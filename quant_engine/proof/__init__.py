"""Fail-closed infrastructure for private strategy-readiness proofs."""

from .gap_policy import GapPolicy, audit_ohlcv
from .strategy_adapter import Action, Decision, StrategyAdapter, StrategyContext, simulate_window
from .walk_forward import WalkForwardConfig, run_causal_walk_forward

__all__ = [
    "Action",
    "Decision",
    "GapPolicy",
    "StrategyAdapter",
    "StrategyContext",
    "WalkForwardConfig",
    "audit_ohlcv",
    "run_causal_walk_forward",
    "simulate_window",
]
