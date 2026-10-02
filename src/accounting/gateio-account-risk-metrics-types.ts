import type { GateIoAccountMarginMode } from '../runtime/gateio/GateIoAuthenticatedReadFoundation';

export const GATEIO_ACCOUNT_FACT_OBSERVED = 'GATEIO_ACCOUNT_FACT_OBSERVED' as const;
export const ACCOUNT_RISK_METRIC_POLICY_ACTIVATED =
  'ACCOUNT_RISK_METRIC_POLICY_ACTIVATED' as const;
export const GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION =
  'gateio-account-observation-v1' as const;
export const ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION =
  'account-risk-metric-policy-v1' as const;
export const CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1 =
  'CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1' as const;

export type GateIoAccountModeQualification =
  | 'SUPPORTED_CLASSIC'
  | 'UNSUPPORTED_ACCOUNT_MODE'
  | 'UNKNOWN_ACCOUNT_MODE';

export interface GateIoAccountRiskIdentity {
  readonly exchange: 'gateio';
  readonly settle: 'USDT';
  readonly accountId: string;
}

export interface GateIoAccountObservationCaptureProvenance {
  readonly kind: 'GATEIO_AUTHENTICATED_ACCOUNT_READ';
  readonly endpoint: '/api/v4/futures/usdt/accounts';
  readonly foundationFreshness: 'FRESH' | 'STALE' | 'UNKNOWN';
}

/** Durable exchange observation. No field in this type is named or represented as equity. */
export interface GateIoDurableAccountObservation extends GateIoAccountRiskIdentity {
  readonly schemaVersion: typeof GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION;
  readonly currency: 'USDT';
  readonly marginMode: GateIoAccountMarginMode | null;
  readonly accountModeQualification: GateIoAccountModeQualification;
  readonly totalExact: string;
  readonly availableExact: string;
  readonly unrealisedPnlExact: string;
  readonly observedAt: number;
  readonly serverTime: number;
  readonly source: 'gateio-usdt-futures-read';
  readonly sourceSchemaVersion: 'gateio-l1a-v1';
  readonly captureProvenance: GateIoAccountObservationCaptureProvenance;
  readonly rawPayloadDigest?: string;
}

export interface AccountRiskMetricPolicy extends GateIoAccountRiskIdentity {
  readonly schemaVersion: typeof ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly effectiveAt: number;
  readonly accountValueFormula: typeof CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1;
  readonly accountObservationMaxAgeMs: number;
  readonly dayBoundary: {
    readonly timezone: string;
    /** Canonical 24-hour local time with seconds: HH:mm:ss. */
    readonly localBoundaryTime: string;
  };
}

export interface GateIoAccountFactObservedPayload {
  readonly observation: GateIoDurableAccountObservation;
  readonly observationDigest: string;
}

export interface AccountRiskMetricPolicyActivatedPayload {
  readonly policy: AccountRiskMetricPolicy;
  readonly policyDigest: string;
}

export interface GateIoAccountObservationRecord {
  readonly identity: string;
  readonly observationId: string;
  readonly observationDigest: string;
  readonly observation: GateIoDurableAccountObservation;
}

export interface AccountRiskMetricPolicyRecord {
  readonly identity: string;
  readonly policyDigest: string;
  readonly policy: AccountRiskMetricPolicy;
}

export interface GateIoAccountMetricFoundationSnapshot {
  readonly schemaVersion: 'gateio-account-metric-foundation-v1';
  readonly observations: readonly GateIoAccountObservationRecord[];
  readonly policies: readonly AccountRiskMetricPolicyRecord[];
  readonly conflictedObservationIdentities: readonly string[];
  readonly conflictedPolicyIdentities: readonly string[];
  readonly lastKernelLogicalSequence: number | null;
}

export type AccountRiskMetricStatus =
  | 'AVAILABLE'
  | 'PARTIAL_DAY'
  | 'POLICY_UNAVAILABLE'
  | 'CURRENT_VALUE_UNAVAILABLE'
  | 'STALE'
  | 'ECONOMIC_CONFLICT'
  | 'UNCLASSIFIED_ECONOMIC_ACTIVITY'
  | 'IDENTITY_INVALID'
  | 'UNSUPPORTED_ACCOUNT_MODE'
  | 'COVERAGE_UNKNOWN';

export type AccountBoundaryCoverage =
  | 'FULL_BOUNDARY_COVERAGE'
  | 'PARTIAL_DAY_BOOTSTRAP'
  | 'COVERAGE_UNKNOWN';

export interface AcceptedAccountMetricPoint {
  readonly kernelLogicalSequence: number;
  readonly observationId: string;
  readonly observedAt: number;
  readonly derivedAccountValueExact: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyEffectiveAt: number;
  readonly epochId: string;
}

export interface DailyAccountMetricBaseline {
  readonly status: 'AVAILABLE' | 'PARTIAL_DAY' | 'COVERAGE_UNKNOWN';
  readonly accountingDayId: string;
  readonly boundaryAt: number | null;
  readonly coverage: AccountBoundaryCoverage;
  readonly valueExact: string | null;
  readonly sourceObservationId: string | null;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly qualifiedAt: number | null;
  readonly reasons: readonly string[];
}

export interface GateIoDurableAccountRiskMetricsSnapshot {
  readonly schemaVersion: 'gateio-durable-account-risk-metrics-v1';
  readonly evaluatedAt: number;
  readonly accountingDayId: string | null;
  readonly activePolicyId: string | null;
  readonly activePolicyVersion: number | null;
  readonly metricEpochId: string | null;
  readonly status: AccountRiskMetricStatus;
  readonly reasons: readonly string[];
  readonly currentQualifiedAccountValueExact: string | null;
  readonly baseline: DailyAccountMetricBaseline | null;
  readonly dailyEquityLossExact: string | null;
  readonly epochHighWaterExact: string | null;
  readonly drawdownAbsoluteExact: string | null;
  readonly drawdownFractionExact: string | null;
  readonly drawdownFractionScale: 18;
  readonly drawdownFractionRounding: 'ROUND_HALF_UP';
  readonly acceptedMetricPoints: readonly AcceptedAccountMetricPoint[];
  readonly historicalStateRetained: boolean;
  readonly lastKernelLogicalSequence: number | null;
}

export type QualifiedAccountValueStatus =
  | 'AVAILABLE'
  | 'POLICY_UNAVAILABLE'
  | 'ACCOUNT_MODE_UNSUPPORTED'
  | 'ACCOUNT_MODE_UNKNOWN'
  | 'ACCOUNT_IDENTITY_INVALID'
  | 'STALE'
  | 'MALFORMED'
  | 'SOURCE_UNAVAILABLE';

export interface QualifiedAccountValueCandidate {
  readonly status: QualifiedAccountValueStatus;
  readonly valueKind: 'INTERNAL_DERIVED_ACCOUNT_VALUE';
  readonly derivedAccountValueExact: string | null;
  readonly formula: typeof CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1 | null;
  readonly observationId: string | null;
  readonly observedAt: number | null;
  readonly ageMs: number | null;
  readonly policyId: string | null;
  readonly policyVersion: number | null;
  readonly reasons: readonly string[];
}
