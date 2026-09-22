/**
 * Bitget L1A real authenticated-read execution prep.
 *
 * Offline only: every run in this file is driven by an injected fixture fetch (or, for the production
 * code-path test, a fixture installed as the ambient `globalThis.fetch`). No real credential is read,
 * no api.bitget.com request is made, and no mutation authority exists.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BITGET_REAL_READ_AUTHORIZATION_REQUIRED,
  BITGET_REAL_READ_MODES,
  BITGET_REAL_READ_SCHEMA_VERSION,
  MAX_BITGET_REAL_READ_GETS,
  bitgetRealReadBudgetCheck,
  createBitgetRealReadRunner,
  deriveBitgetRealReadMode,
} from '../../src/runtime/bitget/BitgetRealReadExecutionRunner';
import {
  hasProductionBitgetReadTransportProvenance,
  createBitgetReadTransport,
  createProductionBitgetReadTransport,
} from '../../src/runtime/bitget/BitgetReadTransport';
import { BITGET_READ_ENDPOINTS, BITGET_L0_PRODUCTION_ORIGIN } from '../../src/runtime/bitget/BitgetReadContracts';

const FIXTURE_BITGET_API_KEY = 'FIXTURE_BITGET_API_KEY';
const FIXTURE_BITGET_SECRET = 'FIXTURE_BITGET_SECRET';
const FIXTURE_BITGET_PASSPHRASE = 'FIXTURE_BITGET_PASSPHRASE';
const FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK = 'FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK';
const BASE_MS = 1_799_000_000_000;

const credential = Object.freeze({
  apiKey: FIXTURE_BITGET_API_KEY,
  secretKey: FIXTURE_BITGET_SECRET,
  passphrase: FIXTURE_BITGET_PASSPHRASE,
});
const identity = Object.freeze({ exchange: 'bitget' as const, accountId: 'acct-1' });

interface Fixtures {
  readonly serverTime?: unknown;
  readonly accounts?: unknown;
  readonly positions?: unknown;
  readonly pendingOrders?: unknown;
  readonly fills?: unknown;
  readonly contracts?: unknown;
  readonly symbolPrice?: unknown;
  readonly networkFailure?: boolean;
  readonly reject?: readonly string[];
}

function fixtureFetch(fixtures: Fixtures = {}) {
  const captured: { url: string; headers?: Record<string, string> }[] = [];
  const data: Record<string, unknown> = {
    [BITGET_READ_ENDPOINTS.SERVER_TIME]: fixtures.serverTime ?? { serverTime: String(BASE_MS) },
    [BITGET_READ_ENDPOINTS.ACCOUNTS]: fixtures.accounts ?? [{
      marginCoin: 'USDT', accountEquity: '1000.5', available: '900.25', locked: '10.5', unrealizedPL: '0',
    }],
    [BITGET_READ_ENDPOINTS.POSITIONS]: fixtures.positions ?? [{
      symbol: 'ETHUSDT', holdSide: 'long', total: '1.5', openPriceAvg: '2000', markPrice: '2010.5',
      unrealizedPL: '15.75', leverage: '10', marginMode: 'crossed', posMode: 'hedge_mode',
      liquidationPrice: '1800', uTime: String(BASE_MS),
    }],
    [BITGET_READ_ENDPOINTS.PENDING_ORDERS]: fixtures.pendingOrders ?? [{
      orderId: '9001', clientOid: 'cli-1', symbol: 'ETHUSDT', side: 'buy', posSide: 'long',
      orderType: 'limit', status: 'live', price: '1950', size: '0.5', baseVolume: '0',
      reduceOnly: false, marginMode: 'crossed', leverage: '10',
      cTime: String(BASE_MS), uTime: String(BASE_MS),
    }],
    [BITGET_READ_ENDPOINTS.FILLS]: fixtures.fills ?? [{
      tradeId: '7001', orderId: '7000', symbol: 'ETHUSDT', side: 'buy', tradeSide: 'open',
      price: '1999.5', baseVolume: '0.25', quoteVolume: '499.875', posMode: 'hedge_mode',
      profit: '0', cTime: String(BASE_MS),
      feeDetail: [{ feeCoin: 'USDT', totalFee: '0.2', totalDeductionFee: '0', deduction: false }],
    }],
    [BITGET_READ_ENDPOINTS.CONTRACTS]: fixtures.contracts ?? [{
      symbol: 'ETHUSDT', symbolStatus: 'normal', minTradeNum: '0.001', minTradeUSDT: '5',
      pricePlace: '2', priceEndStep: '1', volumePlace: '3', sizeMultiplier: '0.01',
      minLever: '1', maxLever: '125',
    }],
    [BITGET_READ_ENDPOINTS.SYMBOL_PRICE]: fixtures.symbolPrice ?? [{
      symbol: 'ETHUSDT', price: '2009.5', indexPrice: '2008.75', markPrice: '2010.5', ts: String(BASE_MS),
    }],
  };
  const reject = new Set<string>(fixtures.reject ?? []);
  const fetchImpl = async (input: string, init: RequestInit) => {
    captured.push({ url: input, headers: (init.headers ?? undefined) as Record<string, string> | undefined });
    if (fixtures.networkFailure === true) throw new Error(FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK);
    const path = input.replace(BITGET_L0_PRODUCTION_ORIGIN, '').split('?')[0] ?? '';
    const body = reject.has(path)
      ? { code: '40012', msg: FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK, requestTime: 1, data: null }
      : { code: '00000', msg: 'success', requestTime: 1, data: data[path] ?? null };
    return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
  };
  return { fetchImpl, captured };
}

const run = (fixtures: Fixtures = {}, opts: Record<string, unknown> = {}) => {
  const fake = fixtureFetch(fixtures);
  const runner = createBitgetRealReadRunner({
    credential,
    identity,
    now: () => BASE_MS,
    runId: 'bitget-l1a-real-read-prep',
    fetchImpl: fake.fetchImpl as never,
    ...opts,
  });
  return { runner, captured: fake.captured, receipt: () => runner.run() };
};

const serialize = (value: unknown) => JSON.stringify(value ?? null);

function assertNoLeak(value: unknown): void {
  const text = serialize(value);
  for (const forbidden of [
    FIXTURE_BITGET_API_KEY, FIXTURE_BITGET_SECRET, FIXTURE_BITGET_PASSPHRASE,
    FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK, 'ACCESS-SIGN', 'ACCESS-PASSPHRASE', 'ACCESS-KEY',
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked: ${forbidden}`);
  }
}

describe('Bitget L1A real read execution prep', () => {
  it('1. construction performs no I/O on the production code path', () => {
    const runner = createBitgetRealReadRunner({ credential, identity, now: () => BASE_MS, runId: 'no-io' });
    assert.equal(runner.productionTransportProvenance(), true);
    assert.equal(runner.requestCount(), 0, 'building a runner must not perform a request');
  });

  it('2. an injected or lookalike transport can never obtain production provenance', () => {
    const fake = fixtureFetch({});
    const injected = createBitgetReadTransport(fake.fetchImpl as never);
    assert.equal(hasProductionBitgetReadTransportProvenance(injected), false);
    const lookalike = { get: injected.get, production: true, provenance: 'production' };
    assert.equal(hasProductionBitgetReadTransportProvenance(lookalike), false);
    assert.equal(hasProductionBitgetReadTransportProvenance(createProductionBitgetReadTransport()), true);
    const runner = createBitgetRealReadRunner({
      credential, identity, now: () => BASE_MS, runId: 'fake', fetchImpl: fake.fetchImpl as never,
    });
    assert.equal(runner.productionTransportProvenance(), false);
  });

  it('3. a simulated run is labelled OFFLINE_SIMULATION and stays within the GET budget', async () => {
    const { receipt } = run();
    const value = await receipt();
    assert.equal(value.SCHEMA_VERSION, BITGET_REAL_READ_SCHEMA_VERSION);
    assert.equal(value.MODE, BITGET_REAL_READ_MODES.OFFLINE_SIMULATION);
    assert.equal(value.MODE_IS_EVIDENCE_DERIVED, true);
    assert.equal(value.MODE_STRING_PROVES_NETWORK, false);
    assert.equal(value.PRODUCTION_TRANSPORT_PROVENANCE, false);
    assert.equal(value.ACCOUNT_TRUTH_AVAILABLE, true);
    assert.equal(value.INSTRUMENT_FACTS_AVAILABLE, true);
    assert.equal(value.ACCOUNT_STATE, 'OPEN');
    assert.equal(value.POSITION_COUNT, 1);
    assert.equal(value.OPEN_ORDER_COUNT, 1);
    assert.equal(value.RECENT_FILL_COUNT, 1);
    assert.equal(value.SYMBOL, 'ETHUSDT');
    assert.equal(value.PRODUCT_TYPE, 'USDT-FUTURES');
    assert.equal(value.MARGIN_COIN, 'USDT');
    assert.equal(value.SERVER_TIME_PREFLIGHT_PERFORMED, true);
    assert.equal(value.SERVER_TIME_OBSERVED, true);
    assert.equal(value.SERVER_TIME_OFFSET_MS, 0);
    assert.equal(value.SERVER_TIME_WITHIN_SKEW, true);
    assert.equal(value.FAILURE_REASON, null);
    assert.equal(value.NETWORK_REQUEST_COUNT, 9);
    assert.equal(value.MAX_REAL_READ_GETS, MAX_BITGET_REAL_READ_GETS);
    assert.equal(value.GETS_WITHIN_BUDGET, true);
    assert.equal(value.DIAGNOSTICS.length, 0);
    assert.deepEqual(value.REQUEST_COUNT_BY_ENDPOINT, {
      '/api/v2/public/time': 3,
      '/api/v2/mix/account/accounts': 1,
      '/api/v2/mix/position/all-position': 1,
      '/api/v2/mix/order/orders-pending': 1,
      '/api/v2/mix/order/fills': 1,
      '/api/v2/mix/market/contracts': 1,
      '/api/v2/mix/market/symbol-price': 1,
    });
    assert.deepEqual(value.REQUEST_SEQUENCE, [
      BITGET_READ_ENDPOINTS.SERVER_TIME,
      BITGET_READ_ENDPOINTS.SERVER_TIME,
      BITGET_READ_ENDPOINTS.ACCOUNTS,
      BITGET_READ_ENDPOINTS.POSITIONS,
      BITGET_READ_ENDPOINTS.PENDING_ORDERS,
      BITGET_READ_ENDPOINTS.FILLS,
      BITGET_READ_ENDPOINTS.SERVER_TIME,
      BITGET_READ_ENDPOINTS.CONTRACTS,
      BITGET_READ_ENDPOINTS.SYMBOL_PRICE,
    ]);
    assert.equal(value.REQUEST_SEQUENCE.length, value.NETWORK_REQUEST_COUNT);
    assert.equal(value.ENTRY_READINESS?.safeToOpen, true);
    assertNoLeak(value);
  });

  it('4. the mode label is derived from evidence and cannot be asserted by a caller', () => {
    assert.equal(deriveBitgetRealReadMode({ productionTransportProvenance: true, networkRequestCount: 0, realReadAuthorized: true }), 'OFFLINE_SIMULATION');
    assert.equal(deriveBitgetRealReadMode({ productionTransportProvenance: false, networkRequestCount: 9, realReadAuthorized: true }), 'OFFLINE_SIMULATION');
    assert.equal(deriveBitgetRealReadMode({ productionTransportProvenance: true, networkRequestCount: 9, realReadAuthorized: false }), 'OFFLINE_SIMULATION');
    assert.equal(deriveBitgetRealReadMode({ productionTransportProvenance: true, networkRequestCount: 9, realReadAuthorized: true }), 'REAL_AUTHENTICATED_NETWORK');
    assert.equal(deriveBitgetRealReadMode({ productionTransportProvenance: true, networkRequestCount: -1, realReadAuthorized: true }), 'OFFLINE_SIMULATION');
  });

  it('5. a simulated run cannot be relabelled real even when authorization is claimed', async () => {
    const { receipt } = run({}, { realReadAuthorized: true });
    const value = await receipt();
    assert.equal(value.REAL_READ_AUTHORIZED, true);
    assert.equal(value.PRODUCTION_TRANSPORT_PROVENANCE, false);
    assert.equal(value.MODE, BITGET_REAL_READ_MODES.OFFLINE_SIMULATION, 'a fake transport cannot claim real mode');
    assert.equal(value.PRODUCTION_CONNECTIVITY_VERIFIED, false);
    assert.equal(value.REAL_READ_VERIFIED, false);
  });

  it('6. the production code path executes offline and still certifies nothing', async () => {
    const fake = fixtureFetch({});
    const original = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fake.fetchImpl;
    try {
      const runner = createBitgetRealReadRunner({
        credential, identity, now: () => BASE_MS, runId: 'prod-path', realReadAuthorized: true,
      });
      assert.equal(runner.productionTransportProvenance(), true);
      assert.equal(runner.requestCount(), 0);
      const value = await runner.run();
      assert.equal(value.PRODUCTION_TRANSPORT_PROVENANCE, true);
      assert.equal(value.REAL_READ_AUTHORIZED, true);
      assert.equal(value.NETWORK_REQUEST_COUNT, 9);
      // The mode identifies the production code path; it is not a claim that Bitget answered.
      assert.equal(value.MODE, BITGET_REAL_READ_MODES.REAL_AUTHENTICATED_NETWORK);
      assert.equal(value.MODE_STRING_PROVES_NETWORK, false);
      assert.equal(value.PRODUCTION_CONNECTIVITY_VERIFIED, false);
      assert.equal(value.REAL_READ_VERIFIED, false);
      assert.equal(value.BITGET_ACCOUNT_TRUTH_VERIFIED, false);
      assert.equal(value.REAL_CREDENTIAL_USED, false);
      assert.equal(value.LIVE_READY, false);
      assertNoLeak(value);
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
  });

  it('6b. production provenance without explicit authorization fails before ambient fetch', async () => {
    const original = globalThis.fetch;
    try {
      for (const authorization of [undefined, false] as const) {
        const fake = fixtureFetch({});
        (globalThis as { fetch: unknown }).fetch = fake.fetchImpl;
        const runner = createBitgetRealReadRunner({
          credential,
          identity,
          now: () => BASE_MS,
          runId: `unauthorized-${String(authorization)}`,
          ...(authorization === undefined ? {} : { realReadAuthorized: authorization }),
        });
        const value = await runner.run();
        assert.equal(runner.productionTransportProvenance(), true);
        assert.equal(runner.requestCount(), 0);
        assert.equal(fake.captured.length, 0, 'ambient fetch must remain uncalled');
        assert.equal(value.FAILURE_REASON, BITGET_REAL_READ_AUTHORIZATION_REQUIRED);
        assert.equal(value.MODE, BITGET_REAL_READ_MODES.OFFLINE_SIMULATION);
        assert.equal(value.NETWORK_REQUEST_COUNT, 0);
        assert.deepEqual(value.REQUEST_SEQUENCE, []);
        assert.equal(value.SERVER_TIME_PREFLIGHT_PERFORMED, false);
        assert.equal(value.ACCOUNT_TRUTH_AVAILABLE, false);
        assert.equal(value.INSTRUMENT_FACTS_AVAILABLE, false);
        assert.equal(value.PRODUCTION_CONNECTIVITY_VERIFIED, false);
        assert.equal(value.REAL_READ_VERIFIED, false);
        assert.equal(value.EXECUTION_AUTHORITY, false);
        assert.equal(value.LIVE_READY, false);
        assertNoLeak(value);
      }
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
  });

  it('7. no injected credential means zero requests and a sanitized reason', async () => {
    const { receipt, captured } = run({}, { credential: null });
    const value = await receipt();
    assert.equal(value.FAILURE_REASON, 'BITGET_READ_CREDENTIALS_UNAVAILABLE');
    assert.equal(value.CREDENTIAL_INJECTED, false);
    assert.equal(value.NETWORK_REQUEST_COUNT, 0);
    assert.deepEqual(value.REQUEST_SEQUENCE, []);
    assert.equal(captured.length, 0);
    assert.equal(value.SERVER_TIME_PREFLIGHT_PERFORMED, false);
    assert.equal(value.MODE, BITGET_REAL_READ_MODES.OFFLINE_SIMULATION);
    assert.equal(value.REAL_CREDENTIAL_DISCOVERY, false);
  });

  it('8. an invalid or skewed server time blocks the run after the preflight only', async () => {
    const invalid = await run({ serverTime: { serverTime: 'not-a-time' } }).receipt();
    assert.equal(invalid.FAILURE_REASON, 'BITGET_SERVER_TIME_INVALID');
    assert.equal(invalid.SERVER_TIME_OBSERVED, false);
    assert.equal(invalid.NETWORK_REQUEST_COUNT, 1, 'preflight only');
    assert.deepEqual(invalid.REQUEST_SEQUENCE, [BITGET_READ_ENDPOINTS.SERVER_TIME]);
    assert.equal(invalid.ACCOUNT_TRUTH_AVAILABLE, false);

    const skewed = await run({ serverTime: { serverTime: String(BASE_MS + 90_000) } }).receipt();
    assert.equal(skewed.FAILURE_REASON, 'BITGET_CLOCK_SKEW_INVALID');
    assert.equal(skewed.NETWORK_REQUEST_COUNT, 1);
    assert.deepEqual(skewed.REQUEST_SEQUENCE, [BITGET_READ_ENDPOINTS.SERVER_TIME]);
    assert.equal(skewed.DIAGNOSTICS[0]?.reason, 'BITGET_CLOCK_SKEW_INVALID');
  });

  it('9. transport failures produce sanitized diagnostics only', async () => {
    const { receipt } = run({ networkFailure: true });
    const value = await receipt();
    assert.equal(value.FAILURE_REASON, 'BITGET_READ_TRANSPORT_FAILED');
    assert.equal(value.NETWORK_REQUEST_COUNT, 1);
    assert.deepEqual(value.REQUEST_SEQUENCE, [BITGET_READ_ENDPOINTS.SERVER_TIME]);
    assert.equal(value.DIAGNOSTICS.length, 1);
    const diagnostic = value.DIAGNOSTICS[0];
    assert.equal(diagnostic?.phase, 'SERVER_TIME_PREFLIGHT');
    assert.equal(diagnostic?.endpoint, '/api/v2/public/time');
    assert.deepEqual(Object.keys(diagnostic ?? {}).sort(), ['bitgetCode', 'endpoint', 'httpStatus', 'phase', 'reason', 'transportCode']);
    assertNoLeak(value);
  });

  it('10. an exchange rejection is reported by code, not by body', async () => {
    const { receipt } = run({ reject: [BITGET_READ_ENDPOINTS.SERVER_TIME] });
    const value = await receipt();
    assert.equal(value.FAILURE_REASON, 'BITGET_READ_API_REJECTED');
    assert.equal(value.DIAGNOSTICS[0]?.transportCode, 'BITGET_READ_API_REJECTED');
    assert.equal(value.DIAGNOSTICS[0]?.bitgetCode, '40012');
    assert.equal(value.DIAGNOSTICS[0]?.httpStatus, 200);
    assertNoLeak(value);
  });

  it('11. malformed account data fails closed before any instrument read', async () => {
    const { receipt } = run({ positions: { not: 'an array' } });
    const value = await receipt();
    assert.equal(value.FAILURE_REASON, 'POSITION_TRUTH_MALFORMED');
    assert.equal(value.ACCOUNT_TRUTH_AVAILABLE, false);
    assert.equal(value.INSTRUMENT_FACTS_AVAILABLE, false);
    assert.equal(value.ACCOUNT_STATE, null, 'malformed positions must never become FLAT');
    assert.equal(value.NETWORK_REQUEST_COUNT, 4, 'preflight + foundation server-time + accounts + positions');
    assert.deepEqual(value.REQUEST_SEQUENCE, [
      BITGET_READ_ENDPOINTS.SERVER_TIME,
      BITGET_READ_ENDPOINTS.SERVER_TIME,
      BITGET_READ_ENDPOINTS.ACCOUNTS,
      BITGET_READ_ENDPOINTS.POSITIONS,
    ]);
    assert.equal(value.REQUEST_COUNT_BY_ENDPOINT['/api/v2/mix/market/contracts'] ?? 0, 0);
    assert.equal(value.DIAGNOSTICS[0]?.reason, 'POSITION_TRUTH_MALFORMED');
  });

  it('12. the run-wide GET ceiling is exact and enforced', () => {
    assert.equal(MAX_BITGET_REAL_READ_GETS, 9);
    assert.equal(bitgetRealReadBudgetCheck(0).withinBudget, true);
    assert.equal(bitgetRealReadBudgetCheck(9).withinBudget, true);
    assert.equal(bitgetRealReadBudgetCheck(10).withinBudget, false);
    assert.equal(bitgetRealReadBudgetCheck(-1).withinBudget, false);
    assert.equal(bitgetRealReadBudgetCheck(1.5).withinBudget, false);
  });

  it('13. every request stays on the closed GET-only allowlist and the fixed origin', async () => {
    const { receipt, captured } = run();
    const value = await receipt();
    const allowlist = new Set(Object.values(BITGET_READ_ENDPOINTS) as string[]);
    assert.equal(captured.length, 9);
    for (const request of captured) {
      assert.equal(request.url.startsWith(BITGET_L0_PRODUCTION_ORIGIN), true);
      const path = request.url.replace(BITGET_L0_PRODUCTION_ORIGIN, '').split('?')[0] ?? '';
      assert.equal(allowlist.has(path), true, path);
      assert.equal(path.includes('/position/all?'), false);
    }
    assert.equal(value.REQUEST_SEQUENCE.every((endpoint) => allowlist.has(endpoint)), true);
    assert.equal(captured.filter((request) => request.url.includes('productType=USDT-FUTURES')).length >= 5, true);
    assert.equal(captured.some((request) => request.url.includes('symbol=ETHUSDT')), true);
  });

  it('14. the runner surface has no mutation or execution method', async () => {
    const { runner } = run();
    assert.deepEqual(Object.keys(runner).sort(), ['productionTransportProvenance', 'requestCount', 'run']);
    for (const forbidden of ['placeOrder', 'cancelOrder', 'modifyOrder', 'setLeverage', 'setMarginMode', 'setPositionMode', 'transfer', 'withdraw', 'submit']) {
      assert.equal(forbidden in runner, false, forbidden);
    }
  });

  it('15. the runner never discovers credentials from the environment or a file', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync('src/runtime/bitget/BitgetRealReadExecutionRunner.ts', 'utf8');
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    assert.equal(/process\.env/.test(source), false);
    assert.equal(/dotenv/.test(source), false);
    assert.equal(/readFileSync|node:fs|\.bitget\.env/.test(source), false);
    const value = await run().receipt();
    assert.equal(value.REAL_CREDENTIAL_DISCOVERY, false);
    assert.equal(value.REAL_CREDENTIAL_USED, false);
    assert.equal(value.CREDENTIAL_INJECTED, true);
  });

  it('16. a symbol override is honoured and productType stays fixed', async () => {
    const { receipt, captured } = run({ symbolPrice: [{ symbol: 'ETHUSDT', price: '2009.5', indexPrice: '2008.75', markPrice: '2010.5', ts: String(BASE_MS) }] }, { symbol: 'BTCUSDT' });
    const value = await receipt();
    assert.equal(value.SYMBOL, 'BTCUSDT');
    assert.equal(value.PRODUCT_TYPE, 'USDT-FUTURES');
    assert.equal(captured.some((request) => request.url.includes('symbol=BTCUSDT')), true);
    assert.equal(value.INSTRUMENT_FACTS_AVAILABLE, false, 'contracts fixture has no BTCUSDT entry');
    assert.equal(value.FAILURE_REASON, 'MARKET_RULES_UNKNOWN');
    assert.equal(value.NETWORK_REQUEST_COUNT, 8);
    assert.deepEqual(value.REQUEST_SEQUENCE, [
      BITGET_READ_ENDPOINTS.SERVER_TIME,
      BITGET_READ_ENDPOINTS.SERVER_TIME,
      BITGET_READ_ENDPOINTS.ACCOUNTS,
      BITGET_READ_ENDPOINTS.POSITIONS,
      BITGET_READ_ENDPOINTS.PENDING_ORDERS,
      BITGET_READ_ENDPOINTS.FILLS,
      BITGET_READ_ENDPOINTS.SERVER_TIME,
      BITGET_READ_ENDPOINTS.CONTRACTS,
    ]);
    assert.equal(value.REQUEST_COUNT_BY_ENDPOINT[BITGET_READ_ENDPOINTS.SYMBOL_PRICE] ?? 0, 0);
  });
});
