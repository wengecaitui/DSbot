"""Stage 5R1 v2 metrics — standard profit factor, return profit factor, cost aggregation."""

from __future__ import annotations

import statistics
from typing import Any, Sequence

from quant_engine.proof.stage5r1_capital import TradeAccounting

PROFIT_FACTOR_WIN_ONLY_SENTINEL = 1_000_000.0


def _validate_lineage(trades: Sequence[TradeAccounting]) -> None:
    """Fail-closed: all trades must share the same contract lineage."""
    if not trades:
        return
    first = trades[0]
    for i, t in enumerate(trades):
        if t.trade_accounting_schema_version != first.trade_accounting_schema_version:
            raise ValueError(f"STAGE5R1_METRICS_MIXED_TRADE_SCHEMA: trade {i}")
        if t.contract_type != first.contract_type:
            raise ValueError(f"STAGE5R1_METRICS_MIXED_CONTRACT_TYPE: trade {i}")
        if t.capital_model_id != first.capital_model_id:
            raise ValueError(f"STAGE5R1_METRICS_MIXED_CAPITAL_MODEL: trade {i}")
        if t.cost_model_id != first.cost_model_id:
            raise ValueError(f"STAGE5R1_METRICS_MIXED_COST_MODEL: trade {i}")
        if t.capital_initial_equity != first.capital_initial_equity:
            raise ValueError(f"STAGE5R1_METRICS_MIXED_INITIAL_EQUITY: trade {i}")


def standard_profit_factor(trades: Sequence[TradeAccounting]) -> float:
    """Profit factor from actual net PnL amounts (equity-delta)."""
    _validate_lineage(trades)
    if not trades:
        return 0.0
    wins = sum(t.net_pnl_amount for t in trades if t.net_pnl_amount > 0)
    losses = abs(sum(t.net_pnl_amount for t in trades if t.net_pnl_amount < 0))
    if wins == 0:
        return 0.0
    if losses == 0:
        return PROFIT_FACTOR_WIN_ONLY_SENTINEL
    return wins / losses


def return_profit_factor(trades: Sequence[TradeAccounting]) -> float:
    """Profit factor from trade-level net returns (backward-compat)."""
    _validate_lineage(trades)
    if not trades:
        return 0.0
    wins = sum(t.net_return_on_entry_equity for t in trades if t.net_return_on_entry_equity > 0)
    losses = abs(sum(t.net_return_on_entry_equity for t in trades if t.net_return_on_entry_equity < 0))
    if wins == 0:
        return 0.0
    if losses == 0:
        return PROFIT_FACTOR_WIN_ONLY_SENTINEL
    return wins / losses


def aggregate_cost_accounting(trades: Sequence[TradeAccounting]) -> dict[str, Any]:
    """Aggregate cost accounting across trades."""
    _validate_lineage(trades)
    if not trades:
        return {
            "spread_cost_amount": 0.0, "slippage_cost_amount": 0.0,
            "market_impact_cost_amount": 0.0,
            "fee_amount": 0.0, "funding_amount": 0.0,
            "explicit_cost_amount": 0.0, "total_cost_amount": 0.0,
            "cost_as_initial_equity_fraction": 0.0,
            "cost_as_average_entry_equity_fraction": 0.0,
            "fee_rate_disclosure_sum": 0.0, "spread_rate_disclosure_sum": 0.0,
            "slippage_rate_disclosure_sum": 0.0, "funding_rate_disclosure_sum": 0.0,
        }

    spread_cost_amount = sum(t.spread_cost_amount for t in trades)
    slippage_cost_amount = sum(t.slippage_cost_amount for t in trades)
    market_impact_cost_amount = sum(t.market_impact_cost_amount for t in trades)
    fee_amount = sum(t.fee_amount for t in trades)
    funding_amount = sum(t.funding_amount for t in trades)
    explicit_cost_amount = sum(t.explicit_cost_amount for t in trades)
    total_cost_amount = sum(t.total_cost_amount for t in trades)

    capital_initial = trades[0].capital_initial_equity
    cost_as_initial = total_cost_amount / capital_initial if capital_initial > 0 else 0.0
    avg_equity = statistics.fmean(float(t.entry_equity) for t in trades)
    cost_as_avg = total_cost_amount / avg_equity if avg_equity > 0 else 0.0

    fee_rate_disclosure_sum = sum(
        t.fee_amount / t.entry_notional if t.entry_notional > 0 else 0.0 for t in trades
    )
    spread_rate_disclosure_sum = sum(
        t.spread_cost_amount / (t.entry_notional + t.exit_notional)
        if (t.entry_notional + t.exit_notional) > 0 else 0.0 for t in trades
    )
    slippage_rate_disclosure_sum = sum(
        t.slippage_cost_amount / (t.entry_notional + t.exit_notional)
        if (t.entry_notional + t.exit_notional) > 0 else 0.0 for t in trades
    )
    funding_rate_disclosure_sum = sum(
        t.funding_amount / t.entry_notional if t.entry_notional > 0 else 0.0 for t in trades
    )

    return {
        "spread_cost_amount": spread_cost_amount,
        "slippage_cost_amount": slippage_cost_amount,
        "market_impact_cost_amount": market_impact_cost_amount,
        "fee_amount": fee_amount,
        "funding_amount": funding_amount,
        "explicit_cost_amount": explicit_cost_amount,
        "total_cost_amount": total_cost_amount,
        "cost_as_initial_equity_fraction": cost_as_initial,
        "cost_as_average_entry_equity_fraction": cost_as_avg,
        "fee_rate_disclosure_sum": fee_rate_disclosure_sum,
        "spread_rate_disclosure_sum": spread_rate_disclosure_sum,
        "slippage_rate_disclosure_sum": slippage_rate_disclosure_sum,
        "funding_rate_disclosure_sum": funding_rate_disclosure_sum,
    }
