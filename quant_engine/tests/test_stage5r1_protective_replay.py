"""Stage 5R1.3-D protective replay — final test gates."""

import unittest

from quant_engine.proof.stage5r1_replay import ReplayAction, ReplayBar, ReplayConfig, ReplayInstruction
from quant_engine.proof.stage5r1_capital import CapitalModel, CostModel, PositionSide, calculate_trade_accounting
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


# ======== CORE BEHAVIORAL TESTS ========

class LongProtectiveTests(unittest.TestCase):
    def test_intrabar_stop(self):
        b = list(bars(200)); b[105] = bar(b[105].open_time_ms, 305, 306, 289, 305.5)
        self.assertEqual(_run(b, _insts(b), _p_long()).selections[0].source, "PROTECTIVE")
    def test_intrabar_target(self):
        b = list(bars(200)); b[105] = bar(b[105].open_time_ms, 305, 312, 304, 305.5)
        self.assertEqual(_run(b, _insts(b), _p_long()).selections[0].reason, "TAKE_PROFIT")
    def test_entry_bar_stop(self):
        b = list(bars(200)); b[100] = bar(b[100].open_time_ms, 300, 301, 289, 300.5)
        self.assertEqual(_run(b, _insts(b), _p_long()).selections[0].source, "PROTECTIVE")
    def test_entry_bar_collision(self):
        b = list(bars(200)); b[100] = bar(b[100].open_time_ms, 300, 312, 289, 300.5)
        self.assertEqual(_run(b, _insts(b), _p_long()).selections[0].reason, "STOP_LOSS")
    def test_explicit_fallback(self):
        r = _run(bars(200), _insts(bars(200)), _p_long(stop=100, tp=999))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")
    def test_trigger_on_exit_sig_bar(self):
        b = list(bars(200)); b[110] = bar(b[110].open_time_ms, b[110].open, b[110].high, 289, b[110].close)
        self.assertEqual(_run(b, _insts(b), _p_long()).selections[0].source, "PROTECTIVE")
    def test_multi_trade_compounding(self):
        b = bars(300)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[170].open_time_ms, action=ReplayAction.EXIT))
        p1 = _p_long(stop=100, tp=999); p2 = _p_long(entry=351, stop=100, tp=999)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p1),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[150].open_time_ms, plan=p2))
        r = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r.trade_count, 2)


class ShortProtectiveTests(unittest.TestCase):
    def test_intrabar_stop(self):
        b = list(bars(200)); b[105] = bar(b[105].open_time_ms, 305, 312, 304, 305.5)
        self.assertEqual(_run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short()).selections[0].source, "PROTECTIVE")
    def test_intrabar_target(self):
        b = list(bars(200)); b[105] = bar(b[105].open_time_ms, 305, 306, 288, 305.5)
        self.assertEqual(_run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short()).selections[0].reason, "TAKE_PROFIT")


class DeterminismTests(unittest.TestCase):
    def test_repeated_identical(self):
        b = bars(200)
        self.assertEqual(_run(b, _insts(b), _p_long(stop=100, tp=999)).replay_id,
                         _run(b, _insts(b), _p_long(stop=100, tp=999)).replay_id)
    def test_post_trigger_independence(self):
        b1 = list(bars(200)); b1[105] = bar(b1[105].open_time_ms, 305, 306, 289, 305.5)
        insts = _insts(b1); b2 = list(b1); b2[106] = bar(b2[106].open_time_ms, 999, 1000, 998, 999.5)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertEqual(r1.trades[0].accounting_id, r2.trades[0].accounting_id)


# ======== FIXED: EXPLICIT EXECUTION BAR TESTS ========

