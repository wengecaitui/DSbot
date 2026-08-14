// Phase 1B3: KernelPositionStateStore — event-backed, immutable position state
import type { DomainClock } from '../runtime/Clock';
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { ConfirmedFill } from '../types/confirmed-fill';
import { validateConfirmedFill, canonicalizeConfirmedFill } from '../types/confirmed-fill';
import type { ConfirmedPositionBaseline, VersionedPositionSnapshot, PositionResolution } from '../types/position-state';

const SHA64_RE = /^[0-9a-f]{64}$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = deepClone(val);
  }
  return out as unknown as T;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    if (!Object.isFrozen(v)) {
      Object.freeze(v);
      for (const val of Object.values(v as Record<string, unknown>)) deepFreeze(val);
    }
  }
  return v;
}

// ─── Fill equality ──────────────────────────────────────────────────────────

function fillEqual(a: ConfirmedFill, b: ConfirmedFill): boolean {
  return a.fillId === b.fillId && a.exchange === b.exchange && a.symbol === b.symbol
    && a.side === b.side && a.quantity === b.quantity && a.price === b.price
    && a.executedAt === b.executedAt;
}

// ─── Position math ──────────────────────────────────────────────────────────

interface PosState { side: 'long' | 'short' | 'flat'; signedQty: number; avgPrice: number; }

function applyFillToState(current: PosState, fill: ConfirmedFill): PosState {
  const isBuy = fill.side === 'buy';
  if (current.side === 'flat') {
    return isBuy
      ? { side: 'long', signedQty: fill.quantity, avgPrice: fill.price }
      : { side: 'short', signedQty: -fill.quantity, avgPrice: fill.price };
  }
  if (current.side === 'long') {
    if (isBuy) {
      const totalQty = current.signedQty + fill.quantity;
      const totalCost = current.avgPrice * current.signedQty + fill.price * fill.quantity;
      return { side: 'long', signedQty: totalQty, avgPrice: totalCost / totalQty };
    }
    // sell vs long
    if (fill.quantity < current.signedQty) {
      return { side: 'long', signedQty: current.signedQty - fill.quantity, avgPrice: current.avgPrice };
    }
    if (fill.quantity === current.signedQty) {
      return { side: 'flat', signedQty: 0, avgPrice: 0 };
    }
    const remaining = fill.quantity - current.signedQty;
    return { side: 'short', signedQty: -remaining, avgPrice: fill.price };
  }
  // short
  if (!isBuy) {
    const totalQty = Math.abs(current.signedQty) + fill.quantity;
    const totalCost = current.avgPrice * Math.abs(current.signedQty) + fill.price * fill.quantity;
    return { side: 'short', signedQty: -totalQty, avgPrice: totalCost / totalQty };
  }
  // buy vs short
  const absQty = Math.abs(current.signedQty);
  if (fill.quantity < absQty) {
    return { side: 'short', signedQty: -(absQty - fill.quantity), avgPrice: current.avgPrice };
  }
  if (fill.quantity === absQty) {
    return { side: 'flat', signedQty: 0, avgPrice: 0 };
  }
  const remaining = fill.quantity - absQty;
  return { side: 'long', signedQty: remaining, avgPrice: fill.price };
}

