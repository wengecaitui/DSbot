import { createHash } from 'node:crypto';
import type { ExternalFlatBaselineEvidence } from '../../events/TradingEvent';
import type { TradingKernel } from '../../kernel/TradingKernel';
import type { KernelPositionStateStore } from '../../kernel/KernelPositionStateStore';
import type { GateIoExecutionTruthPort } from '../../reconciliation/GateIoExecutionTruthPort';
import type { ExecutionTruthSnapshot } from '../../reconciliation/reconciliation-types';

export interface VerifiedGateIoFlatBaselineInput {
  readonly truthPort: GateIoExecutionTruthPort;
  readonly truth: ExecutionTruthSnapshot;
  readonly kernel: TradingKernel;
  readonly positionStore: KernelPositionStateStore;
  readonly accountId: string;
  readonly symbol: string;
  readonly now: () => number;
}

/** Bootstrap only: exchange facts prove FLAT before the existing Kernel owns the baseline. */
export function establishVerifiedExternalFlatBaseline(
  input: VerifiedGateIoFlatBaselineInput,
): Readonly<ExternalFlatBaselineEvidence> {
  const { truth, truthPort, kernel, positionStore } = input;
  const capture = truthPort.canonicalForCapture(truthPort.captureSequence());
  const account = capture?.account;
  const currentTime = input.now();
  const dual = account?.account.inDualMode;
  const modes = account?.positions.map((leg) => leg.mode) ?? [];
  if (truthPort.environment !== 'testnet' || !truthPort.isLatestTruth(truth)
      || !truth.complete || account === undefined
      || truth.identity.exchange !== 'gateio' || truth.identity.accountId !== input.accountId
      || input.symbol !== 'ETH/USDT'
      || account.identity.accountId !== input.accountId || account.identity.exchange !== 'gateio'
      || !truth.source.endsWith(`capture-${truthPort.captureSequence()}`)
      || !Number.isSafeInteger(currentTime) || currentTime < truth.capturedAt
      || currentTime - truth.capturedAt > 30_000 || account.freshness !== 'FRESH'
      || account.accountState !== 'FLAT' || truth.positions.length !== 0
      || truth.orders.length !== 0 || dual === null
      || account.account.positionMode !== (dual ? 'dual' : 'single')
      || (dual === true && (modes.length !== 2 || !modes.includes('dual_long')
        || !modes.includes('dual_short')))
      || (dual === false && (modes.length > 1 || modes.some((mode) => mode !== 'single')))
      || account.positions.some((leg) => leg.signedSize !== 0 || leg.quoteValue !== 0)
      || positionStore.resolve('gateio', 'ETH/USDT').status !== 'missing'
      || kernel.journal().readFromLogicalSequence(1).length !== 0) {
    throw new Error('GATEIO_VERIFIED_FLAT_BASELINE_DENIED');
  }
  const positionMode = dual ? 'dual' : 'single';
  const digest = createHash('sha256').update(JSON.stringify({
    exchange: 'gateio', accountId: input.accountId, symbol: 'ETH/USDT',
    capturedAt: truth.capturedAt, source: truth.source, positionMode,
    legs: account.positions.map((leg) => ({ mode: leg.mode, size: leg.signedSize, value: leg.quoteValue })),
  })).digest('hex');
  const evidence: ExternalFlatBaselineEvidence = Object.freeze({
    exchange: 'gateio', accountId: input.accountId, symbol: 'ETH/USDT',
    capturedAt: truth.capturedAt, source: truth.source, digest,
    positionMode, baseline: 'flat',
  });
  const published = kernel.publish('position.baseline.confirmed', {
    baseline: { exchange: 'gateio', symbol: 'ETH/USDT', side: 'flat',
      signedQuantity: 0, averageEntryPrice: 0 }, evidence,
  });
  if (published.status !== 'accepted' || published.failures !== 0
      || positionStore.resolve('gateio', 'ETH/USDT').status !== 'flat') {
    throw new Error('GATEIO_VERIFIED_FLAT_BASELINE_NOT_APPLIED');
  }
  return evidence;
}
