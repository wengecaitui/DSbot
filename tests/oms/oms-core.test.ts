// Phase 3: OMS Core — contract tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { generateOrderId } from '../../src/oms/order-id';
import { OmsCore } from '../../src/oms/OmsCore';
import { OmsOrderStore } from '../../src/oms/OmsOrderStore';
import type { ExecutionAdapter, ExecutionResult, OmsOrder } from '../../src/oms/oms-types';
import type { TradeIntent } from '../../src/types/trade-intent';
import type { ExchangeId } from '../../src/data/MarketIdentity';

const BITGET = 'bitget' as ExchangeId;

function mkIntent(overrides?: Partial<TradeIntent>): TradeIntent {
  return { intentId: 'intent-001', exchange: BITGET, symbol: 'BTC/USDT',
    direction: 'long', orderType: 'market', positionUsd: 10000, source: 'test',
    createdAt: 1000, reason: 'test', biasUpdatedAt: 500, ...overrides } as TradeIntent;
}

class FakeAdapter implements ExecutionAdapter {
  result: ExecutionResult | null = null;
  calls: OmsOrder[] = [];
  async submit(order: OmsOrder): Promise<ExecutionResult> { this.calls.push(order);
    if (this.result) return this.result;
    if (this._throw) throw this._throw;
    const fill: any = makeFill('fill-001');
    fill.orderId = order.orderId;
    fill.intentId = order.intentId;
    return { status: 'filled', fill };
  }
  _throw: Error | null = null;
}

function makeFill(fillId: string): any {
  return { fillId, exchange: BITGET, symbol: 'BTC/USDT', side: 'buy', quantity: 0.2,
    price: 50000, executedAt: 2000, orderId: '', intentId: '' };
}

function makeAdapter(result: ExecutionResult): FakeAdapter {
  const a = new FakeAdapter(); a.result = result; return a;
}

// ─── orderId ────────────────────────────────────────────────────────────────
describe('order ID', () => {
  it('deterministic', () => {
    const id1 = generateOrderId({ intentId: 'a', exchange: 'x', symbol: 'b', direction: 'long', action: 'open', approvedPositionUsd: 500 });
    const id2 = generateOrderId({ intentId: 'a', exchange: 'x', symbol: 'b', direction: 'long', action: 'open', approvedPositionUsd: 500 });
    assert.strictEqual(id1, id2);
  });
  it('different approvedSize → different id', () => {
    const id1 = generateOrderId({ intentId: 'a', exchange: 'x', symbol: 'b', direction: 'long', action: 'open', approvedPositionUsd: 500 });
    const id2 = generateOrderId({ intentId: 'a', exchange: 'x', symbol: 'b', direction: 'long', action: 'open', approvedPositionUsd: 1000 });
    assert.notStrictEqual(id1, id2);
  });
});

// ─── OmsCore ────────────────────────────────────────────────────────────────
describe('OmsCore', () => {
  it('approvedPositionUsd determines executed size', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(adapter);
    const r = await oms.submitRequest(mkIntent({ positionUsd: 20000 }), 'open', 5000);
    assert.strictEqual(r.status, 'filled');
    // OMS uses approvedPositionUsd, NOT intent.positionUsd
    assert.strictEqual(adapter.calls[0].approvedNotionalUsd, 5000);
    assert.notStrictEqual(adapter.calls[0].approvedNotionalUsd, 20000);
  });
  it('original TradeIntent unchanged', async () => {
    const intent = mkIntent({ positionUsd: 20000 });
    const adapter = new FakeAdapter();
    const oms = new OmsCore(adapter);
    await oms.submitRequest(intent, 'open', 5000);
    assert.strictEqual(intent.positionUsd, 20000);
  });
  it('retry same request → duplicate + adapter called once', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(adapter);
    const intent = mkIntent();
    await oms.submitRequest(intent, 'open', 5000);
    const r2 = await oms.submitRequest(intent, 'open', 5000);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(adapter.calls.length, 1);
  });
  it('different approved size → different orderId → new order', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(adapter);
    await oms.submitRequest(mkIntent(), 'open', 5000);
    const r2 = await oms.submitRequest(mkIntent(), 'open', 10000);
    assert.strictEqual(r2.status, 'filled');
    assert.strictEqual(adapter.calls.length, 2);
    assert.notStrictEqual(adapter.calls[0].approvedNotionalUsd, adapter.calls[1].approvedNotionalUsd);
  });
  it('filled lifecycle', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(adapter);
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r.status, 'filled');
    assert.ok(r.order);
    assert.strictEqual(r.order!.status, 'FILLED');
  });
  it('rejected lifecycle', async () => {
    const oms = new OmsCore(makeAdapter({ status: 'rejected', reason: 'test' }));
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r.status, 'rejected');
    assert.strictEqual(r.order!.status, 'REJECTED');
  });
  it('unknown → submission_unknown', async () => {
    const oms = new OmsCore(makeAdapter({ status: 'unknown', reason: 'timeout' }));
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r.status, 'submission_unknown');
    assert.strictEqual(r.order!.status, 'SUBMISSION_UNKNOWN');
  });
  it('adapter throw → submission_unknown', async () => {
    const oms = new OmsCore({ submit: () => { throw new Error('fail'); } });
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r.status, 'submission_unknown');
  });
  it('submission_unknown cannot blindly resubmit', async () => {
    const oms = new OmsCore({ submit: () => { throw new Error('fail'); } });
    await oms.submitRequest(mkIntent(), 'open', 5000);
    const r2 = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r2.status, 'duplicate');
  });
  it('fill has matching orderId + intentId', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(adapter);
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r.status, 'filled');
    if (r.status === 'filled') {
      assert.strictEqual(r.fill.orderId, r.order.orderId);
      assert.strictEqual(r.fill.intentId, 'intent-001');
    }
  });
  it('mismatched fill attribution → rejected', async () => {
    const adapter = new FakeAdapter();
    adapter.result = { status: 'filled', fill: { ...makeFill('f1'), orderId: 'wrong', intentId: 'intent-001' } };
    const oms = new OmsCore(adapter);
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r.status, 'rejected');
  });
  it('protective action label preserved', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(adapter);
    const r = await oms.submitRequest(mkIntent({ direction: 'short' }), 'close', 5000);
    assert.strictEqual(r.order!.action, 'close');
    assert.strictEqual(r.order!.side, 'sell');
  });
  it('side derivation: long → buy', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(adapter);
    const r = await oms.submitRequest(mkIntent({ direction: 'long' }), 'open', 5000);
    assert.strictEqual(r.order!.side, 'buy');
  });
  it('side derivation: short → sell', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(adapter);
    const r = await oms.submitRequest(mkIntent({ direction: 'short' }), 'open', 5000);
    assert.strictEqual(r.order!.side, 'sell');
  });
});

