// Phase 4: Position Management — final closure repair tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { PositionManager } from '../../src/position/PositionManager';
import { PositionPlanStore } from '../../src/position/PositionPlanStore';
import { generatePlanId } from '../../src/position/plan-id';
import { buildProtectiveIntent, evaluateProtectiveRoute } from '../../src/position/ProtectiveExecutor';
import type { ProtectiveContext } from '../../src/position/ProtectiveExecutor';
import type { PositionPlan } from '../../src/position/position-plan-types';
import type { PositionResolution } from '../../src/types/position-state';

const unlockedHardRisk = { exchange: 'bitget' as any, locked: false, enabled: true, totalCapitalUsd: 1_000_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: Infinity };
const validMarket = { exchange: 'bitget', symbol: 'BTC/USDT', isStale: false, ticker: { ticker: { last: 50000 } } } as any;

function mkPos(overrides?: Partial<PositionResolution>): PositionResolution {
  return { status: 'open', snapshot: null, side: 'long', signedQuantity: 1, averageEntryPrice: 50000, ...overrides } as PositionResolution;
}
function mkPlan(status: string, stopPrice: number, side: 'long' | 'short'): PositionPlan {
  return { planId: generatePlanId('bitget', 'BTC/USDT', side, 50000, 0), symbol: 'BTC/USDT',
    positionSide: side, side, entryPrice: 50000, entryQuantity: 1, stopPrice,
    status: status as any, planVersion: 0, sourceKernelEventId: 'e0' };
}

// ─── Real OMS submission ────────────────────────────────────────────────────
describe('Real OMS submission', () => {
  it('intent is deterministic (same input → same intentId)', () => {
    const ctx: ProtectiveContext = { plan: mkPlan('active', 47500, 'long'), currentPosition: mkPos(), exchange: 'bitget', marketPrice: 47499, hardRisk: unlockedHardRisk };
    assert.strictEqual(buildProtectiveIntent(ctx).intentId, buildProtectiveIntent(ctx).intentId);
  });
  it('Gateway ADMITTED → admitted=true', () => {
    const ctx: ProtectiveContext = { plan: mkPlan('active', 47500, 'long'), currentPosition: mkPos(), exchange: 'bitget', marketPrice: 47499, marketSnapshot: validMarket, hardRisk: unlockedHardRisk };
    assert.strictEqual(evaluateProtectiveRoute(ctx).admitted, true);
  });
  it('HardRisk locked → admitted=false', () => {
    const ctx: ProtectiveContext = { plan: mkPlan('active', 47500, 'long'), currentPosition: mkPos(), exchange: 'bitget', marketPrice: 47499, marketSnapshot: validMarket, hardRisk: { ...unlockedHardRisk, locked: true } };
    assert.strictEqual(evaluateProtectiveRoute(ctx).admitted, false);
  });
  it('missing position → admitted=false', () => {
    const ctx: ProtectiveContext = { plan: mkPlan('active', 47500, 'long'), currentPosition: mkPos({ status: 'missing' }), exchange: 'bitget', marketPrice: 47499, marketSnapshot: validMarket, hardRisk: unlockedHardRisk };
    assert.strictEqual(evaluateProtectiveRoute(ctx).admitted, false);
  });
  it('repeated stop ticks → same intentId', () => {
    const plan = mkPlan('active', 47500, 'long');
    const pos = mkPos();
    const id1 = buildProtectiveIntent({ plan, currentPosition: pos, exchange: 'bitget', marketPrice: 47400, hardRisk: unlockedHardRisk }).intentId;
    const id2 = buildProtectiveIntent({ plan, currentPosition: pos, exchange: 'bitget', marketPrice: 47300, hardRisk: unlockedHardRisk }).intentId;
    assert.strictEqual(id1, id2);
  });
});

