import { createHash } from 'node:crypto';
import type { TradingKernel } from '../kernel/TradingKernel';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import { createGateIoEconomicLedger, GateIoEconomicLedgerError } from './gateio-economic-ledger';
import { projectGateIoEconomicState } from './gateio-economic-projection';
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
  type AcceptedAccountMetricPoint,
  type AccountBoundaryCoverage,
  type AccountRiskMetricStatus,
  type DailyAccountMetricBaseline,
  type GateIoDurableAccountRiskMetricsSnapshot,
} from './gateio-account-risk-metrics-types';
import { GATEIO_ECONOMIC_EVENT_RECORDED } from './gateio-economic-ledger-types';
import type { GateIoEconomicProjection } from './gateio-economic-projection-types';

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

function compareExactDecimals(left: string, right: string): number | null {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (a === null || b === null) return null;
  const scale = Math.max(a.scale, b.scale);
  const leftCoefficient = a.coefficient * (10n ** BigInt(scale - a.scale));
  const rightCoefficient = b.coefficient * (10n ** BigInt(scale - b.scale));
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

function subtractExactDecimals(left: string, right: string): string | null {
  const b = parseExactDecimal(right);
  if (b === null) return null;
  return addExactDecimals(left, exactDecimal({ coefficient: -b.coefficient, scale: b.scale }));
}

function nonNegativeDifference(left: string, right: string): string | null {
  const comparison = compareExactDecimals(left, right);
  if (comparison === null) return null;
  if (comparison <= 0) return '0';
  return subtractExactDecimals(left, right);
}

const DRAWDOWN_FRACTION_SCALE = 18 as const;

function divideExactDecimals(
  numerator: string,
  denominator: string,
  scale = DRAWDOWN_FRACTION_SCALE,
): string | null {
  const a = parseExactDecimal(numerator);
  const b = parseExactDecimal(denominator);
  if (a === null || b === null || b.coefficient <= 0n) return null;
  const dividend = a.coefficient * (10n ** BigInt(scale + b.scale));
  const divisor = b.coefficient * (10n ** BigInt(a.scale));
  let quotient = dividend / divisor;
  const remainder = dividend % divisor;
  if (remainder * 2n >= divisor) quotient += 1n;
  return exactDecimal({ coefficient: quotient, scale });
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
  if (input.observation.captureProvenance.foundationFreshness === 'STALE') {
    return candidate('STALE', ['ACCOUNT_FOUNDATION_REPORTED_STALE'], observationDetails);
  }
  if (input.observation.captureProvenance.foundationFreshness !== 'FRESH') {
    return candidate('SOURCE_UNAVAILABLE', ['ACCOUNT_FOUNDATION_FRESHNESS_UNKNOWN'],
      observationDetails);
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

export interface GateIoDurableAccountRiskMetricProjector {
  apply(envelope: unknown): 'RECORDED' | 'DUPLICATE_SAME_FACT';
  snapshot(
    expectedIdentity: GateIoAccountRiskIdentity,
    evaluationTime: number,
  ): GateIoDurableAccountRiskMetricsSnapshot;
  digest(): string;
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function zonedParts(timestamp: number, timezone: string): ZonedParts | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(timestamp);
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((entry) => entry.type === type)?.value);
    const result = {
      year: value('year'), month: value('month'), day: value('day'),
      hour: value('hour'), minute: value('minute'), second: value('second'),
    };
    return Object.values(result).every(Number.isSafeInteger) ? result : null;
  } catch {
    return null;
  }
}

function dateKey(parts: Pick<ZonedParts, 'year' | 'month' | 'day'>): string {
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}`
    + `-${parts.day.toString().padStart(2, '0')}`;
}

function shiftUtcDate(date: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${shifted.getUTCFullYear().toString().padStart(4, '0')}`
    + `-${(shifted.getUTCMonth() + 1).toString().padStart(2, '0')}`
    + `-${shifted.getUTCDate().toString().padStart(2, '0')}`;
}

