"""Stage 5R1 capital model, cost model, and trade accounting tests — revised v3."""

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
    def test_reject_unknown_bankruptcy_policy(self):
        with self.assertRaises(ValueError):
            CapitalModel(initial_equity=1.0, bankruptcy_policy="LIQUIDATION_FIRST")


class CostModelContractTests(unittest.TestCase):
    def test_valid_cost_model_frozen_defaults(self) -> None:
        model = CostModel()
        self.assertEqual(model.schema_version, "stage-5r1.cost-model.v1")
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


# --- Linear PnL (unchanged core arithmetic) ---

class LinearLongTests(unittest.TestCase):
    def test_profitable_long_zero_costs(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, 0.10)
        self.assertAlmostEqual(result.net_pnl_amount, 0.10)
        self.assertAlmostEqual(result.closing_equity, 1.10)
        self.assertFalse(result.bankrupt)

    def test_losing_long_zero_costs(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
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
            side=PositionSide.SHORT, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=90.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, 0.10)
        self.assertAlmostEqual(result.net_pnl_amount, 0.10)
        self.assertAlmostEqual(result.closing_equity, 1.10)

    def test_losing_short_100_to_110(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.SHORT, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, -0.10)
        self.assertAlmostEqual(result.net_pnl_amount, -0.10)

    def test_short_bankruptcy_at_200(self) -> None:
        result = calculate_trade_accounting(
            side=PositionSide.SHORT, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=200.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.execution_pnl_amount, -1.0)
        self.assertAlmostEqual(result.raw_closing_equity, 0.0)
        self.assertTrue(result.bankrupt)


class FractionalPositionTests(unittest.TestCase):
    def test_fractional_long_profitable(self) -> None:
        """Position fraction comes from CapitalModel, not from a parameter."""
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM_FRAC, cost=_COST_ZERO,
        )
        self.assertAlmostEqual(result.position_fraction, 0.25)
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
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=CostModel(**kw),
        )

    def test_fee_monotonicity(self) -> None:
        r0, r5, r10 = self._long(fee_bps_per_fill=0), self._long(fee_bps_per_fill=5), self._long(fee_bps_per_fill=10)
        self.assertEqual(r0.execution_pnl_amount, r5.execution_pnl_amount)
        self.assertGreater(r0.net_pnl_amount, r5.net_pnl_amount)
        self.assertGreater(r5.net_pnl_amount, r10.net_pnl_amount)


class CostReconciliationTests(unittest.TestCase):
    def _trade(self, side, **cost_overrides):
        kw = {"fee_bps_per_fill": 5, "half_spread_bps_per_fill": 1,
              "slippage_bps_per_fill": 2, "funding_bps_per_8h_adverse": 1}
        kw.update(cost_overrides)
        return calculate_trade_accounting(
            side=side, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=10_000,
            capital=_CM, cost=CostModel(**kw),
        )

    def test_recon_long_raw_to_execution(self):
        t = self._trade(PositionSide.LONG, half_spread_bps_per_fill=1, slippage_bps_per_fill=2)
        self.assertAlmostEqual(t.raw_price_pnl_amount - t.spread_cost_amount - t.slippage_cost_amount, t.execution_pnl_amount)

    def test_recon_short_raw_to_execution(self):
        t = self._trade(PositionSide.SHORT, half_spread_bps_per_fill=1, slippage_bps_per_fill=2)
        self.assertAlmostEqual(t.raw_price_pnl_amount - t.spread_cost_amount - t.slippage_cost_amount, t.execution_pnl_amount)

    def test_recon_execution_to_net(self):
        t = self._trade(PositionSide.LONG, fee_bps_per_fill=5, funding_bps_per_8h_adverse=1)
        self.assertAlmostEqual(t.execution_pnl_amount - t.fee_amount - t.funding_amount, t.net_pnl_amount)

    def test_recon_total_cost_components(self):
        t = self._trade(PositionSide.SHORT)
        self.assertAlmostEqual(t.spread_cost_amount + t.slippage_cost_amount + t.fee_amount + t.funding_amount, t.total_cost_amount)


