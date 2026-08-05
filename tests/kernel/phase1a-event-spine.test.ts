// Phase 1A Event Spine — contract tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import type { WsTicker, WsKline } from '../../src/data/types';
import type { MarketBiasReportFull } from '../../src/types/market-bias';

import { InvalidExchangeProvenanceError } from '../../src/events/TradingEvent';
import { createTradingEventBus } from '../../src/events/TradingEventBus';
import type { TradingEventBus } from '../../src/events/TradingEventBus';
import type { TradingEventType, TradingEventPayloadMap } from '../../src/events/TradingEvent';
import { KlineClosedEventRejectedError } from '../../src/events/TradingEvent';

import { validateTradingEventPayload } from '../../src/events/validateTradingEventPayload';
import type { KernelEventEnvelope } from '../../src/kernel/KernelEventEnvelope';
import type { EventJournalPort } from '../../src/kernel/EventJournalPort';
import { createInMemoryEventJournal } from '../../src/kernel/InMemoryEventJournal';
import type { TradingKernel } from '../../src/kernel/TradingKernel';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import type { DomainClock } from '../../src/runtime/Clock';

const BITGET = 'bitget' as const;
const makeTicker = (overrides?: Partial<WsTicker>): WsTicker => ({
  exchange: BITGET, symbol: 'BTC/USDT', ...(overrides as Partial<WsTicker> ?? {}),
} as unknown as WsTicker);
const makeKline = (overrides?: Partial<WsKline>): WsKline => ({
  exchange: BITGET, symbol: 'BTC/USDT', interval: '1m', ts: 1000, open: 100,
  high: 101, low: 99, close: 100.5, volume: 1000, confirm: true, ...overrides,
} as unknown as WsKline);
const makeBiasReport = (overrides?: Partial<MarketBiasReportFull>): MarketBiasReportFull => ({
  exchange: BITGET, version: 1, updatedAt: 1000, assets: [], whitelist: ['BTC/USDT'],
  ...overrides,
} as unknown as MarketBiasReportFull);

