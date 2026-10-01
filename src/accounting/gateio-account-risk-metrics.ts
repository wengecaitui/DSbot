import { createHash } from 'node:crypto';
import type { TradingKernel } from '../kernel/TradingKernel';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import {
  GATEIO_L1A_SCHEMA_VERSION,
  GATEIO_L1A_SOURCE,
  type GateIoCanonicalAccountTruth,
} from '../runtime/gateio/GateIoAuthenticatedReadFoundation';
import { GATEIO_READ_ENDPOINTS } from '../runtime/gateio/GateIoReadContracts';
import {
  ACCOUNT_RISK_METRIC_POLICY_ACTIVATED,
  ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION,
  CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1,
  GATEIO_ACCOUNT_FACT_OBSERVED,
  GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION,
  type AccountRiskMetricPolicy,
  type AccountRiskMetricPolicyActivatedPayload,
  type AccountRiskMetricPolicyRecord,
  type GateIoAccountFactObservedPayload,
  type GateIoAccountMetricFoundationSnapshot,
  type GateIoAccountModeQualification,
  type GateIoAccountObservationRecord,
  type GateIoAccountRiskIdentity,
  type GateIoDurableAccountObservation,
  type QualifiedAccountValueCandidate,
  type QualifiedAccountValueStatus,
} from './gateio-account-risk-metrics-types';

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;
const POLICY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LOCAL_BOUNDARY_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;

export type GateIoAccountMetricFoundationErrorCode =
  | 'GATEIO_ACCOUNT_OBSERVATION_INVALID'
  | 'ACCOUNT_RISK_METRIC_POLICY_INVALID'
  | 'GATEIO_ACCOUNT_OBSERVATION_DIGEST_MISMATCH'
  | 'ACCOUNT_RISK_METRIC_POLICY_DIGEST_MISMATCH'
  | 'GATEIO_ACCOUNT_METRIC_ENVELOPE_INVALID'
  | 'GATEIO_ACCOUNT_OBSERVATION_IDENTITY_CONFLICT'
  | 'ACCOUNT_RISK_METRIC_POLICY_IDENTITY_CONFLICT'
  | 'GATEIO_ACCOUNT_METRIC_EVENT_CONFLICT'
  | 'GATEIO_ACCOUNT_METRIC_REPLAY_ORDER_INVALID';

export class GateIoAccountMetricFoundationError extends Error {
  constructor(readonly code: GateIoAccountMetricFoundationErrorCode) {
    super(code);
    this.name = 'GateIoAccountMetricFoundationError';
  }
}

export interface GateIoAccountMetricFoundation {
  apply(envelope: unknown): 'RECORDED' | 'DUPLICATE_SAME_FACT';
  snapshot(): GateIoAccountMetricFoundationSnapshot;
  digest(): string;
  activePolicyAt(
    expectedIdentity: GateIoAccountRiskIdentity,
    evaluationTime: number,
  ): AccountRiskMetricPolicy | null;
  latestObservationAt(
    expectedIdentity: GateIoAccountRiskIdentity,
    evaluationTime: number,
  ): GateIoDurableAccountObservation | null;
}

function fail(code: GateIoAccountMetricFoundationErrorCode): never {
  throw new GateIoAccountMetricFoundationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  code: GateIoAccountMetricFoundationErrorCode,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
      || Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('GATEIO_ACCOUNT_METRIC_ENVELOPE_INVALID');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail('GATEIO_ACCOUNT_METRIC_ENVELOPE_INVALID');
      sorted[key] = canonicalValue(value[key]);
    }
    return sorted;
  }
  fail('GATEIO_ACCOUNT_METRIC_ENVELOPE_INVALID');
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

function validIdentity(value: unknown): value is GateIoAccountRiskIdentity {
  if (!isRecord(value)) return false;
  return value.exchange === 'gateio' && value.settle === 'USDT'
    && typeof value.accountId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value.accountId);
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function accountModeQualification(
  marginMode: GateIoDurableAccountObservation['marginMode'],
): GateIoAccountModeQualification {
  if (marginMode === 0) return 'SUPPORTED_CLASSIC';
  if (marginMode === null) return 'UNKNOWN_ACCOUNT_MODE';
  return 'UNSUPPORTED_ACCOUNT_MODE';
}

