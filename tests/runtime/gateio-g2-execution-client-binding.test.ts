/** Gate.io G2 tests are recording-transport only: no socket, env credential, TestNet, or Live I/O. */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { GateIoFuturesExecutionAdapter } from '../../src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { OmsCore } from '../../src/oms/OmsCore';
import type {
  GateIoAuthenticatedReadFoundation,
  GateIoCanonicalInstrumentFacts,
  GateIoFoundationReadResult,
} from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import {
  GATEIO_EXECUTION_ORDER_PATH,
  GATEIO_EXECUTION_ORIGINS,
  GATEIO_EXECUTION_POST_RETRY_COUNT,
  GATEIO_G3_PROOF_MUTATION_HARD_CAP,
  GATEIO_G3_EMERGENCY_CLEANUP_RESERVE,
  GATEIO_G3_TOTAL_MUTATION_HARD_CAP,
  GateIoG3MutationBudget,
  GateIoFuturesExecutionClientError,
  createGateIoFuturesExecutionClient,
  type GateIoEnvironment,
  type GateIoFuturesExecutionFetch,
} from '../../src/runtime/gateio/GateIoFuturesExecutionClient';
import type { GateIoReadResponse } from '../../src/runtime/gateio/GateIoReadTransport';

const API_KEY = 'FIXTURE_GATEIO_G2_KEY_DO_NOT_LEAK';
const SECRET = 'FIXTURE_GATEIO_G2_SECRET_DO_NOT_LEAK';
const RAW_MESSAGE = 'FIXTURE_GATEIO_G2_RAW_MESSAGE_DO_NOT_LEAK';
const TIMESTAMP = '1800000000';
const CLIENT_TEXT = 't-dsb-' + 'a'.repeat(22);
const EXACT_INT64 = '9223372036854775806';

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function facts(
  patch: Partial<GateIoCanonicalInstrumentFacts> = {},
): GateIoCanonicalInstrumentFacts {
  return Object.freeze({
    contract: 'ETH_USDT',
    contractStatus: 'trading',
    contractOpenable: true,
    inDelisting: false,
    contractMultiplier: 0.001,
    minOrderSize: 1,
    maxOrderSize: 1_000,
    decimalSizeEnabled: false,
    priceStep: 0.01,
    markPriceStep: 0.01,
    minLeverage: 1,
    maxLeverage: 100,
    markPrice: 2_000,
    indexPrice: 1_999,
    lastPrice: 2_001,
    makerFeeRate: -0.0002,
    takerFeeRate: 0.0005,
    fundingRate: 0.0001,
    serverTimeMs: 1_800_000_000_000,
    observedAtMs: 1_800_000_000_000,
    freshness: 'FRESH',
    source: 'gateio-usdt-futures-read',
    schemaVersion: 'gateio-l1a-v1',
    ...patch,
  });
}

function readResult(
  value: GateIoCanonicalInstrumentFacts | null = facts(),
  availability: GateIoFoundationReadResult<GateIoCanonicalInstrumentFacts>['availability']
    = value === null ? 'UNKNOWN' : 'AVAILABLE',
): GateIoFoundationReadResult<GateIoCanonicalInstrumentFacts> {
  return Object.freeze({
    availability,
    value,
    reason: value === null ? 'INSTRUMENT_FACTS_UNKNOWN' : null,
    failureProvenance: null,
  });
}

function foundation(
  result: GateIoFoundationReadResult<GateIoCanonicalInstrumentFacts> = readResult(),
): Pick<GateIoAuthenticatedReadFoundation, 'instrumentFacts'> {
  return Object.freeze({ async instrumentFacts() { return result; } });
}

