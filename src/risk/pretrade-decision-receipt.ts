import { createHash } from 'node:crypto';
import { isExchangeId } from '../data/MarketIdentity';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { TradeIntent } from '../types/trade-intent';
import { generateOrderId } from '../oms/order-id';
import { compareExitProduct, type TrustedExitProof } from './trusted-exit';
import type {
  AccountBoundGatewayResult,
  ExactRiskComparisonEvidence,
  GatewayResult,
  TradeAction,
} from './pretrade-risk-types';
import {
  PRETRADE_RISK_DECISION_RECEIPT_SCHEMA_VERSION,
  PRETRADE_RISK_DECISION_RECORDED,
  type PreTradeGatewayMode,
  type PreTradeRiskDecisionReceiptStore,
  type PreTradeRiskDecisionReceiptStoreSnapshot,
  type PreTradeRiskDecisionReceiptV1,
  type PreTradeRiskDecisionRecordedPayload,
} from './pretrade-decision-receipt-types';

const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const ACTIONS = new Set<TradeAction>(['open', 'reduce', 'close', 'emergency_exit']);
const COMPARISON_METRICS = new Set([
  'DAILY_EQUITY_LOSS', 'DRAWDOWN_FRACTION', 'POSITION_NOTIONAL',
  'POSITION_FRACTION_NOTIONAL',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonicalize(value[key])]));
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

/** Full semantic intent binding, not merely a caller-chosen intentId. */
export function riskIncreaseIntentDigest(intent: TradeIntent): string {
  return sha256(intent);
}

function cloneFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  function freeze(entry: unknown): void {
    if (entry === null || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
    Object.freeze(entry);
  }
  freeze(cloned);
  return cloned;
}

function exactNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('PRETRADE_RECEIPT_NUMBER_INVALID');
  const source = String(value);
  const rendered = source.includes('e') || source.includes('E')
    ? (() => {
        const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(source);
        if (match === null) throw new Error('PRETRADE_RECEIPT_NUMBER_INVALID');
        const integer = match[1]!;
        const fraction = match[2] ?? '';
        const exponent = Number(match[3]);
        if (!Number.isSafeInteger(exponent)) throw new Error('PRETRADE_RECEIPT_NUMBER_INVALID');
        const digits = integer + fraction;
        const point = integer.length + exponent;
        if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
        if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
        return `${digits.slice(0, point)}.${digits.slice(point)}`;
      })()
    : source;
  if (!EXACT_NON_NEGATIVE_DECIMAL.test(rendered)) {
    throw new Error('PRETRADE_RECEIPT_NUMBER_INVALID');
  }
  return rendered;
}

export { exactNumber as preTradeReceiptExactNumber };

function validNullableSha(value: unknown): boolean {
  return value === null || (typeof value === 'string' && SHA256.test(value));
}

function validComparison(value: unknown): value is ExactRiskComparisonEvidence {
  if (!isRecord(value) || !exactKeys(value,
    ['metric', 'actualExact', 'limitExact', 'rejectWhen', 'outcome'])) return false;
  return COMPARISON_METRICS.has(value.metric as string)
    && typeof value.actualExact === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(value.actualExact)
    && typeof value.limitExact === 'string' && EXACT_NON_NEGATIVE_DECIMAL.test(value.limitExact)
    && (value.rejectWhen === '>=' || value.rejectWhen === '>')
    && (value.outcome === 'PASS' || value.outcome === 'REJECT');
}

