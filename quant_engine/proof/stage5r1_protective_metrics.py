"""Stage 5R1.3-F protective excursion metrics — composition-only analytics.

Consumes Stage E excursion results and Stage D protective bindings to
produce risk-aware performance metrics.  Does not modify lower layers.
"""

from __future__ import annotations

import math
import re
import statistics
from dataclasses import dataclass
from typing import Sequence

from quant_engine.proof.stage5r1_capital import PositionSide, TradeAccounting
from quant_engine.proof.stage5r1_protective_exit import (
    ProtectiveExitPlan,
    KIND_GAP_OPEN, KIND_INTRABAR_LEVEL,
    REASON_STOP_LOSS, REASON_TAKE_PROFIT,
)
from quant_engine.proof.stage5r1_protective_replay import (
    ProtectiveReplayBinding, ProtectiveReplayResult,
    _binding_set_id,
)
from quant_engine.proof.stage5r1_protective_excursion import (
    ProtectiveExcursionResult, ProtectiveExcursionTrade,
    ProtectiveTradeExcursion,
    verify_stage5r1_protective_excursion,
    SOURCE_FULL_BAR, SOURCE_FRONTIER_EXIT_OPEN,
    SOURCE_FRONTIER_TRIGGER_OPEN, SOURCE_FRONTIER_TRIGGER_LEVEL,
    PROTECTIVE_SOURCE, EXPLICIT_SOURCE,
)
from quant_engine.proof.stage5r1_metrics import (
    standard_profit_factor, return_profit_factor,
    aggregate_cost_accounting,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

# --- Schema ---

PROTECTIVE_METRICS_SCHEMA = "stage-5r1.protective-metrics.v1"
PROTECTIVE_METRICS_REPORT_SCHEMA = "stage-5r1.protective-metrics-report.v1"
PROTECTIVE_METRICS_POLICY = "stage-5r1.protective-excursion-metrics.v1"
PROTECTIVE_COST_METRICS_SCHEMA = "stage-5r1.protective-cost-metrics.v1"

RISK_DEFINED = "DEFINED"
EVAL_NO_TRADES = "NO_TRADES"
EVAL_MEASURED = "MEASURED"

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


def _vfinite(v, label):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{label}_NON_NUMERIC: {v!r}")
    if not math.isfinite(float(v)):
        raise ValueError(f"{label}_NON_FINITE: {v}")


# --- ProtectiveCostMetrics ---

def _cost_payload(c: ProtectiveCostMetrics) -> dict:
    return {
        "schemaVersion": c.schema_version,
        "spreadCostAmount": float(c.spread_cost_amount),
        "slippageCostAmount": float(c.slippage_cost_amount),
        "marketImpactCostAmount": float(c.market_impact_cost_amount),
        "feeAmount": float(c.fee_amount),
        "fundingAmount": float(c.funding_amount),
        "explicitCostAmount": float(c.explicit_cost_amount),
        "totalCostAmount": float(c.total_cost_amount),
        "costAsInitialEquityFraction": float(c.cost_as_initial_equity_fraction),
        "costAsAverageEntryEquityFraction": float(c.cost_as_average_entry_equity_fraction),
        "feeRateDisclosureSum": float(c.fee_rate_disclosure_sum),
        "spreadRateDisclosureSum": float(c.spread_rate_disclosure_sum),
        "slippageRateDisclosureSum": float(c.slippage_rate_disclosure_sum),
        "fundingRateDisclosureSum": float(c.funding_rate_disclosure_sum),
    }


@dataclass(frozen=True)
class ProtectiveCostMetrics:
    schema_version: str
    spread_cost_amount: float
    slippage_cost_amount: float
    market_impact_cost_amount: float
    fee_amount: float
    funding_amount: float
    explicit_cost_amount: float
    total_cost_amount: float
    cost_as_initial_equity_fraction: float
    cost_as_average_entry_equity_fraction: float
    fee_rate_disclosure_sum: float
    spread_rate_disclosure_sum: float
    slippage_rate_disclosure_sum: float
    funding_rate_disclosure_sum: float

    def __post_init__(self) -> None:
        if self.schema_version != PROTECTIVE_COST_METRICS_SCHEMA:
            raise ValueError("COST_SCHEMA_INVALID")
        for n in ("spread_cost_amount", "slippage_cost_amount", "market_impact_cost_amount",
                  "fee_amount", "funding_amount", "explicit_cost_amount", "total_cost_amount",
                  "cost_as_initial_equity_fraction", "cost_as_average_entry_equity_fraction",
                  "fee_rate_disclosure_sum", "spread_rate_disclosure_sum",
                  "slippage_rate_disclosure_sum", "funding_rate_disclosure_sum"):
            _vnonneg_finite(getattr(self, n), f"COST_{n.upper()}")
        if self.market_impact_cost_amount + self.explicit_cost_amount != self.total_cost_amount:
            raise ValueError("COST_TOTAL_MISMATCH")
        if (self.spread_cost_amount + self.slippage_cost_amount !=
                self.market_impact_cost_amount):
            raise ValueError("COST_MARKET_IMPACT_MISMATCH")


def _build_cost_metrics(d: dict) -> ProtectiveCostMetrics:
    return ProtectiveCostMetrics(
        schema_version=PROTECTIVE_COST_METRICS_SCHEMA,
        spread_cost_amount=float(d["spread_cost_amount"]),
        slippage_cost_amount=float(d["slippage_cost_amount"]),
        market_impact_cost_amount=float(d["market_impact_cost_amount"]),
        fee_amount=float(d["fee_amount"]),
        funding_amount=float(d["funding_amount"]),
        explicit_cost_amount=float(d["explicit_cost_amount"]),
        total_cost_amount=float(d["total_cost_amount"]),
        cost_as_initial_equity_fraction=float(d["cost_as_initial_equity_fraction"]),
        cost_as_average_entry_equity_fraction=float(d["cost_as_average_entry_equity_fraction"]),
        fee_rate_disclosure_sum=float(d["fee_rate_disclosure_sum"]),
        spread_rate_disclosure_sum=float(d["spread_rate_disclosure_sum"]),
        slippage_rate_disclosure_sum=float(d["slippage_rate_disclosure_sum"]),
        funding_rate_disclosure_sum=float(d["funding_rate_disclosure_sum"]),
    )


# --- ProtectiveTradeRiskMetrics ---

def _trade_metric_payload(m: ProtectiveTradeRiskMetrics) -> dict:
    return {
        "schemaVersion": m.schema_version,
        "side": m.side.value,
        "actualEntryFillPrice": float(m.actual_entry_fill_price),
        "stopPrice": float(m.stop_price),
        "quantity": float(m.quantity),
        "netPnlAmount": float(m.net_pnl_amount),
        "mfeAmountBeforeExitCosts": float(m.mfe_amount_before_exit_costs),
        "maeAmountBeforeExitCosts": float(m.mae_amount_before_exit_costs),
        "initialRiskPerUnit": float(m.initial_risk_per_unit),
        "initialRiskAmount": float(m.initial_risk_amount),
        "realizedNetR": float(m.realized_net_r),
        "mfeR": float(m.mfe_r),
        "maeR": float(m.mae_r),
        "fullPreExitBarCount": m.full_pre_exit_bar_count,
        "compositeTradeId": m.composite_trade_id,
        "excursionId": m.excursion_id,
        "bindingId": m.binding_id,
        "planId": m.plan_id,
        "protectiveResolutionId": m.protective_resolution_id,
        "accountingId": m.accounting_id,
        "riskStatus": m.risk_status,
    }


@dataclass(frozen=True)
class ProtectiveTradeRiskMetrics:
    schema_version: str
    side: PositionSide
    actual_entry_fill_price: float
    stop_price: float
    quantity: float
    net_pnl_amount: float
    mfe_amount_before_exit_costs: float
    mae_amount_before_exit_costs: float
    initial_risk_per_unit: float
    initial_risk_amount: float
    realized_net_r: float
    mfe_r: float
    mae_r: float
    full_pre_exit_bar_count: int
    composite_trade_id: str
    excursion_id: str
    binding_id: str
    plan_id: str
    protective_resolution_id: str
    accounting_id: str
    risk_status: str
    metric_id: str

    def __post_init__(self) -> None:
        if self.schema_version != PROTECTIVE_METRICS_SCHEMA:
            raise ValueError("METRIC_SCHEMA_INVALID")
        if self.risk_status != RISK_DEFINED:
            raise ValueError(f"METRIC_RISK_STATUS_INVALID: {self.risk_status}")
        if type(self.side) is not PositionSide:
            raise ValueError("METRIC_SIDE_INVALID")

        _vpos(self.actual_entry_fill_price, "METRIC_ENTRY_FILL")
        _vpos(self.stop_price, "METRIC_STOP")
        _vpos(self.quantity, "METRIC_QUANTITY")
        _vpos(self.initial_risk_per_unit, "METRIC_RISK_PER_UNIT")
        _vpos(self.initial_risk_amount, "METRIC_RISK_AMOUNT")
        _vfinite(self.net_pnl_amount, "METRIC_NET_PNL")
        _vnonneg_finite(self.mfe_amount_before_exit_costs, "METRIC_MFE_AMOUNT")
        _vnonneg_finite(self.mae_amount_before_exit_costs, "METRIC_MAE_AMOUNT")
        _vfinite(self.realized_net_r, "METRIC_REALIZED_R")
        _vnonneg_finite(self.mfe_r, "METRIC_MFE_R")
        _vnonneg_finite(self.mae_r, "METRIC_MAE_R")
        _vint(self.full_pre_exit_bar_count, "METRIC_HOLDING_BARS")

        _vsha(self.composite_trade_id, "METRIC_COMPOSITE_ID")
        _vsha(self.excursion_id, "METRIC_EXCURSION_ID")
        _vsha(self.binding_id, "METRIC_BINDING_ID")
        _vsha(self.plan_id, "METRIC_PLAN_ID")
        _vsha(self.protective_resolution_id, "METRIC_RESOLUTION_ID")
        _vsha(self.accounting_id, "METRIC_ACCOUNTING_ID")
        _vsha(self.metric_id, "METRIC_METRIC_ID")

        # Recompute risk arithmetic
        if self.side is PositionSide.LONG:
            if not (self.stop_price < self.actual_entry_fill_price):
                raise ValueError("RISK_RELATION_INVALID_LONG")
            exp_risk = self.actual_entry_fill_price - self.stop_price
        else:
            if not (self.stop_price > self.actual_entry_fill_price):
                raise ValueError("RISK_RELATION_INVALID_SHORT")
            exp_risk = self.stop_price - self.actual_entry_fill_price
        if self.initial_risk_per_unit != exp_risk:
            raise ValueError("METRIC_RISK_PER_UNIT_INCONSISTENT")
        exp_amt = self.quantity * exp_risk
        if self.initial_risk_amount != exp_amt:
            raise ValueError("METRIC_RISK_AMOUNT_INCONSISTENT")
        if self.realized_net_r != self.net_pnl_amount / exp_amt:
            raise ValueError("METRIC_REALIZED_R_INCONSISTENT")
        if self.mfe_r != self.mfe_amount_before_exit_costs / exp_amt:
            raise ValueError("METRIC_MFE_R_INCONSISTENT")
        if self.mae_r != self.mae_amount_before_exit_costs / exp_amt:
            raise ValueError("METRIC_MAE_R_INCONSISTENT")

        expected = canonical_sha256(_trade_metric_payload(self))
        if self.metric_id != expected:
            raise ValueError("METRIC_ID_MISMATCH")


# --- ProtectiveExcursionMetricCounts ---

@dataclass(frozen=True)
class ProtectiveExcursionMetricCounts:
    long_count: int
    short_count: int
    explicit_exit_count: int
    protective_exit_count: int
    stop_loss_count: int
    take_profit_count: int
    gap_open_count: int
    intrabar_level_count: int
    same_bar_collision_count: int
    zero_duration_count: int
    favorable_full_bar_count: int
    favorable_exit_open_count: int
    favorable_trigger_open_count: int
    favorable_trigger_level_count: int
    adverse_full_bar_count: int
    adverse_exit_open_count: int
    adverse_trigger_open_count: int
    adverse_trigger_level_count: int

    def __post_init__(self) -> None:
        for n in self.__dataclass_fields__:
            _vint(getattr(self, n), f"COUNTS_{n.upper()}")
        t = self.long_count + self.short_count
        if t != self.explicit_exit_count + self.protective_exit_count:
            raise ValueError("COUNTS_SOURCE_SUM_MISMATCH")
        if self.protective_exit_count != self.stop_loss_count + self.take_profit_count:
            raise ValueError("COUNTS_REASON_SUM_MISMATCH")
        if self.gap_open_count + self.intrabar_level_count != self.protective_exit_count:
            raise ValueError("COUNTS_KIND_SUM_MISMATCH")
        fav = (self.favorable_full_bar_count + self.favorable_exit_open_count +
               self.favorable_trigger_open_count + self.favorable_trigger_level_count)
        if fav != t:
            raise ValueError("COUNTS_FAV_SUM_MISMATCH")
        adv = (self.adverse_full_bar_count + self.adverse_exit_open_count +
               self.adverse_trigger_open_count + self.adverse_trigger_level_count)
        if adv != t:
            raise ValueError("COUNTS_ADV_SUM_MISMATCH")


# --- ProtectiveExcursionMetricsReport ---

def _report_payload(r: ProtectiveExcursionMetricsReport) -> dict:
    p = {
        "schemaVersion": r.schema_version,
        "policy": r.policy,
        "sourceExcursionResultId": r.source_excursion_result_id,
        "baseProtectiveReplayId": r.base_protective_replay_id,
        "datasetId": r.dataset_id,
        "instructionSetId": r.instruction_set_id,
        "bindingSetId": r.binding_set_id,
        "replayConfigId": r.replay_config_id,
        "capitalModelId": r.capital_model_id,
        "costModelId": r.cost_model_id,
        "symbol": r.symbol,
        "timeframeMs": r.timeframe_ms,
        "evaluationStatus": r.evaluation_status,
        "riskMetricsComplete": r.risk_metrics_complete,
        "tradeCount": r.trade_count,
        "tradeMetricIds": [m.metric_id for m in r.trade_metrics],
        "counts": {
            "long": r.counts.long_count, "short": r.counts.short_count,
            "explicitExit": r.counts.explicit_exit_count,
            "protectiveExit": r.counts.protective_exit_count,
            "stopLoss": r.counts.stop_loss_count,
            "takeProfit": r.counts.take_profit_count,
            "gapOpen": r.counts.gap_open_count,
            "intrabarLevel": r.counts.intrabar_level_count,
            "sameBarCollision": r.counts.same_bar_collision_count,
            "zeroDuration": r.counts.zero_duration_count,
            "favorableFullBar": r.counts.favorable_full_bar_count,
            "favorableExitOpen": r.counts.favorable_exit_open_count,
            "favorableTriggerOpen": r.counts.favorable_trigger_open_count,
            "favorableTriggerLevel": r.counts.favorable_trigger_level_count,
            "adverseFullBar": r.counts.adverse_full_bar_count,
            "adverseExitOpen": r.counts.adverse_exit_open_count,
            "adverseTriggerOpen": r.counts.adverse_trigger_open_count,
            "adverseTriggerLevel": r.counts.adverse_trigger_level_count,
        },
    }
    for agg_name in ("mean_mfe_return", "mean_mae_return", "mean_holding_bars",
                     "median_mfe_return", "median_mae_return", "median_holding_bars",
                     "max_mfe_return", "max_mae_return", "max_holding_bars",
                     "mean_realized_net_r", "median_realized_net_r",
                     "mean_mfe_r", "median_mfe_r", "max_mfe_r",
                     "mean_mae_r", "median_mae_r", "max_mae_r"):
        v = getattr(r, agg_name)
        p[agg_name] = float(v) if v is not None else None
    p["standardProfitFactor"] = float(r.standard_profit_factor) if r.standard_profit_factor is not None else None
    p["returnProfitFactor"] = float(r.return_profit_factor) if r.return_profit_factor is not None else None
    if r.cost_metrics is not None:
        p["costMetricsId"] = canonical_sha256(_cost_payload(r.cost_metrics))
    else:
        p["costMetricsId"] = None
    return p


@dataclass(frozen=True)
class ProtectiveExcursionMetricsReport:
    schema_version: str
    policy: str
    source_excursion_result_id: str
    base_protective_replay_id: str
    dataset_id: str
    instruction_set_id: str
    binding_set_id: str
    replay_config_id: str
    capital_model_id: str
    cost_model_id: str
    symbol: str
    timeframe_ms: int
    evaluation_status: str
    risk_metrics_complete: bool
    trade_count: int
    trade_metrics: tuple[ProtectiveTradeRiskMetrics, ...]
    counts: ProtectiveExcursionMetricCounts
    mean_mfe_return: float | None
    median_mfe_return: float | None
    max_mfe_return: float | None
    mean_mae_return: float | None
    median_mae_return: float | None
    max_mae_return: float | None
    mean_holding_bars: float | None
    median_holding_bars: float | None
    max_holding_bars: float | None
    mean_realized_net_r: float | None
    median_realized_net_r: float | None
    mean_mfe_r: float | None
    median_mfe_r: float | None
    max_mfe_r: float | None
    mean_mae_r: float | None
    median_mae_r: float | None
    max_mae_r: float | None
    standard_profit_factor: float | None
    return_profit_factor: float | None
    cost_metrics: ProtectiveCostMetrics | None
    report_id: str

    def __post_init__(self) -> None:
        if self.schema_version != PROTECTIVE_METRICS_REPORT_SCHEMA:
            raise ValueError("REPORT_SCHEMA_INVALID")
        if self.policy != PROTECTIVE_METRICS_POLICY:
            raise ValueError("REPORT_POLICY_INVALID")
        if self.evaluation_status not in (EVAL_NO_TRADES, EVAL_MEASURED):
            raise ValueError(f"REPORT_EVAL_STATUS_INVALID: {self.evaluation_status}")
        if type(self.risk_metrics_complete) is not bool:
            raise ValueError("REPORT_RISK_COMPLETE_NOT_BOOL")
        if not self.symbol or not isinstance(self.symbol, str):
            raise ValueError("REPORT_SYMBOL_INVALID")
        if type(self.timeframe_ms) is not int or self.timeframe_ms != 300000:
            raise ValueError("REPORT_TIMEFRAME_INVALID")

        _vsha(self.source_excursion_result_id, "REPORT_SOURCE_RESULT_ID")
        _vsha(self.base_protective_replay_id, "REPORT_REPLAY_ID")
        _vsha(self.dataset_id, "REPORT_DATASET_ID")
        _vsha(self.instruction_set_id, "REPORT_INSTRUCTION_ID")
        _vsha(self.binding_set_id, "REPORT_BINDING_ID")
        _vsha(self.replay_config_id, "REPORT_CONFIG_ID")
        _vsha(self.capital_model_id, "REPORT_CAPITAL_ID")
        _vsha(self.cost_model_id, "REPORT_COST_ID")
        _vsha(self.report_id, "REPORT_REPORT_ID")

        _vint(self.trade_count, "REPORT_TRADE_COUNT")
        if type(self.trade_metrics) is not tuple:
            raise ValueError("REPORT_TRADES_NOT_TUPLE")
        if len(self.trade_metrics) != self.trade_count:
            raise ValueError("REPORT_TRADE_METRIC_COUNT_MISMATCH")
        for i, m in enumerate(self.trade_metrics):
            if type(m) is not ProtectiveTradeRiskMetrics:
                raise ValueError(f"REPORT_METRIC_TYPE_{i}")

        if type(self.counts) is not ProtectiveExcursionMetricCounts:
            raise ValueError("REPORT_COUNTS_TYPE_INVALID")

        if self.evaluation_status == EVAL_NO_TRADES:
            if self.trade_count != 0:
                raise ValueError("REPORT_NO_TRADES_NONZERO_COUNT")
            if self.risk_metrics_complete:
                raise ValueError("REPORT_NO_TRADES_RISK_COMPLETE")
            for agg in ("mean_mfe_return", "median_mfe_return", "max_mfe_return",
                        "mean_mae_return", "median_mae_return", "max_mae_return",
                        "mean_holding_bars", "median_holding_bars", "max_holding_bars",
                        "mean_realized_net_r", "median_realized_net_r",
                        "mean_mfe_r", "median_mfe_r", "max_mfe_r",
                        "mean_mae_r", "median_mae_r", "max_mae_r"):
                if getattr(self, agg) is not None:
                    raise ValueError(f"REPORT_NO_TRADES_{agg.upper()}_NOT_NULL")
            if self.standard_profit_factor is not None:
                raise ValueError("REPORT_NO_TRADES_PF_NOT_NULL")
            if self.cost_metrics is not None:
                raise ValueError("REPORT_NO_TRADES_COST_NOT_NULL")
        else:
            if self.trade_count <= 0:
                raise ValueError("REPORT_MEASURED_ZERO_COUNT")
            if not self.risk_metrics_complete:
                raise ValueError("REPORT_MEASURED_NOT_RISK_COMPLETE")
            for agg in ("mean_mfe_return", "mean_mae_return", "mean_holding_bars",
                        "median_mfe_return", "median_mae_return", "median_holding_bars",
                        "max_mfe_return", "max_mae_return", "max_holding_bars"):
                v = getattr(self, agg)
                if v is None:
                    raise ValueError(f"REPORT_MEASURED_{agg.upper()}_NULL")
                _vnonneg_finite(v, f"REPORT_{agg.upper()}")
            for agg in ("mean_realized_net_r", "median_realized_net_r",
                        "mean_mfe_r", "median_mfe_r", "max_mfe_r",
                        "mean_mae_r", "median_mae_r", "max_mae_r"):
                v = getattr(self, agg)
                if v is None:
                    raise ValueError(f"REPORT_MEASURED_{agg.upper()}_NULL")
                _vfinite(v, f"REPORT_{agg.upper()}")
            if self.standard_profit_factor is None:
                raise ValueError("REPORT_MEASURED_PF_NULL")
            _vnonneg_finite(self.standard_profit_factor, "REPORT_PF")
            if self.cost_metrics is None:
                raise ValueError("REPORT_MEASURED_COST_NULL")
            if type(self.cost_metrics) is not ProtectiveCostMetrics:
                raise ValueError("REPORT_COST_TYPE_INVALID")

        expected = canonical_sha256(_report_payload(self))
        if self.report_id != expected:
            raise ValueError("REPORT_ID_MISMATCH")


# --- build_stage5r1_protective_metrics ---

def build_stage5r1_protective_metrics(
    *, result, protective_bindings,
) -> ProtectiveExcursionMetricsReport:
    if type(result) is not ProtectiveExcursionResult:
        raise ValueError(f"RESULT_TYPE_INVALID: {type(result).__name__}")

    # Binding validation BEFORE tuple conversion
    if type(protective_bindings) is not tuple:
        raise ValueError("BINDINGS_NOT_TUPLE")

    bindings = protective_bindings
    seen_ids = set()
    for b in bindings:
        if type(b) is not ProtectiveReplayBinding:
            raise ValueError(f"BINDING_TYPE_INVALID: {type(b).__name__}")
        # Reconstruct plan from primitives and verify identity
        plan = b.plan
        if type(plan) is not ProtectiveExitPlan:
            raise ValueError(f"BINDING_PLAN_TYPE_INVALID: {type(plan).__name__}")
        try:
            reconstructed = ProtectiveExitPlan(
                side=plan.side,
                entry_reference_price=plan.entry_reference_price,
                stop_price=plan.stop_price,
                take_profit_price=plan.take_profit_price,
                schema_version=plan.schema_version,
                gap_fill_policy=plan.gap_fill_policy,
                intrabar_fill_policy=plan.intrabar_fill_policy,
                same_bar_collision_policy=plan.same_bar_collision_policy,
                scan_policy=plan.scan_policy,
            )
        except Exception:
            raise ValueError("BINDING_PLAN_RECONSTRUCTION_FAILED")
        if reconstructed != plan or reconstructed.plan_id != plan.plan_id:
            raise ValueError("BINDING_PLAN_IDENTITY_FORGERY")
        # Recompute binding_id
        from quant_engine.proof.stage5r1_protective_replay import PROTECTIVE_REPLAY_BINDING_SCHEMA
        expected_bid = canonical_sha256({
            "schemaVersion": PROTECTIVE_REPLAY_BINDING_SCHEMA,
            "entrySignalBarOpenTimeMs": b.entry_signal_bar_open_time_ms,
            "planId": plan.plan_id,
        })
        if b.binding_id != expected_bid:
            raise ValueError("BINDING_ID_MISMATCH")
        if b.binding_id in seen_ids:
            raise ValueError("BINDING_DUPLICATE_ID")
        seen_ids.add(b.binding_id)

    bs_id = _binding_set_id(bindings)
    if bs_id != result.binding_set_id:
        raise ValueError("BINDING_SET_ID_MISMATCH")

    if len(bindings) != result.trade_count:
        raise ValueError(f"BINDING_COUNT_MISMATCH: {len(bindings)} != {result.trade_count}")

    binding_by_id = {b.binding_id: b for b in bindings}

    # Stage E graph revalidation — call __post_init__ on result and nested objects
    try:
        result.__post_init__()
        result.base.__post_init__()
    except Exception:
        raise ValueError("STAGE_E_RESULT_REVALIDATION_FAILED")
    for ct in result.trades:
        if type(ct) is not ProtectiveExcursionTrade:
            raise ValueError(f"STAGE_E_TRADE_TYPE_INVALID: {type(ct).__name__}")
        try:
            ct.__post_init__()
            ct.base.__post_init__()
            ct.selection.__post_init__()
            ct.excursion.__post_init__()
            ct.resolution.__post_init__()
            if ct.resolution.event is not None:
                ct.resolution.event.__post_init__()
        except Exception:
            raise ValueError("STAGE_E_TRADE_REVALIDATION_FAILED")

    trade_metrics: list[ProtectiveTradeRiskMetrics] = []
    accounting_list: list[TradeAccounting] = []

    lc = sc = exc_c = prot_c = sl_c = tp_c = go_c = il_c = col_c = zd_c = 0
    ff_c = fe_c = ft_c = fl_c = af_c = ae_c = at_c = al_c = 0

    for i, ct in enumerate(result.trades):
        if ct.excursion.binding_id not in binding_by_id:
            raise ValueError(f"BINDING_NOT_FOUND_FOR_TRADE_{i}: {ct.excursion.binding_id}")
        bind = binding_by_id[ct.excursion.binding_id]
        if bind.plan.plan_id != ct.excursion.plan_id:
            raise ValueError(f"PLAN_ID_MISMATCH_{i}")
        if bind.plan.side is not ct.excursion.side:
            raise ValueError(f"SIDE_MISMATCH_{i}")
        if bind.binding_id != result.trades[i].excursion.binding_id:
            raise ValueError(f"ORDERED_BINDING_MISMATCH_{i}")

        exc = ct.excursion
        side = exc.side
        plan = bind.plan
        entry_fill = exc.entry_fill_price
        acct = ct.accounting

        # Risk computation — must be valid per lower-layer invariant
        if side is PositionSide.LONG:
            if not (plan.stop_price < entry_fill):
                raise ValueError(f"RISK_RELATION_INVALID_LONG: stop={plan.stop_price} fill={entry_fill}")
            risk_per_unit = entry_fill - plan.stop_price
        else:
            if not (plan.stop_price > entry_fill):
                raise ValueError(f"RISK_RELATION_INVALID_SHORT: stop={plan.stop_price} fill={entry_fill}")
            risk_per_unit = plan.stop_price - entry_fill

        risk_amount = exc.quantity * risk_per_unit
        realized_net_r = acct.net_pnl_amount / risk_amount
        mfe_r = exc.mfe_amount_before_exit_costs / risk_amount
        mae_r = exc.mae_amount_before_exit_costs / risk_amount

        metric_id = canonical_sha256({
            "schemaVersion": PROTECTIVE_METRICS_SCHEMA,
            "side": side.value,
            "actualEntryFillPrice": float(entry_fill),
            "stopPrice": float(plan.stop_price),
            "quantity": float(exc.quantity),
            "netPnlAmount": float(acct.net_pnl_amount),
            "mfeAmountBeforeExitCosts": float(exc.mfe_amount_before_exit_costs),
            "maeAmountBeforeExitCosts": float(exc.mae_amount_before_exit_costs),
            "initialRiskPerUnit": float(risk_per_unit),
            "initialRiskAmount": float(risk_amount),
            "realizedNetR": float(realized_net_r),
            "mfeR": float(mfe_r),
            "maeR": float(mae_r),
            "fullPreExitBarCount": exc.full_pre_exit_bar_count,
            "compositeTradeId": ct.composite_trade_id,
            "excursionId": exc.excursion_id,
            "bindingId": exc.binding_id,
            "planId": exc.plan_id,
            "protectiveResolutionId": exc.protective_resolution_id,
            "accountingId": acct.accounting_id,
            "riskStatus": RISK_DEFINED,
        })

        tm = ProtectiveTradeRiskMetrics(
            schema_version=PROTECTIVE_METRICS_SCHEMA,
            side=side,
            actual_entry_fill_price=entry_fill,
            stop_price=plan.stop_price,
            quantity=exc.quantity,
            net_pnl_amount=acct.net_pnl_amount,
            mfe_amount_before_exit_costs=exc.mfe_amount_before_exit_costs,
            mae_amount_before_exit_costs=exc.mae_amount_before_exit_costs,
            initial_risk_per_unit=risk_per_unit,
            initial_risk_amount=risk_amount,
            realized_net_r=realized_net_r,
            mfe_r=mfe_r,
            mae_r=mae_r,
            full_pre_exit_bar_count=exc.full_pre_exit_bar_count,
            composite_trade_id=ct.composite_trade_id,
            excursion_id=exc.excursion_id,
            binding_id=exc.binding_id,
            plan_id=exc.plan_id,
            protective_resolution_id=exc.protective_resolution_id,
            accounting_id=acct.accounting_id,
            risk_status=RISK_DEFINED,
            metric_id=metric_id,
        )
        trade_metrics.append(tm)
        accounting_list.append(acct)

        # Counts
        if side is PositionSide.LONG: lc += 1
        else: sc += 1
        if exc.source == EXPLICIT_SOURCE: exc_c += 1
        else: prot_c += 1
        if exc.source == PROTECTIVE_SOURCE:
            if exc.trigger_kind == KIND_GAP_OPEN: go_c += 1
            else: il_c += 1
            evt = ct.resolution.event
            if evt and evt.reason == REASON_STOP_LOSS: sl_c += 1
            elif evt and evt.reason == REASON_TAKE_PROFIT: tp_c += 1
            if evt and evt.same_bar_collision: col_c += 1
        if exc.full_pre_exit_bar_count == 0: zd_c += 1
        if exc.favorable_extreme_source == SOURCE_FULL_BAR: ff_c += 1
        elif exc.favorable_extreme_source == SOURCE_FRONTIER_EXIT_OPEN: fe_c += 1
        elif exc.favorable_extreme_source == SOURCE_FRONTIER_TRIGGER_OPEN: ft_c += 1
        elif exc.favorable_extreme_source == SOURCE_FRONTIER_TRIGGER_LEVEL: fl_c += 1
        if exc.adverse_extreme_source == SOURCE_FULL_BAR: af_c += 1
        elif exc.adverse_extreme_source == SOURCE_FRONTIER_EXIT_OPEN: ae_c += 1
        elif exc.adverse_extreme_source == SOURCE_FRONTIER_TRIGGER_OPEN: at_c += 1
        elif exc.adverse_extreme_source == SOURCE_FRONTIER_TRIGGER_LEVEL: al_c += 1

    counts = ProtectiveExcursionMetricCounts(
        long_count=lc, short_count=sc,
        explicit_exit_count=exc_c, protective_exit_count=prot_c,
        stop_loss_count=sl_c, take_profit_count=tp_c,
        gap_open_count=go_c, intrabar_level_count=il_c,
        same_bar_collision_count=col_c, zero_duration_count=zd_c,
        favorable_full_bar_count=ff_c, favorable_exit_open_count=fe_c,
        favorable_trigger_open_count=ft_c, favorable_trigger_level_count=fl_c,
        adverse_full_bar_count=af_c, adverse_exit_open_count=ae_c,
        adverse_trigger_open_count=at_c, adverse_trigger_level_count=al_c,
    )

    tc = result.trade_count
    if tc == 0:
        eval_status = EVAL_NO_TRADES
        risk_complete = False
        agg = {k: None for k in ["mean_mfe_return", "median_mfe_return", "max_mfe_return",
                                  "mean_mae_return", "median_mae_return", "max_mae_return",
                                  "mean_holding_bars", "median_holding_bars", "max_holding_bars",
                                  "mean_realized_net_r", "median_realized_net_r",
                                  "mean_mfe_r", "median_mfe_r", "max_mfe_r",
                                  "mean_mae_r", "median_mae_r", "max_mae_r"]}
        pf_std = pf_ret = None
        cost_m = None
    else:
        eval_status = EVAL_MEASURED
        risk_complete = True
        mfe_returns = [float(e.excursion.mfe_return_on_entry_equity) for e in result.trades]
        mae_returns = [float(e.excursion.mae_return_on_entry_equity) for e in result.trades]
        holding = [float(e.excursion.full_pre_exit_bar_count) for e in result.trades]
        agg = {
            "mean_mfe_return": float(statistics.fmean(mfe_returns)),
            "median_mfe_return": float(statistics.median(mfe_returns)),
            "max_mfe_return": float(max(mfe_returns)),
            "mean_mae_return": float(statistics.fmean(mae_returns)),
            "median_mae_return": float(statistics.median(mae_returns)),
            "max_mae_return": float(max(mae_returns)),
            "mean_holding_bars": float(statistics.fmean(holding)),
            "median_holding_bars": float(statistics.median(holding)),
            "max_holding_bars": float(max(holding)),
        }
        r_vals = [tm.realized_net_r for tm in trade_metrics]
        mfe_vals = [tm.mfe_r for tm in trade_metrics]
        mae_vals = [tm.mae_r for tm in trade_metrics]
        agg["mean_realized_net_r"] = float(statistics.fmean(r_vals))
        agg["median_realized_net_r"] = float(statistics.median(r_vals))
        agg["mean_mfe_r"] = float(statistics.fmean(mfe_vals))
        agg["median_mfe_r"] = float(statistics.median(mfe_vals))
        agg["max_mfe_r"] = float(max(mfe_vals))
        agg["mean_mae_r"] = float(statistics.fmean(mae_vals))
        agg["median_mae_r"] = float(statistics.median(mae_vals))
        agg["max_mae_r"] = float(max(mae_vals))
        pf_std = standard_profit_factor(accounting_list)
        pf_ret = return_profit_factor(accounting_list)
        cost_m = _build_cost_metrics(aggregate_cost_accounting(accounting_list))

    report_id = canonical_sha256(_build_report_payload_dict(
        result, eval_status, risk_complete, trade_metrics, counts, agg,
        pf_std, pf_ret, cost_m,
    ))

    return ProtectiveExcursionMetricsReport(
        schema_version=PROTECTIVE_METRICS_REPORT_SCHEMA,
        policy=PROTECTIVE_METRICS_POLICY,
        source_excursion_result_id=result.result_id,
        base_protective_replay_id=result.base_protective_replay_id,
        dataset_id=result.dataset_id,
        instruction_set_id=result.instruction_set_id,
        binding_set_id=result.binding_set_id,
        replay_config_id=result.replay_config_id,
        capital_model_id=result.capital_model_id,
        cost_model_id=result.cost_model_id,
        symbol=result.symbol,
        timeframe_ms=result.timeframe_ms,
        evaluation_status=eval_status,
        risk_metrics_complete=risk_complete,
        trade_count=tc,
        trade_metrics=tuple(trade_metrics),
        counts=counts,
        **agg,
        standard_profit_factor=pf_std,
        return_profit_factor=pf_ret,
        cost_metrics=cost_m,
        report_id=report_id,
    )


def _build_report_payload_dict(result, es, rc, tms, counts, agg, pfs, pfr, cm):
    p = {
        "schemaVersion": PROTECTIVE_METRICS_REPORT_SCHEMA,
        "policy": PROTECTIVE_METRICS_POLICY,
        "sourceExcursionResultId": result.result_id,
        "baseProtectiveReplayId": result.base_protective_replay_id,
        "datasetId": result.dataset_id,
        "instructionSetId": result.instruction_set_id,
        "bindingSetId": result.binding_set_id,
        "replayConfigId": result.replay_config_id,
        "capitalModelId": result.capital_model_id,
        "costModelId": result.cost_model_id,
        "symbol": result.symbol,
        "timeframeMs": result.timeframe_ms,
        "evaluationStatus": es,
        "riskMetricsComplete": rc,
        "tradeCount": result.trade_count,
        "tradeMetricIds": [m.metric_id for m in tms],
        "counts": {
            "long": counts.long_count, "short": counts.short_count,
            "explicitExit": counts.explicit_exit_count,
            "protectiveExit": counts.protective_exit_count,
            "stopLoss": counts.stop_loss_count,
            "takeProfit": counts.take_profit_count,
            "gapOpen": counts.gap_open_count,
            "intrabarLevel": counts.intrabar_level_count,
            "sameBarCollision": counts.same_bar_collision_count,
            "zeroDuration": counts.zero_duration_count,
            "favorableFullBar": counts.favorable_full_bar_count,
            "favorableExitOpen": counts.favorable_exit_open_count,
            "favorableTriggerOpen": counts.favorable_trigger_open_count,
            "favorableTriggerLevel": counts.favorable_trigger_level_count,
            "adverseFullBar": counts.adverse_full_bar_count,
            "adverseExitOpen": counts.adverse_exit_open_count,
            "adverseTriggerOpen": counts.adverse_trigger_open_count,
            "adverseTriggerLevel": counts.adverse_trigger_level_count,
        },
    }
    for k in ["mean_mfe_return", "median_mfe_return", "max_mfe_return",
              "mean_mae_return", "median_mae_return", "max_mae_return",
              "mean_holding_bars", "median_holding_bars", "max_holding_bars",
              "mean_realized_net_r", "median_realized_net_r",
              "mean_mfe_r", "median_mfe_r", "max_mfe_r",
              "mean_mae_r", "median_mae_r", "max_mae_r"]:
        p[k] = float(agg[k]) if agg[k] is not None else None
    p["standardProfitFactor"] = float(pfs) if pfs is not None else None
    p["returnProfitFactor"] = float(pfr) if pfr is not None else None
    if cm is not None:
        p["costMetricsId"] = canonical_sha256(_cost_payload(cm))
    else:
        p["costMetricsId"] = None
    return p


# --- verify_stage5r1_protective_metrics ---

def verify_stage5r1_protective_metrics(
    *, report, result, bars, instructions, protective_bindings, config, capital, cost,
) -> ProtectiveExcursionMetricsReport:
    if type(report) is not ProtectiveExcursionMetricsReport:
        raise ValueError(f"VERIFY_REPORT_TYPE_INVALID: {type(report).__name__}")

    if type(protective_bindings) is not tuple:
        raise ValueError("VERIFY_BINDINGS_NOT_TUPLE")

    verified_result = verify_stage5r1_protective_excursion(
        result=result, bars=bars, instructions=instructions,
        protective_bindings=protective_bindings, config=config,
        capital=capital, cost=cost,
    )

    recomputed = build_stage5r1_protective_metrics(
        result=verified_result, protective_bindings=protective_bindings,
    )

    if report.report_id != recomputed.report_id:
        raise ValueError(
            f"VERIFY_REPORT_ID_MISMATCH: supplied={report.report_id} "
            f"recomputed={recomputed.report_id}"
        )

    if report != recomputed:
        raise ValueError("VERIFY_REPORT_CONTENT_MISMATCH")

    return report
