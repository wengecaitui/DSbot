/**
 * Bitget L0 read transport foundation.
 *
 * Offline only: every transport here is a fake/injected fetch. No credential is read, no socket is
 * opened and no real origin is contacted.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  BITGET_L0_PRODUCTION_ORIGIN,
  BITGET_READ_ENDPOINTS,
  BITGET_READ_ENDPOINTS_REQUIRING_L1A_VERIFICATION,
  PRODUCT_TYPE_USDT_FUTURES,
  BitgetReadContractError,
  canonicalBitgetQuery,
} from '../../src/runtime/bitget/BitgetReadContracts';
import {
  BITGET_V2_L0_SIGNED_METHOD,
  BITGET_V2_SIGNATURE_ALGORITHM,
  BITGET_V2_SIGNATURE_ENCODING,
  bitgetTimestampFromMillis,
  bitgetV2Preimage,
  signBitgetV2Request,
} from '../../src/runtime/bitget/BitgetV2Signer';
import {
  BitgetReadTransportError,
  MAX_BITGET_RESPONSE_BYTES,
  createBitgetReadTransport,
  createProductionBitgetReadTransport,
  getBitgetReadRequestCount,
  hasProductionBitgetReadTransportProvenance,
  type BitgetReadFetch,
  type BitgetReadResponse,
} from '../../src/runtime/bitget/BitgetReadTransport';

const FIXTURE_API_KEY_DO_NOT_LEAK = 'FIXTURE_API_KEY_DO_NOT_LEAK';
const FIXTURE_SECRET_DO_NOT_LEAK = 'FIXTURE_SECRET_DO_NOT_LEAK';
const FIXTURE_PASSPHRASE_DO_NOT_LEAK = 'FIXTURE_PASSPHRASE_DO_NOT_LEAK';
const FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK = 'FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK';
const FIXTURE_TIMESTAMP = '1700000000000';

/** Independent cross-implementation vectors (HMAC-SHA256/Base64 computed outside this codebase). */
const VECTOR_NO_QUERY_SIGNATURE = 'FxgPdLvxbNVEu+o0ImHf+C54M+60nxtJxYGF9sD/I6A=';
const VECTOR_WITH_QUERY_SIGNATURE = 'v/YoGadWxm0uNSKFP69Iy/Kutrb9QGeR55maMoFSuoo=';

const credential = Object.freeze({
  apiKey: FIXTURE_API_KEY_DO_NOT_LEAK,
  secretKey: FIXTURE_SECRET_DO_NOT_LEAK,
  passphrase: FIXTURE_PASSPHRASE_DO_NOT_LEAK,
});

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return { ok, status, async text() { return JSON.stringify(body); } };
}

function recordingFetch(
  responder: (url: string) => Pick<Response, 'ok' | 'status' | 'text'>,
): { fetchImpl: BitgetReadFetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl: BitgetReadFetch = async (input, init) => {
    captured.push({ url: input, init });
    return responder(input);
  };
  return { fetchImpl, captured };
}

const okEnvelope = (data: unknown) => ({ code: '00000', msg: 'success', requestTime: 1789000000000, data });

const serializedError = (error: unknown) => JSON.stringify({
  name: (error as Error).name,
  message: (error as Error).message,
  code: (error as BitgetReadTransportError).code,
  httpStatus: (error as BitgetReadTransportError).httpStatus,
  bitgetCode: (error as BitgetReadTransportError).bitgetCode,
  stack: undefined,
});

function assertNoLeak(candidate: unknown): void {
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
  for (const fixture of [
    FIXTURE_API_KEY_DO_NOT_LEAK,
    FIXTURE_SECRET_DO_NOT_LEAK,
    FIXTURE_PASSPHRASE_DO_NOT_LEAK,
    FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK,
  ]) {
    assert.equal(text.includes(fixture), false, `fixture leaked: ${fixture}`);
  }
  assert.equal(/ACCESS-(KEY|SIGN|TIMESTAMP|PASSPHRASE)/.test(text), false, 'auth header leaked');
}

