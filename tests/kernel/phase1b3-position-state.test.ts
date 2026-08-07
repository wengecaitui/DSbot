// Phase 1B3: KernelPositionStateStore — RED contract tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { ConfirmedFill } from '../../src/types/confirmed-fill';
import type { ConfirmedPositionBaseline, VersionedPositionSnapshot } from '../../src/types/position-state';
import { createKernelPositionStateStore } from '../../src/kernel/KernelPositionStateStore';
import type { KernelPositionStateStore, KernelEventEnvelope } from '../../src/kernel/KernelPositionStateStore';
import { createTradingKernel } from '../../src/kernel/TradingKernel';

const BITGET = 'bitget' as const;
const SHA64 = 'a'.repeat(64);

function mkEnv<T>(type: string, payload: T, seq: number = 1): KernelEventEnvelope {
  return { kernelEventId: SHA64, kernelLogicalSequence: seq, kernelTimestamp: 1000 * seq,
    type, payload } as unknown as KernelEventEnvelope;
}

function mkFill(overrides?: Partial<ConfirmedFill>): ConfirmedFill {
  return { fillId: 'fill-001', exchange: BITGET, symbol: 'BTC/USDT', side: 'buy',
    quantity: 1.0, price: 50000, executedAt: 1000, ...overrides };
}

function mkBaseline(overrides?: Partial<ConfirmedPositionBaseline>): ConfirmedPositionBaseline {
  return { exchange: BITGET, symbol: 'BTC/USDT', side: 'flat', signedQuantity: 0,
    averageEntryPrice: 0, ...overrides };
}

function applyFill(s: KernelPositionStateStore, overrides?: Partial<ConfirmedFill>, seq = 1) {
  return s.apply(mkEnv('execution.fill.confirmed', { fill: mkFill(overrides) }, seq));
}

function applyBaseline(s: KernelPositionStateStore, overrides?: Partial<ConfirmedPositionBaseline>, seq = 1) {
  return s.apply(mkEnv('position.baseline.confirmed', { baseline: mkBaseline(overrides) }, seq));
}

// ─── Missing vs flat ────────────────────────────────────────────────────────
describe('missing vs flat', () => {
  it('missing resolve != flat', () => {
    const s = createKernelPositionStateStore();
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.status, 'missing');
    assert.strictEqual(r.snapshot, null);
  });
});

// ─── Baseline ───────────────────────────────────────────────────────────────
describe('baseline', () => {
  it('missing → KNOWN_FLAT', () => {
    const s = createKernelPositionStateStore();
    applyBaseline(s, { side: 'flat', signedQuantity: 0, averageEntryPrice: 0 });
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.status, 'flat');
    assert.strictEqual(r.signedQuantity, 0);
  });
  it('missing → OPEN LONG', () => {
    const s = createKernelPositionStateStore();
    applyBaseline(s, { side: 'long', signedQuantity: 2, averageEntryPrice: 40000 });
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.status, 'open');
    assert.strictEqual(r.side, 'long');
    assert.strictEqual(r.signedQuantity, 2);
    assert.strictEqual(r.averageEntryPrice, 40000);
  });
  it('second baseline on initialized key → fail closed', () => {
    const s = createKernelPositionStateStore();
    applyBaseline(s, { side: 'flat' }, 1);
    assert.throws(() => applyBaseline(s, { side: 'long', signedQuantity: 1, averageEntryPrice: 100 }, 2), /already initialized/);
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'flat');
  });
});

