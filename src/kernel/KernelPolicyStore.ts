// Phase 1B2: KernelPolicyStore — event-backed versioned policy store
//
// Consumes 'policy.snapshot.published' KernelEventEnvelope.
// All other events are irrelevant.
//
// Identity from envelope: policyId=kernelEventId, policyVersion=kernelLogicalSequence,
// publishedAt=kernelTimestamp.

import type { ExchangeId } from '../data/MarketIdentity';
import type {
  CompiledPolicy,
  SymbolPolicyRule,
  VersionedPolicySnapshot,
  PolicyResolution,
  PolicyDirection,
  PolicyRiskLevel,
  PolicyStatus,
} from '../types/policy-snapshot';
import { validatePolicyPublication } from '../events/validatePolicySnapshot';
import type { DomainClock } from '../runtime/Clock';
import type { KernelEventEnvelope } from './KernelEventEnvelope';

// ─── Helpers ────────────────────────────────────────────────────────────────

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    if (Array.isArray(obj)) {
      for (const item of obj) deepFreeze(item);
    } else {
      for (const v of Object.values(obj)) deepFreeze(v);
    }
  }
  return obj;
}

const RISK_ORDER: Record<PolicyRiskLevel, number> = { low: 1, medium: 2, high: 3 };

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KernelPolicyStore {
  apply(envelope: KernelEventEnvelope): { status: 'applied' | 'ignored' | 'irrelevant'; snapshot?: VersionedPolicySnapshot };
  getLatest(exchange: ExchangeId): VersionedPolicySnapshot | undefined;
  getByVersion(exchange: ExchangeId, version: number): VersionedPolicySnapshot | undefined;
  resolve(exchange: ExchangeId, symbol: string): PolicyResolution;
}

interface ExchangeState {
  latest: VersionedPolicySnapshot | null;
  byVersion: Map<number, VersionedPolicySnapshot>;
  history: VersionedPolicySnapshot[]; // newest-first
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createKernelPolicyStore(config: {
  clock: DomainClock;
  maxLifetimeMs: number;
  maxVersionsPerExchange: number;
}): KernelPolicyStore {
  if (!config.clock || typeof config.clock.now !== 'function') {
    throw new Error('POLICY_STORE_CONFIG: clock required');
  }
  if (!Number.isSafeInteger(config.maxLifetimeMs) || config.maxLifetimeMs <= 0) {
    throw new Error('POLICY_STORE_CONFIG: maxLifetimeMs must be positive safe integer');
  }
  if (!Number.isSafeInteger(config.maxVersionsPerExchange) || config.maxVersionsPerExchange <= 0) {
    throw new Error('POLICY_STORE_CONFIG: maxVersionsPerExchange must be positive safe integer');
  }
  const { clock, maxLifetimeMs, maxVersionsPerExchange } = config;
  const states = new Map<ExchangeId, ExchangeState>();

  function ensureState(exchange: ExchangeId): ExchangeState {
    let s = states.get(exchange);
    if (!s) {
      s = { latest: null, byVersion: new Map(), history: [] };
      states.set(exchange, s);
    }
    return s;
  }

  function deriveStatus(snapshot: VersionedPolicySnapshot): PolicyStatus {
    const now = clock.now();
    if (now < snapshot.effectiveAt) return 'missing';
    if (now < snapshot.expiresAt) return 'active';
    if (snapshot.degradeUntil !== undefined && now < snapshot.degradeUntil) return 'degraded';
    return 'expired';
  }

  function buildResolution(state: ExchangeState, symbol: string): PolicyResolution {
    const snap = state.latest;
    if (!snap) {
      return { status: 'missing', policy: null, allowNewEntries: false, maxPositionMultiplier: 0,
        directionBias: 'neutral', riskLevel: 'high', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] };
    }

    const status = deriveStatus(snap);

    if (status === 'missing') {
      return { status, policy: null, allowNewEntries: false, maxPositionMultiplier: 0,
        directionBias: 'neutral', riskLevel: 'high', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] };
    }

    if (status === 'degraded' || status === 'expired') {
      return { status, policy: snap, allowNewEntries: false, maxPositionMultiplier: 0,
        directionBias: 'neutral', riskLevel: 'high', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: snap.reasonCodes };
    }

