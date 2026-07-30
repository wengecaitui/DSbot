from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from quant_engine.proof.stage5_dataset import build_stage5_dataset_manifest
from quant_engine.proof.stage5_evaluation import build_stage5_evaluation_spec, canonical_json_bytes
from quant_engine.tests.test_stage5_dataset import EVAL_SOURCE, SOURCE, matrix


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/run-stage-5-dataset-audit.py"
SPEC = importlib.util.spec_from_file_location("stage5_dataset_cli", SCRIPT)
assert SPEC and SPEC.loader
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)
ENTRY = (ROOT / "tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json").read_bytes()
EVAL_RAW = canonical_json_bytes(build_stage5_evaluation_spec(EVAL_SOURCE, ENTRY)) + b"\n"


class Stage5DatasetCliTests(unittest.TestCase):
    def test_private_output_rejects_repository_and_descendants(self) -> None:
        for path in (ROOT, ROOT / "private-proof"):
            with self.assertRaisesRegex(ValueError, "PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY"):
                CLI.validate_private_output_dir(path)

    def test_verify_existing_requires_canonical_raw_bytes(self) -> None:
        manifest = build_stage5_dataset_manifest(SOURCE, EVAL_RAW, matrix())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_bytes(canonical_json_bytes(manifest) + b"\n")
            self.assertEqual(CLI.verify_existing(path, SOURCE, EVAL_RAW), manifest)
            path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "NOT_CANONICAL"):
                CLI.verify_existing(path, SOURCE, EVAL_RAW)

    def test_write_exclusive_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.json"
            CLI._write_exclusive(path, b"one")
            with self.assertRaises(FileExistsError):
                CLI._write_exclusive(path, b"two")
            self.assertEqual(path.read_bytes(), b"one")

    def test_private_rows_resume_requires_canonical_bytes(self) -> None:
        rows = [[1, "2"]]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rows.json"
            path.write_bytes(canonical_json_bytes(rows) + b"\n")
            self.assertEqual(CLI._read_canonical_rows(path), rows)
            path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "NOT_CANONICAL"):
                CLI._read_canonical_rows(path)


if __name__ == "__main__":
    unittest.main()
