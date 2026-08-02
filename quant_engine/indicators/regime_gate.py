"""
quant_engine/indicators/regime_gate.py
SUSA-Inspired Four-State Deterministic Regime Heuristic (arXiv 2607.22491)

IMPORTANT ATTRIBUTION: this is a PROJECT-SPECIFIC DETERMINISTIC HEURISTIC
inspired by SUSA's finding that the same features carry different meaning
across market phases. It is NOT an exact reproduction of the SUSA reservoir
architecture, and the regime labels are not proven realized volatility states.

CONTRACT (mirrors src/strategies/shared/regime-gate.ts):
  - RegimeClassifier (features -> RegimeSnapshot) is decoupled from the
    entry policy (RegimeEntryPolicy -> ALLOW/BLOCK).
  - UNKNOWN is a first-class state (insufficient data, non-finite input,
    timestamp gaps, non-monotonic timestamps, unfinished bar, invalid config).
    When the gate is enabled, UNKNOWN is fail-closed: BLOCK_NEW_ENTRY.
  - The gate may only block NEW entries. It must never block exits, force
    exits, stop losses, risk reductions, or existing position management.
  - Causal boundary: observationEndMs <= decisionTimeMs, final bar closed.

Parameters (same semantics as TS constants):
  window: int (default=20) — rolling window for all features
  stress_dd_threshold: float (default=-0.10)
  onset_dd_threshold: float (default=-0.05)
  max_bar_gap_ms: float (default=300000) — 5 min
"""

import math
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = "regime-snapshot-v1"
POLICY_VERSION = "regime-entry-policy-v1"
THRESHOLD_VERSION = "regime-threshold-v1"
WINDOW = 20
MAX_BAR_GAP_MS = 5 * 60_000
STRESS_DD_THRESHOLD = -0.10
ONSET_DD_THRESHOLD = -0.05
CALM_VOV_TO_LOW_VOL_RATIO = 0.03

# Priority (frozen by parity tests):
#   INVALID/UNKNOWN -> persistent_stress -> onset -> calm -> recovery


def _is_finite(v: Any) -> bool:
    if v is None:
        return False
    try:
        return math.isfinite(float(v))
    except (TypeError, ValueError):
        return False


def _unknown_snapshot(
    decision_time_ms: float,
    reason_code: str,
    observation_start_ms: Optional[float] = None,
    observation_end_ms: Optional[float] = None,
) -> Dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "policyVersion": POLICY_VERSION,
        "valid": False,
        "regime": "UNKNOWN",
        "reasonCode": reason_code,
        "observationStartMs": observation_start_ms,
        "observationEndMs": observation_end_ms,
        "decisionTimeMs": decision_time_ms,
        "featureWindowSize": WINDOW,
        "vol": None,
        "quarticity": None,
        "jumpCount": None,
        "drawdown": None,
        "volOfVol": None,
        "thresholdVersion": THRESHOLD_VERSION,
    }


def _validate_observation(prices: List[Any], close_times_ms: List[Any], decision_time_ms: Any) -> Optional[str]:
    if not isinstance(prices, list) or not isinstance(close_times_ms, list):
        return "invalid_config"
    n = len(prices)
    if n == 0 or len(close_times_ms) != n:
        return "invalid_config"
    if not _is_finite(decision_time_ms):
        return "invalid_config"
    if not _is_finite(close_times_ms[n - 1]) or float(close_times_ms[n - 1]) > float(decision_time_ms):
        return "unfinished_bar"
    for i in range(n):
        if not _is_finite(prices[i]) or not _is_finite(close_times_ms[i]):
            return "non_finite_input"
        if i > 0:
            gap = float(close_times_ms[i]) - float(close_times_ms[i - 1])
            if gap <= 0:
                return "non_monotonic_timestamps"
            if gap > MAX_BAR_GAP_MS:
                return "timestamp_gap"
    if n < WINDOW + 1:
        return "insufficient_data"
    return None


