/** Gate.io G1 adapter tests: injected facts/client only, with zero network or credential surface. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { OmsCore } from '../../src/oms/OmsCore';
import type { OmsOrder } from '../../src/oms/oms-types';
import type { GateIoCanonicalInstrumentFacts } from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import {
  GATEIO_CLIENT_TEXT_MAX_LENGTH,
  GATEIO_CLIENT_TEXT_PREFIX,
  GateIoFuturesExecutionAdapter,
  gateIoExecutionSecondsToMilliseconds,
  toGateIoClientText,
  type GateIoFuturesExecutionClient,
  type GateIoFuturesMarketOrderRequest,
  type GateIoFuturesMarketOrderResult,
} from '../../src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter';

const OMS_ORDER_ID = 'a'.repeat(64);
const TRADE_ID = '9223372036854775806';
const EXCHANGE_ORDER_ID = '9223372036854775807';

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

function order(patch: Partial<OmsOrder> = {}): OmsOrder {
  return {
    orderId: OMS_ORDER_ID,
    intentId: 'gateio-g1-intent',
    exchange: 'gateio',
    symbol: 'ETH/USDT',
    action: 'open',
    side: 'buy',
    orderType: 'market',
    approvedNotionalUsd: 10.9,
    ...patch,
  };
}

function finished(
  request: GateIoFuturesMarketOrderRequest,
  patch: Partial<GateIoFuturesMarketOrderResult> = {},
): GateIoFuturesMarketOrderResult {
  return {
    status: 'FINISHED',
    clientText: request.text,
    contract: request.contract,
    signedFilledSize: request.size,
    averagePrice: 2_001,
    executedAt: 1_800_000_000.123,
    tradeId: TRADE_ID,
    exchangeOrderId: EXCHANGE_ORDER_ID,
    ...patch,
  };
}

function fakeClient(options: {
  readonly instrumentFacts?: GateIoCanonicalInstrumentFacts | null;
  readonly factsError?: Error;
  readonly submit?: (
    request: GateIoFuturesMarketOrderRequest,
  ) => GateIoFuturesMarketOrderResult | Promise<GateIoFuturesMarketOrderResult>;
} = {}): GateIoFuturesExecutionClient & {
  readonly factSymbols: string[];
  readonly requests: GateIoFuturesMarketOrderRequest[];
} {
  const factSymbols: string[] = [];
  const requests: GateIoFuturesMarketOrderRequest[] = [];
  return {
    factSymbols,
    requests,
    async getInstrumentFacts(symbol) {
      factSymbols.push(symbol);
      if (options.factsError) throw options.factsError;
      return options.instrumentFacts === undefined ? facts() : options.instrumentFacts;
    },
    async submitMarketOrder(request) {
      requests.push(request);
      return options.submit ? options.submit(request) : finished(request);
    },
  };
}

describe('Gate.io G1 deterministic identity and sizing', () => {
  it('derives one legal deterministic t- client text from the OMS order id', () => {
    const first = toGateIoClientText(OMS_ORDER_ID);
    const second = toGateIoClientText(OMS_ORDER_ID);
    assert.equal(first, second);
    assert.ok(first.startsWith(GATEIO_CLIENT_TEXT_PREFIX));
    assert.equal(first.length, GATEIO_CLIENT_TEXT_MAX_LENGTH);
    assert.equal(first, `t-dsb-${'a'.repeat(22)}`);
    for (const invalid of ['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      assert.throws(() => toGateIoClientText(invalid), /INVALID_OMS_ORDER_ID/);
    }
  });

  it('floors approved notional into factual Gate contract count', async () => {
    const client = fakeClient();
    const result = await new GateIoFuturesExecutionAdapter(client).submit(order());
    assert.equal(result.status, 'filled');
    assert.equal(client.factSymbols[0], 'ETH/USDT');
    assert.equal(client.requests[0]?.size, 5);
    if (result.status === 'filled') {
      assert.equal(result.fill.quantity, 0.005);
    }
  });

  it('rejects below-min, above-max, normalized-zero and invalid notional without submitting', async () => {
    const cases: readonly [OmsOrder, GateIoCanonicalInstrumentFacts, string][] = [
      [order({ approvedNotionalUsd: 3 }), facts({ minOrderSize: 2 }), 'BELOW_MIN_ORDER_SIZE'],
      [order({ approvedNotionalUsd: 12 }), facts({ maxOrderSize: 5 }), 'ABOVE_MAX_ORDER_SIZE'],
      [order({ approvedNotionalUsd: 1 }), facts({ minOrderSize: 0.1 }), 'NORMALIZED_SIZE_ZERO'],
      [order({ approvedNotionalUsd: Number.NaN }), facts(), 'INVALID_APPROVED_NOTIONAL'],
      [order({ approvedNotionalUsd: 0 }), facts(), 'INVALID_APPROVED_NOTIONAL'],
    ];
    for (const [input, instrumentFacts, reason] of cases) {
      const client = fakeClient({ instrumentFacts });
      assert.deepEqual(await new GateIoFuturesExecutionAdapter(client).submit(input), {
        status: 'rejected', reason,
      });
      assert.equal(client.requests.length, 0, reason);
    }
  });

  it('never enlarges an approved below-min order to the venue minimum', async () => {
    const client = fakeClient({ instrumentFacts: facts({ minOrderSize: 2 }) });
    const result = await new GateIoFuturesExecutionAdapter(client).submit(
      order({ approvedNotionalUsd: 3 }),
    );
    assert.deepEqual(result, { status: 'rejected', reason: 'BELOW_MIN_ORDER_SIZE' });
    assert.equal(client.requests.length, 0);
  });

  it('rejects missing, mismatched, closed, or malformed instrument facts', async () => {
    const malformed = [
      null,
      facts({ contract: 'BTC_USDT' as 'ETH_USDT' }),
      facts({ contractOpenable: false }),
      facts({ markPrice: 0 }),
      facts({ contractMultiplier: Number.NaN }),
      facts({ minOrderSize: 5, maxOrderSize: 1 }),
      { ...facts(), decimalSizeEnabled: 'false' } as unknown as GateIoCanonicalInstrumentFacts,
    ];
    for (const instrumentFacts of malformed) {
      const client = fakeClient({ instrumentFacts });
      assert.deepEqual(await new GateIoFuturesExecutionAdapter(client).submit(order()), {
        status: 'rejected', reason: 'MISSING_INSTRUMENT_FACTS',
      });
      assert.equal(client.requests.length, 0);
    }
    const unavailable = fakeClient({ factsError: new Error('offline') });
    assert.deepEqual(await new GateIoFuturesExecutionAdapter(unavailable).submit(order()), {
      status: 'rejected', reason: 'MISSING_INSTRUMENT_FACTS',
    });
  });

  it('keeps the G1 production scope closed to canonical ETH/USDT only', async () => {
    const client = fakeClient();
    assert.deepEqual(await new GateIoFuturesExecutionAdapter(client).submit(
      order({ symbol: 'BTC/USDT' }),
    ), { status: 'rejected', reason: 'MISSING_INSTRUMENT_FACTS' });
    assert.equal(client.factSymbols.length, 0);
    assert.equal(client.requests.length, 0);
  });
});

describe('Gate.io G1 request mapping', () => {
  it('maps buy positive, sell negative, market IOC, price zero, and deterministic text', async () => {
    for (const side of ['buy', 'sell'] as const) {
      const client = fakeClient();
      await new GateIoFuturesExecutionAdapter(client).submit(order({ side }));
      assert.deepEqual(client.requests[0], {
        contract: 'ETH_USDT',
        size: side === 'buy' ? 5 : -5,
        price: '0',
        tif: 'ioc',
        reduceOnly: false,
        text: toGateIoClientText(OMS_ORDER_ID),
      });
    }
  });

  it('maps reduce-only from action without flipping the OMS side', async () => {
    for (const action of ['open', 'reduce', 'close', 'emergency_exit'] as const) {
      const client = fakeClient();
      await new GateIoFuturesExecutionAdapter(client).submit(order({ action, side: 'sell' }));
      assert.equal(client.requests[0]?.size, -5);
      assert.equal(client.requests[0]?.reduceOnly, action !== 'open');
    }
  });
});

describe('Gate.io G1 result mapping', () => {
  it('maps a fully attributed fill with explicit seconds-to-milliseconds conversion', async () => {
    assert.equal(gateIoExecutionSecondsToMilliseconds(1_800_000_000.123), 1_800_000_000_123);
    const client = fakeClient();
    const result = await new GateIoFuturesExecutionAdapter(client).submit(order());
    assert.equal(result.status, 'filled');
    if (result.status === 'filled') {
      assert.deepEqual(result.fill, {
        fillId: TRADE_ID,
        orderId: OMS_ORDER_ID,
        intentId: 'gateio-g1-intent',
        exchange: 'gateio',
        symbol: 'ETH/USDT',
        side: 'buy',
        quantity: 0.005,
        price: 2_001,
        executedAt: 1_800_000_000_123,
      });
    }
  });

  it('maps transport ambiguity once, partial fill, explicit rejection and accepted/open', async () => {
    const transport = fakeClient({ submit: async () => { throw new Error('timeout'); } });
    assert.deepEqual(await new GateIoFuturesExecutionAdapter(transport).submit(order()), {
      status: 'unknown', reason: 'TRANSPORT_AMBIGUITY',
    });
    assert.equal(transport.requests.length, 1);

    const partial = fakeClient({ submit: request => finished(request, {
      status: 'PARTIALLY_FILLED', signedFilledSize: 2,
    }) });
    const partialResult = await new GateIoFuturesExecutionAdapter(partial).submit(order());
    assert.equal(partialResult.status, 'execution');
    if (partialResult.status === 'execution') {
      assert.equal(partialResult.observation.status, 'PARTIALLY_FILLED');
      assert.equal(partialResult.observation.requestedQuantity, 0.005);
      assert.equal(partialResult.observation.cumulativeFilledQuantity, 0.002);
      assert.equal(partialResult.observation.remainingQuantity, 0.003);
    }

    const rejected = fakeClient({ submit: request => finished(request, {
      status: 'REJECTED', signedFilledSize: 0, averagePrice: null,
      executedAt: null, tradeId: null, rejectionReason: 'INSUFFICIENT_BALANCE',
    }) });
    assert.deepEqual(await new GateIoFuturesExecutionAdapter(rejected).submit(order()), {
      status: 'rejected', reason: 'INSUFFICIENT_BALANCE',
    });

    for (const status of ['ACCEPTED', 'OPEN'] as const) {
      const accepted = fakeClient({ submit: request => finished(request, {
        status, signedFilledSize: 0, averagePrice: null, executedAt: null, tradeId: null,
      }) });
      assert.deepEqual(await new GateIoFuturesExecutionAdapter(accepted).submit(order()), {
        status: 'accepted',
      });
    }
  });

  it('treats every attribution mismatch and malformed fill as UNKNOWN', async () => {
    const mutations: Array<(request: GateIoFuturesMarketOrderRequest) => Partial<GateIoFuturesMarketOrderResult>> = [
      () => ({ clientText: 't-wrong' }),
      () => ({ contract: 'BTC_USDT' }),
      () => ({ signedFilledSize: -5 }),
      () => ({ signedFilledSize: 6 }),
      () => ({ averagePrice: 0 }),
      () => ({ executedAt: Number.NaN }),
      () => ({ executedAt: 1_800_000_000.1234 }),
      () => ({ tradeId: '' }),
      () => ({ tradeId: 'not-an-int64' }),
      () => ({ exchangeOrderId: Number.MAX_SAFE_INTEGER + 1 as unknown as string }),
    ];
    for (const mutate of mutations) {
      const client = fakeClient({ submit: request => finished(request, mutate(request)) });
      assert.deepEqual(await new GateIoFuturesExecutionAdapter(client).submit(order()), {
        status: 'unknown', reason: 'MALFORMED_EXCHANGE_RESULT',
      });
    }
  });

  it('preserves exact string int64 facts and never accepts a numeric order id', async () => {
    const exact = fakeClient({ submit: request => finished(request, {
      tradeId: TRADE_ID, exchangeOrderId: EXCHANGE_ORDER_ID,
    }) });
    const exactResult = await new GateIoFuturesExecutionAdapter(exact).submit(order());
    assert.equal(exactResult.status, 'filled');
    if (exactResult.status === 'filled') assert.equal(exactResult.fill.fillId, TRADE_ID);

    const numeric = fakeClient({ submit: request => finished(request, {
      exchangeOrderId: 42 as unknown as string,
    }) });
    assert.deepEqual(await new GateIoFuturesExecutionAdapter(numeric).submit(order()), {
      status: 'unknown', reason: 'MALFORMED_EXCHANGE_RESULT',
    });
  });

  it('partial cumulative observations preserve int64 strings and reject malformed identity', async () => {
    for (const id of [42, Number.MAX_SAFE_INTEGER + 1, 'not-an-int64', '']) {
      const partial = fakeClient({ submit: request => finished(request, {
        status: 'PARTIALLY_FILLED', signedFilledSize: 2, exchangeOrderId: id as any,
      }) });
      assert.equal((await new GateIoFuturesExecutionAdapter(partial).submit(order())).status, 'unknown');
    }
  });
});

describe('Gate.io G1 real OMS integration and architecture boundary', () => {
  it('flows through real OmsCore events with exact Gate fill identity', async () => {
    const client = fakeClient();
    const kernel = createTradingKernel({ exchange: 'gateio' });
    const oms = new OmsCore(kernel, new GateIoFuturesExecutionAdapter(client));
    const result = await oms.submitRequest({
      intentId: 'gateio-real-oms-intent',
      exchange: 'gateio',
      symbol: 'ETH/USDT',
      direction: 'long',
      orderType: 'market',
      positionUsd: 10.9,
      source: 'test',
      createdAt: 1,
      reason: 'test',
      biasUpdatedAt: 1,
    }, 'open', 10.9);
    assert.equal(result.status, 'filled');
    assert.equal(result.fill?.exchange, 'gateio');
    assert.equal(result.fill?.symbol, 'ETH/USDT');
    assert.equal(result.fill?.side, 'buy');
    assert.equal(result.fill?.intentId, 'gateio-real-oms-intent');
    assert.equal(result.fill?.orderId, result.order?.orderId);
    assert.equal(result.fill?.fillId, TRADE_ID);
    assert.deepEqual(
      kernel.journal().readFromLogicalSequence(1).map(entry => entry.type),
      ['order.created', 'order.submitted', 'order.execution.prepared', 'execution.fill.confirmed'],
    );
  });

  it('does not retry an ambiguous submission through OmsCore duplicate handling', async () => {
    const client = fakeClient({ submit: async () => { throw new Error('timeout'); } });
    const oms = new OmsCore(
      createTradingKernel({ exchange: 'gateio' }),
      new GateIoFuturesExecutionAdapter(client),
    );
    const intent = {
      intentId: 'gateio-unknown-intent', exchange: 'gateio' as const, symbol: 'ETH/USDT',
      direction: 'long' as const, orderType: 'market' as const, positionUsd: 10.9,
      source: 'test', createdAt: 1, reason: 'test', biasUpdatedAt: 1,
    };
    assert.equal((await oms.submitRequest(intent, 'open', 10.9)).status, 'submission_unknown');
    assert.equal((await oms.submitRequest(intent, 'open', 10.9)).status, 'duplicate');
    assert.equal(client.requests.length, 1);
  });

  it('contains no network, credential, env, SDK, retry, kernel, position or clock authority', () => {
    const source = readFileSync(
      'src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter.ts', 'utf8',
    );
    for (const forbidden of [
      'process.env', 'fetch(', 'api.gateio.ws', '.gateio.env', 'setTimeout(', 'setInterval(',
      'TradingKernel', 'KernelPositionStateStore', 'PositionManager', 'Reconciliation',
      'createGateIoReadTransport', 'createProductionGateIoReadTransport',
    ]) assert.equal(source.includes(forbidden), false, forbidden);
    assert.equal(Object.keys(fakeClient()).sort().join(','),
      'factSymbols,getInstrumentFacts,requests,submitMarketOrder');
  });
});
