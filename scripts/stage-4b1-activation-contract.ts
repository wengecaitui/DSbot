#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACTIVATION_AUDIT_SCHEMA,
  ACTIVATION_CONTRACT_VERSION,
  canonicalSha256,
  createRealBlockedAudit,
  evaluateActivationDecision,
  verifyProductionEligibility,
  type ActivationAuditEvent,
  type ActivationDecision,
  type ActivationEligibilityProof,
  type Stage4AArtifactTextBundle,
} from '../src/validation/ActivationContract';

const ARTIFACT_SCHEMA = 'stage-4b1.activation-contract-artifact.v1' as const;
const SUBJECT_SCHEMA = 'stage-4b1.attested-activation-contract.v1' as const;
const ARTIFACT_TIMESTAMP = '2026-07-27T00:00:00.000Z' as const;
const LABELS = [
  'OFFLINE ACTIVATION CONTRACT ONLY',
  'BLOCKED: NO PROMOTED STRATEGY',
  'NOT APPROVED FOR PAPER, TESTNET OR LIVE',
] as const;

interface Stage4B1Artifact {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA;
  readonly labels: typeof LABELS;
  readonly contractVersion: typeof ACTIVATION_CONTRACT_VERSION;
  readonly baselineCommit: string;
  readonly sourceArtifactIds: Readonly<Record<string, string>>;
  readonly counts: ActivationEligibilityProof['counts'];
  readonly eligibilityProof: ActivationEligibilityProof;
  readonly activationRequest: null;
  readonly activationDecision: ActivationDecision;
  readonly stateMachine: {
    readonly initialState: 'INACTIVE';
    readonly terminalState: 'ACTIVATION_BLOCKED';
    readonly path: readonly ['INACTIVE', 'ELIGIBILITY_CHECKED', 'ACTIVATION_BLOCKED'];
  };
  readonly audit: {
    readonly schemaVersion: typeof ACTIVATION_AUDIT_SCHEMA;
    readonly rootEventId: string;
    readonly tipEventId: string;
    readonly eventCount: 3;
    readonly events: readonly ActivationAuditEvent[];
  };
  readonly stage4A14SourceAccepted: false;
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
  readonly liveExecutionChanges: false;
  readonly artifactId: string;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`STAGE_4B1_ARGUMENT_REQUIRED:${name}`);
  return value;
}

