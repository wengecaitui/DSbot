// Phase 1B2: Policy Store — contract tests (RED first)
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
  return createKernelPolicyStore({
    clock: clock ?? mkClock(1000),
    maxLifetimeMs: MAX_24H,
    maxVersionsPerExchange: 10,
  });
}

function mkPolicy(overrides?: Partial<CompiledPolicy>): CompiledPolicy {
  return {
    exchange: BITGET,
    sourceResearchEventId: 'a'.repeat(64),
    sourceResearchSequence: 0,
    compilerVersion: '1.0.0',
    compiledAt: 900,
    effectiveAt: 1000,
    expiresAt: 1000000,
    allowNewEntries: true,
    allowedSymbols: ['BTC/USDT'],
    blockedSymbols: [],
    allowedStrategyIds: ['momentum'],
    blockedStrategyIds: [],
    maxPositionMultiplier: 1.0,
    riskLevel: 'medium',
    directionBias: 'bullish',
    symbolRules: {},
    reasonCodes: [],
    ...overrides,
  } as CompiledPolicy;
}

function env(policy: CompiledPolicy, seq: number): KernelEventEnvelope {
  return {
    kernelEventId: 'a'.repeat(64), kernelLogicalSequence: seq, kernelTimestamp: 1000 * seq,
    type: 'policy.snapshot.published', payload: { policy },
  } as unknown as KernelEventEnvelope;
}

// ─── Invalid config ─────────────────────────────────────────────────────────
describe('invalid config', () => {
  it('rejects missing clock', () => {
    assert.throws(() => createKernelPolicyStore({ maxLifetimeMs: 1000, maxVersionsPerExchange: 5 } as unknown as Parameters<typeof createKernelPolicyStore>[0]), /POLICY_STORE_CONFIG/);
  });
  it('rejects non-positive maxLifetimeMs', () => {
    assert.throws(() => createKernelPolicyStore({ clock: mkClock(0), maxLifetimeMs: 0, maxVersionsPerExchange: 5 }), /POLICY_STORE_CONFIG/);
  });
  it('rejects non-positive maxVersionsPerExchange', () => {
    assert.throws(() => createKernelPolicyStore({ clock: mkClock(0), maxLifetimeMs: 1000, maxVersionsPerExchange: 0 }), /POLICY_STORE_CONFIG/);
  });
});

// ─── Identity from envelope ─────────────────────────────────────────────────
describe('identity from envelope', () => {
  it('policyId = kernelEventId', () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    const policy = mkPolicy();
    const r = kernel.publish('policy.snapshot.published', { policy });
    assert.strictEqual(r.envelope.kernelEventId.length, 64);
  });
  it('same policy payload → same eventId', () => {
    const k1 = createTradingKernel({ exchange: BITGET });
    const k2 = createTradingKernel({ exchange: BITGET });
    const p = mkPolicy();
    assert.strictEqual(
      k1.publish('policy.snapshot.published', { policy: p }).envelope.kernelEventId,
      k2.publish('policy.snapshot.published', { policy: p }).envelope.kernelEventId,
    );
  });
});

// ─── Policy validation ──────────────────────────────────────────────────────
describe('policy validation', () => {
  it('rejects compiledAt > effectiveAt', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ compiledAt: 2000, effectiveAt: 1000 }), 5, 5000, MAX_24H), /compiledAt > effectiveAt/);
  });
  it('rejects effectiveAt > kernelTimestamp', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ effectiveAt: 10000 }), 5, 5000, MAX_24H), /effectiveAt > kernelTimestamp/);
  });
  it('rejects expiresAt <= effectiveAt', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ expiresAt: 1000, effectiveAt: 1000 }), 5, 5000, MAX_24H), /expiresAt <= effectiveAt/);
  });
  it('rejects degradeUntil < expiresAt', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ expiresAt: 5000, degradeUntil: 4000 }), 5, 5000, MAX_24H), /degradeUntil/);
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
});

