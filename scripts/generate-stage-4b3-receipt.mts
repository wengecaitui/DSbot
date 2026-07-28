#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../src/validation/RuntimeSafety');
const createStage4B3Receipt = mod.createStage4B3Receipt;
const verifyStage4B3Receipt = mod.verifyStage4B3Receipt;
const createBlockedSafetyAudit = mod.createBlockedSafetyAudit;
const KillSwitch = mod.KillSwitch;
const IdempotencyLedger = mod.IdempotencyLedger;
const RuntimeSafetyPolicy = mod.RuntimeSafetyPolicy;
const canonicalSha256 = require('../src/validation/ActivationContract').canonicalSha256;

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1]) throw new Error(`Missing value for ${name}`);
  return process.argv[index + 1];
}

const sourceCommit = argument('--source-commit', process.env.SOURCE_COMMIT);
const output = path.resolve(argument('--output', 'artifacts/stage-4b3-receipt.json')!);
const artifact4B1Path = argument('--artifact-4b1', 'docs/releases/stage-4b1-activation-contract.json')!;
if (!sourceCommit) throw new Error('SOURCE_COMMIT or --source-commit is required');

// ── Read raw 4B1 artifact (trust anchor) ──────────────────────────
const raw4B1 = await readFile(path.resolve(artifact4B1Path), 'utf8');
const stage4B1Artifact = JSON.parse(raw4B1);
const stage4B1ArtifactSourceSha256 = createHash('sha256').update(raw4B1).digest('hex');

// ── Regenerate 4B2 receipt from 4B1 artifact (no hardcoded IDs) ──
const PaperReadinessReview = require('../src/validation/PaperReadinessReview');
const createStage4B2Receipt = PaperReadinessReview.createStage4B2Receipt;
const verifyStage4B2Receipt = PaperReadinessReview.verifyStage4B2Receipt;
const STAGE_4A_CLOSURE_AUDIT_ID = 'af9dc5cbb832b32b0c403631b2805bcb93996d215c044a47a06e4b3347db40cc';
const STAGE_4B2_SOURCE_COMMIT = '81b0980f4fee168075a52c6ebcb12eb50f382217';

const stage4B2Receipt = createStage4B2Receipt({
  sourceCommit: STAGE_4B2_SOURCE_COMMIT,
  stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID,
  stage4B1Artifact,
  stage4B1ArtifactSourceSha256,
  generatedAt: '2026-07-28T00:00:00.000Z',
});
verifyStage4B2Receipt(stage4B2Receipt, {
  sourceCommit: STAGE_4B2_SOURCE_COMMIT,
  stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID,
  stage4B1Artifact,
  stage4B1ArtifactSourceSha256,
});

// ── 4B2 artifact SHA-256 (for binding) ─────────────────────────────
const stage4B2ArtifactJson = JSON.stringify(stage4B2Receipt);
const stage4B2ArtifactSha256 = createHash('sha256').update(stage4B2ArtifactJson).digest('hex');

// ── Build real safety state deterministically ──────────────────────
const audit = createBlockedSafetyAudit('2026-07-28T00:00:00.000Z');
const killSwitch = new KillSwitch();
const idempotencyLedger = new IdempotencyLedger();
const policy = new RuntimeSafetyPolicy(stage4B2Receipt.receiptId, sourceCommit, killSwitch, idempotencyLedger);

