// Stage 3B4C8-R2: Complete atomic commit + full accounting invariants.
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { PaperFill } from '../types/paper-fill';
import { validatePaperFill } from '../types/paper-fill';
import type {
  PaperAccountConfig, PaperPosition, PaperAccountSnapshot,
  PaperLedgerEntry, PaperFillLedgerEntry, PaperMarkLedgerEntry,
} from '../types/paper-account';
import { validatePaperAccountConfig, canonicalizePaperAccountConfig } from '../types/paper-account';
import {
  roundUsd, roundQuantity, normalizeZero, assertFinitePositive,
  assertAccountingInvariant, ACCOUNTING_EPSILON, QUANTITY_EPSILON,
} from './PaperLedgerMath';
import {
  DuplicateFillConflictError, StalePaperLedgerEventError, ConflictingMarkError,
  PaperLedgerInvariantError, PaperLedgerValidationError, PaperLedgerExchangeMismatchError,
  PaperLedgerCorruptionError,
} from './errors';

// ═══ Canonicalization ═══════════════════════════════════════════
function canonicalizeFill(f: PaperFill): PaperFill {
  const validated = validatePaperFill(f);
  const qty = roundQuantity(validated.quantity);
  const price = roundUsd(validated.priceUsd);
  const fee = roundUsd(validated.feeUsd);
  if (!Number.isFinite(qty) || qty <= 0)
    throw new PaperLedgerValidationError(`quantity ${qty} after canonicalization — rejected`);
  if (!Number.isFinite(price) || price <= 0)
    throw new PaperLedgerValidationError(`priceUsd ${price} after canonicalization — rejected`);
  if (!Number.isFinite(fee) || fee < 0)
    throw new PaperLedgerValidationError(`feeUsd ${fee} after canonicalization — rejected`);
  return {
    fillId: validated.fillId, exchange: validated.exchange, symbol: validated.symbol,
    side: validated.side, quantity: qty, priceUsd: price, feeUsd: fee, executedAt: validated.executedAt,
    sourceOrderId: validated.sourceOrderId, sourceIntentId: validated.sourceIntentId,
    executionReferencePriceUsd: validated.executionReferencePriceUsd,
  };
}

function fillsEqual(a: PaperFill, b: PaperFill): boolean {
  return a.fillId === b.fillId && a.exchange === b.exchange && a.symbol === b.symbol &&
    a.side === b.side && a.quantity === b.quantity && a.priceUsd === b.priceUsd &&
    a.feeUsd === b.feeUsd && a.executedAt === b.executedAt &&
    a.sourceOrderId === b.sourceOrderId && a.sourceIntentId === b.sourceIntentId &&
    a.executionReferencePriceUsd === b.executionReferencePriceUsd;
}

// ═══ Deep clone ════════════════════════════════════════════════
function cloneConfig(c: PaperAccountConfig): PaperAccountConfig {
  return { accountId: c.accountId, exchange: c.exchange, initialCashUsd: c.initialCashUsd };
}
function clonePosition(p: PaperPosition): PaperPosition { return { ...p }; }
function cloneFill(f: PaperFill): PaperFill {
  return { fillId: f.fillId, exchange: f.exchange, symbol: f.symbol,
    side: f.side, quantity: f.quantity, priceUsd: f.priceUsd, feeUsd: f.feeUsd, executedAt: f.executedAt,
    sourceOrderId: f.sourceOrderId, sourceIntentId: f.sourceIntentId,
    executionReferencePriceUsd: f.executionReferencePriceUsd };
}
function cloneEntry(e: PaperLedgerEntry): PaperLedgerEntry {
  if (e.type === 'fill') return { type: 'fill', sequence: e.sequence, fill: cloneFill(e.fill) };
  return { type: 'mark', sequence: e.sequence, exchange: e.exchange, symbol: e.symbol, markPriceUsd: e.markPriceUsd, markedAt: e.markedAt };
}

