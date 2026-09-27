/** Offline wire-contract regression: injected responses only, no ambient fetch or credentials. */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  GATEIO_READ_ENDPOINTS as E,
  canonicalGateIoQuery,
  type GateIoReadTransportRequest,
} from '../../src/runtime/gateio/GateIoReadContracts';
import {
  createGateIoReadTransport,
  createGateIoTestnetReadTransport,
} from '../../src/runtime/gateio/GateIoReadTransport';
import {
  createGateIoAuthenticatedReadFoundation,
  normalizeGateIoContract,
} from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import {
  createGateIoFuturesExecutionClient,
  GATEIO_EXECUTION_ORIGINS,
  GATEIO_EXECUTION_ORDER_PATH,
  GATEIO_EXECUTION_POST_RETRY_COUNT,
} from '../../src/runtime/gateio/GateIoFuturesExecutionClient';
import { GateIoG3RunBudget } from '../../src/runtime/gateio/GateIoG3RunBudget';

const HEADER = 'X-Gate-Size-Decimal'; // Independent wire expectation, not the implementation constant.
const CREDENTIAL = { apiKey: 'OFFLINE_G7R2_KEY', secretKey: 'OFFLINE_G7R2_SECRET' };
const TIME = '1800000000';
const NOW = Number(TIME) * 1000;
// Matches the proven primitive shape; unrelated numeric values are synthetic fixtures.
const CONTRACT = Object.freeze({
  name: 'ETH_USDT', status: 'trading', in_delisting: false, enable_decimal: true,
  order_size_min: '0.1', order_size_max: '1000', quanto_multiplier: '0.001',
  order_price_round: '0.01', mark_price_round: '0.01', leverage_min: '1', leverage_max: '100',
  maker_fee_rate: '-0.0002', taker_fee_rate: '0.0005',
});
const TICKER = [{ contract: 'ETH_USDT', last: '2000', mark_price: '2000',
  index_price: '2000', funding_rate: '0.0001' }];
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function assertAuth(url: string, init: RequestInit) {
  const headers = init.headers as Readonly<Record<string, string>>;
  assert.deepEqual(Object.keys(headers).sort(),
    ['Accept', 'Content-Type', 'KEY', 'SIGN', 'Timestamp', HEADER].sort());
  assert.equal(headers[HEADER], '1');
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.KEY, CREDENTIAL.apiKey);
  assert.equal(headers.Timestamp, TIME);
  const parsed = new URL(url);
  const bodyHash = createHash('sha512').update(typeof init.body === 'string' ? init.body : '').digest('hex');
  const signatureInput = [init.method, parsed.pathname, parsed.search.slice(1), bodyHash, TIME].join('\n');
  assert.equal(headers.SIGN, createHmac('sha512', CREDENTIAL.secretKey).update(signatureInput).digest('hex'));
  assert.equal(Object.isFrozen(headers), true);
  assert.equal(Reflect.set(headers, HEADER, '0'), false);
  assert.equal(Reflect.deleteProperty(headers, HEADER), false);
  assert.equal(init.redirect, 'error');
}

describe('Gate G7R2 decimal-size negotiation on existing read wire paths', () => {
  for (const environment of ['live', 'testnet'] as const) {
    for (const endpoint of Object.values(E)) it(`${environment}: ${endpoint} header scope and unchanged auth`, async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      const fake = async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return response(endpoint === E.SERVER_TIME ? { server_time: NOW }
          : endpoint === E.CONTRACT || endpoint === E.ACCOUNTS ? {} : []);
      };
      const transport = environment === 'live' ? createGateIoReadTransport(fake)
        : createGateIoTestnetReadTransport(fake, GateIoG3RunBudget.create());
      const authenticated = endpoint !== E.SERVER_TIME && endpoint !== E.CONTRACT && endpoint !== E.TICKERS;
      const query = endpoint === E.OPEN_ORDERS
        ? [{ name: 'status', value: 'open' }, { name: 'contract', value: 'ETH_USDT' }]
        : endpoint === E.TICKERS || endpoint === E.MY_TRADES ? [{ name: 'contract', value: 'ETH_USDT' }] : [];
      const request: GateIoReadTransportRequest = { endpoint, query,
        ...(authenticated ? { credential: CREDENTIAL, timestamp: TIME } : {}) };
      Object.defineProperty(request, 'headers', { get() { assert.fail('caller header injection must not be read'); } });
      await transport.get(request);
      assert.equal(calls.length, 1);
      const { url, init } = calls[0];
      assert.equal(new URL(url).origin, GATEIO_EXECUTION_ORIGINS[environment]);
      assert.equal(new URL(url).search.slice(1), canonicalGateIoQuery(query));
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      if (authenticated) assertAuth(url, init);
      else if (endpoint === E.SERVER_TIME) assert.equal(init.headers, undefined);
      else {
        assert.deepEqual(init.headers, { [HEADER]: '1' });
        assert.equal(Object.isFrozen(init.headers), true);
      }
    });
  }
});

