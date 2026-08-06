// Phase 1B1: KernelMarketStateStore — contract tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import type { WsTicker, WsKline } from '../../src/data/types';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import { sourceKey } from '../../src/data/MarketIdentity';
import type { MarketSnapshot } from '../../src/data/MarketSnapshot';
import type { DomainClock } from '../../src/runtime/Clock';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createKernelMarketStateStore } from '../../src/kernel/KernelMarketStateStore';
import type { KernelMarketStateStore } from '../../src/kernel/KernelMarketStateStore';
import type { KernelEventEnvelope } from '../../src/kernel/KernelEventEnvelope';

const BITGET = 'bitget' as const;

// ─── Complete valid fixtures ────────────────────────────────────────────────
const validTicker: WsTicker = {
  exchange: BITGET, instId: 'BTC/USDT', channel: 'ticker',
  last: 50000, bestBid: 49900, bestAsk: 50100,
  volume24h: 1234, high24h: 51000, low24h: 49000, ts: 1000,
};

const validKline: WsKline = {
  exchange: BITGET, instId: 'BTC/USDT', channel: 'kline',
  interval: '1m', open: 100, high: 105, low: 95, close: 102,
  volume: 500, confirm: true, ts: 1000,
};

function env(type: string, payload: Record<string,unknown>, seq: number): KernelEventEnvelope {
  return {
    kernelEventId: 'a'.repeat(64), kernelLogicalSequence: seq, kernelTimestamp: 1000 * seq,
    type, payload,
  } as unknown as KernelEventEnvelope;
}

function tickerEnv(t: Partial<WsTicker>, receivedAt: number, seq: number): KernelEventEnvelope {
  return env('market.ticker.updated', {
    ticker: { ...validTicker, ...t } as WsTicker,
    receivedAt,
  } as Record<string,unknown>, seq);
}

function klineEnv(k: Partial<WsKline>, receivedAt: number, seq: number): KernelEventEnvelope {
  return env('market.kline.closed', {
    kline: { ...validKline, ...k } as WsKline,
    receivedAt,
  } as Record<string,unknown>, seq);
}

