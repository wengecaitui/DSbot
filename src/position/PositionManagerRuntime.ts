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
import type { TradingEventType } from '../events/TradingEvent';

export type RuntimeMode = 'replay' | 'live';

export interface PositionManagerRuntimeConfig {
  readonly kernel: TradingKernel;
  readonly positionStore: KernelPositionStateStore;
  readonly planStore: PositionPlanStore;
  readonly marketStore?: any;
  readonly hardRisk: () => HardRiskSnapshot;
  readonly oms?: OmsCore;
  readonly stopConfig?: { stopPct: number };
}

export interface RuntimeState {
  mode: RuntimeMode;
  readonly submittedIntents: Set<string>;
}

export function createPositionManagerRuntime(config: PositionManagerRuntimeConfig) {
  const positionManager = new PositionManager({ stopPct: config.stopConfig?.stopPct ?? 0.05, enabled: true });
  const state: RuntimeState = { mode: 'replay', submittedIntents: new Set() };

  // ── Fail-closed: no OMS, no live protection ──────────────────────────────
  if (!config.oms) {
    return {
      setMode(m: RuntimeMode) { state.mode = m; },
      getMode(): RuntimeMode { return state.mode; },
      getSubmittedCount(): number { return state.submittedIntents.size; },
      start(): void {},
      stop(): void {},
      get positionManager() { return positionManager; },
      get planStore() { return config.planStore; },
    };
  }

  const oms = config.oms;

  // ── Event handlers ───────────────────────────────────────────────────────
  function onFillEvent(envelope: any): void {
    const { type, kernelLogicalSequence: seq } = envelope;
    if (type !== 'execution.fill.confirmed') return;
    const fill = envelope.payload.fill;
    if (!fill) return;

    const exchange = fill.exchange ?? 'bitget';
    const symbol = fill.symbol;
    const position = config.positionStore.resolve(exchange, symbol);
    if (!position || position.status === 'missing' || position.status === 'flat') {
      // Flat position → close active plan
      const activePlan = config.planStore.getActive(symbol);
      if (activePlan) {
        const planDelta = positionManager.onFill(position || { status: 'flat', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } as any, exchange, symbol, seq, activePlan);
        if (planDelta) config.kernel.publish('position.plan.closed', { planId: planDelta.planId });
      }
      return;
    }

    const activePlan = config.planStore.getActive(symbol);
    const planDelta = positionManager.onFill(position, exchange, symbol, seq, activePlan);

    if (!planDelta) return;

    if (planDelta.status === 'active' && planDelta.planId !== activePlan?.planId) {
      // New plan or flip → publish plan.created
      config.kernel.publish('position.plan.created', { plan: planDelta });
    } else if (planDelta.status === 'active' && planDelta.stopPrice !== activePlan?.stopPrice) {
      // Scale-in → publish plan.updated
      config.kernel.publish('position.plan.updated', { planId: planDelta.planId, stopPrice: planDelta.stopPrice });
    } else if (planDelta.status === 'closed') {
      // Full close → publish plan.closed
      config.kernel.publish('position.plan.closed', { planId: planDelta.planId });
    }
  }

  async function onMarketEvent(envelope: any): Promise<void> {
    if (state.mode !== 'live') return;
    const { type } = envelope;
    if (type !== 'market.ticker.updated') return;
    const ticker = envelope.payload?.ticker;
    if (!ticker) return;

    const symbol = ticker.symbol ?? ticker.instId;
    const exchange = ticker.exchange ?? 'bitget';
    const marketPrice = Number(ticker.last);
    if (!Number.isFinite(marketPrice) || marketPrice <= 0) return;

    const plan = config.planStore.getActive(symbol);
    if (!plan) return;

    const result = positionManager.evaluate(plan, marketPrice);
    if (result.decision !== 'close') return;

    const position = config.positionStore.resolve(exchange, symbol);
    if (!position || position.status !== 'open') return;

    // ── Idempotency: same plan incarnation → only one economic close ──────
    if (state.submittedIntents.has(plan.planId)) return;

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

    state.submittedIntents.add(plan.planId);
    await oms.submitRequest(route.intent, 'close', route.approvedSize);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  return {
    setMode(m: RuntimeMode) {
      state.mode = m;
    },
    getMode(): RuntimeMode {
      return state.mode;
    },
    getSubmittedCount(): number {
      return state.submittedIntents.size;
    },

    start(): void {
      config.kernel.subscribe('execution.fill.confirmed', onFillEvent);
      config.kernel.subscribe('market.ticker.updated', onMarketEvent);
    },

    stop(): void {
      state.mode = 'replay';
    },

    get positionManager() { return positionManager; },
    get planStore() { return config.planStore; },
  };
}
