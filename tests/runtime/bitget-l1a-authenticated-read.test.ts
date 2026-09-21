/**
 * Bitget L1A authenticated read foundation.
 *
 * Offline only: every transport wraps an injected fake fetch that answers declared fixtures. No real
 * credential is read and no real Bitget host is contacted anywhere in this file.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BITGET_DRIFTED_ENDPOINTS,
  BITGET_L1A_INITIAL_SYMBOL,
  BITGET_L1A_MARGIN_COIN,
  BITGET_L1A_PRODUCT_TYPE,
  BITGET_L1A_SCHEMA_VERSION,
  BITGET_READ_ENDPOINTS,
  BITGET_READ_ENDPOINTS_REQUIRING_L1A_VERIFICATION,
} from '../../src/runtime/bitget/BitgetReadContracts';
import {
  BITGET_SIGNED_TIMESTAMP_WINDOW_MS,
  MAX_BITGET_SERVER_TIME_SKEW_MS,
  createBitgetReadClock,
  observeBitgetServerTime,
  signedBitgetTimestamp,
} from '../../src/runtime/bitget/BitgetReadClock';
import {
  createBitgetAuthenticatedReadClient,
  BITGET_L1A_FILL_LIMIT,
  type BitgetReadIdentity,
} from '../../src/runtime/bitget/BitgetAuthenticatedReadClient';
import {
  ACCOUNT_FRESHNESS_WINDOW_MS,
  MARK_PRICE_FRESHNESS_WINDOW_MS,
  createBitgetAuthenticatedReadFoundation,
  evaluateBitgetNewEntryReadiness,
  normalizeBitgetContractRule,
  normalizeBitgetFill,
  normalizeBitgetOpenOrder,
  normalizeBitgetPosition,
  normalizeBitgetSymbolPrice,
} from '../../src/runtime/bitget/BitgetAuthenticatedReadFoundation';
import { createBitgetReadTransport } from '../../src/runtime/bitget/BitgetReadTransport';

const FIXTURE_BITGET_API_KEY = 'FIXTURE_BITGET_API_KEY';
const FIXTURE_BITGET_SECRET = 'FIXTURE_BITGET_SECRET';
const FIXTURE_BITGET_PASSPHRASE = 'FIXTURE_BITGET_PASSPHRASE';
const FIXTURE_MESSAGE_DO_NOT_LEAK = 'FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK';

const credential = Object.freeze({
  apiKey: FIXTURE_BITGET_API_KEY,
  secretKey: FIXTURE_BITGET_SECRET,
  passphrase: FIXTURE_BITGET_PASSPHRASE,
});
const identity: BitgetReadIdentity = Object.freeze({ exchange: 'bitget', accountId: 'acct-1' });

const BASE_MS = 1_799_000_000_000;

const accountPayload = [{
  marginCoin: 'USDT', accountEquity: '1000.5', available: '900.25', locked: '10.5', unrealizedPL: '0',
}];
const positionPayload = [{
  symbol: 'ETHUSDT', holdSide: 'long', total: '1.5', openPriceAvg: '2000', markPrice: '2010.5',
  unrealizedPL: '15.75', leverage: '10', marginMode: 'crossed', posMode: 'hedge_mode',
  liquidationPrice: '1800', uTime: String(BASE_MS),
}];
const orderPayload = [{
  orderId: '9001', clientOid: '', symbol: 'ETHUSDT', side: 'buy', posSide: 'long',
  orderType: 'limit', status: 'live', price: '1950', size: '0.5', baseVolume: '0',
  reduceOnly: false, marginMode: 'crossed', leverage: '10',
  cTime: String(BASE_MS), uTime: String(BASE_MS),
}];
const fillPayload = [{
  tradeId: 7001, orderId: 7000, symbol: 'ETHUSDT', side: 'buy', tradeSide: 'open',
  price: '1999.5', baseVolume: '0.25', quoteVolume: '499.875', posMode: 'hedge_mode',
  profit: '0', cTime: String(BASE_MS),
  feeDetail: [
    { feeCoin: 'USDT', totalFee: '0.2', totalDeductionFee: '0', deduction: false },
    { feeCoin: 'BGB', totalFee: '0.01', totalDeductionFee: '0.005', deduction: true },
  ],
}];
// Distinguishing fixture: sizeMultiplier (0.01) is deliberately NOT 10^-volumePlace (0.001), so a
// precision unit can never be mistaken for the order-quantity multiple.
const contractPayload = [{
  symbol: 'ETHUSDT', symbolStatus: 'normal', minTradeNum: '0.001', minTradeUSDT: '5',
  pricePlace: '2', priceEndStep: '1', volumePlace: '3', sizeMultiplier: '0.01',
  minLever: '1', maxLever: '125',
}];
const pricePayload = [{
  symbol: 'ETHUSDT', price: '2009.5', indexPrice: '2008.75', markPrice: '2010.5', ts: String(BASE_MS),
}];

interface Fixtures {
  readonly serverTime?: unknown;
  readonly accounts?: unknown;
  readonly positions?: unknown;
  readonly pendingOrders?: unknown;
  readonly fills?: unknown;
  readonly contracts?: unknown;
  readonly symbolPrice?: unknown;
  readonly reject?: readonly string[];
  readonly networkFailure?: boolean;
  readonly status?: number;
}

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
}

function makeFetch(fixtures: Fixtures = {}) {
  const captured: Captured[] = [];
  const data: Record<string, unknown> = {
    [BITGET_READ_ENDPOINTS.SERVER_TIME]: fixtures.serverTime ?? { serverTime: String(BASE_MS) },
    [BITGET_READ_ENDPOINTS.ACCOUNTS]: fixtures.accounts ?? accountPayload,
    [BITGET_READ_ENDPOINTS.POSITIONS]: fixtures.positions ?? positionPayload,
    [BITGET_READ_ENDPOINTS.PENDING_ORDERS]: fixtures.pendingOrders ?? orderPayload,
    [BITGET_READ_ENDPOINTS.FILLS]: fixtures.fills ?? fillPayload,
    [BITGET_READ_ENDPOINTS.CONTRACTS]: fixtures.contracts ?? contractPayload,
    [BITGET_READ_ENDPOINTS.SYMBOL_PRICE]: fixtures.symbolPrice ?? pricePayload,
  };
  const reject = new Set<string>(fixtures.reject ?? []);
  const fetchImpl = async (input: string, init: RequestInit) => {
    captured.push({ url: input, headers: (init.headers ?? undefined) as Record<string, string> | undefined });
    if (fixtures.networkFailure === true) throw new Error('offline');
    const path = input.replace('https://api.bitget.com', '').split('?')[0] ?? '';
    const status = fixtures.status ?? 200;
    const body = reject.has(path) || (fixtures.status !== undefined && fixtures.status >= 400)
      ? { code: '40012', msg: FIXTURE_MESSAGE_DO_NOT_LEAK, requestTime: 1, data: null }
      : { code: '00000', msg: 'success', requestTime: 1, data: data[path] ?? null };
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return JSON.stringify(body); },
    };
  };
  return { fetchImpl, captured };
}

function makeTransport(fixtures: Fixtures = {}) {
  const fake = makeFetch(fixtures);
  return { transport: createBitgetReadTransport(fake.fetchImpl as never), captured: fake.captured };
}

function makeFoundation(fixtures: Fixtures = {}, opts: { readonly credential?: typeof credential | null; readonly now?: () => number } = {}) {
  const fake = makeFetch(fixtures);
  const foundation = createBitgetAuthenticatedReadFoundation({
    transport: createBitgetReadTransport(fake.fetchImpl as never),
    identity,
    now: opts.now ?? (() => BASE_MS),
    credential: opts.credential === undefined ? credential : opts.credential,
  });
  return { foundation, captured: fake.captured };
}

const errorOf = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as { code?: string; reason?: string });
const serialize = (value: unknown) => JSON.stringify(value ?? null);

function assertNoFixtureLeak(value: unknown): void {
  const text = serialize(value);
  for (const fixture of [FIXTURE_BITGET_API_KEY, FIXTURE_BITGET_SECRET, FIXTURE_BITGET_PASSPHRASE, FIXTURE_MESSAGE_DO_NOT_LEAK]) {
    assert.equal(text.includes(fixture), false, `fixture leaked: ${fixture}`);
  }
  assert.equal(text.includes('ACCESS-SIGN'), false, 'signature leaked');
  assert.equal(text.includes('ACCESS-PASSPHRASE'), false, 'auth header leaked');
}

describe('Bitget L1A endpoint contract', () => {
  it('1. current endpoint constants are exact', () => {
    assert.deepEqual(Object.values(BITGET_READ_ENDPOINTS), [
      '/api/v2/public/time',
      '/api/v2/mix/market/contracts',
      '/api/v2/mix/market/symbol-price',
      '/api/v2/mix/account/accounts',
      '/api/v2/mix/position/all-position',
      '/api/v2/mix/order/orders-pending',
      '/api/v2/mix/order/fills',
    ]);
    assert.equal(BITGET_L1A_PRODUCT_TYPE, 'USDT-FUTURES');
    assert.equal(BITGET_L1A_MARGIN_COIN, 'USDT');
    assert.equal(BITGET_L1A_INITIAL_SYMBOL, 'ETHUSDT');
    assert.equal(BITGET_L1A_SCHEMA_VERSION, 'BITGET_L1A_V1');
  });

  it('2. the drifted positions endpoint is rejected before any fetch', async () => {
    const { transport, captured } = makeTransport();
    const error = await errorOf(transport.get({
      endpoint: BITGET_DRIFTED_ENDPOINTS.MIX_POSITION_ALL as never, query: [],
    }));
    assert.equal(error?.code, 'BITGET_READ_REQUEST_INVALID');
    assert.equal(captured.length, 0);
  });

  it('3. the current positions endpoint is accepted and signed', async () => {
    const { transport, captured } = makeTransport();
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.POSITIONS,
      query: [{ name: 'productType', value: 'USDT-FUTURES' }],
      credential,
      timestamp: String(BASE_MS),
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.url, 'https://api.bitget.com/api/v2/mix/position/all-position?productType=USDT-FUTURES');
    assert.equal(typeof captured[0]?.headers?.['ACCESS-SIGN'], 'string');
  });

  it('4. the superseded tickers endpoint is not silently retained', async () => {
    const { transport, captured } = makeTransport();
    const error = await errorOf(transport.get({ endpoint: BITGET_DRIFTED_ENDPOINTS.MIX_TICKERS as never, query: [] }));
    assert.equal(error?.code, 'BITGET_READ_REQUEST_INVALID');
    assert.equal(captured.length, 0);
    assert.equal(
      (Object.values(BITGET_READ_ENDPOINTS) as string[]).includes(BITGET_DRIFTED_ENDPOINTS.MIX_TICKERS),
      false,
    );
  });

  it('5-8. contracts, symbol-price, pending orders and fills are all callable', async () => {
    const { transport, captured } = makeTransport();
    await transport.get({ endpoint: BITGET_READ_ENDPOINTS.CONTRACTS, query: [{ name: 'productType', value: 'USDT-FUTURES' }] });
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.SYMBOL_PRICE,
      query: [{ name: 'productType', value: 'USDT-FUTURES' }, { name: 'symbol', value: 'ETHUSDT' }],
    });
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.PENDING_ORDERS,
      query: [{ name: 'productType', value: 'USDT-FUTURES' }],
      credential,
      timestamp: String(BASE_MS),
    });
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.FILLS,
      query: [{ name: 'productType', value: 'USDT-FUTURES' }, { name: 'limit', value: '50' }],
      credential,
      timestamp: String(BASE_MS),
    });
    assert.deepEqual(captured.map((entry) => entry.url.split('?')[0]?.replace('https://api.bitget.com', '')), [
      '/api/v2/mix/market/contracts',
      '/api/v2/mix/market/symbol-price',
      '/api/v2/mix/order/orders-pending',
      '/api/v2/mix/order/fills',
    ]);
  });

  it('5. an unknown endpoint is rejected before fetch', async () => {
    const { transport, captured } = makeTransport();
    const error = await errorOf(transport.get({ endpoint: '/api/v2/mix/order/place-order' as never, query: [] }));
    assert.equal(error?.code, 'BITGET_READ_REQUEST_INVALID');
    assert.equal(captured.length, 0);
  });

  it('6. every private endpoint requires an injected credential', async () => {
    const { transport, captured } = makeTransport();
    for (const endpoint of [BITGET_READ_ENDPOINTS.ACCOUNTS, BITGET_READ_ENDPOINTS.POSITIONS, BITGET_READ_ENDPOINTS.PENDING_ORDERS, BITGET_READ_ENDPOINTS.FILLS]) {
      const error = await errorOf(transport.get({
        endpoint,
        query: endpoint === BITGET_READ_ENDPOINTS.FILLS
          ? [{ name: 'productType', value: 'USDT-FUTURES' }, { name: 'limit', value: '50' }]
          : [{ name: 'productType', value: 'USDT-FUTURES' }],
        timestamp: String(BASE_MS),
      }));
      assert.equal(error?.code, 'BITGET_READ_REQUEST_INVALID', endpoint);
    }
    assert.equal(captured.length, 0);
  });

  it('7. public endpoints send no auth headers and private ones do', async () => {
    const { transport, captured } = makeTransport();
    await transport.get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] });
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.ACCOUNTS,
      query: [{ name: 'productType', value: 'USDT-FUTURES' }],
      credential,
      timestamp: String(BASE_MS),
    });
    assert.equal(captured[0]?.headers, undefined);
    assert.deepEqual(Object.keys(captured[1]?.headers ?? {}).sort(),
      ['ACCESS-KEY', 'ACCESS-PASSPHRASE', 'ACCESS-SIGN', 'ACCESS-TIMESTAMP', 'Content-Type']);
  });
});

describe('Bitget L1A account truth', () => {
  it('8. a valid snapshot is normalized into canonical facts', async () => {
    const { foundation } = makeFoundation();
    const result = await foundation.accountTruth();
    assert.equal(result.availability, 'AVAILABLE');
    const truth = result.value;
    assert.ok(truth !== null);
    assert.equal(truth.accountState, 'OPEN');
    assert.equal(truth.accountStateBasis, 'FACTUAL_POSITIONS_RESPONSE');
    assert.equal(truth.freshness, 'FRESH');
    assert.equal(truth.source, 'bitget-usdm-read');
    assert.equal(truth.schemaVersion, BITGET_L1A_SCHEMA_VERSION);
    assert.equal(truth.observedAt, BASE_MS);
    assert.deepEqual(truth.balances[0], {
      marginCoin: 'USDT', equity: 1000.5, available: 900.25, locked: 10.5, unrealizedPL: 0,
    });
    assert.deepEqual(truth.positions[0], {
      symbol: 'ETHUSDT', holdSide: 'LONG', quantity: 1.5, entryPrice: 2000, markPrice: 2010.5,
      unrealizedPL: 15.75, leverage: 10, marginMode: 'CROSS', posMode: 'hedge_mode',
      liquidationPrice: 1800, updatedAt: BASE_MS,
    });
    assert.equal(truth.openOrders[0]?.orderId, '9001');
    assert.equal(truth.openOrders[0]?.clientOid, null, 'empty clientOid stays null, never invented');
    assert.equal(truth.recentFills[0]?.tradeId, '7001');
    assert.equal(truth.recentFills[0]?.orderId, '7000');
  });

  it('9. a factually successful empty positions response is FLAT', async () => {
    const { foundation } = makeFoundation({ positions: [] });
    const result = await foundation.accountTruth();
    assert.equal(result.availability, 'AVAILABLE');
    assert.equal(result.value?.accountState, 'FLAT');
    assert.deepEqual(result.value?.positions, []);
  });

  it('10. missing positions cannot become FLAT', async () => {
    const { foundation } = makeFoundation({ reject: [BITGET_READ_ENDPOINTS.POSITIONS] });
    const result = await foundation.accountTruth();
    assert.notEqual(result.availability, 'AVAILABLE');
    assert.equal(result.value, null);
    assert.notEqual(result.reason, null);
  });

  it('11. malformed positions cannot become FLAT', async () => {
    const { foundation } = makeFoundation({ positions: { total: '1.5' } });
    const result = await foundation.accountTruth();
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.value, null);
    assert.equal(result.reason, 'POSITION_TRUTH_MALFORMED');
  });

  it('12. malformed balances fail closed and never become zero', async () => {
    const { foundation } = makeFoundation({ accounts: [{ marginCoin: 'USDT', accountEquity: 'NaN', available: '1', locked: '0', unrealizedPL: '0' }] });
    const result = await foundation.accountTruth();
    assert.equal(result.reason, 'ACCOUNT_TRUTH_MALFORMED');
    assert.equal(result.value, null);
  });

  it('13. pending orders and fills malformation fail closed separately', async () => {
    const orders = await makeFoundation({ pendingOrders: [{ orderId: '1' }] }).foundation.accountTruth();
    assert.equal(orders.reason, 'OPEN_ORDERS_MALFORMED');
    const fills = await makeFoundation({ fills: [{ tradeId: '1' }] }).foundation.accountTruth();
    assert.equal(fills.reason, 'FILLS_MALFORMED');
  });

  it('14. fee detail is preserved entry-by-entry', async () => {
    const fill = normalizeBitgetFill(fillPayload[0]);
    assert.equal(fill.feeDetail.length, 2);
    assert.deepEqual(fill.feeDetail[0], {
      feeCoin: 'USDT', totalFee: 0.2, totalDeductionFee: 0, deduction: false,
    });
    assert.deepEqual(fill.feeDetail[1], {
      feeCoin: 'BGB', totalFee: 0.01, totalDeductionFee: 0.005, deduction: true,
    });
  });

  it('15. hedge long/short and crossed/isolated are normalized', () => {
    assert.equal(normalizeBitgetPosition({ ...positionPayload[0], holdSide: 'short' }).holdSide, 'SHORT');
    assert.equal(normalizeBitgetPosition({ ...positionPayload[0], marginMode: 'isolated' }).marginMode, 'ISOLATED');
    assert.equal(normalizeBitgetPosition({ ...positionPayload[0], marginMode: 'cross' }).marginMode, 'CROSS');
    assert.throws(() => normalizeBitgetPosition({ ...positionPayload[0], holdSide: 'net' }));
  });

  it('16. invalid numeric facts are rejected instead of coerced', () => {
    assert.throws(() => normalizeBitgetPosition({ ...positionPayload[0], total: '-1' }), 'negative quantity');
    assert.throws(() => normalizeBitgetPosition({ ...positionPayload[0], leverage: '0' }), 'zero leverage');
    assert.throws(() => normalizeBitgetPosition({ ...positionPayload[0], leverage: 'abc' }), 'NaN leverage');
    assert.throws(() => normalizeBitgetPosition({ ...positionPayload[0], markPrice: 'Infinity' }), 'infinite price');
    assert.throws(() => normalizeBitgetPosition({ ...positionPayload[0], uTime: -1 }), 'negative timestamp');
    assert.throws(() => normalizeBitgetPosition({ ...positionPayload[0], uTime: '1.5' }), 'fractional timestamp');
    assert.throws(() => normalizeBitgetOpenOrder({ ...orderPayload[0], size: '' }), 'blank size');
    assert.throws(() => normalizeBitgetOpenOrder({ ...orderPayload[0], cTime: 'not-a-time' }), 'invalid cTime');
  });

  it('17. stale and future account timestamps are never fresh', async () => {
    const stale = await makeFoundation({}, { now: () => BASE_MS + ACCOUNT_FRESHNESS_WINDOW_MS + 1 }).foundation.accountTruth();
    assert.equal(stale.value?.freshness, 'STALE');
    const future = await makeFoundation({}, { now: () => BASE_MS - 1 }).foundation.accountTruth();
    assert.equal(future.value?.freshness, 'UNKNOWN');
  });

  it('18. an unconfigured foundation fails closed without making any request', async () => {
    const { foundation, captured } = makeFoundation({}, { credential: null });
    const result = await foundation.accountTruth();
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.reason, 'BITGET_READ_CREDENTIALS_UNAVAILABLE');
    assert.equal(captured.length, 0);
    const status = foundation.status();
    assert.equal(status.configured, false);
    assert.equal(status.connected, false);
    assert.equal(status.realClientDefaultWired, false);
    assert.equal(status.realCredentialDiscovery, false);
  });

  it('19. the account snapshot stays within the five-request budget', async () => {
    const { foundation, captured } = makeFoundation();
    await foundation.accountTruth();
    assert.equal(captured.length, 5);
    assert.deepEqual(captured.map((entry) => entry.url.split('?')[0]), [
      'https://api.bitget.com/api/v2/public/time',
      'https://api.bitget.com/api/v2/mix/account/accounts',
      'https://api.bitget.com/api/v2/mix/position/all-position',
      'https://api.bitget.com/api/v2/mix/order/orders-pending',
      'https://api.bitget.com/api/v2/mix/order/fills',
    ]);
  });

  it('20. a transport failure is reported, never retried', async () => {
    const { foundation, captured } = makeFoundation({ networkFailure: true });
    const result = await foundation.accountTruth();
    assert.equal(result.availability, 'UNKNOWN');
    assert.equal(result.reason, 'BITGET_READ_TRANSPORT_FAILED');
    assert.equal(captured.length, 1, 'exactly one attempt');
  });

  it('21. the client surface exposes no mutation method', () => {
    const { transport } = makeTransport();
    const client = createBitgetAuthenticatedReadClient({
      transport,
      credential,
      clock: createBitgetReadClock(() => BASE_MS),
    });
    assert.deepEqual(Object.keys(client).sort(), [
      'getAccounts', 'getContracts', 'getPendingOrders', 'getPositions', 'getRecentFills',
      'getServerTime', 'getSymbolPrice',
    ]);
    for (const forbidden of ['placeOrder', 'cancelOrder', 'modifyOrder', 'setLeverage', 'setMarginMode', 'setPositionMode', 'transfer', 'withdraw']) {
      assert.equal(forbidden in client, false);
    }
    assert.equal(BITGET_L1A_FILL_LIMIT, 50);
  });

  it('22. private client reads sign with the injected clock and observed offset', async () => {
    const { transport, captured } = makeTransport({ serverTime: { serverTime: String(BASE_MS + 5_000) } });
    let tick = BASE_MS;
    const client = createBitgetAuthenticatedReadClient({
      transport,
      credential,
      clock: createBitgetReadClock(() => tick),
      serverTimeOffsetMs: 5_000,
    });
    tick = BASE_MS;
    await client.getAccounts();
    const header = captured[0]?.headers?.['ACCESS-TIMESTAMP'];
    assert.equal(header, String(BASE_MS + 5_000), 'signed timestamp uses the explicit offset');
  });
});

describe('Bitget L1A instrument facts', () => {
  it('23. quantity multiple and precision are separate facts; price step is endStep/10^place', () => {
    const rule = normalizeBitgetContractRule(contractPayload[0]);
    // Quantity: the venue's multiplier is the multiple; volumePlace is only precision.
    assert.equal(rule.quantityMultiple, 0.01);
    assert.equal(rule.quantityMultipleBasis, 'SIZE_MULTIPLIER');
    assert.equal(rule.quantityPrecision, 3);
    assert.equal(rule.quantityPrecisionBasis, 'VOLUME_PLACE');
    assert.notEqual(rule.quantityMultiple, 0.001, 'the precision unit must never become the multiple');
    assert.notEqual(rule.quantityMultiple, 1 / 10 ** rule.quantityPrecision);
    // The old ambiguous field must be gone from the canonical rule.
    assert.equal('quantityStep' in rule, false);
    assert.equal('quantityStepBasis' in rule, false);
    assert.equal('sizeMultiplier' in rule, false, 'one explicit quantity-multiple fact only');
    // Price: priceEndStep is the step coefficient at pricePlace decimals.
    assert.equal(rule.priceStep, 0.01);
    assert.equal(rule.priceStepBasis, 'PRICE_END_STEP_AT_PRICE_PLACE');
    assert.equal(rule.pricePrecision, 2);
    // Minimums stay verbatim.
    assert.equal(rule.minQty, 0.001);
    assert.equal(rule.minNotional, 5);
    assert.equal(rule.minLeverage, 1);
    assert.equal(rule.maxLeverage, 125);
    assert.equal(rule.status, 'normal');
    assert.equal(rule.openable, true);
    assert.equal(rule.openableReason, null);
  });

  it('24. quantity and price rules are normalized without inventing relations', () => {
    // pricePlace=1, priceEndStep=5 -> 0.5 (NOT 5, NOT 0.1)
    const priceDistinguishing = normalizeBitgetContractRule({ ...contractPayload[0], pricePlace: '1', priceEndStep: '5' });
    assert.equal(priceDistinguishing.priceStep, 0.5);
    assert.equal(priceDistinguishing.pricePrecision, 1);
    const priceUnitStep = normalizeBitgetContractRule({ ...contractPayload[0], pricePlace: '0', priceEndStep: '5' });
    assert.equal(priceUnitStep.priceStep, 5);
    assert.equal(priceUnitStep.pricePrecision, 0);
    // volumePlace=0 is precision 0, and the multiple still comes from sizeMultiplier only.
    const zeroPrecision = normalizeBitgetContractRule({ ...contractPayload[0], volumePlace: '0' });
    assert.equal(zeroPrecision.quantityPrecision, 0);
    assert.equal(zeroPrecision.quantityMultiple, 0.01);
    // A sizeMultiplier that is NOT a power of ten still survives unchanged.
    const oddMultiple = normalizeBitgetContractRule({ ...contractPayload[0], sizeMultiplier: '0.3' });
    assert.equal(oddMultiple.quantityMultiple, 0.3);
    assert.equal(oddMultiple.quantityPrecision, 3);
  });

  it('25. invalid quantity rules fail closed and never fall back to a derived multiple', () => {
    const invalidMultipliers: readonly Record<string, unknown>[] = [
      { ...contractPayload[0], sizeMultiplier: undefined },
      { ...contractPayload[0], sizeMultiplier: '' },
      { ...contractPayload[0], sizeMultiplier: '0' },
      { ...contractPayload[0], sizeMultiplier: '-1' },
      { ...contractPayload[0], sizeMultiplier: 'NaN' },
      { ...contractPayload[0], sizeMultiplier: 'Infinity' },
      { ...contractPayload[0], sizeMultiplier: 'not-a-number' },
    ];
    for (const payload of invalidMultipliers) {
      assert.throws(
        () => normalizeBitgetContractRule(payload),
        (error: unknown) => (error as { reason?: string }).reason === 'MARKET_RULES_UNKNOWN',
        `sizeMultiplier=${String(payload.sizeMultiplier)}`,
      );
    }
    const invalidPrecisions: readonly Record<string, unknown>[] = [
      { ...contractPayload[0], volumePlace: undefined },
      { ...contractPayload[0], volumePlace: '-1' },
      { ...contractPayload[0], volumePlace: '1.5' },
      { ...contractPayload[0], volumePlace: 'NaN' },
      { ...contractPayload[0], volumePlace: 'not-a-number' },
    ];
    for (const payload of invalidPrecisions) {
      assert.throws(
        () => normalizeBitgetContractRule(payload),
        (error: unknown) => (error as { reason?: string }).reason === 'MARKET_RULES_UNKNOWN',
        `volumePlace=${String(payload.volumePlace)}`,
      );
    }
    assert.throws(() => normalizeBitgetContractRule({ ...contractPayload[0], priceEndStep: '0' }));
    assert.throws(() => normalizeBitgetContractRule({ ...contractPayload[0], priceEndStep: undefined }));
    assert.throws(() => normalizeBitgetContractRule({ ...contractPayload[0], pricePlace: '99' }));
    assert.throws(() => normalizeBitgetContractRule({ ...contractPayload[0], pricePlace: '-1' }));
    assert.throws(() => normalizeBitgetContractRule({ ...contractPayload[0], minLever: '150', maxLever: '100' }));
    assert.throws(() => normalizeBitgetContractRule({ ...contractPayload[0], minTradeNum: '' }));
    assert.throws(() => normalizeBitgetContractRule({ ...contractPayload[0], minTradeUSDT: '-5' }));
  });

  it('26. the precision unit can never be re-adopted as the quantity multiple (blind-spot guard)', () => {
    const rule = normalizeBitgetContractRule(contractPayload[0]);
    assert.equal(rule.quantityPrecision, 3);
    assert.equal(rule.quantityMultiple, 0.01);
    assert.notEqual(rule.quantityMultiple, 0.001);
    assert.notEqual(rule.quantityMultiple, 10 ** -rule.quantityPrecision);
    assert.deepEqual(
      Object.keys(rule).filter((key) => /quantity/i.test(key)).sort(),
      ['quantityMultiple', 'quantityMultipleBasis', 'quantityPrecision', 'quantityPrecisionBasis'],
    );
  });

  it('27. a valid instrument snapshot carries prices, rules and freshness', async () => {
    const { foundation, captured } = makeFoundation();
    const result = await foundation.instrumentFacts('ETHUSDT');
    assert.equal(result.availability, 'AVAILABLE');
    const facts = result.value;
    assert.ok(facts !== null);
    assert.equal(facts.symbol, 'ETHUSDT');
    assert.equal(facts.markPrice, 2010.5);
    assert.equal(facts.indexPrice, 2008.75);
    assert.equal(facts.marketPrice, 2009.5);
    assert.equal(facts.priceTimestamp, BASE_MS);
    assert.equal(facts.freshness, 'FRESH');
    assert.equal(facts.contractStatus, 'normal');
    assert.equal(facts.contractOpenable, true);
    assert.equal(facts.minQty, 0.001);
    assert.equal(facts.minNotional, 5);
    assert.equal(facts.quantityMultiple, 0.01);
    assert.equal(facts.quantityPrecision, 3);
    assert.notEqual(facts.quantityMultiple, 10 ** -facts.quantityPrecision);
    assert.equal(facts.priceStep, 0.01);
    assert.equal(facts.pricePrecision, 2);
    assert.equal(captured.length, 3, 'server time + contracts + symbol price');
  });

  it('28. incomplete quantity rules block a new entry', async () => {
    const accountTruth = await makeFoundation().foundation.accountTruth();
    for (const broken of [
      { ...contractPayload[0], sizeMultiplier: undefined },
      { ...contractPayload[0], sizeMultiplier: '0' },
      { ...contractPayload[0], volumePlace: undefined },
      { ...contractPayload[0], minTradeNum: undefined },
    ]) {
      const facts = await makeFoundation({ contracts: [broken] }).foundation.instrumentFacts('ETHUSDT');
      assert.equal(facts.availability, 'UNAVAILABLE');
      assert.equal(facts.reason, 'MARKET_RULES_UNKNOWN');
      const readiness = evaluateBitgetNewEntryReadiness({ accountTruth, instrumentFacts: facts });
      assert.equal(readiness.safeToOpen, false);
      assert.equal(readiness.blockers.includes('MARKET_RULES_UNKNOWN'), true);
    }
  });

  it('29. an unknown symbol fails closed', async () => {
    const { foundation } = makeFoundation({ contracts: [{ ...contractPayload[0], symbol: 'BTCUSDT' }] });
    const result = await foundation.instrumentFacts('ETHUSDT');
    assert.equal(result.availability, 'UNKNOWN');
    assert.equal(result.reason, 'MARKET_RULES_UNKNOWN');
    assert.equal(result.value, null);
  });

  it('30. a malformed symbol price fails closed', async () => {
    const { foundation } = makeFoundation({ symbolPrice: [{ symbol: 'ETHUSDT', price: 'x', indexPrice: '1', markPrice: '1' }] });
    const result = await foundation.instrumentFacts('ETHUSDT');
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.reason, 'INSTRUMENT_FACTS_MALFORMED');
  });

  it('31. a missing or future price timestamp is never fresh', async () => {
    const missing = normalizeBitgetSymbolPrice({ symbol: 'ETHUSDT', price: '1', indexPrice: '1', markPrice: '1' }, 'ETHUSDT');
    assert.equal(missing.priceTimestamp, null);
    const { foundation } = makeFoundation({ symbolPrice: [{ symbol: 'ETHUSDT', price: '1', indexPrice: '1', markPrice: '1' }] });
    const result = await foundation.instrumentFacts('ETHUSDT');
    assert.equal(result.value?.freshness, 'UNKNOWN');
    const future = await makeFoundation({}, { now: () => BASE_MS - 1 }).foundation.instrumentFacts('ETHUSDT');
    assert.equal(future.value?.freshness, 'UNKNOWN');
    const stale = await makeFoundation({}, { now: () => BASE_MS + MARK_PRICE_FRESHNESS_WINDOW_MS + 1 }).foundation.instrumentFacts('ETHUSDT');
    assert.equal(stale.value?.freshness, 'STALE');
  });

  it('32. only explicitly safe contract statuses may open, everything else is blocked', async () => {
    const { foundation } = makeFoundation();
    const accountTruth = await foundation.accountTruth();
    for (const status of ['maintain', 'limit_open', 'restrictedAPI', 'off', 'listed', 'something-new']) {
      const facts = await makeFoundation({
        contracts: [{ ...contractPayload[0], symbolStatus: status }],
      }).foundation.instrumentFacts('ETHUSDT');
      const readiness = evaluateBitgetNewEntryReadiness({ accountTruth, instrumentFacts: facts });
      assert.equal(readiness.safeToOpen, false, status);
      assert.equal(readiness.blockers.includes('CONTRACT_NOT_OPENABLE'), status === 'something-new' ? false : true, status);
    }
    const healthy = await makeFoundation().foundation.instrumentFacts('ETHUSDT');
    assert.equal(evaluateBitgetNewEntryReadiness({ accountTruth, instrumentFacts: healthy }).safeToOpen, true);
  });

  it('33. stale or unknown mark price blocks opening, but never gates close/reduce', async () => {
    const accountTruth = await makeFoundation().foundation.accountTruth();
    const stale = await makeFoundation({}, { now: () => BASE_MS + MARK_PRICE_FRESHNESS_WINDOW_MS + 1 }).foundation.instrumentFacts('ETHUSDT');
    const staleReadiness = evaluateBitgetNewEntryReadiness({ accountTruth, instrumentFacts: stale });
    assert.equal(staleReadiness.safeToOpen, false);
    assert.equal(staleReadiness.blockers.includes('MARK_PRICE_STALE'), true);
    assert.equal(staleReadiness.closeOrReduceBlockedByEntryFreshness, false);

    const unknown = await makeFoundation({
      symbolPrice: [{ symbol: 'ETHUSDT', price: '1', indexPrice: '1', markPrice: '1' }],
    }).foundation.instrumentFacts('ETHUSDT');
    const unknownReadiness = evaluateBitgetNewEntryReadiness({ accountTruth, instrumentFacts: unknown });
    assert.equal(unknownReadiness.blockers.includes('MARK_PRICE_UNKNOWN'), true);
    assert.equal(unknownReadiness.closeOrReduceBlockedByEntryFreshness, false);
  });

  it('34. an unavailable account truth blocks opening as UNKNOWN, not as FLAT', async () => {
    const unavailableAccount = await makeFoundation({ positions: { bad: true } }).foundation.accountTruth();
    const facts = await makeFoundation().foundation.instrumentFacts('ETHUSDT');
    const readiness = evaluateBitgetNewEntryReadiness({ accountTruth: unavailableAccount, instrumentFacts: facts });
    assert.equal(readiness.safeToOpen, false);
    assert.equal(readiness.blockers.includes('POSITION_TRUTH_UNKNOWN'), true);
    assert.equal(unavailableAccount.value, null);
  });
});

describe('Bitget L1A clock and timestamp boundary', () => {
  it('35. a valid server time observation yields the offset', () => {
    const observation = observeBitgetServerTime({
      serverTimeMs: BASE_MS + 1_200, requestStartedMs: BASE_MS - 100, responseReceivedMs: BASE_MS,
    });
    assert.equal(observation.offsetMs, 1_200);
    assert.equal(observation.roundTripMs, 100);
    assert.equal(observation.serverTimeMs, BASE_MS + 1_200);
  });

  it('36. invalid server time, absurd offsets and slow round trips fail closed', () => {
    assert.throws(() => observeBitgetServerTime({ serverTimeMs: 'nope', requestStartedMs: BASE_MS, responseReceivedMs: BASE_MS }), /BITGET_SERVER_TIME_INVALID/);
    assert.throws(() => observeBitgetServerTime({ serverTimeMs: -1, requestStartedMs: BASE_MS, responseReceivedMs: BASE_MS }), /BITGET_SERVER_TIME_INVALID/);
    assert.throws(() => observeBitgetServerTime({ serverTimeMs: BASE_MS + 1.5, requestStartedMs: BASE_MS, responseReceivedMs: BASE_MS }), /BITGET_SERVER_TIME_INVALID/);
    assert.throws(() => observeBitgetServerTime({
      serverTimeMs: BASE_MS + MAX_BITGET_SERVER_TIME_SKEW_MS + 1, requestStartedMs: BASE_MS, responseReceivedMs: BASE_MS,
    }), /BITGET_CLOCK_SKEW_INVALID/);
    assert.throws(() => observeBitgetServerTime({
      serverTimeMs: BASE_MS, requestStartedMs: BASE_MS, responseReceivedMs: BASE_MS - 5,
    }), /BITGET_SERVER_TIME_INVALID/);
  });

  it('37. timestamps are deterministic and come from the injected clock only', () => {
    const clock = createBitgetReadClock(() => BASE_MS);
    assert.equal(signedBitgetTimestamp(clock, 0), String(BASE_MS));
    assert.equal(signedBitgetTimestamp(clock, 0), signedBitgetTimestamp(clock, 0));
    assert.equal(signedBitgetTimestamp(clock, 2_500), String(BASE_MS + 2_500));
    const other = createBitgetReadClock(() => BASE_MS + 9_000);
    assert.equal(signedBitgetTimestamp(other, 0), String(BASE_MS + 9_000));
    assert.throws(() => signedBitgetTimestamp(clock, MAX_BITGET_SERVER_TIME_SKEW_MS + 1), /BITGET_CLOCK_SKEW_INVALID/);
    assert.throws(() => signedBitgetTimestamp(clock, 1.5), /BITGET_CLOCK_SKEW_INVALID/);
    const nanClock = createBitgetReadClock(() => Number.NaN);
    assert.throws(() => nanClock.now(), /OBSERVATION_TIME_INVALID/);
    assert.equal(BITGET_SIGNED_TIMESTAMP_WINDOW_MS, 30_000);
    assert.equal(MAX_BITGET_SERVER_TIME_SKEW_MS, 30_000);
  });

  it('38. the signed header and the signature preimage use one identical timestamp', async () => {
    const { transport, captured } = makeTransport();
    const client = createBitgetAuthenticatedReadClient({
      transport, credential, clock: createBitgetReadClock(() => BASE_MS),
    });
    await client.getPendingOrders();
    const timestamp = captured[0]?.headers?.['ACCESS-TIMESTAMP'];
    assert.equal(timestamp, String(BASE_MS));
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', FIXTURE_BITGET_SECRET)
      .update(`${timestamp}GET/api/v2/mix/order/orders-pending?productType=USDT-FUTURES`, 'utf8')
      .digest('base64');
    assert.equal(captured[0]?.headers?.['ACCESS-SIGN'], expected);
  });

  it('39. clock and transport failures surface as their own reasons', async () => {
    const skew = await makeFoundation({ serverTime: { serverTime: String(BASE_MS + MAX_BITGET_SERVER_TIME_SKEW_MS + 5_000) } }).foundation.accountTruth();
    assert.equal(skew.reason, 'BITGET_CLOCK_SKEW_INVALID');
    const invalid = await makeFoundation({ serverTime: { serverTime: 'not-a-time' } }).foundation.accountTruth();
    assert.equal(invalid.reason, 'BITGET_SERVER_TIME_INVALID');
    const missing = await makeFoundation({ serverTime: {} }).foundation.accountTruth();
    assert.equal(missing.reason, 'BITGET_SERVER_TIME_INVALID');
  });
});

describe('Bitget L1A security boundary', () => {
  it('40. no fixture credential, signature or raw exchange message reaches a serialized result', async () => {
    const { foundation } = makeFoundation();
    const accountTruth = await foundation.accountTruth();
    const facts = await foundation.instrumentFacts('ETHUSDT');
    const readiness = evaluateBitgetNewEntryReadiness({ accountTruth, instrumentFacts: facts });
    assertNoFixtureLeak(accountTruth);
    assertNoFixtureLeak(facts);
    assertNoFixtureLeak(readiness);
    assertNoFixtureLeak(foundation.status());
  });

  it('41. errors carry only sanitized reasons', async () => {
    const rejected = await makeFoundation({ reject: [BITGET_READ_ENDPOINTS.ACCOUNTS] }).foundation.accountTruth();
    assertNoFixtureLeak(rejected);
    const network = await makeFoundation({ networkFailure: true }).foundation.accountTruth();
    assertNoFixtureLeak(network);
    const malformed = await makeFoundation({ positions: { bad: true } }).foundation.accountTruth();
    assertNoFixtureLeak(malformed);
    const { transport, captured } = makeTransport();
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.ACCOUNTS,
      query: [{ name: 'productType', value: 'USDT-FUTURES' }],
      credential,
      timestamp: String(BASE_MS),
    });
    assertNoFixtureLeak(captured[0]?.url);
  });

  it('42. the foundation never wires a real client and never discovers credentials', async () => {
    const { foundation } = makeFoundation();
    await foundation.accountTruth();
    const status = foundation.status();
    assert.equal(status.realClientDefaultWired, false);
    assert.equal(status.realCredentialDiscovery, false);
    assert.equal(status.configured, true);
    assert.equal(status.lastObservedAt, BASE_MS);
    assert.equal(status.reason, null);
  });

  it('43. no runtime file references a production transport or an environment credential loader', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = 'src/runtime/bitget';
    for (const file of readdirSync(dir)) {
      // Comments are stripped first: the module headers legitimately *mention* these forbidden
      // constructs when documenting that they are not implemented.
      const raw = readFileSync(`${dir}/${file}`, 'utf8');
      const source = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
      assert.equal(/process\.env\s*\[/.test(source), false, `env lookup in ${file}`);
      assert.equal(/dotenv/.test(source), false, `dotenv in ${file}`);
      // The transport module defines the closed production factory and the real-read runner is the
      // single intended production consumer of it; every other runtime file must stay unwired.
      if (file === 'BitgetReadTransport.ts' || file === 'BitgetRealReadExecutionRunner.ts') continue;
      assert.equal(/createProductionBitgetReadTransport\s*\(/.test(source), false, `production transport in ${file}`);
    }
  });

  it('44. deferred read families are declared but not callable', async () => {
    const { transport, captured } = makeTransport();
    for (const deferred of BITGET_READ_ENDPOINTS_REQUIRING_L1A_VERIFICATION) {
      const error = await errorOf(transport.get({ endpoint: deferred as never, query: [] }));
      assert.equal(error?.code, 'BITGET_READ_REQUEST_INVALID', deferred);
    }
    assert.equal(captured.length, 0);
    assert.equal(BITGET_READ_ENDPOINTS_REQUIRING_L1A_VERIFICATION.length, 3);
  });
});
