// Phase 6A: Runtime Accounting — pure, deterministic projection.
//
// Inputs (all explicit, gathered at the nondeterministic read boundary):
//   - PaperAccountSnapshot (durable economic facts)
//   - persisted PaperFill[] (fee + slippage evidence)
//   - MarketSnapshot[] (current factual market marks)
//   - capturedAt / source (explicit capture metadata)
//
// No network, no LLM, no execution, no storage writes, no Date.now, no randomness.
// Identical inputs produce an identical snapshot. Position ordering is deterministic.

import type { PaperAccountSnapshot, PaperPosition } from '../types/paper-account';
import type { PaperFill } from '../types/paper-fill';
import type { MarketSnapshot } from '../data/MarketSnapshot';
import { roundUsd, ACCOUNTING_EPSILON } from '../paper/PaperLedgerMath';
import type {
  RuntimeAccountingSnapshot,
  RuntimePositionAccounting,
  SlippageAttribution,
  FillSlippageEvidence,
  ValuationStatus,
} from './runtime-accounting-types';

function positionKey(exchange: string, symbol: string): string {
  return `${exchange}\u0000${symbol}`;
}

/**
 * A market snapshot is usable as a current mark only when it matches the
 * position's exchange+symbol, has a ticker, is not stale, and its canonical
 * last price is finite and positive. Otherwise null (never a substitute price).
 */
function usableMarket(position: PaperPosition, snapshot: MarketSnapshot | undefined): MarketSnapshot | null {
  if (!snapshot) return null;
  if (snapshot.exchange !== position.exchange || snapshot.symbol !== position.symbol) return null;
  if (!snapshot.ticker) return null;
  if (snapshot.isStale) return null;
  const price = snapshot.ticker.ticker.last;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  return snapshot;
}

function computeSlippage(fills: readonly PaperFill[]): SlippageAttribution {
  const sorted = [...fills].sort((a, b) =>
    a.executedAt !== b.executedAt ? a.executedAt - b.executedAt : a.fillId.localeCompare(b.fillId));
  const attributed: FillSlippageEvidence[] = [];
  let unattributed = 0;
  let partialSum = 0;
  for (const f of sorted) {
    if (f.executionReferencePriceUsd === undefined) {
      unattributed += 1;
      continue;
    }
    const ref = f.executionReferencePriceUsd;
    // Adverse execution delta per unit: buy → paid over reference; sell → received under reference.
    const adverseDeltaPerUnit = f.side === 'buy' ? f.priceUsd - ref : ref - f.priceUsd;
    const amount = roundUsd(adverseDeltaPerUnit * f.quantity);
    partialSum = roundUsd(partialSum + amount);
    attributed.push(Object.freeze({
      fillId: f.fillId,
      sourceOrderId: f.sourceOrderId,
      side: f.side,
      quantity: f.quantity,
      executionReferencePriceUsd: ref,
      executedPriceUsd: f.priceUsd,
      observedSlippageUsd: amount,
    } satisfies FillSlippageEvidence));
  }
  if (unattributed > 0) {
    return Object.freeze({
      status: 'INCOMPLETE',
      totalObservedSlippageUsd: null,
      partialObservedSlippageUsd: partialSum,
      attributedFills: Object.freeze(attributed),
      unattributedFillCount: unattributed,
    });
  }
  return Object.freeze({
    status: 'COMPLETE',
    totalObservedSlippageUsd: partialSum,
    partialObservedSlippageUsd: partialSum,
    attributedFills: Object.freeze(attributed),
    unattributedFillCount: 0,
  });
}

export interface RuntimeAccountingInput {
  account: PaperAccountSnapshot;
  fills: readonly PaperFill[];
  markets: readonly MarketSnapshot[];
  capturedAt: number;
  source: string;
}