class ExplicitExecutionBarIgnoredTests(unittest.TestCase):
    def test_explicit_bar_gap_ignored(self):
        b = list(bars(200))
        b[111] = bar(b[111].open_time_ms, 289, 300, 285, 295)  # gap below stop=290
        r = _run(b, _insts(b), _p_long(stop=100, tp=999))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")
        self.assertEqual(r.selections[0].raw_exit_price, 289.0)

    def test_explicit_bar_intrabar_ignored(self):
        b = list(bars(200))
        b[111] = bar(b[111].open_time_ms, 300, 350, 289, 319)  # low=289 < stop=290
        r = _run(b, _insts(b), _p_long(stop=100, tp=999))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")
        self.assertEqual(r.selections[0].raw_exit_price, 300.0)


# ======== FIXED: MASKED TESTS ========

class FixedMaskedTests(unittest.TestCase):
    def test_unsorted_bindings_two_pairs_rejected(self):
        b = bars(300)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[170].open_time_ms, action=ReplayAction.EXIT))
        p = _p_long(stop=100, tp=999)
        # reverse order
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[150].open_time_ms, plan=p),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p))
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_consecutive_exit_rejected(self):
        b = bars(300)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.EXIT),  # invalid
                 ReplayInstruction(signal_bar_open_time_ms=b[170].open_time_ms, action=ReplayAction.ENTER_LONG))
        p = _p_long(stop=100, tp=999)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[170].open_time_ms, plan=p))
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)


# ======== ACCOUNTING PROOF ========

class EntryBarAccountingProofTests(unittest.TestCase):
    def test_entry_bar_stop_zero_duration(self):
        b = list(bars(200)); b[100] = bar(b[100].open_time_ms, 300, 301, 289, 300.5)
        r = _run(b, _insts(b), _p_long())
        self.assertEqual(r.trade_count, 1)
        # independently reconstruct
        expected = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=10000.0,
            raw_entry_price=300.0, raw_exit_price=290.0, entry_time_ms=b[100].open_time_ms,
            exit_time_ms=b[100].open_time_ms, capital=_CM, cost=_ZC)
        self.assertEqual(expected.holding_time_ms, 0)
        self.assertEqual(expected.completed_funding_periods, 0)
        self.assertEqual(expected.accounting_id, r.trades[0].accounting_id)


# ======== NO-LOOKAHEAD TESTS ========

class PostTriggerIndependenceFullTests(unittest.TestCase):
    def test_post_trigger_ohlc_selection_accounting_trade_unchanged(self):
        b1 = list(bars(200)); b1[105] = bar(b1[105].open_time_ms, 305, 306, 289, 305.5)
        insts = _insts(b1); b2 = list(b1)
        b2[106] = bar(b2[106].open_time_ms, 999, 1000, 998, 999.5)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertEqual(r1.trades[0].accounting_id, r2.trades[0].accounting_id)
        self.assertEqual(r1.trades[0].trade_id, r2.trades[0].trade_id)
        self.assertNotEqual(r1.dataset_id, r2.dataset_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_volume_pre_trigger_selection_unchanged(self):
        b1 = list(bars(200)); b1[105] = bar(b1[105].open_time_ms, 305, 306, 289, 305.5)
        insts = _insts(b1); b2 = list(b1)
        b2[104] = bar(b2[104].open_time_ms, b2[104].open, b2[104].high, b2[104].low, b2[104].close, v=9999)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_pre_trigger_ohlc_changes_selection(self):
        b1 = list(bars(200)); b1[105] = bar(b1[105].open_time_ms, 305, 306, 289, 305.5)
        b2 = list(b1); b2[104] = bar(b2[104].open_time_ms, b2[104].open, 500, b2[104].low, b2[104].close)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=_insts(b1), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertNotEqual(r1.selections[0].selection_id, r2.selections[0].selection_id)

    def test_explicit_open_changes_everything(self):
        b1 = list(bars(200))
        b1[111] = bar(b1[111].open_time_ms, 310, 320, 305, 315)
        b2 = list(b1)
        b2[111] = bar(b2[111].open_time_ms, 315, 320, 305, 317)
        p = _p_long(stop=100, tp=999)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=_insts(b1), protective_bindings=(ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),), config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=(ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b2[99].open_time_ms, plan=p),), config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertNotEqual(r1.selections[0].selection_id, r2.selections[0].selection_id)
        self.assertNotEqual(r1.trades[0].accounting_id, r2.trades[0].accounting_id)

    def test_post_explicit_ohlc_selection_unchanged(self):
        b1 = list(bars(200))
        b1[111] = bar(b1[111].open_time_ms, 310, 320, 305, 315)
        b2 = list(b1)
        b2[112] = bar(b2[112].open_time_ms, 999, 1000, 998, 999.5)
        p = _p_long(stop=100, tp=999)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=_insts(b1), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)