export function validatePreTradeRiskDecisionReceipt(
  value: unknown,
): asserts value is PreTradeRiskDecisionReceiptV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'gatewayMode', 'exchange', 'settle', 'accountId', 'intentId',
    'symbol', 'action', 'requestedPositionUsdExact', 'evaluationTime', 'decision',
    'reasonCode', 'approvedPositionUsdExact', 'riskEffect', 'contextDigest',
    'snapshotDigest', 'mandateDigest', 'accountingDayId', 'positionVersion',
    'positionSourceKernelEventId', 'comparisons',
    ...(isRecord(value) && value.gatewayMode === 'GATEIO_TRUSTED_EXIT_ONLY' ? ['exitProof'] : []),
    ...(isRecord(value) && Object.hasOwn(value, 'riskIncreaseProof') ? ['riskIncreaseProof'] : []),
  ])) throw new Error('PRETRADE_RECEIPT_INVALID');
  if (value.schemaVersion !== PRETRADE_RISK_DECISION_RECEIPT_SCHEMA_VERSION
      || (value.gatewayMode !== 'LEGACY_PAPER_OR_NON_GATE'
        && value.gatewayMode !== 'GATEIO_ACCOUNT_BOUND'
        && value.gatewayMode !== 'GATEIO_EXISTING_EXIT_PATH'
        && value.gatewayMode !== 'GATEIO_TRUSTED_EXIT_ONLY')
      || !isExchangeId(value.exchange as string)
      || (value.settle !== null && value.settle !== 'USDT')
      || typeof value.accountId !== 'string' || value.accountId.length === 0
      || typeof value.intentId !== 'string' || value.intentId.length === 0
      || typeof value.symbol !== 'string' || value.symbol.length === 0
      || !ACTIONS.has(value.action as TradeAction)
      || typeof value.requestedPositionUsdExact !== 'string'
      || !EXACT_NON_NEGATIVE_DECIMAL.test(value.requestedPositionUsdExact)
      || !Number.isSafeInteger(value.evaluationTime) || (value.evaluationTime as number) <= 0
      || (value.decision !== 'ADMITTED' && value.decision !== 'REJECTED')
      || (value.reasonCode !== null
        && (typeof value.reasonCode !== 'string' || value.reasonCode.length === 0))
      || (value.approvedPositionUsdExact !== null
        && (typeof value.approvedPositionUsdExact !== 'string'
          || !EXACT_NON_NEGATIVE_DECIMAL.test(value.approvedPositionUsdExact)))
      || (value.riskEffect !== null && value.riskEffect !== 'OPEN'
        && value.riskEffect !== 'INCREASE'
        && !(value.gatewayMode === 'GATEIO_TRUSTED_EXIT_ONLY'
          && ['REDUCE', 'CLOSE', 'EMERGENCY_CLOSE'].includes(value.riskEffect as string)))
      || !validNullableSha(value.contextDigest)
      || !validNullableSha(value.snapshotDigest)
      || !validNullableSha(value.mandateDigest)
      || (value.accountingDayId !== null
        && (typeof value.accountingDayId !== 'string' || value.accountingDayId.length === 0))
      || (value.positionVersion !== null
        && (!Number.isSafeInteger(value.positionVersion) || (value.positionVersion as number) <= 0))
      || !validNullableSha(value.positionSourceKernelEventId)
      || !Array.isArray(value.comparisons) || !value.comparisons.every(validComparison)) {
    throw new Error('PRETRADE_RECEIPT_INVALID');
  }
  if ((value.gatewayMode === 'GATEIO_ACCOUNT_BOUND'
        || value.gatewayMode === 'GATEIO_EXISTING_EXIT_PATH'
        || value.gatewayMode === 'GATEIO_TRUSTED_EXIT_ONLY')
      && (value.exchange !== 'gateio' || value.settle !== 'USDT')) {
    throw new Error('PRETRADE_RECEIPT_IDENTITY_INVALID');
  }
  if ((value.decision === 'ADMITTED') !== (value.approvedPositionUsdExact !== null)
      || (value.decision === 'REJECTED') !== (value.reasonCode !== null)) {
    throw new Error('PRETRADE_RECEIPT_DECISION_INVALID');
  }
  if (Object.hasOwn(value, 'riskIncreaseProof')) {
    const proof = value.riskIncreaseProof;
    if (value.gatewayMode !== 'GATEIO_ACCOUNT_BOUND' || value.action !== 'open'
        || value.decision !== 'ADMITTED' || !['OPEN', 'INCREASE'].includes(value.riskEffect as string)
        || !isRecord(proof) || !exactKeys(proof, ['intentDigest', 'direction', 'orderId'])
        || typeof proof.intentDigest !== 'string' || !SHA256.test(proof.intentDigest)
        || (proof.direction !== 'long' && proof.direction !== 'short')
        || proof.orderId !== generateOrderId({ intentId: value.intentId as string,
          exchange: value.exchange as string, symbol: value.symbol as string,
          direction: proof.direction, action: 'open', approvedPositionUsd: Number(value.approvedPositionUsdExact) }))
      throw new Error('RISK_INCREASE_RECEIPT_PROOF_INVALID');
  }
  if (value.gatewayMode === 'GATEIO_TRUSTED_EXIT_ONLY') {
    const p = value.exitProof;
    if (value.decision === 'REJECTED') {
      if (p !== null || value.riskEffect !== null) throw new Error('EXIT_RECEIPT_PROOF_INVALID');
      return;
    }
    if (!isRecord(p) || !exactKeys(p, ['effect', 'exchange', 'settle', 'accountId', 'symbol',
        'direction', 'exposureQuantityExact', 'valuationPriceExact', 'positionVersion',
        'positionSourceKernelEventId', 'truthCapturedAt', 'truthSource', 'reduceOnly', 'orderId'])
        || p.exchange !== value.exchange || p.settle !== value.settle || p.accountId !== value.accountId
        || p.symbol !== value.symbol || p.effect !== value.riskEffect
        || p.positionVersion !== value.positionVersion || p.positionSourceKernelEventId !== value.positionSourceKernelEventId
        || !Number.isSafeInteger(p.positionVersion) || (p.positionVersion as number) <= 0
        || typeof p.positionSourceKernelEventId !== 'string' || !SHA256.test(p.positionSourceKernelEventId)
        || !Number.isSafeInteger(p.truthCapturedAt) || (p.truthCapturedAt as number) <= 0
        || (p.truthCapturedAt as number) > (value.evaluationTime as number)
        || typeof p.truthSource !== 'string' || !p.truthSource
        || p.reduceOnly !== true || (p.direction !== 'long' && p.direction !== 'short')
        || typeof p.exposureQuantityExact !== 'string' || !EXACT_NON_NEGATIVE_DECIMAL.test(p.exposureQuantityExact)
        || p.exposureQuantityExact === '0'
        || typeof p.valuationPriceExact !== 'string' || !EXACT_NON_NEGATIVE_DECIMAL.test(p.valuationPriceExact)
        || p.valuationPriceExact === '0'
        || value.requestedPositionUsdExact !== value.approvedPositionUsdExact
        || p.orderId !== generateOrderId({ intentId: value.intentId as string, exchange: 'gateio',
          symbol: value.symbol as string, direction: p.direction, action: value.action as string,
          approvedPositionUsd: Number(value.approvedPositionUsdExact) })) throw new Error('EXIT_RECEIPT_PROOF_INVALID');
    const comparison = compareExitProduct(p.exposureQuantityExact, p.valuationPriceExact,
      value.approvedPositionUsdExact as string);
    if (comparison < 0 || (p.effect === 'REDUCE'
        ? comparison <= 0 || value.action !== 'reduce'
        : comparison !== 0 || (p.effect === 'CLOSE' ? value.action !== 'close'
          : p.effect !== 'EMERGENCY_CLOSE' || value.action !== 'emergency_exit')))
      throw new Error('EXIT_RECEIPT_EFFECT_INVALID');
  }
}