export function validateGateIoDurableAccountObservation(
  value: unknown,
): asserts value is GateIoDurableAccountObservation {
  const code = 'GATEIO_ACCOUNT_OBSERVATION_INVALID' as const;
  if (!isRecord(value)) fail(code);
  exactKeys(value, [
    'schemaVersion', 'exchange', 'settle', 'accountId', 'currency', 'marginMode',
    'accountModeQualification', 'totalExact', 'availableExact', 'unrealisedPnlExact',
    'observedAt', 'serverTime', 'source', 'sourceSchemaVersion', 'captureProvenance',
  ], ['rawPayloadDigest'], code);
  const marginMode = value.marginMode;
  if (value.schemaVersion !== GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION
      || !validIdentity(value) || value.currency !== 'USDT'
      || (marginMode !== null && marginMode !== 0 && marginMode !== 1
        && marginMode !== 2 && marginMode !== 3)
      || value.accountModeQualification !== accountModeQualification(
        marginMode as GateIoDurableAccountObservation['marginMode'],
      )
      || typeof value.totalExact !== 'string' || !EXACT_DECIMAL.test(value.totalExact)
      || typeof value.availableExact !== 'string' || !EXACT_DECIMAL.test(value.availableExact)
      || value.availableExact.startsWith('-')
      || typeof value.unrealisedPnlExact !== 'string'
      || !EXACT_DECIMAL.test(value.unrealisedPnlExact)
      || !Number.isSafeInteger(value.observedAt) || (value.observedAt as number) <= 0
      || !Number.isSafeInteger(value.serverTime) || (value.serverTime as number) <= 0
      || value.source !== GATEIO_L1A_SOURCE
      || value.sourceSchemaVersion !== GATEIO_L1A_SCHEMA_VERSION
      || !isRecord(value.captureProvenance)) fail(code);
  const provenance = value.captureProvenance;
  exactKeys(provenance, ['kind', 'endpoint', 'foundationFreshness'], [], code);
  if (provenance.kind !== 'GATEIO_AUTHENTICATED_ACCOUNT_READ'
      || provenance.endpoint !== GATEIO_READ_ENDPOINTS.ACCOUNTS
      || (provenance.foundationFreshness !== 'FRESH'
        && provenance.foundationFreshness !== 'STALE'
        && provenance.foundationFreshness !== 'UNKNOWN')) fail(code);
  if (Object.prototype.hasOwnProperty.call(value, 'rawPayloadDigest')
      && (typeof value.rawPayloadDigest !== 'string' || !SHA256.test(value.rawPayloadDigest))) {
    fail(code);
  }
}

export function validateAccountRiskMetricPolicy(
  value: unknown,
): asserts value is AccountRiskMetricPolicy {
  const code = 'ACCOUNT_RISK_METRIC_POLICY_INVALID' as const;
  if (!isRecord(value)) fail(code);
  exactKeys(value, [
    'schemaVersion', 'exchange', 'settle', 'accountId', 'policyId', 'policyVersion',
    'effectiveAt', 'accountValueFormula', 'accountObservationMaxAgeMs', 'dayBoundary',
  ], [], code);
  if (value.schemaVersion !== ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION
      || !validIdentity(value) || typeof value.policyId !== 'string' || !POLICY_ID.test(value.policyId)
      || !Number.isSafeInteger(value.policyVersion) || (value.policyVersion as number) <= 0
      || !Number.isSafeInteger(value.effectiveAt) || (value.effectiveAt as number) <= 0
      || value.accountValueFormula !== CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1
      || !Number.isSafeInteger(value.accountObservationMaxAgeMs)
      || (value.accountObservationMaxAgeMs as number) <= 0 || !isRecord(value.dayBoundary)) fail(code);
  exactKeys(value.dayBoundary, ['timezone', 'localBoundaryTime'], [], code);
  if (!validTimezone(value.dayBoundary.timezone)
      || typeof value.dayBoundary.localBoundaryTime !== 'string'
      || !LOCAL_BOUNDARY_TIME.test(value.dayBoundary.localBoundaryTime)) fail(code);
}

