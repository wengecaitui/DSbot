"""Stage 5.4-B — Causal strategy intent compiler."""

from __future__ import annotations

import re
from dataclasses import dataclass

from quant_engine.proof.stage5_evaluation import canonical_sha256
from quant_engine.proof.stage5_lifecycle_plan import (
    Stage5LifecycleAction, Stage5LifecycleOrigin,
    Stage5LifecyclePlan,
    create_stage5_lifecycle_instruction,
    build_stage5_lifecycle_plan,
    TIMEFRAME,
)

OBS_SCHEMA = "stage-5.intent-observation.v1"
COMPILATION_SCHEMA = "stage-5.intent-compilation.v1"
COMPILATION_SCOPE = "STRATEGY_INTENT_ONLY"
_SHA = re.compile(r"^[a-f0-9]{64}$")


def _vsha(v, label):
    if type(v) is not str:
        raise ValueError(f"{label}_MALFORMED")
    if not _SHA.fullmatch(v):
        raise ValueError(f"{label}_MALFORMED")


def _vint(v, label):
    if isinstance(v, bool) or type(v) is not int:
        raise ValueError(f"{label}_NOT_INT")
    if v < 0:
        raise ValueError(f"{label}_NEGATIVE")


def _vbool(v, label):
    if type(v) is not bool:
        raise ValueError(f"{label}_NOT_BOOL")


def _obs_payload(obs) -> dict:
    return {
        "schemaVersion": obs.schema_version,
        "strategyId": obs.strategy_id,
        "specId": obs.spec_id,
        "parameterId": obs.parameter_id,
        "datasetId": obs.dataset_id,
        "symbol": obs.symbol,
        "signalBarOpenTimeMs": obs.signal_bar_open_time_ms,
        "hasOutputs": obs.has_outputs,
        "longEntry": obs.long_entry,
        "shortEntry": obs.short_entry,
        "longExit": obs.long_exit,
        "shortExit": obs.short_exit,
    }


@dataclass(frozen=True)
class Stage5StrategyIntentObservation:
    schema_version: str
    strategy_id: str
    spec_id: str
    parameter_id: str
    dataset_id: str
    symbol: str
    signal_bar_open_time_ms: int
    has_outputs: bool
    long_entry: bool
    short_entry: bool
    long_exit: bool
    short_exit: bool
    observation_id: str

    def __post_init__(self):
        if type(self.schema_version) is not str:
            raise ValueError("OBS_SCHEMA_NOT_STRING")
        if self.schema_version != OBS_SCHEMA:
            raise ValueError("OBS_SCHEMA_INVALID")
        if type(self.strategy_id) is not str:
            raise ValueError("OBS_STRATEGY_NOT_STRING")
        if not self.strategy_id:
            raise ValueError("OBS_STRATEGY_EMPTY")
        _vsha(self.spec_id, "OBS_SPEC_ID")
        _vsha(self.parameter_id, "OBS_PARAM_ID")
        _vsha(self.dataset_id, "OBS_DATASET_ID")
        if type(self.symbol) is not str:
            raise ValueError("OBS_SYMBOL_NOT_STRING")
        if not self.symbol:
            raise ValueError("OBS_SYMBOL_EMPTY")
        _vint(self.signal_bar_open_time_ms, "OBS_TIME")
        if self.signal_bar_open_time_ms % TIMEFRAME != 0:
            raise ValueError("OBS_TIME_NOT_ALIGNED")
        _vbool(self.has_outputs, "OBS_HAS_OUTPUTS")
        _vbool(self.long_entry, "OBS_LONG_ENTRY")
        _vbool(self.short_entry, "OBS_SHORT_ENTRY")
        _vbool(self.long_exit, "OBS_LONG_EXIT")
        _vbool(self.short_exit, "OBS_SHORT_EXIT")
        if not self.has_outputs:
            if self.long_entry or self.short_entry or self.long_exit or self.short_exit:
                raise ValueError("OBS_NO_OUTPUTS_BUT_RULES_TRUE")
        expected = canonical_sha256(_obs_payload(self))
        if self.observation_id != expected:
            raise ValueError("OBS_ID_MISMATCH")


