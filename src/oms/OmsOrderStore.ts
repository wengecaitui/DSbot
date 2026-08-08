// Phase 3: OmsOrderStore — event-backed order snapshot projection
import type { OmsOrderSnapshot, OmsOrderStatus } from './oms-types';
import { TERMINAL_STATUSES } from './oms-types';

interface OrderRecord {
  snapshot: OmsOrderSnapshot;
}

export class OmsOrderStore {
  private orders = new Map<string, OrderRecord>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply(envelope: { readonly type: string; readonly payload: Record<string, any>; readonly kernelEventId?: string; readonly kernelLogicalSequence?: number }): OmsOrderSnapshot {
    const seq = envelope.kernelLogicalSequence ?? 0;
    const eventId = envelope.kernelEventId ?? '';
    const type = envelope.type;

    if (type === 'order.created') {
      const snapshot = envelope.payload.order as OmsOrderSnapshot;
      if (!snapshot || !snapshot.orderId) throw new Error('OMS_STORE: order.created missing order');
      if (this.orders.has(snapshot.orderId)) throw new Error(`OMS_STORE: duplicate order ${snapshot.orderId}`);
      const frozen: OmsOrderSnapshot = Object.freeze({
        ...snapshot,
        status: 'CREATED',
        orderVersion: seq,
        sourceKernelEventId: eventId,
      });
      this.orders.set(snapshot.orderId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'order.submitted') {
      const update = envelope.payload as { orderId: string };
      const rec = this.orders.get(update.orderId);
      if (!rec) throw new Error(`OMS_STORE: unknown order ${update.orderId}`);
      const frozen: OmsOrderSnapshot = Object.freeze({
        ...rec.snapshot,
        status: 'SUBMITTED',
        orderVersion: seq,
        sourceKernelEventId: eventId,
      });
      this.orders.set(update.orderId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'order.rejected') {
      const update = envelope.payload as { orderId: string; reason: string };
      const rec = this.orders.get(update.orderId);
      if (!rec) throw new Error(`OMS_STORE: unknown order ${update.orderId}`);
      const frozen: OmsOrderSnapshot = Object.freeze({
        ...rec.snapshot,
        status: 'REJECTED',
        rejectionReason: update.reason,
        orderVersion: seq,
        sourceKernelEventId: eventId,
      });
      this.orders.set(update.orderId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'order.submission.unknown') {
      const update = envelope.payload as { orderId: string; reason: string };
      const rec = this.orders.get(update.orderId);
      if (!rec) throw new Error(`OMS_STORE: unknown order ${update.orderId}`);
      const frozen: OmsOrderSnapshot = Object.freeze({
        ...rec.snapshot,
        status: 'SUBMISSION_UNKNOWN',
        rejectionReason: update.reason,
        orderVersion: seq,
        sourceKernelEventId: eventId,
      });
      this.orders.set(update.orderId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'execution.fill.confirmed') {
      const fill = envelope.payload.fill as { orderId: string; fillId: string };
      const rec = this.orders.get(fill.orderId);
      if (!rec) throw new Error(`OMS_STORE: unknown order ${fill.orderId}`);
      const frozen: OmsOrderSnapshot = Object.freeze({
        ...rec.snapshot,
        status: 'FILLED',
        fillId: fill.fillId,
        orderVersion: seq,
        sourceKernelEventId: eventId,
      });
      this.orders.set(fill.orderId, { snapshot: frozen });
      return frozen;
    }

    throw new Error(`OMS_STORE: unknown event type ${type}`);
  }

  get(orderId: string): OmsOrderSnapshot | undefined {
    return this.orders.get(orderId)?.snapshot;
  }

  getByIntent(intentId: string): OmsOrderSnapshot | undefined {
    for (const rec of this.orders.values()) {
      if (rec.snapshot.intentId === intentId) return rec.snapshot;
    }
    return undefined;
  }

  getLatestStatus(orderId: string): OmsOrderStatus | undefined {
    return this.orders.get(orderId)?.snapshot?.status;
  }
}
