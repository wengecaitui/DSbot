/**
 * ShadowRuntimeSnapshot — deterministic derivative snapshot of
 * ShadowEventLedger + ShadowIntentBoundary + ShadowRuntimeStateMachine.
 *
 * Stage 4B4.2: fail-closed snapshot verification with prefix proof,
 * tamper detection, and atomic durable storage.
 *
 * REFERENCE SHADOW INFRASTRUCTURE ONLY.
 * NOT APPROVED FOR PAPER TESTNET OR LIVE.
 */
import * as crypto from 'node:crypto';
import fs = require('node:fs');
import * as path from 'node:path';
import { canonicalSerialize } from './CanonicalJson';
import type { ShadowEventLedger, ShadowLedgerEntry } from './ShadowEventLedger';
import type { ShadowIntentBoundary } from './ShadowIntentBoundary';
import type { ShadowRuntimeStateMachine } from './ShadowRuntimeStateMachine';

// ─── Types ───────────────────────────────────────────────────────────────────

export const SNAPSHOT_SCHEMA_VERSION = 'cloddsbot.shadow.snapshot.v1' as const;

export interface ShadowRuntimeSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly shadowState: string;
  readonly ledgerSize: number;
  readonly ledgerDigest: string | null;
  readonly lastEventId: string | null;
  readonly lastObservationId: string | null;
  readonly boundarySize: number;
  readonly snapshotId: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SNAP_DOMAIN = 'CLODDSBOT_SHADOW_SNAPSHOT\u0000v1\u0000';
const SNAP_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion', 'shadowState', 'ledgerSize', 'ledgerDigest',
  'lastEventId', 'lastObservationId', 'boundarySize', 'snapshotId',
]);
const SNAP_ALLOWED_STATES: ReadonlySet<string> = new Set([
  'STOPPED', 'PRECHECKED', 'SHADOW_READY', 'SHADOW_ACTIVE',
  'PAUSED', 'RECOVERY_REQUIRED', 'FAILED',
]);

// ─── Schema helpers ──────────────────────────────────────────────────────────

function isStrictPlainObject(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(obj).length > 0) return false;
  return true;
}

// ─── Symlink detection ───────────────────────────────────────────────────────

