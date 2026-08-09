// Phase 1A: shared payload validation for TradingEvent types
// Extracted from TradingEventBus.ts publish() — canonical validation
// used by both legacy EventBus and TradingKernel.

import type { WsTicker, WsKline } from '../data/types';
import type { MarketBiasReportFull } from '../types/market-bias';
import { isExchangeId } from '../data/MarketIdentity';
import { InvalidExchangeProvenanceError, KlineClosedEventRejectedError } from './TradingEvent';
import { validateConfirmedFill } from '../types/confirmed-fill';
import { validatePositionBaseline } from '../types/position-state';

export function validateTradingEventPayload(
  type: string,
  payload: Record<string, unknown>,
): void {
  if (type !== 'market.ticker.updated' && type !== 'market.kline.closed' && type !== 'research.bias.updated' && type !== 'policy.snapshot.published' && type !== 'execution.fill.confirmed' && type !== 'position.baseline.confirmed' && type !== 'order.created' && type !== 'order.submitted' && type !== 'order.rejected' && type !== 'order.submission.unknown') {
    throw new Error(`UNKNOWN_EVENT_TYPE: ${JSON.stringify(type)}`);
  }

  if (type === 'policy.snapshot.published') {
    if (!payload || typeof payload !== 'object' || !(payload as { policy?: unknown }).policy) {
      throw new InvalidExchangeProvenanceError('policy.snapshot.published requires policy payload');
    }
    return;
  }

  if (type === 'market.ticker.updated') {
    const p = payload as { ticker?: WsTicker };
    if (!p || !p.ticker) {
      throw new InvalidExchangeProvenanceError('market.ticker.updated requires ticker payload');
    }
    if (!isExchangeId((p.ticker as WsTicker & { exchange?: unknown }).exchange)) {
      throw new InvalidExchangeProvenanceError(
        `market.ticker.updated: invalid ticker.exchange: ${JSON.stringify((p.ticker as WsTicker & { exchange?: unknown }).exchange)}`,
      );
    }
  }

  if (type === 'market.kline.closed') {
    const p = payload as { kline?: WsKline };
    if (!p || !p.kline) {
      throw new KlineClosedEventRejectedError('market.kline.closed requires kline payload');
    }
    if (!isExchangeId((p.kline as WsKline & { exchange?: unknown }).exchange)) {
      throw new InvalidExchangeProvenanceError(
        `market.kline.closed: invalid kline.exchange: ${JSON.stringify((p.kline as WsKline & { exchange?: unknown }).exchange)}`,
      );
    }
    if (p.kline.confirm !== true) {
      throw new KlineClosedEventRejectedError();
    }
  }

  if (type === 'research.bias.updated') {
    const p = payload as { report?: MarketBiasReportFull };
    if (!p || !p.report) {
      throw new InvalidExchangeProvenanceError('research.bias.updated requires report payload');
    }
    if (!isExchangeId((p.report as MarketBiasReportFull & { exchange?: unknown }).exchange)) {
      throw new InvalidExchangeProvenanceError(
        `research.bias.updated: invalid report.exchange: ${JSON.stringify((p.report as MarketBiasReportFull & { exchange?: unknown }).exchange)}`,
      );
    }
  }

  // Phase 1B3: execution + baseline pre-journal validation
  if (type === 'execution.fill.confirmed') {
    const p = payload as { fill?: unknown };
    if (!p || p.fill === undefined) throw new InvalidExchangeProvenanceError('execution.fill.confirmed requires fill payload');
    validateConfirmedFill(p.fill);
  }

  if (type === 'position.baseline.confirmed') {
    const p = payload as { baseline?: unknown };
    if (!p || p.baseline === undefined) throw new InvalidExchangeProvenanceError('position.baseline.confirmed requires baseline payload');
    validatePositionBaseline(p.baseline);
  }

  // Phase 3 OMS: strict order lifecycle validation
  if (type === 'order.created') {
    const p = payload as { order?: Record<string, unknown> };
    if (!p || !p.order) throw new Error('order.created requires order payload');
    const o = p.order;
    if (typeof o.orderId !== 'string' || !o.orderId) throw new Error('order.created: orderId required');
    if (typeof o.intentId !== 'string' || !o.intentId) throw new Error('order.created: intentId required');
    if (!isExchangeId(o.exchange as string)) throw new Error('order.created: invalid exchange');
    if (typeof o.symbol !== 'string' || !o.symbol) throw new Error('order.created: symbol required');
    const validActions = ['open', 'reduce', 'close', 'emergency_exit'];
    if (!validActions.includes(o.action as string)) throw new Error('order.created: invalid action');
    if (o.side !== 'buy' && o.side !== 'sell') throw new Error('order.created: invalid side');
    if (o.orderType !== 'market') throw new Error('order.created: orderType must be market');
    if (typeof o.approvedNotionalUsd !== 'number' || !Number.isFinite(o.approvedNotionalUsd) || o.approvedNotionalUsd <= 0) {
      throw new Error('order.created: approvedNotionalUsd must be finite positive');
    }
  }

  if (type === 'order.submitted') {
    const p = payload as { orderId?: unknown };
    if (typeof p.orderId !== 'string' || !p.orderId) throw new Error('order.submitted: orderId required');
  }

  if (type === 'order.rejected' || type === 'order.submission.unknown') {
    const p = payload as { orderId?: unknown; reason?: unknown };
    if (typeof p.orderId !== 'string' || !p.orderId) throw new Error(`${type}: orderId required`);
    if (typeof p.reason !== 'string' || !p.reason) throw new Error(`${type}: reason required`);
  }
}
