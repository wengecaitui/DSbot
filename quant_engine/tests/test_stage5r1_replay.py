"""Stage 5R1 replay contract tests — RED phase."""

from __future__ import annotations

import unittest

from quant_engine.proof.stage5r1_capital import CapitalModel, CostModel, PositionSide
from quant_engine.proof.stage5r1_replay import (
    ReplayAction,
    ReplayBar,
    ReplayConfig,
    ReplayInstruction,
    ReplayResult,
    ReplayTrade,
    run_stage5r1_replay,
    validate_bar_sequence,
    validate_instruction_set,
)


# --- Helpers ---

def bar(open_time_ms: int, o: float, h: float, l: float, c: float, v: float = 100.0) -> ReplayBar:
    return ReplayBar(open_time_ms=open_time_ms, open=o, high=h, low=l, close=c, volume=v)

def bars(count: int, base_time: int = 0, price: float = 100.0) -> tuple[ReplayBar, ...]:
    result = []
    for i in range(count):
        t = base_time + i * 300_000
        p = price + i * 0.5
        result.append(bar(t, p, p + 1, p - 1, p + 0.25, 100.0))
    return tuple(result)

_CM = CapitalModel(initial_equity=1.0, position_fraction=1.0)
_COST = CostModel()


# --- Bar validation ---

class BarValidationTests(unittest.TestCase):
    def test_valid_bars_accepted(self):
        b = validate_bar_sequence(bars(5))
        self.assertEqual(len(b), 5)

    def test_unsorted_rejected(self):
        b = list(bars(5))
        b[0], b[2] = b[2], b[0]
        with self.assertRaises(ValueError):
            validate_bar_sequence(b)

    def test_duplicate_timestamp_rejected(self):
        b = list(bars(5))
        b[1] = bar(b[0].open_time_ms, 100, 101, 99, 100.5)
        with self.assertRaises(ValueError):
            validate_bar_sequence(b)

    def test_gap_rejected(self):
        b = list(bars(5))
        b[2] = bar(b[2].open_time_ms + 300_000, 100, 101, 99, 100.5)
        with self.assertRaises(ValueError):
            validate_bar_sequence(b)

    def test_ohlc_range_rejected(self):
        with self.assertRaises(ValueError):
            bar(0, 100, 99, 101, 100)

    def test_zero_ohlc_rejected(self):
        with self.assertRaises(ValueError):
            bar(0, 0, 101, 99, 100)

    def test_negative_volume_rejected(self):
        with self.assertRaises(ValueError):
            bar(0, 100, 101, 99, 100, -1)

    def test_nan_rejected(self):
        with self.assertRaises(ValueError):
            bar(0, float("nan"), 101, 99, 100)

    def test_inf_rejected(self):
        with self.assertRaises(ValueError):
            bar(0, float("inf"), 101, 99, 100)

    def test_open_bar_rejected(self):
        with self.assertRaises(ValueError):
            ReplayBar(open_time_ms=0, open=100.0, high=101.0, low=99.0, close=100.5, volume=100.0, closed=False)

    def test_fake_bar_rejected(self):
        fake = type("FakeBar", (), {"open_time_ms": 0, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5, "volume": 100.0, "closed": True})()
        with self.assertRaises(ValueError):
            validate_bar_sequence([fake, bar(300000, 101, 102, 100, 101.5)])

    def test_subclass_bar_rejected(self):
        class SubBar(ReplayBar):
            pass
        sb = SubBar(open_time_ms=0, open=100.0, high=101.0, low=99.0, close=100.5, volume=100.0)
        with self.assertRaises(ValueError):
            validate_bar_sequence([sb, bar(300000, 101, 102, 100, 101.5)])

    def test_too_few_bars_rejected(self):
        with self.assertRaises(ValueError):
            validate_bar_sequence([bar(0, 100, 101, 99, 100.5)])


# --- Config and instructions ---

