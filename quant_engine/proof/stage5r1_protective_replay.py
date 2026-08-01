"""Stage 5R1.3-D deterministic protective replay integration."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

from quant_engine.proof.stage5r1_capital import (
    CapitalModel, CostModel, PositionSide,
    calculate_trade_accounting, capital_model_id, cost_model_id,
)
from quant_engine.proof.stage5r1_replay import (
    ReplayAction, ReplayBar, ReplayConfig, ReplayInstruction,
    validate_bar_sequence, validate_instruction_set,
    _dataset_id, _instruction_set_id, _replay_config_id,
)
from quant_engine.proof.stage5r1_protective_exit import (
    ProtectiveExitPlan,
    resolve_protective_exit,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

# --- Schema ---
PROTECTIVE_REPLAY_BINDING_SCHEMA = "stage-5r1.protective-replay-binding.v1"
REPLAY_EXIT_SELECTION_SCHEMA = "stage-5r1.replay-exit-selection.v1"
PROTECTIVE_REPLAY_TRADE_SCHEMA = "stage-5r1.protective-replay-trade.v1"
PROTECTIVE_REPLAY_RESULT_SCHEMA = "stage-5r1.protective-replay-result.v1"

EXIT_ARBITRATION_POLICY = "PROTECTIVE_THROUGH_EXIT_SIGNAL_BAR_THEN_EXPLICIT_NEXT_OPEN"
ACCOUNTING_TIME_POLICY = "TRIGGER_BAR_OPEN_TIME"
PROTECTIVE_SOURCE = "PROTECTIVE"
EXPLICIT_SOURCE = "EXPLICIT_NEXT_OPEN"
EXPLICIT_EXECUTED = "EXECUTED_NEXT_OPEN"
EXPLICIT_SUPERSEDED = "SUPERSEDED_BY_PROTECTIVE"
EXPLICIT_REASON_VAL = "EXPLICIT_EXIT"

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
        _vint(entry_signal_bar_open_time_ms, "BINDING_TIME")
        bid = canonical_sha256({
            "schemaVersion": PROTECTIVE_REPLAY_BINDING_SCHEMA,
            "entrySignalBarOpenTimeMs": entry_signal_bar_open_time_ms,
            "planId": plan.plan_id,
        })
        for k, v in [("schema_version", PROTECTIVE_REPLAY_BINDING_SCHEMA),
                      ("entry_signal_bar_open_time_ms", entry_signal_bar_open_time_ms),
                      ("plan", plan), ("binding_id", bid)]:
            object.__setattr__(self, k, v)


def _validate_bindings(bindings_seq: Sequence[ProtectiveReplayBinding], entry_insts: list[ReplayInstruction]) -> tuple[ProtectiveReplayBinding, ...]:
    if not isinstance(bindings_seq, Sequence) or isinstance(bindings_seq, (str, bytes)):
        raise ValueError("BINDINGS_NOT_SEQUENCE")
    entry_times = [i.signal_bar_open_time_ms for i in entry_insts]
    result: list[ProtectiveReplayBinding] = []
    seen_times: set[int] = set()
    for b in bindings_seq:
        if type(b) is not ProtectiveReplayBinding:
            raise ValueError(f"BINDING_TYPE_INVALID: {type(b).__name__}")
        if b.schema_version != PROTECTIVE_REPLAY_BINDING_SCHEMA:
            raise ValueError("BINDING_SCHEMA_INVALID")
        _vint(b.entry_signal_bar_open_time_ms, "BINDING_TIME")
        if type(b.plan) is not ProtectiveExitPlan:
            raise ValueError("BINDING_PLAN_TYPE_INVALID")
        _vsha(b.binding_id, "BINDING_ID")
        expected = canonical_sha256({
            "schemaVersion": PROTECTIVE_REPLAY_BINDING_SCHEMA,
            "entrySignalBarOpenTimeMs": b.entry_signal_bar_open_time_ms,
            "planId": b.plan.plan_id,
        })
        if b.binding_id != expected:
            raise ValueError("BINDING_ID_MISMATCH")
        if b.entry_signal_bar_open_time_ms in seen_times:
            raise ValueError(f"BINDING_DUPLICATE_TIME: {b.entry_signal_bar_open_time_ms}")
        seen_times.add(b.entry_signal_bar_open_time_ms)
        result.append(b)
    if len(result) != len(entry_times):
        raise ValueError(f"BINDING_COUNT_MISMATCH: {len(result)} != {len(entry_times)}")
    # Check ordering — must match entry times order (strictly increasing)
    for i, t in enumerate(entry_times):
        if result[i].entry_signal_bar_open_time_ms != t:
            raise ValueError(f"BINDING_TIME_MISMATCH_AT_{i}: expected={t} got={result[i].entry_signal_bar_open_time_ms}")
        if i > 0 and result[i].entry_signal_bar_open_time_ms <= result[i - 1].entry_signal_bar_open_time_ms:
            raise ValueError("BINDING_NOT_STRICTLY_INCREASING")
    return tuple(result)


# --- Exit Selection Payload ---

def _selection_payload(sel: ReplayExitSelection) -> dict:
    return {
        "schemaVersion": sel.schema_version,
        "arbitrationPolicy": sel.arbitration_policy,
        "accountingTimePolicy": sel.accounting_time_policy,
        "source": sel.source, "reason": sel.reason, "explicitOutcome": sel.explicit_outcome,
        "entrySignalBarOpenTimeMs": sel.entry_signal_bar_open_time_ms,
        "entryExecutionTimeMs": sel.entry_execution_time_ms,
        "pairedExitSignalBarOpenTimeMs": sel.paired_exit_signal_bar_open_time_ms,
        "explicitExitExecutionTimeMs": sel.explicit_exit_execution_time_ms,
        "selectedExitBarIndex": sel.selected_exit_bar_index,
        "selectedExitBarOpenTimeMs": sel.selected_exit_bar_open_time_ms,
        "rawEntryPrice": float(sel.raw_entry_price),
        "rawExitPrice": float(sel.raw_exit_price),
        "bindingId": sel.binding_id, "planId": sel.plan_id,
        "protectiveResolutionId": sel.protective_resolution_id,
        "protectiveEventId": sel.protective_event_id,
    }


@dataclass(frozen=True)
class ReplayExitSelection:
    schema_version: str; arbitration_policy: str; accounting_time_policy: str
    source: str; reason: str; explicit_outcome: str
    entry_signal_bar_open_time_ms: int; entry_execution_time_ms: int
    paired_exit_signal_bar_open_time_ms: int; explicit_exit_execution_time_ms: int
    selected_exit_bar_index: int; selected_exit_bar_open_time_ms: int
    raw_entry_price: float; raw_exit_price: float
    binding_id: str; plan_id: str
    protective_resolution_id: str | None; protective_event_id: str | None
    selection_id: str

    def __post_init__(self) -> None:
        if self.schema_version != REPLAY_EXIT_SELECTION_SCHEMA:
            raise ValueError("SELECTION_SCHEMA_INVALID")
        if self.arbitration_policy != EXIT_ARBITRATION_POLICY:
            raise ValueError("SELECTION_ARBITRATION_INVALID")
        if self.accounting_time_policy != ACCOUNTING_TIME_POLICY:
            raise ValueError("SELECTION_TIME_POLICY_INVALID")

        if self.source == PROTECTIVE_SOURCE:
            if self.reason not in ("STOP_LOSS", "TAKE_PROFIT"):
                raise ValueError("SELECTION_PROTECTIVE_REASON_INVALID")
            if self.explicit_outcome != EXPLICIT_SUPERSEDED:
                raise ValueError("SELECTION_PROTECTIVE_OUTCOME_INVALID")
            _vsha(self.protective_resolution_id, "SELECTION_PROT_RES_ID")
            _vsha(self.protective_event_id, "SELECTION_PROT_EVT_ID")
            if not (self.entry_execution_time_ms <= self.selected_exit_bar_open_time_ms <= self.paired_exit_signal_bar_open_time_ms):
                raise ValueError("SELECTION_TIME_ORDER_INVALID")
        elif self.source == EXPLICIT_SOURCE:
            if self.reason != EXPLICIT_REASON_VAL:
                raise ValueError("SELECTION_EXPLICIT_REASON_INVALID")
            if self.explicit_outcome != EXPLICIT_EXECUTED:
                raise ValueError("SELECTION_EXPLICIT_OUTCOME_INVALID")
            _vsha(self.protective_resolution_id, "SELECTION_EXPLICIT_RES_ID")
            if self.protective_event_id is not None:
                raise ValueError("SELECTION_EXPLICIT_EVENT_NOT_NULL")
            if self.selected_exit_bar_open_time_ms != self.explicit_exit_execution_time_ms:
                raise ValueError("SELECTION_EXPLICIT_TIME_MISMATCH")
        else:
            raise ValueError(f"SELECTION_SOURCE_INVALID: {self.source}")

        # Common
        _vint(self.entry_signal_bar_open_time_ms, "SEL_ENTRY_SIG")
        _vint(self.entry_execution_time_ms, "SEL_ENTRY_EXEC")
        _vint(self.paired_exit_signal_bar_open_time_ms, "SEL_EXIT_SIG")
        _vint(self.explicit_exit_execution_time_ms, "SEL_EXPLICIT_EXEC")
        _vint(self.selected_exit_bar_index, "SEL_BAR_IDX")
        _vint(self.selected_exit_bar_open_time_ms, "SEL_BAR_TIME")
        _vpos(self.raw_entry_price, "SEL_RAW_ENTRY")
        _vpos(self.raw_exit_price, "SEL_RAW_EXIT")
        _vsha(self.binding_id, "SEL_BINDING_ID")
        _vsha(self.plan_id, "SEL_PLAN_ID")
        _vsha(self.selection_id, "SEL_SELECTION_ID")

        if not (self.entry_signal_bar_open_time_ms < self.entry_execution_time_ms):
            raise ValueError("SEL_TIME_ORDER_MUST_INCREASE")
        if not (self.entry_execution_time_ms <= self.paired_exit_signal_bar_open_time_ms):
            raise ValueError("SEL_EXEC_EXIT_ORDER")
        if not (self.paired_exit_signal_bar_open_time_ms < self.explicit_exit_execution_time_ms):
            raise ValueError("SEL_EXIT_EXPLICIT_ORDER")

        expected = canonical_sha256(_selection_payload(self))
        if self.selection_id != expected:
            raise ValueError("SELECTION_ID_MISMATCH")


# --- ProtectiveReplayTrade ---

def _trade_payload(t: ProtectiveReplayTrade) -> dict:
    return {
        "schemaVersion": t.schema_version, "tradeIndex": t.trade_index,
        "bindingId": t.binding_id,
        "entrySignalBarOpenTimeMs": t.entry_signal_bar_open_time_ms,
        "pairedExitSignalBarOpenTimeMs": t.paired_exit_signal_bar_open_time_ms,
        "entryExecutionTimeMs": t.entry_execution_time_ms,
        "selectedExitBarOpenTimeMs": t.selected_exit_bar_open_time_ms,
        "selectionId": t.selection_id, "accountingId": t.accounting_id,
    }


@dataclass(frozen=True)
class ProtectiveReplayTrade:
    schema_version: str; trade_index: int
    binding_id: str
    entry_signal_bar_open_time_ms: int; paired_exit_signal_bar_open_time_ms: int
    entry_execution_time_ms: int; selected_exit_bar_open_time_ms: int
    selection_id: str; accounting_id: str
    trade_id: str

    def __post_init__(self) -> None:
        if self.schema_version != PROTECTIVE_REPLAY_TRADE_SCHEMA:
            raise ValueError("TRADE_SCHEMA_INVALID")
        _vint(self.trade_index, "TRADE_IDX")
        _vint(self.entry_signal_bar_open_time_ms, "TRADE_ENTRY_SIG")
        _vint(self.paired_exit_signal_bar_open_time_ms, "TRADE_EXIT_SIG")
        _vint(self.entry_execution_time_ms, "TRADE_ENTRY_EXEC")
        _vint(self.selected_exit_bar_open_time_ms, "TRADE_EXIT_TIME")
        _vsha(self.binding_id, "TRADE_BINDING_ID")
        _vsha(self.selection_id, "TRADE_SEL_ID")
        _vsha(self.accounting_id, "TRADE_ACCT_ID")
        _vsha(self.trade_id, "TRADE_ID")
        expected = canonical_sha256(_trade_payload(self))
        if self.trade_id != expected:
            raise ValueError("TRADE_ID_MISMATCH")


# --- ProtectiveReplayResult ---

def _result_payload(r: ProtectiveReplayResult) -> dict:
    return {
        "schemaVersion": r.schema_version, "datasetId": r.dataset_id,
        "instructionSetId": r.instruction_set_id, "bindingSetId": r.binding_set_id,
        "replayConfigId": r.replay_config_id, "capitalModelId": r.capital_model_id,
        "costModelId": r.cost_model_id, "initialEquity": float(r.initial_equity),
        "finalEquity": float(r.final_equity), "tradeCount": r.trade_count,
        "tradeIds": [t.trade_id for t in r.trades],
    }


@dataclass(frozen=True)
class ProtectiveReplayResult:
    schema_version: str; symbol: str; timeframe_ms: int
    dataset_id: str; instruction_set_id: str; binding_set_id: str
    replay_config_id: str; capital_model_id: str; cost_model_id: str
    initial_equity: float; final_equity: float; trade_count: int
    trades: tuple[ProtectiveReplayTrade, ...]
    selections: tuple[ReplayExitSelection, ...]
    replay_id: str

    def __post_init__(self) -> None:
        if self.schema_version != PROTECTIVE_REPLAY_RESULT_SCHEMA:
            raise ValueError("RESULT_SCHEMA_INVALID")
        if not self.symbol or not isinstance(self.symbol, str):
            raise ValueError("RESULT_SYMBOL_INVALID")
        if type(self.timeframe_ms) is not int or self.timeframe_ms != 300000:
            raise ValueError("RESULT_TIMEFRAME_INVALID")
        _vpos(self.initial_equity, "RESULT_INIT_EQ")
        if isinstance(self.final_equity, bool) or not isinstance(self.final_equity, (int, float)):
            raise ValueError("RESULT_FINAL_EQ_NON_NUMERIC")
        if float(self.final_equity) < 0:
            raise ValueError("RESULT_FINAL_EQ_NEGATIVE")
        _vsha(self.dataset_id, "RESULT_DS_ID")
        _vsha(self.instruction_set_id, "RESULT_IS_ID")
        _vsha(self.binding_set_id, "RESULT_BS_ID")
        _vsha(self.replay_config_id, "RESULT_RC_ID")
        _vsha(self.capital_model_id, "RESULT_CM_ID")
        _vsha(self.cost_model_id, "RESULT_CO_ID")
        _vsha(self.replay_id, "RESULT_REPLAY_ID")
        if type(self.trades) is not tuple:
            raise ValueError("RESULT_TRADES_NOT_TUPLE")
        if type(self.selections) is not tuple:
            raise ValueError("RESULT_SELECTIONS_NOT_TUPLE")
        if self.trade_count != len(self.trades) or len(self.trades) != len(self.selections):
            raise ValueError("RESULT_COUNT_MISMATCH")
        for i, (t, s) in enumerate(zip(self.trades, self.selections)):
            if type(t) is not ProtectiveReplayTrade:
                raise ValueError(f"RESULT_TRADE_TYPE_INVALID_AT_{i}")
            if type(s) is not ReplayExitSelection:
                raise ValueError(f"RESULT_SEL_TYPE_INVALID_AT_{i}")
            if t.trade_index != i:
                raise ValueError(f"RESULT_TRADE_INDEX_MISMATCH_AT_{i}")
            if t.selection_id != s.selection_id:
                raise ValueError(f"RESULT_SEL_TRADE_MISMATCH_AT_{i}")
        expected = canonical_sha256(_result_payload(self))
        if self.replay_id != expected:
            raise ValueError("RESULT_ID_MISMATCH")


# --- Main ---

def _binding_set_id(bindings: tuple[ProtectiveReplayBinding, ...]) -> str:
    return canonical_sha256({
        "schemaVersion": "stage-5r1.protective-replay-binding-set.v1",
        "bindings": [{"entrySignalBarOpenTimeMs": b.entry_signal_bar_open_time_ms, "planId": b.plan.plan_id} for b in bindings],
    })


def _validate_pairing(instructions: tuple[ReplayInstruction, ...]) -> None:
    if len(instructions) % 2 != 0:
        raise ValueError("PAIRING_ODD_COUNT")
    expected = None
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


def run_stage5r1_protective_replay(
    *, bars, instructions, protective_bindings, config, capital, cost,
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
    entry_insts = [i for i in valid_instructions if i.action in (ReplayAction.ENTER_LONG, ReplayAction.ENTER_SHORT)]
    bindings = _validate_bindings(protective_bindings, entry_insts)

    current_eq = float(capital.initial_equity)
    trades: list[ProtectiveReplayTrade] = []
    selections: list[ReplayExitSelection] = []
    ds_id = _dataset_id(valid_bars, symbol=config.symbol, timeframe_ms=config.timeframe_ms)

    for i in range(0, len(valid_instructions), 2):
        entry_inst = valid_instructions[i]; exit_inst = valid_instructions[i + 1]
        entry_sig = entry_inst.signal_bar_open_time_ms; exit_sig = exit_inst.signal_bar_open_time_ms
        entry_si = bt.index(entry_sig); exit_si = bt.index(exit_sig)
        entry_ei = entry_si + 1; explicit_exit_ei = exit_si + 1
        binding = bindings[i // 2]
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
                symbol=config.symbol, timeframe_ms=config.timeframe_ms)
            if resolution.status == "TRIGGERED":
                break
        assert resolution is not None

        if resolution.status == "TRIGGERED":
            source = PROTECTIVE_SOURCE; reason = resolution.event.reason
            explicit_outcome = EXPLICIT_SUPERSEDED
            sel_ei = resolution.event.trigger_bar_index
            sel_time = resolution.event.trigger_bar_open_time_ms
            raw_exit = resolution.event.raw_exit_price
            prot_res_id = resolution.resolution_id
            prot_evt_id = resolution.event.event_id
        else:
            source = EXPLICIT_SOURCE; reason = EXPLICIT_REASON_VAL
            explicit_outcome = EXPLICIT_EXECUTED
            sel_ei = explicit_exit_ei
            sel_time = valid_bars[explicit_exit_ei].open_time_ms
            raw_exit = float(valid_bars[explicit_exit_ei].open)
            prot_res_id = resolution.resolution_id
            prot_evt_id = None

        sel_id = canonical_sha256({
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
        })

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
            raw_entry_price=float(entry_open), raw_exit_price=float(raw_exit),
            binding_id=binding.binding_id, plan_id=plan.plan_id,
            protective_resolution_id=prot_res_id, protective_event_id=prot_evt_id,
            selection_id=sel_id)
        selections.append(sel)

        accounting = calculate_trade_accounting(
            side=side, entry_equity=current_eq, raw_entry_price=entry_open,
            raw_exit_price=raw_exit,
            entry_time_ms=valid_bars[entry_ei].open_time_ms,
            exit_time_ms=sel_time, capital=capital, cost=cost)

        # Verify accounting lineage
        if accounting.raw_entry_price != entry_open:
            raise ValueError("ACCT_ENTRY_MISMATCH")
        if accounting.raw_exit_price != raw_exit:
            raise ValueError("ACCT_EXIT_MISMATCH")

        tid = canonical_sha256({
            "schemaVersion": PROTECTIVE_REPLAY_TRADE_SCHEMA,
            "tradeIndex": len(trades), "bindingId": binding.binding_id,
            "entrySignalBarOpenTimeMs": entry_sig,
            "pairedExitSignalBarOpenTimeMs": exit_sig,
            "entryExecutionTimeMs": valid_bars[entry_ei].open_time_ms,
            "selectedExitBarOpenTimeMs": sel_time,
            "selectionId": sel_id, "accountingId": accounting.accounting_id,
        })

        trades.append(ProtectiveReplayTrade(
            schema_version=PROTECTIVE_REPLAY_TRADE_SCHEMA,
            trade_index=len(trades), binding_id=binding.binding_id,
            entry_signal_bar_open_time_ms=entry_sig,
            paired_exit_signal_bar_open_time_ms=exit_sig,
            entry_execution_time_ms=valid_bars[entry_ei].open_time_ms,
            selected_exit_bar_open_time_ms=sel_time,
            selection_id=sel_id, accounting_id=accounting.accounting_id,
            trade_id=tid))

        current_eq = accounting.closing_equity

    is_id = _instruction_set_id(valid_instructions)
    bs_id = _binding_set_id(bindings)
    rc_id = _replay_config_id(config)
    cm_id = capital_model_id(capital); co_id = cost_model_id(cost)

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
        replay_id=rid)
