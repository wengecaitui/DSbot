import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  BINANCE_L1A_SCHEMA_VERSION,
  BINANCE_L1A_SOURCE,
  createBinanceAuthenticatedReadFoundation,
  type BinanceReadCredentials,
  type BinanceReadIdentity,
} from '../../src/runtime/binance/BinanceAuthenticatedReadFoundation';
import {
  BINANCE_L1A_Q0_SCHEMA_VERSION,
  type BinanceOfflineQualificationReceipt,
} from '../../src/runtime/binance/BinanceOfflineReadQualification';
import {
  createBinanceUsdMAuthenticatedReadClient,
  DEFAULT_BINANCE_RECV_WINDOW_MS,
  MAX_BINANCE_RECV_WINDOW_MS,
  RECENT_FILL_LIMIT_PER_SYMBOL,
} from '../../src/runtime/binance/BinanceUsdMAuthenticatedReadClient';
import {
  runBinanceAuthenticatedReadQualification,
} from '../../src/runtime/binance/BinanceAuthenticatedReadQualificationRunner';
import {
  BINANCE_USDM_BASE_ORIGIN,
  BINANCE_USDM_READ_ENDPOINTS,
  createBinanceUsdMReadTransport,
  type BinanceUsdMReadEndpoint,
  type BinanceUsdMReadTransport,
  type BinanceUsdMReadTransportRequest,
} from '../../src/runtime/binance/BinanceUsdMReadTransport';

const NOW = 2_000_000_000_000;
const SYMBOLS = Object.freeze(['ADAUSDT', 'SOLUSDT']);
const identity: BinanceReadIdentity = Object.freeze({
  exchange: 'binance',
  accountId: 'q1-real-read-prep-account',
});
const fakeCredentials: BinanceReadCredentials = Object.freeze({
  apiKey: 'FAKE_Q1_API_KEY_DO_NOT_USE',
  secretKey: 'FAKE_Q1_SECRET_KEY_DO_NOT_USE',
});

const q0Checks = Object.freeze({
  NOT_CONFIGURED_FAIL_CLOSED: true,
  CREDENTIALS_UNAVAILABLE_FAIL_CLOSED: true,
  TRANSPORT_FAILURE_FAIL_CLOSED: true,
  ACCOUNT_TRUTH_NORMALIZED: true,
  INSTRUMENT_FACTS_NORMALIZED: true,
  STALE_MARK_BLOCKS_ENTRY_ONLY: true,
  MISSING_RULES_BLOCK_ENTRY_ONLY: true,
  MISSING_ACCOUNT_NOT_FLAT: true,
  UNKNOWN_BALANCE_NOT_ZERO: true,
  UNKNOWN_POSITION_NOT_ZERO: true,
  TIMES_AND_FRESHNESS_DETERMINISTIC: true,
  READ_CLIENT_SURFACE_EXACT: true,
  MUTATION_METHOD_UNREACHABLE: true,
  RECEIPT_CANNOT_GRANT_AUTHORITY: true,
});

const validQ0Receipt: BinanceOfflineQualificationReceipt = Object.freeze({
  QUALIFICATION_MODE: 'OFFLINE',
  SCHEMA_VERSION: BINANCE_L1A_Q0_SCHEMA_VERSION,
  READ_SOURCE: BINANCE_L1A_SOURCE,
  READ_SCHEMA_VERSION: BINANCE_L1A_SCHEMA_VERSION,
  AUTH_NETWORK_USED: false,
  REAL_CREDENTIAL_USED: false,
  REAL_CREDENTIAL_DISCOVERY: false,
  PRODUCTION_CONNECTIVITY_VERIFIED: false,
  READ_CONTRACT_VERIFIED: true,
  FAIL_CLOSED_VERIFIED: true,
  MUTATION_SURFACE_PRESENT: false,
  LIVE_READY: false,
  EXECUTION_AUTHORITY_GRANTED: false,
  READY_FOR_REAL_READ_QUALIFICATION: true,
  ACCOUNT_OBSERVED_AT: NOW,
  ACCOUNT_SERVER_TIME: NOW,
  INSTRUMENT_OBSERVED_AT: NOW,
  INSTRUMENT_SERVER_TIME: NOW,
  CHECKS: q0Checks,
});

type EndpointOverrides = Partial<Record<BinanceUsdMReadEndpoint, unknown | Error>>;

