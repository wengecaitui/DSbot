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
  const handler = (event: any) => {
    const ticker = event.ticker;
    if (!ticker) return;
    try {
      kernel.publish('market.ticker.updated', {
        ticker: {
          exchange: ticker.exchange,
          instId: ticker.instId,
          symbol: ticker.symbol,
          channel: 'ticker' as const,
          last: ticker.last,
          bestBid: ticker.bestBid,
          bestAsk: ticker.bestAsk,
          volume24h: ticker.volume24h,
          high24h: ticker.high24h,
          low24h: ticker.low24h,
          ts: ticker.ts,
        },
        receivedAt: Date.now(),
      });
    } catch (_) {
      // Fail-closed
    }
  };

  const unsub = eventBus.subscribe('market.ticker.updated', handler);
  return () => { (unsub as any)(); };
}
