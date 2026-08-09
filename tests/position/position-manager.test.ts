// Phase 4: Position Management — final integration repair tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { PositionManager } from '../../src/position/PositionManager';
import { PositionPlanStore } from '../../src/position/PositionPlanStore';
import { generatePlanId } from '../../src/position/plan-id';
import { buildProtectiveIntent, evaluateAndRoute } from '../../src/position/ProtectiveExecutor';
import type { ProtectiveContext, ProtectiveOutcome } from '../../src/position/ProtectiveExecutor';
import type { PositionPlan } from '../../src/position/position-plan-types';
import type { PositionResolution } from '../../src/types/position-state';

function mkPosition(overrides?: Partial<PositionResolution>): PositionResolution {
  return { status: 'open', snapshot: null, side: 'long', signedQuantity: 1, averageEntryPrice: 50000, ...overrides } as PositionResolution;
}
function makePlan(status: string, stopPrice: number, side: 'long' | 'short'): PositionPlan {
  return { planId: generatePlanId('BTC/USDT', side, 50000, 0), symbol: 'BTC/USDT',
    positionSide: side, side, entryPrice: 50000, entryQuantity: 1, stopPrice,
    status: status as any, planVersion: 0, sourceKernelEventId: 'e0' };
}

const unlockedHardRisk = { exchange: 'bitget' as any, locked: false, enabled: true, totalCapitalUsd: 1_000_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: Infinity };

// ─── Real Gateway context ───────────────────────────────────────────────────
describe('ProtectiveExecutor → real Gateway', () => {
  it('valid long stop close → ADMITTED through real Gateway', () => {
    const ctx: ProtectiveContext = { plan: makePlan('active', 47500, 'long'), currentPosition: mkPosition({ side: 'long', signedQuantity: 1, averageEntryPrice: 50000 }), marketPrice: 47499, hardRisk: unlockedHardRisk };
    const r = evaluateAndRoute(ctx);
    assert.strictEqual(r.submitted, true);
    assert.ok((r as any).orderId.startsWith('protect-'));
  });
  it('valid short stop close → ADMITTED', () => {
    const ctx: ProtectiveContext = { plan: makePlan('active', 52500, 'short'), currentPosition: mkPosition({ side: 'short', signedQuantity: -1, averageEntryPrice: 50000 }), marketPrice: 52501, hardRisk: unlockedHardRisk };
    assert.strictEqual(evaluateAndRoute(ctx).submitted, true);
  });
  it('hardRisk locked → blocked', () => {
    const ctx: ProtectiveContext = { plan: makePlan('active', 47500, 'long'), currentPosition: mkPosition(), marketPrice: 47499, hardRisk: { ...unlockedHardRisk, locked: true } };
    const r = evaluateAndRoute(ctx);
    assert.strictEqual(r.submitted, false);
    assert.strictEqual(r.reason, 'hardrisk_locked');
  });
  it('missing position → no_position', () => {
    const ctx: ProtectiveContext = { plan: makePlan('active', 47500, 'long'), currentPosition: mkPosition({ status: 'missing' }), marketPrice: 47499, hardRisk: unlockedHardRisk };
    assert.strictEqual(evaluateAndRoute(ctx).submitted, false);
    assert.strictEqual((evaluateAndRoute(ctx) as any).reason, 'no_position');
  });
  it('flat position → no_position', () => {
    const ctx: ProtectiveContext = { plan: makePlan('active', 47500, 'long'), currentPosition: mkPosition({ status: 'flat' }), marketPrice: 47499, hardRisk: unlockedHardRisk };
    assert.strictEqual(evaluateAndRoute(ctx).submitted, false);
  });
});

