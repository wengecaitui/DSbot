// Stage 3B4C1-R1: MarketIdentity type guard tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExchangeId } from '../../src/data/MarketIdentity';
import type { ExchangeId } from '../../src/data/MarketIdentity';

// ── isExchangeId: positive cases ───────────────────────────────────────────

test('1. isExchangeId accepts "bitget"', () => {
  assert.equal(isExchangeId('bitget'), true);
  // compile-time narrowing must work
  const v: unknown = 'bitget';
  if (isExchangeId(v)) {
    const _typed: ExchangeId = v; // → ExchangeId
    assert.equal(_typed, 'bitget');
  } else {
    assert.fail('should narrow to ExchangeId');
  }
});

test('2. isExchangeId accepts "binance"', () => {
  assert.equal(isExchangeId('binance'), true);
  const v: unknown = 'binance';
  if (isExchangeId(v)) {
    const _typed: ExchangeId = v;
    assert.equal(_typed, 'binance');
  } else {
    assert.fail('should narrow to ExchangeId');
  }
});

test('2b. isExchangeId accepts "gateio" and narrows it', () => {
  const value: unknown = 'gateio';
  assert.equal(isExchangeId(value), true);
  if (isExchangeId(value)) {
    const typed: ExchangeId = value;
    assert.equal(typed, 'gateio');
  } else {
    assert.fail('should narrow gateio to ExchangeId');
  }
});

// ── isExchangeId: negative strings ──────────────────────────────────────────

test('3. isExchangeId rejects "coinbase" (unknown exchange)', () => {
  assert.equal(isExchangeId('coinbase'), false);
});

test('4. isExchangeId rejects empty string', () => {
  assert.equal(isExchangeId(''), false);
});

test('5. isExchangeId rejects case variant "BITGET"', () => {
  // Type guard is case-sensitive — 'BITGET' is a different string.
  assert.equal(isExchangeId('BITGET'), false);
  assert.equal(isExchangeId('Bitget'), false);
  assert.equal(isExchangeId(' binance'), false); // leading space
  assert.equal(isExchangeId('binance '), false); // trailing space
  assert.equal(isExchangeId('GATEIO'), false);
  assert.equal(isExchangeId('GateIO'), false);
  assert.equal(isExchangeId('gate'), false);
});

test('6. isExchangeId rejects "default" and "unknown" placeholders', () => {
  assert.equal(isExchangeId('default'), false);
  assert.equal(isExchangeId('unknown'), false);
  assert.equal(isExchangeId('exchange'), false);
});

// ── isExchangeId: non-string values ──────────────────────────────────────────

test('7. isExchangeId rejects null', () => {
  assert.equal(isExchangeId(null), false);
});

test('8. isExchangeId rejects undefined', () => {
  assert.equal(isExchangeId(undefined), false);
});

test('9. isExchangeId rejects number', () => {
  assert.equal(isExchangeId(0), false);
  assert.equal(isExchangeId(1), false);
  assert.equal(isExchangeId(NaN), false);
  assert.equal(isExchangeId(Infinity), false);
});

test('10. isExchangeId rejects object/array', () => {
  assert.equal(isExchangeId({ exchange: 'bitget' }), false);
  assert.equal(isExchangeId(['bitget']), false);
  assert.equal(isExchangeId(['bitget', 'binance']), false);
});

test('11. isExchangeId rejects boolean', () => {
  assert.equal(isExchangeId(true), false);
  assert.equal(isExchangeId(false), false);
});

// ── isExchangeId: exhaustive coverage ───────────────────────────────────────

