// Phase 2: PreTradeRiskGateway — pure deterministic risk admission
import { isExchangeId } from '../data/MarketIdentity';
import type { GatewayInput, GatewayResult, RiskReasonCode } from './pretrade-risk-types';

function reject(reasonCode: RiskReasonCode): GatewayResult {
  return { decision: 'REJECTED', reasonCode };
}

function admit(input: GatewayInput, approvedPositionUsd: number): GatewayResult {
  return { decision: 'ADMITTED', action: input.action,
    intent: input.intent, approvedPositionUsd };
}

// ─── Validate ────────────────────────────────────────────────────────────────

function validateInput(input: GatewayInput): RiskReasonCode | null {
  const { intent, action, hardRisk } = input;
  if (!intent || typeof intent.intentId !== 'string' || !intent.intentId) return 'INVALID_INPUT';
  if (!isExchangeId(intent.exchange)) return 'INVALID_INPUT';
  if (typeof intent.symbol !== 'string' || !intent.symbol) return 'INVALID_INPUT';
  if (intent.direction !== 'long' && intent.direction !== 'short') return 'INVALID_INPUT';
  if (typeof intent.positionUsd !== 'number' || !Number.isFinite(intent.positionUsd) || intent.positionUsd <= 0) return 'INVALID_INPUT';
  if (action !== 'open' && action !== 'reduce' && action !== 'close' && action !== 'emergency_exit') return 'INVALID_INPUT';
  if (typeof hardRisk.locked !== 'boolean' || typeof hardRisk.enabled !== 'boolean') return 'HARD_RISK_CONFIG_INVALID';
  if (hardRisk.locked) return 'KILLSWITCH_LOCKED';
  if (typeof hardRisk.totalCapitalUsd !== 'number' || !Number.isFinite(hardRisk.totalCapitalUsd) || hardRisk.totalCapitalUsd < 0) return 'HARD_RISK_CONFIG_INVALID';
  if (typeof hardRisk.maxSinglePositionPct !== 'number' || !Number.isFinite(hardRisk.maxSinglePositionPct) || hardRisk.maxSinglePositionPct <= 0 || hardRisk.maxSinglePositionPct > 1) return 'HARD_RISK_CONFIG_INVALID';
  if (typeof hardRisk.maxSinglePositionAbsUsd !== 'number' || (!Number.isFinite(hardRisk.maxSinglePositionAbsUsd) && hardRisk.maxSinglePositionAbsUsd !== Infinity)) return 'HARD_RISK_CONFIG_INVALID';
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

// ─── Arithmetic ─────────────────────────────────────────────────────────────

function getMarketPrice(input: GatewayInput): number {
  return input.marketSnapshot!.ticker!.ticker.last;
}

function currentExposureUsd(input: GatewayInput): number {
  const pr = input.positionResolution;
  if (pr.status === 'missing' || pr.status === 'flat') return 0;
  if (typeof pr.signedQuantity !== 'number' || !Number.isFinite(pr.signedQuantity)) return NaN;
  return Math.abs(pr.signedQuantity) * getMarketPrice(input);
}

function hardLimitUsd(input: GatewayInput): number {
  const hr = input.hardRisk;
  if (!hr.enabled) return Infinity;
  return Math.min(hr.totalCapitalUsd * hr.maxSinglePositionPct, hr.maxSinglePositionAbsUsd);
}

function computeApproved(input: GatewayInput): number | null {
  if (input.action === 'open') {
    const multiplier = Math.min(input.policyResolution.maxPositionMultiplier, 1);
    if (multiplier <= 0) return null;
    const hard = hardLimitUsd(input);
    const limit = hard * multiplier;
    const current = currentExposureUsd(input);
    if (!Number.isFinite(current)) return null;
    const available = limit - current;
    if (!(available > 0)) return null;
    return Math.min(input.intent.positionUsd, available);
  }
  if (input.action === 'reduce') {
    const current = currentExposureUsd(input);
    if (!Number.isFinite(current)) return null;
    return Math.min(input.intent.positionUsd, current);
  }
  // close / emergency_exit
  const current = currentExposureUsd(input);
  if (!Number.isFinite(current)) return null;
  return current;
}

// ─── Universal finite admission check ───────────────────────────────────────

function isFinitePositiveApproved(approved: number): boolean {
  return Number.isFinite(approved) && approved > 0;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export function evaluatePreTradeRisk(input: GatewayInput): GatewayResult {
  const inputErr = validateInput(input);
  if (inputErr) return reject(inputErr);

  const marketErr = validateMarket(input);
  if (marketErr) return reject(marketErr);

  const posErr = validatePosition(input);
  if (posErr) return reject(posErr);

  const polErr = validatePolicy(input);
  if (polErr) return reject(polErr);

  const approved = computeApproved(input);
  if (approved === null || !isFinitePositiveApproved(approved)) return reject('POSITION_LIMIT_REACHED');

  return admit(input, approved);
}
