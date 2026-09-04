"""Static and byte-level checks for the durable Stage 4B/Stage 5 authority chain."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
BINDINGS_PATH = REPO / "docs/releases/stage-4b-stage-5-durable-authority-bindings.json"
VERIFIER_PATH = REPO / "scripts/verify-durable-authority.py"
WORKFLOWS = {
    "stage4b3": REPO / ".github/workflows/stage-4b3-receipt.yml",
    "stage4b_closure": REPO / ".github/workflows/stage-4b-closure-audit.yml",
    "stage5_entry": REPO / ".github/workflows/stage-5-entry-gate.yml",
    "stage5_1": REPO / ".github/workflows/stage-5-1-evaluation-constitution.yml",
    "stage5_2": REPO / ".github/workflows/stage-5-2-dataset-leakage.yml",
    "stage5_3_4": REPO / ".github/workflows/stage-5-3-4-registry-harness.yml",
    "stage5_5_8": REPO / ".github/workflows/stage-5-5-8-research-promotion.yml",
    "stage5_closure": REPO / ".github/workflows/stage-5-closure.yml",
}
CONSUMED_PATHS = {
    "stage4b3": ["tests/fixtures/stage-4b-closure/stage-4b2-receipt.json"],
    "stage4b_closure": [
        "docs/releases/stage-4b1-activation-contract.json",
        "tests/fixtures/stage-4b-closure/stage-4b1-subject.json",
        "tests/fixtures/stage-4b-closure/stage-4b2-receipt.json",
        "tests/fixtures/stage-4b-closure/stage-4b3-receipt.json",
        "tests/fixtures/stage-4b-closure/stage-4b4-proof.json",
    ],
    "stage5_entry": ["tests/fixtures/stage-5-entry/stage-4b-closure-audit.json"],
    "stage5_1": ["tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json"],
    "stage5_2": [
        "tests/fixtures/stage-5-evaluation/stage-5-evaluation-spec.json",
        "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json",
    ],
    "stage5_3_4": [
        "docs/releases/stage-4a12-candidate-manifest.json",
        "tests/fixtures/stage-5-evaluation/stage-5-evaluation-spec.json",
        "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json",
    ],
    "stage5_5_8": [
        "tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json",
        "tests/fixtures/stage-5-evaluation/stage-5-evaluation-spec.json",
        "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json",
        "tests/fixtures/stage-5-registry/stage-5-candidate-registry.json",
        "tests/fixtures/stage-5-research/stage-5-research-results.json",
        "tests/fixtures/stage-5-research/stage-5-validation-decision.json",
        "tests/fixtures/stage-5-research/stage-5-promotion-decision.json",
    ],
    "stage5_closure": [
        "tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json",
        "tests/fixtures/stage-5-evaluation/stage-5-evaluation-spec.json",
        "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json",
        "tests/fixtures/stage-5-registry/stage-5-candidate-registry.json",
        "tests/fixtures/stage-5-research/stage-5-research-results.json",
        "tests/fixtures/stage-5-research/stage-5-validation-decision.json",
        "tests/fixtures/stage-5-research/stage-5-promotion-decision.json",
    ],
}


def _load_verifier():
    spec = importlib.util.spec_from_file_location("durable_authority_verifier", VERIFIER_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("verifier module is not loadable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DurableAuthorityChainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.verifier = _load_verifier()
        cls.bindings_document = json.loads(BINDINGS_PATH.read_text(encoding="utf-8"))
        cls.bindings = cls.bindings_document["subjects"]

    def test_every_binding_verifies_bytes_json_and_semantic_identity(self) -> None:
        verified = self.verifier.verify_subjects(BINDINGS_PATH, REPO, [])
        self.assertEqual(len(verified), len(self.bindings))
        self.assertEqual(len(self.bindings), 14)

    def test_authority_ids_and_canonical_paths_are_unique(self) -> None:
        ids = [binding["id"] for binding in self.bindings]
        paths = [binding["canonicalPath"] for binding in self.bindings]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(paths), len(set(paths)))

    def test_every_authority_path_has_git_text_unset(self) -> None:
        paths = [binding["canonicalPath"] for binding in self.bindings]
        git_executable = shutil.which("git")
        self.assertIsNotNone(git_executable)
        result = subprocess.run(
            [git_executable, "check-attr", "text", "--", *paths],
            cwd=REPO,
            check=True,
            capture_output=True,
            text=True,
        )
        lines = [line for line in result.stdout.splitlines() if line]
        self.assertEqual(len(lines), len(paths))
        for path, line in zip(paths, lines, strict=True):
            self.assertEqual(line, f"{path}: text: unset")

    def test_migrated_workflows_have_no_historical_artifact_downloads(self) -> None:
        for name, workflow_path in WORKFLOWS.items():
            workflow = workflow_path.read_text(encoding="utf-8")
            with self.subTest(workflow=name):
                self.assertNotIn("gh run download", workflow)
                self.assertNotIn("actions/download-artifact", workflow)
                self.assertIn("scripts/verify-durable-authority.py", workflow)
                self.assertIn("docs/releases/stage-4b-stage-5-durable-authority-bindings.json", workflow)
                self.assertIn("'.gitattributes'", workflow)
                for canonical_path in CONSUMED_PATHS[name]:
                    self.assertIn(canonical_path, workflow)

    def test_stage5_2_retains_full_history_checkout(self) -> None:
        workflow = WORKFLOWS["stage5_2"].read_text(encoding="utf-8")
        self.assertIn("fetch-depth: 0", workflow)

    def test_missing_or_unknown_authority_fails_without_generation(self) -> None:
        binding = dict(self.bindings[0])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            missing = root / binding["canonicalPath"]
            with self.assertRaisesRegex(
                self.verifier.DurableAuthorityError, "CANONICAL_SUBJECT_MISSING"
            ):
                self.verifier.verify_subject(binding, root)
            self.assertFalse(missing.exists())
        with self.assertRaisesRegex(
            self.verifier.DurableAuthorityError, "UNKNOWN_AUTHORITY_SUBJECT"
        ):
            self.verifier.verify_subjects(BINDINGS_PATH, REPO, ["NOT_A_SUBJECT"])

    def test_historical_safety_states_remain_fail_closed(self) -> None:
        expected_blocked = {
            "STAGE_4B2_RECEIPT": ("status", "BLOCKED_NO_ACTIVATION_REVIEW_READY_STRATEGY"),
            "STAGE_4B_CLOSURE_AUDIT": ("status", "CLOSED_BLOCKED_NO_PROMOTED_STRATEGY"),
            "STAGE_5_ENTRY_GATE": ("status", "BLOCKED_NO_PROMOTED_STRATEGY"),
            "STAGE_5_PROMOTION_DECISION": (
                "status",
                "REJECTED_VALIDATION_NO_LOCKED_TEST_RUN",
            ),
        }
        by_id = {binding["id"]: binding for binding in self.bindings}
        for subject_id, (field, status) in expected_blocked.items():
            binding = by_id[subject_id]
            value = json.loads((REPO / binding["canonicalPath"]).read_bytes())
            with self.subTest(subject=subject_id):
                self.assertEqual(value[field], status)
        for binding in self.bindings:
            semantic = binding["semanticIdentityFields"]
            for field in (
                "paperApproved",
                "testnetApproved",
                "liveApproved",
                "runtimeStarted",
                "safety.paperApproved",
                "safety.testnetApproved",
                "safety.liveApproved",
                "safety.runtimeStarted",
            ):
                if field in semantic:
                    self.assertIs(semantic[field], False)


if __name__ == "__main__":
    unittest.main()
