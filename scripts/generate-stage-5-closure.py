#!/usr/bin/env python3
"""Generate or verify the Stage 5.9 closure — deterministic final seal over all Stage 5 artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.stage5_closure import build_stage5_closure, verify_stage5_closure  # noqa: E402
from quant_engine.proof.stage5_evaluation import canonical_json_bytes  # noqa: E402


INPUT_NAMES = (
    "entry-gate",
    "evaluation-spec",
    "dataset-manifest",
    "candidate-registry",
    "research-results",
    "validation-decision",
    "promotion-decision",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--final-target-sha", required=True)
    for name in INPUT_NAMES:
        parser.add_argument(f"--{name}", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path)
    mode.add_argument("--verify", type=Path)
    args = parser.parse_args()

    raws = [
        getattr(args, name.replace("-", "_")).read_bytes()
        for name in INPUT_NAMES
    ]

    if args.verify:
        raw = args.verify.read_bytes()
        decision = json.loads(raw.decode("utf-8"))
        if raw != canonical_json_bytes(decision) + b"\n":
            raise ValueError("CLOSURE_NOT_CANONICAL")
        verify_stage5_closure(decision, *raws, args.source_commit, args.final_target_sha)
    else:
        decision = build_stage5_closure(*raws, args.source_commit, args.final_target_sha)
        verify_stage5_closure(decision, *raws, args.source_commit, args.final_target_sha)
        if args.output.exists():
            raise FileExistsError("CLOSURE_OUTPUT_EXISTS")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(canonical_json_bytes(decision) + b"\n")
        raw = args.output.read_bytes()

    print("STAGE 5.9 CLOSURE")
    print(f"CLOSURE_ID={decision['closureId']}")
    print(f"RAW_SHA256={hashlib.sha256(raw).hexdigest()}")
    print(f"STATUS={decision['status']}")
    print("PROMOTED_STRATEGY_COUNT=0")
    print("PROMOTED_STRATEGY_ID=null")
    print("PAPER_REVIEW_ELIGIBLE=false")
    print("PAPER_TESTNET_LIVE_CALLS=0")
    print("LOCKED_TEST_ACCESS_COUNT=0")
    print("VERIFY=PASS")


if __name__ == "__main__":
    main()
