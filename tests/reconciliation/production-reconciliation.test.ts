// Phase 5B2: Production reconciliation integration tests.
// Covers read surfaces, Paper correlation persistence, Paper truth port,
// startup authority, the 3-gate LIVE_READY, real restart MATCH, and negative proofs.

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createProductionSpine,
  executeThroughGateway,
  trustBaseline,
  recoverAndStart,
  reconcileRecoveredState,
  activateLiveReadiness,
} from '../../src/position/ProductionSpine';
import { createPaperExecutionTruthPort } from '../../src/reconciliation/PaperExecutionTruthPort';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import { OmsOrderStore } from '../../src/oms/OmsOrderStore';
import { createKernelPositionStateStore } from '../../src/kernel/KernelPositionStateStore';
import { PositionPlanStore } from '../../src/position/PositionPlanStore';
import type { PaperBrokerPersistence } from '../../src/paper/PaperBroker';
import type { ExchangeId } from '../../src/data/MarketIdentity';

const hardRisk = () => ({ exchange: 'bitget', locked: false, enabled: true, totalCapitalUsd: 1_000_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: Infinity });

function env(type: string, seq: number, payload: Record<string, unknown>) {
  return { kernelEventId: 'a'.repeat(64), kernelLogicalSequence: seq, kernelTimestamp: seq * 1000, type, payload };
}

function btcTicker() {
  return { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 50000, bestBid: 49999, bestAsk: 50001, volume24h: 100, high24h: 51000, low24h: 49000, ts: Date.now() };
}

function makeIntent(id: string, symbol: string, dir: 'long' | 'short', usd: number) {
  return { intentId: id, exchange: 'bitget' as ExchangeId, symbol, direction: dir, orderType: 'market' as const, positionUsd: usd, limitPrice: undefined, createdAt: Date.now() };
}

async function createSpineWithMarket(overrides: any = {}) {
  const { createMarketDataRuntime } = require('../../src/runtime/market/MarketDataRuntime');
  let tickerHandler: ((t: any) => void) | null = null;
  const collector = {
    start: async () => {},
    stop: () => {},
    onTicker: (h: any) => { tickerHandler = h; },
    onKline: (_h: any) => {},
  };
  const marketRuntime = createMarketDataRuntime({ collectorFactory: () => collector });
  const spine = await createProductionSpine({ exchange: 'bitget', hardRisk, ...overrides, marketRuntime });
  await marketRuntime.start();
  return { spine, emitTicker: () => { tickerHandler?.(btcTicker()); } };
}

function pubPolicy(s: any) {
  const now = Date.now();
  s.kernel.publish('policy.snapshot.published', {
    policy: {
      exchange: 'bitget', sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1,
      compilerVersion: '1', compiledAt: now, effectiveAt: now, expiresAt: now + 3600_000,
      allowNewEntries: true, allowedSymbols: [], blockedSymbols: [],
      allowedStrategyIds: [], blockedStrategyIds: [],
      maxPositionMultiplier: 1, riskLevel: 'low' as const, directionBias: 'neutral' as const,
      symbolRules: {}, reasonCodes: [],
    },
  });
}

function paperConfig(accountId: string) {
  return { accountId, exchange: 'bitget' as ExchangeId, initialCashUsd: 100000 };
}

function countingPersistence(inner: PaperBrokerPersistence) {
  const state = { saves: 0 };
  const wrapped: PaperBrokerPersistence & { saves: () => number; reset: () => void } = {
    load: () => inner.load(),
    save: async (ledger) => { state.saves++; return inner.save(ledger); },
    saves: () => state.saves,
    reset: () => { state.saves = 0; },
  };
  return wrapped;
}

