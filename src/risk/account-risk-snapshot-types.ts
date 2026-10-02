import type {
  AccountRiskMetricPolicy,
  GateIoAccountRiskIdentity,
  GateIoDurableAccountObservation,
  GateIoDurableAccountRiskMetricsSnapshot,
} from '../accounting/gateio-account-risk-metrics-types';
import type { GateIoEconomicProjection } from '../accounting/gateio-economic-projection-types';
import type { GateIoAccountMarginMode } from '../runtime/gateio/GateIoAuthenticatedReadFoundation';

export const ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION = 'account-risk-snapshot-v1' as const;

export type AccountRiskSnapshotStatus =
  | 'QUALIFIED'
  | 'POLICY_UNAVAILABLE'
  | 'CURRENT_ACCOUNT_VALUE_UNAVAILABLE'
  | 'PARTIAL_DAY'
  | 'STALE'
  | 'ACCOUNT_IDENTITY_INVALID'
  | 'ACCOUNT_MODE_UNSUPPORTED'
  | 'ECONOMIC_CONFLICT'
  | 'UNCLASSIFIED_ECONOMIC_ACTIVITY'
  | 'ECONOMIC_PROJECTION_UNUSABLE'
  | 'MIXED_VERSION_STATE';

export type AccountRiskFieldAvailability =
  | 'AVAILABLE'
  | 'HISTORICAL_ONLY'
  | 'UNAVAILABLE';

export interface AccountRiskExactField {
  readonly availability: AccountRiskFieldAvailability;
  readonly valueExact: string | null;
  readonly reasons: readonly string[];
}

export interface AccountRiskSnapshotV1 {
  readonly schemaVersion: typeof ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION;
  readonly identity: Readonly<{
    exchange: 'gateio';
    settle: 'USDT';
    accountId: string;
    accountMode: GateIoAccountMarginMode | null;
    accountModeQualification:
      GateIoDurableAccountObservation['accountModeQualification'] | 'UNAVAILABLE';
  }>;
  readonly evaluation: Readonly<{
    evaluatedAt: number;
    accountObservationId: string | null;
    accountObservedAt: number | null;
    observationAgeMs: number | null;
    observationFreshness: 'FRESH' | 'STALE' | 'UNKNOWN' | 'UNAVAILABLE';
  }>;
  readonly policy: Readonly<{
    policyId: string | null;
    policyVersion: number | null;
    policyEffectiveAt: number | null;
    accountValueFormula: AccountRiskMetricPolicy['accountValueFormula'] | null;
    accountingDayId: string | null;
  }>;
  readonly account: Readonly<{
    derivedAccountValue: AccountRiskExactField;
    available: AccountRiskExactField;
    unrealisedPnl: AccountRiskExactField;
  }>;
  readonly daily: Readonly<{
    baselineStatus: 'AVAILABLE' | 'PARTIAL_DAY' | 'COVERAGE_UNKNOWN' | 'UNAVAILABLE';
    baseline: AccountRiskExactField;
    dailyEquityLoss: AccountRiskExactField;
  }>;
  readonly drawdown: Readonly<{
    epochId: string | null;
    highWater: AccountRiskExactField;
    absolute: AccountRiskExactField;
    fraction: AccountRiskExactField;
    fractionScale: 18;
    fractionRounding: 'ROUND_HALF_UP';
  }>;
  readonly economicHealth: Readonly<{
    projectionStatus:
      | 'USABLE_OBSERVED_SCOPE'
      | 'CONFLICTED'
      | 'UNCLASSIFIED_PRESENT'
      | 'UNUSABLE';
    projectionUsableForObservedAccounting: boolean;
    identityConflictCount: number;
    unclassifiedEventCount: number;
    untrackedObservedActivityCount: number;
    notExplainedByTrackedEvidenceCount: number;
    trackedExecutionAttributionStatus:
      GateIoEconomicProjection['trackedExecutionAttribution']['status'];
    accountActivityReconciled: 'UNAVAILABLE';
  }>;
  readonly provenance: Readonly<{
    accountObservationDigest: string | null;
    metricPolicyDigest: string | null;
    riskMetricsDigest: string;
    economicProjectionDigest: string;
    riskMetricsSchemaVersion: GateIoDurableAccountRiskMetricsSnapshot['schemaVersion'];
    economicProjectionSchemaVersion: GateIoEconomicProjection['schemaVersion'];
    economicLedgerSchemaVersion: GateIoEconomicProjection['provenance']['ledgerSchemaVersion'];
    economicHistoryScope: 'OBSERVED_PAGES_ONLY';
    lastKernelLogicalSequence: number | null;
  }>;
  readonly status: AccountRiskSnapshotStatus;
  readonly reasons: readonly string[];
  readonly snapshotDigest: string;
}

export interface BuildAccountRiskSnapshotInput {
  readonly expectedIdentity: GateIoAccountRiskIdentity;
  readonly accountObservation: GateIoDurableAccountObservation | null;
  readonly metricPolicy: AccountRiskMetricPolicy | null;
  readonly riskMetrics: GateIoDurableAccountRiskMetricsSnapshot;
  readonly economicProjection: GateIoEconomicProjection;
  readonly evaluationTime: number;
}
