"""Stage 5R1.3-F — hardened adversarial test suite (expanded red-gate)."""

import math
import unittest

from quant_engine.proof.stage5r1_replay import (
    ReplayAction, ReplayBar, ReplayConfig, ReplayInstruction,
)
from quant_engine.proof.stage5r1_capital import (
    CapitalModel, CostModel, PositionSide,
)
from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitPlan
from quant_engine.proof.stage5r1_protective_replay import (
    ProtectiveReplayBinding,
)
from quant_engine.proof.stage5r1_protective_excursion import (
    run_stage5r1_protective_excursion,
    _excursion_payload,
)
from quant_engine.proof.stage5r1_protective_metrics import (
    build_stage5r1_protective_metrics,
    verify_stage5r1_protective_metrics,
    ProtectiveTradeRiskMetrics,
    ProtectiveExcursionMetricCounts,
    ProtectiveExcursionMetricsReport,
    ProtectiveCostMetrics,
    RISK_DEFINED, EVAL_NO_TRADES, EVAL_MEASURED,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

FROZEN_TIMEFRAME_MS = 300_000


def bar(ms, o, h, l, c, v=100.0):
    return ReplayBar(open_time_ms=ms, open=float(o), high=float(h), low=float(l), close=float(c), volume=v)


def bars(n, start_ms=0, base=200.0):
    return tuple(bar(start_ms + i * FROZEN_TIMEFRAME_MS, base + i, base + i + 1, base + i - 1, base + i + 0.5) for i in range(n))


_CM = CapitalModel(initial_equity=10000.0)
_ZC = CostModel(fee_bps_per_fill=0, half_spread_bps_per_fill=0, slippage_bps_per_fill=0, funding_bps_per_8h_adverse=0)


def _p_long(entry=None, stop=290.0, tp=310.0):
    return ProtectiveExitPlan(side=PositionSide.LONG, entry_reference_price=entry or 300.0, stop_price=stop, take_profit_price=tp)


def _p_short(entry=None, stop=310.0, tp=290.0):
    return ProtectiveExitPlan(side=PositionSide.SHORT, entry_reference_price=entry or 300.0, stop_price=stop, take_profit_price=tp)


def _cfg(symbol="BTC/USDT"):
    return ReplayConfig(symbol=symbol)


def _insts(b, entry_sig=99, exit_sig=110, action=ReplayAction.ENTER_LONG):
    return (ReplayInstruction(signal_bar_open_time_ms=b[entry_sig].open_time_ms, action=action),
            ReplayInstruction(signal_bar_open_time_ms=b[exit_sig].open_time_ms, action=ReplayAction.EXIT))


def _run_e(b, insts, bindings=None, cfg=None, capital=None, cost=None):
    if cfg is None: cfg = _cfg()
    if capital is None: capital = _CM
    if cost is None: cost = _ZC
    if bindings is None:
        p = _p_long()
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
    return run_stage5r1_protective_excursion(bars=b, instructions=insts, protective_bindings=bindings, config=cfg, capital=capital, cost=cost)


def _build(b, insts, bindings):
    r = _run_e(b, insts, bindings)
    return build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)


def _one_trade_setup(stop=1.0):
    b = bars(200)
    insts = _insts(b, entry_sig=99, exit_sig=110)
    p = _p_long(entry=float(b[100].open), stop=stop, tp=9999.0)
    bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
    r = _run_e(b, insts, bindings)
    return b, insts, p, bindings, r


def _two_trade_setup():
    b = list(bars(300))
    b = tuple(b)
    insts = (
        ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
        ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.EXIT),
        ReplayInstruction(signal_bar_open_time_ms=b[199].open_time_ms, action=ReplayAction.ENTER_LONG),
        ReplayInstruction(signal_bar_open_time_ms=b[250].open_time_ms, action=ReplayAction.EXIT),
    )
    p1 = _p_long(entry=float(b[100].open), stop=290.0, tp=9999.0)
    p2 = _p_long(entry=float(b[200].open), stop=390.0, tp=9999.0)
    bindings = (
        ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p1),
        ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[199].open_time_ms, plan=p2),
    )
    r = _run_e(b, insts, bindings)
    return b, insts, bindings, r


