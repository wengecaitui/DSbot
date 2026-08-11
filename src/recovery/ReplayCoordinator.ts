// Phase 5A: ReplayCoordinator — adapter-free type→projector replay
import type { EventJournalPort } from '../kernel/EventJournalPort';
import type { TradingEventType } from '../events/TradingEvent';

export interface Projector {
  apply(envelope: unknown): unknown;
  digest(): string;
}

export type ProjectorMap = Map<TradingEventType, Projector[]>;

export interface ReplayError {
  sequence: number;
  eventId: string;
  message: string;
}

export interface ReplayReport {
  eventsReplayed: number;
  lastSequence: number;
  errors: ReplayError[];
}

/**
 * Replay all events from journal into their applicable projectors.
 * Events are routed by type — only projectors registered for that type receive the event.
 * No kernel.publish, no adapter, no execution.
 */
export function replayJournal(
  journal: EventJournalPort,
  projectors: ProjectorMap,
  batchSize = 100,
): ReplayReport {
  const errors: ReplayError[] = [];
  let eventsReplayed = 0;
  let fromSeq = 1;

  while (true) {
    const batch = journal.readFromLogicalSequence(fromSeq, batchSize);
    if (batch.length === 0) break;

    for (const envelope of batch) {
      const type = envelope.type as TradingEventType;
      const targets = projectors.get(type);
      if (!targets || targets.length === 0) {
        // Event type not mapped to any projector — skip silently
        fromSeq = envelope.kernelLogicalSequence + 1;
        eventsReplayed++;
        continue;
      }

      for (const proj of targets) {
        try {
          proj.apply(envelope);
        } catch (e: any) {
          errors.push({
            sequence: envelope.kernelLogicalSequence,
            eventId: envelope.kernelEventId,
            message: e?.message ?? 'unknown projector error',
          });
        }
      }
      fromSeq = envelope.kernelLogicalSequence + 1;
      eventsReplayed++;
    }
  }

  return {
    eventsReplayed,
    lastSequence: fromSeq - 1,
    errors,
  };
}