def create_stage5_strategy_intent_observation(
    *, strategy_id, spec_id, parameter_id, dataset_id, symbol,
    signal_bar_open_time_ms, has_outputs,
    long_entry, short_entry, long_exit, short_exit,
) -> Stage5StrategyIntentObservation:
    if type(strategy_id) is not str:
        raise ValueError("OBS_FACTORY_STRATEGY_NOT_STRING")
    if not strategy_id:
        raise ValueError("OBS_FACTORY_STRATEGY_EMPTY")
    _vsha(spec_id, "OBS_FACTORY_SPEC_ID")
    _vsha(parameter_id, "OBS_FACTORY_PARAM_ID")
    _vsha(dataset_id, "OBS_FACTORY_DATASET_ID")
    if type(symbol) is not str:
        raise ValueError("OBS_FACTORY_SYMBOL_NOT_STRING")
    if not symbol:
        raise ValueError("OBS_FACTORY_SYMBOL_EMPTY")
    _vint(signal_bar_open_time_ms, "OBS_FACTORY_TIME")
    _vbool(has_outputs, "OBS_FACTORY_HAS")
    _vbool(long_entry, "OBS_FACTORY_LE")
    _vbool(short_entry, "OBS_FACTORY_SE")
    _vbool(long_exit, "OBS_FACTORY_LX")
    _vbool(short_exit, "OBS_FACTORY_SX")
    p = {
        "schemaVersion": OBS_SCHEMA,
        "strategyId": strategy_id, "specId": spec_id,
        "parameterId": parameter_id, "datasetId": dataset_id,
        "symbol": symbol,
        "signalBarOpenTimeMs": signal_bar_open_time_ms,
        "hasOutputs": has_outputs,
        "longEntry": long_entry, "shortEntry": short_entry,
        "longExit": long_exit, "shortExit": short_exit,
    }
    return Stage5StrategyIntentObservation(
        schema_version=OBS_SCHEMA,
        strategy_id=strategy_id, spec_id=spec_id,
        parameter_id=parameter_id, dataset_id=dataset_id,
        symbol=symbol,
        signal_bar_open_time_ms=signal_bar_open_time_ms,
        has_outputs=has_outputs,
        long_entry=long_entry, short_entry=short_entry,
        long_exit=long_exit, short_exit=short_exit,
        observation_id=canonical_sha256(p),
    )


def _compilation_payload(comp) -> dict:
    return {
        "schemaVersion": comp.schema_version,
        "scope": comp.scope,
        "planId": comp.plan.plan_id,
        "observationIds": list(comp.observation_ids),
        "maxHoldingBars": comp.max_holding_bars,
        "protectiveExecutionIncluded": comp.protective_execution_included,
        "replayCompatible": comp.replay_compatible,
        "requiresProtectiveStateBridge": comp.requires_protective_state_bridge,
    }


@dataclass(frozen=True)
class Stage5IntentCompilation:
    schema_version: str
    scope: str
    plan: Stage5LifecyclePlan
    observation_ids: tuple[str, ...]
    max_holding_bars: int
    protective_execution_included: bool
    replay_compatible: bool
    requires_protective_state_bridge: bool
    compilation_id: str

    def __post_init__(self):
        if type(self.schema_version) is not str:
            raise ValueError("COMPILATION_SCHEMA_NOT_STRING")
        if self.schema_version != COMPILATION_SCHEMA:
            raise ValueError("COMPILATION_SCHEMA_INVALID")
        if type(self.scope) is not str:
            raise ValueError("COMPILATION_SCOPE_NOT_STRING")
        if self.scope != COMPILATION_SCOPE:
            raise ValueError("COMPILATION_SCOPE_INVALID")
        if type(self.plan) is not Stage5LifecyclePlan:
            raise ValueError("COMPILATION_PLAN_TYPE_INVALID")
        Stage5LifecyclePlan.__post_init__(self.plan)
        if type(self.observation_ids) is not tuple:
            raise ValueError("COMPILATION_OBS_IDS_NOT_TUPLE")
        seen_ids = set()
        for i, oid in enumerate(self.observation_ids):
            if type(oid) is not str or not _SHA.fullmatch(oid):
                raise ValueError(f"COMPILATION_OBS_ID_MALFORMED_{i}")
            if oid in seen_ids:
                raise ValueError(f"COMPILATION_DUPLICATE_OBS_ID_{i}")
            seen_ids.add(oid)
        if type(self.max_holding_bars) is not int:
            raise ValueError("COMPILATION_MAX_HOLD_NOT_INT")
        if self.max_holding_bars <= 0:
            raise ValueError("COMPILATION_MAX_HOLD_INVALID")
        if self.protective_execution_included is not False:
            raise ValueError("COMPILATION_PROTECTIVE_NOT_FALSE")
        if self.replay_compatible is not False:
            raise ValueError("COMPILATION_REPLAY_NOT_FALSE")
        if self.requires_protective_state_bridge is not True:
            raise ValueError("COMPILATION_BRIDGE_NOT_TRUE")
        expected = canonical_sha256(_compilation_payload(self))
        if self.compilation_id != expected:
            raise ValueError("COMPILATION_ID_MISMATCH")


