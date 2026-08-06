// Phase 1B2: Policy Store — provenance and journal-evidence contract tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import type { DomainClock } from '../../src/runtime/Clock';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { CompiledPolicy } from '../../src/types/policy-snapshot';
import { validatePolicyPublication } from '../../src/events/validatePolicySnapshot';
import { createKernelPolicyStore } from '../../src/kernel/KernelPolicyStore';
import type { KernelPolicyStore, KernelEventEnvelope } from '../../src/kernel/KernelPolicyStore';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import type { TradingKernel } from '../../src/kernel/TradingKernel';

const BITGET = 'bitget' as const;
const MAX_24H = 86400000;
const SHA64 = 'a'.repeat(64);
// sourceResearchSequence=1 → valid policy, must publish at seq >= 2
const DEFAULT_SEQ = 2;

function mkClock(init: number): DomainClock & { advance(ms: number): void } {
  let t = init; return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function mkStore(clock?: DomainClock): KernelPolicyStore {
  return createKernelPolicyStore({ clock: clock ?? mkClock(1000), maxLifetimeMs: MAX_24H, maxVersionsPerExchange: 10 });
}

function mkPolicy(overrides?: Partial<CompiledPolicy>): CompiledPolicy {
  return {
    exchange: BITGET, sourceResearchEventId: SHA64, sourceResearchSequence: 1,
    compilerVersion: '1.0.0', compiledAt: 900, effectiveAt: 1000, expiresAt: 1000000,
    allowNewEntries: true, allowedSymbols: ['BTC/USDT'], blockedSymbols: [],
    allowedStrategyIds: ['momentum'], blockedStrategyIds: [],
    maxPositionMultiplier: 1.0, riskLevel: 'medium', directionBias: 'bullish',
    symbolRules: {}, reasonCodes: [],
    ...overrides,
  } as CompiledPolicy;
}

function mkResearchPayload(): { report: Record<string,unknown> } {
  return { report: { exchange: BITGET, timestamp: 500, updatedAt: 500, globalBias: 'bullish',
    confidence: 80, assets: [], globalLongShortRatio: 1, globalVolatility: 40, fearGreedIndex: 60,
    fundingStatus: 'positive', whitelist: ['BTC/USDT'], blacklist: [], riskEvents: [],
    meta: { source: 'manual', modelVersion: '0.1', generationTimeMs: 10, inputSummary: '' } } };
}

function env(policy: CompiledPolicy, seq: number = DEFAULT_SEQ): KernelEventEnvelope {
  return { kernelEventId: SHA64, kernelLogicalSequence: seq, kernelTimestamp: 1000 * seq,
    type: 'policy.snapshot.published', payload: { policy } } as unknown as KernelEventEnvelope;
}

// ─── Invalid config ─────────────────────────────────────────────────────────
describe('invalid config', () => {
  it('rejects missing clock', () => {
    assert.throws(() => createKernelPolicyStore({ maxLifetimeMs: 1000, maxVersionsPerExchange: 5 } as unknown as Parameters<typeof createKernelPolicyStore>[0]), /POLICY_STORE_CONFIG/);
  });
});

// ─── Provenance: sourceResearchSequence ─────────────────────────────────────
describe('provenance: sourceResearchSequence', () => {
  it('sourceResearchSequence=0 throws', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ sourceResearchSequence: 0 } as Partial<CompiledPolicy>), 5, 5000, MAX_24H), /sourceResearchSequence/);
  });
  it('sourceResearchSequence >= candidateSeq throws', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ sourceResearchSequence: 3 }), 3, 5000, MAX_24H), /publication seq/);
  });
});

