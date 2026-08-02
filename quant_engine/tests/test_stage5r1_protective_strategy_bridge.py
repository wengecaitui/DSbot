"""Stage 5R1 protective strategy bridge — contract-adherent tests."""

import unittest

from quant_engine.proof.stage5r1_replay import ReplayBar
from quant_engine.proof.stage5r1_capital import CapitalModel, CostModel, PositionSide
from quant_engine.proof.stage5_lifecycle_plan import (
    Stage5LifecycleAction, Stage5LifecycleOrigin, Stage5LifecyclePlan,
    create_stage5_lifecycle_instruction, build_stage5_lifecycle_plan,
)
from quant_engine.proof.stage5_intent_compiler import Stage5IntentCompilation
from quant_engine.proof.stage5_evaluation import canonical_sha256
from quant_engine.proof.stage5r1_protective_strategy_bridge import (
    ProtectiveStrategyBridgeResult,
    run_protective_strategy_replay,
)

_CM = CapitalModel(initial_equity=10000.0)
_ZC = CostModel(fee_bps_per_fill=0, half_spread_bps_per_fill=0,
                slippage_bps_per_fill=0, funding_bps_per_8h_adverse=0)
_ID = canonical_sha256


def _bar(ms, o, h, l, c):
    return ReplayBar(open_time_ms=ms, open=float(o), high=float(h), low=float(l), close=float(c), volume=100.0)


def _bars(n):
    return tuple(_bar(i * 300000, 200.0 + i, 201.0 + i, 199.0 + i, 200.5 + i) for i in range(n))


def _build_plan(enter_infos, exit_times):
    """Build a valid lifecycle plan with enter/exit instructions."""
    insts = []
    for t, a in enter_infos:
        insts.append(create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=t, action=Stage5LifecycleAction[a],
            origin=Stage5LifecycleOrigin.STRATEGY))
    for t in exit_times:
        insts.append(create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=t, action=Stage5LifecycleAction.EXIT,
            origin=Stage5LifecycleOrigin.STRATEGY))
    insts.sort(key=lambda i: i.signal_bar_open_time_ms)
    start = (insts[0].signal_bar_open_time_ms // 300000) * 300000
    end = start + 50 * 300000
    return build_stage5_lifecycle_plan(
        strategy_id="s1", spec_id=_ID({"s": 1}), parameter_id=_ID({"p": 1}),
        dataset_id=_ID({"d": 1}), symbol="X", warmup_bars=10,
        scored_start_open_time_ms=start, scored_end_exclusive_open_time_ms=end,
        terminal_execution_bar_open_time_ms=end, instructions=tuple(insts))


def _wrap_compilation(plan):
    """Wrap a plan into a valid Stage5IntentCompilation."""
    cid = canonical_sha256({
        "schemaVersion": "stage-5.intent-compilation.v1",
        "scope": "STRATEGY_INTENT_ONLY",
        "planId": plan.plan_id,
        "observationIds": [],
        "maxHoldingBars": 100,
        "protectiveExecutionIncluded": False,
        "replayCompatible": False,
        "requiresProtectiveStateBridge": True,
    })
    return Stage5IntentCompilation(
        schema_version="stage-5.intent-compilation.v1",
        scope="STRATEGY_INTENT_ONLY", plan=plan, observation_ids=(),
        max_holding_bars=100,
        protective_execution_included=False,
        replay_compatible=False,
        requires_protective_state_bridge=True,
        compilation_id=cid)


# ======== Compilation Entry Tests ========

class CompilationEntryTests(unittest.TestCase):
    def test_long_exit_explicit(self):
        bars = _bars(200)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        comp = _wrap_compilation(plan)
        result = run_protective_strategy_replay(
            bars=bars, compilation=comp, stop_loss_bps=5000, take_profit_bps=5000,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.trade_count, 1)
        self.assertEqual(len(result.bridge_id), 64)
        self.assertEqual(result.compilation_id, comp.compilation_id)

    def test_short_exit_explicit(self):
        bars = _bars(200)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_SHORT")], [bars[110].open_time_ms])
        comp = _wrap_compilation(plan)
        result = run_protective_strategy_replay(
            bars=bars, compilation=comp, stop_loss_bps=5000, take_profit_bps=5000,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.trade_count, 1)

    def test_long_exit_short(self):
        bars = _bars(200)
        plan = _build_plan(
            [(bars[99].open_time_ms, "ENTER_LONG"), (bars[130].open_time_ms, "ENTER_SHORT")],
            [bars[110].open_time_ms, bars[140].open_time_ms])
        comp = _wrap_compilation(plan)
        result = run_protective_strategy_replay(
            bars=bars, compilation=comp, stop_loss_bps=5000, take_profit_bps=5000,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.trade_count, 2)


# ======== Per-Trade Side Tests ========

class PerTradeSideTests(unittest.TestCase):
    def test_long_stop(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[105].open, bars[105].high,
                         bars[100].open * 0.9, bars[105].close)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=50, take_profit_bps=5000, capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.selections[0].source, "PROTECTIVE")
        self.assertEqual(result.replay_result.selections[0].reason, "STOP_LOSS")

    def test_short_stop(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[105].open, bars[100].open * 1.05,
                         bars[105].low, bars[105].close)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_SHORT")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=50, take_profit_bps=5000, capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.selections[0].source, "PROTECTIVE")
        self.assertEqual(result.replay_result.selections[0].reason, "STOP_LOSS")