interface RecordedRequest {
  readonly endpoint: BinanceUsdMReadEndpoint;
  readonly query: readonly Readonly<{ name: string; value: string }>[];
  readonly apiKey?: string;
}

function queryValue(request: RecordedRequest, name: string): string | null {
  return request.query.find((entry) => entry.name === name)?.value ?? null;
}

function accountPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assets: [{ asset: 'USDT', walletBalance: '100', availableBalance: '80' }],
    positions: [],
    updateTime: NOW,
    ...overrides,
  };
}

function exchangeInfoPayload(
  symbols: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    symbols: symbols.map((symbol) => ({
      symbol,
      status: 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', minQty: '0.001', stepSize: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ],
    })),
    ...overrides,
  };
}

function defaultPayload(endpoint: BinanceUsdMReadEndpoint, symbols: readonly string[], request: RecordedRequest): unknown {
  const symbol = queryValue(request, 'symbol');
  switch (endpoint) {
    case BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME:
      return { serverTime: NOW };
    case BINANCE_USDM_READ_ENDPOINTS.ACCOUNT:
      return accountPayload();
    case BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS:
    case BINANCE_USDM_READ_ENDPOINTS.USER_TRADES:
      return [];
    case BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE:
      return { symbol, markPrice: '100', time: NOW };
    case BINANCE_USDM_READ_ENDPOINTS.EXCHANGE_INFO:
      return exchangeInfoPayload(symbols);
  }
}

function fakeTransport(
  symbols: readonly string[] = SYMBOLS,
  overrides: EndpointOverrides = {},
): { readonly transport: BinanceUsdMReadTransport; readonly requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const transport: BinanceUsdMReadTransport = Object.freeze({
    async get(input: BinanceUsdMReadTransportRequest) {
      const request: RecordedRequest = Object.freeze({
        endpoint: input.endpoint,
        query: Object.freeze(input.query.map((entry) => Object.freeze({ ...entry }))),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      });
      requests.push(request);
      if (Object.prototype.hasOwnProperty.call(overrides, input.endpoint)) {
        const overridden = overrides[input.endpoint];
        if (overridden instanceof Error) throw overridden;
        return overridden;
      }
      return defaultPayload(input.endpoint, symbols, request);
    },
  });
  return { transport, requests };
}

function clientFor(
  transport: BinanceUsdMReadTransport,
  symbols: readonly string[] = SYMBOLS,
  options: { readonly now?: () => number; readonly timeOffsetMs?: number; readonly recvWindowMs?: number } = {},
) {
  return createBinanceUsdMAuthenticatedReadClient({
    identity,
    requestedSymbols: symbols,
    credentials: fakeCredentials,
    timeOffsetMs: options.timeOffsetMs ?? 0,
    now: options.now ?? (() => NOW),
    transport,
    ...(options.recvWindowMs === undefined ? {} : { recvWindowMs: options.recvWindowMs }),
  });
}

async function simulatedRun(options: {
  readonly symbols?: readonly string[];
  readonly overrides?: EndpointOverrides;
  readonly q0Receipt?: BinanceOfflineQualificationReceipt | null;
  readonly credentials?: BinanceReadCredentials | null;
  readonly now?: () => number;
} = {}) {
  const symbols = options.symbols ?? SYMBOLS;
  const fake = fakeTransport(symbols, options.overrides);
  let secretProviderCalls = 0;
  const receipt = await runBinanceAuthenticatedReadQualification({
    runId: 'q1-simulated-real-run',
    identity,
    requestedSymbols: symbols,
    q0Receipt: options.q0Receipt === undefined ? validQ0Receipt : options.q0Receipt,
    secretProvider: Object.freeze({
      async getReadCredentials() {
        secretProviderCalls += 1;
        return options.credentials === undefined ? fakeCredentials : options.credentials;
      },
    }),
    transport: fake.transport,
    now: options.now ?? (() => NOW),
  });
  return { receipt, requests: fake.requests, secretProviderCalls };
}