export function computeRuntimeAccounting(input: RuntimeAccountingInput): RuntimeAccountingSnapshot {
  const { account, fills, markets, capturedAt, source } = input;

  const marketByKey = new Map<string, MarketSnapshot>();
  for (const m of markets) marketByKey.set(positionKey(m.exchange, m.symbol), m);

  const sortedPositions = [...account.positions].sort((a, b) =>
    positionKey(a.exchange, a.symbol).localeCompare(positionKey(b.exchange, b.symbol)));

  const positions: RuntimePositionAccounting[] = [];
  let allValued = true;
  for (const p of sortedPositions) {
    const snap = usableMarket(p, marketByKey.get(positionKey(p.exchange, p.symbol)));
    const mark = snap ? snap.ticker!.ticker.last : null;
    if (mark === null) allValued = false;
    const marketValueUsd = mark !== null ? roundUsd(p.signedQuantity * mark) : null;
    const unrealized = mark !== null
      ? (p.direction === 'long'
        ? roundUsd((mark - p.averageEntryPriceUsd) * Math.abs(p.signedQuantity))
        : roundUsd((p.averageEntryPriceUsd - mark) * Math.abs(p.signedQuantity)))
      : null;
    positions.push(Object.freeze({
      exchange: p.exchange,
      symbol: p.symbol,
      side: p.direction,
      signedQuantity: p.signedQuantity,
      averageEntryPriceUsd: p.averageEntryPriceUsd,
      markPriceUsd: mark,
      marketSnapshotVersion: snap ? snap.snapshotVersion : null,
      marketLastUpdatedAt: snap ? snap.lastUpdatedAt : null,
      marketValueUsd,
      unrealizedPnlUsd: unrealized,
    } satisfies RuntimePositionAccounting));
  }

  const openPositions = positions.length;

  let valuationStatus: ValuationStatus;
  let unrealizedPnlUsd: number | null;
  let equityUsd: number | null;
  let grossExposureUsd: number | null;
  let netExposureUsd: number | null;

  if (openPositions === 0) {
    // Flat account: no market ticker required.
    valuationStatus = 'COMPLETE';
    unrealizedPnlUsd = 0;
    grossExposureUsd = 0;
    netExposureUsd = 0;
    equityUsd = account.cashUsd;
  } else if (!allValued) {
    valuationStatus = 'INCOMPLETE';
    unrealizedPnlUsd = null;
    grossExposureUsd = null;
    netExposureUsd = null;
    equityUsd = null;
  } else {
    valuationStatus = 'COMPLETE';
    const totalUnrealized = roundUsd(positions.reduce((s, p) => s + (p.unrealizedPnlUsd ?? 0), 0));
    const gross = roundUsd(positions.reduce((s, p) => s + Math.abs(p.marketValueUsd ?? 0), 0));
    const net = roundUsd(positions.reduce((s, p) => s + (p.marketValueUsd ?? 0), 0));
    unrealizedPnlUsd = totalUnrealized;
    grossExposureUsd = gross;
    netExposureUsd = net;
    equityUsd = roundUsd(account.cashUsd + net);
  }

  const summedFillFees = roundUsd(fills.reduce((s, f) => s + f.feeUsd, 0));
  const feesReconciled = Math.abs(summedFillFees - account.totalFeesUsd) <= ACCOUNTING_EPSILON;

  return Object.freeze({
    accountId: account.accountId,
    exchange: account.exchange,
    sourceLedgerSequence: account.sequence,
    sourceLedgerUpdatedAt: account.updatedAt,
    source,
    capturedAt,
    initialCashUsd: account.initialCashUsd,
    cashUsd: account.cashUsd,
    realizedPnlUsd: account.realizedPnlUsd,
    totalFeesUsd: account.totalFeesUsd,
    processedFills: account.processedFills,
    valuationStatus,
    unrealizedPnlUsd,
    equityUsd,
    grossExposureUsd,
    netExposureUsd,
    openPositions,
    positions: Object.freeze(positions),
    fees: Object.freeze({ totalFeesUsd: account.totalFeesUsd, summedFillFeesUsd: summedFillFees, reconciled: feesReconciled }),
    slippage: computeSlippage(fills),
  } satisfies RuntimeAccountingSnapshot);
}