describe('Bitget L0 transport foundation', () => {
  it('1. deterministic HMAC-SHA256/Base64 vector matches an external implementation', () => {
    assert.equal(BITGET_V2_SIGNATURE_ALGORITHM, 'HMAC-SHA256');
    assert.equal(BITGET_V2_SIGNATURE_ENCODING, 'base64');
    const signed = signBitgetV2Request({
      secretKey: FIXTURE_SECRET_DO_NOT_LEAK,
      timestamp: FIXTURE_TIMESTAMP,
      method: 'GET',
      requestPath: BITGET_READ_ENDPOINTS.SERVER_TIME,
      canonicalQuery: '',
      body: '',
    });
    assert.equal(signed.preimage, '1700000000000GET/api/v2/public/time');
    assert.equal(signed.signature, VECTOR_NO_QUERY_SIGNATURE);
    assert.equal(bitgetTimestampFromMillis(1700000000000), FIXTURE_TIMESTAMP);
  });

  it('2. preimage without query is timestamp + method + path', () => {
    assert.equal(bitgetV2Preimage('GET', '/api/v2/public/time', '', ''), '/api/v2/public/time');
  });

  it('3. preimage with query matches an external implementation', () => {
    const query = 'marginCoin=USDT&productType=USDT-FUTURES';
    assert.equal(
      bitgetV2Preimage('GET', '/api/v2/mix/account/accounts', query, ''),
      `/api/v2/mix/account/accounts?${query}`,
    );
    const signed = signBitgetV2Request({
      secretKey: FIXTURE_SECRET_DO_NOT_LEAK,
      timestamp: FIXTURE_TIMESTAMP,
      method: 'GET',
      requestPath: '/api/v2/mix/account/accounts',
      canonicalQuery: query,
      body: '',
    });
    assert.equal(signed.signature, VECTOR_WITH_QUERY_SIGNATURE);
  });

  it('4. canonical query ordering is stable whatever the input order', () => {
    const forward = canonicalBitgetQuery([
      { name: 'marginCoin', value: 'USDT' }, { name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES },
    ]);
    const reversed = canonicalBitgetQuery([
      { name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }, { name: 'marginCoin', value: 'USDT' },
    ]);
    assert.equal(forward, 'marginCoin=USDT&productType=USDT-FUTURES');
    assert.equal(forward, reversed);
  });

  it('5. canonical query encodes correctly and never coerces values', () => {
    assert.equal(canonicalBitgetQuery([{ name: 'symbol', value: 'A B+C&D=E' }]), 'symbol=A%20B%2BC%26D%3DE');
    assert.equal(canonicalBitgetQuery([{ name: 'symbol', value: "a!b'c(d)e*f" }]), 'symbol=a%21b%27c%28d%29e%2Af');
    for (const bad of [
      [{ name: 'symbol', value: null }],
      [{ name: 'symbol', value: undefined }],
      [{ name: 'symbol', value: 7 }],
      [{ name: 'symbol', value: ['ETHUSDT'] }],
      [{ name: 'symbol', value: { symbol: 'ETHUSDT' } }],
      [{ name: 'symbol', value: '' }],
      [{ name: 'symbol', value: 'x' }, { name: 'symbol', value: 'y' }],
      [{ name: 'bad name', value: 'x' }],
    ]) {
      assert.throws(() => canonicalBitgetQuery(bad as never), BitgetReadContractError);
    }
  });

  it('6. injected fake transport carries no production provenance', () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, okEnvelope({})));
    const transport = createBitgetReadTransport(fetchImpl);
    assert.equal(hasProductionBitgetReadTransportProvenance(transport), false);
    assert.equal(
      hasProductionBitgetReadTransportProvenance({ get: async () => ({}) }),
      false,
    );
  });

  it('7. production factory produces provenance that cannot be forged structurally', () => {
    const production = createProductionBitgetReadTransport();
    assert.equal(hasProductionBitgetReadTransportProvenance(production), true);
    const lookalike = { get: production.get };
    assert.equal(hasProductionBitgetReadTransportProvenance(lookalike), false);
    assert.equal(hasProductionBitgetReadTransportProvenance(null), false);
  });

  it('8. production factory construction performs no I/O and leaves globalThis.fetch untouched', () => {
    const before = globalThis.fetch;
    const production = createProductionBitgetReadTransport();
    assert.equal(globalThis.fetch, before);
    assert.deepEqual(getBitgetReadRequestCount(production), { total: 0, byEndpoint: {} });
  });

  it('9. transport method surface is exactly GET', () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, okEnvelope({})));
    const transport = createBitgetReadTransport(fetchImpl);
    assert.deepEqual(Object.keys(transport), ['get']);
    for (const forbidden of ['post', 'put', 'patch', 'delete', 'request', 'send']) {
      assert.equal(forbidden in transport, false);
    }
    assert.equal(Object.isFrozen(transport), true);
  });

  it('10. arbitrary origin or absolute URL cannot be injected', async () => {
    const { fetchImpl, captured } = recordingFetch(() => jsonResponse(200, okEnvelope([])));
    const transport = createBitgetReadTransport(fetchImpl);
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME,
      query: [],
      origin: 'https://evil.example',
      url: 'https://evil.example/steal',
    } as never);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.url, `${BITGET_L0_PRODUCTION_ORIGIN}${BITGET_READ_ENDPOINTS.SERVER_TIME}`);
    await assert.rejects(
      () => transport.get({ endpoint: 'https://evil.example/v2/account' as never, query: [] }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_REQUEST_INVALID',
    );
    assert.equal(captured.length, 1);
  });

  it('11. unknown endpoint fails closed before fetch', async () => {
    const { fetchImpl, captured } = recordingFetch(() => jsonResponse(200, okEnvelope({})));
    const transport = createBitgetReadTransport(fetchImpl);
    await assert.rejects(
      () => transport.get({ endpoint: '/api/v2/mix/order/place-order' as never, query: [] }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_REQUEST_INVALID' && error.httpStatus === null
        && error.bitgetCode === null,
    );
    assert.equal(captured.length, 0);
  });

  it('12. missing credential (apiKey) fails closed before fetch', async () => {
    const { fetchImpl, captured } = recordingFetch(() => jsonResponse(200, okEnvelope({})));
    const transport = createBitgetReadTransport(fetchImpl);
    await assert.rejects(
      () => transport.get({
        endpoint: BITGET_READ_ENDPOINTS.ACCOUNTS,
        query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
        timestamp: FIXTURE_TIMESTAMP,
      }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_REQUEST_INVALID',
    );
    assert.equal(captured.length, 0);
  });

  it('13. missing secret fails closed before fetch', async () => {
    const { fetchImpl, captured } = recordingFetch(() => jsonResponse(200, okEnvelope({})));
    const transport = createBitgetReadTransport(fetchImpl);
    await assert.rejects(
      () => transport.get({
        endpoint: BITGET_READ_ENDPOINTS.ACCOUNTS,
        query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
        credential: { apiKey: FIXTURE_API_KEY_DO_NOT_LEAK, passphrase: FIXTURE_PASSPHRASE_DO_NOT_LEAK } as never,
        timestamp: FIXTURE_TIMESTAMP,
      }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_REQUEST_INVALID',
    );
    assert.equal(captured.length, 0);
  });

  it('14. missing passphrase (and missing timestamp) fails closed before fetch', async () => {
    const { fetchImpl, captured } = recordingFetch(() => jsonResponse(200, okEnvelope({})));
    const transport = createBitgetReadTransport(fetchImpl);
    const base = {
      endpoint: BITGET_READ_ENDPOINTS.ACCOUNTS,
      query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
    };
    await assert.rejects(
      () => transport.get({
        ...base,
        credential: { apiKey: FIXTURE_API_KEY_DO_NOT_LEAK, secretKey: FIXTURE_SECRET_DO_NOT_LEAK } as never,
        timestamp: FIXTURE_TIMESTAMP,
      }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_REQUEST_INVALID',
    );
    await assert.rejects(
      () => transport.get({ ...base, credential }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_REQUEST_INVALID',
    );
    await assert.rejects(
      () => transport.get({ ...base, credential, timestamp: 'not-a-timestamp' }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_REQUEST_INVALID',
    );
    assert.equal(captured.length, 0);
  });

  it('15. credential values are absent from the emitted URL', async () => {
    const { fetchImpl, captured } = recordingFetch(() => jsonResponse(200, okEnvelope([])));
    const transport = createBitgetReadTransport(fetchImpl);
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.POSITIONS,
      query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
      credential,
      timestamp: FIXTURE_TIMESTAMP,
    });
    const url = captured[0]?.url ?? '';
    assert.equal(url.includes(FIXTURE_API_KEY_DO_NOT_LEAK), false);
    assert.equal(url.includes(FIXTURE_SECRET_DO_NOT_LEAK), false);
    assert.equal(url.includes(FIXTURE_PASSPHRASE_DO_NOT_LEAK), false);
    assertNoLeak(url);
  });

  it('16. signature is absent from the emitted URL and the query is canonical', async () => {
    const { fetchImpl, captured } = recordingFetch(() => jsonResponse(200, okEnvelope([])));
    const transport = createBitgetReadTransport(fetchImpl);
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.POSITIONS,
      query: [
        { name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES },
        { name: 'marginCoin', value: 'USDT' },
      ],
      credential,
      timestamp: FIXTURE_TIMESTAMP,
    });
    const capturedUrl = captured[0]?.url ?? '';
    const expectedQuery = 'marginCoin=USDT&productType=USDT-FUTURES';
    assert.equal(capturedUrl, `${BITGET_L0_PRODUCTION_ORIGIN}${BITGET_READ_ENDPOINTS.POSITIONS}?${expectedQuery}`);
    assert.equal(capturedUrl.includes('ACCESS-SIGN'), false);
    assert.equal(capturedUrl.includes('signature'), false);
    // Signing uses exactly the emitted bytes: recomputed independently here.
    const headers = (captured[0]?.init.headers ?? {}) as Record<string, string>;
    const expected = createHmac('sha256', FIXTURE_SECRET_DO_NOT_LEAK)
      .update(`${FIXTURE_TIMESTAMP}GET${BITGET_READ_ENDPOINTS.POSITIONS}?${expectedQuery}`, 'utf8')
      .digest('base64');
    assert.equal(headers['ACCESS-SIGN'], expected);
  });

  it('17. network rejection maps to BITGET_READ_NETWORK_FAILED', async () => {
    const transport = createBitgetReadTransport(async () => { throw new Error('offline'); });
    await assert.rejects(
      () => transport.get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_NETWORK_FAILED'
        && error.httpStatus === null && error.bitgetCode === null,
    );
  });

  it('18. HTTP non-2xx maps to BITGET_READ_HTTP_FAILED with status and code', async () => {
    const withCode = recordingFetch(() => jsonResponse(400, { code: '40012', msg: FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK }));
    await assert.rejects(
      () => createBitgetReadTransport(withCode.fetchImpl).get({
        endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [],
      }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_HTTP_FAILED' && error.httpStatus === 400
        && error.bitgetCode === '40012' && assertNoLeak(serializedError(error)) === undefined,
    );
    const nonJson = recordingFetch(() => ({ ok: false, status: 451, async text() { return `<html>${FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK}</html>`; } }));
    await assert.rejects(
      () => createBitgetReadTransport(nonJson.fetchImpl).get({
        endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [],
      }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_HTTP_FAILED' && error.httpStatus === 451
        && error.bitgetCode === null,
    );
  });

  it('19. HTTP 2xx with a non-00000 exchange code is a rejection, not a success', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, {
      code: '40012', msg: FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK, requestTime: 1, data: null,
    }));
    await assert.rejects(
      () => createBitgetReadTransport(fetchImpl).get({
        endpoint: BITGET_READ_ENDPOINTS.ACCOUNTS,
        query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
        credential,
        timestamp: FIXTURE_TIMESTAMP,
      }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_API_REJECTED' && error.httpStatus === 200
        && error.bitgetCode === '40012' && assertNoLeak(serializedError(error)) === undefined,
    );
  });

  it('20. malformed JSON and malformed envelopes map to BITGET_READ_RESPONSE_INVALID', async () => {
    const malformed = recordingFetch(() => ({ ok: true, status: 200, async text() { return `{"code":<bad ${FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK}>`; } }));
    await assert.rejects(
      () => createBitgetReadTransport(malformed.fetchImpl).get({
        endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [],
      }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_RESPONSE_INVALID' && error.httpStatus === 200,
    );
    for (const body of [[], 'text', 7, null, { code: 0 }, { code: '00000' }, { msg: 'x', data: 1 }]) {
      const shaped = recordingFetch(() => ({ ok: true, status: 200, async text() { return JSON.stringify(body); } }));
      await assert.rejects(
        () => createBitgetReadTransport(shaped.fetchImpl).get({
          endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [],
        }),
        (error: unknown) => error instanceof BitgetReadTransportError
          && error.code === 'BITGET_READ_RESPONSE_INVALID',
      );
    }
    const oversized = recordingFetch(() => ({
      ok: false, status: 500,
      async text() { return `{"code":"40012","msg":"${'x'.repeat(5000)}"}`; },
    }));
    await assert.rejects(
      () => createBitgetReadTransport(oversized.fetchImpl).get({
        endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [],
      }),
      (error: unknown) => error instanceof BitgetReadTransportError
        && error.code === 'BITGET_READ_HTTP_FAILED' && error.httpStatus === 500
        && error.bitgetCode === null,
    );
  });

  it('21. raw exchange msg cannot reach a serialized error', async () => {
    for (const responder of [
      () => jsonResponse(200, { code: '40012', msg: FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK, requestTime: 1, data: {} }),
      () => jsonResponse(401, { code: '40006', msg: FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK }),
      () => ({ ok: true, status: 200, async text() { return FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK; } }),
    ]) {
      const { fetchImpl } = recordingFetch(responder);
      const error = await createBitgetReadTransport(fetchImpl).get({
        endpoint: BITGET_READ_ENDPOINTS.POSITIONS,
        query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
        credential,
        timestamp: FIXTURE_TIMESTAMP,
      }).then(() => null, (caught: unknown) => caught);
      assert.ok(error instanceof BitgetReadTransportError);
      assertNoLeak(serializedError(error));
      assertNoLeak(error);
    }
  });

  it('22. credential fixtures cannot reach a serialized error', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(403, { code: '40006', msg: 'denied' }));
    const error = await createBitgetReadTransport(fetchImpl).get({
      endpoint: BITGET_READ_ENDPOINTS.ACCOUNTS,
      query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
      credential,
      timestamp: FIXTURE_TIMESTAMP,
    }).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof BitgetReadTransportError);
    assertNoLeak(serializedError(error));
  });

  it('23. a network failure never retries', async () => {
    let calls = 0;
    const transport = createBitgetReadTransport(async () => {
      calls += 1;
      throw new Error('offline');
    });
    await assert.rejects(() => transport.get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] }));
    await assert.rejects(() => transport.get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] }));
    assert.equal(calls, 2);
  });

  it('24. one logical get performs exactly one fetch invocation', async () => {
    const { fetchImpl, captured } = recordingFetch(() => jsonResponse(200, okEnvelope({ ok: true })));
    const transport = createBitgetReadTransport(fetchImpl);
    const data = await transport.get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] });
    assert.equal(captured.length, 1);
    assert.equal((captured[0]?.init as RequestInit).method, 'GET');
    assert.equal((captured[0]?.init as RequestInit).redirect, 'error');
    assert.deepEqual(data, { ok: true });
  });

  it('25. a successful envelope returns the parsed data payload', async () => {
    const payload = { symbol: 'ETHUSDT', markPrice: '2500.5', status: 'normal' };
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, {
      code: '00000', msg: 'success', requestTime: 1789000000001, data: [payload],
    }));
    const transport = createBitgetReadTransport(fetchImpl);
    assert.deepEqual(await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.CONTRACTS,
      query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }, { name: 'symbol', value: 'ETHUSDT' }],
    }), [payload]);
  });

  it('26. request counters count attempts per endpoint and never leak across transports', async () => {
    const first = recordingFetch(() => jsonResponse(200, okEnvelope([])));
    const second = recordingFetch(() => jsonResponse(200, okEnvelope([])));
    const transportA = createBitgetReadTransport(first.fetchImpl);
    const transportB = createBitgetReadTransport(second.fetchImpl);
    assert.deepEqual(getBitgetReadRequestCount(transportA), { total: 0, byEndpoint: {} });
    await transportA.get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] });
    await transportA.get({
      endpoint: BITGET_READ_ENDPOINTS.CONTRACTS,
      query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
    });
    await assert.rejects(() => transportA.get({ endpoint: 'nope' as never, query: [] }));
    assert.deepEqual(getBitgetReadRequestCount(transportA), {
      total: 2,
      byEndpoint: {
        [BITGET_READ_ENDPOINTS.SERVER_TIME]: 1,
        [BITGET_READ_ENDPOINTS.CONTRACTS]: 1,
      },
    });
    assert.deepEqual(getBitgetReadRequestCount(transportB), { total: 0, byEndpoint: {} });
    assert.equal(getBitgetReadRequestCount(undefined), null);
  });

  it('27. public reads send no credential headers; authenticated reads send exactly the V2 headers', async () => {
    const { fetchImpl, captured } = recordingFetch(() => jsonResponse(200, okEnvelope([])));
    const transport = createBitgetReadTransport(fetchImpl);
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.CONTRACTS,
      query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
    });
    const publicInit = captured[0]?.init as RequestInit;
    assert.equal(publicInit.headers, undefined);
    await transport.get({
      endpoint: BITGET_READ_ENDPOINTS.ACCOUNTS,
      query: [{ name: 'productType', value: PRODUCT_TYPE_USDT_FUTURES }],
      credential,
      timestamp: FIXTURE_TIMESTAMP,
    });
    const headers = ((captured[1]?.init as RequestInit).headers ?? {}) as Record<string, string>;
    assert.deepEqual(Object.keys(headers).sort(),
      ['ACCESS-KEY', 'ACCESS-PASSPHRASE', 'ACCESS-SIGN', 'ACCESS-TIMESTAMP', 'Content-Type']);
    assert.equal(headers['ACCESS-KEY'], FIXTURE_API_KEY_DO_NOT_LEAK);
    assert.equal(headers['ACCESS-PASSPHRASE'], FIXTURE_PASSPHRASE_DO_NOT_LEAK);
    assert.equal(headers['ACCESS-TIMESTAMP'], FIXTURE_TIMESTAMP);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(BITGET_V2_L0_SIGNED_METHOD, 'GET');
  });

  it('28. endpoint allowlist is closed and unverified families stay deferred to L1A', () => {
    assert.deepEqual(Object.values(BITGET_READ_ENDPOINTS), [
      '/api/v2/public/time', '/api/v2/mix/market/contracts',
      '/api/v2/mix/market/symbol-price', '/api/v2/mix/account/accounts',
      '/api/v2/mix/position/all-position', '/api/v2/mix/order/orders-pending',
      '/api/v2/mix/order/fills',
    ]);
    assert.equal(BITGET_L0_PRODUCTION_ORIGIN, 'https://api.bitget.com');
    for (const deferred of BITGET_READ_ENDPOINTS_REQUIRING_L1A_VERIFICATION) {
      assert.equal(
        (Object.values(BITGET_READ_ENDPOINTS) as string[]).includes(deferred),
        false,
        `${deferred} must not be callable in L0`,
      );
    }
    assert.equal(BITGET_READ_ENDPOINTS_REQUIRING_L1A_VERIFICATION.length > 0, true);
  });
});