describe('Binance L1A Q1 real authenticated-read execution prep', () => {
  it('1. fixes the origin, permits all six read endpoints, and emits GET only', async () => {
    const calls: Array<{ readonly url: URL; readonly init: RequestInit }> = [];
    const transport = createBinanceUsdMReadTransport(async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return { ok: true, status: 200, async json() { return {}; } };
    });
    const signedQuery = [
      { name: 'recvWindow', value: '5000' },
      { name: 'signature', value: 'a'.repeat(64) },
      { name: 'timestamp', value: String(NOW) },
    ] as const;
    const requests: readonly BinanceUsdMReadTransportRequest[] = [
      { endpoint: BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME, query: [] },
      {
        endpoint: BINANCE_USDM_READ_ENDPOINTS.ACCOUNT,
        query: signedQuery,
        apiKey: 'fixture-api-key',
      },
      {
        endpoint: BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS,
        query: [...signedQuery, { name: 'symbol', value: 'SOLUSDT' }],
        apiKey: 'fixture-api-key',
      },
      {
        endpoint: BINANCE_USDM_READ_ENDPOINTS.USER_TRADES,
        query: [
          ...signedQuery,
          { name: 'limit', value: '50' },
          { name: 'symbol', value: 'SOLUSDT' },
        ],
        apiKey: 'fixture-api-key',
      },
      {
        endpoint: BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE,
        query: [{ name: 'symbol', value: 'SOLUSDT' }],
      },
      { endpoint: BINANCE_USDM_READ_ENDPOINTS.EXCHANGE_INFO, query: [] },
    ];
    for (const request of requests) {
      await transport.get(request);
    }
    assert.equal(BINANCE_USDM_BASE_ORIGIN, 'https://fapi.binance.com');
    assert.deepEqual(calls.map((call) => call.url.pathname), Object.values(BINANCE_USDM_READ_ENDPOINTS));
    assert.equal(calls.every((call) => call.url.origin === BINANCE_USDM_BASE_ORIGIN), true);
    assert.equal(calls.every((call) => call.init.method === 'GET'), true);
    const securePaths = new Set([
      BINANCE_USDM_READ_ENDPOINTS.ACCOUNT,
      BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS,
      BINANCE_USDM_READ_ENDPOINTS.USER_TRADES,
    ]);
    for (const call of calls) {
      const headers = call.init.headers as Readonly<Record<string, string>> | undefined;
      assert.equal(
        headers?.['X-MBX-APIKEY'],
        securePaths.has(call.url.pathname as BinanceUsdMReadEndpoint) ? 'fixture-api-key' : undefined,
      );
    }
    await assert.rejects(() => transport.get({ endpoint: '/fapi/v1/order' as never, query: [] }),
      /BINANCE_USDM_READ_REQUEST_INVALID/);
    await assert.rejects(() => transport.get({
      endpoint: BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME,
      query: [],
      apiKey: 'must-not-leak-to-public-endpoints',
    }), /BINANCE_USDM_READ_REQUEST_INVALID/);
    await assert.rejects(() => transport.get({
      endpoint: BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS,
      query: signedQuery,
      apiKey: 'fixture-api-key',
    }), /BINANCE_USDM_READ_REQUEST_INVALID/);
  });

  it('2. transport and client expose no non-GET or mutation method', () => {
    const fake = fakeTransport();
    const transport = createBinanceUsdMReadTransport(async () => ({
      ok: true, status: 200, async json() { return {}; },
    }));
    assert.deepEqual(Object.keys(transport), ['get']);
    assert.deepEqual(Object.keys(clientFor(fake.transport)).sort(), [
      'getAccount', 'getInstrumentRules', 'getMarkPrice',
      'getOpenOrders', 'getRecentFills', 'getServerTime',
    ]);
  });

  it('3. signs deterministic USER_DATA GET queries with HMAC-SHA256', async () => {
    const fake = fakeTransport();
    const client = clientFor(fake.transport);
    await client.getAccount();
    await client.getAccount();
    const accountRequests = fake.requests.filter((request) =>
      request.endpoint === BINANCE_USDM_READ_ENDPOINTS.ACCOUNT);
    assert.equal(accountRequests.length, 2);
    const unsigned = `recvWindow=${DEFAULT_BINANCE_RECV_WINDOW_MS}&timestamp=${NOW}`;
    const expected = createHmac('sha256', fakeCredentials.secretKey).update(unsigned).digest('hex');
    assert.equal(queryValue(accountRequests[0], 'signature'), expected);
    assert.equal(queryValue(accountRequests[1], 'signature'), expected);
  });

  it('4. includes timestamp/recvWindow and applies API key only to USER_DATA', async () => {
    const fake = fakeTransport();
    const client = clientFor(fake.transport);
    await client.getServerTime();
    await client.getAccount();
    await client.getMarkPrice('SOLUSDT');
    await client.getInstrumentRules('SOLUSDT');
    const secure = fake.requests.filter((request) => request.apiKey !== undefined);
    const publicReads = fake.requests.filter((request) => request.apiKey === undefined);
    assert.equal(secure.length, 1);
    assert.equal(secure[0].apiKey, fakeCredentials.apiKey);
    assert.equal(queryValue(secure[0], 'timestamp'), String(NOW));
    assert.equal(queryValue(secure[0], 'recvWindow'), String(DEFAULT_BINANCE_RECV_WINDOW_MS));
    assert.equal(publicReads.length, 3);
  });

  it('5. enforces recvWindow default and hard maximum', () => {
    const fake = fakeTransport();
    assert.doesNotThrow(() => clientFor(fake.transport, SYMBOLS, { recvWindowMs: MAX_BINANCE_RECV_WINDOW_MS }));
    assert.throws(() => clientFor(fake.transport, SYMBOLS, { recvWindowMs: MAX_BINANCE_RECV_WINDOW_MS + 1 }),
      /BINANCE_USDM_RECV_WINDOW_INVALID/);
  });

  it('6. preflight computes a deterministic offset used by signed calls', async () => {
    const serverTime = NOW + 500;
    const observed = await simulatedRun({
      overrides: { [BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME]: { serverTime } },
    });
    const signed = observed.requests.filter((request) => request.apiKey !== undefined);
    assert.equal(signed.length > 0, true);
    assert.equal(signed.every((request) => queryValue(request, 'timestamp') === String(serverTime)), true);
  });

  it('7. signed reads do not wait for concurrent getServerTime completion', async () => {
    let releaseTime!: (value: unknown) => void;
    const timeResult = new Promise<unknown>((resolvePromise) => { releaseTime = resolvePromise; });
    let accountCompleted = false;
    const transport: BinanceUsdMReadTransport = Object.freeze({
      async get(request) {
        if (request.endpoint === BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME) return timeResult;
        if (request.endpoint === BINANCE_USDM_READ_ENDPOINTS.ACCOUNT) {
          accountCompleted = true;
          return accountPayload();
        }
        return [];
      },
    });
    const client = clientFor(transport, ['SOLUSDT']);
    const pendingTime = client.getServerTime();
    const account = await client.getAccount();
    assert.equal(accountCompleted, true);
    assert.equal(account.updateTime, NOW);
    releaseTime({ serverTime: NOW });
    assert.equal(await pendingTime, NOW);
  });

  it('8. preflight transport failure performs zero authenticated requests and no retry', async () => {
    const observed = await simulatedRun({
      overrides: { [BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME]: new Error('FAKE_PREFLIGHT_FAILURE') },
    });
    assert.equal(observed.requests.length, 1);
    assert.equal(observed.requests[0].apiKey, undefined);
    assert.equal(observed.receipt.AUTH_NETWORK_USED, false);
    assert.equal(observed.receipt.REAL_READ_VERIFIED, false);
  });

  it('9. excessive server-time offset fails before authenticated reads', async () => {
    const observed = await simulatedRun({
      overrides: { [BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME]: { serverTime: NOW + 60_001 } },
    });
    assert.equal(observed.requests.filter((request) => request.apiKey !== undefined).length, 0);
    assert.equal(observed.receipt.PRODUCTION_CONNECTIVITY_VERIFIED, false);
    assert.equal(observed.receipt.REAL_READ_VERIFIED, false);
  });

  it('10. one-symbol run scopes every openOrders and userTrades request', async () => {
    const observed = await simulatedRun({ symbols: ['SOLUSDT'] });
    const scoped = observed.requests.filter((request) =>
      request.endpoint === BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS
      || request.endpoint === BINANCE_USDM_READ_ENDPOINTS.USER_TRADES);
    assert.equal(scoped.length, 2);
    assert.equal(scoped.every((request) => queryValue(request, 'symbol') === 'SOLUSDT'), true);
  });

  it('11. three-symbol run is bounded and shares one exchangeInfo observation', async () => {
    const symbols = ['ADAUSDT', 'SOLUSDT', 'XRPUSDT'];
    const observed = await simulatedRun({ symbols });
    assert.equal(observed.requests.filter((request) =>
      request.endpoint === BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS).length, 3);
    assert.equal(observed.requests.filter((request) =>
      request.endpoint === BINANCE_USDM_READ_ENDPOINTS.USER_TRADES).length, 3);
    assert.equal(observed.requests.filter((request) =>
      request.endpoint === BINANCE_USDM_READ_ENDPOINTS.EXCHANGE_INFO).length, 1);
    assert.equal(observed.receipt.REAL_READ_VERIFIED, true);
  });

  it('12. more than three symbols rejects before credentials or transport', async () => {
    const fake = fakeTransport(['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT']);
    let providerCalls = 0;
    await assert.rejects(() => runBinanceAuthenticatedReadQualification({
      runId: 'too-many-symbols',
      identity,
      requestedSymbols: ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT'],
      q0Receipt: validQ0Receipt,
      secretProvider: { async getReadCredentials() { providerCalls += 1; return fakeCredentials; } },
      transport: fake.transport,
      now: () => NOW,
    }), /BINANCE_Q1_REQUESTED_SYMBOLS_INVALID/);
    assert.equal(providerCalls, 0);
    assert.equal(fake.requests.length, 0);
  });

  it('13. emits no symbol-less openOrders/userTrades request or hidden symbol', async () => {
    const observed = await simulatedRun();
    const scoped = observed.requests.filter((request) =>
      request.endpoint === BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS
      || request.endpoint === BINANCE_USDM_READ_ENDPOINTS.USER_TRADES);
    assert.equal(scoped.every((request) => queryValue(request, 'symbol') !== null), true);
    assert.deepEqual([...new Set(scoped.map((request) => queryValue(request, 'symbol')))].sort(), [...SYMBOLS]);
    assert.equal(scoped.filter((request) => request.endpoint === BINANCE_USDM_READ_ENDPOINTS.USER_TRADES)
      .every((request) => queryValue(request, 'limit') === String(RECENT_FILL_LIMIT_PER_SYMBOL)), true);
  });

  it('14. Account V3 adapter preserves factual balances and signed positions', async () => {
    const fake = fakeTransport(SYMBOLS, {
      [BINANCE_USDM_READ_ENDPOINTS.ACCOUNT]: accountPayload({
        positions: [
          { symbol: 'ADAUSDT', positionAmt: '2', entryPrice: '10', markPrice: '11',
            unrealizedProfit: '2', marginType: 'cross', leverage: '3', updateTime: NOW },
          { symbol: 'SOLUSDT', positionAmt: '-1', entryPrice: '100', markPrice: '90',
            unrealizedProfit: '10', marginType: 'isolated', leverage: '2', updateTime: NOW },
          { symbol: 'XRPUSDT', positionAmt: '0', entryPrice: '0', markPrice: '1',
            unrealizedProfit: '0', marginType: 'cross', leverage: '1', updateTime: NOW },
        ],
      }),
    });
    const account = await clientFor(fake.transport).getAccount();
    assert.deepEqual(account.balances, [{ asset: 'USDT', walletBalance: '100', availableBalance: '80' }]);
    assert.deepEqual(account.positions?.map((position) => position.positionAmt), ['2', '-1', '0']);
    const client = clientFor(fake.transport);
    const foundation = createBinanceAuthenticatedReadFoundation(identity, {
      secretProvider: { async getReadCredentials() { return fakeCredentials; } },
      clientFactory: { create() { return client; } },
      now: () => NOW,
    });
    const normalized = await foundation.accountTruth.read();
    assert.equal(normalized.availability, 'AVAILABLE');
    assert.deepEqual(normalized.value?.positions.map((position) => position.side), ['LONG', 'SHORT', 'FLAT']);
  });

  it('15. missing account arrays and malformed numeric facts fail closed', async () => {
    const missing = await simulatedRun({
      overrides: { [BINANCE_USDM_READ_ENDPOINTS.ACCOUNT]: { positions: [], updateTime: NOW } },
    });
    const malformed = await simulatedRun({
      overrides: { [BINANCE_USDM_READ_ENDPOINTS.ACCOUNT]: accountPayload({
        assets: [{ asset: 'USDT', walletBalance: 'not-a-number', availableBalance: '80' }],
      }) },
    });
    assert.equal(missing.receipt.REAL_READ_VERIFIED, false);
    assert.equal(malformed.receipt.REAL_READ_VERIFIED, false);
    assert.equal(missing.receipt.ACCOUNT_STATE, null);
    assert.equal(malformed.receipt.BALANCE_COUNT, null);
  });

  it('16. open-order and recent-fill adapters preserve factual fields and empty arrays', async () => {
    const fake = fakeTransport(['SOLUSDT'], {
      [BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS]: [{
        orderId: 7, clientOrderId: 'fake-order-7', symbol: 'SOLUSDT', side: 'BUY',
        positionSide: 'BOTH', type: 'LIMIT', status: 'NEW', price: '100', origQty: '2',
        executedQty: '0', reduceOnly: false, updateTime: NOW,
      }],
      [BINANCE_USDM_READ_ENDPOINTS.USER_TRADES]: [{
        id: 8, orderId: 7, symbol: 'SOLUSDT', side: 'BUY', price: '100', qty: '1',
        quoteQty: '100', commission: '0.04', commissionAsset: 'USDT', time: NOW,
      }],
    });
    const client = clientFor(fake.transport, ['SOLUSDT']);
    const orders = await client.getOpenOrders();
    const fills = await client.getRecentFills();
    assert.equal(orders[0].clientOrderId, 'fake-order-7');
    assert.equal(orders[0].reduceOnly, false);
    assert.equal(fills[0].id, 8);
    assert.equal(fills[0].commission, '0.04');
    const empty = clientFor(fakeTransport(['SOLUSDT']).transport, ['SOLUSDT']);
    assert.deepEqual(await empty.getOpenOrders(), []);
    assert.deepEqual(await empty.getRecentFills(), []);
  });

  it('17. mark-price adapter binds the exact requested symbol', async () => {
    const good = clientFor(fakeTransport(['SOLUSDT']).transport, ['SOLUSDT']);
    assert.deepEqual(await good.getMarkPrice('SOLUSDT'), {
      symbol: 'SOLUSDT', markPrice: '100', time: NOW,
    });
    const mismatch = clientFor(fakeTransport(['SOLUSDT'], {
      [BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE]: { symbol: 'ADAUSDT', markPrice: '100', time: NOW },
    }).transport, ['SOLUSDT']);
    await assert.rejects(() => mismatch.getMarkPrice('SOLUSDT'),
      /BINANCE_USDM_MARK_PRICE_RESPONSE_INVALID/);
    const missingTime = clientFor(fakeTransport(['SOLUSDT'], {
      [BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE]: { symbol: 'SOLUSDT', markPrice: '100' },
    }).transport, ['SOLUSDT']);
    await assert.rejects(() => missingTime.getMarkPrice('SOLUSDT'),
      /BINANCE_USDM_MARK_PRICE_RESPONSE_INVALID/);
  });

  it('18. exchangeInfo derives rules from filters and preserves non-TRADING status', async () => {
    const nonTrading = exchangeInfoPayload(['SOLUSDT']);
    (nonTrading.symbols as Array<Record<string, unknown>>)[0].status = 'BREAK';
    const client = clientFor(fakeTransport(['SOLUSDT'], {
      [BINANCE_USDM_READ_ENDPOINTS.EXCHANGE_INFO]: nonTrading,
    }).transport, ['SOLUSDT']);
    assert.deepEqual(await client.getInstrumentRules('SOLUSDT'), {
      symbol: 'SOLUSDT', tickSize: '0.01', stepSize: '0.001', minQty: '0.001',
      minNotional: '5', status: 'BREAK',
    });
  });

  it('19. missing PRICE_FILTER, LOT_SIZE, or notional filter returns no rules', async () => {
    for (const retained of [
      ['LOT_SIZE', 'MIN_NOTIONAL'],
      ['PRICE_FILTER', 'MIN_NOTIONAL'],
      ['PRICE_FILTER', 'LOT_SIZE'],
    ]) {
      const payload = exchangeInfoPayload(['SOLUSDT']);
      const entry = (payload.symbols as Array<Record<string, unknown>>)[0];
      entry.filters = (entry.filters as Array<Record<string, unknown>>)
        .filter((filter) => retained.includes(String(filter.filterType)));
      const client = clientFor(fakeTransport(['SOLUSDT'], {
        [BINANCE_USDM_READ_ENDPOINTS.EXCHANGE_INFO]: payload,
      }).transport, ['SOLUSDT']);
      assert.equal(await client.getInstrumentRules('SOLUSDT'), null);
    }
  });

  it('20. complete fake REAL run can verify reads but grants no authority', async () => {
    const observed = await simulatedRun();
    assert.equal(observed.secretProviderCalls, 1);
    assert.equal(observed.receipt.QUALIFICATION_MODE, 'REAL_AUTHENTICATED_NETWORK');
    assert.equal(observed.receipt.READ_CLIENT_SURFACE_EXACT, true);
    assert.equal(observed.receipt.MUTATION_SURFACE_PRESENT, false);
    assert.equal(observed.receipt.AUTH_NETWORK_USED, true);
    assert.equal(observed.receipt.REAL_CREDENTIAL_USED, true);
    assert.equal(observed.receipt.PRODUCTION_CONNECTIVITY_VERIFIED, true);
    assert.equal(observed.receipt.REAL_READ_VERIFIED, true);
    assert.equal(observed.receipt.LIVE_READY, false);
    assert.equal(observed.receipt.EXECUTION_AUTHORITY_GRANTED, false);
    assert.equal(observed.receipt.TESTNET_AUTHORITY_GRANTED, false);
    assert.equal(observed.receipt.REAL_ORDER_AUTHORITY_GRANTED, false);
  });

  it('21. invalid Q0 prerequisite stops before credential or network use', async () => {
    const invalidQ0 = { ...validQ0Receipt, READY_FOR_REAL_READ_QUALIFICATION: false };
    const observed = await simulatedRun({ q0Receipt: invalidQ0 });
    assert.equal(observed.secretProviderCalls, 0);
    assert.equal(observed.requests.length, 0);
    assert.equal(observed.receipt.Q0_PRECONDITION_SATISFIED, false);
    assert.equal(observed.receipt.REAL_READ_VERIFIED, false);
  });

  it('22. unavailable credentials stop before time preflight', async () => {
    const observed = await simulatedRun({ credentials: null });
    assert.equal(observed.secretProviderCalls, 1);
    assert.equal(observed.requests.length, 0);
    assert.equal(observed.receipt.REAL_CREDENTIAL_USED, false);
    assert.equal(observed.receipt.REAL_READ_VERIFIED, false);
  });

  it('23. account, orders, fills, mark, rules, and transport failures each fail verification', async () => {
    const cases: EndpointOverrides[] = [
      { [BINANCE_USDM_READ_ENDPOINTS.ACCOUNT]: {} },
      { [BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS]: {} },
      { [BINANCE_USDM_READ_ENDPOINTS.USER_TRADES]: {} },
      { [BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE]: {} },
      { [BINANCE_USDM_READ_ENDPOINTS.EXCHANGE_INFO]: {} },
      { [BINANCE_USDM_READ_ENDPOINTS.ACCOUNT]: new Error('FAKE_ACCOUNT_TRANSPORT_FAILURE') },
    ];
    for (const overrides of cases) {
      const observed = await simulatedRun({ overrides });
      assert.equal(observed.receipt.REAL_READ_VERIFIED, false);
      assert.equal(observed.receipt.PRODUCTION_CONNECTIVITY_VERIFIED, false);
    }
  });

  it('24. stale mark facts fail real-read verification', async () => {
    const observed = await simulatedRun({
      overrides: {
        [BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE]: {
          symbol: 'SOLUSDT', markPrice: '100', time: NOW - 5_001,
        },
      },
      symbols: ['SOLUSDT'],
    });
    assert.equal(observed.receipt.CHECKS.INSTRUMENT_FRESHNESS_FRESH, false);
    assert.equal(observed.receipt.REAL_READ_VERIFIED, false);
  });

  it('25. invalid explicit identity fails before secret or transport access', async () => {
    const fake = fakeTransport(['SOLUSDT']);
    let providerCalls = 0;
    await assert.rejects(() => runBinanceAuthenticatedReadQualification({
      runId: 'invalid-identity',
      identity: { exchange: 'binance', accountId: '' },
      requestedSymbols: ['SOLUSDT'],
      q0Receipt: validQ0Receipt,
      secretProvider: { async getReadCredentials() { providerCalls += 1; return fakeCredentials; } },
      transport: fake.transport,
      now: () => NOW,
    }), /BINANCE_Q1_IDENTITY_INVALID/);
    assert.equal(providerCalls, 0);
    assert.equal(fake.requests.length, 0);
  });

  it('26. transport failure is attempted once and never retried', async () => {
    const observed = await simulatedRun({
      overrides: { [BINANCE_USDM_READ_ENDPOINTS.ACCOUNT]: new Error('FAKE_ONCE') },
    });
    assert.equal(observed.requests.filter((request) =>
      request.endpoint === BINANCE_USDM_READ_ENDPOINTS.ACCOUNT).length, 1);
    assert.equal(observed.receipt.CHECKS.NO_UNEXPECTED_TRANSPORT_ERROR, false);
    assert.equal(observed.receipt.REAL_READ_VERIFIED, false);
  });

  it('27. secrets, API key header value, and signature never reach receipt', async () => {
    const observed = await simulatedRun();
    const serialized = JSON.stringify(observed.receipt);
    const signatures = observed.requests
      .map((request) => queryValue(request, 'signature'))
      .filter((value): value is string => value !== null);
    assert.doesNotMatch(serialized, new RegExp(fakeCredentials.apiKey));
    assert.doesNotMatch(serialized, new RegExp(fakeCredentials.secretKey));
    for (const signature of signatures) assert.doesNotMatch(serialized, new RegExp(signature));
    assert.doesNotMatch(serialized, /X-MBX-APIKEY|Authorization|signed query/i);
  });

  it('28. capability remains isolated from env discovery, logging, owner, UI, and mutation paths', () => {
    const sources = [
      'src/runtime/binance/BinanceUsdMReadTransport.ts',
      'src/runtime/binance/BinanceUsdMAuthenticatedReadClient.ts',
      'src/runtime/binance/BinanceAuthenticatedReadQualificationRunner.ts',
    ].map((path) => readFileSync(resolve(process.cwd(), path), 'utf8')).join('\n');
    assert.doesNotMatch(sources, /process\.env|dotenv|readFile|Credential Manager|console\.|logger\./i);
    assert.doesNotMatch(sources, /ProductionRuntimeOwner|ProductionSpine|OmsCore|PositionManager/);
    assert.doesNotMatch(sources, /\/fapi\/v1\/order|\/fapi\/v1\/leverage|\/fapi\/v1\/marginType/);
    assert.doesNotMatch(sources, /\b(?:post|put|patch|delete)\s*\(/i);
  });

  it('29. client construction snapshots run-scoped clock, offset, transport, and symbols', async () => {
    const first = fakeTransport(['SOLUSDT']);
    const second = fakeTransport(['ADAUSDT']);
    const mutable = {
      identity,
      requestedSymbols: ['SOLUSDT'],
      credentials: fakeCredentials,
      timeOffsetMs: 0,
      now: () => NOW,
      transport: first.transport,
    };
    const client = createBinanceUsdMAuthenticatedReadClient(mutable);
    mutable.requestedSymbols[0] = 'ADAUSDT';
    mutable.timeOffsetMs = 999;
    mutable.now = () => NOW + 999;
    mutable.transport = second.transport;
    await client.getAccount();
    assert.equal(first.requests.length, 1);
    assert.equal(second.requests.length, 0);
    assert.equal(queryValue(first.requests[0], 'timestamp'), String(NOW));
    await assert.rejects(() => client.getMarkPrice('ADAUSDT'), /SYMBOL_OUT_OF_SCOPE/);
  });

  it('30. HTTP 418 and 429 fail closed once without Retry-After behavior', async () => {
    for (const status of [418, 429]) {
      let calls = 0;
      const transport = createBinanceUsdMReadTransport(async () => {
        calls += 1;
        return { ok: false, status, async json() { return { retryAfter: 1 }; } };
      });
      await assert.rejects(
        () => transport.get({ endpoint: BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME, query: [] }),
        (error: unknown) => error instanceof Error
          && error.message === 'BINANCE_USDM_READ_HTTP_FAILED'
          && !error.message.includes('retryAfter'),
      );
      assert.equal(calls, 1);
    }
  });

  it('31. malformed server-time preflight fails before authenticated requests', async () => {
    const observed = await simulatedRun({
      overrides: { [BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME]: { serverTime: 'invalid' } },
    });
    assert.equal(observed.requests.length, 1);
    assert.equal(observed.requests[0].apiKey, undefined);
    assert.equal(observed.receipt.REAL_READ_VERIFIED, false);
  });
});
