#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalSerialize } = require('../src/shadow/CanonicalJson');
const {
  createStage4BClosureAudit,
  verifyStage4BClosureAudit,
} = require('../src/validation/Stage4BClosureAudit');

const SHA = /^[a-f0-9]{40}$/;

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
}

const sourceCommit = argument('--source-commit', process.env.SOURCE_COMMIT);
if (!sourceCommit || !SHA.test(sourceCommit)) {
  throw new Error('--source-commit or SOURCE_COMMIT must be a lowercase 40-hex Git SHA');
}
const output = path.resolve(argument('--output', 'artifacts/stage-4b-closure-audit.json')!);

const evidencePaths = {
  stage4B1SubjectJson: argument('--4b1-subject'),
  stage4B1ArtifactJson: argument('--4b1-artifact'),
  stage4B2ReceiptJson: argument('--4b2-receipt'),
  stage4B3ReceiptJson: argument('--4b3-receipt'),
  stage4B4ProofJson: argument('--4b4-proof'),
};
for (const [label, evidencePath] of Object.entries(evidencePaths)) {
  if (!evidencePath) throw new Error(`${label}: evidence path is required`);
}

const inputs = {
  sourceCommit,
  targetBaselineCommit: 'df6df2ea537d86cc3ea31d9c58cdc37b73305496',
  stage4B1SubjectJson: await readFile(path.resolve(evidencePaths.stage4B1SubjectJson!), 'utf8'),
  stage4B1ArtifactJson: await readFile(path.resolve(evidencePaths.stage4B1ArtifactJson!), 'utf8'),
  stage4B2ReceiptJson: await readFile(path.resolve(evidencePaths.stage4B2ReceiptJson!), 'utf8'),
  stage4B3ReceiptJson: await readFile(path.resolve(evidencePaths.stage4B3ReceiptJson!), 'utf8'),
  stage4B4ProofJson: await readFile(path.resolve(evidencePaths.stage4B4ProofJson!), 'utf8'),
  stage4B41MergeCommit: 'e6e21707a39ee8eb96a2b5ce4da916d3c900a6d0',
  stage4B42MergeCommit: '36195a6ddc4a757afdc28a23cdccb42653601368',
  stage4B43MergeCommit: 'df6df2ea537d86cc3ea31d9c58cdc37b73305496',
};

const audit = createStage4BClosureAudit(inputs);
if (!verifyStage4BClosureAudit(audit, inputs)) throw new Error('CLOSURE_VERIFY_FAILED');

const tampered = JSON.parse(JSON.stringify(audit));
tampered.paperApproved = true;
if (verifyStage4BClosureAudit(tampered, inputs) !== null) {
  throw new Error('CLOSURE_TAMPER_CHECK_FAILED');
}
if (verifyStage4BClosureAudit(audit, {
  ...inputs,
  stage4B4ProofJson: `${inputs.stage4B4ProofJson} `,
}) !== null) {
  throw new Error('EVIDENCE_BYTE_TAMPER_CHECK_FAILED');
}

const bytes = Buffer.from(`${canonicalSerialize(audit)}\n`, 'utf8');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, bytes, { flag: 'wx' });
const digest = createHash('sha256').update(await readFile(output)).digest('hex');

console.log('STAGE 4B CLOSURE AUDIT');
console.log('CLOSED_BLOCKED_NO_PROMOTED_STRATEGY');
console.log(`SOURCE_COMMIT=${sourceCommit}`);
console.log(`CLOSURE_ID=${audit.closureId}`);
console.log(`OUTPUT_SHA256=${digest}`);
console.log('PROMOTED_STRATEGIES=0');
console.log('RUNTIME_STARTED=false');
console.log('PAPER_APPROVED=false');
console.log('TESTNET_APPROVED=false');
console.log('LIVE_APPROVED=false');
console.log('LIVE_EXECUTION_CHANGES=false');
console.log('VERIFY=PASS');
console.log('TAMPER_CHECK=PASS');