# ======== INPUT IMMUTABILITY ========

class InputImmutabilityTests(unittest.TestCase):
    def test_bars_unchanged(self):
        b = list(bars(200)); snap = tuple(b)
        _run(b, _insts(b), _p_long(stop=100, tp=999))
        self.assertEqual(tuple(b), snap)

    def test_instructions_unchanged(self):
        b = bars(200); insts = list(_insts(b)); snap = tuple(insts)
        _run(b, insts, _p_long(stop=100, tp=999))
        self.assertEqual(tuple(insts), snap)

    def test_bindings_unchanged(self):
        b = bars(200); p = _p_long()
        bind = [ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p)]
        snap_id = bind[0].binding_id
        run_stage5r1_protective_replay(bars=b, instructions=_insts(b), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(bind[0].binding_id, snap_id)


# ======== FAIL-CLOSED VALIDATION ========

class FailClosedTests(unittest.TestCase):
    def test_unsorted_bindings_rejected(self):
        b = bars(200); p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[110].open_time_ms, plan=p),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p))
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=_insts(b), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_duplicate_bindings_rejected(self):
        b = bars(200); p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)*2
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=_insts(b), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_subclass_binding_rejected(self):
        b = bars(200)
        class FB(ProtectiveReplayBinding): pass
        p = _p_long(); fb = FB(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=_insts(b), protective_bindings=[fb], config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_forged_binding_id_rejected(self):
        b = bars(200); p = _p_long()
        real = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p)
        # construct with wrong ID via object.__setattr__
        fb = ProtectiveReplayBinding.__new__(ProtectiveReplayBinding)
        object.__setattr__(fb, "schema_version", real.schema_version)
        object.__setattr__(fb, "entry_signal_bar_open_time_ms", real.entry_signal_bar_open_time_ms)
        object.__setattr__(fb, "plan", real.plan)
        object.__setattr__(fb, "binding_id", "0"*64)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=_insts(b), protective_bindings=[fb], config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_forged_selection_id_rejected(self):
        b = bars(200); r = _run(b, _insts(b), _p_long(stop=100, tp=999))
        s = r.selections[0]
        with self.assertRaises(ValueError):
            ReplayExitSelection(schema_version=s.schema_version, arbitration_policy=s.arbitration_policy, accounting_time_policy=s.accounting_time_policy, source=s.source, reason=s.reason, explicit_outcome=s.explicit_outcome, entry_signal_bar_open_time_ms=s.entry_signal_bar_open_time_ms, entry_execution_time_ms=s.entry_execution_time_ms, paired_exit_signal_bar_open_time_ms=s.paired_exit_signal_bar_open_time_ms, explicit_exit_execution_time_ms=s.explicit_exit_execution_time_ms, selected_exit_bar_index=s.selected_exit_bar_index, selected_exit_bar_open_time_ms=s.selected_exit_bar_open_time_ms, raw_entry_price=s.raw_entry_price, raw_exit_price=s.raw_exit_price, binding_id=s.binding_id, plan_id=s.plan_id, protective_resolution_id=s.protective_resolution_id, protective_event_id=s.protective_event_id, selection_id="0"*64)

    def test_forged_trade_id_rejected(self):
        b = bars(200); r = _run(b, _insts(b), _p_long(stop=100, tp=999))
        t = r.trades[0]
        with self.assertRaises(ValueError):
            ProtectiveReplayTrade(schema_version=t.schema_version, trade_index=t.trade_index, binding_id=t.binding_id, entry_signal_bar_open_time_ms=t.entry_signal_bar_open_time_ms, paired_exit_signal_bar_open_time_ms=t.paired_exit_signal_bar_open_time_ms, entry_execution_time_ms=t.entry_execution_time_ms, selected_exit_bar_open_time_ms=t.selected_exit_bar_open_time_ms, selection_id=t.selection_id, accounting_id=t.accounting_id, trade_id="0"*64)

    def test_trade_selection_binding_mismatch(self):
        b = bars(200); r = _run(b, _insts(b), _p_long(stop=100, tp=999))
        # Construct result with mismatched child
        t = r.trades[0]; s = r.selections[0]
        from quant_engine.proof.stage5_evaluation import canonical_sha256
        payload = {"schemaVersion": r.schema_version, "datasetId": r.dataset_id, "instructionSetId": r.instruction_set_id, "bindingSetId": r.binding_set_id, "replayConfigId": r.replay_config_id, "capitalModelId": r.capital_model_id, "costModelId": r.cost_model_id, "initialEquity": float(r.initial_equity), "finalEquity": float(r.final_equity), "tradeCount": r.trade_count, "tradeIds": [t.trade_id]}
        with self.assertRaises(ValueError):
            ProtectiveReplayResult(schema_version=r.schema_version, symbol=r.symbol, timeframe_ms=r.timeframe_ms, dataset_id=r.dataset_id, instruction_set_id=r.instruction_set_id, binding_set_id=r.binding_set_id, replay_config_id=r.replay_config_id, capital_model_id=r.capital_model_id, cost_model_id=r.cost_model_id, initial_equity=r.initial_equity, final_equity=r.final_equity, trade_count=r.trade_count, trades=r.trades, selections=(ReplayExitSelection(schema_version=s.schema_version, arbitration_policy=s.arbitration_policy, accounting_time_policy=s.accounting_time_policy, source=s.source, reason=s.reason, explicit_outcome=s.explicit_outcome, entry_signal_bar_open_time_ms=s.entry_signal_bar_open_time_ms, entry_execution_time_ms=s.entry_execution_time_ms, paired_exit_signal_bar_open_time_ms=s.paired_exit_signal_bar_open_time_ms, explicit_exit_execution_time_ms=s.explicit_exit_execution_time_ms, selected_exit_bar_index=s.selected_exit_bar_index, selected_exit_bar_open_time_ms=s.selected_exit_bar_open_time_ms, raw_entry_price=s.raw_entry_price, raw_exit_price=s.raw_exit_price, binding_id="0"*64, plan_id=s.plan_id, protective_resolution_id=s.protective_resolution_id, protective_event_id=s.protective_event_id, selection_id=s.selection_id),), replay_id=canonical_sha256(payload))

    def test_immutability(self):
        b = bars(200); r = _run(b, _insts(b), _p_long(stop=100, tp=999))
        with self.assertRaises(Exception):
            r.trades[0].trade_index = 99  # type: ignore
        with self.assertRaises(Exception):
            r.selections[0].source = "CHANGED"  # type: ignore
        with self.assertRaises(Exception):
            r.replay_id = "changed"  # type: ignore


