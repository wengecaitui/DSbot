// Phase 4: Deterministic plan ID — includes exchange for cross-exchange uniqueness
import { createHash } from 'node:crypto';
import type { ExchangeId } from '../data/MarketIdentity';

export function generatePlanId(exchange: string, symbol: string, side: 'long' | 'short', entryPrice: number, positionVersion: number): string {
  const canonical = JSON.stringify([exchange, symbol, side, entryPrice, positionVersion]);
  return createHash('sha256').update(canonical).digest('hex');
}