# ==========================================================================
# A. Risk arithmetic (existing, retained)
# ==========================================================================

class RiskArithmeticTests(unittest.TestCase):
    def test_long_risk_arithmetic_exact(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=250.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        tm = report.trade_metrics[0]
        self.assertEqual(tm.risk_status, RISK_DEFINED)
        self.assertAlmostEqual(tm.initial_risk_per_unit, 300.0 - 250.0, places=10)

    def test_short_risk_arithmetic_exact(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110, action=ReplayAction.ENTER_SHORT)
        p = _p_short(entry=float(b[100].open), stop=350.0, tp=1.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        report = _build(b, insts, bindings)
        tm = report.trade_metrics[0]
        self.assertAlmostEqual(tm.initial_risk_per_unit, 350.0 - 300.0, places=10)

    def test_actual_fill_not_plan_reference(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=290.0)
        fc = CostModel(fee_bps_per_fill=4, half_spread_bps_per_fill=1, slippage_bps_per_fill=2)
        r2 = run_stage5r1_protective_excursion(bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=fc)
        report = build_stage5r1_protective_metrics(result=r2, protective_bindings=bindings)
        tm = report.trade_metrics[0]
        exc = r2.trades[0].excursion
        self.assertNotEqual(exc.entry_fill_price, p.entry_reference_price)
        self.assertAlmostEqual(tm.initial_risk_per_unit, exc.entry_fill_price - 290.0, places=10)


# ==========================================================================
# B. Forged risk relation (existing)
# ==========================================================================

class ForgedRiskRelationTests(unittest.TestCase):
    def test_long_forged_stop_above_fill_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=250.0)
        object.__setattr__(p, "stop_price", 310.0)
        with self.assertRaises(ValueError) as ctx:
            build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertIn("RECONSTRUCTION", str(ctx.exception))


# ==========================================================================
# C. Zero trades (existing, expanded)
# ==========================================================================

class ZeroTradeReportTests(unittest.TestCase):
    def test_no_trades_all_18_counts_zero(self):
        b = bars(200)
        r = run_stage5r1_protective_excursion(bars=b, instructions=(), protective_bindings=(), config=_cfg(), capital=_CM, cost=_ZC)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=())
        c = report.counts
        for name in c.__dataclass_fields__:
            self.assertEqual(getattr(c, name), 0, f"counts.{name} should be 0")
        self.assertEqual(report.evaluation_status, EVAL_NO_TRADES)
        self.assertFalse(report.risk_metrics_complete)
        self.assertIsNone(report.standard_profit_factor)
        self.assertIsNone(report.return_profit_factor)
        self.assertIsNone(report.cost_metrics)

    def test_no_trades_all_18_aggregates_none(self):
        b = bars(200)
        r = run_stage5r1_protective_excursion(bars=b, instructions=(), protective_bindings=(), config=_cfg(), capital=_CM, cost=_ZC)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=())
        agg_names = ["mean_mfe_return", "median_mfe_return", "max_mfe_return",
                     "mean_mae_return", "median_mae_return", "max_mae_return",
                     "mean_holding_bars", "median_holding_bars", "max_holding_bars",
                     "mean_realized_net_r", "median_realized_net_r",
                     "mean_mfe_r", "median_mfe_r", "max_mfe_r",
                     "mean_mae_r", "median_mae_r", "max_mae_r"]
        for name in agg_names:
            self.assertIsNone(getattr(report, name), f"report.{name} should be None")
        self.assertIsNone(report.return_profit_factor)

    def test_no_trades_source_result_id_bound(self):
        b = bars(200)
        r = run_stage5r1_protective_excursion(bars=b, instructions=(), protective_bindings=(), config=_cfg(), capital=_CM, cost=_ZC)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=())


# ==========================================================================
# D. Aggregate math (existing, expanded)
# ==========================================================================

