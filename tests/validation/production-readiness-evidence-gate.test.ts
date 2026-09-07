import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  evaluateProductionReadinessEvidence,
  type ProductionReadinessEvidenceInput,
  type ProductionReadinessEvidenceObservation,
} from '../../src/validation/ProductionReadinessEvidenceGate';

const HEAD = 'f03629c33c4d867578f144889a7d09b73c29c8aa';
const EVALUATION_TIME = '2026-09-07T12:00:00.000Z';
const COMPLETED_AT = '2026-09-07T11:00:00.000Z';
const VALID_UNTIL = '2026-09-08T11:00:00.000Z';
const DIGEST = 'a'.repeat(64);

function evidence(
  exceptions: readonly { readonly advisoryId: string; readonly package: string; readonly expiresAt: string }[] = [],
): ProductionReadinessEvidenceObservation[] {
  const common = {
    headSha: HEAD,
    runId: 1001,
    status: 'COMPLETED' as const,
    conclusion: 'SUCCESS' as const,
    completedAt: COMPLETED_AT,
    validUntil: VALID_UNTIL,
  };
  return [
    { ...common, family: 'CI', workflow: '.github/workflows/ci.yml' },
    { ...common, family: 'SECURITY', workflow: '.github/workflows/security.yml', exceptions },
    { ...common, family: 'REFERENCE_INFRASTRUCTURE_PROOF', workflow: '.github/workflows/reference-infrastructure-proof.yml', artifactContract: '4A8-R1', artifactSha256: DIGEST },
    { ...common, family: 'INDICATOR_ASSET_READINESS_PROOF', workflow: '.github/workflows/indicator-asset-readiness.yml', artifactContract: 'stage-4a9.asset-readiness.v1', artifactSha256: DIGEST },
    { ...common, family: 'STAGE_4B2_PAPER_READINESS_RECEIPT', workflow: '.github/workflows/stage-4b2-receipt.yml', artifactContract: 'stage-4b2.paper-readiness-receipt.v1', artifactSha256: DIGEST },
    { ...common, family: 'STAGE_4B3_SAFETY_RECEIPT', workflow: '.github/workflows/stage-4b3-receipt.yml', artifactContract: 'stage-4b3.safety-receipt.v1', artifactSha256: DIGEST },
    { ...common, family: 'STAGE_4B4_SHADOW_RUNTIME_PROOF', workflow: '.github/workflows/stage-4b4-shadow-proof.yml', artifactContract: 'cloddsbot.shadow.runtime-proof.v1', artifactSha256: DIGEST },
  ];
}

function input(items = evidence()): ProductionReadinessEvidenceInput {
  return { candidateHead: HEAD, evaluationTime: EVALUATION_TIME, evidence: items };
}

test('PHASE10: complete exact-head evidence permits only an activation decision review', () => {
  const result = evaluateProductionReadinessEvidence(input());
  assert.equal(result.state, 'READY_FOR_ACTIVATION_DECISION');
  assert.equal(result.evidenceValid, true);
  assert.equal(result.activationDecisionEligible, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.productionAuthority, false);
  assert.equal(result.testnetAuthority, false);
  assert.equal(result.liveAuthority, false);
  assert.equal(JSON.stringify(result).includes('PRODUCTION_READY'), false);
});

test('PHASE10: current stream-json exception is an active activation blocker', () => {
  const current = [{ advisoryId: 'GHSA-528h-pc64-c93x', package: 'stream-json', expiresAt: '2026-09-11' }];
  const result = evaluateProductionReadinessEvidence(input(evidence(current)));
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.evidenceValid, true);
  assert.equal(result.activationDecisionEligible, false);
  assert.deepEqual(result.blockers, ['SECURITY_EXCEPTION_ACTIVE:GHSA-528h-pc64-c93x']);
});

test('PHASE10: an expired exception remains an activation blocker', () => {
  const expired = [{ advisoryId: 'GHSA-528h-pc64-c93x', package: 'stream-json', expiresAt: '2026-09-07' }];
  const result = evaluateProductionReadinessEvidence(input(evidence(expired)));
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.evidenceValid, true);
  assert.deepEqual(result.blockers, ['SECURITY_EXCEPTION_EXPIRED:GHSA-528h-pc64-c93x']);
});