// ═══ Ledger state ═══════════════════════════════════════════════
interface LedgerState {
  config: PaperAccountConfig;
  cashUsd: number; realizedPnlUsd: number; unrealizedPnlUsd: number; totalFeesUsd: number;
  positions: Map<string, PaperPosition>; entries: PaperLedgerEntry[];
  processedFillIds: Map<string, PaperFill>; sequence: number; updatedAt: number;
  lastEventAt: Map<string, number>;
}

function cloneState(s: LedgerState): LedgerState {
  const p = new Map<string, PaperPosition>(); for (const [k, v] of s.positions) p.set(k, clonePosition(v));
  const fids = new Map<string, PaperFill>(); for (const [k, v] of s.processedFillIds) fids.set(k, cloneFill(v));
  return { config: cloneConfig(s.config), cashUsd: s.cashUsd, realizedPnlUsd: s.realizedPnlUsd,
    unrealizedPnlUsd: s.unrealizedPnlUsd, totalFeesUsd: s.totalFeesUsd, positions: p,
    entries: s.entries.map(cloneEntry), processedFillIds: fids, sequence: s.sequence,
    updatedAt: s.updatedAt, lastEventAt: new Map(s.lastEventAt) };
}

// ═══ Accounting math ════════════════════════════════════════════
function positionUnrealizedPnl(p: PaperPosition): number {
  const absQty = Math.abs(p.signedQuantity);
  return p.direction === 'long'
    ? roundUsd((p.markPriceUsd - p.averageEntryPriceUsd) * absQty)
    : roundUsd((p.averageEntryPriceUsd - p.markPriceUsd) * absQty);
}
function positionMarketValue(p: PaperPosition): number { return roundUsd(p.signedQuantity * p.markPriceUsd); }

function recalcAllUnrealized(st: LedgerState): void {
  let total = 0;
  for (const [, p] of st.positions) {
    p.unrealizedPnlUsd = positionUnrealizedPnl(p);
    p.marketValueUsd = positionMarketValue(p);
    total += p.unrealizedPnlUsd;
  }
  st.unrealizedPnlUsd = roundUsd(total);
}