export function preTradeRiskDecisionReceiptDigest(
  receipt: PreTradeRiskDecisionReceiptV1,
): string {
  validatePreTradeRiskDecisionReceipt(receipt);
  return sha256(receipt);
}

export function validatePreTradeRiskDecisionRecordedPayload(
  value: unknown,
): asserts value is PreTradeRiskDecisionRecordedPayload {
  if (!isRecord(value) || !exactKeys(value, ['receipt', 'receiptDigest'])) {
    throw new Error('PRETRADE_RECEIPT_PAYLOAD_INVALID');
  }
  validatePreTradeRiskDecisionReceipt(value.receipt);
  if (typeof value.receiptDigest !== 'string' || !SHA256.test(value.receiptDigest)
      || value.receiptDigest !== preTradeRiskDecisionReceiptDigest(value.receipt)) {
    throw new Error('PRETRADE_RECEIPT_DIGEST_MISMATCH');
  }
}

export function createPreTradeRiskDecisionReceipt(input: Readonly<{
  gatewayMode: PreTradeGatewayMode;
  accountId: string;
  intent: TradeIntent;
  action: TradeAction;
  evaluationTime: number;
  result: GatewayResult | AccountBoundGatewayResult;
  exitProof?: TrustedExitProof | null;
  bindRiskIncreaseIntent?: boolean;
}>): PreTradeRiskDecisionRecordedPayload {
  const provenance = 'provenance' in input.result ? input.result.provenance : null;
  const receipt: PreTradeRiskDecisionReceiptV1 = {
    schemaVersion: PRETRADE_RISK_DECISION_RECEIPT_SCHEMA_VERSION,
    gatewayMode: input.gatewayMode,
    exchange: input.intent.exchange,
    settle: provenance?.settle === 'USDT'
      || input.gatewayMode === 'GATEIO_EXISTING_EXIT_PATH'
      || input.gatewayMode === 'GATEIO_TRUSTED_EXIT_ONLY' ? 'USDT' : null,
    accountId: input.accountId,
    intentId: input.intent.intentId,
    symbol: input.intent.symbol,
    action: input.action,
    requestedPositionUsdExact: exactNumber(input.intent.positionUsd),
    evaluationTime: input.evaluationTime,
    decision: input.result.decision,
    reasonCode: input.result.decision === 'REJECTED' ? input.result.reasonCode : null,
    approvedPositionUsdExact: input.result.decision === 'ADMITTED'
      ? exactNumber(input.result.approvedPositionUsd) : null,
    riskEffect: input.exitProof?.effect ?? provenance?.riskEffect ?? null,
    ...(input.bindRiskIncreaseIntent && input.result.decision === 'ADMITTED' ? {
      riskIncreaseProof: {
        intentDigest: riskIncreaseIntentDigest(input.intent), direction: input.intent.direction,
        orderId: generateOrderId({ ...input.intent, action: input.action,
          approvedPositionUsd: input.result.approvedPositionUsd }),
      },
    } : {}),
    ...(input.gatewayMode === 'GATEIO_TRUSTED_EXIT_ONLY' ? { exitProof: input.exitProof ?? null } : {}),
    contextDigest: provenance?.contextDigest ?? null,
    snapshotDigest: provenance?.snapshotDigest ?? null,
    mandateDigest: provenance?.mandateDigest ?? null,
    accountingDayId: provenance?.accountingDayId ?? null,
    positionVersion: input.exitProof?.positionVersion ?? provenance?.positionVersion ?? null,
    positionSourceKernelEventId: input.exitProof?.positionSourceKernelEventId ?? provenance?.positionSourceKernelEventId ?? null,
    comparisons: provenance?.comparisons ?? [],
  };
  validatePreTradeRiskDecisionReceipt(receipt);
  return cloneFreeze({ receipt, receiptDigest: preTradeRiskDecisionReceiptDigest(receipt) });
}

