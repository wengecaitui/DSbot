import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACTIVATION_APPROVAL_SCHEMA,
  ACTIVATION_REASONS,
  ActivationStateMachine,
  AppendOnlyActivationAudit,
  REFERENCE_FIXTURE_LABEL,
  REQUESTED_SCOPE,
  canonicalJson,
  canonicalSha256,
  createActivationRequest,
  createRealBlockedAudit,
  createReferenceActivationRequest,
  evaluateActivationDecision,
  evaluateReferenceContractDecision,
  makeReferenceApprovalSigningPayload,
  verifyProductionEligibility,
  verifyReferenceEligibilityFixture,
  type ActivationApproval,
  type ActivationEligibilityProof,
  type ReferenceActivationApproval,
  type ReferenceEligibilityFixture,
  type Stage4AArtifactTextBundle,
} from '../../src/validation/ActivationContract';

const BASELINE = '9f659d7a02a4c025b9cef86ad6fa855e00f99b15';
const NOW = '2026-07-27T00:00:00.000Z';
const LATER = '2026-07-28T00:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function stage4A(): Stage4AArtifactTextBundle {
  const text = (name: string) => readFileSync(`docs/releases/${name}`, 'utf8');
  return {
    candidateManifestJson: text('stage-4a12-candidate-manifest.json'),
    promotionDecisionJson: text('stage-4a12-promotion-decision.json'),
    consumedEvidenceSeedJson: text('stage-4a13-consumed-evidence-seed.json'),
    governanceContractJson: text('stage-4a13-evidence-governance-contract.json'),
    closureAuditJson: text('stage-4a-closure-audit.json'),
  };
}

function referenceFixture(): ReferenceEligibilityFixture {
  return {
    label: REFERENCE_FIXTURE_LABEL,
    identity: {
      strategyId: 'reference-strategy', specId: SHA_A, strategyVersion: '1.0.0',
      semanticFingerprint: SHA_B, lineageId: SHA_C,
    },
    evidence: [{
      strategyId: 'reference-strategy', specId: SHA_A, strategyVersion: '1.0.0',
      semanticFingerprint: SHA_B, lineageId: SHA_C, evidenceFingerprint: 'd'.repeat(64),
      resultDigest: 'e'.repeat(64), state: 'CONSUMED', evaluationCount: 1,
    }],
  };
}

function signedReferenceApproval(
  overrides: Partial<ReferenceActivationApproval> = {},
  keyPair = generateKeyPairSync('ed25519'),
) {
  const proof = verifyReferenceEligibilityFixture(referenceFixture());
  const request = createReferenceActivationRequest(proof, NOW, LATER);
  const statement: Omit<ReferenceActivationApproval, 'signature'> = {
    schemaVersion: 'stage-4b1.reference-activation-approval.v1', label: REFERENCE_FIXTURE_LABEL,
    eligibilityProofId: proof.proofId, requestId: request.requestId, identity: { ...proof.identity! },
    requestedScope: REQUESTED_SCOPE, approverId: 'reviewer-1', keyId: 'key-1', issuedAt: NOW, expiresAt: LATER,
    ...(({ signature: _signature, ...rest }) => rest)(overrides as ReferenceActivationApproval),
  };
  const approval: ReferenceActivationApproval = {
    ...statement,
    signature: overrides.signature ?? sign(null, makeReferenceApprovalSigningPayload(statement), keyPair.privateKey).toString('base64'),
  };
  const trusted = [{
    approverId: 'reviewer-1', keyId: 'key-1',
    publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }];
  return { proof, request, approval, trusted, keyPair };
}

test('real Stage 4A artifacts deterministically block with no promoted strategy', () => {
  const first = verifyProductionEligibility(stage4A());
  const second = verifyProductionEligibility(stage4A());
  assert.deepEqual(first, second);
  assert.equal(first.status, 'BLOCKED_NO_PROMOTED_STRATEGY');
  assert.deepEqual(first.reasonCodes, [ACTIVATION_REASONS.NO_PROMOTED_STRATEGY]);
  assert.deepEqual(first.counts, { candidateStrategies: 4, promotionEligible: 0, consumedWindows: 10, consumedEvaluations: 40 });
  assert.equal(first.identity, null);
  assert.equal(first.paperApproved, false);
  assert.equal(first.testnetApproved, false);
  assert.equal(first.liveApproved, false);
});

