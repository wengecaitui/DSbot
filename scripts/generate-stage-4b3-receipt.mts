#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const activationMod = require('../src/validation/ActivationContract');
const canonicalSha256 = activationMod.canonicalSha256;
const mod = require('../src/validation/RuntimeSafety');
const createStage4B3Receipt = mod.createStage4B3Receipt;
const verifyStage4B3Receipt = mod.verifyStage4B3Receipt;
const createBlockedSafetyAudit = mod.createBlockedSafetyAudit;
const KillSwitch = mod.KillSwitch;
const IdempotencyLedger = mod.IdempotencyLedger;
const RuntimeSafetyPolicy = mod.RuntimeSafetyPolicy;

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1]) throw new Error(`Missing value for ${name}`);
  return process.argv[index + 1];
}

const sourceCommit = argument('--source-commit', process.env.SOURCE_COMMIT);
const output = path.resolve(argument('--output', 'artifacts/stage-4b3-receipt.json')!);
if (!sourceCommit) throw new Error('SOURCE_COMMIT or --source-commit is required');

const STAGE_4B2_RECEIPT_ID = 'd4be6cadfedc0a9b4ac8628f492a34955c6ce57260fbe781b563787bce4b9f08';
const STAGE_4B2_SOURCE_COMMIT = '81b0980f4fee168075a52c6ebcb12eb50f382217';

// Build real safety state deterministically
const audit = createBlockedSafetyAudit('2026-07-28T00:00:00.000Z');
const killSwitch = new KillSwitch();
const idempotencyLedger = new IdempotencyLedger();
const policy = new RuntimeSafetyPolicy(STAGE_4B2_RECEIPT_ID, sourceCommit, killSwitch, idempotencyLedger);

const decision = policy.evaluate({
  receiptId: STAGE_4B2_RECEIPT_ID,
  sourceSha: sourceCommit,
  killSwitch,
  bridgeHealth: 'READY',
  marketDataHealth: 'UNKNOWN',
  stateStoreIntact: true,
  hasUnresolvedOrders: false,
  recoveryRequired: false,
  paperApproved: false,
  testnetApproved: false,
  liveApproved: false,
}, 'stage-4b3-receipt-generation');

const receiptInput = {
  sourceCommit,
  stage4B2ReceiptId: STAGE_4B2_RECEIPT_ID,
  stage4B2SourceCommit: STAGE_4B2_SOURCE_COMMIT,
  safetyDecisionId: decision.decisionId,
  auditRootId: audit.all[0].eventId,
  auditTipId: audit.tipId!,
  killSwitchEnabled: killSwitch.enabled,
  killSwitchReason: killSwitch.reason,
  idempotencyLedgerDigest: canonicalSha256(idempotencyLedger.persist()),
  recoveryStatus: 'NONE',
  runtimeStarted: false,
  paperApproved: false,
  testnetApproved: false,
  liveApproved: false,
};

const receipt = createStage4B3Receipt(receiptInput, '2026-07-28T00:00:00.000Z');

// Independent verification
verifyStage4B3Receipt(receipt, receiptInput, receipt.receiptId);

// Tamper checks
const tampered = structuredClone(receipt);
(tampered as any).paperApproved = true;
let tamperRejected = false;
try { verifyStage4B3Receipt(tampered, receiptInput); } catch { tamperRejected = true; }
if (!tamperRejected) throw new Error('TAMPER_CHECK_FAILED');

const tamperedSha = structuredClone(receipt);
(tamperedSha as any).sourceCommit = '0'.repeat(40);
let shaRejected = false;
try { verifyStage4B3Receipt(tamperedSha, receiptInput); } catch { shaRejected = true; }
if (!shaRejected) throw new Error('TRUST_ROOT_TAMPER_CHECK_FAILED');

const forged = structuredClone(receipt);
(forged as any).receiptId = 'f'.repeat(64);
let forgeryRejected = false;
try { verifyStage4B3Receipt(forged, receiptInput, receipt.receiptId); } catch { forgeryRejected = true; }
if (!forgeryRejected) throw new Error('SELF_CONSISTENT_FORGERY_CHECK_FAILED');

const truncationInput = { ...receiptInput, auditTipId: '0'.repeat(64) };
let truncationRejected = false;
try { verifyStage4B3Receipt(receipt, truncationInput); } catch { truncationRejected = true; }
if (!truncationRejected) throw new Error('AUDIT_TRUNCATION_CHECK_FAILED');

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
const { readFile } = require('node:fs/promises');
const outputSha256 = createHash('sha256').update(await readFile(output)).digest('hex');

console.log('STAGE 4B3 SAFETY RECEIPT');
console.log('BLOCKED — NO ACTIVATION REVIEW READY STRATEGY');
console.log(`SOURCE_COMMIT=${sourceCommit}`);
console.log(`RECEIPT_ID=${receipt.receiptId}`);
console.log(`4B2_RECEIPT_ID=${STAGE_4B2_RECEIPT_ID}`);
console.log(`4B2_SOURCE_COMMIT=${STAGE_4B2_SOURCE_COMMIT}`);
console.log(`SAFETY_DECISION_ID=${decision.decisionId}`);
console.log(`AUDIT_ROOT=${audit.all[0].eventId}`);
console.log(`AUDIT_TIP=${audit.tipId}`);
console.log('KILL_SWITCH_ENABLED=false');
console.log('RECOVERY_STATUS=NONE');
console.log('RUNTIME_STARTED=false');
console.log('PAPER_APPROVED=false');
console.log('TESTNET_APPROVED=false');
console.log('LIVE_APPROVED=false');
console.log(`OUTPUT_SHA256=${outputSha256}`);
console.log('RECEIPT_VERIFY=PASS');
console.log('TAMPER_CHECK=PASS');
console.log('TRUST_ROOT_TAMPER_CHECK=PASS');
console.log('SELF_CONSISTENT_FORGERY_CHECK=PASS');
console.log('AUDIT_TRUNCATION_CHECK=PASS');