// ─── Full close / flip automatic ────────────────────────────────────────────
describe('Full close / flip automatic', () => {
  const mgr = new PositionManager();
  it('flat position → plan terminated (status=closed)', () => {
    const existing = mkPlan('active', 47500, 'long');
    const r = mgr.onFill(mkPos({ status: 'flat' }), 'bitget', 'BTC/USDT', 2, existing);
    assert.ok(r);
    assert.strictEqual(r!.status, 'closed');
  });
  it('flip: long→short produces new plan with correct side', () => {
    const existing = mkPlan('active', 47500, 'long');
    const r = mgr.onFill(mkPos({ side: 'short', signedQuantity: -1, averageEntryPrice: 51000 }), 'bitget', 'BTC/USDT', 3, existing);
    assert.ok(r);
    assert.strictEqual(r!.side, 'short');
    assert.strictEqual(r!.status, 'active');
    assert.notStrictEqual(r!.planId, existing.planId);
  });
  it('flip: closed plan replaced by new active plan in store', () => {
    const store = new PositionPlanStore();
    const oldPlan = mkPlan('active', 47500, 'long');
    store.apply({ type: 'position.plan.created', payload: { plan: oldPlan }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'position.plan.closed', payload: { planId: oldPlan.planId }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.getActive('BTC/USDT'), undefined);
    const newPlan = mgr.onFill(mkPos({ side: 'short', signedQuantity: -1, averageEntryPrice: 51000 }), 'bitget', 'BTC/USDT', 3, undefined);
    store.apply({ type: 'position.plan.created', payload: { plan: newPlan! }, kernelLogicalSequence: 3, kernelEventId: 'e3' } as any);
    assert.ok(store.getActive('BTC/USDT'));
    assert.strictEqual(store.getActive('BTC/USDT')!.side, 'short');
  });
  it('same-price reopen → distinct planId (different fillSequence)', () => {
    const p1 = mgr.onFill(mkPos({ side: 'long', averageEntryPrice: 50000 }), 'bitget', 'BTC/USDT', 1, undefined);
    const p2 = mgr.onFill(mkPos({ side: 'long', averageEntryPrice: 50000 }), 'bitget', 'BTC/USDT', 5, undefined);
    assert.notStrictEqual(p2!.planId, p1!.planId);
  });
  it('different entry → different planId', () => {
    const p1 = mgr.onFill(mkPos({ side: 'long', averageEntryPrice: 50000 }), 'bitget', 'BTC/USDT', 1, undefined);
    const p2 = mgr.onFill(mkPos({ side: 'long', averageEntryPrice: 51000 }), 'bitget', 'BTC/USDT', 2, undefined);
    assert.notStrictEqual(p2!.planId, p1!.planId);
  });
});

// ─── Plan identity ──────────────────────────────────────────────────────────
describe('Plan identity', () => {
  it('different exchange → different planId', () => {
    assert.notStrictEqual(generatePlanId('bitget', 'BTC/USDT', 'long', 50000, 0), generatePlanId('bybit', 'BTC/USDT', 'long', 50000, 0));
  });
  it('different entry → different planId', () => {
    assert.notStrictEqual(generatePlanId('bitget', 'BTC/USDT', 'long', 50000, 0), generatePlanId('bitget', 'BTC/USDT', 'long', 50100, 0));
  });
  it('different fillSequence → different planId', () => {
    assert.notStrictEqual(generatePlanId('bitget', 'BTC/USDT', 'long', 50000, 1), generatePlanId('bitget', 'BTC/USDT', 'long', 50000, 5));
  });
});

// ─── Plan event validation ──────────────────────────────────────────────────
describe('Plan event validation in store', () => {
  it('plan.created without planId → throws', () => {
    const s = new PositionPlanStore();
    assert.throws(() => s.apply({ type: 'position.plan.created', payload: { plan: {} }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any));
  });
  it('plan.created with invalid stopPrice → throws', () => {
    const s = new PositionPlanStore();
    assert.throws(() => s.apply({ type: 'position.plan.created', payload: { plan: { planId: 'p1', symbol: 'BTC/USDT', positionSide: 'long', entryPrice: 50000, stopPrice: 0 } }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any));
  });
  it('plan.created with NaN stopPrice → throws', () => {
    const s = new PositionPlanStore();
    assert.throws(() => s.apply({ type: 'position.plan.created', payload: { plan: { planId: 'p1', symbol: 'BTC/USDT', positionSide: 'long', entryPrice: 50000, stopPrice: NaN } }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any));
  });
  it('plan.updated with invalid stopPrice → throws', () => {
    const s = new PositionPlanStore();
    const p = mkPlan('active', 47500, 'long');
    s.apply({ type: 'position.plan.created', payload: { plan: p }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    assert.throws(() => s.apply({ type: 'position.plan.updated', payload: { planId: p.planId, stopPrice: -100 }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any));
  });
  it('valid stopPrice update → passes', () => {
    const s = new PositionPlanStore();
    const p = mkPlan('active', 47500, 'long');
    s.apply({ type: 'position.plan.created', payload: { plan: p }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    s.apply({ type: 'position.plan.updated', payload: { planId: p.planId, stopPrice: 47000 }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(s.getActive('BTC/USDT')!.stopPrice, 47000);
  });
  it('stale sequence → no mutation', () => {
    const s = new PositionPlanStore();
    const p = mkPlan('active', 47500, 'long');
    s.apply({ type: 'position.plan.created', payload: { plan: p }, kernelLogicalSequence: 5, kernelEventId: 'e1' } as any);
    s.apply({ type: 'position.plan.updated', payload: { planId: p.planId, stopPrice: 99999 }, kernelLogicalSequence: 3, kernelEventId: 'e2' } as any);
    assert.strictEqual(s.getActive('BTC/USDT')!.stopPrice, 47500);
  });
});

// ─── Regression ─────────────────────────────────────────────────────────────
describe('PositionManager (regression)', () => {
  const mgr = new PositionManager();
  it('open → protected', () => { assert.strictEqual(mgr.onFill(mkPos(), 'bitget', 'BTC/USDT', 0, undefined)!.stopPrice, 47500); });
  it('short → stop above', () => { assert.strictEqual(mgr.onFill(mkPos({ side: 'short', signedQuantity: -1 }), 'bitget', 'BTC/USDT', 0, undefined)!.stopPrice, 52500); });
  it('missing → null', () => { assert.strictEqual(mgr.onFill(mkPos({ status: 'missing' }), 'bitget', 'BTC/USDT', 0, undefined), null); });
  it('long hold', () => { assert.deepStrictEqual(mgr.evaluate(mkPlan('active', 47500, 'long'), 48000), { decision: 'hold' }); });
  it('long triggered', () => { assert.strictEqual(mgr.evaluate(mkPlan('active', 47500, 'long'), 47499).decision, 'close'); });
  it('deterministic', () => { const p=mkPlan('active',47500,'long'); assert.deepStrictEqual(mgr.evaluate(p,47000), mgr.evaluate({...p},47000)); });
});
