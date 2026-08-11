// Phase 4C: ProductionSpine — unified kernel-backed paper execution spine
//
// One shared TradingKernel powers:
//   market.ticker.updated → KernelMarketStateStore
//   PreTradeRiskGateway → OmsCore → PaperExecutionAdapter → factual fill
//   execution.fill.confirmed → KernelPositionStateStore → PositionManagerRuntime

import { createTradingKernel, type TradingKernel } from '../kernel/TradingKernel';
import { createKernelPositionStateStore, type KernelPositionStateStore } from '../kernel/KernelPositionStateStore';
import { createKernelMarketStateStore, type KernelMarketStateStore } from '../kernel/KernelMarketStateStore';
import { OmsCore } from '../oms/OmsCore';
import { PaperExecutionAdapter } from '../oms/PaperExecutionAdapter';
import { PaperExecutionService, type ExecuteParams } from '../paper/PaperExecutionService';
import type { PaperBrokerPersistence } from '../paper/PaperBroker';
import type { PaperAccountConfig } from '../types/paper-account';
import type { RiskSnapshot } from '../router/KillSwitch';
import { createPositionManagerRuntime } from './PositionManagerRuntime';
import { PositionPlanStore } from './PositionPlanStore';
import { systemDomainClock } from '../runtime/Clock';
import { evaluatePreTradeRisk } from '../risk/PreTradeRiskGateway';
import type { GatewayInput } from '../risk/pretrade-risk-types';
import type { TradeIntent } from '../types/trade-intent';

export interface ProductionSpineConfig {
  exchange: string;
  accountId?: string;
  paperAccount?: PaperAccountConfig;
  persistence?: PaperBrokerPersistence;
  hardRisk: () => RiskSnapshot;
  stopPct?: number;
  journal?: any;
  clock?: any;
  /** Market data staleness threshold in milliseconds. Default: 60000 (1 minute). */
  marketStaleAfterMs?: number;
}

export interface ProductionSpine {
  kernel: TradingKernel;
  positionStore: KernelPositionStateStore;
  marketStore: KernelMarketStateStore;
  oms: OmsCore;
  planStore: PositionPlanStore;
  protection: ReturnType<typeof createPositionManagerRuntime>;
  adapter: PaperExecutionAdapter;
  service: PaperExecutionService;
  privateConfig: { hardRisk: () => RiskSnapshot },
}

export interface ExecuteThroughGatewayResult {
  admitted: boolean;
  riskCode: string | null;
  action: 'open' | 'close';
  omsResult?: { status: string; order?: any; fill?: any; reason?: string };
}

function inMemoryPersistence(): PaperBrokerPersistence {
  let saved: any = null;
  return {
    load() { return Promise.resolve(saved); },
    save(ledger: any) { saved = ledger; return Promise.resolve(); },
  };
}

export async function createProductionSpine(config: ProductionSpineConfig): Promise<ProductionSpine> {
  const exchange = config.exchange as any;
  const clock = config.clock ?? systemDomainClock;
  const kernel = createTradingKernel({
    exchange,
    journal: config.journal,
    clock,
  });

  // ── Market state store (subscribed to kernel) ──
  const marketStore = createKernelMarketStateStore({
    clock,
    staleAfterMs: config.marketStaleAfterMs ?? 60_000,
  });
  kernel.subscribe('market.ticker.updated', (e) => { marketStore.apply(e); });

  // ── Paper execution service ──
  const paperConfig: PaperAccountConfig = config.paperAccount ?? {
    accountId: config.accountId ?? `${config.exchange}-paper`,
    exchange,
    initialCashUsd: 100000,
  } as PaperAccountConfig;
  const persistence = config.persistence ?? inMemoryPersistence();
  const service = await PaperExecutionService.open(paperConfig, persistence);

  // ── OMS + adapter (prices filled per-request from market store) ──
  const defaultExecuteParams: ExecuteParams = {
    markPriceUsd: 0, // filled per-request from market store
    feeBps: 10,
    slippageBps: 0,
    executedAtMs: Date.now(),
  };
  const adapter = new PaperExecutionAdapter(service, defaultExecuteParams);
  const oms = new OmsCore(kernel, adapter);

  // ── Position state store ──
  const positionStore = createKernelPositionStateStore();
  kernel.subscribe('execution.fill.confirmed', (e) => { positionStore.apply(e); });
  kernel.subscribe('position.baseline.confirmed' as any, (e: any) => { positionStore.apply(e); });

  const planStore = new PositionPlanStore();

  // ── Dynamic-price OMS: updates execution params from factual market price ──
  const dynamicPriceOms = {
    ...oms,
    submitRequest: (intent: TradeIntent, action: any, approvedUsd: number) => {
      const snapshot = marketStore.getSnapshot(intent.exchange as any, intent.symbol);
      const price = snapshot?.ticker?.ticker?.last ?? (adapter as any).params.markPriceUsd;
      const p = (adapter as any).params;
      p.markPriceUsd = price;
      p.executedAtMs = Date.now();
      return oms.submitRequest(intent, action, approvedUsd);
    },
    getStore: () => oms.getStore(),
  } as typeof oms;

  // ── Position protection with REAL OMS ──
  const protection = createPositionManagerRuntime({
    kernel,
    positionStore,
    planStore,
    oms: dynamicPriceOms,
    marketStore,
    hardRisk: config.hardRisk as any,
    stopPct: config.stopPct ?? 0.05,
  });

  return {
    kernel, positionStore, marketStore, oms: dynamicPriceOms, planStore, protection, adapter, service,
    privateConfig: { hardRisk: config.hardRisk },
  };
}