class ConfigAndInstructionTests(unittest.TestCase):
    def test_unsupported_timeframe_rejected(self):
        with self.assertRaises(ValueError):
            ReplayConfig(symbol="BTC/USDT", timeframe_ms=60_000)

    def test_weakened_closed_bars_rejected(self):
        with self.assertRaises(ValueError):
            ReplayConfig(symbol="BTC/USDT", closed_bars_only=False)

    def test_weakened_next_open_rejected(self):
        with self.assertRaises(ValueError):
            ReplayConfig(symbol="BTC/USDT", next_open_execution=False)

    def test_invalid_warmup_rejected(self):
        with self.assertRaises(ValueError):
            ReplayConfig(symbol="BTC/USDT", warmup_bars=0)

    def test_duplicate_instructions_rejected(self):
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=30_000_000, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=30_000_000, action=ReplayAction.EXIT),
        )
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, bars(150, 0))

    def test_unsorted_instructions_rejected(self):
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=30_300_000, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=30_000_000, action=ReplayAction.EXIT),
        )
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, bars(150, 0))

    def test_unknown_bar_rejected(self):
        insts = (ReplayInstruction(signal_bar_open_time_ms=99_999_999, action=ReplayAction.ENTER_LONG),)
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, bars(150, 0))

    def test_final_bar_instruction_rejected(self):
        b = bars(10, 0)
        last_time = b[-1].open_time_ms
        insts = (ReplayInstruction(signal_bar_open_time_ms=last_time, action=ReplayAction.ENTER_LONG),)
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, b)

    def test_before_warmup_rejected(self):
        # warmup=100, first eligible is bar 99
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[50].open_time_ms, action=ReplayAction.ENTER_LONG),)
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, b, warmup_bars=100)

    def test_first_eligible_executes_on_next_open(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),)
        validate_instruction_set(insts, b, warmup_bars=100)  # should not raise


# --- Position lifecycle ---

class PositionLifecycleTests(unittest.TestCase):
    def test_long_entry_exit_one_trade(self):
        b = bars(150, 0)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
        )
        config = ReplayConfig(symbol="BTC/USDT")
        result = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        self.assertEqual(len(result.trades), 1)
        self.assertEqual(result.trades[0].accounting.side, PositionSide.LONG)

    def test_short_entry_exit_one_trade(self):
        b = bars(150, 0)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_SHORT),
            ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
        )
        config = ReplayConfig(symbol="BTC/USDT")
        result = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        self.assertEqual(len(result.trades), 1)
        self.assertEqual(result.trades[0].accounting.side, PositionSide.SHORT)

    def test_entry_never_on_signal_bar_open(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),)
        insts2 = (ReplayInstruction(signal_bar_open_time_ms=b[120].open_time_ms, action=ReplayAction.EXIT),)
        config = ReplayConfig(symbol="BTC/USDT")
        result = run_stage5r1_replay(bars=b, instructions=insts + insts2, config=config, capital=_CM, cost=_COST)
        t = result.trades[0]
        # entry execution must be at bar[100] (next after signal bar 99)
        self.assertEqual(t.entry_execution_time_ms, b[100].open_time_ms)

    def test_exit_never_on_signal_bar_open(self):
        b = bars(150, 0)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
        )
        config = ReplayConfig(symbol="BTC/USDT")
        result = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        t = result.trades[0]
        self.assertEqual(t.exit_execution_time_ms, b[111].open_time_ms)

    def test_exit_while_flat_rejected(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.EXIT),)
        config = ReplayConfig(symbol="BTC/USDT")
        with self.assertRaises(ValueError):
            run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)

    def test_same_side_second_entry_rejected(self):
        b = bars(150, 0)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[105].open_time_ms, action=ReplayAction.ENTER_LONG),
        )
        config = ReplayConfig(symbol="BTC/USDT")
        with self.assertRaises(ValueError):
            run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)

    def test_opposite_entry_while_open_rejected(self):
        b = bars(150, 0)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[105].open_time_ms, action=ReplayAction.ENTER_SHORT),
        )
        config = ReplayConfig(symbol="BTC/USDT")
        with self.assertRaises(ValueError):
            run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)

    def test_open_position_at_end_rejected(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),)
        config = ReplayConfig(symbol="BTC/USDT")
        with self.assertRaises(ValueError):
            run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)

    def test_two_sequential_trades_compound_equity(self):
        b = bars(200, 0)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
            ReplayInstruction(signal_bar_open_time_ms=b[120].open_time_ms, action=ReplayAction.ENTER_SHORT),
            ReplayInstruction(signal_bar_open_time_ms=b[130].open_time_ms, action=ReplayAction.EXIT),
        )
        config = ReplayConfig(symbol="BTC/USDT")
        result = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        self.assertEqual(len(result.trades), 2)
        self.assertAlmostEqual(result.final_equity, result.trades[1].accounting.closing_equity)


# --- Accounting integration ---

