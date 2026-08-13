// Phase 5B: reconciliation core tests — deterministic, pure comparison.
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { reconcile } from '../../src/reconciliation/reconcile';
import type {
  ExecutionTruthSnapshot,
  ExternalFill,
  ExternalOrder,
  ExternalPosition,
  LocalOrder,
  LocalPlan,
  LocalPosition,
  LocalReconciliationSnapshot,
  ReconciliationIdentity,
} from '../../src/reconciliation/reconciliation-types';

const ID: ReconciliationIdentity = { accountId: 'acct-1', exchange: 'bitget' };

function truth(partial: Partial<ExecutionTruthSnapshot> = {}): ExecutionTruthSnapshot {
  return {
    identity: ID,
    orders: [],
    fills: [],
    positions: [],
    capturedAt: 1700000000000,
    source: 'paper-broker',
    complete: true,
    ...partial,
  };
}

function localSnap(partial: Partial<LocalReconciliationSnapshot> = {}): LocalReconciliationSnapshot {
  return {
    identity: ID,
    orders: [],
    positions: [],
    plans: [],
    ...partial,
  };
}

function localOrder(partial: Partial<LocalOrder> = {}): LocalOrder {
  return {
    orderId: 'o1',
    intentId: 'i1',
    exchange: 'bitget',
    symbol: 'BTC/USDT',
    side: 'buy',
    status: 'SUBMITTED',
    orderVersion: 1,
    sourceKernelEventId: 'a'.repeat(64),
    ...partial,
  };
}

function extOrder(partial: Partial<ExternalOrder> = {}): ExternalOrder {
  return {
    orderId: 'o1',
    exchange: 'bitget',
    symbol: 'BTC/USDT',
    side: 'buy',
    quantity: 1,
    status: 'OPEN',
    filledQuantity: 0,
    averageFillPrice: null,
    updatedAt: 1700000000000,
    ...partial,
  };
}

function extFill(partial: Partial<ExternalFill> = {}): ExternalFill {
  return {
    fillId: 'f1',
    orderId: 'o1',
    exchange: 'bitget',
    symbol: 'BTC/USDT',
    side: 'buy',
    quantity: 1,
    price: 50000,
    executedAt: 1700000000000,
    ...partial,
  };
}

function extPosition(partial: Partial<ExternalPosition> = {}): ExternalPosition {
  return {
    exchange: 'bitget',
    symbol: 'BTC/USDT',
    side: 'long',
    signedQuantity: 1,
    averageEntryPrice: 50000,
    updatedAt: 1700000000000,
    ...partial,
  };
}

function localPosition(partial: Partial<LocalPosition> = {}): LocalPosition {
  return {
    exchange: 'bitget',
    symbol: 'BTC/USDT',
    status: 'open',
    side: 'long',
    signedQuantity: 1,
    averageEntryPrice: 50000,
    positionVersion: 1,
    sourceKernelEventId: 'a'.repeat(64),
    ...partial,
  };
}

function localPlan(partial: Partial<LocalPlan> = {}): LocalPlan {
  return {
    planId: 'p1',
    exchange: 'bitget',
    symbol: 'BTC/USDT',
    positionSide: 'long',
    status: 'active',
    entryPrice: 50000,
    stopPrice: 47500,
    ...partial,
  };
}

