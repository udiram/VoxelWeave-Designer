from __future__ import annotations

import importlib.util
import json
import subprocess
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
        for name in {
            "dicom_mpr_interaction_p95_frame_ms",
            "design_geometry_interaction_p95_frame_ms",
            "toolpath_interaction_p95_frame_ms",
        }:
            self.assertEqual("p50", budget["metrics"][name]["gate_statistic"])
        self.assertIn("native WebKit or WKWebView frame pacing", budget["unmeasured"])

    def test_ui_interaction_gate_requires_two_of_three_regressions(self) -> None:
        script = """
          import { aggregate } from './scripts/benchmark-desktop-ui.mjs';
          const budget = { target_ms: 16.7, gate_ms: 120, gate_statistic: 'p50' };
          console.log(JSON.stringify({
            isolatedStall: aggregate([66.7, 133.3, 83.3], budget),
            sustainedRegression: aggregate([100, 133.3, 133.4], budget),
          }));
        """
        result = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        summaries = json.loads(result.stdout)
        self.assertTrue(summaries["isolatedStall"]["gatePassed"])
        self.assertEqual(83.3, summaries["isolatedStall"]["gateValue"])
        self.assertEqual(133.3, summaries["isolatedStall"]["max"])
        self.assertFalse(summaries["sustainedRegression"]["gatePassed"])
        self.assertEqual(133.3, summaries["sustainedRegression"]["gateValue"])

    def test_native_adapter_operation_lists_and_envelope_match(self) -> None:
        report = contract.validate_contract()
        self.assertEqual(report["status"], "passed", report["failures"])
        self.assertEqual(report["typescriptOperations"], report["rustOperations"])
        self.assertGreaterEqual(report["operationCount"], 14)


if __name__ == "__main__":
    unittest.main()
