/** Gate.io L0 transport tests are entirely offline: all network surfaces are injected fakes. */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  GATEIO_API_PREFIX,
  GATEIO_L0_INITIAL_CONTRACT,
  GATEIO_L0_LIVE_ORIGIN,
  GATEIO_L0_TESTNET_ORIGIN,
  GATEIO_L0_SETTLE,
  GATEIO_READ_ENDPOINTS,
  canonicalGateIoQuery,
  type GateIoQueryParameter,
  type GateIoReadCredential,
  type GateIoReadEndpoint,
} from '../../src/runtime/gateio/GateIoReadContracts';
import {
  GATEIO_EMPTY_BODY_SHA512,
  GATEIO_V4_L0_SIGNED_METHOD,
  GATEIO_V4_SIGNATURE_ALGORITHM,
  GATEIO_V4_SIGNATURE_ENCODING,
  GATEIO_V4_TIMESTAMP_UNIT,
  gateIoV4SignatureString,
  signGateIoV4Request,
} from '../../src/runtime/gateio/GateIoV4Signer';
import {
  MAX_GATEIO_RESPONSE_BYTES,
  GateIoReadTransportError,
  createGateIoReadTransport,
  createProductionGateIoReadTransport,
  getGateIoReadRequestCount,
  getGateIoReadRequestSequence,
  hasProductionGateIoReadTransportProvenance,
  type GateIoReadFetch,
  type GateIoReadResponse,
} from '../../src/runtime/gateio/GateIoReadTransport';

const FIXTURE_API_KEY = 'FIXTURE_GATEIO_API_KEY_DO_NOT_LEAK';
const FIXTURE_SECRET = 'FIXTURE_GATEIO_SECRET_DO_NOT_LEAK';
const FIXTURE_RAW_MESSAGE = 'FIXTURE_RAW_GATE_MESSAGE_DO_NOT_LEAK';
const FIXTURE_TIMESTAMP = '1700000000';
const credential: GateIoReadCredential = {
  apiKey: FIXTURE_API_KEY,
  secretKey: FIXTURE_SECRET,
};

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function textResponse(status: number, text: string, headers?: Record<string, string>): GateIoReadResponse {
  return new Response(text, { status, headers }) as unknown as GateIoReadResponse;
}

function jsonResponse(status: number, value: unknown): GateIoReadResponse {
  return textResponse(status, JSON.stringify(value), { 'content-type': 'application/json' });
}

function recordingFetch(
  responder: (url: string, init: RequestInit) => GateIoReadResponse | Promise<GateIoReadResponse>,
): { fetchImpl: GateIoReadFetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetchImpl: GateIoReadFetch = async (url, init) => {
    captured.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, captured };
}

function publicRequest(endpoint: GateIoReadEndpoint, query: readonly GateIoQueryParameter[] = []) {
  return { endpoint, query };
}

function authenticatedRequest(
  endpoint: GateIoReadEndpoint,
  query: readonly GateIoQueryParameter[] = [],
) {
  return { endpoint, query, credential, timestamp: FIXTURE_TIMESTAMP };
}

async function capturedError(action: Promise<unknown>): Promise<GateIoReadTransportError> {
  try {
    await action;
  } catch (error) {
    assert.equal(error instanceof GateIoReadTransportError, true);
    return error as GateIoReadTransportError;
  }
  assert.fail('expected GateIoReadTransportError');
}

