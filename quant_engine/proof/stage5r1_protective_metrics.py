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

RISK_DEFINED = "DEFINED"
RISK_INVALID_AT_ENTRY = "INVALID_AT_ENTRY"

EVAL_NO_TRADES = "NO_TRADES"
EVAL_RISK_UNDEFINED = "RISK_UNDEFINED"
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


def _validate_binding_tuple(bindings):
    if type(bindings) is not tuple:
        raise ValueError("BINDINGS_NOT_TUPLE")
    seen_ids = set()
    for b in bindings:
        if type(b) is not ProtectiveReplayBinding:
            raise ValueError(f"BINDING_TYPE_INVALID: {type(b).__name__}")
        if b.binding_id in seen_ids:
            raise ValueError("BINDING_DUPLICATE_ID")
        seen_ids.add(b.binding_id)
    return bindings


# --- ProtectiveTradeRiskMetrics ---

def _trade_metric_payload(m: ProtectiveTradeRiskMetrics) -> dict:
    p = {
        "schemaVersion": m.schema_version,
        "compositeTradeId": m.composite_trade_id,
        "excursionId": m.excursion_id,
        "bindingId": m.binding_id,
        "planId": m.plan_id,
        "protectiveResolutionId": m.protective_resolution_id,
        "accountingId": m.accounting_id,
        "riskStatus": m.risk_status,
        "fullPreExitBarCount": m.full_pre_exit_bar_count,
    }
    if m.initial_risk_per_unit is not None:
        p["initialRiskPerUnit"] = float(m.initial_risk_per_unit)
    else:
        p["initialRiskPerUnit"] = None
    if m.initial_risk_amount is not None:
        p["initialRiskAmount"] = float(m.initial_risk_amount)
    else:
        p["initialRiskAmount"] = None
    if m.realized_net_r is not None:
        p["realizedNetR"] = float(m.realized_net_r)
    else:
        p["realizedNetR"] = None
    if m.mfe_r is not None:
        p["mfeR"] = float(m.mfe_r)
    else:
        p["mfeR"] = None
    if m.mae_r is not None:
        p["maeR"] = float(m.mae_r)
    else:
        p["maeR"] = None
    return p


@dataclass(frozen=True)
class ProtectiveTradeRiskMetrics:
    schema_version: str
    composite_trade_id: str
    excursion_id: str
    binding_id: str
    plan_id: str
    protective_resolution_id: str
    accounting_id: str
    risk_status: str
    initial_risk_per_unit: float | None
    initial_risk_amount: float | None
    realized_net_r: float | None
    mfe_r: float | None
    mae_r: float | None
    full_pre_exit_bar_count: int
    metric_id: str

    def __post_init__(self) -> None:
        if self.schema_version != PROTECTIVE_METRICS_SCHEMA:
            raise ValueError("METRIC_SCHEMA_INVALID")
        if self.risk_status not in (RISK_DEFINED, RISK_INVALID_AT_ENTRY):
            raise ValueError(f"METRIC_RISK_STATUS_INVALID: {self.risk_status}")

        _vsha(self.composite_trade_id, "METRIC_COMPOSITE_ID")
        _vsha(self.excursion_id, "METRIC_EXCURSION_ID")
        _vsha(self.binding_id, "METRIC_BINDING_ID")
        _vsha(self.plan_id, "METRIC_PLAN_ID")
        _vsha(self.protective_resolution_id, "METRIC_RESOLUTION_ID")
        _vsha(self.accounting_id, "METRIC_ACCOUNTING_ID")
        _vsha(self.metric_id, "METRIC_METRIC_ID")

        _vint(self.full_pre_exit_bar_count, "METRIC_HOLDING_BARS")

        if self.risk_status == RISK_DEFINED:
            for n, v in [("initial_risk_per_unit", self.initial_risk_per_unit),
                         ("initial_risk_amount", self.initial_risk_amount)]:
                if v is None:
                    raise ValueError(f"METRIC_{n.upper()}_NULL_DEFINED")
                _vpos(v, f"METRIC_{n.upper()}")
            for n, v in [("realized_net_r", self.realized_net_r),
                         ("mfe_r", self.mfe_r), ("mae_r", self.mae_r)]:
                if v is None:
                    raise ValueError(f"METRIC_{n.upper()}_NULL_DEFINED")
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    raise ValueError(f"METRIC_{n.upper()}_NON_NUMERIC")
                if not math.isfinite(float(v)):
                    raise ValueError(f"METRIC_{n.upper()}_NON_FINITE")
            _vnonneg_finite(self.mfe_r, "METRIC_MFE_R")
            _vnonneg_finite(self.mae_r, "METRIC_MAE_R")
        else:
            if any(v is not None for v in [self.initial_risk_per_unit, self.initial_risk_amount,
                                              self.realized_net_r, self.mfe_r, self.mae_r]):
                raise ValueError("METRIC_RISK_FIELDS_NOT_NULL_UNDEFINED")

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
        total = self.long_count + self.short_count
        if total != self.explicit_exit_count + self.protective_exit_count:
            raise ValueError("COUNTS_SOURCE_SUM_MISMATCH")
        if self.protective_exit_count != self.stop_loss_count + self.take_profit_count:
            raise ValueError("COUNTS_REASON_SUM_MISMATCH")
        if self.gap_open_count + self.intrabar_level_count != self.protective_exit_count:
            raise ValueError("COUNTS_KIND_SUM_MISMATCH")


