import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { productionEvidenceSnapshot } from '../../src/runtime/production/ProductionEvidenceSnapshot';
import { createApplicationProductionRuntimeOwner } from '../../src/runtime/production/ProductionRuntimeOwner';
import { createMarketDataRuntime } from '../../src/runtime/market/MarketDataRuntime';
import { activateLiveReadiness, executeThroughGateway, trustBaseline } from '../../src/position/ProductionSpine';
import { createTradeIntent } from '../../src/types/trade-intent';
import { createTestProductionSpine, testSpinePublisher } from '../helpers/production-spine-capability-fixture';

const NOW = 1_800_000_000_000;

function assertImmutableTree(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Reflect.set(value, 'injected', () => 'forged'), false);
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as any)[key];
    assert.equal(Reflect.set(value, key, 'forged'), false);
    assertImmutableTree(child, seen);
  }
  if (Array.isArray(value)) assert.throws(() => value.push('forged'), TypeError);
}

function assertDetached(left: unknown, right: unknown, seen = new WeakSet<object>()): void {
  if (left === null || typeof left !== 'object' || seen.has(left)) return;
  seen.add(left);
  assert.notStrictEqual(left, right);
  for (const key of Reflect.ownKeys(left)) assertDetached((left as any)[key], (right as any)[key], seen);
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'r3h4b-evidence-'));
  const owner = createApplicationProductionRuntimeOwner({ enabled: true, mode: 'paper', exchange: 'bitget',
    accountId: 'r3h4b-paper', journalPath: join(dir, 'events.jsonl'), paperLedgerDir: join(dir, 'paper'),
    initialCashUsd: 1000, hardRisk: { enabled: true, locked: false, totalCapitalUsd: 1000,
      maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 100 },
    market: { entries: [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }] },
  }, {
    createSpine: config => createTestProductionSpine({ ...config, clock: Object.freeze({ now: () => NOW }) }),
    createMarketRuntime: () => {
      let ticker: (value: any) => void = () => {};
      return createMarketDataRuntime({ clock: { now: () => NOW }, collectorFactory: () => ({
        onTicker(handler) { ticker = handler; }, onKline() {}, stop() {},
        async start() { ticker({ exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT',
          channel: 'ticker', last: 100, bestBid: 99, bestAsk: 101, volume24h: 10,
          high24h: 110, low24h: 90, ts: NOW }); },
      }) });
    },
  });
  await owner.start();
  const spine = owner.authoritativeSpine()!;
  trustBaseline(spine, 'bitget', 'BTC/USDT');
  testSpinePublisher(spine).publish('policy.snapshot.published', { policy: { exchange: 'bitget',
    sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1, compilerVersion: 'offline',
    compiledAt: NOW, effectiveAt: NOW, expiresAt: NOW + 3600_000, allowNewEntries: true,
    allowedSymbols: [], blockedSymbols: [], allowedStrategyIds: [], blockedStrategyIds: [],
    maxPositionMultiplier: 1, riskLevel: 'low', directionBias: 'neutral', symbolRules: {}, reasonCodes: [] } });
  await activateLiveReadiness(spine);
  const result = await executeThroughGateway(spine, createTradeIntent({ exchange: 'bitget', symbol: 'BTC/USDT',
    direction: 'long', positionUsd: 10, createdAt: NOW, biasUpdatedAt: NOW, source: 'offline-r3h4b', reason: 'fixture' }), 'open', 10);
  assert.equal(result.omsResult?.status, 'filled');
  await new Promise(resolve => setImmediate(resolve));
  return { owner, spine };
}

