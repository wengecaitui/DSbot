// Phase 1B3: Position State Types
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';

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

export function validatePositionBaseline(v: unknown): void {
  if (!v || typeof v !== 'object') throw new Error('BASELINE_INVALID: not an object');
  const b = v as Record<string, unknown>;
  if (!isExchangeId(b.exchange as string)) throw new Error('BASELINE_INVALID: exchange');
  if (typeof b.symbol !== 'string' || b.symbol.length === 0) throw new Error('BASELINE_INVALID: symbol');
  if (b.side !== 'long' && b.side !== 'short' && b.side !== 'flat') throw new Error('BASELINE_INVALID: side');
  if (typeof b.signedQuantity !== 'number' || !Number.isFinite(b.signedQuantity)) throw new Error('BASELINE_INVALID: signedQuantity');
  if (typeof b.averageEntryPrice !== 'number' || !Number.isFinite(b.averageEntryPrice)) throw new Error('BASELINE_INVALID: averageEntryPrice');
  if (b.side === 'flat' && (b.signedQuantity !== 0 || b.averageEntryPrice !== 0)) throw new Error('BASELINE_INVALID: flat requires qty=0, price=0');
  if (b.side === 'long' && (b.signedQuantity <= 0 || b.averageEntryPrice <= 0)) throw new Error('BASELINE_INVALID: long requires qty>0, price>0');
  if (b.side === 'short' && (b.signedQuantity >= 0 || b.averageEntryPrice <= 0)) throw new Error('BASELINE_INVALID: short requires qty<0, price>0');
}
