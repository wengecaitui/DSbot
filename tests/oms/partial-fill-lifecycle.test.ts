import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createKernelPositionStateStore } from '../../src/kernel/KernelPositionStateStore';
import { OmsCore } from '../../src/oms/OmsCore';
import type { ExecutionAdapter, OrderExecutionObservation } from '../../src/oms/oms-types';
import { addQuantity, subtractQuantity, multiplyQuantity } from '../../src/types/decimal-quantity';

function setup(close = false, requested = 2) {
  const kernel = createTradingKernel({ exchange: 'gateio', clock: { now: () => 1000 } });
  const positions = createKernelPositionStateStore();
  kernel.subscribe('position.baseline.confirmed', e => { positions.apply(e); });
  kernel.subscribe('execution.fill.confirmed', e => { positions.apply(e); });
  kernel.publish('position.baseline.confirmed', { baseline: { exchange: 'gateio', symbol: 'ETH/USDT',
    side: close ? 'long' : 'flat', signedQuantity: close ? 2 : 0, averageEntryPrice: close ? 10 : 0 } });
  let calls = 0;
  const adapter: ExecutionAdapter = { async submit(order, prepared) {
    prepared!({ requestedQuantity: requested, venueQuantity: requested, quantityMultiplier: 1,
      clientOrderId: order.orderId, reduceOnly: close });
    calls++;
    return { status: 'accepted' };
  } };
  const oms = new OmsCore(kernel, adapter, undefined, (exchange, symbol) => positions.resolve(exchange, symbol));
  return { kernel, positions, oms, get calls() { return calls; }, async submit() {
    return oms.submitRequest({ intentId: 'partial', exchange: 'gateio', symbol: 'ETH/USDT',
      direction: close ? 'short' : 'long', orderType: 'market', positionUsd: 20,
      source: 'fixture', createdAt: 1, biasUpdatedAt: 1, reason: 'offline' }, close ? 'close' : 'open', 20);
  } };
}
function observation(orderId: string, overrides: Partial<OrderExecutionObservation> = {}): OrderExecutionObservation {
  return { orderId, exchangeOrderId: '12345678901234567', requestedQuantity: 2,
    cumulativeFilledQuantity: 1, remainingQuantity: 1, cumulativeNotional: 10,
    executedAt: 1000, status: 'PARTIALLY_FILLED', ...overrides };
}

