from __future__ import annotations

import ast
import copy
import unittest
from pathlib import Path

import pandas as pd

from quant_engine.proof.stage5_candidate import build_stage5_candidate_registry
from quant_engine.proof.stage5_evaluation import build_stage5_evaluation_spec, canonical_json_bytes
from quant_engine.proof.stage5_harness import METRICS, RegisteredOfflineAdapter, bars_from_binance_rows, run_offline_replay, strategy_spec_from_registry
from quant_engine.proof.strategy_spec import CompiledStrategyAdapter
from quant_engine.proof.strategy_adapter import Action, Decision


ROOT = Path(__file__).resolve().parents[2]
COST = {"feeBpsPerFill": 5.0, "halfSpreadBpsPerFill": 1.0, "slippageBpsPerFill": 2.0, "fundingBpsPer8hAdverse": 1.0}
SOURCE = "b" * 40
CANDIDATE_RAW = (ROOT / "docs/releases/stage-4a12-candidate-manifest.json").read_bytes()
ENTRY_RAW = (ROOT / "tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json").read_bytes()
EVALUATION_RAW = canonical_json_bytes(build_stage5_evaluation_spec("913646777a64aa801c7dc263701802249164bf97", ENTRY_RAW)) + b"\n"
DATASET_RAW = (ROOT / "tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json").read_bytes()


class ScriptedAdapter:
    strategy_id = "scripted-test-only"
    version = "1"
    minimum_history = 2
    history_limit = 5

    def decide(self, history, parameters, context):
        index = int(history.iloc[-1]["sequence"])
        if context.position == 0 and index == 2:
            return Decision(Action.ENTER_LONG, stop_distance=2.0, take_profit_distance=4.0)
        if context.position == 1 and index == 6:
            return Action.EXIT
        return Action.HOLD


def bars(count: int = 15) -> pd.DataFrame:
    values = []
    for index in range(count):
        price = 100.0 + index
        values.append({"date": pd.Timestamp("2026-01-01", tz="UTC") + pd.Timedelta(minutes=5 * index), "open": price, "high": price + 1, "low": price - 1, "close": price + 0.5, "volume": 10.0, "sequence": index})
    return pd.DataFrame(values)