function localDateTimeEpoch(
  date: string,
  localBoundaryTime: string,
  timezone: string,
): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const time = /^(\d{2}):(\d{2}):(\d{2})$/.exec(localBoundaryTime);
  if (match === null || time === null) return null;
  const target = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(time[1]), minute: Number(time[2]), second: Number(time[3]),
  };
  const targetAsUtc = Date.UTC(
    target.year, target.month - 1, target.day, target.hour, target.minute, target.second,
  );
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour += 6) {
    const probe = targetAsUtc + hour * 60 * 60 * 1_000;
    const parts = zonedParts(probe, timezone);
    if (parts !== null) {
      offsets.add(Date.UTC(
        parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
      ) - probe);
    }
  }
  const candidates = [...offsets]
    .map((offset) => targetAsUtc - offset)
    .filter((candidate) => {
      const parts = zonedParts(candidate, timezone);
      return parts !== null && Object.entries(target).every(
        ([key, value]) => parts[key as keyof ZonedParts] === value,
      );
    })
    .sort((left, right) => left - right);
  // A repeated DST wall time chooses the earlier instant deterministically.
  // A skipped wall time has no candidate and is fail-closed as coverage unknown.
  return candidates[0] ?? null;
}

function accountingDay(
  policy: AccountRiskMetricPolicy,
  timestamp: number,
): { id: string; localDate: string; boundaryAt: number | null } | null {
  const parts = zonedParts(timestamp, policy.dayBoundary.timezone);
  if (parts === null) return null;
  const localTime = `${parts.hour.toString().padStart(2, '0')}`
    + `:${parts.minute.toString().padStart(2, '0')}`
    + `:${parts.second.toString().padStart(2, '0')}`;
  let localDate = dateKey(parts);
  if (localTime < policy.dayBoundary.localBoundaryTime) {
    const prior = shiftUtcDate(localDate, -1);
    if (prior === null) return null;
    localDate = prior;
  }
  const boundaryAt = localDateTimeEpoch(
    localDate, policy.dayBoundary.localBoundaryTime, policy.dayBoundary.timezone,
  );
  const id = canonicalJSON([
    policy.exchange, policy.settle, policy.accountId, policy.policyId, policy.policyVersion,
    policy.effectiveAt, policy.dayBoundary.timezone, policy.dayBoundary.localBoundaryTime, localDate,
  ]);
  return { id, localDate, boundaryAt };
}

function metricEpochId(policy: AccountRiskMetricPolicy): string {
  return sha256(canonicalJSON([
    policy.exchange, policy.settle, policy.accountId, policy.policyId, policy.policyVersion,
    policy.effectiveAt, policy.accountValueFormula, policy.accountObservationMaxAgeMs,
    policy.dayBoundary.timezone, policy.dayBoundary.localBoundaryTime,
  ]));
}

function economicHealth(projection: GateIoEconomicProjection): {
  readonly status: AccountRiskMetricStatus;
  readonly reasons: readonly string[];
} {
  if (projection.identityConflictCount > 0 || projection.completenessStatus === 'CONFLICTED') {
    return { status: 'ECONOMIC_CONFLICT', reasons: ['ECONOMIC_IDENTITY_CONFLICT'] };
  }
  if (projection.unclassifiedEventCount > 0
      || projection.completenessStatus === 'UNCLASSIFIED_PRESENT') {
    return {
      status: 'UNCLASSIFIED_ECONOMIC_ACTIVITY',
      reasons: ['UNCLASSIFIED_ECONOMIC_ACTIVITY_PRESENT'],
    };
  }
  if (projection.balanceStatus === 'AMBIGUOUS_TERMINAL_ORDER') {
    return {
      status: 'CURRENT_VALUE_UNAVAILABLE',
      reasons: ['ECONOMIC_TERMINAL_BALANCE_AMBIGUOUS'],
    };
  }
  if (!projection.projectionUsableForObservedAccounting) {
    return { status: 'CURRENT_VALUE_UNAVAILABLE', reasons: ['ECONOMIC_PROJECTION_UNUSABLE'] };
  }
  return { status: 'AVAILABLE', reasons: [] };
}

function statusFromCandidate(candidateValue: QualifiedAccountValueCandidate): AccountRiskMetricStatus {
  switch (candidateValue.status) {
    case 'POLICY_UNAVAILABLE': return 'POLICY_UNAVAILABLE';
    case 'STALE': return 'STALE';
    case 'ACCOUNT_IDENTITY_INVALID': return 'IDENTITY_INVALID';
    case 'ACCOUNT_MODE_UNSUPPORTED':
    case 'ACCOUNT_MODE_UNKNOWN': return 'UNSUPPORTED_ACCOUNT_MODE';
    default: return 'CURRENT_VALUE_UNAVAILABLE';
  }
}

