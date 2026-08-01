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


# ======== REPAIR: VALIDATION + COVERAGE TESTS ========

class EarliestTriggerTests(unittest.TestCase):
    def test_earliest_bar_wins(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, b[5].high, 88.0, b[5].close)  # stop at bar 5
        b[6] = bar(b[6].open_time_ms, b[6].open, 130.0, 85.0, b[6].close)  # also triggers
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.trigger_bar_index, 5)

    def test_exact_stop_boundary(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, b[5].high, 90.0, b[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "STOP_LOSS")

    def test_exact_target_boundary(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, 120.0, b[5].low, b[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r.event.reason, "TAKE_PROFIT")


class IdentityMutationTests(unittest.TestCase):
    def test_plan_change_changes_resolution_id(self):
        b = bars(20)
        p1 = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        p2 = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=85.0, take_profit_price=120.0)
        r1 = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=p1, symbol="BTC/USDT", timeframe_ms=300000)
        r2 = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=p2, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertNotEqual(r1.resolution_id, r2.resolution_id)

    def test_ohlc_change_changes_observation_path(self):
        b1, b2 = list(bars(20)), list(bars(20))
        b2[5] = bar(b2[5].open_time_ms, b2[5].open, 999.0, b2[5].low, b2[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r1 = resolve_protective_exit(bars=b1, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        r2 = resolve_protective_exit(bars=b2, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertNotEqual(r1.observation_path_id, r2.observation_path_id)

    def test_volume_preserves_observation_path(self):
        b1, b2 = list(bars(20)), list(bars(20))
        b2[5] = bar(b2[5].open_time_ms, b2[5].open, b2[5].high, b2[5].low, b2[5].close, v=999.0)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r1 = resolve_protective_exit(bars=b1, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        r2 = resolve_protective_exit(bars=b2, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r1.observation_path_id, r2.observation_path_id)

    def test_post_observation_preserves_path(self):
        b1 = list(bars(20))
        b1[15] = bar(b1[15].open_time_ms, 999.0, 1000.0, 998.0, 999.5)  # after last_obs=10
        b2 = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r1 = resolve_protective_exit(bars=b1, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        r2 = resolve_protective_exit(bars=b2, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        self.assertEqual(r1.observation_path_id, r2.observation_path_id)


class InputValidationTests(unittest.TestCase):
    def test_malformed_short_target_rejected(self):
        with self.assertRaises(ValueError):
            ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=100.0, stop_price=110.0, take_profit_price=105.0)

    def test_negative_entry_idx_rejected(self):
        b = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=b, entry_execution_index=-1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)

    def test_reversed_indices_rejected(self):
        b = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=b, entry_execution_index=10, last_observation_index=1, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)

    def test_bool_idx_rejected(self):
        b = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=b, entry_execution_index=True, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)

    def test_fake_plan_rejected(self):
        b = bars(20)
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan={"fake": True}, symbol="BTC/USDT", timeframe_ms=300000)

    def test_subclass_plan_rejected(self):
        b = bars(20)
        class FakePlan(ProtectiveExitPlan): pass
        fp = FakePlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=fp, symbol="BTC/USDT", timeframe_ms=300000)

    def test_empty_symbol_rejected(self):
        b = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="", timeframe_ms=300000)

    def test_wrong_timeframe_rejected(self):
        b = bars(20)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=600000)


