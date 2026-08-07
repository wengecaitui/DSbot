// Phase 2: PreTrade Risk Gateway — contract tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { evaluatePreTradeRisk } from '../../src/risk/PreTradeRiskGateway';
import type { GatewayInput, MarketSnapshot, PolicyResolution, PositionResolution, HardRiskSnapshot, TradeAction } from '../../src/risk/pretrade-risk-types';

const BITGET = 'bitget';

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

function evaluate(action: TradeAction, overrides?: Partial<GatewayInput>) {
  const base: GatewayInput = {
    intent: mkIntent(), action, marketSnapshot: mkMarket(),
    policyResolution: mkPolicy(), positionResolution: mkPosition(),
    hardRisk: mkHardRisk(),
  };
  return evaluatePreTradeRisk({ ...base, ...overrides } as GatewayInput);
}

// ─── Market safety ──────────────────────────────────────────────────────────
describe('market safety', () => {
  it('missing market → REJECTED', () => {
    assert.strictEqual(evaluate('open', { marketSnapshot: undefined }).decision, 'REJECTED');
  });
  it('stale market → REJECTED', () => {
    assert.strictEqual(evaluate('open', { marketSnapshot: mkMarket({ isStale: true }) }).decision, 'REJECTED');
  });
  it('bad price → REJECTED', () => {
    assert.strictEqual(evaluate('open', { marketSnapshot: mkMarket({ ticker: { ticker: { last: 0 } } }) }).decision, 'REJECTED');
  });
});

// ─── Position checks ────────────────────────────────────────────────────────
describe('position checks', () => {
  it('position missing → REJECTED', () => {
    assert.strictEqual(evaluate('open', { positionResolution: mkPosition({ status: 'missing' }) }).decision, 'REJECTED');
  });
  it('flat + open → ADMITTED', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 1000);
  });
  it('same-side open → ADMITTED', () => {
    const r = evaluate('open', { positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 1000000 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
  });
  it('opposite-side open → REJECTED', () => {
    const r = evaluate('open', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }) });
    assert.strictEqual(r.decision, 'REJECTED');
  });
});

// ─── Hard risk ──────────────────────────────────────────────────────────────
describe('hard risk', () => {
  it('hard lock → REJECTED', () => {
    assert.strictEqual(evaluate('open', { hardRisk: mkHardRisk({ locked: true }) }).decision, 'REJECTED');
  });
  it('pct cap → capped', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.01 }) });
    assert.strictEqual(r.approvedPositionUsd, 1000);
  });
  it('abs cap → capped', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 5000 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15, maxSinglePositionAbsUsd: 2000 }) });
    assert.strictEqual(r.approvedPositionUsd, 2000);
  });
  it('post-trade exposure at limit → REJECTED', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 1000 }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 2000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'REJECTED');
  });
  it('enabled=false → ADMITTED', () => {
    assert.strictEqual(evaluate('open', { hardRisk: mkHardRisk({ enabled: false, totalCapitalUsd: 0 }) }).decision, 'ADMITTED');
  });
});

