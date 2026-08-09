// Phase 3: OmsCore — deterministic OMS with real TradingKernel
import type { TradeIntent } from '../types/trade-intent';
import type { TradeAction } from '../risk/pretrade-risk-types';
import type { TradingKernel } from '../kernel/TradingKernel';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { ExecutionAdapter, ExecutionResult, OmsOrder, OmsOrderSnapshot, OmsConfirmedFill } from './oms-types';
import { OmsOrderStore } from './OmsOrderStore';
import { generateOrderId } from './order-id';
import { validateConfirmedFill } from '../types/confirmed-fill';

function deriveSide(direction: 'long' | 'short'): 'buy' | 'sell' {
  return direction === 'long' ? 'buy' : 'sell';
}

function isSameOmsOrder(existing: OmsOrderSnapshot, intent: TradeIntent, action: TradeAction, approved: number): boolean {
  const side = deriveSide(intent.direction);
  return existing.intentId === intent.intentId &&
    existing.exchange === intent.exchange &&
    existing.symbol === intent.symbol &&
    existing.action === action &&
    existing.side === side &&
    existing.approvedNotionalUsd === approved &&
    existing.orderType === 'market';
}

export class OmsCore {
  constructor(
    private kernel: TradingKernel,
    private adapter: ExecutionAdapter,
    private store: OmsOrderStore = new OmsOrderStore(),
  ) {
    kernel.subscribe('order.created', (e) => { this.store.apply(e); });
    kernel.subscribe('order.submitted', (e) => { this.store.apply(e); });
    kernel.subscribe('order.rejected', (e) => { this.store.apply(e); });
    kernel.subscribe('order.submission.unknown', (e) => { this.store.apply(e); });
    kernel.subscribe('execution.fill.confirmed', (e) => { this.store.apply(e); });
  }

  getStore(): OmsOrderStore { return this.store; }

  async submitRequest(
    intent: TradeIntent, action: TradeAction, approvedPositionUsd: number,
  ): Promise<{ status: string; order?: OmsOrderSnapshot; fill?: OmsConfirmedFill; reason?: string }> {
    const side = deriveSide(intent.direction);
    const orderId = generateOrderId({
      intentId: intent.intentId, exchange: intent.exchange, symbol: intent.symbol,
      direction: intent.direction, action, approvedPositionUsd });

    // FIX_4: Use isSameOmsOrder for conflict detection
    const existing = this.store.get(orderId);
    if (existing) {
      if (!isSameOmsOrder(existing, intent, action, approvedPositionUsd)) {
        return { status: 'conflict', reason: `orderId ${orderId} exists with different content` };
      }
      return { status: 'duplicate', order: existing };
    }

    const order: OmsOrder = {
      orderId, intentId: intent.intentId, exchange: intent.exchange, symbol: intent.symbol,
      action, side, orderType: 'market', approvedNotionalUsd: approvedPositionUsd };

    // 1. order.created
    this.kernel.publish('order.created', { order });

    // 2. order.submitted
    this.kernel.publish('order.submitted', { orderId });

    // 3. Call adapter
    let result: ExecutionResult;
    try { result = await this.adapter.submit(order); }
    catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.kernel.publish('order.submission.unknown', { orderId, reason });
      return { status: 'submission_unknown', order: this.store.get(orderId)!, reason };
    }

    // 4. Definite rejection
    if (result.status === 'rejected') {
      this.kernel.publish('order.rejected', { orderId, reason: result.reason });
      return { status: 'rejected', order: this.store.get(orderId)!, reason: result.reason };
    }

    // 5. FIX_2: filled with misattribution → SUBMISSION_UNKNOWN, NOT REJECTED
    if (result.status === 'filled') {
      const fill = result.fill;
      const mismatchErr = validateOmsFill(fill, orderId, intent.intentId, intent.exchange, intent.symbol, side);
      if (mismatchErr) {
        this.kernel.publish('order.submission.unknown', { orderId, reason: mismatchErr });
        return { status: 'submission_unknown', order: this.store.get(orderId)!, reason: mismatchErr };
      }
      try { validateConfirmedFill(fill); } catch (e) {
        const reason = `invalid fill: ${e instanceof Error ? e.message : String(e)}`;
        this.kernel.publish('order.submission.unknown', { orderId, reason });
        return { status: 'submission_unknown', order: this.store.get(orderId)!, reason };
      }
      this.kernel.publish('execution.fill.confirmed', { fill });
      return { status: 'filled', order: this.store.get(orderId)!, fill };
    }

    // 6. accepted
    if (result.status === 'accepted') {
      return { status: 'submitted', order: this.store.get(orderId)! };
    }

    // 7. unknown
    this.kernel.publish('order.submission.unknown', { orderId, reason: result.reason });
    return { status: 'submission_unknown', order: this.store.get(orderId)!, reason: result.reason };
  }
}

function validateOmsFill(fill: OmsConfirmedFill, orderId: string, intentId: string, exchange: string, symbol: string, side: string): string | null {
  if (fill.orderId !== orderId) return `fill.orderId mismatch: ${fill.orderId} !== ${orderId}`;
  if (fill.intentId !== intentId) return `fill.intentId mismatch: ${fill.intentId} !== ${intentId}`;
  if (fill.exchange !== exchange) return `fill.exchange mismatch: ${fill.exchange} !== ${exchange}`;
  if (fill.symbol !== symbol) return `fill.symbol mismatch: ${fill.symbol} !== ${symbol}`;
  if (fill.side !== side) return `fill.side mismatch: ${fill.side} !== ${side}`;
  return null;
}
