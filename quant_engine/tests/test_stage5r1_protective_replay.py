"""Stage 5R1.3-D protective replay integration tests — hardened."""

import unittest

from quant_engine.proof.stage5r1_replay import ReplayAction, ReplayBar, ReplayConfig, ReplayInstruction
from quant_engine.proof.stage5r1_capital import CapitalModel, CostModel, PositionSide
from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitPlan
from quant_engine.proof.stage5r1_protective_replay import *


def bar(ms, o, h, l, c, v=100.0):
    return ReplayBar(open_time_ms=ms, open=float(o), high=float(h), low=float(l), close=float(c), volume=v)

def bars(n, start=0):
    return tuple(bar(start + i * 300000, 200.0 + i, 201.0 + i, 199.0 + i, 200.5 + i) for i in range(n))

_CM = CapitalModel(initial_equity=10000.0)
_ZC = CostModel(fee_bps_per_fill=0, half_spread_bps_per_fill=0, slippage_bps_per_fill=0, funding_bps_per_8h_adverse=0)

def _p_long(entry=None, stop=290.0, tp=310.0):
    return ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=entry or 300.0, stop_price=stop, take_profit_price=tp)

def _p_short(entry=None, stop=310.0, tp=290.0):
    return ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=entry or 300.0, stop_price=stop, take_profit_price=tp)

def _insts(b, entry_sig=99, exit_sig=110, action=ReplayAction.ENTER_LONG):
    return (ReplayInstruction(signal_bar_open_time_ms=b[entry_sig].open_time_ms, action=action),
            ReplayInstruction(signal_bar_open_time_ms=b[exit_sig].open_time_ms, action=ReplayAction.EXIT))

def _run(b, insts, p, cfg=None):
    if cfg is None: cfg = ReplayConfig(symbol="BTC/USDT")
    bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
    return run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=cfg, capital=_CM, cost=_ZC)


# ======== BASIC PROTECTIVE TESTS (keep existing) ========

class LongProtectiveTests(unittest.TestCase):
    def test_long_intrabar_stop(self):
        b = list(bars(200, 0)); b[105] = bar(b[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_long_intrabar_target(self):
        b = list(bars(200, 0)); b[105] = bar(b[105].open_time_ms, 305.0, 312.0, 304.0, 305.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")

    def test_entry_bar_stop(self):
        b = list(bars(200, 0)); b[100] = bar(b[100].open_time_ms, 300.0, 301.0, 289.0, 300.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_entry_bar_collision(self):
        b = list(bars(200, 0)); b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 289.0, 300.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "STOP_LOSS")

    def test_explicit_fallback(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")

    def test_trigger_on_exit_signal_bar(self):
        b = list(bars(200, 0)); b[110] = bar(b[110].open_time_ms, b[110].open, b[110].high, 289.0, b[110].close)
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
        r = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r.trade_count, 2)


class ShortProtectiveTests(unittest.TestCase):
    def test_short_intrabar_stop(self):
        b = list(bars(200, 0)); b[105] = bar(b[105].open_time_ms, 305.0, 312.0, 304.0, 305.5)
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_short_intrabar_target(self):
        b = list(bars(200, 0)); b[105] = bar(b[105].open_time_ms, 305.0, 306.0, 288.0, 305.5)
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")


class DeterminismTests(unittest.TestCase):
    def test_repeated_identical(self):
        b = bars(200, 0)
        r1 = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        r2 = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r1.replay_id, r2.replay_id)

    def test_post_trigger_independence(self):
        b1 = list(bars(200, 0)); b1[105] = bar(b1[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)
        insts = _insts(b1)
        b2 = list(b1); b2[106] = bar(b2[106].open_time_ms, 999.0, 1000.0, 998.0, 999.5)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertEqual(r1.trades[0].accounting_id, r2.trades[0].accounting_id)


# ======== REPAIR: BINDING + VALIDATION TESTS ========

class BindingOrderTests(unittest.TestCase):
    def test_unsorted_bindings_rejected(self):
        b = bars(200, 0); insts = _insts(b); p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[110].open_time_ms, plan=p),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p))
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_duplicate_bindings_rejected(self):
        b = bars(200, 0); insts = _insts(b); p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p))
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_fake_binding_no_fields_rejected(self):
        b = bars(200, 0); insts = _insts(b)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=[{"fake": True}], config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_subclass_binding_rejected(self):
        b = bars(200, 0)
        class FakeBinding(ProtectiveReplayBinding): pass
        p = _p_long()
        fb = FakeBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=_insts(b), protective_bindings=[fb], config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)


