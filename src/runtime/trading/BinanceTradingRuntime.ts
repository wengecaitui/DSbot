// Stage 3B3D + 3B4A: Binance Trading Runtime composition root
//
// Composes createTradingRuntime with a Binance Market Data Provider.
// Layer responsibilities (must NOT cross):
//   UniverseManager           → SubscriptionPlan (canonical symbols)
//   TradingRuntime            → plan defensive copy, PlanAwareCollector, lifecycle
//   BinanceMarketDataProvider → snapshot Binance config, build Collector per plan
//   BinanceV2PublicCollector   → dual-route WS, ack lifecycle, reconnect,
//                                ticker merge, kline close
//   PlanAwareCollector        → exchange symbol → canonical symbol normalization
//
// Stage 3B4A — Refactor to Provider:
//   The snapshot + collector-build logic now lives in
//   createBinanceMarketDataProvider(). createBinanceTradingRuntime is now a
//   thin wrapper that builds a Provider and wires its createCollector into
//   createTradingRuntime. Public API, types, and behavior are unchanged.

import type { TradingRuntime, TradingRuntimeOptions } from './TradingRuntime';
import { createTradingRuntime } from './TradingRuntime';
import type {
  BinanceV2PublicCollectorOptions,
  BinanceCollectorFailure,
} from '../../data/binance/BinanceV2PublicCollector';
import {
  createBinanceMarketDataProvider,
  type BinanceMarketDataProviderOptions,
} from './BinanceMarketDataProvider';

/**
 * Failure reported by a Binance Collector owned by the runtime.
 * Augments the protocol-level BinanceCollectorFailure with the SubscriptionPlan
 * version that the failing Collector was actually running under.
 */
export interface BinanceTradingRuntimeCollectorFailure
  extends BinanceCollectorFailure {
  readonly planVersion: number;
}

/**
 * Options for createBinanceTradingRuntime.
 *
 * Extends TradingRuntimeOptions but replaces `collectorFactory` with a Binance-
 * specific `binance` options bag. The factory is constructed internally so
 * that the runtime can supply the exact captured SubscriptionPlan on each
 * (re)start.
 */
export interface BinanceTradingRuntimeOptions
  extends Omit<TradingRuntimeOptions, 'collectorFactory' | 'exchange'> {

  /**
   * Binance V2 Collector tuning. All fields optional except `plan` which is
   * supplied by the runtime on each restart. NEVER read `binance.plan` even if
   * the caller injects it via `any` — the runtime plan always overrides.
   */
  readonly binance?: Omit<BinanceV2PublicCollectorOptions, 'plan'>;

  /**
   * Optional Collector failure callback. Each Collector instance binds its
   * own handler; restart swaps the binding. The callback receives the
   * Collector's actual planVersion at the time of the failure.
   */
  readonly onBinanceCollectorError?: (
    failure: BinanceTradingRuntimeCollectorFailure
  ) => void;
}

/**
 * Compose a TradingRuntime with a Binance V2 Public Collector factory.
 *
 * Since Stage 3B4A this function delegates to createBinanceMarketDataProvider.
 * Public API, types, and behavior are unchanged.
 *
 * The Provider:
 *   - Creates a NEW BinanceV2PublicCollector per restart (no caching, no
 *     singleton).
 *   - Sources all non-plan configuration from the snapshot taken at the
 *     time the Provider (and thus this function) is called.
 *   - Passes the runtime-supplied SubscriptionPlan as the LAST field so
 *     caller-supplied `binance.plan` (when injected via `any`) is overridden.
 *   - Binds onBinanceCollectorError with the live Collector's planVersion.
 */
export function createBinanceTradingRuntime(
  options: BinanceTradingRuntimeOptions
): TradingRuntime {
  const {
    binance,
    onBinanceCollectorError,
    ...tradingOptions
  } = options;

  const providerOptions: BinanceMarketDataProviderOptions = {
    binance,
    onBinanceCollectorError,
  };
  const provider = createBinanceMarketDataProvider(providerOptions);

  const runtimeOptions: Omit<TradingRuntimeOptions, 'collectorFactory' | 'exchange'> = tradingOptions;

  return createTradingRuntime({
    ...runtimeOptions,
    exchange: 'binance',
    collectorFactory: (plan) => provider.createCollector(plan),
  });
}