// ─── Current PositionState sizing ───────────────────────────────────────────
describe('Current PositionState sizing', () => {
  it('close size from current signedQty * avgEntry, not plan qty', () => {
    const plan = makePlan('active', 47500, 'long');
    // Scale-in: current 2 BTC @ 52000 avg
    const pos = mkPosition({ side: 'long', signedQuantity: 2, averageEntryPrice: 52000 });
    const intent = buildProtectiveIntent({ plan, currentPosition: pos, marketPrice: 51000, hardRisk: unlockedHardRisk });
    assert.strictEqual(intent.positionUsd, 104000); // 2 * 52000, not 1 * 50000
  });
  it('scale-in changes close size', () => {
    const plan = makePlan('active', 47500, 'long');
    const pos1 = mkPosition({ signedQuantity: 1, averageEntryPrice: 50000 });
    const pos2 = mkPosition({ signedQuantity: 3, averageEntryPrice: 51000 });
    assert.notStrictEqual(
      buildProtectiveIntent({ plan, currentPosition: pos1, marketPrice: 50000, hardRisk: unlockedHardRisk }).positionUsd,
      buildProtectiveIntent({ plan, currentPosition: pos2, marketPrice: 50000, hardRisk: unlockedHardRisk }).positionUsd,
    );
  });
  it('partial reduce uses reduced remaining qty', () => {
    const pos = mkPosition({ side: 'long', signedQuantity: 0.3, averageEntryPrice: 50000 });
    const intent = buildProtectiveIntent({ plan: makePlan('active', 47500, 'long'), currentPosition: pos, marketPrice: 49000, hardRisk: unlockedHardRisk });
    assert.strictEqual(intent.positionUsd, 15000); // 0.3 * 50000
  });
});

// ─── Exit idempotency ───────────────────────────────────────────────────────
describe('Exit idempotency', () => {
  it('same plan + same position → same intentId', () => {
    const ctx: ProtectiveContext = { plan: makePlan('active', 47500, 'long'), currentPosition: mkPosition(), marketPrice: 47499, hardRisk: unlockedHardRisk };
    assert.strictEqual(
      buildProtectiveIntent(ctx).intentId,
      buildProtectiveIntent(ctx).intentId,
    );
  });
  it('repeated stop ticks → same intentId', () => {
    const plan = makePlan('active', 47500, 'long');
    const pos = mkPosition();
    assert.strictEqual(
      buildProtectiveIntent({ plan, currentPosition: pos, marketPrice: 47400, hardRisk: unlockedHardRisk }).intentId,
      buildProtectiveIntent({ plan, currentPosition: pos, marketPrice: 47300, hardRisk: unlockedHardRisk }).intentId,
    );
  });
  it('no Date.now() in intent construction', () => {
    const intent = buildProtectiveIntent({ plan: makePlan('active', 47500, 'long'), currentPosition: mkPosition(), marketPrice: 47499, hardRisk: unlockedHardRisk });
    assert.strictEqual(intent.createdAt, 0);
    assert.strictEqual(intent.biasUpdatedAt, 0);
  });
  it('deterministic: same inputs → same intent', () => {
    const ctx: ProtectiveContext = { plan: makePlan('active', 47500, 'long'), currentPosition: mkPosition(), marketPrice: 47499, hardRisk: unlockedHardRisk };
    assert.deepStrictEqual(buildProtectiveIntent(ctx), buildProtectiveIntent({ ...ctx, plan: { ...ctx.plan } }));
  });
});

// ─── Full close / flip lifecycle ────────────────────────────────────────────
describe('Full close / flip lifecycle', () => {
  it('full close → plan closed, no active', () => {
    const store = new PositionPlanStore();
    const plan = makePlan('active', 47500, 'long');
    store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'position.plan.closed', payload: { planId: plan.planId }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.getActive('BTC/USDT'), undefined);
  });
  it('flip → old plan closed, new plan with different planId', () => {
    const mgr = new PositionManager();
    const store = new PositionPlanStore();
    const p1 = mgr.onFill(mkPosition({ side: 'long' }), 'BTC/USDT', undefined);
    store.apply({ type: 'position.plan.created', payload: { plan: p1! }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'position.plan.closed', payload: { planId: p1!.planId }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.getActive('BTC/USDT'), undefined);
    const p2 = mgr.onFill(mkPosition({ side: 'short', signedQuantity: -1, averageEntryPrice: 51000 }), 'BTC/USDT', undefined);
    store.apply({ type: 'position.plan.created', payload: { plan: p2! }, kernelLogicalSequence: 3, kernelEventId: 'e3' } as any);
    assert.strictEqual(store.getActive('BTC/USDT')!.side, 'short');
    assert.notStrictEqual(p2!.planId, p1!.planId);
  });
});

