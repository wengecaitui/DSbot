// Phase 1B1: KernelMarketStateStore — contract tests (RED first)
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import type { WsTicker, WsKline } from '../../src/data/types';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { MarketSnapshot } from '../../src/data/MarketSnapshot';
import type { KernelEventEnvelope } from '../../src/kernel/KernelEventEnvelope';
import type { DomainClock } from '../../src/runtime/Clock';
import { createTradingKernel } from '../../src/kernel/TradingKernel';

import { createKernelMarketStateStore } from '../../src/kernel/KernelMarketStateStore';
import type { KernelMarketStateStore } from '../../src/kernel/KernelMarketStateStore';

const BITGET = 'bitget' as const;

const makeTicker = (overrides?: Partial<WsTicker>): WsTicker => ({
  exchange: BITGET, instId: 'BTC/USDT',
  ...(overrides as Partial<WsTicker> ?? {}),
} as unknown as WsTicker);

const makeKline = (overrides?: Partial<WsKline>): WsKline => ({
  exchange: BITGET, instId: 'BTC/USDT', interval: '1m', ts: 1000,
  open: 100, high: 101, low: 99, close: 100.5, volume: 1000, confirm: true,
  ...overrides,
} as unknown as WsKline);

const makeEnvelope = (
  type: 'market.ticker.updated' | 'market.kline.closed' | 'research.bias.updated',
  payload: Record<string,unknown>,
  seq: number,
): KernelEventEnvelope => ({
  kernelEventId: 'a'.repeat(64),
  kernelLogicalSequence: seq,
  kernelTimestamp: 1000 * seq,
  type,
  payload,
} as unknown as KernelEventEnvelope);

// ─── Ticker apply ───────────────────────────────────────────────────────────
describe('ticker apply', () => {
  let store: KernelMarketStateStore;
  let clock: { now: () => number };

  beforeEach(() => {
    let t = 5000;
    clock = { now: () => t++ };
    store = createKernelMarketStateStore({ clock, staleAfterMs: 60000 });
  });

  it('applies ticker event and returns snapshot', () => {
    const ticker = makeTicker();
    const r = store.apply(makeEnvelope('market.ticker.updated',
      { ticker, receivedAt: 1000 }, 1));
    assert.strictEqual(r.status, 'applied');
    assert.ok(r.snapshot);
    assert.strictEqual(r.snapshot!.ticker?.ticker.instId, 'BTC/USDT');
  });

  it('snapshot version equals accepted kernel sequence', () => {
    const ticker = makeTicker();
    const r = store.apply(makeEnvelope('market.ticker.updated',
      { ticker, receivedAt: 1000 }, 5));
    assert.strictEqual(r.snapshot!.snapshotVersion, 5);
  });

  it('older kernel sequence for same key is ignored', () => {
    const ticker = makeTicker();
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker, receivedAt: 1000 }, 5));
    const r = store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker({ last: 200 } as Partial<WsTicker>), receivedAt: 2000 }, 3));
    assert.strictEqual(r.status, 'ignored');
    // snapshot version unchanged
    assert.strictEqual(store.getSnapshot('bitget', 'BTC/USDT')!.snapshotVersion, 5);
  });

  it('older ticker.ts is ignored without version change', () => {
    const ticker = makeTicker({ ts: 5000 } as Partial<WsTicker>);
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker, receivedAt: 1000 }, 1));
    const r = store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker({ ts: 3000 } as Partial<WsTicker>), receivedAt: 2000 }, 2));
    assert.strictEqual(r.status, 'ignored');
    assert.strictEqual(store.getSnapshot('bitget', 'BTC/USDT')!.snapshotVersion, 1);
  });

  it('same ticker.ts with receivedAt not newer is ignored', () => {
    const ticker = makeTicker({ ts: 5000 } as Partial<WsTicker>);
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker, receivedAt: 5000 }, 1));
    const r = store.apply(makeEnvelope('market.ticker.updated',
      { ticker, receivedAt: 5000 }, 2));
    assert.strictEqual(r.status, 'ignored');
  });
});

// ─── Kline apply ────────────────────────────────────────────────────────────
describe('kline apply', () => {
  let store: KernelMarketStateStore;
  let clock: { now: () => number };

  beforeEach(() => {
    let t = 5000;
    clock = { now: () => t++ };
    store = createKernelMarketStateStore({ clock, staleAfterMs: 60000 });
  });

  it('applies kline event and populates interval', () => {
    const kline = makeKline();
    const r = store.apply(makeEnvelope('market.kline.closed',
      { kline, receivedAt: 1000 }, 1));
    assert.strictEqual(r.status, 'applied');
    assert.ok(r.snapshot!.klines['1m']);
  });

  it('older kline.ts per interval is ignored', () => {
    store.apply(makeEnvelope('market.kline.closed',
      { kline: makeKline({ ts: 2000, close: 200 } as Partial<WsKline>), receivedAt: 2000 }, 1));
    const r = store.apply(makeEnvelope('market.kline.closed',
      { kline: makeKline({ ts: 1000 } as Partial<WsKline>), receivedAt: 3000 }, 2));
    assert.strictEqual(r.status, 'ignored');
  });

  it('ticker and kline intervals are isolated', () => {
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker(), receivedAt: 1000 }, 1));
    store.apply(makeEnvelope('market.kline.closed',
      { kline: makeKline(), receivedAt: 1000 }, 2));
    const snap = store.getSnapshot('bitget', 'BTC/USDT')!;
    assert.ok(snap.ticker);
    assert.ok(snap.klines['1m']);
  });
});

