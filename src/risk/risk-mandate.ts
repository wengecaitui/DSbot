import { createHash } from 'node:crypto';
import {
  ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION,
} from '../accounting/gateio-account-risk-metrics-types';
import { ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION } from './account-risk-snapshot-types';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import {
  RISK_ACTION_EFFECTS,
  RISK_MANDATE_ACTIVATED,
  RISK_MANDATE_REVOKED,
  RISK_MANDATE_REVOCATION_SCHEMA_VERSION,
  RISK_MANDATE_SCHEMA_VERSION,
  RISK_MANDATE_STORE_SCHEMA_VERSION,
  type RiskMandateAccountIdentity,
  type RiskMandateActivatedPayload,
  type RiskMandateApplyResult,
  type RiskMandateConflict,
  type RiskMandateConflictKind,
  type RiskMandateEventCapture,
  type RiskMandateHumanApprovalProvenance,
  type RiskMandateProjector,
  type RiskMandateResolution,
  type RiskMandateRevocationRecord,
  type RiskMandateRevocationV1,
  type RiskMandateRevokedPayload,
  type RiskMandateStoreSnapshot,
  type RiskMandateV1,
  type RiskMandateVersionRecord,
} from './risk-mandate-types';

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._-]*\/[A-Z0-9][A-Z0-9._-]*$/;
const CANONICAL_NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const MAX_DECIMAL_LENGTH = 128;
const ACTION_ORDER = new Map(RISK_ACTION_EFFECTS.map((value, index) => [value, index]));

type MandateEnvelope = KernelEventEnvelope<
  typeof RISK_MANDATE_ACTIVATED | typeof RISK_MANDATE_REVOKED
>;

interface MutableMandateRecord {
  identity: string;
  mandateDigest: string;
  mandate: RiskMandateV1;
  activation: RiskMandateEventCapture;
  revocation: RiskMandateRevocationRecord | null;
}

export type RiskMandateErrorCode =
  | 'RISK_MANDATE_INVALID'
  | 'RISK_MANDATE_DIGEST_MISMATCH'
  | 'RISK_MANDATE_REVOCATION_INVALID'
  | 'RISK_MANDATE_REVOCATION_DIGEST_MISMATCH'
  | 'RISK_MANDATE_EVENT_INVALID'
  | 'RISK_MANDATE_ACCOUNT_IDENTITY_MISMATCH'
  | 'RISK_MANDATE_KERNEL_EVENT_CONFLICT'
  | 'RISK_MANDATE_REPLAY_ORDER_INVALID'
  | 'RISK_MANDATE_STREAM_CONFLICT'
  | 'RISK_MANDATE_VERSION_CONFLICT'
  | 'RISK_MANDATE_VERSION_ORDER_CONFLICT'
  | 'RISK_MANDATE_REVOCATION_CONFLICT'
  | 'RISK_MANDATE_REVOCATION_TARGET_DIGEST_MISMATCH'
  | 'RISK_MANDATE_CONFLICTED_EVENT'
  | 'RISK_MANDATE_EVALUATION_TIME_INVALID';

export class RiskMandateError extends Error {
  constructor(readonly code: RiskMandateErrorCode) {
    super(code);
    this.name = 'RiskMandateError';
    Object.setPrototypeOf(this, RiskMandateError.prototype);
  }
}

function fail(code: RiskMandateErrorCode): never {
  throw new RiskMandateError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  code: RiskMandateErrorCode,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) fail(code);
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

function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

function nonEmptyText(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.trim() === value
    && value.length > 0 && value.length <= maxLength;
}

function validIdentity(value: unknown): value is RiskMandateAccountIdentity {
  return isRecord(value)
    && value.exchange === 'gateio'
    && value.settle === 'USDT'
    && typeof value.accountId === 'string'
    && ACCOUNT_ID.test(value.accountId);
}

function sameIdentity(
  left: RiskMandateAccountIdentity,
  right: RiskMandateAccountIdentity,
): boolean {
  return left.exchange === right.exchange
    && left.settle === right.settle
    && left.accountId === right.accountId;
}

