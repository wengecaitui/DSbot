import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GATEIO_L0_INITIAL_CONTRACT,
  GATEIO_READ_ENDPOINTS,
  canonicalGateIoQuery,
  gateIoAccountBookPageQuery,
  type GateIoReadTransport,
  type GateIoReadTransportRequest,
} from '../../src/runtime/gateio/GateIoReadContracts';
import {
  createGateIoAuthenticatedReadClient,
  type GateIoReadIdentity,
} from '../../src/runtime/gateio/GateIoAuthenticatedReadClient';
import { createGateIoReadClock, observeGateIoServerTime } from '../../src/runtime/gateio/GateIoReadClock';
import {
  MAX_GATEIO_ACCOUNT_BOOK_PAGE_GETS,
  createGateIoAuthenticatedReadFoundation,
} from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import { createGateIoReadTransport } from '../../src/runtime/gateio/GateIoReadTransport';
import { normalizeGateIoAccountBookPage } from '../../src/accounting/gateio-economic-truth';
import {
  GATEIO_ACCOUNT_BOOK_ENDPOINT,
  type GateIoEconomicCategory,
} from '../../src/accounting/gateio-economic-truth-types';

const BASE_MS = 1_800_000_000_000;
const credential = Object.freeze({ apiKey: 'fixture-key', secretKey: 'fixture-secret' });
const identity: GateIoReadIdentity = Object.freeze({
  exchange: 'gateio', accountId: 'explicit-account', settle: 'USDT',
});

const rawRow = Object.freeze({
  time: 1_800_000_000.125,
  change: '-0.000000000000000123456789',
  balance: '1234567890.123456789012345678',
  type: 'fee',
  text: 'order-fee-fact',
  contract: GATEIO_L0_INITIAL_CONTRACT,
  trade_id: '9223372036854775806',
  id: '184467440737095516151234567890',
});

const capture = Object.freeze({
  observedAt: BASE_MS,
  pageRequest: Object.freeze({ limit: 100, offset: 0 }),
});

function normalize(rows: unknown = [rawRow]) {
  return normalizeGateIoAccountBookPage(rows, capture);
}

function recordingTransport(
  respond: (request: GateIoReadTransportRequest) => unknown,
): { value: GateIoReadTransport; requests: GateIoReadTransportRequest[] } {
  const requests: GateIoReadTransportRequest[] = [];
  return {
    requests,
    value: Object.freeze({
      async get(request: GateIoReadTransportRequest) {
        requests.push(request);
        return respond(request);
      },
    }),
  };
}

