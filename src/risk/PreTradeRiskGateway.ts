// Phase 2: PreTradeRiskGateway — pure deterministic risk admission
import { createHash } from 'node:crypto';
import { isExchangeId } from '../data/MarketIdentity';
import { ACCOUNT_RISK_AUTHORIZATION_CONTEXT_SCHEMA_VERSION } from './account-risk-authorization-context-types';
import { riskMandateDigest, validateRiskMandate } from './risk-mandate';
import type {
  AccountBoundGatewayDecisionProvenance,
  AccountBoundGatewayInput,
  AccountBoundGatewayResult,
  CanonicalRiskIncreaseEffect,
  ExactRiskComparisonEvidence,
  GatewayInput,
  GatewayResult,
  LegacyPaperGatewayInput,
  RiskReasonCode,
} from './pretrade-risk-types';

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
    const limits = input.positionLimits;
    if (limits !== undefined) {
      if (!Number.isSafeInteger(limits.maxConcurrentPositions) || limits.maxConcurrentPositions <= 0 ||
          !Number.isSafeInteger(limits.openPositionCount) || limits.openPositionCount < 0 ||
          typeof limits.allowScale !== 'boolean') {
        return 'HARD_RISK_CONFIG_INVALID';
      }
      if ((!limits.allowScale && pr.status === 'open') ||
          (pr.status !== 'open' && limits.openPositionCount >= limits.maxConcurrentPositions)) {
        return 'POSITION_LIMIT_REACHED';
      }
    }
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

