// Phase 3: OMS Core — kernel-integration contract tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { generateOrderId } from '../../src/oms/order-id';
import { OmsCore } from '../../src/oms/OmsCore';
import { OmsOrderStore } from '../../src/oms/OmsOrderStore';
import type { ExecutionAdapter, ExecutionResult, OmsOrder, OmsConfirmedFill } from '../../src/oms/oms-types';
import type { TradeIntent, TradingKernel } from '../../src/types/trade-intent';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { simulateFill } from '../../src/paper/FillSimulator';
import type { FillSimulatorConfig } from '../../src/paper/FillSimulator';

const BITGET = 'bitget' as ExchangeId;

function mkIntent(overrides?: Partial<TradeIntent>): TradeIntent {
  return { intentId: 'intent-001', exchange: BITGET, symbol: 'BTC/USDT',
    direction: 'long', orderType: 'market', positionUsd: 10000, source: 'test',
    createdAt: 1000, reason: 'test', biasUpdatedAt: 500, ...overrides } as TradeIntent;
}

function createKernel(): TradingKernel {
  return createTradingKernel({ exchange: BITGET });
}

class FakeAdapter implements ExecutionAdapter {
  result: ExecutionResult | null = null;
  calls: OmsOrder[] = [];
  _throw: Error | null = null;
  async submit(order: OmsOrder): Promise<ExecutionResult> {
    this.calls.push(order);
    if (this._throw) throw this._throw;
    if (this.result) return this.result;
    // Default: produce proper fill using FillSimulator
    const intent: TradeIntent = mkIntent({ positionUsd: order.approvedNotionalUsd });
    const cfg: FillSimulatorConfig = { markPriceUsd: 50000, feeBps: 10, slippageBps: 5, executedAtMs: 2000, fillIdPrefix: 'pfx' };
    const { fill: rawFill } = simulateFill(intent, cfg, this.calls.length);
    const fill: OmsConfirmedFill = {
      fillId: rawFill.fillId, exchange: rawFill.exchange,
      symbol: rawFill.symbol, side: rawFill.side, quantity: rawFill.quantity,
      price: rawFill.priceUsd, executedAt: rawFill.executedAt,
      orderId: order.orderId, intentId: order.intentId };
    return { status: 'filled', fill };
  }
}

// ─── orderId ────────────────────────────────────────────────────────────────
describe('order ID', () => {
  it('deterministic', () => {
    const id1 = generateOrderId({ intentId: 'a', exchange: 'x', symbol: 'b', direction: 'long', action: 'open', approvedPositionUsd: 500 });
    const id2 = generateOrderId({ intentId: 'a', exchange: 'x', symbol: 'b', direction: 'long', action: 'open', approvedPositionUsd: 500 });
    assert.strictEqual(id1, id2);
  });
});

