// Phase 3: OmsOrderStore — event-backed with sequence/terminal guards + legacy compat
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { OmsOrderSnapshot, OmsOrderStatus, OrderExecutionObservation, ExecutionPreparation, OmsConfirmedFill } from './oms-types';
import { planExecutionObservation, validateExecutionPreparation } from './execution-observation';

const VALID_TRANSITIONS: Record<OmsOrderStatus, readonly OmsOrderStatus[]> = {
  CREATED: ['SUBMITTED', 'REJECTED', 'SUBMISSION_UNKNOWN'],
  SUBMITTED: ['FILLED', 'REJECTED', 'SUBMISSION_UNKNOWN'],
  PARTIALLY_FILLED: ['SUBMISSION_UNKNOWN'], CANCELLED: [],
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
      const frozen: OmsOrderSnapshot = Object.freeze({ ...order, status: 'CREATED',
        requestedQuantity: null, cumulativeFilledQuantity: 0, remainingQuantity: null,
        orderVersion: seq, sourceKernelEventId: eventId });
      this.orders.set(order.orderId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'order.execution.prepared') {
      const rec = this.orders.get(payload.orderId as string);
      const p = payload.preparation as ExecutionPreparation;
      validateExecutionPreparation(p);
      if (!rec || (rec.snapshot.status !== 'SUBMITTED' && rec.snapshot.status !== 'CREATED'))
        throw new Error('OMS_STORE: preparation state invalid');
      if (seq <= rec.snapshot.orderVersion) return null;
      if (rec.snapshot.preparation) {
        if (JSON.stringify(rec.snapshot.preparation) !== JSON.stringify(p)) throw new Error('OMS_STORE: preparation conflict');
        return null;
      }
      const frozen = Object.freeze({ ...rec.snapshot, preparation: Object.freeze({ ...p }),
        requestedQuantity: p.requestedQuantity, remainingQuantity: p.requestedQuantity,
        fills: Object.freeze([]), orderVersion: seq, sourceKernelEventId: eventId });
      rec.snapshot = frozen;
      return frozen;
    }

    if (type === 'order.execution.observed' || (type === 'execution.fill.confirmed' && payload.execution)) {
      const execution = payload.execution as OrderExecutionObservation;
      const rec = this.orders.get(execution.orderId);
      if (!rec) throw new Error('OMS_STORE: observation has unknown order');
      if (seq <= rec.snapshot.orderVersion) return null;
      const plan = planExecutionObservation(rec.snapshot, execution);
      if (plan.duplicate) return null;
      const fill = payload.fill as OmsConfirmedFill | undefined;
      if ((plan.fill === null) !== (fill === undefined)
          || (plan.fill && JSON.stringify(plan.fill) !== JSON.stringify(fill))) {
        // Canonical journals sort object keys; compare field values, not insertion order.
        if (!plan.fill || !fill || Object.entries(plan.fill).some(([k,v]) => (fill as any)[k] !== v))
          throw new Error('OMS_STORE: delta does not match cumulative observation');
      }
      const frozen = Object.freeze({ ...rec.snapshot, execution: Object.freeze({ ...execution }),
        status: execution.status, requestedQuantity: execution.requestedQuantity,
        cumulativeFilledQuantity: execution.cumulativeFilledQuantity, remainingQuantity: execution.remainingQuantity,
        fills: Object.freeze([...(rec.snapshot.fills ?? []), ...(fill ? [Object.freeze({ ...fill })] : [])]),
        ...(fill ? { fillId: fill.fillId } : {}), orderVersion: seq, sourceKernelEventId: eventId });
      rec.snapshot = frozen;
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
