#!/usr/bin/env python3
"""Generate the deterministic Stage 5.1 evaluation constitution artifact."""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.stage5_evaluation import (  # noqa: E402
    build_stage5_evaluation_spec,
    canonical_json_bytes,
    verify_stage5_evaluation_spec,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--entry-gate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    entry_raw = args.entry_gate.read_bytes()
    spec = build_stage5_evaluation_spec(args.source_commit, entry_raw)
    verify_stage5_evaluation_spec(spec, args.source_commit, entry_raw)
    output_bytes = canonical_json_bytes(spec) + b"\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("xb") as handle:
        handle.write(output_bytes)

    output_digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    print("STAGE 5.1 EVALUATION CONSTITUTION")
    print("STATUS=FROZEN_BEFORE_DATA_ACCESS")
    print(f"SOURCE_COMMIT={args.source_commit}")
    print(f"EVALUATION_SPEC_ID={spec['evaluationSpecId']}")
    print(f"OUTPUT_SHA256={output_digest}")
    print("LOCKED_TEST_OPENED=false")
    print("LOCKED_TEST_ACCESS_COUNT=0")
    print("ACTIVATION_AUTHORIZED=false")
    print("RUNTIME_STARTED=false")
    print("PAPER_APPROVED=false")
    print("TESTNET_APPROVED=false")
    print("LIVE_APPROVED=false")
    print("PAPER_TESTNET_LIVE_CALLS=0")
    print("VERIFY=PASS")


if __name__ == "__main__":
    main()