function rawResponse(status: number, raw: string): GateIoReadResponse {
  return new Response(raw, {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as GateIoReadResponse;
}

function jsonResponse(status: number, value: unknown): GateIoReadResponse {
  return rawResponse(status, JSON.stringify(value));
}

function orderObject(body: Record<string, unknown>, patch: Record<string, unknown> = {}) {
  return {
    id: EXACT_INT64,
    text: body.text,
    contract: body.contract,
    size: body.size,
    left: 0,
    status: 'finished',
    finish_as: 'filled',
    fill_price: '2001',
    finish_time: 1_800_000_000.123,
    ...patch,
  };
}

function recordingFetch(
  responder: (
    request: Captured,
    index: number,
  ) => GateIoReadResponse | Promise<GateIoReadResponse>,
): { readonly fetchImpl: GateIoFuturesExecutionFetch; readonly captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl: GateIoFuturesExecutionFetch = async (url, init) => {
    const request = { url, init };
    captured.push(request);
    return responder(request, captured.length - 1);
  };
  return { fetchImpl, captured };
}

function client(input: {
  readonly environment?: GateIoEnvironment;
  readonly fetchImpl: GateIoFuturesExecutionFetch;
  readonly read?: Pick<GateIoAuthenticatedReadFoundation, 'instrumentFacts'>;
  readonly signedTimestamp?: () => string;
  readonly mutationBudget?: GateIoG3MutationBudget;
}) {
  return createGateIoFuturesExecutionClient({
    environment: input.environment ?? 'testnet',
    credential: { apiKey: API_KEY, secretKey: SECRET },
    signedTimestamp: input.signedTimestamp ?? (() => TIMESTAMP),
    fetchImpl: input.fetchImpl,
    readFoundation: input.read ?? foundation(),
    mutationBudget: input.mutationBudget ?? GateIoG3MutationBudget.create(),
  });
}

function request(patch: Record<string, unknown> = {}) {
  return {
    contract: 'ETH_USDT' as const,
    size: 5,
    price: '0' as const,
    tif: 'ioc' as const,
    reduceOnly: false,
    text: CLIENT_TEXT,
    ...patch,
  };
}

function parsedBody(captured: Captured): Record<string, unknown> {
  assert.equal(typeof captured.init.body, 'string');
  return JSON.parse(captured.init.body as string) as Record<string, unknown>;
}

describe('Gate.io G2 closed environment and signing surface', () => {
  it('binds exact testnet/live origins with no default or cross-environment fallback', async () => {
    assert.deepEqual(GATEIO_EXECUTION_ORIGINS, {
      testnet: 'https://api-testnet.gateapi.io',
      live: 'https://api.gateio.ws',
    });
    for (const environment of ['testnet', 'live'] as const) {
      const fake = recordingFetch(({ init }) => jsonResponse(
        200, orderObject(JSON.parse(init.body as string)),
      ));
      await client({ environment, fetchImpl: fake.fetchImpl }).submitMarketOrder(request());
      assert.equal(fake.captured.length, 1);
      assert.equal(fake.captured[0]?.url,
        GATEIO_EXECUTION_ORIGINS[environment] + GATEIO_EXECUTION_ORDER_PATH);
      const forbidden = environment === 'testnet' ? GATEIO_EXECUTION_ORIGINS.live
        : GATEIO_EXECUTION_ORIGINS.testnet;
      assert.equal(fake.captured.some(entry => entry.url.startsWith(forbidden)), false);
    }
    const invalid = {
      credential: { apiKey: API_KEY, secretKey: SECRET },
      signedTimestamp: () => TIMESTAMP,
      fetchImpl: recordingFetch(() => jsonResponse(200, {})).fetchImpl,
      readFoundation: foundation(),
    };
    assert.throws(
      () => createGateIoFuturesExecutionClient(invalid as never),
      /GATEIO_EXECUTION_CONFIGURATION_INVALID/,
    );
    const testnetWithoutBudget = { ...invalid, environment: 'testnet' };
    assert.throws(() => createGateIoFuturesExecutionClient(testnetWithoutBudget as never),
      (error: unknown) => {
        assert.ok(error instanceof GateIoFuturesExecutionClientError);
        assert.equal(error.decision, 'DENIED');
        assert.equal(error.reasonCode, 'GATEIO_EXECUTION_CONFIGURATION_INVALID');
        return true;
      });
    const liveWithoutG3Budget = createGateIoFuturesExecutionClient({
      ...invalid, environment: 'live',
    });
    assert.equal(typeof liveWithoutG3Budget.submitMarketOrder, 'function');
  });

  it('emits the one closed POST body and an independently reproducible signature', async () => {
    const fake = recordingFetch(({ init }) => jsonResponse(
      200, orderObject(JSON.parse(init.body as string)),
    ));
    const result = await client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(request());
    assert.equal(result.status, 'FINISHED');
    assert.equal(fake.captured.length, 1);
    const captured = fake.captured[0]!;
    const body = captured.init.body as string;
    assert.deepEqual(JSON.parse(body), {
      contract: 'ETH_USDT',
      size: 5,
      price: '0',
      tif: 'ioc',
      reduce_only: false,
      text: CLIENT_TEXT,
    });
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(),
      ['contract', 'price', 'reduce_only', 'size', 'text', 'tif']);
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.redirect, 'error');
    const headers = captured.init.headers as Record<string, string>;
    assert.equal(headers.KEY, API_KEY);
    assert.equal(headers.Timestamp, TIMESTAMP);
    const bodyHash = createHash('sha512').update(body, 'utf8').digest('hex');
    const signing = ['POST', GATEIO_EXECUTION_ORDER_PATH, '', bodyHash, TIMESTAMP].join('\n');
    const expected = createHmac('sha512', SECRET).update(signing, 'utf8').digest('hex');
    assert.equal(headers.SIGN, expected);
  });

  it('rejects malformed requests and timestamps before the injected wire port', async () => {
    const fake = recordingFetch(() => jsonResponse(200, {}));
    const binding = client({ fetchImpl: fake.fetchImpl });
    for (const invalid of [
      request({ contract: 'BTC_USDT' }),
      request({ size: 0 }),
      request({ size: 1.05 }),
      request({ price: '1' }),
      request({ tif: 'gtc' }),
      request({ text: 'bad' }),
      request({ leverage: 10 }),
    ]) {
      await assert.rejects(binding.submitMarketOrder(invalid as never),
        /GATEIO_EXECUTION_REQUEST_INVALID/);
    }
    const invalidClock = client({ fetchImpl: fake.fetchImpl, signedTimestamp: () => '1800000000000' });
    await assert.rejects(invalidClock.submitMarketOrder(request()),
      /GATEIO_EXECUTION_REQUEST_INVALID/);
    assert.equal(fake.captured.length, 0);
  });
});

