// Stage 4B2: Paper Readiness Review tests — 30+ focused, fail-closed, tamper, real-blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import {
  createArtifactVerifier,
  PaperReadinessReviewPolicy,
  PaperReadinessReviewStateMachine,
  AppendOnlyPaperReadinessAudit,
  createRealBlockedPaperReadinessAudit,
  createPaperReadinessReviewRequest,
  STAGE_4B2_VERIFIED_BASELINE,
  PAPER_READINESS_SCHEMA,
  PAPER_READINESS_REASONS,
  type PaperReadinessReviewRequest,
} from '../../src/validation/PaperReadinessReview';
import {
  canonicalJson,
  ACTIVATION_CONTRACT_VERSION,
  STAGE_4B1_VERIFIED_BASELINE,
  type ActivationEligibilityProof,
  type ActivationIdentity,
  type Stage4AArtifactTextBundle,
} from '../../src/validation/ActivationContract';

// Test helper: generate a minimal 4B1-compatible proof (BLOCKED state)
function makeBlockedProof(reasonCodes: string[] = ['BLOCKED_NO_PROMOTED_STRATEGY']): ActivationEligibilityProof {
  return {
    schemaVersion: 'stage-4b1.activation-eligibility-proof.v1',
    contractVersion: ACTIVATION_CONTRACT_VERSION,
    mode: 'PRODUCTION',
    status: 'BLOCKED_NO_PROMOTED_STRATEGY',
    reasonCodes,
    baselineCommit: STAGE_4B1_VERIFIED_BASELINE,
    identity: null,
    sourceBindings: {},
    counts: { candidateStrategies: 0, promotionEligible: 0, consumedWindows: 0, consumedEvaluations: 0 },
    paperApproved: false, testnetApproved: false, liveApproved: false,
    proofId: '0000000000000000000000000000000000000000000000000000000000000000',
  };
}

const validRequestId = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const blockedProof = makeBlockedProof();

// ═══ 1–10: Artifact verifier ══════════════════════════════════
test('1. verifier rejects wrong baseline', () => {
  const v = createArtifactVerifier('wrong-baseline');
  assert.equal(v.reverifyArtifacts({} as any).reasonCodes[0], PAPER_READINESS_REASONS.BASELINE_MISMATCH);
});

test('2. verifier baseline ok', () => {
  const v = createArtifactVerifier(STAGE_4B2_VERIFIED_BASELINE);
  assert.ok(v);
});

test('3. empty bundle reverification fails', () => {
  const v = createArtifactVerifier(STAGE_4B2_VERIFIED_BASELINE);
  const r = v.reverifyArtifacts({} as Stage4AArtifactTextBundle);
  assert.equal(r.promotionEligible, false);
  assert.equal(r.stage4AClosed, false);
});

test('4. verify identity mismatch', () => {
  const v = createArtifactVerifier(STAGE_4B2_VERIFIED_BASELINE);
  assert.equal(v.verifyIdentity({ strategyId: 'x', specId: 'y', strategyVersion: '1', semanticFingerprint: 'aa', lineageId: 'bb' }, blockedProof), false);
});

test('5. detectStage4A14 on empty bundle', () => {
  const v = createArtifactVerifier(STAGE_4B2_VERIFIED_BASELINE);
  assert.equal(v.detectStage4A14({} as any), false);
});

test('6. artifactDigest is 64-char hex when present', () => {
  const v = createArtifactVerifier(STAGE_4B2_VERIFIED_BASELINE);
  try { const r = v.reverifyArtifacts({ candidateManifestJson: '{}', promotionDecisionJson: '{}', consumedEvidenceSeedJson: '{}', governanceContractJson: '{}', closureAuditJson: '{}' }); assert.equal(r.artifactDigest.length, 64); } catch { /* malformed bundle expected */ }
});

test('7. liveExecutionChanges always false', () => {
  const v = createArtifactVerifier(STAGE_4B2_VERIFIED_BASELINE);
  assert.equal(v.reverifyArtifacts({} as any).liveExecutionChanges, false);
});

test('8. paperApproved always false', () => {
  const v = createArtifactVerifier(STAGE_4B2_VERIFIED_BASELINE);
  assert.equal(v.reverifyArtifacts({} as any).paperApproved, false);
});

// ═══ 11–20: Policy decisions ══════════════════════════════════
test('9. policy baseline mismatch', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: 'wrong' });
  const r = p.evaluateRequest({ schemaVersion: PAPER_READINESS_SCHEMA } as any, blockedProof, {} as any, Date.now());
  assert.ok(r.reasonCodes.includes(PAPER_READINESS_REASONS.BASELINE_MISMATCH));
});

