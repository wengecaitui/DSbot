// Phase 4C + 5A: ProductionSpine — unified kernel-backed paper execution spine
//   Phase 5A adds: durable journal, KernelPolicyStore, recovery verification, start() gate
//
// One shared TradingKernel powers:
//   market.ticker.updated → KernelMarketStateStore
//   policy.snapshot.published → KernelPolicyStore
//   PreTradeRiskGateway → OmsCore → PaperExecutionAdapter → factual fill
//   execution.fill.confirmed → KernelPositionStateStore → PositionManagerRuntime

import { createTradingKernel, type TradingKernel } from '../kernel/TradingKernel';
import { createKernelPositionStateStore, type KernelPositionStateStore } from '../kernel/KernelPositionStateStore';
import { createKernelMarketStateStore, type KernelMarketStateStore } from '../kernel/KernelMarketStateStore';
import { createKernelPolicyStore, type KernelPolicyStore } from '../kernel/KernelPolicyStore';
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
import type { EventJournalPort } from '../kernel/EventJournalPort';
import { createFileEventJournal, type FileEventJournal } from '../recovery/FileEventJournal';

export interface ProductionSpineConfig {
  exchange: string;
  accountId?: string;
  paperAccount?: PaperAccountConfig;
  persistence?: PaperBrokerPersistence;
  hardRisk: () => RiskSnapshot;
  stopPct?: number;
  journal?: EventJournalPort;
  /** Path to durable journal file. Creates FileEventJournal if provided. */
  journalPath?: string;
  clock?: any;
  marketStaleAfterMs?: number;
  /** Policy max lifetime in ms. Required for policy.snapshot.published. Default: 3_600_000 (1 hour). */
  policyMaxLifetimeMs?: number;
}

export interface ProductionSpine {
  kernel: TradingKernel;
  positionStore: KernelPositionStateStore;
  marketStore: KernelMarketStateStore;
  policyStore: KernelPolicyStore;
  oms: OmsCore;
  planStore: PositionPlanStore;
  protection: ReturnType<typeof createPositionManagerRuntime>;
  adapter: PaperExecutionAdapter;
  service: PaperExecutionService;
  privateConfig: { hardRisk: () => RiskSnapshot };
  /** Set internally by RecoveryManager — read-only to callers */
  readonly recoveryVerified: boolean;
  /** Start production: must be called after recovery verification */
  start(options: { exchange: string }): Promise<void>;
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
  const policyMaxLifetimeMs = config.policyMaxLifetimeMs ?? 3_600_000;

  // ── Durable journal ──
  const journal: EventJournalPort = (config.journal ??
    (config.journalPath ? createFileEventJournal(config.journalPath) : undefined))!;

  // ── TradingKernel with recovery sequence ──
  const kernel = createTradingKernel({
    exchange,
    journal,
    clock,
    policyMaxLifetimeMs,
    initialSequence: (journal as FileEventJournal)?.lastSequence ?? 0,
  });

  // ── Policy store (subscribed to kernel) ──
  const policyStore = createKernelPolicyStore({ clock, maxLifetimeMs: policyMaxLifetimeMs, maxVersionsPerExchange: 10 });
  kernel.subscribe('policy.snapshot.published', (e) => { policyStore.apply(e); });

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
    markPriceUsd: 0,
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

  // ── Dynamic-price OMS ──
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

  // ── Recovery state (internal) ──
  let recoveryVerified = false;
  let started = false;

  function _setRecoveryVerified() {
    if (started) throw new Error('SPINE_ALREADY_STARTED: cannot modify recoveryVerified after start');
    recoveryVerified = true;
  }

  const spine = {
    kernel, positionStore, marketStore, policyStore,
    oms: dynamicPriceOms, planStore, protection, adapter, service,
    privateConfig: { hardRisk: config.hardRisk },

    get recoveryVerified() { return recoveryVerified; },

    async start(options: { exchange: string }) {
      if (started) return;
      if (!recoveryVerified) throw new Error('SPINE_NOT_RECOVERY_VERIFIED: start requires RECOVERY_VERIFIED');
      started = true;
      protection.setMode('live');
    },
  };

  // Expose internal setter only to RecoveryManager via module-scope symbol
  (spine as any)[RECOVERY_SET_SYMBOL] = _setRecoveryVerified;

  return spine;
}

const RECOVERY_SET_SYMBOL = Symbol('recoverySet');

/** INTERNAL: exported for RecoveryManager only — sets RECOVERY_VERIFIED on a spine. */
export const INTERNAL_RECOVERY_SET_SYMBOL = RECOVERY_SET_SYMBOL;

/**
 * Execute a TradeIntent through PreTradeRiskGateway → OmsCore → PaperExecutionAdapter.
 * Uses the factual market price and real policy resolution.
 */
export async function executeThroughGateway(
  spine: ProductionSpine,
  intent: TradeIntent,
  action: 'open' | 'close',
  approvedUsd: number,
): Promise<ExecuteThroughGatewayResult> {
  // Block entries before RECOVERY_VERIFIED
  if (!spine.recoveryVerified) {
    // Allow only baseline and market events — not trading entries
    if (action === 'open' || action === 'close') {
      return { admitted: false, riskCode: 'RECOVERY_NOT_VERIFIED', action };
    }
  }

  const { kernel, positionStore, marketStore, oms, adapter, policyStore } = spine;
  const exchange = intent.exchange as any;
  const symbol = intent.symbol;

  const marketSnapshot = marketStore.getSnapshot(exchange, symbol);
  const positionResolved = positionStore.resolve(exchange, symbol);
  const hardRiskSnapshot = spine.privateConfig.hardRisk();

  // Resolve position — preserve factual semantics
  const rawStatus = positionResolved?.status;
  const isOpen = rawStatus === 'open';
  const effectiveStatus: 'open' | 'flat' | 'missing' = isOpen ? 'open'
    : rawStatus === 'missing' ? 'missing'
    : 'flat';
  const pos = isOpen
    ? { ...positionResolved, status: 'open' as const }
    : { snapshot: null, status: effectiveStatus, side: 'flat' as const, signedQuantity: 0, averageEntryPrice: 0 };

  // Real policy resolution from KernelPolicyStore — no fabricated allow-all
  const gatewayInput: GatewayInput = {
    intent,
    action,
    marketSnapshot: marketSnapshot as any,
    positionResolution: pos as any,
    policyResolution: policyStore.resolve(exchange, symbol) as any,
    hardRisk: hardRiskSnapshot as any,
  };

  const riskResult = evaluatePreTradeRisk(gatewayInput);
  if (riskResult.decision !== 'ADMITTED') {
    return { admitted: false, riskCode: riskResult.reasonCode, action };
  }

  const authorisedUsd = riskResult.approvedPositionUsd;

  // Set factual market price before execution
  if (marketSnapshot?.ticker) {
    (adapter as any).params.markPriceUsd = (marketSnapshot as any).ticker?.ticker?.last ?? (marketSnapshot as any).ticker?.last ?? 0;
    (adapter as any).params.executedAtMs = Date.now();
  }

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
 */
export function trustBaseline(
  spine: ProductionSpine,
  exchange: string,
  symbol: string,
): void {
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
