/** One-shot orchestration of the existing owner/spine. This module creates no trading authority. */
import { isAbsolute } from 'node:path';
import type { ApplicationProductionRuntimeOwner } from '../production/ProductionRuntimeOwner';
import type { ProductionSpine } from '../../position/ProductionSpine';
import type { GateIoReadCredential } from './GateIoReadContracts';
import type { GateIoReadFetch } from './GateIoReadTransport';
import type { OmsOrderSnapshot } from '../../oms/oms-types';
import { GateIoG3RunBudget, type GateIoG3RunLimits } from './GateIoG3RunBudget';
import { multiplyQuantity } from '../../types/decimal-quantity';
import { quantityEqual } from '../../oms/execution-observation';
import { GATEIO_ETH_DECIMAL_CONTRACT_STEP, normalizeGateIoEthContracts } from '../../exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import type { GateIoCanonicalInstrumentFacts } from './GateIoAuthenticatedReadFoundation';
import { GateIoCanaryCredentialError } from './GateIoCanaryCredentialFile';

// Same budget implementation as the formal Gate binding; not a second limiter/transport.
// Eight 5-GET captures + two 3-GET instrument reads + 3 attestations + 2 ambiguity GETs + 3 POSTs.
export const GATEIO_LIVE_CANARY_LIMITS: Readonly<GateIoG3RunLimits> = Object.freeze({
  accountAcquisitions: 8, instrumentAcquisitions: 2, currentRunOrderAttestations: 3,
  ambiguousReconciliations: 2, proofMutations: 2, cleanupMutations: 1,
  totalMutations: 3, networkRequests: 54,
});
export const GATEIO_LIVE_RECOVERY_LIMITS: Readonly<GateIoG3RunLimits> = Object.freeze({
  ...GATEIO_LIVE_CANARY_LIMITS, proofMutations: 0, cleanupMutations: 1, totalMutations: 1,
});

/** Reuse the adapter's proven lattice, not an assumed venue exception for sub-minimum closes. */
export function gateIoCanaryPartialCloseability(facts: GateIoCanonicalInstrumentFacts): boolean {
  const quantum = facts.decimalSizeEnabled === true ? GATEIO_ETH_DECIMAL_CONTRACT_STEP
    : facts.decimalSizeEnabled === false ? 1 : NaN;
  return facts.contract === 'ETH_USDT' && Number.isFinite(facts.minOrderSize) && facts.minOrderSize > 0
    && facts.minOrderSize <= quantum && facts.maxOrderSize >= quantum
    && normalizeGateIoEthContracts(facts.minOrderSize, facts, 'open') === facts.minOrderSize
    && normalizeGateIoEthContracts(quantum, facts, 'close') === quantum
    && normalizeGateIoEthContracts(quantum, facts, 'emergency_exit') === quantum;
}

export interface GateIoLiveCanaryOptions {
  readonly execute?: boolean;
  readonly recoveryOnly?: boolean;
  readonly expectedHead?: string;
  readonly environment?: string;
  readonly symbol?: string;
  readonly accountId?: string;
  /** Existing durable recovery input, NOT a scratch journal that invents a FLAT baseline/policy. */
  readonly journalPath?: string;
  readonly maxNotionalUsd?: number;
  /** Independent operator declaration, NOT verification of exchange-side key permissions. */
  readonly permissions?: { readonly READ: boolean; readonly TRADE: boolean;
    readonly WITHDRAW: boolean; readonly ROTATED: boolean };
}

export interface GateIoLiveCanaryHost {
  readonly inspectRepository: () => Promise<{ readonly head: string; readonly clean: boolean }>;
  readonly credentialProvider: () => Promise<GateIoReadCredential | null>;
  readonly fetchImpl: GateIoReadFetch;
  readonly now: () => number;
}

