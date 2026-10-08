// Phase 4C + 5A: ProductionSpine — unified kernel-backed paper execution spine
//   Phase 5A adds: durable journal, KernelPolicyStore, recovery verification, start() gate
//
// One shared TradingKernel powers:
//   market.ticker.updated → KernelMarketStateStore
//   policy.snapshot.published → KernelPolicyStore
//   PreTradeRiskGateway → OmsCore → PaperExecutionAdapter → factual fill
//   execution.fill.confirmed → KernelPositionStateStore → PositionManagerRuntime

import { createTradingKernel, type TradingKernel } from '../kernel/TradingKernel';
import { createKernelPositionStateStore, applyFillToState, type KernelPositionStateStore } from '../kernel/KernelPositionStateStore';
import { createKernelMarketStateStore, type KernelMarketStateStore } from '../kernel/KernelMarketStateStore';
import { createKernelPolicyStore, type KernelPolicyStore } from '../kernel/KernelPolicyStore';
import { createProductionPositionReadView, createProductionPolicyReadView,
  createProductionMarketReadView, createProductionPlanReadView, createProductionProtectionView,
  type ProductionPositionReadView, type ProductionPolicyReadView,
  type ProductionMarketReadView, type ProductionPlanReadView, type ProductionProtectionView } from './ProductionProjectorReadViews';
import type { PositionResolution } from '../types/position-state';
import { OmsCore } from '../oms/OmsCore';
import type { ExecutionAdapter, OmsOrderSnapshot } from '../oms/oms-types';
import type { ProjectorMap } from '../recovery/ReplayCoordinator';
import { PaperExecutionAdapter } from '../oms/PaperExecutionAdapter';
import { PaperExecutionService, type ExecuteParams } from '../paper/PaperExecutionService';
import type { PaperBrokerPersistence } from '../paper/PaperBroker';
import type { PaperAccountConfig, PaperFillLedgerEntry } from '../types/paper-account';
import type { PaperFill } from '../types/paper-fill';
import { createPositionManagerRuntime } from './PositionManagerRuntime';
import { PositionPlanStore } from './PositionPlanStore';
import { systemDomainClock } from '../runtime/Clock';
import { evaluateAccountBoundPreTradeRisk, evaluatePreTradeRisk } from '../risk/PreTradeRiskGateway';
import type {
  AccountBoundGatewayInput,
  AccountBoundHardRiskSnapshot,
  GatewayInput,
  TradeAction,
} from '../risk/pretrade-risk-types';
import type { AccountRiskAuthorizationContext } from '../risk/account-risk-authorization-context-types';
import { createGateIoAccountRiskRuntime, type GateIoAccountRiskRuntime } from '../risk/account-risk-runtime';
import {
  createPreTradeRiskDecisionReceipt,
  createPreTradeRiskDecisionReceiptStore,
} from '../risk/pretrade-decision-receipt';
import type {
  PreTradeRiskDecisionReceiptStore,
  PreTradeRiskDecisionReceiptStoreSnapshot,
} from '../risk/pretrade-decision-receipt-types';
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
  ExternalFill,
} from '../reconciliation/reconciliation-types';
import { createPaperExecutionTruthPort } from '../reconciliation/PaperExecutionTruthPort';
import { buildLocalReconciliationSnapshot } from '../reconciliation/local-snapshot';
import { computeRuntimeAccounting } from '../accounting/runtime-accounting';
import type { RuntimeAccountingSnapshot } from '../accounting/runtime-accounting-types';
import { computeTradeLifecycle } from '../accounting/trade-lifecycle';
import type { TradeLifecycle } from '../accounting/trade-lifecycle-types';
import { deriveTrustedExit, compareExitProduct, type TrustedExitProof } from '../risk/trusted-exit';
import { multiplyQuantity } from '../types/decimal-quantity';
import type { GatewayResult } from '../risk/pretrade-risk-types';
import { createRiskIncreaseAdmission, type RiskIncreaseAdmissionBinding } from '../risk/risk-increase-admission';
import type { PreTradeRiskDecisionRecordedPayload } from '../risk/pretrade-decision-receipt-types';
import type { PublishResult } from '../kernel/TradingKernel';
import { resolve } from 'node:path';
import { createProductionAuthorityPorts, type ProductionKernelReadView,
  type ProductionEvidencePublisher, type RiskMandateOperatorAuthority,
  type ProductionProtectionLifecycleAuthority } from './ProductionAuthorityPorts';