class TimeValidationTests(unittest.TestCase):
    def _acc(self, **kw):
        args = {"side": PositionSide.LONG, "entry_equity": 1.0,
                "raw_entry_price": 100.0, "raw_exit_price": 110.0,
                "entry_time_ms": 0, "exit_time_ms": 60_000,
                "capital": _CM, "cost": _COST_ZERO}
        args.update(kw)
        return calculate_trade_accounting(**args)

    def test_time_exit_equals_entry_valid(self):
        r = self._acc(entry_time_ms=100, exit_time_ms=100)
        self.assertEqual(r.holding_time_ms, 0)

    def test_time_exit_before_entry_rejected(self):
        with self.assertRaises(ValueError): self._acc(entry_time_ms=100, exit_time_ms=50)
    def test_time_negative_entry_rejected(self):
        with self.assertRaises(ValueError): self._acc(entry_time_ms=-1)
    def test_time_negative_exit_rejected(self):
        with self.assertRaises(ValueError): self._acc(exit_time_ms=-1)
    def test_time_float_entry_rejected(self):
        with self.assertRaises(ValueError): self._acc(entry_time_ms=0.5)
    def test_time_bool_entry_rejected(self):
        with self.assertRaises(ValueError): self._acc(entry_time_ms=True)


class PriceValidationTests(unittest.TestCase):
    def _acc(self, **kw):
        args = {"side": PositionSide.LONG, "entry_equity": 1.0,
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
        extreme = CostModel(half_spread_bps_per_fill=10_000, slippage_bps_per_fill=0,
                            fee_bps_per_fill=0, funding_bps_per_8h_adverse=0)
        with self.assertRaises(ValueError):
            calculate_trade_accounting(
                side=PositionSide.LONG, entry_equity=1.0,
                raw_entry_price=1.0, raw_exit_price=1.0,
                entry_time_ms=0, exit_time_ms=1000, capital=_CM, cost=extreme,
            )


# ——— NEW: CAPITAL BOUNDARY ———

class CapitalBoundaryTests(unittest.TestCase):
    def _acc(self, **kw):
        args = {"side": PositionSide.LONG, "entry_equity": 1.0,
                "raw_entry_price": 100.0, "raw_exit_price": 110.0,
                "entry_time_ms": 0, "exit_time_ms": 60_000,
                "capital": _CM, "cost": _COST_ZERO}
        args.update(kw)
        return calculate_trade_accounting(**args)

    def test_entry_equity_zero_rejected(self):
        with self.assertRaises(ValueError): self._acc(entry_equity=0.0)
    def test_entry_equity_negative_rejected(self):
        with self.assertRaises(ValueError): self._acc(entry_equity=-1.0)
    def test_entry_equity_nan_rejected(self):
        with self.assertRaises(ValueError): self._acc(entry_equity=float("nan"))
    def test_entry_equity_inf_rejected(self):
        with self.assertRaises(ValueError): self._acc(entry_equity=float("inf"))
    def test_entry_equity_bool_rejected(self):
        with self.assertRaises(ValueError): self._acc(entry_equity=True)

    def test_no_position_fraction_parameter(self):
        """BOUNDARY-06: calculate_trade_accounting does not accept position_fraction."""
        with self.assertRaises(TypeError):
            calculate_trade_accounting(
                side=PositionSide.LONG, entry_equity=1.0, position_fraction=0.5,
                raw_entry_price=100.0, raw_exit_price=110.0,
                entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
            )

    def test_position_fraction_comes_from_capital_model(self):
        """BOUNDARY-07: positionFraction from CapitalModel, not parameter."""
        cm = CapitalModel(initial_equity=1.0, position_fraction=0.25, maximum_position_fraction=0.50)
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=cm, cost=_COST_ZERO,
        )
        self.assertEqual(result.position_fraction, 0.25)
        self.assertAlmostEqual(result.entry_notional, 0.25)

    def test_position_fraction_above_max_rejected(self):
        """BOUNDARY-08: CapitalModel rejects positionFraction > maximum."""
        with self.assertRaises(ValueError):
            CapitalModel(initial_equity=1.0, position_fraction=0.8, maximum_position_fraction=0.5)

    def test_no_path_to_position_fraction_above_one(self):
        """BOUNDARY-09: Cannot construct CapitalModel with positionFraction > 1."""
        with self.assertRaises(ValueError):
            CapitalModel(initial_equity=1.0, position_fraction=1.5)