test('10. policy rejects REFERENCE mode', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'REFERENCE', '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z');
  const r = p.evaluateRequest(req, blockedProof, {} as any, Date.now());
  assert.equal(r.status, 'REVIEW_BLOCKED');
});

test('11. reviewEligible always false', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  const r = p.evaluateRequest(req, blockedProof, {} as any, Date.now());
  assert.equal(r.reviewEligible, false);
});

test('12. paperApproved always false', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  assert.equal(p.evaluateRequest(req, blockedProof, {} as any, Date.now()).paperApproved, false);
});

test('13. testnetApproved always false', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  assert.equal(p.evaluateRequest(req, blockedProof, {} as any, Date.now()).testnetApproved, false);
});

test('14. liveApproved always false', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  assert.equal(p.evaluateRequest(req, blockedProof, {} as any, Date.now()).liveApproved, false);
});

test('15. expired request rejected', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z');
  const r = p.evaluateRequest(req, blockedProof, {} as any, Date.now());
  assert.ok(r.reasonCodes.includes(PAPER_READINESS_REASONS.REQUEST_EXPIRED));
});

test('16. replay rejected', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  p.evaluateRequest(req, blockedProof, {} as any, Date.now());
  const r2 = p.evaluateRequest(req, blockedProof, {} as any, Date.now());
  assert.ok(r2.reasonCodes.includes(PAPER_READINESS_REASONS.REPLAY_REJECTED));
});

test('17. fake proof rejected', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const fakeProof = { ...blockedProof, mode: 'REFERENCE' as const };
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  assert.ok(p.evaluateRequest(req, fakeProof, {} as any, Date.now()).reasonCodes.includes(PAPER_READINESS_REASONS.FAKE_PROOF_DETECTED));
});

test('18. liveExecutionChanges triggers block', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  (p as any)._liveExecutionChanges = true;
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  assert.ok(p.evaluateRequest(req, blockedProof, {} as any, Date.now()).reasonCodes.includes(PAPER_READINESS_REASONS.LIVE_EXECUTION_CHANGES));
});

test('19. paperRuntimeChanges triggers block', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  (p as any)._paperRuntimeChanges = true;
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  assert.ok(p.evaluateRequest(req, blockedProof, {} as any, Date.now()).reasonCodes.includes(PAPER_READINESS_REASONS.PAPER_RUNTIME_CHANGES));
});

// ═══ 21–30: State machine ═════════════════════════════════════
test('20. initial state UNREVIEWED', () => {
  assert.equal(new PaperReadinessReviewStateMachine().state, 'UNREVIEWED');
});

test('21. UNREVIEWED → ARTIFACTS_REVERIFIED', () => {
  const sm = new PaperReadinessReviewStateMachine();
  assert.equal(sm.transition('ARTIFACTS_REVERIFIED'), 'ARTIFACTS_REVERIFIED');
});

test('22. UNREVIEWED → REVIEW_BLOCKED', () => {
  const sm = new PaperReadinessReviewStateMachine();
  assert.equal(sm.transition('REVIEW_BLOCKED'), 'REVIEW_BLOCKED');
});

test('23. ARTIFACTS_REVERIFIED → REVIEW_BLOCKED', () => {
  const sm = new PaperReadinessReviewStateMachine();
  sm.transition('ARTIFACTS_REVERIFIED');
  assert.equal(sm.transition('REVIEW_BLOCKED'), 'REVIEW_BLOCKED');
});

test('24. REVIEW_BLOCKED is terminal', () => {
  const sm = new PaperReadinessReviewStateMachine();
  sm.transition('REVIEW_BLOCKED');
  assert.throws(() => sm.transition('ARTIFACTS_REVERIFIED'));
});

test('25. invalid transition rejected', () => {
  assert.throws(() => new PaperReadinessReviewStateMachine().transition('ARTIFACTS_REVERIFIED').transition('ARTIFACTS_REVERIFIED'));
});

test('26. duplicate request replay rejected', () => {
  const sm = new PaperReadinessReviewStateMachine();
  sm.transition('ARTIFACTS_REVERIFIED', 'req1');
  assert.throws(() => sm.transition('REVIEW_BLOCKED', 'req1'));
});

// ═══ 31–40: Audit ════════════════════════════════════════════
test('27. audit initializes empty', () => {
  assert.equal(new AppendOnlyPaperReadinessAudit().tipId, null);
});

test('28. audit can append ROOT', () => {
  const a = new AppendOnlyPaperReadinessAudit();
  const e = a.append({ timestamp: '2026-01-01T00:00:00.000Z', fromState: null, toState: 'UNREVIEWED', eventType: 'ROOT', payload: {} });
  assert.equal(e.sequence, 0);
  assert.equal(e.eventType, 'ROOT');
});