class ExplicitLineageTests(unittest.TestCase):
    def test_explicit_selection_has_resolution_id(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertTrue(len(r.selections[0].protective_resolution_id) == 64)

    def test_explicit_selection_event_id_none(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertIsNone(r.selections[0].protective_event_id)

    def test_explicit_exec_bar_intrabar_ignored(self):
        b = list(bars(200, 0))
        b[111] = bar(b[111].open_time_ms, 320.0, 350.0, 288.0, 319.0)  # open OK, intrabar low crosses stop
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")

    def test_explicit_exec_bar_gap_ignored(self):
        b = list(bars(200, 0))
        b[111] = bar(b[111].open_time_ms, 289.0, 290.0, 288.0, 289.5)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")


class SelectionFailClosedTests(unittest.TestCase):
    def test_forged_selection_id_rejected(self):
        b = bars(200, 0); r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        s = r.selections[0]
        with self.assertRaises(ValueError):
            ReplayExitSelection(schema_version=s.schema_version, arbitration_policy=s.arbitration_policy, accounting_time_policy=s.accounting_time_policy, source=s.source, reason=s.reason, explicit_outcome=s.explicit_outcome, entry_signal_bar_open_time_ms=s.entry_signal_bar_open_time_ms, entry_execution_time_ms=s.entry_execution_time_ms, paired_exit_signal_bar_open_time_ms=s.paired_exit_signal_bar_open_time_ms, explicit_exit_execution_time_ms=s.explicit_exit_execution_time_ms, selected_exit_bar_index=s.selected_exit_bar_index, selected_exit_bar_open_time_ms=s.selected_exit_bar_open_time_ms, raw_entry_price=s.raw_entry_price, raw_exit_price=s.raw_exit_price, binding_id=s.binding_id, plan_id=s.plan_id, protective_resolution_id=s.protective_resolution_id, protective_event_id=s.protective_event_id, selection_id="0"*64)


class EntryBarAccountingTests(unittest.TestCase):
    def test_entry_bar_accounting_is_zero_duration(self):
        b = list(bars(200, 0)); b[100] = bar(b[100].open_time_ms, 300.0, 301.0, 289.0, 300.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.trade_count, 1)
        self.assertEqual(r.selections[0].entry_execution_time_ms, r.selections[0].selected_exit_bar_open_time_ms)


class PostTriggerIndependenceTests(unittest.TestCase):
    def test_volume_change_post_trigger_selection_unchanged(self):
        b1 = list(bars(200, 0)); b1[105] = bar(b1[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)
        insts = _insts(b1); b2 = list(b1)
        b2[106] = bar(b2[106].open_time_ms, b2[106].open, b2[106].high, b2[106].low, b2[106].close, v=9999.0)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)

    def test_post_trigger_ohlc_selection_unchanged(self):
        b1 = list(bars(200, 0)); b1[105] = bar(b1[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)
        insts = _insts(b1); b2 = list(b1)
        b2[106] = bar(b2[106].open_time_ms, 999.0, 1000.0, 998.0, 999.5)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertEqual(r1.trades[0].accounting_id, r2.trades[0].accounting_id)


class SwitchingRejectedTests(unittest.TestCase):
    def test_consecutive_enter_rejected(self):
        b = bars(200, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.ENTER_LONG))
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_consecutive_exit_rejected(self):
        b = bars(200, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.EXIT))
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[150].open_time_ms, plan=p))
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)


    def test_side_mismatch_rejected(self):
        b = bars(200, 0); insts = _insts(b, action=ReplayAction.ENTER_SHORT)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_entry_ref_mismatch_rejected(self):
        b = bars(200, 0); insts = _insts(b)
        p = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=999.0, stop_price=900.0, take_profit_price=1200.0)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_subclass_plan_rejected(self):
        b = bars(200, 0)
        class FakePlan(ProtectiveExitPlan): pass
        fp = FakePlan(side=PositionSide.LONG, entry_reference_price=300.0, stop_price=290.0, take_profit_price=310.0)
        with self.assertRaises(ValueError):
            ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=fp)

    def test_missing_binding_rejected(self):
        b = bars(200, 0); insts = _insts(b)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=(), config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_odd_instructions_rejected(self):
        b = bars(200, 0); insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)


