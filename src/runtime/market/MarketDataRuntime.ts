// Stage 3A3 + 3A5 + 3B4C2: MarketDataRuntime — ticker + kline data composition
// Stage 3A5: project confirmed kline into CandleSeriesStore as well
// Stage 3B4C2: exchange provenance flows from collector → bus → store unchanged.
//   - Collector emits ticker/kline with exchange already stamped.
//   - EventBus validates exchange at publish boundary (rejects invalid).
//   - Store subscribers write using the event's own ticker.exchange/kline.exchange.
//   - No fetching, defaulting, or override of exchange at any layer.
import type { WsTicker, WsKline } from '../../data/types';
import type { Clock } from '../../data/MarketSnapshot';
import type { MarketSnapshotStore } from '../../data/MarketSnapshot';
import type { CandleSeriesStore } from '../../data/CandleSeriesStore';
import type { ExchangeId } from '../../data/MarketIdentity';
import type { TradingEventBus } from '../../events';
import type { TradingEventPayloadMap } from '../../events';
import { createTradingEventBus, KlineClosedEventRejectedError, InvalidExchangeProvenanceError } from '../../events';
import { createMarketSnapshotStore } from '../../data/MarketSnapshotStore';
import { createCandleSeriesStore } from '../../data/CandleSeriesStore';

export interface MarketDataCollectorPort {
  start(): Promise<void>;
  stop(): void;
  onTicker(handler: (ticker: WsTicker) => void): void;
  onKline(handler: (kline: WsKline) => void): void;
}

export interface MarketDataRuntimeFailure {
  readonly source: 'collector_start' | 'collector_callback' | 'bus_publish' | 'store_subscriber';
  readonly error: unknown;
  readonly symbol?: string;
  readonly exchange?: ExchangeId;
}

export interface MarketDataRuntime {
  readonly bus: TradingEventBus;
  readonly store: MarketSnapshotStore;
  readonly candleStore: CandleSeriesStore;
  readonly isRunning: boolean;
  start(): Promise<void>;
  stop(): void;
  /**
   * Subscribe to collector-originated ticker ingestion — the provenance authority.
   * Fires ONLY when the active collector ingests a ticker (before bus publication).
   * Direct writes to `bus` never reach this path.
   */
  onTickerIngested(handler: (ticker: WsTicker) => void): () => void;
}

export interface MarketDataRuntimeOptions {
  collectorFactory: () => MarketDataCollectorPort;
  clock?: Clock;
  staleAfterMs?: number;
  bus?: TradingEventBus;
  store?: MarketSnapshotStore;
  candleStore?: CandleSeriesStore;
  onError?: (failure: MarketDataRuntimeFailure) => void;
}

type Generation = number;
let nextGeneration: Generation = 0;

