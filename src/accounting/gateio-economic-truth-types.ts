import type { GateIoAccountBookPageRequest } from '../runtime/gateio/GateIoReadContracts';

export const GATEIO_ECONOMIC_TRUTH_SCHEMA_VERSION = 'gateio-economic-truth-v1' as const;
export const GATEIO_ACCOUNT_BOOK_SOURCE = 'futures_account_book' as const;
export const GATEIO_ACCOUNT_BOOK_ENDPOINT = '/api/v4/futures/usdt/account_book' as const;

export type GateIoEconomicCategory =
  | 'TRANSFER'
  | 'POSITION_PNL'
  | 'TRADING_FEE'
  | 'REFERRAL_REBATE'
  | 'FUNDING'
  | 'POINT_TRANSFER'
  | 'POINT_FEE'
  | 'POINT_REBATE'
  | 'BONUS_OFFSET'
  | 'UNCLASSIFIED';

export interface GateIoEconomicEventCapture {
  readonly endpoint: typeof GATEIO_ACCOUNT_BOOK_ENDPOINT;
  readonly observedAt: number;
  /** The exact single-page request. It makes no ordering or completeness claim. */
  readonly pageRequest: Readonly<GateIoAccountBookPageRequest>;
  /** SHA-256 over a deterministic encoding of the complete raw page payload. */
  readonly rawPayloadDigest: string;
}

/**
 * One immutable Gate futures account-book fact.
 * Identity is the tuple exchange + settle + source + sourceId; sourceId alone is not claimed global.
 */
export interface GateIoCanonicalEconomicEvent {
  readonly schemaVersion: typeof GATEIO_ECONOMIC_TRUTH_SCHEMA_VERSION;
  readonly exchange: 'gateio';
  readonly settle: 'usdt';
  readonly source: typeof GATEIO_ACCOUNT_BOOK_SOURCE;
  readonly sourceId: string;
  readonly occurredAt: number;
  readonly category: GateIoEconomicCategory;
  readonly rawType: string;
  /** Exact Gate-reported account change. Sign and precision are not reinterpreted. */
  readonly change: string;
  /** Exact Gate-reported post-change balance. */
  readonly balance: string;
  readonly contract?: string;
  readonly tradeId?: string;
  readonly text?: string;
  readonly capture: GateIoEconomicEventCapture;
}

export interface GateIoAccountBookCaptureInput {
  readonly observedAt: number;
  readonly pageRequest: GateIoAccountBookPageRequest;
}