export interface ProductionSpineConfig {
  /** Trusted composition binds owner lifecycle; no public Spine-to-capability lookup. */
  bindProtectionLifecycle?: (authority: ProductionProtectionLifecycleAuthority) => void;
  /** Trusted composition only: bind factual ingress without mandate authority. Never returned on spine. */
  bindEvidencePublisher?: (publisher: ProductionEvidencePublisher) => void;
  /** Explicit operator control-plane capability injection. Absent by default; provenance alone cannot mint it. */
  bindOperatorAuthority?: (authority: RiskMandateOperatorAuthority) => void;
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
  /** Composition-owned current Gate execution valuation, never caller-provided sizing. */
  exitValuationPrice?: () => number;
  /** Halt authority is independent of account-capacity refresh, which the adapter invalidates. */
  mutationControl?: () => Pick<AccountBoundHardRiskSnapshot, 'exchange' | 'accountId' | 'locked' | 'mutationHalt'>;
  /** Every runtime composition must select exactly one risk-authority mode. */
  riskAuthorization:
    | { readonly mode: 'LEGACY_PAPER_OR_NON_GATE' }
    | { readonly mode: 'GATEIO_ACCOUNT_BOUND'; readonly settle: 'USDT' };
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
  kernel: ProductionKernelReadView;
  readonly positionStore: ProductionPositionReadView;
  readonly marketStore: ProductionMarketReadView;
  readonly policyStore: ProductionPolicyReadView;
  /** Read-only order evidence. Mutation is available only through executeThroughGateway(). */
  oms: ProductionOmsReadView;
  readonly planStore: ProductionPlanReadView;
  readonly protection: ProductionProtectionView;
  executionMode: 'paper' | 'limited-live';
  /** Present only for Paper compatibility; limited-live never fabricates Paper truth. */
  service: PaperExecutionService | null;
  privateConfig: {
    hardRisk: () => AccountBoundHardRiskSnapshot;
    accountId: string;
    clock: { now(): number };
  };
  readonly riskAuthorizationMode: 'LEGACY_PAPER_OR_NON_GATE' | 'GATEIO_ACCOUNT_BOUND';
  /** Pure current composition; null in the explicitly isolated legacy mode. */
  accountRiskAuthorizationContext(evaluationTime: number): AccountRiskAuthorizationContext | null;
  readonly pretradeDecisionReceipts: {
    snapshot(): PreTradeRiskDecisionReceiptStoreSnapshot;
    digest(): string;
  };
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

export interface ProductionOmsReadStore {
  get(orderId: string): OmsOrderSnapshot | undefined;
  getByIntent(intentId: string): OmsOrderSnapshot | undefined;
  list(): readonly OmsOrderSnapshot[];
  digest(): string;
}

export interface ProductionOmsReadView {
  getStore(): ProductionOmsReadStore;
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

/** Canonical durable lineage, not caller-overridable serialization. */
function sameCanonicalPosition(a: PositionResolution, b: PositionResolution): boolean {
  if (a.status !== b.status || a.side !== b.side || a.signedQuantity !== b.signedQuantity
      || a.averageEntryPrice !== b.averageEntryPrice) return false;
  const x = a.snapshot, y = b.snapshot;
  if (x === null || y === null) return x === y;
  return x.exchange === y.exchange && x.symbol === y.symbol && x.side === y.side
    && x.signedQuantity === y.signedQuantity && x.averageEntryPrice === y.averageEntryPrice
    && x.positionVersion === y.positionVersion && x.sourceKernelEventId === y.sourceKernelEventId;
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
  const gateExecution = executionMode === 'limited-live' && config.exchange === 'gateio';
  if (config.riskAuthorization === undefined) {
    throw new Error('RISK_AUTHORIZATION_MODE_REQUIRED');
  }
  const riskAuthorizationMode = config.riskAuthorization.mode;
  if (gateExecution && riskAuthorizationMode !== 'GATEIO_ACCOUNT_BOUND') {
    throw new Error('GATEIO_ACCOUNT_BOUND_RISK_MODE_REQUIRED');
  }
  if (riskAuthorizationMode === 'GATEIO_ACCOUNT_BOUND'
      && (!gateExecution || config.riskAuthorization.mode !== 'GATEIO_ACCOUNT_BOUND'
        || config.riskAuthorization.settle !== 'USDT')) {
    throw new Error('ACCOUNT_BOUND_RISK_MODE_INVALID');
  }
  let executionInFlight = false;
  let reconciliationInFlight = false;
  let exitDecisionInFlight = false;
  let runtimeStopped = false;
  let lastExecutionTruth: ExecutionTruthSnapshot | null = null;
  let exitPermit: { proof: TrustedExitProof; notional: number; receiptDigest: string } | null = null;
  let entryPermit: object | null = null;

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
  const guardedAdapter: ExecutionAdapter = gateExecution ? {
    async submit(order, prepared) {
      if (order.action === 'open') {
        const checkIncrease = () => {
          const control = config.mutationControl?.() ?? config.hardRisk();
          if (runtimeStopped || control.exchange !== exchange || control.accountId !== reconciliationIdentity.accountId
              || control.locked || control.mutationHalt !== undefined) throw new Error('RISK_INCREASE_HALTED');
        };
        try { checkIncrease(); } catch { return { status: 'rejected', reason: 'RISK_INCREASE_HALTED' }; }
        try { entryAdmission!.enterAdapter(entryPermit, order); }
        catch { return { status: 'rejected', reason: 'RISK_INCREASE_ADMISSION_INVALID' }; }
        return adapter.submit(order, value => {
          checkIncrease(); entryAdmission!.checkAdapter(entryPermit, order);
          prepared?.(value);
          checkIncrease(); entryAdmission!.checkAdapter(entryPermit, order);
        });
      }
      const permit = exitPermit;
      function check() {
        const position = positionStore.resolve(exchange, order.symbol);
        const risk = config.mutationControl?.() ?? config.hardRisk();
        if (!permit || permit.proof.orderId !== order.orderId
            || permit.proof.direction !== (order.side === 'buy' ? 'long' : 'short')
            || permit.notional !== order.approvedNotionalUsd || runtimeStopped
            || risk.exchange !== exchange || risk.accountId !== reconciliationIdentity.accountId
            || risk.mutationHalt === 'ALL_MUTATIONS'
            || (risk.mutationHalt !== undefined && risk.mutationHalt !== 'RISK_INCREASE')
            || position.status !== 'open' || position.snapshot?.positionVersion !== permit.proof.positionVersion
            || position.snapshot.sourceKernelEventId !== permit.proof.positionSourceKernelEventId
            || oms.getStore().list().some(o => o.orderId !== order.orderId
              && !['FILLED', 'CANCELLED', 'REJECTED'].includes(o.status))
            || !decisionReceipts.snapshot().records.some(r => r.receiptDigest === permit.receiptDigest))
          throw new Error('TRUSTED_EXIT_ADMISSION_INVALIDATED');
      }
      try { check(); } catch { return { status: 'rejected', reason: 'TRUSTED_EXIT_ADMISSION_INVALIDATED' }; }
      return adapter.submit(order, value => {
        check();
        if (!value.reduceOnly || !Number.isFinite(value.requestedQuantity) || value.requestedQuantity <= 0
            || compareExitProduct(value.requestedQuantity, 1, permit!.proof.exposureQuantityExact) > 0
            || compareExitProduct(value.requestedQuantity, permit!.proof.valuationPriceExact, permit!.notional) > 0)
          throw new Error('TRUSTED_EXIT_PREPARATION_EXCEEDS_PROOF');
        prepared?.(value);
        check(); // The durable preparation may notify subscribers; recheck before the adapter can POST.
      });
    },
  } : adapter;
  const oms = new OmsCore(kernel, guardedAdapter, undefined,
    (venue, symbol) => positionStore.resolve(venue, symbol));

  // ── Position state store ──
  const positionStore = createKernelPositionStateStore();
  kernel.subscribe('execution.fill.confirmed', (e) => { positionStore.apply(e); });
  kernel.subscribe('position.baseline.confirmed' as any, (e: any) => { positionStore.apply(e); });

  const planStore = new PositionPlanStore();
  for (const type of ['position.plan.created', 'position.plan.updated',
    'position.plan.closed', 'position.plan.archived'] as const) {
    kernel.subscribe(type, event => { planStore.apply(event); });
  }

  // ── Durable account-risk views and pretrade receipts ──
  const accountRiskRuntime: GateIoAccountRiskRuntime | null =
    riskAuthorizationMode === 'GATEIO_ACCOUNT_BOUND'
      ? createGateIoAccountRiskRuntime({ accountId: config.accountId!, kernel })
      : null;
  const legacyDecisionReceipts: PreTradeRiskDecisionReceiptStore | null =
    accountRiskRuntime === null ? createPreTradeRiskDecisionReceiptStore() : null;
  if (legacyDecisionReceipts !== null) {
    kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', (event) => {
      legacyDecisionReceipts.apply(event);
    });
  }
  const decisionReceipts = accountRiskRuntime?.decisionReceipts ?? legacyDecisionReceipts!;
  const entryRiskStateDigest = () => JSON.stringify({
    ...Object.fromEntries(Object.entries(accountRiskRuntime!.digests())
      .filter(([key]) => key !== 'pretradeDecisionReceipts')),
    policy: policyStore.digest(),
  });
  const entryAdmission = gateExecution ? createRiskIncreaseAdmission({
    journalPath: (kernel.journal() as FileEventJournal).filePath,
    accountId: reconciliationIdentity.accountId,
    receipts: decisionReceipts, now: () => clock.now(),
    context: evaluationTime => accountRiskRuntime!.compose(evaluationTime),
    riskStateDigest: entryRiskStateDigest,
    position: symbol => positionStore.resolve(exchange, symbol),
  }) : null;

