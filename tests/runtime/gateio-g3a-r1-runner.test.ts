/** All Gate G3A-R1 evidence uses recording transports and fixture credentials only. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import * as ts from 'typescript';
import { createInMemoryEventJournal } from '../../src/kernel/InMemoryEventJournal';
import { createKernelPositionStateStore } from '../../src/kernel/KernelPositionStateStore';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createGateIoExecutionTruthPort } from '../../src/reconciliation/GateIoExecutionTruthPort';
import { createGateIoAuthenticatedReadFoundation } from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import { createGateIoFuturesExecutionClient, GateIoFuturesExecutionClientError } from '../../src/runtime/gateio/GateIoFuturesExecutionClient';
import { GATEIO_READ_ENDPOINTS } from '../../src/runtime/gateio/GateIoReadContracts';
import { createGateIoReadTransport, createGateIoTestnetReadTransport } from '../../src/runtime/gateio/GateIoReadTransport';
import { GATEIO_G3_LIMITS, GateIoG3BudgetDenial, GateIoG3RunBudget } from '../../src/runtime/gateio/GateIoG3RunBudget';
import { createGateIoTestnetOmsE2ERunner } from '../../src/runtime/gateio/GateIoTestnetOmsE2ERunner';
import { establishVerifiedExternalFlatBaseline } from '../../src/runtime/gateio/establishVerifiedExternalFlatBaseline';

const NOW = 1_800_000_000_000;
const SECOND = '1800000000';
const KEY = 'FIXTURE_G3_KEY_DO_NOT_LEAK';
const SECRET = 'FIXTURE_G3_SECRET_DO_NOT_LEAK';
type Scenario = 'normal' | 'ambiguous-open' | 'ambiguous-close' | 'cleanup'
  | 'dual-opposed' | 'dual-zero' | 'dual-missing' | 'dual-malformed'
  | 'trade-mismatch' | 'trade-mismatch-flat' | 'trade-mismatch-unknown'
  | 'kernel-fill-missing' | 'preclose-mismatch' | 'close-unknown-flat'
  | 'close-unknown-open' | 'cleanup-nonflat' | 'cleanup-truth-unknown'
  | 'close-risk-rejected' | 'preclose-provider-throw' | 'dual-after-open'
  | 'close-fill-mismatch-open' | 'open-unknown-open';

function orderObject(body: Record<string, unknown>, id: string) {
  return { id, text: body.text, contract: body.contract, size: body.size, left: 0,
    status: 'finished', finish_as: 'filled', fill_price: '2000', finish_time: Number(SECOND) };
}

function fixture(scenario: Scenario) {
  const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const orders = new Map<string, Record<string, unknown>>();
  const trades: Record<string, unknown>[] = [];
  let position = scenario === 'dual-opposed' ? 1 : 0;
  const dual = scenario.startsWith('dual-') && scenario !== 'dual-after-open';
  let postCount = 0;
  let accountAcquisitions = 0;
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const readFetch = async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method ?? 'GET', body: null });
    assert.equal(url.startsWith('https://api-testnet.gateapi.io/'), true);
    const path = new URL(url).pathname;
    if (path === GATEIO_READ_ENDPOINTS.SERVER_TIME) return response({ server_time: NOW });
    if (path === GATEIO_READ_ENDPOINTS.ACCOUNTS) {
      accountAcquisitions += 1;
      if (scenario === 'preclose-mismatch' && accountAcquisitions === 3) position = 0.2;
      return response({ currency: 'USDT', total: '1000', available: '900',
        in_dual_mode: dual || (scenario === 'dual-after-open' && postCount > 0),
        position_mode: dual || (scenario === 'dual-after-open' && postCount > 0) ? 'dual' : 'single',
        margin_mode: 0 });
    }
    if (path === GATEIO_READ_ENDPOINTS.POSITIONS) {
      if ((scenario === 'trade-mismatch-unknown' && postCount > 0)
          || (scenario === 'cleanup-truth-unknown' && accountAcquisitions >= 5))
        return response([{ contract: 'ETH_USDT', mode: 'single', size: 'malformed' }]);
      const base = { contract: 'ETH_USDT', pos_margin_mode: 'cross', leverage: '10',
        liq_price: null, unrealised_pnl: null, realised_pnl: null, margin: null,
        update_time: SECOND };
      if (dual || (scenario === 'dual-after-open' && postCount > 0)) {
        const opposed = scenario === 'dual-opposed' || scenario === 'dual-after-open';
        const long = { ...base, mode: 'dual_long', size: opposed ? '1' : '0',
          value: opposed ? '2' : '0',
          entry_price: opposed ? '2000' : null,
          mark_price: opposed ? '2000' : null };
        const short = { ...base, mode: 'dual_short',
          size: opposed ? '-1' : scenario === 'dual-malformed' ? 'bad' : '0',
          value: opposed ? '-2' : '0',
          entry_price: opposed ? '2000' : null,
          mark_price: opposed ? '2000' : null };
        return response(scenario === 'dual-missing' ? [long] : [long, short]);
      }
      return response([{ ...base, mode: 'single', size: String(position),
        value: String(position * 2), entry_price: position === 0 ? null : '2000',
        mark_price: position === 0 ? null : '2000' }]);
    }
    if (path === GATEIO_READ_ENDPOINTS.OPEN_ORDERS) return response([]);
    if (path === GATEIO_READ_ENDPOINTS.MY_TRADES) return response(trades);
    if (path === GATEIO_READ_ENDPOINTS.CONTRACT) return response({
      name: 'ETH_USDT', status: 'trading', in_delisting: false,
      quanto_multiplier: '0.001', order_size_min: '0.1', order_size_max: '10000',
      enable_decimal: true, order_price_round: '0.01', mark_price_round: '0.01',
      leverage_min: '1', leverage_max: '100', maker_fee_rate: '0', taker_fee_rate: '0',
    });
    if (path === GATEIO_READ_ENDPOINTS.TICKERS) return response([{
      contract: 'ETH_USDT', last: '2000', mark_price: '2000',
      index_price: '2000', funding_rate: '0',
    }]);
    assert.fail(`unexpected closed read path: ${path}`);
  };
  const executionFetch = async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method ?? 'GET',
      body: init.method === 'POST' ? JSON.parse(init.body as string) as Record<string, unknown> : null });
    assert.equal(url.startsWith('https://api-testnet.gateapi.io/'), true);
    if (init.method === 'GET') {
      const text = new URL(url).pathname.split('/').at(-1)!;
      assert.ok(orders.has(text));
      if (((scenario === 'close-unknown-flat' || scenario === 'close-unknown-open')
          && postCount === 2) || (scenario === 'open-unknown-open' && postCount === 1))
        return response({ malformed: true });
      return response(orders.get(text));
    }
    assert.equal(init.method, 'POST');
    postCount += 1;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    if (['cleanup', 'cleanup-nonflat', 'cleanup-truth-unknown'].includes(scenario)
        && postCount === 2) {
      return response({ label: 'ORDER_REJECTED' }, 400);
    }
    const id = String(1000 + postCount);
    const normalized = orderObject(body, id);
    orders.set(body.text as string, scenario === 'kernel-fill-missing' && postCount === 1
      ? { ...normalized, fill_price: null } : normalized);
    if (!(scenario === 'close-unknown-open' && postCount === 2)
        && !(scenario === 'close-fill-mismatch-open' && postCount === 2)
        && !(scenario === 'cleanup-nonflat' && postCount === 3))
      position = Math.round((position + Number(body.size)) * 10) / 10;
    if (scenario === 'trade-mismatch-flat' && postCount === 1) position = 0;
    if (!(scenario === 'close-unknown-open' && postCount === 2)) {
      trades.push({ id: String(2000 + postCount), order_id: id, contract: 'ETH_USDT',
        size: scenario === 'close-fill-mismatch-open' && postCount === 2
          ? '-0.05' : scenario.startsWith('trade-mismatch') && postCount === 1
            ? '0.05' : String(body.size),
        close_size: '0', price: '2000', text: body.text,
        fee: '0', point_fee: '0', role: 'taker',
        trade_value: String(Math.abs(Number(body.size)) * 2), create_time: SECOND });
    }
    if ((scenario === 'ambiguous-open' && postCount === 1)
        || (scenario === 'open-unknown-open' && postCount === 1)
        || (scenario === 'ambiguous-close' && postCount === 2)
        || ((scenario === 'close-unknown-flat' || scenario === 'close-unknown-open') && postCount === 2)) {
      throw new Error('FIXTURE_RAW_RESPONSE_DO_NOT_LEAK');
    }
    return response(orders.get(body.text as string));
  };
  const journal = createInMemoryEventJournal();
  const runner = createGateIoTestnetOmsE2ERunner({
    environment: 'testnet', accountId: 'fixture-account',
    credential: { apiKey: KEY, secretKey: SECRET }, readFetch, executionFetch,
    signedTimestamp: () => SECOND, now: () => NOW,
    journal,
    marketSnapshot: () => {
      if (scenario === 'preclose-provider-throw' && postCount >= 1)
        throw new Error('FIXTURE_PROVIDER_RAW_DO_NOT_LEAK');
      return { exchange: 'gateio', symbol: 'ETH/USDT',
      ticker: { receivedAt: NOW, ticker: { channel: 'ticker', exchange: 'gateio',
        instId: 'ETH/USDT', last: 2000, bestBid: 1999, bestAsk: 2001,
        volume24h: 1, high24h: 2100, low24h: 1900, ts: NOW } },
      klines: {}, snapshotVersion: 1, generatedAt: NOW, lastUpdatedAt: NOW,
      ageMs: 0, isStale: false };
    },
    policyResolution: () => ({ status: 'active', policy: null,
      allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'neutral',
      riskLevel: 'low', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] }),
    hardRisk: () => ({ accountId: 'fixture-account', exchange: 'gateio',
      locked: scenario === 'close-risk-rejected' && postCount >= 1,
      enabled: true, totalCapitalUsd: 1000,
      maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1000 }),
  });
  return { runner, journal, requests, readFetch, get position() { return position; },
    get postCount() { return postCount; }, get accountAcquisitions() { return accountAcquisitions; } };
}

async function baselineHarness(scenario: Scenario) {
  const fake = fixture(scenario);
  const budget = GateIoG3RunBudget.create();
  const transport = createGateIoTestnetReadTransport(fake.readFetch, budget);
  let time = NOW;
  const now = () => time;
  const foundation = createGateIoAuthenticatedReadFoundation({
    transport, runBudget: budget, now, credential: { apiKey: KEY, secretKey: SECRET },
    identity: { exchange: 'gateio', accountId: 'fixture-account', settle: 'USDT' },
  });
  const journal = createInMemoryEventJournal();
  const kernel = createTradingKernel({ exchange: 'gateio', journal, clock: { now } });
  const positionStore = createKernelPositionStateStore();
  kernel.subscribe('position.baseline.confirmed', (event) => { positionStore.apply(event); });
  kernel.subscribe('execution.fill.confirmed', (event) => { positionStore.apply(event); });
  const port = createGateIoExecutionTruthPort({ environment: 'testnet', transport,
    runBudget: budget, foundation, accountId: 'fixture-account', now,
    listOmsOrders: () => [] });
  const truth = await port.acquireTruth();
  const establish = (patch: Record<string, unknown> = {}) =>
    establishVerifiedExternalFlatBaseline({ truthPort: port, truth, kernel, positionStore,
      accountId: 'fixture-account', symbol: 'ETH/USDT', now, ...patch });
  return { fake, budget, port, truth, kernel, positionStore, establish,
    setTime(value: number) { time = value; } };
}

describe('Gate G3A-R1 offline budget and runner', () => {
  it('accepts only a current factual single/dual zero-leg baseline with journaled safe evidence', async () => {
    for (const scenario of ['normal', 'dual-zero'] as const) {
      const harness = await baselineHarness(scenario);
      const evidence = harness.establish();
      assert.equal(evidence.positionMode, scenario === 'normal' ? 'single' : 'dual');
      assert.equal(evidence.accountId, 'fixture-account');
      assert.match(evidence.digest, /^[a-f0-9]{64}$/);
      assert.equal(harness.positionStore.resolve('gateio', 'ETH/USDT').status, 'flat');
      const serialized = JSON.stringify(harness.kernel.journal().readFromLogicalSequence(1));
      assert.equal(serialized.includes(evidence.digest), true);
      for (const secret of [KEY, SECRET, 'SIGN', 'FIXTURE_RAW_RESPONSE'])
        assert.equal(serialized.includes(secret), false);
      assert.throws(() => harness.establish(), /GATEIO_VERIFIED_FLAT_BASELINE_DENIED/);
    }
  });

  it('rejects opposed, missing, malformed, stale and mismatched baseline evidence', async () => {
    for (const scenario of ['dual-opposed', 'dual-missing', 'dual-malformed'] as const) {
      const harness = await baselineHarness(scenario);
      assert.throws(() => harness.establish(), /GATEIO_VERIFIED_FLAT_BASELINE_DENIED/);
      assert.equal(harness.kernel.journal().readFromLogicalSequence(1).length, 0);
    }
    const stale = await baselineHarness('normal');
    stale.setTime(NOW + 30_001);
    assert.throws(() => stale.establish(), /GATEIO_VERIFIED_FLAT_BASELINE_DENIED/);
    const wrongAccount = await baselineHarness('normal');
    assert.throws(() => wrongAccount.establish({ accountId: 'other-account' }),
      /GATEIO_VERIFIED_FLAT_BASELINE_DENIED/);
    assert.throws(() => wrongAccount.establish({ symbol: 'BTC/USDT' }),
      /GATEIO_VERIFIED_FLAT_BASELINE_DENIED/);
    assert.throws(() => wrongAccount.establish({ truth: { ...wrongAccount.truth,
      identity: { exchange: 'binance', accountId: 'fixture-account' } } }),
      /GATEIO_VERIFIED_FLAT_BASELINE_DENIED/);
    const opened = await baselineHarness('normal');
    opened.kernel.publish('position.baseline.confirmed', { baseline: { exchange: 'gateio',
      symbol: 'ETH/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } });
    opened.kernel.publish('execution.fill.confirmed', { fill: { fillId: 'existing-fill',
      exchange: 'gateio', symbol: 'ETH/USDT', side: 'buy', quantity: 0.0001,
      price: 2000, executedAt: NOW } });
    assert.equal(opened.positionStore.resolve('gateio', 'ETH/USDT').status, 'open');
    assert.throws(() => opened.establish(), /GATEIO_VERIFIED_FLAT_BASELINE_DENIED/);
  });

  it('keeps one exact budget object across normal reads, proof POSTs and cleanup POST', async () => {
    const fake = fixture('cleanup');
    const budget = fake.runner.sharedBudget;
    const seen: GateIoG3RunBudget[] = [];
    const originalRead = budget.consumeReadRequest.bind(budget);
    const originalMutation = budget.consumeMutationRequest.bind(budget);
    budget.consumeReadRequest = function() { seen.push(this); return originalRead(); };
    budget.consumeMutationRequest = function(purpose, reduceOnly) {
      seen.push(this); return originalMutation(purpose, reduceOnly);
    };
    const receipt = await fake.runner.run();
    assert.equal(receipt.status, 'STOP', receipt.reasonCode);
    assert.equal(receipt.reasonCode, 'FAIL_CLEANED_UP');
    assert.equal(seen.length, fake.requests.length);
    assert.equal(seen.every((candidate) => candidate === budget), true);
    assert.deepEqual(budget.snapshot(), receipt.budget);
  });

  it('binds one shared GET implementation to exact live/testnet origins without fallback', async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ server_time: NOW }));
    };
    const live = createGateIoReadTransport(fetchImpl);
    const testnet = createGateIoTestnetReadTransport(fetchImpl, GateIoG3RunBudget.create());
    await live.get({ endpoint: GATEIO_READ_ENDPOINTS.SERVER_TIME, query: [] });
    await testnet.get({ endpoint: GATEIO_READ_ENDPOINTS.SERVER_TIME, query: [] });
    assert.equal(urls[0], 'https://api.gateio.ws/api/v4/spot/time');
    assert.equal(urls[1], 'https://api-testnet.gateapi.io/api/v4/spot/time');
  });

  it('keeps an attempted POST UNKNOWN when the reconciliation GET is denied by budget', async () => {
    const budget = GateIoG3RunBudget.create({ ...GATEIO_G3_LIMITS, networkRequests: 1 });
    const methods: string[] = [];
    const client = createGateIoFuturesExecutionClient({ environment: 'testnet',
      credential: { apiKey: KEY, secretKey: SECRET }, signedTimestamp: () => SECOND,
      runBudget: budget, readFoundation: { async instrumentFacts() { throw new Error('unused'); } },
      fetchImpl: async (_url, init) => { methods.push(init.method ?? ''); throw new Error('ambiguous'); },
    });
    await assert.rejects(client.submitMarketOrder({ contract: 'ETH_USDT', size: 0.1,
      price: '0', tif: 'ioc', reduceOnly: false, text: 't-dsb-' + 'a'.repeat(22) }),
    (error: unknown) => error instanceof GateIoFuturesExecutionClientError
      && error.decision === null && error.reasonCode === 'NETWORK_REQUEST_CAP_EXCEEDED');
    assert.deepEqual(methods, ['POST']);
    assert.deepEqual(budget.snapshot(), { accountUsed: 0, instrumentUsed: 0,
      ambiguousUsed: 0, proofUsed: 1, cleanupUsed: 0, totalUsed: 1, networkUsed: 1 });
  });

  it('rejects the 37th network request before transport and keeps mutation limits separate', () => {
    const budget = GateIoG3RunBudget.create();
    for (let i = 0; i < 36; i++) budget.consumeReadRequest();
    assert.throws(() => budget.consumeReadRequest(), (error: unknown) =>
      error instanceof GateIoG3BudgetDenial && error.reasonCode === 'NETWORK_REQUEST_CAP_EXCEEDED');
    assert.deepEqual(budget.snapshot(), { accountUsed: 0, instrumentUsed: 0, ambiguousUsed: 0,
      proofUsed: 0, cleanupUsed: 0, totalUsed: 0, networkUsed: 36 });
    const separate = GateIoG3RunBudget.create();
    separate.consumeMutationRequest('PROOF', false);
    separate.consumeMutationRequest('PROOF', true);
    assert.throws(() => separate.consumeMutationRequest('PROOF', false),
      /MUTATION_PROOF_CAP_EXCEEDED/);
    separate.consumeMutationRequest('EMERGENCY_CLEANUP', true);
    assert.throws(() => separate.consumeMutationRequest('EMERGENCY_CLEANUP', true),
      /MUTATION_TOTAL_CAP_EXCEEDED/);
    assert.equal(separate.snapshot().networkUsed, 3);
    assert.deepEqual(GATEIO_G3_LIMITS, { accountAcquisitions: 5, instrumentAcquisitions: 2,
      ambiguousReconciliations: 2, proofMutations: 2, cleanupMutations: 1,
      totalMutations: 3, networkRequests: 36 });
  });

  it('keeps acquisition, reconciliation and cleanup cap denials structured with unchanged counts', () => {
    const budget = GateIoG3RunBudget.create();
    for (let i = 0; i < 5; i++) budget.beginAccountTruth();
    for (let i = 0; i < 2; i++) budget.beginInstrumentFacts();
    for (let i = 0; i < 2; i++) budget.beginAmbiguousReconciliation();
    const before = budget.snapshot();
    const denied = (fn: () => void, reason: string) => assert.throws(fn,
      (error: unknown) => error instanceof GateIoG3BudgetDenial
        && error.decision === 'DENIED' && error.reasonCode === reason);
    denied(() => budget.beginAccountTruth(), 'ACCOUNT_TRUTH_ACQUISITION_CAP_EXCEEDED');
    denied(() => budget.beginInstrumentFacts(), 'INSTRUMENT_FACTS_ACQUISITION_CAP_EXCEEDED');
    denied(() => budget.beginAmbiguousReconciliation(), 'AMBIGUOUS_RECONCILIATION_CAP_EXCEEDED');
    assert.deepEqual(budget.snapshot(), before);
    budget.consumeMutationRequest('EMERGENCY_CLEANUP', true);
    const afterCleanup = budget.snapshot();
    denied(() => budget.consumeMutationRequest('EMERGENCY_CLEANUP', true),
      'MUTATION_CLEANUP_CAP_EXCEEDED');
    assert.deepEqual(budget.snapshot(), afterCleanup);
  });

  for (const scenario of ['normal', 'ambiguous-open', 'ambiguous-close', 'cleanup', 'dual-opposed'] as const) {
    it(`records ${scenario} through the exact TestNet-only path`, async () => {
      const fake = fixture(scenario);
      const result = await fake.runner.run();
      assert.equal(fake.requests.some((entry) => entry.url.startsWith('https://api.gateio.ws')), false);
      assert.equal(fake.requests.every((entry) => entry.url.startsWith('https://api-testnet.gateapi.io')), true);
      assert.equal(result.budget.networkUsed, fake.requests.length);
      assert.equal(result.budget.networkUsed <= 36, true);
      assert.equal(result.budget.accountUsed, fake.accountAcquisitions);
      assert.equal(fake.runner.truthPort.captureSequence(), result.lastCaptureSequence);
      assert.equal(JSON.stringify(result).includes(KEY), false);
      assert.equal(JSON.stringify(result).includes(SECRET), false);
      if (scenario === 'dual-opposed') {
        assert.equal(result.status, 'STOP');
        assert.equal(fake.postCount, 0);
        return;
      }
      assert.equal(result.status, scenario === 'cleanup' ? 'STOP' : 'PASS', result.reasonCode);
      assert.equal(result.reasonCode, scenario === 'cleanup'
        ? 'FAIL_CLEANED_UP' : 'G3_FACTUAL_FLAT');
      assert.equal(result.finalExposure, 'FACTUAL_FLAT');
      assert.equal(fake.position, 0);
      assert.equal(result.budget.proofUsed, 2);
      assert.equal(result.budget.cleanupUsed, scenario === 'cleanup' ? 1 : 0);
      assert.equal(fake.postCount, scenario === 'cleanup' ? 3 : 2);
      assert.equal(result.budget.accountUsed, scenario === 'cleanup' ? 5 : 4);
      assert.equal(result.budget.instrumentUsed, 2);
      assert.equal(result.budget.networkUsed <= (scenario === 'cleanup' ? 36
        : scenario.startsWith('ambiguous') ? 30 : 28), true);
      const firstPost = fake.requests.findIndex((entry) => entry.method === 'POST');
      const nextAccountRead = fake.requests.findIndex((entry, index) => index > firstPost
        && new URL(entry.url).pathname === GATEIO_READ_ENDPOINTS.ACCOUNTS);
      assert.equal(firstPost >= 0 && nextAccountRead > firstPost, true);
      if (scenario.startsWith('ambiguous')) {
        const post = fake.requests.findIndex((entry) => entry.method === 'POST');
        assert.equal(fake.requests.slice(post + 1).some((entry) => entry.method === 'GET'), true);
        assert.equal(result.budget.ambiguousUsed, 1);
      }
    });
  }

  it('cleans factual exposure when a matching order ID has a different fill quantity', async () => {
    const fake = fixture('trade-mismatch');
    const result = await fake.runner.run();
    assert.equal(result.status, 'STOP');
    assert.equal(result.reasonCode, 'FAIL_CLEANED_UP');
    assert.equal(result.failureOrigin, 'OPEN_QUANTITY_MISMATCH');
    assert.equal(result.budget.cleanupUsed, 1);
    assert.equal(fake.postCount, 2);
    assert.equal(fake.position, 0);
  });
});

describe('Gate G3A-R2 post-mutation failure closure (offline)', () => {
  const cases: readonly {
    scenario: Scenario; result: string; posts: number; position: number;
    exposure: 'FACTUAL_FLAT' | 'FACTUAL_NON_FLAT' | 'EXPOSURE_UNKNOWN';
    cleanup: number;
  }[] = [
    { scenario: 'normal', result: 'G3_FACTUAL_FLAT', posts: 2, position: 0,
      exposure: 'FACTUAL_FLAT', cleanup: 0 },
    { scenario: 'trade-mismatch', result: 'FAIL_CLEANED_UP', posts: 2, position: 0,
      exposure: 'FACTUAL_FLAT', cleanup: 1 },
    { scenario: 'trade-mismatch-flat', result: 'FAIL_OPEN_QUANTITY_MISMATCH_FLAT',
      posts: 1, position: 0, exposure: 'FACTUAL_FLAT', cleanup: 0 },
    { scenario: 'trade-mismatch-unknown', result: 'FAIL_EXPOSURE_UNKNOWN',
      posts: 1, position: 0.1, exposure: 'EXPOSURE_UNKNOWN', cleanup: 0 },
    { scenario: 'kernel-fill-missing', result: 'FAIL_CLEANED_UP',
      posts: 2, position: 0, exposure: 'FACTUAL_FLAT', cleanup: 1 },
    { scenario: 'preclose-mismatch', result: 'FAIL_CLEANED_UP',
      posts: 2, position: 0, exposure: 'FACTUAL_FLAT', cleanup: 1 },
    { scenario: 'close-unknown-flat', result: 'FAIL_CLOSE_NOT_FACTUALLY_CONFIRMED_FLAT',
      posts: 2, position: 0, exposure: 'FACTUAL_FLAT', cleanup: 0 },
    { scenario: 'close-unknown-open', result: 'FAIL_CLEANED_UP',
      posts: 3, position: 0, exposure: 'FACTUAL_FLAT', cleanup: 1 },
    { scenario: 'cleanup-nonflat', result: 'FAIL_POSITION_REMAINS_OPEN',
      posts: 3, position: 0.1, exposure: 'FACTUAL_NON_FLAT', cleanup: 1 },
    { scenario: 'cleanup-truth-unknown', result: 'FAIL_POST_CLEANUP_TRUTH_UNKNOWN',
      posts: 3, position: 0, exposure: 'EXPOSURE_UNKNOWN', cleanup: 1 },
    { scenario: 'close-risk-rejected', result: 'FAIL_CLEANED_UP',
      posts: 2, position: 0, exposure: 'FACTUAL_FLAT', cleanup: 1 },
    { scenario: 'preclose-provider-throw', result: 'FAIL_CLEANED_UP',
      posts: 2, position: 0, exposure: 'FACTUAL_FLAT', cleanup: 1 },
    { scenario: 'dual-after-open', result: 'FAIL_EXPOSURE_UNKNOWN',
      posts: 1, position: 0.1, exposure: 'EXPOSURE_UNKNOWN', cleanup: 0 },
    { scenario: 'close-fill-mismatch-open', result: 'FAIL_CLEANED_UP',
      posts: 3, position: 0, exposure: 'FACTUAL_FLAT', cleanup: 1 },
    { scenario: 'open-unknown-open', result: 'FAIL_CLEANED_UP',
      posts: 2, position: 0, exposure: 'FACTUAL_FLAT', cleanup: 1 },
  ];

  for (const testCase of cases) {
    it('classifies ' + testCase.scenario + ' only after factual exchange truth', async () => {
      const fake = fixture(testCase.scenario);
      const result = await fake.runner.run();
      assert.equal(result.reasonCode, testCase.result);
      assert.equal(result.status, testCase.scenario === 'normal' ? 'PASS' : 'STOP');
      assert.equal(result.finalExposure, testCase.exposure);
      assert.equal(result.budget.cleanupUsed, testCase.cleanup);
      assert.equal(fake.postCount, testCase.posts);
      assert.equal(fake.position, testCase.position);
      assert.equal(result.budget.networkUsed, fake.requests.length);
      assert.equal(result.budget.networkUsed <= 36, true);
      assert.equal(result.budget.totalUsed <= 3, true);
      assert.equal(fake.requests.every((request) =>
        request.url.startsWith('https://api-testnet.gateapi.io/')), true);
      assert.equal(JSON.stringify(result).includes(KEY), false);
      assert.equal(JSON.stringify(result).includes(SECRET), false);
      assert.equal(JSON.stringify(result).includes('FIXTURE_RAW_RESPONSE'), false);
      const lastPost = fake.requests.findLastIndex((request) => request.method === 'POST');
      const laterAccountRead = fake.requests.findIndex((request, index) => index > lastPost
        && new URL(request.url).pathname === GATEIO_READ_ENDPOINTS.ACCOUNTS);
      assert.equal(laterAccountRead > lastPost, true);
      if (testCase.cleanup === 1) {
        const post = fake.requests.filter((request) => request.method === 'POST');
        assert.equal(post.length, testCase.posts);
        assert.equal(result.status, 'STOP');
        const cleanup = post.at(-1)!.body!;
        assert.equal(cleanup.contract, 'ETH_USDT');
        assert.equal(cleanup.price, '0');
        assert.equal(cleanup.tif, 'ioc');
        assert.equal(cleanup.reduce_only, true);
        assert.equal(cleanup.size, testCase.scenario === 'preclose-mismatch' ? -0.2 : -0.1);
        assert.equal(new Set(post.map((request) => request.body!.text)).size, post.length);
      }
      if (testCase.scenario === 'trade-mismatch-unknown')
        assert.ok(result.truthFailureReason);
      if (testCase.scenario === 'kernel-fill-missing') {
        assert.equal(result.failureOrigin, 'OPEN_FILL_UNCONFIRMED');
        const fills = fake.journal.readFromLogicalSequence(1)
          .filter((event) => event.type === 'execution.fill.confirmed');
        assert.equal(fills.length, 1);
      }
      if (testCase.scenario === 'close-unknown-flat'
          || testCase.scenario === 'close-unknown-open')
        assert.equal(result.budget.ambiguousUsed, 1);
    });
  }

  it('denies cleanup when the same run budget has already used its sole cleanup slot', async () => {
    const fake = fixture('cleanup');
    fake.runner.sharedBudget.consumeMutationRequest('EMERGENCY_CLEANUP', true);
    const result = await fake.runner.run();
    assert.equal(result.reasonCode, 'FAIL_CLEANUP_BUDGET_EXHAUSTED');
    assert.equal(result.finalExposure, 'FACTUAL_NON_FLAT');
    assert.equal(fake.postCount, 2);
    assert.equal(fake.position, 0.1);
    assert.equal(result.budget.cleanupUsed, 1);
    assert.equal(result.budget.totalUsed, 3);
  });

  it('fails exposure UNKNOWN when a post-mutation account acquisition is denied by budget', async () => {
    const fake = fixture('normal');
    for (let index = 0; index < 4; index++) fake.runner.sharedBudget.beginAccountTruth();
    const result = await fake.runner.run();
    assert.equal(result.reasonCode, 'FAIL_EXPOSURE_UNKNOWN');
    assert.equal(result.finalExposure, 'EXPOSURE_UNKNOWN');
    assert.equal(result.truthFailureReason, 'ACCOUNT_TRUTH_ACQUISITION_CAP_EXCEEDED');
    assert.equal(result.budget.accountUsed, 5);
    assert.equal(result.budget.proofUsed, 1);
    assert.equal(result.budget.cleanupUsed, 0);
    assert.equal(fake.postCount, 1);
    assert.equal(fake.position, 0.1);
  });

  it('cannot turn a run with a used cleanup slot into a normal PASS', async () => {
    const fake = fixture('normal');
    fake.runner.sharedBudget.consumeMutationRequest('EMERGENCY_CLEANUP', true);
    const result = await fake.runner.run();
    assert.equal(result.status, 'STOP');
    assert.equal(result.reasonCode, 'FAIL_CLOSE_NOT_FACTUALLY_CONFIRMED_FLAT');
    assert.equal(result.finalExposure, 'FACTUAL_FLAT');
    assert.equal(result.budget.cleanupUsed, 1);
  });

  it('structurally routes all run returns after first proof submission through finalization or PASS', () => {
    const source = readFileSync(resolve('src/runtime/gateio/GateIoTestnetOmsE2ERunner.ts'), 'utf8');
    const file = ts.createSourceFile('GateIoTestnetOmsE2ERunner.ts', source,
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const openAnchor = source.indexOf("const open = await submit('open'");
    assert.ok(openAnchor > 0);
    let runMethod: ts.MethodDeclaration | null = null;
    const find = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'run')
        runMethod = node;
      ts.forEachChild(node, find);
    };
    find(file);
    assert.ok(runMethod);
    const returns: ts.ReturnStatement[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.getStart(file) > openAnchor) returns.push(node);
      ts.forEachChild(node, collect);
    };
    collect((runMethod as ts.MethodDeclaration).body!);
    assert.ok(returns.length >= 9);
    for (const statement of returns) {
      const expression = statement.expression;
      assert.ok(expression);
      const call = ts.isAwaitExpression(expression) ? expression.expression : expression;
      assert.ok(ts.isCallExpression(call), statement.getText(file));
      const callee = call.expression.getText(file);
      assert.ok(callee === 'finalizeFailedRun'
        || (callee === 'receipt' && call.arguments[0]?.getText(file) === "'PASS'"),
      statement.getText(file));
    }
  });
});
