// Phase 1A: TradingKernel — deterministic event spine
//
// Boundary:
//   validate → eventId → duplicate check → deep clone → recursive freeze → journal → sequence → dispatch
//   Duplicate eventId = status:duplicate, delivered:0, failures:0
//   Journal append failure = throw, no sequence, no dispatch.
//     Same kernel retry with working journal starts at sequence 1.
//   Subscriber failure = count and continue; async subscriber = counted as failure.

import * as crypto from 'node:crypto';
import type { ExchangeId } from '../data/MarketIdentity';
import type { TradingEventType, TradingEventPayloadMap } from '../events/TradingEvent';
import { validateTradingEventPayload } from '../events/validateTradingEventPayload';
import { validatePolicyPublication } from '../events/validatePolicySnapshot';
import type { KernelEventEnvelope } from './KernelEventEnvelope';
import type { EventJournalPort } from './EventJournalPort';
import { createInMemoryEventJournal } from './InMemoryEventJournal';
import type { DomainClock } from '../runtime/Clock';
import { systemDomainClock } from '../runtime/Clock';

const SHA_RE = /^[0-9a-f]{64}$/;

// ─── Canonical JSON ─────────────────────────────────────────────────────────

function canonicalJSON(value: unknown): string {
  try {
    return JSON.stringify(value, sortedKeysReplacer);
  } catch (e) {
    if (e instanceof TypeError && (e.message.includes('circular') || e.message.includes('cyclic'))) {
      throw new Error('CANONICAL_CYCLE: circular reference detected');
    }
    if (e instanceof RangeError && (e.message.includes('call stack') || e.message.includes('recursion'))) {
      throw new Error('CANONICAL_CYCLE: circular reference detected');
    }
    throw e;
  }
}

function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`CANONICAL_NON_FINITE: ${value}`);
  }
  if (value === undefined) {
    throw new Error('CANONICAL_UNDEFINED: undefined is not valid JSON');
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`CANONICAL_INVALID_TYPE: ${typeof value}`);
  }
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

// ─── Deep clone + recursive freeze ──────────────────────────────────────────

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    if (Array.isArray(obj)) {
      for (const item of obj) deepFreeze(item);
    } else {
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        deepFreeze((obj as Record<string, unknown>)[key]);
      }
    }
  }
  return obj;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type KernelSubscriber<T extends TradingEventType = TradingEventType> =
  (envelope: KernelEventEnvelope<T>) => void | Promise<void>;

export interface PublishResult<T extends TradingEventType = TradingEventType> {
  status: 'accepted' | 'duplicate';
  envelope: KernelEventEnvelope<T>;
  delivered: number;
  failures: number;
}

export interface TradingKernel {
  publish<T extends TradingEventType>(
    type: T,
    payload: TradingEventPayloadMap[T],
    eventId?: string,
  ): PublishResult<T>;
  subscribe<T extends TradingEventType>(
    type: T,
    handler: KernelSubscriber<T>,
  ): () => void;
  journal(): EventJournalPort;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createTradingKernel(config: {
  exchange: ExchangeId;
  clock?: DomainClock;
  journal?: EventJournalPort;
  policyMaxLifetimeMs?: number;
  /** Recovery: set initial sequence to journal.lastSequence so first new event is N+1 */
  initialSequence?: number;
}): TradingKernel {
  let seq: number = config.initialSequence ?? 0;
  let journal: EventJournalPort = config.journal ?? createInMemoryEventJournal();
  const clock: DomainClock = config.clock ?? systemDomainClock;
  const subs = new Map<TradingEventType, KernelSubscriber[]>();

  function publish<T extends TradingEventType>(
    type: T,
    payload: TradingEventPayloadMap[T],
    eventId?: string,
  ): PublishResult<T> {
    // Step 1: validate
    validateTradingEventPayload(type, payload as Record<string, unknown>);

    // Step 2: eventId
    if (eventId !== undefined) {
      if (typeof eventId !== 'string' || !SHA_RE.test(eventId)) {
        throw new Error(`INVALID_EVENT_ID: must be 64-char hex, got ${JSON.stringify(eventId)}`);
      }
    } else {
      eventId = sha256(canonicalJSON({ type, payload }));
    }

    // Step 3: duplicate lookup
    const existing = journal.getByEventId(eventId);
    if (existing) {
      // Defensive: clone the stored envelope before returning, preventing mutation
      const cloned = deepClone(existing) as KernelEventEnvelope<T>;
      deepFreeze(cloned);
      return {
        status: 'duplicate',
        envelope: cloned,
        delivered: 0,
        failures: 0,
      };
    }

    // Step 4: candidate sequence (not yet committed)
    const candidateSeq = seq + 1;

    // Step 5: injected DomainClock timestamp
    const timestamp = clock.now();

    // Step 5a: policy.snapshot.published pre-journal validation
    if (type === 'policy.snapshot.published') {
      if (config.policyMaxLifetimeMs === undefined) {
        throw new Error('POLICY_CONFIG_MISSING: policyMaxLifetimeMs required for policy.snapshot.published');
      }
      const policy = (payload as unknown as { policy: unknown }).policy;
      validatePolicyPublication(policy, candidateSeq, timestamp, config.policyMaxLifetimeMs);
    }

    // Step 6: deep defensive clone + recursive freeze before journal
    const clonedPayload = deepClone(payload);
    const env = deepFreeze({
      kernelEventId: eventId,
      kernelLogicalSequence: candidateSeq,
      kernelTimestamp: timestamp,
      type,
      payload: clonedPayload,
    } as unknown as KernelEventEnvelope<T>) as KernelEventEnvelope<T>;

    // Step 7: journal append
    let appendFailed = false;
    try {
      journal.append(env);
    } catch {
      appendFailed = true;
    }

    // Step 7a: append failure → throw. Same kernel can retry with working journal.
    if (appendFailed) {
      throw new Error('JOURNAL_APPEND_FAILED');
    }

    // Step 8: commit sequence
    seq = candidateSeq;

    // Step 9: dispatch with delivered/failures counting
    const handlers = subs.get(type);
    let delivered = 0;
    let failures = 0;
    if (handlers) {
      for (const h of [...handlers]) {
        try {
          const ret = h(env as KernelEventEnvelope);
          if (ret !== null && typeof ret === 'object' && typeof (ret as unknown as { then?: unknown }).then === 'function') {
            failures += 1;
            Promise.resolve(ret as Promise<void>).catch(() => {});
          } else {
            delivered += 1;
          }
        } catch {
          failures += 1;
        }
      }
    }

    return { status: 'accepted', envelope: env, delivered, failures };
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
