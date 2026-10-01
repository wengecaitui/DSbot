import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createGateIoEconomicLedger,
  gateIoEconomicFactDigest,
  gateIoEconomicIdentity,
  recordGateIoEconomicFact,
} from '../../src/accounting/gateio-economic-ledger';
import { GATEIO_ECONOMIC_EVENT_RECORDED } from '../../src/accounting/gateio-economic-ledger-types';
import { normalizeGateIoAccountBookPage } from '../../src/accounting/gateio-economic-truth';
import type { GateIoCanonicalEconomicEvent } from '../../src/accounting/gateio-economic-truth-types';
import type { TradingEventPayloadMap } from '../../src/events/TradingEvent';
import { validateTradingEventPayload } from '../../src/events/validateTradingEventPayload';
import type { KernelEventEnvelope } from '../../src/kernel/KernelEventEnvelope';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createFileEventJournal, type FileEventJournal } from '../../src/recovery/FileEventJournal';
import { replayJournal, type ProjectorMap } from '../../src/recovery/ReplayCoordinator';

const BASE_MS = 1_800_000_000_000;

function fact(overrides: {
  id?: string;
  change?: string;
  balance?: string;
  type?: string;
  time?: number;
  contract?: string | null;
  tradeId?: string | null;
  text?: string | null;
  observedAt?: number;
  pageRequest?: Record<string, unknown>;
  rawPayloadDigest?: string;
} = {}): GateIoCanonicalEconomicEvent {
  const raw: Record<string, unknown> = {
    id: overrides.id ?? 'ledger-row-1',
    time: overrides.time ?? 1_800_000_000.125,
    change: overrides.change ?? '-0.000000000000000123456789',
    balance: overrides.balance ?? '1234567890.123456789012345678',
    type: overrides.type ?? 'fee',
  };
  if (overrides.contract !== null) raw.contract = overrides.contract ?? 'ETH_USDT';
  if (overrides.tradeId !== null) raw.trade_id = overrides.tradeId ?? '9223372036854775806';
  if (overrides.text !== null) raw.text = overrides.text ?? 'economic-fact';
  const event = normalizeGateIoAccountBookPage([raw], {
    observedAt: overrides.observedAt ?? BASE_MS,
    pageRequest: (overrides.pageRequest ?? { limit: 100, offset: 0 }) as never,
  })[0];
  assert.ok(event);
  if (overrides.rawPayloadDigest === undefined) return event;
  return Object.freeze({
    ...event,
    capture: Object.freeze({ ...event.capture, rawPayloadDigest: overrides.rawPayloadDigest }),
  });
}

function projectors(ledger: ReturnType<typeof createGateIoEconomicLedger>): ProjectorMap {
  return new Map([[GATEIO_ECONOMIC_EVENT_RECORDED, [ledger]]]) as ProjectorMap;
}

function kernel(journal: FileEventJournal) {
  return createTradingKernel({
    exchange: 'gateio',
    journal,
    initialSequence: journal.lastSequence,
    clock: { now: () => BASE_MS + journal.lastSequence + 1 },
  });
}

