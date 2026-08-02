"""Stage 5R1.3-G — Strategy Intent → Protective Replay Bridge.

Accepts a Stage5IntentCompilation and maps its lifecycle plan to
the Stage 5R1 deterministic protective replay infrastructure.

Per-trade side (no global inference), TERMINAL_EXIT as EXIT,
fail-closed on reversals, immutable lineage, compilation re-validation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

from quant_engine.proof.stage5_evaluation import canonical_sha256
from quant_engine.proof.stage5_intent_compiler import Stage5IntentCompilation
from quant_engine.proof.stage5_lifecycle_plan import (
    Stage5LifecycleAction, Stage5LifecyclePlan,
)
from quant_engine.proof.stage5r1_replay import (
    ReplayAction, ReplayConfig, ReplayInstruction, ReplayBar,
    validate_bar_sequence,
)
from quant_engine.proof.stage5r1_capital import CapitalModel, CostModel, PositionSide
from quant_engine.proof.stage5r1_protective_exit import ProtectiveExitPlan
from quant_engine.proof.stage5r1_protective_replay import (
    ProtectiveReplayBinding, ProtectiveReplayResult,
    run_stage5r1_protective_replay,
)

BRIDGE_SCHEMA = "stage-5r1.protective-strategy-bridge.v1"
_SHA_RE = re.compile(r"^[a-f0-9]{64}$")
TIMEFRAME_MS = 300000


def _vsha(v, label):
    if not isinstance(v, str) or not _SHA_RE.fullmatch(v):
        raise ValueError(f"{label}_MALFORMED")


def _action_to_side(action: Stage5LifecycleAction) -> PositionSide:
    if action is Stage5LifecycleAction.ENTER_LONG:
        return PositionSide.LONG
    if action is Stage5LifecycleAction.ENTER_SHORT:
        return PositionSide.SHORT
    raise ValueError(f"NOT_ENTER_ACTION: {action}")


# --- Bridge Result ---

@dataclass(frozen=True)
class ProtectiveStrategyBridgeResult:
    compilation_id: str
    replay_result: ProtectiveReplayResult
    bridge_id: str

    def __init__(self, *, compilation_id: str,
                 replay_result: ProtectiveReplayResult) -> None:
        _vsha(compilation_id, "COMPILATION_ID")
        if type(replay_result) is not ProtectiveReplayResult:
            raise ValueError("REPLAY_RESULT_TYPE_INVALID")
        bid = canonical_sha256({
            "schemaVersion": BRIDGE_SCHEMA,
            "compilationId": compilation_id,
            "replayId": replay_result.replay_id,
        })
        for k, v in [("compilation_id", compilation_id),
                      ("replay_result", replay_result),
                      ("bridge_id", bid)]:
            object.__setattr__(self, k, v)


# --- Main ---

def run_protective_strategy_replay(
    *, bars: Sequence[ReplayBar],
    compilation: Stage5IntentCompilation,
    stop_loss_bps: int = 100,
    take_profit_bps: int = 200,
    capital: CapitalModel,
    cost: CostModel,
) -> ProtectiveStrategyBridgeResult:
    """Map Stage5IntentCompilation → Protective Replay.

    Re-executes Stage5IntentCompilation.__post_init__() before use to
    reject forged or tampered compilation objects.  Symbol is taken from
    compilation.plan.symbol — no independent symbol input.
    """
    if type(compilation) is not Stage5IntentCompilation:
        raise ValueError("COMPILATION_TYPE_INVALID")
    # Re-validate compilation: forged/tampered objects fail here
    Stage5IntentCompilation.__post_init__(compilation)
    if type(capital) is not CapitalModel:
        raise ValueError("CAPITAL_TYPE_INVALID")
    if type(cost) is not CostModel:
        raise ValueError("COST_TYPE_INVALID")
    if isinstance(stop_loss_bps, bool) or type(stop_loss_bps) is not int or stop_loss_bps <= 0:
        raise ValueError("SL_BPS_INVALID")
    if isinstance(take_profit_bps, bool) or type(take_profit_bps) is not int or take_profit_bps <= 0:
        raise ValueError("TP_BPS_INVALID")

    plan = compilation.plan
    if type(plan) is not Stage5LifecyclePlan:
        raise ValueError("PLAN_TYPE_INVALID")

    # Symbol is bound to the plan
    symbol = plan.symbol

    valid_bars = validate_bar_sequence(bars)
    bar_by_time = {b.open_time_ms: b for b in valid_bars}

    replay_instructions: list[ReplayInstruction] = []
    protective_bindings: list[ProtectiveReplayBinding] = []

    for inst in plan.instructions:
        a = inst.action
        sig_time = inst.signal_bar_open_time_ms

        # Fail-closed on reversals
        if a in (Stage5LifecycleAction.REVERSE_TO_LONG,
                 Stage5LifecycleAction.REVERSE_TO_SHORT):
            raise ValueError(f"REVERSAL_NOT_SUPPORTED: {a.value}")

        # Map to replay action
        if a is Stage5LifecycleAction.TERMINAL_EXIT:
            ra = ReplayAction.EXIT
        elif a is Stage5LifecycleAction.EXIT:
            ra = ReplayAction.EXIT
        elif a is Stage5LifecycleAction.ENTER_LONG:
            ra = ReplayAction.ENTER_LONG
        elif a is Stage5LifecycleAction.ENTER_SHORT:
            ra = ReplayAction.ENTER_SHORT
        else:
            raise ValueError(f"UNSUPPORTED_ACTION: {a}")

        replay_instructions.append(
            ReplayInstruction(signal_bar_open_time_ms=sig_time, action=ra))

        # Per-trade protective binding
        if a in (Stage5LifecycleAction.ENTER_LONG,
                 Stage5LifecycleAction.ENTER_SHORT):
            entry_bar = bar_by_time.get(sig_time + TIMEFRAME_MS)
            if entry_bar is None:
                raise ValueError(f"ENTRY_BAR_NOT_FOUND: {sig_time + TIMEFRAME_MS}")

            side = _action_to_side(a)
            entry_price = entry_bar.open
            if side is PositionSide.LONG:
                stop_price = entry_price * (1 - stop_loss_bps / 10000)
                tp_price = entry_price * (1 + take_profit_bps / 10000)
            else:
                stop_price = entry_price * (1 + stop_loss_bps / 10000)
                tp_price = entry_price * (1 - take_profit_bps / 10000)

            exit_plan = ProtectiveExitPlan(
                side=side, entry_reference_price=entry_price,
                stop_price=stop_price, take_profit_price=tp_price)
            protective_bindings.append(ProtectiveReplayBinding(
                entry_signal_bar_open_time_ms=sig_time, plan=exit_plan))

    replay_result = run_stage5r1_protective_replay(
        bars=valid_bars, instructions=tuple(replay_instructions),
        protective_bindings=tuple(protective_bindings),
        config=ReplayConfig(symbol=symbol), capital=capital, cost=cost)

    return ProtectiveStrategyBridgeResult(
        compilation_id=compilation.compilation_id,
        replay_result=replay_result)
