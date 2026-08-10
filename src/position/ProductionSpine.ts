// Phase 4C: ProductionSpine — unified kernel-backed paper execution spine
//
// One shared TradingKernel powers the full execution chain:
//   market data → KernelMarketStateStore
//   execution.fill.confirmed → KernelPositionStateStore
//   PreTradeRiskGateway → OmsCore → PaperExecutionAdapter → PaperExecutionService
//   PositionManagerRuntime → real OMS (no more oms: undefined)

import { createTradingKernel, type TradingKernel } from '../kernel/TradingKernel';
import { createKernelPositionStateStore, type KernelPositionStateStore } from '../kernel/KernelPositionStateStore';
import type { KernelMarketStateStore } from '../kernel/KernelMarketStateStore';
import { OmsCore } from '../oms/OmsCore';
import { PaperExecutionAdapter } from '../oms/PaperExecutionAdapter';
import { PaperExecutionService, type ExecuteParams } from '../paper/PaperExecutionService';
import type { PaperBrokerPersistence } from '../paper/PaperBroker';
import type { PaperAccountConfig } from '../types/paper-account';
import type { RiskSnapshot } from '../router/KillSwitch';
import { createPositionManagerRuntime } from './PositionManagerRuntime';
import { PositionPlanStore } from './PositionPlanStore';

export interface ProductionSpineConfig {
  exchange: string;
  accountId?: string;
  paperAccount?: PaperAccountConfig;
  persistence?: PaperBrokerPersistence;
  hardRisk: () => RiskSnapshot;
  stopPct?: number;
  journal?: any;
  clock?: any;
  marketStore?: KernelMarketStateStore;
}

export interface ProductionSpine {
  kernel: TradingKernel;
  positionStore: KernelPositionStateStore;
  marketStore: KernelMarketStateStore | undefined;
  oms: OmsCore;
  planStore: PositionPlanStore;
  protection: ReturnType<typeof createPositionManagerRuntime>;
  adapter: PaperExecutionAdapter;
  service: PaperExecutionService;
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
  const kernel = createTradingKernel({
    exchange,
    journal: config.journal,
    clock: config.clock,
  });

  // Paper execution service
  const paperConfig: PaperAccountConfig = config.paperAccount ?? {
    accountId: config.accountId ?? `${config.exchange}-paper`,
    exchange,
    initialCashUsd: 100000,
  } as PaperAccountConfig;
  const persistence = config.persistence ?? inMemoryPersistence();
  const service = await PaperExecutionService.open(paperConfig, persistence);

  // OMS + adapter — per-request ExecuteParams via factory
  const defaultExecuteParams: ExecuteParams = {
    markPriceUsd: 50000,
    feeBps: 10,
    slippageBps: 0,
    executedAtMs: Date.now(),
  };
  const adapter = new PaperExecutionAdapter(service, defaultExecuteParams);
  const oms = new OmsCore(kernel, adapter);

  // State stores
  const positionStore = createKernelPositionStateStore();
  kernel.subscribe('execution.fill.confirmed', (e) => { positionStore.apply(e); });

  const planStore = new PositionPlanStore();

  // Position protection with REAL OMS
  const protection = createPositionManagerRuntime({
    kernel,
    positionStore,
    planStore,
    oms,
    marketStore: config.marketStore,
    hardRisk: config.hardRisk as any,
    stopPct: config.stopPct ?? 0.05,
  });

  return {
    kernel,
    positionStore,
    marketStore: config.marketStore,
    oms,
    planStore,
    protection,
    adapter,
    service,
  };
}
