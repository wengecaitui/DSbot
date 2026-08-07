// Phase 2: PreTrade Risk Gateway — contract tests (RED first)
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import { evaluatePreTradeRisk } from '../../src/risk/PreTradeRiskGateway';
import type { GatewayInput, MarketSnapshot, PolicyResolution, PositionResolution, HardRiskSnapshot, TradeAction } from '../../src/risk/pretrade-risk-types';

const BITGET = 'bitget' as ExchangeId;

// ─── Fixtures ───────────────────────────────────────────────────────────────

function mkIntent(overrides?: Partial<{ positionUsd: number; direction: 'long' | 'short'; symbol: string }>) {
  return { intentId: 'intent-001', exchange: BITGET, symbol: 'BTC/USDT',
    direction: 'long' as const, positionUsd: 1000, ...overrides };
}

function mkMarket(overrides?: Partial<MarketSnapshot>): MarketSnapshot {
  return { exchange: BITGET, symbol: 'BTC/USDT', isStale: false,
    ticker: { ticker: { last: 50000 } }, ...overrides };
}

function mkPolicy(overrides?: Partial<PolicyResolution>): PolicyResolution {
  return { status: 'active', allowNewEntries: true, maxPositionMultiplier: 1,
    directionBias: 'neutral', ...overrides };
}

function mkPosition(overrides?: Partial<PositionResolution>): PositionResolution {
  return { status: 'flat', side: 'flat', signedQuantity: 0, ...overrides };
}

function mkHardRisk(overrides?: Partial<HardRiskSnapshot>): HardRiskSnapshot {
  return { exchange: BITGET, locked: false, enabled: false, totalCapitalUsd: 0,
    maxSinglePositionPct: 0.15, maxSinglePositionAbsUsd: 100000, ...overrides };
}

function evaluate(action: TradeAction, overrides?: Partial<GatewayInput>): ReturnType<typeof evaluatePreTradeRisk> {
  const base: GatewayInput = {
    intent: mkIntent(), action, marketSnapshot: mkMarket(),
    policyResolution: mkPolicy(), positionResolution: mkPosition(),
    hardRisk: mkHardRisk(),
  };
  return evaluatePreTradeRisk({ ...base, ...overrides } as GatewayInput);
}

// ─── Market ─────────────────────────────────────────────────────────────────
describe('market safety', () => {
  it('missing market → REJECTED', () => {
    const r = evaluate('open', { marketSnapshot: undefined });
    assert.strictEqual(r.decision, 'REJECTED');
    assert.strictEqual(r.reasonCode, 'MARKET_MISSING');
  });
  it('stale market → REJECTED', () => {
    const r = evaluate('open', { marketSnapshot: mkMarket({ isStale: true }) });
    assert.strictEqual(r.decision, 'REJECTED');
    assert.strictEqual(r.reasonCode, 'MARKET_STALE');
  });
  it('bad price → REJECTED', () => {
    const r = evaluate('open', { marketSnapshot: mkMarket({ ticker: { ticker: { last: 0 } } }) });
    assert.strictEqual(r.decision, 'REJECTED');
    assert.strictEqual(r.reasonCode, 'MARKET_PRICE_INVALID');
  });
});

// ─── Position ───────────────────────────────────────────────────────────────
describe('position checks', () => {
  it('position missing → REJECTED', () => {
    const r = evaluate('open', { positionResolution: mkPosition({ status: 'missing' }) });
    assert.strictEqual(r.decision, 'REJECTED');
    assert.strictEqual(r.reasonCode, 'POSITION_UNKNOWN');
  });
  it('flat + open → ADMITTED', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 1000);
  });
  it('same-side open → scale-in ADMITTED', () => {
    const r = evaluate('open', { positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 1000000 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
  });
  it('opposite-side open → REJECTED', () => {
    const r = evaluate('open', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }) });
    assert.strictEqual(r.decision, 'REJECTED');
    assert.strictEqual(r.reasonCode, 'ACTION_POSITION_CONFLICT');
  });
});

