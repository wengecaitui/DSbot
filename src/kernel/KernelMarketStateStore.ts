// Phase 1B1: KernelMarketStateStore — kernel-driven market state with versioned immutable snapshots
//
// Consumes KernelEventEnvelope from TradingKernel subscribers.
// Reduces market.ticker.updated and market.kline.closed events.
// research.bias.updated is irrelevant.
//
// Key: sourceKey(exchange, instId)
// Snapshot version: kernelLogicalSequence of last accepted mutation
// generatedAt: clock.now() at read time
// lastUpdatedAt: max accepted payload.receivedAt
// ageMs: max(0, generatedAt - lastUpdatedAt)
// isStale: ageMs > staleAfterMs

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
import { systemDomainClock } from '../runtime/Clock';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ApplyResult {
  status: 'applied' | 'ignored' | 'irrelevant';
  snapshot?: MarketSnapshot;
}

export interface KernelMarketStateStore {
  apply(envelope: KernelEventEnvelope): ApplyResult;
  getSnapshot(exchange: ExchangeId, symbol: string): MarketSnapshot | undefined;
  getAllSnapshots(): MarketSnapshot[];
}

// ─── Internal ───────────────────────────────────────────────────────────────

interface InternalEntry {
  lastSeq: number;
  ticker: ReceivedTicker | null;
  tickerTs: number; // last applied ticker.ts for staleness comparison
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

function assertFiniteTicker(ticker: WsTicker): void {
  // Check critical price fields for non-finite values
  const fields: Array<[string, unknown]> = [
    ['last', ticker.last],
    ['high24h', ticker.high24h],
    ['low24h', ticker.low24h],
  ];
  for (const [name, val] of fields) {
    if (typeof val === 'number' && !Number.isFinite(val)) {
      throw new Error(`NON_FINITE_TICKER: ${name}=${val}`);
    }
  }
}

function assertFiniteKline(kline: WsKline): void {
  const fields: Array<[string, unknown]> = [
    ['open', kline.open],
    ['high', kline.high],
    ['low', kline.low],
    ['close', kline.close],
    ['volume', kline.volume],
  ];
  for (const [name, val] of fields) {
    if (typeof val === 'number' && !Number.isFinite(val)) {
      throw new Error(`NON_FINITE_KLINE: ${name}=${val}`);
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createKernelMarketStateStore(config: {
  clock?: DomainClock;
  staleAfterMs: number;
}): KernelMarketStateStore {
  const clock: DomainClock = config.clock ?? systemDomainClock;
  const staleAfterMs = config.staleAfterMs;
  const entries = new Map<string, InternalEntry>();

  function ensureEntry(key: string): InternalEntry {
    let e = entries.get(key);
    if (!e) {
      e = {
        lastSeq: 0,
        ticker: null,
        tickerTs: 0,
        lastReceivedAt: 0,
        klines: {},
        klineTs: {},
      };
      entries.set(key, e);
    }
    return e;
  }

  function buildSnapshot(key: string, entry: InternalEntry): MarketSnapshot {
    const parts = key.split('::');
    const generatedAt = clock.now();
    const ageMs = Math.max(0, generatedAt - entry.lastReceivedAt);
    return deepFreeze({
      exchange: parts[0] as ExchangeId,
      symbol: parts[1],
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
      const seq = envelope.kernelLogicalSequence;
      const { type } = envelope;

      if (type === 'research.bias.updated') {
        return { status: 'irrelevant' };
      }

      let key: string;

      if (type === 'market.ticker.updated') {
        const p = envelope.payload as { ticker: WsTicker; receivedAt: number };
        const ticker = p.ticker;
        assertFiniteTicker(ticker);
        key = sourceKey(ticker.exchange as ExchangeId, ticker.instId);

        const entry = ensureEntry(key);

        // Out-of-order kernel sequence → ignore
        if (seq <= entry.lastSeq) return { status: 'ignored' };

        // Older ticker timestamp → ignore
        const newTs = ticker.ts;
        if (entry.tickerTs > 0 && newTs < entry.tickerTs) {
          return { status: 'ignored' };
        }
        // Same ts, not newer receivedAt → ignore
        if (newTs === entry.tickerTs && p.receivedAt <= entry.lastReceivedAt) {
          return { status: 'ignored' };
        }

        entry.ticker = { ticker: deepClone(ticker), receivedAt: p.receivedAt };
        entry.tickerTs = newTs;
        entry.lastReceivedAt = p.receivedAt;
        entry.lastSeq = seq;
        return { status: 'applied', snapshot: buildSnapshot(key, entry) };
      }

      if (type === 'market.kline.closed') {
        const p = envelope.payload as { kline: WsKline; receivedAt: number };
        const kline = p.kline;
        assertFiniteKline(kline);
        key = sourceKey(kline.exchange as ExchangeId, kline.instId);

        const entry = ensureEntry(key);

        // Out-of-order kernel sequence → ignore
        if (seq <= entry.lastSeq) return { status: 'ignored' };

        const interval = kline.interval;
        const existingTs = entry.klineTs[interval] ?? -1;

        // Older kline.ts per interval → ignore
        if (kline.ts <= existingTs) {
          return { status: 'ignored' };
        }

        entry.klines[interval] = { kline: deepClone(kline), receivedAt: p.receivedAt };
        entry.klineTs[interval] = kline.ts;
        if (p.receivedAt > entry.lastReceivedAt) {
          entry.lastReceivedAt = p.receivedAt;
        }
        entry.lastSeq = seq;
        return { status: 'applied', snapshot: buildSnapshot(key, entry) };
      }

      return { status: 'irrelevant' };
    },

    getSnapshot(exchange: ExchangeId, symbol: string): MarketSnapshot | undefined {
      const key = sourceKey(exchange, symbol);
      const entry = entries.get(key);
      if (!entry) return undefined;
      return buildSnapshot(key, entry);
    },

    getAllSnapshots(): MarketSnapshot[] {
      return [...entries.entries()].map(([key, entry]) => buildSnapshot(key, entry));
    },
  };
}
