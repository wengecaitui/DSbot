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
    REASON_STOP_LOSS, REASON_TAKE_PROFIT,
    STATUS_TRIGGERED, STATUS_NO_TRIGGER,
)
from quant_engine.proof.stage5r1_protective_replay import (
    ProtectiveReplayBinding, ReplayExitSelection,
    ProtectiveReplayTrade, ProtectiveReplayResult,
    run_stage5r1_protective_replay,
    PROTECTIVE_SOURCE, EXPLICIT_SOURCE, EXPLICIT_REASON_VAL,
    ACCOUNTING_TIME_POLICY,
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

# Frontier point roles
ROLE_EXIT_OPEN = "EXIT_OPEN"
ROLE_TRIGGER_OPEN = "TRIGGER_OPEN"
ROLE_TRIGGER_LEVEL = "TRIGGER_LEVEL"

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
    """Causal execution frontier observation path identity.

    full_pre_exit_bars = bars[entry_idx:exit_idx] — the exit_idx bar itself
    is NEVER in full pre-exit bars.  The frontier carries what is observable
    on the exit bar.
    """
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
                "openTimeMs": b.open_time_ms,
                "open": float(b.open),
                "high": float(b.high),
                "low": float(b.low),
                "close": float(b.close),
                "closed": b.closed,
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
    """Return (fav_price, fav_time, fav_source, adv_price, adv_time, adv_source).

    Scans full bars chronologically first, then frontier in order.
    Earliest match wins per the tie policy.
    """
    # Candidates: (price, time_ms, source_label)
    candidates: list[tuple[float, int, str]] = []

    # Full bars
    for b in full_bars:
        candidates.append((float(b.high), b.open_time_ms, SOURCE_FULL_BAR))
        candidates.append((float(b.low), b.open_time_ms, SOURCE_FULL_BAR))

    # Frontier points
    for fp in frontier:
        candidates.append((float(fp["price"]), fp["time"], fp["role"]))

    if side is PositionSide.LONG:
        # favorable = max price, adverse = min price
        fav_price = max(c[0] for c in candidates)
        adv_price = min(c[0] for c in candidates)
    else:
        # favorable = min price, adverse = max price
        fav_price = min(c[0] for c in candidates)
        adv_price = max(c[0] for c in candidates)

    # Earliest tie: scan candidates in insertion order, take first match
    fav_time = -1
    fav_source = ""
    for price, t, src in candidates:
        if price == fav_price:
            fav_time = t
            fav_source = src
            break
    if fav_time == -1:
        raise ValueError("EXCURSION_FAVORABLE_EXTREME_NOT_FOUND")

    adv_time = -1
    adv_source = ""
    for price, t, src in candidates:
        if price == adv_price:
            adv_time = t
            adv_source = src
            break
    if adv_time == -1:
        raise ValueError("EXCURSION_ADVERSE_EXTREME_NOT_FOUND")

    return fav_price, fav_time, fav_source, adv_price, adv_time, adv_source


# --- ProtectiveTradeExcursion ---

def _excursion_payload(e: ProtectiveTradeExcursion) -> dict:
    p = {
        "schemaVersion": e.schema_version,
        "windowPolicy": e.window_policy,
        "tiePolicy": e.tie_policy,
        "symbol": e.symbol,
        "timeframeMs": e.timeframe_ms,
        "datasetId": e.dataset_id,
        "instructionSetId": e.instruction_set_id,
        "bindingSetId": e.binding_set_id,
        "replayConfigId": e.replay_config_id,
        "capitalModelId": e.capital_model_id,
        "costModelId": e.cost_model_id,
        "baseProtectiveReplayId": e.base_protective_replay_id,
        "baseTradeId": e.base_trade_id,
        "bindingId": e.binding_id,
        "planId": e.plan_id,
        "protectiveResolutionId": e.protective_resolution_id,
        "selectionId": e.selection_id,
        "accountingId": e.accounting_id,
        "observationPathId": e.observation_path_id,
        "source": e.source,
        "side": e.side.value,
        "entryExecutionTimeMs": e.entry_execution_time_ms,
        "exitExecutionTimeMs": e.exit_execution_time_ms,
        "selectedExitBarIndex": e.selected_exit_bar_index,
        "fullPreExitBarCount": e.full_pre_exit_bar_count,
        "entryFillPrice": float(e.entry_fill_price),
        "quantity": float(e.quantity),
        "entryEquity": float(e.entry_equity),
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
    if e.protective_event_id is not None:
        p["protectiveEventId"] = e.protective_event_id
    else:
        p["protectiveEventId"] = None
    if e.trigger_kind is not None:
        p["triggerKind"] = e.trigger_kind
    else:
        p["triggerKind"] = None
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

        # SHA-256 validations
        for n in ("dataset_id", "instruction_set_id", "binding_set_id",
                  "replay_config_id", "capital_model_id", "cost_model_id",
                  "base_protective_replay_id", "base_trade_id", "binding_id",
                  "plan_id", "protective_resolution_id", "selection_id",
                  "accounting_id", "observation_path_id", "excursion_id"):
            _vsha(getattr(self, n), f"EXC_{n.upper()}")

        # Nullable SHAs
        if self.protective_event_id is not None:
            _vsha(self.protective_event_id, "EXC_PROTECTIVE_EVENT_ID")

        # Side
        if type(self.side) is not PositionSide:
            raise ValueError("EXC_SIDE_INVALID")

        # Source
        if self.source not in (PROTECTIVE_SOURCE, EXPLICIT_SOURCE):
            raise ValueError(f"EXC_SOURCE_INVALID: {self.source}")
        if self.source == EXPLICIT_SOURCE:
            if self.protective_event_id is not None:
                raise ValueError("EXC_EXPLICIT_EVENT_NOT_NULL")
            if self.trigger_kind is not None:
                raise ValueError("EXC_EXPLICIT_TRIGGER_KIND_NOT_NULL")
            if self.raw_exit_price != float(self.raw_exit_price):
                pass  # already float
        else:
            if type(self.protective_event_id) is not str:
                raise ValueError("EXC_PROTECTIVE_EVENT_MISSING")
            if self.trigger_kind not in (KIND_GAP_OPEN, KIND_INTRABAR_LEVEL):
                raise ValueError(f"EXC_TRIGGER_KIND_INVALID: {self.trigger_kind}")

        # Times
        _vint(self.entry_execution_time_ms, "EXC_ENTRY_TIME")
        _vint(self.exit_execution_time_ms, "EXC_EXIT_TIME")
        if self.exit_execution_time_ms < self.entry_execution_time_ms:
            raise ValueError("EXC_TIME_ORDER_INVALID")

        _vint(self.selected_exit_bar_index, "EXC_SEL_EXIT_IDX")
        _vint(self.favorable_extreme_time_ms, "EXC_FAV_TIME")
        _vint(self.adverse_extreme_time_ms, "EXC_ADV_TIME")

        # full_pre_exit_bar_count
        if isinstance(self.full_pre_exit_bar_count, bool) or not isinstance(self.full_pre_exit_bar_count, int):
            raise ValueError("EXC_HOLDING_COUNT_NOT_INT")
        if self.full_pre_exit_bar_count < 0:
            raise ValueError("EXC_HOLDING_COUNT_NEGATIVE")

        # Time span consistency
        expected_span = self.full_pre_exit_bar_count * FROZEN_TIMEFRAME_MS
        actual_span = self.exit_execution_time_ms - self.entry_execution_time_ms
        if actual_span != expected_span:
            raise ValueError(
                f"EXC_HOLDING_SPAN_MISMATCH: count={self.full_pre_exit_bar_count} "
                f"span={actual_span} expected={expected_span}"
            )

        # Numeric validations
        _vpos(self.entry_fill_price, "EXC_ENTRY_FILL")
        _vpos(self.quantity, "EXC_QUANTITY")
        _vpos(self.entry_equity, "EXC_ENTRY_EQUITY")
        _vpos(self.raw_exit_price, "EXC_RAW_EXIT")
        _vpos(self.favorable_extreme_price, "EXC_FAV_PRICE")
        _vpos(self.adverse_extreme_price, "EXC_ADV_PRICE")

        _vnonneg_finite(self.mfe_price_delta, "EXC_MFE_DELTA")
        _vnonneg_finite(self.mae_price_delta, "EXC_MAE_DELTA")
        _vnonneg_finite(self.mfe_amount_before_exit_costs, "EXC_MFE_AMOUNT")
        _vnonneg_finite(self.mae_amount_before_exit_costs, "EXC_MAE_AMOUNT")
        _vnonneg_finite(self.mfe_return_on_entry_equity, "EXC_MFE_RETURN")
        _vnonneg_finite(self.mae_return_on_entry_equity, "EXC_MAE_RETURN")
        _vnonneg_finite(self.mfe_fraction_of_entry_fill_price, "EXC_MFE_FRAC")
        _vnonneg_finite(self.mae_fraction_of_entry_fill_price, "EXC_MAE_FRAC")

        # Source labels
        if self.favorable_extreme_source not in (
            SOURCE_FULL_BAR, SOURCE_FRONTIER_EXIT_OPEN,
            SOURCE_FRONTIER_TRIGGER_OPEN, SOURCE_FRONTIER_TRIGGER_LEVEL,
        ):
            raise ValueError(f"EXC_FAV_SOURCE_INVALID: {self.favorable_extreme_source}")
        if self.adverse_extreme_source not in (
            SOURCE_FULL_BAR, SOURCE_FRONTIER_EXIT_OPEN,
            SOURCE_FRONTIER_TRIGGER_OPEN, SOURCE_FRONTIER_TRIGGER_LEVEL,
        ):
            raise ValueError(f"EXC_ADV_SOURCE_INVALID: {self.adverse_extreme_source}")

        # Excursion ID
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
        "tradeIndex": t.base.trade_index,
    }


@dataclass(frozen=True)
class ProtectiveExcursionTrade:
    base: ProtectiveReplayTrade
    selection: ReplayExitSelection
    accounting: TradeAccounting
    excursion: ProtectiveTradeExcursion
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

        # Cross-object consistency
        if self.selection.selection_id != self.base.selection_id:
            raise ValueError("COMP_TRADE_SEL_ID_MISMATCH")
        if self.accounting.accounting_id != self.base.accounting_id:
            raise ValueError("COMP_TRADE_ACCT_ID_MISMATCH")
        if self.excursion.selection_id != self.base.selection_id:
            raise ValueError("COMP_TRADE_EXC_SEL_ID_MISMATCH")
        if self.excursion.accounting_id != self.base.accounting_id:
            raise ValueError("COMP_TRADE_EXC_ACCT_ID_MISMATCH")

        _vsha(self.composite_trade_id, "COMP_TRADE_ID")
        expected = canonical_sha256(_composite_trade_payload(self))
        if self.composite_trade_id != expected:
            raise ValueError("COMP_TRADE_ID_MISMATCH")


# --- ProtectiveExcursionResult ---

def _excursion_result_payload(r: ProtectiveExcursionResult) -> dict:
    return {
        "schemaVersion": PROTECTIVE_EXCURSION_RESULT_SCHEMA,
        "baseReplayId": r.base.replay_id,
        "symbol": r.base.symbol,
        "timeframeMs": r.base.timeframe_ms,
        "datasetId": r.base.dataset_id,
        "instructionSetId": r.base.instruction_set_id,
        "bindingSetId": r.base.binding_set_id,
        "replayConfigId": r.base.replay_config_id,
        "capitalModelId": r.base.capital_model_id,
        "costModelId": r.base.cost_model_id,
        "tradeCount": r.base.trade_count,
        "compositeTradeIds": [t.composite_trade_id for t in r.trades],
        "excursionIds": [t.excursion.excursion_id for t in r.trades],
    }


@dataclass(frozen=True)
class ProtectiveExcursionResult:
    base: ProtectiveReplayResult
    trades: tuple[ProtectiveExcursionTrade, ...]
    result_id: str

    def __post_init__(self) -> None:
        if type(self.base) is not ProtectiveReplayResult:
            raise ValueError("RES_BASE_TYPE_INVALID")
        if type(self.trades) is not tuple:
            raise ValueError("RES_TRADES_NOT_TUPLE")
        for i, t in enumerate(self.trades):
            if type(t) is not ProtectiveExcursionTrade:
                raise ValueError(f"RES_TRADE_TYPE_{i}")
            if t.base.trade_index != i:
                raise ValueError(f"RES_TRADE_IDX_{i}")
            # Verify base trade IDs match
            if t.base.trade_id != self.base.trades[i].trade_id:
                raise ValueError(f"RES_BASE_TRADE_ID_MISMATCH_{i}")
            if t.selection.selection_id != self.base.selections[i].selection_id:
                raise ValueError(f"RES_BASE_SEL_ID_MISMATCH_{i}")

        _vsha(self.result_id, "RES_RESULT_ID")
        expected = canonical_sha256(_excursion_result_payload(self))
        if self.result_id != expected:
            raise ValueError("RES_ID_MISMATCH")


# --- Main entry point ---

def run_stage5r1_protective_excursion(
    *,
    bars,
    instructions,
    protective_bindings,
    config,
    capital,
    cost,
) -> ProtectiveExcursionResult:
    """Run Stage D protective replay, then compose Stage E excursion analytics.

    Calls run_stage5r1_protective_replay unchanged.  Recomputes and
    independently verifies every TradeAccounting and ProtectiveExitResolution
    before computing causal-execution-frontier excursion metrics.
    """
    # --- Exact type checks at boundary ---
    if type(config) is not ReplayConfig:
        raise ValueError("CONFIG_TYPE_INVALID")
    if type(capital) is not CapitalModel:
        raise ValueError("CAPITAL_TYPE_INVALID")
    if type(cost) is not CostModel:
        raise ValueError("COST_TYPE_INVALID")

    # --- Run Stage D unchanged ---
    base_result = run_stage5r1_protective_replay(
        bars=bars,
        instructions=instructions,
        protective_bindings=protective_bindings,
        config=config,
        capital=capital,
        cost=cost,
    )

    # --- Validate base result type ---
    if type(base_result) is not ProtectiveReplayResult:
        raise ValueError("BASE_RESULT_TYPE_INVALID")

    # --- Setup: bar index lookup ---
    valid_bars = validate_bar_sequence(bars)
    bar_time_to_idx: dict[int, int] = {}
    for i, b in enumerate(valid_bars):
        bar_time_to_idx[b.open_time_ms] = i

    # --- Setup: identity helper values ---
    ds_id = _dataset_id(valid_bars, symbol=config.symbol, timeframe_ms=config.timeframe_ms)
    is_id = _instruction_set_id(validate_instruction_set(instructions, valid_bars, config.warmup_bars))
    bs_id = _binding_set_id(base_result.trades) if len(base_result.trades) == 0 else (
        # Reconstruct binding set ID from the bindings passed in
        _build_binding_set_id(protective_bindings)
    )
    rc_id = _replay_config_id(config)
    cm_id = capital_model_id(capital)
    co_id = cost_model_id(cost)

    # --- Process each trade ---
    current_eq = float(capital.initial_equity)
    comp_trades: list[ProtectiveExcursionTrade] = []

    for trade_idx, (base_trade, base_selection) in enumerate(
        zip(base_result.trades, base_result.selections)
    ):
        entry_idx = bar_time_to_idx[base_selection.entry_execution_time_ms]

        # --- Recompute and verify TradeAccounting ---
        entry_open = float(valid_bars[entry_idx].open)
        raw_exit = base_selection.raw_exit_price
        sel_time = base_selection.selected_exit_bar_open_time_ms

        # Find the binding for this trade to get side
        matching_binding = None
        for b in protective_bindings:
            if type(b) is not ProtectiveReplayBinding:
                continue
            if b.entry_signal_bar_open_time_ms == base_selection.entry_signal_bar_open_time_ms:
                matching_binding = b
                break
        if matching_binding is None:
            raise ValueError("EXC_BINDING_NOT_FOUND")

        side = matching_binding.plan.side
        plan = matching_binding.plan

        accounting = calculate_trade_accounting(
            side=side,
            entry_equity=current_eq,
            raw_entry_price=entry_open,
            raw_exit_price=raw_exit,
            entry_time_ms=valid_bars[entry_idx].open_time_ms,
            exit_time_ms=sel_time,
            capital=capital,
            cost=cost,
        )

        # --- Verify accounting lineage ---
        if accounting.raw_entry_price != entry_open:
            raise ValueError("EXC_ACCT_ENTRY_MISMATCH")
        if accounting.raw_exit_price != raw_exit:
            raise ValueError("EXC_ACCT_EXIT_MISMATCH")
        if accounting.side is not side:
            raise ValueError("EXC_ACCT_SIDE_MISMATCH")
        if accounting.accounting_id != base_trade.accounting_id:
            raise ValueError(
                f"EXC_ACCT_ID_MISMATCH: {accounting.accounting_id} != {base_trade.accounting_id}"
            )

        # --- Recompute and verify ProtectiveExitResolution ---
        exit_sig_idx = bar_time_to_idx[base_selection.paired_exit_signal_bar_open_time_ms]

        # For protective exits, resolve up to the trigger bar
        if base_selection.source == PROTECTIVE_SOURCE:
            trigger_idx = base_selection.selected_exit_bar_index
            resolution = resolve_protective_exit(
                bars=valid_bars,
                entry_execution_index=entry_idx,
                last_observation_index=trigger_idx,
                plan=plan,
                symbol=config.symbol,
                timeframe_ms=config.timeframe_ms,
            )
            if resolution.status != STATUS_TRIGGERED:
                raise ValueError("EXC_RESOLUTION_NOT_TRIGGERED")
            if resolution.resolution_id != base_selection.protective_resolution_id:
                raise ValueError("EXC_RESOLUTION_ID_MISMATCH")
            if resolution.event is None:
                raise ValueError("EXC_RESOLUTION_EVENT_NONE")
            if resolution.event.event_id != base_selection.protective_event_id:
                raise ValueError("EXC_EVENT_ID_MISMATCH")
            if resolution.event.raw_exit_price != base_selection.raw_exit_price:
                raise ValueError("EXC_EVENT_RAW_EXIT_MISMATCH")
            if resolution.event.trigger_kind not in (KIND_GAP_OPEN, KIND_INTRABAR_LEVEL):
                raise ValueError("EXC_EVENT_TRIGGER_KIND_INVALID")
        else:
            # No-trigger explicit — resolve up to exit signal bar, expect NO_TRIGGER
            resolution = resolve_protective_exit(
                bars=valid_bars,
                entry_execution_index=entry_idx,
                last_observation_index=exit_sig_idx,
                plan=plan,
                symbol=config.symbol,
                timeframe_ms=config.timeframe_ms,
            )
            if resolution.status != STATUS_NO_TRIGGER:
                raise ValueError("EXC_RESOLUTION_SHOULD_BE_NO_TRIGGER")
            if resolution.resolution_id != base_selection.protective_resolution_id:
                raise ValueError("EXC_RESOLUTION_ID_MISMATCH_EXPLICIT")
            if base_selection.protective_event_id is not None:
                raise ValueError("EXC_EXPLICIT_EVENT_NOT_NULL_EXPECTED")

        # --- Build observation path ---
        if base_selection.source == PROTECTIVE_SOURCE:
            event = resolution.event
            trigger_idx = base_selection.selected_exit_bar_index

            if event.trigger_kind == KIND_GAP_OPEN:
                full_pre_exit_bars = valid_bars[entry_idx:trigger_idx]
                frontier = [{
                    "time": valid_bars[trigger_idx].open_time_ms,
                    "price": float(valid_bars[trigger_idx].open),
                    "role": SOURCE_FRONTIER_TRIGGER_OPEN,
                }]
                full_count = trigger_idx - entry_idx
            else:  # INTRABAR_LEVEL
                full_pre_exit_bars = valid_bars[entry_idx:trigger_idx]
                frontier = [
                    {
                        "time": valid_bars[trigger_idx].open_time_ms,
                        "price": float(valid_bars[trigger_idx].open),
                        "role": SOURCE_FRONTIER_TRIGGER_OPEN,
                    },
                    {
                        "time": valid_bars[trigger_idx].open_time_ms,
                        "price": float(event.trigger_level_price),
                        "role": SOURCE_FRONTIER_TRIGGER_LEVEL,
                    },
                ]
                full_count = trigger_idx - entry_idx
        else:  # EXPLICIT_SOURCE
            exit_idx = base_selection.selected_exit_bar_index
            full_pre_exit_bars = valid_bars[entry_idx:exit_idx]
            frontier = [{
                "time": valid_bars[exit_idx].open_time_ms,
                "price": float(valid_bars[exit_idx].open),
                "role": SOURCE_FRONTIER_EXIT_OPEN,
            }]
            full_count = exit_idx - entry_idx

        obs_path_id = _observation_path_id(
            bars=valid_bars,
            entry_idx=entry_idx,
            exit_idx=(base_selection.selected_exit_bar_index
                      if base_selection.source == PROTECTIVE_SOURCE
                      else base_selection.selected_exit_bar_index),
            full_pre_exit_bar_count=full_count,
            frontier=frontier,
            symbol=config.symbol,
            timeframe_ms=config.timeframe_ms,
        )

        # --- Compute extrema ---
        fav_price, fav_time, fav_src, adv_price, adv_time, adv_src = _compute_extrema(
            full_bars=full_pre_exit_bars,
            frontier=frontier,
            side=side,
        )

        # --- Compute MFE/MAE ---
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

        # --- Build ProtectiveTradeExcursion ---
        if base_selection.source == PROTECTIVE_SOURCE:
            trigger_kind = resolution.event.trigger_kind
            prot_event_id = base_selection.protective_event_id
            prot_res_id = base_selection.protective_resolution_id
        else:
            trigger_kind = None
            prot_event_id = None
            prot_res_id = base_selection.protective_resolution_id

        exc_payload = {
            "schemaVersion": PROTECTIVE_EXCURSION_SCHEMA,
            "windowPolicy": PROTECTIVE_EXCURSION_WINDOW_POLICY,
            "tiePolicy": PROTECTIVE_EXCURSION_TIE_POLICY,
            "symbol": config.symbol,
            "timeframeMs": config.timeframe_ms,
            "datasetId": ds_id,
            "instructionSetId": is_id,
            "bindingSetId": bs_id,
            "replayConfigId": rc_id,
            "capitalModelId": cm_id,
            "costModelId": co_id,
            "baseProtectiveReplayId": base_result.replay_id,
            "baseTradeId": base_trade.trade_id,
            "bindingId": base_selection.binding_id,
            "planId": base_selection.plan_id,
            "protectiveResolutionId": prot_res_id,
            "selectionId": base_selection.selection_id,
            "accountingId": accounting.accounting_id,
            "observationPathId": obs_path_id,
            "source": base_selection.source,
            "side": side.value,
            "entryExecutionTimeMs": valid_bars[entry_idx].open_time_ms,
            "exitExecutionTimeMs": sel_time,
            "selectedExitBarIndex": base_selection.selected_exit_bar_index,
            "fullPreExitBarCount": full_count,
            "entryFillPrice": float(entry_fill),
            "quantity": float(quantity),
            "entryEquity": float(entry_eq),
            "rawExitPrice": float(raw_exit),
            "favorableExtremePrice": float(fav_price),
            "favorableExtremeTimeMs": fav_time,
            "favorableExtremeSource": fav_src,
            "adverseExtremePrice": float(adv_price),
            "adverseExtremeTimeMs": adv_time,
            "adverseExtremeSource": adv_src,
            "mfePriceDelta": float(mfe_delta),
            "maePriceDelta": float(mae_delta),
            "mfeAmountBeforeExitCosts": float(mfe_amount),
            "maeAmountBeforeExitCosts": float(mae_amount),
            "mfeReturnOnEntryEquity": float(mfe_return),
            "maeReturnOnEntryEquity": float(mae_return),
            "mfeFractionOfEntryFillPrice": float(mfe_frac),
            "maeFractionOfEntryFillPrice": float(mae_frac),
        }
        if prot_event_id is not None:
            exc_payload["protectiveEventId"] = prot_event_id
        else:
            exc_payload["protectiveEventId"] = None
        if trigger_kind is not None:
            exc_payload["triggerKind"] = trigger_kind
        else:
            exc_payload["triggerKind"] = None

        excursion_id = canonical_sha256(exc_payload)

        excursion = ProtectiveTradeExcursion(
            schema_version=PROTECTIVE_EXCURSION_SCHEMA,
            window_policy=PROTECTIVE_EXCURSION_WINDOW_POLICY,
            tie_policy=PROTECTIVE_EXCURSION_TIE_POLICY,
            symbol=config.symbol,
            timeframe_ms=config.timeframe_ms,
            dataset_id=ds_id,
            instruction_set_id=is_id,
            binding_set_id=bs_id,
            replay_config_id=rc_id,
            capital_model_id=cm_id,
            cost_model_id=co_id,
            base_protective_replay_id=base_result.replay_id,
            base_trade_id=base_trade.trade_id,
            binding_id=base_selection.binding_id,
            plan_id=base_selection.plan_id,
            protective_resolution_id=prot_res_id,
            protective_event_id=prot_event_id,
            selection_id=base_selection.selection_id,
            accounting_id=accounting.accounting_id,
            observation_path_id=obs_path_id,
            source=base_selection.source,
            trigger_kind=trigger_kind,
            side=side,
            entry_execution_time_ms=valid_bars[entry_idx].open_time_ms,
            exit_execution_time_ms=sel_time,
            selected_exit_bar_index=base_selection.selected_exit_bar_index,
            full_pre_exit_bar_count=full_count,
            entry_fill_price=entry_fill,
            quantity=quantity,
            entry_equity=entry_eq,
            raw_exit_price=raw_exit,
            favorable_extreme_price=fav_price,
            favorable_extreme_time_ms=fav_time,
            favorable_extreme_source=fav_src,
            adverse_extreme_price=adv_price,
            adverse_extreme_time_ms=adv_time,
            adverse_extreme_source=adv_src,
            mfe_price_delta=mfe_delta,
            mae_price_delta=mae_delta,
            mfe_amount_before_exit_costs=mfe_amount,
            mae_amount_before_exit_costs=mae_amount,
            mfe_return_on_entry_equity=mfe_return,
            mae_return_on_entry_equity=mae_return,
            mfe_fraction_of_entry_fill_price=mfe_frac,
            mae_fraction_of_entry_fill_price=mae_frac,
            excursion_id=excursion_id,
        )

        # --- Build composite trade ---
        comp_tid = canonical_sha256({
            "schemaVersion": PROTECTIVE_EXCURSION_TRADE_SCHEMA,
            "baseTradeId": base_trade.trade_id,
            "selectionId": base_selection.selection_id,
            "accountingId": accounting.accounting_id,
            "excursionId": excursion_id,
            "tradeIndex": trade_idx,
        })

        comp_trade = ProtectiveExcursionTrade(
            base=base_trade,
            selection=base_selection,
            accounting=accounting,
            excursion=excursion,
            composite_trade_id=comp_tid,
        )
        comp_trades.append(comp_trade)
        current_eq = accounting.closing_equity

    # --- Build result ---
    result_id = canonical_sha256({
        "schemaVersion": PROTECTIVE_EXCURSION_RESULT_SCHEMA,
        "baseReplayId": base_result.replay_id,
        "symbol": base_result.symbol,
        "timeframeMs": base_result.timeframe_ms,
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
        trades=tuple(comp_trades),
        result_id=result_id,
    )


def _build_binding_set_id(bindings) -> str:
    """Reconstruct binding set ID from bindings."""
    from quant_engine.proof.stage5r1_protective_replay import _binding_set_id as _bsi
    return _bsi(bindings)
