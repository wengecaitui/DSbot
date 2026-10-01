import type { GateIoCanonicalEconomicEvent, GateIoEconomicEventCapture } from './gateio-economic-truth-types';

export const GATEIO_ECONOMIC_EVENT_RECORDED = 'GATEIO_ECONOMIC_EVENT_RECORDED' as const;

export interface GateIoEconomicEventRecordedPayload {
  readonly fact: GateIoCanonicalEconomicEvent;
  /** Digest of canonical economic semantics only; capture provenance is deliberately excluded. */
  readonly factDigest: string;
}

export type GateIoEconomicApplyStatus = 'RECORDED_NEW_FACT' | 'DUPLICATE_SAME_FACT';
export type GateIoEconomicRecordStatus = GateIoEconomicApplyStatus | 'IDENTITY_CONFLICT';

export interface GateIoEconomicApplyResult {
  readonly status: GateIoEconomicApplyStatus;
  readonly identity: string;
  readonly factDigest: string;
}

export interface GateIoEconomicRecordResult {
  readonly status: GateIoEconomicRecordStatus;
  readonly identity: string;
  readonly factDigest: string;
  readonly kernelEventId: string;
}

export interface GateIoEconomicCaptureRecord {
  readonly kernelEventId: string;
  readonly kernelLogicalSequence: number;
  readonly kernelTimestamp: number;
  readonly factDigest: string;
  readonly capture: GateIoEconomicEventCapture;
}

export interface GateIoEconomicLedgerFactRecord {
  readonly identity: string;
  readonly factDigest: string;
  readonly fact: GateIoCanonicalEconomicEvent;
  /** All distinct durable observations of the same fact, ordered by local journal sequence. */
  readonly captures: readonly GateIoEconomicCaptureRecord[];
}

export interface GateIoEconomicIdentityConflict {
  readonly identity: string;
  readonly acceptedDigest: string;
  readonly conflictingDigest: string;
  readonly conflictingFact: GateIoCanonicalEconomicEvent;
  readonly capture: GateIoEconomicCaptureRecord;
}

export interface GateIoEconomicLocalCaptureBoundary {
  readonly kind: 'LOCAL_JOURNAL_SEQUENCE_ONLY';
  readonly lastKernelLogicalSequence: number;
  readonly lastKernelEventId: string;
}

export interface GateIoEconomicLedgerSnapshot {
  readonly schemaVersion: 'gateio-economic-ledger-v1';
  readonly uniqueIdentityCount: number;
  readonly facts: readonly GateIoEconomicLedgerFactRecord[];
  readonly conflicts: readonly GateIoEconomicIdentityConflict[];
  readonly hasIdentityConflict: boolean;
  /** Local replay/append boundary only; never an exchange cursor or history-completeness proof. */
  readonly captureBoundary: GateIoEconomicLocalCaptureBoundary | null;
}
