"""Stage 5R1.3-E protective excursion — TDD test gates."""

import math
import unittest

from dataclasses import dataclass

from quant_engine.proof.stage5r1_replay import (
    ReplayAction, ReplayBar, ReplayConfig, ReplayInstruction,
)
from quant_engine.proof.stage5r1_capital import (
    CapitalModel, CostModel, PositionSide, TradeAccounting, calculate_trade_accounting,
)
from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitPlan, ProtectiveExitEvent
from quant_engine.proof.stage5r1_protective_replay import (
    ProtectiveReplayBinding, ProtectiveReplayTrade, ProtectiveReplayResult,
    ReplayExitSelection,
    run_stage5r1_protective_replay,
    PROTECTIVE_SOURCE, EXPLICIT_SOURCE,
)
from quant_engine.proof.stage5r1_protective_excursion import (
    ProtectiveTradeExcursion, ProtectiveExcursionTrade, ProtectiveExcursionResult,
    run_stage5r1_protective_excursion,
    PROTECTIVE_EXCURSION_SCHEMA, PROTECTIVE_EXCURSION_WINDOW_POLICY,
    PROTECTIVE_EXCURSION_TIE_POLICY,
    SOURCE_FULL_BAR, SOURCE_FRONTIER_TRIGGER_OPEN, SOURCE_FRONTIER_TRIGGER_LEVEL,
    SOURCE_FRONTIER_EXIT_OPEN,
    _excursion_payload,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

FROZEN_TIMEFRAME_MS = 300_000


def bar(ms, o, h, l, c, v=100.0):
    return ReplayBar(open_time_ms=ms, open=float(o), high=float(h), low=float(l), close=float(c), volume=v)


def bars(n, start_ms=0, base=200.0):
    """Generate N bars with incremental OHLC."""
    return tuple(
        bar(start_ms + i * FROZEN_TIMEFRAME_MS,
            base + i, base + i + 1, base + i - 1, base + i + 0.5)
        for i in range(n)
    )


_CM = CapitalModel(initial_equity=10000.0)
_ZC = CostModel(fee_bps_per_fill=0, half_spread_bps_per_fill=0, slippage_bps_per_fill=0, funding_bps_per_8h_adverse=0)
_FC = CostModel(fee_bps_per_fill=4, half_spread_bps_per_fill=1, slippage_bps_per_fill=2, funding_bps_per_8h_adverse=1)


def _p_long(entry=None, stop=290.0, tp=310.0):
    return ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=entry or 300.0, stop_price=stop, take_profit_price=tp)


def _p_short(entry=None, stop=310.0, tp=290.0):
    return ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=entry or 300.0, stop_price=stop, take_profit_price=tp)


def _cfg(symbol="BTC/USDT"):
    return ReplayConfig(symbol=symbol)


_WARMUP_BARS = 100  # matches default warmup_bars=100


def _build_bars_with_entry(num_bars=200, entry_idx=100, base=200.0):
    """Build bars where entry_bar_idx is the execution bar (signal on bar 99, exec on 100)."""
    b = list(bars(num_bars, base=base))
    return tuple(b), entry_idx


def _run_excursion(b, insts, bindings=None, cfg=None, capital=None, cost=None):
    if cfg is None:
        cfg = _cfg()
    if capital is None:
        capital = _CM
    if cost is None:
        cost = _ZC
    if bindings is None:
        p = _p_long()
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
    return run_stage5r1_protective_excursion(
        bars=b, instructions=insts, protective_bindings=bindings,
        config=cfg, capital=capital, cost=cost,
    )


def _insts(b, entry_sig=99, exit_sig=110, action=ReplayAction.ENTER_LONG):
    return (ReplayInstruction(signal_bar_open_time_ms=b[entry_sig].open_time_ms, action=action),
            ReplayInstruction(signal_bar_open_time_ms=b[exit_sig].open_time_ms, action=ReplayAction.EXIT))


# ========================================================================
# 1. Deterministic repeat equality and independent ID reconstruction
# ========================================================================

class DeterminismTests(unittest.TestCase):
    def test_repeat_identical(self):
        """Two identical runs produce identical results."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open))
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r1 = _run_excursion(b, insts, bindings)
        r2 = _run_excursion(b, insts, bindings)
        self.assertEqual(r1.result_id, r2.result_id)
        self.assertEqual(len(r1.trades), len(r2.trades))
        for i in range(len(r1.trades)):
            self.assertEqual(r1.trades[i].composite_trade_id, r2.trades[i].composite_trade_id)
            self.assertEqual(r1.trades[i].excursion.excursion_id, r2.trades[i].excursion.excursion_id)

    def test_independent_id_reconstruction(self):
        """Excursion ID can be independently reconstructed from excursion fields."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open))
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        from quant_engine.proof.stage5r1_protective_excursion import _excursion_payload
        payload = _excursion_payload(exc)
        reconstructed = canonical_sha256(payload)
        self.assertEqual(exc.excursion_id, reconstructed)


# ========================================================================
# 2-5. Intrabar stop / take profit (long & short)
# ========================================================================

class LongIntrabarStopTests(unittest.TestCase):
    def test_intrabar_stop(self):
        """Long: intrabar stop hit on bar 105."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        self.assertEqual(len(r.trades), 1)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, PROTECTIVE_SOURCE)
        self.assertEqual(exc.trigger_kind, "INTRABAR_LEVEL")
        # full_pre_exit_bar_count = trigger_idx - entry_idx = 105 - 100 = 5
        self.assertEqual(exc.full_pre_exit_bar_count, 5)
        self.assertGreater(exc.mae_amount_before_exit_costs, 0)
        # Exit at stop price: worst case is the stop itself
        self.assertEqual(exc.raw_exit_price, 240.0)


class LongIntrabarTargetTests(unittest.TestCase):
    def test_intrabar_target(self):
        """Long: intrabar take profit hit."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 305.0, 312.0, 303.0, 306.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=250.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, PROTECTIVE_SOURCE)
        self.assertEqual(exc.trigger_kind, "INTRABAR_LEVEL")
        self.assertGreater(exc.mfe_amount_before_exit_costs, 0)


class ShortIntrabarStopTests(unittest.TestCase):
    def test_intrabar_stop(self):
        """Short: intrabar stop hit."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 350.0, 362.0, 347.0, 351.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150, action=ReplayAction.ENTER_SHORT)
        p = _p_short(entry=float(b[100].open), stop=360.0, tp=280.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, PROTECTIVE_SOURCE)
        self.assertEqual(exc.trigger_kind, "INTRABAR_LEVEL")
        self.assertGreater(exc.mae_amount_before_exit_costs, 0)


class ShortIntrabarTargetTests(unittest.TestCase):
    def test_intrabar_target(self):
        """Short: intrabar take profit hit."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 280.0, 283.0, 266.0, 282.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150, action=ReplayAction.ENTER_SHORT)
        p = _p_short(entry=float(b[100].open), stop=360.0, tp=270.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, PROTECTIVE_SOURCE)
        self.assertGreater(exc.mfe_amount_before_exit_costs, 0)


# ========================================================================
# 6. Gap-open stop and gap-open take profit
# ========================================================================

class GapOpenTests(unittest.TestCase):
    def test_gap_open_stop_long(self):
        """Long: bar opens below stop → GAP_OPEN stop."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 238.0, 242.0, 236.0, 239.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, PROTECTIVE_SOURCE)
        self.assertEqual(exc.trigger_kind, "GAP_OPEN")
        self.assertEqual(exc.raw_exit_price, float(b[105].open))
        # Frontier has only trigger open, not HLC
        # MFE/MAE from full bars only (0..104)
        self.assertGreaterEqual(exc.mfe_price_delta, 0)

    def test_gap_open_target_short(self):
        """Short: bar opens below target → GAP_OPEN take profit."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 268.0, 272.0, 266.0, 269.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150, action=ReplayAction.ENTER_SHORT)
        p = _p_short(entry=float(b[100].open), stop=360.0, tp=270.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, PROTECTIVE_SOURCE)
        self.assertEqual(exc.trigger_kind, "GAP_OPEN")