  // ── Dynamic-price OMS ──
  const dynamicPriceOms = {
    ...oms,
    submitRequest: async (intent: TradeIntent, action: any, approvedUsd: number) => {
      if (executionMode === 'paper') {
        const snapshot = marketStore.getSnapshot(intent.exchange as any, intent.symbol);
        const paperAdapter = adapter as PaperExecutionAdapter;
        const price = snapshot?.ticker?.ticker?.last ?? (paperAdapter as any).params.markPriceUsd;
        const p = (paperAdapter as any).params;
        p.markPriceUsd = price;
        p.executedAtMs = Date.now();
      }
      if (!gateExecution) return oms.submitRequest(intent, action, approvedUsd);
      if (!recoveryVerified || runtimeStopped || (action === 'open' && protection.getMode() !== 'live')
          || (action !== 'open' && exitPermit === null) || executionInFlight || reconciliationInFlight
          || intent.exchange !== exchange || intent.symbol !== 'ETH/USDT'
          || (action === 'open' && !reconciliationVerified)) {
        return { status: 'conflict' as const, reason: 'GATEIO_EXECUTION_STATE_NOT_VERIFIED' };
      }
      if (action === 'open') {
        try { entryAdmission!.enterOms(entryPermit, intent, approvedUsd); }
        catch { return { status: 'conflict' as const, reason: 'RISK_INCREASE_ADMISSION_INVALID' }; }
      }
      executionInFlight = true;
      reconciliationVerified = false;
      try {
        // The same OMS applies each factual delta once; later attestation never replays that delta.
        return await oms.submitRequest(intent, action, approvedUsd);
      } finally {
        try { await runCurrentReconciliation(); }
        catch { reconciliationVerified = false; }
        executionInFlight = false;
      }
    },
    getStore: () => oms.getStore(),
    previewExecutionObservation: oms.previewExecutionObservation.bind(oms),
    applyExecutionObservation: oms.applyExecutionObservation.bind(oms),
  } as typeof oms;

