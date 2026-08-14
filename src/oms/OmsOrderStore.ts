// Phase 3: OmsOrderStore — event-backed with sequence/terminal guards + legacy compat
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { OmsOrderSnapshot, OmsOrderStatus } from './oms-types';

const VALID_TRANSITIONS: Record<OmsOrderStatus, readonly OmsOrderStatus[]> = {
  CREATED: ['SUBMITTED', 'REJECTED', 'SUBMISSION_UNKNOWN'],
  SUBMITTED: ['FILLED', 'REJECTED', 'SUBMISSION_UNKNOWN'],
  FILLED: [], REJECTED: [], SUBMISSION_UNKNOWN: [],
};

export class OmsOrderStore {
  private orders = new Map<string, { snapshot: OmsOrderSnapshot }>();

  apply(envelope: KernelEventEnvelope): OmsOrderSnapshot | null {
    const { type, kernelLogicalSequence: seq, kernelEventId: eventId } = envelope;
    const payload = envelope.payload as Record<string, unknown>;

    if (type === 'order.created') {
      const order = payload.order as OmsOrderSnapshot & { orderId: string };
      if (!order?.orderId) throw new Error('OMS_STORE: order.created missing orderId');
      if (this.orders.has(order.orderId)) throw new Error(`OMS_STORE: duplicate order ${order.orderId}`);
      const frozen: OmsOrderSnapshot = Object.freeze({ ...order, status: 'CREATED', orderVersion: seq, sourceKernelEventId: eventId });
      this.orders.set(order.orderId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'execution.fill.confirmed') {
      const orderId = (payload.fill as Record<string, unknown>)?.orderId as string | undefined;
      // Legacy compat: ignore non-OMS fills without orderId
      if (!orderId) return null;
      return this.applyStatus(orderId, seq, eventId, 'FILLED', undefined, (payload.fill as Record<string, unknown>)?.fillId as string | undefined);
    }

    if (type === 'order.submitted' || type === 'order.rejected' || type === 'order.submission.unknown') {
      const orderId = payload.orderId as string;
      if (!orderId) throw new Error(`OMS_STORE: ${type} missing orderId`);
      if (type === 'order.submitted') return this.applyStatus(orderId, seq, eventId, 'SUBMITTED', undefined, undefined);
      const reason = payload.reason as string | undefined;
      if (type === 'order.rejected') return this.applyStatus(orderId, seq, eventId, 'REJECTED', reason, undefined);
      return this.applyStatus(orderId, seq, eventId, 'SUBMISSION_UNKNOWN', reason, undefined);
    }

    throw new Error(`OMS_STORE: unknown event type ${type}`);
  }

  private applyStatus(orderId: string, seq: number, eventId: string, target: OmsOrderStatus, reason?: string, fillId?: string): OmsOrderSnapshot | null {
    const rec = this.orders.get(orderId);
    if (!rec) throw new Error(`OMS_STORE: unknown order ${orderId}`);
    if (seq <= rec.snapshot.orderVersion) return null; // stale sequence guard
    if (!VALID_TRANSITIONS[rec.snapshot.status].includes(target)) {
      throw new Error(`OMS_STORE: invalid transition ${rec.snapshot.status} → ${target} for ${orderId}`);
    }
    const frozen: OmsOrderSnapshot = Object.freeze({
      ...rec.snapshot, status: target,
      fillId: fillId ?? rec.snapshot.fillId,
      rejectionReason: reason ?? rec.snapshot.rejectionReason,
      orderVersion: seq, sourceKernelEventId: eventId,
    });
    this.orders.set(orderId, { snapshot: frozen });
    return frozen;
  }

  get(orderId: string): OmsOrderSnapshot | undefined { return this.orders.get(orderId)?.snapshot; }
  getByIntent(intentId: string): OmsOrderSnapshot | undefined {
    for (const r of this.orders.values()) if (r.snapshot.intentId === intentId) return r.snapshot;
    return undefined;
  }

  /** Phase 5B: deterministic read-only enumeration of all current order snapshots.
   *  Snapshots are frozen at write time; the returned array is a fresh copy. */
  list(): readonly OmsOrderSnapshot[] {
    return [...this.orders.values()]
      .map((r) => r.snapshot)
      .sort((a, b) => a.orderId.localeCompare(b.orderId));
  }

  digest(): string {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const sorted = [...this.orders.entries()]
      .sort(([a], [b]) => a.localeCompare(b));
    return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
  }
}