// ─── shared validation ──────────────────────────────────────────────────────
describe('validateTradingEventPayload', () => {
  it('rejects unknown event type', () => {
    assert.throws(() => validateTradingEventPayload('unknown.type' as TradingEventType, {}), /UNKNOWN_EVENT_TYPE/);
  });
  it('requires ticker payload', () => {
    assert.throws(() => validateTradingEventPayload('market.ticker.updated', { receivedAt: 1 }), InvalidExchangeProvenanceError);
  });
  it('accepts valid ticker', () => {
    validateTradingEventPayload('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
  });
  it('requires kline payload', () => {
    assert.throws(() => validateTradingEventPayload('market.kline.closed', { receivedAt: 1 }), KlineClosedEventRejectedError);
  });
  it('requires kline.confirm === true', () => {
    assert.throws(() => validateTradingEventPayload('market.kline.closed', { kline: makeKline({ confirm: false } as Partial<WsKline>), receivedAt: 1 }), KlineClosedEventRejectedError);
  });
  it('accepts valid kline', () => {
    validateTradingEventPayload('market.kline.closed', { kline: makeKline(), receivedAt: 1 });
  });
  it('requires report payload', () => {
    assert.throws(() => validateTradingEventPayload('research.bias.updated', { receivedAt: 1 }), InvalidExchangeProvenanceError);
  });
  it('accepts valid report', () => {
    validateTradingEventPayload('research.bias.updated', { report: makeBiasReport(), receivedAt: 1 });
  });
});

// ─── legacy EventBus ────────────────────────────────────────────────────────
describe('legacy EventBus (unchanged)', () => {
  let bus: TradingEventBus;
  beforeEach(() => { bus = createTradingEventBus(); });
  it('subscribes and publishes', () => {
    let captured: unknown = null;
    bus.subscribe('market.ticker.updated', (e) => { captured = e; });
    bus.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual((captured as Record<string,unknown>).type, 'market.ticker.updated');
  });
  it('publishes monotonic sequence', () => {
    const ticker = makeTicker();
    const r1 = bus.publish('market.ticker.updated', { ticker, receivedAt: 1 });
    const r2 = bus.publish('market.ticker.updated', { ticker, receivedAt: 2 });
    assert.ok(r1.sequence < r2.sequence);
  });
  it('rejects invalid exchange provenance', () => {
    assert.throws(() => bus.publish('market.ticker.updated', {
      ticker: { exchange: 'coinbase', symbol: 'BTC/USDT' } as unknown as WsTicker, receivedAt: 1,
    }), InvalidExchangeProvenanceError);
  });
  it('rejects unconfirmed kline', () => {
    assert.throws(() => bus.publish('market.kline.closed', {
      kline: makeKline({ confirm: false } as Partial<WsKline>), receivedAt: 1,
    }), KlineClosedEventRejectedError);
  });
  it('subscriber throw does not break others', () => {
    const calls: string[] = [];
    bus.subscribe('market.ticker.updated', () => { calls.push('fail'); throw new Error('boom'); });
    bus.subscribe('market.ticker.updated', () => { calls.push('pass'); });
    bus.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.deepStrictEqual(calls, ['fail', 'pass']);
  });
});

// ─── Kernel publish result ──────────────────────────────────────────────────
describe('TradingKernel publish result', () => {
  let k: TradingKernel;
  beforeEach(() => { k = createTradingKernel({ exchange: BITGET }); });
  it('accepted event has status=accepted', () => {
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r.status, 'accepted');
    assert.strictEqual(r.delivered, 0);
    assert.strictEqual(r.failures, 0);
  });
  it('duplicate eventId returns status=duplicate', () => {
    const r1 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const r2 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, r1.envelope.kernelEventId);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(r2.delivered, 0);
    assert.strictEqual(r2.failures, 0);
  });
  it('sync subscriber throw → failures++', () => {
    k.subscribe('market.ticker.updated', () => { throw new Error('boom'); });
    k.subscribe('market.ticker.updated', () => { /* noop */ });
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r.failures, 1);
    assert.strictEqual(r.delivered, 1);
  });
  it('async subscriber → counted as failure', () => {
    k.subscribe('market.ticker.updated', async () => { /* noop */ });
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r.failures, 1);
  });
});

// ─── Defensive immutability ─────────────────────────────────────────────────
describe('defensive immutability', () => {
  let k: TradingKernel;
  beforeEach(() => { k = createTradingKernel({ exchange: BITGET }); });
  it('envelope is deep frozen', () => {
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.ok(Object.isFrozen(r.envelope));
    // nested payload is also frozen
    assert.ok(Object.isFrozen(r.envelope.payload));
  });
  it('caller mutation does not affect journal', () => {
    const p = { ticker: makeTicker(), receivedAt: 1 };
    const r = k.publish('market.ticker.updated', p);
    p.ticker.symbol = 'MUTATED';
    p.receivedAt = 999;
    const stored = k.journal().getByEventId(r.envelope.kernelEventId);
    assert.ok(stored);
    assert.notStrictEqual((stored.payload as { ticker: WsTicker }).ticker.symbol, 'MUTATED');
  });
  it('getByEventId returns defensive copy (mutation does not affect journal)', () => {
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const stored1 = k.journal().getByEventId(r.envelope.kernelEventId);
    assert.ok(stored1);
    (stored1 as Record<string,unknown>).kernelEventId = 'tampered';
    // re-fetch — must be unchanged
    const stored2 = k.journal().getByEventId(r.envelope.kernelEventId);
    assert.ok(stored2);
    assert.strictEqual(stored2.kernelEventId, r.envelope.kernelEventId);
  });
  it('readFromLogicalSequence returns defensive copies (nested mutation does not leak)', () => {
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const entries = k.journal().readFromLogicalSequence(1, 10);
    assert.strictEqual(entries.length, 1);
    // mutate nested payload on returned copy
    (entries[0].payload as { ticker: WsTicker }).ticker.symbol = 'LEAKED' as string;
    // re-fetch — must be unchanged
    const entries2 = k.journal().readFromLogicalSequence(1, 10);
    assert.notStrictEqual((entries2[0].payload as { ticker: WsTicker }).ticker.symbol, 'LEAKED');
  });
  it('duplicate returned envelope is also defensive', () => {
    const r1 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const r2 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, r1.envelope.kernelEventId);
    assert.ok(Object.isFrozen(r2.envelope));
    assert.ok(Object.isFrozen(r2.envelope.payload));
    // mutate returned duplicate — original in journal unchanged
    (r2.envelope as Record<string,unknown>).kernelTimestamp = -1;
    const stored = k.journal().getByEventId(r1.envelope.kernelEventId);
    assert.ok(stored);
    assert.notStrictEqual(stored.kernelTimestamp, -1);
  });
});

