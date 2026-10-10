import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionSpine, executeThroughGateway, trustBaseline, recoverAndStart,
  reconcileRecoveredState, activateLiveReadiness } from '../../src/position/ProductionSpine';
import { createMarketDataRuntime } from '../../src/runtime/market/MarketDataRuntime';
import { systemDomainClock } from '../../src/runtime/Clock';
import type { ProductionEvidencePublisher, ProductionProtectionLifecycleAuthority } from '../../src/position/ProductionAuthorityPorts';
import type { TradeIntent } from '../../src/types/trade-intent';

const NOW = 1_800_000_000_000;
const hardRisk = () => ({ exchange: 'bitget', enabled: true, locked: false,
  totalCapitalUsd: 1000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 100 });

function ticker(at: number) {
  return { exchange: 'bitget' as const, instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker' as const,
    last: 100, bestBid: 99, bestAsk: 101, volume24h: 10, high24h: 110, low24h: 90, ts: at };
}

async function harness() {
  // Explicit composition-owned controller, not a capability on the returned Spine.
  const sourceClock = { value: NOW, now() { return this.value; } };
  const path = join(mkdtempSync(join(tmpdir(), 'r3h6-clock-')), 'journal.jsonl');
  let evidence!: ProductionEvidencePublisher, lifecycle!: ProductionProtectionLifecycleAuthority;
  let onTicker: (value: ReturnType<typeof ticker>) => void = () => {};
  const market = createMarketDataRuntime({ clock: sourceClock, collectorFactory: () => ({
    async start() {}, stop() {}, onTicker(handler) { onTicker = handler; }, onKline() {},
  }) });
  const spine = await createProductionSpine({ exchange: 'bitget', accountId: 'h6-clock',
    clock: sourceClock, journalPath: path, marketRuntime: market, marketStaleAfterMs: 1000,
    hardRisk, riskAuthorization: { mode: 'LEGACY_PAPER_OR_NON_GATE' },
    bindEvidencePublisher(value) { evidence = value; }, bindProtectionLifecycle(value) { lifecycle = value; },
  });
  await market.start();
  const request = (id: string): TradeIntent => ({ intentId: id, exchange: 'bitget', symbol: 'BTC/USDT',
    direction: 'long', orderType: 'market', positionUsd: 10, createdAt: sourceClock.value, source: 'offline-h6' });
  async function ready() {
    await recoverAndStart(spine, path); trustBaseline(spine, 'bitget', 'BTC/USDT');
    evidence.publish('policy.snapshot.published', { policy: { exchange: 'bitget',
      sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1, compilerVersion: 'h6-offline',
      compiledAt: NOW, effectiveAt: NOW, expiresAt: NOW + 3600_000, allowNewEntries: true,
      allowedSymbols: [], blockedSymbols: [], allowedStrategyIds: [], blockedStrategyIds: [],
      maxPositionMultiplier: 1, riskLevel: 'low', directionBias: 'neutral', symbolRules: {}, reasonCodes: [] } });
    await reconcileRecoveredState(spine); onTicker(ticker(sourceClock.value));
    await activateLiveReadiness(spine);
  }
  return { spine, ready, request, advance(ms: number) { sourceClock.value += ms; },
    replaceCompositionMethod() { sourceClock.now = () => 0; },
    stop() { lifecycle.stop(); market.stop(); } };
}

function attemptPublicClockReplacement(spine: Awaited<ReturnType<typeof createProductionSpine>>) {
  assert.equal('clock' in spine.privateConfig, false);
  assert.equal((spine.privateConfig as any).clock, undefined);
  assert.equal(Reflect.set(spine.privateConfig, 'clock', { now: () => NOW }), false);
  assert.equal(Reflect.set(spine, 'clock', { now: () => NOW }), false);
  assert.equal(Reflect.set(spine, 'privateConfig', { clock: { now: () => NOW } }), false);
  assert.throws(() => Object.defineProperty(spine.privateConfig, 'clock', { value: { now: () => NOW } }), TypeError);
  assert.throws(() => { (spine.privateConfig as any).clock.now = () => NOW; }, TypeError);
  assert.deepEqual(Object.getOwnPropertySymbols(spine), []);
  for (const name of Reflect.ownKeys(spine)) assert.doesNotMatch(String(name), /clock|timeAuthority/);
}