type Exposure = 'NOT_OBSERVED' | 'FACTUAL_FLAT' | 'FACTUAL_NON_FLAT' | 'UNKNOWN';
class CanaryStop extends Error { constructor(readonly code: string) { super(code); } }
function stop(code: string): never { throw new CanaryStop(code); }
function orderEvidence(order: OmsOrderSnapshot | undefined) {
  if (!order) return null;
  // No exchange errors, identifiers, request/response bodies, headers or caller-provided text.
  return Object.freeze({ status: order.status, requestedQuantity: order.requestedQuantity ?? null,
    cumulativeFilledQuantity: order.cumulativeFilledQuantity ?? null,
    remainingQuantity: order.remainingQuantity ?? null, reduceOnly: order.preparation?.reduceOnly ?? null });
}

export async function runGateIoProductionLiveCanary(options: GateIoLiveCanaryOptions,
  host: GateIoLiveCanaryHost) {
  const recoveryOnly = options.recoveryOnly === true;
  const limits = recoveryOnly ? GATEIO_LIVE_RECOVERY_LIMITS : GATEIO_LIVE_CANARY_LIMITS;
  const budget = GateIoG3RunBudget.create(limits);
  let status: 'PASS' | 'STOP' | 'FAIL_CLEANED_UP' | 'RECOVERY_FLAT' | 'RECOVERY_CLEANED_UP' = 'STOP';
  let reason = 'NOT_ARMED';
  let verifiedHead: string | null = null;
  let owner: ApplicationProductionRuntimeOwner | null = null;
  let spine: ProductionSpine | null = null;
  let finalExposure: Exposure = 'NOT_OBSERVED';
  let baselineVerified = false;
  let cleanupAttempted = false;
  let open: ReturnType<typeof orderEvidence> = null;
  let close: ReturnType<typeof orderEvidence> = null;
  let cleanup: ReturnType<typeof orderEvidence> = null;
  let history: 'NONE' | 'LAGGING' | 'CONVERGED' | 'UNKNOWN' = 'UNKNOWN';
  let startedAt = 0;
  const orderIds: Partial<Record<'open' | 'close' | 'emergency_exit', string>> = {};
  const snapshot = () => owner?.gateIoObservation() ?? null;

  function facts() {
    const view = snapshot();
    const now = host.now();
    const c = view?.canonical;
    if (!view?.truth?.complete || !c || !Number.isSafeInteger(now)
        || c.account.identity.accountId !== options.accountId
        || c.account.identity.exchange !== 'gateio'
        || c.account.freshness !== 'FRESH' || c.instrument.freshness !== 'FRESH'
        || c.instrument.contract !== 'ETH_USDT'
        || [view.truth.capturedAt, c.account.observedAtMs, c.instrument.observedAtMs]
          .some(at => now < at || now - at > 30_000)) return null;
    return c;
  }

  function classify(): Exposure {
    const c = facts();
    const local = spine?.positionStore.resolve('gateio', 'ETH/USDT');
    // Contradictory/unattributed state never authorizes a cleanup of someone else's exposure.
    if (!c || !spine?.reconciliationVerified || !local || local.status === 'missing'
        || c.account.openOrders.length !== 0
        || spine.oms.getStore().list().some(o => !['FILLED', 'CANCELLED', 'REJECTED'].includes(o.status)))
      return 'UNKNOWN';
    const legs = c.account.positions.filter(p => p.signedSize !== 0 || p.quoteValue !== 0);
    if (legs.length === 0 && c.account.accountState === 'FLAT'
        && local.status === 'flat' && local.signedQuantity === 0) return 'FACTUAL_FLAT';
    if (legs.length === 1 && c.account.accountState === 'OPEN' && local.status === 'open'
        && legs[0]!.contract === 'ETH_USDT'
        && quantityEqual(local.signedQuantity,
          multiplyQuantity(legs[0]!.signedSize, c.instrument.contractMultiplier))) return 'FACTUAL_NON_FLAT';
    return 'UNKNOWN';
  }

  async function refresh(): Promise<Exposure> {
    try {
      if (!spine) return 'UNKNOWN';
      const before = snapshot()?.sequence ?? 0;
      const { reconcileRecoveredState } = await import('../../position/ProductionSpine');
      try { await reconcileRecoveredState(spine); } catch { /* no stale-success fallback */ }
      const after = snapshot();
      history = after?.history ?? 'UNKNOWN';
      return after && after.sequence > before ? classify() : 'UNKNOWN';
    } catch { history = 'UNKNOWN'; return 'UNKNOWN'; }
  }

  async function submit(action: 'open' | 'close' | 'emergency_exit') {
    if (recoveryOnly && action !== 'emergency_exit') stop('RECOVERY_OPEN_FORBIDDEN');
    const c = facts();
    if (!spine || !c) stop('FRESH_FACTS_REQUIRED');
    if (action === 'open' && !gateIoCanaryPartialCloseability(c.instrument))
      stop('CANARY_PARTIAL_RESIDUAL_NOT_CLOSEABLE');
    const { createTradeIntent } = await import('../../types/trade-intent');
    const { executeThroughGateway } = await import('../../position/ProductionSpine');
    const local = spine.positionStore.resolve('gateio', 'ETH/USDT');
    const quantity = action === 'open'
      ? multiplyQuantity(c.instrument.minOrderSize, c.instrument.contractMultiplier)
      : Math.abs(local.signedQuantity);
    const usd = multiplyQuantity(quantity, c.instrument.markPrice);
    if (!Number.isFinite(usd) || usd <= 0
        || (action === 'open' && usd > options.maxNotionalUsd!)) stop('MINIMUM_SIZE_EXCEEDS_CAP');
    if (action !== 'open' && local.status !== 'open') stop('FACTUAL_RESIDUAL_REQUIRED');
    const intent = createTradeIntent({ exchange: 'gateio', symbol: 'ETH/USDT',
      direction: action === 'open' || local.signedQuantity < 0 ? 'long' : 'short', positionUsd: usd,
      source: 'gateio-production-live-canary', reason: `g6-${recoveryOnly ? 'recovery-' : ''}${action}-${verifiedHead}`,
      createdAt: startedAt, biasUpdatedAt: host.now() });
    const result = await executeThroughGateway(spine, intent, action, usd);
    const order = spine.oms.getStore().list().find(o => o.intentId === intent.intentId);
    if (order) orderIds[action] = order.orderId;
    if (action === 'open') open = orderEvidence(order);
    else if (action === 'close') close = orderEvidence(order);
    else cleanup = orderEvidence(order);
    return { result, order };
  }

  try {
    // Nothing below, including the repository or credential callbacks, is touched by default.
    if (options.execute !== true) stop('NOT_ARMED');
    options = Object.freeze({ ...options, permissions: options.permissions
      ? Object.freeze({ ...options.permissions }) : undefined });
    host = Object.freeze({ ...host });
    if (options.environment !== 'live') stop('LIVE_ONLY');
    if (options.symbol !== 'ETH_USDT') stop('ETH_USDT_ONLY');
    if (!/^[a-f0-9]{40}$/.test(options.expectedHead ?? '')) stop('EXACT_HEAD_REQUIRED');
    const p = options.permissions;
    if (!p || p.READ !== true || p.TRADE !== true || p.WITHDRAW !== false || p.ROTATED !== true)
      stop('PERMISSION_ATTESTATION_REQUIRED');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.accountId ?? '')
        || !options.journalPath || !isAbsolute(options.journalPath)
        || !Number.isFinite(options.maxNotionalUsd) || options.maxNotionalUsd! <= 0)
      stop('EXPLICIT_RUNTIME_CONFIGURATION_REQUIRED');
    const repository = await host.inspectRepository();
    if (repository.head !== options.expectedHead) stop('HEAD_MISMATCH');
    if (repository.clean !== true) stop('DIRTY_WORKTREE');
    verifiedHead = repository.head;
    // Inspect only the explicitly named durable journal, using its existing integrity reader.
    // A TestNet/bare synthetic baseline cannot be promoted into a production recovery input.
    const { createFileEventJournal } = await import('../../recovery/FileEventJournal');
    const journal = createFileEventJournal(options.journalPath);
    try {
      const events = journal.readFromLogicalSequence(1, journal.eventCount);
      if (!recoveryOnly && events.some(e => e.type === 'order.created')) stop('CANARY_JOURNAL_ALREADY_USED');
      const baselines = events.filter(e => e.type === 'position.baseline.confirmed');
      if (baselines.length !== 1 || baselines.some(e => {
        const p = e.payload as import('../../events/TradingEvent').TradingEventPayloadMap['position.baseline.confirmed'];
        return p.baseline.exchange !== 'gateio' || p.baseline.symbol !== 'ETH/USDT'
          || !p.evidence || p.evidence.accountId !== options.accountId || p.evidence.exchange !== 'gateio'
          || !/^gateio-live-read:capture-[1-9][0-9]*$/.test(p.evidence.source);
      })) stop('RECOVERED_LIVE_BASELINE_REQUIRED');
    } finally { journal.close(); }
    startedAt = host.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) stop('CLOCK_INVALID');
    let credential: GateIoReadCredential | null;
    try { credential = await host.credentialProvider(); }
    catch (error) {
      stop(error instanceof GateIoCanaryCredentialError ? error.code : 'CREDENTIAL_UNAVAILABLE');
    }
    if (!credential || typeof credential.apiKey !== 'string' || !credential.apiKey.trim()
        || typeof credential.secretKey !== 'string' || !credential.secretKey.trim()) stop('CREDENTIAL_UNAVAILABLE');
    // Recheck immediately before composition; no network occurred during credential loading.
    const recheck = await host.inspectRepository();
    if (recheck.head !== verifiedHead || recheck.clean !== true) stop('REPOSITORY_CHANGED');
    const { createApplicationProductionRuntimeOwner } = await import('../production/ProductionRuntimeOwner');
    owner = createApplicationProductionRuntimeOwner({ enabled: true, mode: 'limited-live',
      exchange: 'gateio', environment: 'live', accountId: options.accountId,
      journalPath: options.journalPath, hardRisk: { enabled: true, locked: false,
        totalCapitalUsd: options.maxNotionalUsd!, maxSinglePositionPct: 1,
        maxSinglePositionAbsUsd: options.maxNotionalUsd! },
      market: { entries: [{ symbol: 'ETH/USDT', exchangeSymbol: 'ETH_USDT', intervals: ['1m'], ticker: true }],
        staleAfterMs: 30_000 },
    }, { gateIo: { environment: 'live', accountId: options.accountId!, credential,
      fetchImpl: host.fetchImpl, now: host.now, runBudget: budget } });
    await owner.start();
    spine = owner.authoritativeSpine();
    if (!spine || owner.read.status().spineCreations !== 1 || !spine.recoveryVerified
        || !spine.reconciliationVerified) stop('FORMAL_RECOVERY_RECONCILIATION_REQUIRED');
    if (!recoveryOnly && (spine.oms.getStore().list().length !== 0 || classify() !== 'FACTUAL_FLAT'))
      stop('EMPTY_ORDER_HISTORY_AND_FACTUAL_FLAT_REQUIRED');
    baselineVerified = true;
    const { activateLiveReadiness } = await import('../../position/ProductionSpine');
    if (recoveryOnly) {
      finalExposure = classify();
      if (finalExposure === 'FACTUAL_FLAT') {
        status = 'RECOVERY_FLAT'; reason = 'RECOVERY_ALREADY_FACTUAL_FLAT';
      } else {
        if (finalExposure !== 'FACTUAL_NON_FLAT') stop('RECOVERY_TRUTH_UNVERIFIED');
        await activateLiveReadiness(spine); // Same recovery, current reconciliation and market gates.
        if (classify() !== 'FACTUAL_NON_FLAT') stop('RECOVERY_TRUTH_UNVERIFIED');
        cleanupAttempted = true;
        try { await submit('emergency_exit'); } catch { /* Observe once; never retry a cleanup. */ }
        finalExposure = await refresh();
        cleanup = orderEvidence(orderIds.emergency_exit ? spine.oms.getStore().get(orderIds.emergency_exit) : undefined);
        if (finalExposure === 'FACTUAL_FLAT' && cleanup?.status === 'FILLED'
            && cleanup.cumulativeFilledQuantity! > 0 && budget.snapshot().cleanupUsed === 1) {
          status = 'RECOVERY_CLEANED_UP'; reason = 'RECOVERY_FACTUAL_FLAT';
        } else reason = 'RECOVERY_CLEANUP_NOT_VERIFIED';
      }
    } else {
      const policy = spine.policyStore.resolve('gateio', 'ETH/USDT');
      if (policy.status !== 'active' || !policy.allowNewEntries) stop('RECOVERED_POLICY_REQUIRED');
      await activateLiveReadiness(spine); // No bypass of recovery/reconciliation/factual market gates.
      const opened = await submit('open');
      finalExposure = classify();
      if (!opened.result.admitted || !opened.order
          || !['FILLED', 'CANCELLED'].includes(opened.order.status)
          || !(opened.order.cumulativeFilledQuantity! > 0) || finalExposure !== 'FACTUAL_NON_FLAT')
        stop('OPEN_NOT_FACTUALLY_VERIFIED');
      // A terminal partial OPEN is closed at factual exposure, never at requested quantity.
      const closed = await submit('close');
      if (!closed.result.admitted || closed.order?.status !== 'FILLED') stop('CLOSE_NOT_FULLY_FILLED');
      finalExposure = await refresh();
      if (finalExposure !== 'FACTUAL_FLAT') stop('FINAL_FLAT_NOT_VERIFIED');
      if (budget.snapshot().proofUsed !== 2 || budget.snapshot().cleanupUsed !== 0)
        stop('PROOF_BUDGET_MISMATCH');
      status = 'PASS'; reason = 'OPEN_CLOSE_FACTUAL_FLAT';
    }
  } catch (error) {
    reason = error instanceof CanaryStop ? error.code : 'CANARY_FAILED';
    if (recoveryOnly && owner) finalExposure = 'UNKNOWN';
    if (spine && budget.snapshot().totalUsed > 0) {
      // Includes failures of the automatic post-submit reconciliation. Never inspect old captures.
      finalExposure = await refresh();
      if (!recoveryOnly && !cleanupAttempted && finalExposure === 'FACTUAL_NON_FLAT') {
        cleanupAttempted = true;
        try {
          await submit('emergency_exit'); // Same Risk -> OMS path, at most one attempt.
        } catch { /* A cleanup error still requires one final fresh observation, never a retry. */ }
        finalExposure = await refresh();
        cleanup = orderEvidence(orderIds.emergency_exit ? spine.oms.getStore().get(orderIds.emergency_exit) : undefined);
        if (finalExposure === 'FACTUAL_FLAT' && cleanup?.status === 'FILLED'
            && cleanup.cumulativeFilledQuantity! > 0 && budget.snapshot().cleanupUsed === 1)
          status = 'FAIL_CLEANED_UP';
      }
    }
  } finally {
    if (spine) {
      // Receipt reflects the sole OMS's latest cumulative state, including reconciliation deltas.
      open = orderEvidence(orderIds.open ? spine.oms.getStore().get(orderIds.open) : undefined);
      close = orderEvidence(orderIds.close ? spine.oms.getStore().get(orderIds.close) : undefined);
      cleanup = orderEvidence(orderIds.emergency_exit ? spine.oms.getStore().get(orderIds.emergency_exit) : undefined);
    }
    if (owner) {
      try { await owner.stop(); } catch { status = 'STOP'; reason = 'OWNER_SHUTDOWN_FAILED'; }
      if (owner.read.status().state === 'STOP_FAILED') { status = 'STOP'; reason = 'OWNER_SHUTDOWN_FAILED'; }
    }
  }
  return Object.freeze({ status, reason, expectedHead: verifiedHead, environment: 'live' as const,
    symbol: 'ETH_USDT' as const, baselineVerified, finalExposure, open, close, cleanup,
    cleanupAttempted, history, budget: budget.snapshot(), limits,
    mode: recoveryOnly ? 'RECOVERY_ONLY' as const : 'CANARY' as const,
    ownerSpineCreations: owner?.read.status().spineCreations ?? 0,
    postRetryCount: 0 as const, permissionAttestationIsExchangePermissionProof: false as const,
    readyForAutonomousLive: false as const });
}
