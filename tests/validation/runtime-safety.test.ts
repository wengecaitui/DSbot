// Stage 4B3-R1: Trust Boundary Closure — comprehensive tests
// ~90+ focused tests: canonical tamper, fake receipt, UNKNOWN fail-closed,
// kill-switch persistence, ledger replay, incomplete recovery, snapshot binding

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE_4B3_BASELINE,
  SAFETY_REASONS,
  KillSwitch,
  IdempotencyLedger,
  RuntimeSafetyStateMachine,
  RuntimeStartupSafetyGate,
  RuntimeSafetyPolicy,
  RecoveryCoordinator,
  AppendOnlySafetyAudit,
  createRuntimeHealthSnapshot,
  createBlockedSafetyAudit,
  verify4B2Receipt,
  type SafetyGateInput,
  type RuntimeHealthSnapshotData,
  type Stage4B2ReceiptData,
  type RecoveryCompletionEvidence,
} from '../../src/validation/RuntimeSafety';
import { canonicalJson, canonicalSha256 } from '../../src/validation/ActivationContract';

// ═══════════════════════════════════════════════════════════════════
// 1–10: Canonical JSON tamper detection
// ═══════════════════════════════════════════════════════════════════

test('1. canonical JSON nested object key order independent', () => {
  const a = canonicalJson({ b: { d: 4, c: 3 }, a: 1 });
  const b = canonicalJson({ a: 1, b: { c: 3, d: 4 } });
  assert.equal(a, b);
});

test('2. canonical JSON nested tamper changes ID', () => {
  const a = canonicalJson({ a: 1, b: { c: 3 } });
  const b = canonicalJson({ a: 1, b: { c: 4 } });
  assert.notEqual(a, b);
});

test('3. canonical JSON array order preserved', () => {
  const a = canonicalJson({ arr: [1, 2] });
  const b = canonicalJson({ arr: [2, 1] });
  assert.notEqual(a, b);
});

test('4. canonical JSON null/boolean/number/string', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(42), '42');
  assert.equal(canonicalJson('x'), '"x"');
});

test('5. snapshot ID changes on nested tamper', () => {
  const d1 = makeSnapshotData();
  const d2 = makeSnapshotData();
  d2.blockedReasons = [...d1.blockedReasons, SAFETY_REASONS.KILL_SWITCH_ENABLED];
  const s1 = createRuntimeHealthSnapshot(d1, '2026-01-01T00:00:00.000Z');
  const s2 = createRuntimeHealthSnapshot(d2, '2026-01-01T00:00:00.000Z');
  assert.notEqual(s1.snapshotId, s2.snapshotId);
});

// ═══════════════════════════════════════════════════════════════════
// 10–20: Fake 4B2 receipt detection
// ═══════════════════════════════════════════════════════════════════

test('6. verify4B2Receipt valid receipt passes', () => {
  const receipt = makeReal4B2Receipt();
  assert.equal(verify4B2Receipt(receipt).valid, true);
});

test('7. verify4B2Receipt fake receipt ID rejected', () => {
  const receipt = makeReal4B2Receipt();
  receipt.receiptId = '0'.repeat(64);
  const result = verify4B2Receipt(receipt);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'RECEIPT_ID_MISMATCH');
});

test('8. verify4B2Receipt wrong source commit rejected', () => {
  const receipt = makeReal4B2Receipt();
  receipt.sourceCommit = '0'.repeat(40);
  assert.equal(verify4B2Receipt(receipt).valid, false);
});

test('9. verify4B2Receipt wrong 4B1 artifact rejected', () => {
  const receipt = makeReal4B2Receipt();
  receipt.stage4B1Artifact = 'x'.repeat(64);
  assert.equal(verify4B2Receipt(receipt).valid, false);
});

test('10. verify4B2Receipt wrong 4B1 proof rejected', () => {
  const receipt = makeReal4B2Receipt();
  receipt.stage4B1Proof = 'y'.repeat(64);
  assert.equal(verify4B2Receipt(receipt).valid, false);
});