// ─── Deterministic eventId ──────────────────────────────────────────────────
describe('deterministic eventId', () => {
  it('same payload → same eventId', () => {
    const k1 = createTradingKernel({ exchange: BITGET });
    const k2 = createTradingKernel({ exchange: BITGET });
    const r1 = k1.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const r2 = k2.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r1.envelope.kernelEventId, r2.envelope.kernelEventId);
  });
  it('supplied non-hex eventId throws', () => {
    const k = createTradingKernel({ exchange: BITGET });
    assert.throws(() => k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, 'z'.repeat(64)), /INVALID_EVENT_ID/);
  });
  it('canonical JSON rejects non-finite numbers', () => {
    const k = createTradingKernel({ exchange: BITGET });
    assert.throws(() => k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: NaN }), /CANONICAL_NON_FINITE/);
  });
  it('canonical JSON rejects undefined', () => {
    const k = createTradingKernel({ exchange: BITGET });
    assert.throws(() => k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: undefined as unknown as number }), /CANONICAL_UNDEFINED/);
  });
  it('canonical JSON rejects cycles', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const ticker = makeTicker();
    // create a cycle in a nested property that passes validation
    const sub: Record<string,unknown> = { deep: null };
    sub.deep = sub;
    (ticker as Record<string,unknown>).extra = sub;
    assert.throws(() => k.publish('market.ticker.updated',
      { ticker, receivedAt: 1 }), /CANONICAL_CYCLE/);
  });
});

// ─── Sequence authority ────────────────────────────────────────────────────
describe('logical sequence', () => {
  it('sequences 1,2,3', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const ticker = makeTicker();
    const s1 = k.publish('market.ticker.updated', { ticker, receivedAt: 1 }).envelope.kernelLogicalSequence;
    const s2 = k.publish('market.ticker.updated', { ticker, receivedAt: 2 }).envelope.kernelLogicalSequence;
    const s3 = k.publish('market.ticker.updated', { ticker, receivedAt: 3 }).envelope.kernelLogicalSequence;
    assert.deepStrictEqual([s1, s2, s3], [1, 2, 3]);
  });
  it('sequence advances despite DomainClock rollback', () => {
    let fakeTime = 5000;
    const fakeClock: DomainClock = { now: () => fakeTime };
    const k = createTradingKernel({ exchange: BITGET, clock: fakeClock });
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    fakeTime = 3000;
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 2 });
    fakeTime = 6000;
    const r3 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 3 });
    assert.strictEqual(r3.envelope.kernelLogicalSequence, 3);
  });
});

// ─── Duplicate idempotency ──────────────────────────────────────────────────
describe('duplicate idempotency', () => {
  it('duplicate → no sequence advancement', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const r1 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, r1.envelope.kernelEventId);
    const r3 = k.publish('market.kline.closed', { kline: makeKline(), receivedAt: 2 });
    assert.strictEqual(r3.envelope.kernelLogicalSequence, 2);
  });
});

// ─── Invalid event handling ────────────────────────────────────────────────
describe('invalid event handling', () => {
  it('invalid event → no journal append', () => {
    const k = createTradingKernel({ exchange: BITGET });
    try { k.publish('unknown.type' as TradingEventType, {}); } catch { /* expected */ }
    assert.strictEqual(k.journal().readFromLogicalSequence(1, 10).length, 0);
  });
});

