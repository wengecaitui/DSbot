"""Stage 5R1.3-D protective replay integration tests."""

import unittest

from quant_engine.proof.stage5r1_replay import ReplayAction, ReplayBar, ReplayConfig, ReplayInstruction
from quant_engine.proof.stage5r1_capital import CapitalModel, CostModel, PositionSide
from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitPlan
from quant_engine.proof.stage5r1_protective_replay import (
    ProtectiveReplayBinding, run_stage5r1_protective_replay,
)


def bar(ms, o, h, l, c, v=100.0):
    return ReplayBar(open_time_ms=ms, open=float(o), high=float(h), low=float(l), close=float(c), volume=v)

def bars(n, start=0):
    return tuple(bar(start + i * 300000, 200.0 + i, 201.0 + i, 199.0 + i, 200.5 + i) for i in range(n))

_CM = CapitalModel(initial_equity=10000.0)
_ZC = CostModel(fee_bps_per_fill=0, half_spread_bps_per_fill=0, slippage_bps_per_fill=0, funding_bps_per_8h_adverse=0)

# Entry at bar[100] = 300.0. stop=290, tp=310 for LONG. SHORT: tp=290, stop=310.
def _p_long(entry=None, stop=290.0, tp=310.0):
    """LONG plan: stop < entry < tp"""
    return ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=entry or 300.0, stop_price=stop, take_profit_price=tp)

def _p_short(entry=None, stop=310.0, tp=290.0):
    """SHORT plan: tp < entry < stop"""
    return ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=entry or 300.0, stop_price=stop, take_profit_price=tp)

def _insts(b, entry_sig=99, exit_sig=110, action=ReplayAction.ENTER_LONG):
    return (ReplayInstruction(signal_bar_open_time_ms=b[entry_sig].open_time_ms, action=action),
            ReplayInstruction(signal_bar_open_time_ms=b[exit_sig].open_time_ms, action=ReplayAction.EXIT))


def _run(b, insts, p, cfg=ReplayConfig(symbol="BTC/USDT")):
    bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
    return run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=cfg, capital=_CM, cost=_ZC)


class LongProtectiveTests(unittest.TestCase):
    # Entry at bar[100] = 300.0. stop=290, tp=310.

    def test_long_intrabar_stop(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)  # low=289 < stop=290
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")
        self.assertEqual(r.selections[0].reason, "STOP_LOSS")

    def test_long_intrabar_target(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 305.0, 312.0, 304.0, 305.5)  # high=312 > tp=310
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")

    def test_gap_stop(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 289.0, 290.0, 288.0, 289.5)  # open=289 <= stop=290
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_gap_target(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 312.0, 313.0, 311.0, 312.5)  # open=312 >= tp=310
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")

    def test_entry_bar_stop(self):
        b = list(bars(200, 0))
        b[100] = bar(b[100].open_time_ms, 300.0, 301.0, 289.0, 300.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_entry_bar_collision(self):
        b = list(bars(200, 0))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 289.0, 300.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "STOP_LOSS")

    def test_explicit_fallback(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")

    def test_trigger_on_exit_signal_bar(self):
        b = list(bars(200, 0))
        b[110] = bar(b[110].open_time_ms, b[110].open, b[110].high, 289.0, b[110].close)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_multi_trade_compounding(self):
        b = bars(300, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[170].open_time_ms, action=ReplayAction.EXIT))
        p1 = _p_long(stop=100.0, tp=999.0)
        p2 = _p_long(entry=351.0, stop=100.0, tp=999.0)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p1),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[150].open_time_ms, plan=p2))
        r = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r.trade_count, 2)


class ShortProtectiveTests(unittest.TestCase):
    # Entry at bar[100] = 300.0. SHORT: tp=290 < entry=300 < stop=310

    def test_short_intrabar_stop(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 305.0, 312.0, 304.0, 305.5)  # high=312 > stop=310
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_short_intrabar_target(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 305.0, 306.0, 288.0, 305.5)  # low=288 < tp=290
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")

    def test_short_gap_stop(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 312.0, 313.0, 311.0, 312.5)  # open=312 > stop=310
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_short_gap_target(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 288.0, 289.0, 287.0, 288.5)  # open=288 < tp=290
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")


