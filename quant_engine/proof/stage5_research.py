"""Deterministic Stage 5.5 TRAIN/VALIDATION research decision receipt."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import statistics
from collections.abc import Mapping, Sequence
from typing import Any

from quant_engine.proof.stage5_evaluation import canonical_json_bytes, canonical_sha256


SCHEMA_VERSION = "stage-5.validation-decision.v1"
_GIT_SHA = re.compile(r"^[a-f0-9]{40}$")
_SYMBOLS = ("BNB/USDT", "BTC/USDT", "ETH/USDT", "SOL/USDT")
_METRICS = (
    "grossReturn", "netReturn", "maximumDrawdown", "sharpe", "sortino",
    "profitFactor", "winRate", "averageWin", "averageLoss", "expectancy",
    "turnover", "tradeCount", "exposure", "fees", "spreadCost",
    "slippageCost", "fundingCost", "mfe", "mae", "rMultiple",
)


def build_fold_geometry(row_count: int, warmup_bars: int = 100, embargo_bars: int = 96) -> list[dict[str, int]]:
    if not isinstance(row_count, int) or row_count <= warmup_bars + embargo_bars * 3 + 6:
        raise ValueError("RESEARCH_FOLD_ROW_COUNT_INVALID")
    scored_start, scored_end = warmup_bars, row_count - embargo_bars
    usable = scored_end - scored_start - 2 * embargo_bars
    base, remainder = divmod(usable, 3)
    folds = []
    cursor = scored_start
    for index in range(3):
        size = base + (1 if index < remainder else 0)
        folds.append({"foldIndex": index, "start": cursor, "endExclusive": cursor + size})
        cursor += size + (embargo_bars if index < 2 else 0)
    if folds[-1]["endExclusive"] != scored_end:
        raise ValueError("RESEARCH_FOLD_GEOMETRY_INTERNAL")
    return folds


def _parse(raw: bytes, label: str) -> dict[str, Any]:
    if not isinstance(raw, bytes):
        raise TypeError(f"{label}_RAW_MUST_BE_BYTES")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label}_RAW_INVALID") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label}_NOT_OBJECT")
    canonical_json_bytes(value)
    return value


def _verify_self_id(value: Mapping[str, Any], key: str, label: str) -> None:
    unsigned = dict(value)
    identity = unsigned.pop(key, None)
    if not isinstance(identity, str) or identity != canonical_sha256(unsigned):
        raise ValueError(f"{label}_IDENTITY_INVALID")


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValueError(f"{label}_INVALID")
    return float(value)


def summarize_assets(assets: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not isinstance(assets, Sequence) or isinstance(assets, (str, bytes)) or len(assets) != 4:
        raise ValueError("RESEARCH_ASSET_CARDINALITY_INVALID")
    by_symbol: dict[str, Mapping[str, Any]] = {}
    for item in assets:
        if not isinstance(item, Mapping) or item.get("symbol") not in _SYMBOLS or item["symbol"] in by_symbol:
            raise ValueError("RESEARCH_ASSET_INVALID")
        metrics = item.get("metrics")
        if not isinstance(metrics, Mapping) or tuple(metrics) != _METRICS:
            raise ValueError("RESEARCH_METRICS_INVALID")
        for name in _METRICS:
            _finite_number(metrics[name], f"RESEARCH_METRIC_{name}")
        if int(metrics["tradeCount"]) != metrics["tradeCount"] or metrics["tradeCount"] < 0:
            raise ValueError("RESEARCH_TRADE_COUNT_INVALID")
        by_symbol[str(item["symbol"])] = item
    ordered = [by_symbol[symbol]["metrics"] for symbol in _SYMBOLS]
    return {
        "aggregationMethod": "CONSERVATIVE_CROSS_ASSET_V1",
        "assetCount": 4,
        "aggregateTradeCount": sum(int(metrics["tradeCount"]) for metrics in ordered),
        "minimumAssetTradeCount": min(int(metrics["tradeCount"]) for metrics in ordered),
        "medianNetReturn": statistics.median(float(metrics["netReturn"]) for metrics in ordered),
        "positiveAssets": sum(float(metrics["netReturn"]) > 0 for metrics in ordered),
        "maximumAssetDrawdown": max(float(metrics["maximumDrawdown"]) for metrics in ordered),
        "aggregateProfitFactor": min(float(metrics["profitFactor"]) for metrics in ordered),
        "aggregateSharpe": min(float(metrics["sharpe"]) for metrics in ordered),
        "aggregateSortino": min(float(metrics["sortino"]) for metrics in ordered),
        "medianTurnover": statistics.median(float(metrics["turnover"]) for metrics in ordered),
        "medianCostBurden": statistics.median(
            float(metrics["fees"]) + float(metrics["spreadCost"]) + float(metrics["slippageCost"]) + float(metrics["fundingCost"])
            for metrics in ordered
        ),
    }


def aggregate_fold_metrics(fold_metrics: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not isinstance(fold_metrics, Sequence) or isinstance(fold_metrics, (str, bytes)) or len(fold_metrics) != 3:
        raise ValueError("RESEARCH_FOLD_METRIC_CARDINALITY_INVALID")
    for metrics in fold_metrics:
        if not isinstance(metrics, Mapping) or tuple(metrics) != _METRICS:
            raise ValueError("RESEARCH_FOLD_METRICS_INVALID")
        for name in _METRICS:
            _finite_number(metrics[name], f"RESEARCH_FOLD_METRIC_{name}")
    counts = [int(item["tradeCount"]) for item in fold_metrics]
    total = sum(counts)

    def weighted(name: str) -> float:
        return 0.0 if total == 0 else sum(float(item[name]) * count for item, count in zip(fold_metrics, counts)) / total

    def compound(name: str) -> float:
        return math.prod(1.0 + float(item[name]) for item in fold_metrics) - 1.0

    return {
        "grossReturn": compound("grossReturn"),
        "netReturn": compound("netReturn"),
        "maximumDrawdown": max(float(item["maximumDrawdown"]) for item in fold_metrics),
        "sharpe": min(float(item["sharpe"]) for item in fold_metrics),
        "sortino": min(float(item["sortino"]) for item in fold_metrics),
        "profitFactor": min(float(item["profitFactor"]) for item in fold_metrics),
        "winRate": weighted("winRate"),
        "averageWin": weighted("averageWin"),
        "averageLoss": weighted("averageLoss"),
        "expectancy": weighted("expectancy"),
        "turnover": sum(float(item["turnover"]) for item in fold_metrics),
        "tradeCount": total,
        "exposure": statistics.fmean(float(item["exposure"]) for item in fold_metrics),
        "fees": sum(float(item["fees"]) for item in fold_metrics),
        "spreadCost": sum(float(item["spreadCost"]) for item in fold_metrics),
        "slippageCost": sum(float(item["slippageCost"]) for item in fold_metrics),
        "fundingCost": sum(float(item["fundingCost"]) for item in fold_metrics),
        "mfe": weighted("mfe"),
        "mae": weighted("mae"),
        "rMultiple": weighted("rMultiple"),
    }


def _validate_phase(phase: Mapping[str, Any], label: str, expected_geometry: Sequence[Mapping[str, int]]) -> dict[str, Any]:
    if not isinstance(phase, Mapping) or phase.get("phase") != label:
        raise ValueError(f"RESEARCH_{label}_INVALID")
    assets = phase.get("assets")
    summary = summarize_assets(assets)
    if phase.get("summary") != summary:
        raise ValueError(f"RESEARCH_{label}_SUMMARY_INVALID")
    folds = phase.get("folds")
    if not isinstance(folds, list) or len(folds) != 3:
        raise ValueError(f"RESEARCH_{label}_FOLDS_INVALID")
    for expected_index, fold in enumerate(folds):
        if not isinstance(fold, Mapping) or fold.get("foldIndex") != expected_index:
            raise ValueError(f"RESEARCH_{label}_FOLD_INDEX_INVALID")
        start, end = fold.get("start"), fold.get("endExclusive")
        if {"foldIndex": expected_index, "start": start, "endExclusive": end} != dict(expected_geometry[expected_index]):
            raise ValueError(f"RESEARCH_{label}_FOLD_GEOMETRY_INVALID")
        if fold.get("summary") != summarize_assets(fold.get("assets")):
            raise ValueError(f"RESEARCH_{label}_FOLD_SUMMARY_INVALID")
    return summary


def _gate_failures(validation: Mapping[str, Any], stress: Mapping[str, Any], gate: Mapping[str, Any]) -> list[str]:
    checks = (
        (validation["aggregateTradeCount"] >= gate["aggregateTradeCountMin"], "VALIDATION_AGGREGATE_TRADE_COUNT"),
        (validation["minimumAssetTradeCount"] >= gate["eachAssetTradeCountMin"], "VALIDATION_EACH_ASSET_TRADE_COUNT"),
        (validation["medianNetReturn"] > gate["medianNetReturnMinExclusive"], "VALIDATION_MEDIAN_NET_RETURN"),
        (validation["positiveAssets"] >= gate["positiveAssetsMin"], "VALIDATION_POSITIVE_ASSETS"),
        (validation["maximumAssetDrawdown"] <= gate["eachAssetMaximumDrawdownMax"], "VALIDATION_MAXIMUM_DRAWDOWN"),
        (validation["aggregateProfitFactor"] >= gate["aggregateProfitFactorMin"], "VALIDATION_PROFIT_FACTOR"),
        (validation["aggregateSharpe"] >= gate["aggregateSharpeMin"], "VALIDATION_SHARPE"),
        (validation["aggregateSortino"] >= gate["aggregateSortinoMin"], "VALIDATION_SORTINO"),
        (stress["medianNetReturn"] >= gate["stressedMedianNetReturnMin"], "VALIDATION_STRESSED_MEDIAN_NET_RETURN"),
    )
    return [reason for passed, reason in checks if not passed]


def _validate_upstream(registry: Mapping[str, Any], evaluation: Mapping[str, Any], dataset: Mapping[str, Any]) -> list[tuple[str, str, str]]:
    _verify_self_id(registry, "registryId", "CANDIDATE_REGISTRY")
    _verify_self_id(evaluation, "evaluationSpecId", "EVALUATION_SPEC")
    _verify_self_id(dataset, "datasetManifestId", "DATASET_MANIFEST")
    if registry.get("searchBudget") != {"researchRounds": 1, "candidates": 4, "parameterSets": 12, "promotionsMax": 1, "lockedTestAccess": 1}:
        raise ValueError("RESEARCH_BUDGET_INVALID")
    for source in (registry, evaluation, dataset):
        safety = source.get("safety", {})
        if safety.get("paperTestnetLiveCalls") != 0 or any(safety.get(key) is not False for key in ("activationAuthorized", "runtimeStarted", "paperApproved", "testnetApproved", "liveApproved")):
            raise ValueError("RESEARCH_UPSTREAM_SAFETY_INVALID")
    locked_sources = (registry.get("lockedTest", {}), dataset.get("splitManifest", {}).get("LOCKED_TEST", {}))
    if any(item.get("state") != "SEALED_UNOPENED" or item.get("accessCount") != 0 for item in locked_sources):
        raise ValueError("RESEARCH_LOCKED_TEST_CONTAMINATED")
    combinations = []
    for candidate in registry.get("candidates", []):
        if candidate.get("status") != "REGISTERED":
            raise ValueError("RESEARCH_CANDIDATE_NOT_REGISTERED")
        for parameter in candidate.get("parameterSets", []):
            combinations.append((candidate["strategyId"], candidate["specId"], parameter["parameterId"]))
    if len(combinations) != 12 or len(set(combinations)) != 12:
        raise ValueError("RESEARCH_COMBINATIONS_INVALID")
    return sorted(combinations)


def build_stage5_validation_decision(
    source_commit: str,
    registry_raw: bytes,
    evaluation_raw: bytes,
    dataset_raw: bytes,
    research_results: Mapping[str, Any],
) -> dict[str, Any]:
    if not isinstance(source_commit, str) or not _GIT_SHA.fullmatch(source_commit):
        raise ValueError("RESEARCH_SOURCE_COMMIT_INVALID")
    registry = _parse(registry_raw, "CANDIDATE_REGISTRY")
    evaluation = _parse(evaluation_raw, "EVALUATION_SPEC")
    dataset = _parse(dataset_raw, "DATASET_MANIFEST")
    combinations = _validate_upstream(registry, evaluation, dataset)
    results = copy.deepcopy(research_results)
    if not isinstance(results, Mapping) or results.get("schemaVersion") != "stage-5.research-results.v1":
        raise ValueError("RESEARCH_RESULTS_INVALID")
    if results.get("lockedTestAccessCount") != 0 or results.get("phases") != ["TRAIN", "VALIDATION"]:
        raise ValueError("RESEARCH_RESULTS_PHASE_CONTAMINATION")
    if results.get("adversarialChecks") != {
        "extremeVolatility": "FINITE_FAIL_CLOSED_VERIFIED",
        "gapPolicy": "REJECT_VERIFIED",
        "missingData": "REJECT_VERIFIED",
        "parameterSearch": "DECLARED_SETS_ONLY",
        "signalDelay": "CLOSED_BAR_NEXT_OPEN_ONE_BAR_FIXED",
    }:
        raise ValueError("RESEARCH_ADVERSARIAL_CHECKS_INVALID")
    unsigned_results = dict(results)
    result_id = unsigned_results.pop("resultsId", None)
    if result_id != canonical_sha256(unsigned_results):
        raise ValueError("RESEARCH_RESULTS_ID_INVALID")
    evaluations = results.get("evaluations")
    if not isinstance(evaluations, list) or len(evaluations) != 12:
        raise ValueError("RESEARCH_RESULT_CARDINALITY_INVALID")
    seen: set[tuple[str, str, str]] = set()
    assessed = []
    validation_gate = evaluation.get("validationGate", {})
    rows_by_phase = {
        phase: next(item["expectedRowCount"] for item in dataset["datasets"] if item["phase"] == phase)
        for phase in ("TRAIN", "VALIDATION")
    }
    geometries = {phase: build_fold_geometry(rows_by_phase[phase]) for phase in rows_by_phase}
    for item in evaluations:
        if not isinstance(item, Mapping):
            raise ValueError("RESEARCH_EVALUATION_INVALID")
        key = (item.get("strategyId"), item.get("specId"), item.get("parameterId"))
        if key not in combinations or key in seen:
            raise ValueError("RESEARCH_EVALUATION_LINEAGE_INVALID")
        seen.add(key)
        train_summary = _validate_phase(item.get("train"), "TRAIN", geometries["TRAIN"])
        validation_summary = _validate_phase(item.get("validation"), "VALIDATION", geometries["VALIDATION"])
        stress = item.get("validationStress")
        if not isinstance(stress, Mapping) or stress.get("phase") != "VALIDATION_STRESS" or stress.get("summary") != summarize_assets(stress.get("assets")):
            raise ValueError("RESEARCH_VALIDATION_STRESS_INVALID")
        failures = _gate_failures(validation_summary, stress["summary"], validation_gate)
        validation_folds = item["validation"]["folds"]
        expected_stability = {
            "foldCount": 3,
            "positiveValidationFoldCount": sum(fold["summary"]["medianNetReturn"] > 0 for fold in validation_folds),
            "minimumValidationFoldMedianReturn": min(fold["summary"]["medianNetReturn"] for fold in validation_folds),
            "maximumValidationFoldDrawdown": max(fold["summary"]["maximumAssetDrawdown"] for fold in validation_folds),
        }
        if item.get("foldStability") != expected_stability:
            raise ValueError("RESEARCH_FOLD_STABILITY_INVALID")
        if item.get("regimeAudit") != {
            "classification": "WITHIN_ASSET_REALIZED_VOLATILITY_TERCILES_DESCRIPTIVE_ONLY",
            "LOW": 4, "MEDIUM": 4, "HIGH": 4, "usedForSelection": False,
        }:
            raise ValueError("RESEARCH_REGIME_AUDIT_INVALID")
        assessed.append({
            "strategyId": key[0], "specId": key[1], "parameterId": key[2],
            "train": train_summary, "validation": validation_summary,
            "validationStress": stress["summary"],
            "foldStability": expected_stability,
            "regimeAudit": item["regimeAudit"],
            "passedValidation": not failures,
            "failureReasons": failures,
        })
    if seen != set(combinations):
        raise ValueError("RESEARCH_RESULT_COVERAGE_INVALID")
    assessed.sort(key=lambda item: (item["strategyId"], item["parameterId"]))
    passing = [item for item in assessed if item["passedValidation"]]
    passing.sort(key=lambda item: (
        -float(item["validation"]["medianNetReturn"]),
        -float(item["validation"]["aggregateSharpe"]),
        float(item["validation"]["maximumAssetDrawdown"]),
        item["strategyId"], item["parameterId"],
    ))
    selected = None if not passing else passing[0]
    candidates = []
    for candidate in registry["candidates"]:
        candidate_results = [item for item in assessed if item["strategyId"] == candidate["strategyId"]]
        candidate_passes = [item for item in candidate_results if item["passedValidation"]]
        validation_returns = [float(item["validation"]["medianNetReturn"]) for item in candidate_results]
        candidates.append({
            "strategyId": candidate["strategyId"], "specId": candidate["specId"],
            "stateEvents": [
                {"sequence": 1, "state": "REGISTERED"},
                {"sequence": 2, "state": "TRAIN_EVALUATED"},
                {"sequence": 3, "state": "VALIDATED" if candidate_passes else "REJECTED_VALIDATION"},
            ],
            "parameterResults": candidate_results,
            "parameterSensitivity": {
                "declaredParameterSetCount": len(candidate_results),
                "validationMedianReturnRange": max(validation_returns) - min(validation_returns),
                "allDeclaredSetsReported": True,
            },
            "failureReasons": sorted({reason for item in candidate_results for reason in item["failureReasons"]}),
        })
    decision: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "stage": "STAGE 5.5",
        "status": "FROZEN_CANDIDATE_READY_FOR_SINGLE_LOCKED_TEST" if selected else "NO_CANDIDATE_PASSED_VALIDATION",
        "sourceCommit": source_commit,
        "inputs": {
            "candidateRegistry": {"registryId": registry["registryId"], "rawSha256": hashlib.sha256(registry_raw).hexdigest()},
            "evaluationSpec": {"evaluationSpecId": evaluation["evaluationSpecId"], "rawSha256": hashlib.sha256(evaluation_raw).hexdigest()},
            "datasetManifest": {"datasetManifestId": dataset["datasetManifestId"], "rawSha256": hashlib.sha256(dataset_raw).hexdigest()},
            "researchResults": {"resultsId": result_id, "rawSha256": hashlib.sha256(canonical_json_bytes(results) + b"\n").hexdigest()},
        },
        "searchBudget": {"roundsConsumed": 1, "candidateParameterEvaluations": 12, "candidateExpansion": 0},
        "aggregationContract": {
            "method": "CONSERVATIVE_CROSS_ASSET_V1",
            "profitFactorSharpeSortino": "MINIMUM_ASSET_VALUE",
            "netReturn": "MEDIAN_ASSET_VALUE",
            "drawdown": "MAXIMUM_ASSET_VALUE",
            "selectionTieBreak": ["medianNetReturn desc", "aggregateSharpe desc", "maximumAssetDrawdown asc", "strategyId asc", "parameterId asc"],
        },
        "selectionBiasControl": {"method": "FIXED_GATE_PLUS_COMPLETE_REPORTING", "comparisonCount": 12, "postHocAssetOrTimeExclusions": False, "failedCandidatesHidden": False},
        "candidates": candidates,
        "frozenCandidate": None if selected is None else {
            "strategyId": selected["strategyId"], "specId": selected["specId"], "parameterId": selected["parameterId"],
            "candidateConfigHash": canonical_sha256({"strategyId": selected["strategyId"], "specId": selected["specId"], "parameterId": selected["parameterId"]}),
            "evaluationSpecId": evaluation["evaluationSpecId"],
            "trainingDataHash": canonical_sha256([item["normalizedSha256"] for item in dataset["datasets"] if item["phase"] == "TRAIN"]),
            "validationDataHash": canonical_sha256([item["normalizedSha256"] for item in dataset["datasets"] if item["phase"] == "VALIDATION"]),
            "codeCommit": source_commit,
        },
        "lockedTest": {"state": "SEALED_UNOPENED", "accessCount": 0, "usedForSelection": False},
        "safety": {"offlineOnly": True, "paperTestnetLiveCalls": 0, "activationAuthorized": False, "runtimeStarted": False, "paperApproved": False, "testnetApproved": False, "liveApproved": False},
    }
    decision["decisionId"] = canonical_sha256(decision)
    return decision


def verify_stage5_validation_decision(
    decision: Mapping[str, Any], source_commit: str, registry_raw: bytes,
    evaluation_raw: bytes, dataset_raw: bytes, research_results: Mapping[str, Any],
) -> None:
    expected = build_stage5_validation_decision(source_commit, registry_raw, evaluation_raw, dataset_raw, research_results)
    try:
        actual = canonical_json_bytes(decision)
    except (TypeError, ValueError) as error:
        raise ValueError("VALIDATION_DECISION_INVALID") from error
    if actual != canonical_json_bytes(expected):
        raise ValueError("VALIDATION_DECISION_MISMATCH")