    // active — apply global gates + symbol rules
    let allowNew = snap.allowNewEntries;
    let multiplier = snap.maxPositionMultiplier;
    let direction = snap.directionBias;
    let risk = snap.riskLevel;
    let allowedStrats = [...snap.allowedStrategyIds];
    let blockedStrats = [...snap.blockedStrategyIds];
    let reasons = [...snap.reasonCodes];

    // Global symbol gates
    if (snap.blockedSymbols.includes(symbol)) {
      allowNew = false;
    }
    if (snap.allowedSymbols.length > 0 && !snap.allowedSymbols.includes(symbol)) {
      allowNew = false;
    }

    const symRule: SymbolPolicyRule | undefined = snap.symbolRules[symbol];
    if (symRule) {
      allowNew = allowNew && symRule.allowNewEntries;
      multiplier = Math.min(multiplier, symRule.maxPositionMultiplier);
      direction = symRule.directionBias;
      risk = RISK_ORDER[symRule.riskLevel] > RISK_ORDER[risk] ? symRule.riskLevel : risk;

      // Strategy allowed: intersection (empty = all)
      if (allowedStrats.length === 0) {
        allowedStrats = [...symRule.allowedStrategyIds];
      } else if (symRule.allowedStrategyIds.length > 0) {
        const symSet = new Set(symRule.allowedStrategyIds);
        allowedStrats = allowedStrats.filter(s => symSet.has(s));
      }
      // blocked: union
      const blockSet = new Set(blockedStrats);
      for (const s of symRule.blockedStrategyIds) blockSet.add(s);
      blockedStrats = [...blockSet].sort();

      // reasons: union
      const reasonSet = new Set(reasons);
      for (const r of symRule.reasonCodes) reasonSet.add(r);
      reasons = [...reasonSet].sort();
    }

    return { status, policy: snap, allowNewEntries: allowNew, maxPositionMultiplier: multiplier,
      directionBias: direction, riskLevel: risk, allowedStrategyIds: allowedStrats,
      blockedStrategyIds: blockedStrats, reasonCodes: reasons };
  }

  return {
    apply(envelope: KernelEventEnvelope): { status: 'applied' | 'ignored' | 'irrelevant'; snapshot?: VersionedPolicySnapshot } {
      if (envelope.type !== 'policy.snapshot.published') return { status: 'irrelevant' };
      const policyPayload = (envelope.payload as { policy: CompiledPolicy }).policy;
      const seq = envelope.kernelLogicalSequence;

      // Defensive validation before any mutation
      validatePolicyPublication(policyPayload, seq, envelope.kernelTimestamp, maxLifetimeMs);

      const exchange = policyPayload.exchange as ExchangeId;
      const state = ensureState(exchange);

      // Out-of-order sequence → ignored
      if (state.latest && seq <= state.latest.policyVersion) {
        return { status: 'ignored' };
      }

      // Build versioned snapshot from envelope
      const cloned = deepClone(policyPayload) as CompiledPolicy;
      const versioned: VersionedPolicySnapshot = deepFreeze({
        ...cloned,
        policyId: envelope.kernelEventId,
        policyVersion: seq,
        publishedAt: envelope.kernelTimestamp,
      } as VersionedPolicySnapshot);

      // Commit atomically
      const previous = state.latest;
      state.latest = versioned;
      state.byVersion.set(seq, versioned);
      state.history.unshift(versioned);

      // Evict oldest if over capacity
      while (state.history.length > maxVersionsPerExchange) {
        const evicted = state.history.pop()!;
        state.byVersion.delete(evicted.policyVersion);
      }

      return { status: 'applied', snapshot: versioned };
    },

    getLatest(exchange: ExchangeId): VersionedPolicySnapshot | undefined {
      return states.get(exchange)?.latest ?? undefined;
    },

    getByVersion(exchange: ExchangeId, version: number): VersionedPolicySnapshot | undefined {
      return states.get(exchange)?.byVersion.get(version);
    },

    resolve(exchange: ExchangeId, symbol: string): PolicyResolution {
      const state = states.get(exchange);
      if (!state) {
        return { status: 'missing', policy: null, allowNewEntries: false, maxPositionMultiplier: 0,
          directionBias: 'neutral', riskLevel: 'high', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] };
      }
      return buildResolution(state, symbol);
    },
  };
}
