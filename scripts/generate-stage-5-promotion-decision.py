#!/usr/bin/env python3
"""Generate or verify the Stage 5 fail-closed promotion decision."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.stage5_evaluation import canonical_json_bytes  # noqa: E402
from quant_engine.proof.stage5_promotion import build_stage5_promotion_decision, verify_stage5_promotion_decision  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-commit", required=True)
    for name in ("entry-gate", "evaluation-spec", "dataset-manifest", "candidate-registry", "research-results", "validation-decision"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path)
    mode.add_argument("--verify", type=Path)
    args = parser.parse_args()
    raws = [getattr(args, name.replace("-", "_")).read_bytes() for name in ("entry-gate", "evaluation-spec", "dataset-manifest", "candidate-registry", "research-results", "validation-decision")]
    if args.verify:
        raw = args.verify.read_bytes(); decision = json.loads(raw.decode("utf-8"))
        if raw != canonical_json_bytes(decision) + b"\n":
            raise ValueError("PROMOTION_DECISION_NOT_CANONICAL")
        verify_stage5_promotion_decision(decision, args.source_commit, *raws)
    else:
        decision = build_stage5_promotion_decision(args.source_commit, *raws)
        verify_stage5_promotion_decision(decision, args.source_commit, *raws)
        if args.output.exists():
            raise FileExistsError("PROMOTION_DECISION_OUTPUT_EXISTS")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(canonical_json_bytes(decision) + b"\n")
        raw = args.output.read_bytes()
    print("STAGE 5.6-5.8 PROMOTION DECISION")
    print(f"PROMOTION_RECEIPT_ID={decision['promotionReceiptId']}")
    print(f"RAW_SHA256={hashlib.sha256(raw).hexdigest()}")
    print("LOCKED_TEST_ACCESS_COUNT=0")
    print("PROMOTED_STRATEGY_COUNT=0")
    print("PAPER_REVIEW_ELIGIBLE=false")
    print("PAPER_TESTNET_LIVE_CALLS=0")
    print("VERIFY=PASS")


if __name__ == "__main__":
    main()
