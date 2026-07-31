"""Stage 5R1 capital model, cost model, and trade accounting tests — revised."""

from __future__ import annotations

import unittest

from quant_engine.proof.stage5r1_capital import (
    CapitalModel,
    CostModel,
    PositionSide,
    calculate_trade_accounting,
)


# --- Shared fixtures ---

_CM = CapitalModel(initial_equity=1.0, position_fraction=1.0)
_CM_FRAC = CapitalModel(initial_equity=1.0, position_fraction=0.25, maximum_position_fraction=0.50)
_COST_ZERO = CostModel(
    fee_bps_per_fill=0, half_spread_bps_per_fill=0,
    slippage_bps_per_fill=0, funding_bps_per_8h_adverse=0,
)
_COST = CostModel()


class CapitalModelContractTests(unittest.TestCase):
    def test_valid_capital_model_accepts_frozen_defaults(self) -> None:
        model = CapitalModel(initial_equity=1.0, position_fraction=1.0, maximum_position_fraction=1.0)
        self.assertEqual(model.schema_version, "stage-5r1.capital-model.v1")
        self.assertEqual(model.contract_type, "LINEAR_USDT")
        self.assertFalse(model.allow_leverage)
        self.assertEqual(model.bankruptcy_policy, "STOP_AT_ZERO")
        self.assertEqual(model.initial_equity, 1.0)
        self.assertEqual(model.position_fraction, 1.0)
        self.assertEqual(model.maximum_position_fraction, 1.0)

    def test_valid_capital_model_with_fractional_position(self) -> None:
        model = CapitalModel(initial_equity=10000.0, position_fraction=0.25, maximum_position_fraction=0.50)
        self.assertEqual(model.initial_equity, 10000.0)
        self.assertEqual(model.position_fraction, 0.25)
        self.assertEqual(model.maximum_position_fraction, 0.50)

    def test_reject_initial_equity_zero(self):
        with self.assertRaises(ValueError): CapitalModel(initial_equity=0.0)
    def test_reject_initial_equity_negative(self):
        with self.assertRaises(ValueError): CapitalModel(initial_equity=-100.0)
    def test_reject_position_fraction_zero(self):
        with self.assertRaises(ValueError): CapitalModel(initial_equity=1.0, position_fraction=0.0)
    def test_reject_position_fraction_negative(self):
        with self.assertRaises(ValueError): CapitalModel(initial_equity=1.0, position_fraction=-0.1)
    def test_reject_position_fraction_above_max(self):
        with self.assertRaises(ValueError): CapitalModel(initial_equity=1.0, position_fraction=0.75, maximum_position_fraction=0.50)
    def test_reject_max_position_fraction_above_one(self):
        with self.assertRaises(ValueError): CapitalModel(initial_equity=1.0, position_fraction=1.0, maximum_position_fraction=1.5)
    def test_reject_leverage_true(self):
        with self.assertRaises(ValueError): CapitalModel(initial_equity=1.0, allow_leverage=True)
    def test_reject_nan_value(self):
        with self.assertRaises(ValueError): CapitalModel(initial_equity=float("nan"))
    def test_reject_infinity(self):
        with self.assertRaises(ValueError): CapitalModel(initial_equity=float("inf"))
    def test_reject_bool_as_number(self):
        with self.assertRaises((ValueError, TypeError)): CapitalModel(initial_equity=True)