class ValidationTests(unittest.TestCase):
    def test_side_mismatch_rejected(self):
        b = bars(200, 0)
        insts = _insts(b, action=ReplayAction.ENTER_SHORT)
        p = _p_long()  # LONG plan for SHORT action
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_entry_ref_mismatch_rejected(self):
        b = bars(200, 0)
        insts = _insts(b)
        p = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=999.0, stop_price=900.0, take_profit_price=1200.0)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_missing_binding_rejected(self):
        b = bars(200, 0)
        insts = _insts(b)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=(),
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_extra_binding_rejected(self):
        b = bars(200, 0)
        insts = _insts(b)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[150].open_time_ms, plan=p))
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_fake_binding_rejected(self):
        b = bars(200, 0)
        insts = _insts(b)
        fake = type("FakeBinding", (), {"entry_signal_bar_open_time_ms": 0, "plan": _p_long()})()
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=[fake],
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_odd_instructions_rejected(self):
        b = bars(200, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_exit_first_rejected(self):
        b = bars(200, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.ENTER_LONG))
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)


class DeterminismTests(unittest.TestCase):
    def test_repeated_identical(self):
        b = bars(200, 0)
        insts = _insts(b)
        p = _p_long(stop=100.0, tp=999.0)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.replay_id, r2.replay_id)

    def test_post_trigger_independence(self):
        b1 = list(bars(200, 0))
        b1[105] = bar(b1[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)
        insts = _insts(b1)
        b2 = list(b1)
        b2[106] = bar(b2[106].open_time_ms, 999.0, 1000.0, 998.0, 999.5)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind,
                                            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind,
                                            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertEqual(r1.trades[0].accounting_id, r2.trades[0].accounting_id)

    def test_binding_immutability(self):
        p = _p_long()
        b = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p)
        with self.assertRaises(Exception):
            b.plan = p  # type: ignore

    def test_trade_immutability(self):
        b = bars(200, 0)
        insts = _insts(b)
        p = _p_long(stop=100.0, tp=999.0)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        r = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        with self.assertRaises(Exception):
            r.trades[0].trade_index = 99


class EntryBarZeroDurationTests(unittest.TestCase):
    def test_entry_bar_stop_zero_duration(self):
        b = list(bars(200, 0))
        b[100] = bar(b[100].open_time_ms, 300.0, 301.0, 289.0, 300.5)
        insts = _insts(b)
        r = _run(b, insts, _p_long())
        self.assertEqual(r.trade_count, 1)
        self.assertEqual(r.selections[0].entry_execution_time_ms, r.selections[0].selected_exit_bar_open_time_ms)


    def test_explicit_exec_bar_gap_ignored(self):
        """Explicit exit execution bar open doesn't trigger protective even if it gaps."""
        b = list(bars(200, 0))
        # Protective trigger is at bar 105, explicit exit is at bar 111 (next-open after signal 110)
        b[111] = bar(b[111].open_time_ms, 289.0, 290.0, 288.0, 289.5)  # gap-stop at explicit exec bar
        insts = _insts(b)
        p = _p_long(stop=100.0, tp=999.0)  # far from trigger
        r = _run(b, insts, p)
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")

    def test_entry_bar_target(self):
        b = list(bars(200, 0))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 299.0, 300.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")

    def test_short_entry_bar_stop(self):
        b = list(bars(200, 0))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 299.0, 300.5)  # high=312 > stop=310
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_short_explicit_fallback(self):
        b = bars(200, 0)
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short(stop=999.0, tp=100.0))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")


class EarliestTriggerTests(unittest.TestCase):
    def test_earliest_bar_wins_long(self):
        b = list(bars(200, 0))
        b[103] = bar(b[103].open_time_ms, 303.0, 304.0, 289.0, 303.5)  # stop at 103
        b[105] = bar(b[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)  # stop at 105 too
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].selected_exit_bar_index, 103)

    def test_earliest_bar_wins_short(self):
        b = list(bars(200, 0))
        b[103] = bar(b[103].open_time_ms, 303.0, 312.0, 302.0, 303.5)
        b[105] = bar(b[105].open_time_ms, 305.0, 312.0, 304.0, 305.5)
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].selected_exit_bar_index, 103)


class IdentityTests(unittest.TestCase):
    def test_binding_id_deterministic(self):
        p1 = _p_long()
        p2 = _p_long()
        b1 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p1)
        b2 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p2)
        self.assertEqual(b1.binding_id, b2.binding_id)

    def test_different_entry_time_different_binding(self):
        p = _p_long()
        b1 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p)
        b2 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=300000, plan=p)
        self.assertNotEqual(b1.binding_id, b2.binding_id)

    def test_different_plan_different_binding(self):
        p1 = _p_long(entry=300.0, stop=290.0, tp=310.0)
        p2 = _p_long(entry=300.0, stop=280.0, tp=310.0)
        b1 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p1)
        b2 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p2)
        self.assertNotEqual(b1.binding_id, b2.binding_id)


