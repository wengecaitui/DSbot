// Phase 3: OmsOrderStore — event-backed with sequence + terminal guards
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { OmsOrderSnapshot, OmsOrderStatus } from './oms-types';

interface OrderRecord {
  snapshot: OmsOrderSnapshot;
}

const VALID_TRANSITIONS: Record<OmsOrderStatus, readonly OmsOrderStatus[]> = {
  CREATED: ['SUBMITTED', 'REJECTED', 'SUBMISSION_UNKNOWN'],
  SUBMITTED: ['FILLED', 'REJECTED', 'SUBMISSION_UNKNOWN'],
  FILLED: [],
  REJECTED: [],
  SUBMISSION_UNKNOWN: [],
};

export class OmsOrderStore {
  private orders = new Map<string, OrderRecord>();

  apply(envelope: KernelEventEnvelope): OmsOrderSnapshot | null {
    const { type, kernelLogicalSequence, kernelEventId } = envelope;
    const seq = kernelLogicalSequence;
    const eventId = kernelEventId;
    const payload = envelope.payload as Record<string, unknown>;

    if (type === 'order.created') {
      const order = payload.order as OmsOrderSnapshot & { orderId: string };
      if (!order?.orderId) throw new Error('OMS_STORE: order.created missing orderId');
      if (this.orders.has(order.orderId)) throw new Error(`OMS_STORE: duplicate order ${order.orderId}`);
      const frozen: OmsOrderSnapshot = Object.freeze({
        ...order,
        status: 'CREATED' as const,
        orderVersion: seq,
        sourceKernelEventId: eventId,
      });
      this.orders.set(order.orderId, { snapshot: frozen });
      return frozen;
    }

    // Status mutation events
    if (type === 'order.submitted' || type === 'order.rejected' ||
        type === 'order.submission.unknown' || type === 'execution.fill.confirmed') {
      const orderId = type === 'execution.fill.confirmed'
        ? (payload.fill as Record<string, unknown>)?.orderId as string
        : payload.orderId as string;
      if (!orderId) throw new Error(`OMS_STORE: ${type} missing orderId`);
      const rec = this.orders.get(orderId);
      if (!rec) throw new Error(`OMS_STORE: unknown order ${orderId}`);

      // Sequence guard: stale/equal seq → no mutation
      if (seq <= rec.snapshot.orderVersion) return null;

      // Determine target status
      let targetStatus: OmsOrderStatus;
      let fillId: string | undefined;
      let rejectionReason: string | undefined;
      if (type === 'order.submitted') targetStatus = 'SUBMITTED';
      else if (type === 'order.rejected') {
        targetStatus = 'REJECTED';
        rejectionReason = payload.reason as string | undefined;
      } else if (type === 'order.submission.unknown') {
        targetStatus = 'SUBMISSION_UNKNOWN';
        rejectionReason = payload.reason as string | undefined;
      } else {
        targetStatus = 'FILLED';
        fillId = (payload.fill as Record<string, unknown>)?.fillId as string | undefined;
      }

      // Terminal guard
      const allowed = VALID_TRANSITIONS[rec.snapshot.status];
      if (!allowed.includes(targetStatus)) {
        throw new Error(`OMS_STORE: invalid transition ${rec.snapshot.status} → ${targetStatus} for order ${orderId}`);
      }

      const frozen: OmsOrderSnapshot = Object.freeze({
        ...rec.snapshot, status: targetStatus,
        fillId: fillId ?? rec.snapshot.fillId,
        rejectionReason: rejectionReason ?? rec.snapshot.rejectionReason,
        orderVersion: seq, sourceKernelEventId: eventId,
      });
      this.orders.set(orderId, { snapshot: frozen });
      return frozen;
    }

    throw new Error(`OMS_STORE: unknown event type ${type}`);
  }

  get(orderId: string): OmsOrderSnapshot | undefined {
    return this.orders.get(orderId)?.snapshot;
  }

  getByIntent(intentId: string): OmsOrderSnapshot | undefined {
    for (const r of this.orders.values()) {
      if (r.snapshot.intentId === intentId) return r.snapshot;
    }
    return undefined;
  }
}