function withJournal(
  run: (journal: FileEventJournal, path: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'gate-economic-ledger-'));
  const path = join(dir, 'journal.jsonl');
  try {
    run(createFileEventJournal(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Gate.io durable economic ledger', () => {
  it('appends two identities and deterministically rebuilds facts, digests and local boundary', () => {
    withJournal((journal, path) => {
      const live = createGateIoEconomicLedger();
      const writer = kernel(journal);
      assert.equal(recordGateIoEconomicFact(writer, live, fact({ id: 'row-a' })).status,
        'RECORDED_NEW_FACT');
      assert.equal(recordGateIoEconomicFact(writer, live, fact({ id: 'row-b', type: 'fund' })).status,
        'RECORDED_NEW_FACT');
      assert.equal(journal.eventCount, 2);
      assert.deepEqual(journal.readFromLogicalSequence(1).map((event) => event.kernelLogicalSequence), [1, 2]);

      const recovered = createGateIoEconomicLedger();
      const reopened = createFileEventJournal(path);
      const report = replayJournal(reopened, projectors(recovered));
      assert.deepEqual(report.errors, []);
      assert.equal(report.eventsReplayed, 2);
      const snapshot = recovered.snapshot();
      assert.equal(snapshot.uniqueIdentityCount, 2);
      assert.equal(snapshot.facts.length, 2);
      assert.equal(snapshot.facts.every((entry) => entry.factDigest.length === 64), true);
      assert.deepEqual(snapshot.captureBoundary, {
        kind: 'LOCAL_JOURNAL_SEQUENCE_ONLY',
        lastKernelLogicalSequence: 2,
        lastKernelEventId: reopened.readFromLogicalSequence(2, 1)[0]?.kernelEventId,
      });
      assert.equal('cursor' in snapshot, false);
      assert.equal('accountActivityReconciled' in snapshot, false);
    });
  });

  it('deduplicates both an exact retry and different capture provenance without a second fact', () => {
    withJournal((journal) => {
      const ledger = createGateIoEconomicLedger();
      const writer = kernel(journal);
      const first = fact();
      const exactRetry = recordGateIoEconomicFact(writer, ledger, first);
      assert.equal(exactRetry.status, 'RECORDED_NEW_FACT');
      assert.equal(recordGateIoEconomicFact(writer, ledger, first).status, 'DUPLICATE_SAME_FACT');
      assert.equal(journal.eventCount, 1, 'identical payload is kernel-idempotent');

      const secondCapture = fact({
        observedAt: BASE_MS + 5_000,
        pageRequest: { limit: 50, offset: 100, type: 'fee' },
      });
      assert.equal(gateIoEconomicFactDigest(first), gateIoEconomicFactDigest(secondCapture));
      assert.equal(recordGateIoEconomicFact(writer, ledger, secondCapture).status,
        'DUPLICATE_SAME_FACT');
      assert.equal(journal.eventCount, 2, 'new capture remains durable evidence');
      const snapshot = ledger.snapshot();
      assert.equal(snapshot.uniqueIdentityCount, 1);
      assert.equal(snapshot.facts[0]?.captures.length, 2);
      assert.equal(snapshot.facts[0]?.fact.change, first.change);
    });
  });

  it('fails closed on identity conflict, never overwrites, and reconstructs the conflict on replay', () => {
    withJournal((journal, path) => {
      const ledger = createGateIoEconomicLedger();
      const writer = kernel(journal);
      const accepted = fact({ id: 'same-id', change: '-1.25' });
      const conflict = fact({ id: 'same-id', change: '9.75', observedAt: BASE_MS + 1 });
      assert.equal(recordGateIoEconomicFact(writer, ledger, accepted).status, 'RECORDED_NEW_FACT');
      assert.equal(recordGateIoEconomicFact(writer, ledger, conflict).status, 'IDENTITY_CONFLICT');
      assert.equal(recordGateIoEconomicFact(writer, ledger, fact({
        id: 'same-id', change: '-1.25', observedAt: BASE_MS + 2,
        pageRequest: { limit: 50, offset: 50 },
      })).status, 'IDENTITY_CONFLICT', 'a conflicted identity remains fail-closed');
      assert.equal(journal.eventCount, 3, 'conflict and later capture evidence are append-only and durable');
      assert.equal(ledger.snapshot().facts[0]?.fact.change, '-1.25', 'no last-write-wins');
      assert.equal(ledger.snapshot().facts[0]?.captures.length, 2);
      assert.equal(ledger.snapshot().conflicts[0]?.conflictingFact.change, '9.75');

      const recovered = createGateIoEconomicLedger();
      const report = replayJournal(createFileEventJournal(path), projectors(recovered));
      assert.equal(report.errors.length, 2);
      assert.equal(report.errors.every((entry) =>
        /GATEIO_ECONOMIC_IDENTITY_CONFLICT/.test(entry.message)), true);
      const snapshot = recovered.snapshot();
      assert.equal(snapshot.hasIdentityConflict, true);
      assert.equal(snapshot.facts[0]?.fact.change, '-1.25');
      assert.equal(snapshot.facts[0]?.captures.length, 2);
      assert.equal(snapshot.conflicts[0]?.conflictingFact.change, '9.75');
      assert.equal(snapshot.captureBoundary?.lastKernelLogicalSequence, 3);
    });
  });

  it('replays before restart append so a repeated fact remains deduplicated across processes', () => {
    withJournal((journal, path) => {
      const firstLedger = createGateIoEconomicLedger();
      recordGateIoEconomicFact(kernel(journal), firstLedger, fact());

      const reopened = createFileEventJournal(path);
      const restartedLedger = createGateIoEconomicLedger();
      assert.deepEqual(replayJournal(reopened, projectors(restartedLedger)).errors, []);
      const changedCapture = fact({
        observedAt: BASE_MS + 10_000,
        pageRequest: { from: '0', limit: 25 },
      });
      const result = recordGateIoEconomicFact(kernel(reopened), restartedLedger, changedCapture);
      assert.equal(result.status, 'DUPLICATE_SAME_FACT');
      assert.equal(restartedLedger.snapshot().uniqueIdentityCount, 1);
      assert.equal(restartedLedger.snapshot().facts[0]?.captures.length, 2);

      const secondRestart = createGateIoEconomicLedger();
      const finalJournal = createFileEventJournal(path);
      assert.deepEqual(replayJournal(finalJournal, projectors(secondRestart)).errors, []);
      assert.equal(secondRestart.snapshot().uniqueIdentityCount, 1);
      assert.equal(secondRestart.snapshot().facts[0]?.captures.length, 2);
    });
  });

  it('produces byte-identical snapshots and projector digests for identical replay', () => {
    withJournal((journal, path) => {
      const writerLedger = createGateIoEconomicLedger();
      const writer = kernel(journal);
      recordGateIoEconomicFact(writer, writerLedger, fact({ id: 'b' }));
      recordGateIoEconomicFact(writer, writerLedger, fact({ id: 'a', type: 'pnl' }));
      recordGateIoEconomicFact(writer, writerLedger, fact({
        id: 'a', type: 'pnl', observedAt: BASE_MS + 1, pageRequest: { offset: 20 },
      }));

      const replay = () => {
        const ledger = createGateIoEconomicLedger();
        const report = replayJournal(createFileEventJournal(path), projectors(ledger));
        assert.deepEqual(report.errors, []);
        return ledger;
      };
      const first = replay();
      const second = replay();
      assert.equal(JSON.stringify(first.snapshot()), JSON.stringify(second.snapshot()));
      assert.equal(first.digest(), second.digest());
    });
  });

  it('preserves decimal precision, signs, UNCLASSIFIED and optional-field absence through replay', () => {
    withJournal((journal, path) => {
      const ledger = createGateIoEconomicLedger();
      const writer = kernel(journal);
      recordGateIoEconomicFact(writer, ledger, fact({
        id: 'negative', change: '-999999999999999999.000000000000000001',
        balance: '0.0000000000000000001', type: 'future_type',
        contract: null, tradeId: null, text: null,
      }));
      recordGateIoEconomicFact(writer, ledger, fact({
        id: 'positive', change: '999999999999999999.000000000000000001',
      }));
      const recovered = createGateIoEconomicLedger();
      assert.deepEqual(replayJournal(createFileEventJournal(path), projectors(recovered)).errors, []);
      const facts = recovered.snapshot().facts.map((entry) => entry.fact);
      const negative = facts.find((entry) => entry.sourceId === 'negative');
      const positive = facts.find((entry) => entry.sourceId === 'positive');
      assert.equal(negative?.change, '-999999999999999999.000000000000000001');
      assert.equal(negative?.balance, '0.0000000000000000001');
      assert.equal(negative?.category, 'UNCLASSIFIED');
      assert.equal(negative?.rawType, 'future_type');
      assert.equal('contract' in (negative ?? {}), false);
      assert.equal('tradeId' in (negative ?? {}), false);
      assert.equal('text' in (negative ?? {}), false);
      assert.equal(positive?.change, '999999999999999999.000000000000000001');
    });
  });

  it('rejects malformed durable payload before append and during replay of direct journal data', () => {
    withJournal((journal) => {
      const writer = kernel(journal);
      const valid = fact();
      const payload: TradingEventPayloadMap['GATEIO_ECONOMIC_EVENT_RECORDED'] = {
        fact: valid, factDigest: '0'.repeat(64),
      };
      assert.throws(
        () => writer.publish(GATEIO_ECONOMIC_EVENT_RECORDED, payload),
        /GATEIO_ECONOMIC_FACT_DIGEST_MISMATCH/,
      );
      assert.equal(journal.eventCount, 0);

      const malformed = {
        ...valid,
        change: 1,
      } as unknown as GateIoCanonicalEconomicEvent;
      const envelope = {
        kernelEventId: 'a'.repeat(64), kernelLogicalSequence: 1, kernelTimestamp: BASE_MS,
        type: GATEIO_ECONOMIC_EVENT_RECORDED,
        payload: { fact: malformed, factDigest: 'b'.repeat(64) },
      } as unknown as KernelEventEnvelope;
      journal.append(envelope);
      const recovered = createGateIoEconomicLedger();
      const report = replayJournal(journal, projectors(recovered));
      assert.equal(report.errors.length, 1);
      assert.match(report.errors[0]?.message ?? '', /GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID/);
      assert.equal(recovered.snapshot().uniqueIdentityCount, 0);
    });
  });

  it('retains journal checksum and sequence protection for economic events', () => {
    withJournal((journal, path) => {
      const ledger = createGateIoEconomicLedger();
      const writer = kernel(journal);
      recordGateIoEconomicFact(writer, ledger, fact({ id: 'one' }));
      recordGateIoEconomicFact(writer, ledger, fact({ id: 'two' }));
      assert.deepEqual(journal.readFromLogicalSequence(1).map((entry) => entry.kernelLogicalSequence), [1, 2]);

      const raw = readFileSync(path, 'utf8');
      assert.match(raw, /-0\.000000000000000123456789/);
      writeFileSync(path, raw.replace('-0.000000000000000123456789', '-9.9'), 'utf8');
      assert.throws(() => createFileEventJournal(path), /JOURNAL_CHECKSUM_MISMATCH/);
    });
  });

  it('binds identity to exchange, settle, source and id while excluding capture from fact digest', () => {
    const first = fact();
    const second = fact({
      observedAt: BASE_MS + 99_999,
      pageRequest: { contract: 'ETH_USDT', from: '0', limit: 1, offset: 999 },
    });
    assert.equal(gateIoEconomicIdentity(first),
      '["gateio","usdt","futures_account_book","ledger-row-1"]');
    assert.equal(gateIoEconomicIdentity(first), gateIoEconomicIdentity(second));
    assert.equal(gateIoEconomicFactDigest(first), gateIoEconomicFactDigest(second));
    assert.equal(first.capture.rawPayloadDigest, second.capture.rawPayloadDigest);
    assert.notDeepEqual(first.capture, second.capture);
    validateTradingEventPayload(GATEIO_ECONOMIC_EVENT_RECORDED, {
      fact: first,
      factDigest: gateIoEconomicFactDigest(first),
    });
  });
});
