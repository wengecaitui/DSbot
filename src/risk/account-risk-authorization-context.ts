import { createHash } from 'node:crypto';
import { ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION } from '../accounting/gateio-account-risk-metrics-types';
import { accountRiskSnapshotDigest } from './account-risk-snapshot';
import { ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION } from './account-risk-snapshot-types';
import { riskMandateDigest, validateRiskMandate } from './risk-mandate';
import {
  RISK_MANDATE_SCHEMA_VERSION,
  type RiskMandateResolutionStatus,
  type RiskMandateV1,
} from './risk-mandate-types';
import {
  ACCOUNT_RISK_AUTHORIZATION_CONTEXT_SCHEMA_VERSION,
  type AccountRiskAuthorizationContext,
  type AccountRiskAuthorizationFailure,
  type AccountRiskAuthorizationFailureStatus,
  type AccountRiskAuthorizationMetric,
  type BuildAccountRiskAuthorizationContextInput,
} from './account-risk-authorization-context-types';

const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

const SNAPSHOT_STATUS_FAILURE = Object.freeze({
  POLICY_UNAVAILABLE: 'SNAPSHOT_POLICY_UNAVAILABLE',
  CURRENT_ACCOUNT_VALUE_UNAVAILABLE: 'SNAPSHOT_ACCOUNT_VALUE_UNAVAILABLE',
  PARTIAL_DAY: 'SNAPSHOT_PARTIAL_DAY',
  STALE: 'SNAPSHOT_STALE',
  ACCOUNT_IDENTITY_INVALID: 'SNAPSHOT_IDENTITY_INVALID',
  ACCOUNT_MODE_UNSUPPORTED: 'SNAPSHOT_ACCOUNT_MODE_UNSUPPORTED',
  ECONOMIC_CONFLICT: 'SNAPSHOT_ECONOMIC_CONFLICT',
  UNCLASSIFIED_ECONOMIC_ACTIVITY: 'SNAPSHOT_UNCLASSIFIED_ACTIVITY',
  ECONOMIC_PROJECTION_UNUSABLE: 'SNAPSHOT_ECONOMIC_PROJECTION_UNUSABLE',
  MIXED_VERSION_STATE: 'SNAPSHOT_MIXED_VERSION',
} satisfies Record<string, AccountRiskAuthorizationFailureStatus>);

const MANDATE_STATUS_FAILURE: Readonly<
Partial<Record<RiskMandateResolutionStatus, AccountRiskAuthorizationFailureStatus>>
> = Object.freeze({
  MISSING: 'MANDATE_MISSING',
  NOT_YET_EFFECTIVE: 'MANDATE_NOT_YET_EFFECTIVE',
  DISABLED: 'MANDATE_DISABLED',
  EXPIRED: 'MANDATE_EXPIRED',
  REVOKED: 'MANDATE_REVOKED',
  CONFLICTED: 'MANDATE_CONFLICTED',
});

