// Phase 2: PreTradeRiskGateway — pure deterministic risk admission
import type { GatewayInput, GatewayResult, RiskReasonCode } from './pretrade-risk-types';

function reject(reasonCode: RiskReasonCode): GatewayResult {
  return { decision: 'REJECTED', reasonCode };
}

function admit(input: GatewayInput, approvedPositionUsd: number): GatewayResult {
  return { decision: 'ADMITTED', action: input.action,
    intent: input.intent, approvedPositionUsd };
}

// ─── Validate input ─────────────────────────────────────────────────────────

function validateInput(input: GatewayInput): RiskReasonCode | null {
  const { intent, action, hardRisk } = input;
  if (!intent || typeof intent.intentId !== 'string' || !intent.intentId) return 'INVALID_INPUT';
  if (typeof intent.exchange !== 'string' || !intent.exchange) return 'INVALID_INPUT';
  if (typeof intent.symbol !== 'string' || !intent.symbol) return 'INVALID_INPUT';
  if (intent.direction !== 'long' && intent.direction !== 'short') return 'INVALID_INPUT';
  if (typeof intent.positionUsd !== 'number' || !Number.isFinite(intent.positionUsd) || intent.positionUsd <= 0) return 'INVALID_INPUT';
  if (action !== 'open' && action !== 'reduce' && action !== 'close' && action !== 'emergency_exit') return 'INVALID_INPUT';
  // Boolean gate: non-boolean → REJECTED (never silently disable safety)
  if (typeof hardRisk.locked !== 'boolean' || typeof hardRisk.enabled !== 'boolean') return 'HARD_RISK_CONFIG_INVALID';
  if (hardRisk.locked) return 'KILLSWITCH_LOCKED';
  if (typeof hardRisk.totalCapitalUsd !== 'number' || !Number.isFinite(hardRisk.totalCapitalUsd) || hardRisk.totalCapitalUsd < 0) return 'HARD_RISK_CONFIG_INVALID';
  if (typeof hardRisk.maxSinglePositionPct !== 'number' || !Number.isFinite(hardRisk.maxSinglePositionPct) || hardRisk.maxSinglePositionPct <= 0 || hardRisk.maxSinglePositionPct > 1) return 'HARD_RISK_CONFIG_INVALID';
  if (typeof hardRisk.maxSinglePositionAbsUsd !== 'number' || !Number.isFinite(hardRisk.maxSinglePositionAbsUsd) && hardRisk.maxSinglePositionAbsUsd !== Infinity) return 'HARD_RISK_CONFIG_INVALID';
  if (hardRisk.maxSinglePositionAbsUsd < 0) return 'HARD_RISK_CONFIG_INVALID';
  if (intent.exchange !== hardRisk.exchange) return 'PROVENANCE_MISMATCH';
  return null;
}

function validateMarket(input: GatewayInput): RiskReasonCode | null {
  const ms = input.marketSnapshot;
  if (!ms) return 'MARKET_MISSING';
  if (ms.isStale) return 'MARKET_STALE';
  if (ms.exchange !== input.intent.exchange || ms.symbol !== input.intent.symbol) return 'PROVENANCE_MISMATCH';
  if (!ms.ticker) return 'MARKET_MISSING';
  if (typeof ms.ticker.ticker.last !== 'number' || !Number.isFinite(ms.ticker.ticker.last) || ms.ticker.ticker.last <= 0) return 'MARKET_PRICE_INVALID';
  return null;
}

function validatePosition(input: GatewayInput): RiskReasonCode | null {
  const pr = input.positionResolution;
  if (pr.status === 'missing') return 'POSITION_UNKNOWN';
  const isOpposite = (pr.side === 'long' && input.intent.direction === 'short') || (pr.side === 'short' && input.intent.direction === 'long');
  const isSame = (pr.side === input.intent.direction);
  if (input.action === 'open') {
    if (pr.status === 'flat') return null;
    if (isSame) return null;
    if (isOpposite) return 'ACTION_POSITION_CONFLICT';
    return null;
  }
  if (pr.status !== 'open') return 'ACTION_POSITION_CONFLICT';
  if (!isOpposite) return 'ACTION_POSITION_CONFLICT';
  return null;
}

function validatePolicy(input: GatewayInput): RiskReasonCode | null {
  if (input.action !== 'open') return null;
  const pol = input.policyResolution;
  if (pol.status !== 'active') return 'POLICY_UNAVAILABLE';
  if (!pol.allowNewEntries) return 'POLICY_ENTRIES_BLOCKED';
  if (pol.directionBias === 'bullish' && input.intent.direction === 'short') return 'POLICY_DIRECTION_MISMATCH';
  if (pol.directionBias === 'bearish' && input.intent.direction === 'long') return 'POLICY_DIRECTION_MISMATCH';
  if (typeof pol.maxPositionMultiplier !== 'number' || !Number.isFinite(pol.maxPositionMultiplier) || pol.maxPositionMultiplier < 0 || pol.maxPositionMultiplier > 1) return 'POLICY_UNAVAILABLE';
  return null;
}

// ─── Exposure arithmetic ────────────────────────────────────────────────────

function getMarketPrice(input: GatewayInput): number {
  return input.marketSnapshot!.ticker!.ticker.last;
}

function currentExposureUsd(input: GatewayInput): number {
  const pr = input.positionResolution;
  if (pr.status === 'missing' || pr.status === 'flat') return 0;
  return Math.abs(pr.signedQuantity) * getMarketPrice(input);
}

function hardLimitUsd(input: GatewayInput): number {
  const hr = input.hardRisk;
  if (!hr.enabled) return Infinity;
  return Math.min(hr.totalCapitalUsd * hr.maxSinglePositionPct, hr.maxSinglePositionAbsUsd);
}

function approvedForOpen(input: GatewayInput): number | null {
  const multiplier = Math.min(input.policyResolution.maxPositionMultiplier, 1);
  if (multiplier <= 0) return null;
  const hard = hardLimitUsd(input);
  const limit = hard * multiplier; // Infinity*positive→Infinity, Infinity*0→NaN handled above
  const current = currentExposureUsd(input);
  const available = limit - current; // Infinity - 0 = Infinity (valid)
  // Reject NaN or non-positive finite; accept positive Infinity (unbounded when enabled=false)
  if (!(available > 0)) return null;
  return Math.min(input.intent.positionUsd, available);
}

function approvedForReduce(input: GatewayInput): number {
  return Math.min(input.intent.positionUsd, currentExposureUsd(input));
}

function approvedForClose(input: GatewayInput): number {
  return currentExposureUsd(input);
}

// ─── Main gateway ───────────────────────────────────────────────────────────

export function evaluatePreTradeRisk(input: GatewayInput): GatewayResult {
  const inputErr = validateInput(input);
  if (inputErr) return reject(inputErr);

  const marketErr = validateMarket(input);
  if (marketErr) return reject(marketErr);

  const posErr = validatePosition(input);
  if (posErr) return reject(posErr);

  const polErr = validatePolicy(input);
  if (polErr) return reject(polErr);

  let approvedUsd: number;
  if (input.action === 'open') {
    const a = approvedForOpen(input);
    if (a === null || !Number.isFinite(a) || a <= 0) return reject('POSITION_LIMIT_REACHED');
    approvedUsd = a;
  } else if (input.action === 'reduce') {
    approvedUsd = approvedForReduce(input);
    if (!Number.isFinite(approvedUsd) || approvedUsd <= 0) return reject('POSITION_LIMIT_REACHED');
  } else {
    approvedUsd = approvedForClose(input);
  }

  return admit(input, approvedUsd);
}
