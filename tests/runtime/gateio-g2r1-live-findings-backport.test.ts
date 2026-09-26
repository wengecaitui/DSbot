/** F-09 backport tests are deterministic and use only injected facts, clients, and wire responses. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OmsOrder } from '../../src/oms/oms-types';
import {
  GateIoFuturesExecutionAdapter,
  type GateIoFuturesExecutionClient,
  type GateIoFuturesMarketOrderRequest,
} from '../../src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import type {
  GateIoAuthenticatedReadFoundation,
  GateIoCanonicalInstrumentFacts,
} from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import {
  GATEIO_EXECUTION_POST_RETRY_COUNT,
  GateIoG3MutationBudget,
  createGateIoFuturesExecutionClient,
  type GateIoFuturesExecutionFetch,
} from '../../src/runtime/gateio/GateIoFuturesExecutionClient';
import type { GateIoReadResponse } from '../../src/runtime/gateio/GateIoReadTransport';

const ORDER_ID = 'a'.repeat(64);
const CLIENT_TEXT = `t-dsb-${'a'.repeat(22)}`;
const EXACT_INT64 = '9223372036854775806';
const MARK = 2_000;
const MULTIPLIER = 0.01;

function decimalFacts(
  patch: Partial<GateIoCanonicalInstrumentFacts> = {},
): GateIoCanonicalInstrumentFacts {
  return Object.freeze({
    contract: 'ETH_USDT', contractStatus: 'trading', contractOpenable: true,
    inDelisting: false, contractMultiplier: MULTIPLIER, minOrderSize: 0.1,
    maxOrderSize: 1_000, decimalSizeEnabled: true, priceStep: 0.01,
    markPriceStep: 0.01, minLeverage: 1, maxLeverage: 100, markPrice: MARK,
    indexPrice: MARK, lastPrice: MARK, makerFeeRate: -0.0002, takerFeeRate: 0.0005,
    fundingRate: 0.0001, serverTimeMs: 1_800_000_000_000,
    observedAtMs: 1_800_000_000_000, freshness: 'FRESH',
    source: 'gateio-usdt-futures-read', schemaVersion: 'gateio-l1a-v1', ...patch,
  });
}

function order(patch: Partial<OmsOrder> = {}): OmsOrder {
  return {
    orderId: ORDER_ID, intentId: 'gateio-g2r1', exchange: 'gateio', symbol: 'ETH/USDT',
    action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 2, ...patch,
  };
}

function recordingAdapterClient(facts: GateIoCanonicalInstrumentFacts = decimalFacts()) {
  const requests: GateIoFuturesMarketOrderRequest[] = [];
  const client: GateIoFuturesExecutionClient = Object.freeze({
    async getInstrumentFacts() { return facts; },
    async submitMarketOrder(request: GateIoFuturesMarketOrderRequest) {
      requests.push(request);
      return Object.freeze({
        status: 'FINISHED' as const, clientText: request.text, contract: request.contract,
        signedFilledSize: request.size, averagePrice: facts.markPrice,
        executedAt: 1_800_000_000.123, tradeId: EXACT_INT64,
        exchangeOrderId: EXACT_INT64,
      });
    },
  });
  return { client, requests };
}

describe('Gate.io G2R1 F-09 fractional ETH sizing', () => {
  it('preserves factual 0.1, 0.2, 0.3 and 1 contract sizes deterministically', async () => {
    for (const contracts of [0.1, 0.2, 0.3, 1]) {
      const recorded = recordingAdapterClient();
      const result = await new GateIoFuturesExecutionAdapter(recorded.client).submit(order({
        approvedNotionalUsd: contracts * MARK * MULTIPLIER,
      }));
      assert.equal(result.status, 'filled');
      assert.equal(recorded.requests[0]?.size, contracts);
    }
  });

  it('maps buy +0.1 and sell -0.1 but never grows 0.09 into the factual minimum', async () => {
    for (const side of ['buy', 'sell'] as const) {
      const recorded = recordingAdapterClient();
      assert.equal((await new GateIoFuturesExecutionAdapter(recorded.client).submit(
        order({ side }),
      )).status, 'filled');
      assert.equal(recorded.requests[0]?.size, side === 'buy' ? 0.1 : -0.1);
    }
    const below = recordingAdapterClient();
    const rejected = await new GateIoFuturesExecutionAdapter(below.client).submit(order({
      approvedNotionalUsd: 0.09 * MARK * MULTIPLIER,
    }));
    assert.equal(rejected.status, 'rejected');
    assert.equal(below.requests.length, 0);
  });

  it('closes factual +0.1 after a 0.1% mark rise with -0.1 and reduce-only', async () => {
    for (const action of ['reduce', 'close', 'emergency_exit'] as const) {
      const recorded = recordingAdapterClient(decimalFacts({ markPrice: MARK * 1.001 }));
      const result = await new GateIoFuturesExecutionAdapter(recorded.client).submit(order({
        action, side: 'sell', approvedNotionalUsd: 0.1 * MARK * MULTIPLIER,
      }));
      assert.equal(result.status, 'filled');
      assert.equal(recorded.requests[0]?.size, -0.1);
      assert.equal(recorded.requests[0]?.reduceOnly, true);
    }

    const insufficient = recordingAdapterClient(decimalFacts({ markPrice: MARK }));
    const rejected = await new GateIoFuturesExecutionAdapter(insufficient.client).submit(order({
      action: 'close', side: 'sell', approvedNotionalUsd: 0.09 * MARK * MULTIPLIER,
    }));
    assert.equal(rejected.status, 'rejected');
    assert.equal(insufficient.requests.length, 0);
  });
});

function wireResponse(value: unknown): GateIoReadResponse {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  }) as unknown as GateIoReadResponse;
}

function executionClient(
  responder: (body: Record<string, unknown>, call: number) => unknown,
): { readonly client: ReturnType<typeof createGateIoFuturesExecutionClient>; readonly calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: GateIoFuturesExecutionFetch = async (_url, init) => {
    calls.push(init.method ?? '');
    const body = typeof init.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : { contract: 'ETH_USDT', size: 0.1, text: CLIENT_TEXT };
    return wireResponse(responder(body, calls.length));
  };
  const readFoundation: Pick<GateIoAuthenticatedReadFoundation, 'instrumentFacts'> = Object.freeze({
    async instrumentFacts() {
      return Object.freeze({
        availability: 'AVAILABLE' as const, value: decimalFacts(), reason: null,
        failureProvenance: null,
      });
    },
  });
  return {
    calls,
    client: createGateIoFuturesExecutionClient({
      environment: 'testnet',
      credential: { apiKey: 'FIXTURE_G2R1_KEY', secretKey: 'FIXTURE_G2R1_SECRET' },
      signedTimestamp: () => '1800000000', fetchImpl, readFoundation,
      mutationBudget: GateIoG3MutationBudget.create(),
    }),
  };
}

function fractionalRequest(size: number): GateIoFuturesMarketOrderRequest {
  return Object.freeze({
    contract: 'ETH_USDT', size, price: '0', tif: 'ioc', reduceOnly: size < 0,
    text: CLIENT_TEXT,
  });
}

describe('Gate.io G2R1 F-09 full-fill interpretation', () => {
  it('uses attributed finish_as=filled as the primary witness when Gate reports size=0,left=0', async () => {
    for (const requestedSize of [0.1, -0.1]) {
      const binding = executionClient((body) => ({
        id: EXACT_INT64, text: body.text, contract: body.contract, size: 0, left: 0,
        status: 'finished', finish_as: 'filled', fill_price: '2001',
        finish_time: 1_800_000_000.123,
      }));
      const result = await binding.client.submitMarketOrder(fractionalRequest(requestedSize));
      assert.equal(result.status, 'FINISHED');
      assert.equal(result.signedFilledSize, requestedSize);
      assert.equal(result.exchangeOrderId, EXACT_INT64);
      assert.deepEqual(binding.calls, ['POST']);
    }
  });

  it('keeps incomplete attribution UNKNOWN and performs no POST retry', async () => {
    const binding = executionClient((body) => ({
      id: EXACT_INT64, text: `${String(body.text)}-wrong`, contract: body.contract,
      size: 0, left: 0, status: 'finished', finish_as: 'filled', fill_price: '2001',
      finish_time: 1_800_000_000.123,
    }));
    await assert.rejects(
      binding.client.submitMarketOrder(fractionalRequest(0.1)),
      /GATEIO_EXECUTION_SUBMISSION_UNKNOWN/,
    );
    assert.deepEqual(binding.calls, ['POST', 'GET']);
    assert.equal(binding.calls.filter(method => method === 'POST').length, 1);
    assert.equal(GATEIO_EXECUTION_POST_RETRY_COUNT, 0);
  });
});
