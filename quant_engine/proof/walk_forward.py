"""Causal per-fold selection with an exact-once final holdout."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

import pandas as pd

from .strategy_adapter import StrategyAdapter, simulate_window
from .gap_policy import dataframe_sha256


@dataclass(frozen=True)
class WalkForwardConfig:
    train_bars: int
    validation_bars: int
    test_bars: int
    purge_bars: int = 0
    embargo_bars: int = 0
    feature_lookback_bars: int = 0
    label_horizon_bars: int = 0
    final_holdout_ratio: float = 0.15
    final_holdout_min_bars: int | None = None


def _canonical_sha(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def run_causal_walk_forward(
    adapter: StrategyAdapter,
    bars: pd.DataFrame,
    candidates: Sequence[Mapping[str, Any]],
    config: WalkForwardConfig,
    data_audit: Mapping[str, Any],
    segment_index: int = 0,
) -> dict[str, Any]:
    if not candidates:
        raise ValueError("CANDIDATES_EMPTY")
    if min(config.train_bars, config.validation_bars, config.test_bars) <= 1:
        raise ValueError("WALK_FORWARD_BARS_INVALID")
    if min(config.purge_bars, config.embargo_bars, config.feature_lookback_bars, config.label_horizon_bars) < 0:
        raise ValueError("WALK_FORWARD_GAP_INVALID")
    if not (0 < config.final_holdout_ratio < 1):
        raise ValueError("FINAL_HOLDOUT_RATIO_INVALID")
    if config.final_holdout_min_bars is not None and config.final_holdout_min_bars < 0:
        raise ValueError("FINAL_HOLDOUT_MIN_INVALID")
    if data_audit.get("dataframeSha256") != dataframe_sha256(bars):
        raise ValueError("DATA_AUDIT_SHA_MISMATCH")
    segments = data_audit.get("segments")
    if not isinstance(segments, list) or not (0 <= segment_index < len(segments)):
        raise ValueError("DATA_SEGMENT_INVALID")
    if data_audit.get("gapCount", 0) and data_audit.get("gapPolicy") != "segment":
        raise ValueError("GAPPED_DATA_NOT_SEGMENTED")
    selected_segment = segments[segment_index]
    segment_start = int(selected_segment["startRow"])
    segment_end = int(selected_segment["endRowExclusive"])
    if not (0 <= segment_start < segment_end <= len(bars)):
        raise ValueError("DATA_SEGMENT_RANGE_INVALID")
    working_bars = bars.iloc[segment_start:segment_end].reset_index(drop=True)

    holdout_bars = max(
        math.ceil(len(working_bars) * config.final_holdout_ratio),
        config.final_holdout_min_bars or (3 * config.test_bars),
    )
    holdout_start = len(working_bars) - holdout_bars
    final_holdout_gap = max(config.purge_bars, config.embargo_bars, config.label_horizon_bars)
    development_end = holdout_start - final_holdout_gap
    phase_gap = max(config.purge_bars, config.label_horizon_bars)
    out_of_sample_gap = max(config.embargo_bars, config.label_horizon_bars)
    fold_step = config.test_bars + phase_gap + config.validation_bars + out_of_sample_gap

    split_ranges: list[dict[str, Any]] = []
    test_end = development_end
    while True:
        test_start = test_end - config.test_bars
        validation_end = test_start - phase_gap
        validation_start = validation_end - config.validation_bars
        train_end = validation_start - phase_gap
        train_start = config.feature_lookback_bars
        if train_end - train_start < config.train_bars:
            break
        split_ranges.append({
            "train": {"start": train_start, "endExclusive": train_end},
            "validation": {"start": validation_start, "endExclusive": validation_end},
            "test": {"start": test_start, "endExclusive": test_end},
        })
        test_end -= fold_step
    if not split_ranges:
        raise ValueError("INSUFFICIENT_DEVELOPMENT_BARS")
    split_ranges.reverse()

    folds: list[dict[str, Any]] = []
    test_calls = 0
    deployment: Mapping[str, Any] | None = None
    for ranges in split_ranges:
        validation_start = ranges["validation"]["start"]
        validation_end = ranges["validation"]["endExclusive"]
        test_start = ranges["test"]["start"]
        test_end = ranges["test"]["endExclusive"]
        candidate_results = []
        for candidate in candidates:
            metrics = simulate_window(adapter, working_bars, candidate, validation_start, validation_end)
            candidate_results.append({"parameters": dict(candidate), "metrics": metrics})
        ranked = sorted(candidate_results, key=lambda item: (-item["metrics"]["netReturn"], _canonical_sha(item["parameters"])))
        selected = ranked[0]
        frozen_parameters = json.loads(json.dumps(selected["parameters"], sort_keys=True))
        test_metrics = simulate_window(adapter, working_bars, frozen_parameters, test_start, test_end)
        test_calls += 1
        folds.append({
            "fold": len(folds),
            **ranges,
            "candidateResults": candidate_results,
            "selectedParameters": frozen_parameters,
            "testMetrics": test_metrics,
        })
        deployment = frozen_parameters

    if deployment is None:
        raise ValueError("NO_DEPLOYMENT_PARAMETERS")
    final_holdout_metrics = simulate_window(adapter, working_bars, deployment, holdout_start, len(working_bars))
    report = {
        "schemaVersion": "stage-4a9.causal-walk-forward.v1",
        "strategyId": adapter.strategy_id,
        "adapterVersion": adapter.version,
        "dataframeSha256": data_audit["dataframeSha256"],
        "dataSegment": {"index": segment_index, **selected_segment},
        "foldIsolation": {
            "phaseGapBars": phase_gap,
            "outOfSampleGapBars": out_of_sample_gap,
            "finalHoldoutGapBars": final_holdout_gap,
        },
        "config": asdict(config),
        "folds": folds,
        "testEvaluationCount": test_calls,
        "deploymentParameters": dict(deployment),
        "finalHoldout": {"start": holdout_start, "endExclusive": len(working_bars)},
        "finalHoldoutEvaluationCount": 1,
        "finalHoldoutMetrics": final_holdout_metrics,
    }
    report["reportId"] = _canonical_sha(report)
    return report
