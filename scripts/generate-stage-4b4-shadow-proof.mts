#!/usr/bin/env node

/**
 * REFERENCE SHADOW INFRASTRUCTURE PROOF ONLY.
 * NOT A STRATEGY BACKTEST.
 * NOT APPROVED FOR PAPER, TESTNET OR LIVE.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalSerialize } = require('../src/shadow/CanonicalJson');
const { createCanonicalShadowEvent } = require('../src/shadow/CanonicalShadowEvent');
const { createShadowDecisionOutcome } = require('../src/shadow/ShadowDecisionOutcome');
const { ShadowRuntimeCoordinator } = require('../src/shadow/ShadowRuntimeCoordinator');
const {
  createShadowRuntimeProof,
  verifyShadowRuntimeProof,
  STAGE_4B4_2_BASELINE,
} = require('../src/shadow/ShadowRuntimeProof');
const { createTradeIntent } = require('../src/types/trade-intent');

const SOURCE_SHA = /^[a-f0-9]{40}$/;
const EVENT_TIME_MS = 1_000_000_000_000;
const EXCHANGE = 'bitget';
const SYMBOL = 'BTCUSDT';
const SOURCE = 'stage-4b4-reference-shadow-proof';
const REASON = 'REFERENCE TEST FIXTURE ONLY';

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
}

const sourceCommit = argument('--source-commit', process.env.SOURCE_COMMIT);
if (!sourceCommit || !SOURCE_SHA.test(sourceCommit)) {
  throw new Error('--source-commit or SOURCE_COMMIT must be a lowercase 40-hex Git SHA');
}
const output = path.resolve(argument(
  '--output',
  'artifacts/stage-4b4-shadow-proof.json',
)!);

const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'clodds-stage-4b4-proof-'));
const ledgerFile = path.join(evidenceDir, 'shadow-ledger.jsonl');
const snapshotFile = path.join(evidenceDir, 'shadow-snapshot.json');

const coordinator = new ShadowRuntimeCoordinator(ledgerFile, snapshotFile);
coordinator.startup();
const intent = createTradeIntent({
  exchange: EXCHANGE,
  symbol: SYMBOL,
  direction: 'long',
  positionUsd: 1500,
  source: SOURCE,
  reason: REASON,
  biasUpdatedAt: EVENT_TIME_MS - 1_000,
  createdAt: EVENT_TIME_MS,
  intentId: 'ti-stage4b4-reference-000000000001',
});
const outcome = createShadowDecisionOutcome({
  exchange: EXCHANGE,
  decision: 'trade',
  direction: 'long',
  symbol: SYMBOL,
  positionUsd: 1500,
  tradeIntent: intent,
  reason: REASON,
}, EXCHANGE, SYMBOL);
const event = createCanonicalShadowEvent(SOURCE, EVENT_TIME_MS, 0, outcome);
const result = coordinator.process(event, outcome);
if (result.status !== 'accepted') {
  throw new Error(`REFERENCE_INTENT_REJECTED:${result.status}`);
}
coordinator.stop();

const context = {
  sourceCommit,
  implementationBaseline: STAGE_4B4_2_BASELINE,
  ledgerFile,
  snapshotFile,
};
const proof = createShadowRuntimeProof(context);
if (!verifyShadowRuntimeProof(proof, context)) {
  throw new Error('PROOF_VERIFY_FAILED');
}

const approvalTamper = JSON.parse(JSON.stringify(proof));
approvalTamper.paperApproved = true;
if (verifyShadowRuntimeProof(approvalTamper, context) !== null) {
  throw new Error('APPROVAL_TAMPER_CHECK_FAILED');
}

const tamperDir = await mkdtemp(path.join(os.tmpdir(), 'clodds-stage-4b4-tamper-'));
const tamperLedger = path.join(tamperDir, 'shadow-ledger.jsonl');
const tamperSnapshot = path.join(tamperDir, 'shadow-snapshot.json');
await copyFile(ledgerFile, tamperLedger);
await copyFile(snapshotFile, tamperSnapshot);
const tamperContext = { ...context, ledgerFile: tamperLedger, snapshotFile: tamperSnapshot };
if (!verifyShadowRuntimeProof(proof, tamperContext)) {
  throw new Error('COPIED_EVIDENCE_PRECHECK_FAILED');
}
await writeFile(tamperLedger, Buffer.from('tampered-evidence\n'), { flag: 'w' });
if (verifyShadowRuntimeProof(proof, tamperContext) !== null) {
  throw new Error('EVIDENCE_TAMPER_CHECK_FAILED');
}

const outputBytes = Buffer.from(`${canonicalSerialize(proof)}\n`, 'utf8');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, outputBytes, { flag: 'wx' });
const outputSha256 = createHash('sha256').update(await readFile(output)).digest('hex');

console.log('STAGE 4B4.3 SHADOW RUNTIME PROOF');
console.log('REFERENCE SHADOW INFRASTRUCTURE PROOF ONLY');
console.log('NOT A STRATEGY BACKTEST');
console.log('NOT APPROVED FOR PAPER TESTNET OR LIVE');
console.log(`SOURCE_COMMIT=${sourceCommit}`);
console.log(`PROOF_ID=${proof.proofId}`);
console.log(`OUTPUT_SHA256=${outputSha256}`);
console.log('ZERO_ADAPTER_CALLS=0');
console.log('PAPER_APPROVED=false');
console.log('TESTNET_APPROVED=false');
console.log('LIVE_APPROVED=false');
console.log('VERIFY=PASS');
console.log('TAMPER_CHECK=PASS');