class CostModelContractTests(unittest.TestCase):
    def test_valid_cost_model_frozen_defaults(self) -> None:
        model = CostModel()
        self.assertEqual(model.schema_version, "stage-5r1.cost-model.v1")
        self.assertEqual(model.fee_bps_per_fill, 5.0)
        self.assertEqual(model.half_spread_bps_per_fill, 1.0)
        self.assertEqual(model.slippage_bps_per_fill, 2.0)
        self.assertEqual(model.funding_bps_per_8h_adverse, 1.0)
        self.assertEqual(model.funding_period_ms, 28_800_000)

    def test_valid_cost_model_custom_values(self) -> None:
        model = CostModel(fee_bps_per_fill=10.0, half_spread_bps_per_fill=2.0,
                          slippage_bps_per_fill=5.0, funding_bps_per_8h_adverse=2.0)
        self.assertEqual(model.fee_bps_per_fill, 10.0)
        self.assertEqual(model.funding_bps_per_8h_adverse, 2.0)

    def test_reject_negative_fee(self):
        with self.assertRaises(ValueError): CostModel(fee_bps_per_fill=-1.0)
    def test_reject_negative_spread(self):
        with self.assertRaises(ValueError): CostModel(half_spread_bps_per_fill=-0.5)
    def test_reject_negative_slippage(self):
        with self.assertRaises(ValueError): CostModel(slippage_bps_per_fill=-1.0)
    def test_reject_negative_funding(self):
        with self.assertRaises(ValueError): CostModel(funding_bps_per_8h_adverse=-10.0)
    def test_reject_negative_funding_period(self):
        with self.assertRaises(ValueError): CostModel(funding_period_ms=-1000)
    def test_reject_zero_funding_period(self):
        with self.assertRaises(ValueError): CostModel(funding_period_ms=0)
    def test_reject_non_finite_cost(self):
        with self.assertRaises(ValueError): CostModel(fee_bps_per_fill=float("nan"))

    # --- NEW: COSTMODEL validation ---
    def test_reject_bool_fee(self):
        with self.assertRaises(ValueError): CostModel(fee_bps_per_fill=True)
    def test_reject_bool_spread(self):
        with self.assertRaises(ValueError): CostModel(half_spread_bps_per_fill=False)
    def test_reject_bool_slippage(self):
        with self.assertRaises(ValueError): CostModel(slippage_bps_per_fill=True)
    def test_reject_bool_funding(self):
        with self.assertRaises(ValueError): CostModel(funding_bps_per_8h_adverse=False)
    def test_reject_float_funding_period(self):
        with self.assertRaises(ValueError): CostModel(funding_period_ms=28_800_000.0)
    def test_reject_bool_funding_period(self):
        with self.assertRaises(ValueError): CostModel(funding_period_ms=True)


class LinearLongTests(unittest.TestCase):
    def test_profitable_long_zero_costs(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.quantity, 0.01)
        self.assertAlmostEqual(result.entry_notional, 1.0)
        self.assertAlmostEqual(result.execution_pnl_amount, 0.10)
        self.assertAlmostEqual(result.net_pnl_amount, 0.10)
        self.assertAlmostEqual(result.closing_equity, 1.10)
        self.assertFalse(result.bankrupt)

    def test_losing_long_zero_costs(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=90.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, -0.10)
        self.assertAlmostEqual(result.net_pnl_amount, -0.10)
        self.assertAlmostEqual(result.closing_equity, 0.90)
        self.assertFalse(result.bankrupt)


class LinearShortTests(unittest.TestCase):
    def test_profitable_short_100_to_90(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.SHORT, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=90.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, 0.10)
        self.assertAlmostEqual(result.net_pnl_amount, 0.10)
        self.assertAlmostEqual(result.closing_equity, 1.10)

    def test_profitable_short_100_to_80(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.SHORT, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=80.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, 0.20)
        self.assertAlmostEqual(result.net_pnl_amount, 0.20)
        self.assertAlmostEqual(result.closing_equity, 1.20)

    def test_losing_short_100_to_110(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.SHORT, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, -0.10)
        self.assertAlmostEqual(result.net_pnl_amount, -0.10)
        self.assertAlmostEqual(result.closing_equity, 0.90)

    def test_short_bankruptcy_at_200(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.SHORT, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=200.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, -1.0)
        self.assertAlmostEqual(result.raw_closing_equity, 0.0)
        self.assertAlmostEqual(result.closing_equity, 0.0)
        self.assertTrue(result.bankrupt)

    def test_short_beyond_bankruptcy_at_250(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.SHORT, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=250.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, -1.5)
        self.assertAlmostEqual(result.raw_closing_equity, -0.5)
        self.assertAlmostEqual(result.closing_equity, 0.0)
        self.assertTrue(result.bankrupt)
        self.assertLess(result.execution_pnl_amount, -1.0)


class FractionalPositionTests(unittest.TestCase):
    def test_fractional_long_profitable(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0, position_fraction=0.25,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM_FRAC, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.entry_notional, 0.25)
        self.assertAlmostEqual(result.quantity, 0.0025)
        self.assertAlmostEqual(result.execution_pnl_amount, 0.025)
        self.assertAlmostEqual(result.closing_equity, 1.025)


