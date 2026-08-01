/**
 * SUSA-Inspired Four-State Deterministic Regime Heuristic — shared module
 *
 * Paper-inspired: arXiv 2607.22491 (SUSA) argues that the SAME features can
 * carry different meaning across market phases and should be interpreted
 * regime-conditionally. This module is a PROJECT-SPECIFIC DETERMINISTIC
 * HEURISTIC inspired by that finding. It is NOT an exact reproduction of the
 * SUSA reservoir architecture, and the regime labels are not proven realized
 * volatility states.
 *
 * Design contract (per hardening spec):
 *   1. RegimeClassifier (features → RegimeSnapshot) is separated from
 *      RegimeEntryPolicy (snapshot → ALLOW/BLOCK). The classifier never
 *      decides policy; the policy never classifies.
 *   2. UNKNOWN is a first-class state, produced on insufficient data,
 *      non-finite inputs, timestamp gaps, non-monotonic timestamps, or
 *      unfinished bars. When the gate is enabled, UNKNOWN is fail-closed:
 *      BLOCK_NEW_ENTRY.
 *   3. The gate may only block NEW entries. It must never block exits,
 *      force exits, stop losses, risk reductions, or existing position
 *      management.
 *   4. All observation data must be causally closed: observationEndMs <=
 *      decisionTimeMs, and the final bar must be closed.
 */

export type RegimeState =
  | 'calm'
  | 'onset'
  | 'recovery'
  | 'persistent_stress'
  | 'UNKNOWN';

export type RegimeReasonCode =
  | 'ok'
  | 'insufficient_data'
  | 'non_finite_input'
  | 'timestamp_gap'
  | 'non_monotonic_timestamps'
  | 'unfinished_bar'
  | 'invalid_config';

export interface RegimeObservation {
  /** Closed-bar prices in chronological order (oldest first). */
  prices: number[];
  /** Bar close timestamps in ms, aligned with prices, strictly increasing. */
  closeTimesMs: number[];
  /** Decision time in ms. Must be >= last close time. */
  decisionTimeMs: number;
}

export interface RegimeSnapshot {
  schemaVersion: string;
  policyVersion: string;
  valid: boolean;
  regime: RegimeState;
  reasonCode: RegimeReasonCode;
  observationStartMs: number | null;
  observationEndMs: number | null;
  decisionTimeMs: number;
  featureWindowSize: number;
  vol: number | null;
  quarticity: number | null;
  jumpCount: number | null;
  drawdown: number | null;
  volOfVol: number | null;
  thresholdVersion: string;
}

export type RegimeEntryDecision =
  | { allow: true; reasonCode: 'allowed' }
  | { allow: false; reasonCode: 'blocked_persistent_stress' | 'blocked_unknown' };

export const REGIME_SCHEMA_VERSION = 'regime-snapshot-v1';
export const REGIME_POLICY_VERSION = 'regime-entry-policy-v1';
export const REGIME_THRESHOLD_VERSION = 'regime-threshold-v1';

/** Default feature window (closed bars). */
export const REGIME_WINDOW = 20;
/** Max allowed gap between consecutive close timestamps (ms). */
export const REGIME_MAX_BAR_GAP_MS = 5 * 60_000;
/** Drawdown below this (e.g. -0.10) + high vol = persistent_stress. */
export const REGIME_STRESS_DD_THRESHOLD = -0.10;
/** Drawdown above this with high vol = onset (trend starting). */
export const REGIME_ONSET_DD_THRESHOLD = -0.05;

export function isFiniteNumber(v: number): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Deterministic 4-state classifier. Pure, no side effects, no I/O.
 *
 * Priority order (frozen by tests):
 *   INVALID/UNKNOWN → persistent_stress → onset → calm → recovery
 *
 * UNKNOWN triggers: insufficient data, non-finite values, timestamp gaps,
 * non-monotonic timestamps, or unfinished bar (last close > decision time).
 */
