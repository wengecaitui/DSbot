/**
 * ShadowEventLedger — append-only, restart-verifiable ledger for shadow observations.
 *
 * REFERENCE SHADOW INFRASTRUCTURE ONLY.
 * NOT APPROVED FOR PAPER TESTNET OR LIVE.
 */
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');
import { canonicalSerialize } from './CanonicalJson';
import type { CanonicalShadowEvent } from './CanonicalShadowEvent';
import { verifyCanonicalShadowEvent } from './CanonicalShadowEvent';
import type { ShadowIntentObservation } from './ShadowIntentObservation';
import { verifyShadowIntentObservation } from './ShadowIntentObservation';

// ─── Types ───────────────────────────────────────────────────────────────────

export const LEDGER_ENTRY_SCHEMA_VERSION = 'cloddsbot.shadow.ledger-entry.v1' as const;

export interface ShadowLedgerEntry {
  readonly schemaVersion: typeof LEDGER_ENTRY_SCHEMA_VERSION;
  readonly ledgerSequence: number;
  readonly previousEntryDigest: string;
  readonly event: CanonicalShadowEvent;
  readonly observation: ShadowIntentObservation;
  readonly entryDigest: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GENESIS_DIGEST = '0'.repeat(64);
const DOMAIN_SEPARATOR = 'CLODDSBOT_SHADOW_LEDGER_ENTRY\u0000v1\u0000';

// ─── Entry digest computation ─────────────────────────────────────────────────

function computeEntryDigest(entry: Omit<ShadowLedgerEntry, 'entryDigest'>): string {
  const preimage = DOMAIN_SEPARATOR + canonicalSerialize({
    schemaVersion: entry.schemaVersion,
    ledgerSequence: entry.ledgerSequence,
    previousEntryDigest: entry.previousEntryDigest,
    event: entry.event,
    observation: entry.observation,
  });
  return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// ─── Symlink / path-chain detection ──────────────────────────────────────────

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

// ─── Strict UTF-8 decoder ────────────────────────────────────────────────────

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

// ─── Deep-freeze helper ──────────────────────────────────────────────────────

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.getOwnPropertyNames(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
}

// ─── Ledger implementation ────────────────────────────────────────────────────

export class ShadowEventLedger {
  readonly #filePath: string;
  #entries: ShadowLedgerEntry[] = [];
  #verifiedSize: number = 0;
  #verifiedDigest: string | null = null;
  #verifiedExists: boolean = false;
  #verifiedFileIdentity: { readonly dev: number; readonly ino: number } | null = null;

  constructor(filePath: string) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('ShadowEventLedger: filePath must be a non-empty string');
    }

    this.#filePath = path.resolve(filePath);

    if (pathChainContainsSymlink(this.#filePath)) {
      throw new Error('ShadowEventLedger: path contains symlink/junction/reparse point; rejected fail-closed');
    }

    const parentDir = path.dirname(this.#filePath);
    let parentStat: Stats;
    try {
      parentStat = fs.statSync(parentDir);
    } catch (err) {
      throw new Error(`ShadowEventLedger: parent directory does not exist or is inaccessible: ${parentDir}`);
    }
    if (!parentStat.isDirectory()) {
      throw new Error(`ShadowEventLedger: parent path is not a directory: ${parentDir}`);
    }

    if (fs.existsSync(this.#filePath)) {
      const targetStat = fs.statSync(this.#filePath);
      if (targetStat.isDirectory()) {
        throw new Error(`ShadowEventLedger: target is a directory, not a regular file: ${this.#filePath}`);
      }
      if (!targetStat.isFile()) {
        throw new Error(`ShadowEventLedger: target is not a regular file: ${this.#filePath}`);
      }
    }

    this.#openAndVerify();
  }

  // ─── Public read-only API ────────────────────────────────────────────────

  get size(): number {
    return this.#entries.length;
  }

  get latestDigest(): string | null {
    if (this.#entries.length === 0) return null;
    return this.#entries[this.#entries.length - 1].entryDigest;
  }

  getEntries(): readonly ShadowLedgerEntry[] {
    const snapshots: ShadowLedgerEntry[] = this.#entries.map(e => {
      const copy = { ...e };
      deepFreeze(copy);
      return copy;
    });
    return Object.freeze(snapshots);
  }

  getByEventId(eventId: string): ShadowLedgerEntry | null {
    const entry = this.#entries.find(e => e.event.eventId === eventId);
    if (!entry) return null;
    const copy = { ...entry };
    deepFreeze(copy);
    return copy;
  }

  // ─── Append ────────────────────────────────────────────────────────────────

  append(event: CanonicalShadowEvent, observation: ShadowIntentObservation): { duplicate: boolean } {
    const verifiedEvent = verifyCanonicalShadowEvent(event);
    if (!verifiedEvent) {
      throw new Error('ShadowEventLedger.append: event verification failed');
    }

    const verifiedObs = verifyShadowIntentObservation(observation, verifiedEvent);
    if (!verifiedObs) {
      throw new Error('ShadowEventLedger.append: observation verification failed');
    }

    if (verifiedObs.sourceEventId !== verifiedEvent.eventId) {
      throw new Error('ShadowEventLedger.append: observation sourceEventId does not match event.eventId');
    }

    const existingByEventId = this.#entries.find(e => e.event.eventId === verifiedEvent.eventId);
    if (existingByEventId) {
      if (existingByEventId.observation.observationId === verifiedObs.observationId) {
        this.#checkExternalModification();
        return { duplicate: true };
      }
      throw new Error('ShadowEventLedger.append: eventId already exists with different observation');
    }

    const existingByObsId = this.#entries.find(e =>
      e.observation.observationId === verifiedObs.observationId);
    if (existingByObsId) {
      throw new Error('ShadowEventLedger.append: observationId already exists with different event');
    }

    const verifiedPreviousBytes = this.#checkExternalModification();

    const previousDigest = this.#entries.length === 0
      ? GENESIS_DIGEST
      : this.#entries[this.#entries.length - 1].entryDigest;

    const entryWithoutDigest: Omit<ShadowLedgerEntry, 'entryDigest'> = {
      schemaVersion: LEDGER_ENTRY_SCHEMA_VERSION,
      ledgerSequence: this.#entries.length,
      previousEntryDigest: previousDigest,
      event: verifiedEvent,
      observation: verifiedObs,
    };

    const entryDigest = computeEntryDigest(entryWithoutDigest);

    const entry: ShadowLedgerEntry = {
      ...entryWithoutDigest,
      entryDigest,
    };

    deepFreeze(entry);

    const line = canonicalSerialize(entry) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf-8');

    let fd: number | undefined;
    let ioError: unknown;
    try {
      fs.appendFileSync(this.#filePath, line, { encoding: 'utf-8' });

      fd = fs.openSync(this.#filePath, 'r+');
      fs.fsyncSync(fd);
    } catch (err) {
      ioError = err;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (closeError) {
          if (ioError === undefined) ioError = closeError;
        }
      }
    }
    if (ioError !== undefined) {
      throw new Error(`ShadowEventLedger.append: write/fsync/close failed: ${(ioError as Error).message}`);
    }

    // Post-write verification: all checks must succeed before mutating in-memory state
    const fileBuf = fs.readFileSync(this.#filePath);
    const postWriteStat = fs.statSync(this.#filePath);
    const actualSize = fileBuf.length;
    const expectedSize = this.#verifiedSize + lineBytes;
    if (!postWriteStat.isFile() || actualSize !== expectedSize || postWriteStat.size !== expectedSize) {
      throw new Error(
        `ShadowEventLedger.append: post-write size mismatch (expected ${expectedSize}, got bytes=${actualSize}, stat=${postWriteStat.size}); fail-closed`,
      );
    }

    const expectedBytes = Buffer.concat([
      verifiedPreviousBytes,
      Buffer.from(line, 'utf8'),
    ]);
    if (!fileBuf.equals(expectedBytes)) {
      throw new Error('ShadowEventLedger.append: post-write content mismatch; fail-closed');
    }

    if (this.#verifiedFileIdentity !== null &&
        (postWriteStat.dev !== this.#verifiedFileIdentity.dev ||
         postWriteStat.ino !== this.#verifiedFileIdentity.ino)) {
      throw new Error('ShadowEventLedger.append: post-write file identity changed; fail-closed');
    }

    const newDigest = crypto.createHash('sha256').update(fileBuf).digest('hex');

    if (pathChainContainsSymlink(this.#filePath)) {
      throw new Error('ShadowEventLedger.append: symlink detected after write; rejected fail-closed');
    }

    // Atomically commit in-memory state only after all verifications pass
    this.#entries.push(entry);
    this.#verifiedSize = actualSize;
    this.#verifiedDigest = newDigest;
    this.#verifiedExists = true;
    this.#verifiedFileIdentity = Object.freeze({
      dev: postWriteStat.dev,
      ino: postWriteStat.ino,
    });

    return { duplicate: false };
  }

  // ─── Private methods ──────────────────────────────────────────────────────

  #openAndVerify(): void {
    if (!fs.existsSync(this.#filePath)) {
      this.#verifiedSize = 0;
      this.#verifiedDigest = null;
      this.#verifiedExists = false;
      this.#verifiedFileIdentity = null;
      return;
    }

    const beforeReadStat = fs.statSync(this.#filePath);
    const fileBuf = fs.readFileSync(this.#filePath);
    const afterReadStat = fs.statSync(this.#filePath);
    if (!afterReadStat.isFile() ||
        beforeReadStat.dev !== afterReadStat.dev ||
        beforeReadStat.ino !== afterReadStat.ino ||
        afterReadStat.size !== fileBuf.length ||
        pathChainContainsSymlink(this.#filePath)) {
      throw new Error('ShadowEventLedger: file changed while opening; rejected fail-closed');
    }

    this.#verifiedExists = true;
    this.#verifiedFileIdentity = Object.freeze({
      dev: afterReadStat.dev,
      ino: afterReadStat.ino,
    });
    this.#verifiedSize = fileBuf.length;
    this.#verifiedDigest = crypto.createHash('sha256').update(fileBuf).digest('hex');

    if (fileBuf.length === 0) return;

    // Check for BOM in raw bytes (TextDecoder strips BOM by default)
    if (fileBuf.length >= 3 &&
        fileBuf[0] === 0xEF && fileBuf[1] === 0xBB && fileBuf[2] === 0xBF) {
      throw new Error('ShadowEventLedger: file contains BOM; rejected fail-closed');
    }

    let raw: string;
    try {
      raw = strictUtf8Decoder.decode(fileBuf);
    } catch (err) {
      throw new Error(`ShadowEventLedger: invalid UTF-8 encoding in file: ${(err as Error).message}`);
    }

    if (raw.charCodeAt(0) === 0xFEFF) {
      throw new Error('ShadowEventLedger: file contains BOM; rejected fail-closed');
    }

    if (raw.length > 0 && !raw.endsWith('\n')) {
      throw new Error('ShadowEventLedger: file does not end with trailing LF; rejected fail-closed');
    }

    const lines = raw.split('\n');
    const recordLines = lines.slice(0, -1);

    for (let i = 0; i < recordLines.length; i++) {
      if (recordLines[i].length === 0) {
        throw new Error(`ShadowEventLedger: blank line at record index ${i}; rejected fail-closed`);
      }
    }

    const entries: ShadowLedgerEntry[] = [];
    const seenEventIds = new Set<string>();
    const seenObservationIds = new Set<string>();
    let expectedSequence = 0;
    let previousDigest = GENESIS_DIGEST;

    for (let i = 0; i < recordLines.length; i++) {
      const line = recordLines[i];
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`ShadowEventLedger: malformed JSON at line ${i + 1}; rejected fail-closed`);
      }

      const recanonicalized = canonicalSerialize(parsed);
      if (line !== recanonicalized) {
        throw new Error(
          `ShadowEventLedger: non-canonical JSON at line ${i + 1}; rejected fail-closed`,
        );
      }

      const entry = this.#verifyEntryRecord(
        parsed, i, expectedSequence, previousDigest,
        seenEventIds, seenObservationIds,
      );
      entries.push(entry);
      expectedSequence++;
      previousDigest = entry.entryDigest;
    }

    this.#entries = entries;
  }

  #verifyEntryRecord(
    raw: unknown,
    index: number,
    expectedSequence: number,
    expectedPreviousDigest: string,
    seenEventIds: Set<string>,
    seenObservationIds: Set<string>,
  ): ShadowLedgerEntry {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`ShadowEventLedger: invalid entry at line ${index + 1}: not an object`);
    }

    const obj = raw as Record<string, unknown>;

    const keys = Object.keys(obj);
    const expectedKeys = ['schemaVersion', 'ledgerSequence', 'previousEntryDigest', 'event', 'observation', 'entryDigest'];
    if (keys.length !== expectedKeys.length) {
      throw new Error(`ShadowEventLedger: wrong key count at line ${index + 1}: expected ${expectedKeys.length}, got ${keys.length}`);
    }
    for (const k of keys) {
      if (!expectedKeys.includes(k)) {
        throw new Error(`ShadowEventLedger: unexpected key "${k}" at line ${index + 1}`);
      }
    }

    if (obj.schemaVersion !== LEDGER_ENTRY_SCHEMA_VERSION) {
      throw new Error(`ShadowEventLedger: invalid schemaVersion at line ${index + 1}`);
    }

    if (!Number.isSafeInteger(obj.ledgerSequence) || (obj.ledgerSequence as number) < 0) {
      throw new Error(`ShadowEventLedger: invalid ledgerSequence at line ${index + 1}`);
    }
    if (obj.ledgerSequence !== expectedSequence) {
      throw new Error(`ShadowEventLedger: non-contiguous sequence at line ${index + 1}: expected ${expectedSequence}, got ${obj.ledgerSequence}`);
    }

    if (typeof obj.previousEntryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(obj.previousEntryDigest as string)) {
      throw new Error(`ShadowEventLedger: invalid previousEntryDigest at line ${index + 1}`);
    }
    if (obj.previousEntryDigest !== expectedPreviousDigest) {
      throw new Error(`ShadowEventLedger: wrong previousEntryDigest at line ${index + 1}`);
    }

    const verifiedEvent = verifyCanonicalShadowEvent(obj.event);
    if (!verifiedEvent) {
      throw new Error(`ShadowEventLedger: invalid event at line ${index + 1}`);
    }

    const verifiedObs = verifyShadowIntentObservation(obj.observation, verifiedEvent);
    if (!verifiedObs) {
      throw new Error(`ShadowEventLedger: invalid observation at line ${index + 1}`);
    }

    if (verifiedObs.sourceEventId !== verifiedEvent.eventId) {
      throw new Error(`ShadowEventLedger: cross-binding mismatch at line ${index + 1}`);
    }

    if (seenEventIds.has(verifiedEvent.eventId)) {
      throw new Error(`ShadowEventLedger: duplicate eventId "${verifiedEvent.eventId}" at line ${index + 1}`);
    }
    if (seenObservationIds.has(verifiedObs.observationId)) {
      throw new Error(`ShadowEventLedger: duplicate observationId "${verifiedObs.observationId}" at line ${index + 1}`);
    }
    seenEventIds.add(verifiedEvent.eventId);
    seenObservationIds.add(verifiedObs.observationId);

    if (typeof obj.entryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(obj.entryDigest as string)) {
      throw new Error(`ShadowEventLedger: invalid entryDigest at line ${index + 1}`);
    }

    const entryWithoutDigest: Omit<ShadowLedgerEntry, 'entryDigest'> = {
      schemaVersion: LEDGER_ENTRY_SCHEMA_VERSION,
      ledgerSequence: expectedSequence as number,
      previousEntryDigest: expectedPreviousDigest,
      event: verifiedEvent,
      observation: verifiedObs,
    };
    const computedDigest = computeEntryDigest(entryWithoutDigest);
    if (computedDigest !== obj.entryDigest) {
      throw new Error(`ShadowEventLedger: entryDigest mismatch at line ${index + 1}`);
    }

    const entry: ShadowLedgerEntry = {
      ...entryWithoutDigest,
      entryDigest: computedDigest,
    };

    deepFreeze(entry);

    return entry;
  }

  #checkExternalModification(): Buffer {
    if (pathChainContainsSymlink(this.#filePath)) {
      throw new Error('ShadowEventLedger: external path redirection detected; fail-closed');
    }
    try {
      const stat = fs.statSync(this.#filePath);
      if (!this.#verifiedExists) {
        throw new Error('ShadowEventLedger: external file creation detected; fail-closed');
      }
      if (!stat.isFile()) {
        throw new Error('ShadowEventLedger: external target type change detected; fail-closed');
      }
      if (this.#verifiedFileIdentity === null ||
          stat.dev !== this.#verifiedFileIdentity.dev ||
          stat.ino !== this.#verifiedFileIdentity.ino) {
        throw new Error('ShadowEventLedger: external file identity change detected; fail-closed');
      }
      if (stat.size !== this.#verifiedSize) {
        throw new Error(
          'ShadowEventLedger: external file modification detected (file size changed); fail-closed',
        );
      }
      if (this.#verifiedDigest !== null) {
        const fileBuf = fs.readFileSync(this.#filePath);
        if (fileBuf.length !== this.#verifiedSize) {
          throw new Error('ShadowEventLedger: external file byte length change detected; fail-closed');
        }
        const currentDigest = crypto.createHash('sha256').update(fileBuf).digest('hex');
        if (currentDigest !== this.#verifiedDigest) {
          throw new Error(
            'ShadowEventLedger: external file modification detected (content hash mismatch); fail-closed',
          );
        }
        return fileBuf;
      }
      return Buffer.alloc(0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !this.#verifiedExists) {
        return Buffer.alloc(0);
      }
      if ((err as Error).message.includes('external')) {
        throw err;
      }
      throw new Error(
        `ShadowEventLedger: external modification check failed: ${(err as Error).message}`,
      );
    }
  }
}
