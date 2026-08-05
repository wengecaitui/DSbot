// Phase 1A: InMemoryEventJournal — Map-backed passive journal with invariant enforcement
import type { KernelEventEnvelope } from './KernelEventEnvelope';
import type { EventJournalPort } from './EventJournalPort';

export function createInMemoryEventJournal(): EventJournalPort {
  const byId = new Map<string, KernelEventEnvelope>();
  const bySequence = new Map<number, KernelEventEnvelope>();

  function assertValidSequence(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new Error(`JOURNAL_SEQUENCE_INVALID: must be positive safe integer, got ${seq}`);
    }
  }

  function assertMonotonicSequence(seq: number): void {
    // find highest seq, must be strictly greater
    let maxSeq = 0;
    for (const s of bySequence.keys()) { if (s > maxSeq) maxSeq = s; }
    if (seq <= maxSeq) {
      throw new Error(`JOURNAL_SEQUENCE_NOT_MONOTONIC: ${seq} <= existing max ${maxSeq}`);
    }
  }

  return {
    append(envelope: KernelEventEnvelope): void {
      const seq = envelope.kernelLogicalSequence;
      assertValidSequence(seq);
      // reject duplicate eventId BEFORE monotonicity check
      if (byId.has(envelope.kernelEventId)) {
        throw new Error(`JOURNAL_DUPLICATE_EVENT_ID: ${envelope.kernelEventId}`);
      }
      // reject non-monotonic
      assertMonotonicSequence(seq);
      byId.set(envelope.kernelEventId, envelope);
      bySequence.set(seq, envelope);
    },

    getByEventId(eventId: string): KernelEventEnvelope | null {
      return byId.get(eventId) ?? null;
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
        result.push(env);
      }
      return result;
    },
  };
}
