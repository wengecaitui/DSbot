// Phase 1A: shared payload validation for TradingEvent types
// Extracted from TradingEventBus.ts publish() — canonical validation
// used by both legacy EventBus and TradingKernel.

import type { WsTicker, WsKline } from '../data/types';
import type { MarketBiasReportFull } from '../types/market-bias';
import { isExchangeId } from '../data/MarketIdentity';
import { InvalidExchangeProvenanceError, KlineClosedEventRejectedError } from './TradingEvent';

export function validateTradingEventPayload(
  type: string,
  payload: Record<string, unknown>,
): void {
  if (type !== 'market.ticker.updated' && type !== 'market.kline.closed' && type !== 'research.bias.updated' && type !== 'policy.snapshot.published') {
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
}