function validateProvenance(
  value: unknown,
  latestAllowedApprovalTime: number,
  code: RiskMandateErrorCode,
): asserts value is RiskMandateHumanApprovalProvenance {
  if (!isRecord(value)) fail(code);
  exactKeys(value, ['authorityType', 'actorId', 'approvalReference', 'approvedAt', 'source'], code);
  if (value.authorityType !== 'HUMAN_OPERATOR'
      || !nonEmptyText(value.actorId, 128)
      || !nonEmptyText(value.approvalReference, 256)
      || !Number.isSafeInteger(value.approvedAt) || (value.approvedAt as number) <= 0
      || (value.approvedAt as number) > latestAllowedApprovalTime
      || !nonEmptyText(value.source, 128)) fail(code);
}

function validCanonicalPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_DECIMAL_LENGTH
    && CANONICAL_NON_NEGATIVE_DECIMAL.test(value)
    && value !== '0';
}

function validUnitFraction(value: unknown): value is string {
  return validCanonicalPositiveDecimal(value)
    && (value === '1' || value.startsWith('0.'));
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateCanonicalArray<T extends string>(
  value: unknown,
  itemValid: (entry: unknown) => entry is T,
  compare: (left: T, right: T) => number,
  code: RiskMandateErrorCode,
): asserts value is readonly T[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(itemValid)) fail(code);
  const expected = [...value].sort(compare);
  if (new Set(value).size !== value.length
      || value.some((entry, index) => entry !== expected[index])) fail(code);
}

export function validateRiskMandateAccountIdentity(
  value: unknown,
): asserts value is RiskMandateAccountIdentity {
  if (!validIdentity(value)) fail('RISK_MANDATE_ACCOUNT_IDENTITY_MISMATCH');
  exactKeys(value as unknown as Record<string, unknown>,
    ['exchange', 'settle', 'accountId'], 'RISK_MANDATE_ACCOUNT_IDENTITY_MISMATCH');
}

export function validateRiskMandate(value: unknown): asserts value is RiskMandateV1 {
  const code = 'RISK_MANDATE_INVALID' as const;
  if (!isRecord(value)) fail(code);
  exactKeys(value, [
    'schemaVersion', 'mandateId', 'mandateVersion', 'exchange', 'settle', 'accountId',
    'effectiveAt', 'expiresAt', 'enabled', 'allowedSymbols', 'allowedActionEffects',
    'limits', 'metricPolicyBinding', 'provenance',
  ], code);
  if (value.schemaVersion !== RISK_MANDATE_SCHEMA_VERSION
      || !validIdentity(value)
      || typeof value.mandateId !== 'string' || !IDENTIFIER.test(value.mandateId)
      || !Number.isSafeInteger(value.mandateVersion) || (value.mandateVersion as number) <= 0
      || !Number.isSafeInteger(value.effectiveAt) || (value.effectiveAt as number) <= 0
      || !Number.isSafeInteger(value.expiresAt)
      || (value.expiresAt as number) <= (value.effectiveAt as number)
      || typeof value.enabled !== 'boolean') fail(code);

  validateCanonicalArray(
    value.allowedSymbols,
    (entry): entry is string => typeof entry === 'string' && SYMBOL.test(entry),
    compareCanonicalText,
    code,
  );
  validateCanonicalArray(
    value.allowedActionEffects,
    (entry): entry is (typeof RISK_ACTION_EFFECTS)[number] =>
      typeof entry === 'string' && ACTION_ORDER.has(entry as (typeof RISK_ACTION_EFFECTS)[number]),
    (left, right) => ACTION_ORDER.get(left)! - ACTION_ORDER.get(right)!,
    code,
  );

  if (!isRecord(value.limits)) fail(code);
  exactKeys(value.limits, [
    'maxSinglePositionFractionExact', 'maxSinglePositionNotionalExact',
    'maxDailyEquityLossExact', 'maxDrawdownFractionExact',
  ], code);
  if (!validUnitFraction(value.limits.maxSinglePositionFractionExact)
      || !validCanonicalPositiveDecimal(value.limits.maxSinglePositionNotionalExact)
      || !validCanonicalPositiveDecimal(value.limits.maxDailyEquityLossExact)
      || !validUnitFraction(value.limits.maxDrawdownFractionExact)) fail(code);

  if (!isRecord(value.metricPolicyBinding)) fail(code);
  exactKeys(value.metricPolicyBinding, [
    'accountRiskSnapshotSchemaVersion', 'metricPolicySchemaVersion', 'metricPolicyId',
    'metricPolicyVersion', 'metricPolicyDigest',
  ], code);
  if (value.metricPolicyBinding.accountRiskSnapshotSchemaVersion
        !== ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION
      || value.metricPolicyBinding.metricPolicySchemaVersion
        !== ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION
      || typeof value.metricPolicyBinding.metricPolicyId !== 'string'
      || !IDENTIFIER.test(value.metricPolicyBinding.metricPolicyId)
      || !Number.isSafeInteger(value.metricPolicyBinding.metricPolicyVersion)
      || (value.metricPolicyBinding.metricPolicyVersion as number) <= 0
      || typeof value.metricPolicyBinding.metricPolicyDigest !== 'string'
      || !SHA256.test(value.metricPolicyBinding.metricPolicyDigest)) fail(code);

  validateProvenance(value.provenance, value.effectiveAt as number, code);
}