// ─── Policy ─────────────────────────────────────────────────────────────────
describe('policy', () => {
  it('missing → REJECTED', () => {
    assert.strictEqual(evaluate('open', { policyResolution: mkPolicy({ status: 'missing' }) }).decision, 'REJECTED');
  });
  it('expired → REJECTED', () => {
    assert.strictEqual(evaluate('open', { policyResolution: mkPolicy({ status: 'expired' }) }).decision, 'REJECTED');
  });
  it('degraded → REJECTED', () => {
    assert.strictEqual(evaluate('open', { policyResolution: mkPolicy({ status: 'degraded' }) }).decision, 'REJECTED');
  });
  it('allowNewEntries=false → REJECTED', () => {
    assert.strictEqual(evaluate('open', { policyResolution: mkPolicy({ allowNewEntries: false }) }).decision, 'REJECTED');
  });
  it('bullish + short → REJECTED', () => {
    assert.strictEqual(evaluate('open', { intent: mkIntent({ direction: 'short' }),
      policyResolution: mkPolicy({ directionBias: 'bullish' }) }).decision, 'REJECTED');
  });
  it('bearish + long → REJECTED', () => {
    assert.strictEqual(evaluate('open', { policyResolution: mkPolicy({ directionBias: 'bearish' }) }).decision, 'REJECTED');
  });
  it('multiplier tightens hard cap', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 2000 }),
      policyResolution: mkPolicy({ maxPositionMultiplier: 0.5 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
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
  it('reduce caps at intent', () => {
    const r = evaluate('reduce', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }) });
    assert.strictEqual(r.approvedPositionUsd, 1000);
  });
  it('close = current exposure', () => {
    const r = evaluate('close', { intent: mkIntent({ direction: 'short' }),
      positionResolution: mkPosition({ status: 'open', side: 'long', signedQuantity: 1 }) });
    assert.strictEqual(r.approvedPositionUsd, 50000);
  });
});

// ─── Determinism ────────────────────────────────────────────────────────────
describe('determinism', () => {
  it('identical input → identical result', () => {
    const input: GatewayInput = { intent: mkIntent(), action: 'open', marketSnapshot: mkMarket(),
      policyResolution: mkPolicy(), positionResolution: mkPosition(), hardRisk: mkHardRisk() };
    assert.deepStrictEqual(evaluatePreTradeRisk(input), evaluatePreTradeRisk({ ...input }));
  });
});

// ─── FIX_1: NaN rejection ──────────────────────────────────────────────────
describe('fix: NaN rejection', () => {
  it('enabled=false + multiplier=0 → REJECTED, never NaN', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: false, totalCapitalUsd: 0 }),
      policyResolution: mkPolicy({ maxPositionMultiplier: 0 }) });
    assert.strictEqual(r.decision, 'REJECTED');
  });
  it('every ADMITTED has finite>0 approvedPositionUsd', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.ok(Number.isFinite(r.approvedPositionUsd));
    assert.ok(r.approvedPositionUsd! > 0);
  });
  it('malformed hardRisk.locked non-boolean → REJECTED', () => {
    assert.strictEqual(evaluate('open', { hardRisk: mkHardRisk({ locked: 1 } as unknown as HardRiskSnapshot) }).decision, 'REJECTED');
  });
  it('malformed hardRisk.enabled non-boolean → REJECTED', () => {
    assert.strictEqual(evaluate('open', { hardRisk: mkHardRisk({ enabled: 'true' } as unknown as HardRiskSnapshot) }).decision, 'REJECTED');
  });
  it('maxSinglePositionAbsUsd=Infinity accepted', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionAbsUsd: Infinity }) });
    assert.strictEqual(r.decision, 'ADMITTED');
  });
  it('policy multiplier actually caps: hard=15000 × 0.5=7500', () => {
    const r = evaluate('open', { intent: mkIntent({ positionUsd: 10000 }),
      policyResolution: mkPolicy({ maxPositionMultiplier: 0.5 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.approvedPositionUsd, 7500);
  });
});

// ─── FIX_2: Canonical intent preserved ─────────────────────────────────────
describe('fix: canonical intent', () => {
  it('ADMITTED preserves original intent.positionUsd (requested size)', () => {
    const intent = mkIntent({ positionUsd: 10000 });
    const r = evaluate('open', { intent,
      policyResolution: mkPolicy({ maxPositionMultiplier: 0.5 }),
      hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000, maxSinglePositionPct: 0.15 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.intent.positionUsd, 10000); // original requested
    assert.strictEqual(r.approvedPositionUsd, 7500); // risk-capped
  });
  it('ADMITTED preserves intentId unchanged', () => {
    const r = evaluate('open', { hardRisk: mkHardRisk({ enabled: true, totalCapitalUsd: 100000 }) });
    assert.strictEqual(r.decision, 'ADMITTED');
    assert.strictEqual(r.intent.intentId, 'intent-001');
  });
});
