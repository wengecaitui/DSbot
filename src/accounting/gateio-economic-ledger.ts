import { createHash } from 'node:crypto';
import type { TradingKernel } from '../kernel/TradingKernel';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import { normalizeGateIoAccountBookPageRequest } from '../runtime/gateio/GateIoReadContracts';
import { gateIoEconomicCategoryForRawType } from './gateio-economic-truth';
import {
  GATEIO_ACCOUNT_BOOK_ENDPOINT,
  GATEIO_ACCOUNT_BOOK_SOURCE,
  GATEIO_ECONOMIC_TRUTH_SCHEMA_VERSION,
  type GateIoCanonicalEconomicEvent,
  type GateIoEconomicEventCapture,
} from './gateio-economic-truth-types';
import {
  GATEIO_ECONOMIC_EVENT_RECORDED,
  type GateIoEconomicApplyResult,
  type GateIoEconomicCaptureRecord,
  type GateIoEconomicEventRecordedPayload,
  type GateIoEconomicIdentityConflict,
  type GateIoEconomicLedgerFactRecord,
  type GateIoEconomicLedgerSnapshot,
  type GateIoEconomicRecordResult,
} from './gateio-economic-ledger-types';

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;
const CATEGORIES = new Set([
  'TRANSFER', 'POSITION_PNL', 'TRADING_FEE', 'REFERRAL_REBATE', 'FUNDING',
  'POINT_TRANSFER', 'POINT_FEE', 'POINT_REBATE', 'BONUS_OFFSET', 'UNCLASSIFIED',
]);

export type GateIoEconomicLedgerErrorCode =
  | 'GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID'
  | 'GATEIO_ECONOMIC_FACT_DIGEST_MISMATCH'
  | 'GATEIO_ECONOMIC_IDENTITY_CONFLICT'
  | 'GATEIO_ECONOMIC_KERNEL_EVENT_CONFLICT'
  | 'GATEIO_ECONOMIC_REPLAY_ORDER_INVALID'
  | 'GATEIO_ECONOMIC_LEDGER_NOT_REPLAYED';

export class GateIoEconomicLedgerError extends Error {
  constructor(readonly code: GateIoEconomicLedgerErrorCode) {
    super(code);
    this.name = 'GateIoEconomicLedgerError';
  }
}

export interface GateIoEconomicLedger {
  apply(envelope: unknown): GateIoEconomicApplyResult;
  snapshot(): GateIoEconomicLedgerSnapshot;
  digest(): string;
  factDigestForIdentity(identity: string): string | null;
  isConflicted(identity: string): boolean;
}

interface MutableFactRecord {
  identity: string;
  factDigest: string;
  fact: GateIoCanonicalEconomicEvent;
  captures: GateIoEconomicCaptureRecord[];
}

function fail(code: GateIoEconomicLedgerErrorCode): never {
  throw new GateIoEconomicLedgerError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
      || Object.keys(value).some((key) => !allowed.has(key))) {
    fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  }
}

function nonEmptyText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  }
  return value;
}

function optionalText(value: Record<string, unknown>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  if (typeof value[key] !== 'string') fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  return value[key] as string;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
      sorted[key] = canonicalValue(value[key]);
    }
    return sorted;
  }
  fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cloneFreeze<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    Object.freeze(entry);
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
  };
  freeze(clone);
  return clone;
}

function validateCapture(value: unknown): GateIoEconomicEventCapture {
  if (!isRecord(value)) fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  exactKeys(value, ['endpoint', 'observedAt', 'pageRequest', 'rawPayloadDigest']);
  if (value.endpoint !== GATEIO_ACCOUNT_BOOK_ENDPOINT
      || typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt)
      || value.observedAt <= 0 || typeof value.rawPayloadDigest !== 'string'
      || !SHA256.test(value.rawPayloadDigest) || !isRecord(value.pageRequest)) {
    fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  }
  let normalizedRequest: unknown;
  try {
    normalizedRequest = normalizeGateIoAccountBookPageRequest(value.pageRequest);
  } catch {
    fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  }
  if (canonicalJSON(normalizedRequest) !== canonicalJSON(value.pageRequest)) {
    fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  }
  return value as unknown as GateIoEconomicEventCapture;
}