def classify(prices: List[Any], close_times_ms: List[Any], decision_time_ms: Any) -> Dict[str, Any]:
    """Deterministic 4-state classifier. Pure, no side effects, no I/O.

    Mirrors TS classifyRegime() in src/strategies/shared/regime-gate.ts.
    """
    invalid = _validate_observation(prices, close_times_ms, decision_time_ms)
    obs_start = close_times_ms[0] if close_times_ms and _is_finite(close_times_ms[0]) else None
    obs_end = close_times_ms[-1] if close_times_ms and _is_finite(close_times_ms[-1]) else None
    if invalid:
        return _unknown_snapshot(float(decision_time_ms) if _is_finite(decision_time_ms) else 0.0, invalid, obs_start, obs_end)

    n = len(prices)
    rets: List[float] = []
    for i in range(1, n):
        prev = float(prices[i - 1])
        cur = float(prices[i])
        if prev <= 0:
            return _unknown_snapshot(float(decision_time_ms), "non_finite_input", obs_start, obs_end)
        rets.append((cur - prev) / prev)

    if len(rets) < WINDOW:
        return _unknown_snapshot(float(decision_time_ms), "insufficient_data", obs_start, obs_end)

    recent_rets = rets[-WINDOW:]
    mean = sum(recent_rets) / WINDOW
    variance = sum((r - mean) ** 2 for r in recent_rets) / WINDOW
    vol = math.sqrt(variance)

    quarticity = sum(r ** 4 for r in recent_rets) / WINDOW
    jump_count = sum(1 for r in recent_rets if abs(r) > 2 * vol)

    recent_prices = [float(p) for p in prices[-WINDOW:]]
    high = max(recent_prices)
    last_price = recent_prices[-1]
    drawdown = last_price / high - 1.0 if high > 0 else 0.0

    rolling_vols: List[float] = []
    for i in range(WINDOW, len(rets)):
        w = rets[i - WINDOW:i]
        m = sum(w) / WINDOW
        v = sum((r - m) ** 2 for r in w) / WINDOW
        rolling_vols.append(math.sqrt(v))

    vov_mean = sum(rolling_vols) / len(rolling_vols) if rolling_vols else 0.0
    vov_var = sum((v - vov_mean) ** 2 for v in rolling_vols) / len(rolling_vols) if len(rolling_vols) > 1 else 0.0
    vol_of_vol = math.sqrt(vov_var)

    sorted_vol = sorted(rolling_vols)
    if len(sorted_vol) >= 5:
        vol_high = sorted_vol[int(math.floor(len(sorted_vol) * 0.70))]
        vol_low = sorted_vol[int(math.floor(len(sorted_vol) * 0.30))]
    else:
        vol_high = vol * 2.0
        vol_low = vol * 0.5
    vov_low = vol_low * CALM_VOV_TO_LOW_VOL_RATIO

    # ── Deterministic classification with frozen priority ──────────────────
    if vol > vol_high and drawdown < STRESS_DD_THRESHOLD:
        regime = "persistent_stress"
    elif vol > vol_high and drawdown > ONSET_DD_THRESHOLD:
        regime = "onset"
    elif vol <= vol_low and vol_of_vol <= vov_low:
        regime = "calm"
    else:
        regime = "recovery"

    return {
        "schemaVersion": SCHEMA_VERSION,
        "policyVersion": POLICY_VERSION,
        "valid": True,
        "regime": regime,
        "reasonCode": "ok",
        "observationStartMs": obs_start,
        "observationEndMs": obs_end,
        "decisionTimeMs": float(decision_time_ms),
        "featureWindowSize": WINDOW,
        "vol": round(vol, 10),
        "quarticity": round(quarticity, 12),
        "jumpCount": float(jump_count),
        "drawdown": round(drawdown, 10),
        "volOfVol": round(vol_of_vol, 10),
        "thresholdVersion": THRESHOLD_VERSION,
    }


def entry_policy(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """RegimeEntryPolicy — decoupled from the classifier.

    persistent_stress -> BLOCK_NEW_ENTRY
    UNKNOWN           -> BLOCK_NEW_ENTRY (fail-closed)
    all other valid   -> ALLOW_NEW_ENTRY
    """
    if not snapshot.get("valid") or snapshot.get("regime") == "UNKNOWN":
        return {"allow": False, "reasonCode": "blocked_unknown"}
    if snapshot.get("regime") == "persistent_stress":
        return {"allow": False, "reasonCode": "blocked_persistent_stress"}
    return {"allow": True, "reasonCode": "allowed"}


def calculate(df, params: Dict) -> Dict[str, Any]:
    """Daemon-facing entry point. Accepts a pandas DataFrame with
    'close' + 'ts' (or 'timestamp') columns, or raw dict lists.

    Converts OHLC bars into the shared observation contract and returns a
    RegimeSnapshot dict.
    """
    try:
        window = int(params.get("window", WINDOW))
    except (TypeError, ValueError):
        return _unknown_snapshot(0.0, "invalid_config")
    if window != WINDOW:
        return _unknown_snapshot(0.0, "invalid_config")

    # DataFrame path
    if hasattr(df, "columns"):
        if "close" not in df.columns:
            return _unknown_snapshot(0.0, "invalid_config")
        closes = df["close"].tolist()
        if "ts" in df.columns:
            times = df["ts"].tolist()
        elif "timestamp" in df.columns:
            times = df["timestamp"].tolist()
        else:
            # Causal proof requires source timestamps; never fabricate them.
            return _unknown_snapshot(0.0, "invalid_config")
        decision = float(times[-1]) if times else 0.0
        return classify(closes, times, decision)

    # Raw dict path (golden-vector style)
    if isinstance(df, dict):
        prices = df.get("prices") or df.get("close")
        times = df.get("closeTimesMs") or df.get("ts")
        decision = df.get("decisionTimeMs", 0.0)
        if prices is None or times is None:
            return _unknown_snapshot(float(decision) if _is_finite(decision) else 0.0, "invalid_config")
        return classify(prices, times, decision)

    return _unknown_snapshot(0.0, "invalid_config")
