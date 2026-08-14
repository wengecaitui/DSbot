// Phase 5B: buildLocalReconciliationSnapshot — project recovered stores into
// the immutable LocalReconciliationSnapshot. Read-only; no mutation.

import type { KernelPositionStateStore } from '../kernel/KernelPositionStateStore';
import type { OmsOrderStore } from '../oms/OmsOrderStore';
import type { PositionPlanStore } from '../position/PositionPlanStore';
import type {
  LocalOrder,
  LocalPlan,
  LocalPosition,
  LocalReconciliationSnapshot,
  ReconciliationIdentity,
} from './reconciliation-types';

export function buildLocalReconciliationSnapshot(
  orderStore: OmsOrderStore,
  positionStore: KernelPositionStateStore,
  planStore: PositionPlanStore,
  identity: ReconciliationIdentity,
): LocalReconciliationSnapshot {
  const orders: LocalOrder[] = orderStore.list().map((o) => Object.freeze({
    orderId: o.orderId,
    intentId: o.intentId,
    exchange: o.exchange,
    symbol: o.symbol,
    side: o.side,
    status: o.status,
    fillId: o.fillId,
    orderVersion: o.orderVersion,
    sourceKernelEventId: o.sourceKernelEventId,
  } satisfies LocalOrder));

  const positions: LocalPosition[] = positionStore.listResolved().map((r) => Object.freeze({
    exchange: r.snapshot!.exchange,
    symbol: r.snapshot!.symbol,
    status: r.status,
    side: r.side,
    signedQuantity: r.signedQuantity,
    averageEntryPrice: r.averageEntryPrice,
    positionVersion: r.snapshot!.positionVersion,
    sourceKernelEventId: r.snapshot!.sourceKernelEventId,
  } satisfies LocalPosition));

  const plans: LocalPlan[] = planStore.list().map((p) => Object.freeze({
    planId: p.planId,
    exchange: p.exchange,
    symbol: p.symbol,
    positionSide: p.positionSide,
    status: p.status,
    entryPrice: p.entryPrice,
    stopPrice: p.stopPrice,
  } satisfies LocalPlan));

  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    orders: Object.freeze(orders),
    positions: Object.freeze(positions),
    plans: Object.freeze(plans),
  } satisfies LocalReconciliationSnapshot);
}
