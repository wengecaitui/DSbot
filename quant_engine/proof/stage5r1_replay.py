"""Stage 5R1 deterministic replay — excursion ledger with two-level identity."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from enum import Enum
from typing import Sequence

from quant_engine.proof.stage5r1_capital import (
    CapitalModel, CostModel, PositionSide, TradeAccounting,
    calculate_trade_accounting, capital_model_id, cost_model_id,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

# --- Schema ---

REPLAY_BAR_SCHEMA = "stage-5r1.replay-bar.v1"
REPLAY_CONFIG_SCHEMA = "stage-5r1.replay-config.v1"
REPLAY_INSTRUCTION_SCHEMA = "stage-5r1.replay-instruction.v1"
REPLAY_TRADE_SCHEMA = "stage-5r1.replay-trade.v2"
TRADE_EXCURSION_SCHEMA = "stage-5r1.trade-excursion.v1"
HOLDING_PATH_SCHEMA = "stage-5r1.holding-path.v1"
REPLAY_RESULT_SCHEMA = "stage-5r1.replay-result.v2"

FROZEN_TIMEFRAME_MS = 300_000
EXCURSION_WINDOW_POLICY = "ENTRY_FULL_INTERMEDIATE_FULL_EXIT_OPEN_ONLY"
EXCURSION_TIE_POLICY = "EARLIEST_BAR"

_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")

def _validate_sha256(value: str, label: str) -> None:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{label}_MALFORMED: {value!r}")


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
            raise ValueError(f"REPLAY_BAR_OPEN_OUT_OF_RANGE")
        if not (self.low <= self.close <= self.high):
            raise ValueError(f"REPLAY_BAR_CLOSE_OUT_OF_RANGE")


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
        if curr.open_time_ms - prev.open_time_ms != FROZEN_TIMEFRAME_MS:
            raise ValueError(f"REPLAY_BAR_TIME_GAP: index={i}")
    return tuple(bars)


# --- Actions / Instructions / Config (unchanged from 3-A) ---

class ReplayAction(str, Enum):
    ENTER_LONG = "enter_long"
    ENTER_SHORT = "enter_short"
    EXIT = "exit"


@dataclass(frozen=True)
class ReplayInstruction:
    schema_version: str = REPLAY_INSTRUCTION_SCHEMA
    signal_bar_open_time_ms: int = 0
    action: ReplayAction = ReplayAction.ENTER_LONG

    def __post_init__(self) -> None:
        if self.schema_version != REPLAY_INSTRUCTION_SCHEMA:
            raise ValueError(f"REPLAY_INSTRUCTION_SCHEMA_INVALID")
        if not isinstance(self.action, ReplayAction):
            raise ValueError(f"REPLAY_INSTRUCTION_ACTION_INVALID")
        if isinstance(self.signal_bar_open_time_ms, bool) or not isinstance(self.signal_bar_open_time_ms, int):
            raise ValueError(f"REPLAY_INSTRUCTION_TIME_NOT_INT")
        if self.signal_bar_open_time_ms < 0:
            raise ValueError(f"REPLAY_INSTRUCTION_TIME_NEGATIVE")


def validate_instruction_set(
    instructions: Sequence[ReplayInstruction], bars: tuple[ReplayBar, ...], warmup_bars: int = 100,
) -> tuple[ReplayInstruction, ...]:
    if not isinstance(instructions, Sequence) or isinstance(instructions, (str, bytes)):
        raise ValueError("REPLAY_INSTRUCTION_SET_NOT_SEQUENCE")
    valid_bars = validate_bar_sequence(bars)
    if isinstance(warmup_bars, bool) or not isinstance(warmup_bars, int):
        raise ValueError(f"REPLAY_WARMUP_NOT_INT")
    if warmup_bars <= 0:
        raise ValueError(f"REPLAY_WARMUP_NOT_POSITIVE")
    bar_times = {b.open_time_ms for b in valid_bars}
    seen: set[int] = set()
    prev: int | None = None
    for i, inst in enumerate(instructions):
        if type(inst) is not ReplayInstruction:
            raise ValueError(f"REPLAY_INSTRUCTION_TYPE_INVALID_AT_{i}")
        t = inst.signal_bar_open_time_ms
        if t in seen:
            raise ValueError(f"REPLAY_INSTRUCTION_DUPLICATE_TIME: {t}")
        seen.add(t)
        if prev is not None and t <= prev:
            raise ValueError(f"REPLAY_INSTRUCTION_NOT_SORTED")
        prev = t
        if t not in bar_times:
            raise ValueError(f"REPLAY_INSTRUCTION_UNKNOWN_BAR: {t}")
        if t == valid_bars[-1].open_time_ms:
            raise ValueError(f"REPLAY_INSTRUCTION_ON_FINAL_BAR: {t}")
        bt = sorted(bar_times)
        if bt.index(t) < warmup_bars - 1:
            raise ValueError(f"REPLAY_INSTRUCTION_BEFORE_WARMUP")
    return tuple(instructions)


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
            raise ValueError(f"REPLAY_CONFIG_SCHEMA_INVALID")
        if not self.symbol or not isinstance(self.symbol, str):
            raise ValueError(f"REPLAY_CONFIG_SYMBOL_INVALID")
        if type(self.timeframe_ms) is not int or self.timeframe_ms != FROZEN_TIMEFRAME_MS:
            raise ValueError(f"REPLAY_CONFIG_TIMEFRAME_INVALID")
        if isinstance(self.warmup_bars, bool) or not isinstance(self.warmup_bars, int):
            raise ValueError(f"REPLAY_CONFIG_WARMUP_NOT_INT")
        if self.warmup_bars <= 0:
            raise ValueError(f"REPLAY_CONFIG_WARMUP_NOT_POSITIVE")
        if self.closed_bars_only is not True:
            raise ValueError(f"REPLAY_CONFIG_CLOSED_BARS_WEAKENED")
        if self.next_open_execution is not True:
            raise ValueError(f"REPLAY_CONFIG_NEXT_OPEN_WEAKENED")
        if self.gap_policy != "REJECT":
            raise ValueError(f"REPLAY_CONFIG_GAP_POLICY_INVALID")
        if self.end_of_replay_policy != "REJECT_OPEN_POSITION":
            raise ValueError(f"REPLAY_CONFIG_END_POLICY_INVALID")


# --- Holding Path ---

def _holding_path_id(
    bars: tuple[ReplayBar, ...], entry_idx: int, exit_idx: int, symbol: str, timeframe_ms: int,
) -> str:
    full_bars = bars[entry_idx:exit_idx]
    exit_open = bars[exit_idx].open
    payload = {
        "schemaVersion": HOLDING_PATH_SCHEMA,
        "symbol": symbol,
        "timeframeMs": timeframe_ms,
        "windowPolicy": EXCURSION_WINDOW_POLICY,
        "entryExecutionTimeMs": bars[entry_idx].open_time_ms,
        "exitExecutionTimeMs": bars[exit_idx].open_time_ms,
        "fullBars": [
            {"openTimeMs": b.open_time_ms, "open": float(b.open), "high": float(b.high),
             "low": float(b.low), "close": float(b.close), "closed": b.closed}
            for b in full_bars
        ],
        "exitOpen": {"openTimeMs": bars[exit_idx].open_time_ms, "open": float(exit_open)},
    }
    return canonical_sha256(payload)


# --- TradeExcursion ---

def _validate_positive_finite(value: float, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label}_NON_NUMERIC: {value!r}")
    if not math.isfinite(float(value)):
        raise ValueError(f"{label}_NON_FINITE: {value}")
    if float(value) <= 0:
        raise ValueError(f"{label}_NOT_POSITIVE: {value}")


def _validate_non_negative_finite(value: float, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label}_NON_NUMERIC: {value!r}")
    if not math.isfinite(float(value)):
        raise ValueError(f"{label}_NON_FINITE: {value}")
    if float(value) < 0:
        raise ValueError(f"{label}_NEGATIVE: {value}")


def _validate_int(value: int, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label}_NOT_INT: {value!r}")
    if value < 0:
        raise ValueError(f"{label}_NEGATIVE: {value}")


@dataclass(frozen=True)
class TradeExcursion:
    schema_version: str
    window_policy: str
    tie_policy: str
    symbol: str
    timeframe_ms: int
    dataset_id: str
    holding_path_id: str
    accounting_id: str
    side: PositionSide
    entry_execution_time_ms: int
    exit_execution_time_ms: int
    full_holding_bar_count: int
    entry_fill_price: float
    quantity: float
    entry_equity: float
    favorable_extreme_price: float
    favorable_extreme_bar_open_time_ms: int
    adverse_extreme_price: float
    adverse_extreme_bar_open_time_ms: int
    mfe_price_delta: float
    mae_price_delta: float
    mfe_amount_before_exit_costs: float
    mae_amount_before_exit_costs: float
    mfe_return_on_entry_equity: float
    mae_return_on_entry_equity: float
    mfe_fraction_of_entry_fill_price: float
    mae_fraction_of_entry_fill_price: float
    excursion_id: str

    def __post_init__(self) -> None:
        if self.schema_version != TRADE_EXCURSION_SCHEMA:
            raise ValueError(f"EXCURSION_SCHEMA_INVALID: {self.schema_version}")
        if self.window_policy != EXCURSION_WINDOW_POLICY:
            raise ValueError(f"EXCURSION_WINDOW_POLICY_INVALID: {self.window_policy}")
        if self.tie_policy != EXCURSION_TIE_POLICY:
            raise ValueError(f"EXCURSION_TIE_POLICY_INVALID: {self.tie_policy}")
        if not self.symbol or not isinstance(self.symbol, str):
            raise ValueError(f"EXCURSION_SYMBOL_INVALID: {self.symbol!r}")
        if type(self.timeframe_ms) is not int or self.timeframe_ms != FROZEN_TIMEFRAME_MS:
            raise ValueError(f"EXCURSION_TIMEFRAME_INVALID: {self.timeframe_ms}")
        if not isinstance(self.side, PositionSide):
            raise ValueError(f"EXCURSION_SIDE_INVALID")

        _validate_sha256(self.dataset_id, "EXCURSION_DATASET_ID")
        _validate_sha256(self.holding_path_id, "EXCURSION_HOLDING_PATH_ID")
        _validate_sha256(self.accounting_id, "EXCURSION_ACCOUNTING_ID")
        _validate_sha256(self.excursion_id, "EXCURSION_EXCURSION_ID")

        _validate_int(self.entry_execution_time_ms, "EXCURSION_ENTRY_TIME")
        _validate_int(self.exit_execution_time_ms, "EXCURSION_EXIT_TIME")
        if self.exit_execution_time_ms <= self.entry_execution_time_ms:
            raise ValueError(f"EXCURSION_TIME_ORDER_INVALID")

        if isinstance(self.full_holding_bar_count, bool) or not isinstance(self.full_holding_bar_count, int):
            raise ValueError(f"EXCURSION_HOLDING_COUNT_NOT_INT")
        if self.full_holding_bar_count <= 0:
            raise ValueError(f"EXCURSION_HOLDING_COUNT_NOT_POSITIVE")

        expected_span = self.full_holding_bar_count * FROZEN_TIMEFRAME_MS
        actual_span = self.exit_execution_time_ms - self.entry_execution_time_ms
        if actual_span != expected_span:
            raise ValueError(f"EXCURSION_HOLDING_SPAN_MISMATCH: count={self.full_holding_bar_count} span={actual_span} expected={expected_span}")

        _validate_positive_finite(self.entry_fill_price, "EXCURSION_ENTRY_FILL")
        _validate_positive_finite(self.quantity, "EXCURSION_QUANTITY")
        _validate_positive_finite(self.entry_equity, "EXCURSION_ENTRY_EQUITY")
        _validate_positive_finite(self.favorable_extreme_price, "EXCURSION_FAV_PRICE")
        _validate_positive_finite(self.adverse_extreme_price, "EXCURSION_ADV_PRICE")

        _validate_int(self.favorable_extreme_bar_open_time_ms, "EXCURSION_FAV_TIME")
        _validate_int(self.adverse_extreme_bar_open_time_ms, "EXCURSION_ADV_TIME")

        _validate_non_negative_finite(self.mfe_price_delta, "EXCURSION_MFE_DELTA")
        _validate_non_negative_finite(self.mae_price_delta, "EXCURSION_MAE_DELTA")
        _validate_non_negative_finite(self.mfe_amount_before_exit_costs, "EXCURSION_MFE_AMOUNT")
        _validate_non_negative_finite(self.mae_amount_before_exit_costs, "EXCURSION_MAE_AMOUNT")
        _validate_non_negative_finite(self.mfe_return_on_entry_equity, "EXCURSION_MFE_RETURN")
        _validate_non_negative_finite(self.mae_return_on_entry_equity, "EXCURSION_MAE_RETURN")
        _validate_non_negative_finite(self.mfe_fraction_of_entry_fill_price, "EXCURSION_MFE_FRAC")
        _validate_non_negative_finite(self.mae_fraction_of_entry_fill_price, "EXCURSION_MAE_FRAC")


# --- Excursion calculation ---

def _verify_accounting_lineage(
    accounting: TradeAccounting, entry_exec_time_ms: int, exit_exec_time_ms: int,
    entry_open: float, exit_open: float,
) -> None:
    if type(accounting) is not TradeAccounting:
        raise ValueError(f"EXCURSION_ACCOUNTING_TYPE_INVALID")
    if accounting.raw_entry_price != entry_open:
        raise ValueError(f"EXCURSION_RAW_ENTRY_MISMATCH: {accounting.raw_entry_price} != {entry_open}")
    if accounting.raw_exit_price != exit_open:
        raise ValueError(f"EXCURSION_RAW_EXIT_MISMATCH: {accounting.raw_exit_price} != {exit_open}")
    if type(accounting.side) is not PositionSide:
        raise ValueError(f"EXCURSION_ACCOUNTING_SIDE_INVALID")

    expected_payload = {
        "tradeAccountingSchemaVersion": accounting.trade_accounting_schema_version,
        "capitalModelId": accounting.capital_model_id,
        "costModelId": accounting.cost_model_id,
        "side": accounting.side.value,
        "entryEquity": float(accounting.entry_equity),
        "rawEntryPrice": float(accounting.raw_entry_price),
        "rawExitPrice": float(accounting.raw_exit_price),
        "entryTimeMs": entry_exec_time_ms,
        "exitTimeMs": exit_exec_time_ms,
    }
    expected_id = canonical_sha256(expected_payload)
    if expected_id != accounting.accounting_id:
        raise ValueError(f"EXCURSION_ACCOUNTING_LINEAGE_MISMATCH")


def _earliest_extreme_time(
    bars: tuple[ReplayBar, ...], entry_idx: int, exit_idx: int,
    target_price: float, side: PositionSide, is_favorable: bool,
) -> int:
    for i in range(entry_idx, exit_idx):
        b = bars[i]
        if side is PositionSide.LONG:
            found = (is_favorable and float(b.high) == target_price) or (not is_favorable and float(b.low) == target_price)
        else:
            found = (is_favorable and float(b.low) == target_price) or (not is_favorable and float(b.high) == target_price)
        if found:
            return b.open_time_ms
    if float(bars[exit_idx].open) == target_price:
        return bars[exit_idx].open_time_ms
    raise ValueError("EXCURSION_EXTREME_NOT_FOUND")


def _calculate_trade_excursion(
    *, bars: tuple[ReplayBar, ...], entry_exec_index: int, exit_exec_index: int,
    accounting: TradeAccounting, dataset_id: str, symbol: str, timeframe_ms: int,
) -> TradeExcursion:
    valid_bars = validate_bar_sequence(bars)
    if entry_exec_index < 0 or exit_exec_index >= len(valid_bars):
        raise ValueError(f"EXCURSION_INDEX_OUT_OF_RANGE")
    if exit_exec_index <= entry_exec_index:
        raise ValueError(f"EXCURSION_INDEX_INVALID")

    entry_open = float(valid_bars[entry_exec_index].open)
    exit_open = float(valid_bars[exit_exec_index].open)
    _verify_accounting_lineage(accounting, valid_bars[entry_exec_index].open_time_ms, valid_bars[exit_exec_index].open_time_ms, entry_open, exit_open)

    side = accounting.side
    entry_fill = accounting.entry_fill_price
    quantity = accounting.quantity
    entry_eq = accounting.entry_equity

    full_bars = valid_bars[entry_exec_index:exit_exec_index]
    all_highs = [float(b.high) for b in full_bars] + [exit_open]
    all_lows = [float(b.low) for b in full_bars] + [exit_open]

    if side is PositionSide.LONG:
        fav_price = max(all_highs)
        adv_price = min(all_lows)
    else:
        fav_price = min(all_lows)
        adv_price = max(all_highs)

    fav_time = _earliest_extreme_time(valid_bars, entry_exec_index, exit_exec_index, fav_price, side, True)
    adv_time = _earliest_extreme_time(valid_bars, entry_exec_index, exit_exec_index, adv_price, side, False)

    if side is PositionSide.LONG:
        mfe_delta = max(0.0, fav_price - entry_fill)
        mae_delta = max(0.0, entry_fill - adv_price)
    else:
        mfe_delta = max(0.0, entry_fill - fav_price)
        mae_delta = max(0.0, adv_price - entry_fill)

    mfe_amount = quantity * mfe_delta
    mae_amount = quantity * mae_delta
    mfe_return = mfe_amount / entry_eq
    mae_return = mae_amount / entry_eq
    mfe_frac = mfe_delta / entry_fill
    mae_frac = mae_delta / entry_fill

    hp_id = _holding_path_id(valid_bars, entry_exec_index, exit_exec_index, symbol, timeframe_ms)

    identity_payload = {
        "schemaVersion": TRADE_EXCURSION_SCHEMA,
        "windowPolicy": EXCURSION_WINDOW_POLICY,
        "tiePolicy": EXCURSION_TIE_POLICY,
        "symbol": symbol,
        "timeframeMs": timeframe_ms,
        "datasetId": dataset_id,
        "holdingPathId": hp_id,
        "accountingId": accounting.accounting_id,
        "side": side.value,
        "entryExecutionTimeMs": valid_bars[entry_exec_index].open_time_ms,
        "exitExecutionTimeMs": valid_bars[exit_exec_index].open_time_ms,
        "fullHoldingBarCount": len(full_bars),
        "entryFillPrice": float(entry_fill),
        "quantity": float(quantity),
        "entryEquity": float(entry_eq),
        "favorableExtremePrice": float(fav_price),
        "favorableExtremeBarOpenTimeMs": fav_time,
        "adverseExtremePrice": float(adv_price),
        "adverseExtremeBarOpenTimeMs": adv_time,
        "mfePriceDelta": float(mfe_delta), "maePriceDelta": float(mae_delta),
        "mfeAmountBeforeExitCosts": float(mfe_amount), "maeAmountBeforeExitCosts": float(mae_amount),
        "mfeReturnOnEntryEquity": float(mfe_return), "maeReturnOnEntryEquity": float(mae_return),
        "mfeFractionOfEntryFillPrice": float(mfe_frac), "maeFractionOfEntryFillPrice": float(mae_frac),
    }
    excursion_id = canonical_sha256(identity_payload)

    return TradeExcursion(
        schema_version=TRADE_EXCURSION_SCHEMA, window_policy=EXCURSION_WINDOW_POLICY,
        tie_policy=EXCURSION_TIE_POLICY, symbol=symbol, timeframe_ms=timeframe_ms,
        dataset_id=dataset_id, holding_path_id=hp_id, accounting_id=accounting.accounting_id,
        side=side, entry_execution_time_ms=valid_bars[entry_exec_index].open_time_ms,
        exit_execution_time_ms=valid_bars[exit_exec_index].open_time_ms,
        full_holding_bar_count=len(full_bars),
        entry_fill_price=entry_fill, quantity=quantity, entry_equity=entry_eq,
        favorable_extreme_price=fav_price, favorable_extreme_bar_open_time_ms=fav_time,
        adverse_extreme_price=adv_price, adverse_extreme_bar_open_time_ms=adv_time,
        mfe_price_delta=mfe_delta, mae_price_delta=mae_delta,
        mfe_amount_before_exit_costs=mfe_amount, mae_amount_before_exit_costs=mae_amount,
        mfe_return_on_entry_equity=mfe_return, mae_return_on_entry_equity=mae_return,
        mfe_fraction_of_entry_fill_price=mfe_frac, mae_fraction_of_entry_fill_price=mae_frac,
        excursion_id=excursion_id,
    )


# --- ReplayTrade / ReplayResult ---

@dataclass(frozen=True)
class ReplayTrade:
    schema_version: str; trade_index: int
    entry_signal_bar_open_time_ms: int; exit_signal_bar_open_time_ms: int
    entry_execution_time_ms: int; exit_execution_time_ms: int
    accounting: TradeAccounting; excursion: TradeExcursion


@dataclass(frozen=True)
class ReplayResult:
    schema_version: str; symbol: str; timeframe_ms: int
    dataset_id: str; instruction_set_id: str; replay_config_id: str
    capital_model_id: str; cost_model_id: str
    initial_equity: float; final_equity: float; trade_count: int
    trades: tuple[ReplayTrade, ...]; replay_id: str


# --- Identity helpers ---

def _dataset_id(bars: tuple[ReplayBar, ...], *, symbol: str, timeframe_ms: int) -> str:
    payload = {
        "schemaVersion": REPLAY_BAR_SCHEMA, "symbol": symbol, "timeframeMs": timeframe_ms,
        "bars": [
            {"openTimeMs": b.open_time_ms, "open": float(b.open), "high": float(b.high),
             "low": float(b.low), "close": float(b.close), "volume": float(b.volume),
             "closed": b.closed}
            for b in bars
        ],
    }
    return canonical_sha256(payload)


def _instruction_set_id(instructions: tuple[ReplayInstruction, ...]) -> str:
    return canonical_sha256({
        "schemaVersion": REPLAY_INSTRUCTION_SCHEMA,
        "instructions": [{"signalBarOpenTimeMs": i.signal_bar_open_time_ms, "action": i.action.value} for i in instructions],
    })


def _replay_config_id(config: ReplayConfig) -> str:
    return canonical_sha256({
        "schemaVersion": config.schema_version, "symbol": config.symbol, "timeframeMs": config.timeframe_ms,
        "warmupBars": config.warmup_bars, "closedBarsOnly": config.closed_bars_only,
        "nextOpenExecution": config.next_open_execution, "gapPolicy": config.gap_policy,
        "endOfReplayPolicy": config.end_of_replay_policy,
    })


def _replay_result_id(
    *, ds_id: str, is_id: str, rc_id: str, cm_id: str, co_id: str,
    initial_eq: float, final_eq: float, trade_count: int,
    accounting_ids: list[str], excursion_ids: list[str],
) -> str:
    return canonical_sha256({
        "schemaVersion": REPLAY_RESULT_SCHEMA, "datasetId": ds_id, "instructionSetId": is_id,
        "replayConfigId": rc_id, "capitalModelId": cm_id, "costModelId": co_id,
        "initialEquity": float(initial_eq), "finalEquity": float(final_eq),
        "tradeCount": trade_count, "accountingIds": accounting_ids, "excursionIds": excursion_ids,
    })


# --- Main replay ---

def run_stage5r1_replay(
    *, bars: Sequence[ReplayBar], instructions: Sequence[ReplayInstruction],
    config: ReplayConfig, capital: CapitalModel, cost: CostModel,
) -> ReplayResult:
    if type(config) is not ReplayConfig:
        raise ValueError(f"REPLAY_CONFIG_TYPE_INVALID")
    if type(capital) is not CapitalModel:
        raise ValueError(f"REPLAY_CAPITAL_MODEL_TYPE_INVALID")
    if type(cost) is not CostModel:
        raise ValueError(f"REPLAY_COST_MODEL_TYPE_INVALID")

    valid_bars = validate_bar_sequence(bars)
    valid_instructions = validate_instruction_set(instructions, valid_bars, config.warmup_bars)
    bar_by_time = {b.open_time_ms: b for b in valid_bars}
    bt = sorted(bar_by_time)

    current_eq = float(capital.initial_equity)
    pos: PositionSide | None = None
    entry_sig: int | None = None; entry_idx: int | None = None; entry_raw: float | None = None
    trades: list[ReplayTrade] = []
    ds_id = _dataset_id(valid_bars, symbol=config.symbol, timeframe_ms=config.timeframe_ms)

    for inst in valid_instructions:
        si = bt.index(inst.signal_bar_open_time_ms)
        ei = si + 1; et = bt[ei]; eb = bar_by_time[et]; ep = float(eb.open)

        if inst.action in (ReplayAction.ENTER_LONG, ReplayAction.ENTER_SHORT):
            if pos is not None:
                raise ValueError(f"REPLAY_ENTRY_WHILE_OPEN")
            pos = PositionSide.LONG if inst.action is ReplayAction.ENTER_LONG else PositionSide.SHORT
            entry_sig, entry_idx, entry_raw = inst.signal_bar_open_time_ms, ei, ep
        else:  # EXIT
            if pos is None: raise ValueError(f"REPLAY_EXIT_WHILE_FLAT")
            assert entry_idx is not None and entry_raw is not None and entry_sig is not None
            acct = calculate_trade_accounting(side=pos, entry_equity=current_eq, raw_entry_price=entry_raw, raw_exit_price=ep, entry_time_ms=bt[entry_idx], exit_time_ms=et, capital=capital, cost=cost)
            exc = _calculate_trade_excursion(bars=valid_bars, entry_exec_index=entry_idx, exit_exec_index=ei, accounting=acct, dataset_id=ds_id, symbol=config.symbol, timeframe_ms=config.timeframe_ms)
            trades.append(ReplayTrade(schema_version=REPLAY_TRADE_SCHEMA, trade_index=len(trades), entry_signal_bar_open_time_ms=entry_sig, exit_signal_bar_open_time_ms=inst.signal_bar_open_time_ms, entry_execution_time_ms=bt[entry_idx], exit_execution_time_ms=et, accounting=acct, excursion=exc))
            current_eq = acct.closing_equity
            pos = entry_sig = entry_idx = entry_raw = None

    if pos is not None: raise ValueError("REPLAY_END_WITH_OPEN_POSITION")

    is_id = _instruction_set_id(valid_instructions)
    rc_id = _replay_config_id(config)
    cm_id = capital_model_id(capital); co_id = cost_model_id(cost)
    rid = _replay_result_id(ds_id=ds_id, is_id=is_id, rc_id=rc_id, cm_id=cm_id, co_id=co_id, initial_eq=float(capital.initial_equity), final_eq=float(current_eq), trade_count=len(trades), accounting_ids=[t.accounting.accounting_id for t in trades], excursion_ids=[t.excursion.excursion_id for t in trades])
    return ReplayResult(schema_version=REPLAY_RESULT_SCHEMA, symbol=config.symbol, timeframe_ms=config.timeframe_ms, dataset_id=ds_id, instruction_set_id=is_id, replay_config_id=rc_id, capital_model_id=cm_id, cost_model_id=co_id, initial_equity=float(capital.initial_equity), final_equity=float(current_eq), trade_count=len(trades), trades=tuple(trades), replay_id=rid)