test('PHASE10: missing required evidence fails closed', () => {
  const withoutPaperReceipt = evidence().filter(
    item => item.family !== 'STAGE_4B2_PAPER_READINESS_RECEIPT',
  );
  const result = evaluateProductionReadinessEvidence(input(withoutPaperReceipt));
  assert.equal(result.state, 'EVIDENCE_INVALID');
  assert.equal(result.evidenceValid, false);
  assert.ok(result.blockers.includes('MISSING_EVIDENCE:STAGE_4B2_PAPER_READINESS_RECEIPT'));
});

test('PHASE10: failed and unknown workflow observations fail closed', () => {
  for (const { index, patch } of [
    { index: 4, patch: { conclusion: 'FAILURE' } },
    { index: 5, patch: { conclusion: 'UNKNOWN' } },
    { index: 6, patch: { status: 'UNKNOWN' } },
  ] as const) {
    const items = evidence() as unknown as Record<string, unknown>[];
    items[index] = { ...items[index], ...patch };
    const result = evaluateProductionReadinessEvidence(input(items as unknown as ProductionReadinessEvidenceObservation[]));
    assert.equal(result.state, 'EVIDENCE_INVALID');
    assert.equal(result.activationDecisionEligible, false);
  }
});

test('PHASE10: stale and future observations fail closed at explicit evaluation time', () => {
  const stale = evidence() as unknown as Record<string, unknown>[];
  stale[0] = { ...stale[0], validUntil: EVALUATION_TIME };
  assert.ok(evaluateProductionReadinessEvidence(input(stale as unknown as ProductionReadinessEvidenceObservation[])).blockers.includes('EVIDENCE_STALE:CI'));

  const future = evidence() as unknown as Record<string, unknown>[];
  future[0] = { ...future[0], completedAt: '2026-09-07T13:00:00.000Z' };
  assert.ok(evaluateProductionReadinessEvidence(input(future as unknown as ProductionReadinessEvidenceObservation[])).blockers.includes('EVIDENCE_NOT_YET_OBSERVED:CI'));

  const callerExtended = evidence() as unknown as Record<string, unknown>[];
  callerExtended[0] = {
    ...callerExtended[0],
    completedAt: '2026-09-06T11:59:59.999Z',
    validUntil: '2026-09-09T11:00:00.000Z',
  };
  const extendedResult = evaluateProductionReadinessEvidence(input(callerExtended as unknown as ProductionReadinessEvidenceObservation[]));
  assert.equal(extendedResult.state, 'EVIDENCE_INVALID');
  assert.ok(extendedResult.blockers.includes('EVIDENCE_TIME_INVALID:CI'));
  assert.ok(extendedResult.blockers.includes('EVIDENCE_STALE:CI'));
});

test('PHASE10: mixed and malformed candidate heads fail closed', () => {
  const mixed = evidence() as unknown as Record<string, unknown>[];
  mixed[2] = { ...mixed[2], headSha: 'b'.repeat(40) };
  assert.ok(evaluateProductionReadinessEvidence(input(mixed as unknown as ProductionReadinessEvidenceObservation[])).blockers.includes('EVIDENCE_HEAD_MISMATCH:REFERENCE_INFRASTRUCTURE_PROOF'));

  const malformedObservation = evidence() as unknown as Record<string, unknown>[];
  malformedObservation[2] = { ...malformedObservation[2], headSha: 'current' };
  assert.ok(evaluateProductionReadinessEvidence(input(malformedObservation as unknown as ProductionReadinessEvidenceObservation[])).blockers.includes('EVIDENCE_HEAD_INVALID:REFERENCE_INFRASTRUCTURE_PROOF'));

  const malformed = { ...input(), candidateHead: 'latest' };
  const result = evaluateProductionReadinessEvidence(malformed);
  assert.equal(result.state, 'EVIDENCE_INVALID');
  assert.ok(result.blockers.includes('CANDIDATE_HEAD_INVALID'));
});