/**
 * Execute a TradeIntent through PreTradeRiskGateway → OmsCore → PaperExecutionAdapter.
 * Uses the factual market price from KernelMarketStateStore for the execution.
 *
 * Risk rejection returns { admitted: false, riskCode } without calling OMS.
 */
export async function executeThroughGateway(
  spine: ProductionSpine,
  intent: TradeIntent,
  action: 'open' | 'close',
  approvedUsd: number,
): Promise<ExecuteThroughGatewayResult> {
  const { kernel, positionStore, marketStore, oms, adapter } = spine;
  const exchange = intent.exchange as any;
  const symbol = intent.symbol;

  // Factual market price
  const marketSnapshot = marketStore.getSnapshot(exchange, symbol);
  const positionResolved = positionStore.resolve(exchange, symbol);
  const hardRiskSnapshot = spine.privateConfig.hardRisk();

  // Resolve position for Gateway — preserve factual semantics
  // missing → fail-closed: requires trusted baseline before first trade
  // flat → allowed: baseline has been established
  const rawStatus = positionResolved?.status;
  const isOpen = rawStatus === 'open';
  const effectiveStatus: 'open' | 'flat' | 'missing' = isOpen ? 'open'
    : rawStatus === 'missing' ? 'missing'
    : 'flat';
  const pos = isOpen
    ? { ...positionResolved, status: 'open' as const }
    : { snapshot: null, status: effectiveStatus, side: 'flat' as const, signedQuantity: 0, averageEntryPrice: 0 };

  const gatewayInput: GatewayInput = {
    intent,
    action,
    marketSnapshot: marketSnapshot as any,
    positionResolution: pos,
    policyResolution: { status: 'active', policy: null, allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'neutral', riskLevel: 'low', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } as any,
    hardRisk: hardRiskSnapshot as any,
  };

  const riskResult = evaluatePreTradeRisk(gatewayInput);
  if (riskResult.decision !== 'ADMITTED') {
    return { admitted: false, riskCode: riskResult.reasonCode, action };
  }

  // Use Gateway-authorised sizing, never caller-supplied size
  const authorisedUsd = riskResult.approvedPositionUsd;

  // Set factual market price before execution
  if (marketSnapshot?.ticker) {
    (adapter as any).params.markPriceUsd = (marketSnapshot as any).ticker?.ticker?.last ?? (marketSnapshot as any).ticker?.last ?? 0;
    (adapter as any).params.executedAtMs = Date.now();
  }

  // Execute through same OMS, using Gateway-approved size
  const omsResult = await oms.submitRequest(intent, action, authorisedUsd);

  return {
    admitted: true,
    riskCode: null,
    action,
    omsResult: {
      status: omsResult.status,
      reason: (omsResult as any).reason,
    },
  };
}

/**
 * Establish a trusted flat baseline for the given exchange+symbol.
 * Required before the first opening trade — missing positions reject at Gateway.
 */
export function trustBaseline(
  spine: ProductionSpine,
  exchange: string,
  symbol: string,
): void {
  // Publish baseline through kernel so position store projects a flat state
  spine.kernel.publish('position.baseline.confirmed' as any, {
    baseline: {
      exchange: exchange as any,
      symbol,
      side: 'flat',
      signedQuantity: 0,
      averageEntryPrice: 0,
    },
  });
}