// ─── Identity from envelope ─────────────────────────────────────────────────
describe('identity from envelope', () => {
  it('policyId = kernelEventId', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    kernel.publish('research.bias.updated', mkResearchPayload() as unknown as Parameters<TradingKernel['publish']>[1]);
    const r = kernel.publish('policy.snapshot.published', { policy: mkPolicy() });
    assert.strictEqual(r.envelope.kernelEventId.length, 64);
  });
  it('same policy → same eventId', () => {
    const k1 = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    const k2 = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    const p = mkPolicy();
    k1.publish('research.bias.updated', mkResearchPayload() as unknown as Parameters<TradingKernel['publish']>[1]);
    k2.publish('research.bias.updated', mkResearchPayload() as unknown as Parameters<TradingKernel['publish']>[1]);
    assert.strictEqual(
      k1.publish('policy.snapshot.published', { policy: p }).envelope.kernelEventId,
      k2.publish('policy.snapshot.published', { policy: p }).envelope.kernelEventId);
  });
  it('missing policyMaxLifetimeMs rejects policy publication', () => {
    const kernel = createTradingKernel({ exchange: BITGET });
    assert.throws(() => kernel.publish('policy.snapshot.published', { policy: mkPolicy() }), /POLICY_CONFIG_MISSING/);
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────
describe('validation', () => {
  it('rejects invalid exchange', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ exchange: 'coinbase' } as unknown as ExchangeId), 5, 5000, MAX_24H), /exchange/);
  });
  it('rejects unknown field', () => {
    assert.throws(() => validatePolicyPublication({ ...mkPolicy(), bogus: true }, 5, 5000, MAX_24H), /unknown field/);
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
    assert.throws(() => validatePolicyPublication(mkPolicy({ symbolRules: { BTC: { allowNewEntries: true, maxPositionMultiplier: 0.5, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [], bogus: true } as unknown as never } }), 5, 5000, MAX_24H), /unknown field/);
  });
  it('rejects non-array list', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ allowedSymbols: 'not-array' } as unknown as CompiledPolicy), 5, 5000, MAX_24H), /is not an array/);
  });
  it('rejects cycle', () => {
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
    validatePolicyPublication(mkPolicy({ symbolRules: { BTC: r1, ETH: r2 } }), 5, 5000, MAX_24H);
  });
  it('rejects missing symbolRules', () => {
    assert.throws(() => validatePolicyPublication(mkPolicy({ symbolRules: undefined } as unknown as CompiledPolicy), 5, 5000, MAX_24H), /symbolRules missing/);
  });
  it('rejects missing required top-level field', () => {
    const p: Record<string,unknown> = { ...mkPolicy() };
    delete p.compilerVersion;
    assert.throws(() => validatePolicyPublication(p, 5, 5000, MAX_24H), /missing required field/);
  });
  it('rejects missing required SymbolPolicyRule field', () => {
    const rule: Record<string,unknown> = { allowNewEntries: true, maxPositionMultiplier: 0.5, directionBias: 'bullish', riskLevel: 'low', allowedStrategyIds: [], blockedStrategyIds: [] };
    assert.throws(() => validatePolicyPublication(mkPolicy({ symbolRules: { BTC: rule } } as unknown as CompiledPolicy), 5, 5000, MAX_24H), /missing required field/);
  });
});

// ─── Apply ──────────────────────────────────────────────────────────────────
describe('apply', () => {
  let s: KernelPolicyStore;
  beforeEach(() => { s = mkStore(); });
  it('applies policy event', () => {
    const r = s.apply(env(mkPolicy()));
    assert.strictEqual(r.status, 'applied');
    assert.strictEqual(r.snapshot!.policyVersion, DEFAULT_SEQ);
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
    s.apply(env(mkPolicy()));
    assert.throws(() => s.apply(env(mkPolicy({ exchange: 'coinbase' } as unknown as ExchangeId))), /exchange/);
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, DEFAULT_SEQ);
  });
  it('invalid kernelEventId rejected atomically', () => {
    const badEnv = { type: 'policy.snapshot.published', kernelLogicalSequence: DEFAULT_SEQ, kernelTimestamp: 2000,
      kernelEventId: 'bad-id', payload: { policy: mkPolicy() } } as unknown as KernelEventEnvelope;
    assert.throws(() => s.apply(badEnv), /invalid kernelEventId/);
  });
});

// ─── Status resolution ─────────────────────────────────────────────────────
describe('status resolution', () => {
  it('active', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 })));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'active');
  });
  it('degraded', () => {
    const s = mkStore(mkClock(12000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000, degradeUntil: 15000 })));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'degraded');
  });
  it('expired', () => {
    const s = mkStore(mkClock(20000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 })));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').status, 'expired');
  });
});

describe('entry permission', () => {
  it('active allows', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 })));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, true);
  });
  it('degraded blocks, multiplier=0', () => {
    const s = mkStore(mkClock(12000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000, degradeUntil: 15000 })));
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r.allowNewEntries, false);
    assert.strictEqual(r.maxPositionMultiplier, 0);
  });
});

