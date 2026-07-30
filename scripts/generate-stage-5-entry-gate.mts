#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalSerialize } = require('../src/shadow/CanonicalJson');
const { createStage5EntryGate, verifyStage5EntryGate } = require('../src/validation/Stage5EntryGate');

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
}

const sourceCommit = argument('--source-commit', process.env.SOURCE_COMMIT);
if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
  throw new Error('--source-commit or SOURCE_COMMIT must be a lowercase 40-hex Git SHA');
}
const closurePath = argument('--stage-4b-closure');
if (!closurePath) throw new Error('--stage-4b-closure is required');
const output = path.resolve(argument('--output', 'artifacts/stage-5-entry-gate.json')!);

const inputs = {
  sourceCommit,
  stage4BClosureMergeCommit: 'fcc3a1a24fb7fc07b91878b27bddf9465da6334d',
  stage4BClosureJson: await readFile(path.resolve(closurePath), 'utf8'),
};
const gate = createStage5EntryGate(inputs);
if (!verifyStage5EntryGate(gate, inputs)) throw new Error('STAGE5_ENTRY_VERIFY_FAILED');

const tampered = JSON.parse(JSON.stringify(gate));
tampered.activationAuthorized = true;
if (verifyStage5EntryGate(tampered, inputs) !== null) {
  throw new Error('ACTIVATION_TAMPER_CHECK_FAILED');
}
if (verifyStage5EntryGate(gate, {
  ...inputs,
  stage4BClosureJson: `${inputs.stage4BClosureJson} `,
}) !== null) {
  throw new Error('CLOSURE_BYTE_TAMPER_CHECK_FAILED');
}

const bytes = Buffer.from(`${canonicalSerialize(gate)}\n`, 'utf8');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, bytes, { flag: 'wx' });
const digest = createHash('sha256').update(await readFile(output)).digest('hex');

console.log('STAGE 5 ENTRY GATE');
console.log('BLOCKED_NO_PROMOTED_STRATEGY');
console.log(`SOURCE_COMMIT=${sourceCommit}`);
console.log(`GATE_ID=${gate.gateId}`);
console.log(`OUTPUT_SHA256=${digest}`);
console.log('STAGE5_ENTERED=true');
console.log('ENTRY_AUTHORIZED=false');
console.log('ACTIVATION_AUTHORIZED=false');
console.log('RUNTIME_STARTED=false');
console.log('PAPER_APPROVED=false');
console.log('TESTNET_APPROVED=false');
console.log('LIVE_APPROVED=false');
console.log('REQUIRED_ACTION=FRESH_PROMOTION_AND_ACTIVATION_CHAIN_REQUIRED');
console.log('VERIFY=PASS');
console.log('TAMPER_CHECK=PASS');
