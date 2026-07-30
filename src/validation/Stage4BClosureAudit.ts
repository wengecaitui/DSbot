/**
 * Deterministic Stage 4B evidence-chain closure.
 *
 * This audit closes an offline, blocked readiness chain. It does not approve or
 * start Paper, Testnet, or Live trading.
 */
import * as crypto from 'node:crypto';
import { canonicalSerialize } from '../shadow/CanonicalJson';

export const STAGE_4B_CLOSURE_SCHEMA_VERSION = 'stage-4b.closure-audit.v1' as const;

const GIT_SHA = /^[a-f0-9]{40}$/;
const DOMAIN = 'CLODDSBOT_STAGE_4B_CLOSURE_AUDIT\u0000v1\u0000';

const AUTHORITATIVE = Object.freeze({
  stage4B1ReceiptCommit: 'eee580cb7a25f67cb65aecd9a0a82f71b4921121',
  stage4B1SubjectSha256: '0ecc172079eb5a78f1733ccf9a332a188ba5f55ecd13586970450a25cafd8fb5',
  stage4B1ArtifactSha256: '4d474f9d357fa6fb7d584576a891c5916f4f7ca4166d82027dba8fb29947d4aa',
  stage4B1ArtifactId: 'f320f0e51ef6c0900a189dd7455d0c3ee77726bb4c6d1820d422d725629bf52e',
  stage4B1ProofId: '7d35edaa205593ad07ccb8b254a67acad09511118939817e649166028535f1fb',
  stage4B1DecisionId: '80268cc673363290bea5f65aec0e7811041ecd6c608e06d6944aecfe5c2c39aa',
  stage4B2SourceCommit: '81b0980f4fee168075a52c6ebcb12eb50f382217',
  stage4B2Sha256: '5fefa5c1ddb025c94300e8b7dcb3b6d9dd5ba2e36a6d70e2ec10554d1d6a2453',
  stage4B2ReceiptId: '64b15a8acef9b1ba6f16ff87f81d27fcf28fbf6b94424d059521a20702165785',
  stage4B3SourceCommit: 'e6bc1852f55d71fd897a513bb533085596a1a480',
  stage4B3Sha256: '2e339f3fa9a8e02c7a0219248d54bcf5844591d20b35c8ffc24ed02777f9c55b',
  stage4B3ReceiptId: '18a7e928015ded178e5b48beaefff8cc29945e8e1d8329c4c03c58148a07ffa2',
  stage4B4ProofSourceCommit: '9e0d9dafeead4ee22f38ae9e1f964cb15855da27',
  stage4B4Sha256: 'aa9b5e4715d9a3e9ba16dbed8a3bf77d11016b5c53f4bc12cc51d117ce2693c0',
  stage4B4ProofId: 'srp-3c1d24416252eefce4e7b6f43fdc5b79419a8a0970a8428f5c3f0877af8f46be',
  stage4B41MergeCommit: 'e6e21707a39ee8eb96a2b5ce4da916d3c900a6d0',
  stage4B42MergeCommit: '36195a6ddc4a757afdc28a23cdccb42653601368',
  stage4B43MergeCommit: 'df6df2ea537d86cc3ea31d9c58cdc37b73305496',
});

export interface Stage4BClosureInputs {
  readonly sourceCommit: string;
  readonly targetBaselineCommit: string;
  readonly stage4B1SubjectJson: string;
  readonly stage4B1ArtifactJson: string;
  readonly stage4B2ReceiptJson: string;
  readonly stage4B3ReceiptJson: string;
  readonly stage4B4ProofJson: string;
  readonly stage4B41MergeCommit: string;
  readonly stage4B42MergeCommit: string;
  readonly stage4B43MergeCommit: string;
}

export interface Stage4BClosureAudit {
  readonly schemaVersion: typeof STAGE_4B_CLOSURE_SCHEMA_VERSION;
  readonly stage: 'STAGE 4B';
  readonly status: 'CLOSED_BLOCKED_NO_PROMOTED_STRATEGY';
  readonly sourceCommit: string;
  readonly targetBaselineCommit: string;
  readonly stage4B1: {
    readonly receiptCommit: string;
    readonly subjectSha256: string;
    readonly artifactSha256: string;
    readonly artifactId: string;
    readonly proofId: string;
    readonly decisionId: string;
  };
  readonly stage4B2: {
    readonly sourceCommit: string;
    readonly rawSha256: string;
    readonly receiptId: string;
    readonly status: 'BLOCKED_NO_ACTIVATION_REVIEW_READY_STRATEGY';
  };
  readonly stage4B3: {
    readonly sourceCommit: string;
    readonly rawSha256: string;
    readonly receiptId: string;
  };
  readonly stage4B4: {
    readonly stage4B41MergeCommit: string;
    readonly stage4B42MergeCommit: string;
    readonly stage4B43MergeCommit: string;
    readonly proofSourceCommit: string;
    readonly proofRawSha256: string;
    readonly proofId: string;
    readonly runtimeState: 'STOPPED';
    readonly zeroAdapterCalls: 0;
  };
  readonly promotedStrategies: 0;
  readonly runtimeStarted: false;
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
  readonly liveExecutionChanges: false;
  readonly closureId: string;
}

