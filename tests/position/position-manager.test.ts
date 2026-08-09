// Phase 4: Position Management — contract tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { PositionManager } from '../../src/position/PositionManager';
import { PositionPlanStore } from '../../src/position/PositionPlanStore';
import { generatePlanId } from '../../src/position/plan-id';
import type { PositionPlan, StopConfig } from '../../src/position/position-plan-types';
import type { PositionResolution } from '../../src/types/position-state';
import type { ExchangeId } from '../../src/data/MarketIdentity';

const BITGET = 'bitget' as ExchangeId;

function mkPosition(overrides?: Partial<PositionResolution>): PositionResolution {
  return { status: 'open', snapshot: null, side: 'long', signedQuantity: 1,
    averageEntryPrice: 50000, ...overrides } as PositionResolution;
}

const DEFAULT_STOP_PCT = 0.05;

// ─── PositionManager.onFill ─────────────────────────────────────────────────
describe('PositionManager.onFill', () => {
  const mgr = new PositionManager();
  it('open fill → protected plan created', () => {
    const plan = mgr.onFill(mkPosition({ status: 'open', side: 'long', averageEntryPrice: 50000, signedQuantity: 1 }), undefined);
    assert.ok(plan);
    assert.strictEqual(plan!.status, 'active');
    assert.strictEqual(plan!.side, 'long');
    assert.strictEqual(plan!.stopPrice, 47500); // 50000 * (1 - 0.05)
  });
  it('short open → stop above entry', () => {
    const plan = mgr.onFill(mkPosition({ status: 'open', side: 'short', averageEntryPrice: 50000, signedQuantity: -1 }), undefined);
    assert.ok(plan);
    assert.strictEqual(plan!.side, 'short');
    assert.strictEqual(plan!.stopPrice, 52500); // 50000 * (1 + 0.05)
  });
  it('missing position → null', () => {
    assert.strictEqual(mgr.onFill(mkPosition({ status: 'missing' }), undefined), null);
  });
  it('flat position + active plan → should archive (returns plan)', () => {
    const existing = makePlan('active', 47500, 'long');
    const r = mgr.onFill(mkPosition({ status: 'flat' }), existing);
    assert.ok(r); // caller should archive
    assert.strictEqual(r!.status, 'active');
  });
  it('scale-in with changed avg → stop updated', () => {
    const existing = makePlan('active', 47500, 'long');
    const r = mgr.onFill(mkPosition({ status: 'open', side: 'long', averageEntryPrice: 52000, signedQuantity: 2 }), existing);
    assert.ok(r);
    assert.strictEqual(r!.stopPrice, 49400); // 52000 * 0.95
  });
  it('scale-in with same avg → null (no change)', () => {
    const existing = makePlan('active', 47500, 'long');
    assert.strictEqual(mgr.onFill(mkPosition({ status: 'open', side: 'long', averageEntryPrice: 50000, signedQuantity: 2 }), existing), null);
  });
  it('partial reduce → plan unchanged', () => {
    const existing = makePlan('active', 47500, 'long');
    assert.strictEqual(mgr.onFill(mkPosition({ status: 'open', side: 'long', averageEntryPrice: 50000, signedQuantity: 0.5 }), existing), null);
  });
});

// ─── PositionManager.evaluate ───────────────────────────────────────────────
describe('PositionManager.evaluate', () => {
  const mgr = new PositionManager();
  it('long stop not triggered → hold', () => {
    const plan = makePlan('active', 47500, 'long');
    assert.deepStrictEqual(mgr.evaluate(plan, 48000), { decision: 'hold' });
  });
  it('long stop triggered → close', () => {
    const plan = makePlan('active', 47500, 'long');
    const r = mgr.evaluate(plan, 47499);
    assert.strictEqual(r.decision, 'close');
  });
  it('long stop exactly at → triggered', () => {
    const plan = makePlan('active', 47500, 'long');
    assert.strictEqual(mgr.evaluate(plan, 47500).decision, 'close');
  });
  it('short stop not triggered → hold', () => {
    const plan = makePlan('active', 52500, 'short');
    assert.deepStrictEqual(mgr.evaluate(plan, 52000), { decision: 'hold' });
  });
  it('short stop triggered → close', () => {
    const plan = makePlan('active', 52500, 'short');
    assert.strictEqual(mgr.evaluate(plan, 52501).decision, 'close');
  });
  it('inactive plan → hold', () => {
    assert.deepStrictEqual(mgr.evaluate(makePlan('closed', 47500, 'long'), 40000), { decision: 'hold' });
  });
  it('archived plan → hold', () => {
    assert.deepStrictEqual(mgr.evaluate(makePlan('archived', 47500, 'long'), 40000), { decision: 'hold' });
  });
  it('non-finite market price → hold', () => {
    assert.deepStrictEqual(mgr.evaluate(makePlan('active', 47500, 'long'), NaN), { decision: 'hold' });
    assert.deepStrictEqual(mgr.evaluate(makePlan('active', 47500, 'long'), 0), { decision: 'hold' });
  });
  it('deterministic: same input → same output', () => {
    const plan = makePlan('active', 47500, 'long');
    assert.deepStrictEqual(mgr.evaluate(plan, 47000), mgr.evaluate({ ...plan }, 47000));
  });
});

