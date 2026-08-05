"""Minimal JSON-lines sidecar runner with no arbitrary command execution."""

from __future__ import annotations

import json
import sys
from contextlib import suppress
from typing import TextIO

from .engine import EngineSession
from .errors import EngineError
from .models import ProgressEvent, canonicalize
from .protocol import ControlEnvelope


def serve_jsonl(input_stream: TextIO, output_stream: TextIO) -> None:
    """Serve bounded control envelopes from stdin and write bounded events to stdout."""

    session = EngineSession()

    def emit(value: object) -> None:
        output_stream.write(json.dumps(canonicalize(value), sort_keys=True, separators=(",", ":")) + "\n")
        output_stream.flush()

    def progress(event: ProgressEvent) -> None:
        emit({"protocol": "voxelweave.progress.v1", **event.to_dict()})

    for line in input_stream:
        if not line.strip():
            continue
        try:
            envelope = ControlEnvelope.from_json(line)
            payload = session.handle(envelope, progress=progress)
            emit(
                {
                    "protocol": "voxelweave.response.v1",
                    "request_id": envelope.request_id,
                    "operation": envelope.operation.value,
                    "ok": True,
                    "payload": payload,
                }
            )
        except EngineError as exc:
            request_id = "unknown"
            with suppress(EngineError):
                request_id = ControlEnvelope.from_json(line).request_id
            emit(
                {
                    "protocol": "voxelweave.response.v1",
                    "request_id": request_id,
                    "operation": "unknown",
                    "ok": False,
                    "error": {"code": type(exc).__name__, "message": str(exc)},
                }
            )


def main() -> None:
    serve_jsonl(sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