export function classifyRegime(obs: RegimeObservation): RegimeSnapshot {
  const featureWindowSize = REGIME_WINDOW;

  // ── Structural validation → UNKNOWN ─────────────────────────────────────
  const invalidReason = validateObservation(obs);
  if (invalidReason) {
    return unknownSnapshot(obs, invalidReason);
  }

  const { prices } = obs;
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    if (!isFiniteNumber(prev) || !isFiniteNumber(prices[i])) {
      return unknownSnapshot(obs, 'non_finite_input');
    }
    if (prev <= 0) {
      return unknownSnapshot(obs, 'non_finite_input');
    }
    rets.push((prices[i] - prev) / prev);
  }

  if (rets.length < featureWindowSize) {
    return unknownSnapshot(obs, 'insufficient_data');
  }

  const recentRets = rets.slice(-featureWindowSize);

  // Feature 1: trailing vol (std of returns over window)
  const mean = recentRets.reduce((a, b) => a + b, 0) / recentRets.length;
  const variance = recentRets.reduce((s, r) => s + (r - mean) ** 2, 0) / recentRets.length;
  const vol = Math.sqrt(variance);

  // Feature 2: quarticity (4th moment of returns)
  const quarticity = recentRets.reduce((s, r) => s + r ** 4, 0) / recentRets.length;

  // Feature 3: jump count (|ret| > 2σ within window)
  const jumpCount = recentRets.filter((r) => Math.abs(r) > 2 * vol).length;

  // Feature 4: drawdown from window high
  const recentPrices = prices.slice(-featureWindowSize);
  const high = Math.max(...recentPrices);
  const lastPrice = recentPrices[recentPrices.length - 1];
  const drawdown = high > 0 ? lastPrice / high - 1.0 : 0;

  // Feature 5: vol-of-vol (std of rolling vol over full history)
  const rollingVols: number[] = [];
  for (let i = featureWindowSize; i < rets.length; i++) {
    const w = rets.slice(i - featureWindowSize, i);
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const v = w.reduce((s, r) => s + (r - m) ** 2, 0) / w.length;
    rollingVols.push(Math.sqrt(v));
  }
  const volOfVolMean = rollingVols.length > 0
    ? rollingVols.reduce((a, b) => a + b, 0) / rollingVols.length
    : 0;
  const volOfVolVar = rollingVols.length > 1
    ? rollingVols.reduce((s, v) => s + (v - volOfVolMean) ** 2, 0) / rollingVols.length
    : 0;
  const volOfVol = Math.sqrt(volOfVolVar);

  // Percentile thresholds from rolling vol distribution (70th / 30th)
  const sortedVol = [...rollingVols].sort((a, b) => a - b);
  const volHigh = sortedVol.length >= 5
    ? sortedVol[Math.floor(sortedVol.length * 0.70)]
    : vol * 2.0;
  const volLow = sortedVol.length >= 5
    ? sortedVol[Math.floor(sortedVol.length * 0.30)]
    : vol * 0.5;
  const vovHigh = volOfVol * 1.5;

  if (![vol, quarticity, jumpCount, drawdown, volOfVol].every(isFiniteNumber)) {
    return unknownSnapshot(obs, 'non_finite_input');
  }

  // ── Deterministic classification with frozen priority ───────────────────
  let regime: RegimeState;
  // 1. persistent_stress: high vol + significant drawdown
  if (vol > volHigh && drawdown < REGIME_STRESS_DD_THRESHOLD) {
    regime = 'persistent_stress';
  }
  // 2. onset: high vol but no deep drawdown yet (trend starting)
  else if (vol > volHigh && drawdown > REGIME_ONSET_DD_THRESHOLD) {
    regime = 'onset';
  }
  // 3. calm: low vol + low vol-of-vol (flat market)
  else if (vol < volLow && volOfVol < vovHigh * 0.3) {
    regime = 'calm';
  }
  // 4. recovery: everything else
  else {
    regime = 'recovery';
  }

  const observationStartMs = obs.closeTimesMs[0];
  const observationEndMs = obs.closeTimesMs[obs.closeTimesMs.length - 1];

  return {
    schemaVersion: REGIME_SCHEMA_VERSION,
    policyVersion: REGIME_POLICY_VERSION,
    valid: true,
    regime,
    reasonCode: 'ok',
    observationStartMs,
    observationEndMs,
    decisionTimeMs: obs.decisionTimeMs,
    featureWindowSize,
    vol,
    quarticity,
    jumpCount,
    drawdown,
    volOfVol,
    thresholdVersion: REGIME_THRESHOLD_VERSION,
  };
}

