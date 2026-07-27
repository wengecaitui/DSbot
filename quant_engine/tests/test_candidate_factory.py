"""Stage 4A12 candidate factory, robustness, and holdout-ledger tests."""

from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from quant_engine.proof.asset_manifest import build_asset_manifest
from quant_engine.proof.gap_policy import GapPolicy, audit_ohlcv
from quant_engine.proof.robustness_gate import (
    HoldoutLedger,
    MarketDataset,
    RobustnessConfig,
    finalize_robustness_evaluation,
    prepare_robustness_evaluation,
)
from quant_engine.proof.promotion_receipt import build_attestation_subject, build_promotion_receipt, verify_promotion_receipt
from quant_engine.proof.strategy_adapter import Action, Decision, StrategyContext, simulate_window
from quant_engine.proof.strategy_spec import (
    _CALCULATORS,
    _component_series,
    SPEC_LABEL,
    CompiledStrategyAdapter,
    build_candidate_manifest,
    build_candidate_specs,
    candidate_parameter_sets,
)


REPO = Path(__file__).resolve().parents[2]


def bars(count: int, frequency: str, slope: float = 0.02) -> pd.DataFrame:
    closes = [100 + index * slope + ((index % 12) - 6) * 0.08 for index in range(count)]
    return pd.DataFrame({
        "date": pd.date_range("2024-01-01", periods=count, freq=frequency, tz="UTC"),
        "open": closes,
        "high": [item + 0.5 for item in closes],
        "low": [item - 0.5 for item in closes],
        "close": closes,
        "volume": [100 + index % 20 for index in range(count)],
    })


def dataset(dataset_id: str, symbol: str, timeframe: str, frequency: str, slope: float = 0.02) -> MarketDataset:
    frame = bars(400, frequency, slope)
    return MarketDataset(dataset_id, symbol, timeframe, frame, audit_ohlcv(frame, pd.Timedelta(frequency), GapPolicy.REJECT))


def simple_outputs(history: pd.DataFrame, _params):
    rising = float(history.iloc[-1]["close"]) >= float(history.iloc[-2]["close"])
    return {"name": "mock", "signal": "BULL" if rising else "BEAR", "lag_bars": 0}


def simple_stochastic(history: pd.DataFrame, _params):
    rising = float(history.iloc[-1]["close"]) >= float(history.iloc[-2]["close"])
    return {"name": "mock", "signal": "BUY" if rising else "SELL", "lag_bars": 0}


class CandidateFactoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = build_asset_manifest(REPO, "test-commit")
        cls.specs = build_candidate_specs(cls.manifest)

    def test_factory_is_small_deterministic_and_source_bound(self):
        again = build_candidate_specs(self.manifest)
        self.assertEqual([item.to_dict() for item in self.specs], [item.to_dict() for item in again])
        self.assertEqual(len(self.specs), 4)
        self.assertEqual(len({item.strategy_id for item in self.specs}), 4)
        for spec in self.specs:
            payload = spec.to_dict()
            self.assertEqual(payload["label"], SPEC_LABEL)
            self.assertEqual(len(candidate_parameter_sets(spec)), 3)
            self.assertEqual(spec.execution_timing, "closed-bar-next-open")
            self.assertTrue(spec.position_lifecycle["longSupported"])
            self.assertTrue(spec.position_lifecycle["shortSupported"])
            self.assertIn("stopLoss", spec.risk_rules)
            self.assertIn("takeProfit", spec.risk_rules)

    def test_blocked_assets_remain_blocked_and_are_not_first_batch_components(self):
        blocked = {item["registryName"] for item in self.manifest["assets"] if item["classification"] == "needs-lifecycle"}
        used = {component["assetId"] for spec in self.specs for component in spec.components}
        self.assertEqual(blocked, {"ChandelierExit", "FibonacciEntryBands", "HullSuite", "UTBotAlerts"})
        self.assertTrue(blocked.isdisjoint(used))
        self.assertEqual(self.manifest["counts"]["needsLifecycle"], 4)

    def test_source_digest_change_changes_strategy_identity(self):
        changed = copy.deepcopy(self.manifest)
        changed["assets"][11]["pythonSymbolSha256"] = "0" * 64
        before = {item.strategy_id for item in self.specs}
        after = {item.strategy_id for item in build_candidate_specs(changed)}
        self.assertNotEqual(before, after)

    def test_flat_entry_reversal_stop_and_take_profit_are_explicit(self):
        spec = self.specs[0]
        adapter = CompiledStrategyAdapter(spec)
        parameters = candidate_parameter_sets(spec)[0]
        frame = bars(100, "4h")
        with patch.dict("quant_engine.proof.strategy_spec._CALCULATORS", {"TrendImpulse": simple_outputs, "StochasticOverlay": simple_stochastic}, clear=False):
            decision = adapter.decide(frame, parameters, StrategyContext(0, None, None))
        self.assertEqual(decision.action, Action.ENTER_LONG)
        self.assertGreater(decision.stop_distance, 0)
        self.assertGreater(decision.take_profit_distance, decision.stop_distance)

    def test_vectorized_component_outputs_match_closed_prefix_calls(self):
        frame = bars(160, "4h")
        fields = {
            "TrendImpulse": ("signal",),
            "StochasticOverlay": ("signal",),
            "STC": ("signal", "trend"),
            "MeanReversion": ("signal", "probability"),
            "SRRange": ("position", "signal"),
        }
        seen = set()
        for spec in self.specs:
            parameters = candidate_parameter_sets(spec)[1]
            for component in spec.components:
                component_id = component["assetId"]
                if component_id in seen:
                    continue
                seen.add(component_id)
                mapped = {target: parameters[source] for target, source in component["parameterMap"].items()}
                vector = _component_series(component_id, frame, mapped)
                for end in (100, 130, 160):
                    prefix = frame.iloc[:end].copy(deep=True)
                    expected = _CALCULATORS[component_id](prefix, dict(mapped))
                    actual = vector[end - 1]
                    for field in fields[component_id]:
                        self.assertEqual(actual[field], expected[field], f"{component_id}.{field}@{end}")


