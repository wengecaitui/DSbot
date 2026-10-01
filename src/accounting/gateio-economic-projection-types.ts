import type {
  GateIoEconomicIdentityConflict,
  GateIoEconomicLedgerState,
  GateIoEconomicLocalCaptureBoundary,
} from './gateio-economic-ledger-types';
import type {
  GateIoCanonicalEconomicEvent,
  GateIoEconomicCategory,
} from './gateio-economic-truth-types';

export const GATEIO_ECONOMIC_PROJECTION_SCHEMA_VERSION =
  'gateio-economic-projection-v1' as const;
export const GATEIO_TRACKED_EXECUTION_EVIDENCE_SCHEMA_VERSION =
  'gateio-tracked-execution-economic-evidence-v1' as const;

export type GateIoDocumentedEconomicCategory = Exclude<GateIoEconomicCategory, 'UNCLASSIFIED'>;

export type GateIoObservedActivityClassification =
  | 'TRACKED_TRADE_LINKED'
  | 'UNTRACKED_TRADE_LINKED'
  | 'NON_TRADE_ACCOUNT_ACTIVITY'
  | 'UNLINKED_TRADE_ECONOMIC_ACTIVITY'
  | 'UNCLASSIFIED_ACTIVITY'
  | 'IDENTITY_CONFLICT';

export type GateIoProjectionCompletenessStatus =
  | 'OBSERVED_ONLY'
  | 'CONFLICTED'
  | 'UNCLASSIFIED_PRESENT';

export type GateIoBalanceObservationStatus =
  | 'TERMINAL_OBSERVED'
  | 'AMBIGUOUS_TERMINAL_ORDER'
  | 'IDENTITY_CONFLICT'
  | 'UNAVAILABLE';

export type GateIoTrackedExecutionAttributionStatus =
  | 'COMPLETE'
  | 'INCOMPLETE'
  | 'UNAVAILABLE';

export type GateIoTrackedExecutionCaptureScopeStatus =
  | 'SUFFICIENT_FOR_TRACKED_TRADES'
  | 'NOT_PROVEN';

export interface TrackedExecutionEconomicEvidence {
  readonly schemaVersion: typeof GATEIO_TRACKED_EXECUTION_EVIDENCE_SCHEMA_VERSION;
  readonly trackedTradeIds: readonly string[];
  readonly evidenceCapturedAt: number;
  readonly provenance: Readonly<{
    source: string;
  }>;
  readonly captureScope?: GateIoTrackedExecutionCaptureScopeStatus;
}

export type GateIoCategoryCounts = Readonly<Record<GateIoEconomicCategory, number>>;

/** Null means no trusted observed fact exists for that category; it is never coerced to zero. */
export type GateIoCategoryChangeTotals = Readonly<
  Record<GateIoEconomicCategory, string | null>
>;

export type GateIoObservedActivityCounts = Readonly<
  Record<GateIoObservedActivityClassification, number>
>;

export interface GateIoProjectedEconomicFact {
  readonly identity: string;
  readonly factDigest: string;
  readonly fact: GateIoCanonicalEconomicEvent;
}

export interface GateIoObservedEconomicActivity {
  readonly identity: string;
  readonly classification: GateIoObservedActivityClassification;
  /** Null for a conflicted identity because projection must not select a winner. */
  readonly category: GateIoEconomicCategory | null;
  readonly tradeId: string | null;
  readonly factDigest: string | null;
}

export interface GateIoTrackedExecutionAttribution {
  readonly status: GateIoTrackedExecutionAttributionStatus;
  readonly expectedTrackedTradeIds: readonly string[];
  readonly matchedTrackedTradeIds: readonly string[];
  readonly missingTrackedTradeIds: readonly string[];
  readonly reasons: readonly string[];
  readonly evidenceCapturedAt: number | null;
  readonly evidenceSource: string | null;
  readonly captureScope: GateIoTrackedExecutionCaptureScopeStatus | 'UNAVAILABLE';
}

export interface GateIoEconomicProjectionProvenance {
  readonly exchange: 'gateio';
  readonly settle: 'usdt';
  readonly source: 'futures_account_book';
  readonly endpoint: '/api/v4/futures/usdt/account_book';
  readonly ledgerSchemaVersion: GateIoEconomicLedgerState['schemaVersion'];
  readonly localCaptureBoundary: GateIoEconomicLocalCaptureBoundary | null;
  readonly observedCaptureCount: number;
  readonly distinctRawPayloadDigests: readonly string[];
  readonly historyScope: 'OBSERVED_PAGES_ONLY';
  readonly authoritativeExchangeCursor: false;
  readonly completeAccountHistory: false;
}

export interface GateIoEconomicProjection {
  readonly schemaVersion: typeof GATEIO_ECONOMIC_PROJECTION_SCHEMA_VERSION;
  /** Unique identities retained in the durable ledger, including conflicted identities. */
  readonly economicEventCount: number;
  /** Non-conflicted unique facts eligible for observed category aggregation. */
  readonly trustedEconomicEventCount: number;
  readonly identityConflictCount: number;
  readonly conflictedIdentityCount: number;
  /** All retained UNCLASSIFIED fact variants, including conflict evidence. */
  readonly unclassifiedEventCount: number;
  readonly observedFrom: number | null;
  readonly observedTo: number | null;
  /** Counts and totals exclude every conflicted identity. */
  readonly categoryCounts: GateIoCategoryCounts;
  readonly categoryChangeTotals: GateIoCategoryChangeTotals;
  readonly documentedCategoryFacts: readonly GateIoProjectedEconomicFact[];
  readonly unclassifiedFacts: readonly GateIoProjectedEconomicFact[];
  readonly identityConflicts: readonly GateIoEconomicIdentityConflict[];
  readonly terminalObservedBalance: string | null;
  readonly balanceStatus: GateIoBalanceObservationStatus;
  readonly completenessStatus: GateIoProjectionCompletenessStatus;
  readonly completenessReasons: readonly string[];
  /** Scope is observed category facts only; this never means complete account history. */
  readonly projectionUsableForObservedAccounting: boolean;
  readonly provenance: GateIoEconomicProjectionProvenance;
  readonly observedActivities: readonly GateIoObservedEconomicActivity[];
  readonly observedActivityCounts: GateIoObservedActivityCounts;
  readonly untrackedObservedActivityCount: number;
  readonly notExplainedByTrackedEvidenceCount: number;
  readonly trackedExecutionAttribution: GateIoTrackedExecutionAttribution;
  readonly accountActivityReconciled: 'UNAVAILABLE';
  readonly accountActivityReconciliationReasons: readonly string[];
}
