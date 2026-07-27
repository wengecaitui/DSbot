"""Multi-market robustness gate with train-only fitting and one-shot holdouts."""

from __future__ import annotations

import json
import math
import os
import statistics
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import pandas as pd

from .gap_policy import dataframe_sha256
from .strategy_adapter import simulate_window
from .strategy_spec import CompiledStrategyAdapter, StrategySpec, candidate_parameter_sets, canonical_sha256


DEVELOPMENT_LABELS = [
    "NEW DERIVED STRATEGY ROBUSTNESS DEVELOPMENT",
    "FINAL HOLDOUT NOT YET CONSUMED",
    "NOT APPROVED FOR PAPER, TESTNET OR LIVE",
]
FINAL_LABELS = [
    "NEW DERIVED STRATEGY ROBUSTNESS PROOF",
    "FINAL HOLDOUT CONSUMED EXACTLY ONCE",
    "PAPER READINESS REVIEW ONLY",
    "NOT APPROVED FOR PAPER, TESTNET OR LIVE",
]


@dataclass(frozen=True)
class MarketDataset:
    dataset_id: str
    symbol: str
    timeframe: str
    bars: pd.DataFrame
    audit: Mapping[str, Any]
    segment_index: int = 0
    source_sha256: str | None = None


@dataclass(frozen=True)
class RobustnessConfig:
    fold_count: int = 3
    max_bars_per_dataset: int = 9_000
    min_train_bars: int = 4_000
    validation_bars: int = 480
    test_bars: int = 480
    purge_bars: int = 40
    embargo_bars: int = 40
    label_horizon_bars: int = 1
    final_holdout_ratio: float = 0.15
    final_holdout_min_bars: int = 1_200
    fee_bps: float = 4.0
    slippage_bps: float = 1.0
    stress_fee_bps: float = 8.0
    stress_slippage_bps: float = 3.0
    selection_bias_penalty_scale: float = 1.0
    min_total_holdout_trades: int = 60
    max_holdout_drawdown: float = 0.25
    min_positive_market_fraction: float = 0.60
    min_stress_test_return: float = -0.02
    max_parameter_return_delta: float = 0.05


def _validate_config(config: RobustnessConfig) -> None:
    positive_ints = (config.fold_count, config.max_bars_per_dataset, config.min_train_bars, config.validation_bars, config.test_bars, config.final_holdout_min_bars)
    if min(positive_ints) <= 0:
        raise ValueError("ROBUSTNESS_CONFIG_BARS_INVALID")
    if min(config.purge_bars, config.embargo_bars, config.label_horizon_bars) < 0:
        raise ValueError("ROBUSTNESS_CONFIG_GAP_INVALID")
    costs = (config.fee_bps, config.slippage_bps, config.stress_fee_bps, config.stress_slippage_bps)
    if any(not math.isfinite(item) or item < 0 for item in costs):
        raise ValueError("ROBUSTNESS_CONFIG_COST_INVALID")
    if config.stress_fee_bps < config.fee_bps or config.stress_slippage_bps < config.slippage_bps:
        raise ValueError("ROBUSTNESS_STRESS_NOT_CONSERVATIVE")
    if not (0 < config.final_holdout_ratio < 1 and 0 < config.min_positive_market_fraction <= 1):
        raise ValueError("ROBUSTNESS_CONFIG_RATIO_INVALID")
    if not (0 < config.max_holdout_drawdown < 1) or config.min_total_holdout_trades <= 0:
        raise ValueError("ROBUSTNESS_PROMOTION_THRESHOLD_INVALID")


