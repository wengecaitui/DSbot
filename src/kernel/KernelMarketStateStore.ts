// Phase 1B1: KernelMarketStateStore — kernel-driven market state with versioned immutable snapshots
//
// Consumes KernelEventEnvelope from TradingKernel subscribers.
// Reduces market.ticker.updated and market.kline.closed events.
// research.bias.updated is irrelevant.
//
// Key: (exchange, symbol) — stored explicitly, never parsed from sourceKey.
// Snapshot version: kernelLogicalSequence of last accepted mutation.
// generatedAt: clock.now() at read time.
// lastUpdatedAt: max(previous, payload.receivedAt).

import type { WsTicker, WsKline } from '../data/types';
import type { ExchangeId } from '../data/MarketIdentity';
import { sourceKey } from '../data/MarketIdentity';
import type {
  MarketSnapshot,
  ReceivedTicker,
  ReceivedClosedKline,
} from '../data/MarketSnapshot';
import type { KernelEventEnvelope } from './KernelEventEnvelope';
import type { DomainClock } from '../runtime/Clock';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ApplyResult {
  status: 'applied' | 'ignored' | 'irrelevant';
  snapshot?: MarketSnapshot;
}

export interface KernelMarketStateStore {
  apply(envelope: KernelEventEnvelope): ApplyResult;
  getSnapshot(exchange: ExchangeId, symbol: string): MarketSnapshot | undefined;
  getAllSnapshots(): MarketSnapshot[];
  digest(): string;
}

// ─── Internal ───────────────────────────────────────────────────────────────

interface InternalEntry {
  exchange: ExchangeId;
  symbol: string;
  lastSeq: number;
  ticker: ReceivedTicker | null;
  lastReceivedAt: number;
  klines: Record<string, ReceivedClosedKline>;
  klineTs: Record<string, number>;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    if (Array.isArray(obj)) {
      for (const item of obj) deepFreeze(item);
    } else {
      for (const v of Object.values(obj)) deepFreeze(v);
    }
  }
  return obj;
}

function assertAllFinite(prefix: string, fields: Array<[string, unknown]>): void {
  for (const [name, val] of fields) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new Error(`${prefix}: ${name}=${JSON.stringify(val)}`);
    }
  }
}

function assertValidTicker(ticker: WsTicker, receivedAt: number): void {
  if (ticker.channel !== 'ticker') {
    throw new Error(`TICKER_CHANNEL: expected 'ticker', got ${JSON.stringify(ticker.channel)}`);
  }
  assertAllFinite('NON_FINITE_TICKER', [
    ['last', ticker.last],
    ['bestBid', ticker.bestBid],
    ['bestAsk', ticker.bestAsk],
    ['volume24h', ticker.volume24h],
    ['high24h', ticker.high24h],
    ['low24h', ticker.low24h],
    ['ts', ticker.ts],
    ['receivedAt', receivedAt],
  ]);
}

