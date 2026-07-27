#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  createStage4B2Receipt,
  verifyStage4B2Receipt,
}: {
  createStage4B2Receipt: typeof import('../src/validation/PaperReadinessReview').createStage4B2Receipt;
  verifyStage4B2Receipt: typeof import('../src/validation/PaperReadinessReview').verifyStage4B2Receipt;
} = require('../src/validation/PaperReadinessReview');

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1]) throw new Error(`Missing value for ${name}`);
  return process.argv[index + 1];
}

const sourceCommit = argument('--source-commit', process.env.SOURCE_COMMIT);
const output = path.resolve(argument('--output', 'artifacts/stage-4b2-receipt.json')!);
const artifactPath = argument('--artifact', 'docs/releases/stage-4b1-activation-contract.json')!;
if (!sourceCommit) throw new Error('SOURCE_COMMIT or --source-commit is required');

// Stage 4A closure audit ID from verified baseline
const STAGE_4A_CLOSURE_AUDIT_ID = 'af9dc5cbb832b32b0c403631b2805bcb93996d215c044a47a06e4b3347db40cc';

// Read and independently re-verify the 4B1 artifact (never trust hardcoded IDs)
const raw4B1 = await readFile(path.resolve(artifactPath), 'utf8');
const artifact4B1 = JSON.parse(raw4B1);
const artifactSourceSha256 = createHash('sha256').update(raw4B1).digest('hex');

const receipt = createStage4B2Receipt({
  sourceCommit,
  stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID,
  stage4B1Artifact: artifact4B1,
  stage4B1ArtifactSourceSha256: artifactSourceSha256,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
});

// Independent verification with re-verified artifact
verifyStage4B2Receipt(receipt, {
  sourceCommit,
  stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID,
  stage4B1Artifact: artifact4B1,
  stage4B1ArtifactSourceSha256: artifactSourceSha256,
});

// Tamper check — alter receipt field, must fail
const tampered = structuredClone(receipt);
tampered.paperApproved = true as any;
let tamperRejected = false;
try {
  verifyStage4B2Receipt(tampered, { sourceCommit, stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID, stage4B1Artifact: artifact4B1, stage4B1ArtifactSourceSha256: artifactSourceSha256 });
} catch {
  tamperRejected = true;
}
if (!tamperRejected) throw new Error('TAMPER_CHECK_FAILED');

// Tamper check — alter 4B1 artifact, must fail
const tamperedArtifact = structuredClone(artifact4B1);
tamperedArtifact.eligibilityProof.status = 'ELIGIBLE_FOR_ACTIVATION_REVIEW';
let artifactTamperRejected = false;
try {
  verifyStage4B2Receipt(receipt, { sourceCommit, stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID, stage4B1Artifact: tamperedArtifact, stage4B1ArtifactSourceSha256: artifactSourceSha256 });
} catch {
  artifactTamperRejected = true;
}
if (!artifactTamperRejected) throw new Error('ARTIFACT_TAMPER_CHECK_FAILED');

// Self-consistent fake artifact — sha256 mismatch rejects at verifier
const fakeArtifact = structuredClone(artifact4B1);
fakeArtifact.eligibilityProof.proofId = 'f'.repeat(64);
fakeArtifact.activationDecision.eligibilityProofId = 'f'.repeat(64);
fakeArtifact.artifactId = 'f'.repeat(64);
let fakeRejected = false;
try {
  verifyStage4B2Receipt(receipt, { sourceCommit, stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID, stage4B1Artifact: fakeArtifact, stage4B1ArtifactSourceSha256: artifactSourceSha256 });
} catch {
  fakeRejected = true;
}
if (!fakeRejected) throw new Error('FAKE_ARTIFACT_CHECK_FAILED');

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
const outputSha256 = createHash('sha256').update(await readFile(output)).digest('hex');
console.log('STAGE 4B2 PAPER READINESS RECEIPT');
console.log('BLOCKED — NO ACTIVATION REVIEW READY STRATEGY');
console.log(`SOURCE_COMMIT=${sourceCommit}`);
console.log(`RECEIPT_ID=${receipt.receiptId}`);
console.log(`STAGE_4A_CLOSURE=${STAGE_4A_CLOSURE_AUDIT_ID}`);
console.log(`STAGE_4B1_ARTIFACT=${receipt.stage4B1ArtifactId}`);
console.log(`STAGE_4B1_PROOF=${receipt.stage4B1ProofId}`);
console.log(`STAGE_4B1_DECISION=${receipt.stage4B1DecisionId}`);
console.log(`4B1_ARTIFACT_SOURCE_SHA256=${artifactSourceSha256}`);
console.log(`REVIEW_ELIGIBLE=false`);
console.log(`PAPER_APPROVED=false`);
console.log(`TESTNET_APPROVED=false`);
console.log(`LIVE_APPROVED=false`);
console.log(`OUTPUT_SHA256=${outputSha256}`);
console.log('RECEIPT_VERIFY=PASS');
console.log('TAMPER_CHECK=PASS');
console.log('ARTIFACT_TAMPER_CHECK=PASS');
console.log('FAKE_ARTIFACT_CHECK=PASS');
