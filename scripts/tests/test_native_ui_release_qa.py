from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


contract = _load("check_native_adapter_contract", ROOT / "scripts" / "check-native-adapter-contract.py")


class NativeUiReleaseQATests(unittest.TestCase):
    def test_ui_budget_has_repeatable_severe_regression_gates(self) -> None:
        budget = json.loads((ROOT / "scripts" / "desktop-ui-performance-budget.json").read_text(encoding="utf-8"))
        required = {
            "first_workspace_render_ms",
            "dicom_mpr_interaction_p95_frame_ms",
            "design_geometry_interaction_p95_frame_ms",
            "toolpath_interaction_p95_frame_ms",
            "main_thread_long_task_max_ms",
            "webgl2_probe_ms",
        }
        self.assertEqual(required, set(budget["metrics"]))
        for name, metric in budget["metrics"].items():
            self.assertLess(metric["target_ms"], metric["gate_ms"], name)
            self.assertGreater(metric["gate_ms"], 0, name)
            self.assertIn(metric["gate_statistic"], {"max", "p95"}, name)
        interaction_metrics = {name for name in required if "interaction_p95_frame_ms" in name}
        self.assertTrue(interaction_metrics)
        for name in interaction_metrics:
            self.assertEqual(budget["metrics"][name]["gate_statistic"], "p95", name)
        self.assertIn("native WebKit or WKWebView frame pacing", budget["unmeasured"])

    def test_native_adapter_operation_lists_and_envelope_match(self) -> None:
        report = contract.validate_contract()
        self.assertEqual(report["status"], "passed", report["failures"])
        self.assertEqual(report["typescriptOperations"], report["rustOperations"])
        self.assertGreaterEqual(report["operationCount"], 14)


if __name__ == "__main__":
    unittest.main()