test('real blocked proof creates exact fail-closed state path and no request', () => {
  const proof = verifyProductionEligibility(stage4A());
  const audit = createRealBlockedAudit(proof, NOW);
  assert.deepEqual(audit.events.map(event => event.toState), ['INACTIVE', 'ELIGIBILITY_CHECKED', 'ACTIVATION_BLOCKED']);
  assert.ok(audit.events.every(event => event.requestId === null));
  assert.throws(() => createActivationRequest(proof, NOW, LATER), /ACTIVATION_REQUEST_REJECTED/);
});

test('promotion=false is rejected before approvals', () => {
  const proof = verifyProductionEligibility(stage4A());
  const result = evaluateActivationDecision(proof, null, [], [], Date.parse(NOW));
  assert.equal(result.status, 'ACTIVATION_BLOCKED');
  assert.ok(result.reasonCodes.includes(ACTIVATION_REASONS.NO_PROMOTED_STRATEGY));
});

test('tampered digest and commit/SHA binding fail closed without partial state', () => {
  const original = stage4A();
  for (const key of Object.keys(original) as (keyof Stage4AArtifactTextBundle)[]) {
    const changed = { ...original, [key]: original[key].replace(/[a-f0-9]{40,64}/, match => `${match[0] === '0' ? '1' : '0'}${match.slice(1)}`) };
    const proof = verifyProductionEligibility(changed);
    assert.equal(proof.status, 'BLOCKED_INVALID_EVIDENCE', key);
    assert.ok(proof.reasonCodes.includes(ACTIVATION_REASONS.ARTIFACT_DIGEST_INVALID), key);
  }
});

test('malformed and Stage 4A14 relabelled sources fail closed', () => {
  const malformed = { ...stage4A(), closureAuditJson: '{bad' };
  assert.deepEqual(verifyProductionEligibility(malformed).reasonCodes, [ACTIVATION_REASONS.ARTIFACT_MALFORMED]);
  const closure = JSON.parse(stage4A().closureAuditJson);
  closure.stage4A14Authorized = true;
  const unsigned = { ...closure };
  delete unsigned.auditId;
  closure.auditId = canonicalSha256(unsigned);
  const result = verifyProductionEligibility({ ...stage4A(), closureAuditJson: `${JSON.stringify(closure)}\n` });
  assert.equal(result.status, 'BLOCKED_INVALID_EVIDENCE');
  assert.ok(result.reasonCodes.includes(ACTIVATION_REASONS.STAGE_4A14_SOURCE_REJECTED));
});

test('reference exact-once evidence verifies but is production-incompatible', () => {
  const proof = verifyReferenceEligibilityFixture(referenceFixture());
  assert.equal(proof.mode, 'REFERENCE');
  assert.equal(proof.status, 'REFERENCE_CONTRACT_VERIFIED');
  assert.throws(() => createActivationRequest(proof, NOW, LATER), /ACTIVATION_REQUEST_REJECTED/);
  const request = createReferenceActivationRequest(proof, NOW, LATER);
  const production = evaluateActivationDecision(proof, request as never, [], [], Date.parse(NOW));
  assert.deepEqual(production.reasonCodes, [ACTIVATION_REASONS.REFERENCE_FIXTURE_REJECTED]);
});

test('reference evidence rejects foreign family, relabel, incomplete and duplicate consumption', () => {
  const foreign = referenceFixture();
  foreign.evidence[0] = { ...foreign.evidence[0], semanticFingerprint: SHA_C };
  assert.throws(() => verifyReferenceEligibilityFixture(foreign), /FOREIGN_OR_RELABELLED/);
  const incomplete = referenceFixture();
  incomplete.evidence[0] = { ...incomplete.evidence[0], evaluationCount: 2 as 1 };
  assert.throws(() => verifyReferenceEligibilityFixture(incomplete), /EVIDENCE_INCOMPLETE/);
  const duplicate = referenceFixture();
  (duplicate.evidence as ReferenceEligibilityFixture['evidence'][number][]).push({ ...duplicate.evidence[0] });
  assert.throws(() => verifyReferenceEligibilityFixture(duplicate), /EVIDENCE_DUPLICATE/);
  const relabel = referenceFixture();
  relabel.evidence[0] = { ...relabel.evidence[0], strategyId: 'copied-new-id' };
  assert.throws(() => verifyReferenceEligibilityFixture(relabel), /FOREIGN_OR_RELABELLED/);
});

