"""Stage 5.9 closure tests — TDD RED phase (tests written before implementation)."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from quant_engine.proof.stage5_candidate import build_stage5_candidate_registry
from quant_engine.proof.stage5_evaluation import (
    build_stage5_evaluation_spec,
    canonical_json_bytes,
    canonical_sha256,
)
from quant_engine.proof.stage5_closure import (
    AUTHORITATIVE_RAW_SHA256,
    build_stage5_closure,
    verify_stage5_closure,
)

ROOT = Path(__file__).resolve().parents[2]
SOURCE = "d" * 40
FINAL_SHA = SOURCE


def _checked_in_bytes(relative_path: str) -> bytes:
    """Return the committed LF evidence bytes despite Windows checkout conversion."""
    return (ROOT / relative_path).read_bytes().replace(b"\r\n", b"\n")


ENTRY = _checked_in_bytes("tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json")


class Stage5ClosureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evaluation_spec = build_stage5_evaluation_spec(
            "913646777a64aa801c7dc263701802249164bf97", ENTRY
        )
        cls.evaluation_raw = canonical_json_bytes(cls.evaluation_spec) + b"\n"
        cls.dataset_raw = _checked_in_bytes(
            "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json"
        )
        candidate_manifest = _checked_in_bytes(
            "docs/releases/stage-4a12-candidate-manifest.json"
        )
        registry = build_stage5_candidate_registry(
            "2115bfa277d2ca2eb582a010e248f369096cb6fa",
            candidate_manifest,
            cls.evaluation_raw,
            cls.dataset_raw,
        )
        cls.registry_raw = canonical_json_bytes(registry) + b"\n"
        cls.results_raw = _checked_in_bytes(
            "tests/fixtures/stage-5-research/stage-5-research-results.json"
        )
        cls.validation_raw = _checked_in_bytes(
            "tests/fixtures/stage-5-research/stage-5-validation-decision.json"
        )
        cls.promotion_raw = _checked_in_bytes(
            "tests/fixtures/stage-5-research/stage-5-promotion-decision.json"
        )
        cls.closure = build_stage5_closure(
            ENTRY,
            cls.evaluation_raw,
            cls.dataset_raw,
            cls.registry_raw,
            cls.results_raw,
            cls.validation_raw,
            cls.promotion_raw,
            SOURCE,
            FINAL_SHA,
        )

    # ── positive tests ────────────────────────────────────────────────

    def test_round_trip_build_and_verify(self):
        """Build produces a verifiable closure with valid self-ID."""
        verify_stage5_closure(
            self.closure,
            ENTRY,
            self.evaluation_raw,
            self.dataset_raw,
            self.registry_raw,
            self.results_raw,
            self.validation_raw,
            self.promotion_raw,
            SOURCE,
            FINAL_SHA,
        )

    def test_byte_identical_repeat_builds(self):
        """Two builds with the same inputs produce byte-identical output."""
        closure2 = build_stage5_closure(
            ENTRY,
            self.evaluation_raw,
            self.dataset_raw,
            self.registry_raw,
            self.results_raw,
            self.validation_raw,
            self.promotion_raw,
            SOURCE,
            FINAL_SHA,
        )
        self.assertEqual(
            canonical_json_bytes(self.closure), canonical_json_bytes(closure2)
        )

    def test_status_is_closed_no_promoted_strategy(self):
        self.assertIs(self.closure["stage5Closed"], True)
        self.assertEqual(self.closure["status"], "CLOSED_NO_PROMOTED_STRATEGY")

    def test_promoted_count_zero_and_id_null(self):
        terminal = self.closure["terminalState"]["promotion"]
        self.assertEqual(terminal, {
            "decision": "NO_PROMOTED_STRATEGY",
            "promotedStrategyCount": 0,
            "promotedStrategyId": None,
            "paperReviewEligible": False,
        })

    def test_all_safety_flags_false(self):
        safety = self.closure["safety"]
        for key in (
            "activationAuthorized",
            "runtimeStarted",
            "paperApproved",
            "testnetApproved",
            "liveApproved",
        ):
            self.assertIs(safety[key], False, f"safety.{key} must be False")
        self.assertEqual(safety["paperTestnetLiveCalls"], 0)

    def test_research_coverage_4_candidates_12_parameter_sets(self):
        coverage = self.closure["terminalState"]["researchCoverage"]
        self.assertEqual(coverage["candidateCount"], 4)
        self.assertEqual(coverage["parameterSetCount"], 12)

    def test_frozen_candidate_null_and_locked_test_sealed(self):
        coverage = self.closure["terminalState"]["researchCoverage"]
        self.assertIsNone(coverage["frozenCandidate"])
        self.assertEqual(coverage["lockedTestState"], "SEALED_UNOPENED")
        self.assertEqual(coverage["lockedTestAccessCount"], 0)

    def test_stage56_status_skipped_by_contract(self):
        self.assertEqual(
            self.closure["terminalState"]["stage5.6Status"],
            "SKIPPED_BY_CONTRACT_NO_FROZEN_CANDIDATE",
        )

    def test_robustness_not_run_and_overfit_high(self):
        self.assertEqual(
            self.closure["terminalState"]["robustnessStatus"],
            "NOT_RUN_NO_VALIDATED_CANDIDATE",
        )
        self.assertEqual(
            self.closure["terminalState"]["robustnessResult"],
            "REJECTED_BEFORE_LOCKED_TEST",
        )
        self.assertEqual(self.closure["terminalState"]["overfitRisk"], "HIGH")

    def test_all_candidates_rejected_validation(self):
        self.assertTrue(
            self.closure["terminalState"]["allCandidatesRejectedValidation"]
        )

    def test_null_artifacts(self):
        for key in (
            "frozenCandidateReceipt",
            "lockedTestArtifact",
            "robustnessArtifact",
        ):
            self.assertIsNone(
                self.closure["terminalState"][key],
                f"terminalState.{key} must be null",
            )
            self.assertEqual(
                self.closure["terminalState"]["absentEvidence"][key],
                "ABSENT_BY_CONTRACT",
            )

    def test_merge_commits_all_bound(self):
        mc = self.closure["mergeCommits"]
        self.assertEqual(mc["5.1"], "913646777a64aa801c7dc263701802249164bf97")
        self.assertEqual(mc["5.2"], "f7ee27391067c77112a1754ab5c99fc9a5adb6a3")
        self.assertEqual(mc["5.2-fix"], "8c87c86107bf32c7e9f2fd4d494a22d612dcf1b8")
        self.assertEqual(mc["5.3-5.4"], "2115bfa277d2ca2eb582a010e248f369096cb6fa")
        self.assertEqual(mc["5.5-5.8"], "3cbf9b88e7929b5649b84094d77f1492919b2453")
        self.assertEqual(mc["security"], "b9634af97e226b80890464eadb2f4c4c16b128f3")

    def test_initial_baseline_bound(self):
        self.assertEqual(
            self.closure["initialBaseline"],
            "818770767eab0a7173292b614b6e699a9ce310a1",
        )

    def test_source_commit_and_final_target_sha_preserved(self):
        self.assertEqual(self.closure["sourceCommit"], SOURCE)
        self.assertEqual(self.closure["finalTargetSha"], FINAL_SHA)

    def test_all_authoritative_raw_digests_are_bound_exactly(self):
        self.assertEqual(
            {key: value["rawSha256"] for key, value in self.closure["inputs"].items()},
            AUTHORITATIVE_RAW_SHA256,
        )

    # ── tamper/adversarial tests ──────────────────────────────────────

    def _assert_tamper_rejected(self, mutate):
        changed = copy.deepcopy(self.closure)
        mutate(changed)
        with self.assertRaises(ValueError):
            verify_stage5_closure(
                changed,
                ENTRY,
                self.evaluation_raw,
                self.dataset_raw,
                self.registry_raw,
                self.results_raw,
                self.validation_raw,
                self.promotion_raw,
                SOURCE,
                FINAL_SHA,
            )

    def test_tamper_promotion_approval_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["terminalState"]["promotion"].update(decision="PROMOTED")
        )

    def test_tamper_paper_review_eligible_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["terminalState"]["promotion"].update(
                paperReviewEligible=True
            )
        )

    def test_tamper_safety_flag_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["safety"].update(paperApproved=True)
        )

    def test_tamper_candidate_count_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["terminalState"]["researchCoverage"].update(
                candidateCount=5
            )
        )

    def test_tamper_dataset_digest_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["inputs"]["datasetManifest"].update(
                rawSha256="0" * 64
            )
        )

    def test_tamper_source_commit_rejected(self):
        real_commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True).strip()
        self._assert_tamper_rejected(
            lambda v: v.update(sourceCommit=real_commit))

    def test_tamper_final_target_sha_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v.update(finalTargetSha="a" * 40)
        )

    def test_tamper_locked_test_state_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["terminalState"]["researchCoverage"].update(
                lockedTestState="OPENED"
            )
        )

    def test_tamper_robustness_result_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["terminalState"].update(
                robustnessResult="PASSED"
            )
        )

    def test_tamper_robustness_status_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["terminalState"].update(robustnessStatus="RAN")
        )

    def test_tamper_overfit_risk_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["terminalState"].update(overfitRisk="LOW")
        )

    def test_tamper_all_candidates_rejected_flag_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["terminalState"].update(
                allCandidatesRejectedValidation=False
            )
        )

    def test_tamper_frozen_candidate_not_null_rejected(self):
        self._assert_tamper_rejected(
            lambda v: v["terminalState"]["researchCoverage"].update(
                frozenCandidate={"strategyId": "fake"}
            )
        )

    def test_substituted_raw_input_rejected(self):
        """A raw input that doesn't match the bound digest is rejected."""
        with self.assertRaises(ValueError):
            build_stage5_closure(
                ENTRY + b" ",
                self.evaluation_raw,
                self.dataset_raw,
                self.registry_raw,
                self.results_raw,
                self.validation_raw,
                self.promotion_raw,
                SOURCE,
                FINAL_SHA,
            )

    @staticmethod
    def _rewrite_with_self_id(raw: bytes, id_key: str, mutate) -> bytes:
        value = json.loads(raw)
        mutate(value)
        unsigned = dict(value)
        unsigned.pop(id_key, None)
        value[id_key] = canonical_sha256(unsigned)
        return canonical_json_bytes(value) + b"\n"

    def _assert_upstream_tamper_rejected(self, index: int, changed_raw: bytes):
        raws = [
            ENTRY,
            self.evaluation_raw,
            self.dataset_raw,
            self.registry_raw,
            self.results_raw,
            self.validation_raw,
            self.promotion_raw,
        ]
        raws[index] = changed_raw
        with self.assertRaises(ValueError):
            build_stage5_closure(*raws, SOURCE, FINAL_SHA)

    def test_upstream_candidate_identity_tamper_rejected_after_self_id_recomputed(self):
        changed = self._rewrite_with_self_id(
            self.registry_raw,
            "registryId",
            lambda value: value["candidates"][0].update(strategyId="forged-strategy"),
        )
        self._assert_upstream_tamper_rejected(3, changed)

    def test_upstream_dataset_hash_tamper_rejected_after_self_id_recomputed(self):
        changed = self._rewrite_with_self_id(
            self.dataset_raw,
            "datasetManifestId",
            lambda value: value["datasets"][0].update(normalizedSha256="0" * 64),
        )
        self._assert_upstream_tamper_rejected(2, changed)

    def test_upstream_research_metric_tamper_rejected_after_self_id_recomputed(self):
        changed = self._rewrite_with_self_id(
            self.results_raw,
            "resultsId",
            lambda value: value["evaluations"][0]["validation"]["assets"][0]["metrics"].update(netReturn=1.0),
        )
        self._assert_upstream_tamper_rejected(4, changed)

    def test_upstream_test_status_tamper_rejected_after_self_id_recomputed(self):
        changed = self._rewrite_with_self_id(
            self.promotion_raw,
            "promotionReceiptId",
            lambda value: value["singleLockedTest"].update(status="TESTED"),
        )
        self._assert_upstream_tamper_rejected(6, changed)

    def test_source_and_final_target_must_be_the_same_checked_out_sha(self):
        with self.assertRaisesRegex(ValueError, "CLOSURE_SOURCE_TARGET_SHA_MISMATCH"):
            build_stage5_closure(
                ENTRY,
                self.evaluation_raw,
                self.dataset_raw,
                self.registry_raw,
                self.results_raw,
                self.validation_raw,
                self.promotion_raw,
                SOURCE,
                "e" * 40,
            )

    def test_cli_generate_then_verify_end_to_end(self):
        raws = [
            ENTRY,
            self.evaluation_raw,
            self.dataset_raw,
            self.registry_raw,
            self.results_raw,
            self.validation_raw,
            self.promotion_raw,
        ]
        names = (
            "entry-gate", "evaluation-spec", "dataset-manifest",
            "candidate-registry", "research-results",
            "validation-decision", "promotion-decision",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = [
                sys.executable,
                str(ROOT / "scripts/generate-stage-5-closure.py"),
                "--source-commit", SOURCE,
                "--final-target-sha", FINAL_SHA,
            ]
            for name, raw in zip(names, raws, strict=True):
                evidence = root / f"{name}.json"
                evidence.write_bytes(raw)
                command.extend((f"--{name}", str(evidence)))
            output = root / "closure.json"
            generated = subprocess.run(
                [*command, "--output", str(output)],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(generated.returncode, 0, generated.stderr)
            verified = subprocess.run(
                [*command, "--verify", str(output)],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(verified.returncode, 0, verified.stderr)

    def test_caller_inputs_not_mutated(self):
        """Calling verify does not mutate the caller's decision dict."""
        decision_copy = copy.deepcopy(self.closure)
        before = canonical_json_bytes(self.closure)
        verify_stage5_closure(
            self.closure,
            ENTRY,
            self.evaluation_raw,
            self.dataset_raw,
            self.registry_raw,
            self.results_raw,
            self.validation_raw,
            self.promotion_raw,
            SOURCE,
            FINAL_SHA,
        )
        self.assertEqual(before, canonical_json_bytes(self.closure))
        self.assertEqual(
            canonical_json_bytes(decision_copy), canonical_json_bytes(self.closure)
        )


if __name__ == "__main__":
    unittest.main()