def _working_dataset(dataset: MarketDataset, config: RobustnessConfig) -> tuple[pd.DataFrame, dict[str, Any]]:
    if dataset.timeframe not in {"5m", "4h", "1h"}:
        raise ValueError("ROBUSTNESS_TIMEFRAME_INVALID")
    if dataset.audit.get("dataframeSha256") != dataframe_sha256(dataset.bars):
        raise ValueError("ROBUSTNESS_DATA_AUDIT_MISMATCH")
    segments = dataset.audit.get("segments")
    if not isinstance(segments, list) or not (0 <= dataset.segment_index < len(segments)):
        raise ValueError("ROBUSTNESS_SEGMENT_INVALID")
    if dataset.audit.get("gapCount", 0) and dataset.audit.get("gapPolicy") != "segment":
        raise ValueError("ROBUSTNESS_GAP_POLICY_INVALID")
    segment = segments[dataset.segment_index]
    segment_start, segment_end = int(segment["startRow"]), int(segment["endRowExclusive"])
    start = max(segment_start, segment_end - config.max_bars_per_dataset)
    working = dataset.bars.iloc[start:segment_end].reset_index(drop=True)
    if len(working) < config.min_train_bars + config.validation_bars + config.test_bars + config.final_holdout_min_bars:
        raise ValueError("ROBUSTNESS_DATASET_TOO_SHORT")
    identity = {
        "datasetId": dataset.dataset_id,
        "symbol": dataset.symbol,
        "timeframe": dataset.timeframe,
        "sourceDataframeSha256": dataset.audit["dataframeSha256"],
        "sourceSha256": dataset.source_sha256 or dataset.audit["dataframeSha256"],
        "workingDataframeSha256": dataframe_sha256(working),
        "sourceRows": len(dataset.bars),
        "workingStartRow": start,
        "workingEndRowExclusive": segment_end,
        "workingRows": len(working),
        "gapPolicy": dataset.audit["gapPolicy"],
        "gapCount": dataset.audit["gapCount"],
        "segmentIndex": dataset.segment_index,
    }
    return working, identity


def _geometry(length: int, warmup: int, config: RobustnessConfig) -> dict[str, Any]:
    phase_gap = max(config.purge_bars, config.label_horizon_bars)
    out_of_sample_gap = max(config.embargo_bars, config.label_horizon_bars)
    holdout_gap = max(config.purge_bars, config.embargo_bars, config.label_horizon_bars)
    holdout_bars = max(math.ceil(length * config.final_holdout_ratio), config.final_holdout_min_bars)
    holdout_start = length - holdout_bars
    development_end = holdout_start - holdout_gap
    step = config.test_bars + phase_gap + config.validation_bars + out_of_sample_gap
    folds: list[dict[str, Any]] = []
    test_end = development_end
    for fold in range(config.fold_count):
        test_start = test_end - config.test_bars
        validation_end = test_start - phase_gap
        validation_start = validation_end - config.validation_bars
        train_end = validation_start - phase_gap
        train_start = warmup
        if train_end - train_start < config.min_train_bars:
            raise ValueError("ROBUSTNESS_FOLD_FOOTPRINT_INSUFFICIENT")
        folds.append({
            "fold": config.fold_count - fold - 1,
            "train": {"start": train_start, "endExclusive": train_end},
            "validation": {"start": validation_start, "endExclusive": validation_end},
            "test": {"start": test_start, "endExclusive": test_end},
        })
        test_end -= step
    folds.reverse()
    for current, following in zip(folds, folds[1:]):
        if current["test"]["endExclusive"] + out_of_sample_gap > following["validation"]["start"]:
            raise ValueError("ROBUSTNESS_FOLD_LEAKAGE")
    if folds[-1]["test"]["endExclusive"] + holdout_gap > holdout_start:
        raise ValueError("ROBUSTNESS_HOLDOUT_LEAKAGE")
    return {
        "phaseGapBars": phase_gap,
        "outOfSampleGapBars": out_of_sample_gap,
        "finalHoldoutGapBars": holdout_gap,
        "folds": folds,
        "finalHoldout": {"start": holdout_start, "endExclusive": length},
    }


def _compact(metrics: Mapping[str, Any]) -> dict[str, Any]:
    trades = metrics.get("trades", [])
    return {
        "start": metrics["start"],
        "endExclusive": metrics["endExclusive"],
        "decisionCalls": metrics["decisionCalls"],
        "firstEntryIndex": metrics["firstEntryIndex"],
        "tradeCount": metrics["tradeCount"],
        "netReturn": metrics["netReturn"],
        "maxDrawdown": metrics["maxDrawdown"],
        "winRate": metrics["winRate"],
        "tradesSha256": canonical_sha256(trades),
    }