function mkClock(init: number): DomainClock & { advance(ms: number): void } {
  let t = init;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function mkStore(clock?: DomainClock): KernelMarketStateStore {
  return createKernelMarketStateStore({ clock: clock ?? mkClock(0), staleAfterMs: 60000 });
}

// ─── Invalid config ─────────────────────────────────────────────────────────
describe('invalid config', () => {
  it('rejects missing clock', () => {
    assert.throws(() => createKernelMarketStateStore({ staleAfterMs: 1000 } as unknown as { clock: DomainClock; staleAfterMs: number }), /STORAGE_CONFIG/);
  });
  it('rejects non-finite staleAfterMs', () => {
    assert.throws(() => createKernelMarketStateStore({ clock: mkClock(0), staleAfterMs: NaN }), /STORAGE_CONFIG/);
  });
  it('rejects zero staleAfterMs', () => {
    assert.throws(() => createKernelMarketStateStore({ clock: mkClock(0), staleAfterMs: 0 }), /STORAGE_CONFIG/);
  });
  it('rejects negative staleAfterMs', () => {
    assert.throws(() => createKernelMarketStateStore({ clock: mkClock(0), staleAfterMs: -1 }), /STORAGE_CONFIG/);
  });
});

// ─── Ticker validation ──────────────────────────────────────────────────────
describe('ticker validation', () => {
  it('rejects non-ticker channel', () => {
    const s = mkStore();
    assert.throws(() => s.apply(tickerEnv({ channel: 'kline' } as Partial<WsTicker>, 1, 1)), /TICKER_CHANNEL/);
  });
  it('rejects non-finite last', () => {
    const s = mkStore();
    assert.throws(() => s.apply(tickerEnv({ last: NaN } as Partial<WsTicker>, 1, 1)), /NON_FINITE_TICKER/);
  });
  it('rejects non-finite receivedAt', () => {
    const s = mkStore();
    assert.throws(() => {
      s.apply(env('market.ticker.updated', { ticker: validTicker, receivedAt: NaN }, 1));
    }, /NON_FINITE_TICKER/);
  });
});

// ─── Kline validation ───────────────────────────────────────────────────────
describe('kline validation', () => {
  it('rejects non-kline channel', () => {
    const s = mkStore();
    assert.throws(() => s.apply(klineEnv({ channel: 'ticker' } as Partial<WsKline>, 1, 1)), /KLINE_CHANNEL/);
  });
  it('rejects confirm=false', () => {
    const s = mkStore();
    assert.throws(() => s.apply(klineEnv({ confirm: false } as Partial<WsKline>, 1, 1)), /KLINE_NOT_CONFIRMED/);
  });
  it('rejects empty interval', () => {
    const s = mkStore();
    assert.throws(() => s.apply(klineEnv({ interval: '' } as Partial<WsKline>, 1, 1)), /KLINE_INTERVAL/);
  });
  it('rejects non-finite close', () => {
    const s = mkStore();
    assert.throws(() => s.apply(klineEnv({ close: Infinity } as Partial<WsKline>, 1, 1)), /NON_FINITE_KLINE/);
  });
});

// ─── Core apply ─────────────────────────────────────────────────────────────
describe('core apply', () => {
  let s: KernelMarketStateStore;
  beforeEach(() => { s = mkStore(); });

  it('ticker apply', () => {
    const r = s.apply(tickerEnv({}, 1000, 1));
    assert.strictEqual(r.status, 'applied');
    assert.ok(r.snapshot);
  });

  it('snapshot exchange and symbol exact', () => {
    const r = s.apply(tickerEnv({}, 1000, 1));
    assert.strictEqual(r.snapshot!.exchange, 'bitget');
    assert.strictEqual(r.snapshot!.symbol, 'BTC/USDT');
  });

  it('version equals accepted kernel sequence', () => {
    const r = s.apply(tickerEnv({}, 1000, 5));
    assert.strictEqual(r.snapshot!.snapshotVersion, 5);
  });

  it('kline apply', () => {
    const r = s.apply(klineEnv({}, 1000, 1));
    assert.strictEqual(r.status, 'applied');
    assert.ok(r.snapshot!.klines['1m']);
  });

  it('research event irrelevant', () => {
    const r = s.apply(env('research.bias.updated', { report: { exchange: 'bitget' } }, 1));
    assert.strictEqual(r.status, 'irrelevant');
    assert.strictEqual(r.snapshot, undefined);
  });
});

// ─── Ignored events ─────────────────────────────────────────────────────────
describe('ignored events', () => {
  let s: KernelMarketStateStore;
  beforeEach(() => { s = mkStore(); });

  it('out-of-order kernel sequence ignored', () => {
    s.apply(tickerEnv({}, 1000, 5));
    const r = s.apply(tickerEnv({ last: 60000 } as Partial<WsTicker>, 2000, 3));
    assert.strictEqual(r.status, 'ignored');
    assert.strictEqual(s.getSnapshot('bitget', 'BTC/USDT')!.snapshotVersion, 5);
  });

  it('older ticker.ts ignored', () => {
    s.apply(tickerEnv({ ts: 5000 } as Partial<WsTicker>, 1000, 1));
    const r = s.apply(tickerEnv({ ts: 3000 } as Partial<WsTicker>, 2000, 2));
    assert.strictEqual(r.status, 'ignored');
  });

  it('same-ts newer ticker accepted', () => {
    s.apply(tickerEnv({ ts: 5000 } as Partial<WsTicker>, 1000, 1));
    const r = s.apply(tickerEnv({ ts: 5000 } as Partial<WsTicker>, 2000, 2));
    assert.strictEqual(r.status, 'applied');
  });

  it('same-ts same-or-older receivedAt ignored', () => {
    s.apply(tickerEnv({ ts: 5000 } as Partial<WsTicker>, 2000, 1));
    const r = s.apply(tickerEnv({ ts: 5000 } as Partial<WsTicker>, 2000, 2));
    assert.strictEqual(r.status, 'ignored');
  });

  it('older kline.ts per interval ignored', () => {
    s.apply(klineEnv({ ts: 2000, close: 200 } as Partial<WsKline>, 2000, 1));
    const r = s.apply(klineEnv({ ts: 1000 } as Partial<WsKline>, 3000, 2));
    assert.strictEqual(r.status, 'ignored');
  });

  it('same-ts newer kline per interval accepted', () => {
    s.apply(klineEnv({ ts: 2000 } as Partial<WsKline>, 1000, 1));
    const r = s.apply(klineEnv({ ts: 2000 } as Partial<WsKline>, 2000, 2));
    assert.strictEqual(r.status, 'applied');
  });
});

// ─── lastUpdatedAt ──────────────────────────────────────────────────────────
describe('lastUpdatedAt', () => {
  it('never regresses', () => {
    const s = mkStore();
    s.apply(tickerEnv({}, 5000, 1));
    s.apply(klineEnv({ ts: 2000 } as Partial<WsKline>, 1000, 2));
    const snap = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.ok(snap.lastUpdatedAt >= 5000);
  });
});

// ─── Symbol/exchange isolation ──────────────────────────────────────────────
describe('isolation', () => {
  it('symbol isolation', () => {
    const s = mkStore();
    s.apply(tickerEnv({}, 1000, 1));
    s.apply(tickerEnv({ instId: 'ETH/USDT' } as Partial<WsTicker>, 1000, 2));
    assert.ok(s.getSnapshot('bitget', 'BTC/USDT'));
    assert.ok(s.getSnapshot('bitget', 'ETH/USDT'));
    assert.strictEqual(s.getAllSnapshots().length, 2);
  });

  it('ticker/kline receivedAt isolation', () => {
    const s = mkStore();
    s.apply(tickerEnv({}, 5000, 1));
    s.apply(klineEnv({}, 1000, 2));
    const snap = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.ok(snap.ticker);
    assert.ok(snap.klines['1m']);
  });
});

// ─── Staleness ──────────────────────────────────────────────────────────────
describe('staleness', () => {
  it('isStale=true when ageMs > staleAfterMs', () => {
    const c = mkClock(1000);
    const s = createKernelMarketStateStore({ clock: c, staleAfterMs: 1000 });
    s.apply(tickerEnv({}, 500, 1));
    c.advance(100000);
    assert.strictEqual(s.getSnapshot('bitget', 'BTC/USDT')!.isStale, true);
  });
  it('isStale=false when ageMs <= staleAfterMs', () => {
    const c = mkClock(6000);
    const s = createKernelMarketStateStore({ clock: c, staleAfterMs: 60000 });
    s.apply(tickerEnv({}, 5000, 1));
    assert.strictEqual(s.getSnapshot('bitget', 'BTC/USDT')!.isStale, false);
  });
});

// ─── Mutation isolation ─────────────────────────────────────────────────────
describe('mutation isolation', () => {
  it('caller mutation cannot affect store', () => {
    const s = mkStore();
    const r = s.apply(tickerEnv({}, 1000, 1));
    assert.ok(Object.isFrozen(r.snapshot));
    const snap2 = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.ok(Object.isFrozen(snap2));
    assert.notStrictEqual(r.snapshot, snap2);
  });
});

// ─── Subscription integration ───────────────────────────────────────────────
describe('kernel subscription', () => {
  it('store receives events via kernel subscribe', () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    const s = mkStore();
    kernel.subscribe('market.ticker.updated', (e) => { s.apply(e); });
    kernel.publish('market.ticker.updated', { ticker: validTicker, receivedAt: 1 });
    assert.ok(s.getSnapshot('bitget', 'BTC/USDT'));
  });
});