describe('Gate.io account-book canonical economic facts', () => {
  it('normalizes one documented row without reinterpreting monetary facts', () => {
    const event = normalize()[0];
    assert.deepEqual(event, {
      schemaVersion: 'gateio-economic-truth-v1',
      exchange: 'gateio', settle: 'usdt', source: 'futures_account_book',
      sourceId: rawRow.id, occurredAt: rawRow.time,
      category: 'TRADING_FEE', rawType: 'fee',
      change: rawRow.change, balance: rawRow.balance,
      contract: rawRow.contract, tradeId: rawRow.trade_id, text: rawRow.text,
      capture: {
        endpoint: GATEIO_ACCOUNT_BOOK_ENDPOINT,
        observedAt: BASE_MS,
        pageRequest: { limit: 100, offset: 0 },
        rawPayloadDigest: event?.capture.rawPayloadDigest,
      },
    });
    assert.match(event?.capture.rawPayloadDigest ?? '', /^[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(event), true);
    assert.equal(Object.isFrozen(event?.capture), true);
    assert.equal(Object.isFrozen(event?.capture.pageRequest), true);
  });

  it('maps every documented type and preserves unknown future types as UNCLASSIFIED', () => {
    const mapping: Readonly<Record<string, GateIoEconomicCategory>> = {
      dnw: 'TRANSFER', pnl: 'POSITION_PNL', fee: 'TRADING_FEE', refr: 'REFERRAL_REBATE',
      fund: 'FUNDING', point_dnw: 'POINT_TRANSFER', point_fee: 'POINT_FEE',
      point_refr: 'POINT_REBATE', bonus_offset: 'BONUS_OFFSET',
    };
    for (const [rawType, category] of Object.entries(mapping)) {
      const event = normalize([{ ...rawRow, id: `id-${rawType}`, type: rawType }])[0];
      assert.equal(event?.category, category);
      assert.equal(event?.rawType, rawType);
    }
    const future = normalize([{ ...rawRow, type: 'future_economic_type' }])[0];
    assert.equal(future?.category, 'UNCLASSIFIED');
    assert.equal(future?.rawType, 'future_economic_type');
  });

  it('preserves positive, negative and high-precision decimals as exact strings', () => {
    const [negative, positive] = normalize([
      { ...rawRow, id: 'negative', change: '-0.000000000000000000000001' },
      { ...rawRow, id: 'positive', change: '99999999999999999999.99999999999999999999' },
    ]);
    assert.equal(negative?.change, '-0.000000000000000000000001');
    assert.equal(positive?.change, '99999999999999999999.99999999999999999999');
    assert.equal(positive?.balance, rawRow.balance);
    assert.equal(typeof positive?.change, 'string');
  });

  it('preserves large string ids and permits documented optional fields to be absent', () => {
    const { contract: _contract, trade_id: _tradeId, text: _text, ...minimal } = rawRow;
    const event = normalize([minimal])[0];
    assert.equal(event?.sourceId, rawRow.id);
    assert.equal('contract' in (event ?? {}), false);
    assert.equal('tradeId' in (event ?? {}), false);
    assert.equal('text' in (event ?? {}), false);
  });

  it('fails closed on malformed decimal or time values', () => {
    for (const change of ['', ' ', '1e-8', '+1', '.1', '1.', 'NaN', 1, null]) {
      assert.throws(
        () => normalize([{ ...rawRow, change }]),
        /GATEIO_ACCOUNT_BOOK_DECIMAL_MALFORMED/,
      );
    }
    for (const time of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1800000000', null]) {
      assert.throws(
        () => normalize([{ ...rawRow, time }]),
        /GATEIO_ACCOUNT_BOOK_TIME_MALFORMED/,
      );
    }
  });

  it('is deterministic for the same raw page and explicit capture', () => {
    const first = normalize();
    const reordered = [{
      id: rawRow.id, trade_id: rawRow.trade_id, contract: rawRow.contract, text: rawRow.text,
      type: rawRow.type, balance: rawRow.balance, change: rawRow.change, time: rawRow.time,
    }];
    const second = normalize(reordered);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('treats an empty page and a contract filter as no historical-completeness evidence', () => {
    const empty = normalizeGateIoAccountBookPage([], {
      observedAt: BASE_MS,
      pageRequest: { contract: GATEIO_L0_INITIAL_CONTRACT },
    });
    assert.deepEqual(empty, []);
    const event = normalizeGateIoAccountBookPage([rawRow], {
      observedAt: BASE_MS,
      pageRequest: { contract: GATEIO_L0_INITIAL_CONTRACT },
    })[0] as unknown as Record<string, unknown>;
    assert.equal('complete' in event, false);
    assert.equal('historicalCompleteness' in event, false);
    assert.equal('nextCursor' in event, false);
  });
});

describe('Gate.io account-book single-page read contract', () => {
  it('serializes every official query field deterministically', () => {
    const query = gateIoAccountBookPageQuery({
      from: '1700000000', to: '1800000000', limit: 100, offset: 20,
      type: 'fund', contract: GATEIO_L0_INITIAL_CONTRACT,
    });
    assert.equal(canonicalGateIoQuery(query),
      'contract=ETH_USDT&from=1700000000&limit=100&offset=20&to=1800000000&type=fund');
    assert.equal(GATEIO_READ_ENDPOINTS.ACCOUNT_BOOK, '/api/v4/futures/usdt/account_book');
    assert.equal(GATEIO_READ_ENDPOINTS.ACCOUNT_BOOK, GATEIO_ACCOUNT_BOOK_ENDPOINT);
  });

  it('rejects malformed page queries without assuming an undocumented maximum limit', () => {
    assert.deepEqual(gateIoAccountBookPageQuery({ limit: Number.MAX_SAFE_INTEGER }), [
      { name: 'limit', value: String(Number.MAX_SAFE_INTEGER) },
    ]);
    for (const request of [
      { limit: 0 }, { limit: 1.5 }, { offset: -1 }, { from: '1e3' },
      { to: '9223372036854775808' },
      { contract: 'bad contract' }, { type: '' }, { unknown: 'x' },
    ]) assert.throws(() => gateIoAccountBookPageQuery(request as never));
    assert.deepEqual(gateIoAccountBookPageQuery({ from: '0' }), [
      { name: 'from', value: '0' },
    ]);
  });

  it('uses the existing authenticated GET signing path and exact endpoint without real network', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | null = null;
    const transport = createGateIoReadTransport(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify([rawRow]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const observation = observeGateIoServerTime({
      requestStartedMs: BASE_MS, serverTimeMs: BASE_MS, responseReceivedMs: BASE_MS,
    });
    const client = createGateIoAuthenticatedReadClient({
      transport, credential, clock: createGateIoReadClock(() => BASE_MS),
      serverTimeObservation: () => observation,
    });
    await client.getAccountBookPage({
      contract: GATEIO_L0_INITIAL_CONTRACT, from: '1700000000', to: '1800000000',
      limit: 100, offset: 20, type: 'fund',
    });
    assert.equal(capturedUrl,
      'https://api.gateio.ws/api/v4/futures/usdt/account_book'
      + '?contract=ETH_USDT&from=1700000000&limit=100&offset=20&to=1800000000&type=fund');
    assert.equal(capturedInit?.method, 'GET');
    const headers = capturedInit?.headers as Readonly<Record<string, string>>;
    assert.equal(headers.KEY, credential.apiKey);
    assert.equal(headers.Timestamp, '1800000000');
    assert.match(headers.SIGN ?? '', /^[0-9a-f]{128}$/);
  });

  it('foundation performs only server-time plus one account-book page read', async () => {
    const injected = recordingTransport((request) => request.endpoint === GATEIO_READ_ENDPOINTS.SERVER_TIME
      ? { server_time: BASE_MS } : [rawRow]);
    const foundation = createGateIoAuthenticatedReadFoundation({
      transport: injected.value, identity, credential, now: () => BASE_MS,
    });
    const result = await foundation.accountBookPage({ limit: 100, offset: 0 });
    assert.equal(result.availability, 'AVAILABLE');
    assert.equal(result.value?.[0]?.category, 'TRADING_FEE');
    assert.deepEqual(injected.requests.map((request) => request.endpoint), [
      GATEIO_READ_ENDPOINTS.SERVER_TIME, GATEIO_READ_ENDPOINTS.ACCOUNT_BOOK,
    ]);
    assert.equal(injected.requests.length, MAX_GATEIO_ACCOUNT_BOOK_PAGE_GETS);
    assert.equal('accountActivityReconciled' in (result.value?.[0] ?? {}), false);
  });

  it('freezes page provenance before I/O and rejects invalid queries before any request', async () => {
    const mutableRequest = { limit: 100, offset: 0 };
    const injected = recordingTransport((request) => {
      if (request.endpoint === GATEIO_READ_ENDPOINTS.ACCOUNT_BOOK) mutableRequest.limit = 200;
      return request.endpoint === GATEIO_READ_ENDPOINTS.SERVER_TIME
        ? { server_time: BASE_MS } : [rawRow];
    });
    const foundation = createGateIoAuthenticatedReadFoundation({
      transport: injected.value, identity, credential, now: () => BASE_MS,
    });
    const result = await foundation.accountBookPage(mutableRequest);
    assert.equal(result.value?.[0]?.capture.pageRequest.limit, 100);

    const invalidTransport = recordingTransport(() => assert.fail('no I/O expected'));
    const invalidFoundation = createGateIoAuthenticatedReadFoundation({
      transport: invalidTransport.value, identity, credential, now: () => BASE_MS,
    });
    const invalid = await invalidFoundation.accountBookPage({ limit: 0 });
    assert.equal(invalid.availability, 'UNKNOWN');
    assert.equal(invalid.reason, 'ACCOUNT_BOOK_QUERY_INVALID');
    assert.equal(invalidTransport.requests.length, 0);
  });
});