test('12. isExchangeId only matches the three canonical values', () => {
  const allStrings: string[] = ['bitget', 'binance', 'gateio', 'BITGET', '', 'bitget ', ' binance',
                                'coinbase', 'okx', 'kraken', 'default', 'unknown',
                                'BITGET', 'Binance', 'GATEIO', 'GateIO', 'gate', 'bitgetx', 'xbittance'];
  let trueCount = 0;
  for (const s of allStrings) {
    if (isExchangeId(s)) trueCount++;
  }
  assert.equal(trueCount, 3, 'exactly three strings accepted: bitget + binance + gateio');
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C4: assertExchangeId — runtime assertion narrowing helper
// ═══════════════════════════════════════════════════════════════════════════

import { assertExchangeId, sourceKey } from '../../src/data/MarketIdentity';

test('13. assertExchangeId accepts bitget without throwing', () => {
  let narrowed: ExchangeId | null = null;
  assert.doesNotThrow(() => { narrowed = 'bitget'; assertExchangeId('TestComp', 'bitget'); });
  // After assertion, TypeScript narrows `narrowed` to ExchangeId — runtime sanity check.
  assert.equal(narrowed, 'bitget');
});

test('14. assertExchangeId accepts binance without throwing', () => {
  assert.doesNotThrow(() => assertExchangeId('TestComp', 'binance'));
});

test('14b. assertExchangeId accepts gateio without throwing', () => {
  assert.doesNotThrow(() => assertExchangeId('TestComp', 'gateio'));
});

test('15. assertExchangeId throws on coinbase', () => {
  assert.throws(
    () => assertExchangeId('TestComp', 'coinbase'),
    /TestComp: invalid exchange/,
  );
});

test('16. assertExchangeId throws on empty string', () => {
  assert.throws(
    () => assertExchangeId('TestComp', ''),
    /TestComp: invalid exchange/,
  );
});

test('17. assertExchangeId throws on case variant (BITGET)', () => {
  assert.throws(
    () => assertExchangeId('TestComp', 'BITGET'),
    /TestComp: invalid exchange/,
  );
});

test('18. assertExchangeId throws on null', () => {
  assert.throws(
    () => assertExchangeId('TestComp', null),
    /TestComp: invalid exchange/,
  );
});

test('19. assertExchangeId throws on undefined', () => {
  assert.throws(
    () => assertExchangeId('TestComp', undefined),
    /TestComp: invalid exchange/,
  );
});

test('20. assertExchangeId throws on number', () => {
  assert.throws(
    () => assertExchangeId('TestComp', 42),
    /TestComp: invalid exchange/,
  );
});

test('21. assertExchangeId throws on object/array', () => {
  assert.throws(
    () => assertExchangeId('TestComp', ['bitget']),
    /TestComp: invalid exchange/,
  );
});

test('22. assertExchangeId error includes componentName for traceability', () => {
  assert.throws(
    () => assertExchangeId('KillSwitch', 'okx'),
    /KillSwitch: invalid exchange/,
  );
  assert.throws(
    () => assertExchangeId('ExecutionRouter', 'kraken'),
    /ExecutionRouter: invalid exchange/,
  );
});

test('23. assertExchangeId is callable with unknown and narrows correctly', () => {
  // Simulate data from external source typed as unknown
  const external: unknown = 'bitget';
  assert.doesNotThrow(() => assertExchangeId('Runtime', external));
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C2 + 3B4C4: sourceKey — additional edge cases
// ═══════════════════════════════════════════════════════════════════════════

test('24. sourceKey accepts a valid exchange (defense in depth)', () => {
  assert.doesNotThrow(() => sourceKey('bitget' as ExchangeId, 'BTC/USDT'));
  assert.equal(sourceKey('bitget', 'BTC/USDT'), 'bitget:BTC/USDT');
});

test('25. sourceKey rejects symbol that is undefined', () => {
  assert.throws(
    // @ts-expect-error — intentional bad type
    () => sourceKey('bitget', undefined),
    /sourceKey: invalid symbol: not a string/,
  );
});

test('26. sourceKey produces expected format', () => {
  assert.equal(sourceKey('bitget', 'BTC/USDT'), 'bitget:BTC/USDT');
  assert.equal(sourceKey('binance', 'BTC/USDT'), 'binance:BTC/USDT');
  assert.equal(sourceKey('gateio', 'ETH/USDT'), 'gateio:ETH/USDT');
  assert.equal(sourceKey('bitget', 'ETH/USDT:SWAP'), 'bitget:ETH/USDT:SWAP');
});
