#!/usr/bin/env python3
"""Build or verify the source-free Stage 4A12 promotion receipt."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.promotion_receipt import build_attestation_subject, build_promotion_receipt, verify_promotion_receipt


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-manifest", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--development", type=Path)
    parser.add_argument("--final", type=Path)
    parser.add_argument("--engine-commit")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--receipt-commit")
    parser.add_argument("--subject-output", type=Path)
    args = parser.parse_args()
    manifest = _read(args.candidate_manifest)
    if args.verify:
        receipt = _read(args.receipt)
        verify_promotion_receipt(receipt, manifest)
    else:
        if not args.development or not args.final or not args.engine_commit:
            raise ValueError("PROMOTION_RECEIPT_PRIVATE_INPUTS_REQUIRED")
        receipt = build_promotion_receipt(_read(args.development), _read(args.final), manifest, args.engine_commit)
        _write(args.receipt, receipt)
    if args.receipt_commit or args.subject_output:
        if not args.receipt_commit or not args.subject_output:
            raise ValueError("PROMOTION_RECEIPT_SUBJECT_ARGS_INCOMPLETE")
        _write(args.subject_output, build_attestation_subject(receipt, args.receipt_commit))
    print(f"RECEIPT_ID={receipt['receiptId']} PRIVATE_PROOF_ID={receipt['privateProofId']} CANDIDATES={receipt['counts']['candidateStrategiesGenerated']} PROMOTION_ELIGIBLE={receipt['counts']['promotionEligible']} PAPER_APPROVED=false TESTNET_APPROVED=false LIVE_APPROVED=false")


if __name__ == "__main__":
    main()
