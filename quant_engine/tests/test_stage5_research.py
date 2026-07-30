from __future__ import annotations

import copy
import unittest
from pathlib import Path

from quant_engine.proof.stage5_candidate import build_stage5_candidate_registry
from quant_engine.proof.stage5_evaluation import build_stage5_evaluation_spec, canonical_json_bytes, canonical_sha256
from quant_engine.proof.stage5_research import aggregate_fold_metrics, build_fold_geometry, build_stage5_validation_decision, summarize_assets, verify_stage5_validation_decision


ROOT = Path(__file__).resolve().parents[2]
SOURCE = "c" * 40
CANDIDATE_RAW = (ROOT / "docs/releases/stage-4a12-candidate-manifest.json").read_bytes()
ENTRY_RAW = (ROOT / "tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json").read_bytes()
EVALUATION = build_stage5_evaluation_spec("913646777a64aa801c7dc263701802249164bf97", ENTRY_RAW)
EVALUATION_RAW = canonical_json_bytes(EVALUATION) + b"\n"
DATASET_RAW = (ROOT / "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json").read_bytes()
REGISTRY = build_stage5_candidate_registry("2115bfa277d2ca2eb582a010e248f369096cb6fa", CANDIDATE_RAW, EVALUATION_RAW, DATASET_RAW)
REGISTRY_RAW = canonical_json_bytes(REGISTRY) + b"\n"


def metrics(net: float = 0.02, trades: int = 40, drawdown: float = 0.1, sharpe: float = 0.8, sortino: float = 1.0, profit: float = 1.2):
    return {
        "grossReturn": net + 0.01, "netReturn": net, "maximumDrawdown": drawdown,
        "sharpe": sharpe, "sortino": sortino, "profitFactor": profit,
        "winRate": 0.55, "averageWin": 0.02, "averageLoss": -0.01,
        "expectancy": 0.002, "turnover": float(trades * 2), "tradeCount": trades,
        "exposure": 0.5, "fees": 0.01, "spreadCost": 0.002,
        "slippageCost": 0.004, "fundingCost": 0.001, "mfe": 0.03,
        "mae": -0.02, "rMultiple": 0.5,
    }


def phase(name: str, net: float = 0.02):
    assets = [{"symbol": symbol, "metrics": metrics(net)} for symbol in ("BNB/USDT", "BTC/USDT", "ETH/USDT", "SOL/USDT")]
    folds = []
    row_count = 78624 if name == "TRAIN" else 26208
    for geometry in build_fold_geometry(row_count):
        fold_assets = copy.deepcopy(assets)
        folds.append({**geometry, "assets": fold_assets, "summary": summarize_assets(fold_assets)})
    return {"phase": name, "assets": assets, "summary": summarize_assets(assets), "folds": folds}


def results(net: float = 0.02):
    evaluations = []
    for candidate in REGISTRY["candidates"]:
        for parameter in candidate["parameterSets"]:
            stress_assets = [{"symbol": symbol, "metrics": metrics(net - 0.01)} for symbol in ("BNB/USDT", "BTC/USDT", "ETH/USDT", "SOL/USDT")]
            evaluations.append({
                "strategyId": candidate["strategyId"], "specId": candidate["specId"], "parameterId": parameter["parameterId"],
                "train": phase("TRAIN", net), "validation": phase("VALIDATION", net),
                "validationStress": {"phase": "VALIDATION_STRESS", "assets": stress_assets, "summary": summarize_assets(stress_assets)},
                "foldStability": {
                    "foldCount": 3, "positiveValidationFoldCount": 3 if net > 0 else 0,
                    "minimumValidationFoldMedianReturn": net,
                    "maximumValidationFoldDrawdown": 0.1,
                },
                "regimeAudit": {"classification": "WITHIN_ASSET_REALIZED_VOLATILITY_TERCILES_DESCRIPTIVE_ONLY", "LOW": 4, "MEDIUM": 4, "HIGH": 4, "usedForSelection": False},
            })
    value = {
        "schemaVersion": "stage-5.research-results.v1", "phases": ["TRAIN", "VALIDATION"], "lockedTestAccessCount": 0,
        "adversarialChecks": {"extremeVolatility": "FINITE_FAIL_CLOSED_VERIFIED", "gapPolicy": "REJECT_VERIFIED", "missingData": "REJECT_VERIFIED", "parameterSearch": "DECLARED_SETS_ONLY", "signalDelay": "CLOSED_BAR_NEXT_OPEN_ONE_BAR_FIXED"},
        "evaluations": evaluations,
    }
    value["resultsId"] = canonical_sha256(value)
    return value


