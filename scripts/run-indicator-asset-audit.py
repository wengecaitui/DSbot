#!/usr/bin/env python3
"""Generate or verify the public, source-free 14-asset readiness artifact."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.asset_manifest import build_asset_manifest, verify_asset_manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-commit", default="LOCAL")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    repo = REPO
    if args.verify:
        manifest = json.loads(args.output.read_text(encoding="utf-8"))
        verify_asset_manifest(repo, manifest, expected_source_commit=args.source_commit)
    else:
        manifest = build_asset_manifest(repo, args.source_commit)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        verify_asset_manifest(repo, manifest, expected_source_commit=args.source_commit)
    counts = manifest["counts"]
    print(f"ASSETS={counts['pineAssetsVerified']} DIRECT={counts['directStrategies']} NEEDS_LIFECYCLE={counts['needsLifecycle']} PURE={counts['pureIndicators']} REAL_WF_READY={counts['realWalkForwardReady']}")
    print(f"PROOF_ID={manifest['proofId']}")


if __name__ == "__main__":
    main()