// ─── OmsCore kernel-integration ─────────────────────────────────────────────
describe('OmsCore kernel integration', () => {
  it('order.created goes through TradingKernel journal', async () => {
    const kernel = createKernel();
    const oms = new OmsCore(kernel, new FakeAdapter());
    await oms.submitRequest(mkIntent(), 'open', 5000);
    const entries = kernel.journal().readFromLogicalSequence(1);
    assert.ok(entries.length >= 1);
    assert.strictEqual(entries[0].type, 'order.created');
  });
  it('no randomUUID in OMS', async () => {
    const kernel = createKernel();
    const oms = new OmsCore(kernel, new FakeAdapter());
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    // kernelEventId is SHA64, not UUID
    const entries = kernel.journal().readFromLogicalSequence(1);
    for (const e of entries) {
      assert.ok(/^[0-9a-f]{64}$/.test(e.kernelEventId), `eventId should be SHA64: ${e.kernelEventId}`);
    }
  });
  it('journal sequence becomes orderVersion', async () => {
    const kernel = createKernel();
    const oms = new OmsCore(kernel, new FakeAdapter());
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.ok(r.order!.orderVersion > 0);
  });
  it('journal kernelEventId becomes sourceKernelEventId', async () => {
    const kernel = createKernel();
    const oms = new OmsCore(kernel, new FakeAdapter());
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.ok(/^[0-9a-f]{64}$/.test(r.order!.sourceKernelEventId));
  });
  it('invalid order event → journal unchanged', async () => {
    const kernel = createKernel();
    assert.throws(() => kernel.publish('order.created' as Parameters<typeof kernel.publish>[0], {} as Parameters<typeof kernel.publish>[1]));
    assert.strictEqual(kernel.journal().readFromLogicalSequence(1).length, 0);
  });
  it('retry identical request → duplicate, adapter called once', async () => {
    const kernel = createKernel();
    const adapter = new FakeAdapter();
    const oms = new OmsCore(kernel, adapter);
    await oms.submitRequest(mkIntent(), 'open', 5000);
    const r2 = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(adapter.calls.length, 1);
  });
  it('SUBMISSION_UNKNOWN cannot blindly retry', async () => {
    const kernel = createKernel();
    const adapter = new FakeAdapter(); adapter._throw = new Error('fail');
    const oms = new OmsCore(kernel, adapter);
    await oms.submitRequest(mkIntent(), 'open', 5000);
    const r2 = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(adapter.calls.length, 1);
  });
  it('approvedPositionUsd determines execution size', async () => {
    const kernel = createKernel();
    const adapter = new FakeAdapter();
    const oms = new OmsCore(kernel, adapter);
    await oms.submitRequest(mkIntent({ positionUsd: 20000 }), 'open', 5000);
    assert.strictEqual(adapter.calls[0].approvedNotionalUsd, 5000);
  });
  it('original TradeIntent unchanged', async () => {
    const intent = mkIntent({ positionUsd: 20000 });
    const kernel = createKernel();
    const oms = new OmsCore(kernel, new FakeAdapter());
    await oms.submitRequest(intent, 'open', 5000);
    assert.strictEqual(intent.positionUsd, 20000);
  });
  it('fill attribution validation: wrong orderId → rejected', async () => {
    const kernel = createKernel();
    const adapter = new FakeAdapter();
    const oms = new OmsCore(kernel, adapter);
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    const fill: OmsConfirmedFill = {
      fillId: 'bad', exchange: BITGET, symbol: 'BTC/USDT', side: 'buy',
      quantity: 0.1, price: 50000, executedAt: 2000,
      orderId: 'WRONG', intentId: 'intent-001' };
    adapter.result = { status: 'filled', fill };
    const r2 = await oms.submitRequest(mkIntent({ intentId: 'intent-002' }), 'open', 6000);
    assert.strictEqual(r2.status, 'rejected');
  });
  it('fill wrong exchange → rejected', async () => {
    const kernel = createKernel();
    const adapter = new FakeAdapter();
    const oms = new OmsCore(kernel, adapter);
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    const fill: OmsConfirmedFill = {
      fillId: 'bad', exchange: 'binance' as ExchangeId, symbol: 'BTC/USDT', side: 'buy',
      quantity: 0.1, price: 50000, executedAt: 2000,
      orderId: '', intentId: 'intent-001' };
    adapter.result = { status: 'filled', fill };
    const r2 = await oms.submitRequest(mkIntent({ intentId: 'intent-002' }), 'open', 6000);
    assert.strictEqual(r2.status, 'rejected');
  });
  it('fill wrong intentId → rejected', async () => {
    const kernel = createKernel();
    const adapter = new FakeAdapter();
    const oms = new OmsCore(kernel, adapter);
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    const fill: OmsConfirmedFill = {
      fillId: 'bad', exchange: BITGET, symbol: 'BTC/USDT', side: 'buy',
      quantity: 0.1, price: 50000, executedAt: 2000,
      orderId: '', intentId: 'WRONG' };
    adapter.result = { status: 'filled', fill };
    const r2 = await oms.submitRequest(mkIntent({ intentId: 'intent-002' }), 'open', 6000);
    assert.strictEqual(r2.status, 'rejected');
  });
  it('genuine matching fill → FILLED', async () => {
    const kernel = createKernel();
    const oms = new OmsCore(kernel, new FakeAdapter());
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r.status, 'filled');
    assert.strictEqual(r.order!.status, 'FILLED');
  });
  it('protective action label preserved', async () => {
    const kernel = createKernel();
    const oms = new OmsCore(kernel, new FakeAdapter());
    const r = await oms.submitRequest(mkIntent({ direction: 'short' }), 'close', 5000);
    assert.strictEqual(r.order!.action, 'close');
    assert.strictEqual(r.order!.side, 'sell');
  });
  it('adapter thrown → submission_unknown', async () => {
    const kernel = createKernel();
    const adapter = new FakeAdapter(); adapter._throw = new Error('fail');
    const oms = new OmsCore(kernel, adapter);
    const r = await oms.submitRequest(mkIntent({ intentId: 'fresh-adapt' }), 'open', 5000);
    assert.strictEqual(r.status, 'submission_unknown');
  });
  it('adapter rejected → REJECTED', async () => {
    const kernel = createKernel();
    const adapter = new FakeAdapter(); adapter.result = { status: 'rejected', reason: 'nope' };
    const oms = new OmsCore(kernel, adapter);
    const r = await oms.submitRequest(mkIntent({ intentId: 'fresh-rej' }), 'open', 5000);
    assert.strictEqual(r.status, 'rejected');
  });
});

