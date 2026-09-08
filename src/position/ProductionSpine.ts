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
import type { ExecutionAdapter } from '../oms/oms-types';
import type { ProjectorMap } from '../recovery/ReplayCoordinator';
import { PaperExecutionAdapter } from '../oms/PaperExecutionAdapter';
import { PaperExecutionService, type ExecuteParams } from '../paper/PaperExecutionService';
import type { PaperBrokerPersistence } from '../paper/PaperBroker';
import type { PaperAccountConfig, PaperFillLedgerEntry } from '../types/paper-account';
import type { PaperFill } from '../types/paper-fill';
import { createPositionManagerRuntime } from './PositionManagerRuntime';
import { PositionPlanStore } from './PositionPlanStore';
import { systemDomainClock } from '../runtime/Clock';
import { evaluatePreTradeRisk } from '../risk/PreTradeRiskGateway';
import type { AccountBoundHardRiskSnapshot, GatewayInput, TradeAction } from '../risk/pretrade-risk-types';
import type { TradeIntent } from '../types/trade-intent';
import type { EventJournalPort } from '../kernel/EventJournalPort';
import { createFileEventJournal, type FileEventJournal } from '../recovery/FileEventJournal';
import { bridgeMarketToKernel } from './MarketBridge';
import type { MarketDataRuntime } from '../runtime/market/MarketDataRuntime';
import { reconcile } from '../reconciliation/reconcile';
import type {
  ReconciliationReport,
  ExecutionTruthPort,
  ExecutionTruthSnapshot,
} from '../reconciliation/reconciliation-types';
import { createPaperExecutionTruthPort } from '../reconciliation/PaperExecutionTruthPort';
import { buildLocalReconciliationSnapshot } from '../reconciliation/local-snapshot';
import { computeRuntimeAccounting } from '../accounting/runtime-accounting';
import type { RuntimeAccountingSnapshot } from '../accounting/runtime-accounting-types';
import { computeTradeLifecycle } from '../accounting/trade-lifecycle';
import type { TradeLifecycle } from '../accounting/trade-lifecycle-types';

export interface ProductionSpineConfig {
  exchange: string;
  accountId?: string;
  paperAccount?: PaperAccountConfig;
  persistence?: PaperBrokerPersistence;
  hardRisk: () => AccountBoundHardRiskSnapshot;
  stopPct?: number;
  journal?: EventJournalPort;
  /** Path to durable journal file. Creates FileEventJournal if provided. */
  journalPath?: string;
  clock?: any;
  marketStaleAfterMs?: number;
  /** Policy max lifetime in ms. Required for policy.snapshot.published. Default: 3_600_000 (1 hour). */
  policyMaxLifetimeMs?: number;
  /**
   * Production market runtime ownership (MarketDataRuntime).
   * ONLY market data flowing through this runtime's collector → bus → bridge
   * can establish LIVE_READY freshness. No public helper injects tickers.
   */
  marketRuntime?: MarketDataRuntime;
  /** Omitted for backward-compatible Paper composition. */
  execution?:
    | { readonly mode: 'paper' }
    | {
        readonly mode: 'limited-live';
        readonly adapter: ExecutionAdapter;
        readonly truthPort: ExecutionTruthPort;
      };
}

export interface ProductionSpine {
  kernel: TradingKernel;
  positionStore: KernelPositionStateStore;
  marketStore: KernelMarketStateStore;
  policyStore: KernelPolicyStore;
  oms: OmsCore;
  planStore: PositionPlanStore;
  protection: ReturnType<typeof createPositionManagerRuntime>;
  executionMode: 'paper' | 'limited-live';
  adapter: ExecutionAdapter;
  /** Present only for Paper compatibility; limited-live never fabricates Paper truth. */
  service: PaperExecutionService | null;
  privateConfig: { hardRisk: () => AccountBoundHardRiskSnapshot };
  /** Set internally by RecoveryManager — read-only to callers */
  readonly recoveryVerified: boolean;
  /** Phase 5B: granted only by the real reconciliation sequence — read-only to callers */
  readonly reconciliationVerified: boolean;
  readonly lastReconciliationReport: ReconciliationReport | null;
  /** Phase 6A: derived read-only runtime accounting (no mutation, no persistence write). */
  accounting: { snapshot(): RuntimeAccountingSnapshot; lifecycle(): TradeLifecycle };
  /** Start production: must be called after recovery verification */
  start(options: { exchange: string }): Promise<void>;
}