test('valid Ed25519 reference approval proves contract without production status', () => {
  const { proof, request, approval, trusted } = signedReferenceApproval();
  const result = evaluateReferenceContractDecision(proof, request, [approval], trusted, Date.parse(NOW));
  assert.equal(result.mode, 'REFERENCE');
  assert.equal(result.status, 'REFERENCE_CONTRACT_VERIFIED');
  assert.notEqual(result.status, 'ACTIVATION_REVIEW_READY');
  assert.deepEqual(result.verifiedApproverIds, ['reviewer-1']);
});

test('missing, malformed, untrusted and duplicate approvals reject', () => {
  const { proof, request, approval, trusted } = signedReferenceApproval();
  assert.deepEqual(evaluateReferenceContractDecision(proof, request, [], trusted, Date.parse(NOW)).reasonCodes, [ACTIVATION_REASONS.APPROVAL_MISSING]);
  assert.ok(evaluateReferenceContractDecision(proof, request, [{ ...approval, signature: '!' }], trusted, Date.parse(NOW)).reasonCodes.includes(ACTIVATION_REASONS.APPROVAL_SIGNATURE_INVALID));
  assert.ok(evaluateReferenceContractDecision(proof, request, [{ ...approval, keyId: 'foreign' }], trusted, Date.parse(NOW)).reasonCodes.includes(ACTIVATION_REASONS.APPROVAL_UNTRUSTED_KEY));
  assert.ok(evaluateReferenceContractDecision(proof, request, [approval, approval], trusted, Date.parse(NOW)).reasonCodes.includes(ACTIVATION_REASONS.APPROVAL_DUPLICATE_APPROVER));
});

test('expired, not-yet-valid, bad signature and identity/SHA binding reject', () => {
  const base = signedReferenceApproval();
  const expired = signedReferenceApproval({ expiresAt: '2026-07-27T12:00:00.000Z' });
  assert.ok(evaluateReferenceContractDecision(expired.proof, expired.request, [expired.approval], expired.trusted, Date.parse('2026-07-27T13:00:00.000Z')).reasonCodes.includes(ACTIVATION_REASONS.APPROVAL_EXPIRED));
  const future = signedReferenceApproval({ issuedAt: '2026-07-27T12:00:00.000Z' });
  assert.ok(evaluateReferenceContractDecision(future.proof, future.request, [future.approval], future.trusted, Date.parse(NOW)).reasonCodes.includes(ACTIVATION_REASONS.APPROVAL_NOT_YET_VALID));
  const badSignature = { ...base.approval, signature: Buffer.alloc(64).toString('base64') };
  assert.ok(evaluateReferenceContractDecision(base.proof, base.request, [badSignature], base.trusted, Date.parse(NOW)).reasonCodes.includes(ACTIVATION_REASONS.APPROVAL_SIGNATURE_INVALID));
  const mismatch = { ...base.approval, identity: { ...base.approval.identity, specId: SHA_C } };
  assert.ok(evaluateReferenceContractDecision(base.proof, base.request, [mismatch], base.trusted, Date.parse(NOW)).reasonCodes.includes(ACTIVATION_REASONS.APPROVAL_BINDING_MISMATCH));
});

test('strategy version, spec, lineage and semantic copy changes reject', () => {
  for (const [key, value] of [['strategyVersion', '2.0.0'], ['specId', SHA_C], ['lineageId', SHA_A], ['semanticFingerprint', SHA_C]] as const) {
    const fixture = referenceFixture();
    fixture.evidence[0] = { ...fixture.evidence[0], [key]: value };
    assert.throws(() => verifyReferenceEligibilityFixture(fixture), /FOREIGN_OR_RELABELLED/, key);
  }
});

