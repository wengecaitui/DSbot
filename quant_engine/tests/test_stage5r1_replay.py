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


if __name__ == "__main__":
    unittest.main()
