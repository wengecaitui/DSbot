/**
 * Deterministic proof of the reference shadow-runtime infrastructure.
 *
 * REFERENCE SHADOW INFRASTRUCTURE PROOF ONLY.
 * NOT A STRATEGY BACKTEST.
 * NOT APPROVED FOR PAPER, TESTNET OR LIVE.
 */
import * as crypto from 'node:crypto';
import fs = require('node:fs');
import { canonicalSerialize } from './CanonicalJson';
import { ShadowEventLedger } from './ShadowEventLedger';
import { loadSnapshot } from './ShadowRuntimeSnapshot';

export const SHADOW_RUNTIME_PROOF_SCHEMA_VERSION =
  'cloddsbot.shadow.runtime-proof.v1' as const;
export const STAGE_4B4_2_BASELINE =
  '36195a6ddc4a757afdc28a23cdccb42653601368' as const;

const PROOF_SCOPE = 'REFERENCE SHADOW INFRASTRUCTURE PROOF ONLY' as const;
const APPROVAL_STATEMENT = 'NOT APPROVED FOR PAPER, TESTNET OR LIVE' as const;
const PROOF_DOMAIN = 'CLODDSBOT_SHADOW_RUNTIME_PROOF\u0000v1\u0000';
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

export interface ShadowRuntimeProofContext {
  readonly sourceCommit: string;
  readonly implementationBaseline: string;
  readonly ledgerFile: string;
  readonly snapshotFile: string;
}

export interface ShadowRuntimeProof {
  readonly schemaVersion: typeof SHADOW_RUNTIME_PROOF_SCHEMA_VERSION;
  readonly proofScope: typeof PROOF_SCOPE;
  readonly strategyBacktest: false;
  readonly approvalStatement: typeof APPROVAL_STATEMENT;
  readonly sourceCommit: string;
  readonly implementationBaseline: string;
  readonly runtimeState: 'STOPPED';
  readonly ledgerSize: number;
  readonly ledgerDigest: string;
  readonly snapshotId: string;
  readonly ledgerSha256: string;
  readonly snapshotSha256: string;
  readonly eventIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly zeroAdapterCalls: 0;
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
  readonly proofId: string;
}

type ProofWithoutId = Omit<ShadowRuntimeProof, 'proofId'>;

const PROOF_KEYS = Object.freeze([
  'schemaVersion', 'proofScope', 'strategyBacktest', 'approvalStatement',
  'sourceCommit', 'implementationBaseline', 'runtimeState', 'ledgerSize',
  'ledgerDigest', 'snapshotId', 'ledgerSha256', 'snapshotSha256', 'eventIds',
  'observationIds', 'zeroAdapterCalls', 'paperApproved', 'testnetApproved',
  'liveApproved', 'proofId',
] as const);

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function proofIdOf(value: ProofWithoutId): string {
  return 'srp-' + sha256(PROOF_DOMAIN + canonicalSerialize(value));
}

function assertContext(context: ShadowRuntimeProofContext): void {
  if (context === null || typeof context !== 'object') {
    throw new Error('ShadowRuntimeProof: context must be an object');
  }
  if (!GIT_SHA.test(context.sourceCommit)) {
    throw new Error('ShadowRuntimeProof: sourceCommit must be a lowercase 40-hex Git SHA');
  }
  if (!GIT_SHA.test(context.implementationBaseline)) {
    throw new Error('ShadowRuntimeProof: implementationBaseline must be a lowercase 40-hex Git SHA');
  }
  if (typeof context.ledgerFile !== 'string' || context.ledgerFile.length === 0 ||
      typeof context.snapshotFile !== 'string' || context.snapshotFile.length === 0) {
    throw new Error('ShadowRuntimeProof: ledgerFile and snapshotFile must be non-empty strings');
  }
}

function readStable(filePath: string): Buffer {
  const before = fs.statSync(filePath);
  if (!before.isFile()) throw new Error('ShadowRuntimeProof: evidence path is not a regular file');
  const bytes = fs.readFileSync(filePath);
  const after = fs.statSync(filePath);
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || after.size !== bytes.length ||
      before.mtimeMs !== after.mtimeMs) {
    throw new Error('ShadowRuntimeProof: evidence changed while being read');
  }
  return bytes;
}

function freezeProof(value: ShadowRuntimeProof): ShadowRuntimeProof {
  Object.freeze(value.eventIds);
  Object.freeze(value.observationIds);
  return Object.freeze(value);
}