  const mutableOmsStore = oms.getStore();
  const omsReadStore: ProductionOmsReadStore = Object.freeze({
    get: mutableOmsStore.get.bind(mutableOmsStore),
    getByIntent: mutableOmsStore.getByIntent.bind(mutableOmsStore),
    list: mutableOmsStore.list.bind(mutableOmsStore),
    digest: mutableOmsStore.digest.bind(mutableOmsStore),
  });
  const omsReadView: ProductionOmsReadView = Object.freeze({
    getStore: () => omsReadStore,
  });

  // ── Position protection with REAL OMS ──
  const protection = createPositionManagerRuntime({
    kernel,
    positionStore,
    planStore,
    planEventsAlreadySubscribed: true,
    oms: dynamicPriceOms,
    marketStore,
    hardRisk: config.hardRisk,
    stopPct: config.stopPct ?? 0.05,
    submitAuthoritativeExit: async (intent) => {
      // Protective quantity is canonical, but valuation must come from current execution facts.
      // The public label never establishes the exit effect or grants OMS access.
      const result = gateExecution ? await executeTrustedExit(intent, 'close', true)
        : await executeThroughGateway(spine, intent, 'close', intent.positionUsd);
      return result.omsResult ?? { status: 'conflict', reason: result.riskCode ?? 'EXIT_DENIED' };
    },
    exitObservationReady: gateExecution ? () => recoveryVerified && !runtimeStopped : undefined,
    onStop: () => { runtimeStopped = true; },
  });
  // Strip _setLive from public interface — captured for internal use only
  const _setLive = (protection as any)._setLive as () => void;
  delete (protection as any)._setLive;
  delete (protection as any).kernel;

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
    config.marketRuntime.onTickerIngested((ticker) => {
      if (ticker.exchange === exchange) freshMarketObserved = true;
    });
  }

  const authorityPorts = createProductionAuthorityPorts(kernel, reconciliationIdentity);
  const spine = {
    kernel: authorityPorts.read,
    positionStore: createProductionPositionReadView(positionStore),
    marketStore: createProductionMarketReadView(marketStore),
    policyStore: createProductionPolicyReadView(policyStore),
    oms: omsReadView,
    planStore: createProductionPlanReadView(planStore),
    protection: createProductionProtectionView(protection), executionMode, service,
    privateConfig: Object.freeze({
      hardRisk: config.hardRisk,
      accountId: reconciliationIdentity.accountId,
      clock,
    }),
    riskAuthorizationMode,
    accountRiskAuthorizationContext(evaluationTime: number) {
      return accountRiskRuntime?.compose(evaluationTime) ?? null;
    },
    pretradeDecisionReceipts: Object.freeze({
      snapshot: () => decisionReceipts.snapshot(),
      digest: () => decisionReceipts.digest(),
    }),

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
  productionSpineInternalsBySpine.set(spine, Object.freeze({
    marketStore,
    planStore,
    protection,
    positionStore,
    policyStore,
    adapter,
    truthPort,
    oms,
    executionOms: dynamicPriceOms,
    executeTrustedExit,
    kernel,
    evidencePublisher: authorityPorts.evidence,
    journal: kernel.journal(),
    verifyRecovery: async () => { if (!started) { recoveryVerified = true; started = true; } },
    reconcile: async () => {
      if (!recoveryVerified) throw new Error('RECONCILIATION_REQUIRES_RECOVERY');
      return runCurrentReconciliation();
    },
    activateLive: async () => activateLive(),
    checkEntry: async (intent: TradeIntent) => gateExecution ? checkEntry(intent) : null,
    entryRiskStateDigest,
    priorEntryJournalSequence: () => (kernel.journal() as FileEventJournal).lastSequence,
    submitRiskIncrease: async (binding: RiskIncreaseAdmissionBinding,
      publication: PublishResult<'PRETRADE_RISK_DECISION_RECORDED'>) => {
      if (!entryAdmission || entryPermit !== null) return { admitted: false,
        riskCode: 'RISK_INCREASE_ADMISSION_INVALID', action: 'open' as const };
      try {
        entryPermit = entryAdmission.issue(binding, publication);
      } catch {
        return { admitted: false, riskCode: 'RISK_INCREASE_ADMISSION_INVALID', action: 'open' as const };
      }
      try {
        const omsResult = await dynamicPriceOms.submitRequest(binding.intent, 'open', binding.approvedUsd);
        return { admitted: omsResult.reason !== 'RISK_INCREASE_ADMISSION_INVALID',
          riskCode: omsResult.reason === 'RISK_INCREASE_ADMISSION_INVALID' ? omsResult.reason : null,
          action: 'open' as const, omsResult };
      } finally {
        entryAdmission.close(entryPermit); entryPermit = null;
      }
    },
  }));
  if (accountRiskRuntime !== null) accountRiskRuntimeBySpine.set(spine, accountRiskRuntime);
  decisionReceiptStoreBySpine.set(spine, decisionReceipts);

  // Internal helper: run reconciliation against CURRENT facts. Revokes any stale
  // authority first; grants reconciliationVerified only on a genuine current MATCH.
  async function runCurrentReconciliation(): Promise<ReconciliationReport> {
    reconciliationVerified = false; // revoke stale authority before each attempt
    if (gateExecution && reconciliationInFlight) throw new Error('RECONCILIATION_IN_PROGRESS');
    reconciliationInFlight = true;
    try {
      const projected = buildLocalReconciliationSnapshot(
        oms.getStore(),
        positionStore,
        planStore,
        reconciliationIdentity,
      );
      let local = gateExecution ? Object.freeze({ ...projected,
        fills: Object.freeze(kernel.journal().readFromLogicalSequence(1)
          .filter((event) => event.type === 'execution.fill.confirmed')
          .map((event) => {
            const f = (event.payload as { fill: ExternalFill }).fill;
            return Object.freeze({ fillId: f.fillId, orderId: f.orderId, exchange: f.exchange,
              symbol: f.symbol, side: f.side, quantity: f.quantity, price: f.price, executedAt: f.executedAt });
          })),
      }) : projected;
      const external: ExecutionTruthSnapshot = await truthPort.acquireTruth();
      lastExecutionTruth = external;
      if (gateExecution && external.complete && external.executions?.length) {
        // Preview with the same OMS transition and position arithmetic. The existing pure
        // reconciliation engine must accept the proposed financial facts BEFORE any delta event.
        const plans = external.executions.map(execution => ({ execution,
          plan: oms.previewExecutionObservation(execution) }));
        const positions = local.positions.map(p => ({ ...p }));
        for (const { plan } of plans) if (plan.fill) {
          const f = plan.fill;
          const p = positions.find(p => p.exchange === f.exchange && p.symbol === f.symbol);
          if (!p || p.status === 'missing') throw new Error('RECOVERY_POSITION_BASELINE_MISSING');
          const next = applyFillToState({ side: p.side, signedQty: p.signedQuantity,
            avgPrice: p.averageEntryPrice }, f);
          Object.assign(p, { side: next.side, signedQuantity: next.signedQty,
            averageEntryPrice: next.avgPrice, status: next.side === 'flat' ? 'flat' : 'open' });
        }
        const candidate = { ...local, positions,
          orders: local.orders.map(order => {
            const found = plans.find(p => p.execution.orderId === order.orderId);
            return found ? { ...order, execution: found.execution, status: found.execution.status } : order;
          }),
          fills: [...(local.fills ?? []), ...plans.flatMap(p => p.plan.fill ? [p.plan.fill] : [])] };
        const preview = reconcile(candidate, external);
        if (preview.issues.some(issue => issue.outcome !== 'MISSING_PROTECTION')) {
          lastReconciliationReport = preview;
          return preview;
        }
        for (const { execution } of plans) oms.applyExecutionObservation(execution);
        await Promise.resolve(); // Existing protection subscribers may project the new factual position.
        local = { ...buildLocalReconciliationSnapshot(oms.getStore(), positionStore, planStore, reconciliationIdentity),
          fills: candidate.fills };
      }
      const report = reconcile(local, external);
      lastReconciliationReport = report;
      reconciliationVerified = report.reconciliationVerified;
      return report;
    } catch (error) {
      lastExecutionTruth = null;
      reconciliationVerified = false;
      lastReconciliationReport = null;
      throw error;
    } finally { reconciliationInFlight = false; }
  }

  function gateMarketFresh(): boolean {
    const market = marketStore.getSnapshot(exchange, 'ETH/USDT');
    const at = market?.ticker?.receivedAt;
    const now = clock.now();
    return freshMarketObserved && !!market && !market.isStale
      && market.ticker?.ticker.exchange === exchange
      && typeof at === 'number' && Number.isSafeInteger(now) && Number.isSafeInteger(at)
      && now >= at && now - at <= (config.marketStaleAfterMs ?? 30_000);
  }

  async function executeTrustedExit(originalIntent: TradeIntent, requestedAction: TradeAction,
    protective = false): Promise<ExecuteThroughGatewayResult> {
    originalIntent = Object.freeze({ ...originalIntent });
    const deny = (riskCode: string): ExecuteThroughGatewayResult => ({ admitted: false, riskCode, action: requestedAction });
    if (runtimeStopped) return deny('EXIT_RUNTIME_STOPPED');
    if (!recoveryVerified || !started) return deny('EXIT_RECOVERY_NOT_VERIFIED');
    if (exitDecisionInFlight || executionInFlight || reconciliationInFlight) return deny('EXIT_EXECUTION_BUSY');
    if (originalIntent.exchange !== exchange || originalIntent.symbol !== 'ETH/USDT') return deny('PROVENANCE_MISMATCH');
    exitDecisionInFlight = true;
    try {
      // Separate exit readiness: no requirement for economic context, mandate or general LIVE_READY.
      const report = await runCurrentReconciliation();
      const truth = lastExecutionTruth;
      const time = clock.now();
      if (!truth || !truth.complete || truth.identity.exchange !== exchange
          || truth.identity.accountId !== reconciliationIdentity.accountId || !truth.source
          || !Number.isSafeInteger(time) || !Number.isSafeInteger(truth.capturedAt)
          || truth.capturedAt > time || time - truth.capturedAt > (config.marketStaleAfterMs ?? 30_000)
          || report.issues.some(issue => issue.outcome !== 'MISSING_PROTECTION')) return deny('EXIT_TRUTH_NOT_VERIFIED');
      if (oms.getStore().list().some(o => !['FILLED', 'CANCELLED', 'REJECTED'].includes(o.status))
          || truth.orders.some(o => ['OPEN', 'PARTIALLY_FILLED'].includes(o.status))) return deny('EXIT_ORDER_UNRESOLVED');
      // Public projections are not authority. Rebuild the canonical position from durable events.
      const durable = createKernelPositionStateStore();
      for (const event of kernel.journal().readFromLogicalSequence(1))
        if (event.type === 'execution.fill.confirmed' || event.type === 'position.baseline.confirmed') durable.apply(event as any);
      const position = positionStore.resolve(exchange, originalIntent.symbol);
      const recovered = durable.resolve(exchange, originalIntent.symbol);
      const external = truth.positions.filter(p => p.exchange === exchange && p.symbol === originalIntent.symbol);
      if (!sameCanonicalPosition(position, recovered) || position.status !== 'open'
          || external.length !== 1 || external[0]!.side !== position.side
          || external[0]!.signedQuantity !== position.signedQuantity
          || external[0]!.averageEntryPrice !== position.averageEntryPrice) return deny('EXIT_POSITION_NOT_VERIFIED');
      const valuationPrice = config.exitValuationPrice?.()
        ?? (gateMarketFresh() ? marketStore.getSnapshot(exchange, originalIntent.symbol)?.ticker?.ticker.last : undefined);
      if (typeof valuationPrice !== 'number' || !Number.isFinite(valuationPrice) || valuationPrice <= 0)
        return deny('EXIT_VALUATION_UNAVAILABLE');
      const intent = protective ? Object.freeze({ ...originalIntent,
        direction: position.side === 'long' ? 'short' as const : 'long' as const,
        positionUsd: multiplyQuantity(Math.abs(position.signedQuantity), valuationPrice) }) : originalIntent;
      const derived = deriveTrustedExit({ intent, requestedAction, position,
        accountId: reconciliationIdentity.accountId, hardRisk: config.hardRisk(), valuationPrice,
        truthCapturedAt: truth.capturedAt, truthSource: truth.source });
      const receipt = createPreTradeRiskDecisionReceipt({ gatewayMode: 'GATEIO_TRUSTED_EXIT_ONLY',
        accountId: reconciliationIdentity.accountId, intent, action: derived.action,
        evaluationTime: time, result: derived.result, exitProof: derived.proof });
      try {
        if (kernel.publish('PRETRADE_RISK_DECISION_RECORDED', receipt).failures > 0)
          return deny('RISK_DECISION_RECEIPT_PERSIST_FAILED');
      } catch { return deny('RISK_DECISION_RECEIPT_PERSIST_FAILED'); }
      if (derived.result.decision !== 'ADMITTED' || derived.proof === null)
        return deny((derived.result as Extract<GatewayResult, { decision: 'REJECTED' }>).reasonCode);
      exitPermit = { proof: derived.proof, notional: derived.result.approvedPositionUsd,
        receiptDigest: receipt.receiptDigest };
      const omsResult = await dynamicPriceOms.submitRequest(intent, derived.action, derived.result.approvedPositionUsd);
      return { admitted: true, riskCode: null, action: derived.action, omsResult };
    } catch { return deny('EXIT_READINESS_UNAVAILABLE'); }
    finally { exitPermit = null; exitDecisionInFlight = false; }
  }

  async function checkEntry(intent: TradeIntent): Promise<string | null> {
      if (intent.exchange !== exchange || intent.symbol !== 'ETH/USDT') return 'GATEIO_VENUE_MISMATCH';
      if (runtimeStopped || exitDecisionInFlight || !recoveryVerified || !reconciliationVerified || executionInFlight || reconciliationInFlight)
        return 'RECONCILIATION_NOT_VERIFIED';
      if (!gateMarketFresh()) return 'MARKET_STALE';
      if (oms.getStore().list().some(o => o.preparation &&
          !['FILLED', 'CANCELLED', 'REJECTED'].includes(o.status))) return 'ORDER_EXECUTION_UNRESOLVED';
      try {
        if (!(await runCurrentReconciliation()).reconciliationVerified) return 'RECONCILIATION_NOT_VERIFIED';
      } catch { return 'RECONCILIATION_NOT_VERIFIED'; }
      return gateMarketFresh() ? null : 'MARKET_STALE';
  }

  // Internal: grant LIVE_READY. Requires recovery + a prior reconciliation + fresh
  // collector market, AND re-establishes that CURRENT facts still reconcile to MATCH.
  async function activateLive() {
    if (!recoveryVerified) throw new Error('LIVE_READY_REQUIRES_RECOVERY');
    if (!reconciliationVerified) throw new Error('LIVE_READY_REQUIRES_RECONCILIATION');
    if (!freshMarketObserved) throw new Error('LIVE_READY_REQUIRES_FRESH_MARKET');
    if (gateExecution && !gateMarketFresh()) throw new Error('LIVE_READY_REQUIRES_FRESH_MARKET');
    // P0: current facts must still MATCH at the point LIVE_READY is granted.
    let report: ReconciliationReport;
    try {
      report = await runCurrentReconciliation();
    } catch {
      throw new Error('LIVE_READY_REQUIRES_RECONCILIATION');
    }
    if (!report.reconciliationVerified) throw new Error('LIVE_READY_REQUIRES_RECONCILIATION');
    if (gateExecution && !gateMarketFresh()) throw new Error('LIVE_READY_REQUIRES_FRESH_MARKET');
    _setLive();
  }

  Object.freeze(protection);
  config.bindProtectionLifecycle?.(Object.freeze({
    start: () => protection.start(),
    stop: () => protection.stop(),
  }));
  config.bindEvidencePublisher?.(authorityPorts.evidence);
  config.bindOperatorAuthority?.(authorityPorts.operator);
  return Object.freeze(spine);
}

