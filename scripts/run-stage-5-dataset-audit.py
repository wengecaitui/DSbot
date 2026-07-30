#!/usr/bin/env python3
"""Fetch/audit Stage 5 TRAIN and VALIDATION market data, or verify its receipt.

Raw rows are written only to an explicit directory outside the repository.
The LOCKED_TEST range is intentionally unreachable from this command.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.stage5_dataset import (  # noqa: E402
    ALLOWED_SYMBOLS,
    PHASES,
    audit_ohlcv_rows,
    build_stage5_dataset_manifest,
    fetch_public_binance_klines,
    verify_stage5_dataset_manifest,
)
from quant_engine.proof.stage5_evaluation import canonical_json_bytes  # noqa: E402


def _inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_private_output_dir(path: Path) -> Path:
    resolved = path.resolve()
    if _inside(resolved, REPO.resolve()):
        raise ValueError("PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY")
    return resolved


def _fetch_json(url: str, params: Mapping[str, Any]) -> Any:
    request_url = f"{url}?{urlencode(params)}"
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            with urlopen(request_url, timeout=30) as response:  # noqa: S310 - frozen public HTTPS endpoint
                if response.status != 200:
                    raise ValueError(f"BINANCE_HTTP_STATUS_{response.status}")
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            if isinstance(error, HTTPError) and error.code < 500 and error.code != 429:
                break
            if attempt < 4:
                time.sleep(2**attempt)
    raise RuntimeError("BINANCE_PUBLIC_DATA_FETCH_FAILED") from last_error


def _write_exclusive(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(payload)


def _read_canonical_rows(path: Path) -> list[list[Any]]:
    raw = path.read_bytes()
    try:
        rows = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("PRIVATE_ROWS_INVALID") from error
    if raw != canonical_json_bytes(rows) + b"\n" or not isinstance(rows, list):
        raise ValueError("PRIVATE_ROWS_NOT_CANONICAL")
    return rows


def verify_existing(manifest_path: Path, source_commit: str, evaluation_raw: bytes) -> dict[str, Any]:
    raw = manifest_path.read_bytes()
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("DATASET_MANIFEST_RAW_INVALID") from error
    if raw != canonical_json_bytes(manifest) + b"\n":
        raise ValueError("DATASET_MANIFEST_NOT_CANONICAL")
    verify_stage5_dataset_manifest(manifest, source_commit, evaluation_raw)
    return manifest


def generate(
    source_commit: str,
    evaluation_raw: bytes,
    private_output_dir: Path,
    manifest_output: Path,
) -> dict[str, Any]:
    private_dir = validate_private_output_dir(private_output_dir)
    audits = []
    for phase in ("TRAIN", "VALIDATION"):
        start_ms, end_ms, _ = PHASES[phase]
        for symbol in ALLOWED_SYMBOLS:
            private_path = private_dir / phase.lower() / f"{symbol}-5m.json"
            if private_path.exists():
                rows = _read_canonical_rows(private_path)
            else:
                rows = fetch_public_binance_klines(symbol, start_ms, end_ms, _fetch_json)
                _write_exclusive(private_path, canonical_json_bytes(rows) + b"\n")
            audit = audit_ohlcv_rows(rows, symbol, phase, start_ms, end_ms)
            audits.append(audit)
    manifest = build_stage5_dataset_manifest(source_commit, evaluation_raw, audits)
    verify_stage5_dataset_manifest(manifest, source_commit, evaluation_raw)
    _write_exclusive(manifest_output, canonical_json_bytes(manifest) + b"\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--evaluation-spec", type=Path, required=True)
    parser.add_argument("--private-output-dir", type=Path)
    parser.add_argument("--manifest-output", type=Path)
    parser.add_argument("--verify-manifest", type=Path)
    args = parser.parse_args()

    evaluation_raw = args.evaluation_spec.read_bytes()
    if args.verify_manifest is not None:
        if args.private_output_dir is not None or args.manifest_output is not None:
            parser.error("verify mode cannot fetch or write data")
        manifest = verify_existing(args.verify_manifest, args.source_commit, evaluation_raw)
    else:
        if args.private_output_dir is None or args.manifest_output is None:
            parser.error("generation requires --private-output-dir and --manifest-output")
        manifest = generate(
            args.source_commit,
            evaluation_raw,
            args.private_output_dir,
            args.manifest_output,
        )

    print("STAGE 5.2 DATASET AND LEAKAGE CONTROL")
    print(f"SOURCE_COMMIT={args.source_commit}")
    print(f"DATASET_MANIFEST_ID={manifest['datasetManifestId']}")
    manifest_digest = hashlib.sha256(canonical_json_bytes(manifest) + bytes([10])).hexdigest()
    print(f"MANIFEST_SHA256={manifest_digest}")
    print("TRAIN_VALIDATION_DATASETS=8")
    print("LEAKAGE_AUDIT=PASS")
    print("LOCKED_TEST_STATE=SEALED_UNOPENED")
    print("LOCKED_TEST_ACCESS_COUNT=0")
    print("PAPER_TESTNET_LIVE_CALLS=0")
    print("VERIFY=PASS")


if __name__ == "__main__":
    main()
