"""Minimal JSON-lines sidecar runner with no arbitrary command execution."""

from __future__ import annotations

import json
import os
import sys
from contextlib import suppress
from threading import Lock, Thread
from typing import TextIO

from .engine import EngineSession
from .errors import EngineError
from .models import ProgressEvent, canonicalize
from .protocol import MAX_JSONL_BYTES, ControlEnvelope, Operation
from .release import require_release_dependencies


def serve_jsonl(input_stream: TextIO, output_stream: TextIO) -> None:
    """Serve bounded control envelopes from stdin and write bounded events to stdout."""

    if os.environ.get("VOXELWEAVE_RELEASE_MODE") == "1":
        require_release_dependencies(require_arm64=False)

    session = EngineSession()
    output_lock = Lock()
    operation_lock = Lock()
    workers: list[Thread] = []

    def emit(value: object) -> None:
        encoded = json.dumps(canonicalize(value), sort_keys=True, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_JSONL_BYTES:
            raise EngineError("Sidecar response exceeds the bounded JSONL line limit.")
        with output_lock:
            output_stream.write(encoded + "\n")
            output_stream.flush()

    def progress(event: ProgressEvent) -> None:
        emit({"protocol": "voxelweave.progress.v1", **event.to_dict()})

    def emit_response(request_id: str, operation: str, payload: object | None = None, error: EngineError | Exception | None = None) -> None:
        if error is None:
            emit(
                {
                    "protocol": "voxelweave.response.v1",
                    "request_id": request_id,
                    "operation": operation,
                    "ok": True,
                    "payload": payload,
                }
            )
            return
        try:
            emit(
                {
                    "protocol": "voxelweave.response.v1",
                    "request_id": request_id,
                    "operation": operation,
                    "ok": False,
                    "error": {"code": type(error).__name__, "message": str(error)},
                }
            )
        except EngineError:
            # Keep the protocol bounded even when an unexpected exception contains a large message.
            emit(
                {
                    "protocol": "voxelweave.response.v1",
                    "request_id": request_id,
                    "operation": operation,
                    "ok": False,
                    "error": {"code": type(error).__name__, "message": "Sidecar operation failed."},
                }
            )

    def run_request(envelope: ControlEnvelope) -> None:
        try:
            # EngineSession state is intentionally serialized, while cancel requests are
            # handled by the input loop and can set the cooperative token immediately.
            with operation_lock:
                payload = session.handle(envelope, progress=progress)
            emit_response(envelope.request_id, envelope.operation.value, payload=payload)
        except Exception as exc:  # noqa: BLE001 - every request must receive a bounded response
            emit_response(envelope.request_id, envelope.operation.value, error=exc)

    for line in input_stream:
        if not line.strip():
            continue
        try:
            envelope = ControlEnvelope.from_json(line)
            if envelope.operation == Operation.CANCEL:
                try:
                    payload = session.handle(envelope, progress=progress)
                    emit_response(envelope.request_id, envelope.operation.value, payload=payload)
                except Exception as exc:  # noqa: BLE001 - every request must receive a bounded response
                    emit_response(envelope.request_id, envelope.operation.value, error=exc)
                continue
            session.register_request(envelope.request_id)
            worker = Thread(target=run_request, args=(envelope,), daemon=True)
            workers.append(worker)
            worker.start()
        except EngineError as exc:
            request_id = "unknown"
            with suppress(EngineError):
                request_id = ControlEnvelope.from_json(line).request_id
            emit_response(request_id, "unknown", error=exc)

    for worker in workers:
        worker.join()
    close = getattr(session, "close", None)
    if callable(close):
        close()


def main() -> None:
    serve_jsonl(sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
