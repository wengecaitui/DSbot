"""Stage 5R1.3-G — Strategy Intent → Protective Replay Bridge.

Connects the Stage 5 intent compilation pipeline to Stage 5R1
deterministic protective replay.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

from quant_engine.proof.stage5_evaluation import canonical_sha256
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

PROTECTIVE_STRATEGY_SCHEMA = "stage-5r1.protective-strategy-bridge.v1"
_SHA_RE = re.compile(r"^[a-f0-9]{64}$")
TIMEFRAME_MS = 300000


def _vsha(v, label):
    if not isinstance(v, str) or not _SHA_RE.fullmatch(v):
        raise ValueError(f"{label}_MALFORMED")


@dataclass(frozen=True)
class ProtectiveStrategyPlan:
    """Protective exit parameters bound to a strategy intent."""
    schema_version: str
    plan_id: str
    side: PositionSide
    stop_loss_bps: int
    take_profit_bps: int

    def __init__(self, *, plan: Stage5LifecyclePlan,
                 stop_loss_bps: int, take_profit_bps: int) -> None:
        if type(plan) is not Stage5LifecyclePlan:
            raise ValueError("PLAN_TYPE_INVALID")
        if isinstance(stop_loss_bps, bool) or type(stop_loss_bps) is not int or stop_loss_bps <= 0:
            raise ValueError("SL_BPS_INVALID")
        if isinstance(take_profit_bps, bool) or type(take_profit_bps) is not int or take_profit_bps <= 0:
            raise ValueError("TP_BPS_INVALID")

        # Infer side from first ENTER instruction
        first_enter = None
        for inst in plan.instructions:
            if inst.action in (Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleAction.ENTER_SHORT):
                first_enter = inst.action
                break
        if first_enter is None:
            raise ValueError("NO_ENTER_INSTRUCTION")
        side = PositionSide.LONG if first_enter is Stage5LifecycleAction.ENTER_LONG else PositionSide.SHORT

        pid = canonical_sha256({
            "schemaVersion": PROTECTIVE_STRATEGY_SCHEMA,
            "planId": plan.plan_id,
            "side": "LONG" if side is PositionSide.LONG else "SHORT",
            "stopLossBps": stop_loss_bps,
            "takeProfitBps": take_profit_bps,
        })

        for k, v in [("schema_version", PROTECTIVE_STRATEGY_SCHEMA),
                      ("plan_id", pid), ("side", side),
                      ("stop_loss_bps", stop_loss_bps),
                      ("take_profit_bps", take_profit_bps)]:
            object.__setattr__(self, k, v)


def run_protective_strategy_replay(
    *, bars: Sequence[ReplayBar],
    plan: Stage5LifecyclePlan,
    stop_loss_bps: int = 100,
    take_profit_bps: int = 200,
    capital: CapitalModel,
    cost: CostModel,
    symbol: str = "DEFAULT",
) -> tuple[ProtectiveStrategyPlan, ProtectiveReplayResult]:
    """Map lifecycle instructions → protective replay."""
    if type(plan) is not Stage5LifecyclePlan:
        raise ValueError("PLAN_TYPE_INVALID")
    if type(capital) is not CapitalModel:
        raise ValueError("CAPITAL_TYPE_INVALID")
    if type(cost) is not CostModel:
        raise ValueError("COST_TYPE_INVALID")
    if not symbol or not isinstance(symbol, str):
        raise ValueError("SYMBOL_INVALID")

    psp = ProtectiveStrategyPlan(
        plan=plan, stop_loss_bps=stop_loss_bps, take_profit_bps=take_profit_bps)
    valid_bars = validate_bar_sequence(bars)
    bar_by_time = {b.open_time_ms: b for b in valid_bars}

    replay_instructions: list[ReplayInstruction] = []
    protective_bindings: list[ProtectiveReplayBinding] = []

    action_map = {
        Stage5LifecycleAction.ENTER_LONG: ReplayAction.ENTER_LONG,
        Stage5LifecycleAction.ENTER_SHORT: ReplayAction.ENTER_SHORT,
        Stage5LifecycleAction.EXIT: ReplayAction.EXIT,
    }

    for inst in plan.instructions:
        sig_time = inst.signal_bar_open_time_ms
        ra = action_map.get(inst.action)
        if ra is None:
            raise ValueError(f"UNSUPPORTED_ACTION: {inst.action}")

        replay_instructions.append(
            ReplayInstruction(signal_bar_open_time_ms=sig_time, action=ra))

        if inst.action in (Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleAction.ENTER_SHORT):
            entry_bar = bar_by_time.get(sig_time + TIMEFRAME_MS)
            if entry_bar is None:
                raise ValueError(f"ENTRY_BAR_NOT_FOUND: {sig_time + TIMEFRAME_MS}")

            entry_price = entry_bar.open
            if psp.side is PositionSide.LONG:
                stop_price = entry_price * (1 - psp.stop_loss_bps / 10000)
                tp_price = entry_price * (1 + psp.take_profit_bps / 10000)
            else:
                stop_price = entry_price * (1 + psp.stop_loss_bps / 10000)
                tp_price = entry_price * (1 - psp.take_profit_bps / 10000)

            exit_plan = ProtectiveExitPlan(
                side=psp.side, entry_reference_price=entry_price,
                stop_price=stop_price, take_profit_price=tp_price)
            protective_bindings.append(
                ProtectiveReplayBinding(entry_signal_bar_open_time_ms=sig_time, plan=exit_plan))

    replay_result = run_stage5r1_protective_replay(
        bars=valid_bars, instructions=tuple(replay_instructions),
        protective_bindings=tuple(protective_bindings),
        config=ReplayConfig(symbol=symbol), capital=capital, cost=cost)

    return psp, replay_result