test('PHASE10: duplicate and conflicting observations fail closed', () => {
  const duplicate = [...evidence(), { ...evidence()[4] }];
  const duplicateResult = evaluateProductionReadinessEvidence(input(duplicate));
  assert.ok(duplicateResult.blockers.includes('DUPLICATE_EVIDENCE:STAGE_4B2_PAPER_READINESS_RECEIPT'));

  const conflicting = [...evidence(), { ...evidence()[5], conclusion: 'FAILURE' as const }];
  const conflictingResult = evaluateProductionReadinessEvidence(input(conflicting));
  assert.equal(conflictingResult.state, 'EVIDENCE_INVALID');
  assert.ok(conflictingResult.blockers.includes('DUPLICATE_EVIDENCE:STAGE_4B3_SAFETY_RECEIPT'));
  assert.ok(conflictingResult.blockers.includes('EVIDENCE_CONCLUSION_FAILED:STAGE_4B3_SAFETY_RECEIPT'));
});

test('PHASE10: workflow and existing artifact contract identities are required', () => {
  const wrongWorkflow = evidence() as unknown as Record<string, unknown>[];
  wrongWorkflow[0] = { ...wrongWorkflow[0], workflow: '.github/workflows/other.yml' };
  assert.ok(evaluateProductionReadinessEvidence(input(wrongWorkflow as unknown as ProductionReadinessEvidenceObservation[])).blockers.includes('EVIDENCE_WORKFLOW_MISMATCH:CI'));

  const wrongContract = evidence() as unknown as Record<string, unknown>[];
  wrongContract[2] = { ...wrongContract[2], artifactContract: 'phase-10.new-proof.v1' };
  assert.ok(evaluateProductionReadinessEvidence(input(wrongContract as unknown as ProductionReadinessEvidenceObservation[])).blockers.includes('EVIDENCE_CONTRACT_MISMATCH:REFERENCE_INFRASTRUCTURE_PROOF'));
});

test('PHASE10: convenience authority flags are rejected as unknown input shape', () => {
  const callerFlag = { ...input(), productionReady: true } as unknown as ProductionReadinessEvidenceInput;
  const result = evaluateProductionReadinessEvidence(callerFlag);
  assert.equal(result.state, 'EVIDENCE_INVALID');
  assert.ok(result.blockers.includes('EVIDENCE_INPUT_SHAPE_INVALID'));
});

test('PHASE10: known P2 debt remains warning-only', () => {
  const result = evaluateProductionReadinessEvidence(input());
  assert.deepEqual(result.warnings, [
    'INT64_JS_SAFE_INTEGER_LIMITATION',
    'PYTHON_BRIDGE_PARALLEL_STARTUP_TIMING_INSTABILITY',
  ]);
  assert.equal(result.evidenceValid, true);
});

test('PHASE10: result is independent of evidence input order', () => {
  const forward = evaluateProductionReadinessEvidence(input(evidence()));
  const reverse = evaluateProductionReadinessEvidence(input(evidence().reverse()));
  assert.deepEqual(reverse, forward);
});

test('PHASE10: output is deeply frozen and detached from mutable input', () => {
  const caller = input(evidence());
  const result = evaluateProductionReadinessEvidence(caller);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.blockers), true);
  assert.equal(Object.isFrozen(result.warnings), true);
  (caller.evidence as ProductionReadinessEvidenceObservation[]).pop();
  assert.equal(result.state, 'READY_FOR_ACTIVATION_DECISION');
  assert.throws(() => (result.warnings as string[]).push('CHANGED'));
});

test('PHASE10: accessors are rejected without execution', () => {
  let calls = 0;
  const caller = input();
  Object.defineProperty(caller, 'evaluationTime', {
    enumerable: true,
    get() { calls++; return EVALUATION_TIME; },
  });
  const result = evaluateProductionReadinessEvidence(caller);
  assert.equal(result.state, 'EVIDENCE_INVALID');
  assert.equal(calls, 0);
});

test('PHASE10: aggregation module contains no I/O, proof generation, or runtime authority', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/validation/ProductionReadinessEvidenceGate.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"]node:(?:fs|http|https|net|child_process)['"]/);
  assert.doesNotMatch(source, /createHash|canonicalSerialize|proofIdOf|receiptIdOf/);
  assert.doesNotMatch(source, /from ['"]\.\.\/(?:oms|risk|runtime|position|research)\//);
});