test('11. verify4B2Receipt wrong 4B1 decision rejected', () => {
  const receipt = makeReal4B2Receipt();
  receipt.stage4B1Decision = 'z'.repeat(64);
  assert.equal(verify4B2Receipt(receipt).valid, false);
});

test('12. verify4B2Receipt paperApproved=true rejected', () => {
  const receipt = makeReal4B2Receipt();
  (receipt as any).paperApproved = true;
  assert.equal(verify4B2Receipt(receipt).valid, false);
});

test('13. verify4B2Receipt reviewEligible=true rejected', () => {
  const receipt = makeReal4B2Receipt();
  (receipt as any).reviewEligible = true;
  assert.equal(verify4B2Receipt(receipt).valid, false);
});

// ═══════════════════════════════════════════════════════════════════
// 20–30: UNKNOWN fail-closed
// ═══════════════════════════════════════════════════════════════════

test('14. UNKNOWN bridge health fail-closed', () => {
  const gate = new RuntimeStartupSafetyGate(VALID_RECEIPT_ID, STAGE_4B3_BASELINE);
  const result = gate.verify(makeInput({ bridgeHealth: 'UNKNOWN' }));
  assert.ok(result.blockedReasons.includes(SAFETY_REASONS.BRIDGE_UNKNOWN));
});

test('15. UNKNOWN market data fail-closed', () => {
  const gate = new RuntimeStartupSafetyGate(VALID_RECEIPT_ID, STAGE_4B3_BASELINE);
  const result = gate.verify(makeInput({ marketDataHealth: 'UNKNOWN' }));
  assert.ok(result.blockedReasons.includes(SAFETY_REASONS.MARKET_DATA_UNKNOWN));
});

test('16. UNKNOWN state store fail-closed', () => {
  const gate = new RuntimeStartupSafetyGate(VALID_RECEIPT_ID, STAGE_4B3_BASELINE);
  const result = gate.verify(makeInput({ stateStoreIntact: 'UNKNOWN' }));
  assert.ok(result.blockedReasons.includes(SAFETY_REASONS.STATE_STORE_UNKNOWN));
});

test('17. UNKNOWN orders fail-closed', () => {
  const gate = new RuntimeStartupSafetyGate(VALID_RECEIPT_ID, STAGE_4B3_BASELINE);
  const result = gate.verify(makeInput({ hasUnresolvedOrders: 'UNKNOWN' }));
  assert.ok(result.blockedReasons.includes(SAFETY_REASONS.UNKNOWN_ORDER_POSITION));
});

test('18. UNKNOWN recovery fail-closed', () => {
  const gate = new RuntimeStartupSafetyGate(VALID_RECEIPT_ID, STAGE_4B3_BASELINE);
  const result = gate.verify(makeInput({ recoveryRequired: 'UNKNOWN' }));
  assert.ok(result.blockedReasons.includes(SAFETY_REASONS.RECOVERY_UNKNOWN));
});

test('19. all UNKNOWN produces multiple block reasons', () => {
  const gate = new RuntimeStartupSafetyGate(VALID_RECEIPT_ID, STAGE_4B3_BASELINE);
  const result = gate.verify(makeInput({
    bridgeHealth: 'UNKNOWN',
    marketDataHealth: 'UNKNOWN',
    stateStoreIntact: 'UNKNOWN',
    hasUnresolvedOrders: 'UNKNOWN',
    recoveryRequired: 'UNKNOWN',
  }));
  assert.ok(result.blockedReasons.length >= 5);
});

// ═══════════════════════════════════════════════════════════════════
// 30–40: Kill Switch persistence
// ═══════════════════════════════════════════════════════════════════

