/** All Gate G3A-R1 evidence uses recording transports and fixture credentials only. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
  | 'dual-opposed' | 'dual-zero' | 'dual-missing' | 'dual-malformed' | 'trade-mismatch';

function orderObject(body: Record<string, unknown>, id: string) {
  return { id, text: body.text, contract: body.contract, size: body.size, left: 0,
    status: 'finished', finish_as: 'filled', fill_price: '2000', finish_time: Number(SECOND) };
}

function fixture(scenario: Scenario) {
  const requests: { url: string; method: string }[] = [];
  const orders = new Map<string, Record<string, unknown>>();
  const trades: Record<string, unknown>[] = [];
  let position = scenario === 'dual-opposed' ? 1 : 0;
  const dual = scenario.startsWith('dual-');
  let postCount = 0;
  let accountAcquisitions = 0;
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const readFetch = async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method ?? 'GET' });
    assert.equal(url.startsWith('https://api-testnet.gateapi.io/'), true);
    const path = new URL(url).pathname;
    if (path === GATEIO_READ_ENDPOINTS.SERVER_TIME) return response({ server_time: NOW });
    if (path === GATEIO_READ_ENDPOINTS.ACCOUNTS) {
      accountAcquisitions += 1;
      return response({ currency: 'USDT', total: '1000', available: '900',
        in_dual_mode: dual, position_mode: dual ? 'dual' : 'single',
        margin_mode: 0 });
    }
    if (path === GATEIO_READ_ENDPOINTS.POSITIONS) {
      const base = { contract: 'ETH_USDT', pos_margin_mode: 'cross', leverage: '10',
        liq_price: null, unrealised_pnl: null, realised_pnl: null, margin: null,
        update_time: SECOND };
      if (dual) {
        const long = { ...base, mode: 'dual_long', size: scenario === 'dual-opposed' ? '1' : '0',
          value: scenario === 'dual-opposed' ? '2' : '0',
          entry_price: scenario === 'dual-opposed' ? '2000' : null,
          mark_price: scenario === 'dual-opposed' ? '2000' : null };
        const short = { ...base, mode: 'dual_short',
          size: scenario === 'dual-opposed' ? '-1' : scenario === 'dual-malformed' ? 'bad' : '0',
          value: scenario === 'dual-opposed' ? '-2' : '0',
          entry_price: scenario === 'dual-opposed' ? '2000' : null,
          mark_price: scenario === 'dual-opposed' ? '2000' : null };
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
    requests.push({ url, method: init.method ?? 'GET' });
    assert.equal(url.startsWith('https://api-testnet.gateapi.io/'), true);
    if (init.method === 'GET') {
      const text = new URL(url).pathname.split('/').at(-1)!;
      assert.ok(orders.has(text));
      return response(orders.get(text));
    }
    assert.equal(init.method, 'POST');
    postCount += 1;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    if (scenario === 'cleanup' && postCount === 2) {
      return response({ label: 'ORDER_REJECTED' }, 400);
    }
    const id = String(1000 + postCount);
    const normalized = orderObject(body, id);
    orders.set(body.text as string, normalized);
    position = Math.round((position + Number(body.size)) * 10) / 10;
    trades.push({ id: String(2000 + postCount), order_id: id, contract: 'ETH_USDT',
      size: scenario === 'trade-mismatch' && postCount === 1 ? '0.05' : String(body.size),
      close_size: '0', price: '2000', text: body.text,
      fee: '0', point_fee: '0', role: 'taker',
      trade_value: String(Math.abs(Number(body.size)) * 2), create_time: SECOND });
    if ((scenario === 'ambiguous-open' && postCount === 1)
        || (scenario === 'ambiguous-close' && postCount === 2)) {
      throw new Error('FIXTURE_RAW_RESPONSE_DO_NOT_LEAK');
    }
    return response(normalized);
  };
  const runner = createGateIoTestnetOmsE2ERunner({
    environment: 'testnet', accountId: 'fixture-account',
    credential: { apiKey: KEY, secretKey: SECRET }, readFetch, executionFetch,
    signedTimestamp: () => SECOND, now: () => NOW,
    journal: createInMemoryEventJournal(),
    marketSnapshot: () => ({ exchange: 'gateio', symbol: 'ETH/USDT',
      ticker: { receivedAt: NOW, ticker: { channel: 'ticker', exchange: 'gateio',
        instId: 'ETH/USDT', last: 2000, bestBid: 1999, bestAsk: 2001,
        volume24h: 1, high24h: 2100, low24h: 1900, ts: NOW } },
      klines: {}, snapshotVersion: 1, generatedAt: NOW, lastUpdatedAt: NOW,
      ageMs: 0, isStale: false }),
    policyResolution: () => ({ status: 'active', policy: null,
      allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'neutral',
      riskLevel: 'low', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] }),
    hardRisk: () => ({ accountId: 'fixture-account', exchange: 'gateio',
      locked: false, enabled: true, totalCapitalUsd: 1000,
      maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1000 }),
  });
  return { runner, requests, readFetch, get position() { return position; },
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
    assert.equal(receipt.status, 'PASS', receipt.reasonCode);
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
      assert.equal(result.status, 'PASS', result.reasonCode);
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

  it('stops when a matching exchange order ID has a different factual fill quantity', async () => {
    const fake = fixture('trade-mismatch');
    const result = await fake.runner.run();
    assert.equal(result.status, 'STOP');
    assert.equal(result.reasonCode, 'OPEN_NOT_FACTUALLY_CONFIRMED');
    assert.equal(fake.postCount, 1);
    assert.equal(fake.position, 0.1);
  });
});
