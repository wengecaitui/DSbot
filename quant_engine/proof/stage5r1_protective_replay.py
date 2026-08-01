"""Stage 5R1.3-D deterministic protective replay integration.

Integrates protective exit resolution into the replay harness with
incremental observation, stop-loss/take-profit arbitration, and
explicit-EXIT precedence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

from quant_engine.proof.stage5r1_capital import (
    CapitalModel, CostModel, PositionSide, TradeAccounting,
    calculate_trade_accounting, capital_model_id, cost_model_id,
)
from quant_engine.proof.stage5r1_replay import (
    ReplayAction, ReplayBar, ReplayConfig, ReplayInstruction,
    validate_bar_sequence, validate_instruction_set,
    _dataset_id, _instruction_set_id, _replay_config_id,
)
from quant_engine.proof.stage5r1_protective_exit import (
    ProtectiveExitPlan, ProtectiveExitResolution,
    resolve_protective_exit,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

# --- Schema ---
PROTECTIVE_REPLAY_BINDING_SCHEMA = "stage-5r1.protective-replay-binding.v1"
PROTECTIVE_REPLAY_BINDING_SET_SCHEMA = "stage-5r1.protective-replay-binding-set.v1"
REPLAY_EXIT_SELECTION_SCHEMA = "stage-5r1.replay-exit-selection.v1"
PROTECTIVE_REPLAY_TRADE_SCHEMA = "stage-5r1.protective-replay-trade.v1"
PROTECTIVE_REPLAY_RESULT_SCHEMA = "stage-5r1.protective-replay-result.v1"

EXIT_ARBITRATION_POLICY = "PROTECTIVE_THROUGH_EXIT_SIGNAL_BAR_THEN_EXPLICIT_NEXT_OPEN"
ACCOUNTING_TIME_POLICY = "TRIGGER_BAR_OPEN_TIME"

PROTECTIVE_SOURCE = "PROTECTIVE"
EXPLICIT_SOURCE = "EXPLICIT_NEXT_OPEN"
EXPLICIT_EXECUTED = "EXECUTED_NEXT_OPEN"
EXPLICIT_SUPERSEDED = "SUPERSEDED_BY_PROTECTIVE"
EXPLICIT_REASON = "EXPLICIT_EXIT"

_SHA_RE = re.compile(r"^[a-f0-9]{64}$")


def _vsha(v: str, label: str) -> None:
    if not isinstance(v, str) or not _SHA_RE.fullmatch(v):
        raise ValueError(f"{label}_MALFORMED: {v!r}")


# --- ProtectiveReplayBinding ---

@dataclass(frozen=True)
class ProtectiveReplayBinding:
    schema_version: str
    entry_signal_bar_open_time_ms: int
    plan: ProtectiveExitPlan
    binding_id: str

    def __init__(self, *, entry_signal_bar_open_time_ms: int, plan: ProtectiveExitPlan) -> None:
        if type(plan) is not ProtectiveExitPlan:
            raise ValueError("BINDING_PLAN_TYPE_INVALID")
        if isinstance(entry_signal_bar_open_time_ms, bool) or not isinstance(entry_signal_bar_open_time_ms, int):
            raise ValueError("BINDING_TIME_NOT_INT")
        if entry_signal_bar_open_time_ms < 0:
            raise ValueError("BINDING_TIME_NEGATIVE")
        bid = canonical_sha256({
            "schemaVersion": PROTECTIVE_REPLAY_BINDING_SCHEMA,
            "entrySignalBarOpenTimeMs": entry_signal_bar_open_time_ms,
            "planId": plan.plan_id,
        })
        for k, v in [("schema_version", PROTECTIVE_REPLAY_BINDING_SCHEMA),
                      ("entry_signal_bar_open_time_ms", entry_signal_bar_open_time_ms),
                      ("plan", plan), ("binding_id", bid)]:
            object.__setattr__(self, k, v)


def _binding_set_id(bindings: tuple[ProtectiveReplayBinding, ...]) -> str:
    return canonical_sha256({
        "schemaVersion": PROTECTIVE_REPLAY_BINDING_SET_SCHEMA,
        "bindings": [{"entrySignalBarOpenTimeMs": b.entry_signal_bar_open_time_ms,
                       "planId": b.plan.plan_id} for b in bindings],
    })


# --- ReplayExitSelection ---

@dataclass(frozen=True)
class ReplayExitSelection:
    schema_version: str
    arbitration_policy: str
    accounting_time_policy: str
    source: str
    reason: str
    explicit_outcome: str

    entry_signal_bar_open_time_ms: int
    entry_execution_time_ms: int
    paired_exit_signal_bar_open_time_ms: int
    explicit_exit_execution_time_ms: int
    selected_exit_bar_index: int
    selected_exit_bar_open_time_ms: int

    raw_entry_price: float
    raw_exit_price: float

    binding_id: str
    plan_id: str
    protective_resolution_id: str | None
    protective_event_id: str | None
    selection_id: str


# --- ProtectiveReplayTrade ---

@dataclass(frozen=True)
class ProtectiveReplayTrade:
    schema_version: str
    trade_index: int
    binding_id: str
    entry_signal_bar_open_time_ms: int
    paired_exit_signal_bar_open_time_ms: int
    entry_execution_time_ms: int
    selected_exit_bar_open_time_ms: int
    selection_id: str
    accounting_id: str
    trade_id: str


# --- ProtectiveReplayResult ---

@dataclass(frozen=True)
class ProtectiveReplayResult:
    schema_version: str
    symbol: str
    timeframe_ms: int
    dataset_id: str
    instruction_set_id: str
    binding_set_id: str
    replay_config_id: str
    capital_model_id: str
    cost_model_id: str
    initial_equity: float
    final_equity: float
    trade_count: int
    trades: tuple[ProtectiveReplayTrade, ...]
    selections: tuple[ReplayExitSelection, ...]
    replay_id: str


# --- Helpers ---

def _validate_pairing(instructions: tuple[ReplayInstruction, ...]) -> None:
    if len(instructions) % 2 != 0:
        raise ValueError("PAIRING_ODD_COUNT")
    expected: ReplayAction | None = None
    for i, inst in enumerate(instructions):
        a = inst.action
        if expected is None:
            if a not in (ReplayAction.ENTER_LONG, ReplayAction.ENTER_SHORT):
                raise ValueError(f"PAIRING_FIRST_NOT_ENTER: index={i}")
            expected = ReplayAction.EXIT
        else:
            if a != ReplayAction.EXIT:
                raise ValueError(f"PAIRING_EXPECTED_EXIT: index={i}")
            expected = None


def _relevant_bindings(bindings: tuple[ProtectiveReplayBinding, ...], bar_by_time: dict[int, ReplayBar],
                       entry_signal_instructions: list[ReplayInstruction]) -> dict[int, ProtectiveReplayBinding]:
    # Match bindings to entry instructions by signal time
    entry_times = [i.signal_bar_open_time_ms for i in entry_signal_instructions]
    result: dict[int, ProtectiveReplayBinding] = {}
    seen_times: set[int] = set()
    for b in bindings:
        if b.entry_signal_bar_open_time_ms not in seen_times:
            seen_times.add(b.entry_signal_bar_open_time_ms)
        else:
            raise ValueError(f"BINDING_DUPLICATE_TIME: {b.entry_signal_bar_open_time_ms}")
        if type(b) is not ProtectiveReplayBinding:
            raise ValueError(f"BINDING_TYPE_INVALID")
        if type(b.plan) is not ProtectiveExitPlan:
            raise ValueError("BINDING_PLAN_TYPE_INVALID")
    if len(seen_times) != len(entry_times):
        raise ValueError(f"BINDING_COUNT_MISMATCH: bindings={len(seen_times)} entries={len(entry_times)}")
    for t in entry_times:
        if t not in seen_times:
            raise ValueError(f"BINDING_MISSING_TIME: {t}")
    # Rebuild sorted
    by_time = {b.entry_signal_bar_open_time_ms: b for b in bindings}
    for t in entry_times:
        result[t] = by_time[t]
    return result


# --- Main ---

def run_stage5r1_protective_replay(
    *, bars: Sequence[ReplayBar], instructions: Sequence[ReplayInstruction],
    protective_bindings: Sequence[ProtectiveReplayBinding],
    config: ReplayConfig, capital: CapitalModel, cost: CostModel,
) -> ProtectiveReplayResult:
    if type(config) is not ReplayConfig:
        raise ValueError("CONFIG_TYPE_INVALID")
    if type(capital) is not CapitalModel:
        raise ValueError("CAPITAL_TYPE_INVALID")
    if type(cost) is not CostModel:
        raise ValueError("COST_TYPE_INVALID")

    valid_bars = validate_bar_sequence(bars)
    valid_instructions = validate_instruction_set(instructions, valid_bars, config.warmup_bars)
    _validate_pairing(valid_instructions)

    bar_by_time = {b.open_time_ms: b for b in valid_bars}
    bt = sorted(bar_by_time)

    # Build entry signal instructions list
    entry_insts = [i for i in valid_instructions if i.action in (ReplayAction.ENTER_LONG, ReplayAction.ENTER_SHORT)]

    bindings_by_time = _relevant_bindings(tuple(protective_bindings), bar_by_time, entry_insts)

    current_eq = float(capital.initial_equity)
    trades: list[ProtectiveReplayTrade] = []
    selections: list[ReplayExitSelection] = []
    ds_id = _dataset_id(valid_bars, symbol=config.symbol, timeframe_ms=config.timeframe_ms)

    # Iterate in pairs
    for i in range(0, len(valid_instructions), 2):
        entry_inst = valid_instructions[i]
        exit_inst = valid_instructions[i + 1]
        assert entry_inst.action in (ReplayAction.ENTER_LONG, ReplayAction.ENTER_SHORT)
        assert exit_inst.action is ReplayAction.EXIT

        entry_sig = entry_inst.signal_bar_open_time_ms
        exit_sig = exit_inst.signal_bar_open_time_ms

        entry_si = bt.index(entry_sig)
        exit_si = bt.index(exit_sig)
        entry_ei = entry_si + 1
        explicit_exit_ei = exit_si + 1

        binding = bindings_by_time[entry_sig]
        plan = binding.plan

        side = PositionSide.LONG if entry_inst.action is ReplayAction.ENTER_LONG else PositionSide.SHORT
        if plan.side is not side:
            raise ValueError(f"SIDE_MISMATCH: plan={plan.side.value} action={side.value}")

        entry_open = float(valid_bars[entry_ei].open)
        if plan.entry_reference_price != entry_open:
            raise ValueError(f"ENTRY_REF_MISMATCH: plan={plan.entry_reference_price} bar={entry_open}")

        # Incremental resolution
        resolution = None
        for obs_idx in range(entry_ei, exit_si + 1):
            resolution = resolve_protective_exit(
                bars=valid_bars, entry_execution_index=entry_ei,
                last_observation_index=obs_idx, plan=plan,
                symbol=config.symbol, timeframe_ms=config.timeframe_ms,
            )
            if resolution.status == "TRIGGERED":
                break

        assert resolution is not None

        if resolution.status == "TRIGGERED":
            source = PROTECTIVE_SOURCE
            reason = resolution.event.reason
            explicit_outcome = EXPLICIT_SUPERSEDED
            sel_ei = resolution.event.trigger_bar_index
            sel_time = resolution.event.trigger_bar_open_time_ms
            raw_exit = resolution.event.raw_exit_price
            prot_res_id: str | None = resolution.resolution_id
            prot_evt_id: str | None = resolution.event.event_id
        else:
            source = EXPLICIT_SOURCE
            reason = EXPLICIT_REASON
            explicit_outcome = EXPLICIT_EXECUTED
            sel_ei = explicit_exit_ei
            sel_time = valid_bars[explicit_exit_ei].open_time_ms
            raw_exit = float(valid_bars[explicit_exit_ei].open)
            prot_res_id = None
            prot_evt_id = None

        sel_id_payload = {
            "schemaVersion": REPLAY_EXIT_SELECTION_SCHEMA,
            "arbitrationPolicy": EXIT_ARBITRATION_POLICY,
            "accountingTimePolicy": ACCOUNTING_TIME_POLICY,
            "source": source, "reason": reason, "explicitOutcome": explicit_outcome,
            "entrySignalBarOpenTimeMs": entry_sig,
            "entryExecutionTimeMs": valid_bars[entry_ei].open_time_ms,
            "pairedExitSignalBarOpenTimeMs": exit_sig,
            "explicitExitExecutionTimeMs": valid_bars[explicit_exit_ei].open_time_ms,
            "selectedExitBarIndex": sel_ei,
            "selectedExitBarOpenTimeMs": sel_time,
            "rawEntryPrice": float(entry_open),
            "rawExitPrice": float(raw_exit),
            "bindingId": binding.binding_id,
            "planId": plan.plan_id,
            "protectiveResolutionId": prot_res_id,
            "protectiveEventId": prot_evt_id,
        }
        sel_id = canonical_sha256(sel_id_payload)

        sel = ReplayExitSelection(
            schema_version=REPLAY_EXIT_SELECTION_SCHEMA,
            arbitration_policy=EXIT_ARBITRATION_POLICY,
            accounting_time_policy=ACCOUNTING_TIME_POLICY,
            source=source, reason=reason, explicit_outcome=explicit_outcome,
            entry_signal_bar_open_time_ms=entry_sig,
            entry_execution_time_ms=valid_bars[entry_ei].open_time_ms,
            paired_exit_signal_bar_open_time_ms=exit_sig,
            explicit_exit_execution_time_ms=valid_bars[explicit_exit_ei].open_time_ms,
            selected_exit_bar_index=sel_ei,
            selected_exit_bar_open_time_ms=sel_time,
            raw_entry_price=float(entry_open),
            raw_exit_price=float(raw_exit),
            binding_id=binding.binding_id, plan_id=plan.plan_id,
            protective_resolution_id=prot_res_id, protective_event_id=prot_evt_id,
            selection_id=sel_id,
        )
        selections.append(sel)

        accounting = calculate_trade_accounting(
            side=side, entry_equity=current_eq,
            raw_entry_price=entry_open, raw_exit_price=raw_exit,
            entry_time_ms=valid_bars[entry_ei].open_time_ms,
            exit_time_ms=sel_time,
            capital=capital, cost=cost,
        )

        trade_id = canonical_sha256({
            "schemaVersion": PROTECTIVE_REPLAY_TRADE_SCHEMA,
            "tradeIndex": len(trades),
            "bindingId": binding.binding_id,
            "entrySignalBarOpenTimeMs": entry_sig,
            "pairedExitSignalBarOpenTimeMs": exit_sig,
            "entryExecutionTimeMs": valid_bars[entry_ei].open_time_ms,
            "selectedExitBarOpenTimeMs": sel_time,
            "selectionId": sel_id,
            "accountingId": accounting.accounting_id,
        })

        trades.append(ProtectiveReplayTrade(
            schema_version=PROTECTIVE_REPLAY_TRADE_SCHEMA,
            trade_index=len(trades),
            binding_id=binding.binding_id,
            entry_signal_bar_open_time_ms=entry_sig,
            paired_exit_signal_bar_open_time_ms=exit_sig,
            entry_execution_time_ms=valid_bars[entry_ei].open_time_ms,
            selected_exit_bar_open_time_ms=sel_time,
            selection_id=sel_id,
            accounting_id=accounting.accounting_id,
            trade_id=trade_id,
        ))
        current_eq = accounting.closing_equity

    is_id = _instruction_set_id(valid_instructions)
    bs_id = _binding_set_id(tuple(bindings_by_time.values()))
    rc_id = _replay_config_id(config)
    cm_id = capital_model_id(capital)
    co_id = cost_model_id(cost)

    rid = canonical_sha256({
        "schemaVersion": PROTECTIVE_REPLAY_RESULT_SCHEMA,
        "datasetId": ds_id, "instructionSetId": is_id,
        "bindingSetId": bs_id, "replayConfigId": rc_id,
        "capitalModelId": cm_id, "costModelId": co_id,
        "initialEquity": float(capital.initial_equity),
        "finalEquity": float(current_eq),
        "tradeCount": len(trades),
        "tradeIds": [t.trade_id for t in trades],
    })

    return ProtectiveReplayResult(
        schema_version=PROTECTIVE_REPLAY_RESULT_SCHEMA,
        symbol=config.symbol, timeframe_ms=config.timeframe_ms,
        dataset_id=ds_id, instruction_set_id=is_id,
        binding_set_id=bs_id, replay_config_id=rc_id,
        capital_model_id=cm_id, cost_model_id=co_id,
        initial_equity=float(capital.initial_equity),
        final_equity=float(current_eq),
        trade_count=len(trades),
        trades=tuple(trades), selections=tuple(selections),
        replay_id=rid,
    )