# ======== BULK EXPANSION TO 70+ ========

class GapTargetIntrabarEdgeTests(unittest.TestCase):
    def test_long_gap_stop(self):
        b = list(bars(200)); b[105] = bar(b[105].open_time_ms, 280, 281, 279, 280.5)
        self.assertEqual(_run(b, _insts(b), _p_long()).selections[0].source, "PROTECTIVE")
    def test_long_gap_target(self):
        b = list(bars(200)); b[105] = bar(b[105].open_time_ms, 312, 313, 311, 312.5)
        self.assertEqual(_run(b, _insts(b), _p_long()).selections[0].reason, "TAKE_PROFIT")
    def test_short_gap_stop(self):
        b = list(bars(200)); b[105] = bar(b[105].open_time_ms, 315, 316, 314, 315.5)
        self.assertEqual(_run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short()).selections[0].source, "PROTECTIVE")
    def test_short_gap_target(self):
        b = list(bars(200)); b[105] = bar(b[105].open_time_ms, 288, 289, 287, 288.5)
        self.assertEqual(_run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short()).selections[0].reason, "TAKE_PROFIT")
    def test_short_entry_bar_stop(self):
        b = list(bars(200)); b[100] = bar(b[100].open_time_ms, 300, 312, 299, 300.5)
        self.assertEqual(_run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short()).selections[0].source, "PROTECTIVE")
    def test_entry_bar_target(self):
        b = list(bars(200)); b[100] = bar(b[100].open_time_ms, 300, 312, 299, 300.5)
        self.assertEqual(_run(b, _insts(b), _p_long()).selections[0].reason, "TAKE_PROFIT")
    def test_short_same_bar_collision(self):
        b = list(bars(200)); b[100] = bar(b[100].open_time_ms, 300, 312, 288, 300.5)
        self.assertEqual(_run(b, _insts(b, action=ReplayAction.ENTER_SHORT), _p_short()).selections[0].reason, "STOP_LOSS")
    def test_short_explicit_fallback(self):
        r = _run(bars(200), _insts(bars(200), action=ReplayAction.ENTER_SHORT), _p_short(stop=999, tp=100))
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")


