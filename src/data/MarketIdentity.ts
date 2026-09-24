// Stage 3B4C1 + 3B4C1-R1 + 3B4C2 + 3B4C4: Exchange-aware market identity
//
// Single canonical definition of ExchangeId and ExchangeAwareMarketData.
// Imported by data layer (types.ts, Collectors), runtime layer (PlanAwareCollector,
// ExchangeMarketDataProvider), and test code.
//
// Rules:
//   - ExchangeId is the ONLY canonical source of exchange identity in the project.
//   - ExchangeAwareMarketData.exchange is REQUIRED (not optional, never 'unknown').
//   - WsTicker and WsKline extend this interface (see types.ts).
//   - The data layer MUST NOT import from runtime/trading.
//   - ExchangeMarketDataProvider re-exports ExchangeId for backward compat.
//
// Stage 3B4C1-R1: hard runtime type guard. Rejects arbitrary strings, empty
// strings, case variants ('BITGET'), unknown/default exchange, and non-string
// values (null/undefined/number/object). Used by PlanAwareCollector to fail
// closed on invalid provenance.
//
// Stage 3B4C2: sourceKey — single canonical Map key for exchange-isolated storage.
//   - Strict: caller MUST pass ExchangeId (no optional, no default).
//   - Validated: throws synchronously on invalid exchange / empty / whitespace symbol.
//   - No round-trip: sourceKey never reparsed to recover exchange/symbol —
//     structured fields always travel with the value.
//   - Internal: only used as Map string key; never persisted to disk, never
//     surfaced in API responses, never logged.
//
// Stage 3B4C4: assertExchangeId — runtime assertion narrowing helper.
// Used by KillSwitch, ExecutionRouter, SlowPipeline, FastPipeline, TradingRuntime
// to fail closed on exchange mismatch during construction.

export type ExchangeId = 'bitget' | 'binance' | 'gateio';

export interface ExchangeAwareMarketData {
  readonly exchange: ExchangeId;
  readonly instId: string;
}

/**
 * Stage 3B4C1-R1: Runtime type guard for ExchangeId.
 *
 * Accepts EXACTLY 'bitget', 'binance', or 'gateio'. Rejects:
 *   - any other string (e.g. 'coinbase', 'okx')
 *   - empty string
 *   - case variants ('BITGET', 'Bitget', ' Binance ')
 *   - unknown / default-exchange placeholders
 *   - null / undefined / number / object / array
 *
 * Used at trust boundaries (PlanAwareCollector) to fail closed on invalid
 * provenance — invalid inputs are silently dropped, never thrown, never
 * re-emitted with a fabricated exchange.
 */
export function isExchangeId(value: unknown): value is ExchangeId {
  return value === 'bitget' || value === 'binance' || value === 'gateio';
}

/**
 * Stage 3B4C4: Runtime assertion for ExchangeId.
 *
 * Throws synchronously if `exchange` is not a valid ExchangeId.
 * The error message includes `componentName` for traceability.
 * This does NOT set a default exchange, does NOT coerce case,
 * does NOT infer from symbol/URL/config.
 *
 * On success, narrows `exchange` from unknown to ExchangeId so the
 * caller can use it without further type guards.
 *
 * Used at construction boundaries (KillSwitch, ExecutionRouter, etc.)
 * to fail closed on invalid provenance at the earliest possible moment.
 */
export function assertExchangeId(
  componentName: string,
  exchange: unknown,
): asserts exchange is ExchangeId {
  if (!isExchangeId(exchange)) {
    throw new Error(
      `${componentName}: invalid exchange: ${JSON.stringify(exchange)}`,
    );
  }
}

/**
 * Stage 3B4C2: Canonical Map key for exchange-isolated market state.
 *
 * Returns `${exchange}:${symbol}` (e.g. 'bitget:BTC/USDT', 'binance:BTC/USDT').
 *
 * Strict contract:
 *   - exchange MUST be a valid ExchangeId (validated via isExchangeId).
 *     Invalid exchange throws synchronously — never silently coerced.
 *   - symbol MUST be a non-empty string with no inner whitespace.
 *     Empty / 'BTC USDT' / ' BTC/USDT ' all throw.
 *   - The function is total: same inputs always yield same output, no I/O,
 *     no clock, no global state.
 *   - The returned key is opaque. Consumers MUST NOT substr/parse it back.
 *     Structured exchange + symbol travel with the value object; the key is
 *     only the Map lookup token.
 *
 * Throws:
 *   - Error('sourceKey: invalid exchange: <value>') on bad exchange.
 *   - Error('sourceKey: invalid symbol: <reason>') on bad symbol.
 */
export function sourceKey(exchange: ExchangeId, symbol: string): string {
  if (!isExchangeId(exchange)) {
    throw new Error(`sourceKey: invalid exchange: ${JSON.stringify(exchange)}`);
  }
  if (typeof symbol !== 'string') {
    throw new Error(`sourceKey: invalid symbol: not a string (${JSON.stringify(symbol)})`);
  }
  if (symbol.length === 0) {
    throw new Error('sourceKey: invalid symbol: empty string');
  }
  if (/\s/.test(symbol)) {
    throw new Error(`sourceKey: invalid symbol: contains whitespace: ${JSON.stringify(symbol)}`);
  }
  return `${exchange}:${symbol}`;
}