function read(path: string): string { return readFileSync(resolve(path), 'utf8'); }
function parse(path: string): unknown { return JSON.parse(read(path)); }
function write(path: string, value: unknown): void { writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

function artifactInputs(): Stage4AArtifactTextBundle {
  return {
    candidateManifestJson: read(requiredArgument('--candidate-manifest')),
    promotionDecisionJson: read(requiredArgument('--promotion-decision')),
    consumedEvidenceSeedJson: read(requiredArgument('--consumed-evidence-seed')),
    governanceContractJson: read(requiredArgument('--governance-contract')),
    closureAuditJson: read(requiredArgument('--closure-audit')),
  };
}

function validateCommit(value: string, code: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(code);
}

export function buildStage4B1Artifact(baselineCommit: string, inputs: Stage4AArtifactTextBundle): Stage4B1Artifact {
  validateCommit(baselineCommit, 'STAGE_4B1_BASELINE_COMMIT_INVALID');
  const proof = verifyProductionEligibility(inputs, baselineCommit);
  if (proof.status !== 'BLOCKED_NO_PROMOTED_STRATEGY' || proof.counts.candidateStrategies !== 4
      || proof.counts.promotionEligible !== 0 || proof.counts.consumedWindows !== 10
      || proof.counts.consumedEvaluations !== 40) throw new Error('STAGE_4B1_REAL_ELIGIBILITY_INVALID');
  const activationDecision = evaluateActivationDecision(
    proof, null, [], [], Date.parse(ARTIFACT_TIMESTAMP), inputs, baselineCommit,
  );
  if (activationDecision.status !== 'ACTIVATION_BLOCKED' || activationDecision.requestId !== null) {
    throw new Error('STAGE_4B1_REAL_DECISION_INVALID');
  }
  if (activationDecision.reasonCodes.length !== 1 || activationDecision.reasonCodes[0] !== 'BLOCKED_NO_PROMOTED_STRATEGY') {
    throw new Error('STAGE_4B1_REAL_DECISION_REASON_INVALID');
  }
  const audit = createRealBlockedAudit(proof, ARTIFACT_TIMESTAMP);
  const events = audit.events;
  const body: Omit<Stage4B1Artifact, 'artifactId'> = {
    schemaVersion: ARTIFACT_SCHEMA,
    labels: LABELS,
    contractVersion: ACTIVATION_CONTRACT_VERSION,
    baselineCommit,
    sourceArtifactIds: { ...proof.sourceBindings },
    counts: { ...proof.counts },
    eligibilityProof: proof,
    activationRequest: null,
    activationDecision,
    stateMachine: {
      initialState: 'INACTIVE', terminalState: 'ACTIVATION_BLOCKED',
      path: ['INACTIVE', 'ELIGIBILITY_CHECKED', 'ACTIVATION_BLOCKED'],
    },
    audit: {
      schemaVersion: ACTIVATION_AUDIT_SCHEMA,
      rootEventId: events[0].eventId,
      tipEventId: events[2].eventId,
      eventCount: 3,
      events,
    },
    stage4A14SourceAccepted: false,
    paperApproved: false,
    testnetApproved: false,
    liveApproved: false,
    liveExecutionChanges: false,
  };
  return { ...body, artifactId: canonicalSha256(body) };
}

export function verifyStage4B1Artifact(artifactValue: unknown, baselineCommit: string, inputs: Stage4AArtifactTextBundle): Stage4B1Artifact {
  if (!artifactValue || typeof artifactValue !== 'object' || Array.isArray(artifactValue)) throw new Error('STAGE_4B1_ARTIFACT_MALFORMED');
  const artifact = artifactValue as Stage4B1Artifact;
  const unsigned = { ...artifact } as Record<string, unknown>;
  delete unsigned.artifactId;
  if (artifact.artifactId !== canonicalSha256(unsigned)) throw new Error('STAGE_4B1_ARTIFACT_ID_INVALID');
  const expected = buildStage4B1Artifact(baselineCommit, inputs);
  if (JSON.stringify(expected) !== JSON.stringify(artifact)) throw new Error('STAGE_4B1_ARTIFACT_RECOMPUTATION_MISMATCH');
  if (artifact.activationRequest !== null || artifact.stage4A14SourceAccepted !== false
      || artifact.paperApproved !== false || artifact.testnetApproved !== false
      || artifact.liveApproved !== false || artifact.liveExecutionChanges !== false) {
    throw new Error('STAGE_4B1_BOUNDARY_INVALID');
  }
  if (artifact.stateMachine.path.join(',') !== 'INACTIVE,ELIGIBILITY_CHECKED,ACTIVATION_BLOCKED') {
    throw new Error('STAGE_4B1_STATE_PATH_INVALID');
  }
  return artifact;
}

function main(): void {
  const output = requiredArgument('--artifact');
  const baselineCommit = requiredArgument('--baseline-commit');
  const inputs = artifactInputs();
  if (process.argv.includes('--build')) write(output, buildStage4B1Artifact(baselineCommit, inputs));
  const artifact = verifyStage4B1Artifact(parse(output), baselineCommit, inputs);
  const receiptCommit = argument('--receipt-commit');
  const subjectOutput = argument('--subject-output');
  if ((receiptCommit && !subjectOutput) || (!receiptCommit && subjectOutput)) throw new Error('STAGE_4B1_SUBJECT_ARGUMENTS_INVALID');
  if (receiptCommit && subjectOutput) {
    validateCommit(receiptCommit, 'STAGE_4B1_RECEIPT_COMMIT_INVALID');
    const subjectBody = {
      schemaVersion: SUBJECT_SCHEMA,
      labels: LABELS,
      receiptCommit,
      artifactId: artifact.artifactId,
      baselineCommit: artifact.baselineCommit,
      eligibilityStatus: artifact.eligibilityProof.status,
      auditTipId: artifact.audit.tipEventId,
      activationRequestPresent: false,
      stage4A14SourceAccepted: false,
      paperApproved: false,
      testnetApproved: false,
      liveApproved: false,
      liveExecutionChanges: false,
    };
    write(subjectOutput, { ...subjectBody, subjectId: canonicalSha256(subjectBody) });
  }
  process.stdout.write(`${JSON.stringify({
    artifactId: artifact.artifactId,
    status: artifact.eligibilityProof.status,
    statePath: artifact.stateMachine.path,
    activationRequestPresent: false,
  })}\n`);
}

if (require.main === module) main();
