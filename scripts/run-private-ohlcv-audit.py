#!/usr/bin/env python3
"""Audit private OHLCV locally and emit a sanitized, path-free digest report."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.gap_policy import GapPolicy, audit_ohlcv


def _read(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix == ".parquet":
        return pd.read_parquet(path)
    if suffix == ".feather":
        return pd.read_feather(path)
    raise ValueError(f"UNSUPPORTED_DATA_FORMAT:{suffix}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, action="append", required=True)
    parser.add_argument("--interval", required=True, help="pandas duration, e.g. 5min or 4h")
    parser.add_argument("--gap-policy", choices=[item.value for item in GapPolicy], required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    records = []
    for path in sorted(args.input, key=lambda item: item.name):
        raw_sha = hashlib.sha256(path.read_bytes()).hexdigest()
        audit = audit_ohlcv(_read(path), pd.Timedelta(args.interval), GapPolicy(args.gap_policy))
        records.append({"sourceName": path.name, "sourceSha256": raw_sha, "audit": audit})
    report = {
        "schemaVersion": "stage-4a9.private-data-audit.v1",
        "labels": ["PRIVATE LOCAL PROOF BUNDLE", "NOT UPLOADED", "NOT APPROVED FOR PAPER, TESTNET OR LIVE"],
        "sourceCommit": args.source_commit,
        "interval": args.interval,
        "gapPolicy": args.gap_policy,
        "datasets": records,
    }
    report["proofId"] = hashlib.sha256(json.dumps(report, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"DATASETS={len(records)} GAPS={sum(item['audit']['gapCount'] for item in records)} PROOF_ID={report['proofId']}")


if __name__ == "__main__":
    main()