describe('Phase 5B — reconciliation core', () => {
  it('MATCH: empty account agrees on both sides', () => {
    const report = reconcile(localSnap(), truth());
    assert.strictEqual(report.outcome, 'MATCH');
    assert.strictEqual(report.reconciliationVerified, true);
    assert.deepStrictEqual(report.issues, []);
  });

  it('MATCH: filled order confirmed by matching external fill', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'FILLED', fillId: 'f1' })] }),
      truth({ orders: [extOrder({ status: 'FILLED', filledQuantity: 1, averageFillPrice: 50000 })], fills: [extFill({ fillId: 'f1', orderId: 'o1' })] }),
    );
    assert.strictEqual(report.outcome, 'MATCH');
    assert.strictEqual(report.reconciliationVerified, true);
  });

  it('MATCH: local SUBMITTED + external OPEN (both agree not filled)', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'SUBMITTED' })] }),
      truth({ orders: [extOrder({ status: 'OPEN' })] }),
    );
    assert.strictEqual(report.outcome, 'MATCH');
  });

  it('MATCH: agreed open position with active protection plan', () => {
    const report = reconcile(
      localSnap({
        positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1 })],
        plans: [localPlan({ positionSide: 'long', status: 'active' })],
      }),
      truth({ positions: [extPosition({ side: 'long', signedQuantity: 1 })] }),
    );
    assert.strictEqual(report.outcome, 'MATCH');
  });

  it('UNKNOWN_ORDER: SUBMITTED order absent from external truth', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'SUBMITTED' })] }),
      truth(),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(report.reconciliationVerified, false);
    assert.ok(report.issues.some((i) => i.outcome === 'UNKNOWN_ORDER' && i.orderId === 'o1'));
  });

  it('UNKNOWN_ORDER: SUBMISSION_UNKNOWN order not found externally (NOT auto-retried / NOT REJECTED)', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'SUBMISSION_UNKNOWN' })] }),
      truth({ orders: [extOrder({ status: 'NOT_FOUND' })] }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    // "Order not found" must NOT mean REJECTED or safe-to-resubmit.
    assert.ok(!report.issues.some((i) => i.outcome === 'MISSING_FILL'));
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('UNKNOWN_ORDER: local FILLED order with unconfirmed fill', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'FILLED', fillId: 'f1' })] }),
      truth({ orders: [extOrder({ status: 'FILLED' })], fills: [] }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('MISSING_FILL: local SUBMITTED but external reports FILLED', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'SUBMITTED' })] }),
      truth({ orders: [extOrder({ status: 'FILLED', filledQuantity: 1, averageFillPrice: 50000 })] }),
    );
    assert.strictEqual(report.outcome, 'MISSING_FILL');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('MISSING_FILL: local REJECTED but external reports a fill', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'REJECTED' })] }),
      truth({ fills: [extFill({ orderId: 'o1' })] }),
    );
    assert.strictEqual(report.outcome, 'MISSING_FILL');
  });

  it('ORPHAN_ORDER: external order with no local OMS order', () => {
    const report = reconcile(
      localSnap(),
      truth({ orders: [extOrder({ orderId: 'o-orphan' })] }),
    );
    assert.strictEqual(report.outcome, 'ORPHAN_ORDER');
    assert.ok(report.issues.some((i) => i.outcome === 'ORPHAN_ORDER' && i.orderId === 'o-orphan'));
  });

  it('ORPHAN_ORDER: external fill for an order local does not know', () => {
    const report = reconcile(
      localSnap(),
      truth({ fills: [extFill({ orderId: 'o-orphan', fillId: 'f-orphan' })] }),
    );
    assert.strictEqual(report.outcome, 'ORPHAN_ORDER');
    assert.ok(report.issues.some((i) => i.fillId === 'f-orphan'));
  });

  it('POSITION_MISMATCH: local open, external absent', () => {
    const report = reconcile(
      localSnap({ positions: [localPosition({ status: 'open', signedQuantity: 1 })] }),
      truth(),
    );
    assert.strictEqual(report.outcome, 'POSITION_MISMATCH');
  });

  it('POSITION_MISMATCH: external open, local absent', () => {
    const report = reconcile(
      localSnap(),
      truth({ positions: [extPosition({ signedQuantity: 1 })] }),
    );
    assert.strictEqual(report.outcome, 'POSITION_MISMATCH');
  });

  it('POSITION_MISMATCH: differing signed quantity', () => {
    const report = reconcile(
      localSnap({ positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1 })] }),
      truth({ positions: [extPosition({ side: 'long', signedQuantity: 2 })] }),
    );
    assert.strictEqual(report.outcome, 'POSITION_MISMATCH');
  });

  it('POSITION_MISMATCH: differing side', () => {
    const report = reconcile(
      localSnap({ positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1 })] }),
      truth({ positions: [extPosition({ side: 'short', signedQuantity: -1 })] }),
    );
    assert.strictEqual(report.outcome, 'POSITION_MISMATCH');
  });

  it('MISSING_PROTECTION: open position without active local plan', () => {
    const report = reconcile(
      localSnap({ positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1 })] }),
      truth({ positions: [extPosition({ side: 'long', signedQuantity: 1 })] }),
    );
    assert.strictEqual(report.outcome, 'MISSING_PROTECTION');
    assert.ok(report.issues.some((i) => i.outcome === 'MISSING_PROTECTION'));
  });

  it('MISSING_PROTECTION: plan side mismatch', () => {
    const report = reconcile(
      localSnap({
        positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1 })],
        plans: [localPlan({ positionSide: 'short', status: 'active' })],
      }),
      truth({ positions: [extPosition({ side: 'long', signedQuantity: 1 })] }),
    );
    assert.strictEqual(report.outcome, 'MISSING_PROTECTION');
  });

  it('UNTRUSTED_STATE: incomplete external truth short-circuits', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'FILLED', fillId: 'f1' })] }),
      truth({ complete: false, incompleteReason: 'query failed' }),
    );
    assert.strictEqual(report.outcome, 'UNTRUSTED_STATE');
    assert.strictEqual(report.reconciliationVerified, false);
    assert.strictEqual(report.issues.length, 1);
    assert.strictEqual(report.issues[0].outcome, 'UNTRUSTED_STATE');
  });

  it('UNTRUSTED_STATE: identity mismatch', () => {
    const report = reconcile(
      localSnap({ identity: { accountId: 'acct-1', exchange: 'bitget' } }),
      truth({ identity: { accountId: 'acct-OTHER', exchange: 'bitget' } }),
    );
    assert.strictEqual(report.outcome, 'UNTRUSTED_STATE');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('determinism: identical inputs produce identical report (digests included)', () => {
    const local = localSnap({
      orders: [localOrder({ status: 'SUBMITTED' }), localOrder({ orderId: 'o2', intentId: 'i2', status: 'REJECTED' })],
      positions: [localPosition({ status: 'open', signedQuantity: 1 })],
    });
    const external = truth({
      orders: [extOrder({ status: 'OPEN' }), extOrder({ orderId: 'o2', status: 'NOT_FOUND' })],
      positions: [extPosition({ signedQuantity: 1 })],
    });
    const a = reconcile(local, external);
    const b = reconcile(local, external);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.localDigest, b.localDigest);
    assert.strictEqual(a.externalDigest, b.externalDigest);
  });

  it('determinism: input array order does not change the report', () => {
    const ordersA = [localOrder({ orderId: 'o1', status: 'SUBMITTED' }), localOrder({ orderId: 'o2', status: 'SUBMITTED' })];
    const ordersB = [localOrder({ orderId: 'o2', status: 'SUBMITTED' }), localOrder({ orderId: 'o1', status: 'SUBMITTED' })];
    const a = reconcile(localSnap({ orders: ordersA }), truth());
    const b = reconcile(localSnap({ orders: ordersB }), truth());
    assert.deepStrictEqual(a.issues, b.issues);
    assert.strictEqual(a.localDigest, b.localDigest);
    assert.strictEqual(a.outcome, b.outcome);
  });

  it('stable ordering: issues are sorted by priority then key', () => {
    const report = reconcile(
      localSnap({
        orders: [localOrder({ orderId: 'o1', status: 'SUBMITTED' }), localOrder({ orderId: 'o2', status: 'SUBMITTED' })],
        positions: [localPosition({ status: 'open', signedQuantity: 1 })],
      }),
      truth({ positions: [] }),
    );
    // Priority: POSITION_MISMATCH(1) < UNKNOWN_ORDER(3)
    const outcomes = report.issues.map((i) => i.outcome);
    const priorities = outcomes.map((o) => ({ POSITION_MISMATCH: 1, UNKNOWN_ORDER: 3, MISSING_FILL: 2 }[o as string] ?? 99));
    for (let i = 1; i < priorities.length; i++) {
      assert.ok(priorities[i - 1] <= priorities[i], `issues sorted by priority: ${outcomes.join(',')}`);
    }
    assert.strictEqual(report.outcome, 'POSITION_MISMATCH');
  });

  it('reconciliationVerified is false whenever any issue exists', () => {
    const cases: Array<[LocalReconciliationSnapshot, ExecutionTruthSnapshot]> = [
      [localSnap({ orders: [localOrder({ status: 'SUBMITTED' })] }), truth()],
      [localSnap(), truth({ orders: [extOrder({ orderId: 'o-orphan' })] })],
      [localSnap({ positions: [localPosition({ status: 'open' })] }), truth()],
      [localSnap({ positions: [localPosition({ status: 'open' })] }), truth({ positions: [extPosition({ signedQuantity: 1 })] })],
    ];
    for (const [l, e] of cases) {
      const report = reconcile(l, e);
      assert.strictEqual(report.reconciliationVerified, false);
    }
  });

  it('the core does not mutate its inputs', () => {
    const local = localSnap({ orders: [localOrder({ status: 'SUBMITTED' })] });
    const external = truth({ orders: [extOrder({ status: 'NOT_FOUND' })] });
    const localJson = JSON.stringify(local);
    const externalJson = JSON.stringify(external);
    reconcile(local, external);
    assert.strictEqual(JSON.stringify(local), localJson);
    assert.strictEqual(JSON.stringify(external), externalJson);
  });

  // ── P0-1: position factual semantics ──────────────────────────────────────

  it('P0-1: local missing + no external position → NOT MATCH', () => {
    const report = reconcile(
      localSnap({ positions: [localPosition({ status: 'missing', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 })] }),
      truth(),
    );
    assert.strictEqual(report.outcome, 'POSITION_MISMATCH');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-1: local flat + no external open position may MATCH', () => {
    const report = reconcile(
      localSnap({ positions: [localPosition({ status: 'flat', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 })] }),
      truth(),
    );
    assert.strictEqual(report.outcome, 'MATCH');
    assert.strictEqual(report.reconciliationVerified, true);
  });

  it('P0-1: same side/qty but different averageEntryPrice → POSITION_MISMATCH', () => {
    const report = reconcile(
      localSnap({ positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1, averageEntryPrice: 50000 })] }),
      truth({ positions: [extPosition({ side: 'long', signedQuantity: 1, averageEntryPrice: 51000 })] }),
    );
    assert.strictEqual(report.outcome, 'POSITION_MISMATCH');
    assert.ok(report.issues.some((i) => i.outcome === 'POSITION_MISMATCH' && /average entry/.test(i.reason)));
  });

  it('P0-1: same side/qty and same averageEntryPrice → MATCH', () => {
    const report = reconcile(
      localSnap({
        positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1, averageEntryPrice: 50000 })],
        plans: [localPlan({ positionSide: 'long', status: 'active' })],
      }),
      truth({ positions: [extPosition({ side: 'long', signedQuantity: 1, averageEntryPrice: 50000 })] }),
    );
    assert.strictEqual(report.outcome, 'MATCH');
  });

  // ── P0-2: order fact contradictions ───────────────────────────────────────

  it('P0-2: local CREATED + external OPEN → not MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'CREATED' })] }),
      truth({ orders: [extOrder({ status: 'OPEN' })] }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-2: local REJECTED + external OPEN → not MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'REJECTED' })] }),
      truth({ orders: [extOrder({ status: 'OPEN' })] }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-2: local SUBMITTED + external CANCELLED → not MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'SUBMITTED' })] }),
      truth({ orders: [extOrder({ status: 'CANCELLED' })] }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-2: same orderId but wrong symbol → not MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ orderId: 'o1', symbol: 'BTC/USDT', status: 'SUBMITTED' })] }),
      truth({ orders: [extOrder({ orderId: 'o1', symbol: 'ETH/USDT', status: 'OPEN' })] }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.ok(report.issues.some((i) => i.outcome === 'UNKNOWN_ORDER' && /attribution/.test(i.reason)));
  });

  it('P0-2: same orderId but wrong side → not MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ orderId: 'o1', side: 'buy', status: 'SUBMITTED' })] }),
      truth({ orders: [extOrder({ orderId: 'o1', side: 'sell', status: 'OPEN' })] }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
  });

  it('P0-2: same orderId but wrong exchange → not MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ orderId: 'o1', exchange: 'bitget', status: 'SUBMITTED' })] }),
      truth({ orders: [extOrder({ orderId: 'o1', exchange: 'binance', status: 'OPEN' })] }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
  });

  // ── P0-3: inconsistent truth / order invariance ───────────────────────────

  it('P0-3: conflicting duplicate external orderId → UNTRUSTED_STATE', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ orderId: 'o1', status: 'SUBMITTED' })] }),
      truth({ orders: [
        extOrder({ orderId: 'o1', status: 'OPEN' }),
        extOrder({ orderId: 'o1', status: 'CANCELLED' }),
      ] }),
    );
    assert.strictEqual(report.outcome, 'UNTRUSTED_STATE');
  });

  it('P0-3: conflicting duplicate external fillId → UNTRUSTED_STATE', () => {
    const report = reconcile(
      localSnap(),
      truth({ fills: [
        extFill({ fillId: 'f1', orderId: 'o1', price: 50000 }),
        extFill({ fillId: 'f1', orderId: 'o1', price: 51000 }),
      ] }),
    );
    assert.strictEqual(report.outcome, 'UNTRUSTED_STATE');
  });

  it('P0-3: conflicting duplicate external position → UNTRUSTED_STATE', () => {
    const report = reconcile(
      localSnap({ positions: [localPosition({ status: 'open', signedQuantity: 1 })] }),
      truth({ positions: [
        extPosition({ signedQuantity: 1 }),
        extPosition({ signedQuantity: 2 }),
      ] }),
    );
    assert.strictEqual(report.outcome, 'UNTRUSTED_STATE');
  });

  it('P0-3: conflicting duplicate local order → UNTRUSTED_STATE', () => {
    const report = reconcile(
      localSnap({ orders: [
        localOrder({ orderId: 'o1', status: 'SUBMITTED' }),
        localOrder({ orderId: 'o1', status: 'REJECTED' }),
      ] }),
      truth(),
    );
    assert.strictEqual(report.outcome, 'UNTRUSTED_STATE');
  });

  it('P0-3: exact duplicate facts canonical-dedupe (no UNTRUSTED, no double issue)', () => {
    const dup = extOrder({ orderId: 'o-orphan', status: 'OPEN' });
    const report = reconcile(
      localSnap(),
      truth({ orders: [dup, { ...dup }] }),
    );
    assert.strictEqual(report.outcome, 'ORPHAN_ORDER');
    assert.strictEqual(report.issues.filter((i) => i.orderId === 'o-orphan').length, 1);
  });

  it('P0-3: reordering external arrays does not change outcome/issues/digests', () => {
    const local = localSnap({
      orders: [localOrder({ orderId: 'o1', status: 'FILLED', fillId: 'f1' })],
      positions: [localPosition({ status: 'open', signedQuantity: 1 })],
    });
    const externalA = truth({
      orders: [extOrder({ orderId: 'o1', status: 'FILLED' }), extOrder({ orderId: 'o-orphan', status: 'OPEN' })],
      fills: [extFill({ fillId: 'f1', orderId: 'o1' })],
      positions: [extPosition({ signedQuantity: 1 })],
    });
    const externalB = truth({
      orders: [extOrder({ orderId: 'o-orphan', status: 'OPEN' }), extOrder({ orderId: 'o1', status: 'FILLED' })],
      fills: [extFill({ fillId: 'f1', orderId: 'o1' })],
      positions: [extPosition({ signedQuantity: 1 })],
    });
    const a = reconcile(local, externalA);
    const b = reconcile(local, externalB);
    assert.strictEqual(a.outcome, b.outcome);
    assert.deepStrictEqual(a.issues, b.issues);
    assert.strictEqual(a.externalDigest, b.externalDigest);
    assert.strictEqual(a.localDigest, b.localDigest);
  });

  // ── P1: immutable report ──────────────────────────────────────────────────

  it('P1: report and individual issues are frozen at runtime', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'SUBMITTED' })] }),
      truth(),
    );
    assert.ok(Object.isFrozen(report), 'report frozen');
    assert.ok(Object.isFrozen(report.issues), 'issues array frozen');
    for (const issue of report.issues) {
      assert.ok(Object.isFrozen(issue), 'each issue frozen');
    }
  });

  // ── P0-2 (closure): complete order/fill fact compatibility ────────────────

  it('P0-2: matching fillId/orderId but wrong fill symbol → NOT MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ orderId: 'o1', status: 'FILLED', fillId: 'f1', symbol: 'BTC/USDT' })] }),
      truth({
        orders: [extOrder({ orderId: 'o1', symbol: 'BTC/USDT', status: 'FILLED' })],
        fills: [extFill({ fillId: 'f1', orderId: 'o1', symbol: 'ETH/USDT' })],
      }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-2: matching fillId/orderId but wrong fill side → NOT MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ orderId: 'o1', status: 'FILLED', fillId: 'f1', side: 'buy' })] }),
      truth({
        orders: [extOrder({ orderId: 'o1', status: 'FILLED' })],
        fills: [extFill({ fillId: 'f1', orderId: 'o1', side: 'sell' })],
      }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-2: matching fillId/orderId but wrong fill exchange → NOT MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ orderId: 'o1', status: 'FILLED', fillId: 'f1', exchange: 'bitget' })] }),
      truth({
        orders: [extOrder({ orderId: 'o1', exchange: 'bitget', status: 'FILLED' })],
        fills: [extFill({ fillId: 'f1', orderId: 'o1', exchange: 'binance' })],
      }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-2: local CREATED + external CANCELLED → NOT MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ status: 'CREATED' })] }),
      truth({ orders: [extOrder({ status: 'CANCELLED' })] }),
    );
    assert.strictEqual(report.outcome, 'UNKNOWN_ORDER');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-2: local FILLED + confirmed fill + external order OPEN → NOT MATCH', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ orderId: 'o1', status: 'FILLED', fillId: 'f1' })] }),
      truth({
        orders: [extOrder({ orderId: 'o1', status: 'OPEN' })],
        fills: [extFill({ fillId: 'f1', orderId: 'o1' })],
      }),
    );
    // External order OPEN contradicts the external fill → UNTRUSTED_STATE.
    assert.strictEqual(report.outcome, 'UNTRUSTED_STATE');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-2: conflicting external order/fill lifecycle → UNTRUSTED_STATE', () => {
    const report = reconcile(
      localSnap({ orders: [localOrder({ orderId: 'o1', status: 'SUBMITTED' })] }),
      truth({
        orders: [extOrder({ orderId: 'o1', status: 'CANCELLED' })],
        fills: [extFill({ fillId: 'f1', orderId: 'o1' })],
      }),
    );
    assert.strictEqual(report.outcome, 'UNTRUSTED_STATE');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  // ── P0-3 (closure): local protection order invariance ─────────────────────

  it('P0-3: conflicting active plans for same position key → fail closed', () => {
    const report = reconcile(
      localSnap({
        positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1 })],
        plans: [
          localPlan({ planId: 'p1', positionSide: 'long', status: 'active' }),
          localPlan({ planId: 'p2', positionSide: 'short', status: 'active' }),
        ],
      }),
      truth({ positions: [extPosition({ side: 'long', signedQuantity: 1 })] }),
    );
    assert.strictEqual(report.outcome, 'UNTRUSTED_STATE');
    assert.strictEqual(report.reconciliationVerified, false);
  });

  it('P0-3: reversing conflicting local plans produces identical report', () => {
    const base = {
      positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1 })],
    };
    const ext = truth({ positions: [extPosition({ side: 'long', signedQuantity: 1 })] });
    const a = reconcile(
      localSnap({
        ...base,
        plans: [
          localPlan({ planId: 'p1', positionSide: 'long', status: 'active' }),
          localPlan({ planId: 'p2', positionSide: 'short', status: 'active' }),
        ],
      }),
      ext,
    );
    const b = reconcile(
      localSnap({
        ...base,
        plans: [
          localPlan({ planId: 'p2', positionSide: 'short', status: 'active' }),
          localPlan({ planId: 'p1', positionSide: 'long', status: 'active' }),
        ],
      }),
      ext,
    );
    assert.deepStrictEqual(a, b);
  });

  it('P0-3: valid single matching active plan → MATCH preserved', () => {
    const report = reconcile(
      localSnap({
        positions: [localPosition({ status: 'open', side: 'long', signedQuantity: 1 })],
        plans: [localPlan({ planId: 'p1', positionSide: 'long', status: 'active' })],
      }),
      truth({ positions: [extPosition({ side: 'long', signedQuantity: 1 })] }),
    );
    assert.strictEqual(report.outcome, 'MATCH');
    assert.strictEqual(report.reconciliationVerified, true);
  });
});
