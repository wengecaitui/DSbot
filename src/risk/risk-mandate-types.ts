import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { AccountRiskMetricPolicy } from '../accounting/gateio-account-risk-metrics-types';
import type { AccountRiskSnapshotV1 } from './account-risk-snapshot-types';

export const RISK_MANDATE_SCHEMA_VERSION = 'risk-mandate-v1' as const;
export const RISK_MANDATE_REVOCATION_SCHEMA_VERSION = 'risk-mandate-revocation-v1' as const;
export const RISK_MANDATE_STORE_SCHEMA_VERSION = 'risk-mandate-store-v1' as const;
export const RISK_MANDATE_ACTIVATED = 'RISK_MANDATE_ACTIVATED' as const;
export const RISK_MANDATE_REVOKED = 'RISK_MANDATE_REVOKED' as const;

export const RISK_ACTION_EFFECTS = Object.freeze([
  'OPEN',
  'INCREASE',
  'REDUCE',
  'CLOSE',
  'EMERGENCY_CLOSE',
] as const);

export type RiskActionEffect = (typeof RISK_ACTION_EFFECTS)[number];

export interface RiskMandateAccountIdentity {
  readonly exchange: 'gateio';
  readonly settle: 'USDT';
  readonly accountId: string;
}

export interface RiskMandateHumanApprovalProvenance {
  readonly authorityType: 'HUMAN_OPERATOR';
  readonly actorId: string;
  readonly approvalReference: string;
  readonly approvedAt: number;
  readonly source: string;
}

export interface RiskMandateLimitsV1 {
  readonly maxSinglePositionFractionExact: string;
  readonly maxSinglePositionNotionalExact: string;
  readonly maxDailyEquityLossExact: string;
  readonly maxDrawdownFractionExact: string;
}

export interface RiskMandateMetricPolicyBindingV1 {
  readonly accountRiskSnapshotSchemaVersion: AccountRiskSnapshotV1['schemaVersion'];
  readonly metricPolicySchemaVersion: AccountRiskMetricPolicy['schemaVersion'];
  readonly metricPolicyId: string;
  readonly metricPolicyVersion: number;
  readonly metricPolicyDigest: string;
}

/**
 * Durable human/operator authority. This is neither account state nor a trade
 * authorization. A later composer and gateway must still qualify all runtime facts.
 */
export interface RiskMandateV1 extends RiskMandateAccountIdentity {
  readonly schemaVersion: typeof RISK_MANDATE_SCHEMA_VERSION;
  readonly mandateId: string;
  readonly mandateVersion: number;
  readonly effectiveAt: number;
  /** V1 deliberately requires a finite expiry; there is no implicit no-expiry mode. */
  readonly expiresAt: number;
  readonly enabled: boolean;
  readonly allowedSymbols: readonly string[];
  readonly allowedActionEffects: readonly RiskActionEffect[];
  readonly limits: RiskMandateLimitsV1;
  readonly metricPolicyBinding: RiskMandateMetricPolicyBindingV1;
  readonly provenance: RiskMandateHumanApprovalProvenance;
}

export interface RiskMandateRevocationV1 extends RiskMandateAccountIdentity {
  readonly schemaVersion: typeof RISK_MANDATE_REVOCATION_SCHEMA_VERSION;
  readonly mandateId: string;
  readonly mandateVersion: number;
  /** Pins revocation to the immutable mandate fact; never means last-write-wins. */
  readonly mandateDigest: string;
  readonly revokedAt: number;
  readonly reason: string;
  readonly provenance: RiskMandateHumanApprovalProvenance;
}

export interface RiskMandateActivatedPayload {
  readonly mandate: RiskMandateV1;
  readonly mandateDigest: string;
}

export interface RiskMandateRevokedPayload {
  readonly revocation: RiskMandateRevocationV1;
  readonly revocationDigest: string;
}

export interface RiskMandateEventCapture {
  readonly kernelEventId: string;
  readonly kernelLogicalSequence: number;
  readonly kernelTimestamp: number;
}

export interface RiskMandateRevocationRecord {
  readonly revocationDigest: string;
  readonly revocation: RiskMandateRevocationV1;
  readonly capture: RiskMandateEventCapture;
}

export interface RiskMandateVersionRecord {
  readonly identity: string;
  readonly mandateDigest: string;
  readonly mandate: RiskMandateV1;
  readonly activation: RiskMandateEventCapture;
  readonly revocation: RiskMandateRevocationRecord | null;
}

export type RiskMandateConflictKind =
  | 'KERNEL_EVENT_CONFLICT'
  | 'MANDATE_STREAM_CONFLICT'
  | 'MANDATE_VERSION_CONFLICT'
  | 'MANDATE_VERSION_ORDER_CONFLICT'
  | 'REVOCATION_CONFLICT'
  | 'REVOCATION_TARGET_DIGEST_MISMATCH';

export interface RiskMandateConflict {
  readonly kind: RiskMandateConflictKind;
  readonly identity: string;
  readonly acceptedDigest: string | null;
  readonly conflictingDigest: string;
  readonly capture: RiskMandateEventCapture;
}

export interface RiskMandateLocalReplayBoundary {
  readonly kind: 'LOCAL_JOURNAL_SEQUENCE_ONLY';
  readonly lastKernelLogicalSequence: number;
  readonly lastKernelEventId: string;
}

export interface RiskMandateStoreSnapshot {
  readonly schemaVersion: typeof RISK_MANDATE_STORE_SCHEMA_VERSION;
  readonly expectedIdentity: RiskMandateAccountIdentity;
  readonly mandateId: string | null;
  readonly versions: readonly RiskMandateVersionRecord[];
  readonly pendingRevocations: readonly RiskMandateRevocationRecord[];
  readonly conflicts: readonly RiskMandateConflict[];
  readonly hasConflict: boolean;
  readonly replayBoundary: RiskMandateLocalReplayBoundary | null;
}

export type RiskMandateResolutionStatus =
  | 'MISSING'
  | 'NOT_YET_EFFECTIVE'
  | 'ACTIVE'
  | 'DISABLED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'CONFLICTED';

/** ACTIVE means only that durable human authority is active, never that a trade is allowed. */
export interface RiskMandateResolution {
  readonly status: RiskMandateResolutionStatus;
  readonly evaluationTime: number;
  readonly mandate: RiskMandateV1 | null;
  readonly mandateDigest: string | null;
  readonly reasons: readonly string[];
  readonly authorityOnly: true;
  readonly tradingAuthorized: false;
}

export type RiskMandateApplyStatus =
  | 'ACTIVATED'
  | 'REVOKED'
  | 'DUPLICATE_SAME_FACT';

export interface RiskMandateApplyResult {
  readonly status: RiskMandateApplyStatus;
  readonly identity: string;
  readonly factDigest: string;
}

export interface RiskMandateProjector {
  apply(
    envelope: KernelEventEnvelope<'RISK_MANDATE_ACTIVATED' | 'RISK_MANDATE_REVOKED'> | unknown,
  ): RiskMandateApplyResult;
  resolve(evaluationTime: number): RiskMandateResolution;
  snapshot(): RiskMandateStoreSnapshot;
  digest(): string;
}
