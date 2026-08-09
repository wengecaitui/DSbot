// Phase 4: Position Management — focused repair tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { PositionManager } from '../../src/position/PositionManager';
import { PositionPlanStore } from '../../src/position/PositionPlanStore';
import { generatePlanId } from '../../src/position/plan-id';
import { buildProtectiveIntent } from '../../src/position/ProtectiveExecutor';
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

// ─── Plan event validation (store-level) ────────────────────────────────────
describe('Plan event validation', () => {
  it('plan.created without planId → store rejects', () => {
    const s = new PositionPlanStore();
    assert.throws(() => s.apply({ type: 'position.plan.created', payload: { plan: { symbol: 'BTC/USDT' } }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any));
  });
  it('plan.updated without planId → store rejects', () => {
    const s = new PositionPlanStore();
    assert.throws(() => s.apply({ type: 'position.plan.updated', payload: {}, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any));
  });
  it('plan.archived without planId → store rejects', () => {
    const s = new PositionPlanStore();
    assert.throws(() => s.apply({ type: 'position.plan.archived', payload: {}, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any));
  });
});

// ─── ProtectiveExecutor → Gateway → OMS wire ────────────────────────────────
describe('ProtectiveExecutor wire', () => {
  it('long stop → short close intent', () => {
    const plan = makePlan('active', 47500, 'long');
    const intent = buildProtectiveIntent(plan);
    assert.strictEqual(intent.direction, 'short');
    assert.strictEqual(intent.source, 'position-manager');
    assert.ok(intent.intentId.startsWith('stop-'));
  });
  it('short stop → long close intent', () => {
    const plan = makePlan('active', 52500, 'short');
    assert.strictEqual(buildProtectiveIntent(plan).direction, 'long');
  });
});

// ─── Full close → no active plan ────────────────────────────────────────────
describe('Full close', () => {
  it('full close → plan closed, no active plan', () => {
    const store = new PositionPlanStore();
    const plan = makePlan('active', 47500, 'long');
    store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'position.plan.closed', payload: { planId: plan.planId }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.get(plan.planId)!.status, 'closed');
    assert.strictEqual(store.getActive('BTC/USDT'), undefined);
  });
  it('full close + new position → new active plan', () => {
    const mgr = new PositionManager();
    const store = new PositionPlanStore();
    const p1 = mgr.onFill(mkPosition({ side: 'long' }), 'BTC/USDT', undefined);
    store.apply({ type: 'position.plan.created', payload: { plan: p1! }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'position.plan.closed', payload: { planId: p1!.planId }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.getActive('BTC/USDT'), undefined);
    const p2 = mgr.onFill(mkPosition({ side: 'long', averageEntryPrice: 51000 }), 'BTC/USDT', undefined);
    store.apply({ type: 'position.plan.created', payload: { plan: p2! }, kernelLogicalSequence: 3, kernelEventId: 'e3' } as any);
    assert.ok(store.getActive('BTC/USDT'));
    assert.notStrictEqual(p2!.planId, p1!.planId);
  });
});

// ─── Flip → old plan archived, new protection correct ───────────────────────
describe('Position flip', () => {
  it('long→short flip: old plan archived, new short-side active', () => {
    const mgr = new PositionManager();
    const store = new PositionPlanStore();
    const longPlan = mgr.onFill(mkPosition({ side: 'long', signedQuantity: 1, averageEntryPrice: 50000 }), 'BTC/USDT', undefined);
    store.apply({ type: 'position.plan.created', payload: { plan: longPlan! }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'position.plan.closed', payload: { planId: longPlan!.planId }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.getActive('BTC/USDT'), undefined);
    const shortPlan = mgr.onFill(mkPosition({ side: 'short', signedQuantity: -1, averageEntryPrice: 51000 }), 'BTC/USDT', undefined);
    store.apply({ type: 'position.plan.created', payload: { plan: shortPlan! }, kernelLogicalSequence: 3, kernelEventId: 'e3' } as any);
    assert.ok(store.getActive('BTC/USDT'));
    assert.strictEqual(store.getActive('BTC/USDT')!.side, 'short');
    assert.notStrictEqual(shortPlan!.planId, longPlan!.planId);
  });
});

// ─── Plan identity scope ────────────────────────────────────────────────────
describe('Plan identity scope', () => {
  it('different entry → different planId', () => {
    assert.notStrictEqual(generatePlanId('BTC/USDT', 'long', 50000, 0), generatePlanId('BTC/USDT', 'long', 50100, 0));
  });
  it('different symbol → different planId', () => {
    assert.notStrictEqual(generatePlanId('BTC/USDT', 'long', 50000, 0), generatePlanId('ETH/USDT', 'long', 50000, 0));
  });
  it('flip → different planId', () => {
    assert.notStrictEqual(generatePlanId('BTC/USDT', 'long', 50000, 0), generatePlanId('BTC/USDT', 'short', 51000, 0));
  });
});

// ─── Regression: PositionManager.onFill ─────────────────────────────────────
describe('PositionManager.onFill (regression)', () => {
  const mgr = new PositionManager();
  it('open → protected', () => { assert.strictEqual(mgr.onFill(mkPosition({ averageEntryPrice: 50000 }), 'BTC/USDT', undefined)!.stopPrice, 47500); });
  it('short open → stop above', () => { assert.strictEqual(mgr.onFill(mkPosition({ side: 'short', signedQuantity: -1 }), 'BTC/USDT', undefined)!.stopPrice, 52500); });
  it('missing → null', () => { assert.strictEqual(mgr.onFill(mkPosition({ status: 'missing' }), 'BTC/USDT', undefined), null); });
  it('scale-in → updated', () => {
    const r = mgr.onFill(mkPosition({ averageEntryPrice: 52000, signedQuantity: 2 }), 'BTC/USDT', makePlan('active', 47500, 'long'));
    assert.strictEqual(r!.stopPrice, 49400);
  });
});

// ─── Regression: PositionManager.evaluate ───────────────────────────────────
describe('PositionManager.evaluate (regression)', () => {
  const mgr = new PositionManager();
  it('long hold', () => { assert.deepStrictEqual(mgr.evaluate(makePlan('active', 47500, 'long'), 48000), { decision: 'hold' }); });
  it('long triggered', () => { assert.strictEqual(mgr.evaluate(makePlan('active', 47500, 'long'), 47499).decision, 'close'); });
  it('short triggered', () => { assert.strictEqual(mgr.evaluate(makePlan('active', 52500, 'short'), 52501).decision, 'close'); });
  it('inactive→hold', () => { assert.deepStrictEqual(mgr.evaluate(makePlan('closed', 47500, 'long'), 40000), { decision: 'hold' }); });
  it('deterministic', () => { const p=makePlan('active',47500,'long'); assert.deepStrictEqual(mgr.evaluate(p,47000), mgr.evaluate({...p},47000)); });
});

// ─── Regression: PositionPlanStore ──────────────────────────────────────────
describe('PositionPlanStore (regression)', () => {
  it('stale seq → no mutation', () => {
    const s = new PositionPlanStore();
    const p = makePlan('active', 47500, 'long');
    s.apply({ type: 'position.plan.created', payload: { plan: p }, kernelLogicalSequence: 5, kernelEventId: 'e1' } as any);
    s.apply({ type: 'position.plan.updated', payload: { planId: p.planId, stopPrice: 99999 }, kernelLogicalSequence: 3, kernelEventId: 'e2' } as any);
    assert.strictEqual(s.getActive('BTC/USDT')!.stopPrice, 47500);
  });
  it('duplicate → idempotent', () => {
    const s = new PositionPlanStore();
    const p = makePlan('active', 47500, 'long');
    s.apply({ type: 'position.plan.created', payload: { plan: p }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    assert.strictEqual(s.apply({ type: 'position.plan.created', payload: { plan: p }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any), null);
  });
});