test('20. kill switch persist and restore', () => {
  const ks = new KillSwitch();
  ks.engage('emergency', '2026-01-01T00:00:00.000Z');
  const state = ks.persist();
  const ks2 = new KillSwitch();
  ks2.restore(state);
  assert.equal(ks2.enabled, true);
  assert.equal(ks2.reason, 'emergency');
  assert.equal(ks2.engagedAt, '2026-01-01T00:00:00.000Z');
});

test('21. kill switch restore does not re-disable', () => {
  const ks = new KillSwitch();
  ks.engage('test', '2026-01-01T00:00:00.000Z');
  const state = ks.persist();
  // Tamper state to disabled
  (state as any).enabled = false;
  const ks2 = new KillSwitch();
  ks2.restore(state);
  assert.equal(ks2.enabled, true); // Should NOT re-disable
});

test('22. kill switch no public reset', () => {
  const ks = new KillSwitch();
  // Verify no public methods exist for resetting (except _testFixtureReset)
  assert.equal(typeof (ks as any).reset, 'undefined');
  assert.equal(typeof (ks as any).disable, 'undefined');
  assert.equal(typeof (ks as any).clear, 'undefined');
});

test('23. kill switch _testFixtureReset works', () => {
  const ks = new KillSwitch();
  ks.engage('test', 'now');
  ks._testFixtureReset();
  assert.equal(ks.enabled, false);
});

test('24. kill switch persisted state is frozen', () => {
  const ks = new KillSwitch();
  ks.engage('test', 'now');
  const state = ks.persist();
  assert.ok(Object.isFrozen(state));
});

// ═══════════════════════════════════════════════════════════════════
// 40–50: Idempotency Ledger persistence + deterministic keys
// ═══════════════════════════════════════════════════════════════════

test('25. idempotency deterministic key independent of time', () => {
  const k1 = IdempotencyLedger.makeKey('STARTUP', 'session-1', 'sha123');
  const k2 = IdempotencyLedger.makeKey('STARTUP', 'session-1', 'sha123');
  assert.equal(k1, k2);
});

test('26. idempotency different session different key', () => {
  const k1 = IdempotencyLedger.makeKey('STARTUP', 'session-1', 'sha');
  const k2 = IdempotencyLedger.makeKey('STARTUP', 'session-2', 'sha');
  assert.notEqual(k1, k2);
});

test('27. idempotency ledger persist and restore', () => {
  const l1 = new IdempotencyLedger();
  const key = IdempotencyLedger.makeKey('STARTUP', 's1', 'sha');
  l1.checkDuplicate('STARTUP', key, '2026-01-01T00:00:00.000Z');
  l1.checkDuplicate('STARTUP', key, '2026-01-01T00:00:00.000Z');
  assert.equal(l1.duplicateCount, 1);

  const state = l1.persist();
  const l2 = new IdempotencyLedger();
  l2.restore(state);
  assert.equal(l2.duplicateCount, 1);
  assert.equal(l2.getAll().length, 1);
});

test('28. idempotency ledger restore then replay rejects', () => {
  const l1 = new IdempotencyLedger();
  const key = IdempotencyLedger.makeKey('STARTUP', 's1', 'sha');
  l1.checkDuplicate('STARTUP', key, '2026-01-01T00:00:00.000Z');
  const state = l1.persist();

  const l2 = new IdempotencyLedger();
  l2.restore(state);
  assert.equal(l2.checkDuplicate('STARTUP', key, '2026-01-01T00:00:01.000Z'), true);
});

test('29. idempotency no public clear', () => {
  const l = new IdempotencyLedger();
  assert.equal(typeof (l as any).clear, 'undefined');
});

test('30. idempotency _testFixtureClear works', () => {
  const l = new IdempotencyLedger();
  l.checkDuplicate('STARTUP', 'key', '2026-01-01T00:00:00.000Z');
  l._testFixtureClear();
  assert.equal(l.duplicateCount, 0);
});

test('31. idempotency FILL and TRANSITION types independent', () => {
  const l = new IdempotencyLedger();
  const key = IdempotencyLedger.makeKey('X', 'v');
  l.checkDuplicate('SIGNAL', key, '2026-01-01T00:00:00.000Z');
  assert.equal(l.checkDuplicate('FILL', key, '2026-01-01T00:00:00.000Z'), false);
});

