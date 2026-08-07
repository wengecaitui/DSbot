// Phase 2: PreTrade Risk Gateway — contract tests with canonical types
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { TradeIntent } from '../../src/types/trade-intent';
import type { MarketSnapshot } from '../../src/data/MarketSnapshot';
import type { PolicyResolution } from '../../src/types/policy-snapshot';
import type { PositionResolution } from '../../src/types/position-state';
import { evaluatePreTradeRisk } from '../../src/risk/PreTradeRiskGateway';
import type { GatewayInput, HardRiskSnapshot, TradeAction } from '../../src/risk/pretrade-risk-types';

const BITGET = 'bitget' as ExchangeId;

function mkIntent(overrides?: Partial<TradeIntent>): TradeIntent {
  return { intentId: 'intent-001', exchange: BITGET, symbol: 'BTC/USDT',
    direction: 'long', orderType: 'market', positionUsd: 1000, source: 'test',
    createdAt: 1000, reason: 'test', biasUpdatedAt: 500, ...overrides } as TradeIntent;
}

function mkMarket(overrides?: Partial<MarketSnapshot>): MarketSnapshot {
  return { exchange: BITGET, symbol: 'BTC/USDT', isStale: false,
    ticker: { ticker: { last: 50000 } as Partial<MarketSnapshot['ticker']>['ticker'] } as Partial<MarketSnapshot['ticker']>['ticker'],
    klines: {}, snapshotVersion: 1, generatedAt: 1000, lastUpdatedAt: 1000, ageMs: 0,
    ...overrides } as unknown as MarketSnapshot;
}

function mkPolicy(overrides?: Partial<PolicyResolution>): PolicyResolution {
  return { status: 'active', policy: null, allowNewEntries: true, maxPositionMultiplier: 1,
    directionBias: 'neutral', riskLevel: 'medium', allowedStrategyIds: [], blockedStrategyIds: [],
    reasonCodes: [], ...overrides } as PolicyResolution;
}

function mkPosition(overrides?: Partial<PositionResolution>): PositionResolution {
  return { status: 'flat', snapshot: null, side: 'flat', signedQuantity: 0,
    averageEntryPrice: 0, ...overrides } as PositionResolution;
}

function mkHardRisk(overrides?: Partial<HardRiskSnapshot>): HardRiskSnapshot {
  return { exchange: BITGET, locked: false, enabled: false, totalCapitalUsd: 0,
    maxSinglePositionPct: 0.15, maxSinglePositionAbsUsd: 100000, ...overrides };
}

function evaluate(action: TradeAction, overrides?: Partial<GatewayInput>) {
  const base: GatewayInput = {
    intent: mkIntent(), action, marketSnapshot: mkMarket(),
    policyResolution: mkPolicy(), positionResolution: mkPosition(), hardRisk: mkHardRisk() };
  return evaluatePreTradeRisk({ ...base, ...overrides });
}

// ─── Market safety ──────────────────────────────────────────────────────────
describe('market safety', () => {
  it('missing → REJECTED', () => {
    assert.strictEqual(evaluate('open', { marketSnapshot: undefined }).decision, 'REJECTED');
  });
  it('stale → REJECTED', () => {
    assert.strictEqual(evaluate('open', { marketSnapshot: mkMarket({ isStale: true }) }).decision, 'REJECTED');
  });
  it('bad price → REJECTED', () => {
    assert.strictEqual(evaluate('open', { marketSnapshot: mkMarket({ ticker: null }) }).decision, 'REJECTED');
  });
});

// ─── Position checks ────────────────────────────────────────────────────────
describe('position checks', () => {
  it('missing → REJECTED', () => {
    assert.strictEqual(evaluate('open', { positionResolution: mkPosition({ status: 'missing' }) }).decision, 'REJECTED');
  });
  it('flat+open → ADMITTED', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 1000);
  });
  it('same-side → ADMITTED', () => {
    const r = evaluate('open', { positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 1000000 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
  });
  it('opposite open → REJECTED', () => {
    const r = evaluate('open', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }) });
    assert.strictEqual(r.decision, 'REJECTED');
  });
});

// ─── Hard risk ──────────────────────────────────────────────────────────────
describe('hard risk', () => {
  it('locked → REJECTED', () => {
    assert.strictEqual(evaluate('open', { hardRisk: mkHardRisk({ locked: true }) }).decision, 'REJECTED');
  });
  it('pct cap', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.01 }) });
    assert.strictEqual(r.approvedPositionUsd, 1000);
  });
  it('abs cap', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 5000 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15, maxSinglePositionAbsUsd: 2000 }) });
    assert.strictEqual(r.approvedPositionUsd, 2000);
  });
  it('post-trade at limit → REJECTED', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 1000 }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 2000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'REJECTED');
  });
  it('enabled=false', () => {
    assert.strictEqual(evaluate('open', { hardRisk: mkHardRisk({ enabled: false, totalCapitalUsd: 0 }) }).decision, 'ADMITTED');
  });
});

