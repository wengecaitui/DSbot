import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { createMarketDataRuntime } from '../../src/runtime/market/MarketDataRuntime';
import { createProductionSpine, executeThroughGateway, trustBaseline, recoverAndStart,
  reconcileRecoveredState, activateLiveReadiness } from '../../src/position/ProductionSpine';
import { PaperExecutionService } from '../../src/paper/PaperExecutionService';
import { PaperExecutionAdapter } from '../../src/oms/PaperExecutionAdapter';
import type { ProductionEvidencePublisher, ProductionProtectionLifecycleAuthority } from '../../src/position/ProductionAuthorityPorts';
import type { TradeIntent } from '../../src/types/trade-intent';

const NOW = 1_800_000_000_000;

function intent(id: string, direction: 'long' | 'short' = 'long', positionUsd = 10): TradeIntent {
  return { intentId: id, exchange: 'bitget', symbol: 'BTC/USDT', direction,
    orderType: 'market', positionUsd, createdAt: NOW, source: 'offline-h4c' };
}

function assertImmutable(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    assert.equal(Reflect.set(value, key, 'forged'), false);
    assertImmutable((value as any)[key]);
  }
}

async function harness(options: { receiptFailure?: 'throw' | 'silent'; locked?: boolean } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'r3h4c-paper-')), 'events.jsonl');
  const journal = createFileEventJournal(path);
  const append = journal.append;
  journal.append = event => {
    if (event.type === 'PRETRADE_RISK_DECISION_RECORDED') {
      if (options.receiptFailure === 'throw') throw new Error('RECEIPT_DISK_FAILURE');
      if (options.receiptFailure === 'silent') return;
    }
    append(event);
  };
  let evidence!: ProductionEvidencePublisher, lifecycle!: ProductionProtectionLifecycleAuthority;
  let ticker: (value: any) => void = () => {};
  const market = createMarketDataRuntime({ clock: { now: () => NOW }, collectorFactory: () => ({
    onTicker(handler) { ticker = handler; }, onKline() {}, stop() {}, async start() {},
  }) });
  let saves = 0, saved: any = null;
  const durableAtSaves: number[] = [];
  const spine = await createProductionSpine({ exchange: 'bitget', accountId: 'h4c-paper', journal,
    clock: Object.freeze({ now: () => NOW }), marketRuntime: market,
    paperAccount: { exchange: 'bitget', accountId: 'h4c-paper', initialCashUsd: 1000 },
    riskAuthorization: { mode: 'LEGACY_PAPER_OR_NON_GATE' },
    hardRisk: () => ({ exchange: 'bitget', enabled: true, locked: options.locked ?? false,
      totalCapitalUsd: 1000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 100 }),
    persistence: { async load() { return saved; }, async save(document) {
      const disk = createFileEventJournal(path).readFromLogicalSequence(1, 10_000);
      const decisions = disk.filter(e => e.type === 'PRETRADE_RISK_DECISION_RECORDED');
      const orders = disk.filter(e => e.type === 'order.created');
      assert.ok(decisions.length > 0); assert.ok(orders.length > 0);
      assert.ok(decisions.at(-1)!.kernelLogicalSequence < orders.at(-1)!.kernelLogicalSequence);
      durableAtSaves.push(decisions.at(-1)!.kernelLogicalSequence);
      saved = document; saves++;
    } },
    bindEvidencePublisher(value) { evidence = value; },
    bindProtectionLifecycle(value) { lifecycle = value; },
  });
  await market.start();
  const emit = () => ticker({ exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT',
    channel: 'ticker', last: 100, bestBid: 99, bestAsk: 101, volume24h: 10, high24h: 110, low24h: 90, ts: NOW });
  async function recover() {
    await recoverAndStart(spine, path);
    trustBaseline(spine, 'bitget', 'BTC/USDT');
    evidence.publish('policy.snapshot.published', { policy: { exchange: 'bitget',
      sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1, compilerVersion: 'offline',
      compiledAt: NOW, effectiveAt: NOW, expiresAt: NOW + 3600_000, allowNewEntries: true,
      allowedSymbols: [], blockedSymbols: [], allowedStrategyIds: [], blockedStrategyIds: [],
      maxPositionMultiplier: 1, riskLevel: 'low', directionBias: 'neutral', symbolRules: {}, reasonCodes: [] } });
    await reconcileRecoveredState(spine); emit();
  }
  async function ready() { await recover(); await activateLiveReadiness(spine); }
  return { spine, journal, path, ready, recover, lifecycle, durableAtSaves, saves: () => saves,
    stop: () => { lifecycle.stop(); market.stop(); } };
}

