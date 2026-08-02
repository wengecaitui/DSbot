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


def _build_plan(enter_infos, exit_times, symbol="X"):
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
        dataset_id=_ID({"d": 1}), symbol=symbol, warmup_bars=10,
        scored_start_open_time_ms=start, scored_end_exclusive_open_time_ms=end,
        terminal_execution_bar_open_time_ms=end, instructions=tuple(insts))


def _wrap_compilation(plan):
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


# ======== Entry + Validation ========

class EntryTests(unittest.TestCase):
    def test_long_exit(self):
        bars = _bars(200)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=5000, take_profit_bps=5000, capital=_CM, cost=_ZC)
        self.assertEqual(result.replay_result.trade_count, 1)

    def test_compilation_rejected_reused(self):
        """Compilation.__post_init__ re-executed on each bridge call."""
        bars = _bars(200)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        comp = _wrap_compilation(plan)
        # First call succeeds
        r1 = run_protective_strategy_replay(bars=bars, compilation=comp, capital=_CM, cost=_ZC)
        # Second call succeeds (same compilation, re-validated)
        r2 = run_protective_strategy_replay(bars=bars, compilation=comp, capital=_CM, cost=_ZC)
        self.assertEqual(r1.bridge_id, r2.bridge_id)

    def test_bad_compilation_type(self):
        with self.assertRaises(ValueError):
            run_protective_strategy_replay(bars=_bars(200), compilation=object(), capital=_CM, cost=_ZC)


# ======== Per-Trade Side ========

class PerTradeSideTests(unittest.TestCase):
    def test_long_stop(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[105].open, bars[105].high,
                         bars[100].open * 0.9, bars[105].close)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=50, take_profit_bps=5000, capital=_CM, cost=_ZC)
        self.assertEqual(result.replay_result.selections[0].reason, "STOP_LOSS")

    def test_short_stop(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[105].open, bars[100].open * 1.05,
                         bars[105].low, bars[105].close)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_SHORT")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=50, take_profit_bps=5000, capital=_CM, cost=_ZC)
        self.assertEqual(result.replay_result.selections[0].reason, "STOP_LOSS")


# ======== Real Reversal / Terminal Tests ========

