#!/usr/bin/env python3
"""Generate or verify the public Stage 4A12 candidate manifest."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.asset_manifest import build_asset_manifest
from quant_engine.proof.strategy_spec import build_candidate_manifest, verify_candidate_manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    assets = build_asset_manifest(REPO, args.source_commit)
    if args.verify:
        manifest = json.loads(args.output.read_text(encoding="utf-8"))
        verify_candidate_manifest(assets, manifest, args.source_commit)
    else:
        manifest = build_candidate_manifest(assets, args.source_commit)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        verify_candidate_manifest(assets, manifest, args.source_commit)
    print(f"CANDIDATES={manifest['candidateCount']} MANIFEST_ID={manifest['manifestId']} BLOCKED_LIFECYCLE=4 TRADEIQ_HOLDOUT_REUSED=false")


if __name__ == "__main__":
    main()
