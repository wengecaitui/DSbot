/** All wire traffic is intercepted by deterministic fixture functions. No ambient fetch or secrets. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { createApplicationProductionRuntimeOwner, type ProductionRuntimeConfig } from '../../src/runtime/production/ProductionRuntimeOwner';
import { createProductionSpine, activateLiveReadiness, executeThroughGateway, reconcileRecoveredState, type ProductionSpine } from '../../src/position/ProductionSpine';
import { GateIoFuturesExecutionAdapter } from '../../src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import { GateIoG3RunBudget, GATEIO_G3_LIMITS } from '../../src/runtime/gateio/GateIoG3RunBudget';
import { GATEIO_READ_ENDPOINTS } from '../../src/runtime/gateio/GateIoReadContracts';
import { createTradeIntent } from '../../src/types/trade-intent';
import { reconcile } from '../../src/reconciliation/reconcile';

const NOW = 1_800_000_000_000;
let nextAccount = 0;
function harness(options: { environment?: 'testnet' | 'live'; seed?: boolean;
  overrideConfig?: Partial<ProductionRuntimeConfig>; omitGate?: boolean; wrongEnvironment?: boolean;
  wrongAccount?: boolean; denyRecovery?: boolean; budget?: GateIoG3RunBudget } = {}) {
  let now = NOW;
  let exposure = 0;
  let posts = 0;
  let accounts = 0;
  let creations = 0;
  let missingOrder = false;
  let mismatchOrder = false;
  let corruptPositions = false;
  let failPostTruth = false;
  let partial = false;
  let pendingPartial = false;
  let partialContracts: number | null = null;
  let tradeConflict = false;
  let history = false;
  let splitHistory = false;
  let externalActivity = false;
  let available = '900';
  const requests: { method: string; url: string; body?: any }[] = [];
  const orders = new Map<string, any>();
  const environment = options.environment ?? 'testnet';
  const accountId = 'gate-g4-' + ++nextAccount;
  const journalPath = join(mkdtempSync(join(tmpdir(), 'gate-g4-')), 'journal.jsonl');
  if (options.seed !== false) {
    // Fixture durable fact, replayed by the REAL RecoveryManager; production binding never seeds FLAT.
    const seed = createFileEventJournal(journalPath);
    const kernel = createTradingKernel({ exchange: 'gateio', journal: seed, clock: { now: () => now } });
    kernel.publish('position.baseline.confirmed', { baseline: { exchange: 'gateio',
      symbol: 'ETH/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } });
    seed.close();
  }
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = method === 'POST' ? JSON.parse(init.body as string) : undefined;
    requests.push({ method, url, body });
    assert.equal(new URL(url).origin, environment === 'testnet'
      ? 'https://api-testnet.gateapi.io' : 'https://api.gateio.ws');
    if (method === 'POST') {
      posts += 1;
      if (failPostTruth) corruptPositions = true;
      const size = partialContracts !== null ? Math.sign(Number(body.size)) * partialContracts
        : partial ? Number(body.size) / 2 : Number(body.size);
      exposure = Math.round((exposure + size) * 100) / 100;
      const order = { ...body, id: '1234567890123456' + posts,
        left: partial ? Number((Number(body.size) - size).toFixed(8)) : 0, status: pendingPartial ? 'open' : 'finished',
        finish_as: partial ? 'ioc' : 'filled', fill_price: '2000',
        finish_time: pendingPartial ? 0 : now / 1000, update_time: now / 1000 };
      orders.set(body.text, order);
      return response(order);
    }
    if (path.startsWith(GATEIO_READ_ENDPOINTS.OPEN_ORDERS + '/')) {
      if (missingOrder) return response({ label: 'ORDER_NOT_FOUND' }, 404);
      const order = orders.get(path.split('/').at(-1)!);
      return response(mismatchOrder ? { ...order, size: Number(order.size) * 2 } : order);
    }
    if (path === GATEIO_READ_ENDPOINTS.SERVER_TIME) return response({ server_time: now });
    if (path === GATEIO_READ_ENDPOINTS.ACCOUNTS) {
      accounts += 1;
      return response({ currency: 'USDT', total: '1000', available,
        in_dual_mode: false, position_mode: 'single', margin_mode: 0 });
    }
    if (path === GATEIO_READ_ENDPOINTS.POSITIONS) return response([{
      contract: 'ETH_USDT', mode: 'single', size: corruptPositions ? 'bad' : String(exposure),
      value: String(exposure * 2), entry_price: exposure === 0 ? null : '2000',
      mark_price: exposure === 0 ? null : '2000', update_time: String(now / 1000),
    }]);
    if (path === GATEIO_READ_ENDPOINTS.OPEN_ORDERS) return response([]);
    if (path === GATEIO_READ_ENDPOINTS.MY_TRADES) {
      const trades = history ? [...orders.values()].map((o, i) => ({
        id: String(3000 + i), order_id: o.id, contract: 'ETH_USDT',
        size: String((Number(o.size) - Number(o.left)) * (tradeConflict ? 2 : 1)),
        close_size: '0', price: '2000', text: o.text, fee: '0', point_fee: '0',
        role: 'taker', create_time: String(now / 1000),
      })) : [];
      if (externalActivity) trades.push({ id: '9999', order_id: '8888', contract: 'ETH_USDT',
        size: '0.1', close_size: '0', price: '2000', text: 't-unrelated', fee: '0',
        point_fee: '0', role: 'taker', create_time: String(now / 1000) });
      return response(splitHistory ? trades.flatMap(trade => [
        { ...trade, id: trade.id + '1', size: String(Number(trade.size) / 2) },
        { ...trade, id: trade.id + '2', size: String(Number(trade.size) / 2) },
      ]) : trades);
    }
    if (path === GATEIO_READ_ENDPOINTS.CONTRACT) return response({
      name: 'ETH_USDT', status: 'trading', in_delisting: false, quanto_multiplier: '0.001',
      order_size_min: '0.1', order_size_max: '10000', enable_decimal: true,
      order_price_round: '0.01', mark_price_round: '0.01', leverage_min: '1', leverage_max: '100',
      maker_fee_rate: '0', taker_fee_rate: '0',
    });
    if (path === GATEIO_READ_ENDPOINTS.TICKERS) return response([{
      contract: 'ETH_USDT', last: '2000', mark_price: '2000', index_price: '2000', funding_rate: '0',
      highest_bid: '1999', lowest_ask: '2001', high_24h: '2100', low_24h: '1900', volume_24h: '100',
    }]);
    assert.fail('unexpected fixture endpoint');
  };
  // Extra READ capacity permits adversarial re-audits; mutation ceilings remain the inherited 2+1.
  const budget = options.budget ?? GateIoG3RunBudget.create({
    ...GATEIO_G3_LIMITS, accountAcquisitions: 20, networkRequests: 120 });
  const config: ProductionRuntimeConfig = {
    enabled: true, mode: 'limited-live', exchange: 'gateio', environment, accountId, journalPath,
    hardRisk: { enabled: true, locked: false, totalCapitalUsd: 2000,
      maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1000 },
    market: { entries: [{ symbol: 'ETH/USDT', exchangeSymbol: 'ETH_USDT', intervals: ['1m'], ticker: true }],
      staleAfterMs: 30_000 },
    ...options.overrideConfig,
  };
  let spine: ProductionSpine;
  const createOwner = () => createApplicationProductionRuntimeOwner(config, {
    ...(options.omitGate ? {} : { gateIo: { environment: options.wrongEnvironment
      ? environment === 'testnet' ? 'live' as const : 'testnet' as const : environment,
    accountId: options.wrongAccount ? 'other-account' : accountId,
    credential: { apiKey: 'OFFLINE_FIXTURE_KEY', secretKey: 'OFFLINE_FIXTURE_SECRET' },
    fetchImpl, now: () => now, runBudget: budget } }),
    createMarketRuntime: () => { throw new Error('REFERENCE_FEED_MUST_NOT_BE_USED'); },
    createLimitedLiveExecution: () => { throw new Error('LEGACY_VENUE_MUST_NOT_BE_USED'); },
    createSpine: async (cfg) => { creations += 1; spine = await createProductionSpine(cfg); return spine; },
    ...(options.denyRecovery ? { recover: async () => { throw new Error('FIXTURE_RECOVERY_DENIED'); } } : {}),
  });
  let owner = createOwner();
  function publishPolicy(allow = true) {
    spine.kernel.publish('policy.snapshot.published', { policy: {
      exchange: 'gateio', sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1,
      compilerVersion: '1', compiledAt: now, effectiveAt: now, expiresAt: now + 3_600_000,
      allowNewEntries: allow, allowedSymbols: [], blockedSymbols: [],
      allowedStrategyIds: [], blockedStrategyIds: [], maxPositionMultiplier: 1, riskLevel: 'low',
      directionBias: 'neutral', symbolRules: {}, reasonCodes: [],
    } });
  }
  return {
    get owner() { return owner; }, requests, budget, get spine() { return spine; }, get posts() { return posts; },
    get creations() { return creations; }, get accounts() { return accounts; },
    get exposure() { return exposure; }, set exposure(v: number) { exposure = v; },
    set missingOrder(v: boolean) { missingOrder = v; },
    set mismatchOrder(v: boolean) { mismatchOrder = v; },
    set corruptPositions(v: boolean) { corruptPositions = v; },
    set failPostTruth(v: boolean) { failPostTruth = v; },
    set partial(v: boolean) { partial = v; }, set history(v: boolean) { history = v; },
    set splitHistory(v: boolean) { splitHistory = v; },
    set pendingPartial(v: boolean) { pendingPartial = v; partial = v; },
    set partialContracts(v: number) { partialContracts = v; partial = true; },
    set tradeConflict(v: boolean) { tradeConflict = v; },
    finishRemaining() {
      const order = [...orders.values()].at(-1)!;
      exposure += Number(order.left);
      order.left = 0; order.status = 'finished'; order.finish_as = 'filled';
      order.finish_time = now / 1000;
    },
    async restart() { await owner.stop(); owner = createOwner(); await owner.start(); publishPolicy(); },
    set externalActivity(v: boolean) { externalActivity = v; },
    set available(v: string) { available = v; },
    advance(ms: number) { now += ms; }, publishPolicy,
    async start() { await owner.start(); publishPolicy(); },
    async activate() { await activateLiveReadiness(spine); },
    async trade(action: 'open' | 'close' = 'open', exchange: 'gateio' | 'binance' = 'gateio', usd = 0.2) {
      return executeThroughGateway(spine, createTradeIntent({ exchange, symbol: 'ETH/USDT',
        direction: action === 'open' ? 'long' : 'short', positionUsd: usd,
        source: 'offline-g4', reason: action, biasUpdatedAt: now, createdAt: now }),
      action, usd);
    },
    fills() { return spine.kernel.journal().readFromLogicalSequence(1)
      .filter((e) => e.type === 'execution.fill.confirmed'); },
  };
}

describe('Gate G5 — cumulative lifecycle through the sole production Owner/Spine/OMS', () => {
  it('fractional CLOSE 0.3 -> fill 0.1 -> residual 0.2 uses decimal quantities without dust or false flat', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    await h.trade('open', 'gateio', 0.6);
    h.partialContracts = 0.1;
    assert.equal((await h.trade('close', 'gateio', 0.6)).omsResult?.status, 'cancelled');
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.0002);
    assert.equal(h.spine.reconciliationVerified, true);
  });
  it('A/B/C/G: OPEN 2 -> fill 1 -> fill 1; duplicates and delayed history never apply twice', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.pendingPartial = true;
    const result = await h.trade('open', 'gateio', 4);
    assert.equal(result.omsResult?.status, 'partially_filled');
    let order = h.spine.oms.getStore().list()[0]!;
    assert.equal(order.requestedQuantity, 0.002);
    assert.equal(order.cumulativeFilledQuantity, 0.001);
    assert.equal(order.remainingQuantity, 0.001);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.001);
    assert.equal(h.spine.reconciliationVerified, true);
    assert.equal(h.fills().length, 1);
    h.finishRemaining();
    assert.equal((await reconcileRecoveredState(h.spine)).outcome, 'MATCH');
    order = h.spine.oms.getStore().list()[0]!;
    assert.equal(order.status, 'FILLED');
    assert.equal(order.cumulativeFilledQuantity, 0.002);
    assert.equal(order.remainingQuantity, 0);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.002);
    assert.equal(h.fills().length, 2);
    assert.equal((await reconcileRecoveredState(h.spine)).outcome, 'MATCH');
    h.history = true; h.splitHistory = true;
    assert.equal((await reconcileRecoveredState(h.spine)).outcome, 'MATCH');
    assert.equal(h.fills().length, 2); assert.equal(h.posts, 1);
  });
  it('D/E/I: CLOSE 2 -> IOC fill 1 preserves residual 1, then closes only that residual', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    await h.trade('open', 'gateio', 4);
    h.partial = true;
    assert.equal((await h.trade('close', 'gateio', 4)).omsResult?.status, 'cancelled');
    const close = h.spine.oms.getStore().list().find(o => o.action === 'close')!;
    assert.equal(close.preparation?.reduceOnly, true);
    assert.equal(close.requestedQuantity, 0.002);
    assert.equal(close.cumulativeFilledQuantity, 0.001);
    assert.equal(close.remainingQuantity, 0.001);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.001);
    assert.equal(h.spine.reconciliationVerified, true);
    assert.equal(h.requests.filter(r => r.method === 'POST')[1]!.body.reduce_only, true);
    // Proof mutation budget remains two: any further submission must fail without a third POST.
    h.partial = false;
    assert.equal((await h.trade('close', 'gateio', 2)).omsResult?.status, 'rejected');
    assert.equal(h.posts, 2);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.001);
  });
  it('F: restart replays the first partial, then recovers only the new factual cumulative delta', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.pendingPartial = true; await h.trade('open', 'gateio', 4);
    await h.restart();
    assert.equal(h.spine.recoveryVerified, true);
    assert.equal(h.spine.reconciliationVerified, true);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.001);
    assert.equal(h.fills().length, 1);
    h.finishRemaining();
    assert.equal((await reconcileRecoveredState(h.spine)).outcome, 'MATCH');
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.002);
    assert.equal(h.fills().length, 2);
    h.history = true;
    assert.equal((await reconcileRecoveredState(h.spine)).outcome, 'MATCH');
    assert.equal(h.fills().length, 2); assert.equal(h.posts, 1);
  });
  it('H: contradictory trade aggregation cannot authorize a second delta or a new entry', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.pendingPartial = true; await h.trade('open', 'gateio', 4);
    h.finishRemaining(); h.history = true; h.tradeConflict = true;
    assert.equal((await reconcileRecoveredState(h.spine)).reconciliationVerified, false);
    assert.equal(h.fills().length, 1);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.001);
    assert.equal((await h.trade()).admitted, false); assert.equal(h.posts, 1);
  });
  it('a new cumulative delta with contradictory fresh position is not applied', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.pendingPartial = true; await h.trade('open', 'gateio', 4);
    h.finishRemaining(); h.exposure = 0;
    assert.equal((await reconcileRecoveredState(h.spine)).reconciliationVerified, false);
    assert.equal(h.fills().length, 1);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'open');
  });
  it('unrelated activity during partial-fill history lag remains fail closed', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.pendingPartial = true; await h.trade('open', 'gateio', 4);
    h.finishRemaining(); h.externalActivity = true;
    assert.equal((await reconcileRecoveredState(h.spine)).reconciliationVerified, false);
    assert.equal(h.fills().length, 1); assert.equal(h.posts, 1);
  });
});

describe('Gate G4 — existing Owner/Spine/Risk/OMS composition, offline only', () => {
  for (const environment of ['testnet', 'live'] as const) {
    it(environment + ': one spine, explicit environment, no boot order or auto LIVE_READY', async (t) => {
      const h = harness({ environment }); t.after(() => h.owner.stop());
      assert.equal(h.requests.length, 0);
      await h.start();
      assert.equal(h.creations, 1);
      assert.equal(h.owner.authoritativeSpine(), h.spine);
      assert.equal(h.spine.executionMode, 'limited-live');
      assert.equal(h.spine.service, null);
      assert.ok(h.spine.adapter instanceof GateIoFuturesExecutionAdapter);
      assert.equal(h.spine.recoveryVerified, true);
      assert.equal(h.spine.lastReconciliationReport?.outcome, 'MATCH');
      assert.equal(h.spine.protection.getMode(), 'replay');
      assert.equal(h.posts, 0);
      assert.equal((await h.trade()).riskCode, 'NOT_LIVE_READY');
      assert.equal(h.owner.legacyWrites.mode, 'QUARANTINED');
    });
  }

  it('OPEN -> CLOSE -> FLAT with both histories lagging; fresh reads, exact attestation, no double fill', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    const before = h.accounts;
    assert.equal((await h.trade()).omsResult?.status, 'filled');
    assert.equal(h.accounts, before + 2, 'pre-entry and fresh post-submit acquisition');
    assert.equal(h.spine.reconciliationVerified, true);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.0001);
    assert.equal(h.fills().length, 1);
    assert.equal((await h.trade('close')).omsResult?.status, 'filled');
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'flat');
    assert.equal(h.spine.reconciliationVerified, true);
    assert.equal(h.fills().length, 2);
    assert.deepEqual(h.requests.filter((r) => r.method === 'POST').map((r) => [r.body.size, r.body.reduce_only]),
      [[0.1, false], [-0.1, true]]);
    assert.equal(h.budget.snapshot().attestationUsed, 2);
    h.history = true;
    assert.equal((await reconcileRecoveredState(h.spine)).outcome, 'MATCH');
    assert.equal(h.fills().length, 2);
    assert.equal(h.budget.snapshot().attestationUsed, 2);
  });

  it('Risk rejects policy-blocked entry before OMS/client mutation', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.publishPolicy(false);
    assert.equal((await h.trade()).riskCode, 'POLICY_ENTRIES_BLOCKED');
    assert.equal(h.spine.oms.getStore().list().length, 0); assert.equal(h.posts, 0);
  });
  it('live environment wire injection also follows the full gateway path with no host fallback', async (t) => {
    const h = harness({ environment: 'live' }); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    assert.equal((await h.trade()).omsResult?.status, 'filled');
    assert.equal((await h.trade('close')).omsResult?.status, 'filled');
    assert.equal(h.spine.reconciliationVerified, true);
    assert.equal(h.posts, 2);
    assert.ok(h.requests.every((r) => new URL(r.url).origin === 'https://api.gateio.ws'));
  });
  it('the unchanged default G3 budget suffices for bound OPEN/CLOSE and cannot replenish', async (t) => {
    const h = harness({ budget: GateIoG3RunBudget.create() }); t.after(() => h.owner.stop());
    await h.start(); await h.activate(); await h.trade(); await h.trade('close');
    assert.equal(h.spine.reconciliationVerified, true);
    assert.equal(h.budget.snapshot().accountUsed, 5);
    assert.equal(h.budget.snapshot().totalUsed, 2);
    assert.ok(h.budget.snapshot().networkUsed <= 39);
    const exhausted = await reconcileRecoveredState(h.spine);
    assert.equal(exhausted.reconciliationVerified, false);
    assert.match(exhausted.issues[0]!.reason, /ACQUISITION_CAP_EXCEEDED/);
    assert.equal(h.spine.reconciliationVerified, false);
    assert.equal((await h.trade()).admitted, false);
  });
  it('failed fresh post-submit read retains factual fill and revokes reconciliation immediately', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.failPostTruth = true;
    assert.equal((await h.trade()).omsResult?.status, 'filled');
    assert.equal(h.spine.reconciliationVerified, false);
    assert.equal(h.fills().length, 1);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'open');
    assert.equal((await h.trade()).admitted, false); assert.equal(h.posts, 1);
  });
  it('concurrent entry attempts cannot overlap mutation or scale a factual position', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    await Promise.all([h.trade(), h.trade()]);
    assert.equal(h.posts, 1);
    assert.equal(h.fills().length, 1);
    assert.equal(h.spine.reconciliationVerified, true);
  });
  it('shutdown removes Gate mutation authority even from a retained internal OMS reference', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    await h.trade(); await h.owner.stop();
    const count = h.requests.length;
    const result = await h.spine.oms.submitRequest(createTradeIntent({
      exchange: 'gateio', symbol: 'ETH/USDT', direction: 'short', positionUsd: 0.2,
      source: 'offline-g4', reason: 'post-stop', biasUpdatedAt: NOW, createdAt: NOW,
    }), 'reduce', 0.2);
    assert.equal(result.status, 'conflict');
    assert.equal(h.requests.length, count);
  });
  it('Gate account capacity tightens caller limits; unknown account never uses config capital', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start();
    assert.equal(h.spine.privateConfig.hardRisk().totalCapitalUsd, 1000);
    assert.equal(h.spine.privateConfig.hardRisk().maxSinglePositionAbsUsd, 900);
    await h.activate(); h.available = '0.1';
    const result = await h.trade();
    assert.equal(result.omsResult?.status, 'rejected');
    assert.equal(h.posts, 0);
    h.available = 'bad';
    assert.equal((await reconcileRecoveredState(h.spine)).reconciliationVerified, false);
    assert.throws(() => h.spine.privateConfig.hardRisk(), /UNAVAILABLE/);
  });
  it('no local baseline remains MISSING, never auto FLAT', async (t) => {
    const h = harness({ seed: false }); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'missing');
    assert.equal((await h.trade()).admitted, false); assert.equal(h.posts, 0);
  });
  it('unverified recovery denies activation and performs no reads', async (t) => {
    const h = harness({ denyRecovery: true }); t.after(() => h.owner.stop());
    await assert.rejects(h.start(), /RECOVERY_DENIED/);
    await assert.rejects(h.activate(), /REQUIRES_RECOVERY/);
    assert.equal(h.requests.length, 0); assert.equal(h.owner.authoritativeSpine(), null);
  });
  it('stale market cannot grant LIVE_READY', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); h.advance(30_001);
    await assert.rejects(h.activate(), /REQUIRES_FRESH_MARKET/); assert.equal(h.posts, 0);
  });
  it('stale or future market denies subsequent entry, not merely boot readiness', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.advance(-1); assert.equal((await h.trade()).riskCode, 'MARKET_STALE');
    h.advance(30_002); assert.equal((await h.trade()).riskCode, 'MARKET_STALE');
    assert.equal(h.posts, 0);
  });
  it('mismatched Gate exposure revokes existing reconciliation and denies new entry', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.exposure = 0.1;
    assert.equal((await reconcileRecoveredState(h.spine)).reconciliationVerified, false);
    assert.equal(h.owner.read.reconciliation()?.reconciliationVerified, false);
    assert.equal((await h.trade()).riskCode, 'RECONCILIATION_NOT_VERIFIED'); assert.equal(h.posts, 0);
  });
  for (const kind of ['missingOrder', 'mismatchOrder', 'corruptPositions'] as const) {
    it(kind + ': factual local fill retained, post-submit truth fails closed, no false FLAT', async (t) => {
      const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
      if (kind !== 'corruptPositions') h[kind] = true;
      assert.equal((await h.trade()).omsResult?.status, 'filled');
      if (kind === 'corruptPositions') {
        h.corruptPositions = true; await reconcileRecoveredState(h.spine);
      }
      assert.equal(h.spine.reconciliationVerified, false);
      assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'open');
      assert.equal((await h.trade()).admitted, false); assert.equal(h.posts, 1);
    });
  }
  it('unrelated trade during history lag remains fail closed', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    await h.trade(); h.externalActivity = true;
    assert.equal((await reconcileRecoveredState(h.spine)).reconciliationVerified, false);
    assert.equal((await h.trade()).admitted, false); assert.equal(h.posts, 1);
  });
  it('IOC partial fill terminates the order without discarding its factual residual exposure', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate(); h.partial = true;
    assert.equal((await h.trade()).omsResult?.status, 'cancelled');
    assert.equal(h.exposure, 0.05); assert.equal(h.fills().length, 1);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.00005);
    assert.equal(h.spine.reconciliationVerified, true);
    assert.equal(h.spine.oms.getStore().list()[0]!.remainingQuantity, 0.00005);
    assert.equal((await h.trade()).admitted, false);
  });
  it('wrong venue intent and reference ticker cannot become Gate order/position truth', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    assert.equal((await h.trade('open', 'binance')).riskCode, 'GATEIO_VENUE_MISMATCH');
    h.spine.kernel.publish('market.ticker.updated', { ticker: {
      exchange: 'binance', instId: 'ETH/USDT', channel: 'ticker', last: 1, bestBid: 1, bestAsk: 1,
      volume24h: 0, high24h: 1, low24h: 1, ts: NOW }, receivedAt: NOW });
    assert.equal(h.spine.marketStore.getSnapshot('gateio', 'ETH/USDT')!.ticker!.ticker.last, 2000);
    assert.equal(h.spine.positionStore.resolve('binance', 'ETH/USDT').status, 'missing');
    assert.equal((await h.trade()).omsResult?.status, 'filled');
    assert.equal(h.exposure, 0.1);
  });
  for (const opts of [{ omitGate: true }, { wrongEnvironment: true }, { wrongAccount: true }]) {
    it('missing or misbound capability rejects before creating a spine ' + JSON.stringify(opts), async (t) => {
      const h = harness(opts); t.after(() => h.owner.stop());
      await assert.rejects(h.start(), /DEPENDENCY_MISMATCH/);
      assert.equal(h.requests.length, 0); assert.equal(h.creations, 0);
    });
  }
  for (const overrideConfig of [{ environment: undefined }, { environment: 'unknown' as any },
    { exchange: 'unknown' as any }, { mode: 'paper' as const }]) {
    it('invalid explicit Gate configuration has no effects ' + JSON.stringify(overrideConfig), async (t) => {
      const h = harness({ overrideConfig }); t.after(() => h.owner.stop()); await h.owner.start();
      assert.equal(h.owner.read.status().state, 'NOT_CONFIGURED'); assert.equal(h.creations, 0);
      assert.equal(h.requests.length, 0);
    });
  }
  it('existing reconciliation rejects conflicting fills even when the final position nets flat', () => {
    const fill = { exchange: 'gateio' as const, symbol: 'ETH/USDT', side: 'buy' as const,
      fillId: '1', orderId: 'a', quantity: 0.0001, price: 2000, executedAt: NOW };
    const local = { identity: { exchange: 'gateio' as const, accountId: 'a' }, positions: [], plans: [],
      orders: [{ ...fill, intentId: 'i', status: 'FILLED' as const, orderVersion: 1, sourceKernelEventId: 'x' }],
      fills: [fill] };
    const report = reconcile(local, { identity: local.identity, orders: [], positions: [],
      fills: [{ ...fill, quantity: 0.0002 }], complete: true, capturedAt: NOW, source: 'fixture' });
    assert.equal(report.reconciliationVerified, false);
  });
  it('production composition source contains no secret discovery, runner, alternate OMS or direct client mutation', () => {
    const binding = readFileSync(resolve('src/runtime/gateio/GateIoProductionBinding.ts'), 'utf8');
    const owner = readFileSync(resolve('src/runtime/production/ProductionRuntimeOwner.ts'), 'utf8');
    assert.doesNotMatch(binding + owner, /process\.env|dotenv|\.gateio\.env|readFileSync|client\.submitMarketOrder|createGateIoTestnetOmsE2ERunner|new OmsCore/);
    assert.match(binding, /new GateIoFuturesExecutionAdapter\(client\)/);
    assert.match(binding, /client\.lookupSubmittedOrder/);
    assert.match(owner, /createLimitedLiveExecution: \(\) => null/);
  });
});