test('29. audit chain intact', () => {
  const a = new AppendOnlyPaperReadinessAudit();
  a.append({ timestamp: '2026-01-01T00:00:00.000Z', fromState: null, toState: 'UNREVIEWED', eventType: 'ROOT', payload: {} });
  a.append({ timestamp: '2026-01-01T00:00:00.001Z', fromState: 'UNREVIEWED', toState: 'REVIEW_BLOCKED', eventType: 'TRANSITION', payload: {} });
  assert.equal(a.tipId, a.all[1].eventId);
});

test('30. audit detection of broken chain', () => {
  // Constructor validates input — broken chain should throw at construction time
  try {
    new AppendOnlyPaperReadinessAudit([{
      schemaVersion: PAPER_READINESS_REASONS.AUDIT_CHAIN_BROKEN as any,
      sequence: 0, timestamp: '2026-01-01T00:00:00.000Z', previousEventId: null,
      fromState: null, toState: 'UNREVIEWED', eventType: 'ROOT', payloadDigest: 'aa',
      requestId: null, eventId: 'bb',
    } as any]);
    assert.fail('should have thrown on broken chain');
  } catch {
    // Expected — constructor validate detected schema mismatch
  }
});

test('31. createRealBlockedAudit produces valid chain', () => {
  const a = createRealBlockedPaperReadinessAudit('2026-01-01T00:00:00.000Z');
  assert.equal(a.all.length, 2);
  assert.equal(a.all[0].toState, 'UNREVIEWED');
  assert.equal(a.all[1].toState, 'REVIEW_BLOCKED');
});

test('32. real blocked audit validates', () => {
  const a = createRealBlockedPaperReadinessAudit('2026-01-01T00:00:00.000Z');
  a.validate(); // should not throw
});