export function riskMandateIdentity(mandate: RiskMandateV1): string {
  validateRiskMandate(mandate);
  return canonicalJSON([
    mandate.exchange, mandate.settle, mandate.accountId,
    mandate.mandateId, mandate.mandateVersion,
  ]);
}

export function riskMandateDigest(mandate: RiskMandateV1): string {
  validateRiskMandate(mandate);
  return sha256(canonicalJSON(mandate));
}

export function validateRiskMandateRevocation(
  value: unknown,
): asserts value is RiskMandateRevocationV1 {
  const code = 'RISK_MANDATE_REVOCATION_INVALID' as const;
  if (!isRecord(value)) fail(code);
  exactKeys(value, [
    'schemaVersion', 'exchange', 'settle', 'accountId', 'mandateId', 'mandateVersion',
    'mandateDigest', 'revokedAt', 'reason', 'provenance',
  ], code);
  if (value.schemaVersion !== RISK_MANDATE_REVOCATION_SCHEMA_VERSION
      || !validIdentity(value)
      || typeof value.mandateId !== 'string' || !IDENTIFIER.test(value.mandateId)
      || !Number.isSafeInteger(value.mandateVersion) || (value.mandateVersion as number) <= 0
      || typeof value.mandateDigest !== 'string' || !SHA256.test(value.mandateDigest)
      || !Number.isSafeInteger(value.revokedAt) || (value.revokedAt as number) <= 0
      || !nonEmptyText(value.reason, 512)) fail(code);
  validateProvenance(value.provenance, value.revokedAt as number, code);
}

export function riskMandateRevocationIdentity(revocation: RiskMandateRevocationV1): string {
  validateRiskMandateRevocation(revocation);
  return canonicalJSON([
    revocation.exchange, revocation.settle, revocation.accountId,
    revocation.mandateId, revocation.mandateVersion,
  ]);
}

export function riskMandateRevocationDigest(revocation: RiskMandateRevocationV1): string {
  validateRiskMandateRevocation(revocation);
  return sha256(canonicalJSON(revocation));
}

export function validateRiskMandateActivatedPayload(
  value: unknown,
): asserts value is RiskMandateActivatedPayload {
  if (!isRecord(value)) fail('RISK_MANDATE_INVALID');
  exactKeys(value, ['mandate', 'mandateDigest'], 'RISK_MANDATE_INVALID');
  validateRiskMandate(value.mandate);
  if (typeof value.mandateDigest !== 'string' || !SHA256.test(value.mandateDigest)) {
    fail('RISK_MANDATE_INVALID');
  }
  if (value.mandateDigest !== riskMandateDigest(value.mandate)) {
    fail('RISK_MANDATE_DIGEST_MISMATCH');
  }
}

export function validateRiskMandateRevokedPayload(
  value: unknown,
): asserts value is RiskMandateRevokedPayload {
  if (!isRecord(value)) fail('RISK_MANDATE_REVOCATION_INVALID');
  exactKeys(value, ['revocation', 'revocationDigest'], 'RISK_MANDATE_REVOCATION_INVALID');
  validateRiskMandateRevocation(value.revocation);
  if (typeof value.revocationDigest !== 'string' || !SHA256.test(value.revocationDigest)) {
    fail('RISK_MANDATE_REVOCATION_INVALID');
  }
  if (value.revocationDigest !== riskMandateRevocationDigest(value.revocation)) {
    fail('RISK_MANDATE_REVOCATION_DIGEST_MISMATCH');
  }
}