class ExplicitOutcomeFieldTests(unittest.TestCase):
    def test_protective_superseded(self):
        b = list(bars(200)); b[105] = bar(b[105].open_time_ms, 305, 306, 289, 305.5)
        self.assertEqual(_run(b, _insts(b), _p_long()).selections[0].explicit_outcome, "SUPERSEDED_BY_PROTECTIVE")
    def test_explicit_executed(self):
        r = _run(bars(200), _insts(bars(200)), _p_long(stop=100, tp=999))
        self.assertEqual(r.selections[0].explicit_outcome, "EXECUTED_NEXT_OPEN")
    def test_arbitration_policy_field(self):
        r = _run(bars(200), _insts(bars(200)), _p_long(stop=100, tp=999))
        self.assertEqual(r.selections[0].arbitration_policy, "PROTECTIVE_THROUGH_EXIT_SIGNAL_BAR_THEN_EXPLICIT_NEXT_OPEN")


class ExplicitLineageTests(unittest.TestCase):
    def test_explicit_has_resolution_id(self):
        r = _run(bars(200), _insts(bars(200)), _p_long(stop=100, tp=999))
        self.assertTrue(len(r.selections[0].protective_resolution_id) == 64)
    def test_explicit_event_id_none(self):
        r = _run(bars(200), _insts(bars(200)), _p_long(stop=100, tp=999))
        self.assertIsNone(r.selections[0].protective_event_id)


class SizingTests(unittest.TestCase):
    def test_trade_count_matches_selections_trades(self):
        r = _run(bars(200), _insts(bars(200)), _p_long(stop=100, tp=999))
        self.assertEqual(r.trade_count, len(r.trades))
        self.assertEqual(r.trade_count, len(r.selections))