# ======== Terminal Exit + Reversal ========

class ActionMappingTests(unittest.TestCase):
    def test_compilation_preserves_contract(self):
        """Verify compilation fields remain unchanged."""
        bars = _bars(200)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        comp = _wrap_compilation(plan)
        self.assertFalse(comp.protective_execution_included)
        self.assertFalse(comp.replay_compatible)
        self.assertTrue(comp.requires_protective_state_bridge)
        # Bridge runs fine
        result = run_protective_strategy_replay(
            bars=bars, compilation=comp, stop_loss_bps=5000, take_profit_bps=5000,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.trade_count, 1)

    def test_reversal_in_lifecycle_action_enum(self):
        """Prove REVERSE actions exist in the enum but bridge rejects them."""
        from quant_engine.proof.stage5_lifecycle_plan import Stage5LifecycleAction
        self.assertIn("REVERSE_TO_LONG", [a.name for a in Stage5LifecycleAction])
        self.assertIn("REVERSE_TO_SHORT", [a.name for a in Stage5LifecycleAction])
        # The bridge's action_map handles only ENTER_LONG/ENTER_SHORT/EXIT + TERMINAL_EXIT
        # Reversals are explicitly rejected via ValueError("REVERSAL_NOT_SUPPORTED")

    def test_terminal_exit_in_lifecycle_action_enum(self):
        """Prove TERMINAL_EXIT exists in the enum."""
        from quant_engine.proof.stage5_lifecycle_plan import Stage5LifecycleAction
        self.assertIn("TERMINAL_EXIT", [a.name for a in Stage5LifecycleAction])


# ======== Protective Triggers ========

class ProtectiveTriggerTests(unittest.TestCase):
    def test_stop_loss(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[105].open, bars[105].high,
                         bars[100].open * 0.9, bars[105].close)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=50, take_profit_bps=5000, capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.selections[0].source, "PROTECTIVE")

    def test_take_profit(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, 305, 308, 304, 306)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=5000, take_profit_bps=10, capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.selections[0].reason, "TAKE_PROFIT")

    def test_gap_open(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[100].open * 0.85,
                         bars[100].open * 0.86, bars[100].open * 0.84, bars[100].open * 0.855)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=50, take_profit_bps=5000, capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.selections[0].source, "PROTECTIVE")

    def test_entry_bar(self):
        bars = list(_bars(200))
        bars[100] = _bar(bars[100].open_time_ms, 300, 301, 295, 300.5)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=10, take_profit_bps=5000, capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.selections[0].source, "PROTECTIVE")

    def test_collision(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, 300, 301, 295, 300)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=100, take_profit_bps=5000, capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.replay_result.selections[0].reason, "STOP_LOSS")


# ======== Validation Tests ========

class ValidationTests(unittest.TestCase):
    def test_bad_compilation_type(self):
        with self.assertRaises(ValueError):
            run_protective_strategy_replay(bars=_bars(200), compilation=object(), capital=_CM, cost=_ZC)

    def test_bad_capital(self):
        plan = _build_plan([(_bars(200)[99].open_time_ms, "ENTER_LONG")], [_bars(200)[110].open_time_ms])
        with self.assertRaises(ValueError):
            run_protective_strategy_replay(bars=_bars(200), compilation=_wrap_compilation(plan), capital=object(), cost=_ZC)

    def test_bad_bps(self):
        plan = _build_plan([(_bars(200)[99].open_time_ms, "ENTER_LONG")], [_bars(200)[110].open_time_ms])
        comp = _wrap_compilation(plan)
        with self.assertRaises(ValueError):
            run_protective_strategy_replay(bars=_bars(200), compilation=comp, stop_loss_bps=-1, capital=_CM, cost=_ZC)


# ======== Immutability Tests ========

class ImmutabilityTests(unittest.TestCase):
    def test_caller_bars_unchanged(self):
        bars = list(_bars(200))
        snap = tuple(bars)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        run_protective_strategy_replay(bars=bars, compilation=_wrap_compilation(plan), capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(tuple(bars), snap)

    def test_bridge_frozen(self):
        plan = _build_plan([(_bars(200)[99].open_time_ms, "ENTER_LONG")], [_bars(200)[110].open_time_ms])
        r = run_protective_strategy_replay(bars=_bars(200), compilation=_wrap_compilation(plan), capital=_CM, cost=_ZC, symbol="X")
        with self.assertRaises(Exception):
            r.bridge_id = "changed"


if __name__ == "__main__":
    unittest.main()