// ─── OmsOrderStore transition safety ────────────────────────────────────────
describe('OmsOrderStore transition safety', () => {
  it('FILLED cannot transition back', () => {
    const store = new OmsOrderStore();
    store.apply({ type: 'order.created', payload: { order: makeSnap('o1', 'CREATED') }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'order.submitted', payload: { orderId: 'o1' }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    store.apply({ type: 'execution.fill.confirmed', payload: { fill: { orderId: 'o1', fillId: 'f1' } }, kernelLogicalSequence: 3, kernelEventId: 'e3' } as any);
    assert.strictEqual(store.get('o1')!.status, 'FILLED');
    assert.throws(() => store.apply({ type: 'order.submitted', payload: { orderId: 'o1' }, kernelLogicalSequence: 4, kernelEventId: 'e4' } as any));
  });
  it('REJECTED cannot transition again', () => {
    const store = new OmsOrderStore();
    store.apply({ type: 'order.created', payload: { order: makeSnap('o1', 'CREATED') }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'order.rejected', payload: { orderId: 'o1', reason: 'x' }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.throws(() => store.apply({ type: 'order.submitted', payload: { orderId: 'o1' }, kernelLogicalSequence: 3, kernelEventId: 'e3' } as any));
  });
  it('stale/equal sequence → no mutation', () => {
    const store = new OmsOrderStore();
    store.apply({ type: 'order.created', payload: { order: makeSnap('o1', 'CREATED') }, kernelLogicalSequence: 5, kernelEventId: 'e1' } as any);
    const r = store.apply({ type: 'order.submitted', payload: { orderId: 'o1' }, kernelLogicalSequence: 3, kernelEventId: 'e2' } as any);
    assert.strictEqual(r, null);
    assert.strictEqual(store.get('o1')!.status, 'CREATED');
  });
});

function makeSnap(oid: string, status: string): any {
  return { orderId: oid, intentId: 'i1', exchange: BITGET, symbol: 'BTC/USDT',
    action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 500,
    status, orderVersion: 0, sourceKernelEventId: '' };
}

// ─── PaperAdapter ───────────────────────────────────────────────────────────
describe('PaperAdapter', () => {
  it('uses FillSimulator via approvedNotionalUsd', async () => {
    const { PaperExecutionAdapter } = await import('../../src/oms/PaperExecutionAdapter');
    const a = new PaperExecutionAdapter({ markPriceUsd: 50000, feeBps: 10, slippageBps: 5, executedAtMs: 2000, fillIdPrefix: 'pfx', counter: 0 });
    const r = await a.submit({ orderId: 'o1', intentId: 'i1', exchange: BITGET, symbol: 'BTC/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 5000 });
    assert.strictEqual(r.status, 'filled');
    if (r.status === 'filled') {
      assert.ok(r.fill.quantity > 0);
      assert.strictEqual(r.fill.orderId, 'o1');
      assert.strictEqual(r.fill.intentId, 'i1');
      assert.strictEqual(r.fill.price, 50025);
    }
  });
});