const decision = policy.evaluate({
  receiptId: stage4B2Receipt.receiptId,
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

// ── Build 4B3 receipt with verified 4B2 data ───────────────────────
const receiptInput = {
  sourceCommit,
  stage4B2ReceiptId: stage4B2Receipt.receiptId,
  stage4B2SourceCommit: stage4B2Receipt.sourceCommit,
  stage4B2ArtifactSha256,
  stage4B1ArtifactId: stage4B2Receipt.stage4B1ArtifactId,
  stage4B1ProofId: stage4B2Receipt.stage4B1ProofId,
  stage4B1DecisionId: stage4B2Receipt.stage4B1DecisionId,
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

// ── Independent trust-chain re-verification ────────────────────────
// Passes raw 4B1 artifact — verifier re-derives 4B2 receipt itself
const verified4B2 = verifyStage4B3Receipt(receipt, stage4B1Artifact, stage4B1ArtifactSourceSha256);

// ── Tamper checks ──────────────────────────────────────────────────

// 1. Alter receipt field
const tampered = structuredClone(receipt);
(tampered as any).paperApproved = true;
let tamperRejected = false;
try { verifyStage4B3Receipt(tampered, stage4B1Artifact, stage4B1ArtifactSourceSha256); } catch { tamperRejected = true; }
if (!tamperRejected) throw new Error('TAMPER_CHECK_FAILED');

// 2. Alter source commit (trust-root replacement)
const tamperedSha = structuredClone(receipt);
(tamperedSha as any).sourceCommit = '0'.repeat(40);
// Changing sourceCommit changes receiptId (fails self-consistent check)
let shaRejected = false;
try { verifyStage4B3Receipt(tamperedSha, stage4B1Artifact, stage4B1ArtifactSourceSha256); } catch { shaRejected = true; }
if (!shaRejected) throw new Error('TRUST_ROOT_TAMPER_CHECK_FAILED');

// 3. Self-consistent forgery — alter receipt ID
const forged = structuredClone(receipt);
(forged as any).receiptId = 'f'.repeat(64);
let forgeryRejected = false;
try { verifyStage4B3Receipt(forged, stage4B1Artifact, stage4B1ArtifactSourceSha256); } catch { forgeryRejected = true; }
if (!forgeryRejected) throw new Error('SELF_CONSISTENT_FORGERY_CHECK_FAILED');

// 4. Mismatched 4B2 receipt ID in binding
const bad4B2Binding = structuredClone(receipt);
(bad4B2Binding as any).stage4B2ReceiptId = '0'.repeat(64);
// This changes receiptId (field is in the body), so self-consistent check catches it
// Additional: tampered receipt id will not match computed → SELF_CONSISTENT_FORGERY
let bindingRejected = false;
try { verifyStage4B3Receipt(bad4B2Binding, stage4B1Artifact, stage4B1ArtifactSourceSha256); } catch { bindingRejected = true; }
if (!bindingRejected) throw new Error('4B2_RECEIPT_ID_BINDING_CHECK_FAILED');

// 5. Mismatched artifact SHA-256
const badSha256 = structuredClone(receipt);
(badSha256 as any).stage4B2ArtifactSha256 = '0'.repeat(64);
let sha256Rejected = false;
try { verifyStage4B3Receipt(badSha256, stage4B1Artifact, stage4B1ArtifactSourceSha256); } catch { sha256Rejected = true; }
if (!sha256Rejected) throw new Error('ARTIFACT_SHA256_BINDING_CHECK_FAILED');

// 6. Wrong 4B1 artifact (caller trust-root replacement) — passes different 4B1 artifact
const fake4B1 = structuredClone(stage4B1Artifact);
(fake4B1 as any).eligibilityProof.proofId = 'f'.repeat(64);
let fake4B1Rejected = false;
try { verifyStage4B3Receipt(receipt, fake4B1, stage4B1ArtifactSourceSha256); } catch { fake4B1Rejected = true; }
if (!fake4B1Rejected) throw new Error('FAKE_4B1_ARTIFACT_CHECK_FAILED');

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
const outputSha256 = createHash('sha256').update(await readFile(output)).digest('hex');

console.log('STAGE 4B3 SAFETY RECEIPT');
console.log('BLOCKED — NO ACTIVATION REVIEW READY STRATEGY');
console.log(`SOURCE_COMMIT=${sourceCommit}`);
console.log(`RECEIPT_ID=${receipt.receiptId}`);
console.log(`4B2_RECEIPT_ID=${receipt.stage4B2ReceiptId}`);
console.log(`4B2_SOURCE_COMMIT=${receipt.stage4B2SourceCommit}`);
console.log(`4B2_ARTIFACT_SHA256=${receipt.stage4B2ArtifactSha256}`);
console.log(`4B1_ARTIFACT_ID=${receipt.stage4B1ArtifactId}`);
console.log(`4B1_PROOF_ID=${receipt.stage4B1ProofId}`);
console.log(`4B1_DECISION_ID=${receipt.stage4B1DecisionId}`);
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
console.log('4B2_RECEIPT_ID_BINDING_CHECK=PASS');
console.log('ARTIFACT_SHA256_BINDING_CHECK=PASS');
console.log('FAKE_4B1_ARTIFACT_CHECK=PASS');