def _aggregate(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    returns = [float(item["netReturn"]) for item in records]
    return {
        "datasetCount": len(records),
        "meanNetReturn": statistics.fmean(returns),
        "medianNetReturn": statistics.median(returns),
        "worstNetReturn": min(returns),
        "positiveDatasetCount": sum(item > 0 for item in returns),
        "positiveDatasetFraction": sum(item > 0 for item in returns) / len(returns),
        "totalTrades": sum(int(item["tradeCount"]) for item in records),
        "maxDrawdown": max(float(item["maxDrawdown"]) for item in records),
    }


def _selection_score(aggregate: Mapping[str, Any], selection_count: int, scale: float, returns: Sequence[float]) -> tuple[float, float]:
    dispersion = statistics.pstdev(returns) if len(returns) > 1 else 0.0
    penalty = scale * dispersion * math.sqrt(2 * math.log(max(selection_count, 1)))
    return float(aggregate["medianNetReturn"]) - penalty, penalty


def _simulate(adapter: CompiledStrategyAdapter, bars: pd.DataFrame, parameters: Mapping[str, Any], bounds: Mapping[str, int], fee: float, slippage: float) -> dict[str, Any]:
    return _compact(simulate_window(adapter, bars, parameters, int(bounds["start"]), int(bounds["endExclusive"]), fee, slippage))


def prepare_robustness_evaluation(
    specs: Sequence[StrategySpec],
    datasets: Sequence[MarketDataset],
    config: RobustnessConfig,
    source_commit: str,
) -> dict[str, Any]:
    """Fit on train only; validation/test are evaluation-only and holdout is untouched."""
    _validate_config(config)
    if len(specs) == 0 or len(datasets) < 2 or len({item.timeframe for item in datasets}) < 2:
        raise ValueError("ROBUSTNESS_MATRIX_INCOMPLETE")
    prepared: dict[str, tuple[pd.DataFrame, dict[str, Any]]] = {item.dataset_id: _working_dataset(item, config) for item in datasets}
    if len(prepared) != len(datasets):
        raise ValueError("ROBUSTNESS_DATASET_ID_DUPLICATE")
    dataset_records = [prepared[item.dataset_id][1] for item in datasets]
    strategies = []
    for spec in specs:
        parameter_sets = candidate_parameter_sets(spec)
        adapters = {item.dataset_id: CompiledStrategyAdapter(spec) for item in datasets}
        geometries = {item.dataset_id: _geometry(len(prepared[item.dataset_id][0]), spec.warmup_bars, config) for item in datasets}
        for dataset in datasets:
            for parameters in parameter_sets:
                adapters[dataset.dataset_id].prime(prepared[dataset.dataset_id][0], parameters)
        fold_records = []
        for fold_index in range(config.fold_count):
            train_candidates = []
            for parameters in parameter_sets:
                parameter_id = canonical_sha256(parameters)
                per_dataset = []
                for dataset in datasets:
                    bars = prepared[dataset.dataset_id][0]
                    bounds = geometries[dataset.dataset_id]["folds"][fold_index]["train"]
                    metrics = _simulate(adapters[dataset.dataset_id], bars, parameters, bounds, config.fee_bps, config.slippage_bps)
                    per_dataset.append({"datasetId": dataset.dataset_id, **metrics})
                aggregate = _aggregate(per_dataset)
                score, penalty = _selection_score(aggregate, len(parameter_sets), config.selection_bias_penalty_scale, [item["netReturn"] for item in per_dataset])
                train_candidates.append({
                    "parameterId": parameter_id,
                    "parameters": parameters,
                    "perDataset": per_dataset,
                    "aggregate": aggregate,
                    "selectionBiasPenalty": penalty,
                    "selectionScore": score,
                })
            ranked = sorted(train_candidates, key=lambda item: (-item["selectionScore"], item["parameterId"]))
            selected = ranked[0]
            selected_parameters = json.loads(json.dumps(selected["parameters"], sort_keys=True))
            validation, test, stress = [], [], []
            for dataset in datasets:
                bars = prepared[dataset.dataset_id][0]
                fold = geometries[dataset.dataset_id]["folds"][fold_index]
                adapter = adapters[dataset.dataset_id]
                validation.append({"datasetId": dataset.dataset_id, **_simulate(adapter, bars, selected_parameters, fold["validation"], config.fee_bps, config.slippage_bps)})
                test.append({"datasetId": dataset.dataset_id, **_simulate(adapter, bars, selected_parameters, fold["test"], config.fee_bps, config.slippage_bps)})
                stress.append({"datasetId": dataset.dataset_id, **_simulate(adapter, bars, selected_parameters, fold["test"], config.stress_fee_bps, config.stress_slippage_bps)})
            perturbations = []
            for parameters in parameter_sets:
                if canonical_sha256(parameters) == selected["parameterId"]:
                    continue
                metrics = []
                for dataset in datasets:
                    bars = prepared[dataset.dataset_id][0]
                    bounds = geometries[dataset.dataset_id]["folds"][fold_index]["test"]
                    metrics.append({"datasetId": dataset.dataset_id, **_simulate(adapters[dataset.dataset_id], bars, parameters, bounds, config.fee_bps, config.slippage_bps)})
                perturbations.append({"parameterId": canonical_sha256(parameters), "aggregate": _aggregate(metrics)})
            selected_test = _aggregate(test)
            parameter_delta = max((abs(item["aggregate"]["medianNetReturn"] - selected_test["medianNetReturn"]) for item in perturbations), default=0.0)
            fold_records.append({
                "fold": fold_index,
                "selectionPhase": "train-only",
                "selectionCount": len(parameter_sets),
                "trainCandidates": train_candidates,
                "selectedParameterId": selected["parameterId"],
                "selectedParameters": selected_parameters,
                "validationEvaluationCount": len(datasets),
                "validation": {"perDataset": validation, "aggregate": _aggregate(validation)},
                "testEvaluationCount": len(datasets),
                "test": {"perDataset": test, "aggregate": selected_test},
                "stressTestEvaluationCount": len(datasets),
                "stressTest": {"perDataset": stress, "aggregate": _aggregate(stress)},
                "parameterPerturbationEvaluationCount": len(perturbations) * len(datasets),
                "parameterStability": {"maxMedianReturnDelta": parameter_delta, "passed": parameter_delta <= config.max_parameter_return_delta},
                "validationAndTestUsedForFitting": False,
            })
        last = fold_records[-1]
        preholdout_reasons = []
        if last["stressTest"]["aggregate"]["medianNetReturn"] < config.min_stress_test_return:
            preholdout_reasons.append("HIGH_COST_TEST_RETURN_BELOW_THRESHOLD")
        if last["test"]["aggregate"]["positiveDatasetFraction"] < config.min_positive_market_fraction:
            preholdout_reasons.append("TEST_CROSS_MARKET_INCONSISTENT")
        if not all(item["parameterStability"]["passed"] for item in fold_records):
            preholdout_reasons.append("PARAMETER_PERTURBATION_UNSTABLE")
        strategies.append({
            "strategyId": spec.strategy_id,
            "specId": spec.to_dict()["specId"],
            "candidateParameterCount": len(parameter_sets),
            "selectionCountTotal": len(parameter_sets) * config.fold_count,
            "geometryByDataset": geometries,
            "folds": fold_records,
            "deploymentParameterId": last["selectedParameterId"],
            "deploymentParameters": last["selectedParameters"],
            "preHoldoutPassed": not preholdout_reasons,
            "preHoldoutReasons": preholdout_reasons,
        })
    report: dict[str, Any] = {
        "schemaVersion": "stage-4a12.robustness-development.v1",
        "labels": DEVELOPMENT_LABELS,
        "sourceCommit": source_commit,
        "config": asdict(config),
        "datasetMatrix": dataset_records,
        "datasetMatrixId": canonical_sha256(dataset_records),
        "candidateCount": len(specs),
        "reportedCandidateCount": len(strategies),
        "selectionPolicy": "train-only-cross-market-penalized",
        "selectionBiasControl": "median train return minus cross-market dispersion times sqrt(2*log(selectionCount)); all candidates reported",
        "finalHoldoutEvaluationCount": 0,
        "strategies": strategies,
        "isolationVerified": True,
    }
    report["developmentId"] = canonical_sha256(report)
    return report


class HoldoutLedger:
    """Persistent fail-closed ledger. A reservation is itself a consumption."""

    def __init__(self, path: Path):
        self.path = path

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"schemaVersion": "stage-4a12.holdout-ledger.v1", "entries": {}}
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if payload.get("schemaVersion") != "stage-4a12.holdout-ledger.v1" or not isinstance(payload.get("entries"), dict):
            raise ValueError("FINAL_HOLDOUT_LEDGER_INVALID")
        return payload

    def _write(self, payload: Mapping[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f"{self.path.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)

    def reserve(self, keys: Sequence[str], run_id: str) -> None:
        payload = self._load()
        if len(set(keys)) != len(keys) or any(key in payload["entries"] for key in keys):
            raise ValueError("FINAL_HOLDOUT_REUSE_DETECTED")
        for key in keys:
            payload["entries"][key] = {"runId": run_id, "evaluationCount": 1, "status": "reserved"}
        self._write(payload)

    def complete(self, key: str, result_digest: str) -> None:
        payload = self._load()
        entry = payload["entries"].get(key)
        if not entry or entry.get("status") != "reserved" or entry.get("evaluationCount") != 1:
            raise ValueError("FINAL_HOLDOUT_LEDGER_STATE_INVALID")
        entry["status"] = "consumed"
        entry["resultDigest"] = result_digest
        self._write(payload)


def finalize_robustness_evaluation(
    development: Mapping[str, Any],
    specs: Sequence[StrategySpec],
    datasets: Sequence[MarketDataset],
    ledger: HoldoutLedger,
    run_id: str,
) -> dict[str, Any]:
    unsigned = dict(development)
    development_id = unsigned.pop("developmentId", None)
    if development_id != canonical_sha256(unsigned) or development.get("finalHoldoutEvaluationCount") != 0:
        raise ValueError("ROBUSTNESS_DEVELOPMENT_ID_INVALID")
    config = RobustnessConfig(**development["config"])
    _validate_config(config)
    prepared = {item.dataset_id: _working_dataset(item, config) for item in datasets}
    expected_matrix = [prepared[item.dataset_id][1] for item in datasets]
    if expected_matrix != development.get("datasetMatrix") or canonical_sha256(expected_matrix) != development.get("datasetMatrixId"):
        raise ValueError("ROBUSTNESS_DATASET_MATRIX_MISMATCH")
    spec_by_id = {item.strategy_id: item for item in specs}
    if set(spec_by_id) != {item["strategyId"] for item in development["strategies"]}:
        raise ValueError("ROBUSTNESS_SPEC_SET_MISMATCH")

    reservations: list[tuple[str, Mapping[str, Any], MarketDataset, StrategySpec, pd.DataFrame, Mapping[str, int]]] = []
    for strategy in development["strategies"]:
        spec = spec_by_id[strategy["strategyId"]]
        if spec.to_dict()["specId"] != strategy["specId"]:
            raise ValueError("ROBUSTNESS_SPEC_ID_MISMATCH")
        expected_geometry = {item.dataset_id: _geometry(len(prepared[item.dataset_id][0]), spec.warmup_bars, config) for item in datasets}
        if expected_geometry != strategy.get("geometryByDataset"):
            raise ValueError("ROBUSTNESS_GEOMETRY_MISMATCH")
        declared = {canonical_sha256(item) for item in candidate_parameter_sets(spec)}
        if strategy["deploymentParameterId"] not in declared or canonical_sha256(strategy["deploymentParameters"]) != strategy["deploymentParameterId"]:
            raise ValueError("ROBUSTNESS_DEPLOYMENT_PARAMETERS_INVALID")
        for dataset in datasets:
            bars = prepared[dataset.dataset_id][0]
            holdout = _geometry(len(bars), spec.warmup_bars, config)["finalHoldout"]
            key_payload = {
                "developmentId": development_id,
                "strategyId": spec.strategy_id,
                "specId": strategy["specId"],
                "datasetId": dataset.dataset_id,
                "workingDataframeSha256": prepared[dataset.dataset_id][1]["workingDataframeSha256"],
                "deploymentParameterId": strategy["deploymentParameterId"],
                "finalHoldout": holdout,
            }
            key = canonical_sha256(key_payload)
            reservations.append((key, strategy, dataset, spec, bars, holdout))
    ledger.reserve([item[0] for item in reservations], run_id)

    per_strategy: dict[str, list[dict[str, Any]]] = {item.strategy_id: [] for item in specs}
    for key, strategy, dataset, spec, bars, holdout in reservations:
        adapter = CompiledStrategyAdapter(spec)
        result = _simulate(adapter, bars, strategy["deploymentParameters"], holdout, config.fee_bps, config.slippage_bps)
        ledger.complete(key, canonical_sha256(result))
        per_strategy[spec.strategy_id].append({"datasetId": dataset.dataset_id, "ledgerKey": key, **result})

    decisions = []
    for strategy in development["strategies"]:
        metrics = per_strategy[strategy["strategyId"]]
        aggregate = _aggregate(metrics)
        reasons = list(strategy["preHoldoutReasons"])
        if aggregate["medianNetReturn"] <= 0:
            reasons.append("FINAL_HOLDOUT_NOT_POSITIVE")
        if aggregate["totalTrades"] < config.min_total_holdout_trades:
            reasons.append("FINAL_HOLDOUT_TRADE_COUNT_BELOW_THRESHOLD")
        if aggregate["maxDrawdown"] > config.max_holdout_drawdown:
            reasons.append("FINAL_HOLDOUT_DRAWDOWN_EXCEEDED")
        if aggregate["positiveDatasetFraction"] < config.min_positive_market_fraction:
            reasons.append("FINAL_HOLDOUT_CROSS_MARKET_INCONSISTENT")
        eligible = not reasons
        decisions.append({
            "strategyId": strategy["strategyId"],
            "specId": strategy["specId"],
            "deploymentParameterId": strategy["deploymentParameterId"],
            "finalHoldoutEvaluationCount": len(metrics),
            "expectedFinalHoldoutEvaluationCount": len(datasets),
            "finalHoldout": {"perDataset": metrics, "aggregate": aggregate},
            "robustnessPassed": eligible,
            "promotionEligible": eligible,
            "promotionReasons": reasons,
            "paperReadinessReview": eligible,
            "paperApproved": False,
            "testnetApproved": False,
            "liveApproved": False,
        })
    report: dict[str, Any] = {
        "schemaVersion": "stage-4a12.robustness-final.v1",
        "labels": FINAL_LABELS,
        "sourceCommit": development["sourceCommit"],
        "developmentId": development_id,
        "datasetMatrixId": development["datasetMatrixId"],
        "candidateCount": len(decisions),
        "backtestCompletedCount": len(decisions),
        "robustnessPassedCount": sum(item["robustnessPassed"] for item in decisions),
        "promotionEligibleCount": sum(item["promotionEligible"] for item in decisions),
        "finalHoldoutEvaluationCount": len(reservations),
        "expectedFinalHoldoutEvaluationCount": len(specs) * len(datasets),
        "holdoutRunId": run_id,
        "decisions": decisions,
        "approvals": {"paperApproved": False, "testnetApproved": False, "liveApproved": False},
    }
    report["proofId"] = canonical_sha256(report)
    return report