// ─── Fill transitions ──────────────────────────────────────────────────────
describe('fill transitions', () => {
  let s: KernelPositionStateStore;
  beforeEach(() => { s = createKernelPositionStateStore(); });

  it('flat + buy → long', () => {
    applyFill(s, { side: 'buy', quantity: 1, price: 50000 });
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.side, 'long');
    assert.strictEqual(r.signedQuantity, 1);
    assert.strictEqual(r.averageEntryPrice, 50000);
  });
  it('flat + sell → short', () => {
    applyFill(s, { side: 'sell', quantity: 1, price: 50000 });
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').side, 'short');
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').signedQuantity, -1);
  });
  it('long same-side scale-in → weighted avg', () => {
    applyFill(s, { side: 'buy', quantity: 1, price: 100 }, 1);
    applyFill(s, { side: 'buy', quantity: 1, price: 200, fillId: 'fill-002' }, 2);
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.side, 'long');
    assert.strictEqual(r.signedQuantity, 2);
    assert.strictEqual(r.averageEntryPrice, 150); // (100+200)/2
  });
  it('short same-side scale-in → weighted avg', () => {
    applyFill(s, { side: 'sell', quantity: 2, price: 100 }, 1);
    applyFill(s, { side: 'sell', quantity: 1, price: 400, fillId: 'fill-002' }, 2);
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').signedQuantity, -3);
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').averageEntryPrice, 200); // (200+400)/3
  });
  it('partial long reduction → avg unchanged', () => {
    applyFill(s, { side: 'buy', quantity: 2, price: 100 }, 1);
    applyFill(s, { side: 'sell', quantity: 1, price: 200, fillId: 'fill-002' }, 2);
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.signedQuantity, 1);
    assert.strictEqual(r.averageEntryPrice, 100);
  });
  it('partial short reduction → avg unchanged', () => {
    applyFill(s, { side: 'sell', quantity: 3, price: 100 }, 1);
    applyFill(s, { side: 'buy', quantity: 1, price: 200, fillId: 'fill-002' }, 2);
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').signedQuantity, -2);
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').averageEntryPrice, 100);
  });
  it('full close → KNOWN_FLAT retained', () => {
    applyFill(s, { side: 'buy', quantity: 1, price: 50000 }, 1);
    applyFill(s, { side: 'sell', quantity: 1, price: 51000, fillId: 'fill-002' }, 2);
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.status, 'flat');
    assert.strictEqual(r.signedQuantity, 0);
    assert.strictEqual(r.averageEntryPrice, 0);
    assert.ok(s.getLatest(BITGET, 'BTC/USDT')); // record retained
  });
  it('long → short flip', () => {
    applyFill(s, { side: 'buy', quantity: 1, price: 100 }, 1);
    applyFill(s, { side: 'sell', quantity: 3, price: 200, fillId: 'fill-002' }, 2);
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.side, 'short');
    assert.strictEqual(r.signedQuantity, -2);
    assert.strictEqual(r.averageEntryPrice, 200);
  });
  it('short → long flip', () => {
    applyFill(s, { side: 'sell', quantity: 2, price: 100 }, 1);
    applyFill(s, { side: 'buy', quantity: 3, price: 200, fillId: 'fill-002' }, 2);
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').side, 'long');
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').signedQuantity, 1);
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').averageEntryPrice, 200);
  });
});

// ─── Ordering ──────────────────────────────────────────────────────────────
describe('ordering', () => {
  it('positionVersion = kernelLogicalSequence', () => {
    const s = createKernelPositionStateStore();
    s.apply(mkEnv('execution.fill.confirmed', { fill: mkFill() }, 5));
    assert.strictEqual(s.getLatest(BITGET, 'BTC/USDT')!.positionVersion, 5);
  });
  it('late executedAt at newer kernel sequence → applied', () => {
    const s = createKernelPositionStateStore();
    applyFill(s, { executedAt: 5000 }, 1);
    applyFill(s, { executedAt: 100, fillId: 'fill-002' }, 2);
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').signedQuantity, 2);
  });
  it('older/equal kernel sequence → ignored', () => {
    const s = createKernelPositionStateStore();
    applyFill(s, {}, 5);
    const r = applyFill(s, { fillId: 'fill-002' }, 3);
    assert.strictEqual(r.status, 'ignored');
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').signedQuantity, 1);
  });
});

// ─── Domain idempotency ────────────────────────────────────────────────────
describe('domain idempotency', () => {
  it('identical fillId duplicate → idempotent', () => {
    const s = createKernelPositionStateStore();
    applyFill(s, { quantity: 0.5, price: 100 }, 1);
    const r = applyFill(s, { quantity: 0.5, price: 100 }, 2);
    assert.strictEqual(r.status, 'ignored');
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').signedQuantity, 0.5);
  });
  it('conflicting fillId duplicate → fail closed', () => {
    const s = createKernelPositionStateStore();
    applyFill(s, { quantity: 1, price: 100 }, 1);
    assert.throws(() => applyFill(s, { quantity: 2, price: 200 }, 2), /conflicting fillId/);
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').signedQuantity, 1);
  });
});

