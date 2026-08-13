// Phase 5A: FileEventJournal — durable append-only journal with SHA-256 integrity
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { EventJournalPort } from '../kernel/EventJournalPort';

interface JournalLine {
  checksum: string;
  envelope: KernelEventEnvelope;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function canonicalJSON(obj: unknown): string {
  return JSON.stringify(obj, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export interface FileEventJournal extends EventJournalPort {
  readonly filePath: string;
  readonly lastSequence: number;
  readonly eventCount: number;
  close(): void;
}

export function createFileEventJournal(filePath: string): FileEventJournal {
  const byId = new Map<string, KernelEventEnvelope>();
  const bySequence = new Map<number, KernelEventEnvelope>();
  let lastSeq = 0;

  // Load existing journal on open
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    for (let i = 0; i < lines.length; i++) {
      let line: JournalLine;
      try {
        line = JSON.parse(lines[i]);
      } catch {
        throw new Error(`JOURNAL_CORRUPT: unparseable JSON at line ${i + 1}`);
      }
      if (!line?.checksum || !line?.envelope) {
        throw new Error(`JOURNAL_CORRUPT: missing checksum or envelope at line ${i + 1}`);
      }
      // Verify checksum
      const expected = sha256(canonicalJSON(line.envelope));
      if (line.checksum !== expected) {
        throw new Error(`JOURNAL_CHECKSUM_MISMATCH: line ${i + 1}`);
      }
      const env = line.envelope;
      if (byId.has(env.kernelEventId)) {
        throw new Error(`JOURNAL_CORRUPT: duplicate eventId ${env.kernelEventId} at line ${i + 1}`);
      }
      if (env.kernelLogicalSequence !== lastSeq + 1) {
        throw new Error(`JOURNAL_SEQUENCE_GAP: expected ${lastSeq + 1}, got ${env.kernelLogicalSequence} at line ${i + 1}`);
      }
      byId.set(env.kernelEventId, env);
      bySequence.set(env.kernelLogicalSequence, env);
      lastSeq = env.kernelLogicalSequence;
    }
  }

  function append(envelope: KernelEventEnvelope): void {
    const seq = envelope.kernelLogicalSequence;
    if (byId.has(envelope.kernelEventId)) {
      throw new Error(`JOURNAL_DUPLICATE_EVENT_ID: ${envelope.kernelEventId}`);
    }
    if (seq !== lastSeq + 1) {
      throw new Error(`JOURNAL_SEQUENCE_NOT_CONTIGUOUS: expected ${lastSeq + 1}, got ${seq}`);
    }
    const checksum = sha256(canonicalJSON(envelope));
    const line: JournalLine = { checksum, envelope };
    appendFileSync(filePath, JSON.stringify(line) + '\n', 'utf8');
    byId.set(envelope.kernelEventId, envelope);
    bySequence.set(seq, envelope);
    lastSeq = seq;
  }

  return {
    filePath,
    get lastSequence() { return lastSeq; },
    get eventCount() { return bySequence.size; },
    append,
    getByEventId(eventId: string) {
      return byId.get(eventId) ?? null;
    },
    readFromLogicalSequence(fromSeq: number, limit = 100) {
      const result: KernelEventEnvelope[] = [];
      for (let i = 0; i < limit; i++) {
        const env = bySequence.get(fromSeq + i);
        if (!env) break;
        result.push(env);
      }
      return result;
    },
    close() { /* no-op for sync file journal */ },
  };
}