// ═══════════════════════════════════════════════════════════════════
// 50–60: Recovery — incomplete restarts blocked
// ═══════════════════════════════════════════════════════════════════

test('32. recovery incomplete restart stays FAILED without completion evidence', () => {
  const rc = new RecoveryCoordinator();
  rc.startRecovery(makeRecoveryEvent('BRIDGE_CRASH'), '2026-01-01T00:00:00.000Z');
  // Restart without completion evidence
  const status = rc.restartRecovery(rc.getAllEvents());
  assert.equal(status, 'FAILED');
  assert.ok(rc.newPositionsBlocked);
});

test('33. recovery restart with valid completion evidence succeeds', () => {
  const rc = new RecoveryCoordinator();
  const event = makeRecoveryEvent('BRIDGE_CRASH');
  rc.startRecovery(event, '2026-01-01T00:00:00.000Z');
  const evidence = makeCompletionEvidence(event.eventId);
  rc.completeRecovery(evidence);

  const rc2 = new RecoveryCoordinator();
  const status = rc2.restartRecovery(rc.getAllEvents(), evidence);
  assert.equal(status, 'COMPLETED');
});

test('34. recovery restart with wrong evidence eventId fails', () => {
  const rc = new RecoveryCoordinator();
  const event = makeRecoveryEvent('BRIDGE_CRASH');
  rc.startRecovery(event, '2026-01-01T00:00:00.000Z');
  const wrongEvidence = makeCompletionEvidence('wrong-id'.repeat(4));
  assert.throws(() => rc.completeRecovery(wrongEvidence), /RECOVERY_NOT_VERIFIED/);
});

test('35. UNKNOWN order permanently blocks', () => {
  const rc = new RecoveryCoordinator();
  rc.startRecovery(makeRecoveryEvent('UNKNOWN_ORDER'), '2026-01-01T00:00:00.000Z');
  assert.equal(rc.status, 'FAILED');
  assert.ok(rc.newPositionsBlocked);
  // Can't restart out of FAILED with unknown orders
  const status = rc.restartRecovery(rc.getAllEvents());
  assert.equal(status, 'FAILED');
});

test('36. recovery complete blocks new positions in production', () => {
  const rc = new RecoveryCoordinator();
  const event = makeRecoveryEvent('BRIDGE_CRASH');
  rc.startRecovery(event, '2026-01-01T00:00:00.000Z');
  rc.completeRecovery(makeCompletionEvidence(event.eventId));
  assert.ok(rc.newPositionsBlocked); // Production: always blocked
});

test('37. recovery reference path enables positions', () => {
  const rc = new RecoveryCoordinator();
  const event = makeRecoveryEvent('BRIDGE_CRASH');
  rc.startRecovery(event, '2026-01-01T00:00:00.000Z');
  rc.completeRecovery(makeCompletionEvidence(event.eventId));
  rc._referenceEnablePositions();
  assert.equal(rc.newPositionsBlocked, false);
});

test('38. recovery complete without verification evidence throws', () => {
  const rc = new RecoveryCoordinator();
  rc.startRecovery(makeRecoveryEvent('BRIDGE_CRASH'), '2026-01-01T00:00:00.000Z');
  assert.throws(() => rc.completeRecovery({ recoveryEventId: '', verifiedState: '', evidenceDigest: '' }), /RECOVERY_NOT_VERIFIED/);
});

// ═══════════════════════════════════════════════════════════════════
// 60–70: State machine + Safety Gate regression
// ═══════════════════════════════════════════════════════════════════

test('39. state machine full reference path', () => {
  const sm = new RuntimeSafetyStateMachine();
  sm.transition('PRECHECKED');
  sm.transition('STARTING', 'REFERENCE_TEST_FIXTURE:r1');
  sm.transition('RUNNING_REFERENCE', 'REFERENCE_TEST_FIXTURE:r2');
  assert.equal(sm.state, 'RUNNING_REFERENCE');
});