class AggregateMathTests(unittest.TestCase):
    def test_two_trade_even_median(self):
        b, insts, bindings, r = _two_trade_setup()
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.trade_count, 2)
        e1, e2 = r.trades[0].excursion, r.trades[1].excursion
        v1, v2 = e1.mfe_return_on_entry_equity, e2.mfe_return_on_entry_equity
        self.assertAlmostEqual(report.median_mfe_return, (v1 + v2) / 2.0, places=10)

    def test_two_trade_all_aggregates_manual(self):
        b, insts, bindings, r = _two_trade_setup()
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        e1, e2 = r.trades[0].excursion, r.trades[1].excursion
        mfe = [e1.mfe_return_on_entry_equity, e2.mfe_return_on_entry_equity]
        mae = [e1.mae_return_on_entry_equity, e2.mae_return_on_entry_equity]
        hb = [float(e1.full_pre_exit_bar_count), float(e2.full_pre_exit_bar_count)]
        self.assertAlmostEqual(report.mean_mfe_return, sum(mfe)/2, places=10)
        self.assertAlmostEqual(report.median_mae_return, (mae[0]+mae[1])/2, places=10)
        self.assertAlmostEqual(report.max_holding_bars, max(hb), places=10)


# ==========================================================================
# E. Count buckets (existing, expanded)
# ==========================================================================

class CountBucketTests(unittest.TestCase):
    def test_count_invariants(self):
        b = list(bars(300))
        b[105] = bar(b[105].open_time_ms, 350.0, 362.0, 347.0, 351.0)
        b[205] = bar(b[205].open_time_ms, 250.0, 255.0, 239.0, 251.0)
        b = tuple(b)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_SHORT),
            ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.EXIT),
            ReplayInstruction(signal_bar_open_time_ms=b[199].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[250].open_time_ms, action=ReplayAction.EXIT),
        )
        p1 = _p_short(entry=float(b[100].open), stop=360.0, tp=280.0)
        p2 = _p_long(entry=float(b[200].open), stop=390.0, tp=410.0)
        bindings = (
            ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p1),
            ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[199].open_time_ms, plan=p2),
        )
        report = _build(b, insts, bindings)
        c = report.counts
        self.assertEqual(c.long_count + c.short_count, 2)
        self.assertEqual(c.explicit_exit_count + c.protective_exit_count, 2)
        fav = (c.favorable_full_bar_count + c.favorable_exit_open_count +
               c.favorable_trigger_open_count + c.favorable_trigger_level_count)
        self.assertEqual(fav, 2)

    def test_count_buckets_exact_explicit(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.counts.explicit_exit_count, 1)
        self.assertEqual(report.counts.protective_exit_count, 0)

    def test_count_buckets_protective_gap_stop(self):
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 238.0, 242.0, 236.0, 239.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=240.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.counts.protective_exit_count, 1)
        self.assertEqual(report.counts.gap_open_count, 1)
        self.assertEqual(report.counts.stop_loss_count, 1)

    def test_count_buckets_protective_intrabar_target(self):
        b = list(bars(200))
        b[105] = bar(b[105].open_time_ms, 305.0, 312.0, 303.0, 306.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=250.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.counts.take_profit_count, 1)
        self.assertEqual(report.counts.intrabar_level_count, 1)

    def test_count_buckets_same_bar_collision(self):
        b = list(bars(200))
        b[100] = bar(b[100].open_time_ms, 300.0, 312.0, 289.0, 301.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=290.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.counts.same_bar_collision_count, 1)

    def test_count_buckets_zero_duration_entry_bar(self):
        b = list(bars(200))
        b[100] = bar(b[100].open_time_ms, 300.0, 305.0, 289.0, 301.0)
        b = tuple(b)
        insts = _insts(b, entry_sig=99, exit_sig=150)
        p = _p_long(entry=float(b[100].open), stop=290.0, tp=310.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.counts.zero_duration_count, 1)


# ==========================================================================
# F. Cost metrics (existing, expanded)
# ==========================================================================

