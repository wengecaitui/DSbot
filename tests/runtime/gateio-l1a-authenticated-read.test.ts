/** Gate.io L1A tests are entirely offline and use only injected transports and clocks. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  GATEIO_L0_INITIAL_CONTRACT,
  GATEIO_READ_ENDPOINTS,
  type GateIoReadEndpoint,
  type GateIoReadTransport,
  type GateIoReadTransportRequest,
} from '../../src/runtime/gateio/GateIoReadContracts';
import {
  MAX_GATEIO_SERVER_TIME_OBSERVATION_AGE_MS,
  MAX_GATEIO_SERVER_TIME_RTT_MS,
  GateIoReadClockError,
  createGateIoReadClock,
  observeGateIoServerTime,
  signedGateIoTimestamp,
} from '../../src/runtime/gateio/GateIoReadClock';
import {
  GateIoReadClientError,
  createGateIoAuthenticatedReadClient,
  type GateIoReadIdentity,
} from '../../src/runtime/gateio/GateIoAuthenticatedReadClient';
import {
  GATEIO_KNOWN_CONTRACT_STATUSES,
  MAX_GATEIO_ACCOUNT_TRUTH_GETS,
  MAX_GATEIO_INSTRUMENT_FACTS_GETS,
  MAX_GATEIO_L1A_COMBINED_GETS,
  createGateIoAuthenticatedReadFoundation,
  evaluateGateIoEntryReadiness,
  normalizeGateIoAccount,
  normalizeGateIoContract,
  normalizeGateIoOpenOrder,
  normalizeGateIoPosition,
  normalizeGateIoTicker,
  normalizeGateIoTrade,
  type GateIoCanonicalAccountTruth,
  type GateIoCanonicalInstrumentFacts,
  type GateIoFoundationReadResult,
} from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import {
  GateIoReadTransportError,
} from '../../src/runtime/gateio/GateIoReadTransport';

const BASE_MS = 1_800_000_000_000;
const FIXTURE_API_KEY = 'FIXTURE_GATEIO_KEY_DO_NOT_LEAK';
const FIXTURE_SECRET = 'FIXTURE_GATEIO_SECRET_DO_NOT_LEAK';
const FIXTURE_GATE_MESSAGE = 'FIXTURE_RAW_GATE_MESSAGE_DO_NOT_LEAK';
const credential = Object.freeze({ apiKey: FIXTURE_API_KEY, secretKey: FIXTURE_SECRET });
const identity: GateIoReadIdentity = Object.freeze({
  exchange: 'gateio', accountId: 'explicit-gate-account', settle: 'USDT',
});

const accountFixture = Object.freeze({
  currency: 'USDT', total: '1000.5', available: '900.25', unrealised_pnl: '4.5',
  order_margin: '10', in_dual_mode: false, position_mode: 'single', margin_mode: 'cross',
});
const positionFixture = Object.freeze({
  contract: GATEIO_L0_INITIAL_CONTRACT, size: '2', mode: 'single', pos_margin_mode: 'cross',
  leverage: '10', entry_price: '2000', mark_price: '2010', liq_price: '1600',
  unrealised_pnl: '20', realised_pnl: '1', margin: '400', update_time: '1800000000',
});
const orderFixture = Object.freeze({
  id: '9223372036854775806', text: 't-client-1', contract: GATEIO_L0_INITIAL_CONTRACT,
  size: '3', left: '2', price: '1900', fill_price: '1901', tif: 'gtc', status: 'open',
  is_reduce_only: true, is_close: false, create_time: '1800000000', update_time: '1800000001',
});
const tradeFixture = Object.freeze({
  id: '9223372036854775805', order_id: '9223372036854775806',
  contract: GATEIO_L0_INITIAL_CONTRACT, size: '-2', close_size: '1', price: '2010',
  text: 't-client-1', fee: '-0.4', point_fee: '-0.01', role: 'maker',
  trade_value: '4020', create_time: '1800000002',
});
const contractFixture = Object.freeze({
  name: GATEIO_L0_INITIAL_CONTRACT, status: 'trading', in_delisting: false,
  quanto_multiplier: '0.00001', order_size_min: '1', order_size_max: '1000000',
  enable_decimal: false, order_price_round: '0.01', mark_price_round: '0.001',
  leverage_min: '1', leverage_max: '100', maker_fee_rate: '-0.0002', taker_fee_rate: '0.0005',
});
const tickerFixture = Object.freeze([{
  contract: GATEIO_L0_INITIAL_CONTRACT, last: '2009', mark_price: '2010',
  index_price: '2008', funding_rate: '0.0001',
}]);

function transport(
  respond: (request: GateIoReadTransportRequest) => unknown | Promise<unknown>,
): { readonly value: GateIoReadTransport; readonly requests: GateIoReadTransportRequest[] } {
  const requests: GateIoReadTransportRequest[] = [];
  return {
    requests,
    value: Object.freeze({
      async get(request: GateIoReadTransportRequest): Promise<unknown> {
        requests.push(request);
        return respond(request);
      },
    }),
  };
}

function fixtureFor(endpoint: GateIoReadEndpoint): unknown {
  switch (endpoint) {
    case GATEIO_READ_ENDPOINTS.SERVER_TIME: return { server_time: BASE_MS };
    case GATEIO_READ_ENDPOINTS.ACCOUNTS: return accountFixture;
    case GATEIO_READ_ENDPOINTS.POSITIONS: return [positionFixture];
    case GATEIO_READ_ENDPOINTS.OPEN_ORDERS: return [orderFixture];
    case GATEIO_READ_ENDPOINTS.MY_TRADES: return [tradeFixture];
    case GATEIO_READ_ENDPOINTS.CONTRACT: return contractFixture;
    case GATEIO_READ_ENDPOINTS.TICKERS: return tickerFixture;
  }
}

function foundation(overrides: {
  readonly respond?: (request: GateIoReadTransportRequest) => unknown | Promise<unknown>;
  readonly now?: () => number;
  readonly withCredential?: boolean;
} = {}) {
  const injected = transport(overrides.respond ?? ((request) => fixtureFor(request.endpoint)));
  return {
    requests: injected.requests,
    value: createGateIoAuthenticatedReadFoundation({
      transport: injected.value,
      identity,
      credential: overrides.withCredential === false ? null : credential,
      now: overrides.now ?? (() => BASE_MS),
    }),
  };
}

function availableAccount(
  value: GateIoCanonicalAccountTruth,
): GateIoFoundationReadResult<GateIoCanonicalAccountTruth> {
  return Object.freeze({ availability: 'AVAILABLE', value, reason: null, failureProvenance: null });
}

function availableInstrument(
  value: GateIoCanonicalInstrumentFacts,
): GateIoFoundationReadResult<GateIoCanonicalInstrumentFacts> {
  return Object.freeze({ availability: 'AVAILABLE', value, reason: null, failureProvenance: null });
}

async function clientError(action: Promise<unknown>): Promise<GateIoReadClientError> {
  try {
    await action;
  } catch (error) {
    assert.equal(error instanceof GateIoReadClientError, true);
    return error as GateIoReadClientError;
  }
  assert.fail('expected GateIoReadClientError');
}

describe('Gate.io L1A deterministic clock', () => {
  it('observes midpoint offset and emits Unix seconds', () => {
    const observation = observeGateIoServerTime({
      requestStartedMs: BASE_MS, serverTimeMs: BASE_MS + 2_050, responseReceivedMs: BASE_MS + 100,
    });
    assert.deepEqual(observation, {
      requestStartedMs: BASE_MS, serverTimeMs: BASE_MS + 2_050,
      responseReceivedMs: BASE_MS + 100, midpointMs: BASE_MS + 50,
      offsetMs: 2_000, roundTripMs: 100,
    });
    assert.equal(signedGateIoTimestamp(
      createGateIoReadClock(() => BASE_MS + 100), observation,
    ), '1800000002');
  });

  it('rejects stale, excessive RTT, malformed, negative and unreasonable observations', () => {
    const fresh = observeGateIoServerTime({
      requestStartedMs: BASE_MS, serverTimeMs: BASE_MS, responseReceivedMs: BASE_MS,
    });
    assert.throws(() => signedGateIoTimestamp(
      createGateIoReadClock(() => BASE_MS + MAX_GATEIO_SERVER_TIME_OBSERVATION_AGE_MS + 1), fresh,
    ), (error: unknown) => error instanceof GateIoReadClockError
      && error.reason === 'GATEIO_SERVER_TIME_OBSERVATION_STALE');
    assert.throws(() => observeGateIoServerTime({
      requestStartedMs: BASE_MS,
      serverTimeMs: BASE_MS,
      responseReceivedMs: BASE_MS + MAX_GATEIO_SERVER_TIME_RTT_MS + 1,
    }), /GATEIO_SERVER_TIME_RTT_INVALID/);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1, 0]) {
      assert.throws(() => observeGateIoServerTime({
        requestStartedMs: BASE_MS, serverTimeMs: invalid, responseReceivedMs: BASE_MS,
      }));
    }
    assert.throws(() => observeGateIoServerTime({
      requestStartedMs: BASE_MS + 1, serverTimeMs: BASE_MS, responseReceivedMs: BASE_MS,
    }), /GATEIO_SERVER_TIME_RTT_INVALID/);
    assert.throws(() => observeGateIoServerTime({
      requestStartedMs: BASE_MS, serverTimeMs: BASE_MS + 86_400_001, responseReceivedMs: BASE_MS,
    }), /GATEIO_SERVER_TIME_OFFSET_INVALID/);
  });

  it('rejects hidden-invalid injected local time', () => {
    assert.throws(() => createGateIoReadClock(() => Number.NaN).now(), /OBSERVATION_TIME_INVALID/);
  });
});

describe('Gate.io L1A authenticated read client', () => {
  function clientWith(
    readTransport: GateIoReadTransport,
    injectedCredential: typeof credential | null = credential,
  ) {
    const observation = observeGateIoServerTime({
      requestStartedMs: BASE_MS, serverTimeMs: BASE_MS + 2_000, responseReceivedMs: BASE_MS,
    });
    return createGateIoAuthenticatedReadClient({
      transport: readTransport,
      credential: injectedCredential,
      clock: createGateIoReadClock(() => BASE_MS),
      serverTimeObservation: () => observation,
    });
  }

  it('public time carries no auth and authenticated reads carry derived Unix seconds', async () => {
    const injected = transport((request) => fixtureFor(request.endpoint));
    const client = clientWith(injected.value);
    await client.getServerTime();
    await client.getAccount();
    assert.equal(injected.requests[0]?.credential, undefined);
    assert.equal(injected.requests[0]?.timestamp, undefined);
    assert.equal(injected.requests[1]?.credential, credential);
    assert.equal(injected.requests[1]?.timestamp, '1800000002');
  });

  it('missing credential fails before transport entry', async () => {
    const injected = transport(() => accountFixture);
    const error = await clientError(clientWith(injected.value, null).getAccount());
    assert.equal(error.reason, 'GATEIO_READ_CREDENTIALS_UNAVAILABLE');
    assert.equal(injected.requests.length, 0);
  });

  it('exposes exactly seven GET read methods and no mutation method', () => {
    const injected = transport((request) => fixtureFor(request.endpoint));
    assert.deepEqual(Object.keys(clientWith(injected.value)).sort(), [
      'getAccount', 'getContract', 'getOpenOrders', 'getPositions', 'getRecentTrades',
      'getServerTime', 'getTicker',
    ]);
  });

  it('preserves safe failure provenance and each actual endpoint', async () => {
    const cases: readonly [keyof ReturnType<typeof clientWith>, GateIoReadEndpoint][] = [
      ['getServerTime', GATEIO_READ_ENDPOINTS.SERVER_TIME],
      ['getAccount', GATEIO_READ_ENDPOINTS.ACCOUNTS],
      ['getPositions', GATEIO_READ_ENDPOINTS.POSITIONS],
      ['getOpenOrders', GATEIO_READ_ENDPOINTS.OPEN_ORDERS],
      ['getRecentTrades', GATEIO_READ_ENDPOINTS.MY_TRADES],
      ['getContract', GATEIO_READ_ENDPOINTS.CONTRACT],
      ['getTicker', GATEIO_READ_ENDPOINTS.TICKERS],
    ];
    for (const [method, endpoint] of cases) {
      const injected = transport((request) => {
        throw new GateIoReadTransportError(
          'GATEIO_READ_API_REJECTED', request.endpoint, 401, 'INVALID_KEY',
        );
      });
      const client = clientWith(injected.value);
      const error = await clientError(client[method]());
      assert.deepEqual(error.failureProvenance, {
        reason: 'GATEIO_READ_API_REJECTED', endpoint,
        transportCode: 'GATEIO_READ_API_REJECTED', httpStatus: 401, gateLabel: 'INVALID_KEY',
      });
    }
  });
});

describe('Gate.io L1A strict canonical normalization', () => {
  it('normalizes classic and unified-account-compatible facts without inventing zeroes', () => {
    assert.deepEqual(normalizeGateIoAccount(accountFixture), {
      currency: 'USDT', total: 1000.5, available: 900.25, unrealizedPnl: 4.5,
      orderMargin: 10, inDualMode: false, positionMode: 'single', marginMode: 'cross',
    });
    assert.deepEqual(normalizeGateIoAccount({
      currency: 'usdt', total: '8', available: '7', in_dual_mode: true, position_mode: 'dual',
    }), {
      currency: 'USDT', total: 8, available: 7, unrealizedPnl: null, orderMargin: null,
      inDualMode: true, positionMode: 'dual', marginMode: null,
    });
    assert.throws(() => normalizeGateIoAccount({ currency: 'BTC', total: '1', available: '1' }));
    assert.throws(() => normalizeGateIoAccount({ currency: 'USDT', available: '1' }));
    assert.throws(() => normalizeGateIoAccount({ currency: 'USDT', total: '', available: '1' }));
    assert.throws(() => normalizeGateIoAccount({
      currency: 'USDT', total: '1', available: '1', order_margin: '',
    }));
  });

  it('preserves signed single/dual positions and validates nonzero prices', () => {
    assert.equal(normalizeGateIoPosition(positionFixture).signedSize, 2);
    assert.equal(normalizeGateIoPosition({ ...positionFixture, size: '-2' }).signedSize, -2);
    assert.equal(normalizeGateIoPosition({ ...positionFixture, mode: 'dual_long' }).mode, 'dual_long');
    assert.equal(normalizeGateIoPosition({
      ...positionFixture, size: '-2', mode: 'dual_short', hedge_status: 'ignored',
    }).mode, 'dual_short');
    const zero = normalizeGateIoPosition({
      ...positionFixture, size: '0', entry_price: null, mark_price: null,
    });
    assert.equal(zero.signedSize, 0);
    assert.throws(() => normalizeGateIoPosition({ ...positionFixture, mode: 'unknown' }));
    assert.throws(() => normalizeGateIoPosition({ ...positionFixture, entry_price: '0' }));
    assert.throws(() => normalizeGateIoPosition({ ...positionFixture, mark_price: '' }));
    assert.throws(() => normalizeGateIoPosition({ ...positionFixture, mode: 'dual_short', size: '2' }));
  });

  it('preserves order sign, reduce-only and close as distinct factual fields', () => {
    const buy = normalizeGateIoOpenOrder(orderFixture);
    const sell = normalizeGateIoOpenOrder({
      ...orderFixture, id: '2', size: '-3', is_reduce_only: false, is_close: true,
    });
    assert.equal(buy.signedSize, 3);
    assert.equal(buy.reduceOnly, true);
    assert.equal(buy.close, false);
    assert.equal(sell.signedSize, -3);
    assert.equal(sell.reduceOnly, false);
    assert.equal(sell.close, true);
    assert.throws(() => normalizeGateIoOpenOrder({ ...orderFixture, status: 'finished' }));
    assert.throws(() => normalizeGateIoOpenOrder({ ...orderFixture, left: '' }));
  });

  it('preserves exact int64 strings, maker/taker roles, fee, point fee and close size', () => {
    const maker = normalizeGateIoTrade(tradeFixture);
    assert.equal(maker.tradeId, '9223372036854775805');
    assert.equal(maker.orderId, '9223372036854775806');
    assert.equal(maker.fee, -0.4);
    assert.equal(maker.pointFee, -0.01);
    assert.equal(maker.closeSize, 1);
    assert.equal(normalizeGateIoTrade({
      ...tradeFixture, id: 42, order_id: 41, role: 'taker',
    }).role, 'taker');
    assert.throws(() => normalizeGateIoTrade({
      ...tradeFixture, id: Number.MAX_SAFE_INTEGER + 1,
    }));
    assert.throws(() => normalizeGateIoTrade({ ...tradeFixture, role: 'unknown' }));
  });

  it('preserves signed close_size and fractional trade timestamps', async () => {
    // P1-1: Gate reports close_size as signed — 0, positive and negative are all legal facts.
    for (const [raw, expected] of [['0', 0], ['1', 1], ['-1', -1], ['2.5', 2.5], ['-0.75', -0.75]] as const) {
      assert.equal(normalizeGateIoTrade({ ...tradeFixture, close_size: raw }).closeSize, expected);
    }
    const signed = normalizeGateIoTrade({ ...tradeFixture, close_size: '-1' });
    assert.equal(signed.closeSize, -1);
    assert.equal(signed.signedSize, -2, 'signedSize stays exchange-native');
    assert.equal(Object.isFrozen(signed), true);
    assert.deepEqual(Object.keys(signed).sort(), [
      'clientText', 'closeSize', 'contract', 'createdAt', 'fee', 'orderId', 'pointFee', 'price',
      'role', 'signedSize', 'tradeId', 'tradeValue',
    ], 'no open/close direction may be invented');
    for (const bad of ['', ' ', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 'abc']) {
      assert.throws(() => normalizeGateIoTrade({ ...tradeFixture, close_size: bad }));
    }

    // P1-2: create_time is a double — fractional seconds survive, never rounded or truncated.
    for (const raw of [1514764800.123, '1514764800.123'] as const) {
      const trade = normalizeGateIoTrade({ ...tradeFixture, create_time: raw });
      assert.equal(trade.createdAt, 1514764800.123);
      assert.notEqual(Math.floor(trade.createdAt), trade.createdAt);
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, -0.5,
                       '', ' ', 'junk', '12abc', '1e3', '1514764800.', '.5', null, undefined]) {
      assert.throws(() => normalizeGateIoTrade({ ...tradeFixture, create_time: bad }));
    }
    // the same epoch rule applies to the other Gate doubles
    assert.equal(normalizeGateIoOpenOrder({ ...orderFixture, create_time: '1514764800.5' }).createdAt, 1514764800.5);
    assert.equal(normalizeGateIoOpenOrder({ ...orderFixture, update_time: '1514764800.25' }).updatedAt, 1514764800.25);
    assert.equal(normalizeGateIoOpenOrder({ ...orderFixture, update_time: null }).updatedAt, null);
    assert.equal(normalizeGateIoPosition({ ...positionFixture, update_time: '1514764800.125' }).updatedAt, 1514764800.125);
    assert.throws(() => normalizeGateIoPosition({ ...positionFixture, update_time: '0' }));

    // and it reaches the canonical account truth unchanged
    const fractional = foundation({ respond(request) {
      return request.endpoint === GATEIO_READ_ENDPOINTS.MY_TRADES
        ? [{ ...tradeFixture, close_size: '-1', create_time: '1514764800.123' }]
        : fixtureFor(request.endpoint);
    } });
    const truth = await fractional.value.accountTruth();
    assert.equal(truth.availability, 'AVAILABLE');
    assert.equal(truth.value?.recentTrades[0]?.closeSize, -1);
    assert.equal(truth.value?.recentTrades[0]?.createdAt, 1514764800.123);
  });

  it('preserves exchange-native Gate contract units and only opens trading/non-delisting', () => {
    const rule = normalizeGateIoContract(contractFixture);
    assert.equal(rule.multiplier, 0.00001);
    assert.equal(rule.minSize, 1);
    assert.equal(rule.maxSize, 1_000_000);
    assert.equal(rule.decimalSize, false);
    assert.equal(rule.priceStep, 0.01);
    assert.equal(rule.openable, true);
    for (const status of GATEIO_KNOWN_CONTRACT_STATUSES) {
      const current = normalizeGateIoContract({ ...contractFixture, status });
      assert.equal(current.openable, status === 'trading');
    }
    assert.equal(normalizeGateIoContract({
      ...contractFixture, status: 'trading', in_delisting: true,
    }).openable, false);
    assert.equal(normalizeGateIoContract({ ...contractFixture, status: 'future_status' }).openable, false);
  });

  it('requires exactly one matching ticker and a positive factual mark price', () => {
    assert.equal(normalizeGateIoTicker(tickerFixture).markPrice, 2010);
    assert.throws(() => normalizeGateIoTicker([]));
    assert.throws(() => normalizeGateIoTicker([...tickerFixture, ...tickerFixture]));
    assert.throws(() => normalizeGateIoTicker([{ ...tickerFixture[0], contract: 'BTC_USDT' }]));
    assert.throws(() => normalizeGateIoTicker([{ ...tickerFixture[0], mark_price: 'NaN' }]));
    assert.throws(() => normalizeGateIoTicker([{ ...tickerFixture[0], mark_price: '0' }]));
  });
});

describe('Gate.io L1A foundation truth and readiness', () => {
  it('enforces fixed budgets, sequence, queries and immutable AVAILABLE truth', async () => {
    const accountRead = foundation();
    const account = await accountRead.value.accountTruth();
    assert.equal(account.availability, 'AVAILABLE');
    assert.equal(accountRead.requests.length, MAX_GATEIO_ACCOUNT_TRUTH_GETS);
    assert.deepEqual(accountRead.requests.map((entry) => entry.endpoint), [
      GATEIO_READ_ENDPOINTS.SERVER_TIME, GATEIO_READ_ENDPOINTS.ACCOUNTS,
      GATEIO_READ_ENDPOINTS.POSITIONS, GATEIO_READ_ENDPOINTS.OPEN_ORDERS,
      GATEIO_READ_ENDPOINTS.MY_TRADES,
    ]);
    assert.deepEqual(accountRead.requests[3]?.query, [
      { name: 'contract', value: GATEIO_L0_INITIAL_CONTRACT }, { name: 'status', value: 'open' },
    ]);
    assert.deepEqual(accountRead.requests[4]?.query, [
      { name: 'contract', value: GATEIO_L0_INITIAL_CONTRACT },
    ]);
    assert.equal(account.value?.accountState, 'OPEN');
    assert.equal(account.value?.accountStateBasis, 'FACTUAL_POSITIONS_RESPONSE');
    assert.equal(account.value?.freshness, 'FRESH');
    assert.equal(Object.isFrozen(account.value), true);
    assert.equal(Object.isFrozen(account.value?.positions), true);

    const instrumentRead = foundation();
    const facts = await instrumentRead.value.instrumentFacts();
    assert.equal(facts.availability, 'AVAILABLE');
    assert.equal(instrumentRead.requests.length, MAX_GATEIO_INSTRUMENT_FACTS_GETS);
    assert.deepEqual(instrumentRead.requests.map((entry) => entry.endpoint), [
      GATEIO_READ_ENDPOINTS.SERVER_TIME, GATEIO_READ_ENDPOINTS.CONTRACT,
      GATEIO_READ_ENDPOINTS.TICKERS,
    ]);
    assert.deepEqual(instrumentRead.requests[2]?.query, [
      { name: 'contract', value: GATEIO_L0_INITIAL_CONTRACT },
    ]);
    assert.equal(MAX_GATEIO_L1A_COMBINED_GETS, 8);
    assert.equal(facts.value?.contractMultiplier, 0.00001);
    assert.equal(facts.value?.minOrderSize, 1);
    assert.equal(facts.value?.decimalSizeEnabled, false);
  });

  it('derives FLAT only from a factual valid all-zero positions response', async () => {
    const flat = foundation({ respond(request) {
      if (request.endpoint === GATEIO_READ_ENDPOINTS.POSITIONS) {
        return [{ ...positionFixture, size: '0', entry_price: null, mark_price: null }];
      }
      return fixtureFor(request.endpoint);
    } });
    assert.equal((await flat.value.accountTruth()).value?.accountState, 'FLAT');

    const empty = foundation({ respond(request) {
      return request.endpoint === GATEIO_READ_ENDPOINTS.POSITIONS ? [] : fixtureFor(request.endpoint);
    } });
    assert.equal((await empty.value.accountTruth()).value?.accountState, 'FLAT');

    for (const invalid of [null, {}, [{ ...positionFixture, mark_price: '' }]]) {
      const read = foundation({ respond(request) {
        return request.endpoint === GATEIO_READ_ENDPOINTS.POSITIONS
          ? invalid : fixtureFor(request.endpoint);
      } });
      const result = await read.value.accountTruth();
      assert.notEqual(result.value?.accountState, 'FLAT');
      assert.equal(result.value, null);
    }
  });

  it('missing credentials are UNAVAILABLE before any GET and missing is not flat', async () => {
    const read = foundation({ withCredential: false });
    const result = await read.value.accountTruth();
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.value, null);
    assert.equal(result.reason, 'GATEIO_READ_CREDENTIALS_UNAVAILABLE');
    assert.equal(read.requests.length, 0);
    assert.equal(read.value.status().realClientDefaultWired, false);
    assert.equal(read.value.status().realCredentialDiscovery, false);
    assert.equal(read.value.status().connected, false);
  });

  it('transport failure is UNKNOWN with null truth and never becomes zero or FLAT', async () => {
    const read = foundation({ respond(request) {
      if (request.endpoint === GATEIO_READ_ENDPOINTS.ACCOUNTS) {
        throw new GateIoReadTransportError(
          'GATEIO_READ_NETWORK_FAILED', request.endpoint, null, null,
        );
      }
      return fixtureFor(request.endpoint);
    } });
    const result = await read.value.accountTruth();
    assert.equal(result.availability, 'UNKNOWN');
    assert.equal(result.value, null);
    assert.equal(result.reason, 'GATEIO_READ_NETWORK_FAILED');
    assert.equal(result.failureProvenance?.endpoint, GATEIO_READ_ENDPOINTS.ACCOUNTS);
  });

  it('stops immediately after a required endpoint failure and preserves foundation provenance', async () => {
    const accountEndpoints = [
      GATEIO_READ_ENDPOINTS.SERVER_TIME, GATEIO_READ_ENDPOINTS.ACCOUNTS,
      GATEIO_READ_ENDPOINTS.POSITIONS, GATEIO_READ_ENDPOINTS.OPEN_ORDERS,
      GATEIO_READ_ENDPOINTS.MY_TRADES,
    ] as const;
    const instrumentEndpoints = [
      GATEIO_READ_ENDPOINTS.SERVER_TIME, GATEIO_READ_ENDPOINTS.CONTRACT,
      GATEIO_READ_ENDPOINTS.TICKERS,
    ] as const;
    for (const [endpoints, kind] of [
      [accountEndpoints, 'account'], [instrumentEndpoints, 'instrument'],
    ] as const) {
      for (const target of endpoints) {
        const read = foundation({ respond(request) {
          if (request.endpoint === target) {
            throw new GateIoReadTransportError(
              'GATEIO_READ_API_REJECTED', request.endpoint, 403, 'READ_REJECTED',
            );
          }
          return fixtureFor(request.endpoint);
        } });
        const result = kind === 'account'
          ? await read.value.accountTruth() : await read.value.instrumentFacts();
        assert.equal(result.availability, 'UNKNOWN');
        assert.equal(result.value, null);
        assert.deepEqual(result.failureProvenance, {
          reason: 'GATEIO_READ_API_REJECTED', endpoint: target,
          transportCode: 'GATEIO_READ_API_REJECTED', httpStatus: 403, gateLabel: 'READ_REJECTED',
        });
        assert.equal(read.requests.at(-1)?.endpoint, target);
        assert.equal(read.requests.length, endpoints.indexOf(target) + 1);
      }
    }
  });

  it('makes observation timing deterministic and reports stale without blocking close/reduce', async () => {
    let accountClockReads = 0;
    const staleAccount = foundation({
      now: () => (++accountClockReads === 7
        ? BASE_MS + MAX_GATEIO_SERVER_TIME_OBSERVATION_AGE_MS + 1 : BASE_MS),
    });
    const account = await staleAccount.value.accountTruth();
    assert.equal(account.value?.freshness, 'STALE');

    let instrumentClockReads = 0;
    const staleInstrument = foundation({
      now: () => (++instrumentClockReads === 3
        ? BASE_MS + MAX_GATEIO_SERVER_TIME_OBSERVATION_AGE_MS + 1 : BASE_MS),
    });
    const facts = await staleInstrument.value.instrumentFacts();
    assert.equal(facts.value?.freshness, 'STALE');
    assert.equal(account.value === null, false);
    assert.equal(facts.value === null, false);
    const readiness = evaluateGateIoEntryReadiness({
      accountTruth: account as GateIoFoundationReadResult<GateIoCanonicalAccountTruth>,
      instrumentFacts: facts as GateIoFoundationReadResult<GateIoCanonicalInstrumentFacts>,
    });
    assert.equal(readiness.safeToOpen, false);
    assert.ok(readiness.blockers.includes('ACCOUNT_TRUTH_STALE'));
    assert.ok(readiness.blockers.includes('MARK_PRICE_STALE'));
    assert.equal(readiness.closeOrReduceBlockedByEntryFreshness, false);
  });

  it('allows entry-readiness only for fully available fresh openable facts', async () => {
    const accountResult = await foundation().value.accountTruth();
    const instrumentResult = await foundation().value.instrumentFacts();
    const ready = evaluateGateIoEntryReadiness({
      accountTruth: accountResult, instrumentFacts: instrumentResult,
    });
    assert.equal(ready.safeToOpen, true);
    assert.deepEqual(ready.blockers, []);
    assert.equal(ready.closeOrReduceBlockedByEntryFreshness, false);

    const missingAccount: GateIoFoundationReadResult<GateIoCanonicalAccountTruth> = Object.freeze({
      availability: 'UNKNOWN', value: null, reason: 'ACCOUNT_TRUTH_UNKNOWN', failureProvenance: null,
    });
    const missing = evaluateGateIoEntryReadiness({
      accountTruth: missingAccount, instrumentFacts: instrumentResult,
    });
    assert.equal(missing.safeToOpen, false);
    assert.ok(missing.blockers.includes('POSITION_TRUTH_UNKNOWN'));

    assert.ok(accountResult.value && instrumentResult.value);
    for (const [status, inDelisting] of [
      ['prelaunch', false], ['delisting', false], ['delisted', false],
      ['circuit_breaker', false], ['future_status', false], ['trading', true],
    ] as const) {
      const facts = Object.freeze({
        ...instrumentResult.value, contractStatus: status,
        contractOpenable: status === 'trading' && !inDelisting, inDelisting,
      });
      assert.equal(evaluateGateIoEntryReadiness({
        accountTruth: availableAccount(accountResult.value),
        instrumentFacts: availableInstrument(facts),
      }).safeToOpen, false);
    }
  });
});

describe('Gate.io L1A offline security boundary', () => {
  it('never serializes credential, SIGN, auth headers or raw exchange material', async () => {
    const injected = transport((request) => {
      throw new GateIoReadTransportError(
        'GATEIO_READ_API_REJECTED', request.endpoint, 401, 'INVALID_KEY',
      );
    });
    const observation = observeGateIoServerTime({
      requestStartedMs: BASE_MS, serverTimeMs: BASE_MS, responseReceivedMs: BASE_MS,
    });
    const client = createGateIoAuthenticatedReadClient({
      transport: injected.value, credential, clock: createGateIoReadClock(() => BASE_MS),
      serverTimeObservation: () => observation,
    });
    const error = await clientError(client.getAccount());
    const serialized = `${String(error)} ${error.stack ?? ''} ${JSON.stringify(error)}`;
    for (const secret of [
      FIXTURE_API_KEY, FIXTURE_SECRET, FIXTURE_GATE_MESSAGE, 'SIGN', '"KEY"', 'raw body',
    ]) assert.equal(serialized.includes(secret), false);
  });

  it('contains no credential discovery, production transport, mutation verb or hidden clock', () => {
    const paths = [
      'src/runtime/gateio/GateIoReadClock.ts',
      'src/runtime/gateio/GateIoAuthenticatedReadClient.ts',
      'src/runtime/gateio/GateIoAuthenticatedReadFoundation.ts',
    ];
    const source = paths.map((path) => readFileSync(path, 'utf8')).join('\n');
    for (const forbidden of [
      'process.env', '.gateio.env', 'createProductionGateIoReadTransport(', 'Date.now(',
      '.post(', '.put(', '.patch(', '.delete(', 'setInterval(', 'setTimeout(',
    ]) assert.equal(source.includes(forbidden), false, forbidden);
  });
});
