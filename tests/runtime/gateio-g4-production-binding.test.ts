import { createTestProductionSpine as createProductionSpine, testSpinePublisher, testSpineEvidencePublisher } from '../helpers/production-spine-capability-fixture';
/** All wire traffic is intercepted by deterministic fixture functions. No ambient fetch or secrets. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { createApplicationProductionRuntimeOwner, type ProductionRuntimeConfig } from '../../src/runtime/production/ProductionRuntimeOwner';
import { activateLiveReadiness, executeThroughGateway, reconcileRecoveredState, type ProductionSpine } from '../../src/position/ProductionSpine';
import { GateIoG3RunBudget, GATEIO_G3_LIMITS } from '../../src/runtime/gateio/GateIoG3RunBudget';
import { GATEIO_READ_ENDPOINTS } from '../../src/runtime/gateio/GateIoReadContracts';
import { createTradeIntent } from '../../src/types/trade-intent';
import { reconcile } from '../../src/reconciliation/reconcile';
import { seedGateIoAccountRiskAuthority } from '../helpers/gateio-account-risk-authority-fixture';
import { multiplyQuantity } from '../../src/types/decimal-quantity';
import { riskMandateDigest, riskMandateRevocationDigest } from '../../src/risk/risk-mandate';
import { RISK_MANDATE_REVOCATION_SCHEMA_VERSION } from '../../src/risk/risk-mandate-types';
import { gateIoAccountObservationDigest } from '../../src/accounting/gateio-account-risk-metrics';
import { generateOrderId } from '../../src/oms/order-id';
import { toGateIoClientText } from '../../src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter';

const NOW = 1_800_000_000_000;
let nextAccount = 0;
function harness(options: { environment?: 'testnet' | 'live'; seed?: boolean;
  riskAuthority?: boolean;
  receiptWriteFailure?: boolean;
  initialExposure?: number;
  authorityFailure?: 'MISSING' | 'REVOKED' | 'EXPIRED' | 'STALE' | 'PARTIAL' | 'LOSS' | 'DRAWDOWN';
  overrideConfig?: Partial<ProductionRuntimeConfig>; omitGate?: boolean; wrongEnvironment?: boolean;
  wrongAccount?: boolean; denyRecovery?: boolean; budget?: GateIoG3RunBudget;
  lostAcknowledgement?: boolean;
  freshExecutionMark?: number; onInstrumentRefresh?: () => void;
  openOrderFact?: (order: Record<string, any>) => Record<string, any> } = {}) {
  let now = NOW;
  let exposure = options.initialExposure ?? 0;
  let halt: 'RISK_INCREASE' | 'ALL_MUTATIONS' | undefined;
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
  let lookupCount = 0;
  let instrumentReads = 0;
  let instrumentMark = 2000;
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
    if (exposure > 0) {
      // Recovered tracked exchange execution, not an invented open baseline or a new mutation.
      const notional = multiplyQuantity(exposure, 2);
      const orderId = generateOrderId({ intentId: 'historical-open', exchange: 'gateio', symbol: 'ETH/USDT',
        direction: 'long', action: 'open', approvedPositionUsd: notional });
      const text = toGateIoClientText(orderId), id = '12345678901234560';
      kernel.publish('order.created', { order: { orderId, intentId: 'historical-open', exchange: 'gateio',
        symbol: 'ETH/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: notional } });
      kernel.publish('order.submitted', { orderId });
      kernel.publish('order.execution.prepared', { orderId, preparation: { requestedQuantity: multiplyQuantity(exposure, 0.001),
        venueQuantity: exposure, quantityMultiplier: 0.001, clientOrderId: text, reduceOnly: false } });
      kernel.publish('execution.fill.confirmed', { fill: { fillId: id, orderId, intentId: 'historical-open',
        exchange: 'gateio', symbol: 'ETH/USDT', side: 'buy', quantity: multiplyQuantity(exposure, 0.001),
        price: 2000, executedAt: NOW } });
      orders.set(text, { text, id, contract: 'ETH_USDT', size: exposure, left: 0, status: 'finished',
        finish_as: 'filled', reduce_only: false, price: '0', tif: 'ioc', fill_price: '2000',
        finish_time: NOW / 1000, update_time: NOW / 1000 });
    }
    if (options.riskAuthority !== false) {
      const publisher = { ...kernel, publish(type: any, payload: any) {
        if (type === 'RISK_MANDATE_ACTIVATED') {
          if (options.authorityFailure === 'MISSING') return;
          if (options.authorityFailure === 'EXPIRED') {
            const mandate = { ...payload.mandate, expiresAt: NOW - 1 };
            payload = { mandate, mandateDigest: riskMandateDigest(mandate) };
          }
          if (options.authorityFailure === 'LOSS' || options.authorityFailure === 'DRAWDOWN') {
            const mandate = { ...payload.mandate, limits: { ...payload.mandate.limits,
              ...(options.authorityFailure === 'LOSS' ? { maxDailyEquityLossExact: '1' }
                : { maxDrawdownFractionExact: '0.001' }) } };
            payload = { mandate, mandateDigest: riskMandateDigest(mandate) };
          }
        }
        if (type === 'GATEIO_ACCOUNT_FACT_OBSERVED') {
          if (options.authorityFailure === 'PARTIAL' && payload.observation.observedAt !== NOW) return;
          if (['LOSS', 'DRAWDOWN'].includes(options.authorityFailure!) && payload.observation.observedAt === NOW) {
            const observation = { ...payload.observation, totalExact: '800' };
            payload = { observation, observationDigest: gateIoAccountObservationDigest(observation) };
          }
        }
        return kernel.publish(type, payload);
      } } as unknown as typeof kernel;
      const authority = seedGateIoAccountRiskAuthority(publisher, { accountId,
        now: options.authorityFailure === 'STALE' ? NOW - 60_000 : now });
      if (options.authorityFailure === 'REVOKED') {
        const revocation = { schemaVersion: RISK_MANDATE_REVOCATION_SCHEMA_VERSION,
          exchange: 'gateio' as const, settle: 'USDT' as const, accountId,
          mandateId: authority.mandate.mandateId, mandateVersion: 1,
          mandateDigest: riskMandateDigest(authority.mandate), revokedAt: NOW,
          reason: 'offline-revocation', provenance: authority.mandate.provenance };
        kernel.publish('RISK_MANDATE_REVOKED', { revocation, revocationDigest: riskMandateRevocationDigest(revocation) });
      }
    }
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
      return response(options.lostAcknowledgement ? {} : order);
    }
    if (path.startsWith(GATEIO_READ_ENDPOINTS.OPEN_ORDERS + '/')) {
      lookupCount += 1;
      if (options.lostAcknowledgement && lookupCount === 1) return response({ label: 'ORDER_NOT_FOUND' }, 404);
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
    if (path === GATEIO_READ_ENDPOINTS.OPEN_ORDERS) return response(options.openOrderFact
      ? [...orders.values()].map(o => options.openOrderFact!({ ...o, status: 'open',
        left: Math.abs(Number(o.left)), is_reduce_only: o.reduce_only,
        is_close: false, create_time: now / 1000 })) : []);
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
    if (path === GATEIO_READ_ENDPOINTS.CONTRACT) {
      instrumentReads += 1;
      instrumentMark = instrumentReads > 1 ? options.freshExecutionMark ?? 2000 : 2000;
      if (instrumentReads > 1) options.onInstrumentRefresh?.();
      return response({
      name: 'ETH_USDT', status: 'trading', in_delisting: false, quanto_multiplier: '0.001',
      order_size_min: '0.1', order_size_max: '10000', enable_decimal: true,
      order_price_round: '0.01', mark_price_round: '0.01', leverage_min: '1', leverage_max: '100',
      maker_fee_rate: '0', taker_fee_rate: '0',
    });
    }
    if (path === GATEIO_READ_ENDPOINTS.TICKERS) return response([{
      contract: 'ETH_USDT', last: String(instrumentMark), mark_price: String(instrumentMark),
      index_price: String(instrumentMark), funding_rate: '0',
      highest_bid: '1999', lowest_ask: '2001', high_24h: '2100', low_24h: '1900', volume_24h: '100',
    }]);
    assert.fail('unexpected fixture endpoint');
  };
  // Extra READ capacity permits adversarial re-audits and an instrument refresh per execution;
  // mutation ceilings remain the inherited 2+1.
  const budget = options.budget ?? GateIoG3RunBudget.create({
    ...GATEIO_G3_LIMITS, accountAcquisitions: 20, instrumentAcquisitions: 20,
    networkRequests: 120 });
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
    ...(options.receiptWriteFailure ? { createJournal(path: string) {
      const file = createFileEventJournal(path);
      return { ...file, get lastSequence() { return file.lastSequence; },
        get eventCount() { return file.eventCount; },
        append(event: Parameters<typeof file.append>[0]) {
          if (event.type === 'PRETRADE_RISK_DECISION_RECORDED') throw new Error('OFFLINE_RECEIPT_DISK_FAILURE');
          file.append(event);
        } };
    } } : {}),
    ...(options.omitGate ? {} : { gateIo: { environment: options.wrongEnvironment
      ? environment === 'testnet' ? 'live' as const : 'testnet' as const : environment,
    accountId: options.wrongAccount ? 'other-account' : accountId,
    credential: { apiKey: 'OFFLINE_FIXTURE_KEY', secretKey: 'OFFLINE_FIXTURE_SECRET' },
    fetchImpl, now: () => now, runBudget: budget } }),
    createMarketRuntime: () => { throw new Error('REFERENCE_FEED_MUST_NOT_BE_USED'); },
    createLimitedLiveExecution: () => { throw new Error('LEGACY_VENUE_MUST_NOT_BE_USED'); },
    createSpine: async (cfg) => { creations += 1; const hardRisk = cfg.hardRisk;
      const control = cfg.mutationControl!;
      spine = await createProductionSpine({ ...cfg,
        mutationControl: () => ({ ...control(), mutationHalt: halt }),
        hardRisk: () => ({ ...hardRisk(), mutationHalt: halt }) }); return spine; },
    ...(options.denyRecovery ? { recover: async () => { throw new Error('FIXTURE_RECOVERY_DENIED'); } } : {}),
  });
  let owner = createOwner();
  function publishPolicy(allow = true) {
    testSpinePublisher(spine).publish('policy.snapshot.published', { policy: {
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
    get instrumentReads() { return instrumentReads; },
    get exposure() { return exposure; }, set exposure(v: number) { exposure = v; },
    set halt(v: 'RISK_INCREASE' | 'ALL_MUTATIONS' | undefined) { halt = v; },
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
    async trade(action: 'open' | 'close' = 'open', exchange: 'gateio' | 'binance' = 'gateio', amount?: number) {
      const usd = amount ?? (action === 'open' ? 0.2 : multiplyQuantity(Math.abs(
        spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity), instrumentMark));
      return executeThroughGateway(spine, createTradeIntent({ exchange, symbol: 'ETH/USDT',
        direction: action === 'open' ? 'long' : 'short', positionUsd: usd,
        source: 'offline-g4', reason: action, biasUpdatedAt: now, createdAt: now }),
      action, usd);
    },
    fills() { return spine.kernel.journal().readFromLogicalSequence(1)
      .filter((e) => e.type === 'execution.fill.confirmed'); },
  };
}

describe('R3H6 Gate private clock boundary (offline owner composition)', () => {
  it('public time replacement is unavailable; composition clock advancement still keeps stale Gate data blocked', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    const s = h.spine;
    assert.equal('clock' in s.privateConfig, false);
    assert.equal((s.privateConfig as any).clock, undefined);
    assert.equal(Reflect.set(s.privateConfig, 'clock', { now: () => NOW }), false);
    assert.equal(Reflect.set(s, 'clock', { now: () => NOW }), false);
    h.advance(31_000);
    const snapshot = s.marketStore.getSnapshot('gateio', 'ETH/USDT')!;
    assert.equal(snapshot.generatedAt, NOW + 31_000); assert.equal(snapshot.isStale, true);
    assert.equal(Reflect.set(snapshot, 'generatedAt', NOW), false);
    const result = await h.trade();
    assert.equal(result.admitted, false); assert.equal(result.riskCode, 'MARKET_STALE');
    assert.equal(h.posts, 0);
  });
});

describe('R3H4B Gate public evidence does not grant mutable authority (offline)', () => {
  it('detached recovery/observation/receipt/order snapshots cannot poison OPEN or trusted exit', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    const s = h.owner.authoritativeSpine()!;
    function immutable(value: any, seen = new WeakSet<object>()) {
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value); assert.equal(Object.isFrozen(value), true);
      assert.equal(Reflect.set(value, 'injected', () => 'forged'), false);
      for (const key of Object.keys(value)) {
        immutable(value[key], seen); assert.equal(Reflect.set(value, key, 'forged'), false);
      }
    }
    for (const read of [h.owner.read.recovery, h.owner.read.status, h.owner.read.reconciliation,
      h.owner.gateIoObservation, () => s.lastReconciliationReport, () => s.accountRiskAuthorizationContext(NOW)]) {
      const first = read(); const expected = structuredClone(first); immutable(first);
      assert.deepEqual(read(), expected); assert.notStrictEqual(read(), first);
    }
    assert.equal(Reflect.set(s.accounting, 'snapshot', () => ({ forged: true })), false);
    assert.throws(() => s.accounting.snapshot(), /LIMITED_LIVE_ACCOUNTING_UNAVAILABLE_L0/);
    assert.throws(() => s.accounting.lifecycle(), /LIMITED_LIVE_LIFECYCLE_UNAVAILABLE_L0/);
    assert.equal((await h.trade()).omsResult?.status, 'filled');
    immutable(s.pretradeDecisionReceipts.snapshot()); immutable(s.oms.getStore().list());
    h.advance(1); assert.equal((await h.trade('close')).omsResult?.status, 'filled');
    assert.equal(h.posts, 2); assert.equal(h.exposure, 0);
    assert.equal((s.kernel as any).publish, undefined); assert.equal((s.oms as any).submitRequest, undefined);
    assert.equal((s.protection as any).stop, undefined);
  });
});

describe('R3H4A observer and protective control isolation (offline owner composition)', () => {
  it('throwing/rejecting generic receipt observers cannot veto legitimate OPEN or CLOSE', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    let calls = 0;
    const unsubscribe = h.spine.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', () => {
      calls += 1; throw new Error('GENERIC_OBSERVER_NOT_AUTHORITY');
    });
    h.spine.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', async () => {
      throw new Error('ASYNC_OBSERVER_NOT_AUTHORITY');
    });
    assert.equal((await h.trade()).omsResult?.status, 'filled'); h.advance(1);
    assert.equal((await h.trade('close')).omsResult?.status, 'filled');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2); assert.equal(h.posts, 2); assert.equal(h.exposure, 0);
    unsubscribe(); unsubscribe();
    const events = h.spine.kernel.journal().readFromLogicalSequence(1);
    for (const created of events.filter(e => e.type === 'order.created')) {
      assert.ok(events.some(e => e.type === 'PRETRADE_RISK_DECISION_RECORDED'
        && e.kernelLogicalSequence < created.kernelLogicalSequence));
    }
  });

  for (const action of ['open', 'close'] as const) {
    it('real durable receipt append failure blocks ' + action + ' before mutation', async t => {
      const h = harness({ receiptWriteFailure: true, initialExposure: action === 'close' ? 0.1 : 0 });
      t.after(() => h.owner.stop()); await h.start();
      if (action === 'open') await h.activate();
      const orders = h.spine.oms.getStore().list().length;
      const result = await h.trade(action);
      assert.equal(result.riskCode, 'RISK_DECISION_RECEIPT_PERSIST_FAILED');
      assert.equal(h.posts, 0); assert.equal(h.spine.oms.getStore().list().length, orders);
      assert.equal(h.spine.pretradeDecisionReceipts.snapshot().records.length, 0);
      assert.equal(h.spine.kernel.journal().readFromLogicalSequence(1)
        .some(e => e.type === 'PRETRADE_RISK_DECISION_RECORDED'), false);
    });
  }

  it('generic caller cannot obtain, replace or invoke protective lifecycle/re-arm capabilities', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    const view = h.owner.authoritativeSpine()!.protection;
    assert.deepEqual(Object.keys(view).sort(), ['getMode', 'getSubmittedCount', 'positionManager']);
    assert.deepEqual(Object.getOwnPropertySymbols(view), []);
    for (const method of ['start', 'stop', 'clearSubmitted', '_setLive', 'reset', 'set']) {
      assert.equal((view as any)[method], undefined);
      assert.equal(Reflect.set(view, method, () => {}), false);
      assert.throws(() => (view as any)[method]('forged-plan'), TypeError);
    }
    assert.equal(Reflect.set(h.spine, 'protection', { stop() {} }), false);
    assert.equal(view.getMode(), 'live');
    assert.equal((await h.trade()).omsResult?.status, 'filled'); h.advance(1);
    assert.equal((await h.trade('close')).omsResult?.status, 'filled');
    await h.owner.stop();
    assert.equal(view.getMode(), 'replay'); assert.equal(h.owner.read.status().state, 'STOPPED');
    assert.equal((await h.trade()).admitted, false);
  });

  it('public caller cannot clear the in-flight protective lock without a durable fact', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    await h.trade('open', 'gateio', 4); h.pendingPartial = true;
    testSpinePublisher(h.spine).publish('market.ticker.updated', { ticker: { exchange: 'gateio', instId: 'ETH/USDT',
      channel: 'ticker', last: 1800, bestBid: 1799, bestAsk: 1801, volume24h: 100, high24h: 2100,
      low24h: 1800, ts: NOW }, receivedAt: NOW });
    await new Promise(resolve => setImmediate(resolve));
    const plan = h.spine.planStore.getActive('gateio', 'ETH/USDT')!;
    assert.equal(h.spine.protection.getSubmittedCount(), 1);
    const sequence = h.spine.kernel.journal().lastSequence;
    assert.throws(() => (h.spine.protection as any).clearSubmitted(plan.planId), TypeError);
    assert.equal(h.spine.protection.getSubmittedCount(), 1);
    assert.equal(h.spine.kernel.journal().lastSequence, sequence); assert.equal(h.posts, 2);
  });

  it('protective close remains authoritative and durable despite generic observer errors', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate(); await h.trade();
    h.halt = 'RISK_INCREASE';
    h.spine.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', () => { throw new Error('OBSERVER'); });
    testSpinePublisher(h.spine).publish('market.ticker.updated', { ticker: { exchange: 'gateio', instId: 'ETH/USDT',
      channel: 'ticker', last: 1800, bestBid: 1799, bestAsk: 1801, volume24h: 100, high24h: 2100,
      low24h: 1800, ts: NOW }, receivedAt: NOW });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.posts, 2); assert.equal(h.exposure, 0);
    const events = h.spine.kernel.journal().readFromLogicalSequence(1);
    const receipt = events.filter(e => e.type === 'PRETRADE_RISK_DECISION_RECORDED').at(-1)!;
    const close = h.spine.oms.getStore().list().find(o => o.action === 'close')!;
    assert.equal(receipt.payload.receipt.exitProof?.orderId, close.orderId);
    assert.equal(receipt.payload.receipt.exitProof?.reduceOnly, true);
    assert.equal(close.preparation?.reduceOnly, true);
    assert.ok(receipt.kernelLogicalSequence < events.find(e => e.type === 'order.created'
      && e.payload.order.orderId === close.orderId)!.kernelLogicalSequence);
  });
});

describe('R3H3 private market/protection authority (offline owner composition)', () => {
  it('formal owner cannot consume a replaced market price/version or injected market projector', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    const s = h.owner.authoritativeSpine()!;
    const real = s.marketStore.getSnapshot('gateio', 'ETH/USDT')!;
    const forged = { ...real, snapshotVersion: 999999,
      ticker: { ...real.ticker!, ticker: { ...real.ticker!.ticker, last: 1 } }, toJSON: () => real };
    assert.equal((s.marketStore as any).apply, undefined);
    assert.equal(Reflect.set(s.marketStore, 'getSnapshot', () => forged), false);
    assert.equal(Reflect.set(s.marketStore, 'getAllSnapshots', () => [forged]), false);
    assert.equal(Reflect.set(s, 'marketStore', { getSnapshot: () => forged }), false);
    assert.equal((await h.trade()).omsResult?.status, 'filled');
    assert.equal(h.posts, 1);
    assert.equal(s.marketStore.getSnapshot('gateio', 'ETH/USDT')!.ticker!.ticker.last, 2000);
    assert.ok(s.kernel.journal().readFromLogicalSequence(1).some(e =>
      e.type === 'market.ticker.updated' && e.kernelLogicalSequence === real.snapshotVersion));
    assert.equal(s.kernel.journal().readFromLogicalSequence(1).some(e => e.kernelLogicalSequence === 999999), false);
    const receipt = s.pretradeDecisionReceipts.snapshot().records.at(-1)!.receipt;
    assert.equal(receipt.gatewayMode, 'GATEIO_ACCOUNT_BOUND');
    assert.equal(receipt.riskEffect, 'OPEN');
  });
  it('non-durable plan/stop/evaluator injection cannot suppress a real protective close', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate(); await h.trade();
    await new Promise(resolve => setImmediate(resolve));
    const s = h.owner.authoritativeSpine()!, view = s.planStore;
    const plan = view.getActive('gateio', 'ETH/USDT')!;
    assert.equal(plan.stopPrice, 1900);
    const seq = s.kernel.journal().lastSequence, digest = view.digest();
    const eventId = 'd'.repeat(64);
    const event = { type: 'position.plan.updated', kernelLogicalSequence: seq + 100,
      kernelEventId: eventId, kernelTimestamp: NOW, payload: { planId: plan.planId, stopPrice: 1 } };
    assert.equal(Object.isFrozen(view), true);
    assert.equal((view as any).apply, undefined);
    assert.equal((view as any).subscribeToKernel, undefined);
    assert.equal((view as any).plans, undefined);
    assert.throws(() => (view as any).apply(event), TypeError);
    assert.equal(Reflect.set(view, 'apply', () => null), false);
    const forged = { ...plan, stopPrice: 1, planVersion: seq + 100, sourceKernelEventId: eventId, toJSON: () => plan };
    for (const key of Reflect.ownKeys(view)) assert.equal(Reflect.set(view, key, () => forged), false);
    assert.throws(() => Object.setPrototypeOf(view, { apply() {} }), TypeError);
    assert.equal(Reflect.set(s, 'planStore', { getActive: () => forged }), false);
    assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(view.list()), true);
    assert.notEqual(plan, view.get(plan.planId));
    assert.equal(Reflect.set(plan, 'stopPrice', 1), false);
    assert.equal(Reflect.set(plan, 'sourceKernelEventId', eventId), false);
    assert.equal(Reflect.set(plan, 'toJSON', forged.toJSON), false);
    const manager = s.protection.positionManager;
    assert.equal(Object.isFrozen(manager), true);
    assert.equal((manager as any).evaluate, undefined); assert.equal((manager as any).onFill, undefined);
    assert.equal((manager as any).stopConfig, undefined);
    assert.equal(Reflect.set(manager, 'evaluate', () => ({ decision: 'hold' })), false);
    assert.equal(Reflect.set(s.protection, 'positionManager', {}), false);
    assert.equal(Reflect.set(manager.getStopConfig(), 'stopPct', 0.99), false);
    assert.equal(view.digest(), digest); assert.equal(s.kernel.journal().lastSequence, seq);
    assert.equal(s.kernel.journal().getByEventId(eventId), null);
    // Genuine durable ticker still triggers the real evaluator against its private 1900 stop.
    testSpinePublisher(s).publish('market.ticker.updated', { ticker: { exchange: 'gateio', instId: 'ETH/USDT',
      channel: 'ticker', last: 1800, bestBid: 1799, bestAsk: 1801, volume24h: 100,
      high24h: 2100, low24h: 1800, ts: NOW + 1 }, receivedAt: NOW });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.posts, 2); assert.equal(h.exposure, 0);
    const receipt = s.pretradeDecisionReceipts.snapshot().records.at(-1)!.receipt;
    assert.equal(receipt.gatewayMode, 'GATEIO_TRUSTED_EXIT_ONLY'); assert.equal(receipt.riskEffect, 'CLOSE');
    assert.equal(receipt.exitProof!.reduceOnly, true);
    assert.equal(h.requests.filter(r => r.method === 'POST').at(-1)!.body.reduce_only, true);
    assert.equal(view.get(plan.planId)!.status, 'closed');
    assert.ok(s.kernel.journal().getByEventId(view.get(plan.planId)!.sourceKernelEventId));
  });
  it('durable market/plan creation and restart replay retain canonical state without public plan ingress', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate(); await h.trade();
    await new Promise(resolve => setImmediate(resolve));
    const s = h.spine, plan = s.planStore.getActive('gateio', 'ETH/USDT')!;
    assert.ok(s.kernel.journal().getByEventId(plan.sourceKernelEventId));
    // Even the narrowed evidence capability cannot grant arbitrary protection-plan changes.
    assert.throws(() => (testSpinePublisher(s).publish as any)('position.plan.updated',
      { planId: plan.planId, stopPrice: 1850 }), /PRODUCTION_EVIDENCE_EVENT_NOT_PERMITTED/);
    assert.equal(s.planStore.get(plan.planId)!.stopPrice, 1900);
    const market = s.marketStore.getSnapshot('gateio', 'ETH/USDT')!;
    await h.restart();
    assert.equal(h.spine.recoveryVerified, true);
    assert.deepEqual(h.spine.planStore.get(plan.planId), plan);
    assert.deepEqual(h.spine.marketStore.getSnapshot('gateio', 'ETH/USDT'), market);
    assert.equal((h.spine.planStore as any).apply, undefined); assert.equal((h.spine.marketStore as any).apply, undefined);
    assert.equal(h.spine.protection.getMode(), 'replay');
    assert.equal((await h.trade()).riskCode, 'NOT_LIVE_READY');
    assert.equal((await h.trade('close')).omsResult?.status, 'filled');
    assert.equal(h.exposure, 0);
  });
});

describe('R3H1 public projector authority closure (offline owner composition)', () => {
  it('public position/policy facades and returned views are detached and immutable', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start();
    const s = h.owner.authoritativeSpine()!;
    for (const store of [s.positionStore, s.policyStore]) {
      assert.equal(Object.isFrozen(store), true);
      assert.equal('apply' in store, false);
      for (const key of Reflect.ownKeys(store)) assert.equal(Reflect.set(store, key, () => null), false);
      assert.equal(Reflect.set(store, 'apply', () => {}), false);
      assert.throws(() => Object.setPrototypeOf(store, { apply() {} }), TypeError);
    }
    assert.equal(Reflect.set(s, 'positionStore', {}), false);
    assert.equal(Reflect.set(s, 'policyStore', {}), false);
    const pos = s.positionStore.resolve('gateio', 'ETH/USDT');
    const positions = s.positionStore.listResolved();
    const policy = s.policyStore.resolve('gateio', 'ETH/USDT');
    for (const item of [pos, pos.snapshot!, positions, policy,
      s.positionStore.getLatest('gateio', 'ETH/USDT')!, s.policyStore.getLatest('gateio')!])
      assert.equal(Object.isFrozen(item), true);
    assert.notEqual(pos, s.positionStore.resolve('gateio', 'ETH/USDT'));
    assert.equal(Reflect.set(pos.snapshot!, 'positionVersion', 999), false);
    assert.equal(Reflect.set(pos, 'toJSON', () => ({ status: 'flat' })), false);
    assert.equal(Reflect.set(positions, '0', { status: 'flat' }), false);
    assert.equal(Reflect.set(s.policyStore.getLatest('gateio')!.allowedSymbols, '0', 'BTC/USDT'), false);
  });
  it('B1: fictional flat read/count cannot bypass the actual open position limit', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    assert.equal((await h.trade()).omsResult?.status, 'filled');
    const s = h.owner.authoritativeSpine()!;
    const canonical = s.positionStore.resolve('gateio', 'ETH/USDT');
    const fictional = { ...canonical, status: 'flat', side: 'flat', signedQuantity: 0,
      averageEntryPrice: 0, snapshot: { ...canonical.snapshot, side: 'flat', signedQuantity: 0 } };
    assert.equal(Reflect.set(s.positionStore, 'resolve', () => fictional), false);
    assert.equal(Reflect.set(s.positionStore, 'listResolved', () => [fictional]), false);
    assert.throws(() => Object.defineProperty(s.positionStore, 'resolve', { value: () => fictional }), TypeError);
    const counterfeitSpine = Object.create(s);
    Object.defineProperty(counterfeitSpine, 'positionStore', { value: { resolve: () => fictional } });
    h.advance(1);
    const intent = createTradeIntent({ exchange: 'gateio', symbol: 'ETH/USDT', direction: 'long',
      positionUsd: 0.2, source: 'forged-read', reason: 'open', biasUpdatedAt: NOW, createdAt: NOW + 1 });
    await assert.rejects(executeThroughGateway(counterfeitSpine, intent, 'open', 0.2),
      /PRODUCTION_SPINE_MUTATION_AUTHORITY_INVALID/);
    assert.equal((await h.trade()).riskCode, 'POSITION_LIMIT_REACHED');
    assert.equal(h.posts, 1); assert.equal(h.exposure, 0.1);
  });
  it('B2: non-durable policy cannot authorize; legitimate durable policy still can', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.publishPolicy(false);
    const s = h.owner.authoritativeSpine()!;
    const original = s.policyStore.getLatest('gateio')!;
    const forged = { ...original, allowNewEntries: true, policyId: 'b'.repeat(64) };
    const sequence = s.kernel.journal().lastSequence;
    assert.equal((s.policyStore as any).apply, undefined);
    assert.throws(() => (s.policyStore as any).apply(forged), TypeError);
    assert.equal(Reflect.set(original, 'allowNewEntries', true), false);
    assert.equal(Reflect.set(s.policyStore, 'resolve', () => forged), false);
    assert.equal(Reflect.set(s.policyStore, 'getLatest', () => forged), false);
    assert.equal(s.kernel.journal().lastSequence, sequence);
    assert.equal(s.kernel.journal().getByEventId(forged.policyId), null);
    assert.equal((await h.trade()).riskCode, 'POLICY_ENTRIES_BLOCKED'); assert.equal(h.posts, 0);
    h.advance(1); h.publishPolicy(true);
    assert.equal((await h.trade()).omsResult?.status, 'filled'); assert.equal(h.posts, 1);
  });
  it('B3: forged toJSON/version/source cannot enter exit proof; receipt uses durable lineage', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate(); await h.trade();
    const s = h.owner.authoritativeSpine()!;
    const real = s.positionStore.resolve('gateio', 'ETH/USDT');
    let serializationCalls = 0;
    const forged = { ...real, snapshot: { ...real.snapshot, positionVersion: 999,
      sourceKernelEventId: 'e'.repeat(64) }, toJSON() { serializationCalls++; return real; } };
    assert.equal(Reflect.set(s.positionStore, 'resolve', () => forged), false);
    assert.equal(Reflect.set(real.snapshot!, 'sourceKernelEventId', 'e'.repeat(64)), false);
    assert.equal(Reflect.set(real, 'toJSON', forged.toJSON), false);
    h.advance(1);
    assert.equal((await h.trade('close')).omsResult?.status, 'filled');
    assert.equal(serializationCalls, 0);
    const receipt = s.pretradeDecisionReceipts.snapshot().records.at(-1)!.receipt;
    assert.equal(receipt.exitProof!.positionVersion, real.snapshot!.positionVersion);
    assert.equal(receipt.exitProof!.positionSourceKernelEventId, real.snapshot!.sourceKernelEventId);
    assert.ok(s.kernel.journal().getByEventId(receipt.exitProof!.positionSourceKernelEventId));
    assert.equal(h.requests.filter(r => r.method === 'POST').at(-1)!.body.reduce_only, true);
    assert.equal(h.exposure, 0);
  });
  it('restart replays private position/policy and retains immutable views and trusted exit', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate(); await h.trade();
    const before = h.spine.positionStore.resolve('gateio', 'ETH/USDT');
    const policyVersion = h.spine.policyStore.getLatest('gateio')!.policyVersion;
    const policy = h.spine.policyStore.getByVersion('gateio', policyVersion);
    await h.restart();
    assert.equal(h.spine.recoveryVerified, true);
    assert.deepEqual(h.spine.positionStore.resolve('gateio', 'ETH/USDT'), before);
    assert.deepEqual(h.spine.policyStore.getByVersion('gateio', policyVersion), policy);
    assert.equal((h.spine.positionStore as any).apply, undefined);
    assert.equal((h.spine.policyStore as any).apply, undefined);
    assert.equal(h.spine.protection.getMode(), 'replay');
    assert.equal((await h.trade()).riskCode, 'NOT_LIVE_READY');
    assert.equal((await h.trade('close')).omsResult?.status, 'filled');
    assert.equal(h.exposure, 0);
  });
});

describe('R3D2 authoritative trusted exit boundary (offline wire only)', () => {
  function exit(h: ReturnType<typeof harness>, action: 'reduce' | 'close' | 'emergency_exit',
    direction: 'long' | 'short' = 'short', usd = 0.2, exchange: 'gateio' | 'binance' = 'gateio') {
    return executeThroughGateway(h.spine, createTradeIntent({ exchange, symbol: 'ETH/USDT', direction,
      positionUsd: usd, source: 'adversarial-exit', reason: action, biasUpdatedAt: NOW, createdAt: NOW }), action, 999999);
  }
  for (const failure of ['MISSING', 'EXPIRED', 'REVOKED', 'STALE', 'PARTIAL', 'LOSS', 'DRAWDOWN'] as const) {
    it(failure + ': independent recovery exit readiness permits proven close but no risk increase', async t => {
      const h = harness({ initialExposure: 0.1, authorityFailure: failure }); t.after(() => h.owner.stop());
      await h.start();
      assert.equal(h.spine.protection.getMode(), 'replay', 'never grant general LIVE_READY');
      const context = h.spine.accountRiskAuthorizationContext(NOW)!;
      if (failure !== 'LOSS' && failure !== 'DRAWDOWN') assert.notEqual(context.status, 'COMPATIBLE');
      assert.equal((await h.trade()).admitted, false);
      const result = await exit(h, 'close');
      assert.equal(result.omsResult?.status, 'filled', result.riskCode ?? 'expected proven exit');
      assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'flat');
      const receipt = h.spine.pretradeDecisionReceipts.snapshot().records.at(-1)!.receipt;
      assert.equal(receipt.riskEffect, 'CLOSE'); assert.equal(receipt.exitProof?.reduceOnly, true);
      assert.equal(receipt.exitProof?.accountId, h.spine.privateConfig.accountId);
      assert.equal(receipt.exitProof?.orderId, result.omsResult?.order?.orderId);
      assert.equal((await h.trade()).admitted, false);
      await h.activate();
      assert.equal((await h.trade()).admitted, false, 'the same failed economic authority cannot authorize OPEN');
      assert.equal(h.posts, 1);
      assert.equal((h.spine.oms as any).submitRequest, undefined);
      assert.equal((h.spine as any).adapter, undefined);
    });
  }
  for (const action of ['reduce', 'close', 'emergency_exit'] as const) {
    it(action + ' same-side or oversized label does not authorize mutation', async t => {
      const h = harness({ initialExposure: 0.1, riskAuthority: false }); t.after(() => h.owner.stop()); await h.start();
      assert.equal((await exit(h, action, 'long')).riskCode, 'ACTION_POSITION_CONFLICT');
      assert.equal((await exit(h, action, 'short', 0.21)).riskCode, 'EXIT_QUANTITY_EXCEEDS_EXPOSURE');
      assert.equal(h.posts, 0); assert.equal(h.spine.oms.getStore().list().length, 1, 'only the recovered order exists');
    });
  }
  it('close with partial size derives reduce; full emergency derives emergency close, both reduceOnly', async t => {
    const h = harness({ initialExposure: 0.2, riskAuthority: false }); t.after(() => h.owner.stop()); await h.start();
    const partial = await exit(h, 'close', 'short', 0.2);
    assert.equal(partial.action, 'reduce'); assert.equal(partial.omsResult?.status, 'filled');
    assert.equal(h.exposure, 0.1);
    const emergency = await exit(h, 'emergency_exit');
    assert.equal(emergency.action, 'emergency_exit'); assert.equal(emergency.omsResult?.status, 'filled');
    assert.deepEqual(h.spine.pretradeDecisionReceipts.snapshot().records.map(r => r.receipt.riskEffect),
      ['REDUCE', 'EMERGENCY_CLOSE']);
    assert.ok(h.requests.filter(r => r.method === 'POST').every(r => r.body.reduce_only === true));
  });
  it('risk-increase halt allows proven exit; ALL_MUTATIONS blocks entries and exits', async t => {
    const h = harness({ initialExposure: 0.1 }); t.after(() => h.owner.stop()); await h.start();
    h.halt = 'ALL_MUTATIONS';
    assert.equal((await exit(h, 'close')).riskCode, 'ALL_MUTATIONS_HALTED');
    assert.equal((await h.trade()).admitted, false); assert.equal(h.posts, 0);
    h.halt = 'RISK_INCREASE';
    assert.equal((await exit(h, 'close')).omsResult?.status, 'filled');
    await h.activate(); assert.equal((await h.trade()).riskCode, 'KILLSWITCH_LOCKED');
    assert.equal(h.posts, 1);
  });
  it('unknown/flat/mismatched position and foreign venue deny without mutation', async t => {
    const flat = harness(); t.after(() => flat.owner.stop()); await flat.start();
    assert.equal((await exit(flat, 'close')).admitted, false); assert.equal(flat.posts, 0);
    const h = harness({ initialExposure: 0.1 }); t.after(() => h.owner.stop()); await h.start();
    assert.equal((await exit(h, 'close', 'short', 0.2, 'binance')).riskCode, 'PROVENANCE_MISMATCH');
    h.exposure = 0.2;
    assert.equal((await exit(h, 'close')).riskCode, 'EXIT_TRUTH_NOT_VERIFIED');
    assert.equal(h.posts, 0);
  });
  it('unrecovered or stopped process cannot exit; restart needs fresh position proof, not LIVE_READY', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate(); await h.trade();
    await h.restart(); assert.equal(h.spine.protection.getMode(), 'replay');
    assert.equal((await exit(h, 'close')).omsResult?.status, 'filled');
    await h.owner.stop(); const count = h.requests.length;
    assert.equal((await exit(h, 'close')).riskCode, 'EXIT_RUNTIME_STOPPED');
    assert.equal(h.requests.length, count);
    const unready = harness({ initialExposure: 0.1, denyRecovery: true }); t.after(() => unready.owner.stop());
    await assert.rejects(unready.start(), /FIXTURE_RECOVERY_DENIED/);
    assert.equal((await exit(unready, 'close')).admitted, false); assert.equal(unready.posts, 0);
  });
  it('protective exits traverse authoritative receipt even during risk-increase halt', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate(); await h.trade();
    h.halt = 'RISK_INCREASE';
    testSpinePublisher(h.spine).publish('market.ticker.updated', { ticker: { exchange: 'gateio', instId: 'ETH/USDT',
      channel: 'ticker', last: 1800, bestBid: 1799, bestAsk: 1801, volume24h: 100, high24h: 2100,
      low24h: 1800, ts: NOW }, receivedAt: NOW });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.posts, 2);
    const receipt = h.spine.pretradeDecisionReceipts.snapshot().records.at(-1)!.receipt;
    assert.equal(receipt.gatewayMode, 'GATEIO_TRUSTED_EXIT_ONLY');
    assert.equal(receipt.riskEffect, 'CLOSE'); assert.equal(receipt.exitProof?.reduceOnly, true);
    assert.equal(receipt.exitProof?.orderId, h.spine.oms.getStore().list().at(-1)!.orderId);
  });
  it('observer-driven explicit halt and tampering never create a bypass; observer errors alone do not veto', async t => {
    const h = harness({ initialExposure: 0.1 }); t.after(() => h.owner.stop()); await h.start();
    const risk = h.spine.privateConfig.hardRisk;
    Reflect.set(h.spine, 'riskAuthorizationMode', 'LEGACY_PAPER_OR_NON_GATE');
    Reflect.set(h.spine.privateConfig, 'hardRisk', () => ({ locked: false }));
    assert.equal(h.spine.riskAuthorizationMode, 'GATEIO_ACCOUNT_BOUND');
    assert.equal(h.spine.privateConfig.hardRisk, risk);
    h.spine.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', () => { h.halt = 'ALL_MUTATIONS'; });
    const result = await exit(h, 'close');
    assert.equal(result.omsResult?.status, 'rejected'); assert.equal(h.posts, 0);
    const fail = harness({ initialExposure: 0.1 }); t.after(() => fail.owner.stop()); await fail.start();
    fail.spine.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', () => { throw new Error('receipt subscriber failure'); });
    assert.equal((await exit(fail, 'close')).omsResult?.status, 'filled');
    assert.equal(fail.posts, 1); assert.equal(fail.spine.oms.getStore().list().length, 2);
  });
  it('ALL_MUTATIONS newly asserted while recording OPEN stops before adapter POST', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    h.spine.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', () => { h.halt = 'ALL_MUTATIONS'; });
    assert.equal((await h.trade()).omsResult?.status, 'rejected');
    assert.equal(h.posts, 0);
  });
  it('public projection injection is unavailable; mismatched and unresolved exposure are denied', async t => {
    const h = harness({ initialExposure: 0.1 }); t.after(() => h.owner.stop()); await h.start();
    assert.equal('apply' in h.spine.positionStore, false);
    assert.equal(Reflect.set(h.spine.positionStore, 'apply', () => {}), false);
    h.exposure = 0.2;
    assert.equal((await exit(h, 'close', 'short', 0.4)).admitted, false); assert.equal(h.posts, 0);
    const pending = harness(); t.after(() => pending.owner.stop()); await pending.start(); await pending.activate();
    pending.pendingPartial = true; await pending.trade('open', 'gateio', 4);
    assert.equal((await exit(pending, 'close', 'short', 2)).riskCode, 'EXIT_ORDER_UNRESOLVED');
    assert.equal(pending.posts, 1);
  });
  it('execution refresh cannot prepare a reduce-only quantity above the proven exposure', async t => {
    const h = harness({ initialExposure: 0.1, freshExecutionMark: 1000 }); t.after(() => h.owner.stop()); await h.start();
    const result = await exit(h, 'close');
    assert.equal(result.omsResult?.status, 'submission_unknown', 'unchanged OMS catches preparation failure');
    assert.equal(result.omsResult?.reason, 'TRUSTED_EXIT_PREPARATION_EXCEEDS_PROOF');
    assert.equal(h.posts, 0);
  });
  it('protective recovery can exit with expired mandate without general LIVE_READY', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate(); await h.trade();
    h.advance(3_600_001); await h.restart();
    assert.equal(h.spine.protection.getMode(), 'replay');
    assert.notEqual(h.spine.accountRiskAuthorizationContext(NOW + 3_600_001)!.status, 'COMPATIBLE');
    testSpinePublisher(h.spine).publish('market.ticker.updated', { ticker: { exchange: 'gateio', instId: 'ETH/USDT',
      channel: 'ticker', last: 1800, bestBid: 1799, bestAsk: 1801, volume24h: 100, high24h: 2100,
      low24h: 1800, ts: NOW + 3_600_001 }, receivedAt: NOW + 3_600_001 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.posts, 2);
    assert.equal(h.spine.pretradeDecisionReceipts.snapshot().records.at(-1)!.receipt.riskEffect, 'CLOSE');
    assert.equal(h.spine.protection.getMode(), 'replay');
    assert.equal((await h.trade()).admitted, false);
  });
  it('halt asserted by durable preparation subscriber blocks the pending exit before POST', async t => {
    const h = harness({ initialExposure: 0.1 }); t.after(() => h.owner.stop()); await h.start();
    h.spine.kernel.subscribe('order.execution.prepared', () => { h.halt = 'ALL_MUTATIONS'; });
    assert.equal((await exit(h, 'close')).omsResult?.status, 'submission_unknown');
    assert.equal(h.posts, 0);
  });
});

describe('Gate G5R1 cross-source order facts', () => {
  for (const [name, patch] of Object.entries({
    quantity: { size: 3 }, side: { size: -2 }, reduceOnly: { is_reduce_only: true },
    identity: { id: '77777777777777777' }, clientText: { text: 't-unrelated' },
    remainingRegression: { left: 0.5, update_time: NOW / 1000 - 1 },
    remainingSameTime: { left: 2 }, remainingRange: { left: 3 },
    remainingUnknownTime: { left: 2, update_time: null, create_time: NOW / 1000 - 10 },
    price: { price: '100' }, tif: { tif: 'gtc' }, close: { is_close: true },
    fillPrice: { fill_price: '2100' },
  })) {
    it(name + ' contradiction fails closed before replacing factual evidence', async t => {
      const h = harness({ openOrderFact: o => ({ ...o, ...patch }) });
      t.after(() => h.owner.stop()); await h.start(); await h.activate();
      h.pendingPartial = true;
      await h.trade('open', 'gateio', 4);
      assert.equal(h.spine.reconciliationVerified, false);
      assert.notEqual(h.spine.lastReconciliationReport?.outcome, 'MATCH');
      assert.equal(h.fills().length, 1, 'no attestation delta is applied on conflicting truth');
      assert.equal((await h.trade()).admitted, false);
      assert.equal(h.posts, 1);
    });
  }
  it('consistent overlapping facts reconcile without double application', async t => {
    const h = harness({ openOrderFact: o => o }); t.after(() => h.owner.stop());
    await h.start(); await h.activate(); h.pendingPartial = true;
    await h.trade('open', 'gateio', 4);
    assert.equal(h.spine.reconciliationVerified, true);
    assert.equal((await reconcileRecoveredState(h.spine)).outcome, 'MATCH');
    assert.equal(h.fills().length, 1);
  });
  for (const terminal of ['pending', 'cancelled', 'filled'] as const) {
    it('earlier open list can advance to a newer exact ' + terminal + ' observation', async t => {
      const h = harness({ openOrderFact: o => ({ ...o, left: 2, fill_price: null,
        update_time: NOW / 1000 - 1, create_time: NOW / 1000 - 2 }) });
      t.after(() => h.owner.stop()); await h.start(); await h.activate();
      if (terminal === 'pending') h.pendingPartial = true;
      if (terminal === 'cancelled') h.partial = true;
      await h.trade('open', 'gateio', 4);
      assert.equal(h.spine.reconciliationVerified, true);
      assert.equal(h.fills().length, 1);
    });
  }
  it('a later open observation cannot revive a cached terminal partial order', async t => {
    const h = harness({ openOrderFact: o => ({ ...o, update_time: NOW / 1000 + 1 }) });
    t.after(() => h.owner.stop()); await h.start(); await h.activate(); h.partial = true;
    await h.trade('open', 'gateio', 4);
    assert.equal(h.spine.reconciliationVerified, false);
  });
  it('production re-arm never bypasses the unchanged Gate proof mutation budget', async t => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    await h.trade('open', 'gateio', 4); h.partial = true;
    function tick(price: number) {
      testSpinePublisher(h.spine).publish('market.ticker.updated', { ticker: {
        exchange: 'gateio', instId: 'ETH/USDT', channel: 'ticker', last: price,
        bestBid: price - 1, bestAsk: price + 1, volume24h: 100, high24h: 2100,
        low24h: 1800, ts: NOW }, receivedAt: NOW });
    }
    tick(1890); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.spine.oms.getStore().list().find(o => o.action === 'close')!.status, 'CANCELLED');
    assert.equal(h.spine.protection.getSubmittedCount(), 0);
    assert.equal(h.posts, 2);
    tick(1880); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.posts, 2, 're-arm grants neither an extra mutation slot nor POST retry');
    assert.equal(h.budget.snapshot().proofUsed, 2);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'open');
  });
  it('overlapping open-list facts do not widen F15 submission_unknown recovery authority', async t => {
    const h = harness({ openOrderFact: o => o, lostAcknowledgement: true });
    t.after(() => h.owner.stop()); await h.start(); await h.activate(); h.pendingPartial = true;
    assert.equal((await h.trade('open', 'gateio', 4)).omsResult?.status, 'submission_unknown');
    assert.equal(h.spine.oms.getStore().list()[0]!.status, 'SUBMISSION_UNKNOWN');
    assert.equal(h.spine.reconciliationVerified, false);
    assert.equal(h.fills().length, 0);
    assert.equal(h.budget.snapshot().attestationUsed, 0);
    assert.equal(h.posts, 1);
  });
});

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
  it('recovery without account facts or human mandate keeps OPEN fail-closed and records the rejection', async t => {
    const h = harness({ riskAuthority: false });
    t.after(() => h.owner.stop());
    await h.start();
    await h.activate();
    const readiness = h.spine.accountRiskAuthorizationContext(NOW)!;
    assert.equal(readiness.compatible, false);
    assert.notEqual(readiness.status, 'COMPATIBLE');
    const result = await h.trade('open');
    assert.equal(result.admitted, false);
    assert.equal(result.riskCode, 'ACCOUNT_RISK_CONTEXT_INCOMPATIBLE');
    assert.equal(h.posts, 0);
    const receipts = h.spine.pretradeDecisionReceipts.snapshot().records;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.receipt.decision, 'REJECTED');
    assert.equal(receipts[0]!.receipt.reasonCode, 'ACCOUNT_RISK_CONTEXT_INCOMPATIBLE');
  });

  for (const environment of ['testnet', 'live'] as const) {
    it(environment + ': one spine, explicit environment, no boot order or auto LIVE_READY', async (t) => {
      const h = harness({ environment }); t.after(() => h.owner.stop());
      assert.equal(h.requests.length, 0);
      await h.start();
      assert.equal(h.creations, 1);
      assert.equal(h.owner.authoritativeSpine(), h.spine);
      assert.equal(h.spine.executionMode, 'limited-live');
      assert.equal(h.spine.service, null);
      assert.equal((h.spine as any).adapter, undefined);
      assert.equal((h.spine.oms as any).submitRequest, undefined);
      assert.equal((h.spine.oms.getStore() as any).apply, undefined);
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
    const decisions = h.spine.pretradeDecisionReceipts.snapshot().records.map((entry) => entry.receipt);
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0]!.gatewayMode, 'GATEIO_ACCOUNT_BOUND');
    assert.equal(decisions[0]!.decision, 'ADMITTED');
    assert.match(decisions[0]!.contextDigest!, /^[a-f0-9]{64}$/);
    assert.match(decisions[0]!.snapshotDigest!, /^[a-f0-9]{64}$/);
    assert.match(decisions[0]!.mandateDigest!, /^[a-f0-9]{64}$/);
    assert.equal(decisions[1]!.gatewayMode, 'GATEIO_TRUSTED_EXIT_ONLY');
    assert.equal(decisions[1]!.exitProof?.reduceOnly, true);
    assert.equal(decisions[1]!.exitProof?.orderId, h.spine.oms.getStore().list()[1]!.orderId);
    assert.equal(decisions[1]!.decision, 'ADMITTED');
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
  for (const [name, freshExecutionMark, expectedStatus, expectedPosts] of [
    ['successful POST', 2000, 'filled', 1],
    ['fresh-minimum pre-POST rejection', 2005, 'rejected', 0],
  ] as const) it(`execution refresh invalidates prior truth before ${name}, then reconciles`, async t => {
    const duringRefresh: { verified: boolean; canonicalPresent: boolean }[] = [];
    let h: ReturnType<typeof harness>;
    h = harness({ freshExecutionMark, onInstrumentRefresh: () => {
      duringRefresh.push({ verified: h.spine.reconciliationVerified,
        canonicalPresent: h.owner.gateIoObservation()?.canonical !== null });
    } });
    t.after(() => h.owner.stop()); await h.start(); await h.activate();
    assert.equal(h.spine.reconciliationVerified, true);
    assert.notEqual(h.owner.gateIoObservation()?.canonical, null);
    assert.equal((await h.trade()).omsResult?.status, expectedStatus);
    assert.equal(h.instrumentReads, 2);
    assert.deepEqual(duringRefresh, [{ verified: false, canonicalPresent: false }]);
    assert.equal(h.posts, expectedPosts);
    assert.equal(h.spine.reconciliationVerified, true);
    assert.notEqual(h.owner.gateIoObservation()?.canonical, null);
  });
  it('the unchanged default G3 instrument cap fails closed before a second execution', async (t) => {
    const h = harness({ budget: GateIoG3RunBudget.create() }); t.after(() => h.owner.stop());
    await h.start(); await h.activate();
    assert.equal((await h.trade()).omsResult?.status, 'filled');
    assert.equal((await h.trade('close')).omsResult?.status, 'rejected');
    assert.equal(h.spine.reconciliationVerified, false);
    assert.equal(h.budget.snapshot().instrumentUsed, 2);
    assert.equal(h.instrumentReads, 2);
    assert.equal(h.requests.filter(r => new URL(r.url).pathname === GATEIO_READ_ENDPOINTS.CONTRACT).length, 2);
    assert.equal(h.budget.snapshot().totalUsed, 1);
    assert.equal(h.posts, 1);
    assert.ok(h.budget.snapshot().networkUsed <= 39);
    assert.equal((await h.trade('close')).admitted, false);
    assert.equal(h.posts, 1);
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
  it('public spine has no direct OMS/adapter mutation and shutdown keeps the gateway closed', async (t) => {
    const h = harness(); t.after(() => h.owner.stop()); await h.start(); await h.activate();
    assert.equal((h.spine as any).adapter, undefined);
    assert.equal((h.spine.oms as any).submitRequest, undefined);
    assert.equal((h.spine.oms.getStore() as any).apply, undefined);
    await h.trade(); await h.owner.stop();
    const count = h.requests.length;
    const result = await h.trade('close');
    assert.equal(result.admitted, false);
    assert.equal(result.riskCode, 'EXIT_RUNTIME_STOPPED');
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
    testSpinePublisher(h.spine).publish('market.ticker.updated', { ticker: {
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