function validateEnvelope(value: unknown): MandateEnvelope {
  if (!isRecord(value)
      || (value.type !== RISK_MANDATE_ACTIVATED && value.type !== RISK_MANDATE_REVOKED)
      || typeof value.kernelEventId !== 'string' || !SHA256.test(value.kernelEventId)
      || !Number.isSafeInteger(value.kernelLogicalSequence)
      || (value.kernelLogicalSequence as number) <= 0
      || !Number.isSafeInteger(value.kernelTimestamp)
      || (value.kernelTimestamp as number) <= 0) fail('RISK_MANDATE_EVENT_INVALID');
  if (value.type === RISK_MANDATE_ACTIVATED) {
    validateRiskMandateActivatedPayload(value.payload);
  } else {
    validateRiskMandateRevokedPayload(value.payload);
  }
  return value as unknown as MandateEnvelope;
}

function capture(envelope: MandateEnvelope): RiskMandateEventCapture {
  return cloneFreeze({
    kernelEventId: envelope.kernelEventId,
    kernelLogicalSequence: envelope.kernelLogicalSequence,
    kernelTimestamp: envelope.kernelTimestamp,
  });
}

function streamIdentity(value: RiskMandateAccountIdentity, mandateId: string): string {
  return canonicalJSON([value.exchange, value.settle, value.accountId, mandateId]);
}