class Stage5HarnessTests(unittest.TestCase):
    def test_all_twenty_metrics_and_offline_labels(self) -> None:
        result = run_offline_replay(ScriptedAdapter(), bars(), {}, 2, 12, COST)
        self.assertEqual(tuple(result["metrics"]), METRICS)
        self.assertEqual(len(METRICS), 20)
        self.assertGreater(result["metrics"]["tradeCount"], 0)
        self.assertIn("NOT_A_PAPER_FILL", result["labels"])
        self.assertEqual(result["safety"]["paperTestnetLiveCalls"], 0)
        self.assertEqual(result["capacityProxy"]["method"], "TURNOVER_AND_EXPOSURE_ONLY")
        self.assertFalse(result["capacityProxy"]["marketDepthAssumed"])
        self.assertEqual(len(result["digests"]["intentIdentities"]), 64)

    def test_replay_is_byte_deterministic_and_does_not_mutate_inputs(self) -> None:
        frame, parameters, cost = bars(), {}, copy.deepcopy(COST)
        before = frame.copy(deep=True)
        first = run_offline_replay(ScriptedAdapter(), frame, parameters, 2, 12, cost)
        second = run_offline_replay(ScriptedAdapter(), frame, parameters, 2, 12, cost)
        self.assertEqual(first, second)
        pd.testing.assert_frame_equal(frame, before)
        self.assertEqual(cost, COST)

    def test_future_bars_cannot_change_scored_result(self) -> None:
        original = bars(20)
        changed = original.copy(deep=True)
        changed.loc[12:, ["open", "high", "low", "close"]] *= 20
        first = run_offline_replay(ScriptedAdapter(), original.iloc[:12].copy(), {}, 2, 12, COST)
        second = run_offline_replay(ScriptedAdapter(), changed.iloc[:12].copy(), {}, 2, 12, COST)
        self.assertEqual(first, second)

    def test_next_open_and_costs_are_real_not_hidden(self) -> None:
        result = run_offline_replay(ScriptedAdapter(), bars(), {}, 2, 12, COST)
        trade = result["tradeRecords"][0]
        self.assertEqual(trade["entryIndex"], 3)
        self.assertGreater(result["metrics"]["grossReturn"], result["metrics"]["netReturn"])
        self.assertGreater(result["metrics"]["fees"], 0)
        self.assertGreater(result["metrics"]["spreadCost"], 0)
        self.assertGreater(result["metrics"]["slippageCost"], 0)

    def test_bad_window_warmup_cost_and_action_fail_closed(self) -> None:
        for start, end, cost in ((0, 10, COST), (2, 2, COST), (2, 10, {**COST, "extra": 1}), (2, 10, {**COST, "feeBpsPerFill": -1})):
            with self.assertRaises(ValueError):
                run_offline_replay(ScriptedAdapter(), bars(), {}, start, end, cost)

        class BadDistanceAdapter(ScriptedAdapter):
            def decide(self, history, parameters, context):
                return Decision(Action.ENTER_LONG, stop_distance=-1.0)

        with self.assertRaisesRegex(ValueError, "OFFLINE_STOP_DISTANCE_INVALID"):
            run_offline_replay(BadDistanceAdapter(), bars(), {}, 2, 10, COST)

    def test_registry_spec_identity_is_recomputed(self) -> None:
        registry = build_stage5_candidate_registry(SOURCE, CANDIDATE_RAW, EVALUATION_RAW, DATASET_RAW)
        candidate = copy.deepcopy(registry["candidates"][0])
        strategy_spec_from_registry(candidate)
        candidate["spec"]["warmupBars"] += 1
        with self.assertRaisesRegex(ValueError, "OFFLINE_CANDIDATE_SPEC_ID_INVALID"):
            strategy_spec_from_registry(candidate)

    def test_indexed_registered_adapter_matches_reference_decide_path(self) -> None:
        registry = build_stage5_candidate_registry(SOURCE, CANDIDATE_RAW, EVALUATION_RAW, DATASET_RAW)
        candidate = registry["candidates"][0]
        parameters = candidate["parameterSets"][0]["values"]
        spec = strategy_spec_from_registry(candidate)
        frame = bars(180).drop(columns=["sequence"])
        indexed = RegisteredOfflineAdapter(spec)
        indexed.prime(frame, parameters)
        reference = CompiledStrategyAdapter(spec)
        reference.prime(frame, parameters)
        fast = run_offline_replay(indexed, frame, parameters, 100, 170, COST)
        slow = run_offline_replay(reference, frame, parameters, 100, 170, COST)
        self.assertEqual(fast, slow)

    def test_binance_rows_validate_and_convert(self) -> None:
        rows = [[0, "10", "11", "9", "10.5", "100", 299999, "0", 1, "0", "0", "0"], [300000, "10.5", "12", "10", "11", "101", 599999, "0", 1, "0", "0", "0"]]
        frame = bars_from_binance_rows(rows)
        self.assertEqual(list(frame.columns), ["date", "open", "high", "low", "close", "volume"])
        broken = copy.deepcopy(rows); broken[1][0] = 0
        with self.assertRaises(ValueError):
            bars_from_binance_rows(broken)

    def test_module_has_no_trading_environment_imports(self) -> None:
        source = (ROOT / "quant_engine/proof/stage5_harness.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import): imports.extend(alias.name for alias in node.names)
            if isinstance(node, ast.ImportFrom): imports.append(node.module or "")
        forbidden = ("paper", "testnet", "live", "broker", "fillsimulator")
        self.assertFalse(any(any(word in name.lower() for word in forbidden) for name in imports))


if __name__ == "__main__":
    unittest.main()