// ─── Field-level validation ─────────────────────────────────────────────────
describe('field-level atomic validation', () => {
  it('invalid first event leaves getSnapshot undefined', () => {
    const s = mkStore();
    assert.throws(() => s.apply(tickerEnv({ last: NaN } as Partial<WsTicker>, 1, 1)), /NON_FINITE_TICKER/);
    assert.strictEqual(s.getSnapshot('bitget', 'BTC/USDT'), undefined);
  });

  it('invalid update preserves previous snapshot and version', () => {
    const s = mkStore();
    s.apply(tickerEnv({}, 1000, 1));
    const before = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.throws(() => s.apply(tickerEnv({ last: NaN } as Partial<WsTicker>, 2000, 2)), /NON_FINITE_TICKER/);
    const after = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.strictEqual(after.snapshotVersion, before.snapshotVersion);
    assert.strictEqual(after.lastUpdatedAt, before.lastUpdatedAt);
  });

  // Ticker: every numeric field with undefined, string, NaN, Infinity
  for (const [field, badValue] of [
    ['last', undefined],
    ['last', 'not-a-number'],
    ['last', NaN],
    ['last', Infinity],
    ['bestBid', undefined],
    ['bestAsk', NaN],
    ['volume24h', Infinity],
    ['high24h', 'abc'],
    ['low24h', null],
    ['ts', undefined],
  ] as const) {
    it(`ticker.${field} = ${JSON.stringify(badValue)} → throw, state unchanged`, () => {
      const s = mkStore();
      s.apply(tickerEnv({}, 1000, 1));
      const before = s.getSnapshot('bitget', 'BTC/USDT')!;
      assert.throws(() => s.apply(tickerEnv({ [field]: badValue } as Partial<WsTicker>, 2000, 2)), /NON_FINITE_TICKER/);
      const after = s.getSnapshot('bitget', 'BTC/USDT')!;
      assert.strictEqual(after.snapshotVersion, before.snapshotVersion);
    });
  }

  // Kline: every numeric field with undefined, string, NaN, Infinity
  for (const [field, badValue] of [
    ['open', undefined],
    ['open', 'not-a-number'],
    ['open', NaN],
    ['open', Infinity],
    ['close', undefined],
    ['volume', NaN],
    ['ts', 'abc'],
  ] as const) {
    it(`kline.${field} = ${JSON.stringify(badValue)} → throw, state unchanged`, () => {
      const s = mkStore();
      s.apply(klineEnv({}, 1000, 1));
      const before = s.getSnapshot('bitget', 'BTC/USDT')!;
      assert.throws(() => s.apply(klineEnv({ [field]: badValue } as Partial<WsKline>, 2000, 2)), /NON_FINITE_KLINE/);
      const after = s.getSnapshot('bitget', 'BTC/USDT')!;
      assert.strictEqual(after.snapshotVersion, before.snapshotVersion);
    });
  }
});