const accountRiskRuntimeBySpine = new WeakMap<object, GateIoAccountRiskRuntime>();
const decisionReceiptStoreBySpine = new WeakMap<object, PreTradeRiskDecisionReceiptStore>();
interface ProductionSpineInternals {
  readonly marketStore: KernelMarketStateStore;
  readonly planStore: PositionPlanStore;
  readonly protection: ReturnType<typeof createPositionManagerRuntime>;
  readonly positionStore: KernelPositionStateStore;
  readonly policyStore: KernelPolicyStore;
  readonly entryRiskStateDigest: () => string;
  readonly priorEntryJournalSequence: () => number;
  readonly submitRiskIncrease: (binding: RiskIncreaseAdmissionBinding,
    publication: PublishResult<'PRETRADE_RISK_DECISION_RECORDED'>) => Promise<ExecuteThroughGatewayResult>;
  readonly evidencePublisher: ProductionEvidencePublisher;
  readonly kernel: TradingKernel;
  readonly journal: EventJournalPort;
  readonly verifyRecovery: () => Promise<void>;
  readonly reconcile: () => Promise<ReconciliationReport>;
  readonly activateLive: () => Promise<void>;
  readonly checkEntry: (intent: TradeIntent) => Promise<string | null>;
  readonly adapter: ExecutionAdapter;
  readonly truthPort: ExecutionTruthPort;
  readonly oms: OmsCore;
  readonly executionOms: OmsCore;
  readonly executeTrustedExit: (intent: TradeIntent, action: TradeAction) => Promise<ExecuteThroughGatewayResult>;
}
const productionSpineInternalsBySpine = new WeakMap<object, ProductionSpineInternals>();