# --- ProtectiveExcursionMetricsReport ---

def _report_payload(r: ProtectiveExcursionMetricsReport) -> dict:
    p = {
        "schemaVersion": r.schema_version,
        "policy": r.policy,
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
    p["costAggregate"] = dict(r.cost_aggregate) if r.cost_aggregate is not None else None
    return p


@dataclass(frozen=True)
class ProtectiveExcursionMetricsReport:
    schema_version: str
    policy: str
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
    cost_aggregate: dict | None
    report_id: str

    def __post_init__(self) -> None:
        if self.schema_version != PROTECTIVE_METRICS_REPORT_SCHEMA:
            raise ValueError("REPORT_SCHEMA_INVALID")
        if self.policy != PROTECTIVE_METRICS_POLICY:
            raise ValueError("REPORT_POLICY_INVALID")
        if self.evaluation_status not in (EVAL_NO_TRADES, EVAL_RISK_UNDEFINED, EVAL_MEASURED):
            raise ValueError(f"REPORT_EVAL_STATUS_INVALID: {self.evaluation_status}")
        if type(self.risk_metrics_complete) is not bool:
            raise ValueError("REPORT_RISK_COMPLETE_NOT_BOOL")
        if self.risk_metrics_complete is True and self.evaluation_status != EVAL_MEASURED:
            raise ValueError("REPORT_RISK_COMPLETE_WITHOUT_MEASURED")
        if self.evaluation_status == EVAL_MEASURED and self.risk_metrics_complete is not True:
            raise ValueError("REPORT_MEASURED_WITHOUT_RISK_COMPLETE")

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
        if self.symbol is None or not isinstance(self.symbol, str):
            raise ValueError("REPORT_SYMBOL_INVALID")

        expected = canonical_sha256(_report_payload(self))
        if self.report_id != expected:
            raise ValueError("REPORT_ID_MISMATCH")


# --- build_stage5r1_protective_metrics ---

def build_stage5r1_protective_metrics(
    *, result, protective_bindings,
) -> ProtectiveExcursionMetricsReport:
    if type(result) is not ProtectiveExcursionResult:
        raise ValueError(f"RESULT_TYPE_INVALID: {type(result).__name__}")
    bindings = _validate_binding_tuple(tuple(protective_bindings))

    bs_id = _binding_set_id(bindings)
    if bs_id != result.binding_set_id:
        raise ValueError("BINDING_SET_ID_MISMATCH")

    # Build binding lookup by binding_id
    binding_by_id = {b.binding_id: b for b in bindings}
    if len(binding_by_id) != len(bindings):
        raise ValueError("BINDING_DUPLICATE_ID")

    trade_metrics: list[ProtectiveTradeRiskMetrics] = []
    accounting_list: list[TradeAccounting] = []

    lc = sc = exc_c = prot_c = sl_c = tp_c = go_c = il_c = col_c = zd_c = 0
    ff_c = fe_c = ft_c = fl_c = af_c = ae_c = at_c = al_c = 0

    for ct in result.trades:
        bind = binding_by_id.get(ct.excursion.binding_id)
        if bind is None:
            raise ValueError(f"BINDING_NOT_FOUND: {ct.excursion.binding_id}")
        if bind.plan.plan_id != ct.excursion.plan_id:
            raise ValueError("PLAN_ID_MISMATCH")
        if bind.plan.side is not ct.excursion.side:
            raise ValueError("SIDE_MISMATCH")

        exc = ct.excursion
        side = exc.side
        plan = bind.plan
        entry_fill = exc.entry_fill_price

        # Risk computation
        if side is PositionSide.LONG:
            if plan.stop_price < entry_fill:
                risk_status = RISK_DEFINED
                risk_per_unit = entry_fill - plan.stop_price
            else:
                risk_status = RISK_INVALID_AT_ENTRY
                risk_per_unit = None
        else:
            if plan.stop_price > entry_fill:
                risk_status = RISK_DEFINED
                risk_per_unit = plan.stop_price - entry_fill
            else:
                risk_status = RISK_INVALID_AT_ENTRY
                risk_per_unit = None

        if risk_status == RISK_DEFINED:
            risk_amount = exc.quantity * risk_per_unit
            realized_net_r = ct.accounting.net_pnl_amount / risk_amount
            mfe_r = exc.mfe_amount_before_exit_costs / risk_amount
            mae_r = exc.mae_amount_before_exit_costs / risk_amount
        else:
            risk_amount = None
            realized_net_r = None
            mfe_r = None
            mae_r = None

        metric_id = canonical_sha256(_build_metric_payload_dict(
            ct.composite_trade_id, exc.excursion_id, exc.binding_id,
            exc.plan_id, exc.protective_resolution_id,
            ct.accounting.accounting_id, risk_status,
            risk_per_unit, risk_amount, realized_net_r, mfe_r, mae_r,
            exc.full_pre_exit_bar_count,
        ))

        tm = ProtectiveTradeRiskMetrics(
            schema_version=PROTECTIVE_METRICS_SCHEMA,
            composite_trade_id=ct.composite_trade_id,
            excursion_id=exc.excursion_id,
            binding_id=exc.binding_id,
            plan_id=exc.plan_id,
            protective_resolution_id=exc.protective_resolution_id,
            accounting_id=ct.accounting.accounting_id,
            risk_status=risk_status,
            initial_risk_per_unit=risk_per_unit,
            initial_risk_amount=risk_amount,
            realized_net_r=realized_net_r,
            mfe_r=mfe_r,
            mae_r=mae_r,
            full_pre_exit_bar_count=exc.full_pre_exit_bar_count,
            metric_id=metric_id,
        )
        trade_metrics.append(tm)
        accounting_list.append(ct.accounting)

        # Counts
        if side is PositionSide.LONG: lc += 1
        else: sc += 1
        if exc.source == EXPLICIT_SOURCE: exc_c += 1
        else: prot_c += 1
        if exc.source == PROTECTIVE_SOURCE:
            if exc.trigger_kind == KIND_GAP_OPEN: go_c += 1
            else: il_c += 1
            if exc.trigger_kind == KIND_INTRABAR_LEVEL:
                # Check same-bar collision via resolution
                if ct.resolution.event and ct.resolution.event.same_bar_collision:
                    col_c += 1
            # Reason
            if exc.trigger_kind is not None:
                # Use resolution event reason
                evt = ct.resolution.event
                if evt and evt.reason == REASON_STOP_LOSS: sl_c += 1
                elif evt and evt.reason == REASON_TAKE_PROFIT: tp_c += 1
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
    elif any(m.risk_status == RISK_INVALID_AT_ENTRY for m in trade_metrics):
        eval_status = EVAL_RISK_UNDEFINED
        risk_complete = False
    else:
        eval_status = EVAL_MEASURED
        risk_complete = True

    # Compute aggregates
    if tc == 0:
        agg = {k: None for k in [
            "mean_mfe_return", "median_mfe_return", "max_mfe_return",
            "mean_mae_return", "median_mae_return", "max_mae_return",
            "mean_holding_bars", "median_holding_bars", "max_holding_bars",
            "mean_realized_net_r", "median_realized_net_r",
            "mean_mfe_r", "median_mfe_r", "max_mfe_r",
            "mean_mae_r", "median_mae_r", "max_mae_r",
        ]}
        pf_std = pf_ret = None
        cost_agg = None
    else:
        mfe_returns = [float(e.excursion.mfe_return_on_entry_equity) for e in result.trades]
        mae_returns = [float(e.excursion.mae_return_on_entry_equity) for e in result.trades]
        holding = [float(e.excursion.full_pre_exit_bar_count) for e in result.trades]

        agg = {
            "mean_mfe_return": float(statistics.fmean(mfe_returns)) if mfe_returns else None,
            "median_mfe_return": float(statistics.median(mfe_returns)) if mfe_returns else None,
            "max_mfe_return": float(max(mfe_returns)) if mfe_returns else None,
            "mean_mae_return": float(statistics.fmean(mae_returns)) if mae_returns else None,
            "median_mae_return": float(statistics.median(mae_returns)) if mae_returns else None,
            "max_mae_return": float(max(mae_returns)) if mae_returns else None,
            "mean_holding_bars": float(statistics.fmean(holding)) if holding else None,
            "median_holding_bars": float(statistics.median(holding)) if holding else None,
            "max_holding_bars": float(max(holding)) if holding else None,
        }

        defined_r = [m.realized_net_r for m in trade_metrics if m.risk_status == RISK_DEFINED]
        defined_mfe = [m.mfe_r for m in trade_metrics if m.risk_status == RISK_DEFINED]
        defined_mae = [m.mae_r for m in trade_metrics if m.risk_status == RISK_DEFINED]

        agg["mean_realized_net_r"] = float(statistics.fmean(defined_r)) if defined_r else None
        agg["median_realized_net_r"] = float(statistics.median(defined_r)) if defined_r else None
        agg["mean_mfe_r"] = float(statistics.fmean(defined_mfe)) if defined_mfe else None
        agg["median_mfe_r"] = float(statistics.median(defined_mfe)) if defined_mfe else None
        agg["max_mfe_r"] = float(max(defined_mfe)) if defined_mfe else None
        agg["mean_mae_r"] = float(statistics.fmean(defined_mae)) if defined_mae else None
        agg["median_mae_r"] = float(statistics.median(defined_mae)) if defined_mae else None
        agg["max_mae_r"] = float(max(defined_mae)) if defined_mae else None

        pf_std = standard_profit_factor(accounting_list) if accounting_list else None
        pf_ret = return_profit_factor(accounting_list) if accounting_list else None
        cost_agg = aggregate_cost_accounting(accounting_list) if accounting_list else None

    report_id = canonical_sha256(_build_report_payload_dict(
        result, eval_status, risk_complete, trade_metrics, counts, agg,
        pf_std, pf_ret, cost_agg,
    ))

    return ProtectiveExcursionMetricsReport(
        schema_version=PROTECTIVE_METRICS_REPORT_SCHEMA,
        policy=PROTECTIVE_METRICS_POLICY,
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
        cost_aggregate=cost_agg,
        report_id=report_id,
    )


def _build_metric_payload_dict(ctid, eid, bid, pid, rid, aid, rs, rpu, ra, rnr, mr1, mr2, hb):
    p = {
        "schemaVersion": PROTECTIVE_METRICS_SCHEMA,
        "compositeTradeId": ctid, "excursionId": eid,
        "bindingId": bid, "planId": pid,
        "protectiveResolutionId": rid, "accountingId": aid,
        "riskStatus": rs, "fullPreExitBarCount": hb,
    }
    for k, v in [("initialRiskPerUnit", rpu), ("initialRiskAmount", ra),
                 ("realizedNetR", rnr), ("mfeR", mr1), ("maeR", mr2)]:
        p[k] = float(v) if v is not None else None
    return p


def _build_report_payload_dict(result, es, rc, tms, counts, agg, pfs, pfr, ca):
    p = {
        "schemaVersion": PROTECTIVE_METRICS_REPORT_SCHEMA,
        "policy": PROTECTIVE_METRICS_POLICY,
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
    p["costAggregate"] = dict(ca) if ca is not None else None
    return p


# --- verify_stage5r1_protective_metrics ---

def verify_stage5r1_protective_metrics(
    *, report, result, bars, instructions, protective_bindings, config, capital, cost,
) -> ProtectiveExcursionMetricsReport:
    if type(report) is not ProtectiveExcursionMetricsReport:
        raise ValueError(f"VERIFY_REPORT_TYPE_INVALID: {type(report).__name__}")

    verified_result = verify_stage5r1_protective_excursion(
        result=result, bars=bars, instructions=instructions,
        protective_bindings=protective_bindings, config=config,
        capital=capital, cost=cost,
    )

    recomputed = build_stage5r1_protective_metrics(
        result=verified_result, protective_bindings=tuple(protective_bindings),
    )

    if report.report_id != recomputed.report_id:
        raise ValueError(
            f"VERIFY_REPORT_ID_MISMATCH: supplied={report.report_id} "
            f"recomputed={recomputed.report_id}"
        )

    if report != recomputed:
        raise ValueError("VERIFY_REPORT_CONTENT_MISMATCH")

    return report
