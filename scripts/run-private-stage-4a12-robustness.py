#!/usr/bin/env python3
"""Run the private-data Stage 4A12 matrix without exposing local paths."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.asset_manifest import build_asset_manifest
from quant_engine.proof.gap_policy import GapPolicy, audit_ohlcv
from quant_engine.proof.robustness_gate import (
    HoldoutLedger,
    MarketDataset,
    RobustnessConfig,
    finalize_robustness_evaluation,
    prepare_robustness_evaluation,
)
from quant_engine.proof.strategy_spec import build_candidate_specs, canonical_sha256


def _load_dataset(path: Path, timeframe: str) -> MarketDataset:
    raw_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    frame = pd.read_feather(path)
    interval = pd.Timedelta("5min" if timeframe == "5m" else "4h")
    audit = audit_ohlcv(frame, interval, GapPolicy.REJECT)
    symbol = path.stem.rsplit("-", 1)[0].replace("_", "/")
    dataset_id = canonical_sha256({"symbol": symbol, "timeframe": timeframe, "sourceSha256": raw_sha})
    return MarketDataset(dataset_id, symbol, timeframe, frame, audit, source_sha256=raw_sha)


def _discover(data_dir: Path) -> list[MarketDataset]:
    five_minute = sorted(data_dir.glob("*_USDT-5m.feather"))
    four_hour = sorted(data_dir.glob("*_USDT-4h.feather"))
    if len(five_minute) != 8 or {item.name for item in four_hour} != {"BTC_USDT-4h.feather", "ETH_USDT-4h.feather"}:
        raise ValueError(f"STAGE_4A12_DATA_MATRIX_INVALID:5m={len(five_minute)}:4h={len(four_hour)}")
    return [_load_dataset(item, "5m") for item in five_minute] + [_load_dataset(item, "4h") for item in four_hour]


def _write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--development-output", type=Path, required=True)
    parser.add_argument("--consume-final-holdout", action="store_true")
    parser.add_argument("--final-output", type=Path)
    parser.add_argument("--ledger", type=Path)
    parser.add_argument("--run-id")
    args = parser.parse_args()
    specs = build_candidate_specs(build_asset_manifest(REPO, args.source_commit))
    datasets = _discover(args.data_dir)
    config = RobustnessConfig()
    development = prepare_robustness_evaluation(specs, datasets, config, args.source_commit)
    _write(args.development_output, development)
    print(f"DEVELOPMENT_ID={development['developmentId']} CANDIDATES={len(specs)} DATASETS={len(datasets)} FINAL_HOLDOUT_CALLS=0")
    if args.consume_final_holdout:
        if not args.final_output or not args.ledger or not args.run_id:
            raise ValueError("FINAL_HOLDOUT_OUTPUT_LEDGER_RUN_ID_REQUIRED")
        final = finalize_robustness_evaluation(development, specs, datasets, HoldoutLedger(args.ledger), args.run_id)
        _write(args.final_output, final)
        print(f"PROOF_ID={final['proofId']} BACKTESTS={final['backtestCompletedCount']} ROBUSTNESS_PASSED={final['robustnessPassedCount']} PROMOTION_ELIGIBLE={final['promotionEligibleCount']} FINAL_HOLDOUT_CALLS={final['finalHoldoutEvaluationCount']}")


if __name__ == "__main__":
    main()
