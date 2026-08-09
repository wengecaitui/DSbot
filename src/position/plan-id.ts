// Phase 4: Deterministic plan ID
import { createHash } from 'node:crypto';

export function generatePlanId(symbol: string, side: 'long' | 'short', entryPrice: number, positionVersion: number): string {
  const canonical = JSON.stringify([symbol, side, entryPrice, positionVersion]);
  return createHash('sha256').update(canonical).digest('hex');
}