// ─── Hard risk ──────────────────────────────────────────────────────────────
describe('hard risk', () => {
  it('hard lock → REJECTED', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ locked: true }) });
    assert.strictEqual(r.decision, 'REJECTED');
    assert.strictEqual(r.reasonCode, 'KILLSWITCH_LOCKED');
  });
  it('pct cap → post-trade exposure capped', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.01 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 1000); // min(1000, 100000*0.01=1000)
  });
  it('abs cap → post-trade exposure capped', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 5000 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15, maxSinglePositionAbsUsd: 2000 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 2000);
  });
  it('post-trade exposure at limit → REJECTED', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 1000 }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 2000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'REJECTED');
    assert.strictEqual(r.reasonCode, 'POSITION_LIMIT_REACHED');
  });
  it('hardRisk.enabled=false → admission ok', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: false, totalCapitalUsd: 0 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
  });
});

// ─── Policy ─────────────────────────────────────────────────────────────────
describe('policy', () => {
  it('policy missing → REJECTED open', () => {
    const r = evaluate('open', { policyResolution: mkPolicy({ status: 'missing' }) });
    assert.strictEqual(r.decision, 'REJECTED');
    assert.strictEqual(r.reasonCode, 'POLICY_UNAVAILABLE');
  });
  it('policy expired → REJECTED open', () => {
    const r = evaluate('open', { policyResolution: mkPolicy({ status: 'expired' }) });
    assert.strictEqual(r.reasonCode, 'POLICY_UNAVAILABLE');
  });
  it('policy degraded → REJECTED open', () => {
    const r = evaluate('open', { policyResolution: mkPolicy({ status: 'degraded' }) });
    assert.strictEqual(r.reasonCode, 'POLICY_UNAVAILABLE');
  });
  it('allowNewEntries=false → REJECTED', () => {
    const r = evaluate('open', { policyResolution: mkPolicy({ allowNewEntries: false }) });
    assert.strictEqual(r.reasonCode, 'POLICY_ENTRIES_BLOCKED');
  });
  it('bullish policy + short intent → REJECTED', () => {
    const r = evaluate('open', { intent: mkIntent({ direction: 'short' }),
      policyResolution: mkPolicy({ directionBias: 'bullish' }) });
    assert.strictEqual(r.reasonCode, 'POLICY_DIRECTION_MISMATCH');
  });
  it('bearish policy + long intent → REJECTED', () => {
    const r = evaluate('open', { policyResolution: mkPolicy({ directionBias: 'bearish' }) });
    assert.strictEqual(r.reasonCode, 'POLICY_DIRECTION_MISMATCH');
  });
  it('policy multiplier tightens hard cap', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 2000 }),
      policyResolution: mkPolicy({ maxPositionMultiplier: 0.5 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 2000); // 2000 < 15000*0.5=7500
  });
});

// ─── Protective action bypass ──────────────────────────────────────────────
describe('protective action bypass', () => {
  it('reduce bypasses even missing Policy', () => {
    const r = evaluate('reduce', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      policyResolution: mkPolicy({ status: 'missing' }) });
    assert.strictEqual(r.decision, 'ADMITTED');
  });
  it('close bypasses even missing Policy', () => {
    const r = evaluate('close', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      policyResolution: mkPolicy({ status: 'missing' }) });
    assert.strictEqual(r.decision, 'ADMITTED');
  });
  it('emergency_exit bypasses even missing Policy', () => {
    const r = evaluate('emergency_exit', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      policyResolution: mkPolicy({ status: 'missing' }) });
    assert.strictEqual(r.decision, 'ADMITTED');
  });
  it('reduce cannot flip position', () => {
    // reduce of 1000 against long 1 BTC — capped at 1000 (not current 50000)
    const r = evaluate('reduce', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 1000); // min(1000, 50000) = 1000
  });
  it('close approved size = current exposure', () => {
    const r = evaluate('close', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 50000); // currentExposure = 1 * 50000
  });
});

// ─── Provenance ─────────────────────────────────────────────────────────────
describe('provenance', () => {
  it('exchange mismatch → REJECTED', () => {
    const r = evaluate('open', { marketSnapshot: mkMarket({ exchange: 'binance' as ExchangeId }) });
    assert.strictEqual(r.reasonCode, 'PROVENANCE_MISMATCH');
  });
});

// ─── Determinism ────────────────────────────────────────────────────────────
describe('determinism', () => {
  it('identical input → identical result', () => {
    const input: GatewayInput = {
      intent: mkIntent(), action: 'open', marketSnapshot: mkMarket(),
      policyResolution: mkPolicy(), positionResolution: mkPosition(),
      hardRisk: mkHardRisk(),
    };
    const r1 = evaluatePreTradeRisk(input);
    const r2 = evaluatePreTradeRisk({ ...input });
    assert.deepStrictEqual(r1, r2);
  });
});
