import type { ExecutionPreparation, OrderExecutionObservation, OmsOrderSnapshot, OmsConfirmedFill } from './oms-types';
import { subtractQuantity } from '../types/decimal-quantity';

export function quantityEqual(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a - b) <= Number.EPSILON * Math.max(Math.abs(a), Math.abs(b), 1e-12) * 32;
}

export function validateExecutionPreparation(p: ExecutionPreparation): void {
  if (!p || ![p.requestedQuantity, p.venueQuantity, p.quantityMultiplier]
    .every(n => Number.isFinite(n) && n > 0)
    || !quantityEqual(p.requestedQuantity, p.venueQuantity * p.quantityMultiplier)
    || typeof p.clientOrderId !== 'string' || !p.clientOrderId
    || typeof p.reduceOnly !== 'boolean') throw new Error('OMS_EXECUTION_PREPARATION_INVALID');
}

export function validateExecutionObservation(o: OrderExecutionObservation): void {
  if (!o || typeof o.orderId !== 'string' || !o.orderId
      || typeof o.exchangeOrderId !== 'string' || !o.exchangeOrderId
      || (o.aggregateFillId !== undefined && (typeof o.aggregateFillId !== 'string' || !o.aggregateFillId))
      || !Number.isFinite(o.requestedQuantity) || o.requestedQuantity <= 0
      || ![o.cumulativeFilledQuantity, o.remainingQuantity, o.cumulativeNotional]
        .every(n => Number.isFinite(n) && n >= 0)
      || o.cumulativeFilledQuantity > o.requestedQuantity
      || !quantityEqual(o.cumulativeFilledQuantity + o.remainingQuantity, o.requestedQuantity)
      || !Number.isSafeInteger(o.executedAt) || o.executedAt <= 0
      || (o.cumulativeFilledQuantity === 0) !== (o.cumulativeNotional === 0)
      || !['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'].includes(o.status)
      || (o.status === 'FILLED' && o.remainingQuantity !== 0)
      || (o.status === 'PARTIALLY_FILLED' && (o.cumulativeFilledQuantity === 0 || o.remainingQuantity === 0))
      || (['SUBMITTED', 'REJECTED'].includes(o.status) && o.cumulativeFilledQuantity !== 0))
    throw new Error('OMS_EXECUTION_OBSERVATION_INVALID');
}

/** Same deterministic transition for live application and replay; no independent authority. */
export function planExecutionObservation(order: OmsOrderSnapshot, o: OrderExecutionObservation): {
  readonly duplicate: boolean; readonly fill: OmsConfirmedFill | null;
} {
  validateExecutionObservation(o);
  if (!order.preparation || o.orderId !== order.orderId
      || !quantityEqual(o.requestedQuantity, order.preparation.requestedQuantity))
    throw new Error('OMS_EXECUTION_REQUEST_MISMATCH');
  const prior = order.execution;
  const cumulative = prior?.cumulativeFilledQuantity ?? 0;
  const notional = prior?.cumulativeNotional ?? 0;
  if (prior && (o.exchangeOrderId !== prior.exchangeOrderId
      || (prior.aggregateFillId !== undefined && o.aggregateFillId !== prior.aggregateFillId)
      || o.executedAt < prior.executedAt))
    throw new Error('OMS_EXECUTION_IDENTITY_OR_TIME_CONFLICT');
  if (o.cumulativeFilledQuantity < cumulative) throw new Error('OMS_EXECUTION_CUMULATIVE_REGRESSION');
  const sameQuantity = quantityEqual(o.cumulativeFilledQuantity, cumulative);
  if (sameQuantity && !quantityEqual(o.cumulativeNotional, notional))
    throw new Error('OMS_EXECUTION_NOTIONAL_CONFLICT');
  if (['FILLED', 'CANCELLED', 'REJECTED'].includes(order.status)
      && (!prior || !sameQuantity || o.status !== prior.status))
    throw new Error('OMS_EXECUTION_TERMINAL_CONFLICT');
  if (prior && sameQuantity && o.status === prior.status) return { duplicate: true, fill: null };
  if (sameQuantity) return { duplicate: false, fill: null };
  const delta = subtractQuantity(o.cumulativeFilledQuantity, cumulative);
  const price = (o.cumulativeNotional - notional) / delta;
  if (!Number.isFinite(price) || price <= 0) throw new Error('OMS_EXECUTION_DELTA_INVALID');
  const fillId = cumulative === 0 && o.status === 'FILLED'
    ? o.aggregateFillId ?? o.exchangeOrderId : `${o.exchangeOrderId}:cumulative:${o.cumulativeFilledQuantity}`;
  return { duplicate: false, fill: Object.freeze({ fillId, orderId: order.orderId,
    intentId: order.intentId, exchange: order.exchange, symbol: order.symbol, side: order.side,
    quantity: delta, price, executedAt: o.executedAt }) };
}
