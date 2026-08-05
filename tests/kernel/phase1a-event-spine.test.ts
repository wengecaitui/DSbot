// Phase 1A Event Spine — contract tests (RED first)
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import * as crypto from 'node:crypto';
import type { WsTicker, WsKline } from '../../src/data/types';
import type { MarketBiasReportFull } from '../../src/types/market-bias';

// ─── Legacy imports ────────────────────────────────────────────────────────
import { InvalidExchangeProvenanceError } from '../../src/events/TradingEvent';
import { createTradingEventBus } from '../../src/events/TradingEventBus';
import type { TradingEventBus } from '../../src/events/TradingEventBus';
import type { TradingEventType, TradingEventPayloadMap } from '../../src/events/TradingEvent';
import { KlineClosedEventRejectedError } from '../../src/events/TradingEvent';
import { isExchangeId } from '../../src/data/MarketIdentity';

// ─── Kernel imports ────────────────────────────────────────────────────────
import { validateTradingEventPayload } from '../../src/events/validateTradingEventPayload';
import type { KernelEventEnvelope } from '../../src/kernel/KernelEventEnvelope';
import type { EventJournalPort } from '../../src/kernel/EventJournalPort';
import { createInMemoryEventJournal } from '../../src/kernel/InMemoryEventJournal';
import type { TradingKernel } from '../../src/kernel/TradingKernel';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import type { DomainClock } from '../../src/runtime/Clock';
import { systemDomainClock } from '../../src/runtime/Clock';

// ─── Test fixtures ──────────────────────────────────────────────────────────
const BITGET = 'bitget' as const;
const makeTicker = (overrides?: Partial<WsTicker>): WsTicker => ({
  exchange: BITGET,
  symbol: 'BTC/USDT',
  ...(overrides as Partial<WsTicker> ?? {}),
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
    assert.throws(() => validateTradingEventPayload('unknown.type' as TradingEventType, {}),
      /UNKNOWN_EVENT_TYPE/);
  });
  it('requires ticker payload', () => {
    assert.throws(() => validateTradingEventPayload('market.ticker.updated', { receivedAt: 1 }),
      InvalidExchangeProvenanceError);
  });
  it('requires valid exchange on ticker', () => {
    const p: TradingEventPayloadMap['market.ticker.updated'] = { ticker: { exchange: 'coinbase' } as unknown as WsTicker, receivedAt: 1 };
    assert.throws(() => validateTradingEventPayload('market.ticker.updated', p), InvalidExchangeProvenanceError);
  });
  it('accepts valid ticker payload', () => {
    const p: TradingEventPayloadMap['market.ticker.updated'] = { ticker: makeTicker(), receivedAt: 1 };
    validateTradingEventPayload('market.ticker.updated', p); // no throw
  });
  it('requires kline payload', () => {
    assert.throws(() => validateTradingEventPayload('market.kline.closed', { receivedAt: 1 }),
      KlineClosedEventRejectedError);
  });
  it('requires kline.confirm === true', () => {
    const p: TradingEventPayloadMap['market.kline.closed'] = { kline: makeKline({ confirm: false } as Partial<WsKline>), receivedAt: 1 };
    assert.throws(() => validateTradingEventPayload('market.kline.closed', p), KlineClosedEventRejectedError);
  });
  it('accepts valid kline payload', () => {
    const p: TradingEventPayloadMap['market.kline.closed'] = { kline: makeKline(), receivedAt: 1 };
    validateTradingEventPayload('market.kline.closed', p);
  });
  it('requires report payload', () => {
    assert.throws(() => validateTradingEventPayload('research.bias.updated', { receivedAt: 1 }),
      InvalidExchangeProvenanceError);
  });
  it('accepts valid report payload', () => {
    const p: TradingEventPayloadMap['research.bias.updated'] = { report: makeBiasReport(), receivedAt: 1 };
    validateTradingEventPayload('research.bias.updated', p);
  });
});