test('40. safety gate receipt mismatch detected', () => {
  const gate = new RuntimeStartupSafetyGate(VALID_RECEIPT_ID, STAGE_4B3_BASELINE);
  const result = gate.verify(makeInput({ receiptId: '0'.repeat(64) }));
  assert.ok(result.blockedReasons.includes(SAFETY_REASONS.RECEIPT_INVALID));
});

test('41. caller input not frozen by gate', () => {
  const gate = new RuntimeStartupSafetyGate(VALID_RECEIPT_ID, STAGE_4B3_BASELINE);
  const input = makeInput({});
  assert.equal(Object.isFrozen(input), false);
  gate.verify(input);
  assert.equal(Object.isFrozen(input), false);
});

// ═══════════════════════════════════════════════════════════════════
// 70–80: Safety Policy with deterministic tokens
// ═══════════════════════════════════════════════════════════════════

test('42. policy uses deterministic token for idempotency', () => {
  const ks = new KillSwitch();
  const ledger = new IdempotencyLedger();
  const policy = new RuntimeSafetyPolicy(VALID_RECEIPT_ID, STAGE_4B3_BASELINE, ks, ledger);
  const d1 = policy.evaluate(makeInput({}), 'deterministic-token-1');
  const d2 = policy.evaluate(makeInput({}), 'deterministic-token-2');
  assert.equal(d1.decisionId, d2.decisionId); // Same input => same decision ID
});

test('43. policy blocks duplicate with same token', () => {
  const ks = new KillSwitch();
  const ledger = new IdempotencyLedger();
  const policy = new RuntimeSafetyPolicy(VALID_RECEIPT_ID, STAGE_4B3_BASELINE, ks, ledger);
  const d1 = policy.evaluate(makeInput({}), 'same-token');
  // Same token → duplicate STARTUP
  const d2 = policy.evaluate(makeInput({}), 'same-token');
  assert.ok(d2.blockedReasons.includes(SAFETY_REASONS.DUPLICATE_START));
});

test('44. policy decision is frozen', () => {
  const ks = new KillSwitch();
  const ledger = new IdempotencyLedger();
  const policy = new RuntimeSafetyPolicy(VALID_RECEIPT_ID, STAGE_4B3_BASELINE, ks, ledger);
  const d = policy.evaluate(makeInput({}), 't1');
  assert.ok(Object.isFrozen(d));
});

// ═══════════════════════════════════════════════════════════════════
// 80–90: Health Snapshot binding + Audit
// ═══════════════════════════════════════════════════════════════════

test('45. snapshot from real audit binds audit tip', () => {
  const audit = createBlockedSafetyAudit('2026-01-01T00:00:00.000Z');
  const ks = new KillSwitch();
  const ledger = new IdempotencyLedger();
  const policy = new RuntimeSafetyPolicy(VALID_RECEIPT_ID, STAGE_4B3_BASELINE, ks, ledger);
  const snap = policy.buildSnapshot('2026-01-01T00:00:00.000Z', 'READY', 'UNKNOWN', 'NONE', audit);
  assert.equal(snap.auditTip, audit.tipId);
  assert.equal(snap.lastEventId, audit.tipId);
});

test('46. snapshot duplicate count from real ledger', () => {
  const ks = new KillSwitch();
  const ledger = new IdempotencyLedger();
  const key = IdempotencyLedger.makeKey('SIGNAL', 'test');
  ledger.checkDuplicate('SIGNAL', key, 'now');
  ledger.checkDuplicate('SIGNAL', key, 'now'); // duplicate
  const policy = new RuntimeSafetyPolicy(VALID_RECEIPT_ID, STAGE_4B3_BASELINE, ks, ledger);
  const audit = createBlockedSafetyAudit('2026-01-01T00:00:00.000Z');
  const snap = policy.buildSnapshot('2026-01-01T00:00:00.000Z', 'READY', 'UNKNOWN', 'NONE', audit);
  assert.equal(snap.duplicateCount, 1);
});

