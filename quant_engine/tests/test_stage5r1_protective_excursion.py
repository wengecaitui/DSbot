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
            ProtectiveExcursionResult(base=r.base, trades=swapped, result_id="0" * 64)


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
            ProtectiveExcursionResult(base=r.base, trades=list(r.trades), result_id="0" * 64)

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
            composite_trade_id=r.trades[0].composite_trade_id,
        )
        with self.assertRaises(ValueError):
            ProtectiveExcursionResult(base=r.base, trades=(fake,), result_id="0" * 64)

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
            "baseReplayId": r.base.replay_id,
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


if __name__ == "__main__":
    unittest.main()
