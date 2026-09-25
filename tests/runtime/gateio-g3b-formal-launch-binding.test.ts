/** G3B uses recording fetch only. No secret file, real credential or Gate network is read. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createInMemoryEventJournal } from '../../src/kernel/InMemoryEventJournal';
import { GATEIO_READ_ENDPOINTS } from '../../src/runtime/gateio/GateIoReadContracts';
import { createGateIoTestnetOmsE2ELaunchBinding,
  gateIoG3FactualHardRisk, gateIoG3FactualMarketSnapshot } from '../../src/runtime/gateio/GateIoTestnetOmsE2ELaunchBinding';
import type { GateIoG3FactualRiskInput } from '../../src/runtime/gateio/GateIoTestnetOmsE2ERunner';

const NOW = 1_800_000_000_000;
const SECOND = '1800000000';
const HEAD = 'a'.repeat(40);
const KEY = 'FIXTURE_G3B_KEY_DO_NOT_LEAK';
const SECRET = 'FIXTURE_G3B_SECRET_DO_NOT_LEAK';

interface FixtureOptions {
  readonly mark?: number;
  readonly multiplier?: number;
  readonly minSize?: number;
  readonly decimal?: boolean;
  readonly capital?: number;
  readonly unknownAccount?: boolean;
  readonly missingMarketField?: boolean;
  readonly malformedInstrument?: boolean;
}

function fixture(overrides: FixtureOptions = {}) {
  const mark = overrides.mark ?? 2000;
  const multiplier = overrides.multiplier ?? 0.001;
  const minSize = overrides.minSize ?? 0.1;
  const decimal = overrides.decimal ?? true;
  const capital = overrides.capital ?? 1000;
  const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const orders = new Map<string, Record<string, unknown>>();
  const trades: Record<string, unknown>[] = [];
  let position = 0;
  let postCount = 0;
  const response = (value: unknown) => new Response(JSON.stringify(value));
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).origin, 'https://api-testnet.gateapi.io');
    const body = init.method === 'POST' ? JSON.parse(init.body as string) as Record<string, unknown> : null;
    requests.push({ url, method: init.method ?? 'GET', body });
    const path = new URL(url).pathname;
    if (path === GATEIO_READ_ENDPOINTS.SERVER_TIME) return response({ server_time: NOW });
    if (path === GATEIO_READ_ENDPOINTS.ACCOUNTS) return response(overrides.unknownAccount
      ? { currency: 'UNKNOWN' }
      : { currency: 'USDT', total: String(capital), available: String(capital),
        in_dual_mode: false, position_mode: 'single', margin_mode: 0 });
    if (path === GATEIO_READ_ENDPOINTS.POSITIONS) return response([{
      contract: 'ETH_USDT', mode: 'single', size: String(position),
      value: String(position * mark * multiplier),
      pos_margin_mode: 'cross', leverage: '10',
      entry_price: position === 0 ? null : String(mark),
      mark_price: position === 0 ? null : String(mark),
      update_time: SECOND,
    }]);
    if (path === GATEIO_READ_ENDPOINTS.OPEN_ORDERS && init.method === 'GET') return response([]);
    if (path === GATEIO_READ_ENDPOINTS.MY_TRADES) return response(trades);
    if (path === GATEIO_READ_ENDPOINTS.CONTRACT) return response({
      name: 'ETH_USDT', status: 'trading', in_delisting: false,
      quanto_multiplier: String(multiplier), order_size_min: String(minSize),
      order_size_max: '10000', enable_decimal: decimal,
      order_price_round: '0.01', mark_price_round: '0.01',
      leverage_min: '1', leverage_max: '100',
      maker_fee_rate: '0', taker_fee_rate: '0',
    });
    if (path === GATEIO_READ_ENDPOINTS.TICKERS) return response([{
      contract: 'ETH_USDT', last: String(mark),
      mark_price: overrides.malformedInstrument ? 'malformed' : String(mark),
      index_price: String(mark), funding_rate: '0',
      ...(overrides.missingMarketField ? {} : { highest_bid: String(mark - 1) }),
      lowest_ask: String(mark + 1), volume_24h: '1',
      high_24h: String(mark + 100), low_24h: String(mark - 100),
    }]);
    if (init.method === 'GET' && path.startsWith('/api/v4/futures/usdt/orders/')) {
      const text = path.split('/').at(-1)!;
      assert.ok(orders.has(text));
      return response(orders.get(text));
    }
    assert.equal(path, '/api/v4/futures/usdt/orders');
    assert.equal(init.method, 'POST');
    postCount += 1;
    assert.ok(body);
    const id = String(1000 + postCount);
    const order = { id, text: body.text, contract: 'ETH_USDT', size: body.size,
      left: 0, status: 'finished', finish_as: 'filled',
      fill_price: String(mark), finish_time: Number(SECOND) };
    orders.set(body.text as string, order);
    position = Math.round((position + Number(body.size)) * 10) / 10;
    trades.push({ id: String(2000 + postCount), order_id: id, contract: 'ETH_USDT',
      size: String(body.size), close_size: '0', price: String(mark),
      text: body.text, fee: '0', point_fee: '0', role: 'taker',
      trade_value: String(Math.abs(Number(body.size)) * mark * multiplier),
      create_time: SECOND });
    return response(order);
  };
  const binding = createGateIoTestnetOmsE2ELaunchBinding({
    credential: { apiKey: KEY, secretKey: SECRET }, accountId: 'fixture-account',
    fetchImpl, now: () => NOW, journal: createInMemoryEventJournal(),
    expectedExactHead: HEAD, actualExactHead: () => HEAD, worktreeClean: () => true,
  });
  return { binding, requests, get position() { return position; },
    get postCount() { return postCount; } };
}

describe('Gate G3B formal TestNet launch binding (offline)', () => {
  for (const variant of [
    { mark: 2000, multiplier: 0.001, minSize: 0.1, decimal: true },
    { mark: 2400, multiplier: 0.002, minSize: 0.1, decimal: true },
    { mark: 2000, multiplier: 0.001, minSize: 1, decimal: false },
  ] as const) {
    it('runs the formal OMS path using only changed factual minimum contract rules', async () => {
      const fake = fixture(variant);
      const result = await fake.binding.run();
      assert.equal(result.exactHead, HEAD);
      assert.equal(result.receipt.status, 'PASS', JSON.stringify(result.receipt));
      assert.equal(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
      assert.equal(result.proofPolicySource, 'G3_TESTNET_PROOF_POLICY');
      assert.equal(result.sharedBudgetIdentityVerified, true);
      assert.equal(result.marketFacts?.markPrice, variant.mark);
      assert.equal(result.marketFacts?.contractMultiplier, variant.multiplier);
      assert.equal(result.marketFacts?.minOrderSize, variant.minSize);
      assert.equal(result.marketFacts?.decimalSizeEnabled, variant.decimal);
      assert.equal(result.usableCapitalUsd, 1000);
      assert.equal(result.receipt.budget.networkUsed, fake.requests.length);
      assert.equal(result.receipt.budget.proofUsed, 2);
      assert.equal(result.receipt.budget.cleanupUsed, 0);
      assert.equal(fake.postCount, 2);
      assert.equal(fake.position, 0);
      const posts = fake.requests.filter((request) => request.method === 'POST');
      assert.equal(posts[0]!.body!.size, variant.minSize);
      assert.equal(posts[0]!.body!.reduce_only, false);
      assert.equal(posts[1]!.body!.size, -variant.minSize);
      assert.equal(posts[1]!.body!.reduce_only, true);
      assert.equal(posts.every((request) => request.body!.contract === 'ETH_USDT'
        && request.body!.price === '0' && request.body!.tif === 'ioc'), true);
      assert.equal(fake.requests.every((request) =>
        new URL(request.url).origin === 'https://api-testnet.gateapi.io'), true);
      const serialized = JSON.stringify(result);
      for (const forbidden of [KEY, SECRET, 'SIGN', 'KEY:', 'FIXTURE_RAW'])
        assert.equal(serialized.includes(forbidden), false);
    });
  }

  it('stops before mutation when factual available capital cannot cover minimum notional', async () => {
    const fake = fixture({ capital: 0.1 });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP');
    assert.equal(result.receipt.reasonCode, 'GATEIO_G3_CAPITAL_INSUFFICIENT');
    assert.equal(fake.postCount, 0);
    assert.equal(result.receipt.budget.proofUsed, 0);
  });

  it('stops before mutation when account truth is unknown', async () => {
    const fake = fixture({ unknownAccount: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP');
    assert.equal(fake.postCount, 0);
    assert.equal(result.receipt.budget.proofUsed, 0);
  });

  it('stops before mutation when factual market fields are missing', async () => {
    const fake = fixture({ missingMarketField: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP');
    assert.equal(result.receipt.reasonCode, 'GATEIO_G3_MARKET_FACTS_UNAVAILABLE');
    assert.equal(fake.postCount, 0);
  });

  it('stops before mutation when instrument facts are malformed', async () => {
    const fake = fixture({ malformedInstrument: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP');
    assert.equal(fake.postCount, 0);
    assert.equal(result.receipt.budget.proofUsed, 0);
  });

  it('rejects stale observation and unfunded capital without inventing zero or market fields', async () => {
    const fake = fixture();
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'PASS');
    const instrument = {
      contract: 'ETH_USDT', contractOpenable: true, inDelisting: false,
      freshness: 'FRESH', markPrice: 2000, lastPrice: 1998, contractMultiplier: 0.001,
      minOrderSize: 0.1, maxOrderSize: 10000, bestBid: 1999, bestAsk: 2001,
      volume24h: 1, high24h: 2100, low24h: 1900,
      observedAtMs: NOW - 30_001, serverTimeMs: NOW,
    };
    const input = {
      account: { identity: { exchange: 'gateio', accountId: 'fixture-account', settle: 'USDT' },
        freshness: 'FRESH', observedAtMs: NOW, account: { available: 0, total: 0 } },
      instrument, nowMs: NOW,
    } as GateIoG3FactualRiskInput;
    assert.throws(() => gateIoG3FactualMarketSnapshot(input), /GATEIO_G3_MARKET_FACTS_UNAVAILABLE/);
    const freshInput = { ...input, instrument: { ...instrument, observedAtMs: NOW } } as GateIoG3FactualRiskInput;
    assert.equal(gateIoG3FactualMarketSnapshot(freshInput).ticker?.ticker.last, 1998);
    assert.throws(() => gateIoG3FactualHardRisk({ ...input,
      instrument: { ...instrument, observedAtMs: NOW } } as GateIoG3FactualRiskInput,
    'fixture-account'), /GATEIO_G3_ACCOUNT_FACTS_UNAVAILABLE/);
  });

  it('denies wrong exact head and dirty worktree before any network request', async () => {
    for (const [actualHead, clean] of [['b'.repeat(40), true], [HEAD, false]] as const) {
      let requests = 0;
      const binding = createGateIoTestnetOmsE2ELaunchBinding({
        credential: { apiKey: KEY, secretKey: SECRET }, accountId: 'fixture-account',
        fetchImpl: async () => { requests += 1; throw new Error('unreachable'); },
        now: () => NOW, journal: createInMemoryEventJournal(),
        expectedExactHead: HEAD, actualExactHead: () => actualHead,
        worktreeClean: () => clean,
      });
      await assert.rejects(binding.run(), /GATEIO_G3_EXACT_HEAD_PREFLIGHT_FAILED/);
      assert.equal(requests, 0);
      assert.equal(binding.sharedBudget.snapshot().networkUsed, 0);
    }
  });

  it('rejects missing launch dependencies without network and contains no secret discovery', () => {
    assert.throws(() => createGateIoTestnetOmsE2ELaunchBinding({
      credential: { apiKey: '', secretKey: '' }, accountId: 'fixture-account',
      fetchImpl: async () => { throw new Error('unreachable'); }, now: () => NOW,
      journal: createInMemoryEventJournal(), expectedExactHead: HEAD,
      actualExactHead: () => HEAD, worktreeClean: () => true,
    }), /GATEIO_G3_LAUNCH_CONFIGURATION_INVALID/);
    const sources = [
      'GateIoAuthenticatedReadFoundation.ts', 'GateIoFuturesExecutionClient.ts',
      'GateIoTestnetOmsE2ERunner.ts', 'GateIoTestnetOmsE2ELaunchBinding.ts',
    ].map((name) => readFileSync(resolve('src/runtime/gateio', name), 'utf8').toLowerCase());
    for (const source of sources) {
      for (const forbidden of ['process.env', 'dotenv', 'readfilesync', 'gateio-trader',
        'gateio-testnet-order-e2e.mts']) assert.equal(source.includes(forbidden), false);
    }
  });
});