// ═══ Full state verification (R2) ═══════════════════════════════
function verifyFullState(s: LedgerState): void {
  const { config } = s;
  // Account fields
  if (!Number.isFinite(s.cashUsd)) throw new PaperLedgerInvariantError('cashUsd not finite');
  if (!Number.isFinite(s.realizedPnlUsd)) throw new PaperLedgerInvariantError('realizedPnlUsd not finite');
  if (!Number.isFinite(s.unrealizedPnlUsd)) throw new PaperLedgerInvariantError('unrealizedPnlUsd not finite');
  if (!Number.isFinite(s.totalFeesUsd) || s.totalFeesUsd < 0) throw new PaperLedgerInvariantError(`totalFeesUsd=${s.totalFeesUsd}`);
  if (!Number.isInteger(s.sequence) || s.sequence < 0) throw new PaperLedgerInvariantError(`sequence=${s.sequence}`);
  if (!Number.isInteger(s.updatedAt) || s.updatedAt < 0) throw new PaperLedgerInvariantError(`updatedAt=${s.updatedAt}`);

  // Per-position
  let netExposure = 0, grossExposure = 0;
  const seen = new Set<string>();
  for (const [sym, p] of s.positions) {
    if (seen.has(sym)) throw new PaperLedgerInvariantError(`duplicate position: ${sym}`);
    seen.add(sym);
    if (p.exchange !== config.exchange) throw new PaperLedgerInvariantError(`${sym}: exchange mismatch`);
    if (!p.symbol || typeof p.symbol !== 'string') throw new PaperLedgerInvariantError(`${sym}: bad symbol`);
    if (!Number.isFinite(p.signedQuantity)) throw new PaperLedgerInvariantError(`${sym}: signedQuantity NaN/Inf`);
    if (p.signedQuantity === 0) throw new PaperLedgerInvariantError(`${sym}: signedQuantity=0`);
    if (Math.abs(p.signedQuantity) < QUANTITY_EPSILON) throw new PaperLedgerInvariantError(`${sym}: quantity below epsilon`);
    const expectedDir = p.signedQuantity > 0 ? 'long' : 'short';
    if (p.direction !== expectedDir) throw new PaperLedgerInvariantError(`${sym}: direction ${p.direction} vs signed ${p.signedQuantity}`);
    if (!Number.isFinite(p.averageEntryPriceUsd) || p.averageEntryPriceUsd <= 0) throw new PaperLedgerInvariantError(`${sym}: avgEntry ${p.averageEntryPriceUsd}`);
    if (!Number.isFinite(p.markPriceUsd) || p.markPriceUsd <= 0) throw new PaperLedgerInvariantError(`${sym}: markPrice ${p.markPriceUsd}`);
    if (!Number.isInteger(p.openedAt) || p.openedAt < 0 || !Number.isInteger(p.updatedAt) || p.updatedAt < 0)
      throw new PaperLedgerInvariantError(`${sym}: times invalid`);
    if (p.updatedAt < p.openedAt) throw new PaperLedgerInvariantError(`${sym}: updatedAt < openedAt`);
    // Derived field verification
    const expMv = roundUsd(p.signedQuantity * p.markPriceUsd);
    if (p.marketValueUsd !== expMv) throw new PaperLedgerInvariantError(`${sym}: marketValueUsd=${p.marketValueUsd} expected=${expMv}`);
    const expUp = p.direction === 'long'
      ? roundUsd((p.markPriceUsd - p.averageEntryPriceUsd) * Math.abs(p.signedQuantity))
      : roundUsd((p.averageEntryPriceUsd - p.markPriceUsd) * Math.abs(p.signedQuantity));
    if (p.unrealizedPnlUsd !== expUp) throw new PaperLedgerInvariantError(`${sym}: unrealizedPnlUsd=${p.unrealizedPnlUsd} expected=${expUp}`);
    netExposure += p.marketValueUsd; grossExposure += Math.abs(p.marketValueUsd);
  }
  netExposure = roundUsd(netExposure);
  grossExposure = roundUsd(grossExposure);

  // Unrealized total
  const totalUnreal = roundUsd(Array.from(s.positions.values()).reduce((s, p) => s + p.unrealizedPnlUsd, 0));
  if (s.unrealizedPnlUsd !== totalUnreal) throw new PaperLedgerInvariantError(`unrealizedPnlUsd=${s.unrealizedPnlUsd} vs sum=${totalUnreal}`);

  // Equity equation
  const eqFromBalance = roundUsd(s.cashUsd + netExposure);
  const eqFromPnl = roundUsd(config.initialCashUsd + s.realizedPnlUsd + s.unrealizedPnlUsd);
  assertAccountingInvariant(eqFromBalance, eqFromPnl, 'equity equation');

  // Event metadata
  if (s.entries.length !== s.sequence) throw new PaperLedgerInvariantError(`entries=${s.entries.length} vs seq=${s.sequence}`);
  let fillCount = 0;
  for (let i = 0; i < s.entries.length; i++) {
    const e = s.entries[i];
    if (e.sequence !== i + 1) throw new PaperLedgerInvariantError(`entry seq=${e.sequence} expected=${i + 1}`);
    if (e.type === 'fill') {
      fillCount++;
      if (!s.processedFillIds.has(e.fill.fillId)) throw new PaperLedgerInvariantError(`fill entry ${e.fill.fillId} not in processed`);
      if (!fillsEqual(e.fill, s.processedFillIds.get(e.fill.fillId)!)) throw new PaperLedgerInvariantError(`fill ${e.fill.fillId} canonical mismatch`);
    } else if (e.type === 'mark') {
      // ok
    } else {
      throw new PaperLedgerInvariantError(`unknown entry type: ${(e as any).type}`);
    }
  }
  if (fillCount !== s.processedFillIds.size) throw new PaperLedgerInvariantError(`fill entries=${fillCount} vs processed=${s.processedFillIds.size}`);
  // lastEventAt consistency
  for (const [sym, time] of s.lastEventAt) {
    const latestEntry = [...s.entries].reverse().find(e => {
      if (e.type === 'mark' && (e as PaperMarkLedgerEntry).symbol === sym) return true;
      if (e.type === 'fill' && e.fill.symbol === sym) return true;
      return false;
    });
    if (latestEntry) {
      const entryTime = latestEntry.type === 'fill' ? latestEntry.fill.executedAt : (latestEntry as PaperMarkLedgerEntry).markedAt;
      if (entryTime !== time) throw new PaperLedgerInvariantError(`${sym}: lastEventAt=${time} vs entry=${entryTime}`);
    }
  }
}

