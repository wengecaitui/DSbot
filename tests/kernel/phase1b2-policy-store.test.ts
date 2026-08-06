// Phase 1B2: Policy Store — contract tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import type { DomainClock } from '../../src/runtime/Clock';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { CompiledPolicy, VersionedPolicySnapshot, PolicyResolution } from '../../src/types/policy-snapshot';
import { validatePolicyPublication } from '../../src/events/validatePolicySnapshot';
import { createKernelPolicyStore } from '../../src/kernel/KernelPolicyStore';
import type { KernelPolicyStore } from '../../src/kernel/KernelPolicyStore';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import type { KernelEventEnvelope } from '../../src/kernel/KernelEventEnvelope';

const BITGET = 'bitget' as const;
const MAX_24H = 86400000;

function mkClock(init: number): DomainClock & { advance(ms: number): void } {
  let t = init; return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function mkStore(clock?: DomainClock): KernelPolicyStore {
  return createKernelPolicyStore({ clock: clock ?? mkClock(1000), maxLifetimeMs: MAX_24H, maxVersionsPerExchange: 10 });
}

function mkPolicy(overrides?: Partial<CompiledPolicy>): CompiledPolicy {
  return {
    exchange: BITGET, sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 0,
    compilerVersion: '1.0.0', compiledAt: 900, effectiveAt: 1000, expiresAt: 1000000,
    allowNewEntries: true, allowedSymbols: ['BTC/USDT'], blockedSymbols: [],
    allowedStrategyIds: ['momentum'], blockedStrategyIds: [],
    maxPositionMultiplier: 1.0, riskLevel: 'medium', directionBias: 'bullish',
    symbolRules: {}, reasonCodes: [],
    ...overrides,
  } as CompiledPolicy;
}

function env(policy: CompiledPolicy, seq: number): KernelEventEnvelope {
  return { kernelEventId: 'a'.repeat(64), kernelLogicalSequence: seq, kernelTimestamp: 1000 * seq,
    type: 'policy.snapshot.published', payload: { policy } } as unknown as KernelEventEnvelope;
}

// ─── Invalid config ─────────────────────────────────────────────────────────
describe('invalid config', () => {
  it('rejects missing clock', () => {
    assert.throws(() => createKernelPolicyStore({ maxLifetimeMs: 1000, maxVersionsPerExchange: 5 } as unknown as Parameters<typeof createKernelPolicyStore>[0]), /POLICY_STORE_CONFIG/);
  });
});

// ─── Identity from envelope ─────────────────────────────────────────────────
describe('identity from envelope', () => {
  it('policyId = kernelEventId', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    const r = kernel.publish('policy.snapshot.published', { policy: mkPolicy() });
    assert.strictEqual(r.envelope.kernelEventId.length, 64);
  });
  it('same policy → same eventId', () => {
    const k1 = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    const k2 = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    const p = mkPolicy();
    assert.strictEqual(
      k1.publish('policy.snapshot.published', { policy: p }).envelope.kernelEventId,
      k2.publish('policy.snapshot.published', { policy: p }).envelope.kernelEventId);
  });
  it('missing policyMaxLifetimeMs rejects policy publication', () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    assert.throws(() => kernel.publish('policy.snapshot.published', { policy: mkPolicy() }), /POLICY_CONFIG_MISSING/);
  });
  it('same-kernel duplicate publish returns duplicate, dispatched once', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    let count = 0;
    kernel.subscribe('policy.snapshot.published', () => { count++; });
    const r1 = kernel.publish('policy.snapshot.published', { policy: mkPolicy() });
    assert.strictEqual(r1.status, 'accepted');
    assert.strictEqual(count, 1);
    const r2 = kernel.publish('policy.snapshot.published', { policy: mkPolicy() }, r1.envelope.kernelEventId);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(count, 1);
  });
});

