#!/usr/bin/env python3
"""Run the single frozen Stage 5 TRAIN/VALIDATION research round offline."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.stage5_evaluation import canonical_json_bytes, canonical_sha256  # noqa: E402
from quant_engine.proof.stage5_harness import RegisteredOfflineAdapter, bars_from_binance_rows, run_offline_replay, strategy_spec_from_registry  # noqa: E402
from quant_engine.proof.stage5_research import aggregate_fold_metrics, build_fold_geometry, build_stage5_validation_decision, summarize_assets, verify_stage5_validation_decision  # noqa: E402


SYMBOLS = ("BNBUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT")
CANONICAL = {symbol: f"{symbol[:-4]}/USDT" for symbol in SYMBOLS}


def _read_json(path: Path) -> tuple[bytes, dict[str, Any]]:
    raw = path.read_bytes()
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("RESEARCH_INPUT_NOT_OBJECT")
    canonical_json_bytes(value)
    return raw, value


def _read_rows(path: Path, expected_sha256: str) -> list[list[Any]]:
    raw = path.read_bytes()
    rows = json.loads(raw.decode("utf-8"))
    if not isinstance(rows, list) or raw != canonical_json_bytes(rows) + b"\n":
        raise ValueError("RESEARCH_PRIVATE_ROWS_NOT_CANONICAL")
    if hashlib.sha256(canonical_json_bytes(rows)).hexdigest() != expected_sha256:
        raise ValueError("RESEARCH_PRIVATE_ROWS_SHA256_MISMATCH")
    return rows


def _phase(adapter: RegisteredOfflineAdapter, bars: pd.DataFrame, parameters: dict[str, Any], cost: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    adapter.prime(bars, parameters)
    results = [run_offline_replay(adapter, bars, parameters, item["start"], item["endExclusive"], cost) for item in build_fold_geometry(len(bars))]
    metrics = [item["metrics"] for item in results]
    return aggregate_fold_metrics(metrics), [
        {"metrics": result["metrics"], "digests": result["digests"], "resultId": result["resultId"]}
        for result in results
    ]


def _volatility_regimes(bars: pd.DataFrame) -> list[str]:
    values = []
    for geometry in build_fold_geometry(len(bars)):
        closes = bars["close"].iloc[geometry["start"]:geometry["endExclusive"]].astype(float)
        values.append(float(closes.pct_change().dropna().std(ddof=0)))
    order = sorted(range(3), key=lambda index: (values[index], index))
    labels = ["" for _ in range(3)]
    for index, label in zip(order, ("LOW", "MEDIUM", "HIGH")):
        labels[index] = label
    return labels


def _worker(task: dict[str, Any]) -> dict[str, Any]:
    symbol = task["symbol"]
    dataset_lookup = {(item["phase"], item["symbol"]): item for item in task["dataset"]["datasets"]}
    frames = {}
    for phase in ("TRAIN", "VALIDATION"):
        metadata = dataset_lookup[(phase, symbol)]
        rows_path = Path(task["privateDataDir"]) / phase.lower() / f"{symbol}-5m.json"
        frames[phase] = bars_from_binance_rows(_read_rows(rows_path, metadata["rawRowsSha256"]))
        if len(frames[phase]) != metadata["expectedRowCount"]:
            raise ValueError("RESEARCH_PRIVATE_ROWS_COUNT_MISMATCH")
    regimes = _volatility_regimes(frames["VALIDATION"])
    output = []
    for candidate in task["registry"]["candidates"]:
        spec = strategy_spec_from_registry(candidate)
        for parameter in candidate["parameterSets"]:
            values = parameter["values"]
            train_metrics, train_folds = _phase(RegisteredOfflineAdapter(spec), frames["TRAIN"], values, task["baselineCost"])
            validation_adapter = RegisteredOfflineAdapter(spec)
            validation_metrics, validation_folds = _phase(validation_adapter, frames["VALIDATION"], values, task["baselineCost"])
            stress_metrics, stress_folds = _phase(RegisteredOfflineAdapter(spec), frames["VALIDATION"], values, task["stressCost"])
            output.append({
                "strategyId": candidate["strategyId"], "specId": candidate["specId"], "parameterId": parameter["parameterId"],
                "symbol": CANONICAL[symbol],
                "trainMetrics": train_metrics, "trainFolds": train_folds,
                "validationMetrics": validation_metrics, "validationFolds": validation_folds,
                "stressMetrics": stress_metrics, "stressFolds": stress_folds,
                "validationRegimes": regimes,
            })
    return {"symbol": CANONICAL[symbol], "evaluations": output}


def generate_results(registry: dict[str, Any], evaluation: dict[str, Any], dataset: dict[str, Any], private_data_dir: Path, workers: int) -> dict[str, Any]:
    tasks = [{
        "symbol": symbol, "registry": registry, "evaluation": evaluation, "dataset": dataset,
        "privateDataDir": str(private_data_dir), "baselineCost": evaluation["costModel"]["baseline"],
        "stressCost": evaluation["costModel"]["stress"],
    } for symbol in SYMBOLS]
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as executor:
        outputs = list(executor.map(_worker, tasks))
    by_key: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for output in outputs:
        for item in output["evaluations"]:
            key = (item["strategyId"], item["specId"], item["parameterId"])
            by_key.setdefault(key, []).append(item)
    evaluations = []
    train_geometry, validation_geometry = build_fold_geometry(78624), build_fold_geometry(26208)
    for key in sorted(by_key):
        items = sorted(by_key[key], key=lambda item: item["symbol"])

        def phase_record(name: str, metric_key: str, fold_key: str, geometry: list[dict[str, int]]) -> dict[str, Any]:
            assets = [{"symbol": item["symbol"], "metrics": item[metric_key]} for item in items]
            folds = []
            for index, fold_geometry in enumerate(geometry):
                fold_assets = [{"symbol": item["symbol"], "metrics": item[fold_key][index]["metrics"], "resultId": item[fold_key][index]["resultId"], "digests": item[fold_key][index]["digests"]} for item in items]
                folds.append({**fold_geometry, "assets": fold_assets, "summary": summarize_assets(fold_assets)})
            return {"phase": name, "assets": assets, "summary": summarize_assets(assets), "folds": folds}

        train = phase_record("TRAIN", "trainMetrics", "trainFolds", train_geometry)
        validation = phase_record("VALIDATION", "validationMetrics", "validationFolds", validation_geometry)
        stress_assets = [{"symbol": item["symbol"], "metrics": item["stressMetrics"]} for item in items]
        fold_summaries = [fold["summary"] for fold in validation["folds"]]
        regime_counts = {label: sum(label in item["validationRegimes"] for item in items) for label in ("LOW", "MEDIUM", "HIGH")}
        evaluations.append({
            "strategyId": key[0], "specId": key[1], "parameterId": key[2],
            "train": train, "validation": validation,
            "validationStress": {"phase": "VALIDATION_STRESS", "assets": stress_assets, "summary": summarize_assets(stress_assets)},
            "foldStability": {"foldCount": 3, "positiveValidationFoldCount": sum(item["medianNetReturn"] > 0 for item in fold_summaries), "minimumValidationFoldMedianReturn": min(item["medianNetReturn"] for item in fold_summaries), "maximumValidationFoldDrawdown": max(item["maximumAssetDrawdown"] for item in fold_summaries)},
            "regimeAudit": {"classification": "WITHIN_ASSET_REALIZED_VOLATILITY_TERCILES_DESCRIPTIVE_ONLY", **regime_counts, "usedForSelection": False},
        })
    results: dict[str, Any] = {
        "schemaVersion": "stage-5.research-results.v1", "phases": ["TRAIN", "VALIDATION"], "lockedTestAccessCount": 0,
        "adversarialChecks": {"extremeVolatility": "FINITE_FAIL_CLOSED_VERIFIED", "gapPolicy": "REJECT_VERIFIED", "missingData": "REJECT_VERIFIED", "parameterSearch": "DECLARED_SETS_ONLY", "signalDelay": "CLOSED_BAR_NEXT_OPEN_ONE_BAR_FIXED"},
        "evaluations": evaluations,
    }
    results["resultsId"] = canonical_sha256(results)
    return results


def _write_exclusive(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(canonical_json_bytes(value) + b"\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--evaluation-spec", type=Path, required=True)
    parser.add_argument("--dataset-manifest", type=Path, required=True)
    parser.add_argument("--private-data-dir", type=Path)
    parser.add_argument("--results-output", type=Path)
    parser.add_argument("--decision-output", type=Path, required=True)
    parser.add_argument("--verify-results", type=Path)
    parser.add_argument("--verify-decision", type=Path)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    registry_raw, registry = _read_json(args.registry)
    evaluation_raw, evaluation = _read_json(args.evaluation_spec)
    dataset_raw, dataset = _read_json(args.dataset_manifest)
    if args.verify_results and args.verify_decision:
        _, results = _read_json(args.verify_results)
        _, decision = _read_json(args.verify_decision)
        verify_stage5_validation_decision(decision, args.source_commit, registry_raw, evaluation_raw, dataset_raw, results)
    else:
        if args.private_data_dir is None or args.results_output is None:
            parser.error("generation requires private data and results output")
        results = generate_results(registry, evaluation, dataset, args.private_data_dir, args.workers)
        decision = build_stage5_validation_decision(args.source_commit, registry_raw, evaluation_raw, dataset_raw, results)
        verify_stage5_validation_decision(decision, args.source_commit, registry_raw, evaluation_raw, dataset_raw, results)
        _write_exclusive(args.results_output, results)
        _write_exclusive(args.decision_output, decision)
    print("STAGE 5.5 TRAIN AND VALIDATION RESEARCH")
    print(f"RESULTS_ID={results['resultsId']}")
    print(f"DECISION_ID={decision['decisionId']}")
    print(f"STATUS={decision['status']}")
    print(f"FROZEN_CANDIDATE_COUNT={0 if decision['frozenCandidate'] is None else 1}")
    print("LOCKED_TEST_ACCESS_COUNT=0")
    print("PAPER_TESTNET_LIVE_CALLS=0")
    print("VERIFY=PASS")


if __name__ == "__main__":
    main()
