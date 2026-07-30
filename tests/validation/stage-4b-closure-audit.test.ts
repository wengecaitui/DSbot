import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createStage4BClosureAudit,
  verifyStage4BClosureAudit,
  type Stage4BClosureAudit,
  type Stage4BClosureInputs,
} from '../../src/validation/Stage4BClosureAudit';

function raw(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8').replace(/\r\n/g, '\n');
}

function inputs(): Stage4BClosureInputs {
  return {
    sourceCommit: 'c'.repeat(40),
    targetBaselineCommit: 'df6df2ea537d86cc3ea31d9c58cdc37b73305496',
    stage4B1SubjectJson: raw('tests/fixtures/stage-4b-closure/stage-4b1-subject.json'),
    stage4B1ArtifactJson: raw('docs/releases/stage-4b1-activation-contract.json'),
    stage4B2ReceiptJson: raw('tests/fixtures/stage-4b-closure/stage-4b2-receipt.json'),
    stage4B3ReceiptJson: raw('tests/fixtures/stage-4b-closure/stage-4b3-receipt.json'),
    stage4B4ProofJson: raw('tests/fixtures/stage-4b-closure/stage-4b4-proof.json'),
    stage4B41MergeCommit: 'e6e21707a39ee8eb96a2b5ce4da916d3c900a6d0',
    stage4B42MergeCommit: '36195a6ddc4a757afdc28a23cdccb42653601368',
    stage4B43MergeCommit: 'df6df2ea537d86cc3ea31d9c58cdc37b73305496',
  };
}

function copy(audit: Stage4BClosureAudit): Record<string, unknown> {
  return JSON.parse(JSON.stringify(audit)) as Record<string, unknown>;
}

test('4B-CLOSURE: authoritative evidence closes only as blocked and inactive', () => {
  const evidence = inputs();
  const first = createStage4BClosureAudit(evidence);
  const second = createStage4BClosureAudit(evidence);
  assert.deepEqual(first, second);
  assert.equal(first.stage, 'STAGE 4B');
  assert.equal(first.status, 'CLOSED_BLOCKED_NO_PROMOTED_STRATEGY');
  assert.equal(first.promotedStrategies, 0);
  assert.equal(first.runtimeStarted, false);
  assert.equal(first.paperApproved, false);
  assert.equal(first.testnetApproved, false);
  assert.equal(first.liveApproved, false);
  assert.equal(first.liveExecutionChanges, false);
  assert.equal(first.stage4B2.status, 'BLOCKED_NO_ACTIVATION_REVIEW_READY_STRATEGY');
  assert.equal(first.stage4B4.runtimeState, 'STOPPED');
  assert.equal(first.stage4B4.zeroAdapterCalls, 0);
  assert.match(first.closureId, /^[a-f0-9]{64}$/);
  assert.equal(verifyStage4BClosureAudit(first, evidence)?.closureId, first.closureId);
});

test('4B-CLOSURE: every raw evidence byte stream is bound', () => {
  const base = inputs();
  for (const key of [
    'stage4B1SubjectJson', 'stage4B1ArtifactJson', 'stage4B2ReceiptJson',
    'stage4B3ReceiptJson', 'stage4B4ProofJson',
  ] as const) {
    assert.throws(() => createStage4BClosureAudit({ ...base, [key]: `${base[key]} ` }), undefined, key);
  }
});

test('4B-CLOSURE: merge lineage and target baseline cannot be replaced by new IDs', () => {
  const base = inputs();
  for (const key of [
    'targetBaselineCommit', 'stage4B41MergeCommit', 'stage4B42MergeCommit',
    'stage4B43MergeCommit',
  ] as const) {
    assert.throws(() => createStage4BClosureAudit({ ...base, [key]: 'd'.repeat(40) }), undefined, key);
  }
  const audit = createStage4BClosureAudit(base);
  const newSource = { ...base, sourceCommit: 'e'.repeat(40) };
  assert.notEqual(createStage4BClosureAudit(newSource).closureId, audit.closureId);
  assert.equal(verifyStage4BClosureAudit(audit, newSource), null);
});

test('4B-CLOSURE: approval, runtime, evidence, ID, commit and extra-field tampering rejects', () => {
  const evidence = inputs();
  const audit = createStage4BClosureAudit(evidence);
  const mutations: Array<(value: Record<string, unknown>) => void> = [
    value => { value.paperApproved = true; },
    value => { value.testnetApproved = true; },
    value => { value.liveApproved = true; },
    value => { value.runtimeStarted = true; },
    value => { value.liveExecutionChanges = true; },
    value => { value.promotedStrategies = 1; },
    value => { value.status = 'CLOSED'; },
    value => { value.closureId = 'f'.repeat(64); },
    value => { (value.stage4B1 as Record<string, unknown>).artifactId = 'f'.repeat(64); },
    value => { (value.stage4B2 as Record<string, unknown>).receiptId = 'f'.repeat(64); },
    value => { (value.stage4B3 as Record<string, unknown>).rawSha256 = 'f'.repeat(64); },
    value => { (value.stage4B4 as Record<string, unknown>).proofId = `srp-${'f'.repeat(64)}`; },
    value => { (value.stage4B4 as Record<string, unknown>).runtimeState = 'SHADOW_ACTIVE'; },
    value => { value.unexpected = true; },
  ];
  for (const mutate of mutations) {
    const candidate = copy(audit);
    mutate(candidate);
    assert.equal(verifyStage4BClosureAudit(candidate, evidence), null);
  }
});

test('4B-CLOSURE: accessors never execute and proxy ordinary get trap is unused', () => {
  const evidence = inputs();
  const audit = createStage4BClosureAudit(evidence);
  let getterCalls = 0;
  const accessor = copy(audit);
  Object.defineProperty(accessor, 'closureId', {
    enumerable: true,
    get() { getterCalls++; return audit.closureId; },
  });
  assert.equal(verifyStage4BClosureAudit(accessor, evidence), null);
  assert.equal(getterCalls, 0);

  let ordinaryGets = 0;
  const proxy = new Proxy(copy(audit), {
    get(target, property, receiver) {
      ordinaryGets++;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.ok(verifyStage4BClosureAudit(proxy, evidence));
  assert.equal(ordinaryGets, 0);
});

test('4B-CLOSURE: verifier returns independent deeply frozen data without freezing caller', () => {
  const evidence = inputs();
  const audit = createStage4BClosureAudit(evidence);
  const caller = copy(audit);
  const verified = verifyStage4BClosureAudit(caller, evidence);
  assert.ok(verified);
  assert.notEqual(verified, caller);
  assert.equal(Object.isFrozen(caller), false);
  assert.equal(Object.isFrozen(caller.stage4B4 as object), false);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.stage4B1), true);
  assert.equal(Object.isFrozen(verified.stage4B2), true);
  assert.equal(Object.isFrozen(verified.stage4B3), true);
  assert.equal(Object.isFrozen(verified.stage4B4), true);
});
