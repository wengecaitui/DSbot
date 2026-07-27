#!/usr/bin/env python3
"""Build or verify source-free Stage 4A13 governance artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.evidence_governance import (
    build_consumed_evidence_seed,
    build_failure_attribution,
    build_governance_attestation_subject,
    build_governance_contract,
    verify_consumed_evidence_seed,
    verify_failure_attribution,
    verify_governance_contract,
)
from quant_engine.proof.gap_policy import dataframe_sha256


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build_window_boundaries(data_dir: Path, development: dict, final: dict) -> dict[str, dict]:
    file_by_digest = {hashlib.sha256(path.read_bytes()).hexdigest(): path for path in data_dir.glob("*.feather")}
    results: dict[str, dict] = {}
    first_by_dataset = {item["datasetId"]: item for item in final["decisions"][0]["finalHoldout"]["perDataset"]}
    for dataset in development["datasetMatrix"]:
        path = file_by_digest.get(dataset["sourceSha256"])
        if path is None:
            raise ValueError(f"EVIDENCE_SOURCE_DATA_NOT_FOUND:{dataset['datasetId']}")
        frame = pd.read_feather(path)
        result = first_by_dataset[dataset["datasetId"]]
        absolute_start = int(dataset["workingStartRow"]) + int(result["start"])
        absolute_end = int(dataset["workingStartRow"]) + int(result["endExclusive"])
        window = frame.iloc[absolute_start:absolute_end].reset_index(drop=True)
        if len(window) != result["endExclusive"] - result["start"]:
            raise ValueError("EVIDENCE_SOURCE_WINDOW_LENGTH_INVALID")
        interval = pd.Timedelta("5min" if dataset["timeframe"] == "5m" else "4h")
        opens = pd.Timestamp(window.iloc[0]["date"])
        closes = pd.Timestamp(window.iloc[-1]["date"]) + interval
        results[dataset["datasetId"]] = {
            "start": result["start"],
            "endExclusive": result["endExclusive"],
            "opensAt": opens.isoformat().replace("+00:00", "Z"),
            "closesAt": closes.isoformat().replace("+00:00", "Z"),
            "windowDataSha256": dataframe_sha256(window),
        }
    if len(results) != 10:
        raise ValueError("EVIDENCE_SOURCE_WINDOW_COUNT_INVALID")
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-manifest", type=Path, required=True)
    parser.add_argument("--promotion-receipt", type=Path, required=True)
    parser.add_argument("--failure-report", type=Path, required=True)
    parser.add_argument("--evidence-seed", type=Path, required=True)
    parser.add_argument("--governance-contract", type=Path, required=True)
    parser.add_argument("--development", type=Path)
    parser.add_argument("--final", type=Path)
    parser.add_argument("--legacy-ledger", type=Path)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--baseline-commit")
    parser.add_argument("--receipt-commit")
    parser.add_argument("--subject-output", type=Path)
    parser.add_argument("--build", action="store_true")
    args = parser.parse_args()

    manifest = read_json(args.candidate_manifest)
    receipt = read_json(args.promotion_receipt)
    if args.build:
        if not all((args.development, args.final, args.legacy_ledger, args.data_dir, args.baseline_commit)):
            raise SystemExit("BUILD_REQUIRES_PRIVATE_INPUTS_AND_BASELINE")
        development = read_json(args.development)
        final = read_json(args.final)
        report = build_failure_attribution(development, manifest, args.baseline_commit)
        boundaries = build_window_boundaries(args.data_dir, development, final)
        seed = build_consumed_evidence_seed(final, read_json(args.legacy_ledger), receipt, manifest, boundaries)
        contract = build_governance_contract(args.baseline_commit)
        write_json(args.failure_report, report)
        write_json(args.evidence_seed, seed)
        write_json(args.governance_contract, contract)
    else:
        report = read_json(args.failure_report)
        seed = read_json(args.evidence_seed)
        contract = read_json(args.governance_contract)

    verify_failure_attribution(report, manifest)
    verify_consumed_evidence_seed(seed, receipt, manifest)
    verify_governance_contract(contract)
    if args.receipt_commit or args.subject_output:
        if not args.receipt_commit or not args.subject_output:
            raise SystemExit("ATTESTATION_REQUIRES_COMMIT_AND_OUTPUT")
        write_json(args.subject_output, build_governance_attestation_subject(report, seed, contract, args.receipt_commit))
    print(json.dumps({
        "reportId": report["reportId"],
        "seedId": seed["seedId"],
        "contractId": contract["contractId"],
        "consumedWindowCount": seed["windowCount"],
        "consumedEvaluationCount": seed["evaluationCount"],
        "freshEvidenceWindowAvailable": contract["freshEvidenceWindowAvailable"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
