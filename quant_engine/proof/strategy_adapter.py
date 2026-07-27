"""Causal strategy adapter and position lifecycle simulator."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, Mapping, Protocol

import pandas as pd


class Action(str, Enum):
    HOLD = "hold"
    ENTER_LONG = "enter-long"
    ENTER_SHORT = "enter-short"
    EXIT = "exit"


@dataclass(frozen=True)
class Decision:
    action: Action
    stop_distance: float | None = None
    take_profit_distance: float | None = None


@dataclass(frozen=True)
class StrategyContext:
    position: int
    entry_price: float | None
    stop_price: float | None
    take_profit_price: float | None = None
    bars_held: int = 0


class StrategyAdapter(Protocol):
    strategy_id: str
    version: str
    minimum_history: int

    def decide(self, history: pd.DataFrame, parameters: Mapping[str, Any], context: StrategyContext) -> Action | Decision:
        """Return an action using only the supplied, closed-bar history prefix."""


@dataclass(frozen=True)
class Trade:
    side: str
    entry_index: int
    exit_index: int
    entry_price: float
    exit_price: float
    net_return: float
    exit_reason: str


def simulate_window(
    adapter: StrategyAdapter,
    bars: pd.DataFrame,
    parameters: Mapping[str, Any],
    start: int,
    end_exclusive: int,
    fee_bps: float = 4.0,
    slippage_bps: float = 1.0,
) -> dict[str, Any]:
    if not (0 <= start < end_exclusive <= len(bars)):
        raise ValueError("SIMULATION_WINDOW_INVALID")
    if end_exclusive - start < 2:
        raise ValueError("SIMULATION_WINDOW_TOO_SHORT")
    if not math.isfinite(fee_bps) or not math.isfinite(slippage_bps) or min(fee_bps, slippage_bps) < 0:
        raise ValueError("SIMULATION_COST_INVALID")

    position = 0
    entry_index: int | None = None
    entry_price: float | None = None
    stop_price: float | None = None
    take_profit_price: float | None = None
    trades: list[Trade] = []
    decision_calls = 0
    first_entry: int | None = None
    cost = (fee_bps + slippage_bps) / 10_000
    realized_equity = 1.0
    equity_points = [1.0]

    def close_position(exit_index: int, raw_price: float, reason: str) -> None:
        nonlocal position, entry_index, entry_price, stop_price, take_profit_price, realized_equity
        if position == 0 or entry_index is None or entry_price is None:
            return
        exit_price = raw_price * (1 - cost if position == 1 else 1 + cost)
        result = (exit_price / entry_price - 1) if position == 1 else (entry_price / exit_price - 1)
        trades.append(Trade("long" if position == 1 else "short", entry_index, exit_index, entry_price, exit_price, result, reason))
        realized_equity *= 1 + result
        position, entry_index, entry_price, stop_price, take_profit_price = 0, None, None, None, None

    pending = Decision(Action.HOLD)
    for bar_index in range(start, end_exclusive):
        execution_open = float(bars.iloc[bar_index]["open"])
        action = pending.action
        target = position
        if action is Action.ENTER_LONG:
            target = 1
        elif action is Action.ENTER_SHORT:
            target = -1
        elif action is Action.EXIT:
            target = 0
        if target != position:
            close_position(bar_index, execution_open, "signal")
        if target != 0 and position == 0:
            position = target
            entry_index = bar_index
            entry_price = execution_open * (1 + cost if target == 1 else 1 - cost)
            stop_price = None if pending.stop_distance is None else (
                execution_open - pending.stop_distance if target == 1 else execution_open + pending.stop_distance
            )
            take_profit_price = None if pending.take_profit_distance is None else (
                execution_open + pending.take_profit_distance if target == 1 else execution_open - pending.take_profit_distance
            )
            if first_entry is None:
                first_entry = bar_index

        if position == 1 and stop_price is not None and float(bars.iloc[bar_index]["low"]) <= stop_price:
            close_position(bar_index, min(execution_open, stop_price), "stop")
        elif position == -1 and stop_price is not None and float(bars.iloc[bar_index]["high"]) >= stop_price:
            close_position(bar_index, max(execution_open, stop_price), "stop")
        elif position == 1 and take_profit_price is not None and float(bars.iloc[bar_index]["high"]) >= take_profit_price:
            close_position(bar_index, max(execution_open, take_profit_price), "take-profit")
        elif position == -1 and take_profit_price is not None and float(bars.iloc[bar_index]["low"]) <= take_profit_price:
            close_position(bar_index, min(execution_open, take_profit_price), "take-profit")

        mark_equity = realized_equity
        if position != 0 and entry_price is not None:
            mark_price = float(bars.iloc[bar_index]["close"]) * (1 - cost if position == 1 else 1 + cost)
            open_return = (mark_price / entry_price - 1) if position == 1 else (entry_price / mark_price - 1)
            mark_equity *= 1 + open_return
        equity_points.append(mark_equity)

        pending = Decision(Action.HOLD)
        if bar_index >= end_exclusive - 1 or bar_index + 1 < adapter.minimum_history:
            continue
        history_limit = getattr(adapter, "history_limit", None)
        history_start = 0 if history_limit is None else max(0, bar_index + 1 - int(history_limit))
        history = bars.iloc[history_start: bar_index + 1].copy(deep=True)
        bars_held = 0 if entry_index is None else bar_index - entry_index + 1
        raw_decision = adapter.decide(history, parameters, StrategyContext(position, entry_price, stop_price, take_profit_price, bars_held))
        if isinstance(raw_decision, Action):
            raw_decision = Decision(raw_decision)
        if not isinstance(raw_decision, Decision) or not isinstance(raw_decision.action, Action):
            raise ValueError(f"ADAPTER_ACTION_INVALID:{raw_decision}")
        if raw_decision.stop_distance is not None and (
            raw_decision.action not in (Action.ENTER_LONG, Action.ENTER_SHORT) or raw_decision.stop_distance <= 0
        ):
            raise ValueError("ADAPTER_STOP_DISTANCE_INVALID")
        if raw_decision.take_profit_distance is not None and (
            raw_decision.action not in (Action.ENTER_LONG, Action.ENTER_SHORT) or raw_decision.take_profit_distance <= 0
        ):
            raise ValueError("ADAPTER_TAKE_PROFIT_DISTANCE_INVALID")
        pending = raw_decision
        decision_calls += 1

    close_position(end_exclusive - 1, float(bars.iloc[end_exclusive - 1]["close"]), "window-end")
    compounded = 1.0
    for trade in trades:
        compounded *= 1 + trade.net_return
    peak = equity_points[0]
    max_drawdown = 0.0
    for equity in equity_points:
        peak = max(peak, equity)
        if peak > 0:
            max_drawdown = max(max_drawdown, (peak - equity) / peak)
    return {
        "strategyId": adapter.strategy_id,
        "adapterVersion": adapter.version,
        "start": start,
        "endExclusive": end_exclusive,
        "decisionCalls": decision_calls,
        "firstEntryIndex": first_entry,
        "tradeCount": len(trades),
        "netReturn": compounded - 1,
        "maxDrawdown": max_drawdown,
        "winRate": 0.0 if not trades else sum(trade.net_return > 0 for trade in trades) / len(trades),
        "trades": [asdict(trade) for trade in trades],
    }