export function gateIoAccountObservationIdentity(
  observation: GateIoDurableAccountObservation,
): string {
  validateGateIoDurableAccountObservation(observation);
  return canonicalJSON([
    observation.exchange, observation.settle, observation.accountId, observation.source,
    observation.observedAt,
  ]);
}

export function gateIoAccountObservationId(
  observation: GateIoDurableAccountObservation,
): string {
  return sha256(gateIoAccountObservationIdentity(observation));
}

export function gateIoAccountObservationDigest(
  observation: GateIoDurableAccountObservation,
): string {
  validateGateIoDurableAccountObservation(observation);
  return sha256(canonicalJSON(observation));
}

export function accountRiskMetricPolicyIdentity(policy: AccountRiskMetricPolicy): string {
  validateAccountRiskMetricPolicy(policy);
  return canonicalJSON([
    policy.exchange, policy.settle, policy.accountId, policy.policyId, policy.policyVersion,
  ]);
}

export function accountRiskMetricPolicyDigest(policy: AccountRiskMetricPolicy): string {
  validateAccountRiskMetricPolicy(policy);
  return sha256(canonicalJSON(policy));
}

export function validateGateIoAccountFactObservedPayload(
  value: unknown,
): asserts value is GateIoAccountFactObservedPayload {
  if (!isRecord(value)) fail('GATEIO_ACCOUNT_OBSERVATION_INVALID');
  exactKeys(value, ['observation', 'observationDigest'], [], 'GATEIO_ACCOUNT_OBSERVATION_INVALID');
  validateGateIoDurableAccountObservation(value.observation);
  if (typeof value.observationDigest !== 'string' || !SHA256.test(value.observationDigest)) {
    fail('GATEIO_ACCOUNT_OBSERVATION_INVALID');
  }
  if (value.observationDigest !== gateIoAccountObservationDigest(value.observation)) {
    fail('GATEIO_ACCOUNT_OBSERVATION_DIGEST_MISMATCH');
  }
}

export function validateAccountRiskMetricPolicyActivatedPayload(
  value: unknown,
): asserts value is AccountRiskMetricPolicyActivatedPayload {
  if (!isRecord(value)) fail('ACCOUNT_RISK_METRIC_POLICY_INVALID');
  exactKeys(value, ['policy', 'policyDigest'], [], 'ACCOUNT_RISK_METRIC_POLICY_INVALID');
  validateAccountRiskMetricPolicy(value.policy);
  if (typeof value.policyDigest !== 'string' || !SHA256.test(value.policyDigest)) {
    fail('ACCOUNT_RISK_METRIC_POLICY_INVALID');
  }
  if (value.policyDigest !== accountRiskMetricPolicyDigest(value.policy)) {
    fail('ACCOUNT_RISK_METRIC_POLICY_DIGEST_MISMATCH');
  }
}

export function gateIoDurableAccountObservationFromTruth(
  truth: GateIoCanonicalAccountTruth,
): GateIoDurableAccountObservation {
  if (!truth || truth.identity.exchange !== 'gateio' || truth.identity.settle !== 'USDT'
      || typeof truth.identity.accountId !== 'string' || truth.identity.accountId.length === 0
      || typeof truth.account.totalExact !== 'string'
      || typeof truth.account.availableExact !== 'string'
      || typeof truth.account.unrealizedPnlExact !== 'string') {
    fail('GATEIO_ACCOUNT_OBSERVATION_INVALID');
  }
  const observation = cloneFreeze({
    schemaVersion: GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION,
    exchange: 'gateio' as const,
    settle: 'USDT' as const,
    accountId: truth.identity.accountId,
    currency: 'USDT' as const,
    marginMode: truth.account.marginMode,
    accountModeQualification: accountModeQualification(truth.account.marginMode),
    totalExact: truth.account.totalExact,
    availableExact: truth.account.availableExact,
    unrealisedPnlExact: truth.account.unrealizedPnlExact,
    observedAt: truth.observedAtMs,
    serverTime: truth.serverTimeMs,
    source: GATEIO_L1A_SOURCE,
    sourceSchemaVersion: GATEIO_L1A_SCHEMA_VERSION,
    captureProvenance: {
      kind: 'GATEIO_AUTHENTICATED_ACCOUNT_READ' as const,
      endpoint: GATEIO_READ_ENDPOINTS.ACCOUNTS,
      foundationFreshness: truth.freshness,
    },
  });
  validateGateIoDurableAccountObservation(observation);
  return observation;
}