// ═══ Fill application ═══════════════════════════════════════════
function applyFillToState(s: LedgerState, fill: PaperFill): void {
  const { quantity: qty, priceUsd: price, feeUsd: fee, side } = fill;
  s.totalFeesUsd = roundUsd(s.totalFeesUsd + fee);
  s.cashUsd = roundUsd(s.cashUsd + (side === 'buy' ? -(qty * price + fee) : (qty * price - fee)));
  const pos = s.positions.get(fill.symbol) ?? null;
  const oldSigned = pos?.signedQuantity ?? 0;
  const oldAvg = pos?.averageEntryPriceUsd ?? 0;

  if (oldSigned === 0) {
    s.positions.set(fill.symbol, { exchange: fill.exchange, symbol: fill.symbol,
      direction: side === 'buy' ? 'long' : 'short', signedQuantity: roundQuantity(side === 'buy' ? qty : -qty),
      averageEntryPriceUsd: price, markPriceUsd: price, marketValueUsd: 0, unrealizedPnlUsd: 0,
      openedAt: fill.executedAt, updatedAt: fill.executedAt });
    s.realizedPnlUsd = roundUsd(s.realizedPnlUsd - fee);
  } else if ((side === 'buy' && oldSigned > 0) || (side === 'sell' && oldSigned < 0)) {
    const oldAbs = Math.abs(oldSigned);
    const newAbs = oldAbs + qty;
    pos!.averageEntryPriceUsd = roundUsd((oldAbs * oldAvg + qty * price) / newAbs);
    pos!.signedQuantity = roundQuantity(oldSigned > 0 ? newAbs : -newAbs);
    pos!.markPriceUsd = price; pos!.updatedAt = fill.executedAt;
    s.realizedPnlUsd = roundUsd(s.realizedPnlUsd - fee);
  } else {
    const oldAbs = Math.abs(oldSigned);
    if (qty <= oldAbs) {
      s.realizedPnlUsd = roundUsd(s.realizedPnlUsd + (oldSigned > 0 ? (price - oldAvg) * qty : (oldAvg - price) * qty) - fee);
      const rem = roundQuantity(oldAbs - qty);
      if (normalizeZero(rem, QUANTITY_EPSILON) === 0) { s.positions.delete(fill.symbol); }
      else { pos!.signedQuantity = roundQuantity(oldSigned > 0 ? rem : -rem); pos!.markPriceUsd = price; pos!.updatedAt = fill.executedAt; }
    } else {
      const closeQty = oldAbs; const newQty = roundQuantity(qty - oldAbs);
      const rg = oldSigned > 0 ? (price - oldAvg) * closeQty : (oldAvg - price) * closeQty;
      s.realizedPnlUsd = roundUsd(s.realizedPnlUsd + rg - fee);
      s.positions.delete(fill.symbol);
      if (normalizeZero(newQty, QUANTITY_EPSILON) > 0) {
        const nd = side === 'buy' ? 'long' as const : 'short' as const;
        s.positions.set(fill.symbol, { exchange: fill.exchange, symbol: fill.symbol, direction: nd,
          signedQuantity: roundQuantity(side === 'buy' ? newQty : -newQty), averageEntryPriceUsd: price,
          markPriceUsd: price, marketValueUsd: 0, unrealizedPnlUsd: 0,
          openedAt: fill.executedAt, updatedAt: fill.executedAt });
      }
    }
  }
}

// ═══ PaperAccountLedger ═════════════════════════════════════════
export class PaperAccountLedger {
  private state: LedgerState;

  constructor(config: PaperAccountConfig) {
    const c = canonicalizePaperAccountConfig(config);
    this.state = {
      config: c, cashUsd: c.initialCashUsd, realizedPnlUsd: 0, unrealizedPnlUsd: 0, totalFeesUsd: 0,
      positions: new Map(), entries: [], processedFillIds: new Map(),
      sequence: 0, updatedAt: 0, lastEventAt: new Map(),
    };
  }

