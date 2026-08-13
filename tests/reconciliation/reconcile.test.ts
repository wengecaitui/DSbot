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
});