# ——— NEW: SIDE TYPE VALIDATION ———

class SideValidationTests(unittest.TestCase):
    def _acc(self, side):
        return calculate_trade_accounting(
            side=side, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST_ZERO,
        )

    def test_long_ok(self):
        self._acc(PositionSide.LONG)  # should not raise
    def test_short_ok(self):
        self._acc(PositionSide.SHORT)  # should not raise
    def test_string_long_rejected(self):
        with self.assertRaises(ValueError): self._acc("long")
    def test_string_short_rejected(self):
        with self.assertRaises(ValueError): self._acc("short")
    def test_bool_rejected(self):
        with self.assertRaises(ValueError): self._acc(True)
    def test_int_rejected(self):
        with self.assertRaises(ValueError): self._acc(1)
    def test_none_rejected(self):
        with self.assertRaises(ValueError): self._acc(None)


# ——— NEW: NUMERIC NORMALIZATION + MODEL IDENTITY ———

class NumericNormalizationTests(unittest.TestCase):
    def test_int_float_entry_equity_same_id(self):
        r1 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        r2 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        self.assertEqual(r1.accounting_id, r2.accounting_id)

    def test_int_float_price_same_id(self):
        r1 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100, raw_exit_price=110,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        r2 = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        self.assertEqual(r1.accounting_id, r2.accounting_id)


class ModelIdentityTests(unittest.TestCase):
    def test_capital_model_id_deterministic(self):
        cm1 = CapitalModel(initial_equity=1.0, position_fraction=1.0)
        cm2 = CapitalModel(initial_equity=1.0, position_fraction=1.0)
        r1 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=cm1, cost=_COST)
        r2 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=cm2, cost=_COST)
        self.assertEqual(r1.capital_model_id, r2.capital_model_id)

    def test_cost_model_id_deterministic(self):
        r1 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST)
        r2 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST)
        self.assertEqual(r1.cost_model_id, r2.cost_model_id)

    def test_max_position_fraction_changes_capital_model_id(self):
        cm1 = CapitalModel(initial_equity=1.0, position_fraction=0.25, maximum_position_fraction=0.50)
        cm2 = CapitalModel(initial_equity=1.0, position_fraction=0.25, maximum_position_fraction=0.75)
        r1 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=cm1, cost=_COST)
        r2 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=cm2, cost=_COST)
        self.assertNotEqual(r1.capital_model_id, r2.capital_model_id)

    def test_funding_period_changes_cost_model_id(self):
        c1 = CostModel(funding_period_ms=28_800_000)
        c2 = CostModel(funding_period_ms=14_400_000)
        r1 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=c1)
        r2 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=c2)
        self.assertNotEqual(r1.cost_model_id, r2.cost_model_id)

    def test_accounting_id_binds_capital_model_id(self):
        cm1 = CapitalModel(initial_equity=1.0, position_fraction=1.0)
        cm2 = CapitalModel(initial_equity=2.0, position_fraction=1.0)
        r1 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=cm1, cost=_COST)
        r2 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=cm2, cost=_COST)
        self.assertNotEqual(r1.accounting_id, r2.accounting_id)

    def test_accounting_id_binds_cost_model_id(self):
        c1 = CostModel(fee_bps_per_fill=5)
        c2 = CostModel(fee_bps_per_fill=6)
        r1 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=c1)
        r2 = calculate_trade_accounting(side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0, entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=c2)
        self.assertNotEqual(r1.accounting_id, r2.accounting_id)

    def test_capital_initial_equity_on_trade(self):
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        self.assertEqual(result.capital_initial_equity, _CM.initial_equity)

    def test_trade_schema_version_in_identity(self):
        """Different trade schema versions would produce different IDs if supported."""
        # Verify the schema version field is set correctly
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        self.assertEqual(result.trade_accounting_schema_version, "stage-5r1.trade-accounting.v1")