describe('Gate G7R2 execution POST, attestation and ambiguity lookup', () => {
  for (const environment of ['live', 'testnet'] as const) {
    for (const size of [0.1, -0.1]) it(`${environment}: exact fractional ${size} POST and submitted lookup`, async () => {
      const request = { contract: 'ETH_USDT' as const, size, price: '0' as const, tif: 'ioc' as const,
        reduceOnly: size < 0, text: 't-dsb-' + 'a'.repeat(22) };
      const budget = GateIoG3RunBudget.create();
      const calls: { url: string; init: RequestInit }[] = [];
      const options = {
        environment, credential: CREDENTIAL, signedTimestamp: () => TIME, runBudget: budget,
        readFoundation: { async instrumentFacts(): Promise<never> { assert.fail('no hidden instrument I/O'); } },
        fetchImpl: async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return response({ id: '12345678901234567', contract: request.contract, text: request.text,
            size: String(size), left: '0', status: 'finished', finish_as: 'filled',
            fill_price: '2000', finish_time: Number(TIME) });
        },
      };
      Object.defineProperty(options, 'headers', { get() { assert.fail('caller headers must not be read'); } });
      const client = createGateIoFuturesExecutionClient(options);
      const injectedRequest = { ...request };
      Object.defineProperty(injectedRequest, 'headers', { get() { assert.fail('caller headers must not be read'); } });
      await assert.rejects(client.submitMarketOrder(injectedRequest), /GATEIO_EXECUTION_REQUEST_INVALID/);
      assert.equal(calls.length, 0);
      assert.equal(budget.snapshot().totalUsed, 0);
      const result = await client.submitMarketOrder(request);
      assert.equal(result.status, 'FINISHED');
      assert.equal(result.signedFilledSize, size);
      assert.equal(result.exchangeOrderId, '12345678901234567');
      const attestation = await client.lookupSubmittedOrder(request.text);
      assert.equal(attestation?.result.signedFilledSize, size);
      assert.deepEqual(calls.map(c => c.init.method), ['POST', 'GET']);
      assert.equal(calls[0].url, GATEIO_EXECUTION_ORIGINS[environment] + GATEIO_EXECUTION_ORDER_PATH);
      assert.equal(calls[1].url, calls[0].url + '/' + request.text);
      assert.equal(calls[0].init.body, JSON.stringify({ contract: request.contract, size,
        price: '0', tif: 'ioc', reduce_only: request.reduceOnly, text: request.text }));
      assert.equal(calls[1].init.body, undefined);
      for (const call of calls) assertAuth(call.url, call.init);
      assert.equal(budget.snapshot().totalUsed, 1);
      assert.equal(budget.snapshot().attestationUsed, 1);
      assert.equal(budget.snapshot().networkUsed, 2);
    });
    it(`${environment}: ambiguous POST gets one signed decimal lookup, never a POST retry`, async () => {
      const request = { contract: 'ETH_USDT' as const, size: 0.1, price: '0' as const, tif: 'ioc' as const,
        reduceOnly: false, text: 't-dsb-' + 'b'.repeat(22) };
      const methods: string[] = [];
      const budget = GateIoG3RunBudget.create();
      const client = createGateIoFuturesExecutionClient({
        environment, credential: CREDENTIAL, signedTimestamp: () => TIME, runBudget: budget,
        readFoundation: { async instrumentFacts(): Promise<never> { assert.fail('no hidden instrument I/O'); } },
        fetchImpl: async (url, init) => {
          methods.push(init.method!);
          assertAuth(url, init);
          if (init.method === 'POST') throw new Error('OFFLINE_AMBIGUOUS');
          assert.equal(url, GATEIO_EXECUTION_ORIGINS[environment] + GATEIO_EXECUTION_ORDER_PATH + '/' + request.text);
          return response({ id: '12345678901234567', contract: request.contract, text: request.text,
            size: '0.1', left: '0', status: 'finished', finish_as: 'filled',
            fill_price: '2000', finish_time: Number(TIME) });
        },
      });
      assert.equal((await client.submitMarketOrder(request)).signedFilledSize, 0.1);
      assert.deepEqual(methods, ['POST', 'GET']);
      assert.equal(GATEIO_EXECUTION_POST_RETRY_COUNT, 0);
      assert.equal(budget.snapshot().totalUsed, 1);
      assert.equal(budget.snapshot().ambiguousUsed, 1);
    });
  }
});