export interface ExecuteThroughGatewayResult {
  admitted: boolean;
  riskCode: string | null;
  action: TradeAction;
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

  const executionMode = config.execution?.mode ?? 'paper';

  // ── Execution adapter + factual truth port ──
  const defaultExecuteParams: ExecuteParams = {
    markPriceUsd: 0,
    feeBps: 10,
    slippageBps: 0,
    executedAtMs: Date.now(),
  };
  let service: PaperExecutionService | null = null;
  let adapter: ExecutionAdapter;
  let truthPort: ExecutionTruthPort;
  let reconciliationIdentity: { accountId: string; exchange: any };
  if (executionMode === 'paper') {
    const paperConfig: PaperAccountConfig = config.paperAccount ?? {
      accountId: config.accountId ?? `${config.exchange}-paper`,
      exchange,
      initialCashUsd: 100000,
    } as PaperAccountConfig;
    const persistence = config.persistence ?? inMemoryPersistence();
    service = await PaperExecutionService.open(paperConfig, persistence);
    adapter = new PaperExecutionAdapter(service, defaultExecuteParams);
    truthPort = createPaperExecutionTruthPort({ service, now: () => clock.now() });
    const identity = service.getIdentity();
    reconciliationIdentity = { accountId: identity.accountId, exchange: identity.exchange };
  } else {
    if (!config.execution || config.execution.mode !== 'limited-live') {
      throw new Error('LIMITED_LIVE_EXECUTION_BINDING_INVALID');
    }
    if (!config.execution.adapter || typeof config.execution.adapter.submit !== 'function' ||
        !config.execution.truthPort || typeof config.execution.truthPort.acquireTruth !== 'function') {
      throw new Error('LIMITED_LIVE_EXECUTION_BINDING_INVALID');
    }
    if (typeof config.accountId !== 'string' || config.accountId.length === 0) {
      throw new Error('LIMITED_LIVE_ACCOUNT_ID_REQUIRED');
    }
    adapter = config.execution.adapter;
    truthPort = config.execution.truthPort;
    reconciliationIdentity = { accountId: config.accountId, exchange };
  }
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
      if (executionMode === 'paper') {
        const snapshot = marketStore.getSnapshot(intent.exchange as any, intent.symbol);
        const paperAdapter = adapter as PaperExecutionAdapter;
        const price = snapshot?.ticker?.ticker?.last ?? (paperAdapter as any).params.markPriceUsd;
        const p = (paperAdapter as any).params;
        p.markPriceUsd = price;
        p.executedAtMs = Date.now();
      }
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
    hardRisk: config.hardRisk,
    stopPct: config.stopPct ?? 0.05,
  });
  // Strip _setLive from public interface — captured for internal use only
  const _setLive = (protection as any)._setLive as () => void;
  delete (protection as any)._setLive;

  // ── Recovery state (internal) ──
  let recoveryVerified = false;
  let started = false;
  let freshMarketObserved = false;  // Set by production market bus events only
  let reconciliationVerified = false;  // Phase 5B: granted only by the real reconcile sequence
  let lastReconciliationReport: ReconciliationReport | null = null;

  // ── Production market ingestion (runtime ownership: MarketDataRuntime) ──
  // Market data still bridges to the kernel (positions/stores), but freshness
  // provenance comes ONLY from collector ingestion — never a direct bus write.
  if (config.marketRuntime) {
    bridgeMarketToKernel(config.marketRuntime.bus, kernel);
    config.marketRuntime.onTickerIngested(() => { freshMarketObserved = true; });
  }

  const spine = {
    kernel, positionStore, marketStore, policyStore,
    oms: dynamicPriceOms, planStore, protection, executionMode, adapter, service,
    privateConfig: { hardRisk: config.hardRisk },

    get recoveryVerified() { return recoveryVerified; },
    get reconciliationVerified() { return reconciliationVerified; },
    get lastReconciliationReport() { return lastReconciliationReport; },

    // Phase 6A: derived read-only runtime accounting. No mutation, no persistence write.
    accounting: {
      snapshot(): RuntimeAccountingSnapshot {
        if (!service) throw new Error('LIMITED_LIVE_ACCOUNTING_UNAVAILABLE_L0');
        const account = service.snapshot();
        const fills = service.entries()
          .filter((e) => e.type === 'fill')
          .map((e) => (e as { fill: PaperFill }).fill);
        const markets = marketStore.getAllSnapshots();
        return computeRuntimeAccounting({ account, fills, markets, capturedAt: clock.now(), source: 'production-spine' });
      },
      // Phase 6B: derived read-only trade lifecycle. No mutation, no persistence
      // write, no OMS/execution/market writes, no state mutation.
      lifecycle(): TradeLifecycle {
        if (!service) throw new Error('LIMITED_LIVE_LIFECYCLE_UNAVAILABLE_L0');
        const account = service.snapshot();
        const fills = service.entries().filter((e) => e.type === 'fill') as PaperFillLedgerEntry[];
        return computeTradeLifecycle({ account, fills });
      },
    },

    async start(options: { exchange: string }) {
      throw new Error('START_AUTHORITY: use recoverAndStart + activateLiveReadiness');
    },
  };

  // Internal helper: run reconciliation against CURRENT facts. Revokes any stale
  // authority first; grants reconciliationVerified only on a genuine current MATCH.
  async function runCurrentReconciliation(): Promise<ReconciliationReport> {
    reconciliationVerified = false; // revoke stale authority before each attempt
    const local = buildLocalReconciliationSnapshot(
      oms.getStore(),
      positionStore,
      planStore,
      reconciliationIdentity,
    );
    let external: ExecutionTruthSnapshot;
    try {
      external = await truthPort.acquireTruth();
    } catch (err) {
      reconciliationVerified = false; // fail closed on acquisition failure
      lastReconciliationReport = null;
      throw err;
    }
    const report = reconcile(local, external);
    lastReconciliationReport = report;
    reconciliationVerified = report.reconciliationVerified;
    return report;
  }

  (spine as any)[VERIFY_TOKEN] = async function() {
    if (started) return;
    recoveryVerified = true;
    started = true;
  };

  // Internal: run the real reconciliation sequence. Requires RECOVERY_VERIFIED.
  (spine as any)[RECONCILE_TOKEN] = async function(): Promise<ReconciliationReport> {
    if (!recoveryVerified) throw new Error('RECONCILIATION_REQUIRES_RECOVERY');
    return await runCurrentReconciliation();
  };

  // Internal: grant LIVE_READY. Requires recovery + a prior reconciliation + fresh
  // collector market, AND re-establishes that CURRENT facts still reconcile to MATCH.
  (spine as any)[LIVE_TOKEN] = async function() {
    if (!recoveryVerified) throw new Error('LIVE_READY_REQUIRES_RECOVERY');
    if (!reconciliationVerified) throw new Error('LIVE_READY_REQUIRES_RECONCILIATION');
    if (!freshMarketObserved) throw new Error('LIVE_READY_REQUIRES_FRESH_MARKET');
    // P0: current facts must still MATCH at the point LIVE_READY is granted.
    let report: ReconciliationReport;
    try {
      report = await runCurrentReconciliation();
    } catch {
      throw new Error('LIVE_READY_REQUIRES_RECONCILIATION');
    }
    if (!report.reconciliationVerified) throw new Error('LIVE_READY_REQUIRES_RECONCILIATION');
    _setLive();
  };

  return spine;
}