export function validateGateIoCanonicalEconomicEvent(
  value: unknown,
): asserts value is GateIoCanonicalEconomicEvent {
  if (!isRecord(value)) fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  exactKeys(
    value,
    ['schemaVersion', 'exchange', 'settle', 'source', 'sourceId', 'occurredAt', 'category',
      'rawType', 'change', 'balance', 'capture'],
    ['contract', 'tradeId', 'text'],
  );
  const rawType = nonEmptyText(value.rawType);
  if (value.schemaVersion !== GATEIO_ECONOMIC_TRUTH_SCHEMA_VERSION
      || value.exchange !== 'gateio' || value.settle !== 'usdt'
      || value.source !== GATEIO_ACCOUNT_BOOK_SOURCE
      || nonEmptyText(value.sourceId).length === 0
      || typeof value.occurredAt !== 'number' || !Number.isFinite(value.occurredAt)
      || value.occurredAt <= 0 || typeof value.category !== 'string'
      || !CATEGORIES.has(value.category)
      || value.category !== gateIoEconomicCategoryForRawType(rawType)
      || typeof value.change !== 'string' || !EXACT_DECIMAL.test(value.change)
      || typeof value.balance !== 'string' || !EXACT_DECIMAL.test(value.balance)) {
    fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  }
  optionalText(value, 'contract');
  optionalText(value, 'tradeId');
  optionalText(value, 'text');
  validateCapture(value.capture);
}

function semanticFact(fact: GateIoCanonicalEconomicEvent): Record<string, unknown> {
  return {
    schemaVersion: fact.schemaVersion,
    exchange: fact.exchange,
    settle: fact.settle,
    source: fact.source,
    sourceId: fact.sourceId,
    occurredAt: fact.occurredAt,
    category: fact.category,
    rawType: fact.rawType,
    change: fact.change,
    balance: fact.balance,
    ...(fact.contract === undefined ? {} : { contract: fact.contract }),
    ...(fact.tradeId === undefined ? {} : { tradeId: fact.tradeId }),
    ...(fact.text === undefined ? {} : { text: fact.text }),
  };
}

export function gateIoEconomicIdentity(fact: GateIoCanonicalEconomicEvent): string {
  validateGateIoCanonicalEconomicEvent(fact);
  return canonicalJSON([fact.exchange, fact.settle, fact.source, fact.sourceId]);
}

export function gateIoEconomicFactDigest(fact: GateIoCanonicalEconomicEvent): string {
  validateGateIoCanonicalEconomicEvent(fact);
  return sha256(canonicalJSON(semanticFact(fact)));
}

export function validateGateIoEconomicEventRecordedPayload(
  value: unknown,
): asserts value is GateIoEconomicEventRecordedPayload {
  if (!isRecord(value)) fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  exactKeys(value, ['fact', 'factDigest']);
  validateGateIoCanonicalEconomicEvent(value.fact);
  if (typeof value.factDigest !== 'string' || !SHA256.test(value.factDigest)) {
    fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  }
  if (value.factDigest !== gateIoEconomicFactDigest(value.fact)) {
    fail('GATEIO_ECONOMIC_FACT_DIGEST_MISMATCH');
  }
}

function captureRecord(
  envelope: KernelEventEnvelope<'GATEIO_ECONOMIC_EVENT_RECORDED'>,
  payload: GateIoEconomicEventRecordedPayload,
): GateIoEconomicCaptureRecord {
  return cloneFreeze({
    kernelEventId: envelope.kernelEventId,
    kernelLogicalSequence: envelope.kernelLogicalSequence,
    kernelTimestamp: envelope.kernelTimestamp,
    factDigest: payload.factDigest,
    capture: payload.fact.capture,
  });
}

function validateEnvelope(
  value: unknown,
): KernelEventEnvelope<'GATEIO_ECONOMIC_EVENT_RECORDED'> {
  if (!isRecord(value) || value.type !== GATEIO_ECONOMIC_EVENT_RECORDED
      || typeof value.kernelEventId !== 'string' || !SHA256.test(value.kernelEventId)
      || typeof value.kernelLogicalSequence !== 'number'
      || !Number.isSafeInteger(value.kernelLogicalSequence) || value.kernelLogicalSequence <= 0
      || typeof value.kernelTimestamp !== 'number' || !Number.isFinite(value.kernelTimestamp)
      || value.kernelTimestamp <= 0) {
    fail('GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID');
  }
  validateGateIoEconomicEventRecordedPayload(value.payload);
  return value as unknown as KernelEventEnvelope<'GATEIO_ECONOMIC_EVENT_RECORDED'>;
}

