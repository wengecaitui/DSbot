/** G3G exact decimal time evidence; all inputs are offline raw response fixtures. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeGateIoTrade } from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import { gateIoExactDecimalSource, parseGateIoExactInt64Json } from '../../src/runtime/gateio/GateIoExactInt64Recovery';
import { gateIoExactSecondsToMilliseconds } from '../../src/runtime/gateio/GateIoExactTradeTime';

const fields = { shape: 'array' as const, fields: ['id', 'order_id'],
  decimalFields: ['create_time'] };
function wire(id: string, time: string, quoted = false): string {
  return '{"id":' + id + ',"order_id":9007199254740995,"contract":"ETH_USDT",'
    + '"size":"0.1","close_size":"0","price":"2000","text":"fixture",'
    + '"fee":"0","point_fee":"0","role":"taker","create_time":'
    + (quoted ? JSON.stringify(time) : time) + '}';
}

describe('Gate G3G exact fractional trade time', () => {
  it('floors decimal seconds at canonical millisecond precision without binary multiplication', () => {
    for (const [seconds, expected] of [
      ['1800000000', 1800000000000],
      ['1800000000.1', 1800000000100],
      ['1800000000.12', 1800000000120],
      ['1800000000.123', 1800000000123],
      ['1800000000.1230', 1800000000123],
      ['1800000000.1234', 1800000000123],
      ['1800000000.123456', 1800000000123],
      ['1800000000.123999999', 1800000000123],
      ['1800000000.001', 1800000000001],
      ['1800000000.009', 1800000000009],
      ['1800000000.099', 1800000000099],
      ['1800000000.1001', 1800000000100],
      ['1800000000.9999', 1800000000999],
      ['1.8e9', 1800000000000],
    ] as const) {
      assert.equal(gateIoExactSecondsToMilliseconds(seconds), expected, seconds);
    }
  });

  it('keeps exact raw numeric source per array element and distinct same-ms trade IDs', () => {
    const raw = '[' + wire('9007199254740993', '1800000000.1231')
      + ',' + wire('9007199254740997', '1800000000.1239') + ']';
    const rows = parseGateIoExactInt64Json(raw, fields) as Record<string, unknown>[];
    const trades = rows.map(normalizeGateIoTrade);
    assert.deepEqual(trades.map((trade) => trade.tradeId),
      ['9007199254740993', '9007199254740997']);
    assert.deepEqual(trades.map((trade) => trade.createdAtSecondsExact),
      ['1800000000.1231', '1800000000.1239']);
    assert.deepEqual(trades.map((trade) => trade.createdAtMs),
      [1800000000123, 1800000000123]);
    assert.notEqual(JSON.stringify(trades[0]), JSON.stringify(trades[1]));
    assert.equal(gateIoExactDecimalSource(rows[1]!, 'create_time'), '1800000000.1239');
  });

  it('uses raw lexical time when IEEE-754 rounds the parsed number into the next millisecond', () => {
    const token = '1800000000.123999999';
    assert.equal(Math.floor(Number(token) * 1000), 1800000000124);
    const row = (parseGateIoExactInt64Json('[' + wire('9007199254740993', token) + ']',
      fields) as Record<string, unknown>[])[0]!;
    const trade = normalizeGateIoTrade(row);
    assert.equal(trade.createdAtSecondsExact, token);
    assert.equal(trade.createdAtMs, 1800000000123);
    assert.equal(trade.createdAt, 1800000000.124,
      'legacy number is explicitly not the exact source');
  });

  it('accepts old numeric scientific notation but does not expand the string grammar', () => {
    const row = (parseGateIoExactInt64Json('[' + wire('9007199254740993', '1.8e9') + ']',
      fields) as unknown[])[0];
    assert.equal(normalizeGateIoTrade(row).createdAtMs, 1800000000000);
    assert.throws(() => normalizeGateIoTrade(
      (parseGateIoExactInt64Json('[' + wire('9007199254740993', '1.8e9', true) + ']',
        fields) as unknown[])[0]), { message: 'TRADES_MALFORMED' });
    const injected = normalizeGateIoTrade({ id: '1', order_id: '2', contract: 'ETH_USDT',
      size: '0.1', close_size: '0', price: '2000', text: 'fixture', fee: '0',
      point_fee: '0', role: 'taker', create_time: 1800000000.123 });
    assert.equal(injected.createdAtSecondsExact, null,
      'a pre-parsed JS number cannot claim the raw exchange token');
  });

  it('fails closed on missing, null, malformed, nonpositive and unsafe projected time', () => {
    for (const bad of [undefined, null, 0, -1, '', 'abc', '1e3',
      '9007199254741', '9007199254740.992', NaN, Infinity, {}]) {
      const row = { id: '1', order_id: '2', contract: 'ETH_USDT', size: '0.1',
        close_size: '0', price: '2000', text: 'fixture', fee: '0', point_fee: '0',
        role: 'taker', create_time: bad };
      assert.throws(() => normalizeGateIoTrade(row), { message: 'TRADES_MALFORMED' },
        String(bad));
    }
    assert.equal(gateIoExactSecondsToMilliseconds('9007199254740.991'),
      Number.MAX_SAFE_INTEGER);
    assert.equal(gateIoExactSecondsToMilliseconds('9007199254740.992'), null);
    assert.equal(gateIoExactSecondsToMilliseconds('0.0001'), null);
    assert.throws(() => parseGateIoExactInt64Json(
      '[' + wire('1', '1800000000.1').replace('"create_time":1800000000.1',
        '"create_time":1800000000.1,"create_time":1800000000.2') + ']', fields));
  });
});
