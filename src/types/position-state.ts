// Phase 1B3: Position State Types
import type { ExchangeId } from '../data/MarketIdentity';

export interface ConfirmedPositionBaseline {
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'long' | 'short' | 'flat';
  readonly signedQuantity: number;
  readonly averageEntryPrice: number;
}

export interface VersionedPositionSnapshot {
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'long' | 'short' | 'flat';
  readonly signedQuantity: number;
  readonly averageEntryPrice: number;
  readonly positionVersion: number;
  readonly sourceKernelEventId: string;
}

export interface PositionResolution {
  readonly status: 'missing' | 'flat' | 'open';
  readonly snapshot: VersionedPositionSnapshot | null;
  readonly side: 'long' | 'short' | 'flat';
  readonly signedQuantity: number;
  readonly averageEntryPrice: number;
}
