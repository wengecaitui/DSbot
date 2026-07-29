// Stage 3A2 + 3B4C2: MarketSnapshot — immutable market state types
// Reuses WsTicker, WsKline directly. No copy/reduction.
// Stage 3B4C2: MarketSnapshot carries exchange provenance; store API
// requires explicit exchange parameter.

import type { WsTicker, WsKline } from './types';
import type { ExchangeId } from './MarketIdentity';

// ── Clock abstraction ───────────────────────────────────────────────────────
// Stage 4B4.1: canonical Clock lives in runtime/Clock. Re-export for
// source compatibility — all existing importers continue to work.

export type { Clock } from '../runtime/Clock';

// ── Wrappers ────────────────────────────────────────────────────────────────

export interface ReceivedTicker {
  readonly ticker: WsTicker;
  readonly receivedAt: number;
}

export interface ReceivedClosedKline {
  readonly kline: WsKline;
  readonly receivedAt: number;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface MarketSnapshot {
  readonly exchange: ExchangeId;
  readonly symbol: string; // canonical
  readonly ticker: ReceivedTicker | null;
  readonly klines: Readonly<Record<string, ReceivedClosedKline>>;
  readonly snapshotVersion: number;
  readonly generatedAt: number;
  readonly lastUpdatedAt: number;
  readonly ageMs: number;
  readonly isStale: boolean;
}

// ── Store Contract ──────────────────────────────────────────────────────────

export interface MarketSnapshotStore {
  updateTicker(input: {
    ticker: WsTicker;
    receivedAt: number;
  }): MarketSnapshot;

  updateClosedKline(input: {
    kline: WsKline;
    receivedAt: number;
  }): MarketSnapshot;

  getSnapshot(exchange: ExchangeId, symbol: string): MarketSnapshot | undefined;

  getAllSnapshots(): MarketSnapshot[];

  removeSymbol(exchange: ExchangeId, symbol: string): boolean;
}