function requireProductionSpineInternals(spine: ProductionSpine): ProductionSpineInternals {
  const internals = productionSpineInternalsBySpine.get(spine);
  if (internals === undefined) throw new Error('PRODUCTION_SPINE_MUTATION_AUTHORITY_INVALID');
  return internals;
}

/** Composition-time identity check without exposing either mutable execution capability. */
export function productionSpineUsesExecutionBinding(
  spine: ProductionSpine,
  adapter: ExecutionAdapter,
  truthPort: ExecutionTruthPort,
): boolean {
  const internals = productionSpineInternalsBySpine.get(spine);
  return internals?.adapter === adapter && internals.truthPort === truthPort;
}

/** Identity predicate only; does not return any journal or publisher capability. */
export function productionSpineUsesJournal(spine: ProductionSpine, journal: EventJournalPort): boolean {
  return productionSpineInternalsBySpine.get(spine)?.journal === journal;
}

export function productionSpineUsesEvidencePublisher(spine: ProductionSpine, publisher: ProductionEvidencePublisher): boolean {
  return productionSpineInternalsBySpine.get(spine)?.evidencePublisher === publisher;
}

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

  const internals = requireProductionSpineInternals(spine);
  const bound = internals.journal as FileEventJournal;
  const requestedPath = typeof journalPath === 'string' ? journalPath : journalPath.filePath;
  if (typeof bound?.filePath !== 'string' || typeof requestedPath !== 'string'
      || resolve(requestedPath) !== resolve(bound.filePath))
    throw new Error('RECOVERY_JOURNAL_BINDING_MISMATCH');
  // Always reopen the composition-owned path: no caller-supplied empty/fake journal can grant recovery.
  const journal = createFileEventJournal(bound.filePath);
  const projectors = buildProjectorMap(spine);
  const currentStoreDigests = () => ({
    position: internals.positionStore.digest(),
    market: internals.marketStore.digest(),
    policy: internals.policyStore.digest(),
    oms: spine.oms.getStore().digest(),
    plan: internals.planStore.digest(),
    ...(accountRiskRuntimeBySpine.get(spine)?.digests() ?? {
        pretradeDecisionReceipts: spine.pretradeDecisionReceipts.digest(),
      }),
  });
  const result = recoverFromJournal(journal, projectors, checkpointPath, currentStoreDigests);

  if (result.recoveryVerified) {
    await internals.verifyRecovery();
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
  return requireProductionSpineInternals(spine).reconcile();
}