class ReversalAndTerminalTests(unittest.TestCase):
    def test_reverse_to_long_in_compilation_rejected(self):
        """Real compilation with REVERSE_TO_LONG is fail-closed."""
        bars = _bars(300)
        insts = (create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=bars[99].open_time_ms,
            action=Stage5LifecycleAction.ENTER_SHORT, origin=Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=bars[150].open_time_ms,
            action=Stage5LifecycleAction.REVERSE_TO_LONG, origin=Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=bars[155].open_time_ms,
            action=Stage5LifecycleAction.EXIT, origin=Stage5LifecycleOrigin.STRATEGY))
        insts = tuple(sorted(insts, key=lambda i: i.signal_bar_open_time_ms))
        start = (insts[0].signal_bar_open_time_ms // 300000) * 300000
        end = start + 100 * 300000
        plan = build_stage5_lifecycle_plan(
            strategy_id="s1", spec_id=_ID({"s": 1}), parameter_id=_ID({"p": 1}),
            dataset_id=_ID({"d": 1}), symbol="X", warmup_bars=10,
            scored_start_open_time_ms=start, scored_end_exclusive_open_time_ms=end,
            terminal_execution_bar_open_time_ms=end, instructions=insts)
        with self.assertRaisesRegex(ValueError, "REVERSAL_NOT_SUPPORTED"):
            run_protective_strategy_replay(
                bars=bars, compilation=_wrap_compilation(plan), capital=_CM, cost=_ZC)

    def test_reverse_to_short_in_compilation_rejected(self):
        bars = _bars(300)
        insts = (create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=bars[99].open_time_ms,
            action=Stage5LifecycleAction.ENTER_LONG, origin=Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=bars[150].open_time_ms,
            action=Stage5LifecycleAction.REVERSE_TO_SHORT, origin=Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=bars[155].open_time_ms,
            action=Stage5LifecycleAction.EXIT, origin=Stage5LifecycleOrigin.STRATEGY))
        insts = tuple(sorted(insts, key=lambda i: i.signal_bar_open_time_ms))
        start = (insts[0].signal_bar_open_time_ms // 300000) * 300000
        end = start + 100 * 300000
        plan = build_stage5_lifecycle_plan(
            strategy_id="s1", spec_id=_ID({"s": 1}), parameter_id=_ID({"p": 1}),
            dataset_id=_ID({"d": 1}), symbol="X", warmup_bars=10,
            scored_start_open_time_ms=start, scored_end_exclusive_open_time_ms=end,
            terminal_execution_bar_open_time_ms=end, instructions=insts)
        with self.assertRaisesRegex(ValueError, "REVERSAL_NOT_SUPPORTED"):
            run_protective_strategy_replay(
                bars=bars, compilation=_wrap_compilation(plan), capital=_CM, cost=_ZC)

    def test_terminal_exit_mapped_to_next_open_exit(self):
        """TERMINAL_EXIT maps to Replay EXIT with next-open semantics."""
        bars = _bars(300)
        insts = (create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=bars[99].open_time_ms,
            action=Stage5LifecycleAction.ENTER_LONG, origin=Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=bars[260].open_time_ms,
            action=Stage5LifecycleAction.TERMINAL_EXIT, origin=Stage5LifecycleOrigin.TERMINAL_POLICY))
        insts = tuple(sorted(insts, key=lambda i: i.signal_bar_open_time_ms))
        start = (insts[0].signal_bar_open_time_ms // 300000) * 300000
        end = (insts[1].signal_bar_open_time_ms // 300000 + 1) * 300000
        plan = build_stage5_lifecycle_plan(
            strategy_id="s1", spec_id=_ID({"s": 1}), parameter_id=_ID({"p": 1}),
            dataset_id=_ID({"d": 1}), symbol="X", warmup_bars=10,
            scored_start_open_time_ms=start, scored_end_exclusive_open_time_ms=end,
            terminal_execution_bar_open_time_ms=end, instructions=insts)
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=5000, take_profit_bps=5000, capital=_CM, cost=_ZC)
        self.assertEqual(result.replay_result.trade_count, 1)


# ======== Protective Triggers ========

class ProtectiveTriggerTests(unittest.TestCase):
    def test_stop_loss(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[105].open, bars[105].high,
                         bars[100].open * 0.9, bars[105].close)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=50, take_profit_bps=5000, capital=_CM, cost=_ZC)
        self.assertEqual(result.replay_result.selections[0].source, "PROTECTIVE")

    def test_take_profit(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, 305, 308, 304, 306)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=5000, take_profit_bps=10, capital=_CM, cost=_ZC)
        self.assertEqual(result.replay_result.selections[0].reason, "TAKE_PROFIT")

    def test_gap_open(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[100].open * 0.85,
                         bars[100].open * 0.86, bars[100].open * 0.84, bars[100].open * 0.855)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=50, take_profit_bps=5000, capital=_CM, cost=_ZC)
        self.assertEqual(result.replay_result.selections[0].source, "PROTECTIVE")

    def test_entry_bar(self):
        bars = list(_bars(200))
        bars[100] = _bar(bars[100].open_time_ms, 300, 301, 295, 300.5)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=10, take_profit_bps=5000, capital=_CM, cost=_ZC)
        self.assertEqual(result.replay_result.selections[0].source, "PROTECTIVE")

    def test_collision(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, 300, 301, 295, 300)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        result = run_protective_strategy_replay(
            bars=bars, compilation=_wrap_compilation(plan),
            stop_loss_bps=100, take_profit_bps=5000, capital=_CM, cost=_ZC)
        self.assertEqual(result.replay_result.selections[0].reason, "STOP_LOSS")


# ======== Determinism + Immutability ========

class DeterminismTests(unittest.TestCase):
    def test_deterministic(self):
        bars = _bars(200)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        comp = _wrap_compilation(plan)
        r1 = run_protective_strategy_replay(bars=bars, compilation=comp, capital=_CM, cost=_ZC)
        r2 = run_protective_strategy_replay(bars=bars, compilation=comp, capital=_CM, cost=_ZC)
        self.assertEqual(r1.bridge_id, r2.bridge_id)

    def test_caller_bars_unchanged(self):
        bars = list(_bars(200))
        snap = tuple(bars)
        plan = _build_plan([(bars[99].open_time_ms, "ENTER_LONG")], [bars[110].open_time_ms])
        run_protective_strategy_replay(bars=bars, compilation=_wrap_compilation(plan), capital=_CM, cost=_ZC)
        self.assertEqual(tuple(bars), snap)

    def test_frozen(self):
        plan = _build_plan([(_bars(200)[99].open_time_ms, "ENTER_LONG")], [_bars(200)[110].open_time_ms])
        r = run_protective_strategy_replay(bars=_bars(200), compilation=_wrap_compilation(plan), capital=_CM, cost=_ZC)
        with self.assertRaises(Exception):
            r.bridge_id = "changed"


if __name__ == "__main__":
    unittest.main()
