import type { ExactRiskComparisonEvidence, TradeAction } from './pretrade-risk-types';
import type { TrustedExitProof } from './trusted-exit';

export const PRETRADE_RISK_DECISION_RECORDED =
  'PRETRADE_RISK_DECISION_RECORDED' as const;
export const PRETRADE_RISK_DECISION_RECEIPT_SCHEMA_VERSION =
  'pretrade-risk-decision-receipt-v1' as const;

export type PreTradeGatewayMode =
  | 'LEGACY_PAPER_OR_NON_GATE'
  | 'GATEIO_ACCOUNT_BOUND'
  | 'GATEIO_EXISTING_EXIT_PATH'
  | 'GATEIO_TRUSTED_EXIT_ONLY';

export interface PreTradeRiskDecisionReceiptV1 {
  readonly schemaVersion: typeof PRETRADE_RISK_DECISION_RECEIPT_SCHEMA_VERSION;
  readonly gatewayMode: PreTradeGatewayMode;
  readonly exchange: string;
  readonly settle: 'USDT' | null;
  readonly accountId: string;
  readonly intentId: string;
  readonly symbol: string;
  readonly action: TradeAction;
  readonly requestedPositionUsdExact: string;
  readonly evaluationTime: number;
  readonly decision: 'ADMITTED' | 'REJECTED';
  readonly reasonCode: string | null;
  readonly approvedPositionUsdExact: string | null;
  readonly riskEffect: 'OPEN' | 'INCREASE' | TrustedExitProof['effect'] | null;
  /** Additive: historical v1 receipts retain their original schema and digest. */
  readonly exitProof?: TrustedExitProof | null;
  readonly contextDigest: string | null;
  readonly snapshotDigest: string | null;
  readonly mandateDigest: string | null;
  readonly accountingDayId: string | null;
  readonly positionVersion: number | null;
  readonly positionSourceKernelEventId: string | null;
  readonly comparisons: readonly ExactRiskComparisonEvidence[];
}

export interface PreTradeRiskDecisionRecordedPayload {
  readonly receipt: PreTradeRiskDecisionReceiptV1;
  readonly receiptDigest: string;
}

export interface PreTradeRiskDecisionRecord {
  readonly receiptDigest: string;
  readonly receipt: PreTradeRiskDecisionReceiptV1;
  readonly kernelEventId: string;
  readonly kernelLogicalSequence: number;
  readonly kernelTimestamp: number;
}

export interface PreTradeRiskDecisionReceiptStoreSnapshot {
  readonly schemaVersion: 'pretrade-risk-decision-receipt-store-v1';
  readonly records: readonly PreTradeRiskDecisionRecord[];
  readonly lastKernelLogicalSequence: number | null;
}

export interface PreTradeRiskDecisionReceiptStore {
  apply(envelope: unknown): 'RECORDED' | 'DUPLICATE_SAME_FACT';
  snapshot(): PreTradeRiskDecisionReceiptStoreSnapshot;
  digest(): string;
}
