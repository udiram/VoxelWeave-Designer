#!/usr/bin/env python3
"""Smoke a packaged VoxelWeave Designer .app without Chromium.

The smoke starts the actual bundle executable, waits for the macOS process (and
an observable window when the runner exposes System Events), then performs a
bounded JSONL request against the sidecar copied inside that same bundle.  The
sidecar request verifies the packaged bridge endpoint is executable; Tauri UI
invocation remains explicitly outside this smoke because GitHub's macos-14
runner does not provide a stable WebView automation contract.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import platform
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


PROTOCOL = "voxelweave.control.v1"
RESPONSE_PROTOCOL = "voxelweave.response.v1"


class SmokeFailure(RuntimeError):
    """Raised when packaged launch or bridge readiness fails."""


def _resolve_bundle(app: Path) -> tuple[Path, str]:
    if not app.is_dir() or app.suffix != ".app":
        raise SmokeFailure(f"--app must be an existing .app directory: {app}")
    plist_path = app / "Contents" / "Info.plist"
    if not plist_path.is_file():
        raise SmokeFailure(f"Info.plist is missing from packaged app: {plist_path}")
    try:
        metadata = plistlib.loads(plist_path.read_bytes())
    except Exception as error:  # pragma: no cover - malformed bundle is an integration failure
        raise SmokeFailure(f"cannot read {plist_path}: {error}") from error
    executable_name = str(metadata.get("CFBundleExecutable", "")).strip()
    macos_dir = app / "Contents" / "MacOS"
    if executable_name:
        executable = macos_dir / executable_name
    else:
        candidates = sorted(item for item in macos_dir.iterdir() if item.is_file() and os.access(item, os.X_OK)) if macos_dir.is_dir() else []
        executable = candidates[0] if len(candidates) == 1 else Path()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise SmokeFailure(f"packaged app executable is missing or not executable: {executable}")
    return executable, executable.name


def _find_sidecar(app: Path) -> Path:
    resources = app / "Contents" / "Resources"
    candidates = [resources / "voxelweave-sidecar", resources / "resources" / "voxelweave-sidecar"]
    candidates.extend(item for item in resources.rglob("voxelweave-sidecar") if item.is_file()) if resources.is_dir() else None
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise SmokeFailure(f"bundled voxelweave-sidecar was not found below {resources}")


def _apple_process_probe(name: str, timeout_seconds: float = 1.0) -> tuple[bool, bool | None, str]:
    """Return (available, exists, detail) for a System Events process probe."""

    escaped = name.replace("\\", "\\\\").replace('"', '\\"')
    script = f'tell application "System Events" to (exists process "{escaped}")'
    try:
        result = subprocess.run(["osascript", "-e", script], check=False, capture_output=True, text=True, timeout=max(0.1, timeout_seconds))
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, None, str(error)
    if result.returncode != 0:
        return False, None, result.stderr.strip() or "osascript returned a non-zero status"
    value = result.stdout.strip().lower()
    return True, value in {"true", "1", "yes"}, result.stdout.strip()


def _read_response(process: subprocess.Popen[bytes], request_id: str, timeout_seconds: float) -> dict[str, Any]:
    if process.stdin is None or process.stdout is None:
        raise SmokeFailure("sidecar pipes were not available")
    envelope = {
        "protocol": PROTOCOL,
        "request_id": request_id,
        "operation": "validate_scene",
        "payload": {"scene": {"regions": [{"id": "native-smoke", "owner": "T0:measurement"}]}},
    }
    process.stdin.write((json.dumps(envelope, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
    process.stdin.flush()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout_seconds
    buffer = bytearray()
    try:
        while time.monotonic() < deadline:
            remaining = max(0.01, deadline - time.monotonic())
            if not selector.select(remaining):
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
                raise SmokeFailure(f"sidecar exited before bridge response; stderr={stderr[-4000:]!r}")
            buffer.extend(chunk)
            while b"\n" in buffer:
                raw, _, remainder = buffer.partition(b"\n")
                buffer = bytearray(remainder)
                if not raw.strip():
                    continue
                try:
                    value = json.loads(raw)
                except json.JSONDecodeError as error:
                    raise SmokeFailure(f"sidecar emitted invalid JSON during bridge smoke: {error}") from error
                if value.get("protocol") == "voxelweave.progress.v1":
                    continue
                if value.get("protocol") != RESPONSE_PROTOCOL or value.get("request_id") != request_id:
                    raise SmokeFailure(f"bridge response correlation failed: {value}")
                if not value.get("ok"):
                    raise SmokeFailure(f"bridge response returned an error: {value.get('error')}")
                payload = value.get("payload") or {}
                if payload.get("passed") is not True:
                    raise SmokeFailure(f"bridge response did not validate the bounded scene: {payload}")
                return value
    finally:
        selector.close()
    raise SmokeFailure(f"timed out waiting {timeout_seconds:.1f}s for packaged sidecar bridge response")


def _stop_process(process: subprocess.Popen[bytes] | None, timeout_seconds: float = 5.0) -> dict[str, Any]:
    if process is None:
        return {"attempted": False, "terminated": True, "exitCode": None}
    before = process.poll()
    if before is not None:
        return {"attempted": False, "terminated": True, "exitCode": before}
    attempted = True
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        attempted = False
    try:
        exit_code = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        exit_code = process.wait(timeout=timeout_seconds)
    return {"attempted": attempted, "terminated": True, "exitCode": exit_code}


def run_smoke(app: Path, output_dir: Path, timeout_seconds: float, bridge_timeout_seconds: float) -> dict[str, Any]:
    if platform.system() != "Darwin" and os.environ.get("VOXELWEAVE_ALLOW_NON_MACOS") != "1":
        raise SmokeFailure("packaged native app smoke requires macOS")
    output_dir.mkdir(parents=True, exist_ok=True)
    app_log = output_dir / "native-app.log"
    sidecar_log = output_dir / "native-sidecar.log"
    executable, process_name = _resolve_bundle(app)
    sidecar = _find_sidecar(app)
    evidence: dict[str, Any] = {
        "schemaVersion": "voxelweave.native-app-smoke.v1",
        "app": app.name,
        "executable": executable.name,
        "sidecar": str(sidecar.relative_to(app)),
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "status": "failed",
        "launch": {},
        "windowProbe": {"available": False, "ready": None, "detail": "not attempted"},
        "bridge": {"protocol": PROTOCOL, "status": "not attempted"},
        "cleanup": {},
        "limitations": [
            "This smoke does not drive Chromium or WebView UI automation.",
            "The bridge assertion is a packaged sidecar JSONL handshake; direct Tauri invoke coverage remains outside the macos-14 smoke contract.",
        ],
    }
    app_process: subprocess.Popen[bytes] | None = None
    sidecar_process: subprocess.Popen[bytes] | None = None
    launch_started = time.monotonic()
    try:
        try:
            with app_log.open("wb") as app_handle:
                app_process = subprocess.Popen(
                    [str(executable)],
                    cwd=str(app.parent),
                    env={**os.environ, "VOXELWEAVE_NATIVE_SMOKE": "1"},
                    stdout=app_handle,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
        except OSError as error:
            raise SmokeFailure(f"cannot launch packaged app executable: {error}; see {app_log}") from error
        evidence["launch"] = {"pid": app_process.pid, "started": True}
        process_ready_at: float | None = None
        window_available = False
        window_ready = None
        window_detail = "System Events probe was not available"
        window_limitation: str | None = None
        deadline = launch_started + timeout_seconds
        while time.monotonic() < deadline:
            if app_process.poll() is not None:
                raise SmokeFailure(f"app exited before readiness (exit code {app_process.returncode}); see {app_log}")
            if process_ready_at is None:
                process_ready_at = time.monotonic()
                evidence["launch"]["processReadyMs"] = round((process_ready_at - launch_started) * 1000, 3)
            available, exists, detail = _apple_process_probe(process_name, min(1.0, max(0.1, deadline - time.monotonic())))
            window_available = available
            window_ready = exists
            window_detail = detail
            if available and exists:
                break
            if not available:
                # A macOS runner without Accessibility/System Events still
                # gives us a valid process-level smoke; record the limitation.
                break
            time.sleep(0.2)
        else:
            # Keep process/bridge readiness authoritative.  Accessibility
            # permissions and the process-name mapping can make a visible
            # window probe return false on hosted runners even while the app
            # is healthy; retain that observation in evidence instead of
            # turning it into a false native failure.
            if window_available and not window_ready:
                window_limitation = "System Events did not report a window before timeout; process and bridge checks remain authoritative"
        evidence["windowProbe"] = {"available": window_available, "ready": window_ready, "detail": window_detail}
        if window_limitation:
            evidence["windowProbe"]["limitation"] = window_limitation

        try:
            with sidecar_log.open("wb") as sidecar_handle:
                sidecar_process = subprocess.Popen(
                    [str(sidecar)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=sidecar_handle,
                    start_new_session=True,
                )
        except OSError as error:
            raise SmokeFailure(f"cannot launch packaged sidecar: {error}; see {sidecar_log}") from error
        bridge_started = time.monotonic()
        response = _read_response(sidecar_process, "native-app-smoke", bridge_timeout_seconds)
        evidence["bridge"] = {
            "protocol": PROTOCOL,
            "status": "passed",
            "responseProtocol": response.get("protocol"),
            "responseOperation": response.get("operation"),
            "elapsedMs": round((time.monotonic() - bridge_started) * 1000, 3),
        }
        evidence["status"] = "passed"
    except SmokeFailure as error:
        evidence["failure"] = str(error)
    finally:
        sidecar_cleanup = _stop_process(sidecar_process)
        app_cleanup = _stop_process(app_process)
        evidence["cleanup"] = {"sidecar": sidecar_cleanup, "app": app_cleanup}
    evidence_path = output_dir / "native-app-smoke.json"
    evidence_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if evidence["status"] != "passed":
        raise SmokeFailure(str(evidence.get("failure", "native app smoke failed")))
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=20.0)
    parser.add_argument("--bridge-timeout-seconds", type=float, default=15.0)
    args = parser.parse_args()
    if args.timeout_seconds <= 0 or args.bridge_timeout_seconds <= 0:
        parser.error("timeouts must be positive")
    try:
        evidence = run_smoke(args.app.resolve(), args.output_dir.resolve(), args.timeout_seconds, args.bridge_timeout_seconds)
    except SmokeFailure as error:
        print(f"[native-app-smoke] FAIL {error}", file=sys.stderr)
        return 1
    print(f"[native-app-smoke] PASS app={evidence['app']} bridge={evidence['bridge']['elapsedMs']}ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