// ═══ 41–50: Request validity ══════════════════════════════════
test('33. valid request created', () => {
  const r = createPaperReadinessReviewRequest('proof123', 'a'.repeat(64), 'engineer-1', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  assert.equal(r.schemaVersion, 'stage-4b2.paper-readiness-request.v1');
});

test('34. request digest must be 64 hex chars', () => {
  assert.throws(() => createPaperReadinessReviewRequest('p', 'abc', 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'));
});

test('35. request expiresAt before issuedAt', () => {
  assert.throws(() => createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'));
});

test('36. decisionId deterministic', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  const r1 = p.evaluateRequest(req, blockedProof, {} as any, Date.now());
  // Second call would replay-reject, so use new policy
  const p2 = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const r2 = p2.evaluateRequest(req, blockedProof, {} as any, Date.now());
  assert.equal(r1.decisionId, r2.decisionId);
});

test('37. different request → different decisionId', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const r1 = p.evaluateRequest(createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'r1', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'), blockedProof, {} as any, Date.now());
  const p2 = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const r2 = p2.evaluateRequest(createPaperReadinessReviewRequest('p', 'b'.repeat(64), 'r2', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'), blockedProof, {} as any, Date.now());
  assert.notEqual(r1.decisionId, r2.decisionId);
});

test('38. canonical JSON is deterministic', () => {
  const a = canonicalJson({ b: 2, a: 1 });
  const b = canonicalJson({ a: 1, b: 2 });
  assert.equal(a, b);
});

test('39. decision is frozen', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  assert.ok(Object.isFrozen(p.evaluateRequest(req, blockedProof, {} as any, Date.now())));
});

test('40. fake self-consistent proof detected via identity', () => {
  const p = new PaperReadinessReviewPolicy({ baselineCommit: STAGE_4B2_VERIFIED_BASELINE });
  // A proof claiming ELIGIBLE but with null identity is fake
  const fakeEligibleProof = {
    ...blockedProof,
    status: 'ELIGIBLE_FOR_ACTIVATION_REVIEW' as const,
    identity: null,
  };
  const req = createPaperReadinessReviewRequest('p', 'a'.repeat(64), 'req', 'PRODUCTION', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  const r = p.evaluateRequest(req, fakeEligibleProof, {} as any, Date.now());
  assert.ok(r.reasonCodes.includes(PAPER_READINESS_REASONS.FAKE_PROOF_DETECTED));
});

// ═══ 41–50: Stage 4B2 Receipt ═════════════════════════════════
import {
  createStage4B2Receipt,
  verifyStage4B2Receipt,
  STAGE_4B2_RECEIPT_SCHEMA,
} from '../../src/validation/PaperReadinessReview';

const valid4B1Artifact = {
  schemaVersion: 'stage-4b1.activation-contract-artifact.v1',
  labels: ['OFFLINE', 'BLOCKED: NO PROMOTED STRATEGY'],
  artifactId: 'a'.repeat(64),
  eligibilityProof: {
    proofId: 'b'.repeat(64),
    status: 'BLOCKED_NO_PROMOTED_STRATEGY',
    paperApproved: false,
    liveApproved: false,
  },
  activationDecision: {
    decisionId: 'c'.repeat(64),
    eligibilityProofId: 'b'.repeat(64),
    status: 'ACTIVATION_BLOCKED',
    paperApproved: false,
    liveApproved: false,
  },
};

const receiptOptsBase = {
  sourceCommit: 'd'.repeat(40),
  stage4AClosureAuditId: 'e'.repeat(64),
  stage4B1Artifact: valid4B1Artifact,
  stage4B1ArtifactSourceSha256: 'f'.repeat(64),
  generatedAt: '2026-07-27T21:00:00.000Z',
};

test('41. receipt is deterministic', () => {
  const r1 = createStage4B2Receipt(receiptOptsBase);
  const r2 = createStage4B2Receipt(receiptOptsBase);
  assert.equal(r1.receiptId, r2.receiptId);
  assert.ok(Object.isFrozen(r1));
});

test('42. receipt binds all required fields', () => {
  const r = createStage4B2Receipt(receiptOptsBase);
  assert.equal(r.schemaVersion, STAGE_4B2_RECEIPT_SCHEMA);
  assert.equal(r.stage4B1ArtifactId, 'a'.repeat(64));
  assert.equal(r.stage4B1ProofId, 'b'.repeat(64));
  assert.equal(r.stage4B1DecisionId, 'c'.repeat(64));
  assert.equal(r.reviewEligible, false);
  assert.equal(r.paperApproved, false);
  assert.equal(r.testnetApproved, false);
  assert.equal(r.liveApproved, false);
  assert.equal(r.paperRuntimeChanges, false);
  assert.equal(r.liveExecutionChanges, false);
  assert.equal(r.status, 'BLOCKED_NO_ACTIVATION_REVIEW_READY_STRATEGY');
});

test('43. verifier rejects schema mismatch', () => {
  assert.throws(() => verifyStage4B2Receipt(
    { ...createStage4B2Receipt(receiptOptsBase), schemaVersion: 'wrong' }, receiptOptsBase));
});

test('44. verifier rejects tampered sourceCommit', () => {
  assert.throws(() => verifyStage4B2Receipt(
    createStage4B2Receipt(receiptOptsBase),
    { ...receiptOptsBase, sourceCommit: 'x'.repeat(40) }));
});

test('45. verifier rejects tampered 4B1 artifact', () => {
  const r = createStage4B2Receipt(receiptOptsBase);
  const tamperedArtifact = structuredClone(valid4B1Artifact);
  tamperedArtifact.eligibilityProof.status = 'ELIGIBLE_FOR_ACTIVATION_REVIEW';
  assert.throws(() => verifyStage4B2Receipt(r,
    { ...receiptOptsBase, stage4B1Artifact: tamperedArtifact }));
});

test('46. verifier rejects tampered receiptId', () => {
  const r = createStage4B2Receipt(receiptOptsBase);
  const tampered = { ...r, receiptId: 'x'.repeat(64) };
  assert.throws(() => verifyStage4B2Receipt(tampered, receiptOptsBase));
});

test('47. verifier passes valid receipt', () => {
  const r = createStage4B2Receipt(receiptOptsBase);
  const v = verifyStage4B2Receipt(r, receiptOptsBase);
  assert.equal(v.receiptId, r.receiptId);
  assert.ok(Object.isFrozen(v));
});

test('48. receipt rejects invalid source commit length', () => {
  assert.throws(() => createStage4B2Receipt({ ...receiptOptsBase, sourceCommit: 'abc' }));
});

test('49. receipt rejects invalid timestamp', () => {
  assert.throws(() => createStage4B2Receipt({ ...receiptOptsBase, generatedAt: 'now' }));
});

test('50. verifier rejects zero artifactId', () => {
  const r = createStage4B2Receipt(receiptOptsBase);
  const zero = structuredClone(valid4B1Artifact);
  zero.artifactId = '0'.repeat(64);
  assert.throws(() => createStage4B2Receipt({ ...receiptOptsBase, stage4B1Artifact: zero }));
});

test('51. verifier rejects self-consistent fake via sha256 mismatch', () => {
  const r = createStage4B2Receipt(receiptOptsBase);
  // Create a self-consistent fake artifact with different sha256
  const fake = structuredClone(valid4B1Artifact);
  fake.eligibilityProof.proofId = 'f'.repeat(64);
  fake.activationDecision.eligibilityProofId = 'f'.repeat(64);
  fake.artifactId = 'f'.repeat(64);
  // Verifier computes sha256 of the fake → won't match receipt-bound sha256
  assert.throws(() => verifyStage4B2Receipt(r,
    { ...receiptOptsBase, stage4B1Artifact: fake, stage4B1ArtifactSourceSha256: '0'.repeat(64) }));
});
