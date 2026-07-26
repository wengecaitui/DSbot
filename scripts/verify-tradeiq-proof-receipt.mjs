#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const args = process.argv.slice(2);
const receiptPath = args[0];
const sourceIndex = args.indexOf('--source-commit');
const outputIndex = args.indexOf('--output');
if (!receiptPath) throw new Error('RECEIPT_PATH_REQUIRED');
const receipt = JSON.parse(readFileSync(resolve(receiptPath), 'utf8'));
const shaPattern = /^[0-9a-f]{64}$/;
const requiredLabels = [
  'PUBLIC DIGEST RECEIPT ONLY',
  'PRIVATE FULL RECOMPUTATION REQUIRED',
  'NOT STRATEGY PROMOTION',
  'NOT APPROVED FOR PAPER, TESTNET OR LIVE',
];
if (receipt.schemaVersion !== 'stage-4a10.public-private-proof-receipt.v1') throw new Error('RECEIPT_SCHEMA_INVALID');
if (canonical(receipt.labels) !== canonical(requiredLabels)) throw new Error('RECEIPT_LABELS_INVALID');
for (const digest of [receipt.asset.pineSha256, receipt.asset.privateAdapterSha256, receipt.dataset.sourceSha256, receipt.dataset.dataframeSha256, receipt.proof.privateProofId, receipt.proof.candidateGridSha256, receipt.proof.walkForwardReportId]) {
  if (!shaPattern.test(digest)) throw new Error('RECEIPT_DIGEST_INVALID');
}
if (!/^[0-9a-f]{40}$/.test(receipt.engineCommit)) throw new Error('RECEIPT_ENGINE_COMMIT_INVALID');
if (receipt.dataset.gapPolicy !== 'reject' || receipt.dataset.gapCount !== 0) throw new Error('RECEIPT_DATA_GAP_INVALID');
if (receipt.proof.developmentFolds <= 0 || receipt.proof.testEvaluationCount !== receipt.proof.developmentFolds) throw new Error('RECEIPT_TEST_EXACT_ONCE_INVALID');
if (receipt.proof.finalHoldoutEvaluationCount !== 1 || receipt.proof.finalHoldoutTrades <= 0) throw new Error('RECEIPT_HOLDOUT_INVALID');
if (!Number.isFinite(receipt.proof.finalHoldoutNetReturn)) throw new Error('RECEIPT_METRICS_INVALID');
if (!Number.isFinite(receipt.proof.feeBps) || !Number.isFinite(receipt.proof.slippageBps) || Math.min(receipt.proof.feeBps, receipt.proof.slippageBps) < 0) throw new Error('RECEIPT_COST_CONFIG_INVALID');
if (receipt.proof.causalityCandidates !== 3 || receipt.proof.causalityCheckpointsPerCandidate !== 124 || receipt.proof.causalityFields !== 9) throw new Error('RECEIPT_CAUSALITY_INVALID');
if (receipt.promotion.eligible !== false) throw new Error('RECEIPT_PROMOTION_MUST_BE_FALSE');
const unsigned = { ...receipt };
delete unsigned.receiptId;
const expectedId = sha256(canonical(unsigned));
if (receipt.receiptId === 'PLACEHOLDER') {
  console.log(`EXPECTED_RECEIPT_ID=${expectedId}`);
  process.exit(2);
}
if (receipt.receiptId !== expectedId) throw new Error('RECEIPT_ID_INVALID');

if (sourceIndex >= 0 || outputIndex >= 0) {
  if (sourceIndex < 0 || !args[sourceIndex + 1] || outputIndex < 0 || !args[outputIndex + 1]) throw new Error('ATTESTED_OUTPUT_ARGS_INVALID');
  const wrapper = {
    schemaVersion: 'stage-4a10.attested-private-proof-receipt.v1',
    labels: requiredLabels,
    receiptCommit: args[sourceIndex + 1],
    receipt,
  };
  wrapper.subjectId = sha256(canonical(wrapper));
  const output = resolve(args[outputIndex + 1]);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(wrapper, null, 2)}\n`, 'utf8');
}
console.log(`RECEIPT_ID=${receipt.receiptId} PRIVATE_PROOF_ID=${receipt.proof.privateProofId} HOLDOUT_TRADES=${receipt.proof.finalHoldoutTrades} PROMOTION=false`);