function serializedError(error: Error): string {
  return `${String(error)}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
}

describe('Gate.io L0 read foundation', () => {
  it('1. freezes the exact live scope and seven-endpoint allowlist', () => {
    assert.equal(GATEIO_L0_LIVE_ORIGIN, 'https://api.gateio.ws');
    assert.equal(GATEIO_API_PREFIX, '/api/v4');
    assert.equal(GATEIO_L0_SETTLE, 'usdt');
    assert.equal(GATEIO_L0_INITIAL_CONTRACT, 'ETH_USDT');
    assert.deepEqual(Object.values(GATEIO_READ_ENDPOINTS), [
      '/api/v4/spot/time',
      '/api/v4/futures/usdt/contracts/ETH_USDT',
      '/api/v4/futures/usdt/tickers',
      '/api/v4/futures/usdt/accounts',
      '/api/v4/futures/usdt/positions',
      '/api/v4/futures/usdt/orders',
      '/api/v4/futures/usdt/my_trades',
    ]);
  });

  it('2. constructs the exact five-line Gate v4 signature string', () => {
    const value = gateIoV4SignatureString({
      timestamp: FIXTURE_TIMESTAMP,
      method: 'GET',
      requestUrl: GATEIO_READ_ENDPOINTS.OPEN_ORDERS,
      canonicalQuery: 'contract=ETH_USDT&status=open',
      body: '',
    });
    assert.equal(value, [
      'GET', GATEIO_READ_ENDPOINTS.OPEN_ORDERS, 'contract=ETH_USDT&status=open',
      GATEIO_EMPTY_BODY_SHA512, FIXTURE_TIMESTAMP,
    ].join('\n'));
  });

  it('3. matches an independently fixed HMAC-SHA512 vector', () => {
    const signed = signGateIoV4Request({
      secretKey: 'fixture-secret', timestamp: FIXTURE_TIMESTAMP, method: 'GET',
      requestUrl: GATEIO_READ_ENDPOINTS.OPEN_ORDERS,
      canonicalQuery: 'contract=ETH_USDT&status=open', body: '',
    });
    assert.equal(signed.signature,
      'f97fc262fefa6f2435c4a094af88f582577caccc2ecf9754743725442dad8fc2'
      + '1c0e4c64ce0bcc776534cbddb38726a74e6932b8a045d28451c6ac7cdc1d7311');
    assert.equal(GATEIO_V4_SIGNATURE_ALGORITHM, 'HMAC-SHA512');
    assert.equal(GATEIO_V4_SIGNATURE_ENCODING, 'hex');
  });

  it('4. uses the correct SHA512 digest of an empty GET body', () => {
    assert.equal(GATEIO_EMPTY_BODY_SHA512, createHash('sha512').update('', 'utf8').digest('hex'));
  });

  it('5. accepts Unix seconds and rejects a millisecond timestamp', () => {
    assert.equal(GATEIO_V4_TIMESTAMP_UNIT, 'UNIX_SECONDS');
    assert.equal(GATEIO_V4_L0_SIGNED_METHOD, 'GET');
    assert.throws(() => signGateIoV4Request({
      secretKey: FIXTURE_SECRET, timestamp: '1700000000000', method: 'GET',
      requestUrl: GATEIO_READ_ENDPOINTS.ACCOUNTS, canonicalQuery: '', body: '',
    }), /GATEIO_READ_TIMESTAMP_INVALID/);
  });

  it('6. serializes deterministic query bytes once', () => {
    assert.equal(canonicalGateIoQuery([
      { name: 'status', value: 'open' },
      { name: 'contract', value: GATEIO_L0_INITIAL_CONTRACT },
    ]), 'contract=ETH_USDT&status=open');
  });

  it('7. issues a valid public time read and normalizes milliseconds strictly', async () => {
    const fake = recordingFetch(() => jsonResponse(200, { server_time: '1700000000123' }));
    const result = await createGateIoReadTransport(fake.fetchImpl).get(
      publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME),
    );
    assert.deepEqual(result, { server_time: 1_700_000_000_123 });
    assert.equal(fake.captured[0]?.url, `${GATEIO_L0_LIVE_ORIGIN}/api/v4/spot/time`);
    assert.equal(fake.captured[0]?.init.headers, undefined);
  });

  it('8. signs and issues a valid authenticated read', async () => {
    const fake = recordingFetch(() => jsonResponse(200, {}));
    await createGateIoReadTransport(fake.fetchImpl).get(
      authenticatedRequest(GATEIO_READ_ENDPOINTS.ACCOUNTS),
    );
    const headers = fake.captured[0]?.init.headers as Readonly<Record<string, string>>;
    assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'Content-Type', 'KEY', 'SIGN', 'Timestamp']);
    assert.equal(headers.KEY, FIXTURE_API_KEY);
    assert.equal(headers.Timestamp, FIXTURE_TIMESTAMP);
    assert.match(headers.SIGN ?? '', /^[0-9a-f]{128}$/);
  });

  it('9. rejects an unknown endpoint before fetch', async () => {
    const fake = recordingFetch(() => jsonResponse(200, {}));
    const error = await capturedError(createGateIoReadTransport(fake.fetchImpl).get({
      endpoint: '/api/v4/wallet/withdrawals' as GateIoReadEndpoint, query: [],
    }));
    assert.equal(error.code, 'GATEIO_READ_REQUEST_INVALID');
    assert.equal(fake.captured.length, 0);
  });

  it('10. rejects duplicate query parameters before fetch', async () => {
    const fake = recordingFetch(() => jsonResponse(200, []));
    const error = await capturedError(createGateIoReadTransport(fake.fetchImpl).get(
      authenticatedRequest(GATEIO_READ_ENDPOINTS.OPEN_ORDERS, [
        { name: 'status', value: 'open' }, { name: 'status', value: 'open' },
      ]),
    ));
    assert.equal(error.code, 'GATEIO_READ_REQUEST_INVALID');
    assert.equal(fake.captured.length, 0);
  });

  it('11. rejects an unknown query parameter before fetch', async () => {
    const fake = recordingFetch(() => jsonResponse(200, []));
    await capturedError(createGateIoReadTransport(fake.fetchImpl).get(
      authenticatedRequest(GATEIO_READ_ENDPOINTS.OPEN_ORDERS, [
        { name: 'status', value: 'open' }, { name: 'limit', value: '10' },
      ]),
    ));
    assert.equal(fake.captured.length, 0);
  });

  it('12. rejects a missing required query before fetch', async () => {
    const fake = recordingFetch(() => jsonResponse(200, []));
    await capturedError(createGateIoReadTransport(fake.fetchImpl).get(
      authenticatedRequest(GATEIO_READ_ENDPOINTS.MY_TRADES),
    ));
    assert.equal(fake.captured.length, 0);
  });

  it('13. rejects malformed closed-vocabulary values', async () => {
    const fake = recordingFetch(() => jsonResponse(200, []));
    await capturedError(createGateIoReadTransport(fake.fetchImpl).get(
      authenticatedRequest(GATEIO_READ_ENDPOINTS.OPEN_ORDERS, [
        { name: 'status', value: 'finished' },
      ]),
    ));
    assert.equal(fake.captured.length, 0);
  });

  it('14. exposes no non-GET transport method', () => {
    const transport = createGateIoReadTransport(async () => jsonResponse(200, {}));
    assert.deepEqual(Object.keys(transport), ['get']);
    assert.equal((transport as unknown as Record<string, unknown>).post, undefined);
    assert.equal((transport as unknown as Record<string, unknown>).delete, undefined);
  });

  it('15. production construction performs zero I/O', () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response('{}'); }) as typeof fetch;
    try {
      createProductionGateIoReadTransport();
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('16. only the closed production constructor obtains provenance', () => {
    const transport = createProductionGateIoReadTransport();
    assert.equal(hasProductionGateIoReadTransportProvenance(transport), true);
  });

  it('17. an injected fetch transport never gains production provenance', () => {
    const transport = createGateIoReadTransport(async () => jsonResponse(200, {}));
    assert.equal(hasProductionGateIoReadTransportProvenance(transport), false);
  });

  it('18. a structural lookalike cannot forge provenance', () => {
    const lookalike = Object.freeze({ get: async () => ({}), production: true });
    assert.equal(hasProductionGateIoReadTransportProvenance(lookalike), false);
    assert.equal(getGateIoReadRequestCount(lookalike), null);
  });

  it('19. records factual total request count', async () => {
    const transport = createGateIoReadTransport(async () => jsonResponse(200, { server_time: 1 }));
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME));
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME));
    assert.equal(getGateIoReadRequestCount(transport)?.total, 2);
  });

  it('20. records factual per-endpoint count', async () => {
    const fake = recordingFetch((url) => url.endsWith('/spot/time')
      ? jsonResponse(200, { server_time: 1 }) : jsonResponse(200, {}));
    const transport = createGateIoReadTransport(fake.fetchImpl);
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME));
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.CONTRACT));
    assert.deepEqual(getGateIoReadRequestCount(transport)?.byEndpoint, {
      [GATEIO_READ_ENDPOINTS.SERVER_TIME]: 1,
      [GATEIO_READ_ENDPOINTS.CONTRACT]: 1,
    });
  });

  it('21. records the ordered actual endpoint sequence', async () => {
    const fake = recordingFetch((url) => url.endsWith('/spot/time')
      ? jsonResponse(200, { server_time: 1 }) : jsonResponse(200, []));
    const transport = createGateIoReadTransport(fake.fetchImpl);
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME));
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.TICKERS, [
      { name: 'contract', value: GATEIO_L0_INITIAL_CONTRACT },
    ]));
    assert.deepEqual(getGateIoReadRequestSequence(transport), [
      GATEIO_READ_ENDPOINTS.SERVER_TIME, GATEIO_READ_ENDPOINTS.TICKERS,
    ]);
  });

  it('22. returned sequence cannot mutate private history', async () => {
    const transport = createGateIoReadTransport(async () => jsonResponse(200, { server_time: 1 }));
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME));
    const observed = getGateIoReadRequestSequence(transport) as GateIoReadEndpoint[];
    assert.throws(() => observed.push(GATEIO_READ_ENDPOINTS.ACCOUNTS), TypeError);
    assert.deepEqual(getGateIoReadRequestSequence(transport), [GATEIO_READ_ENDPOINTS.SERVER_TIME]);
  });

  it('23. returned counters cannot mutate private counters', async () => {
    const transport = createGateIoReadTransport(async () => jsonResponse(200, { server_time: 1 }));
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME));
    const observed = getGateIoReadRequestCount(transport);
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(Object.isFrozen(observed?.byEndpoint), true);
    (observed?.byEndpoint as Record<string, number>).forged = 100;
    assert.equal((observed?.byEndpoint as Record<string, number>).forged, undefined);
    assert.equal(getGateIoReadRequestCount(transport)?.total, 1);
  });

  it('24. network failure makes exactly one attempt', async () => {
    let attempts = 0;
    const transport = createGateIoReadTransport(async () => {
      attempts += 1;
      throw new Error(FIXTURE_RAW_MESSAGE);
    });
    const error = await capturedError(transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME)));
    assert.equal(error.code, 'GATEIO_READ_NETWORK_FAILED');
    assert.equal(attempts, 1);
  });

  it('25. HTTP failure retains only sanitized status and endpoint', async () => {
    const transport = createGateIoReadTransport(async () => textResponse(502, FIXTURE_RAW_MESSAGE));
    const error = await capturedError(transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME)));
    assert.equal(error.code, 'GATEIO_READ_HTTP_FAILED');
    assert.equal(error.httpStatus, 502);
    assert.equal(error.endpoint, GATEIO_READ_ENDPOINTS.SERVER_TIME);
    assert.equal(error.gateLabel, null);
  });

  it('26. Gate API rejection retains a tightly validated label but not message', async () => {
    const transport = createGateIoReadTransport(async () => jsonResponse(401, {
      label: 'INVALID_KEY', message: FIXTURE_RAW_MESSAGE,
    }));
    const error = await capturedError(transport.get(
      authenticatedRequest(GATEIO_READ_ENDPOINTS.ACCOUNTS),
    ));
    assert.equal(error.code, 'GATEIO_READ_API_REJECTED');
    assert.equal(error.httpStatus, 401);
    assert.equal(error.gateLabel, 'INVALID_KEY');
    assert.equal(serializedError(error).includes(FIXTURE_RAW_MESSAGE), false);
  });

  it('27. malformed success JSON fails closed', async () => {
    const transport = createGateIoReadTransport(async () => textResponse(200, '{bad'));
    const error = await capturedError(transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME)));
    assert.equal(error.code, 'GATEIO_READ_RESPONSE_INVALID');
  });

  it('28. malformed server time never normalizes to zero', async () => {
    for (const server_time of ['', 'junk', '-1', Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const transport = createGateIoReadTransport(async () => jsonResponse(200, { server_time }));
      const error = await capturedError(transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME)));
      assert.equal(error.code, 'GATEIO_READ_RESPONSE_INVALID');
    }
  });

  it('29. malformed endpoint-specific success shape fails closed', async () => {
    const transport = createGateIoReadTransport(async () => jsonResponse(200, {}));
    const error = await capturedError(transport.get(publicRequest(GATEIO_READ_ENDPOINTS.TICKERS, [
      { name: 'contract', value: GATEIO_L0_INITIAL_CONTRACT },
    ])));
    assert.equal(error.code, 'GATEIO_READ_RESPONSE_INVALID');
  });

  it('30. declared oversized response fails before body consumption', async () => {
    let consumed = false;
    const response: GateIoReadResponse = {
      ok: true, status: 200,
      headers: { get: () => String(MAX_GATEIO_RESPONSE_BYTES + 1) },
      async text() { consumed = true; return '{}'; },
    };
    const error = await capturedError(createGateIoReadTransport(async () => response).get(
      publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME),
    ));
    assert.equal(error.code, 'GATEIO_READ_RESPONSE_TOO_LARGE');
    assert.equal(consumed, false);
  });

  it('31. factual UTF-8 byte size enforces the fixed response limit', async () => {
    const body = '界'.repeat(Math.floor(MAX_GATEIO_RESPONSE_BYTES / 3) + 1);
    const error = await capturedError(createGateIoReadTransport(async () => textResponse(200, body)).get(
      publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME),
    ));
    assert.equal(error.code, 'GATEIO_READ_RESPONSE_TOO_LARGE');
    assert.equal(MAX_GATEIO_RESPONSE_BYTES, 1_048_576);
  });

  it('32. production sources contain no environment or filesystem credential discovery', () => {
    const source = gateIoProductionSource();
    assert.doesNotMatch(source, /process\.env|dotenv|node:fs|readFile|\.gateio\.env|registry/i);
  });

  it('33. production sources contain no mutation/order method or arbitrary-path transport', () => {
    const source = gateIoProductionSource();
    assert.doesNotMatch(source,
      /placeOrder|cancelOrder|modifyOrder|setLeverage|setMarginMode|setPositionMode|transfer|withdraw/);
    assert.doesNotMatch(source, /fetchArbitrary|request\(path|get\(path/);
  });

  it('34. explicit live/testnet origins have no US or fallback host', () => {
    const source = gateIoProductionSource();
    assert.equal(GATEIO_L0_LIVE_ORIGIN, 'https://api.gateio.ws');
    assert.equal(GATEIO_L0_TESTNET_ORIGIN, 'https://api-testnet.gateapi.io');
    assert.doesNotMatch(source, /fx-api\.gateio\.ws|gate\.us/);
  });

  it('35. production sources contain no retry, polling or background timer implementation', () => {
    const source = stripComments(gateIoProductionSource());
    assert.doesNotMatch(source, /setTimeout|setInterval|retry\s*\(|poll\s*\(|backoff/i);
  });

  it('36. serialized errors cannot contain the fixture API key', async () => {
    const error = await fixtureApiError();
    assert.equal(serializedError(error).includes(FIXTURE_API_KEY), false);
  });

  it('37. serialized errors cannot contain the fixture secret', async () => {
    const error = await fixtureApiError();
    assert.equal(serializedError(error).includes(FIXTURE_SECRET), false);
  });

  it('38. serialized errors cannot contain signature bytes or authenticated header values', async () => {
    const error = await fixtureApiError();
    const serialized = serializedError(error);
    assert.equal(serialized.includes('fixture-signature'), false);
    assert.equal(serialized.includes(FIXTURE_TIMESTAMP), false);
    assert.equal(serialized.includes('"KEY"'), false);
  });

  it('39. serialized errors cannot contain raw Gate body or exchange message', async () => {
    const error = await fixtureApiError();
    const serialized = serializedError(error);
    assert.equal(serialized.includes(FIXTURE_RAW_MESSAGE), false);
    assert.equal(serialized.includes('message'), false);
  });

  it('40. emitted query bytes are exactly the bytes signed in the header', async () => {
    const fake = recordingFetch(() => jsonResponse(200, []));
    await createGateIoReadTransport(fake.fetchImpl).get(authenticatedRequest(
      GATEIO_READ_ENDPOINTS.OPEN_ORDERS,
      [{ name: 'status', value: 'open' }, { name: 'contract', value: GATEIO_L0_INITIAL_CONTRACT }],
    ));
    const request = fake.captured[0];
    const emittedQuery = request?.url.split('?')[1] ?? '';
    const headers = request?.init.headers as Readonly<Record<string, string>>;
    const signatureString = ['GET', GATEIO_READ_ENDPOINTS.OPEN_ORDERS, emittedQuery,
      GATEIO_EMPTY_BODY_SHA512, FIXTURE_TIMESTAMP].join('\n');
    const expected = createHmac('sha512', FIXTURE_SECRET).update(signatureString).digest('hex');
    assert.equal(emittedQuery, 'contract=ETH_USDT&status=open');
    assert.equal(headers.SIGN, expected);
    assert.equal(request?.init.redirect, 'error');
  });

  it('41. factual sequence length always equals factual request count', async () => {
    const transport = createGateIoReadTransport(async () => jsonResponse(200, { server_time: 1 }));
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME));
    await transport.get(publicRequest(GATEIO_READ_ENDPOINTS.SERVER_TIME));
    assert.equal(getGateIoReadRequestSequence(transport)?.length,
      getGateIoReadRequestCount(transport)?.total);
  });

  it('42. every authenticated allowlisted endpoint is callable with its exact contract', async () => {
    const transport = createGateIoReadTransport(async () => jsonResponse(200, []));
    const accountTransport = createGateIoReadTransport(async () => jsonResponse(200, {}));
    await accountTransport.get(authenticatedRequest(GATEIO_READ_ENDPOINTS.ACCOUNTS));
    await transport.get(authenticatedRequest(GATEIO_READ_ENDPOINTS.POSITIONS));
    await transport.get(authenticatedRequest(GATEIO_READ_ENDPOINTS.OPEN_ORDERS, [
      { name: 'status', value: 'open' },
    ]));
    await transport.get(authenticatedRequest(GATEIO_READ_ENDPOINTS.MY_TRADES, [
      { name: 'contract', value: GATEIO_L0_INITIAL_CONTRACT },
    ]));
    assert.equal(getGateIoReadRequestCount(accountTransport)?.total, 1);
    assert.equal(getGateIoReadRequestCount(transport)?.total, 3);
  });

  it('43. missing API key fails closed before fetch', async () => {
    const fake = recordingFetch(() => jsonResponse(200, {}));
    const invalid = { apiKey: '', secretKey: FIXTURE_SECRET };
    const error = await capturedError(createGateIoReadTransport(fake.fetchImpl).get({
      endpoint: GATEIO_READ_ENDPOINTS.ACCOUNTS, query: [],
      credential: invalid, timestamp: FIXTURE_TIMESTAMP,
    }));
    assert.equal(error.code, 'GATEIO_READ_REQUEST_INVALID');
    assert.equal(fake.captured.length, 0);
  });

  it('44. missing secret fails closed before fetch', async () => {
    const fake = recordingFetch(() => jsonResponse(200, {}));
    const invalid = { apiKey: FIXTURE_API_KEY, secretKey: '' };
    await capturedError(createGateIoReadTransport(fake.fetchImpl).get({
      endpoint: GATEIO_READ_ENDPOINTS.ACCOUNTS, query: [],
      credential: invalid, timestamp: FIXTURE_TIMESTAMP,
    }));
    assert.equal(fake.captured.length, 0);
  });

  it('45. missing signed timestamp fails closed before fetch', async () => {
    const fake = recordingFetch(() => jsonResponse(200, {}));
    await capturedError(createGateIoReadTransport(fake.fetchImpl).get({
      endpoint: GATEIO_READ_ENDPOINTS.ACCOUNTS, query: [], credential,
    }));
    assert.equal(fake.captured.length, 0);
  });

  it('46. a public endpoint rejects credentials and a timestamp before fetch', async () => {
    const fake = recordingFetch(() => jsonResponse(200, { server_time: 1 }));
    await capturedError(createGateIoReadTransport(fake.fetchImpl).get({
      endpoint: GATEIO_READ_ENDPOINTS.SERVER_TIME, query: [], credential,
      timestamp: FIXTURE_TIMESTAMP,
    }));
    assert.equal(fake.captured.length, 0);
  });
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

function gateIoProductionSource(): string {
  return [
    'GateIoReadContracts.ts', 'GateIoV4Signer.ts', 'GateIoReadTransport.ts',
  ].map((file) => readFileSync(`src/runtime/gateio/${file}`, 'utf8')).join('\n');
}

async function fixtureApiError(): Promise<GateIoReadTransportError> {
  const transport = createGateIoReadTransport(async () => jsonResponse(401, {
    label: 'INVALID_SIGNATURE', message: FIXTURE_RAW_MESSAGE,
    apiKey: FIXTURE_API_KEY, secretKey: FIXTURE_SECRET, SIGN: 'fixture-signature',
  }));
  return capturedError(transport.get(authenticatedRequest(GATEIO_READ_ENDPOINTS.ACCOUNTS)));
}
