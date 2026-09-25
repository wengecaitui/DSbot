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
  readonly finalExposure: 'NOT_OBSERVED' | 'FACTUAL_FLAT' | 'FACTUAL_NON_FLAT' | 'EXPOSURE_UNKNOWN';
  readonly failureOrigin: string | null;
  readonly truthFailureReason: string | null;
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
  let finalExposure: GateIoG3RunReceipt['finalExposure'] = 'NOT_OBSERVED';
  let failureOrigin: string | null = null;
  let truthFailureReason: string | null = null;
  let finalizing = false;
  const receipt = (status: 'PASS' | 'STOP', reasonCode: string): GateIoG3RunReceipt => Object.freeze({
    status, reasonCode, openOmsStatus, closeOmsStatus, cleanupOmsStatus,
    lastCaptureSequence: truthPort.captureSequence(), budget: budget.snapshot(),
    finalExposure, failureOrigin, truthFailureReason,
    testnetOnly: true as const, liveReady: false as const,
  });

  async function capture(): Promise<{ truth: ExecutionTruthSnapshot; facts: NonNullable<ReturnType<GateIoExecutionTruthPort['canonicalForCapture']>> } | null> {
    const before = truthPort.captureSequence();
    const truth = await truthPort.acquireTruth();
    const facts = truthPort.canonicalForCapture(truthPort.captureSequence());
    const age = options.now() - truth.capturedAt;
    const usable = truthPort.captureSequence() === before + 1 && truth.complete && facts !== null
      && Number.isSafeInteger(age) && age >= 0 && age <= 30_000
      ? { truth, facts } : null;
    truthFailureReason = usable === null
      ? truth.incompleteReason ?? (facts === null ? 'CANONICAL_TRUTH_UNAVAILABLE' : 'TRUTH_STALE')
      : null;
    return usable;
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

  type Capture = NonNullable<Awaited<ReturnType<typeof capture>>>;
  function classifyExposure(value: Capture): 'FACTUAL_FLAT' | 'FACTUAL_NON_FLAT' | 'EXPOSURE_UNKNOWN' {
    const { account, instrument } = value.facts;
    if (value.truth.orders.length !== 0 || account.identity.accountId !== options.accountId
        || account.identity.exchange !== 'gateio' || account.freshness !== 'FRESH'
        || instrument.freshness !== 'FRESH') return 'EXPOSURE_UNKNOWN';
    if (account.accountState === 'FLAT' && value.truth.positions.length === 0
        && account.positions.every((leg) => leg.signedSize === 0 && leg.quoteValue === 0))
      return 'FACTUAL_FLAT';
    const position = value.truth.positions[0];
    const factualLegs = account.positions.filter((leg) => leg.signedSize !== 0);
    if (account.accountState !== 'OPEN' || account.account.inDualMode !== false
        || value.truth.positions.length !== 1 || factualLegs.length !== 1
        || factualLegs[0]!.mode !== 'single' || !position
        || !Number.isFinite(position.signedQuantity) || position.signedQuantity === 0
        || Math.abs(factualLegs[0]!.signedSize * instrument.contractMultiplier
          - position.signedQuantity) > 1e-10) return 'EXPOSURE_UNKNOWN';
    return 'FACTUAL_NON_FLAT';
  }

  /** A failed proof is never rehabilitated by emergency cleanup. */
  async function finalizeFailedRun(reason: string, alreadyFresh: Capture | null = null): Promise<GateIoG3RunReceipt> {
    failureOrigin = reason;
    if (budget.snapshot().totalUsed === 0) return receipt('STOP', reason);
    if (finalizing) return receipt('STOP', 'FAIL_EXPOSURE_UNKNOWN');
    finalizing = true;
    let current: Capture | null = alreadyFresh;
    if (current !== null) {
      const age = options.now() - current.truth.capturedAt;
      if (!Number.isSafeInteger(age) || age < 0 || age > 30_000) current = null;
    }
    if (current === null) {
      try { current = await capture(); }
      catch { truthFailureReason = 'TRUTH_ACQUISITION_FAILED'; }
    }
    if (current === null) {
      finalExposure = 'EXPOSURE_UNKNOWN';
      return receipt('STOP', 'FAIL_EXPOSURE_UNKNOWN');
    }
    finalExposure = classifyExposure(current);
    const exposureAge = options.now() - current.truth.capturedAt;
    if (!Number.isSafeInteger(exposureAge) || exposureAge < 0 || exposureAge > 30_000) {
      finalExposure = 'EXPOSURE_UNKNOWN';
      truthFailureReason = 'TRUTH_STALE';
      return receipt('STOP', 'FAIL_EXPOSURE_UNKNOWN');
    }
    if (finalExposure === 'FACTUAL_FLAT') return receipt('STOP', 'FAIL_' + reason + '_FLAT');
    if (finalExposure === 'EXPOSURE_UNKNOWN') {
      truthFailureReason ??= 'EXACT_EXPOSURE_UNPROVABLE';
      return receipt('STOP', 'FAIL_EXPOSURE_UNKNOWN');
    }
    const beforeCleanup = budget.snapshot();
    if (beforeCleanup.cleanupUsed >= GATEIO_G3_LIMITS.cleanupMutations
        || beforeCleanup.totalUsed >= GATEIO_G3_LIMITS.totalMutations
        || beforeCleanup.networkUsed >= GATEIO_G3_LIMITS.networkRequests)
      return receipt('STOP', 'FAIL_CLEANUP_BUDGET_EXHAUSTED');
    const exposure = current.truth.positions[0]!;
    const facts = current.facts.instrument;
    const contracts = Math.abs(exposure.signedQuantity) / facts.contractMultiplier;
    const normalized = normalizeGateIoEthContracts(contracts, facts, 'emergency_exit');
    const currentFacts = truthPort.currentInstrument();
    if (currentFacts !== facts || normalized === null
        || Math.abs(normalized - contracts) > 1e-10
        || !Number.isFinite(facts.markPrice) || facts.markPrice <= 0)
      return receipt('STOP', 'FAIL_POSITION_REMAINS_OPEN');
    const positionUsd = Math.abs(exposure.signedQuantity) * facts.markPrice;
    if (!Number.isFinite(positionUsd) || positionUsd <= 0)
      return receipt('STOP', 'FAIL_POSITION_REMAINS_OPEN');
    // Emergency exit still uses the sole OMS and adapter. The factual Gate leg, not
    // a divergent local position, determines the reduce-only target.
    try {
      const intent = createTradeIntent({ exchange: 'gateio', symbol: 'ETH/USDT',
        direction: exposure.side === 'long' ? 'short' : 'long', positionUsd,
        source: 'gateio-g3-testnet', reason: 'g3-factual-emergency-exit',
        biasUpdatedAt: options.now(), createdAt: options.now() });
      const cleanup = await oms.submitRequest(intent, 'emergency_exit', positionUsd);
      cleanupOmsStatus = cleanup.status;
    } catch {
      cleanupOmsStatus = 'submission_unknown';
    }
    // Even an ambiguous or rejected cleanup must be followed by a new factual read.
    let postCleanup: Capture | null = null;
    try { postCleanup = await capture(); }
    catch { truthFailureReason = 'POST_CLEANUP_TRUTH_ACQUISITION_FAILED'; }
    if (postCleanup === null) {
      finalExposure = 'EXPOSURE_UNKNOWN';
      return receipt('STOP', 'FAIL_POST_CLEANUP_TRUTH_UNKNOWN');
    }
    finalExposure = classifyExposure(postCleanup);
    if (finalExposure === 'FACTUAL_FLAT') return receipt('STOP', 'FAIL_CLEANED_UP');
    if (finalExposure === 'FACTUAL_NON_FLAT') return receipt('STOP', 'FAIL_POSITION_REMAINS_OPEN');
    truthFailureReason ??= 'POST_CLEANUP_EXPOSURE_UNPROVABLE';
    return receipt('STOP', 'FAIL_POST_CLEANUP_TRUTH_UNKNOWN');
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
        if (open === 'RISK_REJECTED') return await finalizeFailedRun('OPEN_RISK_REJECTED');
        const postOpen = await capture(); // fresh after mutation even when submission unknown
        if (!postOpen) return await finalizeFailedRun('POST_OPEN_TRUTH_UNKNOWN');
        if (open.status !== 'filled') return await finalizeFailedRun('OPEN_FILL_UNCONFIRMED');
        if (!factualFillsMatchKernel(postOpen.truth))
          return await finalizeFailedRun('OPEN_QUANTITY_MISMATCH');
        if (!factualOpen(postOpen)) return await finalizeFailedRun('OPEN_POSITION_MISMATCH');
        const preClose = await capture(); // fresh position/order/trade facts
        if (!preClose || !factualOpen(preClose))
          return await finalizeFailedRun('PRE_CLOSE_TRUTH_MISMATCH');
        const freshInstrument = await truthPort.refreshInstrumentFacts();
        if (!freshInstrument) return await finalizeFailedRun('PRE_CLOSE_INSTRUMENT_UNKNOWN');
        if (options.now() - preClose.truth.capturedAt > 30_000)
          return await finalizeFailedRun('PRE_CLOSE_TRUTH_STALE');
        const local = positionStore.resolve('gateio', 'ETH/USDT');
        const closeUsd = Math.abs(local.signedQuantity) * freshInstrument.markPrice;
        const close = await submit('close', 'short', closeUsd,
          Math.abs(preClose.truth.positions[0]!.signedQuantity)
          / freshInstrument.contractMultiplier);
        closeOmsStatus = close === 'RISK_REJECTED' ? close : close.status;
        if (close === 'RISK_REJECTED') return await finalizeFailedRun('CLOSE_RISK_REJECTED');
        const postClose = await capture();
        if (!postClose) return await finalizeFailedRun('POST_CLOSE_TRUTH_UNKNOWN');
        if (close.status === 'filled' && factualFlat(postClose)
            && budget.snapshot().cleanupUsed === 0) {
          finalExposure = 'FACTUAL_FLAT';
          return receipt('PASS', 'G3_FACTUAL_FLAT');
        }
        return await finalizeFailedRun('CLOSE_NOT_FACTUALLY_CONFIRMED', postClose);
      } catch (error) {
        const reason = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message : 'G3_RUN_UNKNOWN';
        return await finalizeFailedRun(reason);
      }
    },
  });
}