class CostMetricsTests(unittest.TestCase):
    def test_cost_metrics_exact_type(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertIsNotNone(report.cost_metrics)
        self.assertIsInstance(report.cost_metrics, ProtectiveCostMetrics)

    def test_cost_metrics_match_existing(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        from quant_engine.proof.stage5r1_metrics import aggregate_cost_accounting
        expected = aggregate_cost_accounting([r.trades[0].accounting])
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        cm = report.cost_metrics
        self.assertAlmostEqual(cm.spread_cost_amount, expected["spread_cost_amount"], places=10)
        self.assertAlmostEqual(cm.fee_amount, expected["fee_amount"], places=10)

    def test_cost_metrics_all_13_fields_equal(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        from quant_engine.proof.stage5r1_metrics import aggregate_cost_accounting
        expected = aggregate_cost_accounting([r.trades[0].accounting])
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        cm = report.cost_metrics
        fields = ["spread_cost_amount", "slippage_cost_amount", "market_impact_cost_amount",
                  "fee_amount", "funding_amount", "explicit_cost_amount", "total_cost_amount",
                  "cost_as_initial_equity_fraction", "cost_as_average_entry_equity_fraction",
                  "fee_rate_disclosure_sum", "spread_rate_disclosure_sum",
                  "slippage_rate_disclosure_sum", "funding_rate_disclosure_sum"]
        for f in fields:
            self.assertAlmostEqual(getattr(cm, f), expected[f], places=10, msg=f"field {f} mismatch")

    def test_cost_metrics_frozen_rejects_assignment(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        cm = report.cost_metrics
        with self.assertRaises(Exception):
            cm.spread_cost_amount = 999.0


# ==========================================================================
# G. Deterministic reproduction (existing, expanded)
# ==========================================================================

class DeterministicReproductionTests(unittest.TestCase):
    def test_repeat_identical(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        rep1 = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        rep2 = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(rep1.report_id, rep2.report_id)

    def test_ordered_metric_ids_and_source_result_id_exact(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.source_excursion_result_id, r.result_id)
        self.assertEqual(len(report.trade_metrics), 1)
        self.assertEqual(report.trade_metrics[0].composite_trade_id, r.trades[0].composite_trade_id)


# ==========================================================================
# H. Binding validation (expanded)
# ==========================================================================

class BindingValidationTests(unittest.TestCase):
    def test_list_bindings_rejected(self):
        b, insts, p, correct_bindings, r = _one_trade_setup(stop=1.0)
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=list(correct_bindings))

    def test_binding_count_mismatch_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=())

    def test_duplicate_binding_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        bd = bindings[0]
        with self.assertRaises(ValueError) as ctx:
            build_stage5r1_protective_metrics(result=r, protective_bindings=(bd, bd))
        self.assertIn("DUPLICATE", str(ctx.exception))

    def test_missing_binding_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        wrong = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[50].open_time_ms, plan=_p_long(stop=1.0)),)
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=wrong)

    def test_extra_binding_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        extra = (bindings[0], ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[50].open_time_ms, plan=_p_long(stop=1.0)))
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=extra)

    def test_shuffled_bindings_rejected(self):
        b, insts, bindings, r = _two_trade_setup()
        shuffled = (bindings[1], bindings[0])
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=shuffled)

    def test_binding_id_mutated_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        object.__setattr__(bindings[0], "binding_id", "0" * 64)
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)

    def test_plan_side_mutated_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=250.0)
        object.__setattr__(p, "side", PositionSide.SHORT)
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)

    def test_plan_stop_mutated_identity_forgery_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=250.0)
        object.__setattr__(p, "stop_price", 240.0)  # still valid long (240 < 300)
        with self.assertRaises(ValueError) as ctx:
            build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertIn("IDENTITY", str(ctx.exception))


# ==========================================================================
# I. Report forgery (expanded)
# ==========================================================================

class ForgedReportTests(unittest.TestCase):
    def test_forged_report_id_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        object.__setattr__(report, "symbol", "FORGED")
        with self.assertRaises(ValueError) as ctx:
            verify_stage5r1_protective_metrics(report=report, result=r, bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC)
        self.assertIn("CONTENT", str(ctx.exception))


