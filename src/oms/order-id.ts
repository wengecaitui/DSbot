// Phase 3: Deterministic Order ID
import { createHash } from 'node:crypto';

export type OrderIdParams = {
  readonly intentId: string;
  readonly exchange: string;
  readonly symbol: string;
  readonly direction: 'long' | 'short';
  readonly action: string;
  readonly approvedPositionUsd: number;
};

export function generateOrderId(params: OrderIdParams): string {
  const canonical = JSON.stringify([
    params.intentId,
    params.exchange,
    params.symbol,
    params.direction,
    params.action,
    params.approvedPositionUsd,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