// ─── PositionPlanStore ──────────────────────────────────────────────────────
describe('PositionPlanStore', () => {
  let store: PositionPlanStore;
  beforeEach(() => { store = new PositionPlanStore(); });

  it('plan.created → active', () => {
    const plan = makePlan('active', 47500, 'long');
    const r = store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    assert.strictEqual(r!.status, 'active');
    assert.strictEqual(store.getActive('BTC/USDT')!.planId, plan.planId);
  });
  it('plan.updated → stop changed', () => {
    const plan = makePlan('active', 47500, 'long');
    store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'position.plan.updated', payload: { planId: plan.planId, stopPrice: 47000 }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.getActive('BTC/USDT')!.stopPrice, 47000);
  });
  it('plan.archived → archived', () => {
    const plan = makePlan('active', 47500, 'long');
    store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'position.plan.archived', payload: { planId: plan.planId }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.get(plan.planId)!.status, 'archived');
    assert.strictEqual(store.getActive('BTC/USDT'), undefined);
  });
  it('plan.closed → closed', () => {
    const plan = makePlan('active', 47500, 'long');
    store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    store.apply({ type: 'position.plan.closed', payload: { planId: plan.planId }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.get(plan.planId)!.status, 'closed');
  });
  it('stale sequence → no mutation', () => {
    const plan = makePlan('active', 47500, 'long');
    store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 5, kernelEventId: 'e1' } as any);
    const r = store.apply({ type: 'position.plan.updated', payload: { planId: plan.planId, stopPrice: 99999 }, kernelLogicalSequence: 3, kernelEventId: 'e2' } as any);
    assert.strictEqual(r, null);
    assert.strictEqual(store.getActive('BTC/USDT')!.stopPrice, 47500);
  });
  it('duplicate plan.created → idempotent', () => {
    const plan = makePlan('active', 47500, 'long');
    store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    assert.strictEqual(store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any), null);
  });
  it('getActive returns only active plan', () => {
    const plan = makePlan('active', 47500, 'long');
    store.apply({ type: 'position.plan.created', payload: { plan }, kernelLogicalSequence: 1, kernelEventId: 'e1' } as any);
    assert.ok(store.getActive('BTC/USDT'));
    store.apply({ type: 'position.plan.archived', payload: { planId: plan.planId }, kernelLogicalSequence: 2, kernelEventId: 'e2' } as any);
    assert.strictEqual(store.getActive('BTC/USDT'), undefined);
  });
});

// ─── plan ID ────────────────────────────────────────────────────────────────
describe('plan ID', () => {
  it('deterministic', () => {
    assert.strictEqual(
      generatePlanId('BTC/USDT', 'long', 50000, 0),
      generatePlanId('BTC/USDT', 'long', 50000, 0));
  });
  it('different entry → different', () => {
    assert.notStrictEqual(
      generatePlanId('BTC/USDT', 'long', 50000, 0),
      generatePlanId('BTC/USDT', 'long', 50100, 0));
  });
});

function makePlan(status: string, stopPrice: number, side: 'long' | 'short'): PositionPlan {
  return {
    planId: generatePlanId('BTC/USDT', side, 50000, 0),
    symbol: 'BTC/USDT', positionSide: side, side, entryPrice: 50000,
    entryQuantity: 1, stopPrice, status: status as any, planVersion: 0, sourceKernelEventId: 'e0',
  };
}