function deriveProof(context: ShadowRuntimeProofContext): ShadowRuntimeProof {
  assertContext(context);

  // An empty ledger is represented by an absent file. Validate that state via
  // the domain readers before requiring raw bytes for a non-empty proof.
  const initialLedger = new ShadowEventLedger(context.ledgerFile);
  const initialSnapshot = loadSnapshot(context.snapshotFile, initialLedger);
  if (initialLedger.size < 1) {
    throw new Error('ShadowRuntimeProof: an empty ledger cannot prove shadow intent handling');
  }
  if (initialSnapshot.ledgerSize !== initialLedger.size) {
    throw new Error('ShadowRuntimeProof: initial evidence is not an exact snapshot');
  }

  const ledgerBefore = readStable(context.ledgerFile);
  const snapshotBefore = readStable(context.snapshotFile);
  const ledger = new ShadowEventLedger(context.ledgerFile);
  const snapshot = loadSnapshot(context.snapshotFile, ledger);
  const ledgerAfter = readStable(context.ledgerFile);
  const snapshotAfter = readStable(context.snapshotFile);

  if (!ledgerBefore.equals(ledgerAfter) || !snapshotBefore.equals(snapshotAfter)) {
    throw new Error('ShadowRuntimeProof: evidence changed during verification');
  }
  if (snapshot.shadowState !== 'STOPPED' || snapshot.ledgerSize !== ledger.size ||
      snapshot.boundarySize !== ledger.size || snapshot.ledgerDigest !== ledger.latestDigest) {
    throw new Error('ShadowRuntimeProof: snapshot is not the exact current STOPPED snapshot');
  }

  const entries = ledger.getEntries();
  if (!entries.some(entry => entry.observation.decision === 'trade')) {
    throw new Error('ShadowRuntimeProof: at least one reference trade intent is required');
  }
  const ledgerDigest = ledger.latestDigest;
  if (ledgerDigest === null) {
    throw new Error('ShadowRuntimeProof: non-empty ledger has no digest');
  }

  const withoutId: ProofWithoutId = {
    schemaVersion: SHADOW_RUNTIME_PROOF_SCHEMA_VERSION,
    proofScope: PROOF_SCOPE,
    strategyBacktest: false,
    approvalStatement: APPROVAL_STATEMENT,
    sourceCommit: context.sourceCommit,
    implementationBaseline: context.implementationBaseline,
    runtimeState: 'STOPPED',
    ledgerSize: ledger.size,
    ledgerDigest,
    snapshotId: snapshot.snapshotId,
    ledgerSha256: sha256(ledgerAfter),
    snapshotSha256: sha256(snapshotAfter),
    eventIds: entries.map(entry => entry.event.eventId),
    observationIds: entries.map(entry => entry.observation.observationId),
    zeroAdapterCalls: 0,
    paperApproved: false,
    testnetApproved: false,
    liveApproved: false,
  };
  return freezeProof({ ...withoutId, proofId: proofIdOf(withoutId) });
}

export function createShadowRuntimeProof(
  context: ShadowRuntimeProofContext,
): ShadowRuntimeProof {
  return deriveProof(context);
}

function extractDataObject(value: unknown): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    const object = value as object;
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(object).length !== 0) return null;
    const names = Object.getOwnPropertyNames(object);
    if (names.length !== PROOF_KEYS.length ||
        !PROOF_KEYS.every(key => names.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(object);
    const copy: Record<string, unknown> = {};
    for (const key of PROOF_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined ||
          descriptor.enumerable !== true) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function extractStringArray(value: unknown): string[] | null {
  try {
    if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as
      Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || lengthDescriptor.get !== undefined ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return null;
    const length = lengthDescriptor.value as number;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== length + 1) return null;
    const result: string[] = [];
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined ||
          descriptor.enumerable !== true || typeof descriptor.value !== 'string') return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

/** Fail-closed verification against the current evidence bytes and context. */
export function verifyShadowRuntimeProof(
  artifact: unknown,
  context: ShadowRuntimeProofContext,
): ShadowRuntimeProof | null {
  const extracted = extractDataObject(artifact);
  if (!extracted) return null;
  const eventIds = extractStringArray(extracted.eventIds);
  const observationIds = extractStringArray(extracted.observationIds);
  if (!eventIds || !observationIds) return null;

  let expected: ShadowRuntimeProof;
  try {
    expected = deriveProof(context);
  } catch {
    return null;
  }

  const candidate: Record<string, unknown> = {
    ...extracted,
    eventIds,
    observationIds,
  };
  for (const key of PROOF_KEYS) {
    if (key === 'eventIds' || key === 'observationIds') continue;
    if (candidate[key] !== expected[key]) return null;
  }
  if (eventIds.length !== expected.eventIds.length ||
      eventIds.some((id, index) => id !== expected.eventIds[index])) return null;
  if (observationIds.length !== expected.observationIds.length ||
      observationIds.some((id, index) => id !== expected.observationIds[index])) return null;

  return expected;
}
