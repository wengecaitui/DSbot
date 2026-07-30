from __future__ import annotations

import copy
import math
import unittest
from pathlib import Path

from quant_engine.proof.stage5_evaluation import (
    build_stage5_evaluation_spec,
    canonical_json_bytes,
    canonical_sha256,
    verify_stage5_evaluation_spec,
)


ROOT = Path(__file__).resolve().parents[2]
ENTRY_PATH = ROOT / "tests" / "fixtures" / "stage-5-evaluation" / "stage-5-entry-gate.json"
SOURCE_COMMIT = "818770767eab0a7173292b614b6e699a9ce310a1"


class Stage5EvaluationContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.entry_raw = ENTRY_PATH.read_bytes()
        self.spec = build_stage5_evaluation_spec(SOURCE_COMMIT, self.entry_raw)

    def test_deterministic_identity_and_canonical_bytes(self) -> None:
        other = build_stage5_evaluation_spec(SOURCE_COMMIT, self.entry_raw)
        self.assertEqual(self.spec, other)
        unsigned = copy.deepcopy(self.spec)
        spec_id = unsigned.pop("evaluationSpecId")
        self.assertEqual(spec_id, canonical_sha256(unsigned))
        self.assertEqual(canonical_json_bytes(self.spec), canonical_json_bytes(other))

    def test_entry_gate_and_source_are_bound(self) -> None:
        self.assertEqual(self.spec["sourceCommit"], SOURCE_COMMIT)
        self.assertEqual(self.spec["entryGate"]["gateId"], "987f264ee5079dc623c52edef254e89dc2dab09b18084b238c2d31bd629553d5")
        self.assertEqual(self.spec["entryGate"]["rawSha256"], "b33502d272d7c4bd13c9863518600bb6a1c19cf6e52bf150161f4d494c296c28")
        self.assertEqual(self.spec["entryGate"]["workflowRunId"], 30530350135)

    def test_budget_and_lineage_are_frozen(self) -> None:
        self.assertEqual(self.spec["searchBudget"], {
            "candidateSource": "ALL_FOUR_STAGE_4A12_CANDIDATES_WITH_LINEAGE",
            "lockedTestAccessPerStage5": 1,
            "maxCandidatesPerRound": 4,
            "maxPromotedStrategies": 1,
            "maxResearchRounds": 1,
            "unlimitedSearch": False,
        })
        lineage = self.spec["evaluationLineage"]
        self.assertEqual(len(lineage["candidates"]), 4)
        self.assertEqual(lineage["inheritedConsumedEvaluationCount"], 40)
        self.assertEqual(lineage["inheritedConsumedHoldoutWindowCount"], 10)
        self.assertFalse(lineage["strategyIdChangeResetsConsumption"])

    def test_universe_and_half_open_ranges_are_exact(self) -> None:
        self.assertEqual(self.spec["universe"]["symbols"], ["BNB/USDT", "BTC/USDT", "ETH/USDT", "SOL/USDT"])
        self.assertEqual(self.spec["universe"]["timeframe"], "5m")
        self.assertEqual(self.spec["ranges"]["TRAIN"], {"endExclusive": "2026-04-01T00:00:00Z", "startInclusive": "2025-07-02T00:00:00Z"})
        self.assertEqual(self.spec["ranges"]["VALIDATION"], {"endExclusive": "2026-07-01T00:00:00Z", "startInclusive": "2026-04-01T00:00:00Z"})
        self.assertEqual(self.spec["ranges"]["LOCKED_TEST"], {"endExclusive": "2026-07-29T00:00:00Z", "startInclusive": "2026-07-01T00:00:00Z"})

    def test_split_and_cost_contracts_are_exact(self) -> None:
        split = self.spec["splitContract"]
        self.assertEqual((split["purgeBars"], split["embargoBars"], split["warmupBars"], split["featureLookbackBars"], split["labelHorizonBars"]), (96, 96, 100, 100, 1))
        self.assertTrue(split["fitOnTrainOnly"])
        self.assertTrue(split["validationSelectionOnly"])
        self.assertFalse(split["lockedTestSelection"])
        self.assertEqual(self.spec["costModel"]["baseline"], {"feeBpsPerFill": 5.0, "fundingBpsPer8hAdverse": 1.0, "halfSpreadBpsPerFill": 1.0, "slippageBpsPerFill": 2.0})
        self.assertEqual(self.spec["costModel"]["stress"], {"feeBpsPerFill": 10.0, "fundingBpsPer8hAdverse": 2.0, "halfSpreadBpsPerFill": 2.0, "slippageBpsPerFill": 5.0})

    def test_metric_contract_is_exact(self) -> None:
        self.assertEqual(self.spec["metrics"], [
            "grossReturn", "netReturn", "maximumDrawdown", "sharpe", "sortino",
            "profitFactor", "winRate", "averageWin", "averageLoss", "expectancy",
            "turnover", "tradeCount", "exposure", "fees", "spreadCost",
            "slippageCost", "fundingCost", "mfe", "mae", "rMultiple",
        ])

    def test_promotion_thresholds_are_frozen_before_results(self) -> None:
        self.assertEqual(self.spec["validationGate"]["aggregateTradeCountMin"], 120)
        self.assertEqual(self.spec["validationGate"]["positiveAssetsMin"], 3)
        self.assertEqual(self.spec["validationGate"]["aggregateProfitFactorMin"], 1.10)
        self.assertEqual(self.spec["lockedTestGate"]["accessCountExactly"], 1)
        self.assertEqual(self.spec["lockedTestGate"]["testedCandidateCountExactly"], 1)
        self.assertEqual(self.spec["lockedTestGate"]["stressedMedianNetReturnMin"], 0.0)

    def test_robustness_and_ranking_are_frozen(self) -> None:
        self.assertEqual(self.spec["robustness"]["parameterPerturbations"], [-0.10, -0.05, 0.05, 0.10])
        self.assertEqual(self.spec["robustness"]["minimumNonNegativePerturbations"], 3)
        self.assertEqual(self.spec["robustness"]["overfitRiskAllowed"], ["LOW", "MEDIUM"])
        self.assertEqual(self.spec["ranking"]["evidencePhases"], ["TRAIN", "VALIDATION"])
        self.assertFalse(self.spec["ranking"]["lockedTestMayChangeRanking"])

    def test_locked_test_is_unopened_and_all_runtime_authority_false(self) -> None:
        self.assertFalse(self.spec["creationInputs"]["lockedTestOpened"])
        self.assertEqual(self.spec["creationInputs"]["lockedTestAccessCount"], 0)
        self.assertEqual(self.spec["safety"]["paperTestnetLiveCalls"], 0)
        for key in ("activationAuthorized", "runtimeStarted", "paperApproved", "testnetApproved", "liveApproved"):
            self.assertFalse(self.spec["safety"][key])

    def test_verifier_rejects_mutation_extra_and_missing_fields(self) -> None:
        mutations = []
        changed = copy.deepcopy(self.spec); changed["validationGate"]["positiveAssetsMin"] = 2; mutations.append(changed)
        extra = copy.deepcopy(self.spec); extra["override"] = True; mutations.append(extra)
        missing = copy.deepcopy(self.spec); del missing["costModel"]; mutations.append(missing)
        id_changed = copy.deepcopy(self.spec); id_changed["evaluationSpecId"] = "f" * 64; mutations.append(id_changed)
        for candidate in mutations:
            with self.assertRaises(ValueError):
                verify_stage5_evaluation_spec(candidate, SOURCE_COMMIT, self.entry_raw)

    def test_verifier_rejects_bool_as_number_and_non_finite_values(self) -> None:
        boolean = copy.deepcopy(self.spec); boolean["searchBudget"]["maxResearchRounds"] = True
        nan_value = copy.deepcopy(self.spec); nan_value["costModel"]["baseline"]["feeBpsPerFill"] = math.nan
        infinity = copy.deepcopy(self.spec); infinity["robustness"]["maximumSingleAssetProfitShare"] = math.inf
        for candidate in (boolean, nan_value, infinity):
            with self.assertRaises(ValueError):
                verify_stage5_evaluation_spec(candidate, SOURCE_COMMIT, self.entry_raw)

    def test_entry_raw_bytes_and_source_commit_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            build_stage5_evaluation_spec(SOURCE_COMMIT, self.entry_raw + b" ")
        with self.assertRaises(ValueError):
            build_stage5_evaluation_spec("A" * 40, self.entry_raw)
        with self.assertRaises(ValueError):
            verify_stage5_evaluation_spec(self.spec, "f" * 40, self.entry_raw)

    def test_verifier_does_not_mutate_caller(self) -> None:
        caller = copy.deepcopy(self.spec)
        before = canonical_json_bytes(caller)
        verify_stage5_evaluation_spec(caller, SOURCE_COMMIT, self.entry_raw)
        self.assertEqual(before, canonical_json_bytes(caller))

    def test_canonical_serializer_rejects_non_json_and_non_finite_values(self) -> None:
        for value in ({"x": math.nan}, {"x": math.inf}, {"x": -math.inf}, {"x": {1, 2}}, {1: "bad"}, b"bytes"):
            with self.assertRaises((TypeError, ValueError)):
                canonical_json_bytes(value)

    def test_canonical_serializer_is_order_independent(self) -> None:
        self.assertEqual(canonical_json_bytes({"b": 2, "a": 1}), b'{"a":1,"b":2}')


if __name__ == "__main__":
    unittest.main()
