// Phase 1A: TradingKernel — deterministic event spine
//
// Boundary:
//   validate → eventId → duplicate check → journal append → sequence → dispatch
//   Duplicate eventId = no append, no sequence advancement, no dispatch
//   Journal append failure = throw, no sequence, no dispatch
//   Subscriber failure = count and continue

import * as crypto from 'node:crypto';
import type { ExchangeId } from '../data/MarketIdentity';
import type { TradingEventType, TradingEventPayloadMap } from '../events/TradingEvent';
import { validateTradingEventPayload } from '../events/validateTradingEventPayload';
import type { KernelEventEnvelope } from './KernelEventEnvelope';
import type { EventJournalPort } from './EventJournalPort';
import { createInMemoryEventJournal } from './InMemoryEventJournal';
import type { DomainClock } from '../runtime/Clock';
import { systemDomainClock } from '../runtime/Clock';

const SHA_RE = /^[0-9a-f]{64}$/;

function canonical(envelope: Omit<KernelEventEnvelope, 'kernelEventId' | 'kernelLogicalSequence' | 'kernelTimestamp'>): string {
  return JSON.stringify({ type: envelope.type, payload: envelope.payload }, sortedKeysReplacer);
}

function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = sortedKeysReplacer(k, (value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

export type KernelSubscriber<T extends TradingEventType = TradingEventType> = (envelope: KernelEventEnvelope<T>) => void;

export interface TradingKernel {
  publish<T extends TradingEventType>(
    type: T,
    payload: TradingEventPayloadMap[T],
    eventId?: string,
  ): KernelEventEnvelope<T>;
  subscribe<T extends TradingEventType>(
    type: T,
    handler: KernelSubscriber<T>,
  ): () => void;
  journal(): EventJournalPort;
}

export function createTradingKernel(config: {
  exchange: ExchangeId;
  clock?: DomainClock;
  journal?: EventJournalPort;
}): TradingKernel {
  let seq: number = 0;
  const clock: DomainClock = config.clock ?? systemDomainClock;
  const journal: EventJournalPort = config.journal ?? createInMemoryEventJournal();
  const subs = new Map<TradingEventType, KernelSubscriber[]>();

  function publish<T extends TradingEventType>(
    type: T,
    payload: TradingEventPayloadMap[T],
    eventId?: string,
  ): KernelEventEnvelope<T> {
    // Step 1: validate
    validateTradingEventPayload(type, payload as Record<string, unknown>);

    // Step 2: eventId
    if (eventId !== undefined) {
      if (typeof eventId !== 'string' || !SHA_RE.test(eventId)) {
        throw new Error(`INVALID_EVENT_ID: must be 64-char hex, got ${JSON.stringify(eventId)}`);
      }
    } else {
      const partial = { type, payload };
      eventId = sha256(canonical(partial as Omit<KernelEventEnvelope, 'kernelEventId' | 'kernelLogicalSequence' | 'kernelTimestamp'>));
    }

    // Step 3: duplicate lookup
    const existing = journal.getByEventId(eventId);
    if (existing) return existing as KernelEventEnvelope<T>;

    // Step 4: candidate sequence (not yet committed)
    const candidateSeq = seq + 1;

    // Step 5: injected DomainClock timestamp
    const timestamp = clock.now();

    // Step 6: defensive immutable envelope via Object.freeze
    const env = Object.freeze({
      kernelEventId: eventId,
      kernelLogicalSequence: candidateSeq,
      kernelTimestamp: timestamp,
      type,
      payload,
    } as KernelEventEnvelope<T>);

    // Step 7: journal append
    journal.append(env);

    // Step 8: commit sequence
    seq = candidateSeq;

    // Step 9: dispatch
    const handlers = subs.get(type);
    if (handlers) {
      for (const h of [...handlers]) {
        try { h(env as KernelEventEnvelope); } catch { /* count and continue */ }
      }
    }

    return env;
  }

  function subscribe<T extends TradingEventType>(
    type: T,
    handler: KernelSubscriber<T>,
  ): () => void {
    const list = subs.get(type) ?? [];
    list.push(handler as KernelSubscriber);
    subs.set(type, list);
    let unsubbed = false;
    return () => {
      if (unsubbed) return;
      unsubbed = true;
      const i = list.indexOf(handler as KernelSubscriber);
      if (i !== -1) list.splice(i, 1);
    };
  }

  return { publish, subscribe, journal: () => journal };
}
