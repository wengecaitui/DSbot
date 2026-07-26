"""Causal strategy adapter and position lifecycle simulator."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, Mapping, Protocol

import pandas as pd


class Action(str, Enum):
    HOLD = "hold"
    ENTER_LONG = "enter-long"
    ENTER_SHORT = "enter-short"
    EXIT = "exit"


class StrategyAdapter(Protocol):
    strategy_id: str
    version: str
    minimum_history: int

    def decide(self, history: pd.DataFrame, parameters: Mapping[str, Any]) -> Action:
        """Return an action using only the supplied, closed-bar history prefix."""


@dataclass(frozen=True)
class Trade:
    side: str
    entry_index: int
    exit_index: int
    entry_price: float
    exit_price: float
    net_return: float


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

    position = 0
    entry_index: int | None = None
    entry_price: float | None = None
    trades: list[Trade] = []
    decision_calls = 0
    first_entry: int | None = None
    cost = (fee_bps + slippage_bps) / 10_000

    def close_position(exit_index: int, raw_price: float) -> None:
        nonlocal position, entry_index, entry_price
        if position == 0 or entry_index is None or entry_price is None:
            return
        exit_price = raw_price * (1 - cost if position == 1 else 1 + cost)
        result = (exit_price / entry_price - 1) if position == 1 else (entry_price / exit_price - 1)
        trades.append(Trade("long" if position == 1 else "short", entry_index, exit_index, entry_price, exit_price, result))
        position, entry_index, entry_price = 0, None, None

    for signal_index in range(start, end_exclusive - 1):
        if signal_index + 1 < adapter.minimum_history:
            continue
        history = bars.iloc[: signal_index + 1].copy(deep=True)
        action = adapter.decide(history, parameters)
        if not isinstance(action, Action):
            raise ValueError(f"ADAPTER_ACTION_INVALID:{action}")
        decision_calls += 1
        execution_index = signal_index + 1
        execution_open = float(bars.iloc[execution_index]["open"])
        target = position
        if action is Action.ENTER_LONG:
            target = 1
        elif action is Action.ENTER_SHORT:
            target = -1
        elif action is Action.EXIT:
            target = 0
        if target == position:
            continue
        close_position(execution_index, execution_open)
        if target != 0:
            position = target
            entry_index = execution_index
            entry_price = execution_open * (1 + cost if target == 1 else 1 - cost)
            if first_entry is None:
                first_entry = execution_index

    close_position(end_exclusive - 1, float(bars.iloc[end_exclusive - 1]["close"]))
    compounded = 1.0
    for trade in trades:
        compounded *= 1 + trade.net_return
    return {
        "strategyId": adapter.strategy_id,
        "adapterVersion": adapter.version,
        "start": start,
        "endExclusive": end_exclusive,
        "decisionCalls": decision_calls,
        "firstEntryIndex": first_entry,
        "tradeCount": len(trades),
        "netReturn": compounded - 1,
        "trades": [asdict(trade) for trade in trades],
    }
