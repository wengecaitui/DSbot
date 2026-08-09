// Phase 4B: PositionManagerRuntime — production fill+market orchestrator
import type { TradingKernel } from '../kernel/TradingKernel';
import type { KernelPositionStateStore } from '../kernel/KernelPositionStateStore';
import { PositionManager } from './PositionManager';
import { PositionPlanStore } from './PositionPlanStore';
import { evaluateProtectiveRoute } from './ProtectiveExecutor';
import type { ProtectiveContext } from './ProtectiveExecutor';
import type { PositionPlan } from './position-plan-types';
import type { HardRiskSnapshot } from '../risk/pretrade-risk-types';
import type { OmsCore } from '../oms/OmsCore';

export type RuntimeMode = 'replay' | 'live';

export interface PositionManagerRuntimeConfig {
  readonly kernel: TradingKernel;
  readonly positionStore: KernelPositionStateStore;
  readonly planStore: PositionPlanStore;
  readonly marketStore?: any;
  readonly hardRisk: () => HardRiskSnapshot;
  readonly oms?: OmsCore;
  readonly stopPct?: number;
}

export interface PositionManagerRuntime {
  setMode(m: RuntimeMode): void;
  getMode(): RuntimeMode;
  start(): void;
  stop(): void;
  getSubmittedCount(): number;
  clearSubmitted(planId: string): void;
  positionManager: PositionManager;
}

export function createPositionManagerRuntime(config: PositionManagerRuntimeConfig): PositionManagerRuntime {
  const positionManager = new PositionManager({ stopPct: config.stopPct ?? 0.05, enabled: true });
  let mode: RuntimeMode = 'replay';
  const submittedIntents = new Set<string>();
  let started = false;

  // ── Fail-closed: no OMS → no-op runtime ──────────────────────────────────
  if (!config.oms) {
    return {
      setMode(m) { mode = m; },
      getMode() { return mode; },
      start() {},
      stop() {},
      getSubmittedCount() { return 0; },
      clearSubmitted() {},
      positionManager,
    };
  }

  const oms = config.oms;
  const planStore = config.planStore;
  const kernel = config.kernel;

  // ── Event handlers (synchronous — TradingKernel subscriber contract) ─────

  /** Fill handler: Factual PositionState updates FIRST (via store subscription),
   *  then PositionManager observes post-fill state. Ordering invariant:
   *  positionStore subscriber fires BEFORE runtime subscriber via
   *  subscription ordering — caller ensures this. */
  function onFillEvent(envelope: any): void {
    if (mode === 'replay') return;
    const { type, kernelLogicalSequence: seq } = envelope;
    if (type !== 'execution.fill.confirmed') return;
    const fill = envelope.payload?.fill;
    if (!fill) return;

    const exchange = fill.exchange ?? 'bitget';
    const symbol = fill.symbol;
    const position = config.positionStore.resolve(exchange, symbol);
    const activePlan = planStore.getActive(exchange, symbol);

    // Flat/missing → close active plan
    if (!position || position.status === 'missing' || position.status === 'flat') {
      if (activePlan) {
        const planDelta = positionManager.onFill(position || { status: 'flat', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } as any, exchange, symbol, seq, activePlan);
        if (planDelta) {
          try { kernel.publish('position.plan.closed', { planId: planDelta.planId }); } catch (_) {}
          submittedIntents.delete(activePlan.planId);
        }
      }
      return;
    }

    const planDelta = positionManager.onFill(position, exchange, symbol, seq, activePlan);
    if (!planDelta) return;

    // New plan or flip (different planId) → created
    if (planDelta.status === 'active' && planDelta.planId !== activePlan?.planId) {
      try { kernel.publish('position.plan.created', { plan: planDelta }); } catch (_) {}
      submittedIntents.delete(activePlan?.planId ?? '');
    }
    // Same plan, stop changed → updated
    else if (planDelta.status === 'active' && planDelta.stopPrice !== activePlan?.stopPrice) {
      try { kernel.publish('position.plan.updated', { planId: planDelta.planId, stopPrice: planDelta.stopPrice }); } catch (_) {}
    }
    // Closed → terminate
    else if (planDelta.status === 'closed') {
      try { kernel.publish('position.plan.closed', { planId: planDelta.planId }); } catch (_) {}
      submittedIntents.delete(planDelta.planId);
    }
  }

  /** Market handler: fires synchronously per kernel subscriber contract.
   *  Submits OMS order synchronously (no await) to respect contract. */
  function onMarketEvent(envelope: any): void {
    if (mode !== 'live') return;
    const ticker = envelope.payload?.ticker;
    if (!ticker) return;

    const symbol = ticker.symbol ?? ticker.instId;
    const exchange = ticker.exchange ?? 'bitget';
    const marketPrice = Number(ticker.last);
    if (!Number.isFinite(marketPrice) || marketPrice <= 0) return;

    const plan = planStore.getActive(exchange, symbol);
    if (!plan) return;

    const result = positionManager.evaluate(plan, marketPrice);
    if (result.decision !== 'close') return;

    const position = config.positionStore.resolve(exchange, symbol);
    if (!position || position.status !== 'open') return;

    // Idempotency: one economic exit per plan incarnation
    if (submittedIntents.has(plan.planId)) return;

    const marketSnapshot = config.marketStore?.get?.(exchange, symbol) as any;

    const ctx: ProtectiveContext = {
      plan,
      currentPosition: position,
      exchange,
      marketPrice,
      marketSnapshot,
      hardRisk: config.hardRisk(),
    };

    const route = evaluateProtectiveRoute(ctx);
    if (!route.admitted) return;

    // Synchronously submit via fire-and-forget OMS call
    submittedIntents.add(plan.planId);
    oms.submitRequest(route.intent, 'close', route.approvedSize).then((omsResult: any) => {
      if (omsResult?.status === 'rejected' || omsResult?.status === 'conflict') {
        // Allow future protection retries
        submittedIntents.delete(plan.planId);
      }
      // submission_unknown: leave submitted state — NO retry
    }).catch(() => {
      // OMS error: clear intent to allow retry
      submittedIntents.delete(plan.planId);
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────
  return {
    setMode(m: RuntimeMode) { mode = m; },
    getMode(): RuntimeMode { return mode; },
    getSubmittedCount(): number { return submittedIntents.size; },
    clearSubmitted(planId: string) { submittedIntents.delete(planId); },

    start(): void {
      if (started) return;
      kernel.subscribe('execution.fill.confirmed', onFillEvent);
      kernel.subscribe('market.ticker.updated', onMarketEvent);
      started = true;
    },

    stop(): void {
      mode = 'replay';
    },

    positionManager,
  };
}
