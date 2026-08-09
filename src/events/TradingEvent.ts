// Stage 3A1-R2 + 3B4C2: Trading Event types — Exact 3-event flat contract
// Reuses WsTicker, WsKline, MarketBiasReportFull. No copy/reduction.
//
// Stage 3B4C2: exchange provenance comes from ticker.exchange/kline.exchange.
// No independent `source` field — EventBus payloads are NOT extended.
// The event bus validates exchange at publish boundary (see TradingEventBus.ts).

import type { WsTicker, WsKline } from '../data/types';
import type { MarketBiasReportFull } from '../types/market-bias';
import type { CompiledPolicy } from '../types/policy-snapshot';
import type { ConfirmedFill } from '../types/confirmed-fill';
import type { ConfirmedPositionBaseline } from '../types/position-state';
import type { OrderCreatedPayload, OrderStatusPayload } from '../oms/oms-events';
import type { PositionPlan } from '../position/position-plan-types';

export interface TradingEventPayloadMap {
  'market.ticker.updated':       { ticker: WsTicker; receivedAt: number };
  'market.kline.closed':         { kline: WsKline; receivedAt: number };
  'research.bias.updated':       { report: MarketBiasReportFull; receivedAt: number };
  'policy.snapshot.published':   { policy: CompiledPolicy };
  'execution.fill.confirmed':    { fill: ConfirmedFill };
  'position.baseline.confirmed': { baseline: ConfirmedPositionBaseline };
  'order.created':               OrderCreatedPayload;
  'order.submitted':             OrderStatusPayload;
  'order.rejected':              OrderStatusPayload;
  'order.submission.unknown':    OrderStatusPayload;
  'position.plan.created':      { plan: PositionPlan };
  'position.plan.updated':      { planId: string; stopPrice?: number };
  'position.plan.archived':     { planId: string };
  'position.plan.closed':       { planId: string };
}

export type TradingEventType = keyof TradingEventPayloadMap;

/** Flattened event shape: { type, sequence, ...payloadFields } */
export type TradingEvent<T extends TradingEventType = TradingEventType> =
  T extends TradingEventType
    ? { type: T; sequence: number } & TradingEventPayloadMap[T]
    : never;

export class KlineClosedEventRejectedError extends Error {
  constructor(msg = 'market.kline.closed requires kline.confirm === true') {
    super(msg);
    this.name = 'KlineClosedEventRejectedError';
    Object.setPrototypeOf(this, KlineClosedEventRejectedError.prototype);
  }
}

export class InvalidExchangeProvenanceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InvalidExchangeProvenanceError';
    Object.setPrototypeOf(this, InvalidExchangeProvenanceError.prototype);
  }
}