const MAX = MAX_BITGET_RESPONSE_BYTES;
const MAX_STATUS = 200;

function envelopeOfExactBytes(targetBytes: number): string {
  const prefix = '{"code":"00000","msg":"","requestTime":1,"data":{"pad":"';
  const suffix = '"}}';
  const padBytes = targetBytes - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(suffix, 'utf8');
  return `${prefix}${'x'.repeat(padBytes)}${suffix}`;
}

function streamedResponse(
  payload: string | Uint8Array[],
  options: {
    status?: number;
    contentLength?: string | null;
    onRead?: () => void;
    onCancel?: () => void;
    arrayBufferInsteadOfStream?: boolean;
  } = {},
): BitgetReadResponse {
  const chunks = Array.isArray(payload) ? payload : [new TextEncoder().encode(payload)];
  const status = options.status ?? 200;
  let index = 0;
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: options.contentLength === null || options.contentLength === undefined
      ? null
      : { get: (name: string) => (name.toLowerCase() === 'content-length' ? options.contentLength ?? null : null) },
    body: options.arrayBufferInsteadOfStream
      ? null
      : {
        getReader: () => ({
          read: async () => {
            options.onRead?.();
            if (index >= chunks.length) return { done: true as const };
            const value = chunks[index];
            index += 1;
            return { done: false as const, value };
          },
          cancel: async () => { options.onCancel?.(); },
        }),
      },
    async text() {
      throw new Error('streamed responses must not be read through text()');
    },
    ...(options.arrayBufferInsteadOfStream
      ? { async arrayBuffer() { return concatenated(chunks).buffer; } }
      : {}),
  };
  return response as unknown as BitgetReadResponse;
}

