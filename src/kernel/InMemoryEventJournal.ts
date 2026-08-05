// Phase 1A: InMemoryEventJournal — Map-backed passive journal with invariant enforcement
import type { KernelEventEnvelope } from './KernelEventEnvelope';
import type { EventJournalPort } from './EventJournalPort';

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function createInMemoryEventJournal(): EventJournalPort {
  const byId = new Map<string, KernelEventEnvelope>();
  const bySequence = new Map<number, KernelEventEnvelope>();

  function assertValidSequence(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new Error(`JOURNAL_SEQUENCE_INVALID: must be positive safe integer, got ${seq}`);
    }
  }

  function assertContiguousSequence(seq: number): void {
    // Must be exactly previous+1 for contiguous ordering
    let maxSeq = 0;
    for (const s of bySequence.keys()) { if (s > maxSeq) maxSeq = s; }
    if (seq !== maxSeq + 1) {
      throw new Error(`JOURNAL_SEQUENCE_NOT_CONTIGUOUS: expected ${maxSeq + 1}, got ${seq}`);
    }
  }

  return {
    append(envelope: KernelEventEnvelope): void {
      const seq = envelope.kernelLogicalSequence;
      assertValidSequence(seq);
      if (byId.has(envelope.kernelEventId)) {
        throw new Error(`JOURNAL_DUPLICATE_EVENT_ID: ${envelope.kernelEventId}`);
      }
      assertContiguousSequence(seq);
      // deep-clone before storage so caller mutation cannot alter journal
      const cloned = deepClone(envelope) as KernelEventEnvelope;
      byId.set(cloned.kernelEventId, cloned);
      bySequence.set(seq, cloned);
    },

    getByEventId(eventId: string): KernelEventEnvelope | null {
      const stored = byId.get(eventId);
      if (!stored) return null;
      // return defensive clone to prevent caller mutation of journal state
      return deepClone(stored) as KernelEventEnvelope;
    },

    readFromLogicalSequence(fromSequence: number, limit: number = 100): KernelEventEnvelope[] {
      if (!Number.isSafeInteger(fromSequence) || fromSequence < 1) {
        throw new Error(`JOURNAL_FROM_SEQUENCE_INVALID: must be >=1, got ${fromSequence}`);
      }
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error(`JOURNAL_LIMIT_INVALID: must be positive integer, got ${limit}`);
      }
      const result: KernelEventEnvelope[] = [];
      for (let i = 0; i < limit; i++) {
        const env = bySequence.get(fromSequence + i);
        if (!env) break;
        // return defensive clone to prevent caller mutation of journal state
        result.push(deepClone(env) as KernelEventEnvelope);
      }
      return result;
    },
  };
}