describe('symbol resolution', () => {
  it('blocked symbol forces false', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowedSymbols: [], blockedSymbols: ['BTC/USDT'] })));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, false);
  });
  it('allowlist enforced', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowedSymbols: ['ETH/USDT'] })));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, false);
  });
  it('symbol rule uses min(global,symbol) multiplier', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ maxPositionMultiplier: 0.8, symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 0.5, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } })));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').maxPositionMultiplier, 0.5);
  });
  it('symbol rule cannot relax global allow', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowNewEntries: false, symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } })));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').allowNewEntries, false);
  });
  it('riskLevel uses stricter value', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ riskLevel: 'low', symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'high', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } })));
    assert.strictEqual(s.resolve(BITGET, 'BTC/USDT').riskLevel, 'high');
  });
  it('strategy allowlist intersection', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowedStrategyIds: ['a', 'c'], symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: ['b', 'c'], blockedStrategyIds: [], reasonCodes: [] } } })));
    assert.deepStrictEqual(s.resolve(BITGET, 'BTC/USDT').allowedStrategyIds, ['c']);
  });
  it('blocked strategy sorted union', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ allowedSymbols: [], blockedStrategyIds: ['x'], symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: ['x', 'y'], reasonCodes: [] } } })));
    assert.deepStrictEqual(s.resolve(BITGET, 'BTC/USDT').blockedStrategyIds, ['x', 'y']);
  });
  it('reasonCodes sorted union', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ reasonCodes: ['global'], symbolRules: { 'BTC/USDT': { allowNewEntries: true, maxPositionMultiplier: 1, directionBias: 'bullish', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: ['symbol'] } } })));
    assert.deepStrictEqual(s.resolve(BITGET, 'BTC/USDT').reasonCodes, ['global', 'symbol']);
  });
});

describe('getLatest / getByVersion', () => {
  it('getLatest returns current', () => {
    const s = mkStore(); s.apply(env(mkPolicy()));
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, DEFAULT_SEQ);
  });
  it('getByVersion returns historical', () => {
    const s = mkStore();
    s.apply(env(mkPolicy({ effectiveAt: 1000 })));
    s.apply(env(mkPolicy({ effectiveAt: 2000 }), 3));
    assert.strictEqual(s.getByVersion(BITGET, DEFAULT_SEQ)!.effectiveAt, 1000);
  });
  it('bounded eviction', () => {
    const s = createKernelPolicyStore({ clock: mkClock(0), maxLifetimeMs: MAX_24H, maxVersionsPerExchange: 2 });
    s.apply(env(mkPolicy()));
    s.apply(env(mkPolicy(), 3));
    s.apply(env(mkPolicy(), 4));
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, 4);
    assert.strictEqual(s.getByVersion(BITGET, DEFAULT_SEQ), undefined);
  });
  it('two exchanges isolated', () => {
    const s = mkStore();
    s.apply(env(mkPolicy()));
    s.apply(env(mkPolicy({ exchange: 'binance' } as unknown as ExchangeId), 3));
    assert.ok(s.getLatest(BITGET));
    assert.ok(s.getLatest('binance' as ExchangeId));
  });
});

// ─── Immutability ──────────────────────────────────────────────────────────
describe('immutability', () => {
  it('resolve result recursively frozen', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 })));
    const r = s.resolve(BITGET, 'BTC/USDT');
    assert.ok(Object.isFrozen(r));
    assert.ok(Object.isFrozen(r.allowedStrategyIds));
    assert.ok(Object.isFrozen(r.blockedStrategyIds));
    assert.ok(Object.isFrozen(r.reasonCodes));
  });
  it('mutating input after apply cannot affect store', () => {
    const s = mkStore();
    const mutablePolicy = mkPolicy();
    s.apply(env(mutablePolicy));
    mutablePolicy.allowNewEntries = false;
    mutablePolicy.maxPositionMultiplier = 0;
    assert.strictEqual(s.getLatest(BITGET)!.allowNewEntries, true);
    assert.strictEqual(s.getLatest(BITGET)!.maxPositionMultiplier, 1);
  });
  it('mutating resolve object is ineffective', () => {
    const s = mkStore(mkClock(5000));
    s.apply(env(mkPolicy({ effectiveAt: 1000, expiresAt: 10000 })));
    const r = s.resolve(BITGET, 'BTC/USDT');
    try { (r as Record<string,unknown>).directionBias = 'bearish'; } catch { /* frozen */ }
    const r2 = s.resolve(BITGET, 'BTC/USDT');
    assert.strictEqual(r2.directionBias, 'bullish');
  });
});