export function createGateIoEconomicLedger(): GateIoEconomicLedger {
  const facts = new Map<string, MutableFactRecord>();
  const conflicts: GateIoEconomicIdentityConflict[] = [];
  const appliedEventFingerprints = new Map<string, string>();
  const conflictEventIds = new Set<string>();
  let boundary: { sequence: number; eventId: string } | null = null;

  function apply(value: unknown): GateIoEconomicApplyResult {
    const envelope = validateEnvelope(value);
    const payload = envelope.payload;
    const identity = gateIoEconomicIdentity(payload.fact);
    const fingerprint = sha256(canonicalJSON(envelope));
    const priorFingerprint = appliedEventFingerprints.get(envelope.kernelEventId);
    if (priorFingerprint !== undefined) {
      if (priorFingerprint !== fingerprint) fail('GATEIO_ECONOMIC_KERNEL_EVENT_CONFLICT');
      if (conflictEventIds.has(envelope.kernelEventId)) fail('GATEIO_ECONOMIC_IDENTITY_CONFLICT');
      return Object.freeze({ status: 'DUPLICATE_SAME_FACT', identity, factDigest: payload.factDigest });
    }
    if (boundary !== null && envelope.kernelLogicalSequence <= boundary.sequence) {
      fail('GATEIO_ECONOMIC_REPLAY_ORDER_INVALID');
    }
    appliedEventFingerprints.set(envelope.kernelEventId, fingerprint);
    boundary = { sequence: envelope.kernelLogicalSequence, eventId: envelope.kernelEventId };
    const capture = captureRecord(envelope, payload);
    const existing = facts.get(identity);
    if (existing === undefined) {
      facts.set(identity, {
        identity,
        factDigest: payload.factDigest,
        fact: cloneFreeze(payload.fact),
        captures: [capture],
      });
      return Object.freeze({ status: 'RECORDED_NEW_FACT', identity, factDigest: payload.factDigest });
    }
    if (existing.factDigest === payload.factDigest) {
      existing.captures.push(capture);
      if (conflicts.some((entry) => entry.identity === identity)) {
        conflictEventIds.add(envelope.kernelEventId);
        fail('GATEIO_ECONOMIC_IDENTITY_CONFLICT');
      }
      return Object.freeze({ status: 'DUPLICATE_SAME_FACT', identity, factDigest: payload.factDigest });
    }
    conflicts.push(cloneFreeze({
      identity,
      acceptedDigest: existing.factDigest,
      conflictingDigest: payload.factDigest,
      conflictingFact: payload.fact,
      capture,
    }));
    conflictEventIds.add(envelope.kernelEventId);
    fail('GATEIO_ECONOMIC_IDENTITY_CONFLICT');
  }

  function snapshot(): GateIoEconomicLedgerSnapshot {
    const factRecords: GateIoEconomicLedgerFactRecord[] = [...facts.values()]
      .sort((left, right) => left.identity.localeCompare(right.identity))
      .map((entry) => ({
        identity: entry.identity,
        factDigest: entry.factDigest,
        fact: entry.fact,
        captures: [...entry.captures].sort(
          (left, right) => left.kernelLogicalSequence - right.kernelLogicalSequence,
        ),
      }));
    const conflictRecords = [...conflicts].sort((left, right) =>
      left.capture.kernelLogicalSequence - right.capture.kernelLogicalSequence
      || left.identity.localeCompare(right.identity));
    return cloneFreeze({
      schemaVersion: 'gateio-economic-ledger-v1' as const,
      uniqueIdentityCount: factRecords.length,
      facts: factRecords,
      conflicts: conflictRecords,
      hasIdentityConflict: conflictRecords.length > 0,
      captureBoundary: boundary === null ? null : {
        kind: 'LOCAL_JOURNAL_SEQUENCE_ONLY' as const,
        lastKernelLogicalSequence: boundary.sequence,
        lastKernelEventId: boundary.eventId,
      },
    });
  }

  return Object.freeze({
    apply,
    snapshot,
    digest: () => sha256(canonicalJSON(snapshot())),
    factDigestForIdentity: (identity: string) => facts.get(identity)?.factDigest ?? null,
    isConflicted: (identity: string) => conflicts.some((entry) => entry.identity === identity),
  });
}

/** Append one canonical fact through TradingKernel, then project its durable envelope locally. */
export function recordGateIoEconomicFact(
  kernel: TradingKernel,
  ledger: GateIoEconomicLedger,
  fact: GateIoCanonicalEconomicEvent,
): GateIoEconomicRecordResult {
  const identity = gateIoEconomicIdentity(fact);
  const factDigest = gateIoEconomicFactDigest(fact);
  const published = kernel.publish(GATEIO_ECONOMIC_EVENT_RECORDED, { fact, factDigest });
  if (published.status === 'duplicate') {
    const existing = ledger.factDigestForIdentity(identity);
    if (existing === null) fail('GATEIO_ECONOMIC_LEDGER_NOT_REPLAYED');
    if (ledger.isConflicted(identity) || existing !== factDigest) {
      return Object.freeze({
        status: 'IDENTITY_CONFLICT', identity, factDigest,
        kernelEventId: published.envelope.kernelEventId,
      });
    }
    return Object.freeze({
      status: 'DUPLICATE_SAME_FACT', identity, factDigest,
      kernelEventId: published.envelope.kernelEventId,
    });
  }
  try {
    const applied = ledger.apply(published.envelope);
    return Object.freeze({
      status: applied.status, identity, factDigest,
      kernelEventId: published.envelope.kernelEventId,
    });
  } catch (error) {
    if (error instanceof GateIoEconomicLedgerError
        && error.code === 'GATEIO_ECONOMIC_IDENTITY_CONFLICT') {
      return Object.freeze({
        status: 'IDENTITY_CONFLICT', identity, factDigest,
        kernelEventId: published.envelope.kernelEventId,
      });
    }
    throw error;
  }
}
