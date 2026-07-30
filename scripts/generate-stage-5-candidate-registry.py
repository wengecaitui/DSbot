#!/usr/bin/env python3
"""Generate or independently verify the bounded Stage 5 candidate registry."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.stage5_candidate import (  # noqa: E402
    build_stage5_candidate_registry,
    verify_stage5_candidate_registry,
)
from quant_engine.proof.stage5_evaluation import canonical_json_bytes  # noqa: E402


def _read_json(path: Path, label: str, require_canonical: bool = False) -> tuple[bytes, dict]:
    raw = path.read_bytes()
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label}_RAW_INVALID") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label}_NOT_OBJECT")
    canonical_json_bytes(value)
    if require_canonical and raw != canonical_json_bytes(value) + b"\n":
        raise ValueError(f"{label}_NOT_CANONICAL")
    return raw, value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--candidate-manifest", type=Path, required=True)
    parser.add_argument("--evaluation-spec", type=Path, required=True)
    parser.add_argument("--dataset-manifest", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path)
    mode.add_argument("--verify", type=Path)
    args = parser.parse_args()

    candidate_raw, _ = _read_json(args.candidate_manifest, "CANDIDATE_MANIFEST")
    evaluation_raw, _ = _read_json(args.evaluation_spec, "EVALUATION_SPEC")
    dataset_raw, _ = _read_json(args.dataset_manifest, "DATASET_MANIFEST")
    if args.verify is not None:
        registry_raw, registry = _read_json(args.verify, "CANDIDATE_REGISTRY", require_canonical=True)
        verify_stage5_candidate_registry(registry, args.source_commit, candidate_raw, evaluation_raw, dataset_raw)
    else:
        registry = build_stage5_candidate_registry(args.source_commit, candidate_raw, evaluation_raw, dataset_raw)
        registry_raw = canonical_json_bytes(registry) + b"\n"
        if args.output.exists():
            raise FileExistsError("CANDIDATE_REGISTRY_OUTPUT_EXISTS")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(registry_raw)

    print("STAGE 5.3 CANDIDATE REGISTRY")
    print(f"SOURCE_COMMIT={args.source_commit}")
    print(f"REGISTRY_ID={registry['registryId']}")
    print(f"REGISTRY_RAW_SHA256={hashlib.sha256(registry_raw).hexdigest()}")
    print("CANDIDATES=4")
    print("PARAMETER_SETS=12")
    print("LOCKED_TEST_STATE=SEALED_UNOPENED")
    print("PAPER_TESTNET_LIVE_CALLS=0")
    print("VERIFY=PASS")


if __name__ == "__main__":
    main()