class Stage5ResearchTests(unittest.TestCase):
    def test_fold_geometry_has_exact_embargo_and_aggregation_is_conservative(self):
        geometry = build_fold_geometry(26208)
        self.assertEqual(geometry[1]["start"] - geometry[0]["endExclusive"], 96)
        self.assertEqual(geometry[2]["start"] - geometry[1]["endExclusive"], 96)
        self.assertEqual(geometry[-1]["endExclusive"], 26208 - 96)
        folded = aggregate_fold_metrics([metrics(0.01, 10), metrics(-0.02, 20, sharpe=0.3), metrics(0.03, 30)])
        self.assertEqual(folded["tradeCount"], 60)
        self.assertEqual(folded["sharpe"], 0.3)
        self.assertAlmostEqual(folded["netReturn"], (1.01 * 0.98 * 1.03) - 1)

    def test_all_combinations_pass_and_lexical_tie_break_freezes_one(self):
        decision = build_stage5_validation_decision(SOURCE, REGISTRY_RAW, EVALUATION_RAW, DATASET_RAW, results())
        self.assertEqual(decision["status"], "FROZEN_CANDIDATE_READY_FOR_SINGLE_LOCKED_TEST")
        self.assertEqual(decision["frozenCandidate"]["strategyId"], min(item["strategyId"] for item in REGISTRY["candidates"]))
        self.assertEqual(sum(len(item["parameterResults"]) for item in decision["candidates"]), 12)
        self.assertTrue(all(item["stateEvents"][-1]["state"] == "VALIDATED" for item in decision["candidates"]))

    def test_zero_pass_is_valid_closed_research_outcome(self):
        value = results(-0.01)
        decision = build_stage5_validation_decision(SOURCE, REGISTRY_RAW, EVALUATION_RAW, DATASET_RAW, value)
        self.assertEqual(decision["status"], "NO_CANDIDATE_PASSED_VALIDATION")
        self.assertIsNone(decision["frozenCandidate"])
        self.assertTrue(all(item["stateEvents"][-1]["state"] == "REJECTED_VALIDATION" for item in decision["candidates"]))
        self.assertTrue(all(item["failureReasons"] for item in decision["candidates"]))

    def test_each_frozen_threshold_fails_without_or_logic(self):
        mutations = (
            ("aggregateTradeCountMin", lambda m: m.update(tradeCount=1)),
            ("medianNetReturnMinExclusive", lambda m: m.update(netReturn=0.0)),
            ("eachAssetMaximumDrawdownMax", lambda m: m.update(maximumDrawdown=0.21)),
            ("aggregateProfitFactorMin", lambda m: m.update(profitFactor=1.0)),
            ("aggregateSharpeMin", lambda m: m.update(sharpe=0.4)),
            ("aggregateSortinoMin", lambda m: m.update(sortino=0.6)),
        )
        for _, mutate in mutations:
            value = results()
            for evaluation in value["evaluations"]:
                for asset in evaluation["validation"]["assets"]:
                    mutate(asset["metrics"])
                evaluation["validation"]["summary"] = summarize_assets(evaluation["validation"]["assets"])
            unsigned = dict(value); unsigned.pop("resultsId"); value["resultsId"] = canonical_sha256(unsigned)
            decision = build_stage5_validation_decision(SOURCE, REGISTRY_RAW, EVALUATION_RAW, DATASET_RAW, value)
            self.assertIsNone(decision["frozenCandidate"])

    def test_locked_test_contamination_and_missing_result_fail_closed(self):
        value = results(); value["lockedTestAccessCount"] = 1
        unsigned = dict(value); unsigned.pop("resultsId"); value["resultsId"] = canonical_sha256(unsigned)
        with self.assertRaises(ValueError):
            build_stage5_validation_decision(SOURCE, REGISTRY_RAW, EVALUATION_RAW, DATASET_RAW, value)
        value = results(); value["evaluations"].pop()
        unsigned = dict(value); unsigned.pop("resultsId"); value["resultsId"] = canonical_sha256(unsigned)
        with self.assertRaises(ValueError):
            build_stage5_validation_decision(SOURCE, REGISTRY_RAW, EVALUATION_RAW, DATASET_RAW, value)

    def test_tamper_verifier_and_caller_immutability(self):
        value = results(); before = canonical_json_bytes(value)
        decision = build_stage5_validation_decision(SOURCE, REGISTRY_RAW, EVALUATION_RAW, DATASET_RAW, value)
        self.assertEqual(before, canonical_json_bytes(value))
        verify_stage5_validation_decision(decision, SOURCE, REGISTRY_RAW, EVALUATION_RAW, DATASET_RAW, value)
        changed = copy.deepcopy(decision); changed["safety"]["paperApproved"] = True
        with self.assertRaises(ValueError):
            verify_stage5_validation_decision(changed, SOURCE, REGISTRY_RAW, EVALUATION_RAW, DATASET_RAW, value)


if __name__ == "__main__":
    unittest.main()