class EventResolutionValidationTests(unittest.TestCase):
    def test_event_frozen(self):
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, b[5].high, 88.0, b[5].close)
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        with self.assertRaises(Exception):
            r.event.trigger_bar_index = 99  # type: ignore

    def test_forged_event_id_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitEvent, canonical_sha256, PROTECTIVE_EXIT_EVENT_SCHEMA
        correct = canonical_sha256({"schemaVersion": PROTECTIVE_EXIT_EVENT_SCHEMA, "side": PositionSide.LONG.value,
            "reason": "STOP_LOSS", "triggerKind": "INTRABAR_LEVEL", "triggerBarOpenTimeMs": 0,
            "triggerBarIndex": 1, "triggerLevelPrice": 90.0, "rawExitPrice": 90.0,
            "sameBarCollision": False, "planId": "a"*64, "observationPathId": "b"*64})
        # Construct with correct ID
        v = ProtectiveExitEvent(schema_version=PROTECTIVE_EXIT_EVENT_SCHEMA, side=PositionSide.LONG, reason="STOP_LOSS",
            trigger_kind="INTRABAR_LEVEL", trigger_bar_open_time_ms=0, trigger_bar_index=1,
            trigger_level_price=90.0, raw_exit_price=90.0, same_bar_collision=False, plan_id="a"*64,
            observation_path_id="b"*64, event_id=correct)
        # Forged wrong ID
        with self.assertRaises(ValueError):
            ProtectiveExitEvent(schema_version=PROTECTIVE_EXIT_EVENT_SCHEMA, side=PositionSide.LONG, reason="STOP_LOSS",
                trigger_kind="INTRABAR_LEVEL", trigger_bar_open_time_ms=0, trigger_bar_index=1,
                trigger_level_price=90.0, raw_exit_price=90.0, same_bar_collision=False, plan_id="a"*64,
                observation_path_id="b"*64, event_id="0"*64)

    def test_no_trigger_with_event_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution, ProtectiveExitEvent
        plan = ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)
        ev = None
        # construct a valid event to use
        b = list(bars(20))
        b[5] = bar(b[5].open_time_ms, b[5].open, b[5].high, 88.0, b[5].close)
        r = resolve_protective_exit(bars=b, entry_execution_index=1, last_observation_index=10, plan=plan, symbol="BTC/USDT", timeframe_ms=300000)
        with self.assertRaises(ValueError):
            ProtectiveExitResolution(schema_version="stage-5r1.protective-exit-resolution.v1", status="NO_TRIGGER", plan_id=plan.plan_id, observation_path_id=r.observation_path_id, event=r.event, resolution_id="")


# ======== TEST-GATE GAP CLOSURE ========

class ResolverInputValidationExtendedTests(unittest.TestCase):
    def _plan(self):
        return ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=100.0, stop_price=90.0, take_profit_price=120.0)

    def test_non_string_symbol_rejected(self):
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=bars(20), entry_execution_index=1, last_observation_index=10,
                plan=self._plan(), symbol=12345, timeframe_ms=300000)

    def test_float_timeframe_rejected(self):
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=bars(20), entry_execution_index=1, last_observation_index=10,
                plan=self._plan(), symbol="BTC/USDT", timeframe_ms=300000.0)

    def test_bool_timeframe_rejected(self):
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=bars(20), entry_execution_index=1, last_observation_index=10,
                plan=self._plan(), symbol="BTC/USDT", timeframe_ms=True)

    def test_negative_last_observation_rejected(self):
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=bars(20), entry_execution_index=1, last_observation_index=-1,
                plan=self._plan(), symbol="BTC/USDT", timeframe_ms=300000)

    def test_last_observation_out_of_range_rejected(self):
        with self.assertRaises(ValueError):
            resolve_protective_exit(bars=bars(10), entry_execution_index=1, last_observation_index=10,
                plan=self._plan(), symbol="BTC/USDT", timeframe_ms=300000)


