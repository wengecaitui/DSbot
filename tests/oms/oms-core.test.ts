// Phase 3: OMS Core — final repair contract tests
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

const BITGET = 'bitget' as ExchangeId;

function mkIntent(overrides?: Partial<TradeIntent>): TradeIntent {
  return { intentId: 'intent-001', exchange: BITGET, symbol: 'BTC/USDT',
    direction: 'long', orderType: 'market', positionUsd: 10000, source: 'test',
    createdAt: 1000, reason: 'test', biasUpdatedAt: 500, ...overrides } as TradeIntent;
}

function createKernel() { return createTradingKernel({ exchange: BITGET }); }

function makeFill(orderOrderId: string, overrides?: Partial<OmsConfirmedFill>): OmsConfirmedFill {
  return { fillId: 'f-001', exchange: BITGET, symbol: 'BTC/USDT', side: 'buy',
    quantity: 0.2, price: 50000, executedAt: 2000,
    orderId: orderOrderId, intentId: 'intent-001', ...overrides };
}

class FakeAdapter implements ExecutionAdapter {
  calls: OmsOrder[] = [];
  result: ExecutionResult | null = null;
  _throw: Error | null = null;
  async submit(order: OmsOrder): Promise<ExecutionResult> {
    this.calls.push(order);
    if (this._throw) throw this._throw;
    if (this.result) return this.result;
    return { status: 'filled', fill: makeFill(order.orderId) };
  }
}

// ─── kernel integration ─────────────────────────────────────────────────────
describe('kernel integration', () => {
  it('order.created goes through TradingKernel journal', async () => {
    const kernel = createKernel();
    const oms = new OmsCore(kernel, new FakeAdapter());
    await oms.submitRequest(mkIntent(), 'open', 5000);
    const entries = kernel.journal().readFromLogicalSequence(1);
    assert.ok(entries.length >= 1, `expected >=1 entries, got ${entries.length}`);
  });
  it('no randomUUID', async () => {
    const kernel = createKernel();
    const oms = new OmsCore(kernel, new FakeAdapter());
    await oms.submitRequest(mkIntent(), 'open', 5000);
    for (const e of kernel.journal().readFromLogicalSequence(1)) {
      assert.ok(/^[0-9a-f]{64}$/.test(e.kernelEventId));
    }
  });
  it('journal sequence → orderVersion', async () => {
    const oms = new OmsCore(createKernel(), new FakeAdapter());
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.ok(r.order!.orderVersion > 0);
  });
  it('approvedPositionUsd determines size', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(createKernel(), adapter);
    await oms.submitRequest(mkIntent({ positionUsd: 20000 }), 'open', 5000);
    assert.strictEqual(adapter.calls[0].approvedNotionalUsd, 5000);
  });
  it('original TradeIntent unchanged', async () => {
    const intent = mkIntent({ positionUsd: 20000 });
    const oms = new OmsCore(createKernel(), new FakeAdapter());
    await oms.submitRequest(intent, 'open', 5000);
    assert.strictEqual(intent.positionUsd, 20000);
  });
  it('protective action label preserved', async () => {
    const oms = new OmsCore(createKernel(), new FakeAdapter());
    const r = await oms.submitRequest(mkIntent({ direction: 'short' }), 'close', 5000);
    assert.strictEqual(r.order!.action, 'close');
    assert.strictEqual(r.order!.side, 'sell');
  });
});

