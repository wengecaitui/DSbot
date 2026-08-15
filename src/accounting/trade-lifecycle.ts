// Phase 6B: Trade Lifecycle — pure, deterministic, fail-closed projection.
//
// Inputs (all explicit, gathered at the nondeterministic read boundary):
//   - PaperAccountSnapshot (durable economic facts)
//   - PaperFillLedgerEntry[] (durable fill entries, ordered by ledger sequence)
//
// Invariants:
//   - Ledger `sequence`, NOT timestamp or fill ID, is the lifecycle ordering
//     authority. The function never sorts fills: it rejects duplicate,
//     non-increasing, or non-positive sequences. Gaps (marks between fills) are
//     allowed. Same-timestamp fills remain sequence-sensitive.
//   - One trade incarnation per flat -> open -> ... -> flat/reversal cycle.
//   - A reversal fill appears in two adjacent incarnations only through
//     non-overlapping attributed legs whose quantities and fees sum exactly to
//     the canonical fill values (deterministic residual rule).
//   - Reconciliation is fail-closed: allocated fees must equal canonical total
//     fees, and aggregate gross-realized minus allocated fees must equal
//     canonical realized PnL, within the existing accounting epsilon.
//
// Phase 6B Repair 2 (items 1-5):
//   1. Snapshot/history binding: the supplied fill entries must fully and
//      exactly account for `account.processedFills`, their sequence envelope
//      must be compatible with `account.sequence`, and the projected remaining
//      open positions must reconcile with `account.positions` (identity,
//      signed quantity, and current cost basis). Duplicate fill IDs rejected.
//   2. Fail-closed input validation: finite numeric values, non-negative
//      integer counters/timestamps, account/exchange identity, fill entry
//      shape, positive quantity/price, non-negative fee, unique IDs, and
//      canonical durability precision (USD 8dp / quantity 12dp) are all
//      validated BEFORE arithmetic with typed lifecycle errors. NaN/Infinity
//      can never be published.
//   3. Collision-safe deterministic trade IDs: length-prefixed components so a
//      `|` inside a symbol or fill ID cannot shift boundaries.
//   4. Whole-incarnation entry notional (published average entry) is tracked
//      separately from the current open-position cost basis used for matching,
//      reconciliation, and realized gross PnL.
//   5. Per-symbol `executedAt` regression is rejected (matching the canonical
//      Paper ledger), so a negative holding duration can never be published.
//
// No network, no LLM, no execution, no storage writes, no Date.now, no
// randomness. Identical inputs produce an identical deeply-frozen snapshot.
// Caller-owned inputs are never mutated or frozen.

import type { PaperAccountSnapshot, PaperFillLedgerEntry, PaperPosition } from '../types/paper-account';
import type { PaperFill } from '../types/paper-fill';
import { validatePaperFill } from '../types/paper-fill';
import { roundUsd, roundQuantity, ACCOUNTING_EPSILON, QUANTITY_EPSILON, USD_DECIMALS, QUANTITY_DECIMALS } from '../paper/PaperLedgerMath';
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { TradeLifecycle, TradeIncarnation, AttributedLeg } from './trade-lifecycle-types';

// ─── Domain errors ──────────────────────────────────────────────────────────

export class TradeLifecycleError extends Error {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleError'; }
}
/** Duplicate, non-increasing, or non-positive ledger sequence. */
export class TradeLifecycleSequenceError extends TradeLifecycleError {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleSequenceError'; }
}
/** Fill exchange does not match the account snapshot's exchange. */
export class TradeLifecycleExchangeMismatchError extends TradeLifecycleError {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleExchangeMismatchError'; }
}
/** Projection does not reconcile with canonical account facts. */
export class TradeLifecycleReconciliationError extends TradeLifecycleError {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleReconciliationError'; }
}
/** Repair 2: malformed input — non-finite numbers, invalid identity/counters,
 *  invalid fill entry shape, or non-canonical fill fields. Fail-closed. */
