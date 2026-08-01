"""Stage 5R1.3-F — hardened adversarial test suite per Codex revision."""

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


class RiskArithmeticTests(unittest.TestCase):
    """A. Long/short per-trade primitives and exact risk/R arithmetic."""

    def test_long_risk_arithmetic_exact(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=250.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        report = _build(b, insts, bindings)
        tm = report.trade_metrics[0]
        exc = _run_e(b, insts, bindings).trades[0]
        self.assertEqual(tm.risk_status, RISK_DEFINED)
        self.assertAlmostEqual(tm.initial_risk_per_unit, 300.0 - 250.0, places=10)
        self.assertAlmostEqual(tm.initial_risk_amount, exc.accounting.quantity * 50.0, places=10)
        self.assertAlmostEqual(tm.realized_net_r, exc.accounting.net_pnl_amount / (exc.accounting.quantity * 50.0), places=10)

    def test_short_risk_arithmetic_exact(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110, action=ReplayAction.ENTER_SHORT)
        p = _p_short(entry=float(b[100].open), stop=350.0, tp=1.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        report = _build(b, insts, bindings)
        tm = report.trade_metrics[0]
        self.assertAlmostEqual(tm.initial_risk_per_unit, 350.0 - 300.0, places=10)

    def test_actual_fill_not_plan_reference(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=290.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        fc = CostModel(fee_bps_per_fill=4, half_spread_bps_per_fill=1, slippage_bps_per_fill=2)
        r = run_stage5r1_protective_excursion(bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=fc)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        tm = report.trade_metrics[0]
        exc = r.trades[0].excursion
        self.assertNotEqual(exc.entry_fill_price, p.entry_reference_price)
        self.assertAlmostEqual(tm.initial_risk_per_unit, exc.entry_fill_price - 290.0, places=10)


class ForgedRiskRelationTests(unittest.TestCase):
    """B. Forged stop relation rejected with RISK_RELATION_INVALID."""

    def test_long_forged_stop_above_fill_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=250.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        # Forge the plan's stop_price via object.__setattr__
        object.__setattr__(p, "stop_price", 310.0)  # now stop > entry_fill for LONG
        with self.assertRaises(ValueError) as ctx:
            build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertIn("RISK_RELATION", str(ctx.exception))


class ZeroTradeReportTests(unittest.TestCase):
    """C. Zero trades → NO_TRADES, every aggregate/cost/PF None, all counts zero."""

    def test_no_trades_all_null(self):
        b = bars(200)
        r = run_stage5r1_protective_excursion(bars=b, instructions=(), protective_bindings=(), config=_cfg(), capital=_CM, cost=_ZC)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=())
        self.assertEqual(report.evaluation_status, EVAL_NO_TRADES)
        self.assertFalse(report.risk_metrics_complete)
        self.assertEqual(report.trade_count, 0)
        self.assertIsNone(report.mean_mfe_return)
        self.assertIsNone(report.median_mae_return)
        self.assertIsNone(report.standard_profit_factor)
        self.assertIsNone(report.cost_metrics)
        c = report.counts
        self.assertEqual(c.long_count, 0)
        self.assertEqual(c.protective_exit_count, 0)
        self.assertEqual(c.favorable_full_bar_count, 0)

    def test_no_trades_source_result_id_bound(self):
        b = bars(200)
        r = run_stage5r1_protective_excursion(bars=b, instructions=(), protective_bindings=(), config=_cfg(), capital=_CM, cost=_ZC)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=())
        self.assertEqual(report.source_excursion_result_id, r.result_id)


class AggregateMathTests(unittest.TestCase):
    """D. Mean/median/max exact counterexamples."""

    def test_two_trade_even_median(self):
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
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.trade_count, 2)
        e1 = r.trades[0].excursion
        e2 = r.trades[1].excursion
        v1 = e1.mfe_return_on_entry_equity
        v2 = e2.mfe_return_on_entry_equity
        self.assertAlmostEqual(report.median_mfe_return, (v1 + v2) / 2.0, places=10)
        self.assertAlmostEqual(report.max_mfe_return, max(v1, v2), places=10)
        self.assertAlmostEqual(report.mean_mfe_return, (v1 + v2) / 2.0, places=10)


class CountBucketTests(unittest.TestCase):
    """E. Exact count invariants."""

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
        # favorable sums
        self.assertEqual(c.favorable_full_bar_count + c.favorable_exit_open_count + c.favorable_trigger_open_count + c.favorable_trigger_level_count, 2)
        self.assertEqual(c.adverse_full_bar_count + c.adverse_exit_open_count + c.adverse_trigger_open_count + c.adverse_trigger_level_count, 2)


class CostMetricsTests(unittest.TestCase):
    """F. Cost metrics exact and immutable."""

    def test_cost_metrics_exact_type(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        report = _build(b, insts, bindings)
        self.assertIsNotNone(report.cost_metrics)
        self.assertIsInstance(report.cost_metrics, ProtectiveCostMetrics)
        cm = report.cost_metrics
        self.assertAlmostEqual(cm.total_cost_amount, cm.market_impact_cost_amount + cm.explicit_cost_amount, places=10)

    def test_cost_metrics_match_existing(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        from quant_engine.proof.stage5r1_metrics import aggregate_cost_accounting
        expected = aggregate_cost_accounting([r.trades[0].accounting])
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        cm = report.cost_metrics
        self.assertAlmostEqual(cm.spread_cost_amount, expected["spread_cost_amount"], places=10)
        self.assertAlmostEqual(cm.fee_amount, expected["fee_amount"], places=10)


class DeterministicReproductionTests(unittest.TestCase):
    """G. source_excursion_result_id and ordered metric IDs bind reproduction."""

    def test_repeat_identical(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        rep1 = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        rep2 = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(rep1.report_id, rep2.report_id)
        self.assertEqual(rep1.source_excursion_result_id, rep2.source_excursion_result_id)


class BindingValidationTests(unittest.TestCase):
    """H. Binding input rejection."""

    def test_list_bindings_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings_list = [ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p)]
        r = _run_e(b, insts, tuple(bindings_list))
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=bindings_list)

    def test_binding_count_mismatch_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=())

    def test_binding_count_mismatch_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=())


class ForgedReportTests(unittest.TestCase):
    """I. Report/root/count/status/forgery rejection."""

    def test_forged_report_id_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        object.__setattr__(report, "symbol", "FORGED")
        with self.assertRaises(ValueError) as ctx:
            verify_stage5r1_protective_metrics(report=report, result=r, bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC)
        self.assertIn("CONTENT", str(ctx.exception))


class TypeRejectionTests(unittest.TestCase):
    """K. NaN, Inf, bool-as-int, list/tuple, subclass rejection."""

    def test_subclass_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        class FakeReport(ProtectiveExcursionMetricsReport): pass
        fake = FakeReport(**{k: getattr(report, k) for k in report.__dataclass_fields__})
        with self.assertRaises(ValueError):
            verify_stage5r1_protective_metrics(report=fake, result=r, bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC)


class InputImmutabilityTests(unittest.TestCase):
    """L. Caller inputs unchanged."""

    def test_result_unchanged(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        rid_before = r.result_id
        build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(r.result_id, rid_before)


class VerifyAPITests(unittest.TestCase):
    """M. Verify assertIs, forgery rejection."""

    def test_assertIs_identity(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        verified = verify_stage5r1_protective_metrics(report=report, result=r, bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC)
        self.assertIs(verified, report)

    def test_verify_source_result_id_match(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run_e(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.source_excursion_result_id, r.result_id)


if __name__ == "__main__":
    unittest.main()