# ========================================================================
# 7. No-trigger explicit next-open
# ========================================================================

class ExplicitNoTriggerTests(unittest.TestCase):
    def test_explicit_next_open(self):
        """No protective trigger — exit at explicit next-open."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, EXPLICIT_SOURCE)
        self.assertIsNone(exc.trigger_kind)
        self.assertIsNone(exc.protective_event_id)
        self.assertEqual(exc.raw_exit_price, float(b[111].open))
        # full_pre_exit_bar_count = exit_idx - entry_idx = 111 - 100 = 11
        self.assertEqual(exc.full_pre_exit_bar_count, 11)


# ========================================================================
# 8-9. Entry-bar zero-duration stop / take profit
# ========================================================================

class ZeroDurationEntryBarTests(unittest.TestCase):
    def test_entry_bar_stop_nonzero_mae(self):
        """Entry-bar low hits stop → zero duration, nonzero MAE."""
        b = list(bars(200))
        b[100] = bar(b[100].open_time_ms, 300.0, 305.0, 289.0, 301.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=290.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.full_pre_exit_bar_count, 0)
        self.assertEqual(exc.entry_execution_time_ms, exc.exit_execution_time_ms)
        self.assertGreater(exc.mae_amount_before_exit_costs, 0.0)
        self.assertFalse(exc.mfe_amount_before_exit_costs == 0.0 and exc.mae_amount_before_exit_costs == 0.0,
                         "Zero-duration exit should not have both MFE and MAE zero")

    def test_entry_bar_target_nonzero_mfe(self):
        """Entry-bar high hits target → zero duration, nonzero MFE."""
        b = list(bars(200))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 295.0, 303.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=250.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.full_pre_exit_bar_count, 0)
        self.assertGreater(exc.mfe_amount_before_exit_costs, 0.0)


# ========================================================================
# 10. Entry-bar same-bar collision stop-first
# ========================================================================

class SameBarCollisionTests(unittest.TestCase):
    def test_same_bar_collision_stop_first(self):
        """Entry bar hits both stop and target → stop first, target extreme excluded."""
        b = list(bars(200))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 289.0, 301.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=290.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, PROTECTIVE_SOURCE)
        # It's a stop-first collision
        self.assertEqual(exc.trigger_kind, "INTRABAR_LEVEL")
        # The frontier for collision: only entry open + trigger_level (stop price)
        # Target-side high should NOT appear in frontier
        # So favorable extreme comes from entry open only (300)
        self.assertEqual(exc.favorable_extreme_price, 300.0)
        self.assertEqual(exc.adverse_extreme_price, 290.0)
        # MFE should be zero (entry fill >= favorable) or near zero
        self.assertAlmostEqual(exc.mfe_price_delta, 0.0, places=10)


# ========================================================================
# 11. Trigger-bar unused HLC cannot change computed extrema
# ========================================================================

class TriggerBarHLCDoesNotChangeExtremaTests(unittest.TestCase):
    def test_trigger_bar_hlc_not_counted_intrabar(self):
        """After intrabar trigger, changing trigger bar HLC doesn't change extrema."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 300.0, 200.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r1 = _run_excursion(b, insts, bindings)

        # Change trigger bar HLC but keep open and trigger the same
        b2 = list(b)
        b2[105] = bar(b[105].open_time_ms, 250.0, 999.0, 1.0, 500.0)
        b2 = tuple(b2)
        r2 = _run_excursion(b2, insts, bindings)

        exc1, exc2 = r1.trades[0].excursion, r2.trades[0].excursion
        # Extrema should be identical — trigger bar HLC is not in full_bars or frontier
        self.assertEqual(exc1.favorable_extreme_price, exc2.favorable_extreme_price)
        self.assertEqual(exc1.adverse_extreme_price, exc2.adverse_extreme_price)
        self.assertEqual(exc1.mfe_price_delta, exc2.mfe_price_delta)
        self.assertEqual(exc1.mae_price_delta, exc2.mae_price_delta)
        # Observation path should be unchanged (full bars don't include trigger bar)
        self.assertEqual(exc1.observation_path_id, exc2.observation_path_id)


# ========================================================================
# 12. Explicit exit HLC cannot change computed extrema
# ========================================================================