export function createRiskMandateProjector(
  expectedIdentity: RiskMandateAccountIdentity,
): RiskMandateProjector {
  validateRiskMandateAccountIdentity(expectedIdentity);
  const boundIdentity = cloneFreeze(expectedIdentity);
  const activations = new Map<number, MutableMandateRecord>();
  const revocations = new Map<number, RiskMandateRevocationRecord>();
  const eventFingerprints = new Map<string, string>();
  const conflictedEventIds = new Set<string>();
  const conflicts: RiskMandateConflict[] = [];
  let activeMandateId: string | null = null;
  let boundary: { sequence: number; eventId: string } | null = null;

  function addConflict(
    kind: RiskMandateConflictKind,
    identity: string,
    acceptedDigest: string | null,
    conflictingDigest: string,
    eventCapture: RiskMandateEventCapture,
    eventId: string,
  ): void {
    conflicts.push(cloneFreeze({
      kind, identity, acceptedDigest, conflictingDigest, capture: eventCapture,
    }));
    conflictedEventIds.add(eventId);
  }

  function assertBound(value: RiskMandateAccountIdentity): void {
    if (!sameIdentity(value, boundIdentity)) fail('RISK_MANDATE_ACCOUNT_IDENTITY_MISMATCH');
  }

  function assertStream(
    mandateId: string,
    factDigest: string,
    eventCapture: RiskMandateEventCapture,
    eventId: string,
  ): void {
    if (activeMandateId === null) {
      activeMandateId = mandateId;
      return;
    }
    if (activeMandateId !== mandateId) {
      addConflict('MANDATE_STREAM_CONFLICT', streamIdentity(boundIdentity, mandateId), null,
        factDigest, eventCapture, eventId);
      fail('RISK_MANDATE_STREAM_CONFLICT');
    }
  }

  function apply(value: unknown): RiskMandateApplyResult {
    const envelope = validateEnvelope(value);
    if (envelope.type === RISK_MANDATE_ACTIVATED) {
      assertBound((envelope.payload as RiskMandateActivatedPayload).mandate);
    } else {
      assertBound((envelope.payload as RiskMandateRevokedPayload).revocation);
    }
    const eventCapture = capture(envelope);
    const fingerprint = sha256(canonicalJSON(envelope));
    const priorFingerprint = eventFingerprints.get(envelope.kernelEventId);
    if (priorFingerprint !== undefined) {
      if (priorFingerprint !== fingerprint) {
        addConflict('KERNEL_EVENT_CONFLICT', envelope.kernelEventId, priorFingerprint,
          fingerprint, eventCapture, envelope.kernelEventId);
        fail('RISK_MANDATE_KERNEL_EVENT_CONFLICT');
      }
      if (conflictedEventIds.has(envelope.kernelEventId)) fail('RISK_MANDATE_CONFLICTED_EVENT');
      if (envelope.type === RISK_MANDATE_ACTIVATED) {
        const payload = envelope.payload as RiskMandateActivatedPayload;
        return cloneFreeze({ status: 'DUPLICATE_SAME_FACT',
          identity: riskMandateIdentity(payload.mandate), factDigest: payload.mandateDigest });
      }
      const payload = envelope.payload as RiskMandateRevokedPayload;
      return cloneFreeze({ status: 'DUPLICATE_SAME_FACT',
        identity: riskMandateRevocationIdentity(payload.revocation),
        factDigest: payload.revocationDigest });
    }
    if (boundary !== null && envelope.kernelLogicalSequence <= boundary.sequence) {
      fail('RISK_MANDATE_REPLAY_ORDER_INVALID');
    }
    eventFingerprints.set(envelope.kernelEventId, fingerprint);
    boundary = { sequence: envelope.kernelLogicalSequence, eventId: envelope.kernelEventId };

    if (envelope.type === RISK_MANDATE_ACTIVATED) {
      const payload = envelope.payload as RiskMandateActivatedPayload;
      const mandate = payload.mandate;
      const identity = riskMandateIdentity(mandate);
      assertStream(mandate.mandateId, payload.mandateDigest, eventCapture, envelope.kernelEventId);
      const existing = activations.get(mandate.mandateVersion);
      if (existing !== undefined) {
        if (existing.mandateDigest === payload.mandateDigest) {
          return cloneFreeze({ status: 'DUPLICATE_SAME_FACT', identity,
            factDigest: payload.mandateDigest });
        }
        addConflict('MANDATE_VERSION_CONFLICT', identity, existing.mandateDigest,
          payload.mandateDigest, eventCapture, envelope.kernelEventId);
        fail('RISK_MANDATE_VERSION_CONFLICT');
      }
      const orderConflict = [...activations.values()].find((record) =>
        (record.mandate.mandateVersion < mandate.mandateVersion
          && record.mandate.effectiveAt > mandate.effectiveAt)
        || (record.mandate.mandateVersion > mandate.mandateVersion
          && record.mandate.effectiveAt < mandate.effectiveAt));
      if (orderConflict !== undefined) {
        addConflict('MANDATE_VERSION_ORDER_CONFLICT', identity, orderConflict.mandateDigest,
          payload.mandateDigest, eventCapture, envelope.kernelEventId);
        fail('RISK_MANDATE_VERSION_ORDER_CONFLICT');
      }
      const pendingRevocation = revocations.get(mandate.mandateVersion) ?? null;
      if (pendingRevocation !== null
          && pendingRevocation.revocation.mandateDigest !== payload.mandateDigest) {
        addConflict('REVOCATION_TARGET_DIGEST_MISMATCH', identity,
          pendingRevocation.revocation.mandateDigest, payload.mandateDigest,
          eventCapture, envelope.kernelEventId);
        fail('RISK_MANDATE_REVOCATION_TARGET_DIGEST_MISMATCH');
      }
      activations.set(mandate.mandateVersion, {
        identity,
        mandateDigest: payload.mandateDigest,
        mandate: cloneFreeze(mandate),
        activation: eventCapture,
        revocation: pendingRevocation,
      });
      return cloneFreeze({ status: 'ACTIVATED', identity, factDigest: payload.mandateDigest });
    }

    const payload = envelope.payload as RiskMandateRevokedPayload;
    const revocation = payload.revocation;
    const identity = riskMandateRevocationIdentity(revocation);
    assertStream(revocation.mandateId, payload.revocationDigest,
      eventCapture, envelope.kernelEventId);
    const existingActivation = activations.get(revocation.mandateVersion);
    if (existingActivation !== undefined
        && existingActivation.mandateDigest !== revocation.mandateDigest) {
      addConflict('REVOCATION_TARGET_DIGEST_MISMATCH', identity,
        existingActivation.mandateDigest, revocation.mandateDigest,
        eventCapture, envelope.kernelEventId);
      fail('RISK_MANDATE_REVOCATION_TARGET_DIGEST_MISMATCH');
    }
    const existingRevocation = revocations.get(revocation.mandateVersion);
    if (existingRevocation !== undefined) {
      if (existingRevocation.revocationDigest === payload.revocationDigest) {
        return cloneFreeze({ status: 'DUPLICATE_SAME_FACT', identity,
          factDigest: payload.revocationDigest });
      }
      addConflict('REVOCATION_CONFLICT', identity, existingRevocation.revocationDigest,
        payload.revocationDigest, eventCapture, envelope.kernelEventId);
      fail('RISK_MANDATE_REVOCATION_CONFLICT');
    }
    const record = cloneFreeze({
      revocationDigest: payload.revocationDigest,
      revocation,
      capture: eventCapture,
    });
    revocations.set(revocation.mandateVersion, record);
    if (existingActivation !== undefined) existingActivation.revocation = record;
    return cloneFreeze({ status: 'REVOKED', identity, factDigest: payload.revocationDigest });
  }

  function resolution(
    status: RiskMandateResolution['status'],
    evaluationTime: number,
    record: MutableMandateRecord | null,
    reasons: readonly string[],
  ): RiskMandateResolution {
    return cloneFreeze({
      status,
      evaluationTime,
      mandate: record?.mandate ?? null,
      mandateDigest: record?.mandateDigest ?? null,
      reasons: [...reasons].sort(),
      authorityOnly: true as const,
      tradingAuthorized: false as const,
    });
  }

  function resolve(evaluationTime: number): RiskMandateResolution {
    if (!Number.isSafeInteger(evaluationTime) || evaluationTime <= 0) {
      fail('RISK_MANDATE_EVALUATION_TIME_INVALID');
    }
    if (conflicts.length > 0) {
      return resolution('CONFLICTED', evaluationTime, null,
        [...new Set(conflicts.map((entry) => entry.kind))]);
    }
    const records = [...activations.values()];
    if (records.length === 0) {
      return resolution('MISSING', evaluationTime, null,
        revocations.size > 0 ? ['ACTIVATION_MISSING_WITH_PENDING_REVOCATION'] : ['MANDATE_MISSING']);
    }
    const applicable = records.filter((record) => record.mandate.effectiveAt <= evaluationTime)
      .sort((left, right) => right.mandate.mandateVersion - left.mandate.mandateVersion);
    if (applicable.length === 0) {
      const next = [...records].sort((left, right) =>
        left.mandate.effectiveAt - right.mandate.effectiveAt
        || right.mandate.mandateVersion - left.mandate.mandateVersion)[0]!;
      return resolution('NOT_YET_EFFECTIVE', evaluationTime, next, ['MANDATE_NOT_YET_EFFECTIVE']);
    }
    const selected = applicable[0]!;
    if (selected.revocation !== null
        && selected.revocation.revocation.revokedAt <= evaluationTime) {
      return resolution('REVOKED', evaluationTime, selected, ['MANDATE_REVOKED']);
    }
    if (!selected.mandate.enabled) {
      return resolution('DISABLED', evaluationTime, selected, ['MANDATE_DISABLED']);
    }
    if (evaluationTime >= selected.mandate.expiresAt) {
      return resolution('EXPIRED', evaluationTime, selected, ['MANDATE_EXPIRED']);
    }
    return resolution('ACTIVE', evaluationTime, selected, []);
  }

  function snapshot(): RiskMandateStoreSnapshot {
    const versions: RiskMandateVersionRecord[] = [...activations.values()]
      .sort((left, right) => left.mandate.mandateVersion - right.mandate.mandateVersion)
      .map((record) => ({
        identity: record.identity,
        mandateDigest: record.mandateDigest,
        mandate: record.mandate,
        activation: record.activation,
        revocation: record.revocation,
      }));
    const pendingRevocations = [...revocations.entries()]
      .filter(([version]) => !activations.has(version))
      .map(([, record]) => record)
      .sort((left, right) =>
        left.revocation.mandateVersion - right.revocation.mandateVersion);
    return cloneFreeze({
      schemaVersion: RISK_MANDATE_STORE_SCHEMA_VERSION,
      expectedIdentity: boundIdentity,
      mandateId: activeMandateId,
      versions,
      pendingRevocations,
      conflicts: [...conflicts].sort((left, right) =>
        left.capture.kernelLogicalSequence - right.capture.kernelLogicalSequence
        || compareCanonicalText(left.identity, right.identity)),
      hasConflict: conflicts.length > 0,
      replayBoundary: boundary === null ? null : {
        kind: 'LOCAL_JOURNAL_SEQUENCE_ONLY' as const,
        lastKernelLogicalSequence: boundary.sequence,
        lastKernelEventId: boundary.eventId,
      },
    });
  }

  return Object.freeze({
    apply,
    resolve,
    snapshot,
    digest: () => sha256(canonicalJSON(snapshot())),
  });
}
