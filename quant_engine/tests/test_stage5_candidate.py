from __future__ import annotations

import copy
import hashlib
import unittest
from pathlib import Path

from quant_engine.proof.stage5_candidate import build_stage5_candidate_registry, verify_stage5_candidate_registry
from quant_engine.proof.stage5_evaluation import build_stage5_evaluation_spec, canonical_json_bytes, canonical_sha256


ROOT = Path(__file__).resolve().parents[2]
SOURCE = "b" * 40
CANDIDATE_RAW = (ROOT / "docs/releases/stage-4a12-candidate-manifest.json").read_bytes()
ENTRY_RAW = (ROOT / "tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json").read_bytes()
EVALUATION_RAW = canonical_json_bytes(build_stage5_evaluation_spec("913646777a64aa801c7dc263701802249164bf97", ENTRY_RAW)) + b"\n"
DATASET_RAW = (ROOT / "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json").read_bytes()


class Stage5CandidateRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = build_stage5_candidate_registry(SOURCE, CANDIDATE_RAW, EVALUATION_RAW, DATASET_RAW)

    def test_exact_frozen_candidate_and_parameter_budget(self) -> None:
        self.assertEqual(len(self.registry["candidates"]), 4)
        self.assertEqual(sum(len(item["parameterSets"]) for item in self.registry["candidates"]), 12)
        self.assertEqual(self.registry["searchBudget"], {"researchRounds": 1, "candidates": 4, "parameterSets": 12, "promotionsMax": 1, "lockedTestAccess": 1})
        self.assertTrue(all(item["status"] == "REGISTERED" for item in self.registry["candidates"]))

    def test_complete_specs_and_self_id_are_preserved(self) -> None:
        for candidate in self.registry["candidates"]:
            spec = candidate["spec"]
            unsigned = dict(spec); identity = unsigned.pop("specId")
            self.assertEqual(identity, canonical_sha256(unsigned))
            self.assertEqual(identity, candidate["specId"])
        unsigned = copy.deepcopy(self.registry); identity = unsigned.pop("registryId")
        self.assertEqual(identity, canonical_sha256(unsigned))

    def test_baselines_are_mechanical_non_rankable_and_outside_budget(self) -> None:
        no_trade, existing = self.registry["baselines"]
        self.assertEqual(no_trade["type"], "NO_TRADE")
        self.assertEqual(no_trade["expectedTradeCount"], 0)
        self.assertEqual(existing["selectionReason"], "LEXICAL_PRECOMMIT_NOT_PERFORMANCE")
        self.assertTrue(all(not item["rankable"] and not item["candidateBudgetConsumed"] for item in self.registry["baselines"]))
        self.assertEqual(existing["strategyId"], min(item["strategyId"] for item in self.registry["candidates"]))

    def test_locked_test_and_safety_remain_closed(self) -> None:
        self.assertEqual(self.registry["lockedTest"], {"state": "SEALED_UNOPENED", "accessCount": 0, "usedForRegistration": False})
        self.assertEqual(self.registry["safety"]["paperTestnetLiveCalls"], 0)
        for key in ("activationAuthorized", "runtimeStarted", "paperApproved", "testnetApproved", "liveApproved"):
            self.assertFalse(self.registry["safety"][key])

    def test_raw_digest_mismatch_rejects_each_input(self) -> None:
        inputs = [CANDIDATE_RAW, EVALUATION_RAW, DATASET_RAW]
        for index in range(3):
            changed = inputs.copy(); changed[index] += b" "
            with self.assertRaises(ValueError):
                build_stage5_candidate_registry(SOURCE, *changed)

    def test_source_and_lineage_identity_constants_are_exact(self) -> None:
        self.assertEqual(hashlib.sha256(CANDIDATE_RAW).hexdigest(), self.registry["inputs"]["candidateManifest"]["rawSha256"])
        self.assertEqual(hashlib.sha256(EVALUATION_RAW).hexdigest(), self.registry["inputs"]["evaluationSpec"]["rawSha256"])
        self.assertEqual(hashlib.sha256(DATASET_RAW).hexdigest(), self.registry["inputs"]["datasetManifest"]["rawSha256"])

    def test_verifier_rejects_tamper_extra_missing_and_status_skip(self) -> None:
        candidates = []
        changed = copy.deepcopy(self.registry); changed["candidates"][0]["parameterSets"][0]["values"]["stop_atr"] = 99; candidates.append(changed)
        extra = copy.deepcopy(self.registry); extra["override"] = True; candidates.append(extra)
        missing = copy.deepcopy(self.registry); del missing["lockedTest"]; candidates.append(missing)
        skipped = copy.deepcopy(self.registry); skipped["candidates"][0]["status"] = "VALIDATED"; candidates.append(skipped)
        for candidate in candidates:
            with self.assertRaises(ValueError):
                verify_stage5_candidate_registry(candidate, SOURCE, CANDIDATE_RAW, EVALUATION_RAW, DATASET_RAW)

    def test_verifier_does_not_mutate_caller(self) -> None:
        caller = copy.deepcopy(self.registry)
        before = canonical_json_bytes(caller)
        verify_stage5_candidate_registry(caller, SOURCE, CANDIDATE_RAW, EVALUATION_RAW, DATASET_RAW)
        self.assertEqual(before, canonical_json_bytes(caller))


if __name__ == "__main__":
    unittest.main()