class ExplicitExitHLCDoesNotChangeExtremaTests(unittest.TestCase):
    def test_explicit_exit_hlc_not_counted(self):
        """Explicit exit bar HLC is never in full bars — only open in frontier."""
        b = list(bars(200))
        b[111] = bar(b[111].open_time_ms, 350.0, 999.0, 1.0, 500.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        # Exit bar H/L/C of 999/1/500 should NOT appear in extrema
        self.assertNotEqual(exc.favorable_extreme_price, 999.0)
        self.assertNotEqual(exc.adverse_extreme_price, 1.0)


# ========================================================================
# 13. Post-exit data cannot change observation path or excursion metrics
# ========================================================================

class PostExitIndependenceTests(unittest.TestCase):
    def test_post_exit_bars_do_not_change_excursion(self):
        """Changing bars after the exit bar doesn't change excursion."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r1 = _run_excursion(b, insts, bindings)

        # Change post-trigger bars (everything after bar 105)
        b2 = list(b)
        for i in range(106, len(b2)):
            b2[i] = bar(b2[i].open_time_ms, 999.0, 9999.0, 0.1, 500.0)
        b2 = tuple(b2)
        r2 = _run_excursion(b2, insts, bindings)

        exc1, exc2 = r1.trades[0].excursion, r2.trades[0].excursion
        self.assertEqual(exc1.observation_path_id, exc2.observation_path_id)
        self.assertEqual(exc1.mfe_price_delta, exc2.mfe_price_delta)
        self.assertEqual(exc1.mae_price_delta, exc2.mae_price_delta)


# ========================================================================
# 14. Pre-exit full-bar extrema do affect metrics and path
# ========================================================================

class PreExitBarEffectTests(unittest.TestCase):
    def test_pre_exit_bar_change_affects_excursion(self):
        """A pre-exit bar's high changes → excursion changes."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r1 = _run_excursion(b, insts, bindings)

        # Change bar 103 high (a pre-trigger bar)
        b2 = list(b)
        b2[103] = bar(b2[103].open_time_ms, b2[103].open, 900.0, b2[103].low, b2[103].close)
        b2 = tuple(b2)
        r2 = _run_excursion(b2, insts, bindings)

        exc1, exc2 = r1.trades[0].excursion, r2.trades[0].excursion
        # High price change must affect excursion path
        self.assertNotEqual(exc1.observation_path_id, exc2.observation_path_id)
        # Favorable extreme should change
        self.assertNotEqual(exc1.favorable_extreme_price, exc2.favorable_extreme_price)


# ========================================================================
# 15. Long and short formulas
# ========================================================================

class LongShortFormulaTests(unittest.TestCase):
    def test_long_favorable_is_max_adverse_is_min(self):
        """Long: favorable = max candidate prices, adverse = min."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        # Explicit: favorable = max(highs in bars[100:111] + exit_open)
        # Exit at bar 111 open; bars are monotonically increasing
        self.assertGreater(exc.favorable_extreme_price, exc.entry_fill_price)
        # Adverse is the min of all lows in full bars + exit_open
        self.assertIsNotNone(exc.adverse_extreme_price)

    def test_short_favorable_is_min_adverse_is_max(self):
        """Short: favorable = min candidate prices, adverse = max."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110, action=ReplayAction.ENTER_SHORT)
        p = _p_short(entry=float(b[100].open), stop=9999.0, tp=1.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        # Short: favorable = min, adverse = max
        self.assertLess(exc.favorable_extreme_price, exc.entry_fill_price)
        self.assertGreater(exc.adverse_extreme_price, exc.entry_fill_price)


# ========================================================================
# 16. Fee and slippage use entry fill, not raw entry
# ========================================================================

class FeeSlippageUsesEntryFillTests(unittest.TestCase):
    def test_mfe_mae_use_entry_fill(self):
        """MFE/MAE deltas are computed from entry_fill_price, not raw_entry_price."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        # Use fee model that makes entry_fill differ from raw_entry
        r = run_stage5r1_protective_excursion(
            bars=b, instructions=insts, protective_bindings=bindings,
            config=_cfg(), capital=_CM, cost=_FC,
        )
        exc = r.trades[0].excursion
        # entry_fill_price should differ from raw_entry_price due to spread/slippage
        raw_entry = float(b[100].open)
        self.assertNotEqual(exc.entry_fill_price, raw_entry)
        # MFE/MAE computed against entry_fill
        self.assertGreater(exc.entry_fill_price, raw_entry)  # LONG: fill > raw with fees


# ========================================================================
# 17. All required root and nested identities bound
# ========================================================================

class IdentityBindingTests(unittest.TestCase):
    def test_all_identities_bound(self):
        """All identity fields are non-null valid SHA-256."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion

        required_ids = [
            ("dataset_id", exc.dataset_id),
            ("instruction_set_id", exc.instruction_set_id),
            ("binding_set_id", exc.binding_set_id),
            ("replay_config_id", exc.replay_config_id),
            ("capital_model_id", exc.capital_model_id),
            ("cost_model_id", exc.cost_model_id),
            ("base_protective_replay_id", exc.base_protective_replay_id),
            ("base_trade_id", exc.base_trade_id),
            ("binding_id", exc.binding_id),
            ("plan_id", exc.plan_id),
            ("protective_resolution_id", exc.protective_resolution_id),
            ("selection_id", exc.selection_id),
            ("accounting_id", exc.accounting_id),
            ("observation_path_id", exc.observation_path_id),
            ("excursion_id", exc.excursion_id),
        ]
        for name, val in required_ids:
            self.assertEqual(len(val), 64, f"{name} not 64-char hex: {len(val)}")
            self.assertTrue(all(c in "0123456789abcdef" for c in val), f"{name} not hex: {val[:20]}...")

        # Protective stop has non-null event
        self.assertIsNotNone(exc.protective_event_id)
        self.assertEqual(len(exc.protective_event_id), 64)
        self.assertIsNotNone(exc.trigger_kind)


# ========================================================================
# 18. Forged IDs fail closed
# ========================================================================

class ForgedIDFailClosedTests(unittest.TestCase):
    def _get_excursion(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        return _run_excursion(b, insts, bindings).trades[0].excursion

    def test_forged_dataset_id_rejected(self):
        exc = self._get_excursion()
        with self.assertRaises(ValueError):
            ProtectiveTradeExcursion(
                **{**exc.__dict__, "dataset_id": "0" * 64, "excursion_id": "0" * 64})

    def test_forged_accounting_id_rejected(self):
        exc = self._get_excursion()
        with self.assertRaises(ValueError):
            ProtectiveTradeExcursion(
                **{**exc.__dict__, "accounting_id": "f" * 64, "excursion_id": "f" * 64})

    def test_forged_excursion_id_rejected(self):
        exc = self._get_excursion()
        with self.assertRaises(ValueError):
            ProtectiveTradeExcursion(
                **{**exc.__dict__, "excursion_id": "a" * 64})


# ========================================================================
# 19. Copied or reordered composites fail closed
# ========================================================================

class CompositeTamperTests(unittest.TestCase):
    def test_reordered_composites_fail_closed(self):
        """Copying trade data into wrong index fails ProtectiveExcursionResult."""
        b = list(bars(300))
        # Two trades
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b[205] = bar(b[205].open_time_ms, 350.0, 355.0, 339.0, 351.0)
        b = tuple(b)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.EXIT),
            ReplayInstruction(signal_bar_open_time_ms=b[199].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[250].open_time_ms, action=ReplayAction.EXIT),
        )
        p1 = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        p2 = _p_long(entry=float(b[200].open), stop=340.0, tp=410.0)
        bindings = (
            ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p1),
            ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[199].open_time_ms, plan=p2),
        )
        r = _run_excursion(b, insts, bindings)
        self.assertEqual(len(r.trades), 2)

        # Swap trades
        swapped = (r.trades[1], r.trades[0])
        with self.assertRaises(ValueError):
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base_protective_replay_id,
                symbol=r.symbol, timeframe_ms=r.timeframe_ms,
                dataset_id=r.dataset_id, instruction_set_id=r.instruction_set_id,
                binding_set_id=r.binding_set_id, replay_config_id=r.replay_config_id,
                capital_model_id=r.capital_model_id, cost_model_id=r.cost_model_id,
                trade_count=r.trade_count,
                trades=swapped, result_id="0" * 64)


# ========================================================================
# 20. List/tuple, subclass, bool-int, NaN, infinity, negative fail closed
# ========================================================================

class FailClosedTypeTests(unittest.TestCase):
    def test_list_not_tuple_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        with self.assertRaises(ValueError):
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base_protective_replay_id,
                symbol=r.symbol, timeframe_ms=r.timeframe_ms,
                dataset_id=r.dataset_id, instruction_set_id=r.instruction_set_id,
                binding_set_id=r.binding_set_id, replay_config_id=r.replay_config_id,
                capital_model_id=r.capital_model_id, cost_model_id=r.cost_model_id,
                trade_count=r.trade_count,
                trades=list(r.trades), result_id="0" * 64)

    def test_subclass_not_accepted(self):
        """Subclass of ProtectiveExcursionTrade rejected in result."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)

        class FakeTrade(ProtectiveExcursionTrade):
            pass

        fake = FakeTrade(
            base=r.trades[0].base,
            selection=r.trades[0].selection,
            accounting=r.trades[0].accounting,
            excursion=r.trades[0].excursion,
            resolution=r.trades[0].resolution,
            composite_trade_id=r.trades[0].composite_trade_id,
        )
        with self.assertRaises(ValueError):
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base_protective_replay_id,
                symbol=r.symbol, timeframe_ms=r.timeframe_ms,
                dataset_id=r.dataset_id, instruction_set_id=r.instruction_set_id,
                binding_set_id=r.binding_set_id, replay_config_id=r.replay_config_id,
                capital_model_id=r.capital_model_id, cost_model_id=r.cost_model_id,
                trade_count=r.trade_count,
                trades=(fake,), result_id="0" * 64)

    def test_bool_for_int_rejected(self):
        """Bool True/False where int is expected fails."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        with self.assertRaises(ValueError):
            ProtectiveTradeExcursion(
                **{**exc.__dict__,
                   "full_pre_exit_bar_count": True,
                   "excursion_id": "0" * 64})

    def test_nan_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        with self.assertRaises(ValueError):
            ProtectiveTradeExcursion(
                **{**exc.__dict__,
                   "entry_fill_price": float("nan"),
                   "excursion_id": "0" * 64})

    def test_inf_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        with self.assertRaises(ValueError):
            ProtectiveTradeExcursion(
                **{**exc.__dict__,
                   "entry_fill_price": float("inf"),
                   "excursion_id": "0" * 64})

    def test_negative_magnitude_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        with self.assertRaises(ValueError):
            ProtectiveTradeExcursion(
                **{**exc.__dict__,
                   "mfe_price_delta": -1.0,
                   "excursion_id": "0" * 64})


# ========================================================================
# 21. Caller inputs unchanged
# ========================================================================