class AccountingIntegrationTests(unittest.TestCase):
    def test_trade_contains_exact_accounting(self):
        b = bars(150, 0)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
        )
        config = ReplayConfig(symbol="BTC/USDT")
        result = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        from quant_engine.proof.stage5r1_capital import TradeAccounting
        self.assertIsInstance(result.trades[0].accounting, TradeAccounting)

    def test_replay_accounting_ids_match(self):
        b = bars(150, 0)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
        )
        config = ReplayConfig(symbol="BTC/USDT")
        result = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        self.assertEqual(result.capital_model_id, result.trades[0].accounting.capital_model_id)
        self.assertEqual(result.cost_model_id, result.trades[0].accounting.cost_model_id)

    def test_final_equity_matches_last_close(self):
        b = bars(200, 0)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT),
            ReplayInstruction(signal_bar_open_time_ms=b[120].open_time_ms, action=ReplayAction.ENTER_SHORT),
            ReplayInstruction(signal_bar_open_time_ms=b[130].open_time_ms, action=ReplayAction.EXIT),
        )
        config = ReplayConfig(symbol="BTC/USDT")
        result = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        self.assertAlmostEqual(result.final_equity, result.trades[-1].accounting.closing_equity)

    def test_fake_capital_rejected(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        config = ReplayConfig(symbol="BTC/USDT")
        with self.assertRaises(ValueError):
            run_stage5r1_replay(bars=b, instructions=insts, config=config, capital={"initial_equity": 1.0}, cost=_COST)

    def test_fake_cost_rejected(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        config = ReplayConfig(symbol="BTC/USDT")
        with self.assertRaises(ValueError):
            run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost={"fee_bps_per_fill": 5})

    def test_capital_subclass_rejected(self):
        class SubCapital(CapitalModel):
            pass
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        config = ReplayConfig(symbol="BTC/USDT")
        with self.assertRaises(ValueError):
            run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=SubCapital(initial_equity=1.0), cost=_COST)

    def test_cost_subclass_rejected(self):
        class SubCost(CostModel):
            pass
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        config = ReplayConfig(symbol="BTC/USDT")
        with self.assertRaises(ValueError):
            run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=SubCost())


# --- Determinism and identity ---

class DeterminismAndIdentityTests(unittest.TestCase):
    def test_repeated_replay_same_result(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        config = ReplayConfig(symbol="BTC/USDT")
        r1 = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        r2 = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        self.assertEqual(r1.replay_id, r2.replay_id)

    def test_bar_change_changes_ids(self):
        b1 = bars(150, 0)
        b2_list = list(bars(150, 0))
        b2_list[100] = bar(b2_list[100].open_time_ms, 200.0, 201.0, 199.0, 200.5)
        b2 = tuple(b2_list)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b1[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b1[110].open_time_ms, action=ReplayAction.EXIT))
        config = ReplayConfig(symbol="BTC/USDT")
        r1 = run_stage5r1_replay(bars=b1, instructions=insts, config=config, capital=_CM, cost=_COST)
        r2 = run_stage5r1_replay(bars=b2, instructions=insts, config=config, capital=_CM, cost=_COST)
        self.assertNotEqual(r1.dataset_id, r2.dataset_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_instruction_change_changes_ids(self):
        b = bars(150, 0)
        insts1 = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                  ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        insts2 = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                  ReplayInstruction(signal_bar_open_time_ms=b[115].open_time_ms, action=ReplayAction.EXIT))
        config = ReplayConfig(symbol="BTC/USDT")
        r1 = run_stage5r1_replay(bars=b, instructions=insts1, config=config, capital=_CM, cost=_COST)
        r2 = run_stage5r1_replay(bars=b, instructions=insts2, config=config, capital=_CM, cost=_COST)
        self.assertNotEqual(r1.instruction_set_id, r2.instruction_set_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_capital_change_changes_replay_id(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        config = ReplayConfig(symbol="BTC/USDT")
        cm2 = CapitalModel(initial_equity=2.0, position_fraction=1.0)
        r1 = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        r2 = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=cm2, cost=_COST)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_cost_change_changes_replay_id(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        config = ReplayConfig(symbol="BTC/USDT")
        c2 = CostModel(fee_bps_per_fill=10.0)
        r1 = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=_COST)
        r2 = run_stage5r1_replay(bars=b, instructions=insts, config=config, capital=_CM, cost=c2)
        self.assertNotEqual(r1.replay_id, r2.replay_id)


# --- NEW: CLOSED TYPE EXACT ---

class ClosedTypeExactTests(unittest.TestCase):
    def test_closed_int_rejected(self):
        with self.assertRaises(ValueError):
            ReplayBar(open_time_ms=0, open=100.0, high=101.0, low=99.0, close=100.5, volume=100.0, closed=1)

    def test_closed_str_rejected(self):
        with self.assertRaises(ValueError):
            ReplayBar(open_time_ms=0, open=100.0, high=101.0, low=99.0, close=100.5, volume=100.0, closed="true")

    def test_closed_list_rejected(self):
        with self.assertRaises(ValueError):
            ReplayBar(open_time_ms=0, open=100.0, high=101.0, low=99.0, close=100.5, volume=100.0, closed=[])


# --- NEW: TIMEFRAME TYPE EXACT ---

class TimeframeTypeExactTests(unittest.TestCase):
    def test_timeframe_float_rejected(self):
        with self.assertRaises(ValueError):
            ReplayConfig(symbol="BTC/USDT", timeframe_ms=300000.0)

    def test_timeframe_bool_rejected(self):
        with self.assertRaises(ValueError):
            ReplayConfig(symbol="BTC/USDT", timeframe_ms=True)

    def test_timeframe_str_rejected(self):
        with self.assertRaises(ValueError):
            ReplayConfig(symbol="BTC/USDT", timeframe_ms="300000")


# --- NEW: DATASET ID BINDS SYMBOL ---

class DatasetSymbolBindingTests(unittest.TestCase):
    def test_different_symbols_different_dataset_id(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r1 = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        r2 = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="ETH/USDT"), capital=_CM, cost=_COST)
        self.assertNotEqual(r1.dataset_id, r2.dataset_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)