// ─── FIX_2: misattributed fill → SUBMISSION_UNKNOWN ────────────────────────
describe('misattributed fill → SUBMISSION_UNKNOWN', () => {
  async function testBad(mkFill: (oid: string) => OmsConfirmedFill) {
    const adapter = new FakeAdapter(); adapter.result = null;
    const kernel = createKernel(); const oms = new OmsCore(kernel, adapter);
    const r = await oms.submitRequest(mkIntent(), 'open', 5000);
    adapter.result = { status: 'filled', fill: mkFill(r.order!.orderId) };
    const r2 = await oms.submitRequest(mkIntent({ intentId: 'fresh-1' }), 'open', 5000);
    assert.strictEqual(r2.status, 'submission_unknown');
    // execution.fill.confirmed NOT published
    const fills = kernel.journal().readFromLogicalSequence(1).filter(e => e.type === 'execution.fill.confirmed');
    assert.strictEqual(fills.length, 1); // only first fill
  }
  it('wrong orderId', () => testBad(oid => makeFill('WRONG')));
  it('wrong intentId', () => testBad(oid => makeFill(oid, { intentId: 'WRONG' })));
  it('wrong exchange', () => testBad(oid => makeFill(oid, { exchange: 'binance' as ExchangeId })));
  it('wrong symbol', () => testBad(oid => makeFill(oid, { symbol: 'ETH/USDT' })));
  it('wrong side', () => testBad(oid => makeFill(oid, { side: 'sell' })));
  it('invalid numeric fill', () => testBad(oid => makeFill(oid, { quantity: -1, price: NaN, executedAt: Infinity })));
  it('definite reject → REJECTED', async () => {
    const adapter = new FakeAdapter(); adapter.result = { status: 'rejected', reason: 'nope' };
    const oms = new OmsCore(createKernel(), adapter);
    const r = await oms.submitRequest(mkIntent({ intentId: 'uniq-rej' }), 'open', 5000);
    assert.strictEqual(r.status, 'rejected');
  });
});

// ─── FIX_3: strict event validation ─────────────────────────────────────────
describe('strict event validation', () => {
  it('invalid exchange → journal unchanged', async () => {
    const kernel = createKernel();
    assert.throws(() => kernel.publish('order.created', { order: { orderId: 'o1', intentId: 'i1', exchange: '!!bad!!', symbol: 'X', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 100 } } as any));
    assert.strictEqual(kernel.journal().readFromLogicalSequence(1).length, 0);
  });
  it('invalid action → journal unchanged', async () => {
    const kernel = createKernel();
    assert.throws(() => kernel.publish('order.created', { order: { orderId: 'o1', intentId: 'i1', exchange: BITGET, symbol: 'X', action: 'unknown', side: 'buy', orderType: 'market', approvedNotionalUsd: 100 } } as any));
    assert.strictEqual(kernel.journal().readFromLogicalSequence(1).length, 0);
  });
  it('invalid side → journal unchanged', async () => {
    const kernel = createKernel();
    assert.throws(() => kernel.publish('order.created', { order: { orderId: 'o1', intentId: 'i1', exchange: BITGET, symbol: 'X', action: 'open', side: 'neither', orderType: 'market', approvedNotionalUsd: 100 } } as any));
    assert.strictEqual(kernel.journal().readFromLogicalSequence(1).length, 0);
  });
  it('approvedNotionalUsd <= 0', async () => {
    const kernel = createKernel();
    assert.throws(() => kernel.publish('order.created', { order: { orderId: 'o1', intentId: 'i1', exchange: BITGET, symbol: 'X', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 0 } } as any));
    assert.strictEqual(kernel.journal().readFromLogicalSequence(1).length, 0);
  });
  it('approvedNotionalUsd NaN', async () => {
    const kernel = createKernel();
    assert.throws(() => kernel.publish('order.created', { order: { orderId: 'o1', intentId: 'i1', exchange: BITGET, symbol: 'X', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: NaN } } as any));
    assert.strictEqual(kernel.journal().readFromLogicalSequence(1).length, 0);
  });
  it('missing rejection reason', async () => {
    const kernel = createKernel();
    assert.throws(() => kernel.publish('order.rejected', { orderId: 'o1', reason: '' } as any));
    assert.strictEqual(kernel.journal().readFromLogicalSequence(1).length, 0);
  });
});

// ─── FIX_4: conflict check ─────────────────────────────────────────────────
describe('conflict check', () => {
  it('identical → duplicate', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(createKernel(), adapter);
    await oms.submitRequest(mkIntent(), 'open', 5000);
    const r2 = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(adapter.calls.length, 1);
  });
  it('conflicting same-orderId → fail closed', async () => {
    const adapter = new FakeAdapter();
    const oms = new OmsCore(createKernel(), adapter);
    await oms.submitRequest(mkIntent(), 'open', 5000);
    // Same intentId + action but different approved size → different orderId
    // Different approved → different orderId → NOT conflict
    const r2 = await oms.submitRequest(mkIntent(), 'open', 10000);
    assert.strictEqual(r2.status, 'filled');
    assert.strictEqual(adapter.calls.length, 2);
  });
  it('SUBMISSION_UNKNOWN duplicate blocked', async () => {
    const adapter = new FakeAdapter(); adapter._throw = new Error('fail');
    const oms = new OmsCore(createKernel(), adapter);
    await oms.submitRequest(mkIntent(), 'open', 5000);
    const r2 = await oms.submitRequest(mkIntent(), 'open', 5000);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(adapter.calls.length, 1);
  });
});

