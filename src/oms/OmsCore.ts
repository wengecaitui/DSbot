// Phase 3: OmsCore — deterministic OMS with real TradingKernel
import type { ExchangeId } from '../data/MarketIdentity';
import type { TradeIntent } from '../types/trade-intent';
import type { TradeAction } from '../risk/pretrade-risk-types';
import type { TradingKernel } from '../kernel/TradingKernel';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { ExecutionAdapter, ExecutionResult } from './oms-types';
import type { OmsOrder, OmsOrderSnapshot, OmsConfirmedFill } from './oms-types';
import { OmsOrderStore } from './OmsOrderStore';
import { generateOrderId } from './order-id';
import { validateConfirmedFill } from '../types/confirmed-fill';

const TERMINAL_OR_BLOCKED: string[] = ['FILLED', 'REJECTED', 'SUBMISSION_UNKNOWN'];

function deriveSide(direction: 'long' | 'short'): 'buy' | 'sell' {
  return direction === 'long' ? 'buy' : 'sell';
}

function isSameOrder(a: OmsOrder, intent: TradeIntent, action: TradeAction, approved: number): boolean {
  return a.intentId === intent.intentId && a.exchange === intent.exchange &&
    a.symbol === intent.symbol && a.approvedNotionalUsd === approved &&
    a.action === action && a.side === deriveSide(intent.direction);
}

export class OmsCore {
  private kernel: TradingKernel;
  private store: OmsOrderStore;
  private adapter: ExecutionAdapter;

  constructor(kernel: TradingKernel, adapter: ExecutionAdapter, store?: OmsOrderStore) {
    this.kernel = kernel;
    this.adapter = adapter;
    this.store = store ?? new OmsOrderStore();
    // Auto-subscribe store to kernel events
    this.kernel.subscribe('order.created', (e: KernelEventEnvelope<'order.created'>) => { this.store.apply(e); });
    this.kernel.subscribe('order.submitted', (e: KernelEventEnvelope<'order.submitted'>) => { this.store.apply(e); });
    this.kernel.subscribe('order.rejected', (e: KernelEventEnvelope<'order.rejected'>) => { this.store.apply(e); });
    this.kernel.subscribe('order.submission.unknown', (e: KernelEventEnvelope<'order.submission.unknown'>) => { this.store.apply(e); });
    this.kernel.subscribe('execution.fill.confirmed', (e: KernelEventEnvelope<'execution.fill.confirmed'>) => { this.store.apply(e); });
  }

  getStore(): OmsOrderStore { return this.store; }

  async submitRequest(
    intent: TradeIntent, action: TradeAction, approvedPositionUsd: number,
  ): Promise<{ status: string; order?: OmsOrderSnapshot; fill?: OmsConfirmedFill; reason?: string }> {
    const side = deriveSide(intent.direction);
    const orderId = generateOrderId({
      intentId: intent.intentId, exchange: intent.exchange, symbol: intent.symbol,
      direction: intent.direction, action, approvedPositionUsd: approvedPositionUsd });

    // Idempotency check
    const existing = this.store.get(orderId);
    if (existing) {
      if (TERMINAL_OR_BLOCKED.includes(existing.status)) {
        return { status: 'duplicate', order: existing };
      }
      return { status: 'duplicate', order: existing };
    }

    const order: OmsOrder = {
      orderId, intentId: intent.intentId, exchange: intent.exchange, symbol: intent.symbol,
      action, side, orderType: 'market', approvedNotionalUsd: approvedPositionUsd };

    // 1. order.created via real kernel
    const created = this.kernel.publish('order.created', { order });
    if (created.status === 'duplicate') {
      return { status: 'duplicate', order: this.store.get(orderId)! };
    }

    // 2. order.submitted
    this.kernel.publish('order.submitted', { orderId });

    // 3. Call adapter
    let result: ExecutionResult;
    try {
      result = await this.adapter.submit(order);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.kernel.publish('order.submission.unknown', { orderId, reason });
      return { status: 'submission_unknown', order: this.store.get(orderId)!, reason };
    }

    // 4. Resolve
    if (result.status === 'filled') {
      const fill = result.fill;
      // Full attribution validation
      if (fill.orderId !== orderId || fill.intentId !== intent.intentId ||
          fill.exchange !== intent.exchange || fill.symbol !== intent.symbol ||
          fill.side !== side) {
        this.kernel.publish('order.rejected', { orderId, reason: 'fill attribution mismatch' });
        return { status: 'rejected', order: this.store.get(orderId)!, reason: 'fill attribution mismatch' };
      }
      try { validateConfirmedFill(fill); } catch {
        this.kernel.publish('order.rejected', { orderId, reason: 'invalid fill fields' });
        return { status: 'rejected', order: this.store.get(orderId)!, reason: 'invalid fill fields' };
      }
      this.kernel.publish('execution.fill.confirmed', { fill });
      return { status: 'filled', order: this.store.get(orderId)!, fill };
    }

    if (result.status === 'rejected') {
      this.kernel.publish('order.rejected', { orderId, reason: result.reason });
      return { status: 'rejected', order: this.store.get(orderId)!, reason: result.reason };
    }

    if (result.status === 'accepted') {
      return { status: 'submitted', order: this.store.get(orderId)! };
    }

    // unknown
    this.kernel.publish('order.submission.unknown', { orderId, reason: result.reason });
    return { status: 'submission_unknown', order: this.store.get(orderId)!, reason: result.reason };
  }
}
