"""Stage 5R1 metrics contract tests — revised v3."""

from __future__ import annotations

import unittest

from quant_engine.proof.stage5r1_capital import (
    CapitalModel,
    CostModel,
    PositionSide,
    calculate_trade_accounting,
)
from quant_engine.proof.stage5r1_metrics import (
    aggregate_cost_accounting,
    return_profit_factor,
    standard_profit_factor,
)


_CM = CapitalModel(initial_equity=1.0, position_fraction=1.0)
_CM_LARGE = CapitalModel(initial_equity=100.0, position_fraction=1.0)
_COST = CostModel()
_COST_ZERO = CostModel(
    fee_bps_per_fill=0, half_spread_bps_per_fill=0,
    slippage_bps_per_fill=0, funding_bps_per_8h_adverse=0,
)


class ProfitFactorCounterexampleTests(unittest.TestCase):
    def test_counterexample_from_audit(self) -> None:
        t1 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=150.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        t2 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.5,
            raw_entry_price=100.0, raw_exit_price=50.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        sf = standard_profit_factor([t1, t2])
        rf = return_profit_factor([t1, t2])
        self.assertAlmostEqual(sf, 0.5 / 0.75)
        self.assertAlmostEqual(rf, 1.0)

    def test_no_trades(self):
        self.assertEqual(standard_profit_factor([]), 0.0)
        self.assertEqual(return_profit_factor([]), 0.0)

    def test_only_wins(self):
        t = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertEqual(standard_profit_factor([t]), 1_000_000.0)

    def test_only_losses(self):
        t = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=90.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertEqual(standard_profit_factor([t]), 0.0)


class CostAggregationTests(unittest.TestCase):
    def test_cost_aggregation_has_all_fields(self):
        t = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        agg = aggregate_cost_accounting([t])
        required = [
            "spread_cost_amount", "slippage_cost_amount", "market_impact_cost_amount",
            "fee_amount", "funding_amount", "explicit_cost_amount",
            "total_cost_amount",
            "cost_as_initial_equity_fraction", "cost_as_average_entry_equity_fraction",
            "fee_rate_disclosure_sum", "spread_rate_disclosure_sum",
            "slippage_rate_disclosure_sum", "funding_rate_disclosure_sum",
        ]
        for key in required:
            self.assertIn(key, agg, f"Missing key: {key}")

    def test_total_cost_includes_all_components(self):
        t = calculate_trade_accounting(
            side=PositionSide.SHORT, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        agg = aggregate_cost_accounting([t])
        self.assertAlmostEqual(
            agg["total_cost_amount"],
            agg["market_impact_cost_amount"] + agg["explicit_cost_amount"],
        )

    def test_initial_equity_fraction_uses_capital_initial_equity(self):
        """METRICS-01: Cost fraction uses capital initial equity, not first trade's entry equity."""
        cm = CapitalModel(initial_equity=100.0, position_fraction=1.0)
        t = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=50.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=cm, cost=_COST,
        )
        agg = aggregate_cost_accounting([t])
        # use total_cost_amount from t
        expected = t.total_cost_amount / 100.0
        self.assertAlmostEqual(agg["cost_as_initial_equity_fraction"], expected)


class MetricsLineageTests(unittest.TestCase):
    """METRICS-02 through METRICS-04: mixed contracts rejected."""

    def test_mixed_capital_model_rejected(self):
        cm1 = CapitalModel(initial_equity=1.0, position_fraction=1.0)
        cm2 = CapitalModel(initial_equity=1.0, position_fraction=0.5, maximum_position_fraction=1.0)
        t1 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=cm1, cost=_COST,
        )
        t2 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=cm2, cost=_COST,
        )
        with self.assertRaises(ValueError):
            standard_profit_factor([t1, t2])
        with self.assertRaises(ValueError):
            aggregate_cost_accounting([t1, t2])

    def test_mixed_cost_model_rejected(self):
        c1 = CostModel(fee_bps_per_fill=5)
        c2 = CostModel(fee_bps_per_fill=10)
        t1 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=c1,
        )
        t2 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=c2,
        )
        with self.assertRaises(ValueError):
            standard_profit_factor([t1, t2])
        with self.assertRaises(ValueError):
            return_profit_factor([t1, t2])

    def test_mixed_initial_equity_rejected(self):
        cm1 = CapitalModel(initial_equity=1.0, position_fraction=1.0)
        cm2 = CapitalModel(initial_equity=100.0, position_fraction=1.0)
        t1 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=cm1, cost=_COST,
        )
        t2 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=50.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=cm2, cost=_COST,
        )
        with self.assertRaises(ValueError):
            aggregate_cost_accounting([t1, t2])


if __name__ == "__main__":
    unittest.main()
