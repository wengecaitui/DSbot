/** Explicit, bounded venue composition. No runtime, OMS, risk engine or position store is created here. */
import type { WsTicker } from '../../data/types';
import { createMarketSnapshotStore } from '../../data/MarketSnapshotStore';
import { GateIoFuturesExecutionAdapter } from '../../exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import type { ProductionSpine } from '../../position/ProductionSpine';
import { createGateIoExecutionTruthPort } from '../../reconciliation/GateIoExecutionTruthPort';
import type { AccountBoundHardRiskSnapshot } from '../../risk/pretrade-risk-types';
import { createMarketDataRuntime } from '../market/MarketDataRuntime';
import type { ProductionRuntimeHardRiskConfig } from '../production/ProductionRuntimeOwner';
import { createGateIoAuthenticatedReadFoundation } from './GateIoAuthenticatedReadFoundation';
import { createGateIoFuturesExecutionClient, type GateIoEnvironment } from './GateIoFuturesExecutionClient';
import { GateIoG3RunBudget } from './GateIoG3RunBudget';
import type { GateIoReadCredential } from './GateIoReadContracts';
import { createGateIoReadTransport, createGateIoTestnetReadTransport, type GateIoReadFetch } from './GateIoReadTransport';

export interface GateIoProductionDependencies {
  readonly environment: GateIoEnvironment;
  readonly accountId: string;
  readonly credential: GateIoReadCredential;
  readonly fetchImpl: GateIoReadFetch;
  readonly now: () => number;
  /** Explicit finite session budget. No replenishment, retry or background loop. */
  readonly runBudget: GateIoG3RunBudget;
}

