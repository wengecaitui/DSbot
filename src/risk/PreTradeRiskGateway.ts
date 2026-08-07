// Phase 2: PreTradeRiskGateway — pure deterministic risk admission
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { GatewayInput, GatewayResult, RiskReasonCode, MarketSnapshot } from './pretrade-risk-types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function reject(reasonCode: RiskReasonCode): GatewayResult {
  return { decision: 'REJECTED', reasonCode };
}

function admit(action: GatewayInput['action'], intent: GatewayInput['intent'], approvedPositionUsd: number): GatewayResult {
  return { decision: 'ADMITTED', action,
    intent: { intentId: intent.intentId, exchange: intent.exchange, symbol: intent.symbol,
      direction: intent.direction, positionUsd: approvedPositionUsd },
    approvedPositionUsd };
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateInput(input: GatewayInput): RiskReasonCode | null {
  const { intent, action, hardRisk, marketSnapshot, positionResolution, policyResolution } = input;
  if (!intent || typeof intent.intentId !== 'string' || !intent.intentId) return 'INVALID_INPUT';
  if (!isExchangeId(intent.exchange as string)) return 'INVALID_INPUT';
  if (typeof intent.symbol !== 'string' || !intent.symbol) return 'INVALID_INPUT';
  if (intent.direction !== 'long' && intent.direction !== 'short') return 'INVALID_INPUT';
  if (typeof intent.positionUsd !== 'number' || !Number.isFinite(intent.positionUsd) || intent.positionUsd <= 0) return 'INVALID_INPUT';
  if (action !== 'open' && action !== 'reduce' && action !== 'close' && action !== 'emergency_exit') return 'INVALID_INPUT';
  if (hardRisk.locked) return 'KILLSWITCH_LOCKED';
  if (typeof hardRisk.totalCapitalUsd !== 'number' || !Number.isFinite(hardRisk.totalCapitalUsd) || hardRisk.totalCapitalUsd < 0) return 'HARD_RISK_CONFIG_INVALID';
  if (typeof hardRisk.maxSinglePositionPct !== 'number' || !Number.isFinite(hardRisk.maxSinglePositionPct) || hardRisk.maxSinglePositionPct <= 0 || hardRisk.maxSinglePositionPct > 1) return 'HARD_RISK_CONFIG_INVALID';
  if (typeof hardRisk.maxSinglePositionAbsUsd !== 'number' || !Number.isFinite(hardRisk.maxSinglePositionAbsUsd) || hardRisk.maxSinglePositionAbsUsd < 0) return 'HARD_RISK_CONFIG_INVALID';
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
    if (pr.status === 'flat') return null; // all good
    if (isSame) return null; // scale-in
    if (isOpposite) return 'ACTION_POSITION_CONFLICT'; // opposite open → potential reduce/flip, but action is 'open'
    return null;
  }
  // reduce/close/emergency_exit
  if (pr.status !== 'open') return 'ACTION_POSITION_CONFLICT'; // nothing to reduce/close
  if (!isOpposite) return 'ACTION_POSITION_CONFLICT'; // reduce/close must be opposite direction
  return null;
}

function validatePolicy(input: GatewayInput): RiskReasonCode | null {
  if (input.action !== 'open') return null; // Policy only gates risk-increasing opens
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

function effectiveLimitUsd(input: GatewayInput): number {
  const hard = hardLimitUsd(input);
  if (input.action !== 'open') return hard; // protective actions ignore policy
  const multiplier = Math.min(input.policyResolution.maxPositionMultiplier, 1);
  return hard * multiplier;
}

function approvedForOpen(input: GatewayInput): number {
  const limit = effectiveLimitUsd(input);
  const current = currentExposureUsd(input);
  const available = limit - current;
  if (available <= 0) return -1;
  return Math.min(input.intent.positionUsd, available);
}

function approvedForReduce(input: GatewayInput): number {
  const current = currentExposureUsd(input);
  return Math.min(input.intent.positionUsd, current);
}

function approvedForClose(input: GatewayInput): number {
  return currentExposureUsd(input);
}

// ─── Main gateway ───────────────────────────────────────────────────────────

export function evaluatePreTradeRisk(input: GatewayInput): GatewayResult {
  // 1. Validate input structure
  const inputErr = validateInput(input);
  if (inputErr) return reject(inputErr);

  // 2. Validate market
  const marketErr = validateMarket(input);
  if (marketErr) return reject(marketErr);

  // 3. Validate position
  const posErr = validatePosition(input);
  if (posErr) return reject(posErr);

  // 4. Validate policy (only for 'open')
  const polErr = validatePolicy(input);
  if (polErr) return reject(polErr);

  // 5. Compute approved size
  let approvedUsd: number;
  if (input.action === 'open') {
    approvedUsd = approvedForOpen(input);
    if (approvedUsd <= 0) return reject('POSITION_LIMIT_REACHED');
  } else if (input.action === 'reduce') {
    approvedUsd = approvedForReduce(input);
    if (approvedUsd <= 0) return reject('POSITION_LIMIT_REACHED');
  } else {
    approvedUsd = approvedForClose(input);
  }

  return admit(input.action, input.intent, approvedUsd);
}
