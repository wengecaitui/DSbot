import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createStage5EntryGate,
  verifyStage5EntryGate,
  type Stage5EntryGate,
  type Stage5EntryInputs,
} from '../../src/validation/Stage5EntryGate';

function inputs(): Stage5EntryInputs {
  return {
    sourceCommit: 'd'.repeat(40),
    stage4BClosureMergeCommit: 'fcc3a1a24fb7fc07b91878b27bddf9465da6334d',
    stage4BClosureJson: fs.readFileSync(
      path.resolve(process.cwd(), 'tests/fixtures/stage-5-entry/stage-4b-closure-audit.json'),
      'utf8',
    ).replace(/\r\n/g, '\n'),
  };
}

function copy(gate: Stage5EntryGate): Record<string, unknown> {
  return JSON.parse(JSON.stringify(gate)) as Record<string, unknown>;
}

test('STAGE5: authoritative blocked closure permits entry record but forbids activation', () => {
  const evidence = inputs();
  const first = createStage5EntryGate(evidence);
  const second = createStage5EntryGate(evidence);
  assert.deepEqual(first, second);
  assert.equal(first.stage, 'STAGE 5');
  assert.equal(first.status, 'BLOCKED_NO_PROMOTED_STRATEGY');
  assert.equal(first.stage5Entered, true);
  assert.equal(first.entryAuthorized, false);
  assert.equal(first.activationAuthorized, false);
  assert.equal(first.runtimeStarted, false);
  assert.equal(first.paperApproved, false);
  assert.equal(first.testnetApproved, false);
  assert.equal(first.liveApproved, false);
  assert.equal(first.requiredAction, 'FRESH_PROMOTION_AND_ACTIVATION_CHAIN_REQUIRED');
  assert.match(first.gateId, /^[a-f0-9]{64}$/);
  assert.equal(verifyStage5EntryGate(first, evidence)?.gateId, first.gateId);
});

test('STAGE5: closure raw bytes, closure merge and source commit are bound', () => {
  const evidence = inputs();
  const gate = createStage5EntryGate(evidence);
  assert.throws(() => createStage5EntryGate({
    ...evidence,
    stage4BClosureJson: `${evidence.stage4BClosureJson} `,
  }));
  assert.throws(() => createStage5EntryGate({
    ...evidence,
    stage4BClosureMergeCommit: 'e'.repeat(40),
  }));
  const newSource = { ...evidence, sourceCommit: 'f'.repeat(40) };
  assert.notEqual(createStage5EntryGate(newSource).gateId, gate.gateId);
  assert.equal(verifyStage5EntryGate(gate, newSource), null);
});

test('STAGE5: approval, authorization, runtime, status and self-consistent ID tamper reject', () => {
  const evidence = inputs();
  const gate = createStage5EntryGate(evidence);
  const mutations: Array<(value: Record<string, unknown>) => void> = [
    value => { value.entryAuthorized = true; },
    value => { value.activationAuthorized = true; },
    value => { value.runtimeStarted = true; },
    value => { value.paperApproved = true; },
    value => { value.testnetApproved = true; },
    value => { value.liveApproved = true; },
    value => { value.stage5Entered = false; },
    value => { value.status = 'ACTIVE'; },
    value => { value.requiredAction = 'NONE'; },
    value => { value.gateId = 'f'.repeat(64); },
    value => { (value.stage4BClosure as Record<string, unknown>).closureId = 'f'.repeat(64); },
    value => { (value.stage4BClosure as Record<string, unknown>).mergeCommit = 'f'.repeat(40); },
    value => { value.version = 2; },
  ];
  for (const mutate of mutations) {
    const candidate = copy(gate);
    mutate(candidate);
    assert.equal(verifyStage5EntryGate(candidate, evidence), null);
  }
});

test('STAGE5: changing identity or version cannot reset the blocked closure state', () => {
  const evidence = inputs();
  const gate = createStage5EntryGate(evidence);
  const cloned = copy(gate);
  cloned.sourceCommit = 'a'.repeat(40);
  cloned.gateId = 'a'.repeat(64);
  assert.equal(verifyStage5EntryGate(cloned, evidence), null);
  const missing = copy(gate);
  delete missing.activationAuthorized;
  assert.equal(verifyStage5EntryGate(missing, evidence), null);
});

test('STAGE5: accessors never execute and ordinary proxy get trap is unused', () => {
  const evidence = inputs();
  const gate = createStage5EntryGate(evidence);
  let getterCalls = 0;
  const accessor = copy(gate);
  Object.defineProperty(accessor, 'gateId', {
    enumerable: true,
    get() { getterCalls++; return gate.gateId; },
  });
  assert.equal(verifyStage5EntryGate(accessor, evidence), null);
  assert.equal(getterCalls, 0);

  let ordinaryGets = 0;
  const proxy = new Proxy(copy(gate), {
    get(target, property, receiver) {
      ordinaryGets++;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.ok(verifyStage5EntryGate(proxy, evidence));
  assert.equal(ordinaryGets, 0);
});

test('STAGE5: verified result is independent/deep-frozen and caller remains mutable', () => {
  const evidence = inputs();
  const gate = createStage5EntryGate(evidence);
  const caller = copy(gate);
  const verified = verifyStage5EntryGate(caller, evidence);
  assert.ok(verified);
  assert.notEqual(verified, caller);
  assert.equal(Object.isFrozen(caller), false);
  assert.equal(Object.isFrozen(caller.stage4BClosure as object), false);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.stage4BClosure), true);
});