export class TradeLifecycleValidationError extends TradeLifecycleError {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleValidationError'; }
}
/** Repair 2 (item 1): a fill ID appears more than once in the supplied history. */
export class TradeLifecycleDuplicateFillIdError extends TradeLifecycleValidationError {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleDuplicateFillIdError'; }
}
/** Repair 2 (item 5): a symbol's executedAt regresses against its previous fill. */
export class TradeLifecycleTimeRegressionError extends TradeLifecycleError {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleTimeRegressionError'; }
}
/** Repair 2 (item 1): projected open positions do not reconcile with account.positions. */
export class TradeLifecyclePositionReconciliationError extends TradeLifecycleReconciliationError {
  constructor(message: string) { super(message); this.name = 'TradeLifecyclePositionReconciliationError'; }
}

export interface TradeLifecycleInput {
  account: PaperAccountSnapshot;
  fills: readonly PaperFillLedgerEntry[];
}

const WIN_ONLY_PROFIT_FACTOR_SENTINEL = 1_000_000;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function positionKey(exchange: string, symbol: string): string {
  return `${exchange}\u0000${symbol}`;
}

/** Collision-safe deterministic trade ID. Each component is length-prefixed so
 *  a `|` (or any other byte) inside a symbol or fill ID cannot shift component
 *  boundaries. Repair 2 (item 3): the naive `a|e|s|seq|fillId` join collided for
 *  (symbol=X, seq=1, fillId=2|Y) vs (symbol=X|1, seq=2, fillId=Y). */
function encodeIdComponent(value: string): string {
  return `${value.length}:${value}`;
}

function makeTradeId(accountId: string, exchange: ExchangeId, symbol: string, openingSequence: number, openingFillId: string): string {
  return [accountId, exchange, symbol, String(openingSequence), openingFillId]
    .map(encodeIdComponent)
    .join('|');
}

function makeLeg(fill: PaperFill, sequence: number, attributedQuantity: number, allocatedFeeUsd: number): AttributedLeg {
  const leg: AttributedLeg = {
    fillId: fill.fillId,
    sequence,
    exchange: fill.exchange,
    symbol: fill.symbol,
    side: fill.side,
    attributedQuantity: roundQuantity(attributedQuantity),
    priceUsd: fill.priceUsd,
    executedAt: fill.executedAt,
    allocatedFeeUsd: roundUsd(allocatedFeeUsd),
  };
  // Preserve absence for legacy/generic fills — optional correlation is only
  // present when the source fill carried it.
  if (fill.sourceOrderId !== undefined) (leg as any).sourceOrderId = fill.sourceOrderId;
  if (fill.sourceIntentId !== undefined) (leg as any).sourceIntentId = fill.sourceIntentId;
  return Object.freeze(leg);
}

