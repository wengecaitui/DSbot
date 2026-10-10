import { createHash } from 'node:crypto';
import type { ExternalFlatBaselineEvidence } from '../../events/TradingEvent';
import type { ProductionOmsReadView } from '../../position/ProductionSpine';
import { isGateIoExecutionTruthPort } from '../../reconciliation/GateIoExecutionTruthPort';
import type { VerifiedGateIoFlatBaselineInput } from './establishVerifiedExternalFlatBaseline';

export interface VerifiedGateIoLiveFlatBaselineInput extends VerifiedGateIoFlatBaselineInput {
  readonly oms: ProductionOmsReadView;
}

export const GATEIO_LIVE_BASELINE_MAX_AGE_MS = 30_000;

/** Pure preflight against the existing port's latest capture and the caller's local authorities.
 * A returned digest alone is NOT an applied baseline or any execution/readiness grant.
 */
export function verifyGateIoLiveFlatBaseline(
  input: VerifiedGateIoLiveFlatBaselineInput,
): Readonly<ExternalFlatBaselineEvidence> {
  const { truthPort, truth, kernel, positionStore, oms } = input;
  if (!isGateIoExecutionTruthPort(truthPort)) throw new Error('GATEIO_LIVE_BASELINE_DENIED');
  const sequence = truthPort.captureSequence();
  const account = truthPort.canonicalForCapture(sequence)?.account;
  const now = input.now();
  const fresh = (time: number) => Number.isSafeInteger(time) && time >= 0
    && Number.isSafeInteger(now) && now >= time && now - time <= GATEIO_LIVE_BASELINE_MAX_AGE_MS;
  const dual = account?.account.inDualMode;
  const legs = account?.positions ?? [];
  if (truthPort.environment !== 'live' || !truthPort.isLatestTruth(truth)
      || !truth.complete || account === undefined
      || typeof input.accountId !== 'string' || input.accountId.trim().length === 0
      || input.symbol !== 'ETH/USDT'
      || truth.identity.exchange !== 'gateio' || truth.identity.accountId !== input.accountId
      || account.identity.exchange !== 'gateio' || account.identity.accountId !== input.accountId
      || account.identity.settle !== 'USDT' || account.account.currency !== 'USDT'
      || !Number.isSafeInteger(sequence) || sequence < 1
      || truth.source !== `gateio-live-read:capture-${sequence}`
      || !fresh(truth.capturedAt) || !fresh(account.observedAtMs)
      || truth.capturedAt < account.observedAtMs || account.freshness !== 'FRESH'
      || !Number.isSafeInteger(account.serverTimeMs) || account.serverTimeMs <= 0
      || account.accountState !== 'FLAT' || account.accountStateBasis !== 'FACTUAL_POSITIONS_RESPONSE'
      || truth.positions.length !== 0 || truth.orders.length !== 0 || truth.fills.length !== 0
      || (truth.executions?.length ?? 0) !== 0 || account.openOrders.length !== 0
      || (dual !== true && dual !== false)
      || account.account.positionMode !== (dual ? 'dual' : 'single')
      || (dual === false && (legs.length !== 1 || legs[0]?.mode !== 'single'))
      || (dual === true && (legs.length !== 2
        || legs.filter(leg => leg.mode === 'dual_long').length !== 1
        || legs.filter(leg => leg.mode === 'dual_short').length !== 1))
      || legs.some(leg => leg.contract !== 'ETH_USDT' || leg.signedSize !== 0 || leg.quoteValue !== 0)
      || positionStore.resolve('gateio', 'ETH/USDT').status !== 'missing'
      || oms.getStore().list().length !== 0
      || kernel.journal().readFromLogicalSequence(1).length !== 0) {
    throw new Error('GATEIO_LIVE_BASELINE_DENIED');
  }
  const positionMode = dual ? 'dual' : 'single';
  const digest = createHash('sha256').update(JSON.stringify({
    exchange: 'gateio', accountId: input.accountId, symbol: 'ETH/USDT',
    capturedAt: truth.capturedAt, source: truth.source, positionMode,
    legs: legs.map(leg => ({ contract: leg.contract, mode: leg.mode,
      size: leg.signedSize, value: leg.quoteValue })).sort((a, b) => a.mode.localeCompare(b.mode)),
  })).digest('hex');
  return Object.freeze({ exchange: 'gateio', accountId: input.accountId, symbol: 'ETH/USDT',
    capturedAt: truth.capturedAt, source: truth.source, digest, positionMode, baseline: 'flat' });
}

/** LIVE-only bootstrap. Reuses the SAME port's historical boundary and the SAME Kernel/stores.
 * No acquisition, credential handling, retry, market publication or execution is possible here.
 */
export function establishVerifiedLiveFlatBaseline(
  input: VerifiedGateIoLiveFlatBaselineInput,
): Readonly<ExternalFlatBaselineEvidence> {
  const evidence = verifyGateIoLiveFlatBaseline(input);
  // Also rechecks the port's own OMS view and refuses an already established boundary.
  input.truthPort.establishVerifiedTradeBoundary(input.truth);
  const published = input.kernel.publish('position.baseline.confirmed', {
    baseline: { exchange: 'gateio', symbol: 'ETH/USDT', side: 'flat',
      signedQuantity: 0, averageEntryPrice: 0 }, evidence,
  });
  if (published.status !== 'accepted' || published.failures !== 0
      || input.positionStore.resolve('gateio', 'ETH/USDT').status !== 'flat') {
    throw new Error('GATEIO_LIVE_BASELINE_NOT_APPLIED');
  }
  return evidence;
}