const FAILURE_ORDER: readonly AccountRiskAuthorizationFailureStatus[] = Object.freeze([
  'EVALUATION_TIME_INVALID',
  'SNAPSHOT_SCHEMA_INVALID',
  'SNAPSHOT_DIGEST_INVALID',
  'SNAPSHOT_EVALUATION_TIME_MISMATCH',
  'SNAPSHOT_STATUS_INVALID',
  'SNAPSHOT_POLICY_UNAVAILABLE',
  'SNAPSHOT_ACCOUNT_VALUE_UNAVAILABLE',
  'SNAPSHOT_PARTIAL_DAY',
  'SNAPSHOT_STALE',
  'SNAPSHOT_IDENTITY_INVALID',
  'SNAPSHOT_ACCOUNT_MODE_UNSUPPORTED',
  'SNAPSHOT_ECONOMIC_CONFLICT',
  'SNAPSHOT_UNCLASSIFIED_ACTIVITY',
  'SNAPSHOT_ECONOMIC_PROJECTION_UNUSABLE',
  'SNAPSHOT_MIXED_VERSION',
  'SNAPSHOT_FRESHNESS_NOT_FRESH',
  'MANDATE_RESOLUTION_INVALID',
  'MANDATE_RESOLUTION_TIME_MISMATCH',
  'MANDATE_MISSING',
  'MANDATE_NOT_YET_EFFECTIVE',
  'MANDATE_DISABLED',
  'MANDATE_EXPIRED',
  'MANDATE_REVOKED',
  'MANDATE_CONFLICTED',
  'MANDATE_SCHEMA_INVALID',
  'MANDATE_DIGEST_INVALID',
  'MANDATE_LIFECYCLE_INVALID',
  'ACCOUNT_IDENTITY_MISMATCH',
  'METRIC_POLICY_SCHEMA_MISMATCH',
  'METRIC_POLICY_ID_MISMATCH',
  'METRIC_POLICY_VERSION_MISMATCH',
  'METRIC_POLICY_DIGEST_MISMATCH',
  'ACCOUNTING_DAY_UNAVAILABLE',
  'ACCOUNT_VALUE_UNAVAILABLE',
  'DAILY_EQUITY_LOSS_UNAVAILABLE',
  'DRAWDOWN_UNAVAILABLE',
]);
const FAILURE_RANK = new Map(FAILURE_ORDER.map((status, index) => [status, index]));

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

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function exactAvailable(field: { readonly availability: string; readonly valueExact: unknown }): boolean {
  return field.availability === 'AVAILABLE'
    && typeof field.valueExact === 'string'
    && EXACT_DECIMAL.test(field.valueExact);
}

function metric(field: { readonly availability: AccountRiskAuthorizationMetric['availability'];
  readonly valueExact: string | null }): AccountRiskAuthorizationMetric {
  return { availability: field.availability, valueExact: field.valueExact };
}

function sameIdentity(snapshot: BuildAccountRiskAuthorizationContextInput['snapshot'], mandate: RiskMandateV1): boolean {
  return snapshot.identity.exchange === mandate.exchange
    && snapshot.identity.settle === mandate.settle
    && snapshot.identity.accountId === mandate.accountId;
}

function snapshotDigestValid(snapshot: BuildAccountRiskAuthorizationContextInput['snapshot']): boolean {
  if (!SHA256.test(snapshot.snapshotDigest)) return false;
  const { snapshotDigest: _claimed, ...withoutDigest } = snapshot;
  return accountRiskSnapshotDigest(withoutDigest) === snapshot.snapshotDigest;
}

function addFailure(
  failures: Map<AccountRiskAuthorizationFailureStatus, string[]>,
  status: AccountRiskAuthorizationFailureStatus,
  reasons: readonly string[] = [],
): void {
  const existing = failures.get(status) ?? [];
  failures.set(status, [...existing, ...reasons]);
}

/**
 * Pure compatibility composition. COMPATIBLE qualifies a coherent evidence set;
 * it never means that any symbol, action, size, or trade intent is authorized.
 */