// ─── Kernel integration: journal evidence ──────────────────────────────────
describe('kernel integration', () => {
  it('research → policy: provenance chain', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    // Publish research event first (seq=1)
    kernel.publish('research.bias.updated', mkResearchPayload() as unknown as Parameters<TradingKernel['publish']>[1]);
    // Publish policy at seq=2 referencing seq=1 research
    const p = mkPolicy({ sourceResearchSequence: 1 });
    const r = kernel.publish('policy.snapshot.published', { policy: p });
    assert.strictEqual(r.status, 'accepted');
    assert.strictEqual(r.envelope.kernelLogicalSequence, 2);
  });

  it('duplicate Policy publication: subscriber once, journal exact', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    let policyCount = 0;
    kernel.subscribe('policy.snapshot.published', () => { policyCount++; });
    // Research at seq=1
    kernel.publish('research.bias.updated', mkResearchPayload() as unknown as Parameters<TradingKernel['publish']>[1]);
    // Policy at seq=2
    const p = mkPolicy();
    const r1 = kernel.publish('policy.snapshot.published', { policy: p });
    assert.strictEqual(policyCount, 1);
    // Duplicate with same eventId
    const r2 = kernel.publish('policy.snapshot.published', { policy: p }, r1.envelope.kernelEventId);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(policyCount, 1);
    // Journal: research event + one policy event
    const events = kernel.journal().readFromLogicalSequence(1);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].kernelLogicalSequence, 1);
    assert.strictEqual(events[0].type, 'research.bias.updated');
    assert.strictEqual(events[1].kernelLogicalSequence, 2);
    assert.strictEqual(events[1].type, 'policy.snapshot.published');
  });

  it('invalid publication: subscriber not called, journal has only research', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    let policyCount = 0;
    kernel.subscribe('policy.snapshot.published', () => { policyCount++; });
    // Research at seq=1
    kernel.publish('research.bias.updated', mkResearchPayload() as unknown as Parameters<TradingKernel['publish']>[1]);
    const before = policyCount;
    // Invalid policy: missing symbolRules
    assert.throws(() => kernel.publish('policy.snapshot.published',
      { policy: mkPolicy({ symbolRules: null } as unknown as CompiledPolicy) }), /symbolRules/);
    assert.strictEqual(policyCount, before);
    // Journal: only research event, no policy event
    const events = kernel.journal().readFromLogicalSequence(1);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'research.bias.updated');
  });

  it('store integration: publish → apply', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    const s = mkStore();
    kernel.subscribe('policy.snapshot.published', (e) => { s.apply(e); });
    kernel.publish('research.bias.updated', mkResearchPayload() as unknown as Parameters<TradingKernel['publish']>[1]);
    kernel.publish('policy.snapshot.published', { policy: mkPolicy() });
    assert.ok(s.getLatest(BITGET));
    assert.strictEqual(s.getLatest(BITGET)!.policyVersion, 2);
  });

  it('same-kernel duplicate publish: dispatched once', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    let count = 0;
    kernel.subscribe('policy.snapshot.published', () => { count++; });
    kernel.publish('research.bias.updated', mkResearchPayload() as unknown as Parameters<TradingKernel['publish']>[1]);
    const p = mkPolicy();
    const r1 = kernel.publish('policy.snapshot.published', { policy: p });
    assert.strictEqual(r1.status, 'accepted');
    assert.strictEqual(count, 1);
    const r2 = kernel.publish('policy.snapshot.published', { policy: p }, r1.envelope.kernelEventId);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(count, 1);
  });

  it('invalid publication: subscriber not called', () => {
    const kernel = createTradingKernel({ exchange: BITGET, policyMaxLifetimeMs: MAX_24H });
    let called = false;
    kernel.subscribe('policy.snapshot.published', () => { called = true; });
    assert.throws(() => kernel.publish('policy.snapshot.published',
      { policy: mkPolicy({ exchange: 'coinbase' } as unknown as ExchangeId) }), /exchange/);
    assert.strictEqual(called, false);
  });
});