function validateEnvelope(value: unknown): KernelEventEnvelope {
  if (!isRecord(value)
      || (value.type !== GATEIO_ACCOUNT_FACT_OBSERVED
        && value.type !== ACCOUNT_RISK_METRIC_POLICY_ACTIVATED)
      || typeof value.kernelEventId !== 'string' || !SHA256.test(value.kernelEventId)
      || !Number.isSafeInteger(value.kernelLogicalSequence)
      || (value.kernelLogicalSequence as number) <= 0
      || !Number.isSafeInteger(value.kernelTimestamp) || (value.kernelTimestamp as number) <= 0) {
    fail('GATEIO_ACCOUNT_METRIC_ENVELOPE_INVALID');
  }
  if (value.type === GATEIO_ACCOUNT_FACT_OBSERVED) {
    validateGateIoAccountFactObservedPayload(value.payload);
  } else {
    validateAccountRiskMetricPolicyActivatedPayload(value.payload);
  }
  return value as unknown as KernelEventEnvelope;
}

function sameIdentity(left: GateIoAccountRiskIdentity, right: GateIoAccountRiskIdentity): boolean {
  return left.exchange === right.exchange && left.settle === right.settle
    && left.accountId === right.accountId;
}

export function createGateIoAccountMetricFoundation(): GateIoAccountMetricFoundation {
  const observations = new Map<string, GateIoAccountObservationRecord>();
  const policies = new Map<string, AccountRiskMetricPolicyRecord>();
  const observationConflicts = new Set<string>();
  const policyConflicts = new Set<string>();
  const eventFingerprints = new Map<string, string>();
  let lastSequence: number | null = null;

  function apply(value: unknown): 'RECORDED' | 'DUPLICATE_SAME_FACT' {
    const envelope = validateEnvelope(value);
    const fingerprint = sha256(canonicalJSON(envelope));
    const prior = eventFingerprints.get(envelope.kernelEventId);
    if (prior !== undefined) {
      if (prior !== fingerprint) fail('GATEIO_ACCOUNT_METRIC_EVENT_CONFLICT');
      return 'DUPLICATE_SAME_FACT';
    }
    if (lastSequence !== null && envelope.kernelLogicalSequence <= lastSequence) {
      fail('GATEIO_ACCOUNT_METRIC_REPLAY_ORDER_INVALID');
    }
    eventFingerprints.set(envelope.kernelEventId, fingerprint);
    lastSequence = envelope.kernelLogicalSequence;

    if (envelope.type === GATEIO_ACCOUNT_FACT_OBSERVED) {
      const payload = envelope.payload as GateIoAccountFactObservedPayload;
      const identity = gateIoAccountObservationIdentity(payload.observation);
      const existing = observations.get(identity);
      if (existing === undefined) {
        observations.set(identity, cloneFreeze({
          identity,
          observationId: gateIoAccountObservationId(payload.observation),
          observationDigest: payload.observationDigest,
          observation: payload.observation,
        }));
        return 'RECORDED';
      }
      if (existing.observationDigest === payload.observationDigest
          && !observationConflicts.has(identity)) return 'DUPLICATE_SAME_FACT';
      observationConflicts.add(identity);
      fail('GATEIO_ACCOUNT_OBSERVATION_IDENTITY_CONFLICT');
    }

    const payload = envelope.payload as AccountRiskMetricPolicyActivatedPayload;
    const identity = accountRiskMetricPolicyIdentity(payload.policy);
    const existing = policies.get(identity);
    if (existing === undefined) {
      policies.set(identity, cloneFreeze({
        identity, policyDigest: payload.policyDigest, policy: payload.policy,
      }));
      return 'RECORDED';
    }
    if (existing.policyDigest === payload.policyDigest && !policyConflicts.has(identity)) {
      return 'DUPLICATE_SAME_FACT';
    }
    policyConflicts.add(identity);
    fail('ACCOUNT_RISK_METRIC_POLICY_IDENTITY_CONFLICT');
  }

  function snapshot(): GateIoAccountMetricFoundationSnapshot {
    return cloneFreeze({
      schemaVersion: 'gateio-account-metric-foundation-v1' as const,
      observations: [...observations.values()].sort((left, right) =>
        left.identity.localeCompare(right.identity)),
      policies: [...policies.values()].sort((left, right) =>
        left.policy.effectiveAt - right.policy.effectiveAt
        || left.policy.policyVersion - right.policy.policyVersion
        || left.identity.localeCompare(right.identity)),
      conflictedObservationIdentities: [...observationConflicts].sort(),
      conflictedPolicyIdentities: [...policyConflicts].sort(),
      lastKernelLogicalSequence: lastSequence,
    });
  }

  return Object.freeze({
    apply,
    snapshot,
    digest: () => sha256(canonicalJSON(snapshot())),
    activePolicyAt(expectedIdentity: GateIoAccountRiskIdentity, evaluationTime: number) {
      if (!validIdentity(expectedIdentity) || !Number.isSafeInteger(evaluationTime)
          || evaluationTime <= 0) return null;
      const applicable = [...policies.values()].filter((entry) =>
        sameIdentity(entry.policy, expectedIdentity)
        && entry.policy.effectiveAt <= evaluationTime);
      applicable.sort((left, right) =>
        right.policy.effectiveAt - left.policy.effectiveAt
        || right.policy.policyVersion - left.policy.policyVersion
        || left.policy.policyId.localeCompare(right.policy.policyId));
      const selected = applicable[0];
      return selected === undefined || policyConflicts.has(selected.identity) ? null : selected.policy;
    },
    latestObservationAt(expectedIdentity: GateIoAccountRiskIdentity, evaluationTime: number) {
      if (!validIdentity(expectedIdentity) || !Number.isSafeInteger(evaluationTime)
          || evaluationTime <= 0) return null;
      const applicable = [...observations.values()].filter((entry) =>
        sameIdentity(entry.observation, expectedIdentity)
        && entry.observation.observedAt <= evaluationTime);
      applicable.sort((left, right) =>
        right.observation.observedAt - left.observation.observedAt
        || left.observationId.localeCompare(right.observationId));
      const selected = applicable[0];
      return selected === undefined || observationConflicts.has(selected.identity)
        ? null : selected.observation;
    },
  });
}