describe('G5 common OMS cumulative fill contract', () => {
  it('decimal arithmetic never truncates a genuine fractional residual to zero', () => {
    assert.equal(addQuantity(0.1, 0.2), 0.3);
    assert.equal(subtractQuantity(0.3, 0.1), 0.2);
    assert.equal(multiplyQuantity(0.1, 0.003), 0.0003);
    assert.equal(subtractQuantity(0.1000000000000001, 0.1), 1e-16);
    assert.throws(() => addQuantity(Infinity, 1));
    assert.throws(() => multiplyQuantity(Number.MIN_VALUE, Number.MIN_VALUE));
  });
  it('zero/submitted -> partial -> full uses delta not cumulative quantity and incremental cost basis', async () => {
    const h = setup(); const orderId = (await h.submit()).order!.orderId;
    h.oms.applyExecutionObservation(observation(orderId, { cumulativeFilledQuantity: 0,
      cumulativeNotional: 0, remainingQuantity: 2, status: 'SUBMITTED' }));
    h.oms.applyExecutionObservation(observation(orderId));
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 1);
    const full = observation(orderId, { cumulativeFilledQuantity: 2, remainingQuantity: 0,
      cumulativeNotional: 30, status: 'FILLED', executedAt: 2000 });
    h.oms.applyExecutionObservation(full);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 2);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').averageEntryPrice, 15);
    assert.deepEqual(h.oms.getStore().get(orderId)!.fills!.map(f => [f.quantity, f.price]), [[1, 10], [1, 20]]);
    const before = h.kernel.journal().readFromLogicalSequence(1).length;
    assert.equal(h.oms.applyExecutionObservation(full).status, 'duplicate');
    assert.equal(h.kernel.journal().readFromLogicalSequence(1).length, before);
    const firstFillEvent = h.kernel.journal().readFromLogicalSequence(1)
      .find(event => event.type === 'execution.fill.confirmed')!;
    const replay = h.kernel.publish('execution.fill.confirmed', firstFillEvent.payload as any);
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.failures, 0);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 2);
    assert.equal(h.calls, 1);
  });
  it('partial CLOSE applies only factual quantity; subsequent fill reaches flat exactly once', async () => {
    const h = setup(true); const orderId = (await h.submit()).order!.orderId;
    h.oms.applyExecutionObservation(observation(orderId));
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 1);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').status, 'open');
    const full = observation(orderId, { cumulativeFilledQuantity: 2, cumulativeNotional: 20,
      remainingQuantity: 0, status: 'FILLED' });
    h.oms.applyExecutionObservation(full);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').status, 'flat');
    assert.equal(h.oms.applyExecutionObservation(full).status, 'duplicate');
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 0);
  });
  it('IOC cancellation after partial changes lifecycle, never quantity or residual exposure', async () => {
    const h = setup(true); const orderId = (await h.submit()).order!.orderId;
    h.oms.applyExecutionObservation(observation(orderId));
    h.oms.applyExecutionObservation(observation(orderId, { status: 'CANCELLED' }));
    assert.equal(h.oms.getStore().get(orderId)!.remainingQuantity, 1);
    assert.equal(h.oms.getStore().get(orderId)!.fills!.length, 1);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 1);
    assert.throws(() => h.oms.applyExecutionObservation(observation(orderId, { status: 'FILLED',
      cumulativeFilledQuantity: 2, remainingQuantity: 0, cumulativeNotional: 20 })), /TERMINAL_CONFLICT/);
  });
  for (const [label, invalid] of Object.entries({
    regression: { cumulativeFilledQuantity: 0.5, remainingQuantity: 1.5, cumulativeNotional: 5 },
    notional: { cumulativeNotional: 11 }, identity: { exchangeOrderId: 'different' },
    request: { requestedQuantity: 3, remainingQuantity: 2 },
    overfill: { cumulativeFilledQuantity: 3, remainingQuantity: 0, cumulativeNotional: 30 },
    clock: { executedAt: 999 }, malformed: { cumulativeFilledQuantity: NaN },
    falseFull: { status: 'FILLED' },
  }) as [string, Partial<OrderExecutionObservation>][]) {
    it(label + ' is rejected before any journal or position mutation', async () => {
      const h = setup(); const orderId = (await h.submit()).order!.orderId;
      h.oms.applyExecutionObservation(observation(orderId));
      const before = h.kernel.journal().readFromLogicalSequence(1).length;
      assert.throws(() => h.oms.applyExecutionObservation(observation(orderId, invalid)));
      assert.equal(h.kernel.journal().readFromLogicalSequence(1).length, before);
      assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 1);
    });
  }
  it('reduce-only request larger than factual exposure cannot reach the adapter mutation', async () => {
    const h = setup(true, 3);
    assert.equal((await h.submit()).status, 'submission_unknown');
    assert.equal(h.calls, 0);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 2);
  });
  it('reduce-only later delta cannot exceed residual exposure even after a separate factual reduction', async () => {
    const h = setup(true); const orderId = (await h.submit()).order!.orderId;
    h.oms.applyExecutionObservation(observation(orderId));
    h.kernel.publish('execution.fill.confirmed', { fill: { exchange: 'gateio', symbol: 'ETH/USDT',
      fillId: 'external-reduction', side: 'sell', quantity: 0.5, price: 10, executedAt: 1500 } });
    assert.throws(() => h.oms.applyExecutionObservation(observation(orderId, {
      cumulativeFilledQuantity: 2, cumulativeNotional: 20, remainingQuantity: 0,
      status: 'FILLED', executedAt: 2000 })), /EXPOSURE_CONFLICT/);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 0.5);
  });
});