class PostTriggerIndependenceTests(unittest.TestCase):
    """Prove incremental resolution: post-trigger bars don't affect selection/accounting."""

    def test_volume_change_post_trigger_no_effect(self):
        b1 = list(bars(200, 0))
        b1[105] = bar(b1[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)
        insts = _insts(b1)
        b2 = list(b1)
        b2[106] = bar(b2[106].open_time_ms, b2[106].open, b2[106].high, b2[106].low, b2[106].close, v=9999.0)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind,
                                            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind,
                                            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        # Selection should be identical
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        # But dataset/replay IDs change due to volume in dataset
        self.assertNotEqual(r1.dataset_id, r2.dataset_id)


    def test_exact_stop_boundary_triggers(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 305.0, 306.0, 290.0, 305.5)  # low=290 == stop
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "STOP_LOSS")

    def test_exact_target_boundary_triggers(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 305.0, 310.0, 304.0, 305.5)  # high=310 == tp
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")

    def test_long_gap_stop_below(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 280.0, 281.0, 279.0, 280.5)  # open=280 << stop=290
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_short_gap_stop_above(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 315.0, 316.0, 314.0, 315.5)  # open=315 >> stop=310
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")


class MultipleTradeTests(unittest.TestCase):
    def test_three_trades_sequential(self):
        b = bars(500, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[170].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[200].open_time_ms, action=ReplayAction.ENTER_SHORT),
                 ReplayInstruction(signal_bar_open_time_ms=b[220].open_time_ms, action=ReplayAction.EXIT))
        p_long = _p_long(stop=100.0, tp=999.0)
        p_long2 = _p_long(entry=351.0, stop=100.0, tp=999.0)
        p_short = _p_short(entry=401.0, stop=999.0, tp=100.0)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p_long),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[150].open_time_ms, plan=p_long2),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[200].open_time_ms, plan=p_short))
        r = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r.trade_count, 3)

    def test_mixed_protective_explicit(self):
        b = list(bars(300, 0))
        b[105] = bar(b[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)  # trade1: protective stop
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[170].open_time_ms, action=ReplayAction.EXIT))
        p1 = _p_long()
        p2 = _p_long(entry=351.0, stop=100.0, tp=999.0)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p1),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[150].open_time_ms, plan=p2))
        r = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                           config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r.trade_count, 2)
        self.assertEqual(r.selections[0].source, "PROTECTIVE")
        self.assertEqual(r.selections[1].source, "EXPLICIT_NEXT_OPEN")


class PlanTypeValidationTests(unittest.TestCase):
    def test_subclass_plan_rejected(self):
        b = bars(200, 0)
        class FakePlan(ProtectiveExitPlan): pass
        fp = FakePlan(side=PositionSide.LONG, entry_reference_price=300.0, stop_price=290.0, take_profit_price=310.0)
        with self.assertRaises(ValueError):
            ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=fp)


class EdgeCaseTests(unittest.TestCase):
    def test_short_same_bar_stop_wins(self):
        b = list(bars(200, 0))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 288.0, 300.5)  # high=312 > stop=310, low=288 < tp=290
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].reason, "STOP_LOSS")

    def test_explicit_outcome_superseded(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].explicit_outcome, "SUPERSEDED_BY_PROTECTIVE")

    def test_explicit_outcome_executed(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].explicit_outcome, "EXECUTED_NEXT_OPEN")

    def test_selections_length_matches_trades(self):
        b = bars(200, 0)
        r1 = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(len(r1.selections), len(r1.trades))

    def test_arbitration_policy_field(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].arbitration_policy, "PROTECTIVE_THROUGH_EXIT_SIGNAL_BAR_THEN_EXPLICIT_NEXT_OPEN")

    def test_counting_time_policy_field(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].accounting_time_policy, "TRIGGER_BAR_OPEN_TIME")

    def test_config_symbol_binds_replay(self):
        b = bars(200, 0)
        insts = _insts(b)
        p = _p_long(stop=100.0, tp=999.0)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                                            config=ReplayConfig(symbol="ETH/USDT"), capital=_CM, cost=_ZC)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_bars_not_mutated(self):
        b = list(bars(200, 0))
        snap = tuple(b)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(tuple(b), snap)


if __name__ == "__main__":
    unittest.main()