// ─── Journal contract ───────────────────────────────────────────────────────
describe('InMemoryEventJournal', () => {
  let k: TradingKernel;
  beforeEach(() => { k = createTradingKernel({ exchange: BITGET }); });

  it('getByEventId finds stored event', () => {
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.ok(k.journal().getByEventId(r.envelope.kernelEventId));
  });
  it('getByEventId returns null for unknown', () => {
    assert.strictEqual(k.journal().getByEventId('a'.repeat(64)), null);
  });
  it('readFromLogicalSequence returns ordered', () => {
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    k.publish('market.kline.closed', { kline: makeKline(), receivedAt: 2 });
    const entries = k.journal().readFromLogicalSequence(1, 10);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].kernelLogicalSequence, 1);
    assert.strictEqual(entries[1].kernelLogicalSequence, 2);
  });
  it('readFromLogicalSequence from nonexistent returns empty', () => {
    assert.strictEqual(k.journal().readFromLogicalSequence(999, 10).length, 0);
  });
  it('rejects fromSequence < 1', () => {
    assert.throws(() => k.journal().readFromLogicalSequence(0, 10), /JOURNAL_FROM_SEQUENCE_INVALID/);
  });
  it('rejects non-positive limit', () => {
    assert.throws(() => k.journal().readFromLogicalSequence(1, 0), /JOURNAL_LIMIT_INVALID/);
  });
  it('rejects duplicate eventId on direct append', () => {
    const j = createInMemoryEventJournal();
    const env: KernelEventEnvelope = Object.freeze({ kernelEventId: 'a'.repeat(64), kernelLogicalSequence: 1, kernelTimestamp: 1,
      type: 'market.ticker.updated' as TradingEventType,
      payload: Object.freeze({ ticker: makeTicker(), receivedAt: 1 }) } as KernelEventEnvelope);
    j.append(env);
    assert.throws(() => j.append(env), /JOURNAL_DUPLICATE_EVENT_ID/);
  });
  it('rejects non-contiguous sequence (1→3 skip)', () => {
    const j = createInMemoryEventJournal();
    j.append({ kernelEventId: 'a'.repeat(64), kernelLogicalSequence: 1, kernelTimestamp: 1,
      type: 'market.ticker.updated' as TradingEventType,
      payload: { ticker: makeTicker(), receivedAt: 1 } } as KernelEventEnvelope);
    assert.throws(() => j.append({ kernelEventId: 'b'.repeat(64), kernelLogicalSequence: 3,
      kernelTimestamp: 2, type: 'market.ticker.updated' as TradingEventType,
      payload: { ticker: makeTicker(), receivedAt: 2 } } as KernelEventEnvelope), /JOURNAL_SEQUENCE_NOT_CONTIGUOUS/);
  });
  it('rejects non-positive sequence', () => {
    const j = createInMemoryEventJournal();
    assert.throws(() => j.append({ kernelEventId: 'a'.repeat(64), kernelLogicalSequence: 0,
      kernelTimestamp: 1, type: 'market.ticker.updated' as TradingEventType,
      payload: { ticker: makeTicker(), receivedAt: 1 } } as KernelEventEnvelope), /JOURNAL_SEQUENCE_INVALID/);
  });
});

