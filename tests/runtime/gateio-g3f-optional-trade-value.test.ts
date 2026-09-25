/** G3F local-only proof: trade_value is optional exchange metadata, never a fill input. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeGateIoTrade } from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import { parseGateIoExactInt64Json } from '../../src/runtime/gateio/GateIoExactInt64Recovery';

const FACTUAL_TRADE = Object.freeze({
  id: '9007199254740993', order_id: '9007199254740995',
  contract: 'ETH_USDT', size: '0.1', close_size: '0', price: '2000',
  text: 'fixture-client', fee: '0', point_fee: '0', role: 'taker',
  trade_value: '123.456', create_time: '1800000000.125',
});

describe('Gate G3F optional factual trade value', () => {
  it('keeps missing distinct from factual zero and preserves supplied decimal text', () => {
    const { trade_value: _omitted, ...missingWire } = FACTUAL_TRADE;
    const missing = normalizeGateIoTrade(missingWire);
    const zero = normalizeGateIoTrade({ ...FACTUAL_TRADE, trade_value: '0' });
    const present = normalizeGateIoTrade(FACTUAL_TRADE);
    const numeric = normalizeGateIoTrade({ ...FACTUAL_TRADE, trade_value: 12.5 });
    assert.equal(missing.tradeValue, null);
    assert.equal(zero.tradeValue, '0');
    assert.equal(present.tradeValue, '123.456');
    assert.equal(numeric.tradeValue, 12.5);
    assert.equal(missing.signedSize, 0.1);
    assert.equal(missing.price, 2000);
    assert.equal(Object.isFrozen(missing), true);
    assert.notEqual(missing.tradeValue, zero.tradeValue);
  });

  it('rejects every present malformed value, including explicit null', () => {
    for (const bad of ['', ' ', 'abc', {}, [], null, undefined, NaN, Infinity]) {
      assert.throws(
        () => normalizeGateIoTrade({ ...FACTUAL_TRADE, trade_value: bad }),
        { message: 'TRADES_MALFORMED' },
      );
    }
  });

  it('does not relax identity, contract, quantity, price or timestamp requirements', () => {
    const { trade_value: _omitted, ...missingValue } = FACTUAL_TRADE;
    for (const field of ['id', 'order_id', 'contract', 'size', 'price', 'create_time'] as const) {
      const invalid = { ...missingValue, [field]: undefined };
      assert.throws(() => normalizeGateIoTrade(invalid), { message: 'TRADES_MALFORMED' });
    }
  });

  it('normalizes eight exact unsafe-int64 historical trades without trade_value', () => {
    const raw = '[' + Array.from({ length: 8 }, (_, index) => {
      const id = (9007199254740993n + BigInt(index) * 2n).toString();
      const orderId = (9007199254741093n + BigInt(index) * 2n).toString();
      const entry = { ...FACTUAL_TRADE, id: '__ID__', order_id: '__ORDER__' };
      const { trade_value: _omitted, ...wire } = entry;
      return JSON.stringify(wire).replace('"__ID__"', id).replace('"__ORDER__"', orderId);
    }).join(',') + ']';
    const parsed = parseGateIoExactInt64Json(raw,
      { shape: 'array', fields: ['id', 'order_id'] }) as unknown[];
    const canonical = parsed.map(normalizeGateIoTrade);
    assert.equal(canonical.length, 8);
    assert.equal(canonical.every((trade) => trade.tradeValue === null), true);
    assert.equal(new Set(canonical.map((trade) => trade.tradeId)).size, 8);
    assert.equal(canonical[0]!.tradeId, '9007199254740993');
    assert.equal(canonical[7]!.orderId, '9007199254741107');
  });

  it('accepts a sanitized eight-element G3E response shape without trade_value', () => {
    const { trade_value: _omitted, ...withoutValue } = FACTUAL_TRADE;
    const raw = JSON.stringify(Array.from({ length: 8 }, (_, index) => ({
      ...withoutValue,
      id: 1000 + index,
      order_id: String(2000 + index),
      size: index % 2 === 0 ? 1 : -1,
      close_size: index % 2 === 0 ? 0 : -1,
      amend_text: '',
      biz_info: '',
    })));
    const recovered = parseGateIoExactInt64Json(raw,
      { shape: 'array', fields: ['id', 'order_id'] }) as unknown[];
    const canonical = recovered.map(normalizeGateIoTrade);
    assert.equal(canonical.length, 8);
    assert.equal(canonical.every((trade) => trade.tradeValue === null), true);
    assert.deepEqual(canonical.map((trade) => trade.tradeId),
      Array.from({ length: 8 }, (_, index) => String(1000 + index)));
    assert.deepEqual(canonical.map((trade) => trade.orderId),
      Array.from({ length: 8 }, (_, index) => String(2000 + index)));
  });
});