export function createMarketDataRuntime(
  options: MarketDataRuntimeOptions,
): MarketDataRuntime {
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const bus: TradingEventBus = options.bus ?? createTradingEventBus();
  const store: MarketSnapshotStore =
    options.store ?? createMarketSnapshotStore({ clock, staleAfterMs });
  // Stage 3A5: candle store — inject or default. Created once at runtime init,
  // preserved across stop/start cycles (no re-creation).
  const candleStore: CandleSeriesStore = options.candleStore ?? createCandleSeriesStore();
  const onError = options.onError;

  // — Internal state --------------------------------------------------------

  let startPromise: Promise<void> | null = null;
  let running = false;
  let activeCollector: MarketDataCollectorPort | null = null;
  let generation: Generation = 0;
  let unsubStoreTicker: (() => void) | null = null;
  let unsubStoreKline: (() => void) | null = null;
  let cycleToken = 0;

  // — Collector provenance observers ----------------------------------------
  // Fires only on collector ingestion (not on direct bus writes).
  const tickerIngestionHandlers: Array<(ticker: WsTicker) => void> = [];

  function onTickerIngested(handler: (ticker: WsTicker) => void): () => void {
    tickerIngestionHandlers.push(handler);
    return () => {
      const i = tickerIngestionHandlers.indexOf(handler);
      if (i >= 0) tickerIngestionHandlers.splice(i, 1);
    };
  }

  function notifyTickerIngested(ticker: WsTicker): void {
    for (const handler of tickerIngestionHandlers) {
      try { handler(ticker); } catch { /* never break ingestion */ }
    }
  }

  // — Safe error reporting --------------------------------------------------

  function safeReport(failure: MarketDataRuntimeFailure): void {
    try { onError?.(failure); } catch { /* never bubble */ }
  }

  // — Store subscriber lifecycle --------------------------------------------

  function subscribeStore(): void {
    if (unsubStoreTicker !== null || unsubStoreKline !== null) return;
    const unsubTicker = bus.subscribe('market.ticker.updated', (event) => {
      // Stage 3B4C2: event.ticker.exchange has already been validated by bus.publish;
      // Store write uses event.ticker.exchange + event.ticker.instId (canonical).
      try {
        store.updateTicker({ ticker: event.ticker, receivedAt: event.receivedAt });
      } catch (err) {
        safeReport({
          source: 'store_subscriber',
          error: err,
          symbol: event.ticker.instId,
          exchange: event.ticker.exchange,
        });
      }
    });
    unsubStoreTicker = unsubTicker;
    try {
      unsubStoreKline = bus.subscribe('market.kline.closed', (event) => {
        // Stage 3A5: dual projection into snapshot + candle series
        // Stage 3B4C2: event.kline.exchange validated by bus.publish; both stores
        // take exchange + canonical instId from the event itself.
        try {
          store.updateClosedKline({ kline: event.kline, receivedAt: event.receivedAt });
        } catch (err) {
          safeReport({
            source: 'store_subscriber',
            error: err,
            symbol: event.kline.instId,
            exchange: event.kline.exchange,
          });
        }
        try {
          candleStore.appendClosedKline({ kline: event.kline, receivedAt: event.receivedAt });
        } catch (err) {
          safeReport({
            source: 'store_subscriber',
            error: err,
            symbol: event.kline.instId,
            exchange: event.kline.exchange,
          });
        }
      });
    } catch (err) {
      unsubStoreTicker = null;
      unsubTicker();
      throw err;
    }
  }

  function unsubscribeStore(): void {
    const t = unsubStoreTicker;
    const k = unsubStoreKline;
    unsubStoreTicker = null;
    unsubStoreKline = null;
    if (t) { try { t(); } catch (e) { safeReport({ source: 'store_subscriber', error: e }); } }
    if (k) { try { k(); } catch (e) { safeReport({ source: 'store_subscriber', error: e }); } }
  }

  // — Factory ---------------------------------------------------------------

  return {
    get bus(): TradingEventBus { return bus; },
    get store(): MarketSnapshotStore { return store; },
    get candleStore(): CandleSeriesStore { return candleStore; },
    get isRunning(): boolean { return running; },
    onTickerIngested,

    start(): Promise<void> {
      if (startPromise !== null) return startPromise;
      if (running) return Promise.resolve();

      startPromise = (async () => {
        nextGeneration += 1;
        generation = nextGeneration;
        const myGen = generation;
        const collector = options.collectorFactory();
        const myToken = ++cycleToken;

        subscribeStore();

        collector.onTicker((ticker) => {
          if (generation !== myGen || collector !== activeCollector) return;
          // Collector provenance: notify ingestion observers BEFORE bus publish.
          notifyTickerIngested(ticker);
          try {
            const receivedAt = clock.now();
            const result = bus.publish('market.ticker.updated', { ticker, receivedAt });
            if (result.failures > 0) safeReport({
              source: 'store_subscriber',
              error: new Error(`${result.failures} ticker subscriber(s) failed`),
              symbol: ticker.instId,
              exchange: ticker.exchange,
            });
          } catch (err) {
            safeReport({
              source: 'bus_publish',
              error: err,
              symbol: ticker.instId,
              exchange: ticker.exchange,
            });
          }
        });

        collector.onKline((kline) => {
          if (generation !== myGen || collector !== activeCollector) return;
          if (kline.confirm !== true) return;
          try {
            const receivedAt = clock.now();
            bus.publish('market.kline.closed', { kline, receivedAt });
          } catch (err: unknown) {
            safeReport({
              source: 'bus_publish',
              error: err instanceof KlineClosedEventRejectedError || err instanceof InvalidExchangeProvenanceError
                ? err.message
                : err,
              symbol: kline.instId,
              exchange: kline.exchange,
            });
          }
        });

        activeCollector = collector;

        try {
          await collector.start();
        } catch (err) {
          if (myToken === cycleToken) {
            nextGeneration += 1;
            generation = nextGeneration;
            activeCollector = null;
            running = false;
            unsubscribeStore();
            collector.stop();
            startPromise = null;
            safeReport({ source: 'collector_start', error: err });
            throw err;
          }
          return;
        }

        if (myToken === cycleToken) {
          running = true;
          startPromise = null;
        }
      })();

      return startPromise;
    },

    stop(): void {
      if (!running && activeCollector === null) return;

      cycleToken += 1;

      nextGeneration += 1;
      generation = nextGeneration;

      const collector = activeCollector;
      activeCollector = null;
      running = false;
      startPromise = null;

      unsubscribeStore();
      collector?.stop();
    },
  };
}