const VERIFY_TOKEN = Symbol('verifyToken');
const LIVE_TOKEN = Symbol('liveToken');
const RECONCILE_TOKEN = Symbol('reconcileToken');

/**
 * Full recovery: journal → replay → verify → RECOVERY_VERIFIED.
 * Does NOT grant LIVE_READY — call activateLiveReadiness() after market data is fresh.
 */
export async function recoverAndStart(
  spine: ProductionSpine,
  journalPath: string | FileEventJournal,
  checkpointPath?: string,
): Promise<import('../recovery/RecoveryManager').RecoveryResult & { readonly errors: readonly unknown[] }> {
  const { recoverFromJournal } = require('../recovery/RecoveryManager') as typeof import('../recovery/RecoveryManager');
  const { createFileEventJournal } = require('../recovery/FileEventJournal') as typeof import('../recovery/FileEventJournal');

  const journal = typeof journalPath === 'string' ? createFileEventJournal(journalPath) : journalPath;
  const projectors = buildProjectorMap(spine);
  const storeDigests = {
    position: spine.positionStore.digest(),
    market: spine.marketStore.digest(),
    policy: spine.policyStore.digest(),
    oms: spine.oms.getStore().digest(),
    plan: spine.planStore.digest(),
  };
  const result = recoverFromJournal(journal, projectors, checkpointPath, storeDigests);

  if (result.recoveryVerified) {
    const fn = (spine as any)[VERIFY_TOKEN];
    if (typeof fn === 'function') await fn();
  }

  return { ...result, errors: result.replayReport.errors };
}

