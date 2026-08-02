"""Stage 5R1 protective strategy bridge — comprehensive tests."""

import unittest

from quant_engine.proof.stage5r1_replay import ReplayBar
from quant_engine.proof.stage5r1_capital import CapitalModel, CostModel, PositionSide
from quant_engine.proof.stage5_lifecycle_plan import (
    Stage5LifecycleAction, Stage5LifecycleOrigin,
    create_stage5_lifecycle_instruction, build_stage5_lifecycle_plan,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256
from quant_engine.proof.stage5r1_protective_strategy_bridge import (
    ProtectiveStrategyPlan,
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


def _make_plan(enter_times, exit_times, actions):
    """Build a valid lifecycle plan with the given enter/exit times."""
    insts = []
    for t, a in zip(enter_times, actions):
        insts.append(create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=t, action=Stage5LifecycleAction[a],
            origin=Stage5LifecycleOrigin.STRATEGY))
    for t in exit_times:
        insts.append(create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=t, action=Stage5LifecycleAction.EXIT,
            origin=Stage5LifecycleOrigin.STRATEGY))
    insts.sort(key=lambda i: i.signal_bar_open_time_ms)
    first_time = insts[0].signal_bar_open_time_ms
    start = (first_time // 300000) * 300000
    end = start + 50 * 300000
    return build_stage5_lifecycle_plan(
        strategy_id="s1", spec_id=_ID({"s": 1}), parameter_id=_ID({"p": 1}),
        dataset_id=_ID({"d": 1}), symbol="X", warmup_bars=10,
        scored_start_open_time_ms=start,
        scored_end_exclusive_open_time_ms=end,
        terminal_execution_bar_open_time_ms=end,
        instructions=tuple(insts))


# ======== Plan Construction Tests ========

class PlanConstructionTests(unittest.TestCase):
    def test_long_plan(self):
        plan = _make_plan([0], [300000], ["ENTER_LONG"])
        psp = ProtectiveStrategyPlan(plan=plan, stop_loss_bps=100, take_profit_bps=200)
        self.assertEqual(psp.side, PositionSide.LONG)
        self.assertEqual(len(psp.plan_id), 64)

    def test_short_plan(self):
        plan = _make_plan([0], [300000], ["ENTER_SHORT"])
        psp = ProtectiveStrategyPlan(plan=plan, stop_loss_bps=50, take_profit_bps=100)
        self.assertEqual(psp.side, PositionSide.SHORT)

    def test_no_enter_rejected(self):
        with self.assertRaises(ValueError):
            plan = _make_plan([], [300000], [])  # no enters
            ProtectiveStrategyPlan(plan=plan, stop_loss_bps=100, take_profit_bps=200)

    def test_bad_plan_type(self):
        with self.assertRaises(ValueError):
            ProtectiveStrategyPlan(plan=object(), stop_loss_bps=100, take_profit_bps=200)

    def test_bad_bps(self):
        plan = _make_plan([0], [300000], ["ENTER_LONG"])
        for bad_sl, bad_tp in [(-1, 200), (0, 200), (True, 200), (100, True)]:
            with self.assertRaises(ValueError):
                ProtectiveStrategyPlan(plan=plan, stop_loss_bps=bad_sl, take_profit_bps=bad_tp)

    def test_deterministic(self):
        plan = _make_plan([0], [300000], ["ENTER_LONG"])
        p1 = ProtectiveStrategyPlan(plan=plan, stop_loss_bps=100, take_profit_bps=200)
        p2 = ProtectiveStrategyPlan(plan=plan, stop_loss_bps=100, take_profit_bps=200)
        self.assertEqual(p1.plan_id, p2.plan_id)

    def test_different_bps_different_id(self):
        plan = _make_plan([0], [300000], ["ENTER_LONG"])
        p1 = ProtectiveStrategyPlan(plan=plan, stop_loss_bps=100, take_profit_bps=200)
        p2 = ProtectiveStrategyPlan(plan=plan, stop_loss_bps=150, take_profit_bps=200)
        self.assertNotEqual(p1.plan_id, p2.plan_id)

    def test_frozen(self):
        plan = _make_plan([0], [300000], ["ENTER_LONG"])
        psp = ProtectiveStrategyPlan(plan=plan, stop_loss_bps=100, take_profit_bps=200)
        with self.assertRaises(Exception):
            psp.plan_id = "changed"


# ======== Bridge Run Tests ========

class BridgeRunTests(unittest.TestCase):
    def test_long_explicit_exit(self):
        bars = _bars(200)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        psp, result = run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=5000, take_profit_bps=5000,  # BPS < 10000
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.trade_count, 1)
        self.assertIn(result.selections[0].source, ("PROTECTIVE", "EXPLICIT_NEXT_OPEN"))

    def test_short_explicit_exit(self):
        bars = _bars(200)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_SHORT"])
        psp, result = run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=5000, take_profit_bps=5000,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.trade_count, 1)

    def test_stop_loss_triggers(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[105].open, bars[105].high,
                         bars[100].open * 0.9, bars[105].close)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        psp, result = run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=50, take_profit_bps=10000,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.selections[0].source, "PROTECTIVE")
        self.assertEqual(result.selections[0].reason, "STOP_LOSS")

    def test_take_profit_triggers(self):
        bars = list(_bars(200))
        # Bar 105: high above entry → target hit
        bars[105] = _bar(bars[105].open_time_ms, 305, 308, 304, 306)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        psp, result = run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=5000, take_profit_bps=10,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.selections[0].source, "PROTECTIVE")
        self.assertEqual(result.selections[0].reason, "TAKE_PROFIT")

    def test_deterministic_replay(self):
        bars = _bars(200)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        r1 = run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=100, take_profit_bps=200,
            capital=_CM, cost=_ZC, symbol="X")
        r2 = run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=100, take_profit_bps=200,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(r1[1].replay_id, r2[1].replay_id)

    def test_caller_bars_not_mutated(self):
        bars = list(_bars(200))
        snap = tuple(bars)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=100, take_profit_bps=200,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(tuple(bars), snap)