// ─── Mutation isolation deep ────────────────────────────────────────────────
describe('deep mutation isolation', () => {
  it('mutate original ticker after apply; stored state unchanged', () => {
    const s = mkStore();
    const mutableTicker = { ...validTicker };
    const mutablePayload = { ticker: mutableTicker, receivedAt: 1000 };
    s.apply(env('market.ticker.updated', mutablePayload as unknown as Record<string,unknown>, 1));
    // mutate original
    mutableTicker.last = 999999;
    mutableTicker.ts = 999999;
    const snap = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.notStrictEqual(snap.ticker!.ticker.last, 999999);
  });

  it('mutate original kline after apply; stored state unchanged', () => {
    const s = mkStore();
    const mutableKline = { ...validKline };
    const mutablePayload = { kline: mutableKline, receivedAt: 1000 };
    s.apply(env('market.kline.closed', mutablePayload as unknown as Record<string,unknown>, 1));
    mutableKline.close = 999999;
    const snap = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.notStrictEqual(snap.klines['1m'].kline.close, 999999);
  });
});

// ─── Exchange isolation ─────────────────────────────────────────────────────
describe('exchange isolation', () => {
  it('bitget and binance same symbol remain isolated', () => {
    const s = mkStore();
    s.apply(tickerEnv({}, 1000, 1));
    s.apply(tickerEnv({ exchange: 'binance' } as Partial<WsTicker>, 1000, 2));
    assert.ok(s.getSnapshot('bitget', 'BTC/USDT'));
    assert.ok(s.getSnapshot('binance', 'BTC/USDT'));
    const all = s.getAllSnapshots();
    assert.strictEqual(all.length, 2);
  });
});