export function evaluatePreTradeRisk(input: LegacyPaperGatewayInput): GatewayResult {
  if ('mode' in input || 'authorizationContext' in input) {
    return reject('ACCOUNT_RISK_MODE_INVALID');
  }
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

// ─── R3B3 account-bound risk-increase path ─────────────────────────────────

interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort()
      .map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function contextDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function parseExactDecimal(value: string): ExactDecimal | null {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value);
  if (match === null) return null;
  const negative = match[1] === '-';
  const integer = match[2]!;
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) return null;
  let coefficient = BigInt(`${negative ? '-' : ''}${integer}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function exactFromNumber(value: number): ExactDecimal | null {
  return Number.isFinite(value) ? parseExactDecimal(String(value)) : null;
}

function exactToString(value: ExactDecimal): string {
  let coefficient = value.coefficient;
  const negative = coefficient < 0n;
  if (negative) coefficient = -coefficient;
  if (value.scale === 0) return `${negative ? '-' : ''}${coefficient}`;
  const digits = coefficient.toString().padStart(value.scale + 1, '0');
  const integer = digits.slice(0, -value.scale);
  const fraction = digits.slice(-value.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

function compareExact(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * (10n ** BigInt(scale - left.scale));
  const b = right.coefficient * (10n ** BigInt(scale - right.scale));
  return a < b ? -1 : a > b ? 1 : 0;
}

function addExact(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient: left.coefficient * (10n ** BigInt(scale - left.scale))
      + right.coefficient * (10n ** BigInt(scale - right.scale)),
    scale,
  };
}

function multiplyExact(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return { coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale };
}

function freezeProvenance(
  input: AccountBoundGatewayInput,
  riskEffect: CanonicalRiskIncreaseEffect | null,
  comparisons: readonly ExactRiskComparisonEvidence[],
): AccountBoundGatewayDecisionProvenance {
  const context = input?.authorizationContext;
  const mandate = context?.mandateResolution?.mandate ?? null;
  return Object.freeze({
    mode: 'ACCOUNT_BOUND' as const,
    riskEffect,
    exchange: context?.identity?.exchange ?? input?.intent?.exchange ?? null,
    settle: context?.identity?.settle ?? null,
    accountId: context?.identity?.accountId ?? input?.hardRisk?.accountId ?? null,
    symbol: input?.intent?.symbol ?? null,
    intentId: input?.intent?.intentId ?? null,
    positionVersion: input?.positionResolution?.snapshot?.positionVersion ?? null,
    positionSourceKernelEventId:
      input?.positionResolution?.snapshot?.sourceKernelEventId ?? null,
    contextDigest: context?.contextDigest ?? null,
    snapshotDigest: context?.provenance?.snapshotDigest ?? null,
    mandateDigest: context?.provenance?.mandateDigest ?? null,
    evaluationTime: context?.evaluationTime ?? null,
    accountingDayId: context?.snapshot?.accountingDayId ?? null,
    mandateId: mandate?.mandateId ?? null,
    mandateVersion: mandate?.mandateVersion ?? null,
    comparisons: Object.freeze(comparisons.map((entry) => Object.freeze({ ...entry }))),
  });
}

function accountReject(
  input: AccountBoundGatewayInput,
  reasonCode: RiskReasonCode,
  riskEffect: CanonicalRiskIncreaseEffect | null,
  comparisons: readonly ExactRiskComparisonEvidence[] = [],
): AccountBoundGatewayResult {
  return Object.freeze({
    decision: 'REJECTED' as const,
    reasonCode,
    provenance: freezeProvenance(input, riskEffect, comparisons),
  });
}

function deriveRiskIncreaseEffect(
  input: AccountBoundGatewayInput,
): CanonicalRiskIncreaseEffect | null {
  if (input.action !== 'open') return null;
  const position = input.positionResolution;
  const source = position.snapshot;
  if (source === null
      || source.exchange !== input.intent.exchange
      || source.symbol !== input.intent.symbol
      || source.side !== position.side
      || source.signedQuantity !== position.signedQuantity
      || source.averageEntryPrice !== position.averageEntryPrice) return null;
  if (position.status === 'flat'
      && position.side === 'flat'
      && position.signedQuantity === 0
      && position.averageEntryPrice === 0) return 'OPEN';
  const sameLong = position.status === 'open' && position.side === 'long'
    && position.signedQuantity > 0 && position.averageEntryPrice > 0
    && input.intent.direction === 'long';
  const sameShort = position.status === 'open' && position.side === 'short'
    && position.signedQuantity < 0 && position.averageEntryPrice > 0
    && input.intent.direction === 'short';
  return sameLong || sameShort ? 'INCREASE' : null;
}

function contextProvenanceValid(input: AccountBoundGatewayInput): boolean {
  const context = input.authorizationContext;
  try {
    const { contextDigest: claimed, ...withoutDigest } = context;
    const mandate = context.mandateResolution.mandate;
    if (mandate === null) return false;
    validateRiskMandate(mandate);
    const computedMandateDigest = riskMandateDigest(mandate);
    return /^[a-f0-9]{64}$/.test(claimed)
      && contextDigest(withoutDigest) === claimed
      && context.schemaVersion === ACCOUNT_RISK_AUTHORIZATION_CONTEXT_SCHEMA_VERSION
      && context.compatible === true
      && context.status === 'COMPATIBLE'
      && context.failures.length === 0
      && context.qualifiedContextOnly === true
      && context.tradingAuthorized === false
      && context.snapshot.status === 'QUALIFIED'
      && context.snapshot.observationFreshness === 'FRESH'
      && context.policyBinding.matched === true
      && context.requiredMetrics.allAvailable === true
      && context.requiredMetrics.accountValue.availability === 'AVAILABLE'
      && context.requiredMetrics.dailyEquityLoss.availability === 'AVAILABLE'
      && context.requiredMetrics.drawdownFraction.availability === 'AVAILABLE'
      && context.mandateResolution.status === 'ACTIVE'
      && context.mandateResolution.evaluationTime === context.evaluationTime
      && context.snapshot.evaluatedAt === context.evaluationTime
      && mandate.enabled === true
      && mandate.effectiveAt <= context.evaluationTime
      && context.evaluationTime < mandate.expiresAt
      && context.mandateResolution.mandateDigest === context.provenance.mandateDigest
      && context.provenance.mandateDigest === computedMandateDigest
      && context.snapshot.snapshotDigest === context.provenance.snapshotDigest
      && context.policyBinding.snapshotPolicyDigest === context.provenance.metricPolicyDigest
      && context.policyBinding.mandatePolicySchemaVersion
        === mandate.metricPolicyBinding.metricPolicySchemaVersion
      && context.policyBinding.mandatePolicyId === mandate.metricPolicyBinding.metricPolicyId
      && context.policyBinding.mandatePolicyVersion === mandate.metricPolicyBinding.metricPolicyVersion
      && context.policyBinding.mandatePolicyDigest === mandate.metricPolicyBinding.metricPolicyDigest;
  } catch {
    return false;
  }
}

function appendComparison(
  comparisons: ExactRiskComparisonEvidence[],
  metric: ExactRiskComparisonEvidence['metric'],
  actual: ExactDecimal,
  limit: ExactDecimal,
  rejectWhen: ExactRiskComparisonEvidence['rejectWhen'],
): boolean {
  const comparison = compareExact(actual, limit);
  const rejected = rejectWhen === '>=' ? comparison >= 0 : comparison > 0;
  comparisons.push(Object.freeze({
    metric,
    actualExact: exactToString(actual),
    limitExact: exactToString(limit),
    rejectWhen,
    outcome: rejected ? 'REJECT' as const : 'PASS' as const,
  }));
  return rejected;
}

/**
 * Explicit account-bound risk-increase entrypoint. It never falls back to the
 * legacy/paper mode and never treats a compatible context as automatic admission.
 */
export function evaluateAccountBoundPreTradeRisk(
  input: AccountBoundGatewayInput,
): AccountBoundGatewayResult {
  if (input?.mode !== 'ACCOUNT_BOUND') return accountReject(
    input, 'ACCOUNT_RISK_MODE_INVALID', null,
  );
  if (!input.authorizationContext) return accountReject(
    input, 'ACCOUNT_RISK_CONTEXT_REQUIRED', null,
  );
  const effect = deriveRiskIncreaseEffect(input);
  if (effect === null) return accountReject(input, 'ACCOUNT_RISK_EFFECT_UNRESOLVED', null);
  const context = input.authorizationContext;
  if (context.status !== 'COMPATIBLE' || context.compatible !== true) {
    return accountReject(input, 'ACCOUNT_RISK_CONTEXT_INCOMPATIBLE', effect);
  }
  if (!contextProvenanceValid(input)) {
    return accountReject(input, 'ACCOUNT_RISK_CONTEXT_PROVENANCE_INVALID', effect);
  }
  const mandate = context.mandateResolution.mandate!;
  if (input.intent.exchange !== context.identity.exchange
      || input.hardRisk.exchange !== context.identity.exchange
      || input.hardRisk.accountId !== context.identity.accountId
      || mandate.exchange !== context.identity.exchange
      || mandate.settle !== context.identity.settle
      || mandate.accountId !== context.identity.accountId) {
    return accountReject(input, 'ACCOUNT_RISK_IDENTITY_MISMATCH', effect);
  }
  if (!mandate.allowedSymbols.includes(input.intent.symbol)) {
    return accountReject(input, 'ACCOUNT_RISK_SYMBOL_NOT_ALLOWED', effect);
  }
  if (!mandate.allowedActionEffects.includes(effect)) {
    return accountReject(input, 'ACCOUNT_RISK_EFFECT_NOT_ALLOWED', effect);
  }

  const { mode: _mode, authorizationContext: _context, ...legacyInput } = input;
  const legacy = evaluatePreTradeRisk(legacyInput);
  if (legacy.decision === 'REJECTED') {
    return accountReject(input, legacy.reasonCode, effect);
  }

  const dailyLoss = parseExactDecimal(context.requiredMetrics.dailyEquityLoss.valueExact ?? '');
  const drawdown = parseExactDecimal(context.requiredMetrics.drawdownFraction.valueExact ?? '');
  const accountValue = parseExactDecimal(context.requiredMetrics.accountValue.valueExact ?? '');
  const maxDailyLoss = parseExactDecimal(mandate.limits.maxDailyEquityLossExact);
  const maxDrawdown = parseExactDecimal(mandate.limits.maxDrawdownFractionExact);
  const maxNotional = parseExactDecimal(mandate.limits.maxSinglePositionNotionalExact);
  const maxFraction = parseExactDecimal(mandate.limits.maxSinglePositionFractionExact);
  const intentNotional = exactFromNumber(input.intent.positionUsd);
  if (dailyLoss === null || drawdown === null || accountValue === null
      || maxDailyLoss === null || maxDrawdown === null || maxNotional === null
      || maxFraction === null || intentNotional === null
      || compareExact(accountValue, { coefficient: 0n, scale: 0 }) <= 0) {
    return accountReject(input, 'ACCOUNT_RISK_EXACT_VALUE_INVALID', effect);
  }

  const comparisons: ExactRiskComparisonEvidence[] = [];
  if (appendComparison(comparisons, 'DAILY_EQUITY_LOSS', dailyLoss, maxDailyLoss, '>=')) {
    return accountReject(input, 'ACCOUNT_RISK_DAILY_LOSS_LIMIT_REACHED', effect, comparisons);
  }
  if (appendComparison(comparisons, 'DRAWDOWN_FRACTION', drawdown, maxDrawdown, '>=')) {
    return accountReject(input, 'ACCOUNT_RISK_DRAWDOWN_LIMIT_REACHED', effect, comparisons);
  }

  let proposedNotional = intentNotional;
  if (effect === 'INCREASE') {
    const quantity = exactFromNumber(Math.abs(input.positionResolution.signedQuantity));
    const marketPrice = exactFromNumber(input.marketSnapshot!.ticker!.ticker.last);
    if (quantity === null || marketPrice === null) {
      return accountReject(input, 'ACCOUNT_RISK_EXACT_VALUE_INVALID', effect, comparisons);
    }
    proposedNotional = addExact(multiplyExact(quantity, marketPrice), intentNotional);
  }
  if (appendComparison(comparisons, 'POSITION_NOTIONAL', proposedNotional, maxNotional, '>')) {
    return accountReject(
      input, 'ACCOUNT_RISK_POSITION_NOTIONAL_LIMIT_EXCEEDED', effect, comparisons,
    );
  }
  const fractionNotional = multiplyExact(accountValue, maxFraction);
  if (appendComparison(
    comparisons, 'POSITION_FRACTION_NOTIONAL', proposedNotional, fractionNotional, '>',
  )) {
    return accountReject(
      input, 'ACCOUNT_RISK_POSITION_FRACTION_LIMIT_EXCEEDED', effect, comparisons,
    );
  }

  return Object.freeze({
    decision: 'ADMITTED' as const,
    action: 'open' as const,
    intent: input.intent,
    approvedPositionUsd: legacy.approvedPositionUsd,
    provenance: freezeProvenance(input, effect, comparisons),
  });
}
