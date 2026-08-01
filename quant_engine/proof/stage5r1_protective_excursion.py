"""Stage 5R1.3-E protective excursion composition contract.

Wraps Stage D protective replay results with causal-execution-frontier
excursion analytics.  Does not modify lower-layer schemas, IDs, or contracts.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Sequence

from quant_engine.proof.stage5r1_capital import (
    CapitalModel, CostModel, PositionSide, TradeAccounting,
    calculate_trade_accounting, capital_model_id, cost_model_id,
)
from quant_engine.proof.stage5r1_replay import (
    ReplayBar, ReplayConfig, ReplayInstruction,
    validate_bar_sequence, validate_instruction_set,
    _dataset_id, _instruction_set_id, _replay_config_id,
)
from quant_engine.proof.stage5r1_protective_exit import (
    ProtectiveExitPlan, ProtectiveExitEvent, ProtectiveExitResolution,
    resolve_protective_exit,
    KIND_GAP_OPEN, KIND_INTRABAR_LEVEL,
    STATUS_TRIGGERED, STATUS_NO_TRIGGER,
)
from quant_engine.proof.stage5r1_protective_replay import (
    ProtectiveReplayBinding, ReplayExitSelection,
    ProtectiveReplayTrade, ProtectiveReplayResult,
    run_stage5r1_protective_replay,
    PROTECTIVE_SOURCE, EXPLICIT_SOURCE,
    _binding_set_id,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

# --- Stage E Schema ---

PROTECTIVE_EXCURSION_WINDOW_POLICY = "PROTECTIVE_CAUSAL_EXECUTION_FRONTIER"
PROTECTIVE_EXCURSION_TIE_POLICY = "EARLIEST_FULL_BAR_THEN_FRONTIER"
PROTECTIVE_EXCURSION_SCHEMA = "stage-5r1.protective-excursion.v1"
PROTECTIVE_EXCURSION_TRADE_SCHEMA = "stage-5r1.protective-excursion-trade.v1"
PROTECTIVE_EXCURSION_RESULT_SCHEMA = "stage-5r1.protective-excursion-result.v1"
OBSERVATION_PATH_SCHEMA = "stage-5r1.protective-observation-path.v1"

# Extreme source labels
SOURCE_FULL_BAR = "FULL_BAR"
SOURCE_FRONTIER_EXIT_OPEN = "FRONTIER_EXIT_OPEN"
SOURCE_FRONTIER_TRIGGER_OPEN = "FRONTIER_TRIGGER_OPEN"
SOURCE_FRONTIER_TRIGGER_LEVEL = "FRONTIER_TRIGGER_LEVEL"

FROZEN_TIMEFRAME_MS = 300_000

_SHA_RE = re.compile(r"^[a-f0-9]{64}$")


def _vsha(v, label):
    if not isinstance(v, str) or not _SHA_RE.fullmatch(v):
        raise ValueError(f"{label}_MALFORMED: {v!r}")


def _vint(v, label):
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"{label}_NOT_INT: {v!r}")
    if v < 0:
        raise ValueError(f"{label}_NEGATIVE: {v}")


def _vpos(v, label):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{label}_NON_NUMERIC: {v!r}")
    if not (float(v) > 0 and float(v) < float("inf")):
        raise ValueError(f"{label}_NOT_POSITIVE_FINITE: {v}")


def _vnonneg_finite(v, label):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{label}_NON_NUMERIC: {v!r}")
    if not math.isfinite(float(v)):
        raise ValueError(f"{label}_NON_FINITE: {v}")
    if float(v) < 0:
        raise ValueError(f"{label}_NEGATIVE: {v}")


# --- Source label validation ---

_EXPLICIT_ALLOWED_SOURCES = frozenset({SOURCE_FULL_BAR, SOURCE_FRONTIER_EXIT_OPEN})
_GAP_OPEN_ALLOWED_SOURCES = frozenset({SOURCE_FULL_BAR, SOURCE_FRONTIER_TRIGGER_OPEN})
_INTRABAR_ALLOWED_SOURCES = frozenset({
    SOURCE_FULL_BAR, SOURCE_FRONTIER_TRIGGER_OPEN, SOURCE_FRONTIER_TRIGGER_LEVEL,
})

_ALLOWED_SOURCE_MAP = {
    (EXPLICIT_SOURCE, None): _EXPLICIT_ALLOWED_SOURCES,
    (PROTECTIVE_SOURCE, KIND_GAP_OPEN): _GAP_OPEN_ALLOWED_SOURCES,
    (PROTECTIVE_SOURCE, KIND_INTRABAR_LEVEL): _INTRABAR_ALLOWED_SOURCES,
}


def _allowed_sources(source: str, trigger_kind: str | None) -> frozenset[str]:
    key = (source, trigger_kind)
    if key in _ALLOWED_SOURCE_MAP:
        return _ALLOWED_SOURCE_MAP[key]
    raise ValueError(f"EXC_UNKNOWN_SOURCE_COMBO: {source}/{trigger_kind}")


# --- Observation path ---

def _observation_path_id(
    bars: tuple[ReplayBar, ...],
    entry_idx: int,
    exit_idx: int,
    full_pre_exit_bar_count: int,
    frontier: list[dict],
    symbol: str,
    timeframe_ms: int,
) -> str:
    payload = {
        "schemaVersion": OBSERVATION_PATH_SCHEMA,
        "symbol": symbol,
        "timeframeMs": timeframe_ms,
        "windowPolicy": PROTECTIVE_EXCURSION_WINDOW_POLICY,
        "entryExecutionTimeMs": bars[entry_idx].open_time_ms,
        "exitExecutionTimeMs": bars[exit_idx].open_time_ms,
        "fullPreExitBarCount": full_pre_exit_bar_count,
        "fullPreExitBars": [
            {
                "openTimeMs": b.open_time_ms, "open": float(b.open),
                "high": float(b.high), "low": float(b.low),
                "close": float(b.close), "closed": b.closed,
            }
            for b in bars[entry_idx:exit_idx]
        ],
        "frontier": frontier,
    }
    return canonical_sha256(payload)


# --- Extrema computation ---

def _compute_extrema(
    full_bars: tuple[ReplayBar, ...],
    frontier: list[dict],
    side: PositionSide,
) -> tuple[float, int, str, float, int, str]:
    candidates: list[tuple[float, int, str]] = []
    for b in full_bars:
        candidates.append((float(b.high), b.open_time_ms, SOURCE_FULL_BAR))
        candidates.append((float(b.low), b.open_time_ms, SOURCE_FULL_BAR))
    for fp in frontier:
        candidates.append((float(fp["price"]), fp["time"], fp["role"]))

    if side is PositionSide.LONG:
        fav_price = max(c[0] for c in candidates)
        adv_price = min(c[0] for c in candidates)
    else:
        fav_price = min(c[0] for c in candidates)
        adv_price = max(c[0] for c in candidates)

    fav_time, fav_source = -1, ""
    for price, t, src in candidates:
        if price == fav_price:
            fav_time, fav_source = t, src
            break
    if fav_time == -1:
        raise ValueError("EXCURSION_FAVORABLE_EXTREME_NOT_FOUND")

    adv_time, adv_source = -1, ""
    for price, t, src in candidates:
        if price == adv_price:
            adv_time, adv_source = t, src
            break
    if adv_time == -1:
        raise ValueError("EXCURSION_ADVERSE_EXTREME_NOT_FOUND")

    return fav_price, fav_time, fav_source, adv_price, adv_time, adv_source


# --- ProtectiveTradeExcursion ---

def _excursion_payload(e: ProtectiveTradeExcursion) -> dict:
    p = {
        "schemaVersion": e.schema_version,
        "windowPolicy": e.window_policy, "tiePolicy": e.tie_policy,
        "symbol": e.symbol, "timeframeMs": e.timeframe_ms,
        "datasetId": e.dataset_id, "instructionSetId": e.instruction_set_id,
        "bindingSetId": e.binding_set_id, "replayConfigId": e.replay_config_id,
        "capitalModelId": e.capital_model_id, "costModelId": e.cost_model_id,
        "baseProtectiveReplayId": e.base_protective_replay_id,
        "baseTradeId": e.base_trade_id,
        "bindingId": e.binding_id, "planId": e.plan_id,
        "protectiveResolutionId": e.protective_resolution_id,
        "selectionId": e.selection_id, "accountingId": e.accounting_id,
        "observationPathId": e.observation_path_id,
        "source": e.source, "side": e.side.value,
        "entryExecutionTimeMs": e.entry_execution_time_ms,
        "exitExecutionTimeMs": e.exit_execution_time_ms,
        "selectedExitBarIndex": e.selected_exit_bar_index,
        "fullPreExitBarCount": e.full_pre_exit_bar_count,
        "exitBarOpenPrice": float(e.exit_bar_open_price),
        "entryFillPrice": float(e.entry_fill_price),
        "quantity": float(e.quantity), "entryEquity": float(e.entry_equity),
        "rawExitPrice": float(e.raw_exit_price),
        "favorableExtremePrice": float(e.favorable_extreme_price),
        "favorableExtremeTimeMs": e.favorable_extreme_time_ms,
        "favorableExtremeSource": e.favorable_extreme_source,
        "adverseExtremePrice": float(e.adverse_extreme_price),
        "adverseExtremeTimeMs": e.adverse_extreme_time_ms,
        "adverseExtremeSource": e.adverse_extreme_source,
        "mfePriceDelta": float(e.mfe_price_delta),
        "maePriceDelta": float(e.mae_price_delta),
        "mfeAmountBeforeExitCosts": float(e.mfe_amount_before_exit_costs),
        "maeAmountBeforeExitCosts": float(e.mae_amount_before_exit_costs),
        "mfeReturnOnEntryEquity": float(e.mfe_return_on_entry_equity),
        "maeReturnOnEntryEquity": float(e.mae_return_on_entry_equity),
        "mfeFractionOfEntryFillPrice": float(e.mfe_fraction_of_entry_fill_price),
        "maeFractionOfEntryFillPrice": float(e.mae_fraction_of_entry_fill_price),
    }
    p["protectiveEventId"] = e.protective_event_id if e.protective_event_id is not None else None
    p["triggerKind"] = e.trigger_kind if e.trigger_kind is not None else None
    return p


@dataclass(frozen=True)
class ProtectiveTradeExcursion:
    schema_version: str
    window_policy: str
    tie_policy: str
    symbol: str
    timeframe_ms: int
    dataset_id: str
    instruction_set_id: str
    binding_set_id: str
    replay_config_id: str
    capital_model_id: str
    cost_model_id: str
    base_protective_replay_id: str
    base_trade_id: str
    binding_id: str
    plan_id: str
    protective_resolution_id: str
    protective_event_id: str | None
    selection_id: str
    accounting_id: str
    observation_path_id: str
    source: str
    trigger_kind: str | None
    side: PositionSide
    entry_execution_time_ms: int
    exit_execution_time_ms: int
    selected_exit_bar_index: int
    full_pre_exit_bar_count: int
    exit_bar_open_price: float
    entry_fill_price: float
    quantity: float
    entry_equity: float
    raw_exit_price: float
    favorable_extreme_price: float
    favorable_extreme_time_ms: int
    favorable_extreme_source: str
    adverse_extreme_price: float
    adverse_extreme_time_ms: int
    adverse_extreme_source: str
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
        # --- Schema & basic validation ---
        if self.schema_version != PROTECTIVE_EXCURSION_SCHEMA:
            raise ValueError("EXC_SCHEMA_INVALID")
        if self.window_policy != PROTECTIVE_EXCURSION_WINDOW_POLICY:
            raise ValueError("EXC_WINDOW_POLICY_INVALID")
        if self.tie_policy != PROTECTIVE_EXCURSION_TIE_POLICY:
            raise ValueError("EXC_TIE_POLICY_INVALID")
        if not self.symbol or not isinstance(self.symbol, str):
            raise ValueError("EXC_SYMBOL_INVALID")
        if type(self.timeframe_ms) is not int or self.timeframe_ms != FROZEN_TIMEFRAME_MS:
            raise ValueError("EXC_TIMEFRAME_INVALID")

        for n in ("dataset_id", "instruction_set_id", "binding_set_id",
                  "replay_config_id", "capital_model_id", "cost_model_id",
                  "base_protective_replay_id", "base_trade_id", "binding_id",
                  "plan_id", "protective_resolution_id", "selection_id",
                  "accounting_id", "observation_path_id", "excursion_id"):
            _vsha(getattr(self, n), f"EXC_{n.upper()}")

        if self.protective_event_id is not None:
            _vsha(self.protective_event_id, "EXC_PROTECTIVE_EVENT_ID")

        if type(self.side) is not PositionSide:
            raise ValueError("EXC_SIDE_INVALID")

        # --- Source validation ---
        if self.source not in (PROTECTIVE_SOURCE, EXPLICIT_SOURCE):
            raise ValueError(f"EXC_SOURCE_INVALID: {self.source}")
        if self.source == EXPLICIT_SOURCE:
            if self.protective_event_id is not None:
                raise ValueError("EXC_EXPLICIT_EVENT_NOT_NULL")
            if self.trigger_kind is not None:
                raise ValueError("EXC_EXPLICIT_TRIGGER_KIND_NOT_NULL")
        else:
            if type(self.protective_event_id) is not str:
                raise ValueError("EXC_PROTECTIVE_EVENT_MISSING")
            if self.trigger_kind not in (KIND_GAP_OPEN, KIND_INTRABAR_LEVEL):
                raise ValueError(f"EXC_TRIGGER_KIND_INVALID: {self.trigger_kind}")

        # --- Trigger-kind cross-source coherence ---
        if self.source == PROTECTIVE_SOURCE:
            if self.trigger_kind == KIND_GAP_OPEN:
                pass  # GAP_OPEN allowed
            elif self.trigger_kind == KIND_INTRABAR_LEVEL:
                pass  # INTRABAR_LEVEL allowed
            else:
                raise ValueError(f"EXC_RESOLUTION_KIND_INVALID: {self.trigger_kind}")

        # --- Times ---
        _vint(self.entry_execution_time_ms, "EXC_ENTRY_TIME")
        _vint(self.exit_execution_time_ms, "EXC_EXIT_TIME")
        if self.exit_execution_time_ms < self.entry_execution_time_ms:
            raise ValueError("EXC_TIME_ORDER_INVALID")
        _vint(self.selected_exit_bar_index, "EXC_SEL_EXIT_IDX")
        _vint(self.favorable_extreme_time_ms, "EXC_FAV_TIME")
        _vint(self.adverse_extreme_time_ms, "EXC_ADV_TIME")
        if self.favorable_extreme_time_ms < self.entry_execution_time_ms:
            raise ValueError("EXC_FAV_TIME_BEFORE_ENTRY")
        if self.favorable_extreme_time_ms > self.exit_execution_time_ms:
            raise ValueError("EXC_FAV_TIME_AFTER_EXIT")
        if self.adverse_extreme_time_ms < self.entry_execution_time_ms:
            raise ValueError("EXC_ADV_TIME_BEFORE_ENTRY")
        if self.adverse_extreme_time_ms > self.exit_execution_time_ms:
            raise ValueError("EXC_ADV_TIME_AFTER_EXIT")

        # --- Bar count ---
        if isinstance(self.full_pre_exit_bar_count, bool) or not isinstance(self.full_pre_exit_bar_count, int):
            raise ValueError("EXC_HOLDING_COUNT_NOT_INT")
        if self.full_pre_exit_bar_count < 0:
            raise ValueError("EXC_HOLDING_COUNT_NEGATIVE")
        expected_span = self.full_pre_exit_bar_count * FROZEN_TIMEFRAME_MS
        actual_span = self.exit_execution_time_ms - self.entry_execution_time_ms
        if actual_span != expected_span:
            raise ValueError(f"EXC_HOLDING_SPAN_MISMATCH: count={self.full_pre_exit_bar_count} span={actual_span} expected={expected_span}")

        # --- Numeric ---
        _vpos(self.entry_fill_price, "EXC_ENTRY_FILL")
        _vpos(self.quantity, "EXC_QUANTITY")
        _vpos(self.entry_equity, "EXC_ENTRY_EQUITY")
        _vpos(self.raw_exit_price, "EXC_RAW_EXIT")
        _vpos(self.exit_bar_open_price, "EXC_EXIT_BAR_OPEN")
        _vpos(self.favorable_extreme_price, "EXC_FAV_PRICE")
        _vpos(self.adverse_extreme_price, "EXC_ADV_PRICE")

        # --- Exit bar open price semantics ---
        if self.source == EXPLICIT_SOURCE:
            if self.exit_bar_open_price != self.raw_exit_price:
                raise ValueError("EXC_EXPLICIT_EXIT_BAR_OPEN_NE_RAW_EXIT")
        if self.source == PROTECTIVE_SOURCE and self.trigger_kind == KIND_GAP_OPEN:
            if self.exit_bar_open_price != self.raw_exit_price:
                raise ValueError("EXC_GAP_EXIT_BAR_OPEN_NE_RAW_EXIT")

        # --- Source label semantics (per excursion type) ---
        allowed = _allowed_sources(self.source, self.trigger_kind)
        if self.favorable_extreme_source not in allowed:
            raise ValueError(f"EXC_FAV_SOURCE_DISALLOWED: {self.favorable_extreme_source} for source={self.source} trigger_kind={self.trigger_kind}")
        if self.adverse_extreme_source not in allowed:
            raise ValueError(f"EXC_ADV_SOURCE_DISALLOWED: {self.adverse_extreme_source} for source={self.source} trigger_kind={self.trigger_kind}")

        if self.full_pre_exit_bar_count == 0:
            if self.favorable_extreme_source == SOURCE_FULL_BAR:
                raise ValueError("EXC_FAV_FULL_BAR_IMPOSSIBLE_ZERO_COUNT")
            if self.adverse_extreme_source == SOURCE_FULL_BAR:
                raise ValueError("EXC_ADV_FULL_BAR_IMPOSSIBLE_ZERO_COUNT")

        # FULL_BAR extreme time < exit time
        if self.favorable_extreme_source == SOURCE_FULL_BAR:
            if self.favorable_extreme_time_ms >= self.exit_execution_time_ms:
                raise ValueError("EXC_FAV_FULL_BAR_TIME_NOT_BEFORE_EXIT")
        if self.adverse_extreme_source == SOURCE_FULL_BAR:
            if self.adverse_extreme_time_ms >= self.exit_execution_time_ms:
                raise ValueError("EXC_ADV_FULL_BAR_TIME_NOT_BEFORE_EXIT")

        # Frontier extreme time == exit time
        if self.favorable_extreme_source in (SOURCE_FRONTIER_EXIT_OPEN, SOURCE_FRONTIER_TRIGGER_OPEN, SOURCE_FRONTIER_TRIGGER_LEVEL):
            if self.favorable_extreme_time_ms != self.exit_execution_time_ms:
                raise ValueError("EXC_FAV_FRONTIER_TIME_NOT_EXIT")
        if self.adverse_extreme_source in (SOURCE_FRONTIER_EXIT_OPEN, SOURCE_FRONTIER_TRIGGER_OPEN, SOURCE_FRONTIER_TRIGGER_LEVEL):
            if self.adverse_extreme_time_ms != self.exit_execution_time_ms:
                raise ValueError("EXC_ADV_FRONTIER_TIME_NOT_EXIT")

        # FRONTIER_EXIT_OPEN price == raw_exit_price AND exit_bar_open_price
        if self.favorable_extreme_source == SOURCE_FRONTIER_EXIT_OPEN:
            if self.favorable_extreme_price != self.raw_exit_price:
                raise ValueError("EXC_FAV_FRONTIER_EXIT_OPEN_PRICE_NOT_RAW_EXIT")
            if self.favorable_extreme_price != self.exit_bar_open_price:
                raise ValueError("EXC_FAV_FRONTIER_EXIT_OPEN_PRICE_NOT_EXIT_BAR_OPEN")
        if self.adverse_extreme_source == SOURCE_FRONTIER_EXIT_OPEN:
            if self.adverse_extreme_price != self.raw_exit_price:
                raise ValueError("EXC_ADV_FRONTIER_EXIT_OPEN_PRICE_NOT_RAW_EXIT")
            if self.adverse_extreme_price != self.exit_bar_open_price:
                raise ValueError("EXC_ADV_FRONTIER_EXIT_OPEN_PRICE_NOT_EXIT_BAR_OPEN")

        # FRONTIER_TRIGGER_OPEN price == exit_bar_open_price (always, including intrabar)
        if self.favorable_extreme_source == SOURCE_FRONTIER_TRIGGER_OPEN:
            if self.favorable_extreme_price != self.exit_bar_open_price:
                raise ValueError("EXC_FAV_TRIGGER_OPEN_PRICE_NOT_EXIT_BAR_OPEN")
        if self.adverse_extreme_source == SOURCE_FRONTIER_TRIGGER_OPEN:
            if self.adverse_extreme_price != self.exit_bar_open_price:
                raise ValueError("EXC_ADV_TRIGGER_OPEN_PRICE_NOT_EXIT_BAR_OPEN")

        # GAP_OPEN: FRONTIER_TRIGGER_OPEN == raw_exit_price too
        if self.source == PROTECTIVE_SOURCE and self.trigger_kind == KIND_GAP_OPEN:
            if self.favorable_extreme_source == SOURCE_FRONTIER_TRIGGER_OPEN:
                if self.favorable_extreme_price != self.raw_exit_price:
                    raise ValueError("EXC_FAV_GAP_TRIGGER_OPEN_PRICE_NOT_RAW_EXIT")
            if self.adverse_extreme_source == SOURCE_FRONTIER_TRIGGER_OPEN:
                if self.adverse_extreme_price != self.raw_exit_price:
                    raise ValueError("EXC_ADV_GAP_TRIGGER_OPEN_PRICE_NOT_RAW_EXIT")

        # FRONTIER_TRIGGER_LEVEL price == raw_exit_price
        if self.favorable_extreme_source == SOURCE_FRONTIER_TRIGGER_LEVEL:
            if self.favorable_extreme_price != self.raw_exit_price:
                raise ValueError("EXC_FAV_TRIGGER_LEVEL_PRICE_NOT_RAW_EXIT")
        if self.adverse_extreme_source == SOURCE_FRONTIER_TRIGGER_LEVEL:
            if self.adverse_extreme_price != self.raw_exit_price:
                raise ValueError("EXC_ADV_TRIGGER_LEVEL_PRICE_NOT_RAW_EXIT")

        # --- Side-consistency ---
        if self.side is PositionSide.LONG:
            if self.favorable_extreme_price < self.adverse_extreme_price:
                raise ValueError("EXC_LONG_FAV_LT_ADV")
        else:
            if self.favorable_extreme_price > self.adverse_extreme_price:
                raise ValueError("EXC_SHORT_FAV_GT_ADV")

        # --- Arithmetic ---
        entry_fill = self.entry_fill_price
        quantity = self.quantity
        entry_eq = self.entry_equity
        if self.side is PositionSide.LONG:
            exp_mfe = max(0.0, self.favorable_extreme_price - entry_fill)
            exp_mae = max(0.0, entry_fill - self.adverse_extreme_price)
        else:
            exp_mfe = max(0.0, entry_fill - self.favorable_extreme_price)
            exp_mae = max(0.0, self.adverse_extreme_price - entry_fill)
        if self.mfe_price_delta != exp_mfe:
            raise ValueError(f"EXC_MFE_DELTA_INCONSISTENT: {self.mfe_price_delta} != {exp_mfe}")
        if self.mae_price_delta != exp_mae:
            raise ValueError(f"EXC_MAE_DELTA_INCONSISTENT: {self.mae_price_delta} != {exp_mae}")
        exp_amt_mfe = quantity * exp_mfe
        exp_amt_mae = quantity * exp_mae
        if self.mfe_amount_before_exit_costs != exp_amt_mfe:
            raise ValueError(f"EXC_MFE_AMOUNT_INCONSISTENT")
        if self.mae_amount_before_exit_costs != exp_amt_mae:
            raise ValueError(f"EXC_MAE_AMOUNT_INCONSISTENT")
        if self.mfe_return_on_entry_equity != exp_amt_mfe / entry_eq:
            raise ValueError(f"EXC_MFE_RETURN_INCONSISTENT")
        if self.mae_return_on_entry_equity != exp_amt_mae / entry_eq:
            raise ValueError(f"EXC_MAE_RETURN_INCONSISTENT")
        if self.mfe_fraction_of_entry_fill_price != exp_mfe / entry_fill:
            raise ValueError(f"EXC_MFE_FRAC_INCONSISTENT")
        if self.mae_fraction_of_entry_fill_price != exp_mae / entry_fill:
            raise ValueError(f"EXC_MAE_FRAC_INCONSISTENT")

        # Non-negative
        for n, v in [("MFE_DELTA", self.mfe_price_delta), ("MAE_DELTA", self.mae_price_delta),
                     ("MFE_AMOUNT", self.mfe_amount_before_exit_costs),
                     ("MAE_AMOUNT", self.mae_amount_before_exit_costs),
                     ("MFE_RETURN", self.mfe_return_on_entry_equity),
                     ("MAE_RETURN", self.mae_return_on_entry_equity),
                     ("MFE_FRAC", self.mfe_fraction_of_entry_fill_price),
                     ("MAE_FRAC", self.mae_fraction_of_entry_fill_price)]:
            _vnonneg_finite(v, f"EXC_{n}")

        # --- Excursion ID ---
        expected = canonical_sha256(_excursion_payload(self))
        if self.excursion_id != expected:
            raise ValueError("EXC_ID_MISMATCH")


# --- ProtectiveExcursionTrade ---

def _composite_trade_payload(t: ProtectiveExcursionTrade) -> dict:
    return {
        "schemaVersion": PROTECTIVE_EXCURSION_TRADE_SCHEMA,
        "baseTradeId": t.base.trade_id,
        "selectionId": t.selection.selection_id,
        "accountingId": t.accounting.accounting_id,
        "excursionId": t.excursion.excursion_id,
        "resolutionId": t.resolution.resolution_id,
        "tradeIndex": t.base.trade_index,
    }


@dataclass(frozen=True)
class ProtectiveExcursionTrade:
    base: ProtectiveReplayTrade
    selection: ReplayExitSelection
    accounting: TradeAccounting
    excursion: ProtectiveTradeExcursion
    resolution: ProtectiveExitResolution
    composite_trade_id: str

    def __post_init__(self) -> None:
        if type(self.base) is not ProtectiveReplayTrade:
            raise ValueError("COMP_TRADE_BASE_TYPE_INVALID")
        if type(self.selection) is not ReplayExitSelection:
            raise ValueError("COMP_TRADE_SEL_TYPE_INVALID")
        if type(self.accounting) is not TradeAccounting:
            raise ValueError("COMP_TRADE_ACCT_TYPE_INVALID")
        if type(self.excursion) is not ProtectiveTradeExcursion:
            raise ValueError("COMP_TRADE_EXC_TYPE_INVALID")
        if type(self.resolution) is not ProtectiveExitResolution:
            raise ValueError("COMP_TRADE_RESOLUTION_TYPE_INVALID")

        exc = self.excursion
        sel = self.selection
        base = self.base
        acct = self.accounting
        res = self.resolution

        # Identity chain
        if sel.selection_id != base.selection_id:
            raise ValueError("COMP_TRADE_SEL_ID_MISMATCH")
        if acct.accounting_id != base.accounting_id:
            raise ValueError("COMP_TRADE_ACCT_ID_MISMATCH")
        if exc.selection_id != base.selection_id:
            raise ValueError("COMP_TRADE_EXC_SEL_ID_MISMATCH")
        if exc.accounting_id != base.accounting_id:
            raise ValueError("COMP_TRADE_EXC_ACCT_ID_MISMATCH")

        # Nested lineage
        if exc.base_trade_id != base.trade_id:
            raise ValueError("COMP_TRADE_EXC_BASE_TRADE_ID_MISMATCH")
        if exc.binding_id != base.binding_id or exc.binding_id != sel.binding_id:
            raise ValueError("COMP_TRADE_EXC_BINDING_ID_MISMATCH")
        if exc.plan_id != sel.plan_id:
            raise ValueError("COMP_TRADE_EXC_PLAN_ID_MISMATCH")
        if exc.protective_resolution_id != sel.protective_resolution_id:
            raise ValueError("COMP_TRADE_EXC_RESOLUTION_ID_MISMATCH")
        if exc.protective_event_id != sel.protective_event_id:
            raise ValueError("COMP_TRADE_EXC_EVENT_ID_MISMATCH")
        if exc.source != sel.source:
            raise ValueError("COMP_TRADE_EXC_SOURCE_MISMATCH")
        if exc.entry_execution_time_ms != sel.entry_execution_time_ms or exc.entry_execution_time_ms != base.entry_execution_time_ms:
            raise ValueError("COMP_TRADE_EXC_ENTRY_TIME_MISMATCH")
        if exc.exit_execution_time_ms != sel.selected_exit_bar_open_time_ms or exc.exit_execution_time_ms != base.selected_exit_bar_open_time_ms:
            raise ValueError("COMP_TRADE_EXC_EXIT_TIME_MISMATCH")
        if exc.selected_exit_bar_index != sel.selected_exit_bar_index:
            raise ValueError("COMP_TRADE_EXC_EXIT_IDX_MISMATCH")
        if exc.raw_exit_price != sel.raw_exit_price:
            raise ValueError("COMP_TRADE_EXC_RAW_EXIT_MISMATCH")
        if exc.side is not acct.side:
            raise ValueError("COMP_TRADE_EXC_SIDE_MISMATCH")
        if exc.entry_fill_price != acct.entry_fill_price:
            raise ValueError("COMP_TRADE_EXC_ENTRY_FILL_MISMATCH")
        if exc.quantity != acct.quantity:
            raise ValueError("COMP_TRADE_EXC_QUANTITY_MISMATCH")
        if exc.entry_equity != acct.entry_equity:
            raise ValueError("COMP_TRADE_EXC_ENTRY_EQUITY_MISMATCH")

        # Resolution lineage
        if res.plan_id != sel.plan_id or res.plan_id != exc.plan_id:
            raise ValueError("COMP_TRADE_RES_PLAN_ID_MISMATCH")
        if res.resolution_id != sel.protective_resolution_id or res.resolution_id != exc.protective_resolution_id:
            raise ValueError("COMP_TRADE_RES_ID_MISMATCH")

        if exc.source == PROTECTIVE_SOURCE:
            if res.status != STATUS_TRIGGERED:
                raise ValueError("COMP_TRADE_RES_NOT_TRIGGERED")
            if type(res.event) is not ProtectiveExitEvent:
                raise ValueError("COMP_TRADE_RES_EVENT_TYPE_INVALID")
            if res.event.event_id != sel.protective_event_id or res.event.event_id != exc.protective_event_id:
                raise ValueError("COMP_TRADE_RES_EVENT_ID_MISMATCH")
            if res.event.trigger_kind != exc.trigger_kind:
                raise ValueError("COMP_TRADE_RES_EVENT_KIND_MISMATCH")
            if res.event.raw_exit_price != sel.raw_exit_price or res.event.raw_exit_price != exc.raw_exit_price:
                raise ValueError("COMP_TRADE_RES_EVENT_PRICE_MISMATCH")
            if res.event.trigger_bar_index != sel.selected_exit_bar_index:
                raise ValueError("COMP_TRADE_RES_EVENT_TRIGGER_IDX_MISMATCH")
            if res.event.trigger_bar_open_time_ms != sel.selected_exit_bar_open_time_ms:
                raise ValueError("COMP_TRADE_RES_EVENT_TRIGGER_TIME_MISMATCH")
        else:
            if res.status != STATUS_NO_TRIGGER:
                raise ValueError("COMP_TRADE_RES_NOT_NO_TRIGGER")
            if res.event is not None:
                raise ValueError("COMP_TRADE_RES_EVENT_NOT_NULL")
            if sel.protective_event_id is not None:
                raise ValueError("COMP_TRADE_SEL_EVENT_NOT_NULL")
            if exc.protective_event_id is not None:
                raise ValueError("COMP_TRADE_EXC_EVENT_NOT_NULL")
            if exc.trigger_kind is not None:
                raise ValueError("COMP_TRADE_EXC_KIND_NOT_NULL")

        _vsha(self.composite_trade_id, "COMP_TRADE_ID")
        expected = canonical_sha256(_composite_trade_payload(self))
        if self.composite_trade_id != expected:
            raise ValueError("COMP_TRADE_ID_MISMATCH")


# --- ProtectiveExcursionResult ---

def _excursion_result_payload(r: ProtectiveExcursionResult) -> dict:
    return {
        "schemaVersion": PROTECTIVE_EXCURSION_RESULT_SCHEMA,
        "baseProtectiveReplayId": r.base_protective_replay_id,
        "symbol": r.symbol, "timeframeMs": r.timeframe_ms,
        "datasetId": r.dataset_id, "instructionSetId": r.instruction_set_id,
        "bindingSetId": r.binding_set_id, "replayConfigId": r.replay_config_id,
        "capitalModelId": r.capital_model_id, "costModelId": r.cost_model_id,
        "tradeCount": r.trade_count,
        "compositeTradeIds": [t.composite_trade_id for t in r.trades],
        "excursionIds": [t.excursion.excursion_id for t in r.trades],
    }


@dataclass(frozen=True)
class ProtectiveExcursionResult:
    base: ProtectiveReplayResult
    base_protective_replay_id: str
    symbol: str
    timeframe_ms: int
    dataset_id: str
    instruction_set_id: str
    binding_set_id: str
    replay_config_id: str
    capital_model_id: str
    cost_model_id: str
    trade_count: int
    trades: tuple[ProtectiveExcursionTrade, ...]
    result_id: str

    def __post_init__(self) -> None:
        if type(self.base) is not ProtectiveReplayResult:
            raise ValueError("RES_BASE_TYPE_INVALID")

        # Exact tuple before iteration
        if type(self.trades) is not tuple:
            raise ValueError("RES_TRADES_NOT_TUPLE")

        # Root field validation against base
        if self.base_protective_replay_id != self.base.replay_id:
            raise ValueError("RES_BASE_REPLAY_ID_MISMATCH")
        if self.symbol != self.base.symbol:
            raise ValueError("RES_SYMBOL_MISMATCH")
        if self.timeframe_ms != self.base.timeframe_ms:
            raise ValueError("RES_TIMEFRAME_MISMATCH")
        if self.dataset_id != self.base.dataset_id:
            raise ValueError("RES_DATASET_ID_MISMATCH")
        if self.instruction_set_id != self.base.instruction_set_id:
            raise ValueError("RES_INSTRUCTION_SET_ID_MISMATCH")
        if self.binding_set_id != self.base.binding_set_id:
            raise ValueError("RES_BINDING_SET_ID_MISMATCH")
        if self.replay_config_id != self.base.replay_config_id:
            raise ValueError("RES_REPLAY_CONFIG_ID_MISMATCH")
        if self.capital_model_id != self.base.capital_model_id:
            raise ValueError("RES_CAPITAL_MODEL_ID_MISMATCH")
        if self.cost_model_id != self.base.cost_model_id:
            raise ValueError("RES_COST_MODEL_ID_MISMATCH")

        # Non-negative exact int trade_count
        if isinstance(self.trade_count, bool) or not isinstance(self.trade_count, int):
            raise ValueError("RES_TRADE_COUNT_NOT_INT")
        if self.trade_count < 0:
            raise ValueError("RES_TRADE_COUNT_NEGATIVE")
        if self.trade_count != self.base.trade_count:
            raise ValueError("RES_TRADE_COUNT_MISMATCH")

        # Count validation
        if len(self.trades) != self.trade_count:
            raise ValueError(f"RES_TRADE_COUNT_LEN_MISMATCH: {len(self.trades)} != {self.trade_count}")
        if len(self.trades) != len(self.base.trades):
            raise ValueError(f"RES_TRADE_BASE_LEN_MISMATCH")
        if len(self.trades) != len(self.base.selections):
            raise ValueError(f"RES_TRADE_SEL_LEN_MISMATCH")

        for i, t in enumerate(self.trades):
            if type(t) is not ProtectiveExcursionTrade:
                raise ValueError(f"RES_TRADE_TYPE_{i}")
            if t.base.trade_index != i:
                raise ValueError(f"RES_TRADE_IDX_{i}")
            if t.base.trade_id != self.base.trades[i].trade_id:
                raise ValueError(f"RES_BASE_TRADE_ID_MISMATCH_{i}")
            if t.selection.selection_id != self.base.selections[i].selection_id:
                raise ValueError(f"RES_BASE_SEL_ID_MISMATCH_{i}")

            # Excursion root IDs must equal result
            if t.excursion.base_protective_replay_id != self.base_protective_replay_id:
                raise ValueError(f"RES_EXC_REPLAY_ID_MISMATCH_{i}")
            if t.excursion.symbol != self.symbol:
                raise ValueError(f"RES_EXC_SYMBOL_MISMATCH_{i}")
            if t.excursion.timeframe_ms != self.timeframe_ms:
                raise ValueError(f"RES_EXC_TIMEFRAME_MISMATCH_{i}")
            if t.excursion.dataset_id != self.dataset_id:
                raise ValueError(f"RES_EXC_DATASET_ID_MISMATCH_{i}")
            if t.excursion.instruction_set_id != self.instruction_set_id:
                raise ValueError(f"RES_EXC_INSTRUCTION_ID_MISMATCH_{i}")
            if t.excursion.binding_set_id != self.binding_set_id:
                raise ValueError(f"RES_EXC_BINDING_ID_MISMATCH_{i}")
            if t.excursion.replay_config_id != self.replay_config_id:
                raise ValueError(f"RES_EXC_CONFIG_ID_MISMATCH_{i}")
            if t.excursion.capital_model_id != self.capital_model_id:
                raise ValueError(f"RES_EXC_CAPITAL_ID_MISMATCH_{i}")
            if t.excursion.cost_model_id != self.cost_model_id:
                raise ValueError(f"RES_EXC_COST_ID_MISMATCH_{i}")

        # SHA
        _vsha(self.base_protective_replay_id, "RES_BASE_REPLAY_ID")
        _vsha(self.dataset_id, "RES_DATASET_ID")
        _vsha(self.instruction_set_id, "RES_INSTRUCTION_SET_ID")
        _vsha(self.binding_set_id, "RES_BINDING_SET_ID")
        _vsha(self.replay_config_id, "RES_REPLAY_CONFIG_ID")
        _vsha(self.capital_model_id, "RES_CAPITAL_MODEL_ID")
        _vsha(self.cost_model_id, "RES_COST_MODEL_ID")
        _vsha(self.result_id, "RES_RESULT_ID")

        if type(self.timeframe_ms) is not int:
            raise ValueError("RES_TIMEFRAME_NOT_INT")

        expected = canonical_sha256(_excursion_result_payload(self))
        if self.result_id != expected:
            raise ValueError("RES_ID_MISMATCH")


# --- Main entry point ---

def run_stage5r1_protective_excursion(
    *, bars, instructions, protective_bindings, config, capital, cost,
) -> ProtectiveExcursionResult:
    if type(config) is not ReplayConfig:
        raise ValueError("CONFIG_TYPE_INVALID")
    if type(capital) is not CapitalModel:
        raise ValueError("CAPITAL_TYPE_INVALID")
    if type(cost) is not CostModel:
        raise ValueError("COST_TYPE_INVALID")

    base_result = run_stage5r1_protective_replay(
        bars=bars, instructions=instructions, protective_bindings=protective_bindings,
        config=config, capital=capital, cost=cost,
    )
    if type(base_result) is not ProtectiveReplayResult:
        raise ValueError("BASE_RESULT_TYPE_INVALID")

    valid_bars = validate_bar_sequence(bars)
    bar_time_to_idx: dict[int, int] = {b.open_time_ms: i for i, b in enumerate(valid_bars)}

    ds_id = _dataset_id(valid_bars, symbol=config.symbol, timeframe_ms=config.timeframe_ms)
    is_id = _instruction_set_id(validate_instruction_set(instructions, valid_bars, config.warmup_bars))
    bs_id = _binding_set_id(protective_bindings)
    rc_id = _replay_config_id(config)
    cm_id = capital_model_id(capital)
    co_id = cost_model_id(cost)

    if ds_id != base_result.dataset_id:
        raise ValueError("ROOT_DATASET_ID_MISMATCH")
    if is_id != base_result.instruction_set_id:
        raise ValueError("ROOT_INSTRUCTION_SET_ID_MISMATCH")
    if bs_id != base_result.binding_set_id:
        raise ValueError("ROOT_BINDING_SET_ID_MISMATCH")
    if rc_id != base_result.replay_config_id:
        raise ValueError("ROOT_REPLAY_CONFIG_ID_MISMATCH")
    if cm_id != base_result.capital_model_id:
        raise ValueError("ROOT_CAPITAL_MODEL_ID_MISMATCH")
    if co_id != base_result.cost_model_id:
        raise ValueError("ROOT_COST_MODEL_ID_MISMATCH")

    current_eq = float(capital.initial_equity)
    comp_trades: list[ProtectiveExcursionTrade] = []

    for trade_idx, (base_trade, base_selection) in enumerate(
        zip(base_result.trades, base_result.selections)
    ):
        entry_idx = bar_time_to_idx[base_selection.entry_execution_time_ms]
        entry_open = float(valid_bars[entry_idx].open)
        raw_exit = base_selection.raw_exit_price
        sel_time = base_selection.selected_exit_bar_open_time_ms

        matching_binding = None
        for b in protective_bindings:
            if type(b) is not ProtectiveReplayBinding:
                raise ValueError("EXC_BINDING_TYPE_INVALID")
            if b.entry_signal_bar_open_time_ms == base_selection.entry_signal_bar_open_time_ms:
                matching_binding = b
                break
        if matching_binding is None:
            raise ValueError("EXC_BINDING_NOT_FOUND")

        side = matching_binding.plan.side
        plan = matching_binding.plan

        accounting = calculate_trade_accounting(
            side=side, entry_equity=current_eq,
            raw_entry_price=entry_open, raw_exit_price=raw_exit,
            entry_time_ms=valid_bars[entry_idx].open_time_ms,
            exit_time_ms=sel_time, capital=capital, cost=cost,
        )

        if accounting.accounting_id != base_trade.accounting_id:
            raise ValueError("EXC_ACCT_ID_MISMATCH")

        exit_sig_idx = bar_time_to_idx[base_selection.paired_exit_signal_bar_open_time_ms]

        if base_selection.source == PROTECTIVE_SOURCE:
            trigger_idx = base_selection.selected_exit_bar_index
            resolution = resolve_protective_exit(
                bars=valid_bars, entry_execution_index=entry_idx,
                last_observation_index=trigger_idx, plan=plan,
                symbol=config.symbol, timeframe_ms=config.timeframe_ms,
            )
            if resolution.resolution_id != base_selection.protective_resolution_id:
                raise ValueError("EXC_RESOLUTION_ID_MISMATCH")
        else:
            resolution = resolve_protective_exit(
                bars=valid_bars, entry_execution_index=entry_idx,
                last_observation_index=exit_sig_idx, plan=plan,
                symbol=config.symbol, timeframe_ms=config.timeframe_ms,
            )
            if resolution.resolution_id != base_selection.protective_resolution_id:
                raise ValueError("EXC_RESOLUTION_ID_MISMATCH_EXPLICIT")

        # Build observation path
        if base_selection.source == PROTECTIVE_SOURCE:
            event = resolution.event
            trigger_idx = base_selection.selected_exit_bar_index
            exit_bar_open = float(valid_bars[trigger_idx].open)
            if event.trigger_kind == KIND_GAP_OPEN:
                full_pre = valid_bars[entry_idx:trigger_idx]
                frontier = [{"time": valid_bars[trigger_idx].open_time_ms, "price": exit_bar_open, "role": SOURCE_FRONTIER_TRIGGER_OPEN}]
            else:
                full_pre = valid_bars[entry_idx:trigger_idx]
                frontier = [
                    {"time": valid_bars[trigger_idx].open_time_ms, "price": exit_bar_open, "role": SOURCE_FRONTIER_TRIGGER_OPEN},
                    {"time": valid_bars[trigger_idx].open_time_ms, "price": float(event.trigger_level_price), "role": SOURCE_FRONTIER_TRIGGER_LEVEL},
                ]
            full_count = trigger_idx - entry_idx
        else:
            exit_idx = base_selection.selected_exit_bar_index
            exit_bar_open = float(valid_bars[exit_idx].open)
            full_pre = valid_bars[entry_idx:exit_idx]
            frontier = [{"time": valid_bars[exit_idx].open_time_ms, "price": exit_bar_open, "role": SOURCE_FRONTIER_EXIT_OPEN}]
            full_count = exit_idx - entry_idx

        obs_path_id = _observation_path_id(
            bars=valid_bars, entry_idx=entry_idx,
            exit_idx=base_selection.selected_exit_bar_index,
            full_pre_exit_bar_count=full_count, frontier=frontier,
            symbol=config.symbol, timeframe_ms=config.timeframe_ms,
        )

        fav_price, fav_time, fav_src, adv_price, adv_time, adv_src = _compute_extrema(
            full_bars=full_pre, frontier=frontier, side=side,
        )

        entry_fill = accounting.entry_fill_price
        quantity = accounting.quantity
        entry_eq = accounting.entry_equity
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

        if base_selection.source == PROTECTIVE_SOURCE:
            tk, pev, pr = resolution.event.trigger_kind, base_selection.protective_event_id, base_selection.protective_resolution_id
        else:
            tk, pev, pr = None, None, base_selection.protective_resolution_id

        exc_payload = _make_excursion_payload_dict(
            symbol=config.symbol, timeframe_ms=config.timeframe_ms,
            ds_id=ds_id, is_id=is_id, bs_id=bs_id, rc_id=rc_id, cm_id=cm_id, co_id=co_id,
            base_replay_id=base_result.replay_id, base_trade_id=base_trade.trade_id,
            binding_id=base_selection.binding_id, plan_id=base_selection.plan_id,
            prot_res_id=pr, prot_evt_id=pev,
            selection_id=base_selection.selection_id, accounting_id=accounting.accounting_id,
            obs_path_id=obs_path_id, source=base_selection.source, side=side,
            entry_time=valid_bars[entry_idx].open_time_ms, exit_time=sel_time,
            exit_bar_idx=base_selection.selected_exit_bar_index, full_count=full_count,
            exit_bar_open=exit_bar_open, entry_fill=entry_fill, quantity=quantity,
            entry_eq=entry_eq, raw_exit=raw_exit,
            fav_price=fav_price, fav_time=fav_time, fav_src=fav_src,
            adv_price=adv_price, adv_time=adv_time, adv_src=adv_src,
            mfe_delta=mfe_delta, mae_delta=mae_delta,
            mfe_amount=mfe_amount, mae_amount=mae_amount,
            mfe_return=mfe_return, mae_return=mae_return,
            mfe_frac=mfe_frac, mae_frac=mae_frac,
            trigger_kind=tk, prot_event_id=pev,
        )
        excursion_id = canonical_sha256(exc_payload)

        excursion = ProtectiveTradeExcursion(
            schema_version=PROTECTIVE_EXCURSION_SCHEMA,
            window_policy=PROTECTIVE_EXCURSION_WINDOW_POLICY,
            tie_policy=PROTECTIVE_EXCURSION_TIE_POLICY,
            symbol=config.symbol, timeframe_ms=config.timeframe_ms,
            dataset_id=ds_id, instruction_set_id=is_id,
            binding_set_id=bs_id, replay_config_id=rc_id,
            capital_model_id=cm_id, cost_model_id=co_id,
            base_protective_replay_id=base_result.replay_id,
            base_trade_id=base_trade.trade_id,
            binding_id=base_selection.binding_id,
            plan_id=base_selection.plan_id,
            protective_resolution_id=pr,
            protective_event_id=pev,
            selection_id=base_selection.selection_id,
            accounting_id=accounting.accounting_id,
            observation_path_id=obs_path_id,
            source=base_selection.source,
            trigger_kind=tk, side=side,
            entry_execution_time_ms=valid_bars[entry_idx].open_time_ms,
            exit_execution_time_ms=sel_time,
            selected_exit_bar_index=base_selection.selected_exit_bar_index,
            full_pre_exit_bar_count=full_count,
            exit_bar_open_price=exit_bar_open,
            entry_fill_price=entry_fill, quantity=quantity, entry_equity=entry_eq,
            raw_exit_price=raw_exit,
            favorable_extreme_price=fav_price, favorable_extreme_time_ms=fav_time,
            favorable_extreme_source=fav_src,
            adverse_extreme_price=adv_price, adverse_extreme_time_ms=adv_time,
            adverse_extreme_source=adv_src,
            mfe_price_delta=mfe_delta, mae_price_delta=mae_delta,
            mfe_amount_before_exit_costs=mfe_amount, mae_amount_before_exit_costs=mae_amount,
            mfe_return_on_entry_equity=mfe_return, mae_return_on_entry_equity=mae_return,
            mfe_fraction_of_entry_fill_price=mfe_frac, mae_fraction_of_entry_fill_price=mae_frac,
            excursion_id=excursion_id,
        )

        comp_tid = canonical_sha256({
            "schemaVersion": PROTECTIVE_EXCURSION_TRADE_SCHEMA,
            "baseTradeId": base_trade.trade_id,
            "selectionId": base_selection.selection_id,
            "accountingId": accounting.accounting_id,
            "excursionId": excursion_id,
            "resolutionId": resolution.resolution_id,
            "tradeIndex": trade_idx,
        })

        comp_trade = ProtectiveExcursionTrade(
            base=base_trade, selection=base_selection,
            accounting=accounting, excursion=excursion,
            resolution=resolution, composite_trade_id=comp_tid,
        )
        comp_trades.append(comp_trade)
        current_eq = accounting.closing_equity

    result_id = canonical_sha256({
        "schemaVersion": PROTECTIVE_EXCURSION_RESULT_SCHEMA,
        "baseProtectiveReplayId": base_result.replay_id,
        "symbol": base_result.symbol, "timeframeMs": base_result.timeframe_ms,
        "datasetId": base_result.dataset_id,
        "instructionSetId": base_result.instruction_set_id,
        "bindingSetId": base_result.binding_set_id,
        "replayConfigId": base_result.replay_config_id,
        "capitalModelId": base_result.capital_model_id,
        "costModelId": base_result.cost_model_id,
        "tradeCount": base_result.trade_count,
        "compositeTradeIds": [t.composite_trade_id for t in comp_trades],
        "excursionIds": [t.excursion.excursion_id for t in comp_trades],
    })

    return ProtectiveExcursionResult(
        base=base_result,
        base_protective_replay_id=base_result.replay_id,
        symbol=base_result.symbol, timeframe_ms=base_result.timeframe_ms,
        dataset_id=base_result.dataset_id,
        instruction_set_id=base_result.instruction_set_id,
        binding_set_id=base_result.binding_set_id,
        replay_config_id=base_result.replay_config_id,
        capital_model_id=base_result.capital_model_id,
        cost_model_id=base_result.cost_model_id,
        trade_count=base_result.trade_count,
        trades=tuple(comp_trades), result_id=result_id,
    )


def _make_excursion_payload_dict(
    *, symbol, timeframe_ms, ds_id, is_id, bs_id, rc_id, cm_id, co_id,
    base_replay_id, base_trade_id, binding_id, plan_id,
    prot_res_id, prot_evt_id, selection_id, accounting_id,
    obs_path_id, source, side, entry_time, exit_time,
    exit_bar_idx, full_count, exit_bar_open,
    entry_fill, quantity, entry_eq, raw_exit,
    fav_price, fav_time, fav_src, adv_price, adv_time, adv_src,
    mfe_delta, mae_delta, mfe_amount, mae_amount,
    mfe_return, mae_return, mfe_frac, mae_frac,
    trigger_kind, prot_event_id,
) -> dict:
    p = {
        "schemaVersion": PROTECTIVE_EXCURSION_SCHEMA,
        "windowPolicy": PROTECTIVE_EXCURSION_WINDOW_POLICY,
        "tiePolicy": PROTECTIVE_EXCURSION_TIE_POLICY,
        "symbol": symbol, "timeframeMs": timeframe_ms,
        "datasetId": ds_id, "instructionSetId": is_id,
        "bindingSetId": bs_id, "replayConfigId": rc_id,
        "capitalModelId": cm_id, "costModelId": co_id,
        "baseProtectiveReplayId": base_replay_id,
        "baseTradeId": base_trade_id,
        "bindingId": binding_id, "planId": plan_id,
        "protectiveResolutionId": prot_res_id,
        "selectionId": selection_id, "accountingId": accounting_id,
        "observationPathId": obs_path_id,
        "source": source, "side": side.value,
        "entryExecutionTimeMs": entry_time,
        "exitExecutionTimeMs": exit_time,
        "selectedExitBarIndex": exit_bar_idx,
        "fullPreExitBarCount": full_count,
        "exitBarOpenPrice": float(exit_bar_open),
        "entryFillPrice": float(entry_fill),
        "quantity": float(quantity), "entryEquity": float(entry_eq),
        "rawExitPrice": float(raw_exit),
        "favorableExtremePrice": float(fav_price),
        "favorableExtremeTimeMs": fav_time,
        "favorableExtremeSource": fav_src,
        "adverseExtremePrice": float(adv_price),
        "adverseExtremeTimeMs": adv_time,
        "adverseExtremeSource": adv_src,
        "mfePriceDelta": float(mfe_delta), "maePriceDelta": float(mae_delta),
        "mfeAmountBeforeExitCosts": float(mfe_amount),
        "maeAmountBeforeExitCosts": float(mae_amount),
        "mfeReturnOnEntryEquity": float(mfe_return),
        "maeReturnOnEntryEquity": float(mae_return),
        "mfeFractionOfEntryFillPrice": float(mfe_frac),
        "maeFractionOfEntryFillPrice": float(mae_frac),
    }
    p["protectiveEventId"] = prot_event_id if prot_event_id is not None else None
    p["triggerKind"] = trigger_kind if trigger_kind is not None else None
    return p


# --- Public verification API ---

def verify_stage5r1_protective_excursion(
    *, result, bars, instructions, protective_bindings, config, capital, cost,
) -> ProtectiveExcursionResult:
    """Authoritative verification boundary for untrusted artifacts.

    Recomputes the Stage E result from authoritative inputs and rejects
    any mismatch.  This closes coherent observation_path_id forgery when
    source data is available.
    """
    if type(result) is not ProtectiveExcursionResult:
        raise ValueError(f"VERIFY_RESULT_TYPE_INVALID: {type(result).__name__}")

    recomputed = run_stage5r1_protective_excursion(
        bars=bars, instructions=instructions,
        protective_bindings=protective_bindings,
        config=config, capital=capital, cost=cost,
    )

    if result.result_id != recomputed.result_id:
        raise ValueError(
            f"VERIFY_RESULT_ID_MISMATCH: supplied={result.result_id} "
            f"recomputed={recomputed.result_id}"
        )

    return recomputed
