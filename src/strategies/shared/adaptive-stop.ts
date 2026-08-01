/**
 * Price-Level Adaptive Initial Stop — shared pure module
 *
 * Paper-inspired: arXiv 2602.11708 (AdaptiveTrend) demonstrates that a
 * volatility-regime-calibrated stop improves risk-adjusted returns in crypto
 * trend-following. This module is a PROJECT-SPECIFIC ADAPTATION for binary
 * markets: entry-price distance from 0.50 is used as an uncertainty proxy,
 * NOT measured ATR and NOT verified realized volatility.
 *
 * Important attribution note:
 *   This is NOT an exact reproduction of AdaptiveTrend's dynamic trailing
 *   stop. It is a binary-market heuristic inspired by the paper's finding
 *   that stop distance should widen with uncertainty and tighten when the
 *   market is stable.
 *
 * Single authoritative implementation — both crypto-hft and hft-divergence
 * strategies MUST call this module. No duplicated formulas elsewhere.
 */

export type AdaptiveStopRegime = 'ATM' | 'MID' | 'EDGE';

export interface AdaptiveStopInput {
  /** Binary option entry price, expected in [0, 1] (probability space). */
  entryPrice: number;
  /** Base stop loss % before volatility adjustment (e.g. 12). */
  baseStopLossPct: number;
  /** k multiplier in the ATM (high-uncertainty) zone. */
  highK: number;
  /** k multiplier in the MID zone (baseline). */
  normalK: number;
  /** k multiplier in the EDGE (low-uncertainty) zone. */
  lowK: number;
  /** Cap on effective stop as a multiple of baseStopLossPct (e.g. 1.5). */
  maxMultiplier: number;
}

export interface AdaptiveStopResult {
  /** Effective stop loss % (>= 0), capped at baseStopLossPct * maxMultiplier. */
  effectiveStopLossPct: number;
  /** Which distance zone the entry price fell into. */
  regime: AdaptiveStopRegime;
  /** The k multiplier selected for this entry. */
  multiplierK: number;
  /** Immutable policy version for frozen-at-entry accounting. */
  policyVersion: string;
}

export const ADAPTIVE_STOP_POLICY_VERSION = 'adaptive-stop-v1';

/**
 * Frozen price-zone boundaries (symmetric around 0.50):
 *
 *   distanceFromAtm = abs(entryPrice - 0.50)
 *
 *   distance <= 0.15          → ATM   → k = highK
 *   0.15 < distance <= 0.25   → MID   → k = normalK
 *   distance > 0.25           → EDGE  → k = lowK
 *
 * Exact boundaries therefore are:
 *   0.35 and 0.65 are ATM; 0.25 and 0.75 are MID;
 *   below 0.25 or above 0.75 is EDGE.
 */
export const ADAPTIVE_STOP_ATM_DISTANCE = 0.15;
export const ADAPTIVE_STOP_MID_DISTANCE = 0.25;

function isFiniteNumber(v: number): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Compute the effective initial stop loss % for a binary-option entry.
 *
 * Validation contract: all invalid inputs throw. Invalid values MUST NOT
 * silently fall back to a fixed stop loss.
 *
 * @throws Error with a descriptive message on any invalid input.
 */
export function computeAdaptiveStop(input: AdaptiveStopInput): AdaptiveStopResult {
  const {
    entryPrice,
    baseStopLossPct,
    highK,
    normalK,
    lowK,
    maxMultiplier,
  } = input;

  // ── Input validation (fail closed, no silent fallback) ──────────────────
  if (!isFiniteNumber(entryPrice)) {
    throw new Error(`adaptiveStop: entryPrice must be finite, got ${entryPrice}`);
  }
  if (entryPrice < 0 || entryPrice > 1) {
    throw new Error(`adaptiveStop: entryPrice must be in [0,1], got ${entryPrice}`);
  }
  if (!isFiniteNumber(baseStopLossPct) || baseStopLossPct <= 0) {
    throw new Error(`adaptiveStop: baseStopLossPct must be finite and > 0, got ${baseStopLossPct}`);
  }
  if (!isFiniteNumber(highK) || highK <= 0) {
    throw new Error(`adaptiveStop: highK must be finite and > 0, got ${highK}`);
  }
  if (!isFiniteNumber(normalK) || normalK <= 0) {
    throw new Error(`adaptiveStop: normalK must be finite and > 0, got ${normalK}`);
  }
  if (!isFiniteNumber(lowK) || lowK <= 0) {
    throw new Error(`adaptiveStop: lowK must be finite and > 0, got ${lowK}`);
  }
  if (!isFiniteNumber(maxMultiplier) || maxMultiplier <= 0) {
    throw new Error(`adaptiveStop: maxMultiplier must be finite and > 0, got ${maxMultiplier}`);
  }

  // ── Zone selection (use "cents" to avoid FP boundary issues) ────────────
  // entryPrice * 100 maps [0,1] → [0,100]; distance in cents is exact.
  const distFrom50 = Math.abs(entryPrice * 100 - 50);

  let regime: AdaptiveStopRegime;
  let multiplierK: number;

  if (distFrom50 <= 15) {                        // entry ∈ [0.35, 0.65]
    regime = 'ATM';
    multiplierK = highK;
  } else if (distFrom50 <= 25) {                 // entry ∈ [0.25,0.35) ∪ (0.65,0.75]
    regime = 'MID';
    multiplierK = normalK;
  } else {                                       // entry < 0.25 or > 0.75
    regime = 'EDGE';
    multiplierK = lowK;
  }

  // ── Effective stop ───────────────────────────────────────────────────────
  // rawEffectiveStopPct = baseStopLossPct * (k / normalK)
  // effectiveStopPct    = min(rawEffectiveStopPct, baseStopLossPct * maxMultiplier)
  const rawEffectiveStopPct = baseStopLossPct * (multiplierK / normalK);
  const effectiveStopLossPct = Math.min(rawEffectiveStopPct, baseStopLossPct * maxMultiplier);

  return {
    effectiveStopLossPct,
    regime,
    multiplierK,
    policyVersion: ADAPTIVE_STOP_POLICY_VERSION,
  };
}