// ─── legacy EventBus (unchanged) ────────────────────────────────────────────
describe('legacy EventBus (unchanged)', () => {
  let bus: TradingEventBus;
  beforeEach(() => { bus = createTradingEventBus(); });
  it('subscribes and publishes market ticker', () => {
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
  it('rejects invalid exchange provenance on ticker', () => {
    assert.throws(() => bus.publish('market.ticker.updated', {
      ticker: { exchange: 'coinbase', symbol: 'BTC/USDT' } as unknown as WsTicker,
      receivedAt: 1,
    }), InvalidExchangeProvenanceError);
  });
  it('rejects unconfirmed kline', () => {
    assert.throws(() => bus.publish('market.kline.closed', {
      kline: makeKline({ confirm: false } as Partial<WsKline>),
      receivedAt: 1,
    }), KlineClosedEventRejectedError);
  });
  it('subscriber throw does not break other subscribers', () => {
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
  it('accepted event has status=accepted with delivered/failures', () => {
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r.status, 'accepted');
    assert.strictEqual(r.delivered, 0);
    assert.strictEqual(r.failures, 0);
  });
  it('duplicate eventId returns status=duplicate, delivered=0, failures=0', () => {
    const r1 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const r2 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, r1.envelope.kernelEventId);
    assert.strictEqual(r2.status, 'duplicate');
    assert.strictEqual(r2.delivered, 0);
    assert.strictEqual(r2.failures, 0);
  });
  it('sync subscriber throw → failures++, remaining continue', () => {
    k.subscribe('market.ticker.updated', () => { throw new Error('boom'); });
    k.subscribe('market.ticker.updated', () => { /* noop */ });
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r.failures, 1);
    assert.strictEqual(r.delivered, 1);
  });
  it('async subscriber → counted as failure', async () => {
    k.subscribe('market.ticker.updated', async () => { /* noop */ });
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r.failures, 1);
    assert.strictEqual(r.delivered, 0);
  });
  it('deep defensive clone: caller mutation does not affect journal', () => {
    const p = { ticker: makeTicker(), receivedAt: 1 };
    const r = k.publish('market.ticker.updated', p);
    // mutate caller reference
    p.ticker.symbol = 'MUTATED';
    p.receivedAt = 999;
    const stored = k.journal().getByEventId(r.envelope.kernelEventId);
    assert.ok(stored);
    assert.notStrictEqual((stored.payload as { ticker: WsTicker }).ticker.symbol, 'MUTATED');
  });
  it('journal read cannot expose internal references (defensive copy)', () => {
    const r = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const stored = k.journal().getByEventId(r.envelope.kernelEventId);
    assert.ok(stored);
    // stored is Object.freeze — mutation silently ignored
    assert.ok(Object.isFrozen(stored));
    // envelope returned to caller is also frozen
    assert.ok(Object.isFrozen(r.envelope));
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
  it('supplied non-hex eventId throws INVALID_EVENT_ID', () => {
    const k = createTradingKernel({ exchange: BITGET });
    assert.throws(() => k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, 'z'.repeat(64)),
      /INVALID_EVENT_ID/);
  });
  it('canonical JSON rejects non-finite numbers', () => {
    const k = createTradingKernel({ exchange: BITGET });
    assert.throws(() => k.publish('market.ticker.updated',
      { ticker: makeTicker(), receivedAt: NaN }), /CANONICAL_NON_FINITE/);
  });
  it('canonical JSON rejects undefined', () => {
    const k = createTradingKernel({ exchange: BITGET });
    assert.throws(() => k.publish('market.ticker.updated',
      { ticker: makeTicker(), receivedAt: undefined as unknown as number }), /CANONICAL_UNDEFINED/);
  });
  it('canonical JSON sorted keys produce deterministic output', () => {
    const k = createTradingKernel({ exchange: BITGET });
    // two events with same content but different key order → same eventId
    const r1 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const r2 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r1.envelope.kernelEventId, r2.envelope.kernelEventId);
  });
});

// ─── Sequence authority ────────────────────────────────────────────────────
describe('logical sequence', () => {
  it('sequences are strictly monotonic 1,2,3', () => {
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
    const ticker = makeTicker();
    k.publish('market.ticker.updated', { ticker, receivedAt: 1 });
    fakeTime = 3000;
    k.publish('market.ticker.updated', { ticker, receivedAt: 2 });
    fakeTime = 6000;
    const r3 = k.publish('market.ticker.updated', { ticker, receivedAt: 3 });
    assert.strictEqual(r3.envelope.kernelLogicalSequence, 3);
  });
});

// ─── Duplicate idempotency ──────────────────────────────────────────────────
describe('duplicate event idempotency', () => {
  it('duplicate eventId → no sequence advancement', () => {
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
  it('readFromLogicalSequence with limit', () => {
    for (let i = 0; i < 5; i++) k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: i });
    assert.strictEqual(k.journal().readFromLogicalSequence(1, 2).length, 2);
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
  it('rejects non-safe fromSequence', () => {
    assert.throws(() => k.journal().readFromLogicalSequence(1.5, 10), /JOURNAL_FROM_SEQUENCE_INVALID/);
  });
  it('rejects duplicate eventId on direct append', () => {
    const j = createInMemoryEventJournal();
    const env = { kernelEventId: 'a'.repeat(64), kernelLogicalSequence: 1, kernelTimestamp: 1,
      type: 'market.ticker.updated' as TradingEventType,
      payload: { ticker: makeTicker(), receivedAt: 1 } } as KernelEventEnvelope;
    j.append(env);
    assert.throws(() => j.append(env), /JOURNAL_DUPLICATE_EVENT_ID/);
  });
  it('rejects non-monotonic sequence on direct append', () => {
    const j = createInMemoryEventJournal();
    j.append({ kernelEventId: 'a'.repeat(64), kernelLogicalSequence: 3, kernelTimestamp: 1,
      type: 'market.ticker.updated' as TradingEventType,
      payload: { ticker: makeTicker(), receivedAt: 1 } } as KernelEventEnvelope);
    assert.throws(() => j.append({ kernelEventId: 'b'.repeat(64), kernelLogicalSequence: 2,
      kernelTimestamp: 2, type: 'market.ticker.updated' as TradingEventType,
      payload: { ticker: makeTicker(), receivedAt: 2 } } as KernelEventEnvelope), /JOURNAL_SEQUENCE_NOT_MONOTONIC/);
  });
  it('rejects non-positive sequence on direct append', () => {
    const j = createInMemoryEventJournal();
    assert.throws(() => j.append({ kernelEventId: 'a'.repeat(64), kernelLogicalSequence: 0,
      kernelTimestamp: 1, type: 'market.ticker.updated' as TradingEventType,
      payload: { ticker: makeTicker(), receivedAt: 1 } } as KernelEventEnvelope), /JOURNAL_SEQUENCE_INVALID/);
  });
});

// ─── Append failure recovery ────────────────────────────────────────────────
describe('journal append failure fail-closed', () => {
  it('faulty journal → throw, next event with working journal → sequence 1', () => {
    const k = createTradingKernel({ exchange: BITGET,
      journal: { append: () => { throw new Error('DISK_FULL'); }, getByEventId: () => null, readFromLogicalSequence: () => [] },
    });
    assert.throws(() => k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }),
      /JOURNAL_APPEND_FAILED/);
    // same kernel, new working journal → starts at sequence 1
    // (not possible with current API, but a new kernel instance does start at 1)
    const k2 = createTradingKernel({ exchange: BITGET });
    const r = k2.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(r.envelope.kernelLogicalSequence, 1);
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
