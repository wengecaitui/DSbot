"""Stage 5R1 v2 capital model — frozen LINEAR USDT unlevered contract.

Versioned, independent of old Stage 5 contracts.  All values are validated
at construction so downstream code receives a guaranteed-safe frozen config.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


FROZEN_SCHEMA_VERSION = "stage-5r1.capital-model.v1"
FROZEN_CONTRACT_TYPE = "LINEAR_USDT"
FROZEN_BANKRUPTCY_POLICY = "STOP_AT_ZERO"


@dataclass(frozen=True)
class CapitalModel:
    """Immutable capital configuration for Stage 5R1 research."""

    initial_equity: float = 1.0
    position_fraction: float = 1.0
    maximum_position_fraction: float = 1.0
    allow_leverage: bool = False
    schema_version: str = FROZEN_SCHEMA_VERSION
    contract_type: str = FROZEN_CONTRACT_TYPE
    bankruptcy_policy: str = FROZEN_BANKRUPTCY_POLICY

    def __post_init__(self) -> None:
        if self.schema_version != FROZEN_SCHEMA_VERSION:
            raise ValueError(f"CAPITAL_MODEL_SCHEMA_UNSUPPORTED: {self.schema_version}")
        if self.contract_type != FROZEN_CONTRACT_TYPE:
            raise ValueError(f"CAPITAL_MODEL_CONTRACT_TYPE_UNSUPPORTED: {self.contract_type}")
        if self.bankruptcy_policy != FROZEN_BANKRUPTCY_POLICY:
            raise ValueError(f"CAPITAL_MODEL_BANKRUPTCY_POLICY_UNSUPPORTED: {self.bankruptcy_policy}")

        for name in ("initial_equity", "position_fraction", "maximum_position_fraction"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"CAPITAL_MODEL_NON_NUMERIC_{name.upper()}: {value!r}")
            if not math.isfinite(float(value)):
                raise ValueError(f"CAPITAL_MODEL_NON_FINITE_{name.upper()}: {value}")

        if self.initial_equity <= 0:
            raise ValueError(f"CAPITAL_MODEL_INITIAL_EQUITY_NOT_POSITIVE: {self.initial_equity}")
        if self.position_fraction <= 0:
            raise ValueError(f"CAPITAL_MODEL_POSITION_FRACTION_NOT_POSITIVE: {self.position_fraction}")
        if self.position_fraction > self.maximum_position_fraction:
            raise ValueError(f"CAPITAL_MODEL_POSITION_FRACTION_EXCEEDS_MAX: {self.position_fraction} > {self.maximum_position_fraction}")
        if self.maximum_position_fraction > 1.0:
            raise ValueError(f"CAPITAL_MODEL_MAX_POSITION_FRACTION_ABOVE_ONE: {self.maximum_position_fraction}")
        if self.allow_leverage:
            raise ValueError("CAPITAL_MODEL_LEVERAGE_FORBIDDEN_IN_STAGE5R1")


FROZEN_COST_SCHEMA_VERSION = "stage-5r1.cost-model.v1"
FROZEN_FUNDING_PERIOD_MS = 28_800_000  # 8 hours


@dataclass(frozen=True)
class CostModel:
    """Immutable cost configuration with time-based funding."""

    fee_bps_per_fill: float = 5.0
    half_spread_bps_per_fill: float = 1.0
    slippage_bps_per_fill: float = 2.0
    funding_bps_per_8h_adverse: float = 1.0
    funding_period_ms: int = FROZEN_FUNDING_PERIOD_MS
    schema_version: str = FROZEN_COST_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != FROZEN_COST_SCHEMA_VERSION:
            raise ValueError(f"COST_MODEL_SCHEMA_UNSUPPORTED: {self.schema_version}")

        for name in ("fee_bps_per_fill", "half_spread_bps_per_fill", "slippage_bps_per_fill", "funding_bps_per_8h_adverse"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"COST_MODEL_NON_NUMERIC_{name.upper()}: {value!r}")
            if not math.isfinite(float(value)):
                raise ValueError(f"COST_MODEL_NON_FINITE_{name.upper()}: {value}")
            if float(value) < 0:
                raise ValueError(f"COST_MODEL_NEGATIVE_{name.upper()}: {value}")

        if not isinstance(self.funding_period_ms, int) or isinstance(self.funding_period_ms, bool):
            raise ValueError(f"COST_MODEL_FUNDING_PERIOD_NOT_INT: {self.funding_period_ms!r}")
        if self.funding_period_ms <= 0:
            raise ValueError(f"COST_MODEL_FUNDING_PERIOD_NOT_POSITIVE: {self.funding_period_ms}")


# ---------------------------------------------------------------------------
# Trade accounting
# ---------------------------------------------------------------------------

from enum import Enum
from typing import Any


_TRADE_ACCOUNTING_SCHEMA_VERSION = "stage-5r1.trade-accounting.v1"


class PositionSide(str, Enum):
    LONG = "long"
    SHORT = "short"


def _canonical_json_bytes(value: Any) -> bytes:
    from quant_engine.proof.stage5_evaluation import canonical_json_bytes as _cjb
    return _cjb(value)


def _canonical_sha256(value: Any) -> str:
    from quant_engine.proof.stage5_evaluation import canonical_sha256 as _cs
    return _cs(value)


def _normalize(value: Any) -> Any:
    """Normalize continuous economic values to float for canonical identity.

    Integers that represent continuous quantities (prices, equity, rates)
    are normalized to float so that 1 and 1.0 produce the same identity.
    Time fields and strings are left as-is.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return [_normalize(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _normalize(v) for k, v in value.items()}
    if hasattr(value, "value"):
        return _normalize(value.value)
    return value


def _normalize_capital(c: CapitalModel) -> dict[str, Any]:
    return {
        "schemaVersion": c.schema_version,
        "contractType": c.contract_type,
        "initialEquity": float(c.initial_equity),
        "positionFraction": float(c.position_fraction),
        "maximumPositionFraction": float(c.maximum_position_fraction),
        "allowLeverage": c.allow_leverage,
        "bankruptcyPolicy": c.bankruptcy_policy,
    }


def _normalize_cost(c: CostModel) -> dict[str, Any]:
    return {
        "schemaVersion": c.schema_version,
        "feeBpsPerFill": float(c.fee_bps_per_fill),
        "halfSpreadBpsPerFill": float(c.half_spread_bps_per_fill),
        "slippageBpsPerFill": float(c.slippage_bps_per_fill),
        "fundingBpsPer8hAdverse": float(c.funding_bps_per_8h_adverse),
        "fundingPeriodMs": c.funding_period_ms,
    }


def capital_model_id(capital: CapitalModel) -> str:
    return _canonical_sha256(_normalize_capital(capital))


def cost_model_id(cost: CostModel) -> str:
    return _canonical_sha256(_normalize_cost(cost))


def _validate_finite_positive(value: float, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"STAGE5R1_{label}_NON_NUMERIC: {value!r}")
    if not math.isfinite(float(value)):
        raise ValueError(f"STAGE5R1_{label}_NON_FINITE: {value}")
    if float(value) <= 0:
        raise ValueError(f"STAGE5R1_{label}_NOT_POSITIVE: {value}")


def _validate_timestamp(value: int, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"STAGE5R1_{label}_NOT_INT: {value!r}")
    if value < 0:
        raise ValueError(f"STAGE5R1_{label}_NEGATIVE: {value}")


@dataclass(frozen=True)
class TradeAccounting:
    """Immutable output of a single-trade economic accounting."""

    schema_version: str
    contract_type: str
    trade_accounting_schema_version: str
    side: PositionSide

    entry_equity: float
    position_fraction: float
    entry_notional: float
    quantity: float

    raw_entry_price: float
    raw_exit_price: float
    entry_fill_price: float
    exit_fill_price: float
    exit_notional: float

    raw_price_pnl_amount: float
    execution_pnl_amount: float
    gross_pnl_amount: float  # alias for execution_pnl_amount

    spread_cost_amount: float
    slippage_cost_amount: float
    market_impact_cost_amount: float
    entry_fee_amount: float
    exit_fee_amount: float
    fee_amount: float
    funding_amount: float
    explicit_cost_amount: float
    total_cost_amount: float

    net_pnl_amount: float

    gross_return_on_entry_equity: float
    net_return_on_entry_equity: float

    raw_closing_equity: float
    closing_equity: float
    bankrupt: bool

    holding_time_ms: int
    completed_funding_periods: int

    capital_model_id: str
    cost_model_id: str
    capital_initial_equity: float

    accounting_id: str


def calculate_trade_accounting(
    *,
    side: PositionSide,
    entry_equity: float,
    raw_entry_price: float,
    raw_exit_price: float,
    entry_time_ms: int,
    exit_time_ms: int,
    capital: CapitalModel,
    cost: CostModel,
) -> TradeAccounting:
    """Compute full per-trade economic accounting for a LINEAR USDT position.

    Position fraction is taken exclusively from ``capital.position_fraction``.
    There is no independent position_fraction parameter — this prevents
    bypassing the CapitalModel's max_position_fraction and leverage gates.
    """

    # --- side validation ---
    if not isinstance(side, PositionSide):
        raise ValueError(f"STAGE5R1_SIDE_INVALID: {side!r}")

    # --- entry equity validation ---
    if isinstance(entry_equity, bool) or not isinstance(entry_equity, (int, float)):
        raise ValueError(f"STAGE5R1_ENTRY_EQUITY_NON_NUMERIC: {entry_equity!r}")
    if not math.isfinite(float(entry_equity)):
        raise ValueError(f"STAGE5R1_ENTRY_EQUITY_NON_FINITE: {entry_equity}")
    if float(entry_equity) <= 0:
        raise ValueError(f"STAGE5R1_ENTRY_EQUITY_NOT_POSITIVE: {entry_equity}")

    # --- price and time validation ---
    _validate_finite_positive(raw_entry_price, "RAW_ENTRY_PRICE")
    _validate_finite_positive(raw_exit_price, "RAW_EXIT_PRICE")
    _validate_timestamp(entry_time_ms, "ENTRY_TIME_MS")
    _validate_timestamp(exit_time_ms, "EXIT_TIME_MS")
    if exit_time_ms < entry_time_ms:
        raise ValueError(f"STAGE5R1_TRADE_TIME_ORDER_INVALID: exit={exit_time_ms} < entry={entry_time_ms}")

    # --- position fraction from capital model ---
    position_fraction = capital.position_fraction

    # --- fill prices ---
    spread_rate = cost.half_spread_bps_per_fill / 10_000
    slippage_rate = cost.slippage_bps_per_fill / 10_000
    impact_rate = spread_rate + slippage_rate
    if side is PositionSide.LONG:
        entry_fill_price = raw_entry_price * (1.0 + impact_rate)
        exit_fill_price = raw_exit_price * (1.0 - impact_rate)
    else:
        entry_fill_price = raw_entry_price * (1.0 - impact_rate)
        exit_fill_price = raw_exit_price * (1.0 + impact_rate)

    if entry_fill_price <= 0 or exit_fill_price <= 0:
        raise ValueError(f"STAGE5R1_FILL_PRICE_INVALID: entryFill={entry_fill_price} exitFill={exit_fill_price}")

    # --- notional and quantity ---
    entry_notional = entry_equity * position_fraction
    quantity = entry_notional / entry_fill_price
    exit_notional = quantity * exit_fill_price

    # --- PnL ---
    if side is PositionSide.LONG:
        raw_price_pnl_amount = quantity * (raw_exit_price - raw_entry_price)
        execution_pnl_amount = quantity * (exit_fill_price - entry_fill_price)
    else:
        raw_price_pnl_amount = quantity * (raw_entry_price - raw_exit_price)
        execution_pnl_amount = quantity * (entry_fill_price - exit_fill_price)

    # --- spread/slippage amounts ---
    spread_cost_amount = quantity * (raw_entry_price + raw_exit_price) * spread_rate
    slippage_cost_amount = quantity * (raw_entry_price + raw_exit_price) * slippage_rate
    market_impact_cost_amount = spread_cost_amount + slippage_cost_amount

    # --- fee ---
    fee_rate = cost.fee_bps_per_fill / 10_000
    entry_fee_amount = entry_notional * fee_rate
    exit_fee_amount = exit_notional * fee_rate
    fee_amount = entry_fee_amount + exit_fee_amount

    # --- funding ---
    holding_time_ms = exit_time_ms - entry_time_ms
    completed_funding_periods = holding_time_ms // cost.funding_period_ms
    funding_rate_per_period = cost.funding_bps_per_8h_adverse / 10_000
    funding_amount = entry_notional * funding_rate_per_period * completed_funding_periods

    # --- totals ---
    explicit_cost_amount = fee_amount + funding_amount
    total_cost_amount = market_impact_cost_amount + explicit_cost_amount
    net_pnl_amount = execution_pnl_amount - explicit_cost_amount

    # --- returns ---
    gross_return_on_entry_equity = execution_pnl_amount / entry_equity
    net_return_on_entry_equity = net_pnl_amount / entry_equity

    # --- equity ---
    raw_closing_equity = entry_equity + net_pnl_amount
    bankrupt = raw_closing_equity <= 0.0
    closing_equity = max(raw_closing_equity, 0.0)

    # --- model IDs ---
    cm_id = capital_model_id(capital)
    co_id = cost_model_id(cost)

    # --- canonical identity ---
    identity_payload = _normalize({
        "tradeAccountingSchemaVersion": _TRADE_ACCOUNTING_SCHEMA_VERSION,
        "capitalModelId": cm_id,
        "costModelId": co_id,
        "side": side.value,
        "entryEquity": float(entry_equity),
        "rawEntryPrice": float(raw_entry_price),
        "rawExitPrice": float(raw_exit_price),
        "entryTimeMs": entry_time_ms,
        "exitTimeMs": exit_time_ms,
    })
    accounting_id = _canonical_sha256(identity_payload)

    return TradeAccounting(
        schema_version=capital.schema_version,
        contract_type=capital.contract_type,
        trade_accounting_schema_version=_TRADE_ACCOUNTING_SCHEMA_VERSION,
        side=side,
        entry_equity=entry_equity,
        position_fraction=position_fraction,
        entry_notional=entry_notional,
        quantity=quantity,
        raw_entry_price=raw_entry_price,
        raw_exit_price=raw_exit_price,
        entry_fill_price=entry_fill_price,
        exit_fill_price=exit_fill_price,
        exit_notional=exit_notional,
        raw_price_pnl_amount=raw_price_pnl_amount,
        execution_pnl_amount=execution_pnl_amount,
        gross_pnl_amount=execution_pnl_amount,
        spread_cost_amount=spread_cost_amount,
        slippage_cost_amount=slippage_cost_amount,
        market_impact_cost_amount=market_impact_cost_amount,
        entry_fee_amount=entry_fee_amount,
        exit_fee_amount=exit_fee_amount,
        fee_amount=fee_amount,
        funding_amount=funding_amount,
        explicit_cost_amount=explicit_cost_amount,
        total_cost_amount=total_cost_amount,
        net_pnl_amount=net_pnl_amount,
        gross_return_on_entry_equity=gross_return_on_entry_equity,
        net_return_on_entry_equity=net_return_on_entry_equity,
        raw_closing_equity=raw_closing_equity,
        closing_equity=closing_equity,
        bankrupt=bankrupt,
        holding_time_ms=holding_time_ms,
        completed_funding_periods=completed_funding_periods,
        capital_model_id=cm_id,
        cost_model_id=co_id,
        capital_initial_equity=capital.initial_equity,
        accounting_id=accounting_id,
    )