describe('Gate.io G2 mutation outcome and reconciliation', () => {
  it('enforces two proof POSTs plus one reduce-only cleanup before fetch, including across clients', async () => {
    const budget = GateIoG3MutationBudget.create();
    const fake = recordingFetch(({ init }) => jsonResponse(
      200, orderObject(JSON.parse(init.body as string)),
    ));
    const first = client({ fetchImpl: fake.fetchImpl, mutationBudget: budget });
    const second = client({ fetchImpl: fake.fetchImpl, mutationBudget: budget });
    assert.equal((await first.submitMarketOrder(request())).status, 'FINISHED');
    assert.equal((await second.submitMarketOrder(request())).status, 'FINISHED');
    await assert.rejects(first.submitMarketOrder(request()), (error: unknown) => {
      assert.ok(error instanceof GateIoFuturesExecutionClientError);
      assert.equal(error.decision, 'DENIED');
      assert.equal(error.reasonCode, 'MUTATION_CAP_EXCEEDED');
      assert.equal(JSON.stringify(error).includes(API_KEY), false);
      assert.equal(JSON.stringify(error).includes(SECRET), false);
      return true;
    });
    assert.equal(fake.captured.length, 2);
    assert.equal(fake.captured.filter(entry => entry.init.method === 'POST').length, 2);

    await assert.rejects(first.submitMarketOrder(request(), 'EMERGENCY_CLEANUP'),
      /GATEIO_EXECUTION_MUTATION_CAP_EXCEEDED/);
    assert.equal(fake.captured.length, 2);
    assert.equal((await first.submitMarketOrder(request({ size: -5, reduceOnly: true }),
      'EMERGENCY_CLEANUP')).status, 'FINISHED');
    await assert.rejects(second.submitMarketOrder(request({ size: -5, reduceOnly: true }),
      'EMERGENCY_CLEANUP'), /GATEIO_EXECUTION_MUTATION_CAP_EXCEEDED/);
    assert.equal(fake.captured.length, 3);
    assert.deepEqual(budget.snapshot(), { proof: 2, cleanup: 1, total: 3 });
    assert.equal(GATEIO_G3_PROOF_MUTATION_HARD_CAP, 2);
    assert.equal(GATEIO_G3_EMERGENCY_CLEANUP_RESERVE, 1);
    assert.equal(GATEIO_G3_TOTAL_MUTATION_HARD_CAP, 3);
  });

  it('returns safe structured denial for an invalid contract without touching transport', async () => {
    const fake = recordingFetch(() => jsonResponse(200, {}));
    await assert.rejects(client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(
      request({ contract: 'BTC_USDT' }),
    ), (error: unknown) => {
      assert.ok(error instanceof GateIoFuturesExecutionClientError);
      assert.equal(error.decision, 'DENIED');
      assert.equal(error.reasonCode, 'GATEIO_EXECUTION_REQUEST_INVALID');
      const serialized = JSON.stringify(error);
      for (const secret of [API_KEY, SECRET, RAW_MESSAGE, 'SIGN', 'KEY']) {
        assert.equal(serialized.includes(secret), false);
      }
      return true;
    });
    assert.equal(fake.captured.length, 0);
  });

  it('maps a definite 4xx API rejection without reconciliation or POST retry', async () => {
    const fake = recordingFetch(() => jsonResponse(400, {
      label: 'INVALID_PARAM_VALUE', message: RAW_MESSAGE, secret: SECRET,
    }));
    const result = await client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(request());
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.rejectionReason, 'INVALID_PARAM_VALUE');
    assert.equal(fake.captured.length, 1);
    assert.equal(fake.captured[0]?.init.method, 'POST');
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes(RAW_MESSAGE), false);
  });

  it('uses exactly one POST then one GET by original client text after transport ambiguity', async () => {
    const fake = recordingFetch((captured, index) => {
      if (index === 0) throw new Error(RAW_MESSAGE);
      assert.equal(captured.init.method, 'GET');
      return jsonResponse(200, orderObject(request()));
    });
    const result = await client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(request());
    assert.equal(result.status, 'FINISHED');
    assert.deepEqual(fake.captured.map(entry => entry.init.method), ['POST', 'GET']);
    const reconciliationPath = GATEIO_EXECUTION_ORDER_PATH + '/' + CLIENT_TEXT;
    assert.equal(fake.captured[1]?.url, GATEIO_EXECUTION_ORIGINS.testnet + reconciliationPath);
    assert.equal(fake.captured.every(entry => entry.url.startsWith(GATEIO_EXECUTION_ORIGINS.testnet)),
      true);
    const getHeaders = fake.captured[1]?.init.headers as Record<string, string>;
    const emptyHash = createHash('sha512').update('', 'utf8').digest('hex');
    const getSigning = ['GET', reconciliationPath, '', emptyHash, TIMESTAMP].join('\n');
    assert.equal(getHeaders.SIGN,
      createHmac('sha512', SECRET).update(getSigning, 'utf8').digest('hex'));
    assert.equal(GATEIO_EXECUTION_POST_RETRY_COUNT, 0);
  });

  it('ignores a pre-submit FLAT observation and uses a new post-submit GET to prove the fill', async () => {
    const preSubmitPosition = 'FLAT';
    const fake = recordingFetch((captured, index) => {
      if (index === 0) {
        assert.equal(captured.init.method, 'POST');
        throw new Error(RAW_MESSAGE);
      }
      assert.equal(index, 1);
      assert.equal(captured.init.method, 'GET');
      return jsonResponse(200, orderObject(request()));
    });
    assert.equal(preSubmitPosition, 'FLAT');
    const result = await client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(request());
    assert.equal(result.status, 'FINISHED');
    assert.equal(result.signedFilledSize, 5);
    assert.deepEqual(fake.captured.map(entry => entry.init.method), ['POST', 'GET']);
    assert.equal(fake.captured[1]?.url,
      GATEIO_EXECUTION_ORIGINS.testnet + GATEIO_EXECUTION_ORDER_PATH + '/' + CLIENT_TEXT);
  });

  it('keeps unknown unknown when reconciliation cannot prove submission', async () => {
    const fake = recordingFetch((_captured, index) => {
      if (index === 0) throw new Error(RAW_MESSAGE);
      return jsonResponse(404, { label: 'ORDER_NOT_FOUND', message: RAW_MESSAGE });
    });
    let error: unknown;
    try {
      await client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(request());
    } catch (caught) {
      error = caught;
    }
    assert.equal(error instanceof GateIoFuturesExecutionClientError, true);
    assert.equal((error as GateIoFuturesExecutionClientError).code,
      'GATEIO_EXECUTION_SUBMISSION_UNKNOWN');
    assert.deepEqual(fake.captured.map(entry => entry.init.method), ['POST', 'GET']);
    const serialized = String(error) + JSON.stringify(error);
    for (const secret of [API_KEY, SECRET, RAW_MESSAGE, TIMESTAMP]) {
      assert.equal(serialized.includes(secret), false);
    }
  });

  it('reconciles a 5xx response but never converts one missing GET into safe retry', async () => {
    const fake = recordingFetch((_captured, index) => index === 0
      ? jsonResponse(503, { label: 'INTERNAL', message: RAW_MESSAGE })
      : jsonResponse(404, { label: 'ORDER_NOT_FOUND' }));
    await assert.rejects(
      client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(request()),
      /GATEIO_EXECUTION_SUBMISSION_UNKNOWN/,
    );
    assert.equal(fake.captured.filter(entry => entry.init.method === 'POST').length, 1);
    assert.equal(fake.captured.filter(entry => entry.init.method === 'GET').length, 1);
  });

  it('makes attribution mismatch UNKNOWN after one factual lookup attempt', async () => {
    const fake = recordingFetch((_captured, index) => jsonResponse(200, orderObject(request(), {
      text: index === 0 ? 't-dsb-' + 'b'.repeat(22) : 't-dsb-' + 'c'.repeat(22),
    })));
    await assert.rejects(
      client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(request()),
      /GATEIO_EXECUTION_SUBMISSION_UNKNOWN/,
    );
    assert.deepEqual(fake.captured.map(entry => entry.init.method), ['POST', 'GET']);
  });
});

