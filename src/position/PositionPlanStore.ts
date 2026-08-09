// Phase 4: PositionPlanStore — event-backed with plan field validation
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { PositionPlan } from './position-plan-types';

interface PlanRecord { snapshot: PositionPlan; }

function validatePlan(plan: Record<string, unknown>): void {
  if (typeof plan.planId !== 'string' || !plan.planId) throw new Error('PLAN_STORE: planId required');
  if (typeof plan.symbol !== 'string' || !plan.symbol) throw new Error('PLAN_STORE: symbol required');
  if (plan.positionSide !== 'long' && plan.positionSide !== 'short') throw new Error('PLAN_STORE: invalid positionSide');
  if (typeof plan.entryPrice !== 'number' || !Number.isFinite(plan.entryPrice) || plan.entryPrice <= 0) throw new Error('PLAN_STORE: invalid entryPrice');
  if (typeof plan.stopPrice !== 'number' || !Number.isFinite(plan.stopPrice) || plan.stopPrice <= 0) throw new Error('PLAN_STORE: invalid stopPrice');
}

export class PositionPlanStore {
  private plans = new Map<string, PlanRecord>();

  apply(envelope: KernelEventEnvelope): PositionPlan | null {
    const { type, kernelLogicalSequence: seq, kernelEventId: eventId } = envelope;
    const payload = envelope.payload as Record<string, unknown>;

    if (type === 'position.plan.created') {
      const plan = payload.plan as Record<string, unknown> & { planId: string };
      if (!plan?.planId) throw new Error('PLAN_STORE: plan.created missing planId');
      validatePlan(plan);
      if (this.plans.has(plan.planId)) return null;
      const frozen: PositionPlan = Object.freeze({ ...plan as any, planVersion: seq, sourceKernelEventId: eventId, status: 'active' });
      this.plans.set(plan.planId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'position.plan.updated') {
      const p = payload as { planId: string; stopPrice?: number };
      if (!p.planId) throw new Error('PLAN_STORE: plan.updated missing planId');
      const rec = this.plans.get(p.planId); if (!rec) throw new Error(`PLAN_STORE: unknown plan ${p.planId}`);
      if (seq <= rec.snapshot.planVersion) return null;
      if (p.stopPrice !== undefined) {
        if (typeof p.stopPrice !== 'number' || !Number.isFinite(p.stopPrice) || p.stopPrice <= 0) throw new Error('PLAN_STORE: invalid stopPrice in update');
      }
      const frozen: PositionPlan = Object.freeze({ ...rec.snapshot, ...p, planVersion: seq, sourceKernelEventId: eventId, status: 'active' });
      this.plans.set(p.planId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'position.plan.archived') {
      const p = payload as { planId: string };
      if (!p.planId) throw new Error('PLAN_STORE: plan.archived missing planId');
      const rec = this.plans.get(p.planId); if (!rec) throw new Error(`PLAN_STORE: unknown plan ${p.planId}`);
      if (seq <= rec.snapshot.planVersion) return null;
      const frozen: PositionPlan = Object.freeze({ ...rec.snapshot, status: 'archived', planVersion: seq, sourceKernelEventId: eventId });
      this.plans.set(p.planId, { snapshot: frozen });
      return frozen;
    }

    if (type === 'position.plan.closed') {
      const p = payload as { planId: string };
      if (!p.planId) throw new Error('PLAN_STORE: plan.closed missing planId');
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