function dailyBaseline(
  policy: AccountRiskMetricPolicy,
  day: { id: string; boundaryAt: number | null },
  epochPoints: readonly AcceptedAccountMetricPoint[],
  evaluationTime: number,
): DailyAccountMetricBaseline {
  const common = {
    accountingDayId: day.id,
    boundaryAt: day.boundaryAt,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
  };
  if (day.boundaryAt === null) {
    return cloneFreeze({
      ...common, status: 'COVERAGE_UNKNOWN' as const, coverage: 'COVERAGE_UNKNOWN' as const,
      valueExact: null, sourceObservationId: null, qualifiedAt: null,
      reasons: ['LOCAL_BOUNDARY_INSTANT_UNRESOLVABLE'],
    });
  }
  const after = epochPoints.filter((point) =>
    point.observedAt >= day.boundaryAt! && point.observedAt <= evaluationTime)
    .sort((left, right) => left.observedAt - right.observedAt
      || left.observationId.localeCompare(right.observationId))[0];
  const before = epochPoints.filter((point) => point.observedAt <= day.boundaryAt!)
    .sort((left, right) => right.observedAt - left.observedAt
      || left.observationId.localeCompare(right.observationId))[0];
  const full = policy.effectiveAt <= day.boundaryAt
    && before !== undefined && after !== undefined
    && day.boundaryAt - before.observedAt <= policy.accountObservationMaxAgeMs
    && after.observedAt - day.boundaryAt <= policy.accountObservationMaxAgeMs
    && after.observedAt - before.observedAt <= policy.accountObservationMaxAgeMs;
  if (!full) {
    const reasons = ['DAY_OPEN_VALUE_NOT_PROVEN'];
    if (policy.effectiveAt > day.boundaryAt) reasons.push('POLICY_EPOCH_STARTED_AFTER_BOUNDARY');
    if (before === undefined) reasons.push('PRE_BOUNDARY_OBSERVATION_MISSING');
    if (after === undefined) reasons.push('POST_BOUNDARY_OBSERVATION_MISSING');
    if (before !== undefined && after !== undefined
        && after.observedAt - before.observedAt > policy.accountObservationMaxAgeMs) {
      reasons.push('BOUNDARY_OBSERVATION_GAP_EXCEEDS_POLICY_FRESHNESS');
    }
    return cloneFreeze({
      ...common, status: 'PARTIAL_DAY' as const,
      coverage: 'PARTIAL_DAY_BOOTSTRAP' as AccountBoundaryCoverage,
      valueExact: null, sourceObservationId: null, qualifiedAt: null, reasons,
    });
  }
  return cloneFreeze({
    ...common, status: 'AVAILABLE' as const,
    coverage: 'FULL_BOUNDARY_COVERAGE' as AccountBoundaryCoverage,
    valueExact: after.derivedAccountValueExact,
    sourceObservationId: after.observationId,
    qualifiedAt: after.observedAt,
    reasons: [],
  });
}

/**
 * Replays only canonical durable R1/R2B1 facts. Derived metrics are rebuilt from
 * event order; no checkpoint and no last-write-wins metric record is required.
 */