export function createGateIoProductionBinding(
  options: GateIoProductionDependencies,
  riskLimits: ProductionRuntimeHardRiskConfig,
  staleAfterMs = 30_000,
) {
  if (!options || (options.environment !== 'testnet' && options.environment !== 'live')
      || !options.accountId || typeof options.fetchImpl !== 'function'
      || typeof options.now !== 'function' || !(options.runBudget instanceof GateIoG3RunBudget)
      || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0 || staleAfterMs > 30_000) {
    throw new Error('GATEIO_PRODUCTION_BINDING_INVALID');
  }
  const clock = Object.freeze({ now: options.now });
  options = Object.freeze({ ...options, credential: Object.freeze({ ...options.credential }) });
  riskLimits = Object.freeze({ ...riskLimits });
  const transport = options.environment === 'testnet'
    ? createGateIoTestnetReadTransport(options.fetchImpl, options.runBudget)
    : createGateIoReadTransport(options.fetchImpl, options.runBudget);
  const foundation = createGateIoAuthenticatedReadFoundation({
    transport, runBudget: options.runBudget, credential: options.credential,
    now: options.now, identity: { exchange: 'gateio', accountId: options.accountId, settle: 'USDT' },
  });
  let spine: ProductionSpine | null = null;
  let emitTicker: ((ticker: WsTicker) => void) | null = null;
  let collecting = false;
  const client = createGateIoFuturesExecutionClient({
    environment: options.environment, credential: options.credential,
    signedTimestamp: () => foundation.signedTimestamp(),
    fetchImpl: options.fetchImpl, runBudget: options.runBudget,
    readFoundation: { async instrumentFacts() {
      const facts = gateTruth.currentInstrument();
      return facts === null
        ? { availability: 'UNKNOWN', value: null, reason: 'INSTRUMENT_FACTS_UNKNOWN', failureProvenance: null }
        : { availability: 'AVAILABLE', value: facts, reason: null, failureProvenance: null };
    } },
  });
  const adapter = new GateIoFuturesExecutionAdapter(client);
  const gateTruth = createGateIoExecutionTruthPort({
    environment: options.environment, transport, runBudget: options.runBudget, foundation,
    accountId: options.accountId, now: options.now,
    listOmsOrders: () => {
      if (!spine) throw new Error('GATEIO_PRODUCTION_SPINE_NOT_BOUND');
      return spine.oms.getStore().list();
    },
    attestCurrentRunOrder: (text, order) => client.lookupSubmittedOrder(text, order?.preparation ? {
      text, contract: 'ETH_USDT', price: '0', tif: 'ioc',
      size: (order.side === 'buy' ? 1 : -1) * order.preparation.venueQuantity,
      reduceOnly: order.preparation.reduceOnly,
    } : undefined),
  });

  function facts() {
    const value = gateTruth.canonicalForCapture(gateTruth.captureSequence());
    const now = clock.now();
    if (!value || !Number.isSafeInteger(now)
        || value.account.identity.accountId !== options.accountId
        || value.account.freshness !== 'FRESH' || value.instrument.freshness !== 'FRESH'
        || [value.account.observedAtMs, value.instrument.observedAtMs]
          .some((at) => now < at || now - at > staleAfterMs)) {
      throw new Error('GATEIO_PRODUCTION_FACTS_UNAVAILABLE');
    }
    return value;
  }
  function publishMarket(): void {
    const { instrument: f } = facts();
    const { bestBid, bestAsk, volume24h, high24h, low24h } = f;
    if (!f.contractOpenable || f.inDelisting || f.contract !== 'ETH_USDT'
        || typeof bestBid !== 'number' || !Number.isFinite(bestBid) || bestBid <= 0
        || typeof bestAsk !== 'number' || !Number.isFinite(bestAsk) || bestAsk < bestBid
        || typeof volume24h !== 'number' || !Number.isFinite(volume24h) || volume24h < 0
        || typeof high24h !== 'number' || !Number.isFinite(high24h) || high24h <= 0
        || typeof low24h !== 'number' || !Number.isFinite(low24h) || low24h <= 0
        || high24h < low24h) throw new Error('GATEIO_PRODUCTION_MARKET_UNAVAILABLE');
    if (collecting) emitTicker?.({
      channel: 'ticker', exchange: 'gateio', instId: 'ETH/USDT',
      last: f.lastPrice, bestBid, bestAsk, volume24h, high24h, low24h, ts: f.serverTimeMs,
    });
  }
  const marketRuntime = createMarketDataRuntime({
    // Preserve the actual observation time; repeatedly reading a cache must not rejuvenate it.
    clock: { now: () => facts().instrument.observedAtMs }, staleAfterMs,
    store: createMarketSnapshotStore({ clock, staleAfterMs }),
    collectorFactory: () => ({
      async start() { collecting = true; publishMarket(); },
      stop() { collecting = false; emitTicker = null; },
      onTicker(handler) { emitTicker = handler; },
      onKline() { /* No invented candles or reference-feed substitution. */ },
    }),
  });
  const truthPort = Object.freeze({
    async acquireTruth() {
      if (!spine) throw new Error('GATEIO_PRODUCTION_SPINE_NOT_BOUND');
      const truth = await gateTruth.acquireTruth();
      if (truth.complete && gateTruth.captureSequence() === 1
          && spine.oms.getStore().list().length === 0) {
        // This fixes historical observation scope only. Never publishes FLAT or repairs positions.
        gateTruth.establishVerifiedTradeBoundary(truth);
      }
      return truth;
    },
  });
  return Object.freeze({
    adapter, truthPort, marketRuntime, clock, staleAfterMs,
    currentRunTradeHistory: gateTruth.currentRunTradeHistory,
    bindSpine(value: ProductionSpine) {
      if (spine !== null || value.adapter !== adapter || value.executionMode !== 'limited-live')
        throw new Error('GATEIO_PRODUCTION_SPINE_BINDING_MISMATCH');
      spine = value;
    },
    hardRisk(): AccountBoundHardRiskSnapshot {
      const { account } = facts();
      const capital = Math.min(riskLimits.totalCapitalUsd, account.account.total);
      const available = Math.min(riskLimits.maxSinglePositionAbsUsd, account.account.available);
      if (!Number.isFinite(capital) || capital < 0 || !Number.isFinite(available) || available < 0)
        throw new Error('GATEIO_PRODUCTION_ACCOUNT_UNAVAILABLE');
      // Caller policy can only tighten factual Gate capacity. No invented equity formula.
      return Object.freeze({ ...riskLimits, exchange: 'gateio', accountId: options.accountId,
        totalCapitalUsd: capital, maxSinglePositionAbsUsd: available });
    },
  });
}
