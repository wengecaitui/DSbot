// Phase 4: PositionPlanStore — event-backed plan projection
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { PositionPlan } from './position-plan-types';
import { generatePlanId } from './plan-id';

interface PlanRecord { snapshot: PositionPlan; }

export class PositionPlanStore {
  private plans = new Map<string, PlanRecord>();

  apply(envelope: KernelEventEnvelope): PositionPlan | null {
    const { type, kernelLogicalSequence: seq, kernelEventId: eventId } = envelope;
    const payload = envelope.payload as Record<string, unknown>;

    if (type === 'position.plan.created') {
      const plan = payload.plan as PositionPlan & { planId: string };
      if (!plan?.planId) throw new Error('PLAN_STORE: plan.created missing planId');
      if (this.plans.has(plan.planId)) return null; // duplicate — idempotent
      const frozen: PositionPlan = Object.freeze({ ...plan, planVersion: seq, sourceKernelEventId: eventId, status: 'active' });
      this.plans.set(plan.planId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'position.plan.updated') {
      const p = payload as { planId: string; stopPrice?: number };
      const rec = this.plans.get(p.planId); if (!rec) throw new Error(`PLAN_STORE: unknown plan ${p.planId}`);
      if (seq <= rec.snapshot.planVersion) return null;
      const frozen: PositionPlan = Object.freeze({ ...rec.snapshot, ...p, planVersion: seq, sourceKernelEventId: eventId, status: 'active' });
      this.plans.set(p.planId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'position.plan.archived') {
      const p = payload as { planId: string };
      const rec = this.plans.get(p.planId); if (!rec) throw new Error(`PLAN_STORE: unknown plan ${p.planId}`);
      if (seq <= rec.snapshot.planVersion) return null;
      const frozen: PositionPlan = Object.freeze({ ...rec.snapshot, status: 'archived', planVersion: seq, sourceKernelEventId: eventId });
      this.plans.set(p.planId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'position.plan.closed') {
      const p = payload as { planId: string };
      const rec = this.plans.get(p.planId); if (!rec) throw new Error(`PLAN_STORE: unknown plan ${p.planId}`);
      if (seq <= rec.snapshot.planVersion) return null;
      const frozen: PositionPlan = Object.freeze({ ...rec.snapshot, status: 'closed', planVersion: seq, sourceKernelEventId: eventId });
      this.plans.set(p.planId, { snapshot: frozen });
      return frozen;
    }

    throw new Error(`PLAN_STORE: unknown event ${type}`);
  }

  getActive(symbol: string): PositionPlan | undefined {
    for (const r of this.plans.values()) if (r.snapshot.symbol === symbol && r.snapshot.status === 'active') return r.snapshot;
    return undefined;
  }

  get(planId: string): PositionPlan | undefined { return this.plans.get(planId)?.snapshot; }
}