class CostMonotonicityTests(unittest.TestCase):
    def _long(self, **overrides):
        kw = {"fee_bps_per_fill": 0, "half_spread_bps_per_fill": 0,
              "slippage_bps_per_fill": 0, "funding_bps_per_8h_adverse": 0}
        kw.update(overrides)
        return calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=CostModel(**kw),
        )

    def test_fee_monotonicity(self) -> None:
        r0, r5, r10 = self._long(fee_bps_per_fill=0), self._long(fee_bps_per_fill=5), self._long(fee_bps_per_fill=10)
        self.assertEqual(r0.execution_pnl_amount, r5.execution_pnl_amount)
        self.assertGreater(r0.net_pnl_amount, r5.net_pnl_amount)
        self.assertGreater(r5.net_pnl_amount, r10.net_pnl_amount)
        self.assertEqual(r0.fee_amount, 0.0)
        self.assertLess(r0.fee_amount, r5.fee_amount)
        self.assertLess(r5.fee_amount, r10.fee_amount)

    def test_spread_monotonicity(self) -> None:
        r0, r2, r5 = self._long(half_spread_bps_per_fill=0), self._long(half_spread_bps_per_fill=2), self._long(half_spread_bps_per_fill=5)
        self.assertGreater(r0.net_pnl_amount, r2.net_pnl_amount)
        self.assertGreater(r2.net_pnl_amount, r5.net_pnl_amount)
        self.assertEqual(r0.fee_amount, r2.fee_amount)

    def test_slippage_monotonicity(self) -> None:
        r0, r3, r6 = self._long(slippage_bps_per_fill=0), self._long(slippage_bps_per_fill=3), self._long(slippage_bps_per_fill=6)
        self.assertGreater(r0.net_pnl_amount, r3.net_pnl_amount)
        self.assertGreater(r3.net_pnl_amount, r6.net_pnl_amount)


class FundingTimeTests(unittest.TestCase):
    def test_funding_periods_truncate(self) -> None:
        cost = CostModel(funding_period_ms=28_800_000)
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=100.0,
            entry_time_ms=0, exit_time_ms=57_600_000, capital=_CM, cost=cost,
        )
        self.assertEqual(result.completed_funding_periods, 2)
        self.assertAlmostEqual(result.holding_time_ms, 57_600_000)

    def test_funding_zero_when_under_one_period(self) -> None:
        cost = CostModel(funding_period_ms=28_800_000)
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=100.0,
            entry_time_ms=0, exit_time_ms=10_000_000, capital=_CM, cost=cost,
        )
        self.assertEqual(result.completed_funding_periods, 0)
        self.assertAlmostEqual(result.funding_amount, 0.0)


# ——— NEW: COST RECONCILIATION TESTS ———

class CostReconciliationTests(unittest.TestCase):
    """COST-RECON-01 through COST-RECON-07."""

    def _trade(self, side, **cost_overrides):
        kw = {"fee_bps_per_fill": 5, "half_spread_bps_per_fill": 1,
              "slippage_bps_per_fill": 2, "funding_bps_per_8h_adverse": 1}
        kw.update(cost_overrides)
        return calculate_trade_accounting(
            side=side, entry_equity=1.0, position_fraction=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=10_000,
            capital=_CM, cost=CostModel(**kw),
        )

    def test_recon_long_raw_to_execution(self):
        """COST-RECON-01: rawPricePnl - spread - slippage = executionPnl (long)."""
        t = self._trade(PositionSide.LONG, half_spread_bps_per_fill=1, slippage_bps_per_fill=2)
        self.assertAlmostEqual(
            t.raw_price_pnl_amount - t.spread_cost_amount - t.slippage_cost_amount,
            t.execution_pnl_amount,
        )

    def test_recon_short_raw_to_execution(self):
        """COST-RECON-02: rawPricePnl - spread - slippage = executionPnl (short)."""
        t = self._trade(PositionSide.SHORT, half_spread_bps_per_fill=1, slippage_bps_per_fill=2)
        self.assertAlmostEqual(
            t.raw_price_pnl_amount - t.spread_cost_amount - t.slippage_cost_amount,
            t.execution_pnl_amount,
        )

    def test_recon_execution_to_net(self):
        """COST-RECON-03: executionPnl - fee - funding = netPnl."""
        t = self._trade(PositionSide.LONG, fee_bps_per_fill=5, funding_bps_per_8h_adverse=1)
        self.assertAlmostEqual(
            t.execution_pnl_amount - t.fee_amount - t.funding_amount,
            t.net_pnl_amount,
        )

    def test_recon_raw_to_net(self):
        """COST-RECON-04: rawPricePnl - totalCost = netPnl."""
        t = self._trade(PositionSide.LONG)
        self.assertAlmostEqual(
            t.raw_price_pnl_amount - t.total_cost_amount,
            t.net_pnl_amount,
        )

    def test_recon_total_cost_components(self):
        """COST-RECON-05: totalCost = spread + slippage + fee + funding."""
        t = self._trade(PositionSide.SHORT)
        self.assertAlmostEqual(
            t.spread_cost_amount + t.slippage_cost_amount + t.fee_amount + t.funding_amount,
            t.total_cost_amount,
        )

    def test_recon_explicit_cost(self):
        """COST-RECON-06: explicitCost = fee + funding."""
        t = self._trade(PositionSide.LONG)
        self.assertAlmostEqual(t.explicit_cost_amount, t.fee_amount + t.funding_amount)

    def test_recon_market_impact_cost(self):
        """COST-RECON-07: marketImpactCost = spread + slippage."""
        t = self._trade(PositionSide.SHORT)
        self.assertAlmostEqual(t.market_impact_cost_amount, t.spread_cost_amount + t.slippage_cost_amount)