function isSymlinkOrJunction(target: string): boolean {
  try {
    const lstat = fs.lstatSync(target);
    if (lstat.isSymbolicLink()) return true;
    if (process.platform === 'win32') {
      try {
        const stat = fs.statSync(target);
        if (stat.ino !== lstat.ino) return true;
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function pathChainContainsSymlink(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (isSymlinkOrJunction(resolved)) return true;
  let current = path.dirname(resolved);
  const root = path.parse(current).root;
  while (current !== root && current !== path.dirname(current)) {
    if (isSymlinkOrJunction(current)) return true;
    current = path.dirname(current);
    if (current === path.dirname(current)) break;
  }
  if (current !== filePath && isSymlinkOrJunction(current)) return true;
  return false;
}

// ─── Create snapshot ─────────────────────────────────────────────────────────

export function createShadowRuntimeSnapshot(
  ledger: ShadowEventLedger,
  boundary: ShadowIntentBoundary,
  sm: ShadowRuntimeStateMachine,
): ShadowRuntimeSnapshot {
  const entries = ledger.getEntries();
  const ledgerSize = entries.length;

  let ledgerDigest: string | null = null;
  let lastEventId: string | null = null;
  let lastObservationId: string | null = null;

  if (ledgerSize > 0) {
    const lastEntry = entries[ledgerSize - 1];
    ledgerDigest = lastEntry.entryDigest;
    lastEventId = lastEntry.event.eventId;
    lastObservationId = lastEntry.observation.observationId;
  }

  const snapshotWithoutId: Omit<ShadowRuntimeSnapshot, 'snapshotId'> = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    shadowState: sm.state,
    ledgerSize,
    ledgerDigest,
    lastEventId,
    lastObservationId,
    boundarySize: boundary.size,
  };

  const snapshotId = computeSnapshotId(snapshotWithoutId);

  const snapshot: ShadowRuntimeSnapshot = {
    ...snapshotWithoutId,
    snapshotId,
  };

  Object.freeze(snapshot);
  return snapshot;
}

function computeSnapshotId(snap: Omit<ShadowRuntimeSnapshot, 'snapshotId'>): string {
  const preimage = SNAP_DOMAIN + canonicalSerialize(snap);
  return 'ss-' + crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// ─── Verify snapshot ─────────────────────────────────────────────────────────

/**
 * Verify a snapshot's integrity against the ledger.
 *
 * Contract (4B4.2):
 * - For ledgerSize N>0, compare ledgerDigest to entries[N-1].entryDigest (exact prefix proof),
 *   NOT ledger.latestDigest.
 * - Require boundarySize === ledgerSize.
 * - A valid stale prefix verifies; a mismatched/tampered prefix does not.
 */
export function verifyShadowRuntimeSnapshot(
  value: unknown,
  ledger: ShadowEventLedger,
): ShadowRuntimeSnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  if (!isStrictPlainObject(value as object)) return null;

  const descs = Object.getOwnPropertyDescriptors(value as object);
  const ownKeys = Object.getOwnPropertyNames(value as object);

  if (ownKeys.length !== SNAP_KEYS.size) return null;
  for (const key of ownKeys) {
    if (!SNAP_KEYS.has(key)) return null;
    const d = descs[key];
    if (d.get !== undefined || d.set !== undefined) return null;
    if (d.enumerable !== true) return null;
  }

  const getOwn = (key: string): unknown => {
    const d = descs[key];
    if (!d || d.get !== undefined || d.set !== undefined) return undefined;
    return d.value;
  };

  const schemaVersion = getOwn('schemaVersion');
  const shadowState = getOwn('shadowState');
  const ledgerSize = getOwn('ledgerSize');
  const ledgerDigest = getOwn('ledgerDigest');
  const lastEventId = getOwn('lastEventId');
  const lastObservationId = getOwn('lastObservationId');
  const boundarySize = getOwn('boundarySize');
  const snapshotId = getOwn('snapshotId');

  if (schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
  if (typeof shadowState !== 'string' || !SNAP_ALLOWED_STATES.has(shadowState as string)) return null;
  if (!Number.isSafeInteger(ledgerSize) || (ledgerSize as number) < 0) return null;
  if (!Number.isSafeInteger(boundarySize) || (boundarySize as number) < 0) return null;

  if (typeof snapshotId !== 'string' || !/^ss-[a-f0-9]{64}$/.test(snapshotId as string)) return null;

  // Contract: boundarySize === ledgerSize
  if (boundarySize !== ledgerSize) return null;

  // ledgerDigest/lastEventId/lastObservationId: null when size=0, string when size>0
  const sz = ledgerSize as number;
  if (sz === 0) {
    if (ledgerDigest !== null) return null;
    if (lastEventId !== null) return null;
    if (lastObservationId !== null) return null;
  } else {
    if (typeof ledgerDigest !== 'string' || !/^[a-f0-9]{64}$/.test(ledgerDigest as string)) return null;
    if (typeof lastEventId !== 'string' || !/^se-[a-f0-9]{64}$/.test(lastEventId as string)) return null;
    if (typeof lastObservationId !== 'string' || !/^so-[a-f0-9]{64}$/.test(lastObservationId as string)) return null;
  }

  // Prove ledger prefix: ledgerSize <= actual size
  const actualSize = ledger.size;
  if (sz > actualSize) return null;

  // Contract: for sz > 0, ledgerDigest must match entries[sz-1].entryDigest (exact prefix),
  // NOT ledger.latestDigest.
  if (sz > 0) {
    const entries = ledger.getEntries();
    const prefixEntry = entries[sz - 1];
    if (ledgerDigest !== prefixEntry.entryDigest) return null;
    if (lastEventId !== prefixEntry.event.eventId) return null;
    if (lastObservationId !== prefixEntry.observation.observationId) return null;
  }

  // Recompute snapshotId
  const snapWithoutId = {
    schemaVersion,
    shadowState,
    ledgerSize,
    ledgerDigest,
    lastEventId,
    lastObservationId,
    boundarySize,
  };

  const computedId = computeSnapshotId(snapWithoutId as any);
  if (computedId !== snapshotId) return null;

  // Build verified snapshot from descriptor values
  const verified: Record<string, unknown> = {
    schemaVersion,
    shadowState,
    ledgerSize,
    ledgerDigest,
    lastEventId,
    lastObservationId,
    boundarySize,
    snapshotId,
  };
  Object.freeze(verified);

  return verified as unknown as ShadowRuntimeSnapshot;
}

// ─── Snapshot store ──────────────────────────────────────────────────────────

/**
 * Store a snapshot durably.
 *
 * Contract (4B4.2):
 * - Verifies the supplied snapshot against the ledger before writing.
 * - Strict canonical UTF-8, same-directory atomic replacement, fsync, close.
 * - Exact post-write verification (read-back, canonical re-parse, re-verify).
 * - Path/link checks.
 * - Fail-closed on any write/fsync/close/rename/post-write failure.
 */
export function storeSnapshot(
  snapshot: ShadowRuntimeSnapshot,
  ledger: ShadowEventLedger,
  filePath: string,
): void {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('storeSnapshot: filePath must be a non-empty string');
  }

  const resolved = path.resolve(filePath);

  if (pathChainContainsSymlink(resolved)) {
    throw new Error('storeSnapshot: path contains symlink/junction/reparse point; rejected fail-closed');
  }

  const parentDir = path.dirname(resolved);
  let parentStat: import('node:fs').Stats;
  try {
    parentStat = fs.statSync(parentDir);
  } catch (err) {
    throw new Error(`storeSnapshot: parent directory does not exist or is inaccessible: ${parentDir}`);
  }
  if (!parentStat.isDirectory()) {
    throw new Error(`storeSnapshot: parent path is not a directory: ${parentDir}`);
  }

  // Contract: verify snapshot against ledger before writing
  const verified = verifyShadowRuntimeSnapshot(snapshot, ledger);
  if (!verified) {
    throw new Error('storeSnapshot: snapshot verification failed — tampered input rejected');
  }

  // Serialize to canonical JSON using verified values (not caller input)
  const snapshotWithoutId: Record<string, unknown> = {
    schemaVersion: verified.schemaVersion,
    shadowState: verified.shadowState,
    ledgerSize: verified.ledgerSize,
    ledgerDigest: verified.ledgerDigest,
    lastEventId: verified.lastEventId,
    lastObservationId: verified.lastObservationId,
    boundarySize: verified.boundarySize,
  };

  const recomputedId = computeSnapshotId(snapshotWithoutId as any);
  const fullJson = canonicalSerialize({
    ...snapshotWithoutId,
    snapshotId: recomputedId,
  });
  const fullLine = fullJson + '\n';

  // Write to temp file, fsync, atomic replace
  const tmpFile = resolved + '.tmp.' + crypto.randomBytes(8).toString('hex');

  let fd: number | undefined;
  let ioError: unknown;
  try {
    // Use writeFileSync with utf-8 encoding for strict canonical output
    fs.writeFileSync(tmpFile, fullLine, { encoding: 'utf-8', flag: 'w' });
    fd = fs.openSync(tmpFile, 'r+');
    fs.fsyncSync(fd);
  } catch (err) {
    ioError = err;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (closeErr) {
        // Capture close error if no prior write/fsync error
        if (ioError === undefined) ioError = closeErr;
      }
    }
  }

  if (ioError !== undefined) {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error(`storeSnapshot: write/fsync/close failed: ${(ioError as Error).message}`);
  }

  // Post-write verification on temp file: read back and re-verify
  let tmpBuf: Buffer;
  try {
    tmpBuf = fs.readFileSync(tmpFile);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error(`storeSnapshot: temp file read-back failed: ${(err as Error).message}`);
  }

  // Strict UTF-8 decode
  let tmpRaw: string;
  try {
    const strictDecoder = new TextDecoder('utf-8', { fatal: true });
    tmpRaw = strictDecoder.decode(tmpBuf);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error(`storeSnapshot: temp file invalid UTF-8: ${(err as Error).message}`);
  }

  // Verify trailing LF
  if (!tmpRaw.endsWith('\n')) {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error('storeSnapshot: temp file missing trailing LF; fail-closed');
  }

  // Verify exactly one line
  const trimmed = tmpRaw.slice(0, -1);
  if (trimmed.includes('\n')) {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error('storeSnapshot: temp file contains multiple lines; fail-closed');
  }

  // Parse and verify canonical JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error('storeSnapshot: temp file malformed JSON; fail-closed');
  }

  const recanonicalized = canonicalSerialize(parsed);
  if (trimmed !== recanonicalized) {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error('storeSnapshot: temp file non-canonical JSON; fail-closed');
  }

  // Re-verify the parsed snapshot against ledger
  const reVerified = verifyShadowRuntimeSnapshot(parsed, ledger);
  if (!reVerified || reVerified.snapshotId !== recomputedId) {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error('storeSnapshot: post-write re-verification failed; fail-closed');
  }

  // Check that tmpFile is a regular file (not replaced by symlink during write)
  try {
    const tmpStat = fs.lstatSync(tmpFile);
    if (!tmpStat.isFile()) {
      try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
      throw new Error('storeSnapshot: temp file is not a regular file; fail-closed');
    }
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error(`storeSnapshot: temp file stat failed: ${(err as Error).message}`);
  }

  // Atomic rename (same-directory, works on Windows for existing targets)
  try {
    fs.renameSync(tmpFile, resolved);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    throw new Error(`storeSnapshot: atomic rename failed: ${(err as Error).message}`);
  }

  // Post-rename verification: read back the final file
  let finalBuf: Buffer;
  try {
    finalBuf = fs.readFileSync(resolved);
  } catch (err) {
    throw new Error(`storeSnapshot: final file read-back failed: ${(err as Error).message}`);
  }

  if (finalBuf.length !== tmpBuf.length || !finalBuf.equals(tmpBuf)) {
    throw new Error('storeSnapshot: post-rename content mismatch; fail-closed');
  }

  // Final path/link check
  if (pathChainContainsSymlink(resolved)) {
    throw new Error('storeSnapshot: symlink detected after write; fail-closed');
  }
}

// ─── Load snapshot ───────────────────────────────────────────────────────────

export function loadSnapshot(
  filePath: string,
  ledger: ShadowEventLedger,
): ShadowRuntimeSnapshot {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('loadSnapshot: filePath must be a non-empty string');
  }

  const resolved = path.resolve(filePath);

  if (pathChainContainsSymlink(resolved)) {
    throw new Error('loadSnapshot: path contains symlink/junction/reparse point; rejected fail-closed');
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`loadSnapshot: file does not exist: ${resolved}`);
  }

  const fileBuf = fs.readFileSync(resolved);

  // Check BOM in raw bytes
  if (fileBuf.length >= 3 &&
      fileBuf[0] === 0xEF && fileBuf[1] === 0xBB && fileBuf[2] === 0xBF) {
    throw new Error('loadSnapshot: file contains BOM; rejected fail-closed');
  }

  // Strict UTF-8 decode
  const strictDecoder = new TextDecoder('utf-8', { fatal: true });
  let raw: string;
  try {
    raw = strictDecoder.decode(fileBuf);
  } catch (err) {
    throw new Error(`loadSnapshot: invalid UTF-8: ${(err as Error).message}`);
  }

  // BOM check after decode
  if (raw.charCodeAt(0) === 0xFEFF) {
    throw new Error('loadSnapshot: file contains BOM; rejected fail-closed');
  }

  // Must end with LF
  if (!raw.endsWith('\n')) {
    throw new Error('loadSnapshot: file does not end with trailing LF; rejected fail-closed');
  }

  // Must be exactly one line (single LF-terminated record)
  const trimmed = raw.slice(0, -1);
  if (trimmed.includes('\n')) {
    throw new Error('loadSnapshot: file contains multiple lines; rejected fail-closed');
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('loadSnapshot: malformed JSON; rejected fail-closed');
  }

  // Must be canonical JSON (re-serialize must match exactly)
  const recanonicalized = canonicalSerialize(parsed);
  if (trimmed !== recanonicalized) {
    throw new Error('loadSnapshot: non-canonical JSON; rejected fail-closed');
  }

  // Verify the parsed snapshot
  const verified = verifyShadowRuntimeSnapshot(parsed, ledger);
  if (!verified) {
    throw new Error('loadSnapshot: snapshot verification failed');
  }

  return verified;
}
