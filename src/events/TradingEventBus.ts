// Stage 3A1-R2 + 3B4C2: TradingEventBus — typed pub/sub, strict invariants
// Stage 3B4C2: publish boundary validates exchange provenance.
//   - market.ticker.updated: requires ticker + isExchangeId(ticker.exchange).
//   - market.kline.closed:  requires kline + isExchangeId(kline.exchange) + confirm === true.
//   Invalid exchange is rejected synchronously (never reaches subscribers).
//   No separate `source` field — exchange travels on ticker/kline itself.
import { KlineClosedEventRejectedError } from './TradingEvent';
import type { TradingEventType, TradingEventPayloadMap, TradingEvent } from './TradingEvent';
import { isExchangeId } from '../data/MarketIdentity';
import { validateTradingEventPayload } from './validateTradingEventPayload';

export class InvalidExchangeProvenanceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InvalidExchangeProvenanceError';
    Object.setPrototypeOf(this, InvalidExchangeProvenanceError.prototype);
  }
}

export interface TradingEventBus {
  subscribe<T extends TradingEventType>(
    type: T,
    handler: (event: TradingEvent<T>) => void,
  ): () => void;
  publish<T extends TradingEventType>(
    type: T,
    payload: TradingEventPayloadMap[T],
  ): { delivered: number; failures: number; sequence: number };
}

export function createTradingEventBus(): TradingEventBus {
  let seq = 0;
  const subs = new Map<TradingEventType, Array<(e: unknown) => void>>();

  return {
    subscribe(type, handler) {
      const list = subs.get(type) ?? [];
      list.push(handler as (e: unknown) => void);
      subs.set(type, list);
      let unsubbed = false;
      return () => {
        if (unsubbed) return;
        unsubbed = true;
        const i = list.indexOf(handler as (e: unknown) => void);
        if (i !== -1) list.splice(i, 1);
      };
    },

    publish(type, payload) {
      // Stage 3B4C2 + Phase 1A: delegate to shared canonical validation
      validateTradingEventPayload(type, payload as Record<string, unknown>);

      seq += 1;
      const sequence = seq;
      const event = { type, sequence, ...payload } as unknown as TradingEvent;

      const entries = subs.get(type);
      const handlers = entries ? [...entries] : [];
      let delivered = 0;
      let failures = 0;

      for (const h of handlers) {
        let ret: unknown;
        try { ret = h(event); } catch {
          failures += 1;
          continue;
        }
        if (ret !== null && typeof ret === 'object' && typeof (ret as { then?: unknown }).then === 'function') {
          failures += 1;
          Promise.resolve(ret as Promise<unknown>).catch(() => {});
          continue;
        }
        delivered += 1;
      }

      return { delivered, failures, sequence };
    },
  };
}