class EdgeCaseTests(unittest.TestCase):
    def test_gap_open_trigger(self):
        bars = list(_bars(200))
        bars[105] = _bar(bars[105].open_time_ms, bars[100].open * 0.85,
                         bars[100].open * 0.86, bars[100].open * 0.84, bars[100].open * 0.855)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        psp, result = run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=50, take_profit_bps=10000,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.selections[0].source, "PROTECTIVE")

    def test_same_bar_collision_stop_wins(self):
        bars = list(_bars(200))
        # Entry=300, stop=297 (100bps), tp=999 (no target trigger)
        # Bar 105: open=300 (no gap), low=295 (intrabar stop), high=301 (no target)
        bars[105] = _bar(bars[105].open_time_ms, 300, 301, 295, 300)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        psp, result = run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=100, take_profit_bps=5000,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.selections[0].reason, "STOP_LOSS")

    def test_entry_bar_protective(self):
        bars = list(_bars(200))
        bars[100] = _bar(bars[100].open_time_ms, 300, 301, 295, 300.5)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        psp, result = run_protective_strategy_replay(
            bars=bars, plan=plan, stop_loss_bps=10, take_profit_bps=5000,
            capital=_CM, cost=_ZC, symbol="X")
        self.assertEqual(result.selections[0].source, "PROTECTIVE")


class ValidationTests(unittest.TestCase):
    def test_bad_plan_type_in_run(self):
        bars = _bars(200)
        with self.assertRaises(ValueError):
            run_protective_strategy_replay(bars=bars, plan=object(), capital=_CM, cost=_ZC, symbol="X")

    def test_bad_capital_type(self):
        bars = _bars(200)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        with self.assertRaises(ValueError):
            run_protective_strategy_replay(bars=bars, plan=plan, capital=object(), cost=_ZC, symbol="X")

    def test_empty_symbol(self):
        bars = _bars(200)
        plan = _make_plan([bars[99].open_time_ms], [bars[110].open_time_ms], ["ENTER_LONG"])
        with self.assertRaises(ValueError):
            run_protective_strategy_replay(bars=bars, plan=plan, capital=_CM, cost=_ZC, symbol="")


if __name__ == "__main__":
    unittest.main()