describe('R3H6 private composition-owned time authority', () => {
  it('public callers cannot obtain/replace a clock or now method, including before recovery', async t => {
    const h = await harness(); t.after(h.stop);
    attemptPublicClockReplacement(h.spine);
    assert.equal(h.spine.recoveryVerified, false);
    const result = await executeThroughGateway(h.spine, h.request('cold'), 'open', 10);
    assert.equal(result.riskCode, 'NOT_LIVE_READY');
    assert.equal(h.spine.service!.snapshot().processedFills, 0);
  });

  it('stale remains stale after repeated inspection/replacement attacks and Paper cannot execute', async t => {
    const h = await harness(); t.after(h.stop); await h.ready(); h.advance(1001);
    const before = h.spine.marketStore.getSnapshot('bitget', 'BTC/USDT')!;
    assert.equal(before.isStale, true); assert.equal(before.generatedAt, NOW + 1001);
    for (let i = 0; i < 3; i++) {
      attemptPublicClockReplacement(h.spine);
      assert.equal(Reflect.set(before, 'generatedAt', NOW), false);
      assert.equal(Reflect.set(before, 'ageMs', 0), false);
      assert.equal(Reflect.set(before, 'isStale', false), false);
      const after = h.spine.marketStore.getSnapshot('bitget', 'BTC/USDT')!;
      assert.notStrictEqual(after, before); assert.deepEqual(after, before);
    }
    const result = await executeThroughGateway(h.spine, h.request('stale'), 'open', 10);
    assert.equal(result.admitted, false); assert.equal(result.riskCode, 'MARKET_STALE');
    assert.equal(h.spine.service!.snapshot().processedFills, 0);
    assert.equal(h.spine.oms.getStore().list().length, 0);
  });

  it('explicit stateful test injection retains receiver, deterministic values and valid formal Paper execution', async t => {
    const h = await harness(); t.after(h.stop); await h.ready(); h.advance(500);
    assert.equal(h.spine.marketStore.getSnapshot('bitget', 'BTC/USDT')!.generatedAt, NOW + 500);
    const result = await executeThroughGateway(h.spine, h.request('fresh'), 'open', 10);
    assert.equal(result.omsResult?.status, 'filled');
    const record = h.spine.pretradeDecisionReceipts.snapshot().records.at(-1)!;
    assert.equal(record.receipt.evaluationTime, NOW + 500); assert.equal(record.kernelTimestamp, NOW + 500);
    assert.equal(h.spine.service!.snapshot().processedFills, 1);
  });

  it('clock method binding is captured once; composition state advance still works without public authority', async t => {
    const h = await harness(); t.after(h.stop); await h.ready();
    h.replaceCompositionMethod(); h.advance(1001);
    const snapshot = h.spine.marketStore.getSnapshot('bitget', 'BTC/USDT')!;
    assert.equal(snapshot.generatedAt, NOW + 1001); assert.equal(snapshot.isStale, true);
    assert.equal((await executeThroughGateway(h.spine, h.request('captured'), 'open', 10)).riskCode, 'MARKET_STALE');
  });

  it('default runtimes never depend on the shared mutable systemDomainClock export', async () => {
    const originalNow = systemDomainClock.now;
    const spines: Awaited<ReturnType<typeof createProductionSpine>>[] = [];
    async function create() {
      let evidence!: ProductionEvidencePublisher;
      const spine = await createProductionSpine({ exchange: 'bitget', hardRisk,
        riskAuthorization: { mode: 'LEGACY_PAPER_OR_NON_GATE' },
        bindEvidencePublisher(value) { evidence = value; } });
      const receivedAt = Date.now() - 120_000;
      evidence.publish('market.ticker.updated', { ticker: ticker(receivedAt), receivedAt });
      spines.push(spine); return spine;
    }
    try {
      await create(); systemDomainClock.now = () => 0; await create();
      for (const spine of spines) {
        attemptPublicClockReplacement(spine);
        const snapshot = spine.marketStore.getSnapshot('bitget', 'BTC/USDT')!;
        assert.ok(snapshot.generatedAt > 0); assert.equal(snapshot.isStale, true);
      }
    } finally { systemDomainClock.now = originalNow; }
  });
});