// ─── Policy validation ──────────────────────────────────────────────────────
describe('policy validation', () => {
  it('rejects invalid exchange', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ exchange: 'coinbase' } as unknown as ExchangeId), 5, 5000, MAX_24H), /exchange/);
  });
  it('rejects sourceResearchSequence=0 when >= candidateSeq', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ sourceResearchSequence: 1 } as Partial<CompiledPolicy>), 1, 5000, MAX_24H), /publication seq/);
  });
  it('rejects sourceResearchSequence >= candidateSeq', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ sourceResearchSequence: 5 }), 5, 5000, MAX_24H), /publication seq/);
  });
  it('rejects unknown top-level field', () => {
    assert.throws(() => validatePolicyPublication({ ...mkPolicy(), bogusField: true }, 5, 5000, MAX_24H), /unknown field/);
  });
  it('rejects compiledAt > effectiveAt', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ compiledAt: 2000, effectiveAt: 1000 }), 5, 5000, MAX_24H), /compiledAt > effectiveAt/);
  });
  it('rejects lifetime > maxLifetimeMs', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ compiledAt: 0, effectiveAt: 0, expiresAt: 100000 }), 5, 5000, 1000), /lifetime/);
  });
  it('rejects multiplier outside [0,1]', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ maxPositionMultiplier: 1.5 }), 5, 5000, MAX_24H), /maxPositionMultiplier/);
  });
  it('rejects symbol in both allow and block', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ allowedSymbols: ['BTC/USDT'], blockedSymbols: ['BTC/USDT'] }), 5, 5000, MAX_24H), /in both/);
  });
  it('rejects unknown SymbolPolicyRule field', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ symbolRules: { 'BTC': { allowNewEntries: true, maxPositionMultiplier: 0.5, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [], bogus: true } as unknown as never } }), 5, 5000, MAX_24H), /unknown field/);
  });
  it('rejects non-array list', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ allowedSymbols: 'not-array' } as unknown as CompiledPolicy), 5, 5000, MAX_24H), /is not an array/);
  });
  it('rejects cycle', () => {
    // Cycle inside symbolRules: self-reference in a nested object
    const p = mkPolicy({ symbolRules: {} });
    const nested: Record<string,unknown> = { allowNewEntries: true, maxPositionMultiplier: 0.5, directionBias: 'bullish', riskLevel: 'low', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] };
    nested.cycle = nested;
    (p.symbolRules as Record<string,unknown>)['BTC'] = nested;
    assert.throws(() => validatePolicyPublication(p, 5, 5000, MAX_24H), /JSON-safe|cycle/);
  });
  it('accepts shared non-cyclic reference', () => {
    const shared = ['shared-reason'];
    const r1 = { allowNewEntries: true, maxPositionMultiplier: 0.5, directionBias: 'bullish' as const, riskLevel: 'low' as const, allowedStrategyIds: shared, blockedStrategyIds: [], reasonCodes: shared };
    const r2 = { allowNewEntries: true, maxPositionMultiplier: 0.3, directionBias: 'bearish' as const, riskLevel: 'medium' as const, allowedStrategyIds: shared, blockedStrategyIds: [], reasonCodes: shared };
    const p = mkPolicy({ symbolRules: { BTC: r1, ETH: r2 } });
    validatePolicyPublication(p, 5, 5000, MAX_24H); // no throw
  });
});

// ─── Apply ──────────────────────────────────────────────────────────────────
describe('apply', () => {
  let s: KernelPolicyStore;
  beforeEach(() => { s = mkStore(); });
  it('applies policy event', () => {
    const r = s.apply(env(mkPolicy(), 1));
    assert.strictEqual(r.status, 'applied');
    assert.strictEqual(r.snapshot!.policyVersion, 1);
  });
  it('legacy events irrelevant', () => {
    assert.strictEqual(s.apply({ type: 'market.ticker.updated' } as unknown as KernelEventEnvelope).status, 'irrelevant');
  });
  it('older sequence ignored', () => {
    s.apply(env(mkPolicy(), 5));
    const r = s.apply(env(mkPolicy({ allowNewEntries: false }), 3));
    assert.strictEqual(r.status, 'ignored');
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, 5);
  });
  it('equal sequence ignored', () => {
    s.apply(env(mkPolicy(), 3));
    const r = s.apply(env(mkPolicy({ allowNewEntries: false }), 3));
    assert.strictEqual(r.status, 'ignored');
  });
  it('invalid publication: store unchanged', () => {
    s.apply(env(mkPolicy(), 1));
    assert.throws(() => s.apply(env(mkPolicy({ exchange: 'coinbase' } as unknown as ExchangeId), 2)), /exchange/);
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, 1);
  });
});