/**
 * Grant LIVE_READY after successful recovery, reconciliation, AND fresh market data availability.
 * Requires recoverAndStart + reconcileRecoveredState to have been called first.
 */
export async function activateLiveReadiness(spine: ProductionSpine): Promise<void> {
  await requireProductionSpineInternals(spine).activateLive();
}

function buildProjectorMap(spine: ProductionSpine): ProjectorMap {
  const m: ProjectorMap = new Map();
  const internals = requireProductionSpineInternals(spine);
  const omsStore = internals.oms.getStore();
  m.set('position.baseline.confirmed', [internals.positionStore]);
  m.set('execution.fill.confirmed', [internals.positionStore, omsStore]);
  m.set('market.ticker.updated', [internals.marketStore]);
  // Research remains journal evidence, not market/position truth. This existing projector
  // explicitly treats research as irrelevant, preserving its digest and all readiness gates.
  m.set('research.bias.updated', [internals.marketStore]);
  m.set('policy.snapshot.published', [internals.policyStore]);
  m.set('order.created', [omsStore]);
  m.set('order.submitted', [omsStore]);
  m.set('order.rejected', [omsStore]);
  m.set('order.submission.unknown', [omsStore]);
  m.set('order.execution.prepared', [omsStore]);
  m.set('order.execution.observed', [omsStore]);
  m.set('position.plan.created', [internals.planStore]);
  m.set('position.plan.updated', [internals.planStore]);
  m.set('position.plan.archived', [internals.planStore]);
  m.set('position.plan.closed', [internals.planStore]);
  const accountRiskRuntime = accountRiskRuntimeBySpine.get(spine);
  if (accountRiskRuntime !== undefined) {
    for (const [type, projectors] of accountRiskRuntime.projectorBindings()) {
      m.set(type as any, [...projectors]);
    }
  } else {
    m.set('PRETRADE_RISK_DECISION_RECORDED', [
      decisionReceiptStoreBySpine.get(spine)!,
    ]);
  }
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
  const internals = requireProductionSpineInternals(spine);
  if (spine.riskAuthorizationMode === 'GATEIO_ACCOUNT_BOUND' && action !== 'open')
    return internals.executeTrustedExit(intent, action);
  const receiptBoundEntry = spine.riskAuthorizationMode === 'GATEIO_ACCOUNT_BOUND' && action === 'open';
  if (receiptBoundEntry) intent = Object.freeze(structuredClone(intent));
  // Block entries before LIVE_READY (protection mode !== 'live')
  if (internals.protection.getMode() !== 'live') {
    if (action === 'open' || action === 'close') {
      return { admitted: false, riskCode: 'NOT_LIVE_READY', action };
    }
  }

  const { executionOms: oms } = requireProductionSpineInternals(spine);
  const { kernel } = internals;
  const { positionStore, policyStore, marketStore } = internals;
  if (action === 'open') {
    const reason = await internals.checkEntry(intent);
    if (reason) return { admitted: false, riskCode: reason, action };
  }
  const exchange = intent.exchange as any;
  const symbol = intent.symbol;

  const marketSnapshot = marketStore.getSnapshot(exchange, symbol);
  const positionResolved = positionStore.resolve(exchange, symbol);
  const sourceHardRisk = spine.privateConfig.hardRisk();
  const hardRiskSnapshot = sourceHardRisk.mutationHalt === undefined ? sourceHardRisk
    : { ...sourceHardRisk, locked: true };

  // Preserve the canonical snapshot. In particular, a trusted flat baseline has
  // a non-null versioned snapshot; missing state must never be fabricated as flat.
  const pos = positionResolved;

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

  const evaluationTime = spine.privateConfig.clock.now();
  const riskResult = spine.riskAuthorizationMode === 'GATEIO_ACCOUNT_BOUND'
      && action === 'open'
    ? evaluateAccountBoundPreTradeRisk({
        ...gatewayInput,
        mode: 'ACCOUNT_BOUND',
        action: 'open',
        hardRisk: hardRiskSnapshot,
        authorizationContext: spine.accountRiskAuthorizationContext(evaluationTime)!,
      } satisfies AccountBoundGatewayInput)
    : evaluatePreTradeRisk(gatewayInput);
  const riskStateDigest = receiptBoundEntry ? internals.entryRiskStateDigest() : '';
  const priorJournalSequence = receiptBoundEntry ? internals.priorEntryJournalSequence() : 0;
  let entryReceipt: PreTradeRiskDecisionRecordedPayload | undefined;
  let entryPublication: PublishResult<'PRETRADE_RISK_DECISION_RECORDED'> | undefined;

  // Persist the gateway fact before any OMS mutation. Subscriber failure is
  // fail-closed even though the journal append itself may already be durable.
  try {
    const receipt = createPreTradeRiskDecisionReceipt({
      gatewayMode: spine.riskAuthorizationMode === 'GATEIO_ACCOUNT_BOUND' && action !== 'open'
        ? 'GATEIO_EXISTING_EXIT_PATH' : spine.riskAuthorizationMode,
      accountId: spine.privateConfig.accountId,
      intent,
      action,
      evaluationTime,
      result: riskResult,
      ...(receiptBoundEntry ? { bindRiskIncreaseIntent: true } : {}),
    });
    const recorded = kernel.publish('PRETRADE_RISK_DECISION_RECORDED', receipt);
    if (recorded.failures > 0) {
      return { admitted: false, riskCode: 'RISK_DECISION_RECEIPT_PERSIST_FAILED', action };
    }
    if (receiptBoundEntry) { entryReceipt = receipt; entryPublication = recorded; }
  } catch {
    return { admitted: false, riskCode: 'RISK_DECISION_RECEIPT_PERSIST_FAILED', action };
  }
  if (riskResult.decision !== 'ADMITTED') {
    return { admitted: false, riskCode: riskResult.reasonCode, action };
  }

  const authorisedUsd = riskResult.approvedPositionUsd;
  if (receiptBoundEntry) return internals.submitRiskIncrease({
    intent, approvedUsd: authorisedUsd, expectedReceipt: entryReceipt!,
    priorJournalSequence, riskStateDigest,
  }, entryPublication!);

  const omsResult = await oms.submitRequest(intent, action, authorisedUsd);

  return {
    admitted: true,
    riskCode: null,
    action,
    omsResult,
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
  if (spine.executionMode !== 'paper') throw new Error('BASELINE_REQUIRES_COMPOSITION_EVIDENCE_CAPABILITY');
  requireProductionSpineInternals(spine).kernel.publish('position.baseline.confirmed' as any, {
    baseline: {
      exchange: exchange as any,
      symbol,
      side: 'flat',
      signedQuantity: 0,
      averageEntryPrice: 0,
    },
  });
}