type AuditWithoutId = Omit<Stage4BClosureAudit, 'closureId'>;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseObject(raw: string, label: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error(`${label}: raw evidence must be a string`);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${label}: invalid JSON`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: evidence must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: authoritative binding mismatch`);
}

function requireApprovalsFalse(value: Record<string, unknown>, label: string): void {
  requireEqual(value.paperApproved, false, `${label}.paperApproved`);
  requireEqual(value.testnetApproved, false, `${label}.testnetApproved`);
  requireEqual(value.liveApproved, false, `${label}.liveApproved`);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
}

function derive(inputs: Stage4BClosureInputs): Stage4BClosureAudit {
  if (!GIT_SHA.test(inputs.sourceCommit)) throw new Error('sourceCommit: invalid Git SHA');
  if (!GIT_SHA.test(inputs.targetBaselineCommit)) throw new Error('targetBaselineCommit: invalid Git SHA');
  requireEqual(inputs.targetBaselineCommit, AUTHORITATIVE.stage4B43MergeCommit, 'targetBaselineCommit');
  requireEqual(inputs.stage4B41MergeCommit, AUTHORITATIVE.stage4B41MergeCommit, 'stage4B41MergeCommit');
  requireEqual(inputs.stage4B42MergeCommit, AUTHORITATIVE.stage4B42MergeCommit, 'stage4B42MergeCommit');
  requireEqual(inputs.stage4B43MergeCommit, AUTHORITATIVE.stage4B43MergeCommit, 'stage4B43MergeCommit');

  requireEqual(sha256(inputs.stage4B1SubjectJson), AUTHORITATIVE.stage4B1SubjectSha256, 'stage4B1SubjectSha256');
  requireEqual(sha256(inputs.stage4B1ArtifactJson), AUTHORITATIVE.stage4B1ArtifactSha256, 'stage4B1ArtifactSha256');
  requireEqual(sha256(inputs.stage4B2ReceiptJson), AUTHORITATIVE.stage4B2Sha256, 'stage4B2Sha256');
  requireEqual(sha256(inputs.stage4B3ReceiptJson), AUTHORITATIVE.stage4B3Sha256, 'stage4B3Sha256');
  requireEqual(sha256(inputs.stage4B4ProofJson), AUTHORITATIVE.stage4B4Sha256, 'stage4B4Sha256');

  const subject = parseObject(inputs.stage4B1SubjectJson, 'stage4B1Subject');
  const b1 = parseObject(inputs.stage4B1ArtifactJson, 'stage4B1Artifact');
  const b2 = parseObject(inputs.stage4B2ReceiptJson, 'stage4B2Receipt');
  const b3 = parseObject(inputs.stage4B3ReceiptJson, 'stage4B3Receipt');
  const b4 = parseObject(inputs.stage4B4ProofJson, 'stage4B4Proof');

  requireEqual(subject.schemaVersion, 'stage-4b1.attested-activation-contract.v1', 'stage4B1Subject.schemaVersion');
  requireEqual(subject.receiptCommit, AUTHORITATIVE.stage4B1ReceiptCommit, 'stage4B1Subject.receiptCommit');
  requireEqual(subject.eligibilityStatus, 'BLOCKED_NO_PROMOTED_STRATEGY', 'stage4B1Subject.eligibilityStatus');
  requireEqual(subject.artifactId, AUTHORITATIVE.stage4B1ArtifactId, 'stage4B1Subject.artifactId');
  requireEqual(subject.activationRequestPresent, false, 'stage4B1Subject.activationRequestPresent');
  requireEqual(subject.stage4A14SourceAccepted, false, 'stage4B1Subject.stage4A14SourceAccepted');
  requireEqual(subject.liveExecutionChanges, false, 'stage4B1Subject.liveExecutionChanges');
  requireApprovalsFalse(subject, 'stage4B1Subject');

  requireEqual(b1.schemaVersion, 'stage-4b1.activation-contract-artifact.v1', 'stage4B1.schemaVersion');
  requireEqual(b1.artifactId, AUTHORITATIVE.stage4B1ArtifactId, 'stage4B1.artifactId');
  requireEqual((b1.eligibilityProof as Record<string, unknown>)?.proofId, AUTHORITATIVE.stage4B1ProofId, 'stage4B1.proofId');
  requireEqual((b1.eligibilityProof as Record<string, unknown>)?.status, 'BLOCKED_NO_PROMOTED_STRATEGY', 'stage4B1.status');
  requireEqual((b1.activationDecision as Record<string, unknown>)?.decisionId, AUTHORITATIVE.stage4B1DecisionId, 'stage4B1.decisionId');
  requireEqual((b1.activationDecision as Record<string, unknown>)?.status, 'ACTIVATION_BLOCKED', 'stage4B1.decisionStatus');
  requireEqual(b1.activationRequest, null, 'stage4B1.activationRequest');
  requireEqual(b1.stage4A14SourceAccepted, false, 'stage4B1.stage4A14SourceAccepted');
  requireEqual(b1.liveExecutionChanges, false, 'stage4B1.liveExecutionChanges');
  requireApprovalsFalse(b1, 'stage4B1');

  requireEqual(b2.schemaVersion, 'stage-4b2.paper-readiness-receipt.v1', 'stage4B2.schemaVersion');
  requireEqual(b2.sourceCommit, AUTHORITATIVE.stage4B2SourceCommit, 'stage4B2.sourceCommit');
  requireEqual(b2.receiptId, AUTHORITATIVE.stage4B2ReceiptId, 'stage4B2.receiptId');
  requireEqual(b2.stage4B1ArtifactId, AUTHORITATIVE.stage4B1ArtifactId, 'stage4B2.stage4B1ArtifactId');
  requireEqual(b2.stage4B1ProofId, AUTHORITATIVE.stage4B1ProofId, 'stage4B2.stage4B1ProofId');
  requireEqual(b2.stage4B1DecisionId, AUTHORITATIVE.stage4B1DecisionId, 'stage4B2.stage4B1DecisionId');
  requireEqual(b2.stage4B1ArtifactSourceSha256, AUTHORITATIVE.stage4B1ArtifactSha256, 'stage4B2.stage4B1ArtifactSha256');
  requireEqual(b2.status, 'BLOCKED_NO_ACTIVATION_REVIEW_READY_STRATEGY', 'stage4B2.status');
  requireEqual(b2.reviewEligible, false, 'stage4B2.reviewEligible');
  requireEqual(b2.paperRuntimeChanges, false, 'stage4B2.paperRuntimeChanges');
  requireEqual(b2.liveExecutionChanges, false, 'stage4B2.liveExecutionChanges');
  requireApprovalsFalse(b2, 'stage4B2');

  requireEqual(b3.schemaVersion, 'stage-4b3.safety-receipt.v1', 'stage4B3.schemaVersion');
  requireEqual(b3.sourceCommit, AUTHORITATIVE.stage4B3SourceCommit, 'stage4B3.sourceCommit');
  requireEqual(b3.receiptId, AUTHORITATIVE.stage4B3ReceiptId, 'stage4B3.receiptId');
  requireEqual(b3.stage4B2ReceiptId, AUTHORITATIVE.stage4B2ReceiptId, 'stage4B3.stage4B2ReceiptId');
  requireEqual(b3.stage4B2SourceCommit, AUTHORITATIVE.stage4B2SourceCommit, 'stage4B3.stage4B2SourceCommit');
  requireEqual(b3.stage4B2RawArtifactSha256, AUTHORITATIVE.stage4B2Sha256, 'stage4B3.stage4B2Sha256');
  requireEqual(b3.stage4B1ArtifactId, AUTHORITATIVE.stage4B1ArtifactId, 'stage4B3.stage4B1ArtifactId');
  requireEqual(b3.stage4B1ProofId, AUTHORITATIVE.stage4B1ProofId, 'stage4B3.stage4B1ProofId');
  requireEqual(b3.stage4B1DecisionId, AUTHORITATIVE.stage4B1DecisionId, 'stage4B3.stage4B1DecisionId');
  requireEqual(b3.runtimeStarted, false, 'stage4B3.runtimeStarted');
  requireApprovalsFalse(b3, 'stage4B3');

  requireEqual(b4.schemaVersion, 'cloddsbot.shadow.runtime-proof.v1', 'stage4B4.schemaVersion');
  requireEqual(b4.sourceCommit, AUTHORITATIVE.stage4B4ProofSourceCommit, 'stage4B4.sourceCommit');
  requireEqual(b4.implementationBaseline, AUTHORITATIVE.stage4B42MergeCommit, 'stage4B4.implementationBaseline');
  requireEqual(b4.proofId, AUTHORITATIVE.stage4B4ProofId, 'stage4B4.proofId');
  requireEqual(b4.proofScope, 'REFERENCE SHADOW INFRASTRUCTURE PROOF ONLY', 'stage4B4.proofScope');
  requireEqual(b4.strategyBacktest, false, 'stage4B4.strategyBacktest');
  requireEqual(b4.runtimeState, 'STOPPED', 'stage4B4.runtimeState');
  if (!Number.isSafeInteger(b4.ledgerSize) || (b4.ledgerSize as number) < 1) {
    throw new Error('stage4B4.ledgerSize: must be positive');
  }
  requireEqual(b4.zeroAdapterCalls, 0, 'stage4B4.zeroAdapterCalls');
  requireApprovalsFalse(b4, 'stage4B4');

  const withoutId: AuditWithoutId = {
    schemaVersion: STAGE_4B_CLOSURE_SCHEMA_VERSION,
    stage: 'STAGE 4B',
    status: 'CLOSED_BLOCKED_NO_PROMOTED_STRATEGY',
    sourceCommit: inputs.sourceCommit,
    targetBaselineCommit: inputs.targetBaselineCommit,
    stage4B1: {
      receiptCommit: AUTHORITATIVE.stage4B1ReceiptCommit,
      subjectSha256: AUTHORITATIVE.stage4B1SubjectSha256,
      artifactSha256: AUTHORITATIVE.stage4B1ArtifactSha256,
      artifactId: AUTHORITATIVE.stage4B1ArtifactId,
      proofId: AUTHORITATIVE.stage4B1ProofId,
      decisionId: AUTHORITATIVE.stage4B1DecisionId,
    },
    stage4B2: {
      sourceCommit: AUTHORITATIVE.stage4B2SourceCommit,
      rawSha256: AUTHORITATIVE.stage4B2Sha256,
      receiptId: AUTHORITATIVE.stage4B2ReceiptId,
      status: 'BLOCKED_NO_ACTIVATION_REVIEW_READY_STRATEGY',
    },
    stage4B3: {
      sourceCommit: AUTHORITATIVE.stage4B3SourceCommit,
      rawSha256: AUTHORITATIVE.stage4B3Sha256,
      receiptId: AUTHORITATIVE.stage4B3ReceiptId,
    },
    stage4B4: {
      stage4B41MergeCommit: AUTHORITATIVE.stage4B41MergeCommit,
      stage4B42MergeCommit: AUTHORITATIVE.stage4B42MergeCommit,
      stage4B43MergeCommit: AUTHORITATIVE.stage4B43MergeCommit,
      proofSourceCommit: AUTHORITATIVE.stage4B4ProofSourceCommit,
      proofRawSha256: AUTHORITATIVE.stage4B4Sha256,
      proofId: AUTHORITATIVE.stage4B4ProofId,
      runtimeState: 'STOPPED',
      zeroAdapterCalls: 0,
    },
    promotedStrategies: 0,
    runtimeStarted: false,
    paperApproved: false,
    testnetApproved: false,
    liveApproved: false,
    liveExecutionChanges: false,
  };
  const audit: Stage4BClosureAudit = {
    ...withoutId,
    closureId: sha256(DOMAIN + canonicalSerialize(withoutId)),
  };
  deepFreeze(audit);
  return audit;
}

export function createStage4BClosureAudit(inputs: Stage4BClosureInputs): Stage4BClosureAudit {
  return derive(inputs);
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
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid array length');
      const names = Object.getOwnPropertyNames(object);
      if (names.length !== length + 1) throw new Error('sparse or extended array');
      const result: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined ||
            descriptor.enumerable !== true) throw new Error('invalid array property');
        result.push(cloneWithoutGetters(descriptor.value, path));
      }
      return result;
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) throw new Error('non-plain object');
    const result: Record<string, unknown> = {};
    for (const name of Object.getOwnPropertyNames(object)) {
      const descriptor = descriptors[name];
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined ||
          descriptor.enumerable !== true) throw new Error('invalid object property');
      result[name] = cloneWithoutGetters(descriptor.value, path);
    }
    return result;
  } finally {
    path.delete(object);
  }
}

export function verifyStage4BClosureAudit(
  artifact: unknown,
  inputs: Stage4BClosureInputs,
): Stage4BClosureAudit | null {
  try {
    const expected = derive(inputs);
    const serialized = canonicalSerialize(cloneWithoutGetters(artifact));
    if (serialized !== canonicalSerialize(expected)) return null;
    return expected;
  } catch {
    return null;
  }
}