# --- NEW: COMPLETE REPLAY EQUALITY ---

class CompleteReplayEqualityTests(unittest.TestCase):
    def test_full_result_equality(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r1 = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        r2 = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        self.assertEqual(r1, r2)


# --- NEW: INPUT IMMUTABILITY ---

class InputImmutabilityTests(unittest.TestCase):
    def test_bars_not_mutated_on_success(self):
        b_list = list(bars(150, 0))
        snapshot = [type(b).__name__ for b in b_list]
        insts = (ReplayInstruction(signal_bar_open_time_ms=b_list[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b_list[110].open_time_ms, action=ReplayAction.EXIT))
        run_stage5r1_replay(bars=b_list, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        self.assertEqual([type(b).__name__ for b in b_list], snapshot)

    def test_instructions_not_mutated_on_success(self):
        b = bars(150, 0)
        inst_list = [ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                     ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT)]
        snapshot = [(i.signal_bar_open_time_ms, i.action) for i in inst_list]
        run_stage5r1_replay(bars=b, instructions=inst_list, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        self.assertEqual([(i.signal_bar_open_time_ms, i.action) for i in inst_list], snapshot)

    def test_bars_not_mutated_on_rejection(self):
        b_list = list(bars(150, 0))
        snapshot = [type(b).__name__ for b in b_list]
        insts = (ReplayInstruction(signal_bar_open_time_ms=b_list[99].open_time_ms, action=ReplayAction.EXIT),)
        try:
            run_stage5r1_replay(bars=b_list, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        except ValueError:
            pass
        self.assertEqual([type(b).__name__ for b in b_list], snapshot)


# --- NEW: INSTRUCTION VALIDATOR FAIL-CLOSED ---

class InstructionValidatorFailClosedTests(unittest.TestCase):
    def test_validator_rejects_gap_bars(self):
        b_list = list(bars(150, 0))
        b_list[50] = bar(b_list[50].open_time_ms + 1000, 100, 101, 99, 100.5)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b_list[99].open_time_ms, action=ReplayAction.ENTER_LONG),)
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, b_list)

    def test_validator_rejects_unsorted_bars(self):
        b_list = list(bars(150, 0))
        b_list[0], b_list[5] = b_list[5], b_list[0]
        insts = (ReplayInstruction(signal_bar_open_time_ms=0, action=ReplayAction.ENTER_LONG),)
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, b_list)

    def test_validator_rejects_fake_bar(self):
        fake = type("FB", (), {"open_time_ms": 0, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5, "volume": 100.0, "closed": True})()
        b_list = [fake, bar(300000, 101, 102, 100, 101.5)]
        insts = (ReplayInstruction(signal_bar_open_time_ms=0, action=ReplayAction.ENTER_LONG),)
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, b_list)

    def test_validator_rejects_invalid_warmup(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[10].open_time_ms, action=ReplayAction.ENTER_LONG),)
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, b, warmup_bars=0)

    def test_validator_rejects_bool_warmup(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[10].open_time_ms, action=ReplayAction.ENTER_LONG),)
        with self.assertRaises(ValueError):
            validate_instruction_set(insts, b, warmup_bars=True)  # type: ignore


# --- FINAL CLOSURE: closed=object ---

class ClosedObjectRejectionTests(unittest.TestCase):
    def test_closed_object_rejected(self):
        with self.assertRaises(ValueError):
            ReplayBar(open_time_ms=0, open=100.0, high=101.0, low=99.0, close=100.5, volume=100.0, closed=object())


