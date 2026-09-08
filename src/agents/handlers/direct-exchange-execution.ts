/**
 * Central quarantine for legacy mutation surfaces that do not route through
 * the authoritative ProductionSpine -> PreTradeRiskGateway -> OMS path.
 *
 * The application ProductionRuntimeOwner establishes this state. Handlers and
 * skills only query it, before reading credentials or constructing clients.
 */

export const DIRECT_MUTATION_SURFACES = Object.freeze([
  'binance',
  'bybit',
  'opinion',
  'predictfun',
  'trading-futures',
] as const);

export type DirectMutationSurface = typeof DIRECT_MUTATION_SURFACES[number];

let quarantined = false;

export function setDirectMutationQuarantined(value: boolean): void {
  quarantined = value;
}

export function isDirectMutationQuarantined(_surface: DirectMutationSurface): boolean {
  return quarantined;
}

export function directMutationQuarantineReason(surface: DirectMutationSurface): string {
  return `${surface} direct mutation is quarantined by the authoritative production runtime`;
}