/**
 * Phase 5B: run reconciliation after successful recovery.
 * Acquires the internally wired factual Paper execution truth, builds the local
 * recovered snapshot, and runs the real reconcile(). Grants RECONCILIATION_VERIFIED
 * only when the report is a genuine MATCH. The caller cannot inject a fake truth
 * snapshot, report, or a reconciliationVerified=true boolean.
 */
export async function reconcileRecoveredState(spine: ProductionSpine): Promise<ReconciliationReport> {
  const fn = (spine as any)[RECONCILE_TOKEN];
  if (typeof fn !== 'function') throw new Error('RECONCILIATION_AUTHORITY: no internal reconcile token');
  return await fn();
}

/**
 * Grant LIVE_READY after successful recovery, reconciliation, AND fresh market data availability.
 * Requires recoverAndStart + reconcileRecoveredState to have been called first.
 */
export async function activateLiveReadiness(spine: ProductionSpine): Promise<void> {
  const fn = (spine as any)[LIVE_TOKEN];
  if (typeof fn !== 'function') throw new Error('LIVE_AUTHORITY: no internal live token');
  await fn();
}

function buildProjectorMap(spine: ProductionSpine): ProjectorMap {
  const m: ProjectorMap = new Map();
  m.set('position.baseline.confirmed', [spine.positionStore]);
  m.set('execution.fill.confirmed', [spine.positionStore, spine.oms.getStore()]);
  m.set('market.ticker.updated', [spine.marketStore]);
  m.set('policy.snapshot.published', [spine.policyStore]);
  m.set('order.created', [spine.oms.getStore()]);
  m.set('order.submitted', [spine.oms.getStore()]);
  m.set('order.rejected', [spine.oms.getStore()]);
  m.set('order.submission.unknown', [spine.oms.getStore()]);
  m.set('position.plan.created', [spine.planStore]);
  m.set('position.plan.updated', [spine.planStore]);
  m.set('position.plan.archived', [spine.planStore]);
  m.set('position.plan.closed', [spine.planStore]);
  return m;
}

/**
 * Execute a TradeIntent through PreTradeRiskGateway → OmsCore → the configured adapter.
 * Uses the factual market price and real policy resolution.
 */
export async function executeThroughGateway(
  spine: ProductionSpine,
  intent: TradeIntent,
  action: TradeAction,
  approvedUsd: number,
): Promise<ExecuteThroughGatewayResult> {
  // Block entries before LIVE_READY (protection mode !== 'live')
  if (spine.protection.getMode() !== 'live') {
    if (action === 'open' || action === 'close') {
      return { admitted: false, riskCode: 'NOT_LIVE_READY', action };
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
    hardRisk: hardRiskSnapshot,
    ...(spine.executionMode === 'limited-live' ? {
      positionLimits: {
        maxConcurrentPositions: 1,
        openPositionCount: positionStore.listResolved().filter((item) => item.status === 'open').length,
        allowScale: false,
      },
    } : {}),
  };

  const riskResult = evaluatePreTradeRisk(gatewayInput);
  if (riskResult.decision !== 'ADMITTED') {
    return { admitted: false, riskCode: riskResult.reasonCode, action };
  }

  const authorisedUsd = riskResult.approvedPositionUsd;

  // Paper execution keeps its historical dynamic-price behavior.
  if (spine.executionMode === 'paper' && marketSnapshot?.ticker) {
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