function assertValidKline(kline: WsKline, receivedAt: number): void {
  if (kline.channel !== 'kline') {
    throw new Error(`KLINE_CHANNEL: expected 'kline', got ${JSON.stringify(kline.channel)}`);
  }
  if (kline.confirm !== true) {
    throw new Error(`KLINE_NOT_CONFIRMED: confirm=${kline.confirm}`);
  }
  if (typeof kline.interval !== 'string' || kline.interval.length === 0) {
    throw new Error(`KLINE_INTERVAL: must be non-empty string, got ${JSON.stringify(kline.interval)}`);
  }
  assertAllFinite('NON_FINITE_KLINE', [
    ['open', kline.open],
    ['high', kline.high],
    ['low', kline.low],
    ['close', kline.close],
    ['volume', kline.volume],
    ['ts', kline.ts],
    ['receivedAt', receivedAt],
  ]);
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createKernelMarketStateStore(config: {
  clock: DomainClock;
  staleAfterMs: number;
}): KernelMarketStateStore {
  if (!config.clock || typeof config.clock.now !== 'function') {
    throw new Error('STORAGE_CONFIG: clock is required');
  }
  if (typeof config.staleAfterMs !== 'number' || !Number.isFinite(config.staleAfterMs) || config.staleAfterMs <= 0) {
    throw new Error(`STORAGE_CONFIG: staleAfterMs must be finite >0, got ${config.staleAfterMs}`);
  }
  const clock = config.clock;
  const staleAfterMs = config.staleAfterMs;
  const keys: string[] = [];
  const entries = new Map<string, InternalEntry>();

  function entryKey(exchange: ExchangeId, symbol: string): string {
    return sourceKey(exchange, symbol);
  }

  function ensureEntry(exchange: ExchangeId, symbol: string): InternalEntry {
    const k = entryKey(exchange, symbol);
    let e = entries.get(k);
    if (!e) {
      e = { exchange, symbol, lastSeq: 0, ticker: null, lastReceivedAt: 0, klines: {}, klineTs: {} };
      entries.set(k, e);
      keys.push(k);
    }
    return e;
  }

  function buildSnapshot(entry: InternalEntry): MarketSnapshot {
    const generatedAt = clock.now();
    const ageMs = Math.max(0, generatedAt - entry.lastReceivedAt);
    return deepFreeze({
      exchange: entry.exchange,
      symbol: entry.symbol,
      ticker: entry.ticker ? deepClone(entry.ticker) : null,
      klines: deepClone(entry.klines) as Readonly<Record<string, ReceivedClosedKline>>,
      snapshotVersion: entry.lastSeq,
      generatedAt,
      lastUpdatedAt: entry.lastReceivedAt,
      ageMs,
      isStale: ageMs > staleAfterMs,
    } as MarketSnapshot);
  }

  return {
    apply(envelope: KernelEventEnvelope): ApplyResult {
      const { type } = envelope;
      const seq = envelope.kernelLogicalSequence;

      if (type === 'research.bias.updated') {
        return { status: 'irrelevant' };
      }

      // ── Ticker ────────────────────────────────────────────────────────────
      if (type === 'market.ticker.updated') {
        const p = envelope.payload as { ticker: WsTicker; receivedAt: number };
        const ticker = p.ticker;

        // All validation BEFORE any mutation
        assertValidTicker(ticker, p.receivedAt);
        const exchange = ticker.exchange as ExchangeId;
        const symbol = ticker.instId;
        entryKey(exchange, symbol);

        // Deep-clone into candidate BEFORE ensureEntry
        const candidateTicker: ReceivedTicker = { ticker: deepClone(ticker), receivedAt: p.receivedAt };

        const entry = ensureEntry(exchange, symbol);

        // Out-of-order kernel sequence → ignore (no state change)
        if (seq <= entry.lastSeq) return { status: 'ignored' };

        const newTs = ticker.ts;

        // Older ticker timestamp → ignore
        if (entry.ticker && newTs < entry.ticker.ticker.ts) {
          return { status: 'ignored' };
        }
        // Same ts: compare against existing ticker.receivedAt
        if (entry.ticker && newTs === entry.ticker.ticker.ts) {
          if (p.receivedAt <= entry.ticker.receivedAt) {
            return { status: 'ignored' };
          }
        }

        entry.ticker = candidateTicker;
        entry.lastReceivedAt = Math.max(entry.lastReceivedAt, p.receivedAt);
        entry.lastSeq = seq;
        return { status: 'applied', snapshot: buildSnapshot(entry) };
      }

      // ── Kline ────────────────────────────────────────────────────────────
      if (type === 'market.kline.closed') {
        const p = envelope.payload as { kline: WsKline; receivedAt: number };
        const kline = p.kline;

        // All validation BEFORE any mutation
        assertValidKline(kline, p.receivedAt);
        const exchange = kline.exchange as ExchangeId;
        const symbol = kline.instId;
        entryKey(exchange, symbol);

        // Deep-clone into candidate BEFORE ensureEntry
        const candidateKline: ReceivedClosedKline = { kline: deepClone(kline), receivedAt: p.receivedAt };

        const entry = ensureEntry(exchange, symbol);

        // Out-of-order kernel sequence → ignore
        if (seq <= entry.lastSeq) return { status: 'ignored' };

        const interval = kline.interval;
        const existing = entry.klines[interval] as ReceivedClosedKline | undefined;
        const existingTs = existing ? existing.kline.ts : -1;

        // Older kline.ts per interval → ignore
        if (kline.ts < existingTs) {
          return { status: 'ignored' };
        }
        // Same ts: compare against existing kline.receivedAt
        if (kline.ts === existingTs && existing && p.receivedAt <= existing.receivedAt) {
          return { status: 'ignored' };
        }

        entry.klines[interval] = candidateKline;
        entry.klineTs[interval] = kline.ts;
        entry.lastReceivedAt = Math.max(entry.lastReceivedAt, p.receivedAt);
        entry.lastSeq = seq;
        return { status: 'applied', snapshot: buildSnapshot(entry) };
      }

      return { status: 'irrelevant' };
    },

    getSnapshot(exchange: ExchangeId, symbol: string): MarketSnapshot | undefined {
      const e = entries.get(entryKey(exchange, symbol));
      if (!e) return undefined;
      return buildSnapshot(e);
    },

    getAllSnapshots(): MarketSnapshot[] {
      return keys.map((k) => entries.get(k)!).filter(Boolean).map((e) => buildSnapshot(e));
    },

    digest(): string {
      const sorted = [...entries.entries()]
        .filter(([_, v]) => v !== null)
        .sort(([a], [b]) => a.localeCompare(b));
      const { createHash } = require('node:crypto') as typeof import('node:crypto');
      return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
    },
  };
}