// ─── Isolation ─────────────────────────────────────────────────────────────
describe('isolation', () => {
  it('two exchanges isolated', () => {
    const s = createKernelPositionStateStore();
    s.apply(mkEnv('execution.fill.confirmed', { fill: mkFill({ exchange: BITGET, symbol: 'BTC/USDT' }) }, 1));
    s.apply(mkEnv('execution.fill.confirmed', { fill: mkFill({ exchange: 'binance' as ExchangeId, symbol: 'BTC/USDT', fillId: 'fill-002' }) }, 2));
    assert.ok(s.getLatest(BITGET, 'BTC/USDT'));
    assert.ok(s.getLatest('binance' as ExchangeId, 'BTC/USDT'));
  });
  it('two symbols isolated', () => {
    const s = createKernelPositionStateStore();
    applyFill(s, { symbol: 'BTC/USDT' }, 1);
    applyFill(s, { symbol: 'ETH/USDT', fillId: 'fill-002' }, 2);
    assert.ok(s.getLatest(BITGET, 'BTC/USDT'));
    assert.ok(s.getLatest(BITGET, 'ETH/USDT'));
  });
});

// ─── Immutability ──────────────────────────────────────────────────────────
describe('immutability', () => {
  it('returned snapshots immutable', () => {
    const s = createKernelPositionStateStore();
    applyFill(s, {}, 1);
    const snap = s.getLatest(BITGET, 'BTC/USDT')!;
    assert.ok(Object.isFrozen(snap));
    try { (snap as Record<string,unknown>).signedQuantity = 999; } catch { /* frozen */ }
    assert.strictEqual(s.getLatest(BITGET, 'BTC/USDT')!.signedQuantity, 1);
  });
});

// ─── History ───────────────────────────────────────────────────────────────
describe('history', () => {
  it('bounded history + getByVersion', () => {
    const s = createKernelPositionStateStore({ maxSnapshotsPerSymbol: 2 });
    applyFill(s, { quantity: 1, fillId: 'f1' }, 1);
    applyFill(s, { quantity: 1, fillId: 'f2' }, 2);
    applyFill(s, { quantity: 1, fillId: 'f3' }, 3);
    assert.ok(s.getByVersion(BITGET, 'BTC/USDT', 3));
    assert.strictEqual(s.getByVersion(BITGET, 'BTC/USDT', 1), undefined);
  });
});

// ─── Kernel integration ────────────────────────────────────────────────────
describe('kernel integration', () => {
  it('publish → journal → store', () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    const s = createKernelPositionStateStore();
    kernel.subscribe('execution.fill.confirmed', (e) => { s.apply(e); });
    kernel.publish('execution.fill.confirmed', { fill: mkFill() });
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'open');
  });
  it('legacy events irrelevant', () => {
    const s = createKernelPositionStateStore();
    const r = s.apply({ type: 'market.ticker.updated' } as never as KernelEventEnvelope);
    assert.strictEqual(r.status, 'irrelevant');
  });
});

// ─── FIX_1: Pre-journal validation ─────────────────────────────────────────
describe('pre-journal validation', () => {
  it('invalid execution.fill.confirmed throws before journal', () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    let called = false;
    kernel.subscribe('execution.fill.confirmed', () => { called = true; });
    assert.throws(() => kernel.publish('execution.fill.confirmed',
      { fill: { fillId: '' } } as never), /fillId/);
    assert.strictEqual(called, false);
    assert.strictEqual(kernel.journal().readFromLogicalSequence(1).length, 0);
  });
  it('invalid position.baseline.confirmed throws before journal', () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    let called = false;
    kernel.subscribe('position.baseline.confirmed', () => { called = true; });
    assert.throws(() => kernel.publish('position.baseline.confirmed',
      { baseline: { exchange: BITGET, symbol: 'BTC/USDT', side: 'flat', signedQuantity: 1, averageEntryPrice: 0 } } as never), /flat requires/);
    assert.strictEqual(called, false);
    assert.strictEqual(kernel.journal().readFromLogicalSequence(1).length, 0);
  });
});

// ─── FIX_2: Fill initializes key ──────────────────────────────────────────
describe('fill initializes key', () => {
  it('first fill → baseline afterwards throws', () => {
    const s = createKernelPositionStateStore();
    applyFill(s, { side: 'buy', quantity: 1, price: 50000 }, 1);
    // Baseline on already-initialized key must throw
    assert.throws(() => applyBaseline(s, { side: 'flat' }, 2), /already initialized/);
    // Fill-derived position unchanged
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.status, 'open');
    assert.strictEqual(r.side, 'long');
    assert.strictEqual(r.signedQuantity, 1);
    assert.strictEqual(r.averageEntryPrice, 50000);
    assert.strictEqual(s.getLatest(BITGET, 'BTC/USDT')!.positionVersion, 1);
  });
  it('valid fill Kernel integration still works', () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    const s = createKernelPositionStateStore();
    kernel.subscribe('execution.fill.confirmed', (e) => { s.apply(e); });
    kernel.publish('execution.fill.confirmed', { fill: mkFill() });
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'open');
  });
});
