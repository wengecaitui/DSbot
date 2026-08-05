// Phase 1A: EventJournalPort — passive journal interface
// No replay, no clock, no dispatch, no state, no filesystem.

import type { KernelEventEnvelope } from './KernelEventEnvelope';

export interface EventJournalPort {
  append(envelope: KernelEventEnvelope): void;
  getByEventId(eventId: string): KernelEventEnvelope | null;
  readFromLogicalSequence(fromSequence: number, limit?: number): KernelEventEnvelope[];
}
