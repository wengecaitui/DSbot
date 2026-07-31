"""Stage 5R1.3-C protective exit resolution tests."""

import unittest

from quant_engine.proof.stage5r1_replay import ReplayBar, validate_bar_sequence
from quant_engine.proof.stage5r1_capital import PositionSide
from quant_engine.proof.stage5r1_protective_exit import (
    ProtectiveExitPlan,
    ProtectiveExitEvent,
    ProtectiveExitResolution,
    resolve_protective_exit,
)


def bar(ms, o, h, l, c, v=100.0):
    return ReplayBar(open_time_ms=ms, open=float(o), high=float(h), low=float(l), close=float(c), volume=v)


def bars(n, start_ms=0):
    return tuple(bar(start_ms + i * 300000, 100.0 + i, 101.0 + i, 99.0 + i, 100.5 + i) for i in range(n))


class LongStopIntrabarTests(unittest.TestCase):
    def test_long_intrabar_stop(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, b[5].high, 95.0, b[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=96.0, take_profit_price=120.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.status, "TRIGGERED")
        self.assertIsNotNone(r.event)
        self.assertEqual(r.event.reason, "STOP_LOSS")
        self.assertEqual(r.event.trigger_kind, "INTRABAR_LEVEL")

    def test_long_intrabar_target(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, 130.0, b[5].low, b[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=125.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "TAKE_PROFIT")
        self.assertEqual(r.event.trigger_kind, "INTRABAR_LEVEL")


class ShortStopIntrabarTests(unittest.TestCase):
    def test_short_intrabar_stop(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, 115.0, b[5].low, b[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=100.0, stop_price=110.0, take_profit_price=80.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "STOP_LOSS")

    def test_short_intrabar_target(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, b[5].high, 75.0, b[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=100.0, stop_price=110.0, take_profit_price=80.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "TAKE_PROFIT")


class LongGapTests(unittest.TestCase):
    def test_long_gap_stop(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, 93.0, 95.0, 92.0, 94.0)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=95.0, take_profit_price=130.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.trigger_kind, "GAP_OPEN")
        self.assertEqual(r.event.reason, "STOP_LOSS")

    def test_long_gap_target(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, 135.0, 136.0, 134.0, 135.5)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=130.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "TAKE_PROFIT")
        self.assertEqual(r.event.trigger_kind, "GAP_OPEN")


class ShortGapTests(unittest.TestCase):
    def test_short_gap_stop(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, 112.0, 113.0, 111.0, 112.5)
        plan = ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=100.0, stop_price=110.0, take_profit_price=80.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.trigger_kind, "GAP_OPEN")

    def test_short_gap_target(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, 75.0, 76.0, 74.0, 75.5)
        plan = ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=100.0, stop_price=110.0, take_profit_price=80.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "TAKE_PROFIT")


class EntryBarIntrabarOnlyTests(unittest.TestCase):
    def test_entry_bar_open_not_evaluated(self):
        b = list(bars(20))
        b[1] = bar(b[1].open_time_ms, 120.0, 121.0, 119.0, 120.5)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=130.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.status, "NO_TRIGGER")

    def test_entry_bar_high_low_evaluated(self):
        b = list(bars(20))
        b[1] = bar(b[1].open_time_ms, 95.0, 110.0, 89.0, 100.0)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "STOP_LOSS")


class SameBarCollisionTests(unittest.TestCase):
    def test_long_same_bar_stop_wins(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, 130.0, 88.0, b[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=125.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "STOP_LOSS")
        self.assertTrue(r.event.same_bar_collision)

    def test_short_same_bar_stop_wins(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, 115.0, 75.0, b[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=100.0, stop_price=110.0, take_profit_price=80.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "STOP_LOSS")


class NoTriggerTests(unittest.TestCase):
    def test_no_trigger(self):
        b = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.status, "NO_TRIGGER")
        self.assertIsNone(r.event)


class PlanValidationTests(unittest.TestCase):
    def test_long_stop_above_entry_rejected(self):
        with self.assertRaises(ValueError):
            ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=105.0, take_profit_price=120.0)

    def test_long_target_below_entry_rejected(self):
        with self.assertRaises(ValueError):
            ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=95.0)

    def test_short_stop_below_entry_rejected(self):
        with self.assertRaises(ValueError):
            ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=100.0, stop_price=90.0, take_profit_price=80.0)

    def test_non_finite_price_rejected(self):
        with self.assertRaises(ValueError):
            ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=float("inf"), stop_price=90.0, take_profit_price=120.0)

    def test_boolean_price_rejected(self):
        with self.assertRaises(ValueError):
            ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=True, stop_price=90.0, take_profit_price=120.0)  # type: ignore


class DeterminismTests(unittest.TestCase):
    def test_repeated_resolution_identical(self):
        b = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r1 = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        r2 = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r1.resolution_id, r2.resolution_id)
        self.assertEqual(r1, r2)

    def test_changing_pre_entry_preserves_observation_path(self):
        b1 = list(bars(20))
        b1[0] = bar(b1[0].open_time_ms, 999.0, 1000.0, 998.0, 999.5)
        b2 = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r1 = resolve_protective_exit(bars=b1, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        r2 = resolve_protective_exit(bars=b2, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r1.observation_path_id, r2.observation_path_id)

    def test_plan_changes_plan_id(self):
        p1 = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        p2 = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=85.0, take_profit_price=120.0)
        self.assertNotEqual(p1.plan_id, p2.plan_id)


class ImmutabilityTests(unittest.TestCase):
    def test_plan_is_frozen(self):
        p = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        with self.assertRaises(Exception):
            p.stop_price = 85.0  # type: ignore

    def test_resolution_is_frozen(self):
        b = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        with self.assertRaises(Exception):
            r.status = "CHANGED"  # type: ignore

    def test_bars_not_mutated(self):
        b = list(bars(20))
        snap = tuple(b)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(tuple(b), snap)


if __name__ == "__main__":
    unittest.main()
