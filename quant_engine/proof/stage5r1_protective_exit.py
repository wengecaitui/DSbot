"""Stage 5R1.3-C deterministic protective exit resolution.

Pure, offline resolver for fixed stop-loss and take-profit levels.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Sequence

from quant_engine.proof.stage5r1_capital import PositionSide
from quant_engine.proof.stage5r1_replay import ReplayBar, validate_bar_sequence
from quant_engine.proof.stage5_evaluation import canonical_sha256

# --- Schema ---

PROTECTIVE_EXIT_PLAN_SCHEMA = "stage-5r1.protective-exit-plan.v1"
PROTECTIVE_OBSERVATION_PATH_SCHEMA = "stage-5r1.protective-observation-path.v1"
PROTECTIVE_EXIT_EVENT_SCHEMA = "stage-5r1.protective-exit-event.v1"
PROTECTIVE_EXIT_RESOLUTION_SCHEMA = "stage-5r1.protective-exit-resolution.v1"

FROZEN_TIMEFRAME_MS = 300_000
GAP_FILL_POLICY = "BAR_OPEN"
INTRABAR_FILL_POLICY = "LEVEL_PRICE"
SAME_BAR_COLLISION_POLICY = "STOP_FIRST_CONSERVATIVE"
SCAN_POLICY = "ENTRY_BAR_INTRABAR_ONLY_THEN_OPEN_FIRST"

REASON_STOP_LOSS = "STOP_LOSS"
REASON_TAKE_PROFIT = "TAKE_PROFIT"
KIND_GAP_OPEN = "GAP_OPEN"
KIND_INTRABAR_LEVEL = "INTRABAR_LEVEL"
STATUS_TRIGGERED = "TRIGGERED"
STATUS_NO_TRIGGER = "NO_TRIGGER"


def _validate_price(value: float, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"PROTECTIVE_{label}_NON_NUMERIC: {value!r}")
    if not math.isfinite(float(value)):
        raise ValueError(f"PROTECTIVE_{label}_NON_FINITE: {value}")
    if float(value) <= 0:
        raise ValueError(f"PROTECTIVE_{label}_NOT_POSITIVE: {value}")


# --- ProtectiveExitPlan ---

@dataclass(frozen=True)
class ProtectiveExitPlan:
    schema_version: str
    side: PositionSide
    entry_reference_price: float
    stop_price: float
    take_profit_price: float
    gap_fill_policy: str
    intrabar_fill_policy: str
    same_bar_collision_policy: str
    scan_policy: str
    plan_id: str

    def __init__(
        self,
        *,
        side: PositionSide,
        entry_reference_price: float,
        stop_price: float,
        take_profit_price: float,
        schema_version: str = PROTECTIVE_EXIT_PLAN_SCHEMA,
        gap_fill_policy: str = GAP_FILL_POLICY,
        intrabar_fill_policy: str = INTRABAR_FILL_POLICY,
        same_bar_collision_policy: str = SAME_BAR_COLLISION_POLICY,
        scan_policy: str = SCAN_POLICY,
    ) -> None:
        if schema_version != PROTECTIVE_EXIT_PLAN_SCHEMA:
            raise ValueError(f"PROTECTIVE_PLAN_SCHEMA_INVALID: {schema_version}")
        if not isinstance(side, PositionSide):
            raise ValueError(f"PROTECTIVE_PLAN_SIDE_INVALID: {side!r}")
        if gap_fill_policy != GAP_FILL_POLICY:
            raise ValueError(f"PROTECTIVE_PLAN_GAP_POLICY_INVALID: {gap_fill_policy}")
        if intrabar_fill_policy != INTRABAR_FILL_POLICY:
            raise ValueError(f"PROTECTIVE_PLAN_INTRABAR_POLICY_INVALID")
        if same_bar_collision_policy != SAME_BAR_COLLISION_POLICY:
            raise ValueError(f"PROTECTIVE_PLAN_COLLISION_POLICY_INVALID")
        if scan_policy != SCAN_POLICY:
            raise ValueError(f"PROTECTIVE_PLAN_SCAN_POLICY_INVALID")

        _validate_price(entry_reference_price, "ENTRY_REF")
        _validate_price(stop_price, "STOP")
        _validate_price(take_profit_price, "TARGET")

        if side is PositionSide.LONG:
            if not (stop_price < entry_reference_price < take_profit_price):
                raise ValueError(f"PROTECTIVE_PLAN_LONG_ORDER_INVALID")
        else:
            if not (take_profit_price < entry_reference_price < stop_price):
                raise ValueError(f"PROTECTIVE_PLAN_SHORT_ORDER_INVALID")

        plan_id = canonical_sha256({
            "schemaVersion": schema_version,
            "side": side.value,
            "entryReferencePrice": float(entry_reference_price),
            "stopPrice": float(stop_price),
            "takeProfitPrice": float(take_profit_price),
            "gapFillPolicy": gap_fill_policy,
            "intrabarFillPolicy": intrabar_fill_policy,
            "sameBarCollisionPolicy": same_bar_collision_policy,
            "scanPolicy": scan_policy,
        })

        object.__setattr__(self, "schema_version", schema_version)
        object.__setattr__(self, "side", side)
        object.__setattr__(self, "entry_reference_price", entry_reference_price)
        object.__setattr__(self, "stop_price", stop_price)
        object.__setattr__(self, "take_profit_price", take_profit_price)
        object.__setattr__(self, "gap_fill_policy", gap_fill_policy)
        object.__setattr__(self, "intrabar_fill_policy", intrabar_fill_policy)
        object.__setattr__(self, "same_bar_collision_policy", same_bar_collision_policy)
        object.__setattr__(self, "scan_policy", scan_policy)
        object.__setattr__(self, "plan_id", plan_id)


# --- Observation path ---

def _observation_path_id(
    bars: tuple[ReplayBar, ...],
    entry_idx: int,
    last_obs_idx: int,
    symbol: str,
    timeframe_ms: int,
) -> str:
    obs_bars = bars[entry_idx:last_obs_idx + 1]
    payload = {
        "schemaVersion": PROTECTIVE_OBSERVATION_PATH_SCHEMA,
        "symbol": symbol,
        "timeframeMs": timeframe_ms,
        "entryExecutionTimeMs": bars[entry_idx].open_time_ms,
        "lastObservationTimeMs": bars[last_obs_idx].open_time_ms,
        "scanPolicy": SCAN_POLICY,
        "observedBars": [
            {"openTimeMs": b.open_time_ms, "open": float(b.open),
             "high": float(b.high), "low": float(b.low),
             "close": float(b.close), "closed": b.closed}
            for b in obs_bars
        ],
    }
    return canonical_sha256(payload)


# --- ProtectiveExitEvent ---

@dataclass(frozen=True)
class ProtectiveExitEvent:
    schema_version: str
    side: PositionSide
    reason: str
    trigger_kind: str
    trigger_bar_open_time_ms: int
    trigger_bar_index: int
    trigger_level_price: float
    raw_exit_price: float
    same_bar_collision: bool
    plan_id: str
    observation_path_id: str
    event_id: str


# --- ProtectiveExitResolution ---

@dataclass(frozen=True)
class ProtectiveExitResolution:
    schema_version: str
    status: str
    plan_id: str
    observation_path_id: str
    event: ProtectiveExitEvent | None
    resolution_id: str


# --- Resolver ---

def _make_event(
    *,
    side: PositionSide,
    reason: str,
    trigger_kind: str,
    bar: ReplayBar,
    bar_idx: int,
    trigger_price: float,
    raw_exit_price: float,
    same_bar_collision: bool,
    plan_id: str,
    observation_path_id: str,
) -> ProtectiveExitEvent:
    event_id = canonical_sha256({
        "schemaVersion": PROTECTIVE_EXIT_EVENT_SCHEMA,
        "side": side.value,
        "reason": reason,
        "triggerKind": trigger_kind,
        "triggerBarOpenTimeMs": bar.open_time_ms,
        "triggerBarIndex": bar_idx,
        "triggerLevelPrice": float(trigger_price),
        "rawExitPrice": float(raw_exit_price),
        "sameBarCollision": same_bar_collision,
        "planId": plan_id,
        "observationPathId": observation_path_id,
    })
    return ProtectiveExitEvent(
        schema_version=PROTECTIVE_EXIT_EVENT_SCHEMA,
        side=side, reason=reason, trigger_kind=trigger_kind,
        trigger_bar_open_time_ms=bar.open_time_ms, trigger_bar_index=bar_idx,
        trigger_level_price=trigger_price, raw_exit_price=raw_exit_price,
        same_bar_collision=same_bar_collision, plan_id=plan_id,
        observation_path_id=observation_path_id, event_id=event_id,
    )


def resolve_protective_exit(
    *,
    bars: Sequence[ReplayBar],
    entry_execution_index: int,
    last_observation_index: int,
    plan: ProtectiveExitPlan,
    symbol: str,
    timeframe_ms: int,
) -> ProtectiveExitResolution:
    if type(plan) is not ProtectiveExitPlan:
        raise ValueError("RESOLVE_PLAN_TYPE_INVALID")
    if not symbol or not isinstance(symbol, str):
        raise ValueError("RESOLVE_SYMBOL_INVALID")
    if type(timeframe_ms) is not int or timeframe_ms != FROZEN_TIMEFRAME_MS:
        raise ValueError("RESOLVE_TIMEFRAME_INVALID")
    if isinstance(entry_execution_index, bool) or not isinstance(entry_execution_index, int):
        raise ValueError("RESOLVE_ENTRY_IDX_NOT_INT")
    if isinstance(last_observation_index, bool) or not isinstance(last_observation_index, int):
        raise ValueError("RESOLVE_LAST_IDX_NOT_INT")

    valid_bars = validate_bar_sequence(bars)
    if not (0 <= entry_execution_index <= last_observation_index < len(valid_bars)):
        raise ValueError("RESOLVE_INDEX_OUT_OF_RANGE")

    side = plan.side
    obs_path_id = _observation_path_id(valid_bars, entry_execution_index, last_observation_index, symbol, timeframe_ms)

    for i in range(entry_execution_index, last_observation_index + 1):
        b = valid_bars[i]
        bo = float(b.open)
        bh = float(b.high)
        bl = float(b.low)

        if i == entry_execution_index:
            # Entry bar: skip open, only evaluate high/low
            if side is PositionSide.LONG:
                stop_hit = bl <= plan.stop_price
                target_hit = bh >= plan.take_profit_price
            else:
                stop_hit = bh >= plan.stop_price
                target_hit = bl <= plan.take_profit_price

            trig_kind = KIND_INTRABAR_LEVEL
            if stop_hit and target_hit:
                reason = REASON_STOP_LOSS
                trigger_price = plan.stop_price
                raw_exit = plan.stop_price
                collision = True
            elif stop_hit:
                reason = REASON_STOP_LOSS
                trigger_price = plan.stop_price
                raw_exit = plan.stop_price
                collision = False
            elif target_hit:
                reason = REASON_TAKE_PROFIT
                trigger_price = plan.take_profit_price
                raw_exit = plan.take_profit_price
                collision = False
            else:
                continue  # no trigger on entry bar, move to next bar

            event = _make_event(
                side=side, reason=reason, trigger_kind=trig_kind,
                bar=b, bar_idx=i, trigger_price=trigger_price, raw_exit_price=raw_exit,
                same_bar_collision=collision, plan_id=plan.plan_id, observation_path_id=obs_path_id,
            )
            return _make_resolution(plan, obs_path_id, event)
        else:
            # Later bar: open first
            if side is PositionSide.LONG:
                gap_stop = bo <= plan.stop_price
                gap_target = bo >= plan.take_profit_price
            else:
                gap_stop = bo >= plan.stop_price
                gap_target = bo <= plan.take_profit_price

            if gap_stop:
                event = _make_event(
                    side=side, reason=REASON_STOP_LOSS, trigger_kind=KIND_GAP_OPEN,
                    bar=b, bar_idx=i, trigger_price=plan.stop_price, raw_exit_price=bo,
                    same_bar_collision=False, plan_id=plan.plan_id, observation_path_id=obs_path_id,
                )
                return _make_resolution(plan, obs_path_id, event)

            if gap_target:
                event = _make_event(
                    side=side, reason=REASON_TAKE_PROFIT, trigger_kind=KIND_GAP_OPEN,
                    bar=b, bar_idx=i, trigger_price=plan.take_profit_price, raw_exit_price=bo,
                    same_bar_collision=False, plan_id=plan.plan_id, observation_path_id=obs_path_id,
                )
                return _make_resolution(plan, obs_path_id, event)

            # Intrabar
            if side is PositionSide.LONG:
                stop_hit = bl <= plan.stop_price
                target_hit = bh >= plan.take_profit_price
            else:
                stop_hit = bh >= plan.stop_price
                target_hit = bl <= plan.take_profit_price

            if stop_hit and target_hit:
                event = _make_event(
                    side=side, reason=REASON_STOP_LOSS, trigger_kind=KIND_INTRABAR_LEVEL,
                    bar=b, bar_idx=i, trigger_price=plan.stop_price, raw_exit_price=plan.stop_price,
                    same_bar_collision=True, plan_id=plan.plan_id, observation_path_id=obs_path_id,
                )
                return _make_resolution(plan, obs_path_id, event)
            elif stop_hit:
                event = _make_event(
                    side=side, reason=REASON_STOP_LOSS, trigger_kind=KIND_INTRABAR_LEVEL,
                    bar=b, bar_idx=i, trigger_price=plan.stop_price, raw_exit_price=plan.stop_price,
                    same_bar_collision=False, plan_id=plan.plan_id, observation_path_id=obs_path_id,
                )
                return _make_resolution(plan, obs_path_id, event)
            elif target_hit:
                event = _make_event(
                    side=side, reason=REASON_TAKE_PROFIT, trigger_kind=KIND_INTRABAR_LEVEL,
                    bar=b, bar_idx=i, trigger_price=plan.take_profit_price, raw_exit_price=plan.take_profit_price,
                    same_bar_collision=False, plan_id=plan.plan_id, observation_path_id=obs_path_id,
                )
                return _make_resolution(plan, obs_path_id, event)

    # No trigger
    rid = canonical_sha256({
        "schemaVersion": PROTECTIVE_EXIT_RESOLUTION_SCHEMA,
        "planId": plan.plan_id,
        "observationPathId": obs_path_id,
        "status": STATUS_NO_TRIGGER,
        "eventId": None,
    })
    return ProtectiveExitResolution(
        schema_version=PROTECTIVE_EXIT_RESOLUTION_SCHEMA,
        status=STATUS_NO_TRIGGER, plan_id=plan.plan_id,
        observation_path_id=obs_path_id, event=None,
        resolution_id=rid,
    )


def _make_resolution(plan: ProtectiveExitPlan, obs_path_id: str, event: ProtectiveExitEvent) -> ProtectiveExitResolution:
    rid = canonical_sha256({
        "schemaVersion": PROTECTIVE_EXIT_RESOLUTION_SCHEMA,
        "planId": plan.plan_id,
        "observationPathId": obs_path_id,
        "status": STATUS_TRIGGERED,
        "eventId": event.event_id,
    })
    return ProtectiveExitResolution(
        schema_version=PROTECTIVE_EXIT_RESOLUTION_SCHEMA,
        status=STATUS_TRIGGERED, plan_id=plan.plan_id,
        observation_path_id=obs_path_id, event=event,
        resolution_id=rid,
    )
