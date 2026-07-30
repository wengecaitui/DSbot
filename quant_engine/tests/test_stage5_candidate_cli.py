from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from quant_engine.proof.stage5_evaluation import build_stage5_evaluation_spec, canonical_json_bytes


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/generate-stage-5-candidate-registry.py"
SOURCE = "b" * 40


class Stage5CandidateRegistryCliTests(unittest.TestCase):
    def test_generate_then_verify_exact_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            evaluation = base / "evaluation.json"
            output = base / "registry.json"
            entry = (ROOT / "tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json").read_bytes()
            evaluation.write_bytes(canonical_json_bytes(build_stage5_evaluation_spec("913646777a64aa801c7dc263701802249164bf97", entry)) + b"\n")
            common = [
                sys.executable, str(SCRIPT), "--source-commit", SOURCE,
                "--candidate-manifest", str(ROOT / "docs/releases/stage-4a12-candidate-manifest.json"),
                "--evaluation-spec", str(evaluation),
                "--dataset-manifest", str(ROOT / "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json"),
            ]
            generated = subprocess.run([*common, "--output", str(output)], cwd=ROOT, capture_output=True, text=True, check=False)
            self.assertEqual(generated.returncode, 0, generated.stderr)
            self.assertIn("CANDIDATES=4", generated.stdout)
            verified = subprocess.run([*common, "--verify", str(output)], cwd=ROOT, capture_output=True, text=True, check=False)
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertIn("VERIFY=PASS", verified.stdout)

    def test_existing_output_and_tamper_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory) / "existing.json"
            existing.write_text("user data", encoding="utf-8")
            result = subprocess.run([
                sys.executable, str(SCRIPT), "--source-commit", SOURCE,
                "--candidate-manifest", str(ROOT / "docs/releases/stage-4a12-candidate-manifest.json"),
                "--evaluation-spec", str(ROOT / "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json"),
                "--dataset-manifest", str(ROOT / "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json"),
                "--output", str(existing),
            ], cwd=ROOT, capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(existing.read_text(encoding="utf-8"), "user data")


if __name__ == "__main__":
    unittest.main()