// ─── OmsOrderStore ──────────────────────────────────────────────────────────
describe('OmsOrderStore', () => {
  let store: OmsOrderStore;
  beforeEach(() => { store = new OmsOrderStore(); });

  it('order.created → CREATED', () => {
    const snap = store.apply({ type: 'order.created', payload: { order: { orderId: 'o1', intentId: 'i1', approvedNotionalUsd: 500 } }, kernelLogicalSequence: 1, kernelEventId: 'e1' });
    assert.strictEqual(snap.status, 'CREATED');
    assert.strictEqual(store.get('o1')!.status, 'CREATED');
  });
  it('order.submitted → SUBMITTED', () => {
    store.apply({ type: 'order.created', payload: { order: { orderId: 'o1', intentId: 'i1', approvedNotionalUsd: 500 } }, kernelLogicalSequence: 1, kernelEventId: 'e1' });
    store.apply({ type: 'order.submitted', payload: { orderId: 'o1' }, kernelLogicalSequence: 2, kernelEventId: 'e2' });
    assert.strictEqual(store.get('o1')!.status, 'SUBMITTED');
  });
  it('order.rejected → REJECTED', () => {
    store.apply({ type: 'order.created', payload: { order: { orderId: 'o1', intentId: 'i1', approvedNotionalUsd: 500 } }, kernelLogicalSequence: 1, kernelEventId: 'e1' });
    store.apply({ type: 'order.rejected', payload: { orderId: 'o1', reason: 'test' }, kernelLogicalSequence: 2, kernelEventId: 'e2' });
    assert.strictEqual(store.get('o1')!.status, 'REJECTED');
  });
  it('execution.fill.confirmed → FILLED', () => {
    store.apply({ type: 'order.created', payload: { order: { orderId: 'o1', intentId: 'i1', approvedNotionalUsd: 500 } }, kernelLogicalSequence: 1, kernelEventId: 'e1' });
    store.apply({ type: 'execution.fill.confirmed', payload: { fill: { orderId: 'o1', fillId: 'f1' } }, kernelLogicalSequence: 2, kernelEventId: 'e2' });
    assert.strictEqual(store.get('o1')!.status, 'FILLED');
  });
  it('order.submission.unknown → SUBMISSION_UNKNOWN', () => {
    store.apply({ type: 'order.created', payload: { order: { orderId: 'o1', intentId: 'i1', approvedNotionalUsd: 500 } }, kernelLogicalSequence: 1, kernelEventId: 'e1' });
    store.apply({ type: 'order.submission.unknown', payload: { orderId: 'o1', reason: 'timeout' }, kernelLogicalSequence: 2, kernelEventId: 'e2' });
    assert.strictEqual(store.get('o1')!.status, 'SUBMISSION_UNKNOWN');
  });
  it('getByIntent returns match', () => {
    store.apply({ type: 'order.created', payload: { order: { orderId: 'o1', intentId: 'i1', approvedNotionalUsd: 500 } }, kernelLogicalSequence: 1, kernelEventId: 'e1' });
    assert.strictEqual(store.getByIntent('i1')!.orderId, 'o1');
  });
  it('duplicate order.created → throws', () => {
    store.apply({ type: 'order.created', payload: { order: { orderId: 'o1', intentId: 'i1', approvedNotionalUsd: 500 } }, kernelLogicalSequence: 1, kernelEventId: 'e1' });
    assert.throws(() => store.apply({ type: 'order.created', payload: { order: { orderId: 'o1', intentId: 'i2', approvedNotionalUsd: 500 } }, kernelLogicalSequence: 2, kernelEventId: 'e2' }));
  });
  it('unknown event → throws', () => {
    assert.throws(() => store.apply({ type: 'unknown.event', payload: {} }));
  });
});

// ─── PaperAdapter ───────────────────────────────────────────────────────────
describe('PaperAdapter', () => {
  it('uses approvedNotionalUsd', async () => {
    const { PaperExecutionAdapter } = await import('../../src/oms/PaperExecutionAdapter');
    const adapter = new PaperExecutionAdapter({ markPriceUsd: 50000, feeBps: 10, slippageBps: 5, executedAtMs: 2000, fillIdPrefix: 'pfx', counter: 0 });
    const r = await adapter.submit({ orderId: 'o1', intentId: 'i1', exchange: BITGET, symbol: 'BTC/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 5000 });
    assert.strictEqual(r.status, 'filled');
    assert.ok(r.fill.quantity > 0);
    assert.strictEqual(r.fill.price, 50025);
    assert.strictEqual(r.fill.orderId, 'o1');
    assert.strictEqual(r.fill.intentId, 'i1');
  });
});