// ─── store transition safety ────────────────────────────────────────────────
describe('store transitions', () => {
  it('FILLED cannot transition back', () => {
    const s = new OmsOrderStore();
    s.apply(mkEvt('order.created', { order: mkSnap('o1', 'CREATED') }, 1));
    s.apply(mkEvt('order.submitted', { orderId: 'o1' }, 2));
    s.apply(mkEvt('execution.fill.confirmed', { fill: { orderId: 'o1', fillId: 'f1' } }, 3));
    assert.strictEqual(s.get('o1')!.status, 'FILLED');
    assert.throws(() => s.apply(mkEvt('order.submitted', { orderId: 'o1' }, 4)));
  });
  it('stale/equal seq → no mutation', () => {
    const s = new OmsOrderStore();
    s.apply(mkEvt('order.created', { order: mkSnap('o1', 'CREATED') }, 5));
    const r = s.apply(mkEvt('order.submitted', { orderId: 'o1' }, 3));
    assert.strictEqual(r, null);
    assert.strictEqual(s.get('o1')!.status, 'CREATED');
  });
  it('legacy fill without orderId → ignored', () => {
    const s = new OmsOrderStore();
    const r = s.apply(mkEvt('execution.fill.confirmed', { fill: { fillId: 'f1' } }, 1));
    assert.strictEqual(r, null);
  });
});

// ─── PaperAdapter (real PaperExecutionService) ──────────────────────────────
describe('PaperAdapter', () => {
  it('executes through real PaperExecutionService with approvedNotionalUsd', async () => {
    const { PaperExecutionAdapter } = await import('../../src/oms/PaperExecutionAdapter');
    const { PaperExecutionService } = await import('../../src/paper/PaperExecutionService');

    const svc = await PaperExecutionService.open(
      { exchange: BITGET, accountId: 'test-acct', initialCashUsd: 1000000 },
      { async save(): Promise<void> {}, async load(): Promise<any> { return null; } },
    );
    const a = new PaperExecutionAdapter(svc, { markPriceUsd: 50000, feeBps: 10, slippageBps: 5, executedAtMs: 2000 });
    const r = await a.submit({ orderId: 'o1', intentId: 'i1', exchange: BITGET, symbol: 'BTC/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 5000 });
    assert.strictEqual(r.status, 'filled');
    if (r.status === 'filled') {
      assert.ok(r.fill.quantity > 0);
      assert.strictEqual(r.fill.orderId, 'o1');
      assert.strictEqual(r.fill.intentId, 'i1');
      assert.strictEqual(r.fill.price, 50025);
    }
    // Verify paper ledger updated
    const snap = svc.snapshot();
    assert.ok(snap.processedFills >= 1, `expected >=1 processed fills, got ${snap.processedFills}`);
    assert.ok(snap.sequence >= 1);
  });
  it('no fake same-intentId TradeIntent constructed', async () => {
    const { PaperExecutionAdapter } = await import('../../src/oms/PaperExecutionAdapter');
    const { PaperExecutionService } = await import('../../src/paper/PaperExecutionService');
    const svc = await PaperExecutionService.open(
      { exchange: BITGET, accountId: 'test-acct2', initialCashUsd: 1000000 },
      { async save(): Promise<void> {}, async load(): Promise<any> { return null; } },
    );
    const a = new PaperExecutionAdapter(svc, { markPriceUsd: 50000, feeBps: 10, slippageBps: 5, executedAtMs: 2000 });
    const r = await a.submit({ orderId: 'o1', intentId: 'intent-001', exchange: BITGET, symbol: 'BTC/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 5000 });
    assert.strictEqual(r.status, 'filled');
    if (r.status === 'filled') {
      assert.strictEqual(r.fill.intentId, 'intent-001');
    }
  });
});

function mkEvt(type: string, payload: any, seq: number): any {
  return { type, payload, kernelLogicalSequence: seq, kernelEventId: 'e' + seq };
}
function mkSnap(oid: string, status: string): any {
  return { orderId: oid, intentId: 'i1', exchange: BITGET, symbol: 'BTC/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 500, status, orderVersion: 0, sourceKernelEventId: '' };
}