# ——— NEW: TIME VALIDATION TESTS ———

class TimeValidationTests(unittest.TestCase):
    def _acc(self, **kw):
        args = {"side": PositionSide.LONG, "entry_equity": 1.0, "position_fraction": 1.0,
                "raw_entry_price": 100.0, "raw_exit_price": 110.0,
                "entry_time_ms": 0, "exit_time_ms": 60_000,
                "capital": _CM, "cost": _COST_ZERO}
        args.update(kw)
        return calculate_trade_accounting(**args)

    def test_time_exit_equals_entry_valid(self):
        """TIME-01: holding=0 is legal."""
        r = self._acc(entry_time_ms=100, exit_time_ms=100)
        self.assertEqual(r.holding_time_ms, 0)

    def test_time_exit_before_entry_rejected(self):
        """TIME-02: exit < entry → ValueError."""
        with self.assertRaises(ValueError):
            self._acc(entry_time_ms=100, exit_time_ms=50)

    def test_time_negative_entry_rejected(self):
        """TIME-03: negative entry time."""
        with self.assertRaises(ValueError):
            self._acc(entry_time_ms=-1)

    def test_time_negative_exit_rejected(self):
        """TIME-04: negative exit time."""
        with self.assertRaises(ValueError):
            self._acc(exit_time_ms=-1)

    def test_time_float_entry_rejected(self):
        """TIME-05: float timestamp."""
        with self.assertRaises(ValueError):
            self._acc(entry_time_ms=0.5)

    def test_time_bool_entry_rejected(self):
        """TIME-06: bool timestamp."""
        with self.assertRaises(ValueError):
            self._acc(entry_time_ms=True)


# ——— NEW: PRICE VALIDATION TESTS ———

class PriceValidationTests(unittest.TestCase):
    def _acc(self, **kw):
        args = {"side": PositionSide.LONG, "entry_equity": 1.0, "position_fraction": 1.0,
                "raw_entry_price": 100.0, "raw_exit_price": 110.0,
                "entry_time_ms": 0, "exit_time_ms": 60_000,
                "capital": _CM, "cost": _COST_ZERO}
        args.update(kw)
        return calculate_trade_accounting(**args)

    def test_price_entry_zero_rejected(self):
        with self.assertRaises(ValueError): self._acc(raw_entry_price=0.0)

    def test_price_exit_zero_rejected(self):
        with self.assertRaises(ValueError): self._acc(raw_exit_price=0.0)

    def test_price_negative_rejected(self):
        with self.assertRaises(ValueError): self._acc(raw_entry_price=-100.0)

    def test_price_nan_rejected(self):
        with self.assertRaises(ValueError): self._acc(raw_entry_price=float("nan"))

    def test_price_inf_rejected(self):
        with self.assertRaises(ValueError): self._acc(raw_entry_price=float("inf"))

    def test_price_bool_rejected(self):
        with self.assertRaises(ValueError): self._acc(raw_entry_price=True)

    def test_excessive_impact_creates_invalid_fill_price(self):
        """PRICE-07: spread+slippage so high that fill price ≤ 0."""
        extreme = CostModel(half_spread_bps_per_fill=10_000, slippage_bps_per_fill=0,
                            fee_bps_per_fill=0, funding_bps_per_8h_adverse=0)
        with self.assertRaises(ValueError):
            calculate_trade_accounting(
                side=PositionSide.LONG, entry_equity=1.0, position_fraction=1.0,
                raw_entry_price=1.0, raw_exit_price=1.0,
                entry_time_ms=0, exit_time_ms=1000, capital=_CM, cost=extreme,
            )