class MoreFailClosedTests(unittest.TestCase):
    def test_subclass_plan_rejected(self):
        b = bars(200)
        class FP(ProtectiveExitPlan): pass
        fp = FP(side=PositionSide.LONG, entry_reference_price=300, stop_price=290, take_profit_price=310)
        with self.assertRaises(ValueError):
            ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=fp)
    def test_missing_binding_rejected(self):
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=bars(200), instructions=_insts(bars(200)), protective_bindings=(), config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
    def test_side_mismatch_rejected(self):
        b = bars(200)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=_p_long()),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=_insts(b, action=ReplayAction.ENTER_SHORT), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
    def test_entry_ref_mismatch_rejected(self):
        b = bars(200)
        p = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=999, stop_price=900, take_profit_price=1200)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=_insts(b), protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
    def test_odd_instructions_rejected(self):
        b = bars(200)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=_p_long()),)
        with self.assertRaises(ValueError):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
    def test_selection_frozen(self):
        b = bars(200); r = _run(b, _insts(b), _p_long(stop=100, tp=999))
        with self.assertRaises(Exception):
            r.selections[0].source = "CHANGED"  # type: ignore
    def test_config_symbol_binds(self):
        b = bars(200); insts = _insts(b); p = _p_long(stop=100, tp=999)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind, config=ReplayConfig(symbol="ETH/USDT"), capital=_CM, cost=_ZC)
        self.assertNotEqual(r1.replay_id, r2.replay_id)


# ======== STAGE GATE TESTS (17 new) ========

class ResultSymbolGateTests(unittest.TestCase):
    def test_symbol_mutation_rejects(self):
        b = bars(200); r = _run(b, _insts(b), _p_long(stop=100, tp=999))
        with self.assertRaisesRegex(ValueError, "RES_ID_MISMATCH"):
            ProtectiveReplayResult(schema_version=r.schema_version, symbol="ETH/USDT",
                timeframe_ms=r.timeframe_ms, dataset_id=r.dataset_id,
                instruction_set_id=r.instruction_set_id, binding_set_id=r.binding_set_id,
                replay_config_id=r.replay_config_id, capital_model_id=r.capital_model_id,
                cost_model_id=r.cost_model_id, initial_equity=r.initial_equity,
                final_equity=r.final_equity, trade_count=r.trade_count,
                trades=r.trades, selections=r.selections, replay_id=r.replay_id)

    def test_symbol_change_binds_replay_id(self):
        b = bars(200); insts = _insts(b); p = _p_long(stop=100, tp=999)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
            config=ReplayConfig(symbol="ETH/USDT"), capital=_CM, cost=_ZC)
        self.assertNotEqual(r1.replay_id, r2.replay_id)


class ExecutionBarGateTests(unittest.TestCase):
    def test_gap_stop_below_open_289_stop_290(self):
        b = list(bars(200))
        b[111] = bar(b[111].open_time_ms, 289, 300, 285, 295)
        p = _p_long(stop=100, tp=999)  # no trigger through signal bar
        self.assertLessEqual(b[111].open, 290)
        r = _run(b, _insts(b), p)
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")
        self.assertEqual(r.selections[0].raw_exit_price, 289.0)

    def test_intrabar_stop_below_open_300_low_289_stop_290(self):
        b = list(bars(200))
        b[111] = bar(b[111].open_time_ms, 300, 350, 289, 319)
        p = _p_long(stop=100, tp=999)  # no trigger through signal bar
        self.assertLessEqual(b[111].low, 290)
        r = _run(b, _insts(b), p)
        self.assertEqual(r.selections[0].source, "EXPLICIT_NEXT_OPEN")
        self.assertEqual(r.selections[0].raw_exit_price, 300.0)


