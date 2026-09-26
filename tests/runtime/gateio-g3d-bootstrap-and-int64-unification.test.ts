/** Formal G3D evidence uses only an injected recording TestNet fetch and fixture credentials. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInMemoryEventJournal } from '../../src/kernel/InMemoryEventJournal';
import { gateIoExecutionSecondsToMilliseconds } from '../../src/exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import { parseGateIoExactInt64Json } from '../../src/runtime/gateio/GateIoExactInt64Recovery';
import { GATEIO_READ_ENDPOINTS } from '../../src/runtime/gateio/GateIoReadContracts';
import { createGateIoTestnetOmsE2ELaunchBinding } from '../../src/runtime/gateio/GateIoTestnetOmsE2ELaunchBinding';

const NOW = 1_800_000_000_000;
const SECOND = 1_800_000_000;
const HEAD = 'a'.repeat(40);
const ORDER_ONE = '9007199254740993';
const ORDER_TWO = '9007199254740995';
const HISTORICAL_ONE = '9007199254740997';
const HISTORICAL_TWO = '9007199254740999';

interface Scenario {
  readonly history?: 'none' | 'one' | 'multiple' | 'eight' | 'malformed';
  readonly missingTradeValue?: boolean;
  readonly initialPosition?: number;
  readonly initialOpenOrder?: boolean;
  readonly pageChurn?: boolean;
  readonly historicalChangedAfterOpen?: boolean;
  readonly historicalTimeChangedAfterOpen?: boolean;
  readonly contemporaneousInitialTrade?: boolean;
  readonly externalAfterOpen?: boolean;
  readonly externalFlattens?: boolean;
  readonly wrongCurrentOrderId?: boolean;
  readonly subMillisecondTimes?: boolean;
  readonly historyLag?: 'both' | 'open' | 'close';
  readonly orderLookupFailure?: 'NOT_FOUND' | 'QUANTITY_MISMATCH';
  readonly positionMismatchAfterOpen?: boolean;
  readonly closeRejectedForCleanup?: boolean;
}

function numericToken(value: Record<string, unknown>, field: string, token: string): string {
  return JSON.stringify(value).replace('"' + field + '":"__EXACT__"', '"' + field + '":' + token);
}

function tradeRaw(id: string, orderId: string, text: string, size: number,
  createdAt: number | string, missingTradeValue = false): string {
  const entry = {
    id: '__EXACT__', order_id: '__ORDER__', contract: 'ETH_USDT',
    size: String(size), close_size: '0', price: '2000', text,
    fee: '0', point_fee: '0', role: 'taker',
    ...(missingTradeValue ? {} : { trade_value: String(Math.abs(size) * 2) }),
    create_time: String(createdAt),
  };
  return numericToken(entry, 'id', id).replace('"order_id":"__ORDER__"',
    '"order_id":' + orderId).replace('"create_time":"' + String(createdAt) + '"',
      '"create_time":' + String(createdAt));
}

function fixture(scenario: Scenario = {}) {
  const observedNow = scenario.subMillisecondTimes ? NOW + 1000 : NOW;
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  const orders = new Map<string, string>();
  const currentTrades: string[] = [];
  const historical = scenario.history === 'eight'
    ? Array.from({ length: 8 }, (_, index) =>
      tradeRaw((9007199254740997n + BigInt(index) * 2n).toString(),
        (9100000000000001n + BigInt(index) * 2n).toString(),
        'older-page', index % 2 === 0 ? 0.1 : -0.1,
        scenario.subMillisecondTimes
          ? ['1800000000.4845', '1800000000.1234',
            '1800000000.123456', '1800000000.4849'][index % 4]!
          : SECOND - 20 - index,
        scenario.missingTradeValue))
    : [
      tradeRaw(HISTORICAL_ONE, '9100000000000001', 'external-before-run', 0.1,
        scenario.contemporaneousInitialTrade ? SECOND
          : scenario.subMillisecondTimes ? '1800000000.4845' : SECOND - 20,
        scenario.missingTradeValue),
      ...(scenario.history === 'multiple'
        ? [tradeRaw(HISTORICAL_TWO, '9100000000000003', 'older-page', -0.1,
          scenario.subMillisecondTimes ? '1800000000.1234' : SECOND - 30,
          scenario.missingTradeValue)] : []),
    ];
  let position = scenario.initialPosition ?? 0;
  let postCount = 0;
  let accountReads = 0;
  const response = (value: unknown) => new Response(JSON.stringify(value));
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).origin, 'https://api-testnet.gateapi.io');
    const path = new URL(url).pathname;
    const body = init.method === 'POST'
      ? JSON.parse(init.body as string) as Record<string, unknown> : null;
    calls.push({ path, method: init.method ?? 'GET', body });
    if (path === GATEIO_READ_ENDPOINTS.SERVER_TIME)
      return response({ server_time: observedNow });
    if (path === GATEIO_READ_ENDPOINTS.ACCOUNTS) {
      accountReads += 1;
      return response({
        currency: 'USDT', total: '1000', available: '900',
        in_dual_mode: false, position_mode: 'single', margin_mode: 0,
      });
    }
    if (path === GATEIO_READ_ENDPOINTS.POSITIONS) return response([{
      contract: 'ETH_USDT', mode: 'single', size: String(position),
      value: String(position * 2), pos_margin_mode: 'cross', leverage: '10',
      entry_price: position === 0 ? null : '2000',
      mark_price: position === 0 ? null : '2000', update_time: String(SECOND),
    }]);
    if (path === GATEIO_READ_ENDPOINTS.OPEN_ORDERS && init.method === 'GET')
      return response(scenario.initialOpenOrder && postCount === 0 ? [{
        id: '121', text: 'external-open', contract: 'ETH_USDT', size: '0.1',
        left: '0.1', price: '2000', fill_price: null, tif: 'gtc', status: 'open',
        is_reduce_only: false, is_close: false,
        create_time: String(SECOND - 10), update_time: String(SECOND - 10),
      }] : []);
    if (path === GATEIO_READ_ENDPOINTS.MY_TRADES) {
      const previous = scenario.history === 'none' ? []
        : scenario.pageChurn && postCount > 0
          ? [historical[1] ?? tradeRaw(HISTORICAL_TWO, '9100000000000003',
            'older-page', -0.1, SECOND - 30)]
          : scenario.historicalTimeChangedAfterOpen && postCount > 0
            ? [tradeRaw(HISTORICAL_ONE, '9100000000000001', 'external-before-run',
              0.1, '1800000000.4849', scenario.missingTradeValue)]
          : scenario.historicalChangedAfterOpen && postCount > 0
            ? [tradeRaw(HISTORICAL_ONE, '9100000000000001', 'external-before-run',
              0.2, SECOND - 20)]
            : historical;
      const malformed = scenario.history === 'malformed' && postCount === 0
        ? [tradeRaw('1.234e16', '9100000000000001', 'bad', 0.1, SECOND - 20)] : previous;
      const external = scenario.externalAfterOpen && postCount > 0
        ? [tradeRaw('9100000000000099', '9100000000000097',
          'external-after-run', -0.1,
          scenario.subMillisecondTimes ? '1800000001.0009' : SECOND,
          scenario.missingTradeValue)] : [];
      const visibleCurrent = scenario.historyLag === 'both' ? []
        : scenario.historyLag === 'close' ? currentTrades.slice(0, 1)
        : scenario.historyLag === 'open' && accountReads < 3
          ? currentTrades.slice(1) : currentTrades;
      return new Response('[' + [...malformed, ...visibleCurrent, ...external].join(',') + ']');
    }
    if (path === GATEIO_READ_ENDPOINTS.CONTRACT) return response({
      name: 'ETH_USDT', status: 'trading', in_delisting: false,
      quanto_multiplier: '0.001', order_size_min: '0.1',
      order_size_max: '10000', enable_decimal: true,
      order_price_round: '0.01', mark_price_round: '0.01',
      leverage_min: '1', leverage_max: '100',
      maker_fee_rate: '0', taker_fee_rate: '0',
    });
    if (path === GATEIO_READ_ENDPOINTS.TICKERS) return response([{
      contract: 'ETH_USDT', last: '2000', mark_price: '2000',
      index_price: '2000', funding_rate: '0', highest_bid: '1999',
      lowest_ask: '2001', volume_24h: '1', high_24h: '2100', low_24h: '1900',
    }]);
    if (init.method === 'GET' && path.startsWith('/api/v4/futures/usdt/orders/')) {
      const text = path.split('/').at(-1)!;
      assert.ok(orders.has(text));
      if (scenario.orderLookupFailure === 'NOT_FOUND' && postCount === 1)
        return response({ label: 'ORDER_NOT_FOUND' }, 404);
      if (scenario.orderLookupFailure === 'QUANTITY_MISMATCH' && postCount === 1)
        return new Response(orders.get(text)!.replace('"size":0.1', '"size":0.2'));
      return new Response(orders.get(text));
    }
    assert.equal(path, '/api/v4/futures/usdt/orders');
    assert.equal(init.method, 'POST');
    assert.ok(body);
    postCount += 1;
    if (scenario.closeRejectedForCleanup && postCount === 2)
      return response({ label: 'ORDER_REJECTED' }, 400);
    const orderId = postCount === 1 ? ORDER_ONE : ORDER_TWO;
    const rawOrder = numericToken({
      id: '__EXACT__', text: body.text, contract: 'ETH_USDT', size: body.size,
      left: 0, status: 'finished', finish_as: 'filled',
      fill_price: '2000', finish_time: SECOND,
    }, 'id', orderId);
    orders.set(body.text as string, rawOrder);
    position = Math.round((position + Number(body.size)) * 10) / 10;
    if (scenario.positionMismatchAfterOpen && postCount === 1) position = 0.2;
    if (scenario.externalFlattens && postCount === 1) position = 0;
    const tradeOrderId = scenario.wrongCurrentOrderId && postCount === 1
      ? '9007199254740992' : orderId;
    currentTrades.push(tradeRaw(postCount === 1 ? '9100000000000011' : '9100000000000013',
      tradeOrderId, body.text as string, Number(body.size),
      scenario.subMillisecondTimes
        ? postCount === 1 ? '1800000001.4845' : '1800000001.123456'
        : SECOND,
      scenario.missingTradeValue));
    return new Response(rawOrder);
  };
  const journal = createInMemoryEventJournal();
  const binding = createGateIoTestnetOmsE2ELaunchBinding({
    credential: { apiKey: 'FIXTURE_G3D_KEY', secretKey: 'FIXTURE_G3D_SECRET' },
    accountId: 'fixture-account', fetchImpl, now: () => observedNow,
    journal,
    expectedExactHead: HEAD, actualExactHead: () => HEAD, worktreeClean: () => true,
  });
  return { binding, calls, journal, get postCount() { return postCount; },
    get position() { return position; } };
}

describe('Gate G3D one exact-int64 recovery core', () => {
  for (const shape of ['object', 'array'] as const) {
    it('preserves safe, unsafe, exact string and max int64 identifiers for ' + shape, () => {
      for (const token of ['9007199254740991', '9007199254740992',
        '9007199254740993', '9223372036854775807']) {
        const object = '{"id":' + token + ',"price":0.1}';
        const raw = shape === 'object' ? object : '[' + object + ',' + object + ']';
        const parsed = parseGateIoExactInt64Json(raw, { shape, fields: ['id'] });
        const rows = shape === 'object' ? [parsed] : parsed as unknown[];
        assert.equal(rows.every((row) => (row as Record<string, unknown>).id === token
          && (row as Record<string, unknown>).price === 0.1), true);
      }
      const rawString = shape === 'object'
        ? '{"id":"9007199254740993"}' : '[{"id":"9007199254740993"}]';
      const parsedString = parseGateIoExactInt64Json(rawString, { shape, fields: ['id'] });
      const stringRow = (shape === 'object'
        ? parsedString : (parsedString as unknown[])[0]) as Record<string, unknown>;
      assert.equal(stringRow.id, '9007199254740993');
      const reordered = shape === 'object'
        ? ' { "other":{"id":7}, "price":0.1, "id" : 9007199254740993 } '
        : ' [ {"id":9007199254740993,"price":0.1},'
          + ' {"price":0.2,"id":9007199254740995} ] ';
      const reorderedParsed = parseGateIoExactInt64Json(reordered, { shape, fields: ['id'] });
      if (shape === 'object') {
        const row = reorderedParsed as Record<string, unknown>;
        assert.equal(row.id, ORDER_ONE);
        assert.equal((row.other as Record<string, unknown>).id, 7);
      } else {
        assert.deepEqual((reorderedParsed as Record<string, unknown>[]).map((row) => row.id),
          [ORDER_ONE, ORDER_TWO]);
      }
      for (const bad of ['1.234e16', '9223372036854775808', '-1']) {
        const object = '{"id":' + bad + '}';
        assert.throws(() => parseGateIoExactInt64Json(
          shape === 'object' ? object : '[' + object + ']', { shape, fields: ['id'] }));
      }
      const duplicate = '{"id":9007199254740993,"id":9007199254740995}';
      assert.throws(() => parseGateIoExactInt64Json(
        shape === 'object' ? duplicate : '[' + duplicate + ']', { shape, fields: ['id'] }));
    });
  }
  it('keeps an API rejection object without id but rejects oversized raw text', () => {
    assert.deepEqual(parseGateIoExactInt64Json('{"label":"INVALID_ORDER"}',
      { shape: 'object', fields: ['id'], required: false }), { label: 'INVALID_ORDER' });
    assert.throws(() => parseGateIoExactInt64Json(
      '{"id":1,"padding":"' + 'x'.repeat(1_048_576) + '"}',
      { shape: 'object', fields: ['id'] }));
  });
});

describe('Gate G3D formal offline bootstrap and runtime trade scope', () => {
  for (const history of ['none', 'one', 'multiple'] as const) {
    it('passes full factual OPEN/CLOSE with ' + history + ' preexisting trades', async () => {
      const fake = fixture({ history });
      const result = await fake.binding.run();
      assert.equal(result.receipt.status, 'PASS', JSON.stringify(result.receipt));
      assert.equal(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
      assert.equal(fake.postCount, 2);
      assert.equal(fake.position, 0);
      assert.equal(result.receipt.budget.networkUsed, fake.calls.length);
      assert.equal(result.receipt.budget.proofUsed, 2);
      assert.equal(result.receipt.budget.cleanupUsed, 0);
      assert.equal(result.receipt.budget.networkUsed <= 36, true);
    });
  }

  it('accepts older history entering the recent-trades page after baseline', async () => {
    const fake = fixture({ history: 'one', pageChurn: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'PASS', JSON.stringify(result.receipt));
    assert.equal(fake.postCount, 2);
  });

  for (const scenario of [
    { history: 'malformed' as const },
    { history: 'one' as const, initialPosition: 0.1 },
    { history: 'one' as const, initialOpenOrder: true },
    { history: 'one' as const, contemporaneousInitialTrade: true },
  ]) {
    it('denies unsafe initial truth before any proof mutation', async () => {
      const fake = fixture(scenario);
      const result = await fake.binding.run();
      assert.equal(result.receipt.status, 'STOP');
      assert.equal(fake.postCount, 0);
      assert.equal(result.receipt.budget.proofUsed, 0);
    });
  }

  it('rejects a historical trade id whose factual content changes after baseline', async () => {
    const fake = fixture({ history: 'one', historicalChangedAfterOpen: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
    assert.notEqual(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(fake.postCount >= 1, true);
  });

  for (const externalFlattens of [false, true]) {
    it('never passes after a new external trade, even if net flat', async () => {
      const fake = fixture({ history: 'one', externalAfterOpen: true, externalFlattens });
      const result = await fake.binding.run();
      assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
      assert.notEqual(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
      assert.equal(result.receipt.liveReady, false);
      assert.equal(result.receipt.budget.proofUsed <= 2, true);
    });
  }

  it('rejects exact order-id mismatch hidden by rounded JavaScript numbers', async () => {
    assert.equal(Number(ORDER_ONE), Number('9007199254740992'));
    const fake = fixture({ history: 'one', wrongCurrentOrderId: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
    assert.notEqual(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(fake.postCount >= 1, true);
  });
});

describe('Gate G3F formal offline path with absent trade_value', () => {
  it('accepts eight historical trades and correlates current OPEN/CLOSE without invented value', async () => {
    const fake = fixture({ history: 'eight', missingTradeValue: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'PASS', JSON.stringify(result.receipt));
    assert.equal(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(fake.postCount, 2);
    assert.equal(fake.position, 0);
    assert.equal(result.receipt.budget.proofUsed, 2);
    assert.equal(result.receipt.budget.cleanupUsed, 0);
    assert.equal(result.receipt.budget.networkUsed, fake.calls.length);
    const events = fake.journal.readFromLogicalSequence(1);
    assert.equal(events.filter((event) => event.type === 'position.baseline.confirmed').length, 1);
    assert.equal(events.filter((event) => event.type === 'execution.fill.confirmed').length, 2,
      'historical trades cannot become current-run fills');
  });

  it('still fails closed on a new external trade whose trade_value is absent', async () => {
    const fake = fixture({ history: 'eight', missingTradeValue: true,
      externalAfterOpen: true, externalFlattens: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
    assert.notEqual(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(result.receipt.liveReady, false);
    assert.equal(fake.postCount >= 1, true);
  });
});

describe('Gate G3G exact fractional trade time formal offline path', () => {
  it('reproduces the former time blocker but verifies flat baseline and sub-ms OPEN/CLOSE', async () => {
    assert.equal(gateIoExecutionSecondsToMilliseconds(1800000000.4845), null,
      'the old float/integer path rejected a factual Gate sub-ms time');
    const fake = fixture({ history: 'eight', missingTradeValue: true,
      subMillisecondTimes: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'PASS', JSON.stringify(result.receipt));
    assert.equal(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(fake.postCount, 2);
    assert.equal(fake.position, 0);
    const events = fake.journal.readFromLogicalSequence(1);
    assert.equal(events.filter((event) => event.type === 'position.baseline.confirmed').length, 1);
    assert.equal(events.filter((event) => event.type === 'execution.fill.confirmed').length, 2);
  });

  it('keeps a new exact external trade distinct even in the same projected millisecond', async () => {
    const fake = fixture({ history: 'eight', missingTradeValue: true,
      subMillisecondTimes: true, externalAfterOpen: true, externalFlattens: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
    assert.notEqual(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(result.receipt.liveReady, false);
    assert.equal(fake.postCount >= 1, true);
  });

  it('rejects an existing historical ID whose exact sub-ms source changes within one ms', async () => {
    const fake = fixture({ history: 'one', missingTradeValue: true,
      subMillisecondTimes: true, historicalTimeChangedAfterOpen: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
    assert.notEqual(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(fake.postCount >= 1, true);
  });
});

describe('Gate G3H current-run fill attestation with delayed personal trades', () => {
  it('passes the formal OPEN/CLOSE/FLAT path while both current fills lag in my_trades', async () => {
    const fake = fixture({ history: 'eight', missingTradeValue: true,
      subMillisecondTimes: true, historyLag: 'both' });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'PASS', JSON.stringify(result.receipt));
    assert.equal(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(result.receipt.currentRunTradeHistory, 'LAGGING');
    assert.equal(result.receipt.budget.attestationUsed, 2);
    assert.equal(result.receipt.budget.networkUsed, fake.calls.length);
    assert.equal(result.receipt.budget.networkUsed <= 39, true);
    assert.equal(fake.postCount, 2);
    assert.equal(fake.position, 0);
    assert.equal(fake.journal.readFromLogicalSequence(1)
      .filter((event) => event.type === 'execution.fill.confirmed').length, 2,
    'read-only order attestation must not apply a second Kernel fill');
  });

  it('returns FAIL_CLEANED_UP when cleanup is factually flat despite lagging history', async () => {
    const fake = fixture({ history: 'one', historyLag: 'both',
      closeRejectedForCleanup: true, missingTradeValue: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
    assert.equal(result.receipt.reasonCode, 'FAIL_CLEANED_UP');
    assert.equal(result.receipt.currentRunTradeHistory, 'LAGGING');
    assert.equal(result.receipt.budget.attestationUsed, 2);
    assert.equal(result.receipt.budget.cleanupUsed, 1);
    assert.equal(fake.postCount, 3);
    assert.equal(fake.position, 0);
    assert.equal(fake.journal.readFromLogicalSequence(1)
      .filter((event) => event.type === 'execution.fill.confirmed').length, 2);
  });

  it('attests a lagging CLOSE against a visible OPEN trade and the resulting flat position', async () => {
    const fake = fixture({ history: 'one', historyLag: 'close' });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'PASS', JSON.stringify(result.receipt));
    assert.equal(result.receipt.currentRunTradeHistory, 'LAGGING');
    assert.equal(result.receipt.budget.attestationUsed, 1);
    assert.equal(fake.position, 0);
  });

  for (const failure of ['NOT_FOUND', 'QUANTITY_MISMATCH'] as const) {
    it('fails closed when exact order lookup is ' + failure, async () => {
      const fake = fixture({ history: 'one', historyLag: 'both',
        orderLookupFailure: failure });
      const result = await fake.binding.run();
      assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
      assert.notEqual(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
      assert.equal(result.receipt.currentRunTradeHistory, 'UNKNOWN');
      assert.equal(result.receipt.budget.attestationUsed, 1);
      assert.equal(fake.postCount, 1);
    });
  }

  it('fails closed when the fresh Gate position disagrees with the exact order fill', async () => {
    const fake = fixture({ history: 'one', historyLag: 'both',
      positionMismatchAfterOpen: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
    assert.equal(result.receipt.currentRunTradeHistory, 'UNKNOWN');
    assert.notEqual(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(fake.postCount, 1);
  });

  it('converges when a delayed trade appears later, without another order GET or fill apply', async () => {
    const fake = fixture({ history: 'one', historyLag: 'open' });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'PASS', JSON.stringify(result.receipt));
    assert.equal(result.receipt.currentRunTradeHistory, 'CONVERGED');
    assert.equal(result.receipt.budget.attestationUsed, 1);
    assert.equal(fake.journal.readFromLogicalSequence(1)
      .filter((event) => event.type === 'execution.fill.confirmed').length, 2);
  });

  it('still fails closed on unrelated new trade during a history lag', async () => {
    const fake = fixture({ history: 'one', historyLag: 'both',
      externalAfterOpen: true });
    const result = await fake.binding.run();
    assert.equal(result.receipt.status, 'STOP', JSON.stringify(result.receipt));
    assert.notEqual(result.receipt.reasonCode, 'G3_FACTUAL_FLAT');
    assert.equal(result.receipt.currentRunTradeHistory, 'UNKNOWN');
  });
});
