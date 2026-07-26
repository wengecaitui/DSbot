"""Explicit, fail-closed OHLCV gap handling."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import Enum
from typing import Any

import pandas as pd


class GapPolicy(str, Enum):
    REJECT = "reject"
    SEGMENT = "segment"


@dataclass(frozen=True)
class Gap:
    previous: str
    current: str
    delta_seconds: int
    missing_bars: int


def dataframe_sha256(frame: pd.DataFrame) -> str:
    normalized = frame[["date", "open", "high", "low", "close", "volume"]].copy()
    normalized["date"] = pd.to_datetime(normalized["date"], utc=True).map(lambda value: value.isoformat())
    payload = normalized.to_dict(orient="records")
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def audit_ohlcv(frame: pd.DataFrame, expected_interval: pd.Timedelta, policy: GapPolicy) -> dict[str, Any]:
    required = ["date", "open", "high", "low", "close", "volume"]
    if list(frame.columns) != required:
        raise ValueError(f"OHLCV_COLUMNS_INVALID:{list(frame.columns)}")
    if expected_interval <= pd.Timedelta(0):
        raise ValueError("EXPECTED_INTERVAL_INVALID")
    if not isinstance(policy, GapPolicy):
        raise ValueError("GAP_POLICY_INVALID")
    if frame.empty:
        raise ValueError("OHLCV_EMPTY")
    if frame[required].isna().any().any():
        raise ValueError("OHLCV_MISSING_VALUE")

    dates = pd.to_datetime(frame["date"], utc=False)
    if dates.dt.tz is None:
        raise ValueError("OHLCV_TIMEZONE_MISSING")
    if dates.duplicated().any():
        raise ValueError("OHLCV_DUPLICATE_TIMESTAMP")
    if not dates.is_monotonic_increasing:
        raise ValueError("OHLCV_NOT_CHRONOLOGICAL")

    numeric = frame[["open", "high", "low", "close", "volume"]].astype(float)
    invalid = (
        (numeric["low"] > numeric[["open", "close"]].min(axis=1))
        | (numeric["high"] < numeric[["open", "close"]].max(axis=1))
        | (numeric["low"] > numeric["high"])
        | (numeric["volume"] < 0)
    )
    if invalid.any():
        raise ValueError(f"OHLCV_ILLEGAL_BAR:{int(invalid.sum())}")

    deltas = dates.diff()
    gaps: list[Gap] = []
    boundaries = [0]
    for location in range(1, len(dates)):
        delta = deltas.iloc[location]
        if delta == expected_interval:
            continue
        missing = max(0, int(delta / expected_interval) - 1)
        gaps.append(Gap(dates.iloc[location - 1].isoformat(), dates.iloc[location].isoformat(), int(delta.total_seconds()), missing))
        boundaries.append(location)
    boundaries.append(len(frame))

    if gaps and policy is GapPolicy.REJECT:
        raise ValueError(f"OHLCV_GAP_REJECTED:{len(gaps)}")

    segments = [
        {"startRow": start, "endRowExclusive": end, "bars": end - start}
        for start, end in zip(boundaries, boundaries[1:])
        if end > start
    ]
    return {
        "schemaVersion": "stage-4a9.ohlcv-audit.v1",
        "gapPolicy": policy.value,
        "rows": len(frame),
        "timezone": str(dates.dt.tz),
        "start": dates.iloc[0].isoformat(),
        "end": dates.iloc[-1].isoformat(),
        "expectedIntervalSeconds": int(expected_interval.total_seconds()),
        "gapCount": len(gaps),
        "missingBars": sum(gap.missing_bars for gap in gaps),
        "gaps": [gap.__dict__ for gap in gaps],
        "segments": segments,
        "dataframeSha256": dataframe_sha256(frame),
    }