// ─── Plan identity ──────────────────────────────────────────────────────────
describe('Plan identity', () => {
  it('different entry price → different planId', () => {
    assert.notStrictEqual(generatePlanId('BTC/USDT', 'long', 50000, 0), generatePlanId('BTC/USDT', 'long', 50100, 0));
  });
  it('different symbol → different planId', () => {
    assert.notStrictEqual(generatePlanId('BTC/USDT', 'long', 50000, 0), generatePlanId('ETH/USDT', 'long', 50000, 0));
  });
  it('later position cycle → different planId (different entry)', () => {
    // Same symbol+side, but different entry price after close+reopen
    assert.notStrictEqual(generatePlanId('BTC/USDT', 'long', 50000, 0), generatePlanId('BTC/USDT', 'long', 55000, 0));
  });
});

// ─── Plan event store validation ────────────────────────────────────────────
describe('Plan event store validation', () => {
  it('plan.created without planId → store rejects', () => {
    const s = new PositionPlanStore();
    assert.throws(() => s.apply({ type: 'position.plan.created', payload: { plan: {} }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any));
  });
  it('plan.updated without planId → store rejects', () => {
    const s = new PositionPlanStore();
    assert.throws(() => s.apply({ type: 'position.plan.updated', payload: {}, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any));
  });
  it('plan.archived without planId → store rejects', () => {
    const s = new PositionPlanStore();
    assert.throws(() => s.apply({ type: 'position.plan.archived', payload: {}, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any));
  });
  it('stale sequence → no mutation', () => {
    const s = new PositionPlanStore();
    const p = makePlan('active', 47500, 'long');
    s.apply({ type: 'position.plan.created', payload: { plan: p }, kernelLogicalSequence: 5, kernelEventId: 'e1' } as any);
    s.apply({ type: 'position.plan.updated', payload: { planId: p.planId, stopPrice: 99999 }, kernelLogicalSequence: 3, kernelEventId: 'e2' } as any);
    assert.strictEqual(s.getActive('BTC/USDT')!.stopPrice, 47500);
  });
});

// ─── Regression ─────────────────────────────────────────────────────────────
describe('PositionManager (regression)', () => {
  const mgr = new PositionManager();
  it('open → protected', () => { assert.strictEqual(mgr.onFill(mkPosition(), 'BTC/USDT', undefined)!.stopPrice, 47500); });
  it('short → stop above', () => { assert.strictEqual(mgr.onFill(mkPosition({ side: 'short', signedQuantity: -1 }), 'BTC/USDT', undefined)!.stopPrice, 52500); });
  it('missing → null', () => { assert.strictEqual(mgr.onFill(mkPosition({ status: 'missing' }), 'BTC/USDT', undefined), null); });
  it('long hold', () => { assert.deepStrictEqual(mgr.evaluate(makePlan('active', 47500, 'long'), 48000), { decision: 'hold' }); });
  it('long triggered', () => { assert.strictEqual(mgr.evaluate(makePlan('active', 47500, 'long'), 47499).decision, 'close'); });
  it('short triggered', () => { assert.strictEqual(mgr.evaluate(makePlan('active', 52500, 'short'), 52501).decision, 'close'); });
  it('deterministic', () => { const p=makePlan('active',47500,'long'); assert.deepStrictEqual(mgr.evaluate(p,47000), mgr.evaluate({...p},47000)); });
});