export function recordGateIoAccountObservation(
  kernel: TradingKernel,
  foundation: GateIoAccountMetricFoundation,
  observation: GateIoDurableAccountObservation,
): 'RECORDED' | 'DUPLICATE_SAME_FACT' {
  const observationDigest = gateIoAccountObservationDigest(observation);
  const published = kernel.publish(GATEIO_ACCOUNT_FACT_OBSERVED, { observation, observationDigest });
  return foundation.apply(published.envelope);
}

export function activateAccountRiskMetricPolicy(
  kernel: TradingKernel,
  foundation: GateIoAccountMetricFoundation,
  policy: AccountRiskMetricPolicy,
): 'RECORDED' | 'DUPLICATE_SAME_FACT' {
  const policyDigest = accountRiskMetricPolicyDigest(policy);
  const published = kernel.publish(ACCOUNT_RISK_METRIC_POLICY_ACTIVATED, { policy, policyDigest });
  return foundation.apply(published.envelope);
}

interface ExactDecimalValue {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parseExactDecimal(value: string): ExactDecimalValue | null {
  if (!EXACT_DECIMAL.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${negative ? '-' : ''}${integer}${fraction}`);
  return { coefficient, scale: fraction.length };
}

function exactDecimal(value: ExactDecimalValue): string {
  if (value.coefficient === 0n) return '0';
  const negative = value.coefficient < 0n;
  let digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale === 0) return `${negative ? '-' : ''}${digits}`;
  digits = digits.padStart(value.scale + 1, '0');
  const integer = digits.slice(0, -value.scale);
  const fraction = digits.slice(-value.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction.length === 0 ? '' : `.${fraction}`}`;
}

function addExactDecimals(left: string, right: string): string | null {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (a === null || b === null) return null;
  const scale = Math.max(a.scale, b.scale);
  const coefficient = a.coefficient * (10n ** BigInt(scale - a.scale))
    + b.coefficient * (10n ** BigInt(scale - b.scale));
  return exactDecimal({ coefficient, scale });
}

function candidate(
  status: QualifiedAccountValueStatus,
  reasons: readonly string[],
  details: Partial<QualifiedAccountValueCandidate> = {},
): QualifiedAccountValueCandidate {
  return cloneFreeze({
    status,
    valueKind: 'INTERNAL_DERIVED_ACCOUNT_VALUE' as const,
    derivedAccountValueExact: null,
    formula: null,
    observationId: null,
    observedAt: null,
    ageMs: null,
    policyId: null,
    policyVersion: null,
    reasons: [...reasons],
    ...details,
  });
}

export function projectQualifiedAccountValue(input: {
  readonly observation: GateIoDurableAccountObservation | null;
  readonly policy: AccountRiskMetricPolicy | null;
  readonly evaluationTime: number;
  readonly expectedIdentity: GateIoAccountRiskIdentity;
}): QualifiedAccountValueCandidate {
  if (!input || !Number.isSafeInteger(input.evaluationTime) || input.evaluationTime <= 0) {
    return candidate('MALFORMED', ['EVALUATION_TIME_INVALID']);
  }
  if (!validIdentity(input.expectedIdentity)) {
    return candidate('ACCOUNT_IDENTITY_INVALID', ['EXPECTED_ACCOUNT_IDENTITY_INVALID']);
  }
  if (input.policy === null) return candidate('POLICY_UNAVAILABLE', ['POLICY_UNAVAILABLE']);
  try { validateAccountRiskMetricPolicy(input.policy); }
  catch { return candidate('MALFORMED', ['POLICY_MALFORMED']); }
  const policyDetails = {
    policyId: input.policy.policyId,
    policyVersion: input.policy.policyVersion,
  };
  if (!sameIdentity(input.policy, input.expectedIdentity)) {
    return candidate('ACCOUNT_IDENTITY_INVALID', ['POLICY_ACCOUNT_IDENTITY_MISMATCH'], policyDetails);
  }
  if (input.policy.effectiveAt > input.evaluationTime) {
    return candidate('POLICY_UNAVAILABLE', ['POLICY_NOT_EFFECTIVE'], policyDetails);
  }
  if (input.observation === null) {
    return candidate('SOURCE_UNAVAILABLE', ['ACCOUNT_OBSERVATION_UNAVAILABLE'], policyDetails);
  }
  try { validateGateIoDurableAccountObservation(input.observation); }
  catch { return candidate('MALFORMED', ['ACCOUNT_OBSERVATION_MALFORMED'], policyDetails); }
  const observationDetails = {
    ...policyDetails,
    observationId: gateIoAccountObservationId(input.observation),
    observedAt: input.observation.observedAt,
  };
  if (!sameIdentity(input.observation, input.expectedIdentity)) {
    return candidate('ACCOUNT_IDENTITY_INVALID', ['ACCOUNT_OBSERVATION_IDENTITY_MISMATCH'],
      observationDetails);
  }
  if (input.observation.accountModeQualification === 'UNKNOWN_ACCOUNT_MODE') {
    return candidate('ACCOUNT_MODE_UNKNOWN', ['ACCOUNT_MODE_UNKNOWN'], observationDetails);
  }
  if (input.observation.accountModeQualification !== 'SUPPORTED_CLASSIC') {
    return candidate('ACCOUNT_MODE_UNSUPPORTED', ['ACCOUNT_MODE_UNSUPPORTED'], observationDetails);
  }
  const ageMs = input.evaluationTime - input.observation.observedAt;
  if (!Number.isSafeInteger(ageMs) || ageMs < 0) {
    return candidate('MALFORMED', ['OBSERVATION_TIME_AFTER_EVALUATION'], observationDetails);
  }
  if (ageMs > input.policy.accountObservationMaxAgeMs) {
    return candidate('STALE', ['ACCOUNT_OBSERVATION_STALE'], { ...observationDetails, ageMs });
  }
  const derived = addExactDecimals(
    input.observation.totalExact,
    input.observation.unrealisedPnlExact,
  );
  if (derived === null) {
    return candidate('MALFORMED', ['ACCOUNT_MONETARY_FACT_MALFORMED'], {
      ...observationDetails, ageMs,
    });
  }
  return candidate('AVAILABLE', [], {
    ...observationDetails,
    ageMs,
    derivedAccountValueExact: derived,
    formula: CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1,
  });
}