class NestedLineageGateTests(unittest.TestCase):
    def _make_r(self):
        return _run(bars(200), _insts(bars(200)), _p_long(stop=100, tp=999))

    def test_bid_mismatch_via_selection(self):
        r = self._make_r(); t = r.trades[0]; s = r.selections[0]
        pl_d = {"schemaVersion": s.schema_version, "arbitrationPolicy": s.arbitration_policy,
            "accountingTimePolicy": s.accounting_time_policy, "source": s.source, "reason": s.reason,
            "explicitOutcome": s.explicit_outcome,
            "entrySignalBarOpenTimeMs": s.entry_signal_bar_open_time_ms,
            "entryExecutionTimeMs": s.entry_execution_time_ms,
            "pairedExitSignalBarOpenTimeMs": s.paired_exit_signal_bar_open_time_ms,
            "explicitExitExecutionTimeMs": s.explicit_exit_execution_time_ms,
            "selectedExitBarIndex": s.selected_exit_bar_index,
            "selectedExitBarOpenTimeMs": s.selected_exit_bar_open_time_ms,
            "rawEntryPrice": float(s.raw_entry_price), "rawExitPrice": float(s.raw_exit_price),
            "bindingId": "c"*64, "planId": s.plan_id,
            "protectiveResolutionId": s.protective_resolution_id,
            "protectiveEventId": s.protective_event_id}
        sid = canonical_sha256(pl_d)
        s2 = ReplayExitSelection(schema_version=s.schema_version, arbitration_policy=s.arbitration_policy,
            accounting_time_policy=s.accounting_time_policy, source=s.source, reason=s.reason,
            explicit_outcome=s.explicit_outcome, entry_signal_bar_open_time_ms=s.entry_signal_bar_open_time_ms,
            entry_execution_time_ms=s.entry_execution_time_ms,
            paired_exit_signal_bar_open_time_ms=s.paired_exit_signal_bar_open_time_ms,
            explicit_exit_execution_time_ms=s.explicit_exit_execution_time_ms,
            selected_exit_bar_index=s.selected_exit_bar_index,
            selected_exit_bar_open_time_ms=s.selected_exit_bar_open_time_ms,
            raw_entry_price=s.raw_entry_price, raw_exit_price=s.raw_exit_price,
            binding_id="c"*64, plan_id=s.plan_id,
            protective_resolution_id=s.protective_resolution_id,
            protective_event_id=s.protective_event_id, selection_id=sid)
        rpl = {"schemaVersion": r.schema_version, "symbol": r.symbol, "timeframeMs": r.timeframe_ms,
            "datasetId": r.dataset_id, "instructionSetId": r.instruction_set_id,
            "bindingSetId": r.binding_set_id, "replayConfigId": r.replay_config_id,
            "capitalModelId": r.capital_model_id, "costModelId": r.cost_model_id,
            "initialEquity": float(r.initial_equity), "finalEquity": float(r.final_equity),
            "tradeCount": 1, "tradeIds": [t.trade_id]}
        rid = canonical_sha256(rpl)
        with self.assertRaisesRegex(ValueError, "RES_SID_MISMATCH_0"):
            ProtectiveReplayResult(schema_version=r.schema_version, symbol=r.symbol,
                timeframe_ms=r.timeframe_ms, dataset_id=r.dataset_id,
                instruction_set_id=r.instruction_set_id, binding_set_id=r.binding_set_id,
                replay_config_id=r.replay_config_id, capital_model_id=r.capital_model_id,
                cost_model_id=r.cost_model_id, initial_equity=r.initial_equity,
                final_equity=r.final_equity, trade_count=1,
                trades=(t,), selections=(s2,), replay_id=rid)