  getConfig(): PaperAccountConfig { return cloneConfig(this.state.config); }
  snapshot(): PaperAccountSnapshot { return buildSnapshot(this.state); }
  entries(): readonly PaperLedgerEntry[] { return this.state.entries.map(cloneEntry); }
  hasProcessedFill(fillId: string): boolean { return this.state.processedFillIds.has(fillId); }
  getPosition(symbol: string): PaperPosition | null {
    const p = this.state.positions.get(symbol);
    return p ? clonePosition(p) : null;
  }

  /** R2: Complete atomic commit — ALL mutations on candidate, single state swap. */
  applyFill(fill: PaperFill): { status: 'applied' | 'duplicate'; snapshot: PaperAccountSnapshot } {
    const raw = validatePaperFill(fill);
    if (!isExchangeId(raw.exchange)) throw new PaperLedgerValidationError(`invalid ExchangeId ${JSON.stringify(raw.exchange)}`);
    this.assertExchangeMatch(raw.exchange);
    const canonical = canonicalizeFill(raw);

    const existing = this.state.processedFillIds.get(canonical.fillId);
    if (existing) {
      if (fillsEqual(existing, canonical)) return { status: 'duplicate', snapshot: this.snapshot() };
      throw new DuplicateFillConflictError(`fillId ${canonical.fillId}: conflict`);
    }
    this.assertTimeOrder(canonical.symbol, canonical.executedAt);

    // Clone → compute ALL on candidate
    const c = cloneState(this.state);
    applyFillToState(c, canonical);
    recalcAllUnrealized(c);
    c.processedFillIds.set(canonical.fillId, canonical);
    c.sequence += 1;
    c.updatedAt = Math.max(c.updatedAt, canonical.executedAt);
    c.lastEventAt.set(canonical.symbol, canonical.executedAt);
    c.entries.push({ type: 'fill', sequence: c.sequence, fill: canonical });

    // Single atomic swap
    try { verifyFullState(c); } catch (e) {
      throw new PaperLedgerInvariantError(`fill ${canonical.fillId}: ${(e as Error).message}`);
    }
    this.state = c;
    return { status: 'applied', snapshot: this.snapshot() };
  }

  /** R2: Complete atomic commit for mark. */
  markToMarket(input: { exchange: ExchangeId; symbol: string; markPriceUsd: number; markedAt: number }): { status: 'applied' | 'duplicate'; snapshot: PaperAccountSnapshot } {
    const { exchange, symbol, markedAt } = input;
    const rawPrice = roundUsd(input.markPriceUsd);
    if (!isExchangeId(exchange)) throw new PaperLedgerValidationError(`mark: invalid ExchangeId`);
    this.assertExchangeMatch(exchange);
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) throw new PaperLedgerValidationError(`markPriceUsd=${rawPrice}`);
    if (!Number.isInteger(markedAt) || markedAt < 0) throw new PaperLedgerValidationError(`markedAt=${markedAt}`);

    const pos = this.state.positions.get(symbol);
    if (!pos) throw new PaperLedgerValidationError(`mark: no position for ${symbol}`);
    const lastTime = this.state.lastEventAt.get(symbol) ?? 0;
    if (markedAt < lastTime) throw new StalePaperLedgerEventError(`mark stale: ${symbol} ${markedAt} < ${lastTime}`);
    if (markedAt === lastTime) {
      if (pos.markPriceUsd === rawPrice) return { status: 'duplicate', snapshot: this.snapshot() };
      throw new ConflictingMarkError(`mark conflict: ${symbol}@${markedAt}: current ${pos.markPriceUsd} vs ${rawPrice}`);
    }

    // Clone → compute ALL on candidate
    const c = cloneState(this.state);
    const cpos = c.positions.get(symbol)!;
    cpos.markPriceUsd = rawPrice; cpos.updatedAt = markedAt;
    recalcAllUnrealized(c);
    c.sequence += 1;
    c.updatedAt = Math.max(c.updatedAt, markedAt);
    c.lastEventAt.set(symbol, markedAt);
    c.entries.push({ type: 'mark', sequence: c.sequence, exchange, symbol, markPriceUsd: rawPrice, markedAt });