// ─── Apply ──────────────────────────────────────────────────────────────────
describe('apply', () => {
  let s: KernelPolicyStore;
  beforeEach(() => { s = mkStore(); });

  it('applies policy event', () => {
    const r = s.apply(env(mkPolicy(), 1));
    assert.strictEqual(r.status, 'applied');
    assert.ok(r.snapshot);
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
});

// ─── Status resolution ─────────────────────────────────────────────────────
describe('status resolution', () => {
  it('active policy', () => {
    const c = mkClock(5000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'active');
  });
  it('degraded policy', () => {
    const c = mkClock(12000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000, degradeUntil: 15000 }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'degraded');
  });
  it('expired policy', () => {
    const c = mkClock(20000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'expired');
  });
  it('missing policy', () => {
    assert.strictEqual(mkStore().resolve(BITGET, 'BTC/USDT').status, 'missing');
  });
});

// ─── Entry permission ──────────────────────────────────────────────────────
describe('entry permission', () => {
  it('active allows new entries', () => {
    const c = mkClock(5000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, true);
  });
  it('degraded blocks new entries, multiplier=0', () => {
    const c = mkClock(12000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000, degradeUntil: 15000 }), 1));
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.allowNewEntries, false);
    assert.strictEqual(r.maxPositionMultiplier, 0);
  });
  it('expired blocks new entries, multiplier=0', () => {
    const c = mkClock(20000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 }), 1));
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.allowNewEntries, false);
    assert.strictEqual(r.maxPositionMultiplier, 0);
  });
});

// ─── Symbol resolution ─────────────────────────────────────────────────────
describe('symbol resolution', () => {
  it('blocked symbol forces false', () => {
    const c = mkClock(5000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ allowedSymbols: [], blockedSymbols: ['BTC/USDT'] }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, false);
  });
  it('allowedSymbols allowlist enforced', () => {
    const c = mkClock(5000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ allowedSymbols: ['ETH/USDT'] }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, false);
  });
  it('symbol rule uses min(global,symbol) multiplier', () => {
    const c = mkClock(5000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ maxPositionMultiplier: 0.8, symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 0.5, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').maxPositionMultiplier, 0.5);
  });
  it('symbol rule cannot relax global allow', () => {
    const c = mkClock(5000);
    const s = mkStore(c);
    s.apply(env(mkPolicy({ allowNewEntries: false, symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } }), 1));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, false);
  });
});

// ─── getLatest / getByVersion / history ────────────────────────────────────
describe('getLatest / getByVersion', () => {
  it('getLatest returns current', () => {
    const s = mkStore();
    s.apply(env(mkPolicy(), 1));
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, 1);
  });
  it('getByVersion returns historical', () => {
    const s = mkStore();
    s.apply(env(mkPolicy({ effectiveAt: 1000 }), 1));
    s.apply(env(mkPolicy({ effectiveAt: 2000 }), 2));
    assert.strictEqual(s.getByVersion(BITGET, 1)!.effectiveAt, 1000);
    assert.strictEqual(s.getByVersion(BITGET, 2)!.effectiveAt, 2000);
  });
  it('bounded eviction', () => {
    const s = createKernelPolicyStore({ clock: mkClock(0), maxLifetimeMs: MAX_24H, maxVersionsPerExchange: 2 });
    s.apply(env(mkPolicy(), 1));
    s.apply(env(mkPolicy(), 2));
    s.apply(env(mkPolicy(), 3));
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, 3);
    assert.strictEqual(s.getByVersion(BITGET, 1), undefined); // evicted
    assert.ok(s.getByVersion(BITGET, 2));
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
    const kernel = createTradingKernel({ exchange: BITGET });
    const s = mkStore();
    kernel.subscribe('policy.snapshot.published', (e) => { s.apply(e); });
    kernel.publish('policy.snapshot.published', { policy: mkPolicy() });
    assert.ok(s.getLatest(BITGET));
  });
});
