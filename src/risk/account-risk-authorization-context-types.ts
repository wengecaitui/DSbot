import type { AccountRiskExactField, AccountRiskSnapshotV1 } from './account-risk-snapshot-types';
import type { RiskMandateResolution, RiskMandateV1 } from './risk-mandate-types';

export const ACCOUNT_RISK_AUTHORIZATION_CONTEXT_SCHEMA_VERSION =
  'account-risk-authorization-context-v1' as const;

export type AccountRiskAuthorizationFailureStatus =
  | 'EVALUATION_TIME_INVALID'
  | 'SNAPSHOT_SCHEMA_INVALID'
  | 'SNAPSHOT_DIGEST_INVALID'
  | 'SNAPSHOT_EVALUATION_TIME_MISMATCH'
  | 'SNAPSHOT_POLICY_UNAVAILABLE'
  | 'SNAPSHOT_ACCOUNT_VALUE_UNAVAILABLE'
  | 'SNAPSHOT_PARTIAL_DAY'
  | 'SNAPSHOT_STALE'
  | 'SNAPSHOT_IDENTITY_INVALID'
  | 'SNAPSHOT_ACCOUNT_MODE_UNSUPPORTED'
  | 'SNAPSHOT_ECONOMIC_CONFLICT'
  | 'SNAPSHOT_UNCLASSIFIED_ACTIVITY'
  | 'SNAPSHOT_ECONOMIC_PROJECTION_UNUSABLE'
  | 'SNAPSHOT_MIXED_VERSION'
  | 'SNAPSHOT_STATUS_INVALID'
  | 'SNAPSHOT_FRESHNESS_NOT_FRESH'
  | 'MANDATE_RESOLUTION_INVALID'
  | 'MANDATE_RESOLUTION_TIME_MISMATCH'
  | 'MANDATE_MISSING'
  | 'MANDATE_NOT_YET_EFFECTIVE'
  | 'MANDATE_DISABLED'
  | 'MANDATE_EXPIRED'
  | 'MANDATE_REVOKED'
  | 'MANDATE_CONFLICTED'
  | 'MANDATE_SCHEMA_INVALID'
  | 'MANDATE_DIGEST_INVALID'
  | 'MANDATE_LIFECYCLE_INVALID'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'METRIC_POLICY_SCHEMA_MISMATCH'
  | 'METRIC_POLICY_ID_MISMATCH'
  | 'METRIC_POLICY_VERSION_MISMATCH'
  | 'METRIC_POLICY_DIGEST_MISMATCH'
  | 'ACCOUNTING_DAY_UNAVAILABLE'
  | 'ACCOUNT_VALUE_UNAVAILABLE'
  | 'DAILY_EQUITY_LOSS_UNAVAILABLE'
  | 'DRAWDOWN_UNAVAILABLE';

export type AccountRiskAuthorizationContextStatus =
  | 'COMPATIBLE'
  | AccountRiskAuthorizationFailureStatus;

export interface AccountRiskAuthorizationFailure {
  readonly status: AccountRiskAuthorizationFailureStatus;
  readonly reasons: readonly string[];
}

export interface AccountRiskAuthorizationMetric {
  readonly availability: AccountRiskExactField['availability'];
  readonly valueExact: string | null;
}

export interface AccountRiskAuthorizationContext {
  readonly schemaVersion: typeof ACCOUNT_RISK_AUTHORIZATION_CONTEXT_SCHEMA_VERSION;
  readonly evaluationTime: number;
  readonly status: AccountRiskAuthorizationContextStatus;
  readonly compatible: boolean;
  readonly reasons: readonly string[];
  readonly failures: readonly AccountRiskAuthorizationFailure[];
  readonly identity: Readonly<{
    exchange: AccountRiskSnapshotV1['identity']['exchange'];
    settle: AccountRiskSnapshotV1['identity']['settle'];
    accountId: string;
  }>;
  readonly snapshot: Readonly<{
    schemaVersion: string;
    status: string;
    evaluatedAt: number;
    observationFreshness: string;
    accountingDayId: string | null;
    snapshotDigest: string;
  }>;
  readonly mandateResolution: Readonly<{
    status: RiskMandateResolution['status'];
    evaluationTime: number;
    mandate: RiskMandateV1 | null;
    mandateDigest: string | null;
  }>;
  readonly policyBinding: Readonly<{
    snapshotPolicyId: string | null;
    snapshotPolicyVersion: number | null;
    snapshotPolicyDigest: string | null;
    mandatePolicySchemaVersion: string | null;
    mandatePolicyId: string | null;
    mandatePolicyVersion: number | null;
    mandatePolicyDigest: string | null;
    matched: boolean;
  }>;
  readonly requiredMetrics: Readonly<{
    accountValue: AccountRiskAuthorizationMetric;
    dailyEquityLoss: AccountRiskAuthorizationMetric;
    drawdownFraction: AccountRiskAuthorizationMetric;
    allAvailable: boolean;
  }>;
  readonly provenance: Readonly<{
    snapshotDigest: string;
    mandateDigest: string | null;
    accountObservationDigest: string | null;
    metricPolicyDigest: string | null;
    riskMetricsDigest: string;
    economicProjectionDigest: string;
  }>;
  /** Compatibility is evidence qualification only. It never authorizes a trade. */
  readonly qualifiedContextOnly: true;
  readonly tradingAuthorized: false;
  readonly contextDigest: string;
}

export interface BuildAccountRiskAuthorizationContextInput {
  readonly snapshot: AccountRiskSnapshotV1;
  readonly mandateResolution: RiskMandateResolution;
  readonly evaluationTime: number;
}
