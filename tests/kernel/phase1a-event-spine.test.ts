// Phase 1A Event Spine — contract tests (RED first)
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import * as crypto from 'node:crypto';
import type { WsTicker, WsKline } from '../../src/data/types';
import type { MarketBiasReportFull } from '../../src/types/market-bias';

// ─── Legacy imports ────────────────────────────────────────────────────────
import { createTradingEventBus } from '../../src/events/TradingEventBus';
import type { TradingEventBus } from '../../src/events/TradingEventBus';
import { InvalidExchangeProvenanceError } from '../../src/events/TradingEventBus';
import type { TradingEventType, TradingEventPayloadMap } from '../../src/events/TradingEvent';
import { KlineClosedEventRejectedError } from '../../src/events/TradingEvent';
import { isExchangeId } from '../../src/data/MarketIdentity';

// ─── Kernel imports (will be RED until implemented) ─────────────────────────
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
  symbol: 'BTC/USDT', ...(overrides as Partial<WsTicker> ?? {}),
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
    validateTradingEventPayload('market.kline.closed', p); // no throw
  });

  it('requires report payload', () => {
    assert.throws(() => validateTradingEventPayload('research.bias.updated', { receivedAt: 1 }),
      InvalidExchangeProvenanceError);
  });

  it('accepts valid report payload', () => {
    const p: TradingEventPayloadMap['research.bias.updated'] = { report: makeBiasReport(), receivedAt: 1 };
    validateTradingEventPayload('research.bias.updated', p); // no throw
  });
});

// ─── legacy EventBus compatibility ──────────────────────────────────────────
describe('legacy EventBus (unchanged)', () => {
  let bus: TradingEventBus;
  beforeEach(() => { bus = createTradingEventBus(); });

  it('subscribes and publishes market ticker', () => {
    let captured: unknown = null;
    bus.subscribe('market.ticker.updated', (e) => { captured = e; });
    const ticker = makeTicker();
    bus.publish('market.ticker.updated', { ticker, receivedAt: 1 });
    assert.ok(captured);
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

// ─── KernelEventEnvelope ────────────────────────────────────────────────────
describe('KernelEventEnvelope', () => {
  let kernel: TradingKernel;
  beforeEach(() => { kernel = createTradingKernel({ exchange: BITGET }); });

  it('has kernelEventId as 64-char hex', () => {
    const env = kernel.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(typeof env.kernelEventId, 'string');
    assert.match(env.kernelEventId, /^[0-9a-f]{64}$/);
  });

  it('has kernelLogicalSequence as number', () => {
    const env = kernel.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.ok(Number.isSafeInteger(env.kernelLogicalSequence));
  });

  it('has kernelTimestamp as number', () => {
    const env = kernel.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.ok(Number.isFinite(env.kernelTimestamp) && env.kernelTimestamp >= 0);
  });

  it('envelope is defensive immutable (frozen)', () => {
    const env = kernel.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.ok(Object.isFrozen(env));
    // mutation attempt has no effect in strict mode
    const copy = { ...env };
    (copy as Record<string,unknown>).kernelEventId = 'tampered';
    assert.notStrictEqual(copy.kernelEventId, env.kernelEventId);
  });
});

// ─── Deterministic eventId ──────────────────────────────────────────────────
describe('deterministic eventId', () => {
  it('same payload → same eventId', () => {
    const k1 = createTradingKernel({ exchange: BITGET });
    const k2 = createTradingKernel({ exchange: BITGET });
    const ticker = makeTicker();
    const e1 = k1.publish('market.ticker.updated', { ticker, receivedAt: 1 });
    const e2 = k2.publish('market.ticker.updated', { ticker, receivedAt: 1 });
    assert.strictEqual(e1.kernelEventId, e2.kernelEventId);
  });

  it('different payload → different eventId', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const e1 = k.publish('market.ticker.updated', { ticker: makeTicker({ last: 100 } as Partial<WsTicker>), receivedAt: 1 });
    const e2 = k.publish('market.ticker.updated', { ticker: makeTicker({ last: 101 } as Partial<WsTicker>), receivedAt: 2 });
    assert.notStrictEqual(e1.kernelEventId, e2.kernelEventId);
  });

  it('supplied valid eventId is accepted', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const supplied = 'a'.repeat(64);
    const env = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, supplied);
    assert.strictEqual(env.kernelEventId, supplied);
  });

  it('invalid supplied eventId (wrong length) throws', () => {
    const k = createTradingKernel({ exchange: BITGET });
    assert.throws(() => k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, 'abc'),
      /INVALID_EVENT_ID/);
  });

  it('supplied non-hex eventId throws', () => {
    const k = createTradingKernel({ exchange: BITGET });
    assert.throws(() => k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, 'z'.repeat(64)),
      /INVALID_EVENT_ID/);
  });
});

