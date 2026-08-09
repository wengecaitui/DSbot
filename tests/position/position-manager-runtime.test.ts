// Phase 4B: PositionManagerRuntime — production-path integration tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createKernelPositionStateStore } from '../../src/kernel/KernelPositionStateStore';
import { createPositionManagerRuntime } from '../../src/position/PositionManagerRuntime';
import { generatePlanId } from '../../src/position/plan-id';
import type { PositionPlan } from '../../src/position/position-plan-types';

const BITGET = 'bitget' as any;
const unlockedHardRisk = { exchange: 'bitget' as any, locked: false, enabled: true, totalCapitalUsd: 1_000_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: Infinity };

function mkMarketStore(lastPrice?: number) {
  const price = lastPrice ?? 50000;
  return { get(_e: string, _s: string) { return { exchange: 'bitget', symbol: 'BTC/USDT', isStale: false, ticker: { ticker: { last: price } } }; } } as any;
}

function mkPlanId(seq: number): string { return generatePlanId('bitget', 'BTC/USDT', 'long', 50000, seq); }

// ─── Fill-driven lifecycle ──────────────────────────────────────────────────
describe('Fill-driven lifecycle', () => {
  it('position store starts missing', () => {
    const store = createKernelPositionStateStore();
    assert.strictEqual(store.resolve(BITGET, 'BTC/USDT').status, 'missing');
  });

  it('kernel fill event updates position store', async () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    const positionStore = createKernelPositionStateStore();
    kernel.subscribe('execution.fill.confirmed', (env: any) => positionStore.apply(env));
    await kernel.publish('execution.fill.confirmed', { fill: { fillId: 'f1', intentId: 'i1', orderId: 'o1', exchange: 'bitget', symbol: 'BTC/USDT', side: 'buy', direction: 'buy', quantity: 1, price: 50000, executedAt: 1, fees: [] } });
    const pos = positionStore.resolve(BITGET, 'BTC/USDT');
    assert.ok(['open', 'flat'].includes(pos.status) || pos.status !== 'missing', 'positionStore must track fills');
  });
});

// ─── LIVE_READY + idempotency ───────────────────────────────────────────────
describe('LIVE_READY boundary + idempotency', () => {
  it('replay mode default → no OMS submission on market tick', async () => {
    const submitted: any[] = [];
    const kernel = createTradingKernel({ exchange: BITGET });
    const positionStore = createKernelPositionStateStore();
    kernel.subscribe('execution.fill.confirmed', (env: any) => positionStore.apply(env));
    const rt = createPositionManagerRuntime({ kernel, positionStore, planStore: { getActive() { return undefined; } }, marketStore: mkMarketStore(47499), hardRisk: () => unlockedHardRisk, oms: { submitRequest: async (i: any) => { submitted.push(i); return { status: 'submitted' }; } } });
    rt.start();
    await kernel.publish('market.ticker.updated', { ticker: { exchange: 'bitget', symbol: 'BTC/USDT', last: 47499 } });
    assert.strictEqual(submitted.length, 0, 'replay mode: zero OMS submissions');
  });

  it('live mode with plan → one submission, second tick idempotent', async () => {
    const submitted: any[] = [];
    const kernel = createTradingKernel({ exchange: BITGET });
    const positionStore = createKernelPositionStateStore();
    kernel.subscribe('execution.fill.confirmed', (env: any) => positionStore.apply(env));
    await kernel.publish('execution.fill.confirmed', { fill: { fillId: 'f1', intentId: 'i1', orderId: 'o1', exchange: 'bitget', symbol: 'BTC/USDT', side: 'buy', direction: 'buy', quantity: 1, price: 50000, executedAt: 1, fees: [] } });
    const pid = mkPlanId(5);
    const planStore = {
      _plan: { planId: pid, symbol: 'BTC/USDT', positionSide: 'long', entryPrice: 50000, entryQuantity: 1, stopPrice: 47500, status: 'active', planVersion: 5 } as PositionPlan,
      getActive() { return this._plan; },
    };
    const rt = createPositionManagerRuntime({ kernel, positionStore, planStore, marketStore: mkMarketStore(47499), hardRisk: () => unlockedHardRisk, oms: { submitRequest: async (i: any) => { submitted.push(i); return { status: 'submitted' }; } } });
    rt.start();
    rt.setMode('live');
    await kernel.publish('market.ticker.updated', { ticker: { exchange: 'bitget', symbol: 'BTC/USDT', last: 47499 } });
    assert.strictEqual(submitted.length, 1, 'first breached tick → OMS submission');
    await kernel.publish('market.ticker.updated', { ticker: { exchange: 'bitget', symbol: 'BTC/USDT', last: 47300 } });
    assert.strictEqual(submitted.length, 1, 'second tick → idempotent, no duplicate');
  });

  it('market above stop → no submission', async () => {
    const submitted: any[] = [];
    const kernel = createTradingKernel({ exchange: BITGET });
    const positionStore = createKernelPositionStateStore();
    kernel.subscribe('execution.fill.confirmed', (env: any) => positionStore.apply(env));
    await kernel.publish('execution.fill.confirmed', { fill: { fillId: 'f1', intentId: 'i1', orderId: 'o1', exchange: 'bitget', symbol: 'BTC/USDT', side: 'buy', direction: 'buy', quantity: 1, price: 50000, executedAt: 1, fees: [] } });
    const pid = mkPlanId(1);
    const planStore = { _plan: { planId: pid, symbol: 'BTC/USDT', positionSide: 'long', entryPrice: 50000, stopPrice: 47500, status: 'active', planVersion: 1 } as any, getActive() { return this._plan; } };
    const rt = createPositionManagerRuntime({ kernel, positionStore, planStore, marketStore: mkMarketStore(48000), hardRisk: () => unlockedHardRisk, oms: { submitRequest: async (i: any) => { submitted.push(i); return { status: 'submitted' }; } } });
    rt.start();
    rt.setMode('live');
    await kernel.publish('market.ticker.updated', { ticker: { exchange: 'bitget', symbol: 'BTC/USDT', last: 48000 } });
    assert.strictEqual(submitted.length, 0, 'price above stop → no submit');
  });
});

// ─── OMS truthfulness ──────────────────────────────────────────────────────
describe('OMS outcome truthfulness', () => {
  it('no OMS configured → zero submissions', async () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    const positionStore = createKernelPositionStateStore();
    const rt = createPositionManagerRuntime({ kernel, positionStore, planStore: { getActive() { return undefined; } }, marketStore: mkMarketStore(), hardRisk: () => unlockedHardRisk, oms: undefined });
    rt.start();
    assert.strictEqual(rt.getSubmittedCount(), 0, 'no OMS → no submissions');
  });
});

// ─── Scope boundaries ──────────────────────────────────────────────────────
describe('Scope boundaries', () => {
  it('different exchange → different planId', () => {
    assert.notStrictEqual(generatePlanId('bitget', 'BTC/USDT', 'long', 50000, 1), generatePlanId('bybit', 'BTC/USDT', 'long', 50000, 1));
  });
});