def compile_stage5_strategy_intent(
    *, strategy_id, spec_id, parameter_id, dataset_id, symbol,
    warmup_bars, max_holding_bars,
    scored_start_open_time_ms, scored_end_exclusive_open_time_ms,
    terminal_execution_bar_open_time_ms, observations,
) -> Stage5IntentCompilation:
    if type(strategy_id) is not str:
        raise ValueError("COMPILE_STRATEGY_NOT_STRING")
    if not strategy_id:
        raise ValueError("COMPILE_STRATEGY_EMPTY")
    if type(symbol) is not str:
        raise ValueError("COMPILE_SYMBOL_NOT_STRING")
    if not symbol:
        raise ValueError("COMPILE_SYMBOL_EMPTY")
    _vsha(spec_id, "COMPILE_SPEC_ID")
    _vsha(parameter_id, "COMPILE_PARAM_ID")
    _vsha(dataset_id, "COMPILE_DATASET_ID")
    if type(warmup_bars) is not int:
        raise ValueError("COMPILE_WARMUP_NOT_INT")
    if warmup_bars <= 0:
        raise ValueError("COMPILE_WARMUP_INVALID")
    if type(max_holding_bars) is not int:
        raise ValueError("COMPILE_MAX_HOLD_NOT_INT")
    if max_holding_bars <= 0:
        raise ValueError("COMPILE_MAX_HOLD_INVALID")
    for name, v in [("START", scored_start_open_time_ms),
                     ("END", scored_end_exclusive_open_time_ms),
                     ("TERMINAL", terminal_execution_bar_open_time_ms)]:
        if type(v) is not int:
            raise ValueError(f"COMPILE_{name}_NOT_INT")
        if v < 0:
            raise ValueError(f"COMPILE_{name}_NEGATIVE")
    if scored_start_open_time_ms >= scored_end_exclusive_open_time_ms:
        raise ValueError("COMPILE_WINDOW_INVALID")
    if terminal_execution_bar_open_time_ms != scored_end_exclusive_open_time_ms:
        raise ValueError("COMPILE_TERMINAL_NOT_END")
    if scored_start_open_time_ms % TIMEFRAME != 0:
        raise ValueError("COMPILE_START_NOT_ALIGNED")
    if scored_end_exclusive_open_time_ms % TIMEFRAME != 0:
        raise ValueError("COMPILE_END_NOT_ALIGNED")

    if type(observations) is not tuple:
        raise ValueError("COMPILE_OBS_NOT_TUPLE")
    obs_count = max(0, (scored_end_exclusive_open_time_ms - scored_start_open_time_ms) // TIMEFRAME - 1)
    if len(observations) != obs_count:
        raise ValueError("COMPILE_OBS_COUNT_MISMATCH")
    for i, obs in enumerate(observations):
        if type(obs) is not Stage5StrategyIntentObservation:
            raise ValueError(f"COMPILE_OBS_TYPE_{i}")
        Stage5StrategyIntentObservation.__post_init__(obs)
        expected_time = scored_start_open_time_ms + i * TIMEFRAME
        if obs.signal_bar_open_time_ms != expected_time:
            raise ValueError(f"COMPILE_OBS_TIME_MISMATCH_{i}")
        if obs.strategy_id != strategy_id:
            raise ValueError(f"COMPILE_OBS_STRATEGY_MISMATCH_{i}")
        if obs.spec_id != spec_id:
            raise ValueError(f"COMPILE_OBS_SPEC_MISMATCH_{i}")
        if obs.parameter_id != parameter_id:
            raise ValueError(f"COMPILE_OBS_PARAM_MISMATCH_{i}")
        if obs.dataset_id != dataset_id:
            raise ValueError(f"COMPILE_OBS_DATASET_MISMATCH_{i}")
        if obs.symbol != symbol:
            raise ValueError(f"COMPILE_OBS_SYMBOL_MISMATCH_{i}")

    terminal_bar_time = scored_end_exclusive_open_time_ms - TIMEFRAME
    instructions = []
    intended_position = "FLAT"
    bars_held = 0

    for obs in observations:
        bars_held += 1
        if not obs.has_outputs:
            continue
        if obs.long_entry and obs.short_entry:
            continue
        if intended_position == "LONG":
            if obs.short_entry:
                instructions.append(create_stage5_lifecycle_instruction(
                    obs.signal_bar_open_time_ms, Stage5LifecycleAction.REVERSE_TO_SHORT,
                    Stage5LifecycleOrigin.STRATEGY))
                intended_position = "SHORT"
                bars_held = 0
            elif obs.long_exit or bars_held >= max_holding_bars:
                instructions.append(create_stage5_lifecycle_instruction(
                    obs.signal_bar_open_time_ms, Stage5LifecycleAction.EXIT,
                    Stage5LifecycleOrigin.STRATEGY))
                intended_position = "FLAT"
                bars_held = 0
        elif intended_position == "SHORT":
            if obs.long_entry:
                instructions.append(create_stage5_lifecycle_instruction(
                    obs.signal_bar_open_time_ms, Stage5LifecycleAction.REVERSE_TO_LONG,
                    Stage5LifecycleOrigin.STRATEGY))
                intended_position = "LONG"
                bars_held = 0
            elif obs.short_exit or bars_held >= max_holding_bars:
                instructions.append(create_stage5_lifecycle_instruction(
                    obs.signal_bar_open_time_ms, Stage5LifecycleAction.EXIT,
                    Stage5LifecycleOrigin.STRATEGY))
                intended_position = "FLAT"
                bars_held = 0
        else:  # FLAT
            if obs.long_entry:
                instructions.append(create_stage5_lifecycle_instruction(
                    obs.signal_bar_open_time_ms, Stage5LifecycleAction.ENTER_LONG,
                    Stage5LifecycleOrigin.STRATEGY))
                intended_position = "LONG"
                bars_held = 0
            elif obs.short_entry:
                instructions.append(create_stage5_lifecycle_instruction(
                    obs.signal_bar_open_time_ms, Stage5LifecycleAction.ENTER_SHORT,
                    Stage5LifecycleOrigin.STRATEGY))
                intended_position = "SHORT"
                bars_held = 0

    if intended_position != "FLAT":
        instructions.append(create_stage5_lifecycle_instruction(
            terminal_bar_time, Stage5LifecycleAction.TERMINAL_EXIT,
            Stage5LifecycleOrigin.TERMINAL_POLICY))

    plan = build_stage5_lifecycle_plan(
        strategy_id=strategy_id, spec_id=spec_id, parameter_id=parameter_id,
        dataset_id=dataset_id, symbol=symbol, warmup_bars=warmup_bars,
        scored_start_open_time_ms=scored_start_open_time_ms,
        scored_end_exclusive_open_time_ms=scored_end_exclusive_open_time_ms,
        terminal_execution_bar_open_time_ms=terminal_execution_bar_open_time_ms,
        instructions=tuple(instructions),
    )

    obs_ids = tuple(o.observation_id for o in observations)
    p = {
        "schemaVersion": COMPILATION_SCHEMA, "scope": COMPILATION_SCOPE,
        "planId": plan.plan_id, "observationIds": list(obs_ids),
        "maxHoldingBars": max_holding_bars,
        "protectiveExecutionIncluded": False, "replayCompatible": False,
        "requiresProtectiveStateBridge": True,
    }
    return Stage5IntentCompilation(
        schema_version=COMPILATION_SCHEMA, scope=COMPILATION_SCOPE,
        plan=plan, observation_ids=obs_ids,
        max_holding_bars=max_holding_bars,
        protective_execution_included=False, replay_compatible=False,
        requires_protective_state_bridge=True,
        compilation_id=canonical_sha256(p),
    )


def verify_stage5_intent_compilation(
    *, compilation, strategy_id, spec_id, parameter_id, dataset_id, symbol,
    warmup_bars, max_holding_bars,
    scored_start_open_time_ms, scored_end_exclusive_open_time_ms,
    terminal_execution_bar_open_time_ms, observations,
) -> Stage5IntentCompilation:
    if type(compilation) is not Stage5IntentCompilation:
        raise ValueError("VERIFY_COMPILATION_TYPE_INVALID")
    Stage5IntentCompilation.__post_init__(compilation)
    recomputed = compile_stage5_strategy_intent(
        strategy_id=strategy_id, spec_id=spec_id, parameter_id=parameter_id,
        dataset_id=dataset_id, symbol=symbol,
        warmup_bars=warmup_bars, max_holding_bars=max_holding_bars,
        scored_start_open_time_ms=scored_start_open_time_ms,
        scored_end_exclusive_open_time_ms=scored_end_exclusive_open_time_ms,
        terminal_execution_bar_open_time_ms=terminal_execution_bar_open_time_ms,
        observations=observations,
    )
    if compilation.compilation_id != recomputed.compilation_id:
        raise ValueError("VERIFY_COMPILATION_ID_MISMATCH")
    if compilation != recomputed:
        raise ValueError("VERIFY_COMPILATION_CONTENT_MISMATCH")
    return compilation