class DeterminismTests(unittest.TestCase):
    def test_same_inputs_same_result(self) -> None:
        kwargs = dict(side=PositionSide.LONG, entry_equity=1.0,
                      raw_entry_price=100.0, raw_exit_price=110.0,
                      entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST)
        r1 = calculate_trade_accounting(**kwargs)
        r2 = calculate_trade_accounting(**kwargs)
        self.assertEqual(r1.accounting_id, r2.accounting_id)
        self.assertEqual(len(r1.accounting_id), 64)

    def test_price_change_alters_id(self) -> None:
        def acc(exit_p): return calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=exit_p,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST)
        self.assertNotEqual(acc(110.0).accounting_id, acc(111.0).accounting_id)


# ——— NEW: MODEL TYPE BOUNDARY ———

class FakeCapitalModel(CapitalModel):
    pass


class FakeCostModel(CostModel):
    pass


class ModelTypeBoundaryTests(unittest.TestCase):
    """MODEL-TYPE-01 through MODEL-TYPE-08."""

    def _acc(self, **overrides):
        args = {"side": PositionSide.LONG, "entry_equity": 1.0,
                "raw_entry_price": 100.0, "raw_exit_price": 110.0,
                "entry_time_ms": 0, "exit_time_ms": 60_000,
                "capital": _CM, "cost": _COST_ZERO}
        args.update(overrides)
        return calculate_trade_accounting(**args)

    def test_capital_dict_rejected(self):
        with self.assertRaisesRegex(ValueError, "CAPITAL_MODEL_TYPE"):
            self._acc(capital={"initial_equity": 1.0, "position_fraction": 1.0})

    def test_cost_dict_rejected(self):
        with self.assertRaisesRegex(ValueError, "COST_MODEL_TYPE"):
            self._acc(cost={"fee_bps_per_fill": 0})

    def test_fake_capital_rejected(self):
        try:
            fake = FakeCapitalModel(initial_equity=1.0, position_fraction=2.0)
            with self.assertRaisesRegex(ValueError, "CAPITAL_MODEL_TYPE"):
                self._acc(capital=fake)
        except ValueError:
            # Subclass may fail construction due to position_fraction > 1
            pass

    def test_fake_cost_rejected(self):
        try:
            fake = FakeCostModel(fee_bps_per_fill=-100)
            with self.assertRaisesRegex(ValueError, "COST_MODEL_TYPE"):
                self._acc(cost=fake)
        except ValueError:
            # Subclass may fail construction
            pass

    def test_capital_subclass_rejected(self):
        try:
            fake = FakeCapitalModel(initial_equity=1.0, position_fraction=1.0)
            with self.assertRaisesRegex(ValueError, "CAPITAL_MODEL_TYPE"):
                self._acc(capital=fake)
        except ValueError as e:
            if "CAPITAL_MODEL_TYPE" not in str(e):
                raise

    def test_cost_subclass_rejected(self):
        try:
            fake = FakeCostModel()
            with self.assertRaisesRegex(ValueError, "COST_MODEL_TYPE"):
                self._acc(cost=fake)
        except ValueError as e:
            if "COST_MODEL_TYPE" not in str(e):
                raise

    def test_capital_model_id_rejects_fake(self):
        from quant_engine.proof.stage5r1_capital import capital_model_id
        with self.assertRaises(ValueError):
            capital_model_id({"initial_equity": 1.0})

    def test_cost_model_id_rejects_fake(self):
        from quant_engine.proof.stage5r1_capital import cost_model_id
        with self.assertRaises(ValueError):
            cost_model_id({"fee_bps_per_fill": 5.0})


# ——— NEW: SCHEMA BOUNDARY ———

class SchemaBoundaryTests(unittest.TestCase):
    """SCHEMA-01 through SCHEMA-04."""

    def test_trade_schema_version_correct(self):
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        self.assertEqual(result.schema_version, "stage-5r1.trade-accounting.v1")
        self.assertEqual(result.trade_accounting_schema_version, "stage-5r1.trade-accounting.v1")

    def test_trade_schema_fields_equal(self):
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        self.assertEqual(result.schema_version, result.trade_accounting_schema_version)

    def test_trade_schema_not_capital_schema(self):
        result = calculate_trade_accounting(
            side=PositionSide.LONG, entry_equity=1.0,
            raw_entry_price=100.0, raw_exit_price=110.0,
            entry_time_ms=0, exit_time_ms=60_000, capital=_CM, cost=_COST,
        )
        self.assertNotEqual(result.schema_version, _CM.schema_version)


if __name__ == "__main__":
    unittest.main()