class EventValidationExtendedTests(unittest.TestCase):
    def _valid_event_kw(self):
        from quant_engine.proof.stage5r1_protective_exit import canonical_sha256, PROTECTIVE_EXIT_EVENT_SCHEMA
        payload = {"schemaVersion": PROTECTIVE_EXIT_EVENT_SCHEMA, "side": PositionSide.LONG.value,
            "reason": "STOP_LOSS", "triggerKind": "INTRABAR_LEVEL", "triggerBarOpenTimeMs": 0,
            "triggerBarIndex": 1, "triggerLevelPrice": 90.0, "rawExitPrice": 90.0,
            "sameBarCollision": False, "planId": "a" * 64, "observationPathId": "b" * 64}
        eid = canonical_sha256(payload)
        return {"schema_version": PROTECTIVE_EXIT_EVENT_SCHEMA, "side": PositionSide.LONG,
            "reason": "STOP_LOSS", "trigger_kind": "INTRABAR_LEVEL", "trigger_bar_open_time_ms": 0,
            "trigger_bar_index": 1, "trigger_level_price": 90.0, "raw_exit_price": 90.0,
            "same_bar_collision": False, "plan_id": "a" * 64, "observation_path_id": "b" * 64, "event_id": eid}

    def test_invalid_schema_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitEvent
        kw = self._valid_event_kw(); kw["schema_version"] = "wrong-v1"
        with self.assertRaises(ValueError):
            ProtectiveExitEvent(**kw)

    def test_invalid_reason_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitEvent, canonical_sha256, PROTECTIVE_EXIT_EVENT_SCHEMA
        kw = self._valid_event_kw()
        # recompute id for wrong reason
        p = {"schemaVersion": PROTECTIVE_EXIT_EVENT_SCHEMA, "side": PositionSide.LONG.value,
            "reason": "INVALID", "triggerKind": "INTRABAR_LEVEL", "triggerBarOpenTimeMs": 0,
            "triggerBarIndex": 1, "triggerLevelPrice": 90.0, "rawExitPrice": 90.0,
            "sameBarCollision": False, "planId": "a" * 64, "observationPathId": "b" * 64}
        kw2 = dict(kw); kw2["reason"] = "INVALID"; kw2["event_id"] = canonical_sha256(p)
        with self.assertRaises(ValueError):
            ProtectiveExitEvent(**kw2)

    def test_invalid_kind_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitEvent, canonical_sha256, PROTECTIVE_EXIT_EVENT_SCHEMA
        kw = self._valid_event_kw()
        p = {"schemaVersion": PROTECTIVE_EXIT_EVENT_SCHEMA, "side": PositionSide.LONG.value,
            "reason": "STOP_LOSS", "triggerKind": "INVALID_KIND", "triggerBarOpenTimeMs": 0,
            "triggerBarIndex": 1, "triggerLevelPrice": 90.0, "rawExitPrice": 90.0,
            "sameBarCollision": False, "planId": "a" * 64, "observationPathId": "b" * 64}
        kw2 = dict(kw); kw2["trigger_kind"] = "INVALID_KIND"; kw2["event_id"] = canonical_sha256(p)
        with self.assertRaises(ValueError):
            ProtectiveExitEvent(**kw2)

    def test_malformed_event_id_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitEvent
        kw = self._valid_event_kw(); kw["event_id"] = "not-a-sha"
        with self.assertRaises(ValueError):
            ProtectiveExitEvent(**kw)