describe('R3H4B detached immutable public evidence', () => {
  it('clone boundary preserves unknown/null/absence/exact values and freezes all descendants', () => {
    const source = { missing: undefined, unknown: null, exact: '-0.000000000000000001',
      nested: { rows: [{ status: 'UNAVAILABLE' }] }, failure: new Error('observed', { cause: { detail: ['unknown'] } }) };
    const snapshot = productionEvidenceSnapshot(source);
    assert.deepEqual(snapshot, source); assertDetached(source, snapshot); assertImmutableTree(snapshot);
    source.nested.rows[0].status = 'changed';
    assert.equal(snapshot.nested.rows[0].status, 'UNAVAILABLE');
    assert.equal(snapshot.missing, undefined); assert.equal(snapshot.unknown, null);
  });

  it('unsupported mutable containers/services cannot masquerade as frozen evidence', () => {
    for (const value of [new Map([['a', 1]]), new Set([1]), new Date(NOW), new Uint8Array([1])])
      assert.throws(() => productionEvidenceSnapshot({ value }), /OBSERVABILITY_NON_DTO_VALUE/);
    assert.throws(() => productionEvidenceSnapshot({ callback() {} }));
  });

  it('recovery/status/reconciliation/accounting mutations cannot poison later reads or authority', async t => {
    const { owner, spine } = await harness(); t.after(() => owner.stop());
    const journalSequence = spine.kernel.journal().lastSequence;
    const positionDigest = spine.positionStore.digest(), policyDigest = spine.policyStore.digest();
    const readers = [owner.read.recovery, owner.read.status, owner.read.identity, owner.read.reconciliation,
      owner.read.binanceAuthenticatedReadStatus, spine.accounting.snapshot, spine.accounting.lifecycle,
      () => spine.lastReconciliationReport, spine.pretradeDecisionReceipts.snapshot,
      () => spine.oms.getStore().list(), () => spine.oms.getStore().get(spine.oms.getStore().list()[0].orderId),
      () => spine.oms.getStore().getByIntent(spine.oms.getStore().list()[0].intentId),
      () => spine.kernel.journal().readFromLogicalSequence(1),
      () => spine.kernel.journal().getByEventId(spine.kernel.journal().readFromLogicalSequence(1)[0].kernelEventId)];
    for (const read of readers) {
      const before = read(); assert.notEqual(before, null);
      const expected = structuredClone(before);
      assertImmutableTree(before);
      const after = read(); assert.deepEqual(after, expected); assertDetached(before, after);
    }
    assert.equal(spine.recoveryVerified, true); assert.equal(spine.reconciliationVerified, true);
    assert.equal(owner.read.status().state, 'READY_FOR_MARKET');
    assert.equal(spine.kernel.journal().lastSequence, journalSequence);
    assert.equal(spine.positionStore.digest(), positionDigest); assert.equal(spine.policyStore.digest(), policyDigest);
    assert.equal(spine.accounting.snapshot().processedFills, 1);
    assert.equal(spine.accounting.lifecycle().trades[0].legs.length, 1);
  });

  it('public accounting/read objects and methods cannot be replaced or extended with callbacks', async t => {
    const { owner, spine } = await harness(); t.after(() => owner.stop());
    for (const view of [owner.read, spine.accounting, owner.binanceAuthenticatedRead,
      owner.binanceAuthenticatedRead.accountTruth, owner.binanceAuthenticatedRead.instrumentFacts]) {
      assert.equal(Object.isFrozen(view), true);
      for (const key of Object.keys(view)) {
        assert.equal(Reflect.set(view, key, () => ({ forged: true })), false);
        assert.throws(() => Object.defineProperty(view, key, { value: () => 'forged' }), TypeError);
      }
      assert.equal(Reflect.set(view, 'publish', () => {}), false);
    }
    assert.equal(Reflect.set(owner, 'read', {}), false);
    assert.equal(Reflect.set(spine, 'accounting', { snapshot: () => ({ forged: true }) }), false);
    assert.equal(spine.accounting.snapshot().processedFills, 1);
  });

  it('observer envelopes are detached from private kernel/journal and remain deeply immutable', async t => {
    const { owner, spine } = await harness(); t.after(() => owner.stop());
    let observed: unknown;
    const unsubscribe = spine.kernel.subscribe('market.ticker.updated', event => { observed = event; });
    const result = testSpinePublisher(spine).publish('market.ticker.updated', { ticker: { exchange: 'bitget',
      instId: 'BTC/USDT', channel: 'ticker', last: 101, bestBid: 100, bestAsk: 102,
      volume24h: 10, high24h: 110, low24h: 90, ts: NOW + 1 }, receivedAt: NOW + 1 });
    assert.equal(result.failures, 0); assert.deepEqual(observed, result.envelope);
    assertDetached(result.envelope, observed); assertImmutableTree(observed);
    assert.equal(spine.marketStore.getSnapshot('bitget', 'BTC/USDT')!.ticker!.ticker.last, 101);
    unsubscribe();
  });
});
