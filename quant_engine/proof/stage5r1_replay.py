"""Stage 5R1.3-A deterministic next-open replay contract.

Pure functions. No global state, random, wall-clock, filesystem, or network.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Sequence

from quant_engine.proof.stage5r1_capital import (
    CapitalModel,
    CostModel,
    PositionSide,
    TradeAccounting,
    calculate_trade_accounting,
    capital_model_id,
    cost_model_id,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

# --- Schema versions ---

REPLAY_BAR_SCHEMA = "stage-5r1.replay-bar.v1"
REPLAY_CONFIG_SCHEMA = "stage-5r1.replay-config.v1"
REPLAY_INSTRUCTION_SCHEMA = "stage-5r1.replay-instruction.v1"
REPLAY_TRADE_SCHEMA = "stage-5r1.replay-trade.v1"
REPLAY_RESULT_SCHEMA = "stage-5r1.replay-result.v1"

FROZEN_TIMEFRAME_MS = 300_000  # 5 minutes only


# --- ReplayBar ---

@dataclass(frozen=True)
class ReplayBar:
    schema_version: str = REPLAY_BAR_SCHEMA
    open_time_ms: int = 0
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    volume: float = 0.0
    closed: bool = True

    def __post_init__(self) -> None:
        if self.schema_version != REPLAY_BAR_SCHEMA:
            raise ValueError(f"REPLAY_BAR_SCHEMA_INVALID: {self.schema_version}")
        if isinstance(self.open_time_ms, bool) or not isinstance(self.open_time_ms, int):
            raise ValueError(f"REPLAY_BAR_OPEN_TIME_NOT_INT: {self.open_time_ms!r}")
        if self.open_time_ms < 0:
            raise ValueError(f"REPLAY_BAR_OPEN_TIME_NEGATIVE: {self.open_time_ms}")

        for name in ("open", "high", "low", "close"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"REPLAY_BAR_{name.upper()}_NON_NUMERIC: {value!r}")
            if not math.isfinite(float(value)):
                raise ValueError(f"REPLAY_BAR_{name.upper()}_NON_FINITE: {value}")
            if float(value) <= 0:
                raise ValueError(f"REPLAY_BAR_{name.upper()}_NOT_POSITIVE: {value}")

        if isinstance(self.volume, bool) or not isinstance(self.volume, (int, float)):
            raise ValueError(f"REPLAY_BAR_VOLUME_NON_NUMERIC: {self.volume!r}")
        if not math.isfinite(float(self.volume)):
            raise ValueError(f"REPLAY_BAR_VOLUME_NON_FINITE: {self.volume}")
        if float(self.volume) < 0:
            raise ValueError(f"REPLAY_BAR_VOLUME_NEGATIVE: {self.volume}")

        if self.closed is not True:
            raise ValueError("REPLAY_BAR_NOT_CLOSED")
        if not (self.low <= self.open <= self.high):
            raise ValueError(f"REPLAY_BAR_OPEN_OUT_OF_RANGE: open={self.open} low={self.low} high={self.high}")
        if not (self.low <= self.close <= self.high):
            raise ValueError(f"REPLAY_BAR_CLOSE_OUT_OF_RANGE: close={self.close} low={self.low} high={self.high}")


# --- Bar sequence validation ---

def validate_bar_sequence(bars: Sequence[ReplayBar]) -> tuple[ReplayBar, ...]:
    if not isinstance(bars, Sequence) or isinstance(bars, (str, bytes)):
        raise ValueError("REPLAY_BAR_SEQUENCE_NOT_SEQUENCE")
    if len(bars) < 2:
        raise ValueError("REPLAY_BAR_SEQUENCE_TOO_SHORT")

    for i, b in enumerate(bars):
        if type(b) is not ReplayBar:
            raise ValueError(f"REPLAY_BAR_TYPE_INVALID_AT_{i}: {type(b).__name__}")

    for i in range(1, len(bars)):
        prev, curr = bars[i - 1], bars[i]
        if curr.open_time_ms <= prev.open_time_ms:
            raise ValueError(f"REPLAY_BAR_TIME_NOT_STRICTLY_INCREASING: index={i}")
        diff = curr.open_time_ms - prev.open_time_ms
        if diff != FROZEN_TIMEFRAME_MS:
            raise ValueError(f"REPLAY_BAR_TIME_GAP: index={i} diff={diff} expected={FROZEN_TIMEFRAME_MS}")

    return tuple(bars)


# --- ReplayAction ---

class ReplayAction(str, Enum):
    ENTER_LONG = "enter_long"
    ENTER_SHORT = "enter_short"
    EXIT = "exit"


# --- ReplayInstruction ---

@dataclass(frozen=True)
class ReplayInstruction:
    schema_version: str = REPLAY_INSTRUCTION_SCHEMA
    signal_bar_open_time_ms: int = 0
    action: ReplayAction = ReplayAction.ENTER_LONG

    def __post_init__(self) -> None:
        if self.schema_version != REPLAY_INSTRUCTION_SCHEMA:
            raise ValueError(f"REPLAY_INSTRUCTION_SCHEMA_INVALID: {self.schema_version}")
        if not isinstance(self.action, ReplayAction):
            raise ValueError(f"REPLAY_INSTRUCTION_ACTION_INVALID: {self.action!r}")
        if isinstance(self.signal_bar_open_time_ms, bool) or not isinstance(self.signal_bar_open_time_ms, int):
            raise ValueError(f"REPLAY_INSTRUCTION_TIME_NOT_INT: {self.signal_bar_open_time_ms!r}")
        if self.signal_bar_open_time_ms < 0:
            raise ValueError(f"REPLAY_INSTRUCTION_TIME_NEGATIVE: {self.signal_bar_open_time_ms}")


def validate_instruction_set(
    instructions: Sequence[ReplayInstruction],
    bars: tuple[ReplayBar, ...],
    warmup_bars: int = 100,
) -> tuple[ReplayInstruction, ...]:
    if not isinstance(instructions, Sequence) or isinstance(instructions, (str, bytes)):
        raise ValueError("REPLAY_INSTRUCTION_SET_NOT_SEQUENCE")

    # --- validate bars first ---
    valid_bars = validate_bar_sequence(bars)

    # --- validate warmup ---
    if isinstance(warmup_bars, bool) or not isinstance(warmup_bars, int):
        raise ValueError(f"REPLAY_WARMUP_NOT_INT: {warmup_bars!r}")
    if warmup_bars <= 0:
        raise ValueError(f"REPLAY_WARMUP_NOT_POSITIVE: {warmup_bars}")

    bar_times = {b.open_time_ms for b in valid_bars}

    seen: set[int] = set()
    prev_time: int | None = None
    for i, inst in enumerate(instructions):
        if type(inst) is not ReplayInstruction:
            raise ValueError(f"REPLAY_INSTRUCTION_TYPE_INVALID_AT_{i}: {type(inst).__name__}")
        t = inst.signal_bar_open_time_ms
        if t in seen:
            raise ValueError(f"REPLAY_INSTRUCTION_DUPLICATE_TIME: {t} at index {i}")
        seen.add(t)
        if prev_time is not None and t <= prev_time:
            raise ValueError(f"REPLAY_INSTRUCTION_NOT_SORTED: index={i} time={t} prev={prev_time}")
        prev_time = t
        if t not in bar_times:
            raise ValueError(f"REPLAY_INSTRUCTION_UNKNOWN_BAR: {t}")
        if t == valid_bars[-1].open_time_ms:
            raise ValueError(f"REPLAY_INSTRUCTION_ON_FINAL_BAR: {t}")
        # warmup check: signal must be on or after bar index warmup_bars - 1
        bar_times_sorted = sorted(bar_times)
        signal_index = bar_times_sorted.index(t)
        if signal_index < warmup_bars - 1:
            raise ValueError(f"REPLAY_INSTRUCTION_BEFORE_WARMUP: time={t} signal_index={signal_index} warmup={warmup_bars}")

    return tuple(instructions)


# --- ReplayConfig ---

@dataclass(frozen=True)
class ReplayConfig:
    schema_version: str = REPLAY_CONFIG_SCHEMA
    symbol: str = ""
    timeframe_ms: int = FROZEN_TIMEFRAME_MS
    warmup_bars: int = 100
    closed_bars_only: bool = True
    next_open_execution: bool = True
    gap_policy: str = "REJECT"
    end_of_replay_policy: str = "REJECT_OPEN_POSITION"

    def __post_init__(self) -> None:
        if self.schema_version != REPLAY_CONFIG_SCHEMA:
            raise ValueError(f"REPLAY_CONFIG_SCHEMA_INVALID: {self.schema_version}")
        if not self.symbol or not isinstance(self.symbol, str):
            raise ValueError(f"REPLAY_CONFIG_SYMBOL_INVALID: {self.symbol!r}")
        if type(self.timeframe_ms) is not int or self.timeframe_ms != FROZEN_TIMEFRAME_MS:
            raise ValueError(f"REPLAY_CONFIG_TIMEFRAME_INVALID: {self.timeframe_ms}")
        if isinstance(self.warmup_bars, bool) or not isinstance(self.warmup_bars, int):
            raise ValueError(f"REPLAY_CONFIG_WARMUP_NOT_INT: {self.warmup_bars!r}")
        if self.warmup_bars <= 0:
            raise ValueError(f"REPLAY_CONFIG_WARMUP_NOT_POSITIVE: {self.warmup_bars}")
        if self.closed_bars_only is not True:
            raise ValueError(f"REPLAY_CONFIG_CLOSED_BARS_WEAKENED")
        if self.next_open_execution is not True:
            raise ValueError(f"REPLAY_CONFIG_NEXT_OPEN_WEAKENED")
        if self.gap_policy != "REJECT":
            raise ValueError(f"REPLAY_CONFIG_GAP_POLICY_INVALID: {self.gap_policy}")
        if self.end_of_replay_policy != "REJECT_OPEN_POSITION":
            raise ValueError(f"REPLAY_CONFIG_END_POLICY_INVALID: {self.end_of_replay_policy}")


# --- ReplayTrade ---

@dataclass(frozen=True)
class ReplayTrade:
    schema_version: str
    trade_index: int
    entry_signal_bar_open_time_ms: int
    exit_signal_bar_open_time_ms: int
    entry_execution_time_ms: int
    exit_execution_time_ms: int
    accounting: TradeAccounting


# --- ReplayResult ---

@dataclass(frozen=True)
class ReplayResult:
    schema_version: str
    symbol: str
    timeframe_ms: int
    dataset_id: str
    instruction_set_id: str
    replay_config_id: str
    capital_model_id: str
    cost_model_id: str
    initial_equity: float
    final_equity: float
    trade_count: int
    trades: tuple[ReplayTrade, ...]
    replay_id: str


# --- Identity helpers ---

def _dataset_id(bars: tuple[ReplayBar, ...], *, symbol: str, timeframe_ms: int) -> str:
    payload = {
        "schemaVersion": REPLAY_BAR_SCHEMA,
        "symbol": symbol,
        "timeframeMs": timeframe_ms,
        "bars": [
            {
                "openTimeMs": b.open_time_ms,
                "open": float(b.open),
                "high": float(b.high),
                "low": float(b.low),
                "close": float(b.close),
                "volume": float(b.volume),
                "closed": b.closed,
            }
            for b in bars
        ],
    }
    return canonical_sha256(payload)


def _instruction_set_id(instructions: tuple[ReplayInstruction, ...]) -> str:
    payload = {
        "schemaVersion": REPLAY_INSTRUCTION_SCHEMA,
        "instructions": [
            {
                "signalBarOpenTimeMs": i.signal_bar_open_time_ms,
                "action": i.action.value,
            }
            for i in instructions
        ],
    }
    return canonical_sha256(payload)


def _replay_config_id(config: ReplayConfig) -> str:
    payload = {
        "schemaVersion": config.schema_version,
        "symbol": config.symbol,
        "timeframeMs": config.timeframe_ms,
        "warmupBars": config.warmup_bars,
        "closedBarsOnly": config.closed_bars_only,
        "nextOpenExecution": config.next_open_execution,
        "gapPolicy": config.gap_policy,
        "endOfReplayPolicy": config.end_of_replay_policy,
    }
    return canonical_sha256(payload)


# --- Main replay function ---

def run_stage5r1_replay(
    *,
    bars: Sequence[ReplayBar],
    instructions: Sequence[ReplayInstruction],
    config: ReplayConfig,
    capital: CapitalModel,
    cost: CostModel,
) -> ReplayResult:
    # --- type checks ---
    if type(config) is not ReplayConfig:
        raise ValueError(f"REPLAY_CONFIG_TYPE_INVALID: {type(config).__name__}")
    if type(capital) is not CapitalModel:
        raise ValueError(f"REPLAY_CAPITAL_MODEL_TYPE_INVALID: {type(capital).__name__}")
    if type(cost) is not CostModel:
        raise ValueError(f"REPLAY_COST_MODEL_TYPE_INVALID: {type(cost).__name__}")

    # --- validate inputs ---
    valid_bars = validate_bar_sequence(bars)
    valid_instructions = validate_instruction_set(instructions, valid_bars, config.warmup_bars)

    # --- build bar lookup ---
    bar_by_time: dict[int, ReplayBar] = {b.open_time_ms: b for b in valid_bars}
    bar_times_sorted = sorted(bar_by_time.keys())

    current_equity = float(capital.initial_equity)
    position_side: PositionSide | None = None
    entry_signal_time: int | None = None
    entry_exec_time: int | None = None
    entry_raw_price: float | None = None
    trades: list[ReplayTrade] = []

    for inst in valid_instructions:
        signal_time = inst.signal_bar_open_time_ms
        signal_idx = bar_times_sorted.index(signal_time)
        exec_time = bar_times_sorted[signal_idx + 1]
        exec_bar = bar_by_time[exec_time]
        exec_price = float(exec_bar.open)

        if inst.action is ReplayAction.ENTER_LONG or inst.action is ReplayAction.ENTER_SHORT:
            if position_side is not None:
                raise ValueError(f"REPLAY_ENTRY_WHILE_OPEN: action={inst.action.value} signal_time={signal_time}")
            position_side = PositionSide.LONG if inst.action is ReplayAction.ENTER_LONG else PositionSide.SHORT
            entry_signal_time = signal_time
            entry_exec_time = exec_time
            entry_raw_price = exec_price
        elif inst.action is ReplayAction.EXIT:
            if position_side is None:
                raise ValueError(f"REPLAY_EXIT_WHILE_FLAT: signal_time={signal_time}")
            if entry_signal_time is None or entry_exec_time is None or entry_raw_price is None:
                raise ValueError("REPLAY_INTERNAL_STATE_CORRUPTED")

            accounting = calculate_trade_accounting(
                side=position_side,
                entry_equity=current_equity,
                raw_entry_price=entry_raw_price,
                raw_exit_price=exec_price,
                entry_time_ms=entry_exec_time,
                exit_time_ms=exec_time,
                capital=capital,
                cost=cost,
            )
            trades.append(ReplayTrade(
                schema_version=REPLAY_TRADE_SCHEMA,
                trade_index=len(trades),
                entry_signal_bar_open_time_ms=entry_signal_time,
                exit_signal_bar_open_time_ms=signal_time,
                entry_execution_time_ms=entry_exec_time,
                exit_execution_time_ms=exec_time,
                accounting=accounting,
            ))
            current_equity = accounting.closing_equity
            position_side = None
            entry_signal_time = None
            entry_exec_time = None
            entry_raw_price = None

    if position_side is not None:
        raise ValueError("REPLAY_END_WITH_OPEN_POSITION")

    ds_id = _dataset_id(valid_bars, symbol=config.symbol, timeframe_ms=config.timeframe_ms)
    is_id = _instruction_set_id(valid_instructions)
    rc_id = _replay_config_id(config)
    cm_id = capital_model_id(capital)
    co_id = cost_model_id(cost)

    replay_id_payload = {
        "schemaVersion": REPLAY_RESULT_SCHEMA,
        "datasetId": ds_id,
        "instructionSetId": is_id,
        "replayConfigId": rc_id,
        "capitalModelId": cm_id,
        "costModelId": co_id,
        "initialEquity": float(capital.initial_equity),
        "finalEquity": float(current_equity),
        "tradeCount": len(trades),
        "accountingIds": [t.accounting.accounting_id for t in trades],
    }
    replay_id = canonical_sha256(replay_id_payload)

    return ReplayResult(
        schema_version=REPLAY_RESULT_SCHEMA,
        symbol=config.symbol,
        timeframe_ms=config.timeframe_ms,
        dataset_id=ds_id,
        instruction_set_id=is_id,
        replay_config_id=rc_id,
        capital_model_id=cm_id,
        cost_model_id=co_id,
        initial_equity=float(capital.initial_equity),
        final_equity=float(current_equity),
        trade_count=len(trades),
        trades=tuple(trades),
        replay_id=replay_id,
    )
