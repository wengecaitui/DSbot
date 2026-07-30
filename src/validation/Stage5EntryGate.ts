/**
 * Stage 5 entry gate. Entry is recorded, but activation remains fail-closed.
 * No Paper, Testnet, or Live runtime is authorized by this module.
 */
import * as crypto from 'node:crypto';
import { canonicalSerialize } from '../shadow/CanonicalJson';

export const STAGE_5_ENTRY_SCHEMA_VERSION = 'stage-5.entry-gate.v1' as const;

const DOMAIN = 'CLODDSBOT_STAGE_5_ENTRY_GATE\u0000v1\u0000';
const GIT_SHA = /^[a-f0-9]{40}$/;
const TRUST = Object.freeze({
  closureMergeCommit: 'fcc3a1a24fb7fc07b91878b27bddf9465da6334d',
  closureRawSha256: 'bae5d1d45d2d3d550efec9e18be813c054f98dc32d7b6ebab7d53e0ab094844a',
  closureSourceCommit: 'c33d56d8e295dc064fa971cfa2128aaac41705da',
  closureId: '345432934555e1935388eb2193f6ef365e7f924fba5a668e399ca3f1db72705a',
  closureTargetBaseline: 'df6df2ea537d86cc3ea31d9c58cdc37b73305496',
});

export interface Stage5EntryInputs {
  readonly sourceCommit: string;
  readonly stage4BClosureMergeCommit: string;
  readonly stage4BClosureJson: string;
}

export interface Stage5EntryGate {
  readonly schemaVersion: typeof STAGE_5_ENTRY_SCHEMA_VERSION;
  readonly stage: 'STAGE 5';
  readonly status: 'BLOCKED_NO_PROMOTED_STRATEGY';
  readonly sourceCommit: string;
  readonly stage4BClosure: {
    readonly mergeCommit: string;
    readonly sourceCommit: string;
    readonly rawSha256: string;
    readonly closureId: string;
  };
  readonly stage5Entered: true;
  readonly entryAuthorized: false;
  readonly activationAuthorized: false;
  readonly runtimeStarted: false;
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
  readonly requiredAction: 'FRESH_PROMOTION_AND_ACTIVATION_CHAIN_REQUIRED';
  readonly gateId: string;
}

type GateWithoutId = Omit<Stage5EntryGate, 'gateId'>;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: trust-root mismatch`);
}

function parseClosure(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error('closure evidence must be a string');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('closure evidence is invalid JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('closure evidence must be an object');
  }
  return parsed as Record<string, unknown>;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
}

function derive(inputs: Stage5EntryInputs): Stage5EntryGate {
  if (!GIT_SHA.test(inputs.sourceCommit)) throw new Error('sourceCommit: invalid Git SHA');
  equal(inputs.stage4BClosureMergeCommit, TRUST.closureMergeCommit, 'closure merge commit');
  equal(sha256(inputs.stage4BClosureJson), TRUST.closureRawSha256, 'closure raw SHA-256');

  const closure = parseClosure(inputs.stage4BClosureJson);
  equal(closure.schemaVersion, 'stage-4b.closure-audit.v1', 'closure schema');
  equal(closure.status, 'CLOSED_BLOCKED_NO_PROMOTED_STRATEGY', 'closure status');
  equal(closure.sourceCommit, TRUST.closureSourceCommit, 'closure source commit');
  equal(closure.targetBaselineCommit, TRUST.closureTargetBaseline, 'closure target baseline');
  equal(closure.closureId, TRUST.closureId, 'closure ID');
  equal(closure.promotedStrategies, 0, 'promoted strategies');
  equal(closure.runtimeStarted, false, 'closure runtimeStarted');
  equal(closure.paperApproved, false, 'closure paperApproved');
  equal(closure.testnetApproved, false, 'closure testnetApproved');
  equal(closure.liveApproved, false, 'closure liveApproved');
  equal(closure.liveExecutionChanges, false, 'closure liveExecutionChanges');
  const shadow = closure.stage4B4 as Record<string, unknown> | undefined;
  equal(shadow?.runtimeState, 'STOPPED', 'closure shadow runtime state');
  equal(shadow?.zeroAdapterCalls, 0, 'closure shadow adapter calls');

  const withoutId: GateWithoutId = {
    schemaVersion: STAGE_5_ENTRY_SCHEMA_VERSION,
    stage: 'STAGE 5',
    status: 'BLOCKED_NO_PROMOTED_STRATEGY',
    sourceCommit: inputs.sourceCommit,
    stage4BClosure: {
      mergeCommit: TRUST.closureMergeCommit,
      sourceCommit: TRUST.closureSourceCommit,
      rawSha256: TRUST.closureRawSha256,
      closureId: TRUST.closureId,
    },
    stage5Entered: true,
    entryAuthorized: false,
    activationAuthorized: false,
    runtimeStarted: false,
    paperApproved: false,
    testnetApproved: false,
    liveApproved: false,
    requiredAction: 'FRESH_PROMOTION_AND_ACTIVATION_CHAIN_REQUIRED',
  };
  const gate: Stage5EntryGate = {
    ...withoutId,
    gateId: sha256(DOMAIN + canonicalSerialize(withoutId)),
  };
  deepFreeze(gate);
  return gate;
}

function cloneWithoutGetters(value: unknown, path = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new Error('unsupported value');
  const object = value as object;
  if (path.has(object)) throw new Error('cycle');
  path.add(object);
  try {
    if (Object.getOwnPropertySymbols(object).length !== 0) throw new Error('symbol key');
    const descriptors = Object.getOwnPropertyDescriptors(object) as Record<string, PropertyDescriptor>;
    if (Array.isArray(object)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid array');
      if (Object.getOwnPropertyNames(object).length !== length + 1) throw new Error('sparse array');
      const array: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined ||
            descriptor.enumerable !== true) throw new Error('invalid array property');
        array.push(cloneWithoutGetters(descriptor.value, path));
      }
      return array;
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) throw new Error('non-plain object');
    const result: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(object)) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined ||
          descriptor.enumerable !== true) throw new Error('invalid property');
      result[key] = cloneWithoutGetters(descriptor.value, path);
    }
    return result;
  } finally {
    path.delete(object);
  }
}

export function createStage5EntryGate(inputs: Stage5EntryInputs): Stage5EntryGate {
  return derive(inputs);
}

export function verifyStage5EntryGate(
  artifact: unknown,
  inputs: Stage5EntryInputs,
): Stage5EntryGate | null {
  try {
    const expected = derive(inputs);
    if (canonicalSerialize(cloneWithoutGetters(artifact)) !== canonicalSerialize(expected)) return null;
    return expected;
  } catch {
    return null;
  }
}