class ResolutionValidationExtendedTests(unittest.TestCase):
    def _valid_resolution_kw(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution, PROTECTIVE_EXIT_RESOLUTION_SCHEMA, canonical_sha256
        pid = "a" * 64; oid = "b" * 64
        d = {"schemaVersion": PROTECTIVE_EXIT_RESOLUTION_SCHEMA, "planId": pid, "observationPathId": oid,
            "status": "NO_TRIGGER", "eventId": None}
        rid = canonical_sha256(d)
        return {"schema_version": PROTECTIVE_EXIT_RESOLUTION_SCHEMA, "status": "NO_TRIGGER",
            "plan_id": pid, "observation_path_id": oid, "event": None, "resolution_id": rid}

    def test_invalid_schema_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution
        kw = self._valid_resolution_kw(); kw["schema_version"] = "wrong-v1"
        with self.assertRaises(ValueError):
            ProtectiveExitResolution(**kw)

    def test_invalid_status_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution, canonical_sha256, PROTECTIVE_EXIT_RESOLUTION_SCHEMA
        kw = self._valid_resolution_kw()
        p = {"schemaVersion": PROTECTIVE_EXIT_RESOLUTION_SCHEMA, "planId": kw["plan_id"],
            "observationPathId": kw["observation_path_id"], "status": "INVALID_STATUS", "eventId": None}
        kw2 = dict(kw); kw2["status"] = "INVALID_STATUS"; kw2["resolution_id"] = canonical_sha256(p)
        with self.assertRaises(ValueError):
            ProtectiveExitResolution(**kw2)

    def test_malformed_resolution_id_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution
        kw = self._valid_resolution_kw(); kw["resolution_id"] = "not-sha"
        with self.assertRaises(ValueError):
            ProtectiveExitResolution(**kw)

    def test_no_trigger_with_event_and_correct_id_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution, ProtectiveExitEvent, canonical_sha256, PROTECTIVE_EXIT_EVENT_SCHEMA, PROTECTIVE_EXIT_RESOLUTION_SCHEMA
        # build valid event
        ep = {"schemaVersion": PROTECTIVE_EXIT_EVENT_SCHEMA, "side": PositionSide.LONG.value,
            "reason": "STOP_LOSS", "triggerKind": "INTRABAR_LEVEL", "triggerBarOpenTimeMs": 0,
            "triggerBarIndex": 1, "triggerLevelPrice": 90.0, "rawExitPrice": 90.0,
            "sameBarCollision": False, "planId": "a" * 64, "observationPathId": "b" * 64}
        eid = canonical_sha256(ep)
        ev = ProtectiveExitEvent(schema_version=PROTECTIVE_EXIT_EVENT_SCHEMA, side=PositionSide.LONG,
            reason="STOP_LOSS", trigger_kind="INTRABAR_LEVEL", trigger_bar_open_time_ms=0,
            trigger_bar_index=1, trigger_level_price=90.0, raw_exit_price=90.0,
            same_bar_collision=False, plan_id="a" * 64, observation_path_id="b" * 64, event_id=eid)
        rp = {"schemaVersion": PROTECTIVE_EXIT_RESOLUTION_SCHEMA, "planId": "a" * 64,
            "observationPathId": "b" * 64, "status": "NO_TRIGGER", "eventId": eid}
        rid = canonical_sha256(rp)
        with self.assertRaises(ValueError):
            ProtectiveExitResolution(schema_version=PROTECTIVE_EXIT_RESOLUTION_SCHEMA, status="NO_TRIGGER",
                plan_id="a" * 64, observation_path_id="b" * 64, event=ev, resolution_id=rid)

    def test_triggered_no_event_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution, canonical_sha256, PROTECTIVE_EXIT_RESOLUTION_SCHEMA
        p = {"schemaVersion": PROTECTIVE_EXIT_RESOLUTION_SCHEMA, "planId": "a" * 64,
            "observationPathId": "b" * 64, "status": "TRIGGERED", "eventId": None}
        rid = canonical_sha256(p)
        with self.assertRaises(ValueError):
            ProtectiveExitResolution(schema_version=PROTECTIVE_EXIT_RESOLUTION_SCHEMA, status="TRIGGERED",
                plan_id="a" * 64, observation_path_id="b" * 64, event=None, resolution_id=rid)

    def test_plan_id_mismatch_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution, ProtectiveExitEvent, canonical_sha256, PROTECTIVE_EXIT_EVENT_SCHEMA, PROTECTIVE_EXIT_RESOLUTION_SCHEMA
        ev_pid = "a" * 64
        ev = ProtectiveExitEvent(schema_version=PROTECTIVE_EXIT_EVENT_SCHEMA, side=PositionSide.LONG,
            reason="STOP_LOSS", trigger_kind="INTRABAR_LEVEL", trigger_bar_open_time_ms=0,
            trigger_bar_index=1, trigger_level_price=90.0, raw_exit_price=90.0,
            same_bar_collision=False, plan_id=ev_pid, observation_path_id="b" * 64,
            event_id=canonical_sha256({"schemaVersion": PROTECTIVE_EXIT_EVENT_SCHEMA, "side": PositionSide.LONG.value,
                "reason": "STOP_LOSS", "triggerKind": "INTRABAR_LEVEL", "triggerBarOpenTimeMs": 0,
                "triggerBarIndex": 1, "triggerLevelPrice": 90.0, "rawExitPrice": 90.0,
                "sameBarCollision": False, "planId": ev_pid, "observationPathId": "b" * 64}))
        res_pid = "c" * 64  # different from event plan_id
        rp = {"schemaVersion": PROTECTIVE_EXIT_RESOLUTION_SCHEMA, "planId": res_pid,
            "observationPathId": "b" * 64, "status": "TRIGGERED", "eventId": ev.event_id}
        rid = canonical_sha256(rp)
        with self.assertRaisesRegex(ValueError, "RESOLUTION_PLAN_ID_MISMATCH"):
            ProtectiveExitResolution(schema_version=PROTECTIVE_EXIT_RESOLUTION_SCHEMA, status="TRIGGERED",
                plan_id=res_pid, observation_path_id="b" * 64, event=ev, resolution_id=rid)

    def test_path_id_mismatch_rejected(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution, ProtectiveExitEvent, canonical_sha256, PROTECTIVE_EXIT_EVENT_SCHEMA, PROTECTIVE_EXIT_RESOLUTION_SCHEMA
        ev_oid = "b" * 64
        ev = ProtectiveExitEvent(schema_version=PROTECTIVE_EXIT_EVENT_SCHEMA, side=PositionSide.LONG,
            reason="STOP_LOSS", trigger_kind="INTRABAR_LEVEL", trigger_bar_open_time_ms=0,
            trigger_bar_index=1, trigger_level_price=90.0, raw_exit_price=90.0,
            same_bar_collision=False, plan_id="a" * 64, observation_path_id=ev_oid,
            event_id=canonical_sha256({"schemaVersion": PROTECTIVE_EXIT_EVENT_SCHEMA, "side": PositionSide.LONG.value,
                "reason": "STOP_LOSS", "triggerKind": "INTRABAR_LEVEL", "triggerBarOpenTimeMs": 0,
                "triggerBarIndex": 1, "triggerLevelPrice": 90.0, "rawExitPrice": 90.0,
                "sameBarCollision": False, "planId": "a" * 64, "observationPathId": ev_oid}))
        res_oid = "d" * 64  # different from event path_id
        rp = {"schemaVersion": PROTECTIVE_EXIT_RESOLUTION_SCHEMA, "planId": "a" * 64,
            "observationPathId": res_oid, "status": "TRIGGERED", "eventId": ev.event_id}
        rid = canonical_sha256(rp)
        with self.assertRaisesRegex(ValueError, "RESOLUTION_PATH_ID_MISMATCH"):
            ProtectiveExitResolution(schema_version=PROTECTIVE_EXIT_RESOLUTION_SCHEMA, status="TRIGGERED",
                plan_id="a" * 64, observation_path_id=res_oid, event=ev, resolution_id=rid)


class CanonicalBindingTests(unittest.TestCase):
    def test_event_mutated_payload_rejects(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitEvent, canonical_sha256, PROTECTIVE_EXIT_EVENT_SCHEMA
        p = {"schemaVersion": PROTECTIVE_EXIT_EVENT_SCHEMA, "side": PositionSide.LONG.value,
            "reason": "STOP_LOSS", "triggerKind": "INTRABAR_LEVEL", "triggerBarOpenTimeMs": 0,
            "triggerBarIndex": 1, "triggerLevelPrice": 90.0, "rawExitPrice": 90.0,
            "sameBarCollision": False, "planId": "a" * 64, "observationPathId": "b" * 64}
        eid = canonical_sha256(p)
        p2 = dict(p); p2["triggerLevelPrice"] = 99.0  # mutate
        wrong_eid = canonical_sha256(p2)
        with self.assertRaisesRegex(ValueError, "EVENT_ID_MISMATCH"):
            ProtectiveExitEvent(schema_version=PROTECTIVE_EXIT_EVENT_SCHEMA, side=PositionSide.LONG,
                reason="STOP_LOSS", trigger_kind="INTRABAR_LEVEL", trigger_bar_open_time_ms=0,
                trigger_bar_index=1, trigger_level_price=99.0, raw_exit_price=90.0,
                same_bar_collision=False, plan_id="a" * 64, observation_path_id="b" * 64,
                event_id=eid)  # ID computed from original, but data is mutated

    def test_resolution_mutated_payload_rejects(self):
        from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitResolution, canonical_sha256, PROTECTIVE_EXIT_RESOLUTION_SCHEMA
        p = {"schemaVersion": PROTECTIVE_EXIT_RESOLUTION_SCHEMA, "planId": "a" * 64,
            "observationPathId": "b" * 64, "status": "NO_TRIGGER", "eventId": None}
        rid = canonical_sha256(p)
        p2 = dict(p); p2["observationPathId"] = "d" * 64  # mutate path, keep status valid
        with self.assertRaisesRegex(ValueError, "RESOLUTION_ID_MISMATCH"):
            ProtectiveExitResolution(schema_version=PROTECTIVE_EXIT_RESOLUTION_SCHEMA, status="NO_TRIGGER",
                plan_id="a" * 64, observation_path_id="d" * 64, event=None, resolution_id=rid)


if __name__ == "__main__":
    unittest.main()