# --- FINAL CLOSURE: independent dataset payload ---

class IndependentDatasetPayloadTests(unittest.TestCase):
    def test_dataset_id_matches_independent_payload(self):
        from quant_engine.proof.stage5_evaluation import canonical_sha256
        from quant_engine.proof.stage5r1_replay import REPLAY_BAR_SCHEMA
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        result = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        expected = {
            "schemaVersion": REPLAY_BAR_SCHEMA,
            "symbol": "BTC/USDT",
            "timeframeMs": 300000,
            "bars": [
                {
                    "openTimeMs": b_bar.open_time_ms, "open": float(b_bar.open),
                    "high": float(b_bar.high), "low": float(b_bar.low),
                    "close": float(b_bar.close), "volume": float(b_bar.volume),
                    "closed": True,
                }
                for b_bar in b
            ],
        }
        self.assertEqual(result.dataset_id, canonical_sha256(expected))


# --- FINAL CLOSURE: int/float canonical equivalence ---

class IntFloatCanonicalEquivalenceTests(unittest.TestCase):
    def test_int_float_bars_same_identity(self):
        b_int = tuple(ReplayBar(open_time_ms=i * 300000, open=100 + i, high=101 + i, low=99 + i, close=100 + i, volume=10)
                      for i in range(150))
        b_float = tuple(ReplayBar(open_time_ms=i * 300000, open=100.0 + i, high=101.0 + i, low=99.0 + i, close=100.0 + i, volume=10.0)
                        for i in range(150))
        insts = (ReplayInstruction(signal_bar_open_time_ms=b_int[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b_int[110].open_time_ms, action=ReplayAction.EXIT))
        r_int = run_stage5r1_replay(bars=b_int, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        r_float = run_stage5r1_replay(bars=b_float, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        self.assertEqual(r_int.dataset_id, r_float.dataset_id)
        self.assertEqual(r_int.instruction_set_id, r_float.instruction_set_id)
        self.assertEqual(r_int.replay_config_id, r_float.replay_config_id)
        self.assertEqual(r_int.replay_id, r_float.replay_id)
        self.assertEqual(r_int, r_float)


# --- FINAL CLOSURE: strengthened immutability ---

class StrengthenedImmutabilityTests(unittest.TestCase):
    def test_bars_unchanged_on_success(self):
        b_list = list(bars(150, 0))
        bars_snap = tuple(b_list)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b_list[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b_list[110].open_time_ms, action=ReplayAction.EXIT))
        run_stage5r1_replay(bars=b_list, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        self.assertEqual(tuple(b_list), bars_snap)

    def test_instructions_unchanged_on_rejection(self):
        b = bars(150, 0)
        inst_list = [ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.EXIT)]
        inst_snap = tuple(inst_list)
        with self.assertRaisesRegex(ValueError, "REPLAY_EXIT_WHILE_FLAT"):
            run_stage5r1_replay(bars=b, instructions=inst_list, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_COST)
        self.assertEqual(tuple(inst_list), inst_snap)


# ======== STAGE 5R1.3-B EXCURSION TESTS (RED) ========

_EXCURSION_COST_ZERO = CostModel(
    fee_bps_per_fill=0, half_spread_bps_per_fill=0,
    slippage_bps_per_fill=0, funding_bps_per_8h_adverse=0,
)
_EXCURSION_COST = CostModel(half_spread_bps_per_fill=1, slippage_bps_per_fill=2,
                            fee_bps_per_fill=0, funding_bps_per_8h_adverse=0)


class ExcursionSchemaTests(unittest.TestCase):
    def test_trade_excursion_exists(self):
        from quant_engine.proof.stage5r1_replay import TradeExcursion
        self.assertIsNotNone(TradeExcursion)

    def test_replay_trade_schema_v2(self):
        from quant_engine.proof.stage5r1_replay import REPLAY_TRADE_SCHEMA
        self.assertEqual(REPLAY_TRADE_SCHEMA, "stage-5r1.replay-trade.v2")

    def test_replay_result_schema_v2(self):
        from quant_engine.proof.stage5r1_replay import REPLAY_RESULT_SCHEMA
        self.assertEqual(REPLAY_RESULT_SCHEMA, "stage-5r1.replay-result.v2")


class ExcursionObservationWindowTests(unittest.TestCase):
    def _long_trade(self, highs_override=None, lows_override=None, exit_open=None):
        b = list(bars(150, 0))
        if highs_override:
            for i, h in highs_override:
                b[i] = bar(b[i].open_time_ms, b[i].open, h, b[i].low, b[i].close)
        if lows_override:
            for i, l in lows_override:
                b[i] = bar(b[i].open_time_ms, b[i].open, b[i].high, l, b[i].close)
        if exit_open is not None:
            ei = 111
            b[ei] = bar(b[ei].open_time_ms, exit_open, b[ei].high, b[ei].low, b[ei].close)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        return run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"),
                                   capital=_CM, cost=_EXCURSION_COST_ZERO)

    def test_mfe_uses_entry_fill_not_raw(self):
        r1 = run_stage5r1_replay(
            bars=bars(150, 0),
            instructions=(ReplayInstruction(signal_bar_open_time_ms=99*300000, action=ReplayAction.ENTER_LONG),
                          ReplayInstruction(signal_bar_open_time_ms=110*300000, action=ReplayAction.EXIT)),
            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_EXCURSION_COST_ZERO)
        r2 = run_stage5r1_replay(
            bars=bars(150, 0),
            instructions=(ReplayInstruction(signal_bar_open_time_ms=99*300000, action=ReplayAction.ENTER_LONG),
                          ReplayInstruction(signal_bar_open_time_ms=110*300000, action=ReplayAction.EXIT)),
            config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_EXCURSION_COST)
        self.assertNotEqual(r1.trades[0].excursion.entry_fill_price, r2.trades[0].excursion.entry_fill_price)

    def test_full_holding_bar_count(self):
        r = self._long_trade()
        self.assertEqual(r.trades[0].excursion.full_holding_bar_count, 11)

    def test_excursion_accounting_id_match(self):
        r = self._long_trade()
        self.assertEqual(r.trades[0].excursion.accounting_id, r.trades[0].accounting.accounting_id)


class ExcursionIdentityTests(unittest.TestCase):
    def test_internal_high_preserves_accounting_changes_excursion_and_replay(self):
        b = list(bars(150, 0))
        b[105] = bar(b[105].open_time_ms, b[105].open, 999.0, b[105].low, b[105].close)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_EXCURSION_COST_ZERO)
        b2 = list(bars(150, 0))
        b2[105] = bar(b2[105].open_time_ms, b2[105].open, 888.0, b2[105].low, b2[105].close)
        r2 = run_stage5r1_replay(bars=b2, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_EXCURSION_COST_ZERO)
        self.assertEqual(r.trades[0].accounting.accounting_id, r2.trades[0].accounting.accounting_id)
        self.assertNotEqual(r.trades[0].excursion.excursion_id, r2.trades[0].excursion.excursion_id)
        self.assertNotEqual(r.replay_id, r2.replay_id)

    def test_repeated_replay_identical(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r1 = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_EXCURSION_COST_ZERO)
        r2 = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_EXCURSION_COST_ZERO)
        self.assertEqual(r1, r2)
        self.assertEqual(r1.trades[0].excursion.excursion_id, r2.trades[0].excursion.excursion_id)


