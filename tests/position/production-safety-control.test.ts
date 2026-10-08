import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createProductionAuthorityPorts } from '../../src/position/ProductionAuthorityPorts';

describe('Production authoritative consumer != generic observer', () => {
  it('observer throw/rejection cannot change publication outcome; unsubscribe remains scoped', async () => {
    const kernel = createTradingKernel({ exchange: 'gateio' });
    const { read } = createProductionAuthorityPorts(kernel, { exchange: 'gateio', accountId: 'offline' });
    let authoritative = 0, observed = 0;
    kernel.subscribe('position.baseline.confirmed', () => { authoritative += 1; });
    const unsubscribe = read.subscribe('position.baseline.confirmed', () => {
      observed += 1; throw new Error('OBSERVER');
    });
    read.subscribe('position.baseline.confirmed', async () => { throw new Error('ASYNC_OBSERVER'); });
    const payload = { baseline: { exchange: 'gateio' as const, symbol: 'ETH/USDT',
      side: 'flat' as const, signedQuantity: 0, averageEntryPrice: 0 } };
    assert.equal(kernel.publish('position.baseline.confirmed', payload).failures, 0);
    unsubscribe(); unsubscribe();
    assert.equal(kernel.publish('position.baseline.confirmed', { baseline: { ...payload.baseline,
      symbol: 'BTC/USDT' } }).failures, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(authoritative, 2); assert.equal(observed, 1);
  });

  it('private authoritative consumer errors still fail closed instead of being treated as observations', () => {
    const kernel = createTradingKernel({ exchange: 'gateio' });
    const { read } = createProductionAuthorityPorts(kernel, { exchange: 'gateio', accountId: 'offline' });
    kernel.subscribe('position.baseline.confirmed', () => { throw new Error('AUTHORITATIVE_PROJECTOR_FAILURE'); });
    read.subscribe('position.baseline.confirmed', () => { throw new Error('OBSERVER'); });
    const result = kernel.publish('position.baseline.confirmed', { baseline: { exchange: 'gateio',
      symbol: 'ETH/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } });
    assert.equal(result.status, 'accepted'); assert.equal(result.failures, 1);
  });
});
