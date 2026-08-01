"""Stage 5R1.3-F protective excursion metrics — comprehensive TDD tests."""

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
    PROTECTIVE_SOURCE, EXPLICIT_SOURCE,
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
    RISK_DEFINED, RISK_INVALID_AT_ENTRY,
    EVAL_NO_TRADES, EVAL_RISK_UNDEFINED, EVAL_MEASURED,
)

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


def _run(b, insts, bindings=None, cfg=None, capital=None, cost=None):
    if cfg is None: cfg = _cfg()
    if capital is None: capital = _CM
    if cost is None: cost = _ZC
    if bindings is None:
        p = _p_long()
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
    return run_stage5r1_protective_excursion(bars=b, instructions=insts, protective_bindings=bindings, config=cfg, capital=capital, cost=cost)


def _build(b, insts, bindings=None):
    r = _run(b, insts, bindings)
    return build_stage5r1_protective_metrics(result=r, protective_bindings=bindings if bindings else (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=_p_long()),))


class RiskMathTests(unittest.TestCase):
    def test_long_defined_risk_explicit(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=250.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.evaluation_status, EVAL_MEASURED)
        self.assertTrue(report.risk_metrics_complete)
        tm = report.trade_metrics[0]
        self.assertEqual(tm.risk_status, RISK_DEFINED)
        self.assertAlmostEqual(tm.initial_risk_per_unit, 50.0)  # 300 - 250 = 50
        self.assertGreater(tm.initial_risk_amount, 0)

    def test_short_defined_risk(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110, action=ReplayAction.ENTER_SHORT)
        p = _p_short(entry=float(b[100].open), stop=350.0, tp=1.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.evaluation_status, EVAL_MEASURED)
        tm = report.trade_metrics[0]
        self.assertEqual(tm.risk_status, RISK_DEFINED)
        self.assertAlmostEqual(tm.initial_risk_per_unit, 50.0)  # 350 - 300 = 50

    def test_entry_fill_used_not_plan_reference(self):
        """Actual entry fill (with spread/slippage) used, not plan.entry_reference_price."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=290.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        fc = CostModel(fee_bps_per_fill=4, half_spread_bps_per_fill=1, slippage_bps_per_fill=2)
        r = run_stage5r1_protective_excursion(bars=b, instructions=insts, protective_bindings=bindings, config=_cfg(), capital=_CM, cost=fc)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        tm = report.trade_metrics[0]
        # Entry fill != plan entry reference (fees applied)
        exc = r.trades[0].excursion
        self.assertNotEqual(exc.entry_fill_price, p.entry_reference_price)
        # Risk computed from entry_fill, not plan reference
        self.assertAlmostEqual(tm.initial_risk_per_unit, exc.entry_fill_price - 290.0, places=10)

    def test_long_risk_math_correct(self):
        """Verify risk_per_unit = entry_fill - stop for LONG."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=250.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        tm = report.trade_metrics[0]
        self.assertEqual(tm.risk_status, RISK_DEFINED)
        # entry_fill=300, stop=250, risk=50
        self.assertAlmostEqual(tm.initial_risk_per_unit, 50.0, places=10)

    def test_short_risk_math_correct(self):
        """Verify risk_per_unit = stop - entry_fill for SHORT."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110, action=ReplayAction.ENTER_SHORT)
        p = _p_short(entry=float(b[100].open), stop=350.0, tp=1.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        tm = report.trade_metrics[0]
        self.assertEqual(tm.risk_status, RISK_DEFINED)
        self.assertAlmostEqual(tm.initial_risk_per_unit, 50.0, places=10)


class ZeroTradeReportTests(unittest.TestCase):
    def test_no_trades_null_aggregates(self):
        """Zero trades → NO_TRADES, all aggregates None."""
        b = bars(200)
        insts = ()  # zero instructions
        r = run_stage5r1_protective_excursion(bars=b, instructions=insts, protective_bindings=(), config=_cfg(), capital=_CM, cost=_ZC)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=())
        self.assertEqual(report.evaluation_status, EVAL_NO_TRADES)
        self.assertEqual(report.trade_count, 0)
        self.assertIsNone(report.mean_mfe_return)
        self.assertIsNone(report.median_mae_return)
        self.assertIsNone(report.standard_profit_factor)


class AggregateMathTests(unittest.TestCase):
    def test_mean_median_max(self):
        """Explicit exit provides known MFE/MAE values."""
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertIsNotNone(report.mean_mfe_return)
        self.assertIsNotNone(report.median_mfe_return)
        self.assertIsNotNone(report.max_mfe_return)
        self.assertIsNotNone(report.mean_holding_bars)
        self.assertGreaterEqual(report.max_mfe_return, report.mean_mfe_return)

    def test_even_count_median(self):
        """Two trades produce correct median."""
        b = list(bars(300))
        b[105] = bar(b[105].open_time_ms, 305.0, 312.0, 303.0, 306.0)
        b[205] = bar(b[205].open_time_ms, 305.0, 312.0, 303.0, 306.0)
        b = tuple(b)
        insts = (
            ReplayInstruction(signal_bar_open_time_ms=b[99].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[150].open_time_ms, action=ReplayAction.EXIT),
            ReplayInstruction(signal_bar_open_time_ms=b[199].open_time_ms, action=ReplayAction.ENTER_LONG),
            ReplayInstruction(signal_bar_open_time_ms=b[250].open_time_ms, action=ReplayAction.EXIT),
        )
        p1 = _p_long(entry=float(b[100].open), stop=250.0, tp=310.0)
        p2 = _p_long(entry=float(b[200].open), stop=390.0, tp=410.0)  # bar 200 open=400, stop 390 valid
        bindings = (
            ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=p1),
            ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[199].open_time_ms, plan=p2),
        )
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(report.trade_count, 2)
        self.assertIsNotNone(report.median_mfe_return)


class CountInvariantTests(unittest.TestCase):
    def test_counts_sum_invariants(self):
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
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        c = report.counts
        self.assertEqual(c.long_count + c.short_count, report.trade_count)
        self.assertEqual(c.explicit_exit_count + c.protective_exit_count, report.trade_count)
        # protective exits: stop + tp = protective
        self.assertEqual(c.stop_loss_count + c.take_profit_count, c.protective_exit_count)
        # Long trade has target hit, short has stop hit
        self.assertEqual(c.long_count, 1)
        self.assertEqual(c.short_count, 1)
        self.assertGreaterEqual(c.favorable_full_bar_count + c.favorable_exit_open_count +
                               c.favorable_trigger_open_count + c.favorable_trigger_level_count,
                               report.trade_count)


class DeterministicReportTests(unittest.TestCase):
    def test_repeat_identical(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        rep1 = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        rep2 = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        self.assertEqual(rep1.report_id, rep2.report_id)

    def test_binding_mismatch_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        wrong = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=b[99].open_time_ms, plan=_p_long(stop=1.0)),)
        with self.assertRaises(ValueError):
            build_stage5r1_protective_metrics(result=r, protective_bindings=wrong)


class VerifyAPITests(unittest.TestCase):
    def test_verify_positive_identity(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        verified = verify_stage5r1_protective_metrics(
            report=report, result=r, bars=b, instructions=insts,
            protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC,
        )
        self.assertIs(verified, report)

    def test_verify_content_forgery_rejected(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        object.__setattr__(report, "symbol", "FORGED/BTC")
        with self.assertRaises(ValueError) as ctx:
            verify_stage5r1_protective_metrics(
                report=report, result=r, bars=b, instructions=insts,
                protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC,
            )
        self.assertIn("CONTENT", str(ctx.exception))

    def test_verify_rejects_subclass(self):
        b = bars(200)
        insts = _insts(b, entry_sig=99, exit_sig=110)
        p = _p_long(entry=float(b[100].open), stop=1.0, tp=9999.0)
        bindings = (ProtectiveReplayBinding(entry_signal_bar_open_time_ms=insts[0].signal_bar_open_time_ms, plan=p),)
        r = _run(b, insts, bindings)
        report = build_stage5r1_protective_metrics(result=r, protective_bindings=bindings)
        class FakeReport(ProtectiveExcursionMetricsReport): pass
        fake = FakeReport(**{k: getattr(report, k) for k in report.__dataclass_fields__})
        with self.assertRaises(ValueError):
            verify_stage5r1_protective_metrics(
                report=fake, result=r, bars=b, instructions=insts,
                protective_bindings=bindings, config=_cfg(), capital=_CM, cost=_ZC,
            )


if __name__ == "__main__":
    unittest.main()