    try { verifyFullState(c); } catch (e) {
      throw new PaperLedgerInvariantError(`mark ${symbol}@${markedAt}: ${(e as Error).message}`);
    }
    this.state = c;
    return { status: 'applied', snapshot: this.snapshot() };
  }

  /** R2: Atomic replay with corruption boundary. */
  replay(entries: readonly PaperLedgerEntry[]): void {
    if (!Array.isArray(entries)) throw new PaperLedgerCorruptionError('entries must be an array');
    const temp = new PaperAccountLedger(this.state.config);
    let expectedSeq = 0;
    for (const e of entries) {
      expectedSeq += 1;
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw corruption(`expected seq ${expectedSeq}: invalid entry`);
      if (e.sequence !== expectedSeq) throw corruption(`expected seq ${expectedSeq}, got ${e.sequence}`);
      try {
        if (e.type === 'fill') {
          temp.applyFill(e.fill ?? corruption(`fill entry seq ${e.sequence} missing fill`) as any);
        } else if (e.type === 'mark') {
          const m = e as PaperMarkLedgerEntry;
          if (!m.symbol || !Number.isFinite(m.markPriceUsd)) throw corruption(`malformed mark seq ${e.sequence}`);
          temp.markToMarket({ exchange: m.exchange, symbol: m.symbol, markPriceUsd: m.markPriceUsd, markedAt: m.markedAt });
        } else {
          throw corruption(`unknown type ${(e as any).type}`);
        }
      } catch (err: any) {
        if (err instanceof PaperLedgerCorruptionError) throw err;
        throw corruption(`seq ${e.sequence}: ${err?.message ?? String(err)}`);
      }
    }
    try { verifyFullState(temp.state); } catch (e) {
      throw corruption(`replay final state: ${(e as Error).message}`);
    }
    if (temp.state.entries.length !== entries.length) throw corruption('entry count mismatch');
    this.state = temp.state;
  }

  static fromEntries(config: PaperAccountConfig, entries: readonly PaperLedgerEntry[]): PaperAccountLedger {
    const ledger = new PaperAccountLedger(config);
    ledger.replay(entries);
    return ledger;
  }

  private assertExchangeMatch(exchange: ExchangeId): void {
    if (exchange !== this.state.config.exchange)
      throw new PaperLedgerExchangeMismatchError(`exchange: ${JSON.stringify(exchange)} vs ${this.state.config.exchange}`);
  }
  private assertTimeOrder(symbol: string, time: number): void {
    const last = this.state.lastEventAt.get(symbol);
    if (last != null && time < last) throw new StalePaperLedgerEventError(`${symbol}: time ${time} < ${last}`);
  }
}

function corruption(msg: string): PaperLedgerCorruptionError { return new PaperLedgerCorruptionError(`replay: ${msg}`); }

// ═══ Snapshot builder ═══════════════════════════════════════════
function buildSnapshot(s: LedgerState): PaperAccountSnapshot {
  const positions: PaperPosition[] = [];
  for (const p of s.positions.values()) positions.push(clonePosition(p));
  const gross = roundUsd(positions.reduce((sum, p) => sum + Math.abs(p.marketValueUsd), 0));
  const net = roundUsd(positions.reduce((sum, p) => sum + p.marketValueUsd, 0));
  return {
    accountId: s.config.accountId, exchange: s.config.exchange,
    initialCashUsd: s.config.initialCashUsd, cashUsd: s.cashUsd,
    realizedPnlUsd: s.realizedPnlUsd, unrealizedPnlUsd: s.unrealizedPnlUsd, totalFeesUsd: s.totalFeesUsd,
    equityUsd: roundUsd(s.cashUsd + net), grossExposureUsd: gross, netExposureUsd: net,
    openPositions: s.positions.size, processedFills: s.processedFillIds.size,
    sequence: s.sequence, updatedAt: s.updatedAt, positions,
  };
}