function concatenated(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function textOnlyResponse(body: string, status = 200): BitgetReadResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  } as unknown as BitgetReadResponse;
}

async function oversizedError(status: number, response: BitgetReadResponse): Promise<BitgetReadTransportError> {
  const transport = createBitgetReadTransport(async () => response);
  const caught = await transport
    .get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] })
    .then(() => null, (error: unknown) => error);
  assert.ok(caught instanceof BitgetReadTransportError);
  assert.equal(caught.code, 'BITGET_READ_RESPONSE_TOO_LARGE');
  assert.equal(caught.httpStatus, status);
  assert.equal(caught.bitgetCode, null);
  return caught;
}

describe('Bitget L0 response size bound', () => {
  it('29. the byte ceiling is a fixed runtime constant', () => {
    assert.equal(MAX, 1_048_576);
    assert.equal(typeof MAX_BITGET_RESPONSE_BYTES, 'number');
    // The transport factory takes only the fetch implementation: the limit is not caller-settable.
    assert.equal(createBitgetReadTransport.length, 1);
    assert.equal(createProductionBitgetReadTransport.length, 0);
  });

  it('30. A - a body of exactly MAX bytes is not rejected as oversized', async () => {
    const body = envelopeOfExactBytes(MAX);
    assert.equal(Buffer.byteLength(body, 'utf8'), MAX);
    const transport = createBitgetReadTransport(async () => streamedResponse(body));
    const data = await transport.get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] });
    assert.equal(typeof data, 'object');
  });

  it('31. B - MAX + 1 byte fails closed with RESPONSE_TOO_LARGE', async () => {
    const body = envelopeOfExactBytes(MAX + 1);
    assert.equal(Buffer.byteLength(body, 'utf8'), MAX + 1);
    await oversizedError(MAX_STATUS, streamedResponse(body));
  });

  it('32. C - a declared Content-Length above MAX fails before the body is read', async () => {
    let reads = 0;
    const error = await oversizedError(MAX_STATUS, streamedResponse('{"code":"00000","data":[]}', {
      contentLength: String(MAX + 1),
      onRead: () => { reads += 1; },
    }));
    assert.equal(reads, 0, 'no stream read may happen once the declaration exceeds the ceiling');
    assert.equal(error.httpStatus, MAX_STATUS);
  });

  it('33. D - a dishonest Content-Length below MAX still fails on real bytes', async () => {
    const body = envelopeOfExactBytes(MAX + 512);
    await oversizedError(MAX_STATUS, streamedResponse(body, { contentLength: '1024' }));
  });

  it('34. E - a missing Content-Length is bounded by the stream', async () => {
    await oversizedError(MAX_STATUS, streamedResponse(envelopeOfExactBytes(MAX + 1), { contentLength: null }));
  });

  it('35. F - chunked bodies are bounded across chunks and the reader is cancelled', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(262_144));
    let cancelled = false;
    const error = await oversizedError(MAX_STATUS, streamedResponse(
      [chunk, chunk, chunk, chunk, chunk], // 5 x 256 KiB = 1.25 MiB
      { onCancel: () => { cancelled = true; } },
    ));
    assert.equal(cancelled, true, 'overflow must cancel the remaining stream');
    assert.equal(error.bitgetCode, null);
  });

  it('36. G - the bound counts UTF-8 bytes, not JavaScript characters', async () => {
    const multibyte = '中'.repeat(400_000); // 400k characters, 1.2 MiB of UTF-8
    assert.equal(multibyte.length, 400_000);
    assert.ok(multibyte.length < MAX, 'character count alone would look acceptable');
    assert.ok(Buffer.byteLength(multibyte, 'utf8') > MAX);
    await oversizedError(MAX_STATUS, streamedResponse(multibyte));
    // Same content through the legacy text() shape must also fail: the check is byte-based there too.
    await oversizedError(MAX_STATUS, textOnlyResponse(multibyte));
  });

  it('37. H - oversized bodies never leak their raw message or fixtures', async () => {
    const payload = `${'y'.repeat(MAX + 64)}${FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK}`;
    const error = await oversizedError(MAX_STATUS, streamedResponse(payload));
    assertNoLeak(serializedError(error));
    const nonOk = await oversizedError(503, streamedResponse(
      JSON.stringify({ code: '40012', msg: FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK, pad: 'z'.repeat(MAX) }),
      { status: 503 },
    ));
    assertNoLeak(serializedError(nonOk));
    assertNoLeak(nonOk);
  });

  it('38. oversized 2xx, 4xx and 5xx are all bounded, and TOO_LARGE outranks other classes', async () => {
    await oversizedError(200, streamedResponse(envelopeOfExactBytes(MAX + 1)));
    await oversizedError(400, streamedResponse(envelopeOfExactBytes(MAX + 1), { status: 400 }));
    await oversizedError(500, streamedResponse('{not json'.repeat(200_000), { status: 500 }));
    await oversizedError(200, streamedResponse('<html>'.repeat(200_000)));
  });

  it('39. the arrayBuffer fallback is byte-bounded as well', async () => {
    await oversizedError(MAX_STATUS, streamedResponse(envelopeOfExactBytes(MAX + 1), {
      arrayBufferInsteadOfStream: true,
    }));
    const fine = await createBitgetReadTransport(async () => streamedResponse(
      envelopeOfExactBytes(MAX),
      { arrayBufferInsteadOfStream: true },
    )).get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] });
    assert.equal(typeof fine, 'object');
  });

  it('40. bounded ingestion does not relax envelope validation for in-limit bodies', async () => {
    const cases: Array<[string, string, string]> = [
      ['empty body', '', 'BITGET_READ_RESPONSE_INVALID'],
      ['truncated JSON', '{"code":"00000","data":', 'BITGET_READ_RESPONSE_INVALID'],
      ['missing code', '{"msg":"x","data":[]}', 'BITGET_READ_RESPONSE_INVALID'],
      ['non-00000 code', '{"code":"40012","msg":"x","data":[]}', 'BITGET_READ_API_REJECTED'],
    ];
    for (const [label, body, expected] of cases) {
      const transport = createBitgetReadTransport(async () => streamedResponse(body));
      const caught = await transport
        .get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] })
        .then(() => null, (error: unknown) => error);
      assert.ok(caught instanceof BitgetReadTransportError, label);
      assert.equal(caught.code, expected, label);
      assertNoLeak(serializedError(caught));
    }
    // A large but in-limit body still parses normally.
    const big = JSON.stringify({ code: '00000', msg: 'ok', requestTime: 1, data: { pad: 'q'.repeat(200_000) } });
    assert.ok(Buffer.byteLength(big, 'utf8') < MAX);
    const data = await createBitgetReadTransport(async () => streamedResponse(big))
      .get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] });
    assert.equal((data as { pad: string }).pad.length, 200_000);
  });

  it('41. the existing error-body diagnostic cap still applies below the byte ceiling', async () => {
    const transport = createBitgetReadTransport(async () => streamedResponse(
      JSON.stringify({ code: '40012', msg: FIXTURE_RAW_EXCHANGE_MESSAGE_DO_NOT_LEAK, pad: 'k'.repeat(5_000) }),
      { status: 400 },
    ));
    const caught = await transport
      .get({ endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME, query: [] })
      .then(() => null, (error: unknown) => error);
    assert.ok(caught instanceof BitgetReadTransportError);
    assert.equal(caught.code, 'BITGET_READ_HTTP_FAILED');
    assert.equal(caught.httpStatus, 400);
    assert.equal(caught.bitgetCode, null, 'codes beyond the diagnostic cap are not extracted');
    assertNoLeak(serializedError(caught));
  });
});