/**
 * Entry policy — fully decoupled from the classifier.
 *
 * persistent_stress → BLOCK_NEW_ENTRY
 * UNKNOWN           → BLOCK_NEW_ENTRY (fail-closed)
 * all other valid   → ALLOW_NEW_ENTRY
 */
export function evaluateRegimeEntryPolicy(snapshot: RegimeSnapshot): RegimeEntryDecision {
  if (!snapshot.valid || snapshot.regime === 'UNKNOWN') {
    return { allow: false, reasonCode: 'blocked_unknown' };
  }
  if (snapshot.regime === 'persistent_stress') {
    return { allow: false, reasonCode: 'blocked_persistent_stress' };
  }
  return { allow: true, reasonCode: 'allowed' };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function validateObservation(obs: RegimeObservation): RegimeReasonCode | null {
  if (!obs || !Array.isArray(obs.prices) || !Array.isArray(obs.closeTimesMs)) {
    return 'invalid_config';
  }
  const n = obs.prices.length;
  if (n === 0 || obs.closeTimesMs.length !== n) {
    return 'invalid_config';
  }
  if (!isFiniteNumber(obs.decisionTimeMs)) {
    return 'invalid_config';
  }
  // Causal boundary: last close must be <= decision time (final bar closed).
  const lastClose = obs.closeTimesMs[n - 1];
  if (!isFiniteNumber(lastClose) || lastClose > obs.decisionTimeMs) {
    return 'unfinished_bar';
  }
  for (let i = 0; i < n; i++) {
    if (!isFiniteNumber(obs.prices[i]) || !isFiniteNumber(obs.closeTimesMs[i])) {
      return 'non_finite_input';
    }
    if (i > 0) {
      const gap = obs.closeTimesMs[i] - obs.closeTimesMs[i - 1];
      if (gap <= 0) {
        return 'non_monotonic_timestamps';
      }
      if (gap > REGIME_MAX_BAR_GAP_MS) {
        return 'timestamp_gap';
      }
    }
  }
  if (n < REGIME_WINDOW + 1) {
    return 'insufficient_data';
  }
  return null;
}

function unknownSnapshot(
  obs: RegimeObservation,
  reasonCode: RegimeReasonCode
): RegimeSnapshot {
  const observationStartMs = obs && Array.isArray(obs.closeTimesMs) && obs.closeTimesMs.length > 0
    ? obs.closeTimesMs[0]
    : null;
  const observationEndMs = obs && Array.isArray(obs.closeTimesMs) && obs.closeTimesMs.length > 0
    ? obs.closeTimesMs[obs.closeTimesMs.length - 1]
    : null;
  return {
    schemaVersion: REGIME_SCHEMA_VERSION,
    policyVersion: REGIME_POLICY_VERSION,
    valid: false,
    regime: 'UNKNOWN',
    reasonCode,
    observationStartMs,
    observationEndMs,
    decisionTimeMs: obs ? obs.decisionTimeMs : 0,
    featureWindowSize: REGIME_WINDOW,
    vol: null,
    quarticity: null,
    jumpCount: null,
    drawdown: null,
    volOfVol: null,
    thresholdVersion: REGIME_THRESHOLD_VERSION,
  };
}
