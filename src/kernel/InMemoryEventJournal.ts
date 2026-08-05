// Phase 1A: InMemoryEventJournal — Map-backed passive journal
import type { KernelEventEnvelope } from './KernelEventEnvelope';
import type { EventJournalPort } from './EventJournalPort';

export function createInMemoryEventJournal(): EventJournalPort {
  const byId = new Map<string, KernelEventEnvelope>();
  const bySequence: KernelEventEnvelope[] = [];

  return {
    append(envelope: KernelEventEnvelope): void {
      byId.set(envelope.kernelEventId, envelope);
      // Maintain ordered array by sequence (caller guarantees monotonic)
      const idx = envelope.kernelLogicalSequence - 1;
      bySequence[idx] = envelope;
    },

    getByEventId(eventId: string): KernelEventEnvelope | null {
      return byId.get(eventId) ?? null;
    },

    readFromLogicalSequence(fromSequence: number, limit: number = 100): KernelEventEnvelope[] {
      const start = fromSequence - 1;
      if (start >= bySequence.length) return [];
      return bySequence.slice(start, start + limit).filter(Boolean);
    },
  };
}