function toSnapshot(exchange: ExchangeId, symbol: string, pos: PosState, version: number, eventId: string): VersionedPositionSnapshot {
  return deepFreeze({ exchange, symbol, side: pos.side, signedQuantity: pos.signedQty,
    averageEntryPrice: pos.avgPrice, positionVersion: version, sourceKernelEventId: eventId });
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface KernelEventEnvelope {
  readonly kernelEventId: string;
  readonly kernelLogicalSequence: number;
  readonly kernelTimestamp: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface KernelPositionStateStore {
  apply(envelope: KernelEventEnvelope): { status: 'applied' | 'ignored' | 'irrelevant'; snapshot?: VersionedPositionSnapshot };
  getLatest(exchange: ExchangeId, symbol: string): VersionedPositionSnapshot | undefined;
  getByVersion(exchange: ExchangeId, symbol: string, version: number): VersionedPositionSnapshot | undefined;
  resolve(exchange: ExchangeId, symbol: string): PositionResolution;
  /** Phase 5B: deterministic read-only enumeration of all initialized factual
   *  position resolutions (never 'missing'). */
  listResolved(): readonly PositionResolution[];
  digest(): string;
}

interface PerSymbol {
  latest: VersionedPositionSnapshot | null;
  byVersion: Map<number, VersionedPositionSnapshot>;
  history: VersionedPositionSnapshot[];
  processedFills: Map<string, ConfirmedFill>;
  initialized: boolean;
}

function ensureState(states: Map<string, PerSymbol>, exchange: ExchangeId, symbol: string): PerSymbol {
  const key = `${exchange}:${symbol}`;
  let s = states.get(key);
  if (!s) {
    s = { latest: null, byVersion: new Map(), history: [], processedFills: new Map(), initialized: false };
    states.set(key, s);
  }
  return s;
}

function validateEnvelope(envelope: KernelEventEnvelope): void {
  if (!Number.isSafeInteger(envelope.kernelLogicalSequence) || envelope.kernelLogicalSequence <= 0) throw new Error('POSITION_STORE: invalid kernelLogicalSequence');
  if (!Number.isSafeInteger(envelope.kernelTimestamp) || envelope.kernelTimestamp < 0) throw new Error('POSITION_STORE: invalid kernelTimestamp');
  if (typeof envelope.kernelEventId !== 'string' || !SHA64_RE.test(envelope.kernelEventId)) throw new Error('POSITION_STORE: invalid kernelEventId');
}

export function createKernelPositionStateStore(config?: { maxSnapshotsPerSymbol?: number }): KernelPositionStateStore {
  const maxSnapshotsPerSymbol = config?.maxSnapshotsPerSymbol ?? 20;
  if (!Number.isFinite(maxSnapshotsPerSymbol) || maxSnapshotsPerSymbol <= 0) throw new Error('POSITION_STORE_CONFIG: maxSnapshotsPerSymbol');

  const states = new Map<string, PerSymbol>();

  return {
    apply(envelope: KernelEventEnvelope) {
      if (envelope.type !== 'execution.fill.confirmed' && envelope.type !== 'position.baseline.confirmed') return { status: 'irrelevant' };

      // 1. Validate envelope
      validateEnvelope(envelope);

      const seq = envelope.kernelLogicalSequence;
      const eid = envelope.kernelEventId;

      // 2. Validate payload + derive exchange/symbol BEFORE any mutation
      if (envelope.type === 'execution.fill.confirmed') {
        const fillPayload = (envelope.payload as { fill: unknown }).fill;
        const fill = validateConfirmedFill(fillPayload);
        const exchange = fill.exchange;
        const symbol = fill.symbol;

        // Clone fill for dedup registry
        const canonical = canonicalizeConfirmedFill(fill);
        const state = ensureState(states, exchange, symbol);

        // Check fillId dedup BEFORE clone/derive/commit
        const prev = state.processedFills.get(canonical.fillId);
        if (prev) {
          if (!fillEqual(prev, canonical)) throw new Error('POSITION_STORE: conflicting fillId');
          return { status: 'ignored' };
        }

        // Order check
        if (state.latest && seq <= state.latest.positionVersion) return { status: 'ignored' };

        // Derive candidate
        const currentPos: PosState = state.latest
          ? { side: state.latest.side, signedQty: state.latest.signedQuantity, avgPrice: state.latest.averageEntryPrice }
          : { side: 'flat', signedQty: 0, avgPrice: 0 };
        const nextPos = applyFillToState(currentPos, canonical);
        const snapshot = toSnapshot(exchange, symbol, nextPos, seq, eid);

        // Atomic commit
        state.latest = snapshot;
        state.byVersion.set(seq, snapshot);
        state.history.unshift(snapshot);
        state.processedFills.set(canonical.fillId, canonical);
        state.initialized = true;

        // Evict oldest if over capacity
        while (state.history.length > maxSnapshotsPerSymbol) {
          const evicted = state.history.pop()!;
          state.byVersion.delete(evicted.positionVersion);
        }

        return { status: 'applied', snapshot };
      }

      // position.baseline.confirmed
      const baselinePayload = (envelope.payload as { baseline: unknown }).baseline;
      if (!baselinePayload || typeof baselinePayload !== 'object') throw new Error('POSITION_STORE: invalid baseline');
      const bl = baselinePayload as Record<string, unknown>;
      const exchange = bl.exchange as string;
      const symbol = bl.symbol as string;
      if (!isExchangeId(exchange)) throw new Error('POSITION_STORE_BASELINE: invalid exchange');
      if (typeof symbol !== 'string' || symbol.length === 0) throw new Error('POSITION_STORE_BASELINE: invalid symbol');
      if (bl.side !== 'long' && bl.side !== 'short' && bl.side !== 'flat') throw new Error('POSITION_STORE_BASELINE: invalid side');
      if (typeof bl.signedQuantity !== 'number' || !Number.isFinite(bl.signedQuantity)) throw new Error('POSITION_STORE_BASELINE: invalid signedQuantity');
      if (typeof bl.averageEntryPrice !== 'number' || !Number.isFinite(bl.averageEntryPrice)) throw new Error('POSITION_STORE_BASELINE: invalid averageEntryPrice');
      if (bl.side === 'flat' && (bl.signedQuantity !== 0 || bl.averageEntryPrice !== 0)) throw new Error('POSITION_STORE_BASELINE: flat requires qty=0, price=0');
      if (bl.side === 'long' && (bl.signedQuantity <= 0 || bl.averageEntryPrice <= 0)) throw new Error('POSITION_STORE_BASELINE: long requires qty>0, price>0');
      if (bl.side === 'short' && (bl.signedQuantity >= 0 || bl.averageEntryPrice <= 0)) throw new Error('POSITION_STORE_BASELINE: short requires qty<0, price>0');

      const state = ensureState(states, exchange as ExchangeId, symbol);

      // Baseline only for uninitialized keys
      if (state.initialized) throw new Error('POSITION_STORE_BASELINE: already initialized');

      const snapshot: VersionedPositionSnapshot = deepFreeze({
        exchange: exchange as ExchangeId, symbol,
        side: bl.side, signedQuantity: bl.signedQuantity as number,
        averageEntryPrice: bl.averageEntryPrice as number,
        positionVersion: seq, sourceKernelEventId: eid,
      });

      state.latest = snapshot;
      state.byVersion.set(seq, snapshot);
      state.history.unshift(snapshot);
      state.initialized = true;

      return { status: 'applied', snapshot };
    },

    getLatest(exchange: ExchangeId, symbol: string): VersionedPositionSnapshot | undefined {
      return states.get(`${exchange}:${symbol}`)?.latest ?? undefined;
    },

    getByVersion(exchange: ExchangeId, symbol: string, version: number): VersionedPositionSnapshot | undefined {
      return states.get(`${exchange}:${symbol}`)?.byVersion.get(version);
    },

    resolve(exchange: ExchangeId, symbol: string): PositionResolution {
      const state = states.get(`${exchange}:${symbol}`);
      if (!state || !state.latest) {
        return deepFreeze({ status: 'missing', snapshot: null, side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } as PositionResolution);
      }
      const s = state.latest;
      const status = s.side === 'flat' ? 'flat' : 'open';
      return deepFreeze({ status, snapshot: s, side: s.side, signedQuantity: s.signedQuantity, averageEntryPrice: s.averageEntryPrice } as PositionResolution);
    },

    listResolved(): readonly PositionResolution[] {
      const out: PositionResolution[] = [];
      for (const state of states.values()) {
        if (!state.initialized || !state.latest) continue;
        const s = state.latest;
        const status = s.side === 'flat' ? 'flat' : 'open';
        out.push(deepFreeze({ status, snapshot: s, side: s.side, signedQuantity: s.signedQuantity, averageEntryPrice: s.averageEntryPrice } as PositionResolution));
      }
      return out.sort((a, b) => `${a.snapshot!.exchange}:${a.snapshot!.symbol}`.localeCompare(`${b.snapshot!.exchange}:${b.snapshot!.symbol}`));
    },

    digest(): string {
      const entries = [...states.entries()]
        .map(([k, v]) => [k, v.latest] as [string, unknown])
        .filter(([, v]) => v !== null)
        .sort(([a], [b]) => (a as string).localeCompare(b as string));
      const { createHash } = require('node:crypto') as typeof import('node:crypto');
      return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
    },
  };
}
