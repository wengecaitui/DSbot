"""Stage 5.2 public market-data audit and leakage-control contracts."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlencode

from quant_engine.proof.stage5_evaluation import canonical_json_bytes, canonical_sha256


SCHEMA_VERSION = "stage-5.dataset-manifest.v1"
EVALUATION_SPEC_RAW_SHA256 = "62bf8ccf9fc18b2818c1d24d05426128092e5dd464760daed89986a947adbc1b"
EVALUATION_SPEC_ID = "8248f250d85a78dca564dad07064748d261ed08465477156783c69ffc00a2cf3"
EVALUATION_SPEC_SOURCE_COMMIT = "913646777a64aa801c7dc263701802249164bf97"
BINANCE_KLINES_ENDPOINT = "https://data-api.binance.vision/api/v3/klines"
INTERVAL_MS = 300_000
ALLOWED_SYMBOLS = ("BNBUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT")
PHASES = {
    "TRAIN": (1_751_414_400_000, 1_775_001_600_000, 78_624),
    "VALIDATION": (1_775_001_600_000, 1_782_864_000_000, 26_208),
    "LOCKED_TEST": (1_782_864_000_000, 1_785_283_200_000, 8_064),
}
_GIT_SHA = re.compile(r"^[a-f0-9]{40}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


def _decimal(value: Any, label: str, *, positive: bool = False) -> Decimal:
    if not isinstance(value, str):
        raise ValueError(f"{label}_MUST_BE_DECIMAL_STRING")
    try:
        parsed = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(f"{label}_INVALID") from error
    if not parsed.is_finite() or (parsed <= 0 if positive else parsed < 0):
        raise ValueError(f"{label}_OUT_OF_RANGE")
    return parsed


def _iso(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _verify_evaluation_spec(raw: bytes) -> Mapping[str, Any]:
    if not isinstance(raw, bytes):
        raise TypeError("EVALUATION_SPEC_RAW_MUST_BE_BYTES")
    if hashlib.sha256(raw).hexdigest() != EVALUATION_SPEC_RAW_SHA256:
        raise ValueError("EVALUATION_SPEC_RAW_SHA256_MISMATCH")
    try:
        spec = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("EVALUATION_SPEC_RAW_INVALID") from error
    if not isinstance(spec, dict):
        raise ValueError("EVALUATION_SPEC_NOT_OBJECT")
    checks = {
        "schemaVersion": "stage-5.evaluation-spec.v1",
        "evaluationSpecId": EVALUATION_SPEC_ID,
        "sourceCommit": EVALUATION_SPEC_SOURCE_COMMIT,
        "status": "FROZEN_BEFORE_DATA_ACCESS",
    }
    if any(spec.get(key) != expected for key, expected in checks.items()):
        raise ValueError("EVALUATION_SPEC_CONTRACT_MISMATCH")
    if spec.get("creationInputs", {}).get("lockedTestAccessCount") != 0:
        raise ValueError("LOCKED_TEST_ALREADY_OPENED")
    if spec.get("universe", {}).get("symbols") != ["BNB/USDT", "BTC/USDT", "ETH/USDT", "SOL/USDT"]:
        raise ValueError("EVALUATION_SPEC_UNIVERSE_MISMATCH")
    safety = spec.get("safety", {})
    if safety.get("paperTestnetLiveCalls") != 0 or any(
        safety.get(key) is not False
        for key in ("activationAuthorized", "runtimeStarted", "paperApproved", "testnetApproved", "liveApproved")
    ):
        raise ValueError("EVALUATION_SPEC_SAFETY_MISMATCH")
    return spec


def audit_ohlcv_rows(
    rows: Sequence[Sequence[Any]],
    symbol: str,
    phase: str,
    start_ms: int,
    end_exclusive_ms: int,
) -> dict[str, Any]:
    if symbol not in ALLOWED_SYMBOLS or phase not in PHASES:
        raise ValueError("DATASET_SCOPE_INVALID")
    if isinstance(start_ms, bool) or isinstance(end_exclusive_ms, bool):
        raise ValueError("DATASET_RANGE_INVALID")
    expected_count = (end_exclusive_ms - start_ms) // INTERVAL_MS
    if start_ms < 0 or end_exclusive_ms <= start_ms or (end_exclusive_ms - start_ms) % INTERVAL_MS:
        raise ValueError("DATASET_RANGE_INVALID")
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes, bytearray)):
        raise ValueError("DATASET_ROWS_INVALID")
    if len(rows) != expected_count:
        raise ValueError("DATASET_ROW_COUNT_MISMATCH")

    normalized: list[list[Any]] = []
    previous: int | None = None
    for index, row in enumerate(rows):
        if not isinstance(row, Sequence) or isinstance(row, (str, bytes, bytearray)) or len(row) != 12:
            raise ValueError("DATASET_KLINE_SHAPE_INVALID")
        open_time = row[0]
        close_time = row[6]
        if isinstance(open_time, bool) or not isinstance(open_time, int):
            raise ValueError("DATASET_OPEN_TIME_INVALID")
        if isinstance(close_time, bool) or not isinstance(close_time, int) or close_time != open_time + INTERVAL_MS - 1:
            raise ValueError("DATASET_CLOSE_TIME_INVALID")
        expected_time = start_ms + index * INTERVAL_MS
        if open_time != expected_time or (previous is not None and open_time <= previous):
            raise ValueError("DATASET_GAP_OR_DUPLICATE")
        previous = open_time

        open_price = _decimal(row[1], "OPEN", positive=True)
        high = _decimal(row[2], "HIGH", positive=True)
        low = _decimal(row[3], "LOW", positive=True)
        close = _decimal(row[4], "CLOSE", positive=True)
        _decimal(row[5], "VOLUME")
        if high < max(open_price, close, low) or low > min(open_price, close, high):
            raise ValueError("DATASET_OHLC_INVALID")
        normalized.append([open_time, row[1], row[2], row[3], row[4], row[5]])

    raw_rows_sha = hashlib.sha256(canonical_json_bytes(rows)).hexdigest()
    normalized_sha = hashlib.sha256(canonical_json_bytes(normalized) + b"\n").hexdigest()
    audit: dict[str, Any] = {
        "symbol": symbol,
        "canonicalSymbol": symbol.removesuffix("USDT") + "/USDT",
        "timeframe": "5m",
        "phase": phase,
        "startInclusive": _iso(start_ms),
        "endExclusive": _iso(end_exclusive_ms),
        "startMs": start_ms,
        "endExclusiveMs": end_exclusive_ms,
        "rowCount": len(rows),
        "expectedRowCount": expected_count,
        "timezone": "UTC",
        "gapPolicy": "reject",
        "duplicatePolicy": "reject",
        "missingBars": 0,
        "duplicateBars": 0,
        "rawRowsSha256": raw_rows_sha,
        "normalizedSha256": normalized_sha,
        "ohlcValid": True,
    }
    audit["datasetId"] = canonical_sha256(audit)
    return audit


def fetch_public_binance_klines(
    symbol: str,
    start_ms: int,
    end_exclusive_ms: int,
    fetch_json: Callable[[str, Mapping[str, Any]], Any],
) -> list[list[Any]]:
    if symbol not in ALLOWED_SYMBOLS:
        raise ValueError("BINANCE_SYMBOL_NOT_ALLOWED")
    if not callable(fetch_json) or isinstance(start_ms, bool) or isinstance(end_exclusive_ms, bool):
        raise ValueError("BINANCE_FETCH_ARGUMENT_INVALID")
    if start_ms < PHASES["TRAIN"][0] or end_exclusive_ms > PHASES["VALIDATION"][1]:
        raise ValueError("LOCKED_TEST_ACCESS_FORBIDDEN")
    if end_exclusive_ms <= start_ms or (end_exclusive_ms - start_ms) % INTERVAL_MS:
        raise ValueError("BINANCE_FETCH_RANGE_INVALID")

    rows: list[list[Any]] = []
    cursor = start_ms
    while cursor < end_exclusive_ms:
        params = {
            "symbol": symbol,
            "interval": "5m",
            "startTime": cursor,
            "endTime": end_exclusive_ms - 1,
            "limit": 1000,
        }
        page = fetch_json(BINANCE_KLINES_ENDPOINT, params)
        if not isinstance(page, list) or not page:
            raise ValueError("BINANCE_KLINES_TRUNCATED")
        for row in page:
            if not isinstance(row, list) or len(row) != 12 or isinstance(row[0], bool) or not isinstance(row[0], int):
                raise ValueError("BINANCE_KLINE_RESPONSE_INVALID")
            if row[0] < cursor or row[0] >= end_exclusive_ms:
                raise ValueError("BINANCE_KLINE_OUT_OF_RANGE")
            if rows and row[0] <= rows[-1][0]:
                raise ValueError("BINANCE_KLINE_OVERLAP")
            rows.append(row)
        next_cursor = rows[-1][0] + INTERVAL_MS
        if next_cursor <= cursor:
            raise ValueError("BINANCE_KLINE_NO_PROGRESS")
        cursor = next_cursor
    if cursor != end_exclusive_ms:
        raise ValueError("BINANCE_KLINES_TRUNCATED")
    return rows


def _verify_audited_dataset(item: Mapping[str, Any]) -> None:
    phase = item.get("phase")
    symbol = item.get("symbol")
    if phase not in ("TRAIN", "VALIDATION") or symbol not in ALLOWED_SYMBOLS:
        raise ValueError("AUDITED_DATASET_SCOPE_INVALID")
    start, end, count = PHASES[str(phase)]
    exact = {
        "timeframe": "5m",
        "startMs": start,
        "endExclusiveMs": end,
        "rowCount": count,
        "expectedRowCount": count,
        "timezone": "UTC",
        "gapPolicy": "reject",
        "duplicatePolicy": "reject",
        "missingBars": 0,
        "duplicateBars": 0,
        "ohlcValid": True,
    }
    if any(item.get(key) != value for key, value in exact.items()):
        raise ValueError("AUDITED_DATASET_CONTRACT_INVALID")
    for key in ("rawRowsSha256", "normalizedSha256", "datasetId"):
        if not _SHA256.fullmatch(str(item.get(key, ""))):
            raise ValueError("AUDITED_DATASET_DIGEST_INVALID")


def build_stage5_dataset_manifest(
    source_commit: str,
    evaluation_spec_raw: bytes,
    audited_datasets: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    if not isinstance(source_commit, str) or not _GIT_SHA.fullmatch(source_commit):
        raise ValueError("DATASET_MANIFEST_SOURCE_COMMIT_INVALID")
    _verify_evaluation_spec(evaluation_spec_raw)
    if not isinstance(audited_datasets, Sequence) or len(audited_datasets) != 8:
        raise ValueError("DATASET_MANIFEST_CARDINALITY_INVALID")
    expected_keys = {(symbol, phase) for symbol in ALLOWED_SYMBOLS for phase in ("TRAIN", "VALIDATION")}
    actual_keys: set[tuple[Any, Any]] = set()
    datasets: list[dict[str, Any]] = []
    for item in audited_datasets:
        if not isinstance(item, Mapping):
            raise ValueError("AUDITED_DATASET_NOT_MAPPING")
        _verify_audited_dataset(item)
        key = (item.get("symbol"), item.get("phase"))
        if key in actual_keys:
            raise ValueError("DATASET_MANIFEST_DUPLICATE")
        actual_keys.add(key)
        datasets.append(json.loads(canonical_json_bytes(item)))
    if actual_keys != expected_keys:
        raise ValueError("DATASET_MANIFEST_MATRIX_INVALID")
    datasets.sort(key=lambda item: (("TRAIN", "VALIDATION").index(item["phase"]), item["symbol"]))

    manifest: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "stage": "STAGE 5.2",
        "status": "TRAIN_VALIDATION_AUDITED_LOCKED_TEST_SEALED",
        "sourceCommit": source_commit,
        "evaluationSpec": {
            "evaluationSpecId": EVALUATION_SPEC_ID,
            "rawSha256": EVALUATION_SPEC_RAW_SHA256,
            "sourceCommit": EVALUATION_SPEC_SOURCE_COMMIT,
        },
        "marketDataSource": {
            "provider": "BINANCE",
            "endpoint": BINANCE_KLINES_ENDPOINT,
            "securityType": "NONE",
            "apiKeyUsed": False,
            "interval": "5m",
            "pageLimit": 1000,
            "requestWeight": 2,
            "dataFilesCommitted": False,
            "privateProofBundle": True,
        },
        "datasets": datasets,
        "splitManifest": {
            "TRAIN": {
                "rawStartInclusive": "2025-07-02T00:00:00Z",
                "rawEndExclusive": "2026-04-01T00:00:00Z",
                "scoredStartInclusive": "2025-07-02T08:20:00Z",
                "scoredEndExclusive": "2026-03-31T16:00:00Z",
            },
            "VALIDATION": {
                "rawStartInclusive": "2026-04-01T00:00:00Z",
                "rawEndExclusive": "2026-07-01T00:00:00Z",
                "scoredStartInclusive": "2026-04-01T08:20:00Z",
                "scoredEndExclusive": "2026-06-30T16:00:00Z",
            },
            "LOCKED_TEST": {
                "rawStartInclusive": "2026-07-01T00:00:00Z",
                "rawEndExclusive": "2026-07-29T00:00:00Z",
                "scoredStartInclusive": "2026-07-01T08:20:00Z",
                "scoredEndExclusive": "2026-07-29T00:00:00Z",
                "expectedRowsPerSymbol": 8064,
                "state": "SEALED_UNOPENED",
                "accessCount": 0,
                "rawRowsSha256": None,
                "normalizedSha256": None,
            },
            "purgeBars": 96,
            "embargoBars": 96,
            "warmupBars": 100,
            "featureLookbackBars": 100,
            "labelHorizonBars": 1,
        },
        "featureAvailabilityContract": {
            "closedBarsOnly": True,
            "decisionUsesBarsThroughCurrentClose": True,
            "executionAtNextOpen": True,
            "highTimeframeIncompleteBarsAllowed": False,
            "fitAcrossSplitsAllowed": False,
            "scalerFitOnTrainOnly": True,
            "futureLabelsAsFeaturesAllowed": False,
        },
        "leakageAudit": {
            "result": "PASS",
            "chronological": True,
            "trainValidationOverlap": False,
            "validationLockedTestOverlap": False,
            "purgeApplied": True,
            "embargoApplied": True,
            "warmupExcludedFromScoring": True,
            "lockedTestUsedForSelection": False,
            "lockedTestAccessCount": 0,
        },
        "safety": {
            "offlineOnly": True,
            "paperTestnetLiveCalls": 0,
            "activationAuthorized": False,
            "runtimeStarted": False,
            "paperApproved": False,
            "testnetApproved": False,
            "liveApproved": False,
        },
    }
    manifest["datasetManifestId"] = canonical_sha256(manifest)
    return manifest


def verify_stage5_dataset_manifest(
    manifest: Mapping[str, Any],
    source_commit: str,
    evaluation_spec_raw: bytes,
) -> None:
    if not isinstance(manifest, Mapping):
        raise ValueError("DATASET_MANIFEST_NOT_MAPPING")
    try:
        datasets = manifest["datasets"]
        expected = build_stage5_dataset_manifest(source_commit, evaluation_spec_raw, datasets)
        actual_bytes = canonical_json_bytes(manifest)
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("DATASET_MANIFEST_INVALID") from error
    if actual_bytes != canonical_json_bytes(expected):
        raise ValueError("DATASET_MANIFEST_MISMATCH")
