import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { runWalkForward, type SimResult } from '../../src/validation/WalkForward';
import type { CostConfig, WalkForwardConfig } from '../../src/validation/ValidationTypes';
import type { StrategyPromotionPolicy } from '../../src/validation/StrategyPromotionGate';
import { createPromotionDecisionArtifact } from '../../src/validation/PromotionDecisionArtifactStore';
import {
  evaluatePromotionApprovals,
  makePromotionApprovalSigningPayload,
  PROMOTION_APPROVAL_CONTRACT_VERSION,
  PROMOTION_APPROVAL_REASONS,
  type PromotionApprovalAttestation,
  type PromotionApprovalPolicy,
  type PromotionApprovalStatement,
} from '../../src/validation/PromotionApprovalGate';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const CONFIG: WalkForwardConfig = {
  mode: 'rolling', totalBars: 5_000, trainBars: 500, validationBars: 100, testBars: 100,
  purgeBars: 5, embargoBars: 5, featureLookbackBars: 20, labelHorizonBars: 5,
};
const COST: CostConfig = {
  feeBps: 1, spreadBps: 1, slippageBps: 1, latencyPenaltyBps: 0, stressMultiplier: 1,
};
const PROMOTION_POLICY: StrategyPromotionPolicy = {
  minDevelopmentFolds: 1, maxWarnings: 10, maxLimitations: 10,
  minFinalHoldoutTrades: 10, minFinalHoldoutNetReturn: -1_000_000,
  minFinalHoldoutSharpe: 1, maxFinalHoldoutDrawdown: 0.2,
};

function simulator(): SimResult {
  return {
    grossPnl: 1_000, volume: 10_000, turnover: 2, maxDrawdown: 0.1,
    sharpe: 1.5, sortino: 2, profitFactor: 1.4, trades: 20,
  };
}

function artifact(policy: StrategyPromotionPolicy = PROMOTION_POLICY) {
  const report = runWalkForward(CONFIG, COST, simulator, {
    paramGrid: [{ lookback: 20 }, { lookback: 40 }],
    clock: { nowISO: () => '2026-07-26T00:00:00.000Z', nowMs: () => 1 },
  });
  return createPromotionDecisionArtifact(report, policy);
}

