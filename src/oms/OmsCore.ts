// Phase 3: OmsCore — deterministic order creation, submission, resolution
import type { ExchangeId } from '../data/MarketIdentity';
import type { TradeAction } from '../risk/pretrade-risk-types';
import type { TradeIntent } from '../types/trade-intent';
import type {
  OmsOrder, OmsOrderSnapshot, OmsOrderStatus,
  ExecutionAdapter, ExecutionResult, OmsResult, OmsConfirmedFill,
} from './oms-types';
import { TERMINAL_STATUSES } from './oms-types';
import { generateOrderId } from './order-id';
import { OmsOrderStore } from './OmsOrderStore';
import { randomUUID } from 'node:crypto';

// ─── Side derivation ────────────────────────────────────────────────────────

function deriveSide(direction: 'long' | 'short'): 'buy' | 'sell' {
  return direction === 'long' ? 'buy' : 'sell';
}

// ─── Canonical order ID params ──────────────────────────────────────────────

function getOrderIdParams(intent: TradeIntent, action: TradeAction, approvedPositionUsd: number) {
  return {
    intentId: intent.intentId,
    exchange: intent.exchange,
    symbol: intent.symbol,
    direction: intent.direction,
    action,
    approvedPositionUsd,
  };
}

// ─── OmsCore ────────────────────────────────────────────────────────────────

export class OmsCore {
  private store: OmsOrderStore;
  private adapter: ExecutionAdapter;

  constructor(adapter: ExecutionAdapter, store?: OmsOrderStore) {
    this.adapter = adapter;
    this.store = store ?? new OmsOrderStore();
  }

  getStore(): OmsOrderStore { return this.store; }

  async submitRequest(
    intent: TradeIntent,
    action: TradeAction,
    approvedPositionUsd: number,
  ): Promise<OmsResult> {
    // 1. Create order
    const side = deriveSide(intent.direction);
    const params = getOrderIdParams(intent, action, approvedPositionUsd);
    const orderId = generateOrderId(params);

    const order: OmsOrder = {
      orderId,
      intentId: intent.intentId,
      exchange: intent.exchange,
      symbol: intent.symbol,
      action,
      side,
      orderType: 'market',
      approvedNotionalUsd: approvedPositionUsd,
    };

    // 2. Idempotency check
    const existing = this.store.get(orderId);
    if (existing) {
      // Check conflict
      if (existing.intentId !== order.intentId ||
          existing.exchange !== order.exchange ||
          existing.symbol !== order.symbol ||
          existing.approvedNotionalUsd !== order.approvedNotionalUsd ||
          existing.action !== order.action ||
          existing.side !== order.side) {
        return { status: 'conflict', reason: `orderId ${orderId} already exists with different content` };
      }
      return { status: 'duplicate', order: existing };
    }

    // 3. Publish order.created
    const created = this.store.apply({
      type: 'order.created',
      payload: { order },
      kernelLogicalSequence: 1, // placeholder — real kernel would provide
      kernelEventId: randomUUID(),  // placeholder
    });

    // 4. Submit → order.submitted
    const submitted = this.store.apply({
      type: 'order.submitted',
      payload: { orderId },
      kernelLogicalSequence: 2,
      kernelEventId: randomUUID(),
    });

    // 5. Call adapter
    let adapterResult: ExecutionResult;
    try {
      adapterResult = await this.adapter.submit(order);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.store.apply({
        type: 'order.submission.unknown',
        payload: { orderId, reason },
        kernelLogicalSequence: 3,
        kernelEventId: randomUUID(),
      });
      const current = this.store.get(orderId)!;
      return { status: 'submission_unknown', order: current, reason };
    }

    // 6. Resolve adapter result
    if (adapterResult.status === 'filled') {
      const fill = adapterResult.fill;
      if (fill.orderId !== orderId) {
        // Mismatched fill — reject
        this.store.apply({
          type: 'order.rejected',
          payload: { orderId, reason: `fill.orderId mismatch: ${fill.orderId} !== ${orderId}` },
          kernelLogicalSequence: 3,
          kernelEventId: randomUUID(),
        });
        const current = this.store.get(orderId)!;
        return { status: 'rejected', order: current, reason: 'fill attribution mismatch' };
      }
      this.store.apply({
        type: 'execution.fill.confirmed',
        payload: { fill },
        kernelLogicalSequence: 3,
        kernelEventId: randomUUID(),
      });
      const current = this.store.get(orderId)!;
      return { status: 'filled', order: current, fill };
    }

    if (adapterResult.status === 'rejected') {
      this.store.apply({
        type: 'order.rejected',
        payload: { orderId, reason: adapterResult.reason },
        kernelLogicalSequence: 3,
        kernelEventId: randomUUID(),
      });
      const current = this.store.get(orderId)!;
      return { status: 'rejected', order: current, reason: adapterResult.reason };
    }

    if (adapterResult.status === 'accepted') {
      const current = this.store.get(orderId)!;
      return { status: 'submitted', order: current };
    }

    // unknown
    this.store.apply({
      type: 'order.submission.unknown',
      payload: { orderId, reason: adapterResult.reason },
      kernelLogicalSequence: 3,
      kernelEventId: randomUUID(),
    });
    const finalOrder = this.store.get(orderId)!;
    return { status: 'submission_unknown', order: finalOrder, reason: adapterResult.reason };
  }
}
