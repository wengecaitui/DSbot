/** G3C evidence is entirely offline: every Gate response is an injected bounded fixture. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OmsOrderSnapshot } from '../../src/oms/oms-types';
import { toGateIoClientText } from '../../src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import { createGateIoExecutionTruthPort } from '../../src/reconciliation/GateIoExecutionTruthPort';
import { createGateIoAuthenticatedReadFoundation, normalizeGateIoTrade } from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import { GATEIO_READ_ENDPOINTS } from '../../src/runtime/gateio/GateIoReadContracts';
import { createGateIoTestnetReadTransport, GateIoReadTransportError } from '../../src/runtime/gateio/GateIoReadTransport';
import { GateIoG3RunBudget } from '../../src/runtime/gateio/GateIoG3RunBudget';

const NOW = 1_800_000_000_000;
const CREDENTIAL = Object.freeze({ apiKey: 'FIXTURE_KEY', secretKey: 'FIXTURE_SECRET' });
const MAX_SAFE = '9007199254740991';
const FIRST_TRADE = '9007199254740993';
const FIRST_ORDER = '9100000000000001';

function rawTrade(id: string, orderId: string, asString = false): string {
  const entry = {
    id: '__ID__', order_id: '__ORDER_ID__', contract: 'ETH_USDT',
    size: '0.1', close_size: '0', price: '2000', text: 't-dsb-fixture',
    fee: '0', point_fee: '0', role: 'taker', trade_value: '0.2',
    create_time: '1800000000.123',
  };
  return JSON.stringify(entry).replace('"__ID__"', asString ? JSON.stringify(id) : id)
    .replace('"__ORDER_ID__"', asString ? JSON.stringify(orderId) : orderId);
}

function tradeTransport(raw: string) {
  let requests = 0;
  const budget = GateIoG3RunBudget.create();
  const transport = createGateIoTestnetReadTransport(async (url, init) => {
    requests += 1;
    assert.equal(new URL(url).origin, 'https://api-testnet.gateapi.io');
    assert.equal(init.method, 'GET');
    return new Response(raw);
  }, budget);
  return {
    read: () => transport.get({
      endpoint: GATEIO_READ_ENDPOINTS.MY_TRADES,
      query: [{ name: 'contract', value: 'ETH_USDT' }],
      credential: CREDENTIAL,
      timestamp: '1800000000',
    }),
    get requests() { return requests; },
  };
}

async function exactTrades(raw: string): Promise<Record<string, unknown>[]> {
  const parsed = await tradeTransport(raw).read();
  assert.ok(Array.isArray(parsed));
  return parsed as Record<string, unknown>[];
}

async function invalidTrades(raw: string): Promise<void> {
  const fixture = tradeTransport(raw);
  await assert.rejects(fixture.read(), (error: unknown) =>
    error instanceof GateIoReadTransportError && error.code === 'GATEIO_READ_RESPONSE_INVALID');
  assert.equal(fixture.requests, 1);
}

describe('Gate G3C bounded raw int64 trade identity recovery', () => {
  it('reproduces the original JSON number precision loss without using it as authority', async () => {
    const raw = '[' + rawTrade(FIRST_TRADE, FIRST_ORDER) + ']';
    const lossy = JSON.parse(raw) as Record<string, unknown>[];
    assert.notEqual(String(lossy[0]!.id), FIRST_TRADE);
    assert.throws(() => normalizeGateIoTrade(lossy[0]));
    const recovered = await exactTrades(raw);
    assert.equal(normalizeGateIoTrade(recovered[0]).tradeId, FIRST_TRADE);
    assert.equal(normalizeGateIoTrade(recovered[0]).orderId, FIRST_ORDER);
  });

  it('preserves safe, first unsafe, int64 maximum and exact string identifiers', async () => {
    for (const id of [MAX_SAFE, '9007199254740992', FIRST_TRADE, '9223372036854775807']) {
      const trade = (await exactTrades('[' + rawTrade(id, id) + ']'))[0]!;
      assert.equal(trade.id, id);
      assert.equal(trade.order_id, id);
    }
    const stringTrade = (await exactTrades('[' + rawTrade(FIRST_TRADE, FIRST_ORDER, true) + ']'))[0]!;
    assert.equal(stringTrade.id, FIRST_TRADE);
    assert.equal(stringTrade.order_id, FIRST_ORDER);
  });

  it('attributes multiple array elements through field order, whitespace and unrelated fields', async () => {
    const raw = ' [ {\n "price":"2000", "order_id" : 9100000000000001,'
      + ' "size":"0.1", "id" : 9007199254740993, "memo":"id: 7" },'
      + ' {"id":9007199254740995, "other":{"id":123},'
      + ' "order_id":9100000000000003 } ] ';
    const trades = await exactTrades(raw);
    assert.deepEqual(trades.map((trade) => [trade.id, trade.order_id]), [
      ['9007199254740993', '9100000000000001'],
      ['9007199254740995', '9100000000000003'],
    ]);
    assert.equal((trades[1]!.other as Record<string, unknown>).id, 123);
    assert.deepEqual(await exactTrades(' [ \n ] '), []);
  });

  it('fails closed for duplicate, missing, scientific, negative, out-of-range and noncanonical IDs', async () => {
    for (const raw of [
      '[{"id":9007199254740993,"id":9007199254740995,"order_id":9100000000000001}]',
      '[{"id":9007199254740993,"order_id":9100000000000001,"order_id":9100000000000003}]',
      '[{"id":9007199254740993}]',
      '[{"id":1.234e16,"order_id":1}]',
      '[{"id":-1,"order_id":1}]',
      '[{"id":9223372036854775808,"order_id":1}]',
      '[{"id":01,"order_id":1}]',
    ]) await invalidTrades(raw);
    for (const id of ['0', '01', '9223372036854775808']) {
      const parsed = JSON.parse('[' + rawTrade(id, FIRST_ORDER, true) + ']') as unknown[];
      assert.throws(() => normalizeGateIoTrade(parsed[0]), /TRADES_MALFORMED/);
    }
  });
});

describe('Gate G3C factual truth path with unsafe trade IDs', () => {
  it('recovers exact complete truth for a correlated historical fill, but does not bless an uncorrelated one', async () => {
    const localOrderId = 'a'.repeat(64);
    const clientText = toGateIoClientText(localOrderId);
    const trade = rawTrade(FIRST_TRADE, FIRST_ORDER)
      .replace('t-dsb-fixture', clientText)
      .replace('"create_time":"1800000000.123"', '"create_time":"1799999999.123"');
    const budget = GateIoG3RunBudget.create();
    const requests: string[] = [];
    const transport = createGateIoTestnetReadTransport(async (url, init) => {
      const path = new URL(url).pathname;
      requests.push(path);
      assert.equal(init.method, 'GET');
      assert.equal(new URL(url).origin, 'https://api-testnet.gateapi.io');
      if (path === GATEIO_READ_ENDPOINTS.MY_TRADES) return new Response('[' + trade + ']');
      const data: Record<string, unknown> = {
        [GATEIO_READ_ENDPOINTS.SERVER_TIME]: { server_time: NOW },
        [GATEIO_READ_ENDPOINTS.ACCOUNTS]: {
          currency: 'USDT', total: '1000', available: '900',
          in_dual_mode: false, position_mode: 'single', margin_mode: 0,
        },
        [GATEIO_READ_ENDPOINTS.POSITIONS]: [{
          contract: 'ETH_USDT', mode: 'single', size: '0', value: '0',
          pos_margin_mode: 'cross', leverage: '10',
          entry_price: null, mark_price: null, update_time: '1800000000',
        }],
        [GATEIO_READ_ENDPOINTS.OPEN_ORDERS]: [],
        [GATEIO_READ_ENDPOINTS.CONTRACT]: {
          name: 'ETH_USDT', status: 'trading', in_delisting: false,
          quanto_multiplier: '0.001', order_size_min: '0.1',
          order_size_max: '10000', enable_decimal: true,
          order_price_round: '0.01', mark_price_round: '0.01',
          leverage_min: '1', leverage_max: '100',
          maker_fee_rate: '0', taker_fee_rate: '0',
        },
        [GATEIO_READ_ENDPOINTS.TICKERS]: [{
          contract: 'ETH_USDT', last: '2000', mark_price: '2000',
          index_price: '2000', funding_rate: '0',
        }],
      };
      assert.ok(Object.hasOwn(data, path), path);
      return new Response(JSON.stringify(data[path]));
    }, budget);
    const foundation = createGateIoAuthenticatedReadFoundation({
      transport, runBudget: budget, credential: CREDENTIAL, now: () => NOW,
      identity: { exchange: 'gateio', accountId: 'fixture-account', settle: 'USDT' },
    });
    const localOrder = {
      orderId: localOrderId, exchange: 'gateio', symbol: 'ETH/USDT',
      side: 'buy', status: 'FILLED', fillId: FIRST_ORDER,
    } as OmsOrderSnapshot;
    const truthPort = createGateIoExecutionTruthPort({
      environment: 'testnet', transport, runBudget: budget, foundation,
      accountId: 'fixture-account', now: () => NOW,
      listOmsOrders: () => [localOrder],
    });
    const truth = await truthPort.acquireTruth();
    const account = truthPort.canonicalForCapture(truthPort.captureSequence())?.account;
    assert.equal(truth.complete, true, truth.incompleteReason);
    assert.equal(account?.accountState, 'FLAT');
    assert.equal(account?.recentTrades[0]?.tradeId, FIRST_TRADE);
    assert.equal(account?.recentTrades[0]?.orderId, FIRST_ORDER);
    assert.equal(account?.recentTrades[0]?.signedSize, 0.1);
    assert.equal(account?.recentTrades[0]?.createdAt, 1_799_999_999.123);
    assert.equal(truth.positions.length, 0);
    assert.equal(truth.fills[0]?.fillId, FIRST_ORDER);
    assert.deepEqual(requests, [
      GATEIO_READ_ENDPOINTS.SERVER_TIME, GATEIO_READ_ENDPOINTS.ACCOUNTS,
      GATEIO_READ_ENDPOINTS.POSITIONS, GATEIO_READ_ENDPOINTS.OPEN_ORDERS,
      GATEIO_READ_ENDPOINTS.MY_TRADES, GATEIO_READ_ENDPOINTS.SERVER_TIME,
      GATEIO_READ_ENDPOINTS.CONTRACT, GATEIO_READ_ENDPOINTS.TICKERS,
    ]);
    const emptyOmsTruthPort = createGateIoExecutionTruthPort({
      environment: 'testnet', transport, runBudget: budget, foundation,
      accountId: 'fixture-account', now: () => NOW,
      listOmsOrders: () => [],
    });
    const initialTruth = await emptyOmsTruthPort.acquireTruth();
    assert.equal(initialTruth.complete, true);
    assert.equal(initialTruth.fills.length, 0);
    assert.equal(emptyOmsTruthPort.canonicalForCapture(
      emptyOmsTruthPort.captureSequence(),
    )?.account.recentTrades[0]?.tradeId, FIRST_TRADE);
  });
});
