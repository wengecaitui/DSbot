import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_PROOF_CLASSIFICATION,
  createReferenceInfrastructureProof,
  verifyReferenceInfrastructureProof,
} from '../../src/validation/ReferenceInfrastructureProof';

const INPUT = {
  repository: 'wengecaitui/DSbot',
  sourceCommit: 'a'.repeat(40),
  workflow: '.github/workflows/reference-infrastructure-proof.yml',
  simulatorSourceSha256: 'b'.repeat(64),
};

function proof() {
  return createReferenceInfrastructureProof(INPUT);
}

test('reference proof is deterministic, classified, non-zero, and fully recomputable', () => {
  const first = proof();
  const second = proof();
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(first.classification, REFERENCE_PROOF_CLASSIFICATION);
  assert.ok((first.promotionArtifact.report.finalHoldoutMetrics?.tradeCount ?? 0) > 0);
  assert.equal(verifyReferenceInfrastructureProof(first, {
    expectedRepository: INPUT.repository,
    expectedSourceCommit: INPUT.sourceCommit,
    expectedWorkflow: INPUT.workflow,
    expectedSimulatorSourceSha256: INPUT.simulatorSourceSha256,
  }).proofId, first.proofId);
});

test('commit, dataset, configuration, simulator, ledger and output bindings fail closed', () => {
  const mutations: Array<(value: any) => void> = [
    value => { value.source.commit = 'c'.repeat(40); },
    value => { value.dataset.sha256 = 'c'.repeat(64); },
    value => { value.configuration.value.cost.feeBps += 1; },
    value => { value.simulator.version = 'changed'; },
    value => { value.ledger.calls += 1; },
    value => { value.promotionArtifact.report.finalHoldoutMetrics.netReturn += 1; },
    value => { value.proofId = 'c'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const changed: any = structuredClone(proof());
    mutate(changed);
    assert.throws(() => verifyReferenceInfrastructureProof(changed, {
      expectedSourceCommit: INPUT.sourceCommit,
      expectedSimulatorSourceSha256: INPUT.simulatorSourceSha256,
    }), /REFERENCE_PROOF_INVALID/);
  }
});

test('caller input is not frozen and malformed identity fails closed', () => {
  const input = { ...INPUT };
  createReferenceInfrastructureProof(input);
  assert.equal(Object.isFrozen(input), false);
  assert.throws(() => createReferenceInfrastructureProof({ ...INPUT, sourceCommit: 'not-a-sha' }),
    /REFERENCE_PROOF_INVALID:SOURCE_COMMIT/);
  assert.throws(() => createReferenceInfrastructureProof({ ...INPUT, simulatorSourceSha256: 'bad' }),
    /REFERENCE_PROOF_INVALID:SIMULATOR_SOURCE_SHA256/);
});