export function buildAccountRiskAuthorizationContext(
  input: BuildAccountRiskAuthorizationContextInput,
): AccountRiskAuthorizationContext {
  const { snapshot, mandateResolution: resolution, evaluationTime } = input;
  const failures = new Map<AccountRiskAuthorizationFailureStatus, string[]>();
  if (!Number.isSafeInteger(evaluationTime) || evaluationTime <= 0) {
    addFailure(failures, 'EVALUATION_TIME_INVALID');
  }
  if (snapshot.schemaVersion !== ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION) {
    addFailure(failures, 'SNAPSHOT_SCHEMA_INVALID', [`SNAPSHOT_SCHEMA_${snapshot.schemaVersion}`]);
  }
  if (!snapshotDigestValid(snapshot)) addFailure(failures, 'SNAPSHOT_DIGEST_INVALID');
  if (snapshot.evaluation.evaluatedAt !== evaluationTime) {
    addFailure(failures, 'SNAPSHOT_EVALUATION_TIME_MISMATCH');
  }

  if (snapshot.status !== 'QUALIFIED') {
    const mapped = SNAPSHOT_STATUS_FAILURE[
      snapshot.status as keyof typeof SNAPSHOT_STATUS_FAILURE
    ];
    addFailure(failures, mapped ?? 'SNAPSHOT_STATUS_INVALID', snapshot.reasons);
  }
  if (snapshot.evaluation.observationFreshness !== 'FRESH') {
    addFailure(failures, 'SNAPSHOT_FRESHNESS_NOT_FRESH', [
      `OBSERVATION_FRESHNESS_${snapshot.evaluation.observationFreshness}`,
    ]);
  }

  if (resolution.authorityOnly !== true || resolution.tradingAuthorized !== false) {
    addFailure(failures, 'MANDATE_RESOLUTION_INVALID');
  }
  if (resolution.evaluationTime !== evaluationTime) {
    addFailure(failures, 'MANDATE_RESOLUTION_TIME_MISMATCH');
  }
  if (resolution.status !== 'ACTIVE') {
    addFailure(failures, MANDATE_STATUS_FAILURE[resolution.status]
      ?? 'MANDATE_RESOLUTION_INVALID', resolution.reasons);
  }

  const mandate = resolution.mandate;
  let mandateSchemaValid = false;
  if (mandate === null) {
    if (resolution.status === 'ACTIVE') addFailure(failures, 'MANDATE_RESOLUTION_INVALID');
  } else {
    try {
      validateRiskMandate(mandate);
      mandateSchemaValid = mandate.schemaVersion === RISK_MANDATE_SCHEMA_VERSION;
    } catch {
      mandateSchemaValid = false;
    }
    if (!mandateSchemaValid) addFailure(failures, 'MANDATE_SCHEMA_INVALID');
  }

  let computedMandateDigest: string | null = null;
  if (mandate !== null && mandateSchemaValid) computedMandateDigest = riskMandateDigest(mandate);
  if (resolution.mandateDigest === null || !SHA256.test(resolution.mandateDigest)
      || computedMandateDigest === null || resolution.mandateDigest !== computedMandateDigest) {
    addFailure(failures, 'MANDATE_DIGEST_INVALID');
  }
  if (mandate !== null && mandateSchemaValid
      && (resolution.status !== 'ACTIVE' || !mandate.enabled
        || mandate.effectiveAt > evaluationTime || evaluationTime >= mandate.expiresAt)) {
    addFailure(failures, 'MANDATE_LIFECYCLE_INVALID');
  }

  if (mandate !== null && mandateSchemaValid && !sameIdentity(snapshot, mandate)) {
    addFailure(failures, 'ACCOUNT_IDENTITY_MISMATCH');
  }

  const binding = mandate !== null && mandateSchemaValid ? mandate.metricPolicyBinding : null;
  if (binding !== null
      && (binding.accountRiskSnapshotSchemaVersion !== ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION
        || binding.metricPolicySchemaVersion !== ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION)) {
    addFailure(failures, 'METRIC_POLICY_SCHEMA_MISMATCH');
  }
  if (binding !== null && binding.metricPolicyId !== snapshot.policy.policyId) {
    addFailure(failures, 'METRIC_POLICY_ID_MISMATCH');
  }
  if (binding !== null && binding.metricPolicyVersion !== snapshot.policy.policyVersion) {
    addFailure(failures, 'METRIC_POLICY_VERSION_MISMATCH');
  }
  if (binding !== null && binding.metricPolicyDigest !== snapshot.provenance.metricPolicyDigest) {
    addFailure(failures, 'METRIC_POLICY_DIGEST_MISMATCH');
  }
  if (binding === null && mandate !== null) {
    addFailure(failures, 'METRIC_POLICY_SCHEMA_MISMATCH');
  }

  if (typeof snapshot.policy.accountingDayId !== 'string'
      || snapshot.policy.accountingDayId.length === 0) {
    addFailure(failures, 'ACCOUNTING_DAY_UNAVAILABLE');
  }
  const accountValueAvailable = exactAvailable(snapshot.account.derivedAccountValue);
  const dailyLossAvailable = exactAvailable(snapshot.daily.dailyEquityLoss);
  const drawdownAvailable = exactAvailable(snapshot.drawdown.fraction);
  if (!accountValueAvailable) addFailure(failures, 'ACCOUNT_VALUE_UNAVAILABLE');
  if (!dailyLossAvailable) addFailure(failures, 'DAILY_EQUITY_LOSS_UNAVAILABLE');
  if (!drawdownAvailable) addFailure(failures, 'DRAWDOWN_UNAVAILABLE');

  const orderedFailures: AccountRiskAuthorizationFailure[] = [...failures.entries()]
    .map(([status, reasons]) => ({ status, reasons: uniqueSorted(reasons) }))
    .sort((left, right) => FAILURE_RANK.get(left.status)! - FAILURE_RANK.get(right.status)!);
  const compatible = orderedFailures.length === 0;
  const status = compatible ? 'COMPATIBLE' as const : orderedFailures[0]!.status;
  const policyMatched = binding !== null
    && binding.accountRiskSnapshotSchemaVersion === ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION
    && binding.metricPolicySchemaVersion === ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION
    && binding.metricPolicyId === snapshot.policy.policyId
    && binding.metricPolicyVersion === snapshot.policy.policyVersion
    && binding.metricPolicyDigest === snapshot.provenance.metricPolicyDigest;

  const withoutDigest: Omit<AccountRiskAuthorizationContext, 'contextDigest'> = {
    schemaVersion: ACCOUNT_RISK_AUTHORIZATION_CONTEXT_SCHEMA_VERSION,
    evaluationTime,
    status,
    compatible,
    reasons: uniqueSorted(orderedFailures.flatMap((failure) => [
      failure.status, ...failure.reasons,
    ])),
    failures: orderedFailures,
    identity: {
      exchange: snapshot.identity.exchange,
      settle: snapshot.identity.settle,
      accountId: snapshot.identity.accountId,
    },
    snapshot: {
      schemaVersion: snapshot.schemaVersion,
      status: snapshot.status,
      evaluatedAt: snapshot.evaluation.evaluatedAt,
      observationFreshness: snapshot.evaluation.observationFreshness,
      accountingDayId: snapshot.policy.accountingDayId,
      snapshotDigest: snapshot.snapshotDigest,
    },
    mandateResolution: {
      status: resolution.status,
      evaluationTime: resolution.evaluationTime,
      mandate: mandate === null ? null : mandate,
      mandateDigest: resolution.mandateDigest,
    },
    policyBinding: {
      snapshotPolicyId: snapshot.policy.policyId,
      snapshotPolicyVersion: snapshot.policy.policyVersion,
      snapshotPolicyDigest: snapshot.provenance.metricPolicyDigest,
      mandatePolicySchemaVersion: binding?.metricPolicySchemaVersion ?? null,
      mandatePolicyId: binding?.metricPolicyId ?? null,
      mandatePolicyVersion: binding?.metricPolicyVersion ?? null,
      mandatePolicyDigest: binding?.metricPolicyDigest ?? null,
      matched: policyMatched,
    },
    requiredMetrics: {
      accountValue: metric(snapshot.account.derivedAccountValue),
      dailyEquityLoss: metric(snapshot.daily.dailyEquityLoss),
      drawdownFraction: metric(snapshot.drawdown.fraction),
      allAvailable: accountValueAvailable && dailyLossAvailable && drawdownAvailable,
    },
    provenance: {
      snapshotDigest: snapshot.snapshotDigest,
      mandateDigest: resolution.mandateDigest,
      accountObservationDigest: snapshot.provenance.accountObservationDigest,
      metricPolicyDigest: snapshot.provenance.metricPolicyDigest,
      riskMetricsDigest: snapshot.provenance.riskMetricsDigest,
      economicProjectionDigest: snapshot.provenance.economicProjectionDigest,
    },
    qualifiedContextOnly: true,
    tradingAuthorized: false,
  };
  const contextDigest = sha256(canonicalJSON(withoutDigest));
  return cloneFreeze({ ...withoutDigest, contextDigest });
}