export function createPreTradeRiskDecisionReceiptStore(): PreTradeRiskDecisionReceiptStore {
  const records = new Map<string, PreTradeRiskDecisionReceiptStoreSnapshot['records'][number]>();
  const eventFingerprints = new Map<string, string>();
  let lastSequence: number | null = null;

  return {
    apply(value: unknown) {
      if (!isRecord(value) || value.type !== PRETRADE_RISK_DECISION_RECORDED
          || typeof value.kernelEventId !== 'string' || !SHA256.test(value.kernelEventId)
          || !Number.isSafeInteger(value.kernelLogicalSequence)
          || (value.kernelLogicalSequence as number) <= 0
          || !Number.isSafeInteger(value.kernelTimestamp)
          || (value.kernelTimestamp as number) <= 0) {
        throw new Error('PRETRADE_RECEIPT_EVENT_INVALID');
      }
      validatePreTradeRiskDecisionRecordedPayload(value.payload);
      const envelope = value as unknown as KernelEventEnvelope<typeof PRETRADE_RISK_DECISION_RECORDED>;
      const fingerprint = sha256(envelope);
      const prior = eventFingerprints.get(envelope.kernelEventId);
      if (prior !== undefined) {
        if (prior !== fingerprint) throw new Error('PRETRADE_RECEIPT_EVENT_CONFLICT');
        return 'DUPLICATE_SAME_FACT';
      }
      if (lastSequence !== null && envelope.kernelLogicalSequence <= lastSequence) {
        throw new Error('PRETRADE_RECEIPT_REPLAY_ORDER_INVALID');
      }
      const existing = records.get(envelope.payload.receiptDigest);
      if (existing !== undefined
          && preTradeRiskDecisionReceiptDigest(existing.receipt)
            !== envelope.payload.receiptDigest) {
        throw new Error('PRETRADE_RECEIPT_IDENTITY_CONFLICT');
      }
      eventFingerprints.set(envelope.kernelEventId, fingerprint);
      lastSequence = envelope.kernelLogicalSequence;
      if (existing === undefined) {
        records.set(envelope.payload.receiptDigest, cloneFreeze({
          receiptDigest: envelope.payload.receiptDigest,
          receipt: envelope.payload.receipt,
          kernelEventId: envelope.kernelEventId,
          kernelLogicalSequence: envelope.kernelLogicalSequence,
          kernelTimestamp: envelope.kernelTimestamp,
        }));
      }
      return existing === undefined ? 'RECORDED' : 'DUPLICATE_SAME_FACT';
    },
    snapshot() {
      return cloneFreeze({
        schemaVersion: 'pretrade-risk-decision-receipt-store-v1' as const,
        records: [...records.values()].sort((left, right) =>
          left.kernelLogicalSequence - right.kernelLogicalSequence),
        lastKernelLogicalSequence: lastSequence,
      });
    },
    digest() { return sha256(this.snapshot()); },
  };
}
