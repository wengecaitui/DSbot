/** G3 TestNet verification orchestration. It owns no order, risk or position authority. */
import type { MarketSnapshot } from '../../data/MarketSnapshot';
import { GateIoFuturesExecutionAdapter, normalizeGateIoEthContracts } from '../../exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import type { EventJournalPort } from '../../kernel/EventJournalPort';
import { createKernelPositionStateStore } from '../../kernel/KernelPositionStateStore';
import { createTradingKernel } from '../../kernel/TradingKernel';
import { OmsCore } from '../../oms/OmsCore';
import { PositionPlanStore } from '../../position/PositionPlanStore';
import { createGateIoExecutionTruthPort, type GateIoExecutionTruthPort } from '../../reconciliation/GateIoExecutionTruthPort';
import { buildLocalReconciliationSnapshot } from '../../reconciliation/local-snapshot';
import { reconcile } from '../../reconciliation/reconcile';
import type { ExecutionTruthSnapshot } from '../../reconciliation/reconciliation-types';
import { evaluatePreTradeRisk } from '../../risk/PreTradeRiskGateway';
import type { AccountBoundHardRiskSnapshot, TradeAction } from '../../risk/pretrade-risk-types';
import type { PolicyResolution } from '../../types/policy-snapshot';
import { createTradeIntent } from '../../types/trade-intent';
import { createGateIoAuthenticatedReadFoundation } from './GateIoAuthenticatedReadFoundation';
import { createGateIoFuturesExecutionClient, type GateIoFuturesExecutionFetch } from './GateIoFuturesExecutionClient';
import { type GateIoReadCredential } from './GateIoReadContracts';
import { createGateIoTestnetReadTransport, type GateIoReadFetch } from './GateIoReadTransport';
import { GATEIO_G3_LIMITS, GateIoG3RunBudget } from './GateIoG3RunBudget';
import { establishVerifiedExternalFlatBaseline } from './establishVerifiedExternalFlatBaseline';

export interface GateIoG3RunnerOptions {
  readonly environment: 'testnet';
  readonly accountId: string;
  readonly credential: GateIoReadCredential;
  readonly readFetch: GateIoReadFetch;
  readonly executionFetch: GateIoFuturesExecutionFetch;
  readonly signedTimestamp: () => string;
  readonly now: () => number;
  readonly journal: EventJournalPort;
  /** Mainline factual collector and policy projections; no synthesized market/policy facts. */
  readonly marketSnapshot: () => MarketSnapshot;
  readonly policyResolution: () => PolicyResolution;
  readonly hardRisk: () => AccountBoundHardRiskSnapshot;
}

export interface GateIoG3RunReceipt {
  readonly status: 'PASS' | 'STOP';
  readonly reasonCode: string;
  readonly openOmsStatus: string | null;
  readonly closeOmsStatus: string | null;
  readonly cleanupOmsStatus: string | null;
  readonly lastCaptureSequence: number;
  readonly budget: ReturnType<GateIoG3RunBudget['snapshot']>;
  readonly testnetOnly: true;
  readonly liveReady: false;
}

export interface GateIoG3Runner {
  readonly sharedBudget: GateIoG3RunBudget;
  readonly truthPort: GateIoExecutionTruthPort;
  run(): Promise<GateIoG3RunReceipt>;
}

