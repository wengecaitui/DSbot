/**
 * Realized Cost-Drag Circuit Breaker — shared pure aggregation module
 *
 * Paper-inspired: arXiv 2607.19453 (Predictive Extrema, Unprofitable
 * Policies) shows that high predictive accuracy does not guarantee tradable
 * profitability — fees/turnover can erase a gross edge. This module is a
 * PROJECT-SPECIFIC FEES_ONLY implementation inspired by that finding. It is
 * NOT an exact reproduction of any algorithm in the paper.
 *
 * Cost model scope: FEES_ONLY — only entry + exit fees are counted. Spread,
 * slippage, market impact and funding are NOT modeled (data not available in
 * this strategy layer). Callers must NOT describe costBps as all-in cost.
 */

export interface TradeCostSample {
  tradeId: string;
  openedAtMs: number;
  closedAtMs: number;
  /** Reference notional (entryPrice * shares) in USD; always > 0. */
  referenceNotionalUsd: number;
  grossPnlUsd: number;
  /** Entry fee + exit fee in USD (FEES_ONLY scope). */
  feeCostUsd: number;
  /** grossPnlUsd - feeCostUsd. */
  netPnlUsd: number;
}

export const COST_MODEL_SCOPE = 'FEES_ONLY' as const;
export type CostModelScope = typeof COST_MODEL_SCOPE;

export type CostHurdleStatus =
  | 'DISABLED'
  | 'WARMING_UP'
  | 'NO_POSITIVE_GROSS'
  | 'OK'
  | 'BLOCKED'
  | 'PROBE_IN_FLIGHT';

export interface CostAggregate {
  sampleCount: number;
  aggregateGrossPnlUsd: number;
  aggregateFeeCostUsd: number;
  aggregateNetPnlUsd: number;
  aggregateNotionalUsd: number;
}

export interface CostAuditMetrics {
  /** Amount-weighted gross return in bps (FEES_ONLY). */
  grossBps: number;
  /** Amount-weighted net return in bps. */
  netBps: number;
  /** Amount-weighted fees in bps (FEES_ONLY). */
  costBps: number;
  /** Fee/gross ratio; null when aggregate gross <= 0. Never NaN/Infinity. */
  costToGrossRatio: number | null;
  costModelScope: CostModelScope;
  costHurdleStatus: CostHurdleStatus;
}

const BPS = 10_000;

/**
 * Amount-weighted aggregation. Never simple averages of per-trade bps.
 *
 *   grossBps = sum(grossPnlUsd) / sum(notional) * 10000
 *   costBps  = sum(feeCostUsd)  / sum(notional) * 10000
 *   netBps   = sum(netPnlUsd)   / sum(notional) * 10000
 *
 * Invariant (verified by tests): netBps ≈ grossBps - costBps within a small
 * floating-point tolerance.
 */
export function aggregateCostSamples(samples: TradeCostSample[]): CostAggregate {
  let aggregateGrossPnlUsd = 0;
  let aggregateFeeCostUsd = 0;
  let aggregateNetPnlUsd = 0;
  let aggregateNotionalUsd = 0;
  for (const s of samples) {
    aggregateGrossPnlUsd += s.grossPnlUsd;
    aggregateFeeCostUsd += s.feeCostUsd;
    aggregateNetPnlUsd += s.netPnlUsd;
    aggregateNotionalUsd += s.referenceNotionalUsd;
  }
  return {
    sampleCount: samples.length,
    aggregateGrossPnlUsd,
    aggregateFeeCostUsd,
    aggregateNetPnlUsd,
    aggregateNotionalUsd,
  };
}

function bps(partUsd: number, notionalUsd: number): number {
  if (!Number.isFinite(partUsd) || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return 0;
  return (partUsd / notionalUsd) * BPS;
}

/**
 * Compute audit metrics for the rolling window.
 *
 * Contract: costToGrossRatio is computed ONLY when aggregateGrossPnlUsd > 0;
 * when gross is zero or negative it is null and the status is
 * NO_POSITIVE_GROSS. Never emits NaN/Infinity/negative ratio.
 */
export function computeCostAuditMetrics(
  samples: TradeCostSample[],
  options: {
    gateEnabled: boolean;
    minCompletedTrades: number;
    probeInFlight: boolean;
    blocked: boolean;
  }
): CostAuditMetrics {
  const agg = aggregateCostSamples(samples);
  const grossBps = bps(agg.aggregateGrossPnlUsd, agg.aggregateNotionalUsd);
  const costBps = bps(agg.aggregateFeeCostUsd, agg.aggregateNotionalUsd);
  const netBps = bps(agg.aggregateNetPnlUsd, agg.aggregateNotionalUsd);

  let costToGrossRatio: number | null = null;
  if (agg.aggregateGrossPnlUsd > 0) {
    costToGrossRatio = agg.aggregateFeeCostUsd / agg.aggregateGrossPnlUsd;
  }

  let costHurdleStatus: CostHurdleStatus;
  if (!options.gateEnabled) {
    costHurdleStatus = 'DISABLED';
  } else if (samples.length < options.minCompletedTrades) {
    costHurdleStatus = 'WARMING_UP';
  } else if (agg.aggregateGrossPnlUsd <= 0) {
    costHurdleStatus = 'NO_POSITIVE_GROSS';
  } else if (options.probeInFlight) {
    costHurdleStatus = 'PROBE_IN_FLIGHT';
  } else if (options.blocked) {
    costHurdleStatus = 'BLOCKED';
  } else {
    costHurdleStatus = 'OK';
  }

  return {
    grossBps,
    netBps,
    costBps,
    costToGrossRatio,
    costModelScope: COST_MODEL_SCOPE,
    costHurdleStatus,
  };
}

/**
 * Validate a single TradeCostSample. Returns an error string or null.
 */
export function validateCostSample(s: TradeCostSample): string | null {
  if (!s || typeof s.tradeId !== 'string' || s.tradeId.length === 0) {
    return 'tradeId must be a non-empty string';
  }
  if (!Number.isFinite(s.openedAtMs) || !Number.isFinite(s.closedAtMs)) {
    return 'timestamps must be finite';
  }
  if (s.closedAtMs < s.openedAtMs) {
    return 'closedAtMs must be >= openedAtMs';
  }
  if (!Number.isFinite(s.referenceNotionalUsd) || s.referenceNotionalUsd <= 0) {
    return 'referenceNotionalUsd must be finite and > 0';
  }
  if (![s.grossPnlUsd, s.feeCostUsd, s.netPnlUsd].every(Number.isFinite)) {
    return 'pnl values must be finite';
  }
  if (Math.abs(s.netPnlUsd - (s.grossPnlUsd - s.feeCostUsd)) > 1e-9) {
    return 'netPnlUsd must equal grossPnlUsd - feeCostUsd';
  }
  return null;
}