// ─── symbol/exchange isolation ──────────────────────────────────────────────
describe('symbol and exchange isolation', () => {
  let store: KernelMarketStateStore;
  let clock: { now: () => number };

  beforeEach(() => {
    let t = 5000;
    clock = { now: () => t++ };
    store = createKernelMarketStateStore({ clock, staleAfterMs: 60000 });
  });

  it('different symbols have independent snapshots', () => {
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker(), receivedAt: 1000 }, 1));
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker({ instId: 'ETH/USDT' } as Partial<WsTicker>), receivedAt: 1000 }, 2));
    assert.ok(store.getSnapshot('bitget', 'BTC/USDT'));
    assert.ok(store.getSnapshot('bitget', 'ETH/USDT'));
    const all = store.getAllSnapshots();
    assert.strictEqual(all.length, 2);
  });

  it('different exchanges have independent snapshots', () => {
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker(), receivedAt: 1000 }, 1));
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker({ exchange: 'binance' } as Partial<WsTicker>), receivedAt: 1000 }, 2));
    assert.ok(store.getSnapshot('bitget', 'BTC/USDT'));
    assert.ok(store.getSnapshot('binance', 'BTC/USDT'));
  });
});

// ─── research event irrelevant ──────────────────────────────────────────────
describe('research event', () => {
  it('is irrelevant', () => {
    const store = createKernelMarketStateStore({ staleAfterMs: 60000 });
    const r = store.apply(makeEnvelope('research.bias.updated',
      { report: { exchange: 'bitget' }, receivedAt: 1000 }, 1));
    assert.strictEqual(r.status, 'irrelevant');
    assert.strictEqual(r.snapshot, undefined);
  });
});

// ─── Staleness ──────────────────────────────────────────────────────────────
describe('staleness', () => {
  it('isStale=true when ageMs > staleAfterMs', () => {
    let now = 1000;
    const clock: DomainClock = { now: () => now };
    const store = createKernelMarketStateStore({ clock, staleAfterMs: 1000 });
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker(), receivedAt: 500 }, 1));
    // advance clock past staleness threshold
    now = 100000;
    const snap = store.getSnapshot('bitget', 'BTC/USDT')!;
    assert.strictEqual(snap.isStale, true);
    assert.ok(snap.ageMs >= 90000);
  });

  it('isStale=false when ageMs <= staleAfterMs', () => {
    const clock: DomainClock = { now: () => 6000 };
    const store = createKernelMarketStateStore({ clock, staleAfterMs: 60000 });
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker(), receivedAt: 5000 }, 1));
    const snap = store.getSnapshot('bitget', 'BTC/USDT')!;
    assert.strictEqual(snap.isStale, false);
  });
});

// ─── Mutation isolation ─────────────────────────────────────────────────────
describe('mutation isolation', () => {
  it('caller mutating returned snapshot does not affect store', () => {
    const store = createKernelMarketStateStore({ staleAfterMs: 60000 });
    store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker(), receivedAt: 1000 }, 1));
    const snap = store.getSnapshot('bitget', 'BTC/USDT')!;
    assert.ok(Object.isFrozen(snap));
    // Second read returns fresh independent snapshot
    const snap2 = store.getSnapshot('bitget', 'BTC/USDT')!;
    assert.ok(Object.isFrozen(snap2));
    assert.notStrictEqual(snap, snap2); // different object instances
  });
});

// ─── Invalid input ──────────────────────────────────────────────────────────
describe('invalid input', () => {
  it('non-finite ticker price throws', () => {
    const store = createKernelMarketStateStore({ staleAfterMs: 60000 });
    assert.throws(() => store.apply(makeEnvelope('market.ticker.updated',
      { ticker: makeTicker({ last: NaN } as unknown as Partial<WsTicker>), receivedAt: 1 }, 1)),
      /NON_FINITE_TICKER/);
  });
});

// ─── Subscription integration ───────────────────────────────────────────────
describe('kernel subscription integration', () => {
  it('store receives events via kernel subscribe', () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    const store = createKernelMarketStateStore({ staleAfterMs: 60000 });
    kernel.subscribe('market.ticker.updated', (e) => { store.apply(e); });
    kernel.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const snap = store.getSnapshot('bitget', 'BTC/USDT');
    assert.ok(snap);
  });
});