export function createGateIoDurableAccountRiskMetricProjector():
GateIoDurableAccountRiskMetricProjector {
  const foundation = createGateIoAccountMetricFoundation();
  const economicLedger = createGateIoEconomicLedger();
  const accepted = new Map<string, AcceptedAccountMetricPoint>();
  const eventFingerprints = new Map<string, string>();
  const accountFoundationFailureReasons = new Set<string>();
  const economicFailureReasons = new Set<string>();
  let lastSequence: number | null = null;

  function apply(value: unknown): 'RECORDED' | 'DUPLICATE_SAME_FACT' {
    if (!isRecord(value) || typeof value.kernelEventId !== 'string'
        || !SHA256.test(value.kernelEventId)
        || !Number.isSafeInteger(value.kernelLogicalSequence)
        || (value.kernelLogicalSequence as number) <= 0
        || (value.type !== GATEIO_ECONOMIC_EVENT_RECORDED
          && value.type !== GATEIO_ACCOUNT_FACT_OBSERVED
          && value.type !== ACCOUNT_RISK_METRIC_POLICY_ACTIVATED)) {
      fail('GATEIO_ACCOUNT_METRIC_ENVELOPE_INVALID');
    }
    const fingerprint = sha256(canonicalJSON(value));
    const prior = eventFingerprints.get(value.kernelEventId);
    if (prior !== undefined) {
      if (prior !== fingerprint) fail('GATEIO_ACCOUNT_METRIC_EVENT_CONFLICT');
      return 'DUPLICATE_SAME_FACT';
    }
    if (lastSequence !== null && (value.kernelLogicalSequence as number) <= lastSequence) {
      fail('GATEIO_ACCOUNT_METRIC_REPLAY_ORDER_INVALID');
    }
    eventFingerprints.set(value.kernelEventId, fingerprint);
    lastSequence = value.kernelLogicalSequence as number;

    if (value.type === GATEIO_ECONOMIC_EVENT_RECORDED) {
      try { economicLedger.apply(value); }
      catch (error) {
        if (error instanceof GateIoEconomicLedgerError
            && error.code === 'GATEIO_ECONOMIC_IDENTITY_CONFLICT') return 'RECORDED';
        economicFailureReasons.add(error instanceof Error ? error.message : 'ECONOMIC_STATE_MALFORMED');
        throw error;
      }
      return 'RECORDED';
    }

    let result: 'RECORDED' | 'DUPLICATE_SAME_FACT';
    try { result = foundation.apply(value); }
    catch (error) {
      if (error instanceof GateIoAccountMetricFoundationError
          && (error.code === 'GATEIO_ACCOUNT_OBSERVATION_IDENTITY_CONFLICT'
            || error.code === 'ACCOUNT_RISK_METRIC_POLICY_IDENTITY_CONFLICT')) {
        accountFoundationFailureReasons.add(error.code);
      }
      throw error;
    }
    if (value.type !== GATEIO_ACCOUNT_FACT_OBSERVED || result !== 'RECORDED') return result;
    const observation = (value.payload as unknown as GateIoAccountFactObservedPayload).observation;
    const policy = foundation.activePolicyAt(observation, observation.observedAt);
    const health = economicHealth(projectGateIoEconomicState(economicLedger.snapshot()));
    const qualified = projectQualifiedAccountValue({
      observation, policy, evaluationTime: observation.observedAt, expectedIdentity: observation,
    });
    if (health.status === 'AVAILABLE' && economicFailureReasons.size === 0
        && accountFoundationFailureReasons.size === 0
        && qualified.status === 'AVAILABLE' && policy !== null
        && observation.observedAt >= policy.effectiveAt
        && qualified.derivedAccountValueExact !== null && qualified.observationId !== null) {
      accepted.set(qualified.observationId, cloneFreeze({
        kernelLogicalSequence: value.kernelLogicalSequence as number,
        observationId: qualified.observationId,
        observedAt: observation.observedAt,
        derivedAccountValueExact: qualified.derivedAccountValueExact,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        policyEffectiveAt: policy.effectiveAt,
        epochId: metricEpochId(policy),
      }));
    }
    return result;
  }

  function snapshot(
    expectedIdentity: GateIoAccountRiskIdentity,
    evaluationTime: number,
  ): GateIoDurableAccountRiskMetricsSnapshot {
    const policy = foundation.activePolicyAt(expectedIdentity, evaluationTime);
    const base = {
      schemaVersion: 'gateio-durable-account-risk-metrics-v1' as const,
      evaluatedAt: evaluationTime,
      accountingDayId: null,
      activePolicyId: policy?.policyId ?? null,
      activePolicyVersion: policy?.policyVersion ?? null,
      metricEpochId: policy === null ? null : metricEpochId(policy),
      currentQualifiedAccountValueExact: null,
      baseline: null,
      dailyEquityLossExact: null,
      epochHighWaterExact: null,
      drawdownAbsoluteExact: null,
      drawdownFractionExact: null,
      drawdownFractionScale: DRAWDOWN_FRACTION_SCALE,
      drawdownFractionRounding: 'ROUND_HALF_UP' as const,
      acceptedMetricPoints: [] as readonly AcceptedAccountMetricPoint[],
      historicalStateRetained: false,
      lastKernelLogicalSequence: lastSequence,
    };
    if (!Number.isSafeInteger(evaluationTime) || evaluationTime <= 0 || !validIdentity(expectedIdentity)) {
      return cloneFreeze({ ...base, status: 'IDENTITY_INVALID' as const,
        reasons: ['EVALUATION_OR_ACCOUNT_IDENTITY_INVALID'] });
    }
    if (policy === null) {
      const policyState = foundation.snapshot();
      const sameAccountPolicy = policyState.policies.some((entry) =>
        sameIdentity(entry.policy, expectedIdentity));
      const anyPolicy = policyState.policies.length > 0;
      return cloneFreeze({ ...base,
        status: anyPolicy && !sameAccountPolicy
          ? 'IDENTITY_INVALID' as const : 'POLICY_UNAVAILABLE' as const,
        reasons: [...accountFoundationFailureReasons, anyPolicy && !sameAccountPolicy
          ? 'NO_POLICY_FOR_EXPECTED_ACCOUNT_IDENTITY' : 'POLICY_UNAVAILABLE_OR_CONFLICTED'],
      });
    }
    const epochId = metricEpochId(policy);
    const points = [...accepted.values()].filter((point) =>
      point.epochId === epochId && point.observedAt <= evaluationTime)
      .sort((left, right) => left.observedAt - right.observedAt
        || left.observationId.localeCompare(right.observationId));
    let highWater: string | null = null;
    for (const point of points) {
      if (highWater === null || compareExactDecimals(point.derivedAccountValueExact, highWater) === 1) {
        highWater = point.derivedAccountValueExact;
      }
    }
    const day = accountingDay(policy, evaluationTime);
    const baseline = day === null ? null : dailyBaseline(policy, day, points, evaluationTime);
    const historical = highWater !== null || baseline?.valueExact !== null;
    const withHistory = {
      ...base,
      accountingDayId: day?.id ?? null,
      metricEpochId: epochId,
      baseline,
      epochHighWaterExact: highWater,
      acceptedMetricPoints: points,
      historicalStateRetained: historical,
    };
    if (accountFoundationFailureReasons.size > 0) {
      return cloneFreeze({
        ...withHistory,
        status: 'IDENTITY_INVALID' as const,
        reasons: [...accountFoundationFailureReasons].sort(),
      });
    }
    if (economicFailureReasons.size > 0) {
      return cloneFreeze({
        ...withHistory,
        status: 'CURRENT_VALUE_UNAVAILABLE' as const,
        reasons: ['ECONOMIC_STATE_MALFORMED', ...economicFailureReasons].sort(),
      });
    }
    const projection = projectGateIoEconomicState(economicLedger.snapshot());
    const health = economicHealth(projection);
    if (health.status !== 'AVAILABLE') {
      return cloneFreeze({ ...withHistory, status: health.status, reasons: health.reasons });
    }
    const observation = foundation.latestObservationAt(expectedIdentity, evaluationTime);
    const current = projectQualifiedAccountValue({
      observation, policy, evaluationTime, expectedIdentity,
    });
    if (current.status !== 'AVAILABLE' || current.derivedAccountValueExact === null
        || current.observationId === null) {
      return cloneFreeze({ ...withHistory, status: statusFromCandidate(current),
        reasons: current.reasons });
    }
    if (!accepted.has(current.observationId)) {
      return cloneFreeze({ ...withHistory, status: 'CURRENT_VALUE_UNAVAILABLE' as const,
        reasons: ['CURRENT_OBSERVATION_NOT_ACCEPTED_UNDER_VALID_ECONOMIC_HEALTH'] });
    }
    if (day === null || baseline === null) {
      return cloneFreeze({ ...withHistory, status: 'COVERAGE_UNKNOWN' as const,
        reasons: ['ACCOUNTING_DAY_UNRESOLVABLE'] });
    }
    if (baseline.status !== 'AVAILABLE' || baseline.valueExact === null) {
      return cloneFreeze({ ...withHistory,
        status: baseline.status === 'COVERAGE_UNKNOWN' ? 'COVERAGE_UNKNOWN' as const
          : 'PARTIAL_DAY' as const,
        reasons: baseline.reasons,
        currentQualifiedAccountValueExact: current.derivedAccountValueExact,
      });
    }
    const dailyLoss = nonNegativeDifference(
      baseline.valueExact, current.derivedAccountValueExact,
    );
    const drawdown = highWater === null ? null
      : nonNegativeDifference(highWater, current.derivedAccountValueExact);
    const fraction = highWater === null || drawdown === null
      || compareExactDecimals(highWater, '0') !== 1
      ? null : divideExactDecimals(drawdown, highWater);
    const reasons = fraction === null && highWater !== null
      ? ['DRAWDOWN_FRACTION_UNAVAILABLE_NON_POSITIVE_HIGH_WATER'] : [];
    return cloneFreeze({
      ...withHistory,
      status: 'AVAILABLE' as const,
      reasons,
      currentQualifiedAccountValueExact: current.derivedAccountValueExact,
      dailyEquityLossExact: dailyLoss,
      drawdownAbsoluteExact: drawdown,
      drawdownFractionExact: fraction,
    });
  }

  return Object.freeze({
    apply,
    snapshot,
    digest: () => sha256(canonicalJSON({
      foundation: foundation.snapshot(),
      economic: economicLedger.snapshot(),
      accountFoundationFailureReasons: [...accountFoundationFailureReasons].sort(),
      economicFailureReasons: [...economicFailureReasons].sort(),
      accepted: [...accepted.values()].sort((left, right) =>
        left.kernelLogicalSequence - right.kernelLogicalSequence),
      lastSequence,
    })),
  });
}