// ─── Sequence authority ─────────────────────────────────────────────────────
describe('logical sequence', () => {
  it('sequences are strictly monotonic', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const ticker = makeTicker();
    const s1 = k.publish('market.ticker.updated', { ticker, receivedAt: 1 }).kernelLogicalSequence;
    const s2 = k.publish('market.ticker.updated', { ticker, receivedAt: 2 }).kernelLogicalSequence;
    const s3 = k.publish('market.ticker.updated', { ticker, receivedAt: 3 }).kernelLogicalSequence;
    assert.ok(s1 === 1 && s2 === 2 && s3 === 3);
  });

  it('sequence advances even with DomainClock rollback', () => {
    let fakeTime = 5000;
    const fakeClock: DomainClock = { now: () => fakeTime };
    const k = createTradingKernel({ exchange: BITGET, clock: fakeClock });
    const ticker = makeTicker();
    // First event at T=5000
    const s1 = k.publish('market.ticker.updated', { ticker, receivedAt: 1 }).kernelLogicalSequence;
    // Roll clock back to T=3000
    fakeTime = 3000;
    const s2 = k.publish('market.ticker.updated', { ticker, receivedAt: 2 }).kernelLogicalSequence;
    // Roll forward to T=6000
    fakeTime = 6000;
    const s3 = k.publish('market.ticker.updated', { ticker, receivedAt: 3 }).kernelLogicalSequence;
    assert.deepStrictEqual([s1, s2, s3], [1, 2, 3]);
  });
});

// ─── Duplicate idempotency ──────────────────────────────────────────────────
describe('duplicate event idempotency', () => {
  it('re-publish same eventId → no new sequence, no journal append', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const env = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    // Should return the same envelope
    const env2 = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }, env.kernelEventId);
    assert.strictEqual(env2, env);
    // Sequence did NOT advance
    const env3 = k.publish('market.kline.closed', { kline: makeKline(), receivedAt: 2 });
    assert.strictEqual(env3.kernelLogicalSequence, 2); // only incremented once for the kline
  });
});

// ─── Invalid event handling ─────────────────────────────────────────────────
describe('invalid event handling', () => {
  it('invalid event type → no journal append, no dispatch, throws', () => {
    const k = createTradingKernel({ exchange: BITGET });
    assert.throws(() => k.publish('unknown.type' as TradingEventType, {}), /UNKNOWN_EVENT_TYPE/);
  });

  it('invalid event is not journaled', () => {
    const k = createTradingKernel({ exchange: BITGET });
    try { k.publish('unknown.type' as TradingEventType, {}); } catch { /* expected */ }
    // Journal must be empty
    const entries = k.journal().readFromLogicalSequence(1, 10);
    assert.strictEqual(entries.length, 0);
  });
});

