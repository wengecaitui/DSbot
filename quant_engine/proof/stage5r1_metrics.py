"""Stage 5R1 v2 metrics — standard profit factor, return profit factor, cost aggregation."""

from __future__ import annotations

import statistics
from typing import Any, Sequence

from quant_engine.proof.stage5r1_capital import TradeAccounting

PROFIT_FACTOR_WIN_ONLY_SENTINEL = 1_000_000.0


def standard_profit_factor(trades: Sequence[TradeAccounting]) -> float:
    """Profit factor from actual net PnL amounts (equity-delta)."""
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
    """Profit factor from trade-level net returns (backward-compat with old Stage 5)."""
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
    """Aggregate cost accounting across trades.

    Returns actual amounts, fractions using total_cost_amount, and
    rate disclosure sums for backward comparison.
    """
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

    initial_equity = trades[0].entry_equity
    cost_as_initial = total_cost_amount / initial_equity if initial_equity > 0 else 0.0
    avg_equity = statistics.fmean(t.entry_equity for t in trades)
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