// ─── Repair 2: fail-closed input validation ─────────────────────────────────

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TradeLifecycleValidationError(`${label} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

/** Repair 2 (item 2): canonical durability — the durable Paper ledger rounds USD
 *  values to 8 decimals and quantities to 12 decimals before storing, so any
 *  extra precision was never produced by the ledger. Fail closed. */
function requireCanonicalUsd(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || roundUsd(value) !== value) {
    throw new TradeLifecycleValidationError(`${label} must be a finite, canonically rounded (${USD_DECIMALS}-decimal) USD value, got ${String(value)}`);
  }
  return value;
}

function requireCanonicalQuantity(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || roundQuantity(value) !== value) {
    throw new TradeLifecycleValidationError(`${label} must be a finite, canonically rounded (${QUANTITY_DECIMALS}-decimal) quantity, got ${String(value)}`);
  }
  return value;
}

function validatePosition(p: PaperPosition, accountExchange: ExchangeId, seen: Set<string>): void {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new TradeLifecycleValidationError('position must be an object');
  }
  if (!isExchangeId(p.exchange)) {
    throw new TradeLifecycleValidationError(`position: invalid ExchangeId ${JSON.stringify(p.exchange)}`);
  }
  if (p.exchange !== accountExchange) {
    throw new TradeLifecycleValidationError(`position exchange ${p.exchange} != account exchange ${accountExchange}`);
  }
  if (typeof p.symbol !== 'string' || !p.symbol.trim()) {
    throw new TradeLifecycleValidationError(`position: bad symbol ${JSON.stringify(p.symbol)}`);
  }
  const key = positionKey(p.exchange, p.symbol);
  if (seen.has(key)) throw new TradeLifecycleValidationError(`duplicate position ${p.symbol}`);
  seen.add(key);
  if (p.direction !== 'long' && p.direction !== 'short') {
    throw new TradeLifecycleValidationError(`position: bad direction ${JSON.stringify(p.direction)}`);
  }
  requireCanonicalQuantity(p.signedQuantity, `position ${p.symbol} signedQuantity`);
  if (p.signedQuantity === 0) throw new TradeLifecycleValidationError(`position ${p.symbol}: signedQuantity=0`);
  if ((p.signedQuantity > 0) !== (p.direction === 'long')) {
    throw new TradeLifecycleValidationError(`position ${p.symbol}: direction ${p.direction} vs signed ${p.signedQuantity}`);
  }
  requireCanonicalUsd(p.averageEntryPriceUsd, `position ${p.symbol} averageEntryPriceUsd`);
  if (p.averageEntryPriceUsd <= 0) throw new TradeLifecycleValidationError(`position ${p.symbol}: averageEntryPriceUsd <= 0`);
  requireCanonicalUsd(p.markPriceUsd, `position ${p.symbol} markPriceUsd`);
  if (p.markPriceUsd <= 0) throw new TradeLifecycleValidationError(`position ${p.symbol}: markPriceUsd <= 0`);
  requireCanonicalUsd(p.marketValueUsd, `position ${p.symbol} marketValueUsd`);
  requireCanonicalUsd(p.unrealizedPnlUsd, `position ${p.symbol} unrealizedPnlUsd`);
  requireNonNegativeInteger(p.openedAt, `position ${p.symbol} openedAt`);
  requireNonNegativeInteger(p.updatedAt, `position ${p.symbol} updatedAt`);
  if (p.updatedAt < p.openedAt) throw new TradeLifecycleValidationError(`position ${p.symbol}: updatedAt < openedAt`);
}

function validateAccountSnapshot(account: PaperAccountSnapshot): void {
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    throw new TradeLifecycleValidationError('account snapshot must be an object');
  }
  if (typeof account.accountId !== 'string' || !ACCOUNT_ID_RE.test(account.accountId)) {
    throw new TradeLifecycleValidationError(`accountId must match ${ACCOUNT_ID_RE}, got ${JSON.stringify(account.accountId)}`);
  }
  if (!isExchangeId(account.exchange)) {
    throw new TradeLifecycleValidationError(`account: invalid ExchangeId ${JSON.stringify(account.exchange)}`);
  }
  requireCanonicalUsd(account.initialCashUsd, 'initialCashUsd');
  if (account.initialCashUsd <= 0) throw new TradeLifecycleValidationError(`initialCashUsd must be positive, got ${account.initialCashUsd}`);
  requireCanonicalUsd(account.cashUsd, 'cashUsd');
  requireCanonicalUsd(account.realizedPnlUsd, 'realizedPnlUsd');
  requireCanonicalUsd(account.unrealizedPnlUsd, 'unrealizedPnlUsd');
  requireCanonicalUsd(account.totalFeesUsd, 'totalFeesUsd');
  if (account.totalFeesUsd < 0) throw new TradeLifecycleValidationError(`totalFeesUsd must be non-negative, got ${account.totalFeesUsd}`);
  requireCanonicalUsd(account.equityUsd, 'equityUsd');
  requireCanonicalUsd(account.grossExposureUsd, 'grossExposureUsd');
  requireCanonicalUsd(account.netExposureUsd, 'netExposureUsd');
  requireNonNegativeInteger(account.openPositions, 'openPositions');
  requireNonNegativeInteger(account.processedFills, 'processedFills');
  requireNonNegativeInteger(account.sequence, 'sequence');
  requireNonNegativeInteger(account.updatedAt, 'updatedAt');
  if (!Array.isArray(account.positions)) {
    throw new TradeLifecycleValidationError('account.positions must be an array');
  }
  if (account.positions.length !== account.openPositions) {
    throw new TradeLifecycleValidationError(
      `account.openPositions ${account.openPositions} != positions.length ${account.positions.length}`,
    );
  }
  const seen = new Set<string>();
  for (const p of account.positions) validatePosition(p, account.exchange, seen);
}

/** Validate the fill shape (positive quantity/price, non-negative fee, integer
 *  timestamp, correlation pair consistency, valid exchange identity). Wraps the
 *  canonical Paper fill validator and re-throws as a typed lifecycle error. */
function validateLifecycleFill(raw: unknown): PaperFill {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TradeLifecycleValidationError('fill entry is missing its fill');
  }
  const fill = raw as PaperFill;
  if (!isExchangeId(fill.exchange)) {
    throw new TradeLifecycleValidationError(`fill: invalid ExchangeId ${JSON.stringify(fill.exchange)}`);
  }
  let validated: PaperFill;
  try {
    validated = validatePaperFill(fill);
  } catch (e) {
    throw new TradeLifecycleValidationError(`invalid fill: ${(e as Error).message}`);
  }
  // Repair 2 (item 2): the durable ledger canonicalizes quantity to 12 decimals
  // and price/fee to 8 decimals before storing; reject non-canonical values.
  requireCanonicalQuantity(validated.quantity, `fill ${validated.fillId} quantity`);
  requireCanonicalUsd(validated.priceUsd, `fill ${validated.fillId} priceUsd`);
  requireCanonicalUsd(validated.feeUsd, `fill ${validated.fillId} feeUsd`);
  return validated;
}

// ─── Incarnation state ──────────────────────────────────────────────────────

interface IncState {
  exchange: ExchangeId;
  symbol: string;
  side: 'long' | 'short';
  /** Current open signed quantity (positive = long, negative = short). */
  signedQuantity: number;
  entryQuantity: number;
  exitQuantity: number;
  /** Whole-incarnation total entry notional (sum of entry-leg qty*price). */
  entryNotionalUsd: number;
  /** Current open-position cost basis (matching/reconciliation + gross). */
  costBasisPriceUsd: number;
  grossRealizedPnlUsd: number;
  /** Sum of all leg fees attributed to this incarnation. */
  allocatedFeesUsd: number;
  openedAt: number;
  lastExitAt: number;
  exitPriceWeighted: number;
  openingSequence: number;
  openingFillId: string;
  closed: boolean;
  legs: AttributedLeg[];
}

function newIncarnation(fill: PaperFill, sequence: number, side: 'long' | 'short', signedQuantity: number, entryFeeUsd: number): IncState {
  return {
    exchange: fill.exchange,
    symbol: fill.symbol,
    side,
    signedQuantity: roundQuantity(signedQuantity),
    entryQuantity: roundQuantity(Math.abs(signedQuantity)),
    exitQuantity: 0,
    entryNotionalUsd: roundUsd(Math.abs(signedQuantity) * fill.priceUsd),
    costBasisPriceUsd: roundUsd(fill.priceUsd),
    grossRealizedPnlUsd: 0,
    allocatedFeesUsd: roundUsd(entryFeeUsd),
    openedAt: fill.executedAt,
    lastExitAt: 0,
    exitPriceWeighted: 0,
    openingSequence: sequence,
    openingFillId: fill.fillId,
    closed: false,
    legs: [makeLeg(fill, sequence, Math.abs(signedQuantity), entryFeeUsd)],
  };
}

/** Python `standard_profit_factor` semantics over closed-trade net PnL amounts. */
function standardProfitFactor(netPnls: readonly number[]): number {
  if (netPnls.length === 0) return 0.0;
  let wins = 0;
  let losses = 0;
  for (const n of netPnls) {
    if (n > 0) wins += n;
    else if (n < 0) losses += Math.abs(n);
  }
  if (wins === 0) return 0.0;              // loss-only or all break-even
  if (losses === 0) return WIN_ONLY_PROFIT_FACTOR_SENTINEL; // win-only
  return wins / losses;
}

/** Repair 2 (item 1 + item 4): the projected remaining open positions must
 *  reconcile with account.positions on identity, signed quantity, and CURRENT
 *  cost basis — NOT the whole-incarnation published average entry, which
 *  diverges from the cost basis after a partial close then scale-in. */
function reconcileOpenPositions(openByKey: ReadonlyMap<string, IncState>, account: PaperAccountSnapshot): void {
  if (openByKey.size !== account.positions.length) {
    throw new TradeLifecyclePositionReconciliationError(
      `projected ${openByKey.size} open positions != account ${account.positions.length}`,
    );
  }
  for (const p of account.positions) {
    const key = positionKey(p.exchange, p.symbol);
    const state = openByKey.get(key);
    if (!state) throw new TradeLifecyclePositionReconciliationError(`no open trade for position ${p.symbol}`);
    if (state.side !== p.direction) {
      throw new TradeLifecyclePositionReconciliationError(
        `position ${p.symbol}: side ${state.side} != direction ${p.direction}`,
      );
    }
    if (Math.abs(state.signedQuantity - p.signedQuantity) > QUANTITY_EPSILON) {
      throw new TradeLifecyclePositionReconciliationError(
        `position ${p.symbol}: projected signed ${state.signedQuantity} != account ${p.signedQuantity}`,
      );
    }
    if (Math.abs(state.costBasisPriceUsd - p.averageEntryPriceUsd) > ACCOUNTING_EPSILON) {
      throw new TradeLifecyclePositionReconciliationError(
        `position ${p.symbol}: projected cost basis ${state.costBasisPriceUsd} != account ${p.averageEntryPriceUsd}`,
      );
    }
  }
}

export function computeTradeLifecycle(input: TradeLifecycleInput): TradeLifecycle {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TradeLifecycleValidationError('lifecycle input must be an object');
  }
  const { account } = input;
  const fills = input.fills;

  validateAccountSnapshot(account);
  if (!Array.isArray(fills)) throw new TradeLifecycleValidationError('fills must be an array');

  if (fills.length !== account.processedFills) {
    throw new TradeLifecycleReconciliationError(
      `fill history length ${fills.length} does not account for account.processedFills ${account.processedFills}`,
    );
  }

  const openByKey = new Map<string, IncState>();
  const incarnations: IncState[] = [];
  const seenFillIds = new Set<string>();
  const lastExecutedAtBySymbol = new Map<string, number>();

  let prevSequence = 0;
  for (const entry of fills) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || (entry as any).type !== 'fill') {
      throw new TradeLifecycleValidationError(`fill entry must have type fill, got ${JSON.stringify((entry as any)?.type)}`);
    }
    const sequence = entry.sequence;
    if (!Number.isInteger(sequence) || sequence <= 0) {
      throw new TradeLifecycleSequenceError(`ledger sequence must be a positive integer, got ${sequence}`);
    }
    if (sequence > account.sequence) {
      throw new TradeLifecycleReconciliationError(
        `fill sequence ${sequence} exceeds account.sequence ${account.sequence}`,
      );
    }
    if (sequence <= prevSequence) {
      throw new TradeLifecycleSequenceError(`non-increasing ledger sequence: ${sequence} after ${prevSequence}`);
    }
    prevSequence = sequence;

    const fill = validateLifecycleFill(entry.fill);
    if (seenFillIds.has(fill.fillId)) {
      throw new TradeLifecycleDuplicateFillIdError(`duplicate fill id ${fill.fillId}`);
    }
    seenFillIds.add(fill.fillId);

    if (fill.exchange !== account.exchange) {
      throw new TradeLifecycleExchangeMismatchError(
        `fill exchange ${fill.exchange} does not match account exchange ${account.exchange}`,
      );
    }

    const lastExec = lastExecutedAtBySymbol.get(fill.symbol);
    if (lastExec !== undefined && fill.executedAt < lastExec) {
      throw new TradeLifecycleTimeRegressionError(
        `symbol ${fill.symbol}: executedAt ${fill.executedAt} regresses before ${lastExec}`,
      );
    }
    lastExecutedAtBySymbol.set(fill.symbol, fill.executedAt);

    const key = positionKey(fill.exchange, fill.symbol);
    const state = openByKey.get(key) ?? null;

    if (state === null) {
      const side: 'long' | 'short' = fill.side === 'buy' ? 'long' : 'short';
      const signed = side === 'long' ? fill.quantity : -fill.quantity;
      openByKey.set(key, newIncarnation(fill, sequence, side, signed, fill.feeUsd));
      continue;
    }

    const sameSide = (fill.side === 'buy') === (state.side === 'long');
    if (sameSide) {
      const oldAbs = Math.abs(state.signedQuantity);
      const newAbs = oldAbs + fill.quantity;
      state.costBasisPriceUsd = roundUsd(
        (oldAbs * state.costBasisPriceUsd + fill.quantity * fill.priceUsd) / newAbs,
      );
      state.signedQuantity = roundQuantity(state.side === 'long' ? newAbs : -newAbs);
      state.entryQuantity = roundQuantity(state.entryQuantity + fill.quantity);
      state.entryNotionalUsd = roundUsd(state.entryNotionalUsd + fill.quantity * fill.priceUsd);
      state.allocatedFeesUsd = roundUsd(state.allocatedFeesUsd + fill.feeUsd);
      state.legs.push(makeLeg(fill, sequence, fill.quantity, fill.feeUsd));
      continue;
    }

    const oldAbs = Math.abs(state.signedQuantity);
    const qty = fill.quantity;
    const closeQty = Math.min(qty, oldAbs);

    const gross = state.side === 'long'
      ? (fill.priceUsd - state.costBasisPriceUsd) * closeQty
      : (state.costBasisPriceUsd - fill.priceUsd) * closeQty;
    state.grossRealizedPnlUsd = roundUsd(state.grossRealizedPnlUsd + gross);
    state.exitQuantity = roundQuantity(state.exitQuantity + closeQty);
    state.exitPriceWeighted = roundUsd(state.exitPriceWeighted + fill.priceUsd * closeQty);
    state.lastExitAt = fill.executedAt;

    const closeLegFee = qty <= oldAbs ? fill.feeUsd : roundUsd(fill.feeUsd * (oldAbs / qty));
    state.allocatedFeesUsd = roundUsd(state.allocatedFeesUsd + closeLegFee);
    state.legs.push(makeLeg(fill, sequence, closeQty, closeLegFee));

    if (qty < oldAbs) {
      const rem = roundQuantity(oldAbs - qty);
      state.signedQuantity = roundQuantity(state.side === 'long' ? rem : -rem);
    } else if (qty === oldAbs) {
      state.closed = true;
      openByKey.delete(key);
      incarnations.push(state);
    } else {
      state.closed = true;
      openByKey.delete(key);
      incarnations.push(state);

      const newQty = roundQuantity(qty - oldAbs);
      const newSide: 'long' | 'short' = state.side === 'long' ? 'short' : 'long';
      const residualEntryFee = roundUsd(fill.feeUsd - closeLegFee);
      const fresh = newIncarnation(fill, sequence, newSide, newSide === 'long' ? newQty : -newQty, residualEntryFee);
      openByKey.set(key, fresh);
    }
  }

  for (const [, state] of openByKey) incarnations.push(state);

  const trades: TradeIncarnation[] = incarnations
    .sort((a, b) => a.openingSequence - b.openingSequence)
    .map((st) => {
      const closed = st.closed;
      const averageEntryPriceUsd = st.entryQuantity > 0
        ? roundUsd(st.entryNotionalUsd / st.entryQuantity)
        : roundUsd(0);
      const averageExitPriceUsd = st.exitQuantity > 0
        ? roundUsd(st.exitPriceWeighted / st.exitQuantity)
        : null;
      const holdingDurationMs = closed ? st.lastExitAt - st.openedAt : null;
      if (holdingDurationMs !== null && holdingDurationMs < 0) {
        throw new TradeLifecycleTimeRegressionError(
          `trade ${st.symbol}: negative holding duration ${holdingDurationMs}`,
        );
      }
      return Object.freeze({
        tradeId: makeTradeId(account.accountId, st.exchange, st.symbol, st.openingSequence, st.openingFillId),
        exchange: st.exchange,
        symbol: st.symbol,
        side: st.side,
        status: closed ? 'closed' : 'open',
        entryQuantity: st.entryQuantity,
        exitQuantity: st.exitQuantity,
        openQuantity: roundQuantity(st.entryQuantity - st.exitQuantity),
        averageEntryPriceUsd,
        averageExitPriceUsd,
        grossRealizedPnlUsd: st.grossRealizedPnlUsd,
        allocatedFeesUsd: st.allocatedFeesUsd,
        netPnlUsd: roundUsd(st.grossRealizedPnlUsd - st.allocatedFeesUsd),
        openedAt: st.openedAt,
        closedAt: closed ? st.lastExitAt : null,
        holdingDurationMs,
        legs: Object.freeze(st.legs),
      } satisfies TradeIncarnation);
    });

  const grossRealizedPnlUsd = roundUsd(trades.reduce((s, t) => s + t.grossRealizedPnlUsd, 0));
  const allocatedFeesUsd = roundUsd(trades.reduce((s, t) => s + t.allocatedFeesUsd, 0));
  const netPnlUsd = roundUsd(grossRealizedPnlUsd - allocatedFeesUsd);

  if (!Number.isFinite(grossRealizedPnlUsd) || !Number.isFinite(allocatedFeesUsd) || !Number.isFinite(netPnlUsd)) {
    throw new TradeLifecycleValidationError('projection produced a non-finite aggregate');
  }

  if (Math.abs(allocatedFeesUsd - account.totalFeesUsd) > ACCOUNTING_EPSILON) {
    throw new TradeLifecycleReconciliationError(
      `allocated fees ${allocatedFeesUsd} != canonical totalFeesUsd ${account.totalFeesUsd}`,
    );
  }
  if (Math.abs(netPnlUsd - account.realizedPnlUsd) > ACCOUNTING_EPSILON) {
    throw new TradeLifecycleReconciliationError(
      `projected realized ${netPnlUsd} != canonical realizedPnlUsd ${account.realizedPnlUsd}`,
    );
  }

  reconcileOpenPositions(openByKey, account);

  const closedTrades = trades.filter((t) => t.status === 'closed');
  let winningTrades = 0;
  let losingTrades = 0;
  let breakEvenTrades = 0;
  for (const t of closedTrades) {
    if (t.netPnlUsd > 0) winningTrades += 1;
    else if (t.netPnlUsd < 0) losingTrades += 1;
    else breakEvenTrades += 1;
  }
  const profitFactor = standardProfitFactor(closedTrades.map((t) => t.netPnlUsd));

  return Object.freeze({
    accountId: account.accountId,
    exchange: account.exchange,
    sourceLedgerSequence: account.sequence,
    sourceLedgerUpdatedAt: account.updatedAt,
    trades: Object.freeze(trades),
    grossRealizedPnlUsd,
    totalFeesUsd: account.totalFeesUsd,
    realizedPnlUsd: account.realizedPnlUsd,
    netPnlUsd,
    closedTrades: closedTrades.length,
    winningTrades,
    losingTrades,
    breakEvenTrades,
    profitFactor,
  } satisfies TradeLifecycle);
}