# ========================================================

# ======== PROVENANCE HARDENING TESTS ========

_XC = _EXCURSION_COST_ZERO


class ExcursionValidationTests(unittest.TestCase):
    def _exc(self, **kw):
        from quant_engine.proof.stage5r1_replay import _calculate_trade_excursion
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        return r.trades[0].excursion

    def test_excursion_is_frozen(self):
        e = self._exc()
        with self.assertRaises(Exception):
            e.mfe_price_delta = 999.0

    def test_schema_valid(self):
        self.assertEqual(self._exc().schema_version, "stage-5r1.trade-excursion.v1")

    def test_holding_path_id_present(self):
        self.assertTrue(len(self._exc().holding_path_id) == 64)

    def test_symbol_present(self):
        self.assertEqual(self._exc().symbol, "BTC/USDT")

    def test_reject_negative_mfe(self):
        from quant_engine.proof.stage5r1_replay import TradeExcursion
        e = self._exc()
        with self.assertRaises(ValueError):
            TradeExcursion(schema_version=e.schema_version, window_policy=e.window_policy, tie_policy=e.tie_policy, symbol=e.symbol, timeframe_ms=e.timeframe_ms, dataset_id=e.dataset_id, holding_path_id=e.holding_path_id, accounting_id=e.accounting_id, side=e.side, entry_execution_time_ms=e.entry_execution_time_ms, exit_execution_time_ms=e.exit_execution_time_ms, full_holding_bar_count=e.full_holding_bar_count, entry_fill_price=e.entry_fill_price, quantity=e.quantity, entry_equity=e.entry_equity, favorable_extreme_price=e.favorable_extreme_price, favorable_extreme_bar_open_time_ms=e.favorable_extreme_bar_open_time_ms, adverse_extreme_price=e.adverse_extreme_price, adverse_extreme_bar_open_time_ms=e.adverse_extreme_bar_open_time_ms, mfe_price_delta=-1.0, mae_price_delta=e.mae_price_delta, mfe_amount_before_exit_costs=e.mfe_amount_before_exit_costs, mae_amount_before_exit_costs=e.mae_amount_before_exit_costs, mfe_return_on_entry_equity=e.mfe_return_on_entry_equity, mae_return_on_entry_equity=e.mae_return_on_entry_equity, mfe_fraction_of_entry_fill_price=e.mfe_fraction_of_entry_fill_price, mae_fraction_of_entry_fill_price=e.mae_fraction_of_entry_fill_price, excursion_id=e.excursion_id)


