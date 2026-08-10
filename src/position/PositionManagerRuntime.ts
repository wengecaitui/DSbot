// Phase 4B: PositionManagerRuntime — production fill+market orchestrator
import type { TradingKernel } from '../kernel/TradingKernel';
import type { KernelPositionStateStore } from '../kernel/KernelPositionStateStore';
import type { KernelMarketStateStore } from '../kernel/KernelMarketStateStore';
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
  readonly marketStore?: KernelMarketStateStore;
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
  kernel: TradingKernel;
}

export function createPositionManagerRuntime(config: PositionManagerRuntimeConfig): PositionManagerRuntime {
  const positionManager = new PositionManager({ stopPct: config.stopPct ?? 0.05, enabled: true });
  let mode: RuntimeMode = 'replay';
  const submittedIntents = new Set<string>();
  let started = false;

  // Fail-closed: no OMS -> no-op runtime
  if (!config.oms) {
    return {
      setMode(m) { mode = m; },
      getMode() { return mode; },
      start() {},
      stop() { mode = 'replay'; },
      getSubmittedCount() { return 0; },
      clearSubmitted() {},
      positionManager,
    };
  }

  const oms = config.oms;
  const planStore = config.planStore;
  const kernel = config.kernel;

  // Event handlers — deferred via queueMicrotask to guarantee
  // store projections finish before runtime observes state.
  // This removes dependency on subscriber registration order.

  function onFillEvent(envelope: any): void {
    queueMicrotask(() => {
      if (mode === 'replay') return;
      const { type, kernelLogicalSequence: seq } = envelope;
      if (type !== 'execution.fill.confirmed') return;
      const fill = envelope.payload?.fill;
      if (!fill) return;

      const exchange = fill.exchange as any;
      const symbol = fill.symbol;
      // Fail-closed: missing exchange provenance
      if (typeof exchange !== 'string' || !exchange) return;

      const position = config.positionStore.resolve(exchange as any, symbol);
      const activePlan = planStore.getActive(exchange as any, symbol);

      // Flat/missing -> close active plan
      if (!position || position.status === 'missing' || position.status === 'flat') {
        if (activePlan) {
          const planDelta = positionManager.onFill(
            position || { status: 'flat', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } as any,
            exchange, symbol, seq, activePlan,
          );
          if (planDelta) {
            try { kernel.publish('position.plan.closed', { planId: planDelta.planId }); } catch (_) {}
            submittedIntents.delete(activePlan.planId);
          }
        }
        return;
      }

      const planDelta = positionManager.onFill(position, exchange, symbol, seq, activePlan);
      if (!planDelta) return;

      // New plan or flip (different planId) → created + old plan closed
      if (planDelta.status === 'active' && planDelta.planId !== activePlan?.planId) {
        if (activePlan) {
          try { kernel.publish('position.plan.closed', { planId: activePlan.planId }); } catch (_) {}
        }
        try { kernel.publish('position.plan.created', { plan: planDelta }); } catch (_) {}
        submittedIntents.delete(activePlan?.planId ?? '');
      }
      // Same plan, stop changed -> updated
      else if (planDelta.status === 'active' && planDelta.stopPrice !== activePlan?.stopPrice) {
        try { kernel.publish('position.plan.updated', { planId: planDelta.planId, stopPrice: planDelta.stopPrice }); } catch (_) {}
      }
      // Closed -> terminate
      else if (planDelta.status === 'closed') {
        try { kernel.publish('position.plan.closed', { planId: planDelta.planId }); } catch (_) {}
        submittedIntents.delete(planDelta.planId);
      }
    });
  }

  function onMarketEvent(envelope: any): void {
    queueMicrotask(() => {
      if (mode !== 'live') return;
      const ticker = envelope.payload?.ticker;
      if (!ticker) return;

      const symbol = ticker.symbol ?? ticker.instId;
      const exchange = ticker.exchange as any;
      // Fail-closed: missing exchange provenance
      if (typeof exchange !== 'string' || !exchange) return;

      const marketPrice = Number(ticker.last);
      if (!Number.isFinite(marketPrice) || marketPrice <= 0) return;

      const plan = planStore.getActive(exchange as any, symbol);
      if (!plan) return;

      const result = positionManager.evaluate(plan, marketPrice);
      if (result.decision !== 'close') return;

      const position = config.positionStore.resolve(exchange as any, symbol);
      if (!position || position.status !== 'open') return;

      // Idempotency: one economic exit per plan incarnation
      if (submittedIntents.has(plan.planId)) return;

      const marketSnapshot = config.marketStore?.getSnapshot?.(exchange as any, symbol) as any;

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
        // submission_unknown: leave submitted state - NO retry
      }).catch(() => {
        // OMS error: clear intent to allow retry
        submittedIntents.delete(plan.planId);
      });
    });
  }

  return {
    setMode(m: RuntimeMode) { mode = m; },
    getMode(): RuntimeMode { return mode; },
    getSubmittedCount(): number { return submittedIntents.size; },
    clearSubmitted(planId: string) { submittedIntents.delete(planId); },

    start(): void {
      if (started) return;
      // PlanStore must subscribe before runtime so events project state
      planStore.subscribeToKernel(kernel as any);
      kernel.subscribe('execution.fill.confirmed', onFillEvent);
      kernel.subscribe('market.ticker.updated', onMarketEvent);
      started = true;
    },

    stop(): void {
      mode = 'replay';
    },

    positionManager,
    kernel,
  };
}

// Production integration: composable factory for TradingRuntime
export interface PositionProtectionConfig {
  kernel: TradingKernel;
  positionStore: KernelPositionStateStore;
  planStore: PositionPlanStore;
  marketStore?: KernelMarketStateStore;
  hardRisk: () => HardRiskSnapshot;
  oms?: OmsCore;
  stopPct?: number;
}

export function createPositionProtection(cfg: PositionProtectionConfig): PositionManagerRuntime {
  const rt = createPositionManagerRuntime({
    kernel: cfg.kernel,
    positionStore: cfg.positionStore,
    planStore: cfg.planStore,
    marketStore: cfg.marketStore,
    hardRisk: cfg.hardRisk,
    oms: cfg.oms,
    stopPct: cfg.stopPct,
  });
  rt.start();
  return rt;
}
