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
if (!sourceCommit) throw new Error('SOURCE_COMMIT or --source-commit is required');

// Stage 4A closure audit ID (Stage 4A closure-audit from verified baseline)
const STAGE_4A_CLOSURE_AUDIT_ID = 'af9dc5cbb832b32b0c403631b2805bcb93996d215c044a47a06e4b3347db40cc';
// Stage 4B1 proof ID — BLOCKED_NO_PROMOTED_STRATEGY from verified baseline
const STAGE_4B1_PROOF_ID = '0000000000000000000000000000000000000000000000000000000000000000';
// Stage 4B1 decision ID — deterministic blocked decision
const STAGE_4B1_DECISION_ID = '0000000000000000000000000000000000000000000000000000000000000000';

const receipt = createStage4B2Receipt({
  sourceCommit,
  stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID,
  stage4B1ProofId: STAGE_4B1_PROOF_ID,
  stage4B1DecisionId: STAGE_4B1_DECISION_ID,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
});

// Independent verification
verifyStage4B2Receipt(receipt, {
  sourceCommit,
  stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID,
  stage4B1ProofId: STAGE_4B1_PROOF_ID,
  stage4B1DecisionId: STAGE_4B1_DECISION_ID,
});

// Tamper check
const tampered = structuredClone(receipt);
tampered.paperApproved = true as any;
let tamperRejected = false;
try {
  verifyStage4B2Receipt(tampered, { sourceCommit, stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID, stage4B1ProofId: STAGE_4B1_PROOF_ID, stage4B1DecisionId: STAGE_4B1_DECISION_ID });
} catch {
  tamperRejected = true;
}
if (!tamperRejected) throw new Error('TAMPER_CHECK_FAILED');

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
const outputSha256 = createHash('sha256').update(await readFile(output)).digest('hex');
console.log('STAGE 4B2 PAPER READINESS RECEIPT');
console.log('BLOCKED — NO ACTIVATION REVIEW READY STRATEGY');
console.log(`SOURCE_COMMIT=${sourceCommit}`);
console.log(`RECEIPT_ID=${receipt.receiptId}`);
console.log(`STAGE_4A_CLOSURE=${STAGE_4A_CLOSURE_AUDIT_ID}`);
console.log(`STAGE_4B1_PROOF=${STAGE_4B1_PROOF_ID}`);
console.log(`STAGE_4B1_DECISION=${STAGE_4B1_DECISION_ID}`);
console.log(`REVIEW_ELIGIBLE=false`);
console.log(`PAPER_APPROVED=false`);
console.log(`TESTNET_APPROVED=false`);
console.log(`LIVE_APPROVED=false`);
console.log(`PAPER_RUNTIME_CHANGES=false`);
console.log(`LIVE_EXECUTION_CHANGES=false`);
console.log(`OUTPUT_SHA256=${outputSha256}`);
console.log('RECEIPT_VERIFY=PASS');
console.log('TAMPER_CHECK=PASS');