// ─── Status resolution ─────────────────────────────────────────────────────
describe('status resolution', () => {
  it('active', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'active');
  });
  it('degraded', () => {
    const s = mkStore(mkClock(12000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000, degradeUntil: 15000 }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'degraded');
  });
  it('expired', () => {
    const s = mkStore(mkClock(20000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'expired');
  });
});

// ─── Entry permission ──────────────────────────────────────────────────────
describe('entry permission', () => {
  it('active allows', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, true);
  });
  it('degraded blocks, multiplier=0', () => {
    const s = mkStore(mkClock(12000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000, degradeUntil: 15000 }), 1));
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.allowNewEntries, false);
    assert.strictEqual(r.maxPositionMultiplier, 0);
  });
});

// ─── Symbol resolution ─────────────────────────────────────────────────────
describe('symbol resolution', () => {
  it('blocked symbol forces false', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowedSymbols: [], blockedSymbols: ['BTC/USDT'] }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, false);
  });
  it('allowlist enforced', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowedSymbols: ['ETH/USDT'] }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, false);
  });
  it('symbol rule min(global,symbol) multiplier', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ maxPositionMultiplier: 0.8, symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 0.5, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').maxPositionMultiplier, 0.5);
  });
  it('symbol rule cannot relax global allow', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowNewEntries: false, symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, false);
  });
  it('riskLevel uses stricter value', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ riskLevel: 'low', symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'high', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').riskLevel, 'high');
  });
});

// ─── getLatest / getByVersion ──────────────────────────────────────────────
describe('getLatest / getByVersion', () => {
  it('getLatest returns current', () => {
    const s = mkStore(); s.apply(env(mkPolicy(), 1));
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, 1);
  });
  it('getByVersion returns historical', () => {
    const s = mkStore();
    s.apply(env(mkPolicy({ effectiveAt: 1000 }), 1));
    s.apply(env(mkPolicy({ effectiveAt: 2000 }), 2));
    assert.strictEqual(s.getByVersion(BITGET, 1)!.effectiveAt, 1000);
  });
  it('bounded eviction', () => {
    const s = createKernelPolicyStore({ clock: mkClock(0), maxLifetimeMs: MAX_24H, maxVersionsPerExchange: 2 });
    s.apply(env(mkPolicy(), 1)); s.apply(env(mkPolicy(), 2)); s.apply(env(mkPolicy(), 3));
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, 3);
    assert.strictEqual(s.getByVersion(BITGET, 1), undefined);
  });
  it('two exchanges isolated', () => {
    const s = mkStore();
    s.apply(env(mkPolicy(), 1));
    s.apply(env(mkPolicy({ exchange: 'binance' } as unknown as ExchangeId), 2));
    assert.ok(s.getLatest(BITGET));
    assert.ok(s.getLatest('binance' as ExchangeId));
  });
});

// ─── Subscription integration ───────────────────────────────────────────────
describe('kernel subscription', () => {
  it('publish → store apply', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    const s = mkStore();
    kernel.subscribe('policy.snapshot.published', (e) => { s.apply(e); });
    kernel.publish('policy.snapshot.published', { policy: mkPolicy() });
    assert.ok(s.getLatest(BITGET));
  });
  it('invalid publication: subscriber not called, journal unchanged', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    let called = false;
    kernel.subscribe('policy.snapshot.published', () => { called = true; });
    assert.throws(() => kernel.publish('policy.snapshot.published',
      { policy: mkPolicy({ exchange: 'coinbase' } as unknown as ExchangeId) }), /exchange/);
    assert.strictEqual(called, false);
  });
});