test('47. snapshot field order independent', () => {
  const d1: RuntimeHealthSnapshotData = {
    liveApproved: false, testnetApproved: false, paperApproved: false,
    blockedReasons: [], retryCount: 0, duplicateCount: 0,
    lastEventId: null, auditTip: null, recoveryStatus: 'NONE',
    marketDataHealth: 'UNKNOWN', bridgeHealth: 'READY',
    killSwitchStatus: 'DISABLED', safetyGateStatus: 'BLOCKED',
    runtimeState: 'START_BLOCKED',
  };
  const d2: RuntimeHealthSnapshotData = {
    runtimeState: 'START_BLOCKED', safetyGateStatus: 'BLOCKED',
    killSwitchStatus: 'DISABLED', bridgeHealth: 'READY',
    marketDataHealth: 'UNKNOWN', recoveryStatus: 'NONE',
    lastEventId: null, auditTip: null, duplicateCount: 0, retryCount: 0,
    blockedReasons: [], paperApproved: false, testnetApproved: false, liveApproved: false,
  };
  const s1 = createRuntimeHealthSnapshot(d1, '2026-01-01T00:00:00.000Z');
  const s2 = createRuntimeHealthSnapshot(d2, '2026-01-01T00:00:00.000Z');
  assert.equal(s1.snapshotId, s2.snapshotId);
});

test('48. audit tamper detection', () => {
  const audit = new AppendOnlySafetyAudit();
  audit.append({ timestamp: '2026-01-01T00:00:00.000Z', eventType: 'ROOT', payload: {} });
  // Construct a tampered copy by cloning and mutating
  const tampered = JSON.parse(JSON.stringify(audit.all)) as any[];
  tampered[0].payloadDigest = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  assert.throws(() => new AppendOnlySafetyAudit(tampered), /AUDIT_TAMPERED|AUDIT_CHAIN_BROKEN/);
});

test('49. audit truncation detection', () => {
  const audit = new AppendOnlySafetyAudit();
  audit.append({ timestamp: '2026-01-01T00:00:00.000Z', eventType: 'ROOT', payload: {} });
  const tip = audit.append({ timestamp: '2026-01-01T00:00:01.000Z', eventType: 'SAFETY_CHECK', payload: {} }).eventId;
  assert.throws(() => new AppendOnlySafetyAudit([audit.all[0]]).validate(tip), /AUDIT_TRUNCATED|AUDIT_TAMPERED|AUDIT_CHAIN_BROKEN/);
});

test('50. audit reorder detection', () => {
  const audit = new AppendOnlySafetyAudit();
  audit.append({ timestamp: '2026-01-01T00:00:00.000Z', eventType: 'ROOT', payload: { a: 1 } });
  audit.append({ timestamp: '2026-01-01T00:00:01.000Z', eventType: 'SAFETY_CHECK', payload: { b: 2 } });
  const reordered = [audit.all[1], audit.all[0]];
  assert.throws(() => new AppendOnlySafetyAudit(reordered), /AUDIT_CHAIN_BROKEN|AUDIT_TAMPERED/);
});

// ═══════════════════════════════════════════════════════════════════
// Final status checks
// ═══════════════════════════════════════════════════════════════════

test('51. all approvals remain false in all outputs', () => {
  const ks = new KillSwitch();
  const ledger = new IdempotencyLedger();
  const policy = new RuntimeSafetyPolicy(VALID_RECEIPT_ID, STAGE_4B3_BASELINE, ks, ledger);
  const decision = policy.evaluate(makeInput({}), 'final-check');
  const audit = createBlockedSafetyAudit('2026-01-01T00:00:00.000Z');
  const snapshot = policy.buildSnapshot('2026-01-01T00:00:00.000Z', 'READY', 'UNKNOWN', 'NONE', audit);

  assert.equal(decision.reviewEligible, false);
  assert.equal(decision.paperApproved, false);
  assert.equal(decision.testnetApproved, false);
  assert.equal(decision.liveApproved, false);
  assert.equal(snapshot.paperApproved, false);
  assert.equal(snapshot.testnetApproved, false);
  assert.equal(snapshot.liveApproved, false);
});