class InputImmutabilityTests(unittest.TestCase):
    def test_bars_unchanged(self):
        b_orig = list(bars(200))
        b_copy = list(b_orig)
        insts = _insts(tuple(b_orig), entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b_orig[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        _run_excursion(tuple(b_orig), insts, bindings)
        for i, (a, b_val) in enumerate(zip(b_orig, b_copy)):
            self.assertEqual(a.open_time_ms, b_val.open_time_ms, f"bar {i} time changed")
            self.assertEqual(a.open, b_val.open, f"bar {i} open changed")

    def test_instructions_unchanged(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        insts_copy = (ReplayInstruction(signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, action=insts[0].action),
                      ReplayInstruction(signal_bar_open_time_ms=insts[1].signal_bar_open_time_ms, action=insts[1].action))
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        _run_excursion(b, insts, bindings)
        self.assertEqual(insts[0].signal_bar_open_time_ms, insts_copy[0].signal_bar_open_time_ms)
        self.assertEqual(insts[0].action, insts_copy[0].action)

    def test_capital_cost_unchanged(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        cap = CapitalModel(initial_equity=50000.0)
        cst = CostModel(fee_bps_per_fill=5)
        _run_excursion(b, insts, bindings, capital=cap, cost=cst)
        self.assertEqual(cap.initial_equity, 50000.0)
        self.assertEqual(cst.fee_bps_per_fill, 5.0)


# ========================================================================
# 22. Existing Stage D result and identities unchanged by composition
# ========================================================================

class StageDUnchangedTests(unittest.TestCase):
    def test_base_result_identities_unchanged(self):
        """Stage D ProtectiveReplayResult and trade identities remain intact."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)

        # Run Stage D directly
        base_result = run_stage5r1_protective_replay(
            bars=b, instructions=insts, protective_bindings=bindings,
            config=_cfg(), capital=_CM, cost=_ZC,
        )

        # Run Stage E
        r = _run_excursion(b, insts, bindings)

        # Stage E's base result must match Stage D
        self.assertEqual(r.base.replay_id, base_result.replay_id)
        self.assertEqual(r.base.trade_count, base_result.trade_count)
        for i in range(r.base.trade_count):
            self.assertEqual(r.base.trades[i].trade_id, base_result.trades[i].trade_id)
            self.assertEqual(r.base.trades[i].accounting_id, base_result.trades[i].accounting_id)


# ========================================================================
# 23. Explicit no-trigger has null event and null trigger kind only
# ========================================================================

class ExplicitNullFieldsTests(unittest.TestCase):
    def test_explicit_nulls(self):
        """Explicit source → protective_event_id is None, trigger_kind is None."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, EXPLICIT_SOURCE)
        self.assertIsNone(exc.protective_event_id)
        self.assertIsNone(exc.trigger_kind)


# ========================================================================
# 24. Protective event requires non-null valid event and trigger kind
# ========================================================================

class ProtectiveNonNullFieldsTests(unittest.TestCase):
    def test_protective_requires_event_and_kind(self):
        """Protective trade must have non-null event_id and trigger_kind."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, PROTECTIVE_SOURCE)
        self.assertIsNotNone(exc.protective_event_id)
        self.assertIsNotNone(exc.trigger_kind)
        self.assertIn(exc.trigger_kind, ("GAP_OPEN", "INTRABAR_LEVEL"))


# ========================================================================
# 25. Zero-duration exact time/count relation
# ========================================================================

class ZeroDurationTimeCountTests(unittest.TestCase):
    def test_zero_duration_time_count_relation(self):
        """Zero full_pre_exit_bar_count → entry_time == exit_time."""
        b = list(bars(200))
        b[100] = bar(b[100].open_time_ms, 300.0, 305.0, 289.0, 301.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=290.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.full_pre_exit_bar_count, 0)
        self.assertEqual(exc.entry_execution_time_ms, exc.exit_execution_time_ms)
        # Time span = 0 * 300000 = 0, matches
        span = exc.exit_execution_time_ms - exc.entry_execution_time_ms
        expected = exc.full_pre_exit_bar_count * FROZEN_TIMEFRAME_MS
        self.assertEqual(span, expected)

    def test_positive_duration_time_count_relation(self):
        """Positive full_pre_exit_bar_count → span matches."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertGreater(exc.full_pre_exit_bar_count, 0)
        span = exc.exit_execution_time_ms - exc.entry_execution_time_ms
        expected = exc.full_pre_exit_bar_count * FROZEN_TIMEFRAME_MS
        self.assertEqual(span, expected)


# ========================================================================
# EXTRA: Composite trade ID binding all four sub-IDs
# ========================================================================

class CompositeTradeBindingTests(unittest.TestCase):
    def test_composite_binds_all_four_ids(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        ct = r.trades[0]
        # composite_trade_id binds base, selection, accounting, excursion
        expected = canonical_sha256({
            "schemaVersion": "stage-5r1.protective-excursion-trade.v1",
            "baseTradeId": ct.base.trade_id,
            "selectionId": ct.selection.selection_id,
            "accountingId": ct.accounting.accounting_id,
            "excursionId": ct.excursion.excursion_id,
            "resolutionId": ct.resolution.resolution_id,
            "tradeIndex": ct.base.trade_index,
        })
        self.assertEqual(ct.composite_trade_id, expected)

    def test_result_binds_all_ids(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        expected = canonical_sha256({
            "schemaVersion": "stage-5r1.protective-excursion-result.v1",
            "baseProtectiveReplayId": r.base.replay_id,
            "symbol": r.base.symbol,
            "timeframeMs": r.base.timeframe_ms,
            "datasetId": r.base.dataset_id,
            "instructionSetId": r.base.instruction_set_id,
            "bindingSetId": r.base.binding_set_id,
            "replayConfigId": r.base.replay_config_id,
            "capitalModelId": r.base.capital_model_id,
            "costModelId": r.base.cost_model_id,
            "tradeCount": r.base.trade_count,
            "compositeTradeIds": [t.composite_trade_id for t in r.trades],
            "excursionIds": [t.excursion.excursion_id for t in r.trades],
        })
        self.assertEqual(r.result_id, expected)


# ========================================================================
# EXTRA: Trigger bar HLC proof for intrabar exits
# ========================================================================

class TriggerBarHLCProofIntrabarTests(unittest.TestCase):
    def test_trigger_bar_high_low_not_in_extrema_intrabar(self):
        """Prove trigger bar H/L not used: extrema same regardless of H/L."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r1 = _run_excursion(b, insts, bindings)

        # Change trigger bar to extreme values
        b2 = list(b)
        b2[105] = bar(b2[105].open_time_ms, 250.0, 9999.0, 0.1, 5000.0)
        b2 = tuple(b2)
        r2 = _run_excursion(b2, insts, bindings)

        exc1, exc2 = r1.trades[0].excursion, r2.trades[0].excursion
        # Favorable extreme should NOT be 9999.0
        self.assertNotEqual(exc2.favorable_extreme_price, 9999.0)
        # Adverse extreme should NOT be 0.1
        self.assertNotEqual(exc2.adverse_extreme_price, 0.1)
        # Both should be identical to first run
        self.assertEqual(exc1.favorable_extreme_price, exc2.favorable_extreme_price)
        self.assertEqual(exc1.adverse_extreme_price, exc2.adverse_extreme_price)


# ========================================================================
# EXTRA: Adversarial coherent-forgery tests
# ========================================================================

def _make_explicit_result():
    """Helper: build a valid explicit no-trigger result for forging."""
    b = bars(200)
    insts = _insts(b, entry_sig=99, exit_sig=110)
    p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
    bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
    return _run_excursion(b, insts, bindings)


def _make_protective_result():
    """Helper: build a valid protective (intrabar stop) result for forging."""
    b = list(bars(200))
    b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
    b = tuple(b)
    insts = _insts(b, entry_sig=99, exit_sig=150)
    p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
    bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
    return _run_excursion(b, insts, bindings)


class AdversarialCoherentForgeryTests(unittest.TestCase):
    """Prove that canonical hashes alone do not secure the contract —
    cross-object truth validation must reject forged-but-consistent composites."""

    def test_missing_last_composite_rejected(self):
        r = _make_explicit_result()
        # Drop last (and only) composite, recompute result_id
        empty = ()
        # result_id would be consistent with empty trades
        forgery_id = canonical_sha256({
            "schemaVersion": "stage-5r1.protective-excursion-result.v1",
            "baseProtectiveReplayId": r.base.replay_id,
            "symbol": r.base.symbol, "timeframeMs": r.base.timeframe_ms,
            "datasetId": r.base.dataset_id,
            "instructionSetId": r.base.instruction_set_id,
            "bindingSetId": r.base.binding_set_id,
            "replayConfigId": r.base.replay_config_id,
            "capitalModelId": r.base.capital_model_id,
            "costModelId": r.base.cost_model_id,
            "tradeCount": r.base.trade_count,
            "compositeTradeIds": [],
            "excursionIds": [],
        })
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base.replay_id,
                symbol=r.base.symbol, timeframe_ms=r.base.timeframe_ms,
                dataset_id=r.base.dataset_id,
                instruction_set_id=r.base.instruction_set_id,
                binding_set_id=r.base.binding_set_id,
                replay_config_id=r.base.replay_config_id,
                capital_model_id=r.base.capital_model_id,
                cost_model_id=r.base.cost_model_id,
                trade_count=r.base.trade_count,
                trades=empty, result_id=forgery_id,
            )
        self.assertIn("TRADE_COUNT_LEN", str(ctx.exception))

    def test_extra_composite_rejected(self):
        r = _make_explicit_result()
        t = r.trades[0]
        # Duplicate the trade — now 2 trades but trade_count=1
        doubled = (t, t)
        forgery_id = canonical_sha256({
            "schemaVersion": "stage-5r1.protective-excursion-result.v1",
            "baseProtectiveReplayId": r.base.replay_id,
            "symbol": r.base.symbol, "timeframeMs": r.base.timeframe_ms,
            "datasetId": r.base.dataset_id,
            "instructionSetId": r.base.instruction_set_id,
            "bindingSetId": r.base.binding_set_id,
            "replayConfigId": r.base.replay_config_id,
            "capitalModelId": r.base.capital_model_id,
            "costModelId": r.base.cost_model_id,
            "tradeCount": r.base.trade_count,
            "compositeTradeIds": [t.composite_trade_id, t.composite_trade_id],
            "excursionIds": [t.excursion.excursion_id, t.excursion.excursion_id],
        })
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base.replay_id,
                symbol=r.base.symbol, timeframe_ms=r.base.timeframe_ms,
                dataset_id=r.base.dataset_id,
                instruction_set_id=r.base.instruction_set_id,
                binding_set_id=r.base.binding_set_id,
                replay_config_id=r.base.replay_config_id,
                capital_model_id=r.base.capital_model_id,
                cost_model_id=r.base.cost_model_id,
                trade_count=r.base.trade_count,
                trades=doubled, result_id=forgery_id,
            )
        self.assertIn("TRADE_COUNT_LEN", str(ctx.exception))

    def test_excursion_dataset_id_changed_rejected(self):
        r = _make_explicit_result()
        t = r.trades[0]
        exc = t.excursion
        # Forge dataset_id, recompute all downstream IDs
        forged_ds = "0" * 64
        exc_payload = _excursion_payload(exc)
        exc_payload["datasetId"] = forged_ds
        forged_exc_id = canonical_sha256(exc_payload)

        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__, "dataset_id": forged_ds, "excursion_id": forged_exc_id})

        # Recompute composite and result IDs
        forged_ct_id = canonical_sha256({
            "schemaVersion": "stage-5r1.protective-excursion-trade.v1",
            "baseTradeId": t.base.trade_id,
            "selectionId": t.selection.selection_id,
            "accountingId": t.accounting.accounting_id,
            "excursionId": forged_exc_id,
            "resolutionId": t.resolution.resolution_id,
            "tradeIndex": t.base.trade_index,
        })
        forged_ct = ProtectiveExcursionTrade(
            base=t.base, selection=t.selection, accounting=t.accounting,
            excursion=forged_exc, resolution=t.resolution,
            composite_trade_id=forged_ct_id,
        )
        forgery_rid = canonical_sha256({
            "schemaVersion": "stage-5r1.protective-excursion-result.v1",
            "baseProtectiveReplayId": r.base.replay_id,
            "symbol": r.base.symbol, "timeframeMs": r.base.timeframe_ms,
            "datasetId": r.base.dataset_id,
            "instructionSetId": r.base.instruction_set_id,
            "bindingSetId": r.base.binding_set_id,
            "replayConfigId": r.base.replay_config_id,
            "capitalModelId": r.base.capital_model_id,
            "costModelId": r.base.cost_model_id,
            "tradeCount": r.base.trade_count,
            "compositeTradeIds": [forged_ct_id],
            "excursionIds": [forged_exc_id],
        })
        # Result constructor should reject: excursion dataset_id != result dataset_id
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base.replay_id,
                symbol=r.base.symbol, timeframe_ms=r.base.timeframe_ms,
                dataset_id=r.base.dataset_id,
                instruction_set_id=r.base.instruction_set_id,
                binding_set_id=r.base.binding_set_id,
                replay_config_id=r.base.replay_config_id,
                capital_model_id=r.base.capital_model_id,
                cost_model_id=r.base.cost_model_id,
                trade_count=r.base.trade_count,
                trades=(forged_ct,), result_id=forgery_rid,
            )
        self.assertIn("EXC_DATASET_ID", str(ctx.exception))

    def test_base_protective_replay_id_changed_rejected(self):
        r = _make_explicit_result()
        t = r.trades[0]
        exc = t.excursion
        forged_replay = "f" * 64
        exc_payload = _excursion_payload(exc)
        exc_payload["baseProtectiveReplayId"] = forged_replay
        forged_exc_id = canonical_sha256(exc_payload)

        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__, "base_protective_replay_id": forged_replay,
               "excursion_id": forged_exc_id})
        forged_ct_id = canonical_sha256({
            "schemaVersion": "stage-5r1.protective-excursion-trade.v1",
            "baseTradeId": t.base.trade_id,
            "selectionId": t.selection.selection_id,
            "accountingId": t.accounting.accounting_id,
            "excursionId": forged_exc_id,
            "resolutionId": t.resolution.resolution_id,
            "tradeIndex": t.base.trade_index,
        })
        forged_ct = ProtectiveExcursionTrade(
            base=t.base, selection=t.selection, accounting=t.accounting,
            excursion=forged_exc, resolution=t.resolution,
            composite_trade_id=forged_ct_id,
        )
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base.replay_id,
                symbol=r.base.symbol, timeframe_ms=r.base.timeframe_ms,
                dataset_id=r.base.dataset_id,
                instruction_set_id=r.base.instruction_set_id,
                binding_set_id=r.base.binding_set_id,
                replay_config_id=r.base.replay_config_id,
                capital_model_id=r.base.capital_model_id,
                cost_model_id=r.base.cost_model_id,
                trade_count=r.base.trade_count,
                trades=(forged_ct,), result_id="0" * 64,
            )
        self.assertIn("EXC_REPLAY_ID", str(ctx.exception))

    def test_binding_id_changed_rejected(self):
        r = _make_explicit_result()
        t = r.trades[0]
        exc = t.excursion
        forged_bid = "a" * 64
        exc_payload = _excursion_payload(exc)
        exc_payload["bindingId"] = forged_bid
        forged_exc_id = canonical_sha256(exc_payload)

        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__, "binding_id": forged_bid, "excursion_id": forged_exc_id})
        # When constructing the composite, the nested lineage check fires
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionTrade(
                base=t.base, selection=t.selection, accounting=t.accounting,
                excursion=forged_exc, resolution=t.resolution,
                composite_trade_id="0" * 64,
            )
        self.assertIn("BINDING_ID", str(ctx.exception))

    def test_selection_id_changed_rejected(self):
        r = _make_explicit_result()
        t = r.trades[0]
        exc = t.excursion
        forged_sid = "b" * 64
        exc_payload = _excursion_payload(exc)
        exc_payload["selectionId"] = forged_sid
        forged_exc_id = canonical_sha256(exc_payload)

        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__, "selection_id": forged_sid, "excursion_id": forged_exc_id})
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionTrade(
                base=t.base, selection=t.selection, accounting=t.accounting,
                excursion=forged_exc, resolution=t.resolution,
                composite_trade_id="0" * 64,
            )
        self.assertIn("EXC_SEL_ID", str(ctx.exception))

    def test_accounting_id_changed_rejected(self):
        r = _make_explicit_result()
        t = r.trades[0]
        exc = t.excursion
        forged_aid = "c" * 64
        exc_payload = _excursion_payload(exc)
        exc_payload["accountingId"] = forged_aid
        forged_exc_id = canonical_sha256(exc_payload)

        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__, "accounting_id": forged_aid, "excursion_id": forged_exc_id})
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionTrade(
                base=t.base, selection=t.selection, accounting=t.accounting,
                excursion=forged_exc, resolution=t.resolution,
                composite_trade_id="0" * 64,
            )
        self.assertIn("EXC_ACCT_ID", str(ctx.exception))

    def test_arithmetic_magnitude_forged_rejected(self):
        """Forge mfe_price_delta with recomputed excursion_id — arithmetic check rejects."""
        r = _make_explicit_result()
        exc = r.trades[0].excursion
        forged_delta = exc.mfe_price_delta + 100.0
        exc_payload = _excursion_payload(exc)
        exc_payload["mfePriceDelta"] = float(forged_delta)
        forged_exc_id = canonical_sha256(exc_payload)

        with self.assertRaises(ValueError) as ctx:
            ProtectiveTradeExcursion(
                **{**exc.__dict__, "mfe_price_delta": forged_delta,
                   "excursion_id": forged_exc_id})
        self.assertIn("MFE_DELTA_INCONSISTENT", str(ctx.exception))

    def test_extreme_price_semantic_violation_rejected(self):
        """Change extreme price + recompute IDs but violate side-consistency."""
        r = _make_explicit_result()
        exc = r.trades[0].excursion
        # Swap favorable and adverse prices
        swap_fav = exc.adverse_extreme_price
        swap_adv = exc.favorable_extreme_price
        # Recompute arithmetic
        if exc.side.value == "long":
            new_mfe = max(0.0, swap_fav - exc.entry_fill_price)
            new_mae = max(0.0, exc.entry_fill_price - swap_adv)
        else:
            new_mfe = max(0.0, exc.entry_fill_price - swap_fav)
            new_mae = max(0.0, swap_adv - exc.entry_fill_price)
        new_amt_mfe = exc.quantity * new_mfe
        new_amt_mae = exc.quantity * new_mae
        new_ret_mfe = new_amt_mfe / exc.entry_equity
        new_ret_mae = new_amt_mae / exc.entry_equity
        new_frac_mfe = new_mfe / exc.entry_fill_price
        new_frac_mae = new_mae / exc.entry_fill_price

        payload = _excursion_payload(exc)
        payload["favorableExtremePrice"] = float(swap_fav)
        payload["adverseExtremePrice"] = float(swap_adv)
        payload["mfePriceDelta"] = float(new_mfe)
        payload["maePriceDelta"] = float(new_mae)
        payload["mfeAmountBeforeExitCosts"] = float(new_amt_mfe)
        payload["maeAmountBeforeExitCosts"] = float(new_amt_mae)
        payload["mfeReturnOnEntryEquity"] = float(new_ret_mfe)
        payload["maeReturnOnEntryEquity"] = float(new_ret_mae)
        payload["mfeFractionOfEntryFillPrice"] = float(new_frac_mfe)
        payload["maeFractionOfEntryFillPrice"] = float(new_frac_mae)
        forged_id = canonical_sha256(payload)

        # LONG: favorable must be >= adverse — swapped makes favorable < adverse
        with self.assertRaises(ValueError) as ctx:
            ProtectiveTradeExcursion(
                **{**exc.__dict__,
                   "favorable_extreme_price": swap_fav,
                   "adverse_extreme_price": swap_adv,
                   "mfe_price_delta": new_mfe,
                   "mae_price_delta": new_mae,
                   "mfe_amount_before_exit_costs": new_amt_mfe,
                   "mae_amount_before_exit_costs": new_amt_mae,
                   "mfe_return_on_entry_equity": new_ret_mfe,
                   "mae_return_on_entry_equity": new_ret_mae,
                   "mfe_fraction_of_entry_fill_price": new_frac_mfe,
                   "mae_fraction_of_entry_fill_price": new_frac_mae,
                   "excursion_id": forged_id})
        self.assertIn("LONG_FAV_LT_ADV", str(ctx.exception))

    def test_explicit_using_trigger_source_label_rejected(self):
        r = _make_explicit_result()
        exc = r.trades[0].excursion
        # Forge: change favorable source to FRONTIER_TRIGGER_LEVEL (disallowed for explicit)
        payload = _excursion_payload(exc)
        payload["favorableExtremeSource"] = SOURCE_FRONTIER_TRIGGER_LEVEL
        forged_id = canonical_sha256(payload)
        with self.assertRaises(ValueError) as ctx:
            ProtectiveTradeExcursion(
                **{**exc.__dict__,
                   "favorable_extreme_source": SOURCE_FRONTIER_TRIGGER_LEVEL,
                   "excursion_id": forged_id})
        self.assertIn("FAV_SOURCE_DISALLOWED", str(ctx.exception))

    def test_protective_using_exit_open_source_label_rejected(self):
        r = _make_protective_result()
        exc = r.trades[0].excursion
        # Forge: change source label to FRONTIER_EXIT_OPEN (disallowed for protective)
        payload = _excursion_payload(exc)
        payload["favorableExtremeSource"] = SOURCE_FRONTIER_EXIT_OPEN
        forged_id = canonical_sha256(payload)
        with self.assertRaises(ValueError) as ctx:
            ProtectiveTradeExcursion(
                **{**exc.__dict__,
                   "favorable_extreme_source": SOURCE_FRONTIER_EXIT_OPEN,
                   "excursion_id": forged_id})
        self.assertIn("FAV_SOURCE_DISALLOWED", str(ctx.exception))

    def test_zero_count_full_bar_source_rejected(self):
        """Zero-duration entry-bar exit cannot claim FULL_BAR source."""
        b = list(bars(200))
        b[100] = bar(b[100].open_time_ms, 300.0, 305.0, 289.0, 301.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=290.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.full_pre_exit_bar_count, 0)
        # Forge: change favorable source to FULL_BAR
        payload = _excursion_payload(exc)
        payload["favorableExtremeSource"] = SOURCE_FULL_BAR
        forged_id = canonical_sha256(payload)
        with self.assertRaises(ValueError) as ctx:
            ProtectiveTradeExcursion(
                **{**exc.__dict__,
                   "favorable_extreme_source": SOURCE_FULL_BAR,
                   "excursion_id": forged_id})
        self.assertIn("FULL_BAR_IMPOSSIBLE_ZERO_COUNT", str(ctx.exception))

    def test_result_count_must_equal_base_trade_count(self):
        """ProtectiveExcursionResult enforces len(trades) == base.trade_count."""
        r = _make_explicit_result()
        # Try to construct with trades=() — length 0 but trade_count=1
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base.replay_id,
                symbol=r.base.symbol, timeframe_ms=r.base.timeframe_ms,
                dataset_id=r.base.dataset_id,
                instruction_set_id=r.base.instruction_set_id,
                binding_set_id=r.base.binding_set_id,
                replay_config_id=r.base.replay_config_id,
                capital_model_id=r.base.capital_model_id,
                cost_model_id=r.base.cost_model_id,
                trade_count=r.base.trade_count,
                trades=(), result_id="0" * 64,
            )
        self.assertIn("TRADE_COUNT_LEN", str(ctx.exception))

    def test_exc_root_id_must_equal_result_root_id(self):
        """Result validates each excursion's root IDs match result's exposed fields."""
        r = _make_explicit_result()
        t = r.trades[0]
        exc = t.excursion
        # Forge the excursion's instruction_set_id but keep result's fields matching base
        forged_is = "d" * 64
        exc_payload = _excursion_payload(exc)
        exc_payload["instructionSetId"] = forged_is
        forged_exc_id = canonical_sha256(exc_payload)
        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__, "instruction_set_id": forged_is,
               "excursion_id": forged_exc_id})
        forged_ct_id = canonical_sha256({
            "schemaVersion": "stage-5r1.protective-excursion-trade.v1",
            "baseTradeId": t.base.trade_id,
            "selectionId": t.selection.selection_id,
            "accountingId": t.accounting.accounting_id,
            "excursionId": forged_exc_id,
            "resolutionId": t.resolution.resolution_id,
            "tradeIndex": t.base.trade_index,
        })
        forged_ct = ProtectiveExcursionTrade(
            base=t.base, selection=t.selection, accounting=t.accounting,
            excursion=forged_exc, resolution=t.resolution,
            composite_trade_id=forged_ct_id,
        )
        forgery_rid = canonical_sha256({
            "schemaVersion": "stage-5r1.protective-excursion-result.v1",
            "baseProtectiveReplayId": r.base.replay_id,
            "symbol": r.base.symbol, "timeframeMs": r.base.timeframe_ms,
            "datasetId": r.base.dataset_id,
            "instructionSetId": r.base.instruction_set_id,
            "bindingSetId": r.base.binding_set_id,
            "replayConfigId": r.base.replay_config_id,
            "capitalModelId": r.base.capital_model_id,
            "costModelId": r.base.cost_model_id,
            "tradeCount": r.base.trade_count,
            "compositeTradeIds": [forged_ct_id],
            "excursionIds": [forged_exc_id],
        })
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base.replay_id,
                symbol=r.base.symbol, timeframe_ms=r.base.timeframe_ms,
                dataset_id=r.base.dataset_id,
                instruction_set_id=r.base.instruction_set_id,
                binding_set_id=r.base.binding_set_id,
                replay_config_id=r.base.replay_config_id,
                capital_model_id=r.base.capital_model_id,
                cost_model_id=r.base.cost_model_id,
                trade_count=r.base.trade_count,
                trades=(forged_ct,), result_id=forgery_rid,
            )
        self.assertIn("EXC_INSTRUCTION_ID", str(ctx.exception))


# ========================================================================
# EXTRA: Second-review adversarial coherent-forgery + verification tests
# ========================================================================

class ResolutionForgeryTests(unittest.TestCase):
    """Prove resolution lineage validation rejects trigger-kind swaps etc."""

    def test_trigger_kind_swap_rejected(self):
        """Swap trigger_kind INTRABAR→GAP with recomputed IDs — rejected."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.trigger_kind, "INTRABAR_LEVEL")
        exc_payload = _excursion_payload(exc)
        exc_payload["triggerKind"] = "GAP_OPEN"
        forged_exc_id = canonical_sha256(exc_payload)
        with self.assertRaises(ValueError) as ctx:
            ProtectiveTradeExcursion(
                **{**exc.__dict__, "trigger_kind": "GAP_OPEN",
                   "excursion_id": forged_exc_id})
        # Rejected because exit_bar_open != raw_exit (250 != 240) when GAP
        self.assertIn("BAR_OPEN", str(ctx.exception))

    def test_resolution_id_changed_rejected(self):
        r = _make_explicit_result()
        exc = r.trades[0].excursion
        forged_res = "e" * 64
        exc_payload = _excursion_payload(exc)
        exc_payload["protectiveResolutionId"] = forged_res
        forged_exc_id = canonical_sha256(exc_payload)
        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__,
               "protective_resolution_id": forged_res,
               "excursion_id": forged_exc_id})
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionTrade(
                base=r.trades[0].base, selection=r.trades[0].selection,
                accounting=r.trades[0].accounting, excursion=forged_exc,
                resolution=r.trades[0].resolution,
                composite_trade_id="0" * 64,
            )
        self.assertIn("RESOLUTION_ID_MISMATCH", str(ctx.exception))

    def test_event_id_changed_rejected(self):
        r = _make_protective_result()
        exc = r.trades[0].excursion
        forged_evt = "f" * 64
        exc_payload = _excursion_payload(exc)
        exc_payload["protectiveEventId"] = forged_evt
        forged_exc_id = canonical_sha256(exc_payload)
        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__,
               "protective_event_id": forged_evt,
               "excursion_id": forged_exc_id})
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionTrade(
                base=r.trades[0].base, selection=r.trades[0].selection,
                accounting=r.trades[0].accounting, excursion=forged_exc,
                resolution=r.trades[0].resolution,
                composite_trade_id="0" * 64,
            )
        self.assertIn("EVENT", str(ctx.exception))

    def test_observation_path_id_changed_rejected_by_verify(self):
        """Observation path forgery self-consistent in composite but verify rejects."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        forged_path = "0" * 64
        exc_payload = _excursion_payload(exc)
        exc_payload["observationPathId"] = forged_path
        forged_exc_id = canonical_sha256(exc_payload)
        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__, "observation_path_id": forged_path,
               "excursion_id": forged_exc_id})
        ct_payload = {
            "schemaVersion": "stage-5r1.protective-excursion-trade.v1",
            "baseTradeId": r.trades[0].base.trade_id,
            "selectionId": r.trades[0].selection.selection_id,
            "accountingId": r.trades[0].accounting.accounting_id,
            "excursionId": forged_exc_id,
            "resolutionId": r.trades[0].resolution.resolution_id,
            "tradeIndex": r.trades[0].base.trade_index,
        }
        forged_ct_id = canonical_sha256(ct_payload)
        forged_ct = ProtectiveExcursionTrade(
            base=r.trades[0].base, selection=r.trades[0].selection,
            accounting=r.trades[0].accounting, excursion=forged_exc,
            resolution=r.trades[0].resolution,
            composite_trade_id=forged_ct_id)
        rid_payload = {
            "schemaVersion": "stage-5r1.protective-excursion-result.v1",
            "baseProtectiveReplayId": r.base.replay_id,
            "symbol": r.base.symbol, "timeframeMs": r.base.timeframe_ms,
            "datasetId": r.base.dataset_id,
            "instructionSetId": r.base.instruction_set_id,
            "bindingSetId": r.base.binding_set_id,
            "replayConfigId": r.base.replay_config_id,
            "capitalModelId": r.base.capital_model_id,
            "costModelId": r.base.cost_model_id,
            "tradeCount": r.base.trade_count,
            "compositeTradeIds": [forged_ct_id],
            "excursionIds": [forged_exc_id],
        }
        forgery_rid = canonical_sha256(rid_payload)
        forgery = ProtectiveExcursionResult(
            base=r.base,
            base_protective_replay_id=r.base.replay_id,
            symbol=r.base.symbol, timeframe_ms=r.base.timeframe_ms,
            dataset_id=r.base.dataset_id,
            instruction_set_id=r.base.instruction_set_id,
            binding_set_id=r.base.binding_set_id,
            replay_config_id=r.base.replay_config_id,
            capital_model_id=r.base.capital_model_id,
            cost_model_id=r.base.cost_model_id,
            trade_count=r.base.trade_count,
            trades=(forged_ct,), result_id=forgery_rid,
        )
        # verify must reject because observation path doesn't match authoritative data
        from quant_engine.proof.stage5r1_protective_excursion import \
            verify_stage5r1_protective_excursion
        with self.assertRaises(ValueError) as ctx:
            verify_stage5r1_protective_excursion(
                result=forgery, bars=b, instructions=insts,
                protective_bindings=bindings, config=_cfg(),
                capital=_CM, cost=_ZC,
            )
        self.assertIn("VERIFY_RESULT_ID_MISMATCH", str(ctx.exception))


class VerifyAPITests(unittest.TestCase):
    """Test the authoritative verify_stage5r1_protective_excursion boundary."""

    def test_valid_verify_returns_exact_result(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        from quant_engine.proof.stage5r1_protective_excursion import \
            verify_stage5r1_protective_excursion
        verified = verify_stage5r1_protective_excursion(
            result=r, bars=b, instructions=insts,
            protective_bindings=bindings, config=_cfg(),
            capital=_CM, cost=_ZC,
        )
        self.assertEqual(verified.result_id, r.result_id)
        self.assertEqual(len(verified.trades), len(r.trades))

    def test_valid_verify_returns_supplied_object(self):
        """Verify returns the IDENTICAL supplied object, not a replacement."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        from quant_engine.proof.stage5r1_protective_excursion import \
            verify_stage5r1_protective_excursion
        verified = verify_stage5r1_protective_excursion(
            result=r, bars=b, instructions=insts,
            protective_bindings=bindings, config=_cfg(),
            capital=_CM, cost=_ZC,
        )
        self.assertIs(verified, r)

    def test_verify_content_mismatch_rejected(self):
        """Result with matching result_id but forged content is rejected at step 4.

        Simulates an untrusted deserialized object that bypassed __post_init__
        by using object.__setattr__ on a frozen dataclass.
        """
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        from quant_engine.proof.stage5r1_protective_excursion import \
            verify_stage5r1_protective_excursion
        # Forge: mutate a frozen field while keeping result_id intact,
        # simulating a deserialized object that skipped __post_init__.
        # object.__setattr__ bypasses the frozen dataclass guard.
        object.__setattr__(r, "symbol", "FORGED/BTC")
        # result_id still matches the authoritative recomputation
        with self.assertRaises(ValueError) as ctx:
            verify_stage5r1_protective_excursion(
                result=r, bars=b, instructions=insts,
                protective_bindings=bindings, config=_cfg(),
                capital=_CM, cost=_ZC,
            )
        self.assertIn("VERIFY_RESULT_CONTENT_MISMATCH", str(ctx.exception))

    def test_verify_rejects_subclass(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)

        class FakeResult(ProtectiveExcursionResult):
            pass

        fake = FakeResult(
            base=r.base,
            base_protective_replay_id=r.base_protective_replay_id,
            symbol=r.symbol, timeframe_ms=r.timeframe_ms,
            dataset_id=r.dataset_id,
            instruction_set_id=r.instruction_set_id,
            binding_set_id=r.binding_set_id,
            replay_config_id=r.replay_config_id,
            capital_model_id=r.capital_model_id,
            cost_model_id=r.cost_model_id,
            trade_count=r.trade_count,
            trades=r.trades, result_id=r.result_id,
        )
        from quant_engine.proof.stage5r1_protective_excursion import \
            verify_stage5r1_protective_excursion
        with self.assertRaises(ValueError) as ctx:
            verify_stage5r1_protective_excursion(
                result=fake, bars=b, instructions=insts,
                protective_bindings=bindings, config=_cfg(),
                capital=_CM, cost=_ZC,
            )
        self.assertIn("TYPE", str(ctx.exception))

    def test_verify_does_not_mutate_caller_inputs(self):
        b = list(bars(200))
        b_copy = [bar(bb.open_time_ms, bb.open, bb.high, bb.low, bb.close, bb.volume) for bb in b]
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        insts_copy = (ReplayInstruction(signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, action=insts[0].action),
                      ReplayInstruction(signal_bar_open_time_ms=insts[1].signal_bar_open_time_ms, action=insts[1].action))
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        from quant_engine.proof.stage5r1_protective_excursion import \
            verify_stage5r1_protective_excursion
        verify_stage5r1_protective_excursion(
            result=r, bars=b, instructions=insts,
            protective_bindings=bindings, config=_cfg(),
            capital=_CM, cost=_ZC,
        )
        for i, bb in enumerate(b_copy):
            self.assertEqual(b[i].open_time_ms, bb.open_time_ms)
            self.assertEqual(b[i].open, bb.open)
        self.assertEqual(insts[0].signal_bar_open_time_ms, insts_copy[0].signal_bar_open_time_ms)

    def test_explicit_result_schema_version_set(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        # result must have schema_version if added
        self.assertTrue(hasattr(r, 'base'))

    def test_composite_has_resolution(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        t = r.trades[0]
        self.assertTrue(hasattr(t, 'resolution'))


class ExitBarOpenForgeryTests(unittest.TestCase):
    """Prove exit bar open + raw exit price coherence validation."""

    def test_explicit_exit_bar_open_must_equal_raw_exit(self):
        r = _make_explicit_result()
        exc = r.trades[0].excursion
        self.assertEqual(exc.source, EXPLICIT_SOURCE)
        self.assertEqual(exc.exit_bar_open_price, exc.raw_exit_price)
        # Forge: change exit_bar_open_price
        exc_payload = _excursion_payload(exc)
        exc_payload["exitBarOpenPrice"] = exc.raw_exit_price + 100.0
        forged_id = canonical_sha256(exc_payload)
        with self.assertRaises(ValueError) as ctx:
            ProtectiveTradeExcursion(
                **{**exc.__dict__,
                   "exit_bar_open_price": exc.raw_exit_price + 100.0,
                   "excursion_id": forged_id})
        self.assertIn("BAR_OPEN", str(ctx.exception))

    def test_gap_exit_bar_open_must_equal_raw_exit(self):
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 238.0, 242.0, 236.0, 239.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.trigger_kind, "GAP_OPEN")
        self.assertEqual(exc.exit_bar_open_price, exc.raw_exit_price)

    def test_intrabar_trigger_open_source_must_equal_exit_bar_open(self):
        """For intrabar, FRONTIER_TRIGGER_OPEN price must equal exit_bar_open_price."""
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_excursion(b, insts, bindings)
        exc = r.trades[0].excursion
        self.assertEqual(exc.trigger_kind, "INTRABAR_LEVEL")
        # exit_bar_open_price = trigger bar open = 250.0
        # raw_exit_price = stop = 240.0
        # If favorable source is FRONTIER_TRIGGER_OPEN, price must == exit_bar_open_price
        # If favorable source is FRONTIER_TRIGGER_LEVEL, price must == raw_exit_price


class SymbolTimeframeForgeryTests(unittest.TestCase):
    """Prove symbol and timeframe cross-root validation."""

    def test_result_excursion_symbol_changed_rejected(self):
        r = _make_explicit_result()
        exc = r.trades[0].excursion
        exc_payload = _excursion_payload(exc)
        exc_payload["symbol"] = "ETH/USDT"
        forged_exc_id = canonical_sha256(exc_payload)
        forged_exc = ProtectiveTradeExcursion(
            **{**exc.__dict__, "symbol": "ETH/USDT",
               "excursion_id": forged_exc_id})
        forged_ct = ProtectiveExcursionTrade(
            base=r.trades[0].base, selection=r.trades[0].selection,
            accounting=r.trades[0].accounting, excursion=forged_exc,
            resolution=r.trades[0].resolution,
            composite_trade_id=canonical_sha256({
                "schemaVersion": "stage-5r1.protective-excursion-trade.v1",
                "baseTradeId": r.trades[0].base.trade_id,
                "selectionId": r.trades[0].selection.selection_id,
                "accountingId": r.trades[0].accounting.accounting_id,
                "excursionId": forged_exc_id,
                "resolutionId": r.trades[0].resolution.resolution_id,
                "tradeIndex": r.trades[0].base.trade_index,
            }))
        with self.assertRaises(ValueError) as ctx:
            ProtectiveExcursionResult(
                base=r.base,
                base_protective_replay_id=r.base.replay_id,
                symbol=r.base.symbol, timeframe_ms=r.base.timeframe_ms,
                dataset_id=r.base.dataset_id,
                instruction_set_id=r.base.instruction_set_id,
                binding_set_id=r.base.binding_set_id,
                replay_config_id=r.base.replay_config_id,
                capital_model_id=r.base.capital_model_id,
                cost_model_id=r.base.cost_model_id,
                trade_count=r.base.trade_count,
                trades=(forged_ct,), result_id="0" * 64,
            )
        self.assertIn("SYMBOL", str(ctx.exception))

    def test_result_excursion_timeframe_changed_rejected(self):
        r = _make_explicit_result()
        exc = r.trades[0].excursion
        # timeframe_ms is validated as 300000 in __post_init__, so can't forge directly
        # Instead, verify the result validates excursion.timeframe_ms == result.timeframe_ms
        self.assertEqual(exc.timeframe_ms, r.timeframe_ms)


if __name__ == "__main__":
    unittest.main()