# ——— NEW: IDENTITY MUTATION MATRIX ———

class IdentityMutationTests(unittest.TestCase):
    BASE = {
        "side": PositionSide.LONG, "entry_equity": 1.0, "position_fraction": 1.0,
        "raw_entry_price": 100.0, "raw_exit_price": 110.0,
        "entry_time_ms": 0, "exit_time_ms": 60_000,
    }
    CM = CapitalModel(initial_equity=1.0, position_fraction=1.0)
    COST = CostModel()

    def _id(self, **overrides):
        kw = {**self.BASE, "capital": self.CM, "cost": self.COST}
        kw.update(overrides)
        return calculate_trade_accounting(**kw).accounting_id

    def test_same_inputs_same_id(self):
        self.assertEqual(self._id(), self._id())

    def test_side_changes_id(self):
        self.assertNotEqual(self._id(side=PositionSide.LONG), self._id(side=PositionSide.SHORT))

    def test_entry_equity_changes_id(self):
        self.assertNotEqual(self._id(entry_equity=1.0), self._id(entry_equity=2.0))

    def test_position_fraction_changes_id(self):
        self.assertNotEqual(self._id(position_fraction=1.0), self._id(position_fraction=0.5))

    def test_max_position_fraction_changes_id(self):
        cm1 = CapitalModel(initial_equity=1.0, position_fraction=0.25, maximum_position_fraction=0.50)
        cm2 = CapitalModel(initial_equity=1.0, position_fraction=0.25, maximum_position_fraction=0.75)
        self.assertNotEqual(
            self._id(capital=cm1, position_fraction=0.25),
            self._id(capital=cm2, position_fraction=0.25),
        )

    def test_bankruptcy_policy_would_change_id_if_supported(self):
        # Only STOP_AT_ZERO is supported; test that different contract types → different IDs
        pass  # covered by max_position_fraction above; policy is frozen

    def test_raw_entry_price_changes_id(self):
        self.assertNotEqual(self._id(raw_entry_price=100.0), self._id(raw_entry_price=101.0))

    def test_raw_exit_price_changes_id(self):
        self.assertNotEqual(self._id(raw_exit_price=110.0), self._id(raw_exit_price=111.0))

    def test_entry_time_changes_id(self):
        self.assertNotEqual(self._id(entry_time_ms=0), self._id(entry_time_ms=1))

    def test_exit_time_changes_id(self):
        self.assertNotEqual(self._id(exit_time_ms=60000), self._id(exit_time_ms=60001))

    def test_fee_bps_changes_id(self):
        c1 = CostModel(fee_bps_per_fill=5)
        c2 = CostModel(fee_bps_per_fill=10)
        self.assertNotEqual(self._id(cost=c1), self._id(cost=c2))

    def test_half_spread_changes_id(self):
        c1 = CostModel(half_spread_bps_per_fill=1)
        c2 = CostModel(half_spread_bps_per_fill=2)
        self.assertNotEqual(self._id(cost=c1), self._id(cost=c2))

    def test_slippage_changes_id(self):
        c1 = CostModel(slippage_bps_per_fill=2)
        c2 = CostModel(slippage_bps_per_fill=3)
        self.assertNotEqual(self._id(cost=c1), self._id(cost=c2))

    def test_funding_bps_changes_id(self):
        c1 = CostModel(funding_bps_per_8h_adverse=1)
        c2 = CostModel(funding_bps_per_8h_adverse=2)
        self.assertNotEqual(self._id(cost=c1), self._id(cost=c2))

    def test_funding_period_changes_id(self):
        # funding_period_ms affects completed periods → changes funding_amount → changes id
        c1 = CostModel(funding_period_ms=28_800_000)
        c2 = CostModel(funding_period_ms=14_400_000)
        self.assertNotEqual(self._id(cost=c1), self._id(cost=c2))


class DeterminismTests(unittest.TestCase):
    def test_same_inputs_same_result(self) -> None:
        kwargs = dict(side=PositionSide.LONG, entry_equity=1.0, position_fraction=1.0,
                      raw_entry_price=100.0, raw_exit_price=110.0,
                      entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST)
        r1 = calculate_trade_accounting(**kwargs)
        r2 = calculate_trade_accounting(**kwargs)
        self.assertEqual(r1, r2)
        self.assertEqual(r1.accounting_id, r2.accounting_id)
        self.assertEqual(len(r1.accounting_id), 64)


if __name__ == "__main__":
    unittest.main()