test('state machine rejects skips, replay, backward and post-terminal mutation', () => {
  const skipped = new ActivationStateMachine();
  assert.throws(() => skipped.transition('ACTIVATION_REQUESTED', SHA_A), /INVALID_TRANSITION/);
  const machine = new ActivationStateMachine();
  machine.transition('ELIGIBILITY_CHECKED');
  machine.transition('ACTIVATION_REQUESTED', SHA_A);
  assert.throws(() => machine.transition('ACTIVATION_REQUESTED', SHA_A), /INVALID_TRANSITION/);
  machine.transition('ACTIVATION_BLOCKED', SHA_A);
  assert.throws(() => machine.transition('ELIGIBILITY_CHECKED'), /TERMINAL_STATE/);
});

function blockedAudit() {
  return createRealBlockedAudit(verifyProductionEligibility(stage4A()), NOW);
}

test('append-only audit rejects body, previous hash, sequence and transition tamper', () => {
  const originals = blockedAudit().events;
  const changes = [
    (events: any[]) => { events[1].payloadDigest = SHA_A; },
    (events: any[]) => { events[1].previousEventId = SHA_A; },
    (events: any[]) => { events[1].sequence = 8; },
    (events: any[]) => { events[1].toState = 'ACTIVATION_REVIEW_READY'; },
  ];
  for (const change of changes) {
    const events = JSON.parse(JSON.stringify(originals));
    change(events);
    assert.throws(() => new AppendOnlyActivationAudit(events), /ACTIVATION_AUDIT_ERROR/);
  }
});

test('append-only audit detects truncation against expected tip and request forks', () => {
  const audit = blockedAudit();
  const tip = audit.tipId!;
  assert.throws(() => new AppendOnlyActivationAudit(audit.events.slice(0, 2), tip), /AUDIT_INVALID/);
  const requestAudit = new AppendOnlyActivationAudit();
  requestAudit.append({ timestamp: NOW, eventType: 'ROOT', fromState: null, toState: 'INACTIVE', payload: {} });
  requestAudit.append({ timestamp: NOW, eventType: 'TRANSITION', fromState: 'INACTIVE', toState: 'ELIGIBILITY_CHECKED', payload: {} });
  requestAudit.append({ timestamp: NOW, eventType: 'TRANSITION', fromState: 'ELIGIBILITY_CHECKED', toState: 'ACTIVATION_REQUESTED', requestId: SHA_A, payload: {} });
  assert.throws(() => requestAudit.append({ timestamp: NOW, eventType: 'TRANSITION', fromState: 'ACTIVATION_REQUESTED', toState: 'ACTIVATION_REVIEW_READY', requestId: SHA_B, payload: {} }), /REQUEST_BINDING_MISMATCH/);
});

test('caller inputs remain unfrozen, unmodified and unaliased', () => {
  const input = referenceFixture();
  const before = JSON.stringify(input);
  const proof = verifyReferenceEligibilityFixture(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.identity), false);
  input.identity.strategyId = 'caller-mutated';
  assert.equal(proof.identity?.strategyId, 'reference-strategy');
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(Object.isFrozen(proof.identity), true);
});

test('canonical IDs are deterministic across key order and reject unsupported values', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /NON_FINITE_NUMBER/);
  assert.throws(() => canonicalJson({ bad: undefined }), /UNSUPPORTED_VALUE/);
});

test('production contract has no forbidden runtime, paper, execution, exchange or order import', () => {
  const source = readFileSync('src/validation/ActivationContract.ts', 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(imports, ['node:crypto']);
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:paper|runtime|execution|exchange|broker|order)[^'"]*['"]/i);
});

test('reference private key and signatures are confined to this test module', () => {
  const source = readFileSync('src/validation/ActivationContract.ts', 'utf8');
  assert.doesNotMatch(source, /generateKeyPair|createPrivateKey|privateKey/);
  assert.equal(ACTIVATION_APPROVAL_SCHEMA, 'stage-4b1.activation-approval.v1');
});
