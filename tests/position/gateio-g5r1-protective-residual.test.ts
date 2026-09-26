/** Real protection -> Risk -> OMS -> Gate adapter -> Kernel. Only the client port is fake. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createKernelPositionStateStore } from '../../src/kernel/KernelPositionStateStore';
import { createKernelMarketStateStore } from '../../src/kernel/KernelMarketStateStore';
import { OmsCore } from '../../src/oms/OmsCore';
import { PositionPlanStore } from '../../src/position/PositionPlanStore';
import { createPositionManagerRuntime } from '../../src/position/PositionManagerRuntime';
import { GateIoFuturesExecutionAdapter, type GateIoFuturesMarketOrderRequest } from '../../src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import type { GateIoCanonicalInstrumentFacts } from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';

const NOW = 1_800_000_000_000;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(unknown = false, projectCloseFills = true) {
  const kernel = createTradingKernel({ exchange: 'gateio', clock: { now: () => NOW } });
  const positions = createKernelPositionStateStore();
  const markets = createKernelMarketStateStore({ clock: { now: () => NOW }, staleAfterMs: 30_000 });
  const plans = new PositionPlanStore();
  kernel.subscribe('execution.fill.confirmed', e => {
    if (projectCloseFills || e.payload.fill.side === 'buy') positions.apply(e);
  });
  kernel.subscribe('position.baseline.confirmed', e => { positions.apply(e); });
  kernel.subscribe('market.ticker.updated', e => { markets.apply(e); });
  kernel.publish('position.baseline.confirmed', { baseline: { exchange: 'gateio', symbol: 'ETH/USDT',
    side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } });
  const requests: GateIoFuturesMarketOrderRequest[] = [];
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const facts: GateIoCanonicalInstrumentFacts = {
    contract: 'ETH_USDT', contractStatus: 'trading', contractOpenable: true, inDelisting: false,
    contractMultiplier: 0.001, minOrderSize: 0.1, maxOrderSize: 1000, decimalSizeEnabled: true,
    priceStep: 0.01, markPriceStep: 0.01, minLeverage: 1, maxLeverage: 100,
    markPrice: 2000, indexPrice: 2000, lastPrice: 2000, makerFeeRate: 0, takerFeeRate: 0,
    fundingRate: 0, serverTimeMs: NOW, observedAtMs: NOW, freshness: 'FRESH',
    source: 'gateio-usdt-futures-read', schemaVersion: 'gateio-l1a-v1',
  };
  const adapter = new GateIoFuturesExecutionAdapter({
    async getInstrumentFacts() { return { ...facts, markPrice: requests.length === 0 ? 2000 : 1890 }; },
    async submitMarketOrder(request) {
      requests.push(request);
      const count = requests.length;
      if (count === 2) { await held; if (unknown) throw new Error('OFFLINE_TRANSPORT_AMBIGUITY'); }
      return { status: count === 2 ? 'PARTIALLY_FILLED' : 'FINISHED', terminal: true,
        clientText: request.text, contract: request.contract,
        signedFilledSize: count === 2 ? request.size / 2 : request.size,
        averagePrice: 2000, executedAt: NOW / 1000 + count,
        tradeId: String(1000 + count), exchangeOrderId: String(1000 + count) };
    },
  });
  const oms = new OmsCore(kernel, adapter, undefined, (e, s) => positions.resolve(e, s));
  let locked = false;
  const runtime = createPositionManagerRuntime({ kernel, positionStore: positions, planStore: plans,
    marketStore: markets, oms, hardRisk: () => ({ exchange: 'gateio', enabled: true, locked, totalCapitalUsd: 1000,
      maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1000 }) });
  runtime.start(); runtime._setLive!();
  return { kernel, positions, plans, oms, runtime, requests, release: () => release!(),
    set locked(value: boolean) { locked = value; },
    async open() {
      await oms.submitRequest({ intentId: 'g5r1-open', exchange: 'gateio', symbol: 'ETH/USDT',
        direction: 'long', orderType: 'market', positionUsd: 4, source: 'offline-fixture',
        reason: 'open', createdAt: NOW, biasUpdatedAt: NOW }, 'open', 4);
      await flush();
    },
    tick(sequence: number) {
      return kernel.publish('market.ticker.updated', { ticker: { channel: 'ticker', exchange: 'gateio',
        instId: 'ETH/USDT', last: 1890, bestBid: 1889, bestAsk: 1891,
        volume24h: 100, high24h: 2100, low24h: 1800, ts: NOW + sequence }, receivedAt: NOW + sequence });
    },
  };
}

describe('Gate G5R1 protective terminal partial re-arm', () => {
  it('re-arms only for the next market event, closes residual once and then closes the plan', async t => {
    const h = harness(); t.after(() => h.runtime.stop()); await h.open();
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 0.002);
    h.kernel.subscribe('execution.fill.confirmed', e => {
      if (e.payload.fill.side === 'sell' && e.payload.execution?.status === 'CANCELLED') {
        // Arrives while the submission lock is active, but its deferred handler runs
        // after the cancelled promise callback. It must not become an automatic retry.
        queueMicrotask(() => {
          assert.equal(h.runtime.getSubmittedCount(), 1);
          h.tick(30);
        });
      }
    });
    h.tick(1); await flush();
    assert.equal(h.runtime.getSubmittedCount(), 1);
    assert.equal(h.requests.length, 2);
    assert.equal(h.tick(1).status, 'duplicate');
    h.tick(2); h.tick(3); await flush();
    assert.equal(h.requests.length, 2, 'active lock suppresses all concurrent triggers');
    h.release(); await flush();
    const first = h.oms.getStore().list().find(o => o.action === 'close')!;
    assert.equal(first.status, 'CANCELLED');
    assert.equal(first.cumulativeFilledQuantity, 0.001);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 0.001);
    assert.equal(h.runtime.getSubmittedCount(), 0);
    await flush(); assert.equal(h.requests.length, 2, 'cancelled callback does not submit');
    h.locked = true; h.tick(4); await flush();
    assert.equal(h.requests.length, 2, 're-armed path still traverses Risk');
    h.locked = false; h.tick(5); h.tick(6); await flush();
    assert.deepEqual(h.requests.map(r => [r.size, r.reduceOnly]), [[2, false], [-2, true], [-1, true]]);
    assert.notEqual(h.requests[1]!.text, h.requests[2]!.text, 'new residual order, not a POST retry');
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').status, 'flat');
    assert.equal(h.plans.getActive('gateio', 'ETH/USDT'), undefined);
    assert.equal(h.runtime.getSubmittedCount(), 0);
    h.tick(7); await flush(); assert.equal(h.requests.length, 3);
  });
  it('submission_unknown retains its lock despite later qualifying market events', async t => {
    const h = harness(true); t.after(() => h.runtime.stop()); await h.open();
    h.tick(1); await flush(); h.release(); await flush();
    assert.equal(h.oms.getStore().list().find(o => o.action === 'close')!.status, 'SUBMISSION_UNKNOWN');
    assert.equal(h.runtime.getSubmittedCount(), 1);
    h.tick(2); h.tick(3); await flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 0.002);
  });
  it('cancelled without the matching Kernel position projection cannot re-arm', async t => {
    const h = harness(false, false); t.after(() => h.runtime.stop()); await h.open();
    h.tick(1); await flush(); h.release(); await flush();
    assert.equal(h.oms.getStore().list().find(o => o.action === 'close')!.status, 'CANCELLED');
    assert.equal(h.positions.resolve('gateio', 'ETH/USDT').signedQuantity, 0.002);
    assert.equal(h.runtime.getSubmittedCount(), 1);
    h.tick(2); await flush(); assert.equal(h.requests.length, 2);
  });
});