describe('Gate G7R2 protocol repair never relaxes market-rule parsing', () => {
  it('accepts proven decimal contract shape with positive string minimum', () => {
    const rule = normalizeGateIoContract(CONTRACT);
    assert.equal(rule.minSize, 0.1);
    assert.equal(rule.decimalSize, true);
    assert.equal(rule.openable, true);
  });
  for (const minimum of [0, '0', -0.1, undefined, null, '', 'NaN', Infinity, true])
    it(`rejects invalid minimum ${String(minimum)}`, () => {
      assert.throws(() => normalizeGateIoContract({ ...CONTRACT, order_size_min: minimum }),
        /INSTRUMENT_FACTS_MALFORMED/);
    });
  for (const patch of [
    { name: 'BTC_USDT' }, { order_size_max: '0.09' }, { quanto_multiplier: '0' },
    { leverage_min: '0' }, { leverage_min: '101' }, { order_price_round: '0' },
    { mark_price_round: '-1' }, { enable_decimal: 'true' }, { in_delisting: undefined },
  ]) it(`keeps strict contract gate for ${Object.keys(patch).join(',')}`, () => {
    assert.throws(() => normalizeGateIoContract({ ...CONTRACT, ...patch }), /INSTRUMENT_FACTS_MALFORMED/);
  });
  it('keeps delisting and unknown status non-openable', () => {
    assert.equal(normalizeGateIoContract({ ...CONTRACT, in_delisting: true }).openable, false);
    assert.equal(normalizeGateIoContract({ ...CONTRACT, status: 'unknown' }).openable, false);
  });
  for (const badTicker of [false, true]) it(`negotiation through foundation reaches ticker; malformed=${badTicker}`, async () => {
    const paths: string[] = [];
    const transport = createGateIoReadTransport(async (url, init) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === E.SERVER_TIME) return response({ server_time: NOW });
      if (path === E.CONTRACT) return response({ ...CONTRACT,
        order_size_min: new Headers(init.headers).get(HEADER) === '1' ? '0.1' : 0 });
      assert.equal(path, E.TICKERS);
      return response(badTicker ? [] : TICKER);
    });
    const foundation = createGateIoAuthenticatedReadFoundation({ transport, credential: null,
      identity: { exchange: 'gateio', accountId: 'offline-g7r2', settle: 'USDT' }, now: () => NOW });
    const result = await foundation.instrumentFacts();
    assert.deepEqual(paths, [E.SERVER_TIME, E.CONTRACT, E.TICKERS]);
    assert.equal(result.availability, badTicker ? 'UNKNOWN' : 'AVAILABLE');
    if (badTicker) {
      assert.equal(result.reason, 'INSTRUMENT_FACTS_MALFORMED');
      assert.equal(result.value, null);
    } else {
      assert.equal(result.value?.minOrderSize, 0.1);
      assert.equal(result.value?.decimalSizeEnabled, true);
    }
  });
});