class HoldingPathIdentityTests(unittest.TestCase):
    def test_pre_entry_change_preserves_holding_path(self):
        b1 = list(bars(150, 0))
        b1[50] = bar(b1[50].open_time_ms, 999.0, 1000.0, 998.0, 999.5)  # pre-entry
        b2 = list(bars(150, 0))
        insts = (ReplayInstruction(signal_bar_open_time_ms=b2[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b2[110].open_time_ms, action=ReplayAction.EXIT))
        r1 = run_stage5r1_replay(bars=b1, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        r2 = run_stage5r1_replay(bars=b2, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        self.assertNotEqual(r1.dataset_id, r2.dataset_id)
        self.assertEqual(r1.trades[0].excursion.holding_path_id, r2.trades[0].excursion.holding_path_id)
        self.assertAlmostEqual(r1.trades[0].excursion.mfe_amount_before_exit_costs, r2.trades[0].excursion.mfe_amount_before_exit_costs)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_exit_hlc_change_preserves_holding_path(self):
        b1 = list(bars(150, 0))
        exit_idx = 111
        b1[exit_idx] = bar(b1[exit_idx].open_time_ms, b1[exit_idx].open, 999.0, 1.0, 500.0)
        b2 = list(bars(150, 0))
        insts = (ReplayInstruction(signal_bar_open_time_ms=b2[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b2[110].open_time_ms, action=ReplayAction.EXIT))
        r1 = run_stage5r1_replay(bars=b1, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        r2 = run_stage5r1_replay(bars=b2, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        self.assertNotEqual(r1.dataset_id, r2.dataset_id)
        self.assertEqual(r1.trades[0].excursion.holding_path_id, r2.trades[0].excursion.holding_path_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_internal_high_changes_holding_path(self):
        b1 = list(bars(150, 0))
        b1[105] = bar(b1[105].open_time_ms, b1[105].open, 999.0, b1[105].low, b1[105].close)
        b2 = list(bars(150, 0))
        insts = (ReplayInstruction(signal_bar_open_time_ms=b2[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b2[110].open_time_ms, action=ReplayAction.EXIT))
        r1 = run_stage5r1_replay(bars=b1, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        r2 = run_stage5r1_replay(bars=b2, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        self.assertNotEqual(r1.trades[0].excursion.holding_path_id, r2.trades[0].excursion.holding_path_id)
        self.assertEqual(r1.trades[0].accounting.accounting_id, r2.trades[0].accounting.accounting_id)
        self.assertNotEqual(r1.trades[0].excursion.excursion_id, r2.trades[0].excursion.excursion_id)
        self.assertNotEqual(r1.replay_id, r2.replay_id)

    def test_replay_id_binds_excursion_ids(self):
        """Same dataset/instructions/config/capital/cost but different excursion → different replay."""
        b1 = list(bars(150, 0))
        b1[105] = bar(b1[105].open_time_ms, b1[105].open, 999.0, b1[105].low, b1[105].close)
        b2 = list(bars(150, 0))
        b2[105] = bar(b2[105].open_time_ms, b2[105].open, 888.0, b2[105].low, b2[105].close)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b1[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b1[110].open_time_ms, action=ReplayAction.EXIT))
        r1 = run_stage5r1_replay(bars=b1, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        r2 = run_stage5r1_replay(bars=b2, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        # Everything same except bars → all IDs change
        self.assertNotEqual(r1.replay_id, r2.replay_id)


class AccountingLineageTests(unittest.TestCase):
    def test_forged_raw_entry_rejected(self):
        from dataclasses import replace
        from quant_engine.proof.stage5r1_replay import _calculate_trade_excursion
        b = validate_bar_sequence(bars(150, 0))
        r = run_stage5r1_replay(bars=b, instructions=(ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG), ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT)), config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        forged = replace(r.trades[0].accounting, raw_entry_price=999.0)
        with self.assertRaises(ValueError):
            _calculate_trade_excursion(bars=b, entry_exec_index=100, exit_exec_index=111, accounting=forged, dataset_id=r.dataset_id, symbol="BTC/USDT", timeframe_ms=300000)

    def test_forged_exit_price_rejected(self):
        from dataclasses import replace
        from quant_engine.proof.stage5r1_replay import _calculate_trade_excursion
        b = validate_bar_sequence(bars(150, 0))
        r = run_stage5r1_replay(bars=b, instructions=(ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG), ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT)), config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        forged = replace(r.trades[0].accounting, raw_exit_price=999.0)
        with self.assertRaises(ValueError):
            _calculate_trade_excursion(bars=b, entry_exec_index=100, exit_exec_index=111, accounting=forged, dataset_id=r.dataset_id, symbol="BTC/USDT", timeframe_ms=300000)


class ExcursionShortArithmeticTests(unittest.TestCase):
    def test_short_favorable_price(self):
        b = list(bars(150, 0))
        b[105] = bar(b[105].open_time_ms, b[105].open, b[105].high, 50.0, b[105].close)  # low=50 favorable for short
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_SHORT),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        self.assertAlmostEqual(r.trades[0].excursion.favorable_extreme_price, 50.0)

    def test_short_adverse_price(self):
        b = list(bars(150, 0))
        b[105] = bar(b[105].open_time_ms, b[105].open, 999.0, b[105].low, b[105].close)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_SHORT),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        self.assertAlmostEqual(r.trades[0].excursion.adverse_extreme_price, 999.0)

    def test_short_mfe_delta(self):
        b = list(bars(150, 0))
        entry_open = b[100].open
        b[105] = bar(b[105].open_time_ms, b[105].open, b[105].high, 50.0, b[105].close)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_SHORT),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        self.assertAlmostEqual(r.trades[0].excursion.mfe_price_delta, entry_open - 50.0)

    def test_short_mae_delta(self):
        b = list(bars(150, 0))
        entry_open = b[100].open
        b[105] = bar(b[105].open_time_ms, b[105].open, 999.0, b[105].low, b[105].close)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_SHORT),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        self.assertAlmostEqual(r.trades[0].excursion.mae_price_delta, 999.0 - entry_open)

    def test_short_mfe_amount(self):
        b = list(bars(150, 0))
        b[105] = bar(b[105].open_time_ms, b[105].open, b[105].high, 50.0, b[105].close)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_SHORT),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        expected = r.trades[0].accounting.quantity * r.trades[0].excursion.mfe_price_delta
        self.assertAlmostEqual(r.trades[0].excursion.mfe_amount_before_exit_costs, expected)

    def test_excursion_uses_entry_fill_price(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_EXCURSION_COST)
        self.assertEqual(r.trades[0].excursion.entry_fill_price, r.trades[0].accounting.entry_fill_price)

    def test_entry_fill_differs_from_raw_with_costs(self):
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r_zero = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        r_cost = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_EXCURSION_COST)
        self.assertNotEqual(r_zero.trades[0].excursion.entry_fill_price, r_cost.trades[0].excursion.entry_fill_price)


class IndependentIdentityEvidenceTests(unittest.TestCase):
    def test_replay_id_independent_reconstruction(self):
        from quant_engine.proof.stage5_evaluation import canonical_sha256
        from quant_engine.proof.stage5r1_replay import REPLAY_RESULT_SCHEMA
        b = bars(150, 0)
        insts = (ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
                 ReplayInstruction(signal_bar_open_time_ms=b[110].open_time_ms, action=ReplayAction.EXIT))
        r = run_stage5r1_replay(bars=b, instructions=insts, config=ReplayConfig(symbol="BTC/USDT"), capital=_CM, cost=_XC)
        expected = {"schemaVersion": REPLAY_RESULT_SCHEMA, "datasetId": r.dataset_id, "instructionSetId": r.instruction_set_id, "replayConfigId": r.replay_config_id, "capitalModelId": r.capital_model_id, "costModelId": r.cost_model_id, "initialEquity": float(r.initial_equity), "finalEquity": float(r.final_equity), "tradeCount": r.trade_count, "accountingIds": [t.accounting.accounting_id for t in r.trades], "excursionIds": [t.excursion.excursion_id for t in r.trades]}
        self.assertEqual(r.replay_id, canonical_sha256(expected))


if __name__ == "__main__":
    unittest.main()