class IdentityMutationTests(unittest.TestCase):
    def test_plan_change_changes_binding(self):
        p1 = _p_long(entry=300.0, stop=290.0, tp=310.0)
        p2 = _p_long(entry=300.0, stop=280.0, tp=310.0)
        b1 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p1)
        b2 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p2)
        self.assertNotEqual(b1.binding_id, b2.binding_id)

    def test_binding_deterministic(self):
        p1 = _p_long(); p2 = _p_long()
        b1 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p1)
        b2 = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p2)
        self.assertEqual(b1.binding_id, b2.binding_id)


class ImmutabilityTests(unittest.TestCase):
    def test_binding_frozen(self):
        p = _p_long(); b = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=0, plan=p)
        with self.assertRaises(Exception):
            b.plan = p

    def test_trade_frozen(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        with self.assertRaises(Exception):
            r.trades[0].trade_index = 99

    def test_selection_frozen(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        with self.assertRaises(Exception):
            r.selections[0].source = "CHANGED"

    def test_result_frozen(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        with self.assertRaises(Exception):
            r.replay_id = "changed"

    def test_bars_not_mutated(self):
        b = list(bars(200, 0)); snap = tuple(b)
        _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(tuple(b), snap)


class ConfigBindingTests(unittest.TestCase):
    def test_symbol_binds_replay_id(self):
        b = bars(200, 0); insts = _insts(b); p = _p_long(stop=100.0, tp=999.0)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="ETH/USDT"), capital=_CM, cost=_ZC)
        self.assertNotEqual(r1.replay_id, r2.replay_id)


    def test_explicit_exec_bar_gap_ignored(self):
        b = list(bars(200, 0))
        b[111] = bar(b[111].open_time_ms, 289.0, 290.0, 288.0, 289.5)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")

    def test_long_gap_stop(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 280.0, 281.0, 279.0, 280.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_long_gap_target(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 312.0, 313.0, 311.0, 312.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")

    def test_short_gap_stop(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 315.0, 316.0, 314.0, 315.5)
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_short_gap_target(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 288.0, 289.0, 287.0, 288.5)
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")

    def test_short_entry_bar_stop(self):
        b = list(bars(200, 0))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 299.0, 300.5)
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].source, "PROTECTIVE")

    def test_short_explicit_fallback(self):
        b = bars(200, 0)
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short(stop=999.0, tp=100.0))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")

    def test_entry_bar_target(self):
        b = list(bars(200, 0))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 299.0, 300.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].reason, "TAKE_PROFIT")

    def test_short_same_bar_collision(self):
        b = list(bars(200, 0))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 288.0, 300.5)
        r = _run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short())
        self.assertEqual(r.selections[0].reason, "STOP_LOSS")


class ExplicitOutcomeTests(unittest.TestCase):
    def test_protective_supersedes_explicit(self):
        b = list(bars(200, 0))
        b[105] = bar(b[105].open_time_ms, 305.0, 306.0, 289.0, 305.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.selections[0].explicit_outcome, "SUPERSEDED_BY_PROTECTIVE")

    def test_explicit_outcome_executed(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].explicit_outcome, "EXECUTED_NEXT_OPEN")

    def test_arbitration_policy_field(self):
        b = bars(200, 0)
        r = _run(b, _insts(b), _p_long(stop=100.0, tp=999.0))
        self.assertEqual(r.selections[0].arbitration_policy, "PROTECTIVE_THROUGH_EXIT_SIGNAL_BAR_THEN_EXPLICIT_NEXT_OPEN")


if __name__ == "__main__":
    unittest.main()