// ─── Policy ─────────────────────────────────────────────────────────────────
describe('policy', () => {
  it('missing → REJECTED', () => {
    assert.strictEqual(evaluate('open', { policyResolution: mkPolicy({ status: 'missing' }) }).decision, 'REJECTED');
  });
  it('entries blocked', () => {
    assert.strictEqual(evaluate('open', { policyResolution: mkPolicy({ allowNewEntries: false }) }).decision, 'REJECTED');
  });
  it('bullish+short', () => {
    assert.strictEqual(evaluate('open', { intent: mkIntent({ direction: 'short' }),
      policyResolution: mkPolicy({ directionBias: 'bullish' }) }).decision, 'REJECTED');
  });
  it('bearish+long', () => {
    assert.strictEqual(evaluate('open', { policyResolution: mkPolicy({ directionBias: 'bearish' }) }).decision, 'REJECTED');
  });
  it('multiplier tightens', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 2000 }),
      policyResolution: mkPolicy({ maxPositionMultiplier: 0.5 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.approvedPositionUsd, 2000);
  });
});

// ─── Protective bypass ──────────────────────────────────────────────────────
describe('protective bypass', () => {
  it('reduce bypasses Policy', () => {
    assert.strictEqual(evaluate('reduce', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      policyResolution: mkPolicy({ status: 'missing' }) }).decision, 'ADMITTED');
  });
  it('close bypasses Policy', () => {
    assert.strictEqual(evaluate('close', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      policyResolution: mkPolicy({ status: 'missing' }) }).decision, 'ADMITTED');
  });
  it('emergency_exit bypasses Policy', () => {
    assert.strictEqual(evaluate('emergency_exit', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      policyResolution: mkPolicy({ status: 'missing' }) }).decision, 'ADMITTED');
  });
});

// ─── NaN/invariance ─────────────────────────────────────────────────────────
describe('invariance', () => {
  it('multiplier=0 → REJECTED', () => {
    assert.strictEqual(evaluate('open', { hardRisk: mkHardRisk({ enabled: false }),
      policyResolution: mkPolicy({ maxPositionMultiplier: 0 }) }).decision, 'REJECTED');
  });
  it('every ADMITTED finite>0', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.ok(Number.isFinite(r.approvedPositionUsd));
    assert.ok(r.approvedPositionUsd > 0);
  });
  it('bad locked boolean', () => {
    assert.strictEqual(evaluate('open', { hardRisk: mkHardRisk({ locked: 1 }) as unknown as HardRiskSnapshot }).decision, 'REJECTED');
  });
  it('bad enabled boolean', () => {
    assert.strictEqual(evaluate('open', { hardRisk: mkHardRisk({ enabled: 'true' }) as unknown as HardRiskSnapshot }).decision, 'REJECTED');
  });
  it('Infinity abs cap ok', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionAbsUsd: Infinity }) });
    assert.strictEqual(r.decision, 'ADMITTED');
  });
  it('multiplier .5 caps hard', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 10000 }),
      policyResolution: mkPolicy({ maxPositionMultiplier: 0.5 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.approvedPositionUsd, 7500);
  });
});

// ─── Canonical intent preserved ─────────────────────────────────────────────
describe('canonical intent', () => {
  it('ADMITTED preserves all TradeIntent fields', () => {
    const intent = mkIntent({ positionUsd: 10000 });
    const r = evaluate('open', { intent,
      policyResolution: mkPolicy({ maxPositionMultiplier: 0.5 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.intent.intentId, 'intent-001');
    assert.strictEqual(r.intent.exchange, BITGET);
    assert.strictEqual(r.intent.symbol, 'BTC/USDT');
    assert.strictEqual(r.intent.direction, 'long');
    assert.strictEqual(r.intent.orderType, 'market');
    assert.strictEqual(r.intent.positionUsd, 10000);
    assert.strictEqual(r.intent.source, 'test');
    assert.strictEqual(r.intent.reason, 'test');
    assert.strictEqual(r.approvedPositionUsd, 7500);
  });
});

// ─── Universal finite admission ─────────────────────────────────────────────
describe('universal finite admission', () => {
  it('close malformed non-finite exposure → REJECTED', () => {
    const r = evaluate('close', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: NaN }) });
    assert.strictEqual(r.decision, 'REJECTED');
  });
  it('emergency_exit malformed non-finite exposure → REJECTED', () => {
    const r = evaluate('emergency_exit', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: NaN }) });
    assert.strictEqual(r.decision, 'REJECTED');
  });
  it('reduce truncated at intent (finite)', () => {
    const r = evaluate('reduce', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 1000);
  });
  it('close = current exposure (finite)', () => {
    const r = evaluate('close', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }) });
    assert.strictEqual(r.approvedPositionUsd, 50000);
    assert.ok(Number.isFinite(r.approvedPositionUsd));
  });
});

// ─── Determinism ────────────────────────────────────────────────────────────
describe('determinism', () => {
  it('same input → same output', () => {
    const input: GatewayInput = { intent: mkIntent(), action: 'open', marketSnapshot: mkMarket(),
      policyResolution: mkPolicy(), positionResolution: mkPosition(), hardRisk: mkHardRisk() };
    assert.deepStrictEqual(evaluatePreTradeRisk(input), evaluatePreTradeRisk({ ...input }));
  });
});