describe('Gate.io G2 int64 and canonical truth safety', () => {
  it('recovers a 17+ digit exact order id from transient raw text', async () => {
    const fake = recordingFetch(({ init }) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      const raw = JSON.stringify(orderObject(body, { id: '__ID__' }))
        .replace('"__ID__"', EXACT_INT64);
      return rawResponse(200, raw);
    });
    const result = await client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(request());
    assert.equal(result.status, 'FINISHED');
    assert.equal(result.exchangeOrderId, EXACT_INT64);
    assert.equal(result.tradeId, EXACT_INT64);
    assert.equal(JSON.stringify(result).includes('__ID__'), false);
  });

  it('never promotes an unrecoverable rounded JS number to an order-id fact', async () => {
    const fake = recordingFetch((_captured, index) => {
      if (index !== 0) return jsonResponse(404, { label: 'ORDER_NOT_FOUND' });
      const raw = JSON.stringify(orderObject(request(), { id: '__UNSAFE_ID__' }))
        .replace('"__UNSAFE_ID__"', '9.007199254740992e15');
      return rawResponse(200, raw);
    });
    await assert.rejects(
      client({ fetchImpl: fake.fetchImpl }).submitMarketOrder(request()),
      /GATEIO_EXECUTION_SUBMISSION_UNKNOWN/,
    );
  });

  it('reuses only AVAILABLE/FRESH L1A instrument facts for ETH/USDT', async () => {
    const unused = recordingFetch(() => jsonResponse(500, {})).fetchImpl;
    const fresh = facts();
    assert.equal(await client({
      fetchImpl: unused,
      read: foundation(readResult(fresh)),
    }).getInstrumentFacts('ETH/USDT'), fresh);
    assert.equal(await client({
      fetchImpl: unused,
      read: foundation(readResult(facts({ freshness: 'STALE' }))),
    }).getInstrumentFacts('ETH/USDT'), null);
    assert.equal(await client({
      fetchImpl: unused,
      read: foundation(readResult(null, 'UNKNOWN')),
    }).getInstrumentFacts('ETH/USDT'), null);
    assert.equal(await client({ fetchImpl: unused }).getInstrumentFacts('BTC/USDT'), null);
  });
});