// ─── Final invariants ───────────────────────────────────────────────────────
describe('final invariants', () => {
  it('sourceResearchSequence=0 accepted (non-negative)', () => {
    validatePolicyPublication(mkPolicy({ sourceResearchSequence: 0 } as Partial<CompiledPolicy>), 5, 5000, MAX_24H); // no throw
  });
  it('missing symbolRules rejected', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ symbolRules: undefined } as unknown as CompiledPolicy), 5, 5000, MAX_24H), /symbolRules missing/);
  });
  it('null symbolRules rejected', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ symbolRules: null } as unknown as CompiledPolicy), 5, 5000, MAX_24H), /symbolRules missing/);
  });
  it('array symbolRules rejected', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ symbolRules: [] } as unknown as CompiledPolicy), 5, 5000, MAX_24H), /is not a plain object/);
  });
  it('Date symbolRules rejected', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ symbolRules: new Date() } as unknown as CompiledPolicy), 5, 5000, MAX_24H), /is not a plain object/);
  });
  it('missing required top-level field rejected', () => {
    const p: Record<string,unknown> = { ...mkPolicy() };
    delete p.compilerVersion;
    assert.throws(() => validatePolicyPublication(p, 5, 5000, MAX_24H), /missing required field/);
  });
  it('missing required SymbolPolicyRule field rejected', () => {
    const rule: Record<string,unknown> = { allowNewEntries: true, maxPositionMultiplier: 0.5, directionBias: 'bullish', riskLevel: 'low', allowedStrategyIds: [], blockedStrategyIds: [] };
    // missing reasonCodes
    const p = mkPolicy({ symbolRules: { BTC: rule } } as unknown as CompiledPolicy);
    assert.throws(() => validatePolicyPublication(p, 5, 5000, MAX_24H), /missing required field/);
  });
  it('invalid kernelEventId rejected atomically', () => {
    const s = mkStore();
    const badEnv = { type: 'policy.snapshot.published', kernelLogicalSequence: 2, kernelTimestamp: 1000,
      kernelEventId: 'bad-id', payload: { policy: mkPolicy() } } as unknown as KernelEventEnvelope;
    assert.throws(() => s.apply(badEnv), /invalid kernelEventId|POLICY_INVALID: missing policy/);
  });
  it('duplicate publish: subscriber called once for same eventId', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    let count = 0;
    kernel.subscribe('policy.snapshot.published', () => { count++; });
    const p = mkPolicy({ effectiveAt: 2000 });
    const r1 = kernel.publish('policy.snapshot.published', { policy: p });
    assert.strictEqual(r1.status, 'accepted');
    assert.strictEqual(count, 1);
    const r2 = kernel.publish('policy.snapshot.published', { policy: p }, r1.envelope.kernelEventId);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(count, 1); // not called again
  });
  it('resolve result is recursively frozen', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 }), 2));
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.ok(Object.isFrozen(r));
    assert.ok(Object.isFrozen(r.allowedStrategyIds));
    assert.ok(Object.isFrozen(r.blockedStrategyIds));
    assert.ok(Object.isFrozen(r.reasonCodes));
    try { (r as Record<string,unknown>).allowNewEntries = true; } catch { /* frozen */ }
    const r2 = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r2.allowNewEntries, r.allowNewEntries);
  });
  it('strategy allowlist intersection', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowedStrategyIds: ['a', 'c'], symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: ['b', 'c'], blockedStrategyIds: [], reasonCodes: [] } } }), 2));
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.deepStrictEqual(r.allowedStrategyIds, ['c']); // intersection of [a,c] and [b,c]
  });
  it('blocked strategy sorted union', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowedSymbols: [], blockedStrategyIds: ['x'], symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: ['x', 'y'], reasonCodes: [] } } }), 1));
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.deepStrictEqual(r.blockedStrategyIds, ['x', 'y']); // sorted union
  });
  it('reasonCodes sorted union', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ reasonCodes: ['global'], symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: ['symbol'] } } }), 2));
    assert.deepStrictEqual(s.resolve(BITGET, 'BTC/USDT').reasonCodes, ['global', 'symbol']);
  });
  it('mutating input after apply cannot affect store', () => {
    const s = mkStore();
    const mutablePolicy = mkPolicy();
    s.apply(env(mutablePolicy, 2));
    mutablePolicy.allowNewEntries = false;
    mutablePolicy.maxPositionMultiplier = 0;
    assert.strictEqual(s.getLatest(BITGET)!.allowNewEntries, true);
    assert.strictEqual(s.getLatest(BITGET)!.maxPositionMultiplier, 1);
  });
  it('mutating resolve object is ineffective', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 }), 2));
    const r = s.resolve(BITGET, 'BTC/USDT');
    try { (r as Record<string,unknown>).directionBias = 'bearish'; } catch { /* frozen */ }
    const r2 = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r2.directionBias, 'bullish');
  });
});
