import { createHash } from 'node:crypto';
import {
  accountRiskMetricPolicyDigest,
  gateIoAccountObservationDigest,
  gateIoAccountObservationId,
  projectQualifiedAccountValue,
} from '../accounting/gateio-account-risk-metrics';
import type {
  AccountRiskMetricStatus,
  GateIoAccountRiskIdentity,
  GateIoDurableAccountRiskMetricsSnapshot,
  QualifiedAccountValueCandidate,
} from '../accounting/gateio-account-risk-metrics-types';
import type { GateIoEconomicProjection } from '../accounting/gateio-economic-projection-types';
import {
  ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION,
  type AccountRiskExactField,
  type AccountRiskFieldAvailability,
  type AccountRiskSnapshotStatus,
  type AccountRiskSnapshotV1,
  type BuildAccountRiskSnapshotInput,
} from './account-risk-snapshot-types';

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
  return createHash('sha256').update(value).digest('hex');
}

function cloneFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) cloneFreeze(entry);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) cloneFreeze(entry);
    return Object.freeze(value);
  }
  return value;
}

function sameIdentity(
  value: GateIoAccountRiskIdentity,
  expected: GateIoAccountRiskIdentity,
): boolean {
  return value.exchange === expected.exchange
    && value.settle === expected.settle
    && value.accountId === expected.accountId;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function exactField(
  availability: AccountRiskFieldAvailability,
  valueExact: string | null,
  reasons: readonly string[] = [],
): AccountRiskExactField {
  return cloneFreeze({ availability, valueExact, reasons: uniqueSorted(reasons) });
}

function metricsDigest(metrics: GateIoDurableAccountRiskMetricsSnapshot): string {
  return sha256(canonicalJSON(metrics));
}

function economicDigest(projection: GateIoEconomicProjection): string {
  return sha256(canonicalJSON(projection));
}

export function accountRiskSnapshotDigest(
  snapshot: Omit<AccountRiskSnapshotV1, 'snapshotDigest'>,
): string {
  return sha256(canonicalJSON(snapshot));
}

function statusFromMetrics(status: AccountRiskMetricStatus): AccountRiskSnapshotStatus {
  switch (status) {
    case 'AVAILABLE': return 'QUALIFIED';
    case 'PARTIAL_DAY': return 'PARTIAL_DAY';
    case 'POLICY_UNAVAILABLE': return 'POLICY_UNAVAILABLE';
    case 'STALE': return 'STALE';
    case 'IDENTITY_INVALID': return 'ACCOUNT_IDENTITY_INVALID';
    case 'UNSUPPORTED_ACCOUNT_MODE': return 'ACCOUNT_MODE_UNSUPPORTED';
    case 'ECONOMIC_CONFLICT': return 'ECONOMIC_CONFLICT';
    case 'UNCLASSIFIED_ECONOMIC_ACTIVITY': return 'UNCLASSIFIED_ECONOMIC_ACTIVITY';
    case 'CURRENT_VALUE_UNAVAILABLE':
    case 'COVERAGE_UNKNOWN':
      return 'CURRENT_ACCOUNT_VALUE_UNAVAILABLE';
  }
}

function statusFromCandidate(
  candidate: QualifiedAccountValueCandidate,
): AccountRiskSnapshotStatus | null {
  switch (candidate.status) {
    case 'AVAILABLE': return null;
    case 'POLICY_UNAVAILABLE': return 'POLICY_UNAVAILABLE';
    case 'STALE': return 'STALE';
    case 'ACCOUNT_IDENTITY_INVALID': return 'ACCOUNT_IDENTITY_INVALID';
    case 'ACCOUNT_MODE_UNSUPPORTED':
    case 'ACCOUNT_MODE_UNKNOWN': return 'ACCOUNT_MODE_UNSUPPORTED';
    case 'MALFORMED':
    case 'SOURCE_UNAVAILABLE': return 'CURRENT_ACCOUNT_VALUE_UNAVAILABLE';
  }
}

function projectionStatus(projection: GateIoEconomicProjection):
AccountRiskSnapshotV1['economicHealth']['projectionStatus'] {
  if (projection.identityConflictCount > 0 || projection.completenessStatus === 'CONFLICTED') {
    return 'CONFLICTED';
  }
  if (projection.unclassifiedEventCount > 0
      || projection.completenessStatus === 'UNCLASSIFIED_PRESENT') {
    return 'UNCLASSIFIED_PRESENT';
  }
  if (!projection.projectionUsableForObservedAccounting
      || projection.balanceStatus === 'AMBIGUOUS_TERMINAL_ORDER') return 'UNUSABLE';
  return 'USABLE_OBSERVED_SCOPE';
}

function mixedStateReasons(input: BuildAccountRiskSnapshotInput, observationId: string | null): string[] {
  const { metricPolicy: policy, riskMetrics: metrics, evaluationTime } = input;
  const reasons: string[] = [];
  if (metrics.evaluatedAt !== evaluationTime) reasons.push('MIXED_EVALUATION_TIME');
  if (policy !== null) {
    if (metrics.activePolicyId !== policy.policyId
        || metrics.activePolicyVersion !== policy.policyVersion) {
      reasons.push('MIXED_POLICY_VERSION');
    }
    if (metrics.baseline !== null
        && (metrics.baseline.policyId !== policy.policyId
          || metrics.baseline.policyVersion !== policy.policyVersion)) {
      reasons.push('MIXED_BASELINE_POLICY_VERSION');
    }
  } else if (metrics.activePolicyId !== null || metrics.activePolicyVersion !== null) {
    reasons.push('MISSING_POLICY_FOR_VERSIONED_METRICS');
  }
  if (metrics.baseline !== null
      && metrics.accountingDayId !== metrics.baseline.accountingDayId) {
    reasons.push('MIXED_ACCOUNTING_DAY_CONTEXT');
  }
  const currentPoint = observationId === null ? undefined
    : metrics.acceptedMetricPoints.find((point) => point.observationId === observationId);
  if (currentPoint !== undefined && policy !== null) {
    if (currentPoint.policyId !== policy.policyId
        || currentPoint.policyVersion !== policy.policyVersion
        || currentPoint.policyEffectiveAt !== policy.effectiveAt
        || currentPoint.epochId !== metrics.metricEpochId) {
      reasons.push('MIXED_METRIC_EPOCH');
    }
  }
  return reasons;
}

function upstreamEconomicStatus(projection: GateIoEconomicProjection): AccountRiskSnapshotStatus | null {
  const status = projectionStatus(projection);
  if (status === 'CONFLICTED') return 'ECONOMIC_CONFLICT';
  if (status === 'UNCLASSIFIED_PRESENT') return 'UNCLASSIFIED_ECONOMIC_ACTIVITY';
  if (status === 'UNUSABLE') return 'ECONOMIC_PROJECTION_UNUSABLE';
  return null;
}

/**
 * Pure R2C composition. It consumes only verified R1/R2B1/R2B2 objects and an
 * explicit evaluation time. It neither persists a snapshot nor authorizes trading.
 */
export function buildAccountRiskSnapshot(
  input: BuildAccountRiskSnapshotInput,
): AccountRiskSnapshotV1 {
  const { expectedIdentity, accountObservation: observation, metricPolicy: policy,
    riskMetrics: metrics, economicProjection: economic, evaluationTime } = input;
  const evaluationValid = Number.isSafeInteger(evaluationTime) && evaluationTime > 0;
  const observationId = observation === null ? null : gateIoAccountObservationId(observation);
  const observationDigest = observation === null ? null : gateIoAccountObservationDigest(observation);
  const policyDigest = policy === null ? null : accountRiskMetricPolicyDigest(policy);
  const identityReasons: string[] = [];
  if (!evaluationValid) identityReasons.push('EVALUATION_TIME_INVALID');
  if (observation !== null && !sameIdentity(observation, expectedIdentity)) {
    identityReasons.push('ACCOUNT_OBSERVATION_IDENTITY_MISMATCH');
  }
  if (policy !== null && !sameIdentity(policy, expectedIdentity)) {
    identityReasons.push('METRIC_POLICY_IDENTITY_MISMATCH');
  }
  if (economic.provenance.exchange !== expectedIdentity.exchange
      || economic.provenance.settle.toUpperCase() !== expectedIdentity.settle) {
    identityReasons.push('ECONOMIC_PROJECTION_VENUE_IDENTITY_MISMATCH');
  }

  const candidate = projectQualifiedAccountValue({
    observation,
    policy,
    evaluationTime,
    expectedIdentity,
  });
  const mixedReasons = mixedStateReasons(input, observationId);
  if (candidate.derivedAccountValueExact !== null
      && metrics.currentQualifiedAccountValueExact !== null
      && candidate.derivedAccountValueExact !== metrics.currentQualifiedAccountValueExact) {
    mixedReasons.push('MIXED_CURRENT_ACCOUNT_VALUE');
  }
  if ((metrics.status === 'AVAILABLE' || metrics.status === 'PARTIAL_DAY')
      && observationId !== null
      && !metrics.acceptedMetricPoints.some((point) => point.observationId === observationId)) {
    mixedReasons.push('CURRENT_OBSERVATION_NOT_IN_METRIC_PROVENANCE');
  }

  const economicStatus = upstreamEconomicStatus(economic);
  const candidateStatus = statusFromCandidate(candidate);
  let status: AccountRiskSnapshotStatus;
  let reasons: string[];
  if (identityReasons.length > 0) {
    status = 'ACCOUNT_IDENTITY_INVALID';
    reasons = identityReasons;
  } else if (mixedReasons.length > 0) {
    status = 'MIXED_VERSION_STATE';
    reasons = mixedReasons;
  } else if (observation !== null
      && observation.accountModeQualification !== 'SUPPORTED_CLASSIC') {
    status = 'ACCOUNT_MODE_UNSUPPORTED';
    reasons = ['ACCOUNT_MODE_NOT_SUPPORTED_CLASSIC'];
  } else if (economicStatus !== null) {
    status = economicStatus;
    reasons = economic.completenessReasons.length > 0
      ? [...economic.completenessReasons] : ['ECONOMIC_PROJECTION_NOT_USABLE'];
  } else if (observation?.captureProvenance.foundationFreshness === 'STALE') {
    status = 'STALE';
    reasons = ['ACCOUNT_OBSERVATION_PROVENANCE_STALE'];
  } else if (candidateStatus !== null) {
    status = candidateStatus;
    reasons = [...candidate.reasons];
  } else {
    status = statusFromMetrics(metrics.status);
    reasons = [...metrics.reasons];
  }

  const currentAuthority = status === 'QUALIFIED' || status === 'PARTIAL_DAY';
  const qualifiedCurrent = currentAuthority ? metrics.currentQualifiedAccountValueExact : null;
  if (currentAuthority && qualifiedCurrent === null) {
    status = 'MIXED_VERSION_STATE';
    reasons = [...reasons, 'CURRENT_AUTHORITY_WITHOUT_QUALIFIED_VALUE'];
  }
  const finalCurrentAuthority = status === 'QUALIFIED' || status === 'PARTIAL_DAY';
  const currentUnavailableReasons = finalCurrentAuthority ? [] : ['CURRENT_AUTHORITY_UNAVAILABLE'];
  const historicalAvailability: AccountRiskFieldAvailability =
    finalCurrentAuthority ? 'AVAILABLE' : 'HISTORICAL_ONLY';
  const baseline = metrics.baseline;
  const baselineAvailable = baseline?.status === 'AVAILABLE' && baseline.valueExact !== null;
  const dailyLossAvailable = status === 'QUALIFIED' && metrics.dailyEquityLossExact !== null;
  const drawdownAvailable = status === 'QUALIFIED';
  const accountModeQualification: AccountRiskSnapshotV1['identity']['accountModeQualification'] =
    observation?.accountModeQualification ?? 'UNAVAILABLE';

  const withoutDigest: Omit<AccountRiskSnapshotV1, 'snapshotDigest'> = {
    schemaVersion: ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION,
    identity: {
      exchange: expectedIdentity.exchange,
      settle: expectedIdentity.settle,
      accountId: expectedIdentity.accountId,
      accountMode: observation?.marginMode ?? null,
      accountModeQualification,
    },
    evaluation: {
      evaluatedAt: evaluationTime,
      accountObservationId: observationId,
      accountObservedAt: observation?.observedAt ?? null,
      observationAgeMs: observation === null || !evaluationValid
        ? null : evaluationTime - observation.observedAt,
      observationFreshness: observation === null ? 'UNAVAILABLE' as const
        : candidate.status === 'STALE' ? 'STALE' as const
          : observation.captureProvenance.foundationFreshness,
    },
    policy: {
      policyId: policy?.policyId ?? null,
      policyVersion: policy?.policyVersion ?? null,
      policyEffectiveAt: policy?.effectiveAt ?? null,
      accountValueFormula: policy?.accountValueFormula ?? null,
      accountingDayId: metrics.accountingDayId,
    },
    account: {
      derivedAccountValue: exactField(
        finalCurrentAuthority ? 'AVAILABLE' : 'UNAVAILABLE',
        finalCurrentAuthority ? metrics.currentQualifiedAccountValueExact : null,
        currentUnavailableReasons,
      ),
      available: exactField(
        finalCurrentAuthority ? 'AVAILABLE' : 'UNAVAILABLE',
        finalCurrentAuthority ? observation?.availableExact ?? null : null,
        currentUnavailableReasons,
      ),
      unrealisedPnl: exactField(
        finalCurrentAuthority ? 'AVAILABLE' : 'UNAVAILABLE',
        finalCurrentAuthority ? observation?.unrealisedPnlExact ?? null : null,
        currentUnavailableReasons,
      ),
    },
    daily: {
      baselineStatus: baseline?.status ?? 'UNAVAILABLE',
      baseline: exactField(
        baselineAvailable ? historicalAvailability : 'UNAVAILABLE',
        baselineAvailable ? baseline.valueExact : null,
        baseline?.reasons ?? ['DAILY_BASELINE_UNAVAILABLE'],
      ),
      dailyEquityLoss: exactField(
        dailyLossAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
        dailyLossAvailable ? metrics.dailyEquityLossExact : null,
        dailyLossAvailable ? [] : ['DAILY_EQUITY_LOSS_UNAVAILABLE'],
      ),
    },
    drawdown: {
      epochId: metrics.metricEpochId,
      highWater: exactField(
        metrics.epochHighWaterExact === null ? 'UNAVAILABLE' : historicalAvailability,
        metrics.epochHighWaterExact,
        metrics.epochHighWaterExact === null ? ['EPOCH_HIGH_WATER_UNAVAILABLE'] : [],
      ),
      absolute: exactField(
        drawdownAvailable && metrics.drawdownAbsoluteExact !== null ? 'AVAILABLE' : 'UNAVAILABLE',
        drawdownAvailable ? metrics.drawdownAbsoluteExact : null,
        drawdownAvailable && metrics.drawdownAbsoluteExact !== null
          ? [] : ['CURRENT_DRAWDOWN_UNAVAILABLE'],
      ),
      fraction: exactField(
        drawdownAvailable && metrics.drawdownFractionExact !== null ? 'AVAILABLE' : 'UNAVAILABLE',
        drawdownAvailable ? metrics.drawdownFractionExact : null,
        drawdownAvailable && metrics.drawdownFractionExact !== null
          ? [] : ['CURRENT_DRAWDOWN_FRACTION_UNAVAILABLE'],
      ),
      fractionScale: metrics.drawdownFractionScale,
      fractionRounding: metrics.drawdownFractionRounding,
    },
    economicHealth: {
      projectionStatus: projectionStatus(economic),
      projectionUsableForObservedAccounting: economic.projectionUsableForObservedAccounting,
      identityConflictCount: economic.identityConflictCount,
      unclassifiedEventCount: economic.unclassifiedEventCount,
      untrackedObservedActivityCount: economic.untrackedObservedActivityCount,
      notExplainedByTrackedEvidenceCount: economic.notExplainedByTrackedEvidenceCount,
      trackedExecutionAttributionStatus: economic.trackedExecutionAttribution.status,
      accountActivityReconciled: 'UNAVAILABLE' as const,
    },
    provenance: {
      accountObservationDigest: observationDigest,
      metricPolicyDigest: policyDigest,
      riskMetricsDigest: metricsDigest(metrics),
      economicProjectionDigest: economicDigest(economic),
      riskMetricsSchemaVersion: metrics.schemaVersion,
      economicProjectionSchemaVersion: economic.schemaVersion,
      economicLedgerSchemaVersion: economic.provenance.ledgerSchemaVersion,
      economicHistoryScope: economic.provenance.historyScope,
      lastKernelLogicalSequence: metrics.lastKernelLogicalSequence,
    },
    status,
    reasons: uniqueSorted(reasons),
  };
  const snapshotDigest = accountRiskSnapshotDigest(withoutDigest);
  return cloneFreeze({ ...withoutDigest, snapshotDigest });
}