describe('Phase 5B2 — Read surfaces', () => {
  it('OmsOrderStore.list() returns all snapshots deterministically; snapshots frozen', () => {
    const store = new OmsOrderStore();
    store.apply(env('order.created', 1, { order: { orderId: 'o2', intentId: 'i2', exchange: 'bitget', symbol: 'BTC/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 100 } }));
    store.apply(env('order.created', 2, { order: { orderId: 'o1', intentId: 'i1', exchange: 'bitget', symbol: 'ETH/USDT', action: 'open', side: 'sell', orderType: 'market', approvedNotionalUsd: 200 } }));
    const list = store.list();
    assert.deepStrictEqual(list.map((o) => o.orderId), ['o1', 'o2'], 'sorted by orderId');
    assert.ok(Object.isFrozen(list[0]), 'snapshot frozen');
    assert.strictEqual(store.get('o2')!.status, 'CREATED', 'store unchanged');
  });

  it('KernelPositionStateStore.listResolved() returns initialized states deterministically', () => {
    const store = createKernelPositionStateStore();
    store.apply(env('position.baseline.confirmed', 1, { baseline: { exchange: 'bitget', symbol: 'BTC/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } }));
    store.apply(env('position.baseline.confirmed', 2, { baseline: { exchange: 'bitget', symbol: 'ETH/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } }));
    store.apply(env('execution.fill.confirmed', 3, { fill: { fillId: 'f1', exchange: 'bitget', symbol: 'BTC/USDT', side: 'buy', quantity: 0.1, price: 50000, executedAt: 1000 } }));
    const list = store.listResolved();
    assert.deepStrictEqual(list.map((r) => `${r.snapshot!.symbol}:${r.status}`), ['BTC/USDT:open', 'ETH/USDT:flat'], 'sorted, initialized only');
    assert.strictEqual(list[0].status, 'open');
    assert.strictEqual(list[1].status, 'flat');
    // Uninitialized symbol never appears
    assert.strictEqual(store.resolve('bitget' as ExchangeId, 'XRP/USDT').status, 'missing');
    assert.ok(!list.some((r) => r.snapshot!.symbol === 'XRP/USDT'), 'missing symbol absent from list');
  });

  it('PositionPlanStore.list() returns all plans deterministically; frozen', () => {
    const store = new PositionPlanStore();
    store.apply(env('position.plan.created', 1, { plan: { planId: 'p2', exchange: 'bitget', symbol: 'BTC/USDT', positionSide: 'long', entryPrice: 50000, stopPrice: 47500 } }));
    store.apply(env('position.plan.created', 2, { plan: { planId: 'p1', exchange: 'bitget', symbol: 'ETH/USDT', positionSide: 'short', entryPrice: 3000, stopPrice: 3150 } }));
    const list = store.list();
    assert.deepStrictEqual(list.map((p) => p.planId), ['p1', 'p2'], 'sorted by planId');
    assert.ok(Object.isFrozen(list[0]), 'plan snapshot frozen');
  });

  it('returned enumeration cannot mutate store state', () => {
    const store = new OmsOrderStore();
    store.apply(env('order.created', 1, { order: { orderId: 'o1', intentId: 'i1', exchange: 'bitget', symbol: 'BTC/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 100 } }));
    const list = store.list();
    list.length = 0; // mutate returned array
    assert.strictEqual(store.list().length, 1, 'store unaffected by array mutation');
    assert.strictEqual(store.get('o1')!.status, 'CREATED', 'store snapshot unaffected');
  });
});

describe('Phase 5B2 — Paper correlation persistence', () => {
  it('OMS-originated Paper fill persists sourceOrderId/sourceIntentId and reloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-corr-'));
    const cfg = paperConfig('corr');
    const store = new PaperLedgerStore(cfg, { baseDir: dir });
    const journalPath = join(dir, 'journal.jsonl');

    const s1 = await createProductionSpine({ exchange: 'bitget', accountId: 'corr', hardRisk, journalPath, paperAccount: cfg, persistence: store });
    s1.protection.start();
    s1.planStore.subscribeToKernel(s1.kernel as any);

    // Direct OMS submit (adapter carries correlation into the Paper fill)
    (s1.adapter as any).params.markPriceUsd = 50000;
    (s1.adapter as any).params.executedAtMs = Date.now();
    const omsResult = await s1.oms.submitRequest(makeIntent('i1', 'BTC/USDT', 'long', 5000), 'open', 5000);
    assert.strictEqual(omsResult.status, 'filled', `filled, got ${omsResult.status}`);

    // Persisted Paper fill carries correlation
    const fillEntry = s1.service.entries().find((e: any) => e.type === 'fill');
    assert.ok(fillEntry, 'fill persisted');
    const fill = (fillEntry as any).fill;
    assert.strictEqual(typeof fill.sourceOrderId, 'string', 'sourceOrderId present');
    assert.strictEqual(typeof fill.sourceIntentId, 'string', 'sourceIntentId present');
    assert.strictEqual(fill.sourceOrderId, omsResult.order!.orderId, 'sourceOrderId == OMS orderId');
    assert.strictEqual(fill.sourceIntentId, 'i1', 'sourceIntentId == intentId');

    // Reload the SAME persistence → correlation preserved
    const reloaded = await store.load();
    assert.ok(reloaded, 'ledger reloaded');
    const reloadedFill = reloaded!.entries().find((e: any) => e.type === 'fill') as any;
    assert.strictEqual(reloadedFill.fill.sourceOrderId, fill.sourceOrderId, 'correlation survives reload');
    assert.strictEqual(reloadedFill.fill.sourceIntentId, fill.sourceIntentId, 'intent survives reload');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Phase 5B2 — Paper truth port', () => {
  it('maps canonical identity, positions, correlated fill → ExternalFill + FILLED ExternalOrder', async () => {
    const service = {
      getIdentity: () => ({ accountId: 'acct', exchange: 'bitget' as ExchangeId }),
      snapshot: () => ({
        accountId: 'acct', exchange: 'bitget', initialCashUsd: 100000, cashUsd: 100000,
        realizedPnlUsd: 0, unrealizedPnlUsd: 0, totalFeesUsd: 0, equityUsd: 100000,
        grossExposureUsd: 0, netExposureUsd: 0, openPositions: 1, processedFills: 1,
        sequence: 1, updatedAt: 1000,
        positions: [{ exchange: 'bitget', symbol: 'BTC/USDT', direction: 'long', signedQuantity: 0.1, averageEntryPriceUsd: 50000, markPriceUsd: 50000, marketValueUsd: 5000, unrealizedPnlUsd: 0, openedAt: 1, updatedAt: 2 }],
      }),
      entries: () => [{ type: 'fill', sequence: 1, fill: { fillId: 'f1', exchange: 'bitget', symbol: 'BTC/USDT', side: 'buy', quantity: 0.1, priceUsd: 50000, feeUsd: 5, executedAt: 1000, sourceOrderId: 'o1', sourceIntentId: 'i1' } }],
    };
    const port = createPaperExecutionTruthPort({ service: service as any, now: () => 999 });
    const truth = await port.acquireTruth();
    assert.strictEqual(truth.complete, true);
    assert.strictEqual(truth.source, 'paper-broker');
    assert.strictEqual(truth.capturedAt, 999);
    assert.strictEqual(truth.identity.accountId, 'acct');
    assert.strictEqual(truth.identity.exchange, 'bitget');
    assert.strictEqual(truth.positions.length, 1);
    assert.strictEqual(truth.positions[0].side, 'long');
    assert.strictEqual(truth.positions[0].signedQuantity, 0.1);
    assert.strictEqual(truth.positions[0].averageEntryPrice, 50000);
    assert.strictEqual(truth.fills.length, 1);
    assert.strictEqual(truth.fills[0].orderId, 'o1');
    assert.strictEqual(truth.fills[0].fillId, 'f1');
    assert.strictEqual(truth.orders.length, 1);
    assert.strictEqual(truth.orders[0].orderId, 'o1');
    assert.strictEqual(truth.orders[0].status, 'FILLED');
    assert.strictEqual(truth.orders[0].filledQuantity, 0.1);
    assert.strictEqual(truth.orders[0].averageFillPrice, 50000);
  });

  it('uncorrelated persisted fill → complete=false', async () => {
    const service = {
      getIdentity: () => ({ accountId: 'acct', exchange: 'bitget' as ExchangeId }),
      snapshot: () => ({ positions: [] }),
      entries: () => [{ type: 'fill', sequence: 1, fill: { fillId: 'f1', exchange: 'bitget', symbol: 'BTC/USDT', side: 'buy', quantity: 0.1, priceUsd: 50000, feeUsd: 5, executedAt: 1000 } }],
    };
    const port = createPaperExecutionTruthPort({ service: service as any, now: () => 1 });
    const truth = await port.acquireTruth();
    assert.strictEqual(truth.complete, false);
    assert.ok(/correlation/.test(truth.incompleteReason ?? ''), 'uncorrelated reason');
  });

  it('unestablished identity → complete=false (malformed truth)', async () => {
    const service = {
      getIdentity: () => ({ accountId: '', exchange: '' }),
      snapshot: () => ({ positions: [] }),
      entries: () => [],
    };
    const port = createPaperExecutionTruthPort({ service: service as any, now: () => 1 });
    const truth = await port.acquireTruth();
    assert.strictEqual(truth.complete, false);
    assert.ok(/identity/.test(truth.incompleteReason ?? ''), 'identity reason');
  });

  it('truth port derives facts only from service (no local store references)', () => {
    // The port constructor accepts only { service, now, source } — there is no
    // path to pass local OMS/position/plan state.
    const src = require('../../src/reconciliation/PaperExecutionTruthPort');
    const fn = src.createPaperExecutionTruthPort;
    assert.strictEqual(fn.length, 1, 'single options argument');
    // The module must not import local stores to manufacture facts.
    const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/reconciliation/PaperExecutionTruthPort.ts'), 'utf8');
    assert.ok(!/OmsOrderStore|KernelPositionStateStore|PositionPlanStore/.test(text), 'no local store imports');
  });
});

describe('Phase 5B2 — Authority', () => {
  it('reconcileRecoveredState before recovery fails closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-auth-'));
    const journalPath = join(dir, 'journal.jsonl');
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'auth', hardRisk, journalPath });
    await assert.rejects(() => reconcileRecoveredState(s), { message: /RECONCILIATION_REQUIRES_RECOVERY/ });
    rmSync(dir, { recursive: true, force: true });
  });

  it('caller cannot forge reconciliationVerified (no setter/token/bool injection)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-forge-'));
    const journalPath = join(dir, 'journal.jsonl');
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'forge', hardRisk, journalPath });
    assert.strictEqual(s.reconciliationVerified, false, 'default false');
    const desc = Object.getOwnPropertyDescriptor(s, 'reconciliationVerified');
    assert.strictEqual(desc && desc.set, undefined, 'no setter on reconciliationVerified');
    assert.strictEqual((s as any).setReconciliationVerified, undefined, 'no setReconciliationVerified method');
    const mod = require('../../src/position/ProductionSpine');
    assert.strictEqual(mod.setReconciliationVerified, undefined, 'no exported setter');
    assert.strictEqual(mod.RECONCILE_TOKEN, undefined, 'no exported token');
    assert.strictEqual(reconcileRecoveredState.length, 1, 'reconcileRecoveredState takes only spine');
    rmSync(dir, { recursive: true, force: true });
  });

  it('genuine MATCH grants reconciliationVerified=true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-match-'));
    const journalPath = join(dir, 'journal.jsonl');
    const { spine } = await createSpineWithMarket({ accountId: 'match', journalPath });
    spine.protection.start();
    spine.planStore.subscribeToKernel(spine.kernel as any);
    await recoverAndStart(spine, journalPath);
    const report = await reconcileRecoveredState(spine);
    assert.strictEqual(report.outcome, 'MATCH');
    assert.strictEqual(spine.reconciliationVerified, true);
    assert.strictEqual(spine.lastReconciliationReport, report);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Phase 5B2 — LIVE_READY 3-gate', () => {
  it('no recovery → LIVE_READY denied (RECOVERY)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-g1-'));
    const journalPath = join(dir, 'journal.jsonl');
    const { spine } = await createSpineWithMarket({ accountId: 'g1', journalPath });
    await assert.rejects(() => activateLiveReadiness(spine), { message: /RECOVERY/ });
    rmSync(dir, { recursive: true, force: true });
  });

  it('recovery yes, reconciliation no → denied with RECONCILIATION evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-g2-'));
    const journalPath = join(dir, 'journal.jsonl');
    const { spine, emitTicker } = await createSpineWithMarket({ accountId: 'g2', journalPath });
    spine.protection.start();
    spine.planStore.subscribeToKernel(spine.kernel as any);
    await recoverAndStart(spine, journalPath);
    emitTicker(); // fresh market available, but reconciliation NOT run
    await assert.rejects(() => activateLiveReadiness(spine), { message: /RECONCILIATION/ });
    rmSync(dir, { recursive: true, force: true });
  });

  it('recovery + MATCH + no fresh market → denied (FRESH_MARKET)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-g3-'));
    const journalPath = join(dir, 'journal.jsonl');
    const { spine } = await createSpineWithMarket({ accountId: 'g3', journalPath });
    spine.protection.start();
    spine.planStore.subscribeToKernel(spine.kernel as any);
    await recoverAndStart(spine, journalPath);
    await reconcileRecoveredState(spine); // MATCH
    assert.strictEqual(spine.reconciliationVerified, true);
    await assert.rejects(() => activateLiveReadiness(spine), { message: /FRESH_MARKET/ });
    rmSync(dir, { recursive: true, force: true });
  });

  it('recovery + MATCH + fresh collector market → LIVE_READY succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-g4-'));
    const journalPath = join(dir, 'journal.jsonl');
    const { spine, emitTicker } = await createSpineWithMarket({ accountId: 'g4', journalPath });
    spine.protection.start();
    spine.planStore.subscribeToKernel(spine.kernel as any);
    await recoverAndStart(spine, journalPath);
    await reconcileRecoveredState(spine);
    emitTicker();
    await activateLiveReadiness(spine);
    assert.strictEqual(spine.protection.getMode(), 'live');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Phase 5B2 — Real restart proof', () => {
  it('RUN1 execute fill → RUN2 replay + reconcile → MATCH, zero adapter calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-restart-'));
    const journalPath = join(dir, 'journal.jsonl');
    const paperDir = join(dir, 'paper');
    const cfg = paperConfig('restart');
    const paperStore = new PaperLedgerStore(cfg, { baseDir: paperDir });
    const counting = countingPersistence(paperStore);

    // ── RUN 1: real execution ──
    const m1 = await createSpineWithMarket({ accountId: 'restart', journalPath, paperAccount: cfg, persistence: counting, policyMaxLifetimeMs: 3600_000 });
    const s1 = m1.spine;
    s1.protection.start();
    s1.planStore.subscribeToKernel(s1.kernel as any);
    await recoverAndStart(s1, journalPath);
    await reconcileRecoveredState(s1);
    m1.emitTicker();
    await activateLiveReadiness(s1);
    trustBaseline(s1, 'bitget', 'BTC/USDT');
    pubPolicy(s1);

    const openResult = await executeThroughGateway(s1, makeIntent('gw-restart', 'BTC/USDT', 'long', 5000), 'open', 5000);
    assert.strictEqual(openResult.admitted, true, 'RUN1 admitted');
    await new Promise((r) => setTimeout(r, 300)); // allow plan creation + journal flush

    const fillsPersisted = s1.service.entries().filter((e: any) => e.type === 'fill').length;
    assert.strictEqual(fillsPersisted, 1, 'one fill persisted');

    // ── RUN 2: fresh spine, same durable paper + journal ──
    counting.reset();
    const s2 = await createProductionSpine({ exchange: 'bitget', accountId: 'restart', hardRisk, journalPath, paperAccount: cfg, persistence: counting, policyMaxLifetimeMs: 3600_000 });
    s2.planStore.subscribeToKernel(s2.kernel as any);

    const recResult = await recoverAndStart(s2, journalPath);
    assert.strictEqual(recResult.recoveryVerified, true, `recovery failed: ${JSON.stringify(recResult.errors)}`);
    assert.strictEqual(recResult.errors.length, 0, 'zero replay errors');

    const report = await reconcileRecoveredState(s2);
    assert.strictEqual(report.outcome, 'MATCH', `expected MATCH, got ${report.outcome}: ${JSON.stringify(report.issues)}`);
    assert.strictEqual(s2.reconciliationVerified, true);

    // zero Paper adapter submissions during replay + reconciliation
    assert.strictEqual(counting.saves(), 0, 'zero Paper executions during replay/reconcile');
    assert.strictEqual(s2.service.entries().filter((e: any) => e.type === 'fill').length, 1, 'no synthetic fills');

    rmSync(dir, { recursive: true, force: true });
  });

  it('recovered local FILLED but Paper fill absent → NOT MATCH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-negfill-'));
    const journalPath = join(dir, 'journal.jsonl');
    const cfg = paperConfig('negfill');

    // RUN 1: persist fill to journal + paper
    const m1 = await createSpineWithMarket({ accountId: 'negfill', journalPath, paperAccount: cfg, persistence: new PaperLedgerStore(cfg, { baseDir: join(dir, 'paper1') }), policyMaxLifetimeMs: 3600_000 });
    const s1 = m1.spine;
    s1.protection.start();
    s1.planStore.subscribeToKernel(s1.kernel as any);
    await recoverAndStart(s1, journalPath);
    await reconcileRecoveredState(s1);
    m1.emitTicker();
    await activateLiveReadiness(s1);
    trustBaseline(s1, 'bitget', 'BTC/USDT');
    pubPolicy(s1);
    await executeThroughGateway(s1, makeIntent('gw-negfill', 'BTC/USDT', 'long', 5000), 'open', 5000);
    await new Promise((r) => setTimeout(r, 200));

    // RUN 2: same journal (has OMS/fill events), EMPTY paper persistence
    const emptyPaper = new PaperLedgerStore(cfg, { baseDir: join(dir, 'paper2-empty') });
    const s2 = await createProductionSpine({ exchange: 'bitget', accountId: 'negfill', hardRisk, journalPath, paperAccount: cfg, persistence: emptyPaper });
    await recoverAndStart(s2, journalPath);
    const report = await reconcileRecoveredState(s2);
    assert.notStrictEqual(report.outcome, 'MATCH');
    assert.strictEqual(s2.reconciliationVerified, false);
    assert.ok(report.issues.some((i) => i.outcome === 'UNKNOWN_ORDER'), 'local FILLED unconfirmed');

    rmSync(dir, { recursive: true, force: true });
  });

  it('Paper correlated fill absent from local OMS → ORPHAN_ORDER (never MATCH)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-negoph-'));
    const journalPath = join(dir, 'journal.jsonl');
    const cfg = paperConfig('negoph');
    const paperStore = new PaperLedgerStore(cfg, { baseDir: join(dir, 'paper') });

    // RUN 1: execute fill, persist to shared paper
    const m1 = await createSpineWithMarket({ accountId: 'negoph', journalPath, paperAccount: cfg, persistence: paperStore, policyMaxLifetimeMs: 3600_000 });
    const s1 = m1.spine;
    s1.protection.start();
    s1.planStore.subscribeToKernel(s1.kernel as any);
    await recoverAndStart(s1, journalPath);
    await reconcileRecoveredState(s1);
    m1.emitTicker();
    await activateLiveReadiness(s1);
    trustBaseline(s1, 'bitget', 'BTC/USDT');
    pubPolicy(s1);
    await executeThroughGateway(s1, makeIntent('gw-negoph', 'BTC/USDT', 'long', 5000), 'open', 5000);
    await new Promise((r) => setTimeout(r, 200));

    // RUN 2: EMPTY journal (no local OMS), SAME paper persistence (has correlated fill)
    const emptyJournal = join(dir, 'empty-journal.jsonl');
    const s2 = await createProductionSpine({ exchange: 'bitget', accountId: 'negoph', hardRisk, journalPath: emptyJournal, paperAccount: cfg, persistence: paperStore });
    await recoverAndStart(s2, emptyJournal); // no_history → verified, empty local
    const report = await reconcileRecoveredState(s2);
    assert.notStrictEqual(report.outcome, 'MATCH');
    assert.ok(report.issues.some((i) => i.outcome === 'ORPHAN_ORDER'), 'orphan detected');
    assert.strictEqual(s2.reconciliationVerified, false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('SUBMISSION_UNKNOWN + no conclusive Paper truth → UNKNOWN_ORDER, zero retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5b2-negunk-'));
    const journalPath = join(dir, 'journal.jsonl');
    const cfg = paperConfig('negunk');

    // RUN 1: journal with SUBMISSION_UNKNOWN order (no fill)
    const s1 = await createProductionSpine({ exchange: 'bitget', accountId: 'negunk', hardRisk, journalPath });
    s1.kernel.publish('order.created', { order: { orderId: 'o1', intentId: 'i1', exchange: 'bitget', symbol: 'BTC/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 1000 } });
    s1.kernel.publish('order.submitted', { orderId: 'o1' });
    s1.kernel.publish('order.submission.unknown', { orderId: 'o1', reason: 'adapter unavailable' });

    // RUN 2: recover + reconcile
    const counting = countingPersistence(new PaperLedgerStore(cfg, { baseDir: join(dir, 'paper') }));
    const s2 = await createProductionSpine({ exchange: 'bitget', accountId: 'negunk', hardRisk, journalPath, paperAccount: cfg, persistence: counting });
    await recoverAndStart(s2, journalPath);
    counting.reset();
    const report = await reconcileRecoveredState(s2);
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(s2.reconciliationVerified, false);
    // zero retry: order stays SUBMISSION_UNKNOWN, no adapter submission
    assert.strictEqual(s2.oms.getStore().get('o1')!.status, 'SUBMISSION_UNKNOWN');
    assert.strictEqual(counting.saves(), 0, 'zero submissions during reconcile');
    assert.strictEqual(s2.service.entries().filter((e: any) => e.type === 'fill').length, 0, 'no fill');
    // re-running reconcile does not repair
    const r2 = await reconcileRecoveredState(s2);
    assert.strictEqual(r2.outcome, 'UNKNOWN_ORDER', 'no auto-repair');
    assert.strictEqual(s2.reconciliationVerified, false);

    rmSync(dir, { recursive: true, force: true });
  });
});