function key(approverId: string, keyId = `${approverId}-key`) {
  const pair = generateKeyPairSync('ed25519');
  return {
    approverId, keyId, privateKey: pair.privateKey,
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function policy(keys: ReturnType<typeof key>[], overrides: Partial<PromotionApprovalPolicy> = {}): PromotionApprovalPolicy {
  return {
    minApprovals: 1,
    requiredApproverIds: [],
    maxAttestationAgeMs: 60 * 60 * 1000,
    trustedApprovers: keys.map(({ approverId, keyId, publicKeyPem }) => ({ approverId, keyId, publicKeyPem })),
    ...overrides,
  };
}

function statement(a: ReturnType<typeof artifact>, signer: ReturnType<typeof key>, overrides: Partial<PromotionApprovalStatement> = {}): PromotionApprovalStatement {
  return {
    approvalContractVersion: PROMOTION_APPROVAL_CONTRACT_VERSION,
    artifactId: a.artifactId,
    decisionId: a.decision.decisionId,
    approverId: signer.approverId,
    keyId: signer.keyId,
    issuedAt: '2026-07-26T11:55:00.000Z',
    expiresAt: '2026-07-26T13:00:00.000Z',
    ...overrides,
  };
}

function attest(a: ReturnType<typeof artifact>, signer: ReturnType<typeof key>, overrides: Partial<PromotionApprovalStatement> = {}): PromotionApprovalAttestation {
  const unsigned = statement(a, signer, overrides);
  return { ...unsigned, signature: sign(null, makePromotionApprovalSigningPayload(unsigned), signer.privateKey).toString('base64') };
}

function codes(result: ReturnType<typeof evaluatePromotionApprovals>): readonly string[] {
  return result.reasons.map(reason => reason.code);
}

test('1. valid detached Ed25519 approval passes', () => {
  const a = artifact(); const alice = key('alice');
  const result = evaluatePromotionApprovals(a, [attest(a, alice)], policy([alice]), NOW);
  assert.equal(result.status, 'approved');
  assert.deepStrictEqual(result.verifiedApproverIds, ['alice']);
  assert.deepStrictEqual(result.reasons, []);
});

test('2. explicit quorum and required approver are enforced', () => {
  const a = artifact(); const alice = key('alice'); const bob = key('bob');
  const p = policy([alice, bob], { minApprovals: 2, requiredApproverIds: ['bob'] });
  const one = evaluatePromotionApprovals(a, [attest(a, alice)], p, NOW);
  assert.deepStrictEqual(codes(one), [
    PROMOTION_APPROVAL_REASONS.REQUIRED_APPROVER_MISSING,
    PROMOTION_APPROVAL_REASONS.INSUFFICIENT_APPROVALS,
  ]);
  assert.equal(evaluatePromotionApprovals(a, [attest(a, bob), attest(a, alice)], p, NOW).status, 'approved');
});

test('3. untrusted approver rejects instead of being ignored', () => {
  const a = artifact(); const alice = key('alice'); const mallory = key('mallory');
  const result = evaluatePromotionApprovals(a, [attest(a, mallory)], policy([alice]), NOW);
  assert.deepStrictEqual(codes(result), [
    PROMOTION_APPROVAL_REASONS.UNTRUSTED_APPROVER,
    PROMOTION_APPROVAL_REASONS.INSUFFICIENT_APPROVALS,
  ]);
});

test('4. keyId is bound to exactly one approver identity', () => {
  const a = artifact(); const alice = key('alice');
  const forged = attest(a, { ...alice, approverId: 'mallory' });
  const result = evaluatePromotionApprovals(a, [forged], policy([alice]), NOW);
  assert.ok(codes(result).includes(PROMOTION_APPROVAL_REASONS.KEY_BINDING_MISMATCH));
});

test('5. changed signature payload rejects', () => {
  const a = artifact(); const alice = key('alice');
  const valid = attest(a, alice);
  const changed = { ...valid, expiresAt: '2026-07-26T13:00:01.000Z' };
  assert.ok(codes(evaluatePromotionApprovals(a, [changed], policy([alice]), NOW))
    .includes(PROMOTION_APPROVAL_REASONS.SIGNATURE_INVALID));
});

test('6. malformed signature encoding rejects', () => {
  const a = artifact(); const alice = key('alice');
  const malformed = { ...attest(a, alice), signature: 'not-base64' };
  assert.ok(codes(evaluatePromotionApprovals(a, [malformed], policy([alice]), NOW))
    .includes(PROMOTION_APPROVAL_REASONS.SIGNATURE_ENCODING_INVALID));
});

test('7. artifactId and decisionId bindings are independently enforced', () => {
  const a = artifact(); const alice = key('alice');
  const wrongArtifact = attest(a, alice, { artifactId: 'a'.repeat(64) });
  const wrongDecision = attest(a, alice, { decisionId: 'b'.repeat(64) });
  assert.ok(codes(evaluatePromotionApprovals(a, [wrongArtifact], policy([alice]), NOW))
    .includes(PROMOTION_APPROVAL_REASONS.ARTIFACT_BINDING_MISMATCH));
  assert.ok(codes(evaluatePromotionApprovals(a, [wrongDecision], policy([alice]), NOW))
    .includes(PROMOTION_APPROVAL_REASONS.DECISION_BINDING_MISMATCH));
});

test('8. future, expired, too-old, and malformed time windows reject', () => {
  const a = artifact(); const alice = key('alice'); const p = policy([alice], { maxAttestationAgeMs: 10 * 60 * 1000 });
  const cases: Array<[Partial<PromotionApprovalStatement>, string]> = [
    [{ issuedAt: '2026-07-26T12:01:00.000Z', expiresAt: '2026-07-26T13:00:00.000Z' }, PROMOTION_APPROVAL_REASONS.ATTESTATION_NOT_YET_VALID],
    [{ issuedAt: '2026-07-26T11:00:00.000Z', expiresAt: '2026-07-26T12:00:00.000Z' }, PROMOTION_APPROVAL_REASONS.ATTESTATION_EXPIRED],
    [{ issuedAt: '2026-07-26T11:49:59.999Z', expiresAt: '2026-07-26T13:00:00.000Z' }, PROMOTION_APPROVAL_REASONS.ATTESTATION_TOO_OLD],
    [{ issuedAt: 'bad-time' }, PROMOTION_APPROVAL_REASONS.TIMESTAMP_INVALID],
    [{ issuedAt: '2026-07-26 11:55:00Z' }, PROMOTION_APPROVAL_REASONS.TIMESTAMP_INVALID],
  ];
  for (const [overrides, expected] of cases) {
    assert.ok(codes(evaluatePromotionApprovals(a, [attest(a, alice, overrides)], p, NOW)).includes(expected));
  }
});

test('9. exact max-age boundary is valid; exact expiry boundary is not', () => {
  const a = artifact(); const alice = key('alice'); const p = policy([alice], { maxAttestationAgeMs: 300_000 });
  assert.equal(evaluatePromotionApprovals(a, [attest(a, alice)], p, NOW).status, 'approved');
  const expiresNow = attest(a, alice, { expiresAt: '2026-07-26T12:00:00.000Z' });
  assert.ok(codes(evaluatePromotionApprovals(a, [expiresNow], p, NOW)).includes(PROMOTION_APPROVAL_REASONS.ATTESTATION_EXPIRED));
});

test('10. duplicate approver attestations fail closed and never inflate quorum', () => {
  const a = artifact(); const alice = key('alice'); const bob = key('bob');
  const result = evaluatePromotionApprovals(a, [attest(a, alice), attest(a, alice)],
    policy([alice, bob], { minApprovals: 2 }), NOW);
  assert.ok(codes(result).includes(PROMOTION_APPROVAL_REASONS.DUPLICATE_APPROVER_ATTESTATION));
  assert.ok(codes(result).includes(PROMOTION_APPROVAL_REASONS.INSUFFICIENT_APPROVALS));
});

test('11. rejected Stage 4A5 decision can never be approved', () => {
  const a = artifact({ ...PROMOTION_POLICY, minFinalHoldoutSharpe: 99 }); const alice = key('alice');
  const result = evaluatePromotionApprovals(a, [attest(a, alice)], policy([alice]), NOW);
  assert.ok(codes(result).includes(PROMOTION_APPROVAL_REASONS.DECISION_NOT_PROMOTABLE));
});

test('12. tampered Stage 4A6 artifact fails closed before approval', () => {
  const a = artifact(); const alice = key('alice');
  const tampered = JSON.parse(JSON.stringify(a));
  tampered.report.finalHoldoutEvaluationCount = 0;
  const result = evaluatePromotionApprovals(tampered, [attest(a, alice)], policy([alice]), NOW);
  assert.ok(codes(result).includes(PROMOTION_APPROVAL_REASONS.ARTIFACT_INVALID));
  const nullArtifact = evaluatePromotionApprovals(null, [], policy([alice]), NOW);
  assert.ok(codes(nullArtifact).includes(PROMOTION_APPROVAL_REASONS.ARTIFACT_INVALID));
});

test('13. attestation contract version mismatch rejects', () => {
  const a = artifact(); const alice = key('alice');
  const changed = { ...attest(a, alice), approvalContractVersion: 'old' as typeof PROMOTION_APPROVAL_CONTRACT_VERSION };
  assert.ok(codes(evaluatePromotionApprovals(a, [changed], policy([alice]), NOW))
    .includes(PROMOTION_APPROVAL_REASONS.ATTESTATION_CONTRACT_MISMATCH));
});

test('14. malformed trust policies throw instead of weakening approval', () => {
  const alice = key('alice');
  assert.throws(() => evaluatePromotionApprovals(artifact(), [], policy([alice], { minApprovals: 0 }), NOW), /INVALID_PROMOTION_APPROVAL_POLICY:minApprovals/);
  assert.throws(() => evaluatePromotionApprovals(artifact(), [], policy([alice], { maxAttestationAgeMs: 0 }), NOW), /INVALID_PROMOTION_APPROVAL_POLICY:maxAttestationAgeMs/);
  assert.throws(() => evaluatePromotionApprovals(artifact(), [], policy([alice], { requiredApproverIds: ['unknown'] }), NOW), /INVALID_PROMOTION_APPROVAL_POLICY:requiredApproverIds/);
  assert.throws(() => evaluatePromotionApprovals(artifact(), [], policy([alice, { ...alice, approverId: 'bob' }]), NOW), /INVALID_PROMOTION_APPROVAL_POLICY:trustedApprovers/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.throws(() => evaluatePromotionApprovals(artifact(), [], { ...policy([alice]), trustedApprovers: [{ approverId: 'x', keyId: 'x', publicKeyPem: rsa }] }, NOW), /INVALID_PROMOTION_APPROVAL_POLICY:publicKeyType/);
  const privateKeyPem = alice.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => evaluatePromotionApprovals(artifact(), [], { ...policy([alice]), trustedApprovers: [{ approverId: 'alice', keyId: 'alice-key', publicKeyPem: privateKeyPem }] }, NOW), /INVALID_PROMOTION_APPROVAL_POLICY:publicKeyPem/);
});

test('15. result is deterministic, sorted, frozen, and does not freeze caller policy', () => {
  const a = artifact(); const alice = key('alice'); const bob = key('bob'); const p = policy([alice, bob], { minApprovals: 2 });
  const first = evaluatePromotionApprovals(a, [attest(a, bob), attest(a, alice)], p, NOW);
  const second = evaluatePromotionApprovals(a, [attest(a, alice), attest(a, bob)], p, NOW);
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(first.verifiedApproverIds, ['alice', 'bob']);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.verifiedApproverIds));
  assert.equal(Object.isFrozen(p), false);
  assert.equal(Object.isFrozen(p.trustedApprovers), false);
});

test('16. invalid explicit evaluation time throws', () => {
  const a = artifact(); const alice = key('alice');
  assert.throws(() => evaluatePromotionApprovals(a, [attest(a, alice)], policy([alice]), Number.NaN),
    /INVALID_PROMOTION_APPROVAL_TIME/);
  const malformed = evaluatePromotionApprovals(a, [null as unknown as PromotionApprovalAttestation], policy([alice]), NOW);
  assert.ok(codes(malformed).includes(PROMOTION_APPROVAL_REASONS.ATTESTATION_MALFORMED));
});
