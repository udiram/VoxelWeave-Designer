from __future__ import annotations

import io
import json
from pathlib import Path
from threading import Event

import pytest

from voxelweave.engine import EngineSession
from voxelweave.errors import CancellationError, DicomValidationError, ProtocolError
from voxelweave.protocol import MAX_ARRAY_ITEMS, MAX_JSONL_BYTES, ControlEnvelope, Operation
from voxelweave.sidecar import serve_jsonl


def _response_lines(output: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in output.getvalue().splitlines() if line]


def test_control_envelope_rejects_oversized_json_and_arrays() -> None:
    with pytest.raises(ProtocolError, match="bounded JSONL"):
        ControlEnvelope.from_json(
            json.dumps(
                {
                    "protocol": "voxelweave.control.v1",
                    "request_id": "large",
                    "operation": "validate_scene",
                    "payload": {"blob": "x" * MAX_JSONL_BYTES},
                }
            )
        )

    with pytest.raises(ProtocolError, match="too many array items"):
        ControlEnvelope("large-array", Operation.VALIDATE_SCENE, {"values": list(range(MAX_ARRAY_ITEMS + 1))})


def test_sidecar_returns_correlated_success_and_error_responses() -> None:
    requests = [
        ControlEnvelope(
            "scene-ok",
            Operation.VALIDATE_SCENE,
            {"scene": {"regions": [{"id": "fixture", "owner": "T0"}]}},
        ).to_json(),
        ControlEnvelope("scene-error", Operation.INSPECT_DICOM_SOURCE, {"source": "missing-source"}).to_json(),
    ]
    output = io.StringIO()
    serve_jsonl(io.StringIO("\n".join(requests) + "\n"), output)
    responses = [item for item in _response_lines(output) if item.get("protocol") == "voxelweave.response.v1"]
    by_request = {str(item["request_id"]): item for item in responses}
    assert by_request["scene-ok"]["ok"] is True
    assert by_request["scene-error"]["ok"] is False
    assert by_request["scene-error"]["error"]["code"] == DicomValidationError.__name__  # type: ignore[index]


def test_sidecar_cancel_is_available_while_an_operation_is_running(monkeypatch: pytest.MonkeyPatch) -> None:
    class BlockingSession:
        def __init__(self) -> None:
            self.registered: set[str] = set()
            self.started = Event()
            self.released = Event()
            self.cancelled = Event()

        def register_request(self, request_id: str) -> None:
            self.registered.add(request_id)

        def handle(self, envelope: ControlEnvelope, *, progress: object | None = None) -> dict[str, object]:
            del progress
            if envelope.operation == Operation.CANCEL:
                target = str(envelope.payload.get("request_id", ""))
                if target in self.registered:
                    self.cancelled.set()
                    self.released.set()
                    return {"request_id": target, "cancelled": True}
                return {"request_id": target, "cancelled": False}
            self.started.set()
            self.released.wait(timeout=2)
            if self.cancelled.is_set():
                raise CancellationError("Operation cancelled before completion.")
            return {"completed": True}

    monkeypatch.setattr("voxelweave.sidecar.EngineSession", BlockingSession)
    source = ControlEnvelope("slow", Operation.INSPECT_DICOM_SOURCE, {"source": "synthetic://cancel-test"}).to_json()
    cancel = ControlEnvelope("cancel-request", Operation.CANCEL, {"request_id": "slow"}).to_json()
    output = io.StringIO()
    serve_jsonl(io.StringIO(f"{source}\n{cancel}\n"), output)
    responses = _response_lines(output)
    by_request = {str(item["request_id"]): item for item in responses if item.get("protocol") == "voxelweave.response.v1"}
    assert by_request["cancel-request"]["payload"]["cancelled"] is True  # type: ignore[index]
    assert by_request["slow"]["ok"] is False
    assert by_request["slow"]["error"]["code"] == CancellationError.__name__  # type: ignore[index]


def test_engine_session_context_cleans_scoped_workspace(tmp_path: Path) -> None:
    with EngineSession(workspace=tmp_path) as session:
        workspace = session._workspace
        workspace.joinpath("cache", "sentinel").parent.mkdir(parents=True)
        workspace.joinpath("cache", "sentinel").write_text("temporary", encoding="utf-8")
        assert workspace.exists()
    assert not workspace.exists()
    assert tmp_path.exists()
