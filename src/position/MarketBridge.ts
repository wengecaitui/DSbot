// Phase 4C: MarketBridge — bridges production EventBus market data → TradingKernel
//
// Subscribes to the existing production TradingEventBus for market.ticker.updated,
// forwards each event into the shared TradingKernel so KernelMarketStateStore
// receives authoritative production market input.

import type { TradingEventBus } from '../events/TradingEventBus';
import type { TradingKernel } from '../kernel/TradingKernel';

export function bridgeMarketToKernel(
  eventBus: TradingEventBus,
  kernel: TradingKernel,
): () => void {
  const handler = (event: { type: string; payload: any }) => {
    const p = event.payload;
    try {
      kernel.publish('market.ticker.updated', {
        ticker: {
          exchange: p.exchange,
          instId: p.symbol,
          symbol: p.symbol,
          channel: 'ticker' as const,
          last: p.last,
          bestBid: p.bestBid,
          bestAsk: p.bestAsk,
          volume24h: p.volume24h,
          high24h: p.high24h,
          low24h: p.low24h,
          ts: p.ts,
        },
        receivedAt: Date.now(),
      });
    } catch (_) {
      // Fail-closed: don't break production data flow for kernel projection errors
    }
  };

  const unsub = eventBus.subscribe('market.ticker.updated', handler);
  return () => { (unsub as any)(); };
}