# ==========================================================================
# K. Type rejection (expanded)
# ==========================================================================

class TypeRejectionTests(unittest.TestCase):
    def test_subclass_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        class FakeReport(ProtectiveExcursionMetricsReport): pass
        fake = FakeReport(**{k: getattr(report, k) for k in report.__dataclass_fields__})
        with self.assertRaises(ValueError):
            verify_stage5r1_protective_metrics(report=fake, result=r, bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC)

    def test_count_subclass_rejected(self):
        counts = ProtectiveExcursionMetricCounts(long_count=1, short_count=0, explicit_exit_count=1,
            protective_exit_count=0, stop_loss_count=0, take_profit_count=0, gap_open_count=0,
            intrabar_level_count=0, same_bar_collision_count=0, zero_duration_count=0,
            favorable_full_bar_count=1, favorable_exit_open_count=0, favorable_trigger_open_count=0,
            favorable_trigger_level_count=0, adverse_full_bar_count=1, adverse_exit_open_count=0,
            adverse_trigger_open_count=0, adverse_trigger_level_count=0)
        class FakeCounts(ProtectiveExcursionMetricCounts): pass
        fake = FakeCounts(**{k: getattr(counts, k) for k in counts.__dataclass_fields__})
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        with self.assertRaises(ValueError):
            ProtectiveExcursionMetricsReport(**{**{k: getattr(report, k) for k in report.__dataclass_fields__}, "counts": fake, "report_id": "0"*64})

    def test_trade_metrics_list_rejected(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        with self.assertRaises(ValueError):
            ProtectiveExcursionMetricsReport(**{**{k: getattr(report, k) for k in report.__dataclass_fields__}, "trade_metrics": list(report.trade_metrics), "report_id": "0"*64})


# ==========================================================================
# L. Input immutability (expanded)
# ==========================================================================

class InputImmutabilityTests(unittest.TestCase):
    def test_result_unchanged(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        rid_before = r.result_id
        build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(r.result_id, rid_before)

    def test_bindings_unchanged(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        bid_before = bindings[0].binding_id
        build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(bindings[0].binding_id, bid_before)


# ==========================================================================
# M. Verify API (expanded)
# ==========================================================================

class VerifyAPITests(unittest.TestCase):
    def test_assertIs_identity(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        verified = verify_stage5r1_protective_metrics(report=report, result=r, bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC)
        self.assertIs(verified, report)

    def test_verify_source_result_id_match(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.source_excursion_result_id, r.result_id)


# ==========================================================================
# N. Additional adversarial tests (requirements 7-35)
# ==========================================================================

class BuildGraphRevalidationTests(unittest.TestCase):
    def test_build_rejects_result_symbol_forgery(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        object.__setattr__(r, "symbol", "FORGED")
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)

    def test_build_rejects_nested_excursion_content_forgery(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        exc = r.trades[0].excursion
        object.__setattr__(exc, "symbol", "FORGED")
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)


class VerifyEdgeCaseTests(unittest.TestCase):
    def test_verify_rejects_changed_bars(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        b2 = list(bars(200))
        b2[150] = bar(b2[150].open_time_ms, 999.0, 999.0, 999.0, 999.0)
        b2 = tuple(b2)
        with self.assertRaises(ValueError):
            verify_stage5r1_protective_metrics(report=report, result=r, bars=b2, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC)

    def test_verify_rejects_changed_report_id(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        object.__setattr__(report, "report_id", "0" * 64)
        with self.assertRaises(ValueError):
            verify_stage5r1_protective_metrics(report=report, result=r, bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC)

    def test_verify_rejects_stage_e_input_forgery(self):
        b, insts, p, bindings, r = _one_trade_setup(stop=1.0)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        object.__setattr__(r, "symbol", "FORGED")
        with self.assertRaises(ValueError):
            verify_stage5r1_protective_metrics(report=report, result=r, bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC)


if __name__ == "__main__":
    unittest.main()