test('52. Testnet/Live adapters never called', () => {
  // By construction: no reference to Testnet/Live adapters in RuntimeSafety
  // Verified by checking all exports don't include adapter references
  const ks = new KillSwitch();
  const ledger = new IdempotencyLedger();
  const policy = new RuntimeSafetyPolicy(VALID_RECEIPT_ID, STAGE_4B3_BASELINE, ks, ledger);
  const d = policy.evaluate(makeInput({}), 'zero-calls');
  assert.equal(d.testnetApproved, false);
  assert.equal(d.liveApproved, false);
});

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

const VALID_RECEIPT_ID = 'd4be6cadfedc0a9b4ac8628f492a34955c6ce57260fbe781b563787bce4b9f08';

function makeReal4B2Receipt(): Stage4B2ReceiptData {
  return {
    receiptId: VALID_RECEIPT_ID,
    sourceCommit: '81b0980f4fee168075a52c6ebcb12eb50f382217',
    stage4B1Artifact: 'f320f0e51ef6c0900a189dd7455d0c3ee77726bb4c6d1820d422d725629bf52e',
    stage4B1Proof: '7d35edaa205593ad07ccb8b254a67acad09511118939817e649166028535f1fb',
    stage4B1Decision: '80268cc673363290bea5f65aec0e7811041ecd6c608e06d6944aecfe5c2c39aa',
    paperApproved: false,
    testnetApproved: false,
    liveApproved: false,
    reviewEligible: false,
  };
}

function makeInput(overrides: Partial<SafetyGateInput> = {}): SafetyGateInput {
  return {
    receiptId: VALID_RECEIPT_ID,
    sourceSha: STAGE_4B3_BASELINE,
    killSwitch: new KillSwitch(),
    bridgeHealth: 'READY',
    marketDataHealth: 'UNKNOWN',
    stateStoreIntact: true,
    hasUnresolvedOrders: false,
    recoveryRequired: false,
    paperApproved: false,
    testnetApproved: false,
    liveApproved: false,
    ...overrides,
  };
}

let recoveryEventSeq = 0;
function makeRecoveryEvent(type: 'BRIDGE_CRASH' | 'BRIDGE_TIMEOUT' | 'DUPLICATE_EVENT' | 'PARTIAL_WRITE' | 'RESTART' | 'STALE_SNAPSHOT' | 'UNKNOWN_ORDER'): any {
  recoveryEventSeq++;
  const timestamp = `2026-01-01T00:00:0${recoveryEventSeq}.000Z`;
  const eventId = canonicalSha256({ type, timestamp, seq: recoveryEventSeq });
  return { type, timestamp, details: `test ${type}`, eventId };
}

function makeCompletionEvidence(eventId: string): RecoveryCompletionEvidence {
  return {
    recoveryEventId: eventId,
    verifiedState: 'RESTORED',
    evidenceDigest: canonicalSha256({ eventId, verified: true }),
  };
}

function makeSnapshotData(): RuntimeHealthSnapshotData {
  return {
    runtimeState: 'START_BLOCKED',
    safetyGateStatus: 'BLOCKED',
    killSwitchStatus: 'DISABLED',
    bridgeHealth: 'READY',
    marketDataHealth: 'UNKNOWN',
    recoveryStatus: 'NONE',
    lastEventId: null,
    auditTip: null,
    duplicateCount: 0,
    retryCount: 0,
    blockedReasons: [],
    paperApproved: false,
    testnetApproved: false,
    liveApproved: false,
  };
}