// ─── Cyclic candidate atomic ────────────────────────────────────────────────
describe('cyclic candidate atomic', () => {
  it('cyclic ticker: first event clone throws, getSnapshot undefined', () => {
    const s = mkStore();
    const ticker: Record<string,unknown> = { exchange: BITGET, instId: 'BTC/USDT', channel: 'ticker',
      last: 100, bestBid: 99, bestAsk: 101, volume24h: 1, high24h: 100, low24h: 100, ts: 1 };
    ticker.cycle = ticker; // self-reference
    assert.throws(() => {
      s.apply(env('market.ticker.updated', { ticker, receivedAt: 1 }, 1));
    });
    assert.strictEqual(s.getSnapshot('bitget', 'BTC/USDT'), undefined);
  });

  it('cyclic kline update: state unchanged after clone failure', () => {
    const s = mkStore();
    s.apply(klineEnv({}, 1000, 1));
    const before = s.getSnapshot('bitget', 'BTC/USDT')!;
    const kline: Record<string,unknown> = { exchange: BITGET, instId: 'BTC/USDT', channel: 'kline',
      interval: '1m', open: 100, high: 105, low: 95, close: 102, volume: 500, confirm: true, ts: 2000 };
    kline.cycle = kline;
    assert.throws(() => {
      s.apply(env('market.kline.closed', { kline, receivedAt: 2000 }, 2));
    });
    const after = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.strictEqual(after.snapshotVersion, before.snapshotVersion);
    assert.strictEqual(after.lastUpdatedAt, before.lastUpdatedAt);
    assert.strictEqual(after.klines['1m'].kline.close, validKline.close);
  });
});

// ─── Returned snapshot nested mutation ──────────────────────────────────────
describe('returned snapshot nested mutation', () => {
  it('mutate snapshot.ticker.ticker.last → ineffective, subsequent read unchanged', () => {
    const s = mkStore();
    s.apply(tickerEnv({}, 1000, 1));
    const snap = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.ok(Object.isFrozen(snap));
    assert.ok(snap.ticker && Object.isFrozen(snap.ticker));
    const before = snap.ticker.ticker.last;
    // Attempt mutation on frozen object
    try { (snap.ticker.ticker as Record<string,unknown>).last = 999999; } catch { /* frozen */ }
    const after = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.strictEqual(after.ticker!.ticker.last, before);
  });

  it('mutate snapshot.klines[1m].kline.close → ineffective, subsequent read unchanged', () => {
    const s = mkStore();
    s.apply(klineEnv({}, 1000, 1));
    const snap = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.ok(snap.klines['1m'] && Object.isFrozen(snap.klines['1m']));
    const before = snap.klines['1m'].kline.close;
    try { (snap.klines['1m'].kline as Record<string,unknown>).close = 999999; } catch { /* frozen */ }
    const after = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.strictEqual(after.klines['1m'].kline.close, before);
  });
});

// ─── Additional invalid field coverage ──────────────────────────────────────
describe('additional invalid field coverage', () => {
  for (const [field, badValue] of [
    ['high', NaN],
    ['low', Infinity],
  ] as const) {
    it(`kline.${field} = ${JSON.stringify(badValue)} → throw, state unchanged`, () => {
      const s = mkStore();
      s.apply(klineEnv({}, 1000, 1));
      const before = s.getSnapshot('bitget', 'BTC/USDT')!;
      assert.throws(() => s.apply(klineEnv({ [field]: badValue } as Partial<WsKline>, 2000, 2)), /NON_FINITE_KLINE/);
      const after = s.getSnapshot('bitget', 'BTC/USDT')!;
      assert.strictEqual(after.snapshotVersion, before.snapshotVersion);
    });
  }

  it('kline receivedAt = NaN → throw, state unchanged', () => {
    const s = mkStore();
    s.apply(klineEnv({}, 1000, 1));
    const before = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.throws(() => {
      s.apply(env('market.kline.closed', { kline: validKline, receivedAt: NaN }, 2));
    }, /NON_FINITE_KLINE/);
    const after = s.getSnapshot('bitget', 'BTC/USDT')!;
    assert.strictEqual(after.snapshotVersion, before.snapshotVersion);
  });
});
