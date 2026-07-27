#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  createReferenceInfrastructureProof,
  verifyReferenceInfrastructureProof,
}: {
  createReferenceInfrastructureProof: typeof import('../src/validation/ReferenceInfrastructureProof').createReferenceInfrastructureProof;
  verifyReferenceInfrastructureProof: typeof import('../src/validation/ReferenceInfrastructureProof').verifyReferenceInfrastructureProof;
} = require('../src/validation/ReferenceInfrastructureProof');

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1]) throw new Error(`Missing value for ${name}`);
  return process.argv[index + 1];
}

const repository = argument('--repository', process.env.GITHUB_REPOSITORY ?? 'wengecaitui/DSbot')!;
const sourceCommit = argument('--source-commit', process.env.SOURCE_COMMIT);
const workflow = argument('--workflow', '.github/workflows/reference-infrastructure-proof.yml')!;
const output = path.resolve(argument('--output', 'artifacts/reference-infrastructure-proof.json')!);
if (!sourceCommit) throw new Error('SOURCE_COMMIT or --source-commit is required');

const simulatorSource = path.resolve('src/validation/ReferenceInfrastructureProof.ts');
const simulatorSourceSha256 = createHash('sha256').update(await readFile(simulatorSource)).digest('hex');
const proof = createReferenceInfrastructureProof({ repository, sourceCommit, workflow, simulatorSourceSha256 });
verifyReferenceInfrastructureProof(proof, {
  expectedRepository: repository,
  expectedSourceCommit: sourceCommit,
  expectedWorkflow: workflow,
  expectedSimulatorSourceSha256: simulatorSourceSha256,
});

const tampered = structuredClone(proof);
tampered.promotionArtifact.report.finalHoldoutMetrics.netReturn += 1;
let tamperRejected = false;
try {
  verifyReferenceInfrastructureProof(tampered, { expectedSourceCommit: sourceCommit });
} catch {
  tamperRejected = true;
}
if (!tamperRejected) throw new Error('TAMPER_CHECK_FAILED');

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
const outputSha256 = createHash('sha256').update(await readFile(output)).digest('hex');
console.log('REFERENCE INFRASTRUCTURE PROOF ONLY');
console.log('NOT A REAL STRATEGY BACKTEST');
console.log('NOT APPROVED FOR PAPER, TESTNET OR LIVE');
console.log(`SOURCE_COMMIT=${sourceCommit}`);
console.log(`DATASET_SHA256=${proof.dataset.sha256}`);
console.log(`CONFIGURATION_SHA256=${proof.configuration.sha256}`);
console.log(`PROMOTION_ARTIFACT_ID=${proof.promotionArtifact.artifactId}`);
console.log(`PROOF_ID=${proof.proofId}`);
console.log(`OUTPUT_SHA256=${outputSha256}`);
console.log(`FINAL_HOLDOUT_REFERENCE_TRADES=${proof.promotionArtifact.report.finalHoldoutMetrics.tradeCount}`);
console.log('CHAIN_RECOMPUTATION=PASS');
console.log('TAMPER_CHECK=PASS');
