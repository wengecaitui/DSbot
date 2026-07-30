from __future__ import annotations

import copy
import unittest
from pathlib import Path

from quant_engine.proof.stage5_candidate import build_stage5_candidate_registry
from quant_engine.proof.stage5_evaluation import build_stage5_evaluation_spec, canonical_json_bytes
from quant_engine.proof.stage5_promotion import build_stage5_promotion_decision, verify_stage5_promotion_decision


ROOT = Path(__file__).resolve().parents[2]
SOURCE = "d" * 40


def _checked_in_bytes(relative_path: str) -> bytes:
    """Return the committed LF evidence bytes despite Windows checkout conversion."""
    return (ROOT / relative_path).read_bytes().replace(b"\r\n", b"\n")


ENTRY = _checked_in_bytes("tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json")
EVALUATION = canonical_json_bytes(build_stage5_evaluation_spec("913646777a64aa801c7dc263701802249164bf97", ENTRY)) + b"\n"


class Stage5PromotionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dataset = _checked_in_bytes("tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json")
        candidate = _checked_in_bytes("docs/releases/stage-4a12-candidate-manifest.json")
        registry = build_stage5_candidate_registry("2115bfa277d2ca2eb582a010e248f369096cb6fa", candidate, EVALUATION, cls.dataset)
        cls.registry = canonical_json_bytes(registry) + b"\n"
        cls.results = _checked_in_bytes("tests/fixtures/stage-5-research/stage-5-research-results.json")
        cls.validation = _checked_in_bytes("tests/fixtures/stage-5-research/stage-5-validation-decision.json")
        cls.decision = build_stage5_promotion_decision(SOURCE, ENTRY, EVALUATION, cls.dataset, cls.registry, cls.results, cls.validation)

    def test_no_candidate_promoted_and_locked_test_never_runs(self):
        self.assertEqual(self.decision["promotion"], {"approved": False, "decision": "NO_PROMOTED_STRATEGY", "promotedStrategyCount": 0, "promotedStrategyId": None, "paperReviewEligible": False})
        self.assertEqual(self.decision["singleLockedTest"]["accessCount"], 0)
        self.assertEqual(self.decision["singleLockedTest"]["testedCandidateCount"], 0)
        self.assertTrue(all(item["TEST"]["status"] == "NOT_RUN_BY_CONTRACT_NO_FROZEN_CANDIDATE" for item in self.decision["robustnessAudit"]["structuredComparisons"]))

    def test_all_four_rejections_and_state_machine_are_preserved(self):
        self.assertEqual(len(self.decision["promotionStateMachine"]["candidateStates"]), 4)
        self.assertTrue(all(item["finalState"] == "REJECTED_VALIDATION" for item in self.decision["promotionStateMachine"]["candidateStates"]))
        self.assertEqual(self.decision["promotionStateMachine"]["transitionsSkipped"], [])

    def test_tamper_and_fake_promotion_fail_closed(self):
        for mutate in (
            lambda value: value["promotion"].update(approved=True),
            lambda value: value["singleLockedTest"].update(accessCount=1),
            lambda value: value["safety"].update(paperApproved=True),
            lambda value: value["promotionStateMachine"]["candidateStates"][0].update(finalState="PROMOTED"),
        ):
            changed = copy.deepcopy(self.decision); mutate(changed)
            with self.assertRaises(ValueError):
                verify_stage5_promotion_decision(changed, SOURCE, ENTRY, EVALUATION, self.dataset, self.registry, self.results, self.validation)

    def test_raw_upstream_tamper_rejects_and_caller_not_mutated(self):
        before = canonical_json_bytes(self.decision)
        verify_stage5_promotion_decision(self.decision, SOURCE, ENTRY, EVALUATION, self.dataset, self.registry, self.results, self.validation)
        self.assertEqual(before, canonical_json_bytes(self.decision))
        with self.assertRaises(ValueError):
            build_stage5_promotion_decision(SOURCE, ENTRY, EVALUATION, self.dataset, self.registry, self.results + b" ", self.validation)


if __name__ == "__main__":
    unittest.main()