describe('R3H4C production-facing Paper execution closure', () => {
  it('raw execute/executeApproved and broker/ledger/store/queue are unreachable, even before recovery', async t => {
    const h = await harness(); t.after(h.stop);
    const view = h.spine.service!;
    assert.equal(view instanceof PaperExecutionService, false);
    assert.equal(view instanceof PaperExecutionAdapter, false);
    assert.equal(Object.getPrototypeOf(view), Object.prototype);
    assert.deepEqual(Object.keys(view).sort(), ['entries', 'getIdentity', 'snapshot']);
    const sequence = h.journal.lastSequence, before = view.snapshot();
    for (const key of ['execute', 'executeApproved', 'broker', 'ledger', 'store', 'queue', 'counter', 'canonical']) {
      assert.equal((view as any)[key], undefined);
      assert.equal(Reflect.set(view, key, () => 'forged'), false);
    }
    assert.throws(() => (view as any).execute(intent('direct')), TypeError);
    assert.throws(() => (view as any).executeApproved(intent('direct'), 10), TypeError);
    assert.deepEqual(view.snapshot(), before); assert.equal(h.journal.lastSequence, sequence);
    assert.equal(h.spine.recoveryVerified, false); assert.equal(h.spine.oms.getStore().list().length, 0);
    assert.equal(Reflect.set(h.spine, 'service', {}), false);
    assert.equal(Object.getOwnPropertySymbols(h.spine).length, 0);
  });

  it('Paper observations are detached/deeply immutable and methods cannot be replaced', async t => {
    const h = await harness(); t.after(h.stop); await h.ready();
    assert.equal((await executeThroughGateway(h.spine, intent('read-open'), 'open', 10)).omsResult?.status, 'filled');
    const view = h.spine.service!;
    for (const key of ['getIdentity', 'snapshot', 'entries'] as const) {
      const before = view[key](), expected = structuredClone(before);
      assertImmutable(before); const after = view[key]();
      assert.notStrictEqual(after, before); assert.deepEqual(after, expected);
      assert.equal(Reflect.set(view, key, () => ({ forged: true })), false);
      assert.throws(() => Object.defineProperty(view, key, { value: () => 'forged' }), TypeError);
    }
    assert.notStrictEqual(view.entries()[0], view.entries()[0]);
    assert.notStrictEqual(view.snapshot().positions[0], view.snapshot().positions[0]);
    assert.equal(view.snapshot().processedFills, 1);
  });

  it('recovery alone cannot enable OPEN; ready OPEN and INCREASE each use gateway + durable decision + OMS', async t => {
    const h = await harness(); t.after(h.stop);
    assert.equal((await executeThroughGateway(h.spine, intent('cold'), 'open', 10)).riskCode, 'NOT_LIVE_READY');
    await h.recover();
    assert.equal((await executeThroughGateway(h.spine, intent('recovered'), 'open', 10)).riskCode, 'NOT_LIVE_READY');
    assert.equal(h.spine.service!.snapshot().processedFills, 0);
    await activateLiveReadiness(h.spine);
    for (const id of ['open', 'increase']) {
      const result = await executeThroughGateway(h.spine, intent(id), 'open', 999);
      assert.equal(result.admitted, true); assert.equal(result.omsResult?.status, 'filled');
    }
    assert.equal(h.spine.service!.snapshot().processedFills, 2);
    assert.equal(h.spine.pretradeDecisionReceipts.snapshot().records.length, 2);
    assert.equal(h.durableAtSaves.length, 2);
    assert.equal(h.spine.positionStore.resolve('bitget', 'BTC/USDT').signedQuantity, 0.2);
  });

  it('risk rejection cannot mutate Paper; durable rejected decision remains observable', async t => {
    const h = await harness({ locked: true }); t.after(h.stop); await h.ready();
    const saves = h.saves();
    const result = await executeThroughGateway(h.spine, intent('locked'), 'open', 10);
    assert.equal(result.admitted, false); assert.equal(result.riskCode, 'KILLSWITCH_LOCKED');
    assert.equal(h.saves(), saves); assert.equal(h.spine.oms.getStore().list().length, 0);
    assert.equal(h.spine.service!.snapshot().processedFills, 0);
    assert.equal(h.spine.pretradeDecisionReceipts.snapshot().records[0].receipt.decision, 'REJECTED');
  });

  for (const failure of ['throw', 'silent'] as const) {
    it(`receipt writer ${failure} failure cannot authorize Paper mutation`, async t => {
      const h = await harness({ receiptFailure: failure }); t.after(h.stop); await h.ready();
      const saves = h.saves();
      const result = await executeThroughGateway(h.spine, intent(`receipt-${failure}`), 'open', 10);
      assert.equal(result.admitted, false);
      assert.equal(result.riskCode, failure === 'throw' ? 'RISK_DECISION_RECEIPT_PERSIST_FAILED' : 'PAPER_DECISION_ADMISSION_INVALID');
      assert.equal(h.spine.service!.snapshot().processedFills, 0);
      assert.equal(h.spine.oms.getStore().list().length, 0); assert.equal(h.saves(), saves);
      assert.equal(createFileEventJournal(h.path).readFromLogicalSequence(1, 10_000)
        .filter(e => e.type === 'PRETRADE_RISK_DECISION_RECORDED').length, 0);
    });
  }

  it('receipt replay cannot authorize a second mutation of the same intent', async t => {
    const h = await harness(); t.after(h.stop); await h.ready();
    const request = intent('same');
    assert.equal((await executeThroughGateway(h.spine, request, 'open', 10)).omsResult?.status, 'filled');
    const saves = h.saves();
    const replay = await executeThroughGateway(h.spine, request, 'open', 10);
    assert.equal(replay.admitted, false); assert.equal(replay.riskCode, 'PAPER_DECISION_ADMISSION_INVALID');
    assert.equal(h.saves(), saves); assert.equal(h.spine.service!.snapshot().processedFills, 1);
  });

  it('forged exit labels cannot increase Paper exposure; legitimate close uses the same durable gateway path', async t => {
    const h = await harness(); t.after(h.stop); await h.ready();
    await executeThroughGateway(h.spine, intent('open'), 'open', 10);
    for (const action of ['reduce', 'close', 'emergency_exit'] as const) {
      assert.equal((await executeThroughGateway(h.spine, intent(`forged-${action}`), action, 1000)).admitted, false);
    }
    assert.equal(h.spine.service!.snapshot().processedFills, 1);
    const close = await executeThroughGateway(h.spine, intent('close', 'short', 1000), 'close', 1000);
    assert.equal(close.omsResult?.status, 'filled');
    assert.equal(h.spine.positionStore.resolve('bitget', 'BTC/USDT').status, 'flat');
  });

  it('Paper/read-view mode cannot become Gate authority or provide live mutation bindings', async () => {
    let mutations = 0;
    const config = { exchange: 'gateio', accountId: 'h4c-gate',
      hardRisk: () => ({ exchange: 'gateio', enabled: true, locked: false,
        totalCapitalUsd: 1000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 100 }) };
    await assert.rejects(() => createProductionSpine({ ...config,
      riskAuthorization: { mode: 'GATEIO_ACCOUNT_BOUND', settle: 'USDT' },
      execution: { mode: 'paper' } }), /ACCOUNT_BOUND_RISK_MODE_INVALID/);
    await assert.rejects(() => createProductionSpine({ ...config,
      riskAuthorization: { mode: 'LEGACY_PAPER_OR_NON_GATE' },
      execution: { mode: 'limited-live', adapter: { async submit() { mutations++; throw new Error('UNREACHABLE'); } },
        truthPort: { async acquireTruth() { throw new Error('UNREACHABLE'); } } } }), /GATEIO_ACCOUNT_BOUND_RISK_MODE_REQUIRED/);
    assert.equal(mutations, 0);
  });
});
