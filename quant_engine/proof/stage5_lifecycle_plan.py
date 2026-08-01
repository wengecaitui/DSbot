"""Stage 5.4-A — Atomic lifecycle instruction contract."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

from quant_engine.proof.stage5_evaluation import canonical_sha256

SCHEMA = "stage-5.lifecycle-instruction.v1"
PLAN_SCHEMA = "stage-5.lifecycle-plan.v1"
PLAN_POLICY = "ATOMIC_REVERSAL_TERMINAL_NEXT_OPEN_V1"
TIMEFRAME = 300_000
_SHA = re.compile(r"^[a-f0-9]{64}$")


def _vsha(v, label):
    if not isinstance(v, str):
        raise ValueError(f"{label}_MALFORMED")
    if not _SHA.fullmatch(v):
        raise ValueError(f"{label}_MALFORMED")


def _vint(v, label):
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"{label}_NOT_INT")
    if v < 0:
        raise ValueError(f"{label}_NEGATIVE")


class Stage5LifecycleAction(str, Enum):
    ENTER_LONG = "enter-long"
    ENTER_SHORT = "enter-short"
    EXIT = "exit"
    REVERSE_TO_LONG = "reverse-to-long"
    REVERSE_TO_SHORT = "reverse-to-short"
    TERMINAL_EXIT = "terminal-exit"


class Stage5LifecycleOrigin(str, Enum):
    STRATEGY = "strategy"
    TERMINAL_POLICY = "terminal-policy"


def _instruction_payload(inst) -> dict:
    return {
        "schemaVersion": inst.schema_version,
        "signalBarOpenTimeMs": inst.signal_bar_open_time_ms,
        "executionBarOpenTimeMs": inst.execution_bar_open_time_ms,
        "action": inst.action.value,
        "origin": inst.origin.value,
    }


@dataclass(frozen=True)
class Stage5LifecycleInstruction:
    schema_version: str
    signal_bar_open_time_ms: int
    execution_bar_open_time_ms: int
    action: Stage5LifecycleAction
    origin: Stage5LifecycleOrigin
    instruction_id: str

    def __post_init__(self):
        if self.schema_version != SCHEMA:
            raise ValueError("INSTRUCTION_SCHEMA_INVALID")
        _vint(self.signal_bar_open_time_ms, "INSTR_SIGNAL")
        _vint(self.execution_bar_open_time_ms, "INSTR_EXECUTION")
        if self.execution_bar_open_time_ms != self.signal_bar_open_time_ms + TIMEFRAME:
            raise ValueError("INSTR_EXECUTION_NOT_NEXT_OPEN")
        if type(self.action) is not Stage5LifecycleAction:
            raise ValueError("INSTR_ACTION_NOT_ENUM")
        if type(self.origin) is not Stage5LifecycleOrigin:
            raise ValueError("INSTR_ORIGIN_NOT_ENUM")
        if self.action == Stage5LifecycleAction.TERMINAL_EXIT:
            if self.origin != Stage5LifecycleOrigin.TERMINAL_POLICY:
                raise ValueError("INSTR_TERMINAL_MUST_BE_POLICY")
        else:
            if self.origin != Stage5LifecycleOrigin.STRATEGY:
                raise ValueError("INSTR_NON_TERMINAL_MUST_BE_STRATEGY")
        expected = canonical_sha256(_instruction_payload(self))
        if self.instruction_id != expected:
            raise ValueError("INSTRUCTION_ID_MISMATCH")


def create_stage5_lifecycle_instruction(
    signal_bar_open_time_ms: int,
    action: Stage5LifecycleAction,
    origin: Stage5LifecycleOrigin,
) -> Stage5LifecycleInstruction:
    """Deterministic factory. Caller cannot supply the ID."""
    if type(signal_bar_open_time_ms) is not int:
        raise ValueError("FACTORY_SIGNAL_TYPE_INVALID")
    if signal_bar_open_time_ms < 0:
        raise ValueError("FACTORY_SIGNAL_INVALID")
    if type(action) is not Stage5LifecycleAction:
        raise ValueError("FACTORY_ACTION_INVALID")
    if type(origin) is not Stage5LifecycleOrigin:
        raise ValueError("FACTORY_ORIGIN_INVALID")
    p = {
        "schemaVersion": SCHEMA,
        "signalBarOpenTimeMs": signal_bar_open_time_ms,
        "executionBarOpenTimeMs": signal_bar_open_time_ms + TIMEFRAME,
        "action": action.value,
        "origin": origin.value,
    }
    return Stage5LifecycleInstruction(
        schema_version=SCHEMA,
        signal_bar_open_time_ms=signal_bar_open_time_ms,
        execution_bar_open_time_ms=signal_bar_open_time_ms + TIMEFRAME,
        action=action,
        origin=origin,
        instruction_id=canonical_sha256(p),
    )


def _plan_payload(plan) -> dict:
    return {
        "schemaVersion": plan.schema_version,
        "policy": plan.policy,
        "strategyId": plan.strategy_id,
        "specId": plan.spec_id,
        "parameterId": plan.parameter_id,
        "datasetId": plan.dataset_id,
        "symbol": plan.symbol,
        "timeframeMs": plan.timeframe_ms,
        "warmupBars": plan.warmup_bars,
        "scoredStartOpenTimeMs": plan.scored_start_open_time_ms,
        "scoredEndExclusiveOpenTimeMs": plan.scored_end_exclusive_open_time_ms,
        "terminalExecutionBarOpenTimeMs": plan.terminal_execution_bar_open_time_ms,
        "instructionIds": [i.instruction_id for i in plan.instructions],
        "instructionCount": plan.instruction_count,
        "reversalCount": plan.reversal_count,
        "terminalExitCount": plan.terminal_exit_count,
        "initialState": plan.initial_state,
        "finalState": plan.final_state,
    }


@dataclass(frozen=True)
class Stage5LifecyclePlan:
    schema_version: str
    policy: str
    strategy_id: str
    spec_id: str
    parameter_id: str
    dataset_id: str
    symbol: str
    timeframe_ms: int
    warmup_bars: int
    scored_start_open_time_ms: int
    scored_end_exclusive_open_time_ms: int
    terminal_execution_bar_open_time_ms: int
    instructions: tuple[Stage5LifecycleInstruction, ...]
    instruction_count: int
    reversal_count: int
    terminal_exit_count: int
    initial_state: str
    final_state: str
    plan_id: str

    def __post_init__(self):
        if self.schema_version != PLAN_SCHEMA:
            raise ValueError("PLAN_SCHEMA_INVALID")
        if self.policy != PLAN_POLICY:
            raise ValueError("PLAN_POLICY_INVALID")
        if type(self.timeframe_ms) is not int:
            raise ValueError("PLAN_TIMEFRAME_NOT_INT")
        if self.timeframe_ms != TIMEFRAME:
            raise ValueError("PLAN_TIMEFRAME_INVALID")
        if self.initial_state != "FLAT":
            raise ValueError("PLAN_INITIAL_NOT_FLAT")
        if self.final_state != "FLAT":
            raise ValueError("PLAN_FINAL_NOT_FLAT")
        if not isinstance(self.strategy_id, str):
            raise ValueError("PLAN_STRATEGY_NOT_STRING")
        if not self.strategy_id:
            raise ValueError("PLAN_STRATEGY_INVALID")
        _vsha(self.spec_id, "PLAN_SPEC_ID")
        _vsha(self.parameter_id, "PLAN_PARAM_ID")
        _vsha(self.dataset_id, "PLAN_DATASET_ID")
        _vsha(self.plan_id, "PLAN_PLAN_ID")
        if not isinstance(self.symbol, str):
            raise ValueError("PLAN_SYMBOL_NOT_STRING")
        if not self.symbol:
            raise ValueError("PLAN_SYMBOL_INVALID")
        _vint(self.warmup_bars, "PLAN_WARMUP")
        if self.warmup_bars <= 0:
            raise ValueError("PLAN_WARMUP_ZERO")
        _vint(self.scored_start_open_time_ms, "PLAN_START")
        _vint(self.scored_end_exclusive_open_time_ms, "PLAN_END")
        _vint(self.terminal_execution_bar_open_time_ms, "PLAN_TERMINAL_EXEC")
        if self.scored_start_open_time_ms >= self.scored_end_exclusive_open_time_ms:
            raise ValueError("PLAN_WINDOW_INVALID")
        if self.terminal_execution_bar_open_time_ms != self.scored_end_exclusive_open_time_ms:
            raise ValueError("PLAN_TERMINAL_NOT_END")
        if self.scored_start_open_time_ms % TIMEFRAME != 0:
            raise ValueError("PLAN_START_NOT_ALIGNED")
        if self.scored_end_exclusive_open_time_ms % TIMEFRAME != 0:
            raise ValueError("PLAN_END_NOT_ALIGNED")
        _vint(self.instruction_count, "PLAN_INSTR_COUNT")
        _vint(self.reversal_count, "PLAN_REV_COUNT")
        _vint(self.terminal_exit_count, "PLAN_TERM_COUNT")
        if self.terminal_exit_count not in (0, 1):
            raise ValueError("PLAN_TERMINAL_COUNT_INVALID")
        if type(self.instructions) is not tuple:
            raise ValueError("PLAN_INSTR_NOT_TUPLE")
        if len(self.instructions) != self.instruction_count:
            raise ValueError("PLAN_INSTR_COUNT_MISMATCH")

        seen_times = set()
        prev = -1
        for i, inst in enumerate(self.instructions):
            if type(inst) is not Stage5LifecycleInstruction:
                raise ValueError(f"PLAN_INSTR_TYPE_{i}")
            Stage5LifecycleInstruction.__post_init__(inst)
            if inst.signal_bar_open_time_ms in seen_times:
                raise ValueError(f"PLAN_DUPLICATE_SIGNAL_{i}")
            if inst.signal_bar_open_time_ms <= prev:
                raise ValueError(f"PLAN_SIGNAL_NOT_INCREASING_{i}")
            seen_times.add(inst.signal_bar_open_time_ms)
            prev = inst.signal_bar_open_time_ms
            if inst.signal_bar_open_time_ms < self.scored_start_open_time_ms:
                raise ValueError(f"PLAN_SIGNAL_BEFORE_START_{i}")
            if inst.signal_bar_open_time_ms >= self.scored_end_exclusive_open_time_ms:
                raise ValueError(f"PLAN_SIGNAL_AFTER_END_{i}")
            if inst.execution_bar_open_time_ms > self.terminal_execution_bar_open_time_ms:
                raise ValueError(f"PLAN_EXEC_BEYOND_TERMINAL_{i}")
            if inst.signal_bar_open_time_ms % self.timeframe_ms != 0:
                raise ValueError(f"PLAN_SIGNAL_NOT_ALIGNED_{i}")
            if inst.execution_bar_open_time_ms % self.timeframe_ms != 0:
                raise ValueError(f"PLAN_EXEC_NOT_ALIGNED_{i}")

        state = "FLAT"
        rev_count = 0
        for i, inst in enumerate(self.instructions):
            action = inst.action
            if action == Stage5LifecycleAction.TERMINAL_EXIT:
                if state == "FLAT":
                    raise ValueError(f"PLAN_TERMINAL_WHILE_FLAT_{i}")
                if i != len(self.instructions) - 1:
                    raise ValueError(f"PLAN_TERMINAL_NOT_FINAL_{i}")
                if inst.signal_bar_open_time_ms != self.scored_end_exclusive_open_time_ms - TIMEFRAME:
                    raise ValueError(f"PLAN_TERMINAL_WRONG_SIGNAL_{i}")
                state = "FLAT"
            elif action == Stage5LifecycleAction.EXIT:
                if state == "FLAT":
                    raise ValueError(f"PLAN_EXIT_WHILE_FLAT_{i}")
                state = "FLAT"
            elif action == Stage5LifecycleAction.ENTER_LONG:
                if state != "FLAT":
                    raise ValueError(f"PLAN_ENTRY_WHILE_OPEN_{i}")
                state = "LONG"
            elif action == Stage5LifecycleAction.ENTER_SHORT:
                if state != "FLAT":
                    raise ValueError(f"PLAN_ENTRY_WHILE_OPEN_{i}")
                state = "SHORT"
            elif action == Stage5LifecycleAction.REVERSE_TO_LONG:
                if state != "SHORT":
                    raise ValueError(f"PLAN_REVERSE_WRONG_STATE_{i}")
                state = "LONG"
                rev_count += 1
            elif action == Stage5LifecycleAction.REVERSE_TO_SHORT:
                if state != "LONG":
                    raise ValueError(f"PLAN_REVERSE_WRONG_STATE_{i}")
                state = "SHORT"
                rev_count += 1
        if state != "FLAT":
            raise ValueError("PLAN_NOT_FLAT_AT_END")
        if rev_count != self.reversal_count:
            raise ValueError("PLAN_REVERSAL_COUNT_MISMATCH")

        # Recompute actual terminal count from instructions
        actual_term = sum(1 for i in self.instructions if i.action == Stage5LifecycleAction.TERMINAL_EXIT)
        if actual_term != self.terminal_exit_count:
            raise ValueError("PLAN_TERMINAL_COUNT_MISMATCH")

        expected = canonical_sha256(_plan_payload(self))
        if self.plan_id != expected:
            raise ValueError("PLAN_ID_MISMATCH")


def build_stage5_lifecycle_plan(
    *, strategy_id, spec_id, parameter_id, dataset_id, symbol,
    warmup_bars, scored_start_open_time_ms, scored_end_exclusive_open_time_ms,
    terminal_execution_bar_open_time_ms, instructions,
) -> Stage5LifecyclePlan:
    # --- primitive validation: no hostile object may reach canonical_sha256 ---
    if not isinstance(strategy_id, str):
        raise ValueError("BUILD_STRATEGY_NOT_STRING")
    if not strategy_id:
        raise ValueError("BUILD_STRATEGY_EMPTY")
    if not isinstance(symbol, str):
        raise ValueError("BUILD_SYMBOL_NOT_STRING")
    if not symbol:
        raise ValueError("BUILD_SYMBOL_EMPTY")
    _vsha(spec_id, "BUILD_SPEC_ID")
    _vsha(parameter_id, "BUILD_PARAM_ID")
    _vsha(dataset_id, "BUILD_DATASET_ID")
    if type(warmup_bars) is not int:
        raise ValueError("BUILD_WARMUP_NOT_INT")
    if warmup_bars <= 0:
        raise ValueError("BUILD_WARMUP_INVALID")
    if type(scored_start_open_time_ms) is not int:
        raise ValueError("BUILD_START_NOT_INT")
    if scored_start_open_time_ms < 0:
        raise ValueError("BUILD_START_NEGATIVE")
    if type(scored_end_exclusive_open_time_ms) is not int:
        raise ValueError("BUILD_END_NOT_INT")
    if scored_end_exclusive_open_time_ms < 0:
        raise ValueError("BUILD_END_NEGATIVE")
    if type(terminal_execution_bar_open_time_ms) is not int:
        raise ValueError("BUILD_TERMINAL_NOT_INT")
    if terminal_execution_bar_open_time_ms < 0:
        raise ValueError("BUILD_TERMINAL_NEGATIVE")
    if scored_start_open_time_ms >= scored_end_exclusive_open_time_ms:
        raise ValueError("BUILD_WINDOW_INVALID")
    if terminal_execution_bar_open_time_ms != scored_end_exclusive_open_time_ms:
        raise ValueError("BUILD_TERMINAL_NOT_END")
    if scored_start_open_time_ms % TIMEFRAME != 0:
        raise ValueError("BUILD_START_NOT_ALIGNED")
    if scored_end_exclusive_open_time_ms % TIMEFRAME != 0:
        raise ValueError("BUILD_END_NOT_ALIGNED")
    if type(instructions) is not tuple:
        raise ValueError("BUILD_INSTRUCTIONS_NOT_TUPLE")
    for i, inst in enumerate(instructions):
        if type(inst) is not Stage5LifecycleInstruction:
            raise ValueError(f"BUILD_INSTR_TYPE_{i}")
        Stage5LifecycleInstruction.__post_init__(inst)
    rev_count = sum(1 for i in instructions if i.action in (
        Stage5LifecycleAction.REVERSE_TO_LONG,
        Stage5LifecycleAction.REVERSE_TO_SHORT))
    term_count = sum(1 for i in instructions if i.action == Stage5LifecycleAction.TERMINAL_EXIT)
    p = {
        "schemaVersion": PLAN_SCHEMA, "policy": PLAN_POLICY,
        "strategyId": strategy_id, "specId": spec_id,
        "parameterId": parameter_id, "datasetId": dataset_id,
        "symbol": symbol, "timeframeMs": TIMEFRAME,
        "warmupBars": warmup_bars,
        "scoredStartOpenTimeMs": scored_start_open_time_ms,
        "scoredEndExclusiveOpenTimeMs": scored_end_exclusive_open_time_ms,
        "terminalExecutionBarOpenTimeMs": terminal_execution_bar_open_time_ms,
        "instructionIds": [i.instruction_id for i in instructions],
        "instructionCount": len(instructions),
        "reversalCount": rev_count, "terminalExitCount": term_count,
        "initialState": "FLAT", "finalState": "FLAT",
    }
    return Stage5LifecyclePlan(
        schema_version=PLAN_SCHEMA, policy=PLAN_POLICY,
        strategy_id=strategy_id, spec_id=spec_id,
        parameter_id=parameter_id, dataset_id=dataset_id,
        symbol=symbol, timeframe_ms=TIMEFRAME,
        warmup_bars=warmup_bars,
        scored_start_open_time_ms=scored_start_open_time_ms,
        scored_end_exclusive_open_time_ms=scored_end_exclusive_open_time_ms,
        terminal_execution_bar_open_time_ms=terminal_execution_bar_open_time_ms,
        instructions=instructions,
        instruction_count=len(instructions),
        reversal_count=rev_count, terminal_exit_count=term_count,
        initial_state="FLAT", final_state="FLAT",
        plan_id=canonical_sha256(p),
    )


def verify_stage5_lifecycle_plan(
    *, plan, strategy_id, spec_id, parameter_id, dataset_id,
    symbol, warmup_bars, scored_start_open_time_ms,
    scored_end_exclusive_open_time_ms, terminal_execution_bar_open_time_ms,
    instructions,
) -> Stage5LifecyclePlan:
    if type(plan) is not Stage5LifecyclePlan:
        raise ValueError("VERIFY_PLAN_TYPE_INVALID")
    Stage5LifecyclePlan.__post_init__(plan)
    for inst in plan.instructions:
        Stage5LifecycleInstruction.__post_init__(inst)
    recomputed = build_stage5_lifecycle_plan(
        strategy_id=strategy_id, spec_id=spec_id, parameter_id=parameter_id,
        dataset_id=dataset_id, symbol=symbol, warmup_bars=warmup_bars,
        scored_start_open_time_ms=scored_start_open_time_ms,
        scored_end_exclusive_open_time_ms=scored_end_exclusive_open_time_ms,
        terminal_execution_bar_open_time_ms=terminal_execution_bar_open_time_ms,
        instructions=instructions,
    )
    if plan.plan_id != recomputed.plan_id:
        raise ValueError("VERIFY_PLAN_ID_MISMATCH")
    if plan != recomputed:
        raise ValueError("VERIFY_PLAN_CONTENT_MISMATCH")
    return plan