export function createGateIoTestnetOmsE2ERunner(options: GateIoG3RunnerOptions): GateIoG3Runner {
  if (!options || options.environment !== 'testnet' || !options.credential
      || typeof options.readFetch !== 'function' || typeof options.executionFetch !== 'function'
      || typeof options.signedTimestamp !== 'function' || typeof options.now !== 'function'
      || !options.journal || typeof options.journal.append !== 'function'
      || typeof options.marketSnapshot !== 'function' || typeof options.policyResolution !== 'function'
      || typeof options.hardRisk !== 'function' || !options.accountId) {
    throw new Error('GATEIO_G3_RUNNER_CONFIGURATION_INVALID');
  }
  const budget = GateIoG3RunBudget.create(GATEIO_G3_LIMITS);
  const transport = createGateIoTestnetReadTransport(options.readFetch, budget);
  const foundation = createGateIoAuthenticatedReadFoundation({
    transport, runBudget: budget, credential: options.credential, now: options.now,
    identity: { exchange: 'gateio', accountId: options.accountId, settle: 'USDT' },
  });
  let truthPort: GateIoExecutionTruthPort;
  const client = createGateIoFuturesExecutionClient({
    environment: 'testnet', credential: options.credential,
    signedTimestamp: options.signedTimestamp, fetchImpl: options.executionFetch,
    readFoundation: { async instrumentFacts() {
      const facts = truthPort.currentInstrument();
      return facts === null
        ? { availability: 'UNKNOWN' as const, value: null,
          reason: 'INSTRUMENT_FACTS_UNKNOWN' as const, failureProvenance: null }
        : { availability: 'AVAILABLE' as const, value: facts,
          reason: null, failureProvenance: null };
    } }, runBudget: budget,
  });
  const kernel = createTradingKernel({ exchange: 'gateio', journal: options.journal,
    clock: { now: options.now } });
  const positionStore = createKernelPositionStateStore();
  kernel.subscribe('position.baseline.confirmed', (event) => { positionStore.apply(event); });
  kernel.subscribe('execution.fill.confirmed', (event) => { positionStore.apply(event); });
  const oms = new OmsCore(kernel, new GateIoFuturesExecutionAdapter(client));
  const planStore = new PositionPlanStore();
  truthPort = createGateIoExecutionTruthPort({
    environment: 'testnet', transport, runBudget: budget, foundation,
    accountId: options.accountId, now: options.now,
    listOmsOrders: () => oms.getStore().list(),
  });
  let started = false;
  let openOmsStatus: string | null = null;
  let closeOmsStatus: string | null = null;
  let cleanupOmsStatus: string | null = null;
  const receipt = (status: 'PASS' | 'STOP', reasonCode: string): GateIoG3RunReceipt => Object.freeze({
    status, reasonCode, openOmsStatus, closeOmsStatus, cleanupOmsStatus,
    lastCaptureSequence: truthPort.captureSequence(), budget: budget.snapshot(),
    testnetOnly: true as const, liveReady: false as const,
  });

  async function capture(): Promise<{ truth: ExecutionTruthSnapshot; facts: NonNullable<ReturnType<GateIoExecutionTruthPort['canonicalForCapture']>> } | null> {
    const before = truthPort.captureSequence();
    const truth = await truthPort.acquireTruth();
    const facts = truthPort.canonicalForCapture(truthPort.captureSequence());
    const age = options.now() - truth.capturedAt;
    return truthPort.captureSequence() === before + 1 && truth.complete && facts !== null
      && Number.isSafeInteger(age) && age >= 0 && age <= 30_000
      ? { truth, facts } : null;
  }

  async function submit(action: TradeAction, direction: 'long' | 'short', positionUsd: number,
    expectedContracts: number): Promise<Awaited<ReturnType<OmsCore['submitRequest']>> | 'RISK_REJECTED'> {
    const marketSnapshot = options.marketSnapshot();
    const policyResolution = options.policyResolution();
    const hardRisk = options.hardRisk();
    if (hardRisk.accountId !== options.accountId || hardRisk.exchange !== 'gateio'
        || marketSnapshot?.exchange !== 'gateio' || marketSnapshot.symbol !== 'ETH/USDT'
        || marketSnapshot.isStale || !marketSnapshot.ticker) return 'RISK_REJECTED';
    const intent = createTradeIntent({ exchange: 'gateio', symbol: 'ETH/USDT', direction,
      positionUsd, source: 'gateio-g3-testnet', reason: `g3-${action}`,
      biasUpdatedAt: options.now(), createdAt: options.now() });
    const risk = evaluatePreTradeRisk({ intent, action, marketSnapshot, policyResolution,
      positionResolution: positionStore.resolve('gateio', 'ETH/USDT'), hardRisk,
      positionLimits: { maxConcurrentPositions: 1,
        openPositionCount: positionStore.resolve('gateio', 'ETH/USDT').status === 'open' ? 1 : 0,
        allowScale: false } });
    if (risk.decision !== 'ADMITTED') return 'RISK_REJECTED';
    const facts = truthPort.currentInstrument();
    if (!facts) return 'RISK_REJECTED';
    const contracts = normalizeGateIoEthContracts(
      risk.approvedPositionUsd / (facts.markPrice * facts.contractMultiplier), facts, action,
    );
    if (contracts === null || Math.abs(contracts - expectedContracts) > 1e-10)
      return 'RISK_REJECTED';
    return oms.submitRequest(intent, action, risk.approvedPositionUsd);
  }

  function factualFillsMatchKernel(truth: ExecutionTruthSnapshot): boolean {
    const confirmed = kernel.journal().readFromLogicalSequence(1)
      .filter((event) => event.type === 'execution.fill.confirmed');
    for (const event of confirmed) {
      const local = (event.payload as { fill?: Record<string, unknown> }).fill;
      if (!local || local.exchange !== 'gateio' || local.symbol !== 'ETH/USDT'
          || typeof local.fillId !== 'string' || typeof local.orderId !== 'string'
          || typeof local.quantity !== 'number' || typeof local.price !== 'number') return false;
      const exchange = truth.fills.find((fill) => fill.fillId === local.fillId
        && fill.orderId === local.orderId && fill.side === local.side);
      if (!exchange || Math.abs(exchange.quantity - local.quantity) > 1e-10
          || Math.abs(exchange.price - local.price) > 1e-8) return false;
    }
    return confirmed.length === truth.fills.length;
  }

  function factualOpen(captureValue: NonNullable<Awaited<ReturnType<typeof capture>>>): boolean {
    const local = positionStore.resolve('gateio', 'ETH/USDT');
    return captureValue.facts.account.accountState === 'OPEN'
      && factualFillsMatchKernel(captureValue.truth)
      && captureValue.truth.positions.length === 1
      && captureValue.truth.orders.length === 0
      && captureValue.truth.positions[0]!.side === 'long'
      && local.status === 'open' && local.side === 'long'
      && Math.abs(captureValue.truth.positions[0]!.signedQuantity - local.signedQuantity) < 1e-10;
  }

  function factualFlat(captureValue: NonNullable<Awaited<ReturnType<typeof capture>>>): boolean {
    const local = buildLocalReconciliationSnapshot(oms.getStore(), positionStore, planStore,
      { exchange: 'gateio', accountId: options.accountId });
    return reconcile(local, captureValue.truth).outcome === 'MATCH'
      && factualFillsMatchKernel(captureValue.truth)
      && captureValue.facts.account.accountState === 'FLAT'
      && captureValue.truth.positions.length === 0 && captureValue.truth.orders.length === 0
      && positionStore.resolve('gateio', 'ETH/USDT').status === 'flat';
  }

  return Object.freeze({
    sharedBudget: budget,
    truthPort,
    async run(): Promise<GateIoG3RunReceipt> {
      if (started) return receipt('STOP', 'G3_RUN_ALREADY_STARTED');
      started = true;
      try {
        const initial = await capture(); // 5 account GET + 3 instrument GET
        if (!initial || initial.facts.account.account.inDualMode !== false
            || initial.facts.account.accountState !== 'FLAT'
            || initial.truth.positions.length !== 0 || initial.truth.orders.length !== 0
            || !initial.facts.instrument.contractOpenable) return receipt('STOP', 'INITIAL_TRUTH_NOT_SAFE');
        establishVerifiedExternalFlatBaseline({ truthPort, truth: initial.truth,
          kernel, positionStore, accountId: options.accountId,
          symbol: 'ETH/USDT', now: options.now });
        const minNotional = initial.facts.instrument.minOrderSize
          * initial.facts.instrument.contractMultiplier * initial.facts.instrument.markPrice;
        if (!Number.isFinite(minNotional) || minNotional <= 0) return receipt('STOP', 'MIN_NOTIONAL_UNPROVABLE');
        const open = await submit('open', 'long', minNotional,
          initial.facts.instrument.minOrderSize);
        openOmsStatus = open === 'RISK_REJECTED' ? open : open.status;
        if (open === 'RISK_REJECTED') return receipt('STOP', 'OPEN_RISK_REJECTED');
        const postOpen = await capture(); // fresh after mutation even when submission unknown
        if (!postOpen) return receipt('STOP', 'POST_OPEN_TRUTH_UNKNOWN');
        if (open.status !== 'filled' || !factualOpen(postOpen))
          return receipt('STOP', 'OPEN_NOT_FACTUALLY_CONFIRMED');
        const preClose = await capture(); // fresh position/order/trade facts
        if (!preClose || !factualOpen(preClose)) return receipt('STOP', 'PRE_CLOSE_TRUTH_UNKNOWN');
        const freshInstrument = await truthPort.refreshInstrumentFacts();
        if (!freshInstrument) return receipt('STOP', 'PRE_CLOSE_INSTRUMENT_UNKNOWN');
        if (options.now() - preClose.truth.capturedAt > 30_000)
          return receipt('STOP', 'PRE_CLOSE_TRUTH_STALE');
        const local = positionStore.resolve('gateio', 'ETH/USDT');
        const closeUsd = Math.abs(local.signedQuantity) * freshInstrument.markPrice;
        const close = await submit('close', 'short', closeUsd,
          Math.abs(preClose.truth.positions[0]!.signedQuantity)
          / freshInstrument.contractMultiplier);
        closeOmsStatus = close === 'RISK_REJECTED' ? close : close.status;
        if (close === 'RISK_REJECTED') return receipt('STOP', 'CLOSE_RISK_REJECTED');
        const postClose = await capture();
        if (!postClose) return receipt('STOP', 'POST_CLOSE_TRUTH_UNKNOWN');
        if (close.status === 'filled' && factualFlat(postClose)) return receipt('PASS', 'G3_FACTUAL_FLAT');
        const exposure = postClose.truth.positions[0];
        const current = positionStore.resolve('gateio', 'ETH/USDT');
        if (postClose.truth.positions.length !== 1 || exposure?.side !== 'long'
            || current.status !== 'open' || current.side !== 'long'
            || Math.abs(exposure.signedQuantity - current.signedQuantity) >= 1e-10) {
          return receipt('STOP', 'CLOSE_UNKNOWN_OR_EXPOSURE_MISMATCH');
        }
        const cleanup = await submit('emergency_exit', 'short',
          Math.abs(exposure.signedQuantity) * freshInstrument.markPrice,
          Math.abs(exposure.signedQuantity) / freshInstrument.contractMultiplier);
        cleanupOmsStatus = cleanup === 'RISK_REJECTED' ? cleanup : cleanup.status;
        if (cleanup === 'RISK_REJECTED') return receipt('STOP', 'CLEANUP_RISK_REJECTED');
        const postCleanup = await capture(); // fifth and last account acquisition
        return cleanup.status === 'filled' && postCleanup && factualFlat(postCleanup)
          ? receipt('PASS', 'G3_CLEANUP_FACTUAL_FLAT')
          : receipt('STOP', 'CLEANUP_NOT_FACTUALLY_FLAT');
      } catch (error) {
        return receipt('STOP', error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message : 'G3_RUN_UNKNOWN');
      }
    },
  });
}