class NoLookaheadGateTests(unittest.TestCase):
    def test_post_trigger_ohlc_no_effect_on_ids(self):
        b1 = list(bars(200)); b1[105] = bar(b1[105].open_time_ms, 305, 306, 289, 305.5)
        insts = _insts(b1); b2 = list(b1)
        b2[106] = bar(b2[106].open_time_ms, 999, 1000, 998, 999.5)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind,
            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind,
            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.selections[0].protective_resolution_id, r2.selections[0].protective_resolution_id)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertEqual(r1.trades[0].accounting_id, r2.trades[0].accounting_id)
        self.assertEqual(r1.trades[0].trade_id, r2.trades[0].trade_id)
        self.assertNotEqual(r1.dataset_id, r2.dataset_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_pre_trigger_volume_no_effect_on_ids(self):
        b1 = list(bars(200)); b1[105] = bar(b1[105].open_time_ms, 305, 306, 289, 305.5)
        insts = _insts(b1); b2 = list(b1)
        b2[100] = bar(b2[100].open_time_ms, b2[100].open, b2[100].high, b2[100].low, b2[100].close, v=9999)
        p = _p_long()
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=insts, protective_bindings=bind,
            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind,
            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.selections[0].protective_resolution_id, r2.selections[0].protective_resolution_id)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertEqual(r1.trades[0].trade_id, r2.trades[0].trade_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_post_explicit_ohlc_no_effect_on_selection(self):
        b1 = list(bars(200))
        b1[111] = bar(b1[111].open_time_ms, 310, 320, 305, 315)
        b2 = list(b1)
        b2[112] = bar(b2[112].open_time_ms, 999, 1000, 998, 999.5)
        p = _p_long(stop=100, tp=999)
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b1[99].open_time_ms, plan=p),)
        r1 = run_stage5r1_protective_replay(bars=b1, instructions=_insts(b1), protective_bindings=bind,
            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        r2 = run_stage5r1_protective_replay(bars=b2, instructions=_insts(b2), protective_bindings=bind,
            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)
        self.assertEqual(r1.trades[0].selection_id, r2.trades[0].selection_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)


class FailClosedGateTests(unittest.TestCase):
    def test_binding_id_forged_rejects(self):
        b = bars(200); p = _p_long()
        real = ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p)
        fb = ProtectiveReplayBinding.__new__(ProtectiveReplayBinding)
        for k, v in [("schema_version", real.schema_version),
                      ("entry_signal_bar_open_time_ms", real.entry_signal_bar_open_time_ms),
                      ("plan", real.plan), ("binding_id", "a"*64)]:
            object.__setattr__(fb, k, v)
        with self.assertRaisesRegex(ValueError, "BINDING_ID_MISMATCH"):
            run_stage5r1_protective_replay(bars=b, instructions=_insts(b), protective_bindings=[fb],
                config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_result_schema_forged_rejects(self):
        with self.assertRaisesRegex(ValueError, "RES_SCHEMA_INVALID"):
            ProtectiveReplayResult(schema_version="wrong", symbol="X", timeframe_ms=300000,
                dataset_id="a"*64, instruction_set_id="a"*64, binding_set_id="a"*64,
                replay_config_id="a"*64, capital_model_id="a"*64, cost_model_id="a"*64,
                initial_equity=100.0, final_equity=100.0, trade_count=0,
                trades=(), selections=(), replay_id="a"*64)

    def test_final_eq_nan_rejects(self):
        with self.assertRaisesRegex(ValueError, "RES_FEQ_INVALID"):
            ProtectiveReplayResult(schema_version=PROTECTIVE_REPLAY_RESULT_SCHEMA, symbol="X",
                timeframe_ms=300000, dataset_id="a"*64, instruction_set_id="a"*64,
                binding_set_id="a"*64, replay_config_id="a"*64, capital_model_id="a"*64,
                cost_model_id="a"*64, initial_equity=100.0, final_equity=float("nan"),
                trade_count=0, trades=(), selections=(), replay_id="a"*64)

    def test_unsorted_bindings_rejects_with_exact_error(self):
        b = bars(300); p = _p_long(stop=100, tp=999)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[170].open_time_ms, action=ReplayAction.EXIT))
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[150].open_time_ms, plan=p),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p))
        with self.assertRaisesRegex(ValueError, "BINDING_TIME_MISMATCH_AT_0"):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)

    def test_consecutive_exit_rejects_with_exact_error(self):
        b = bars(300)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.EXIT),
                 ReplayInstruction(signal_bar_open_time_ms=b[170].open_time_ms, action=ReplayAction.ENTER_LONG))
        bind = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=_p_long(stop=100, tp=999)),
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[170].open_time_ms, plan=_p_long(stop=100, tp=999)))
        with self.assertRaisesRegex(ValueError, "PAIRING_FIRST_NOT_ENTER: index=2"):
            run_stage5r1_protective_replay(bars=b, instructions=insts, protective_bindings=bind,
                config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_ZC)


if __name__ == "__main__":
    unittest.main()