class TakeProfitAdapter:
    strategy_id = "take-profit-test"
    version = "1"
    minimum_history = 2

    def decide(self, history, parameters, context):
        if context.position == 0 and len(history) == 2:
            return Decision(Action.ENTER_LONG, stop_distance=1.0, take_profit_distance=1.0)
        return Action.HOLD


class StrategySimulatorTests(unittest.TestCase):
    def test_take_profit_is_executed_and_both_touched_is_stop_first(self):
        frame = bars(8, "4h", 0)
        frame.loc[2, "high"] = frame.loc[2, "open"] + 2
        frame.loc[2, "low"] = frame.loc[2, "open"] - 2
        result = simulate_window(TakeProfitAdapter(), frame, {}, 0, len(frame), 0, 0)
        self.assertEqual(result["trades"][0]["exit_reason"], "stop")
        self.assertGreaterEqual(result["maxDrawdown"], 0)


class PromotionReceiptTests(unittest.TestCase):
    def test_receipt_is_source_free_counted_and_tamper_evident(self):
        engine = "1" * 40
        assets = build_asset_manifest(REPO, engine)
        manifest = build_candidate_manifest(assets, engine)
        specs = build_candidate_specs(assets)
        matrix = [
            {"datasetId": str(index), "symbol": f"S{index}/USDT", "timeframe": "5m" if index < 8 else "4h", "sourceDataframeSha256": "2" * 64, "workingDataframeSha256": "3" * 64, "sourceSha256": "4" * 64, "sourceRows": 9000, "workingStartRow": 0, "workingEndRowExclusive": 9000, "workingRows": 9000, "gapPolicy": "reject", "gapCount": 0, "segmentIndex": 0}
            for index in range(10)
        ]
        aggregate = {"datasetCount": 10, "meanNetReturn": 0.01, "medianNetReturn": 0.01, "worstNetReturn": -0.01, "positiveDatasetCount": 7, "positiveDatasetFraction": 0.7, "totalTrades": 100, "maxDrawdown": 0.1}
        development = {
            "sourceCommit": engine,
            "developmentId": "5" * 64,
            "datasetMatrixId": "6" * 64,
            "datasetMatrix": matrix,
            "strategies": [
                {"strategyId": spec.strategy_id, "selectionCountTotal": 9, "folds": [{"test": {"aggregate": aggregate}, "stressTest": {"aggregate": aggregate}, "parameterStability": {"passed": True, "maxMedianReturnDelta": 0.01}}]}
                for spec in specs
            ],
        }
        final = {
            "sourceCommit": engine,
            "developmentId": development["developmentId"],
            "datasetMatrixId": development["datasetMatrixId"],
            "proofId": "7" * 64,
            "candidateCount": 4,
            "backtestCompletedCount": 4,
            "robustnessPassedCount": 0,
            "promotionEligibleCount": 0,
            "finalHoldoutEvaluationCount": 40,
            "holdoutRunId": "test-run",
            "decisions": [
                {"strategyId": spec.strategy_id, "specId": spec.to_dict()["specId"], "deploymentParameterId": "8" * 64, "finalHoldoutEvaluationCount": 10, "finalHoldout": {"aggregate": aggregate}, "robustnessPassed": False, "promotionEligible": False, "promotionReasons": ["TEST"], "paperReadinessReview": False}
                for spec in specs
            ],
        }
        receipt = build_promotion_receipt(development, final, manifest, engine)
        verify_promotion_receipt(receipt, manifest)
        subject = build_attestation_subject(receipt, "9" * 40)
        self.assertEqual(subject["receiptCommit"], "9" * 40)
        self.assertEqual(receipt["approvals"], {"paperApproved": False, "testnetApproved": False, "liveApproved": False})
        tampered = copy.deepcopy(receipt)
        tampered["counts"]["promotionEligible"] = 1
        with self.assertRaisesRegex(ValueError, "ID_INVALID|PROMOTION_COUNT_INVALID"):
            verify_promotion_receipt(tampered, manifest)


class RobustnessGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest = build_asset_manifest(REPO, "test-commit")
        cls.spec = build_candidate_specs(manifest)[0]
        cls.config = RobustnessConfig(
            fold_count=2,
            max_bars_per_dataset=400,
            min_train_bars=60,
            validation_bars=30,
            test_bars=30,
            purge_bars=2,
            embargo_bars=2,
            final_holdout_ratio=0.15,
            final_holdout_min_bars=60,
            min_total_holdout_trades=1,
        )
        cls.datasets = [
            dataset("btc-5m", "BTC/USDT", "5m", "5min", 0.02),
            dataset("eth-4h", "ETH/USDT", "4h", "4h", -0.01),
        ]

    def _prepare(self, datasets=None):
        calculators = {"TrendImpulse": simple_outputs, "StochasticOverlay": simple_stochastic}
        with patch.dict("quant_engine.proof.strategy_spec._CALCULATORS", calculators, clear=False):
            return prepare_robustness_evaluation([self.spec], datasets or self.datasets, self.config, "test-commit")

    def test_validation_and_test_do_not_change_train_selected_parameters(self):
        baseline = self._prepare()
        mutated = []
        for item in self.datasets:
            frame = item.bars.copy(deep=True)
            frame.loc[310:, "close"] = frame.loc[310:, "close"] * 1.5
            frame.loc[310:, "open"] = frame.loc[310:, "close"]
            frame.loc[310:, "high"] = frame.loc[310:, "close"] + 1
            frame.loc[310:, "low"] = frame.loc[310:, "close"] - 1
            mutated.append(MarketDataset(item.dataset_id, item.symbol, item.timeframe, frame, audit_ohlcv(frame, pd.Timedelta("5min" if item.timeframe == "5m" else "4h"), GapPolicy.REJECT)))
        changed = self._prepare(mutated)
        selected_before = [item["selectedParameterId"] for item in baseline["strategies"][0]["folds"]]
        selected_after = [item["selectedParameterId"] for item in changed["strategies"][0]["folds"]]
        self.assertEqual(selected_before, selected_after)
        self.assertTrue(all(not item["validationAndTestUsedForFitting"] for item in baseline["strategies"][0]["folds"]))

    def test_selection_count_bias_penalty_and_all_candidate_reporting(self):
        report = self._prepare()
        strategy = report["strategies"][0]
        self.assertEqual(strategy["selectionCountTotal"], 6)
        for fold in strategy["folds"]:
            self.assertEqual(fold["selectionCount"], 3)
            self.assertEqual(len(fold["trainCandidates"]), 3)
            self.assertTrue(all(item["selectionBiasPenalty"] >= 0 for item in fold["trainCandidates"]))
        self.assertEqual(report["candidateCount"], report["reportedCandidateCount"])
        self.assertEqual(report["finalHoldoutEvaluationCount"], 0)

    def test_final_holdout_is_exact_once_and_reuse_fails_closed(self):
        development = self._prepare()
        with tempfile.TemporaryDirectory() as directory:
            ledger = HoldoutLedger(Path(directory) / "holdout-ledger.json")
            calculators = {"TrendImpulse": simple_outputs, "StochasticOverlay": simple_stochastic}
            with patch.dict("quant_engine.proof.strategy_spec._CALCULATORS", calculators, clear=False):
                final = finalize_robustness_evaluation(development, [self.spec], self.datasets, ledger, "run-1")
                self.assertEqual(final["finalHoldoutEvaluationCount"], 2)
                self.assertEqual(final["expectedFinalHoldoutEvaluationCount"], 2)
                self.assertFalse(final["approvals"]["paperApproved"])
                self.assertFalse(final["approvals"]["testnetApproved"])
                self.assertFalse(final["approvals"]["liveApproved"])
                with self.assertRaisesRegex(ValueError, "FINAL_HOLDOUT_REUSE_DETECTED"):
                    finalize_robustness_evaluation(development, [self.spec], self.datasets, ledger, "run-2")

    def test_tampered_development_report_fails_before_holdout_reservation(self):
        development = self._prepare()
        development["strategies"][0]["deploymentParameters"]["stop_atr"] = 99
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "DEVELOPMENT_ID_INVALID"):
                finalize_robustness_evaluation(development, [self.spec], self.datasets, HoldoutLedger(Path(directory) / "ledger.json"), "run")


if __name__ == "__main__":
    unittest.main()
