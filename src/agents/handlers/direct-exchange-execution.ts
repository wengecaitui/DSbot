/**
 * Phase 8A: direct exchange mutation quarantine.
 *
 * Agent platform handlers (binance.ts, bybit.ts) previously traded directly
 * against exchange credentials (BINANCE_API_KEY / BINANCE_API_SECRET, etc.)
 * without routing through the authoritative ProductionSpine ->
 * PreTradeRiskGateway -> OMS path. That would let a direct Agent execution
 * authority coexist with the owner spine for the same runtime identity,
 * violating the Phase 8A "no dual execution authority" invariant.
 *
 * When the Application Production Runtime Owner quarantines legacy write paths
 * (productionRuntime.enabled === true), createGateway() marks these direct
 * exchange mutation surfaces quarantined. The corresponding mutation handlers
 * then fail closed before reading credentials or contacting the exchange.
 * Read-only handlers (balance, positions, orders, price, funding) are
 * intentionally left untouched.
 */

export type DirectExchangeId = 'binance' | 'bybit';

const quarantined = new Set<DirectExchangeId>();

export function setDirectExchangeExecutionQuarantined(
  exchange: DirectExchangeId,
  value: boolean,
): void {
  if (value) quarantined.add(exchange);
  else quarantined.delete(exchange);
}

export function isDirectExchangeExecutionQuarantined(exchange: DirectExchangeId): boolean {
  return quarantined.has(exchange);
}

export function directExecutionQuarantineReason(exchange: DirectExchangeId): string {
  return `${exchange} direct execution is quarantined by the authoritative production runtime`;
}