// ─── Flaky journal recovery ─────────────────────────────────────────────────
describe('flaky journal recovery', () => {
  it('same-kernel: first append fails, second publish succeeds with sequence=1', () => {
    let callCount = 0;
    const flakyJournal: EventJournalPort = {
      append: () => {
        callCount++;
        if (callCount === 1) throw new Error('DISK_FULL');
        // Second call succeeds — use a real journal to store
        const j = createInMemoryEventJournal();
        // Create a valid envelope manually to store
        const env: KernelEventEnvelope = Object.freeze({
          kernelEventId: 'a'.repeat(64),
          kernelLogicalSequence: 1,
          kernelTimestamp: 1000,
          type: 'market.ticker.updated' as TradingEventType,
          payload: Object.freeze({ ticker: makeTicker(), receivedAt: 1 }),
        } as KernelEventEnvelope);
        j.append(env);
      },
      getByEventId: () => null,
      readFromLogicalSequence: () => [],
    };
    const k = createTradingKernel({ exchange: BITGET, journal: flakyJournal });
    // First attempt fails
    assert.throws(() => k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }), /JOURNAL_APPEND_FAILED/);
    assert.strictEqual(callCount, 1);
    // Second attempt on SAME kernel succeeds with sequence=1
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r.status, 'accepted');
    assert.strictEqual(r.envelope.kernelLogicalSequence, 1);
    assert.strictEqual(callCount, 2);
  });
});

// ─── Direct-append mutation isolation ───────────────────────────────────────
describe('direct-append mutation isolation', () => {
  it('append mutable nested envelope → caller mutation does not alter journal', () => {
    const j = createInMemoryEventJournal();
    const mutablePayload = { ticker: makeTicker(), receivedAt: 1 };
    const env: KernelEventEnvelope = {
      kernelEventId: 'a'.repeat(64),
      kernelLogicalSequence: 1,
      kernelTimestamp: 1000,
      type: 'market.ticker.updated' as TradingEventType,
      payload: mutablePayload,
    } as KernelEventEnvelope;
    j.append(env);
    // Mutate original payload after append
    mutablePayload.ticker.symbol = 'MUTATED' as string;
    mutablePayload.receivedAt = 999;
    // Journal read must return original values
    const stored = j.getByEventId('a'.repeat(64));
    assert.ok(stored);
    assert.notStrictEqual((stored!.payload as { ticker: WsTicker }).ticker.symbol, 'MUTATED');
    assert.notStrictEqual((stored!.payload as { receivedAt: number }).receivedAt, 999);
  });
});

// ─── Subscriber dispatch ────────────────────────────────────────────────────
describe('kernel subscriber dispatch', () => {
  it('subscribe and receive events', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const events: KernelEventEnvelope[] = [];
    k.subscribe('market.ticker.updated', (e) => events.push(e));
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(events.length, 1);
  });
});

// ─── Kernel instance isolation ──────────────────────────────────────────────
describe('kernel instance isolation', () => {
  it('two kernels have independent sequences', () => {
    const k1 = createTradingKernel({ exchange: BITGET });
    const k2 = createTradingKernel({ exchange: BITGET });
    const ticker = makeTicker();
    assert.strictEqual(k1.publish('market.ticker.updated', { ticker, receivedAt: 1 }).envelope.kernelLogicalSequence, 1);
    assert.strictEqual(k2.publish('market.ticker.updated', { ticker, receivedAt: 1 }).envelope.kernelLogicalSequence, 1);
  });
  it('two kernels have independent journals', () => {
    const k1 = createTradingKernel({ exchange: BITGET });
    const k2 = createTradingKernel({ exchange: BITGET });
    k1.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(k2.journal().readFromLogicalSequence(1, 10).length, 0);
  });
});

// ─── Deterministic replay ──────────────────────────────────────────────────
describe('deterministic replay', () => {
  it('identical input streams → identical IDs and order', () => {
    const events: Array<[TradingEventType, TradingEventPayloadMap[TradingEventType]]> = [
      ['market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }],
      ['market.ticker.updated', { ticker: makeTicker(), receivedAt: 2 }],
    ];
    const run = () => {
      const k = createTradingKernel({ exchange: BITGET });
      return events.map(([t, p]) => k.publish(t, p));
    };
    const r1 = run();
    const r2 = run();
    for (let i = 0; i < r1.length; i++) {
      assert.strictEqual(r1[i].envelope.kernelEventId, r2[i].envelope.kernelEventId);
      assert.strictEqual(r1[i].envelope.kernelLogicalSequence, r2[i].envelope.kernelLogicalSequence);
    }
  });
});