// ─── Journal ────────────────────────────────────────────────────────────────
describe('InMemoryEventJournal', () => {
  let k: TradingKernel;
  beforeEach(() => { k = createTradingKernel({ exchange: BITGET }); });

  it('appended events are retrievable by eventId', () => {
    const env = k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    const found = k.journal().getByEventId(env.kernelEventId);
    assert.ok(found);
    assert.strictEqual(found.kernelEventId, env.kernelEventId);
  });

  it('non-existent eventId returns null', () => {
    assert.strictEqual(k.journal().getByEventId('a'.repeat(64)), null);
  });

  it('readFromLogicalSequence returns ordered', () => {
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    k.publish('market.kline.closed', { kline: makeKline(), receivedAt: 2 });
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 3 });
    const entries = k.journal().readFromLogicalSequence(1, 10);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].kernelLogicalSequence, 1);
    assert.strictEqual(entries[1].kernelLogicalSequence, 2);
    assert.strictEqual(entries[2].kernelLogicalSequence, 3);
  });

  it('readFromLogicalSequence with limit', () => {
    for (let i = 0; i < 5; i++) k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: i });
    const entries = k.journal().readFromLogicalSequence(1, 2);
    assert.strictEqual(entries.length, 2);
  });

  it('readFromLogicalSequence from nonexistent sequence returns empty', () => {
    const entries = k.journal().readFromLogicalSequence(999, 10);
    assert.strictEqual(entries.length, 0);
  });
});

// ─── Subscriber dispatch (handler isolation) ────────────────────────────────
describe('kernel subscriber dispatch', () => {
  it('subscribe and receive events', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const events: KernelEventEnvelope[] = [];
    k.subscribe('market.ticker.updated', (e) => events.push(e));
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(events.length, 1);
  });

  it('subscriber throw does not break others', () => {
    const k = createTradingKernel({ exchange: BITGET });
    const calls: string[] = [];
    k.subscribe('market.ticker.updated', () => { calls.push('fail'); throw new Error('boom'); });
    k.subscribe('market.ticker.updated', () => { calls.push('pass'); });
    k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.deepStrictEqual(calls, ['fail', 'pass']);
  });
});

// ─── Kernel instance isolation ──────────────────────────────────────────────
describe('kernel instance isolation', () => {
  it('two kernels have independent sequences', () => {
    const k1 = createTradingKernel({ exchange: BITGET });
    const k2 = createTradingKernel({ exchange: BITGET });
    const ticker = makeTicker();
    const s1 = k1.publish('market.ticker.updated', { ticker, receivedAt: 1 }).kernelLogicalSequence;
    const s2 = k2.publish('market.ticker.updated', { ticker, receivedAt: 1 }).kernelLogicalSequence;
    assert.strictEqual(s1, 1);
    assert.strictEqual(s2, 1);
  });

  it('two kernels have independent journals', () => {
    const k1 = createTradingKernel({ exchange: BITGET });
    const k2 = createTradingKernel({ exchange: BITGET });
    k1.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(k2.journal().readFromLogicalSequence(1, 10).length, 0);
  });
});

// ─── Journal append failure ─────────────────────────────────────────────────
describe('journal append failure fail-closed', () => {
  it('faulty journal → throw, no sequence advancement', () => {
    const brokenJournal: EventJournalPort = {
      append: () => { throw new Error('DISK_FULL'); },
      getByEventId: () => null,
      readFromLogicalSequence: () => [],
    };
    const k = createTradingKernel({ exchange: BITGET, journal: brokenJournal });
    assert.throws(() => k.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 }),
      /DISK_FULL/);
    // Next event with a working journal gets sequence 1
    const k2 = createTradingKernel({ exchange: BITGET });
    const env = k2.publish('market.ticker.updated', { ticker: makeTicker(), receivedAt: 1 });
    assert.strictEqual(env.kernelLogicalSequence, 1);
  });
});

// ─── Deterministic identity → identical streams → identical IDs/order ───────
describe('deterministic replay', () => {
  it('identical input streams produce identical envelopes and order', () => {
    const ticker = makeTicker();
    const events: Array<[TradingEventType, TradingEventPayloadMap[TradingEventType]]> = [
      ['market.ticker.updated', { ticker, receivedAt: 1 }],
      ['market.ticker.updated', { ticker, receivedAt: 2 }],
    ];
    const run = () => {
      const k = createTradingKernel({ exchange: BITGET });
      return events.map(([t, p]) => k.publish(t, p));
    };
    const r1 = run();
    const r2 = run();
    for (let i = 0; i < r1.length; i++) {
      assert.strictEqual(r1[i].kernelEventId, r2[i].kernelEventId);
      assert.strictEqual(r1[i].kernelLogicalSequence, r2[i].kernelLogicalSequence);
    }
  });
});