describe('Gate.io G2 real OMS-to-wire integration and static boundary', () => {
  it('records a capped mutation as an OMS rejection without a network POST', async () => {
    const budget = GateIoG3MutationBudget.create();
    budget.consume('PROOF', false);
    budget.consume('PROOF', false);
    const fake = recordingFetch(() => jsonResponse(200, {}));
    const kernel = createTradingKernel({ exchange: 'gateio' });
    const oms = new OmsCore(kernel, new GateIoFuturesExecutionAdapter(
      client({ fetchImpl: fake.fetchImpl, mutationBudget: budget }),
    ));
    const result = await oms.submitRequest({
      intentId: 'gateio-g3-capped', exchange: 'gateio', symbol: 'ETH/USDT',
      direction: 'long', orderType: 'market', positionUsd: 10.9,
      source: 'test', createdAt: 1, reason: 'test', biasUpdatedAt: 1,
    }, 'open', 10.9);
    assert.equal(result.status, 'rejected');
    assert.equal(fake.captured.length, 0);
    const events = kernel.journal().readFromLogicalSequence(1);
    assert.deepEqual(events.map(entry => entry.type),
      ['order.created', 'order.submitted', 'order.rejected']);
    assert.equal(JSON.stringify(events).includes('MUTATION_CAP_EXCEEDED'), true);
    assert.deepEqual(budget.snapshot(), { proof: 2, cleanup: 0, total: 2 });
  });

  it('drives OPEN and CLOSE through real Kernel, OMS, adapter, client, and recorded Gate wire', async () => {
    for (const scenario of [
      { action: 'open' as const, direction: 'long' as const, expectedSize: 5, reduceOnly: false },
      { action: 'close' as const, direction: 'short' as const, expectedSize: -5, reduceOnly: true },
    ]) {
      const fake = recordingFetch(({ init }) => {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        return jsonResponse(200, orderObject(body));
      });
      const kernel = createTradingKernel({ exchange: 'gateio' });
      const oms = new OmsCore(kernel, new GateIoFuturesExecutionAdapter(
        client({ fetchImpl: fake.fetchImpl }),
      ));
      const result = await oms.submitRequest({
        intentId: 'gateio-g2-' + scenario.action,
        exchange: 'gateio',
        symbol: 'ETH/USDT',
        direction: scenario.direction,
        orderType: 'market',
        positionUsd: 10.9,
        source: 'test',
        createdAt: 1,
        reason: 'test',
        biasUpdatedAt: 1,
      }, scenario.action, 10.9);
      assert.equal(result.status, 'filled');
      assert.equal(result.fill?.exchange, 'gateio');
      const body = parsedBody(fake.captured[0]!);
      assert.equal(body.size, scenario.expectedSize);
      assert.equal(body.reduce_only, scenario.reduceOnly);
      assert.deepEqual(
        kernel.journal().readFromLogicalSequence(1).map(entry => entry.type),
        ['order.created', 'order.submitted', 'execution.fill.confirmed'],
      );
    }
  });

  it('contains no ambient credential/network discovery, mutation widening, retry, or authority bypass', () => {
    const clientSource = readFileSync(
      'src/runtime/gateio/GateIoFuturesExecutionClient.ts', 'utf8',
    );
    const adapterSource = readFileSync(
      'src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter.ts', 'utf8',
    );
    for (const forbidden of [
      'process.env', '.gateio.env', 'dotenv', 'globalThis.fetch', 'setTimeout(', 'setInterval(',
      'console.',
      'DELETE', 'PATCH', 'setLeverage', 'setMarginMode', 'setPositionMode', 'transfer', 'withdraw',
      'kernel.publish', 'PositionManager',
    ]) {
      assert.equal(clientSource.includes(forbidden), false, forbidden);
    }
    assert.equal(clientSource.match(/fetchImpl\(/g)?.length, 1);
    assert.doesNotMatch(clientSource, /from ['"][^'"]*(strategy|agent|dashboard|skill)/i);
    assert.equal(adapterSource.includes('kernel.publish'), false);
    assert.equal(adapterSource.includes('fetch('), false);
  });
});
