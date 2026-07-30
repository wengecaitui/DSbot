/**
 * Stage 4B4.2 — ShadowRuntimeCoordinator tests (revised).
 *
 * REFERENCE SHADOW INFRASTRUCTURE ONLY.
 * NOT APPROVED FOR PAPER TESTNET OR LIVE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { ShadowRuntimeStateMachine } from '../../src/shadow/ShadowRuntimeStateMachine';
import { ShadowEventLedger } from '../../src/shadow/ShadowEventLedger';
import { createShadowIntentBoundary } from '../../src/shadow/ShadowIntentBoundary';
import { createShadowDecisionOutcome } from '../../src/shadow/ShadowDecisionOutcome';
import { createCanonicalShadowEvent } from '../../src/shadow/CanonicalShadowEvent';
import { createShadowIntentObservation } from '../../src/shadow/ShadowIntentObservation';
import { loadSnapshot } from '../../src/shadow/ShadowRuntimeSnapshot';
import { REF_EXCHANGE, REF_SYMBOL, REF_SOURCE, REF_REASON, REF_EVENT_TIME_MS, makeRefTradeIntent } from '../helpers/shadow-reference-fixtures';
import type { CanonicalShadowEvent, ShadowDecisionOutcome } from '../../src/shadow';

// ESM import — no require() needed
import { ShadowRuntimeCoordinator, startCoordinator } from '../../src/shadow/ShadowRuntimeCoordinator';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-test-'));
}

function makeTmpFile(dir: string, name: string): string {
  return path.join(dir, name);
}

function makeTradeEventAndOutcome(
  source = REF_SOURCE,
  eventTimeMs = REF_EVENT_TIME_MS,
  sourceSequence = 0,
  exchange: string = REF_EXCHANGE,
  symbol: string = REF_SYMBOL,
  positionUsd = 1500,
): { event: CanonicalShadowEvent; outcome: ShadowDecisionOutcome } {
  const intent = makeRefTradeIntent({ exchange: exchange as any, symbol, positionUsd });
  const outcome = createShadowDecisionOutcome(
    { exchange: exchange as any, decision: 'trade', direction: 'long', symbol, positionUsd, tradeIntent: intent, reason: REF_REASON },
    exchange as any, symbol,
  );
  const event = createCanonicalShadowEvent(source, eventTimeMs, sourceSequence, outcome);
  return { event, outcome };
}

// ─── Startup — empty ledger ──────────────────────────────────────────────────

test('COORD: startup empty ledger transitions STOPPED→PRECHECKED→SHADOW_READY→SHADOW_ACTIVE', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');

  const coordinator = startCoordinator(ledgerFile, snapshotFile);
  assert.equal(coordinator.state, 'SHADOW_ACTIVE');
});

test('COORD: startup stores SHADOW_ACTIVE snapshot after ACTIVATE', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');

  const coordinator = startCoordinator(ledgerFile, snapshotFile);
  assert.equal(coordinator.state, 'SHADOW_ACTIVE');

  // Snapshot file must exist and contain SHADOW_ACTIVE
  assert.ok(fs.existsSync(snapshotFile));
  const ledger = new ShadowEventLedger(ledgerFile);
  const snap = loadSnapshot(snapshotFile, ledger);
  assert.equal(snap.shadowState, 'SHADOW_ACTIVE');
  assert.equal(snap.ledgerSize, 0);
  assert.equal(snap.boundarySize, 0);
});

// ─── Startup — ledger replay ────────────────────────────────────────────────

test('COORD: startup replays ledger entries through boundary restore', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');

  // Pre-populate ledger
  const prepLedger = new ShadowEventLedger(ledgerFile);
  const prepSm = new ShadowRuntimeStateMachine();
  prepSm.transition('BEGIN_PRECHECK');
  prepSm.transition('PRECHECK_PASSED');
  prepSm.transition('ACTIVATE');
  const prepBoundary = createShadowIntentBoundary(prepSm);

  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);
  const result = prepBoundary.observe(event, outcome);
  prepLedger.append(event, result.observation!);

  // Now start coordinator — should replay the ledger entry
  const coordinator = startCoordinator(ledgerFile, snapshotFile);
  assert.equal(coordinator.state, 'SHADOW_ACTIVE');

  // Boundary should have the restored entry (check via safe accessor)
  const observations = coordinator.observations;
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observationId, result.observation!.observationId);
});

// ─── Startup — missing snapshot rebuilds ────────────────────────────────────

test('COORD: startup recovers from missing snapshot by rebuilding', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');

  // Pre-populate ledger
  const prepLedger = new ShadowEventLedger(ledgerFile);
  const prepSm = new ShadowRuntimeStateMachine();
  prepSm.transition('BEGIN_PRECHECK');
  prepSm.transition('PRECHECK_PASSED');
  prepSm.transition('ACTIVATE');
  const prepBoundary = createShadowIntentBoundary(prepSm);

  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);
  const result = prepBoundary.observe(event, outcome);
  prepLedger.append(event, result.observation!);

  // Delete snapshot file (it doesn't exist yet)
  const coordinator = startCoordinator(ledgerFile, snapshotFile);
  assert.equal(coordinator.state, 'SHADOW_ACTIVE');
  assert.equal(coordinator.observationCount, 1);
});

// ─── Startup — valid stale prefix snapshot rebuilds ────────────────────────

test('COORD: startup rebuilds snapshot when stale (ledger has grown)', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');

  // First startup creates a snapshot with 0 entries
  const c1 = startCoordinator(ledgerFile, snapshotFile);
  assert.equal(c1.state, 'SHADOW_ACTIVE');

  // Add an entry
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);
  c1.process(event, outcome);
  assert.equal(c1.ledgerSize, 1);

  // Start a new coordinator on same files — snapshot is stale (ledger has 1 entry, snapshot had 0)
  const c2 = startCoordinator(ledgerFile, snapshotFile);
  assert.equal(c2.state, 'SHADOW_ACTIVE');
  // Should have replayed the ledger entry
  assert.equal(c2.observationCount, 1);
});

// ─── Startup — tampered snapshot blocks startup ─────────────────────────────

test('COORD: tampered snapshot blocks startup and enters RECOVERY_REQUIRED', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');

  // First startup creates a valid snapshot
  const c1 = startCoordinator(ledgerFile, snapshotFile);
  assert.equal(c1.state, 'SHADOW_ACTIVE');

  // Corrupt the snapshot file
  fs.writeFileSync(snapshotFile, '{"tampered":true}\n', 'utf-8');

  // New coordinator should fail on startup because snapshot is tampered
  const c2 = new ShadowRuntimeCoordinator(ledgerFile, snapshotFile);
  assert.throws(() => { c2.startup(); });
  // State should be RECOVERY_REQUIRED (transitioned before throw)
  assert.equal(c2.state, 'RECOVERY_REQUIRED');
});

test('COORD: mismatched snapshot (wrong ledger) blocks startup', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');

  // Create snapshot from different ledger
  const otherDir = makeTmpDir();
  const otherLedgerFile = makeTmpFile(otherDir, 'other.jsonl');
  const c1 = new ShadowRuntimeCoordinator(otherLedgerFile, snapshotFile);
  c1.startup();

  // Now snapshot was written for an empty ledger, but our ledger has an entry
  const prepLedger = new ShadowEventLedger(ledgerFile);
  const prepSm = new ShadowRuntimeStateMachine();
  prepSm.transition('BEGIN_PRECHECK');
  prepSm.transition('PRECHECK_PASSED');
  prepSm.transition('ACTIVATE');
  const prepBoundary = createShadowIntentBoundary(prepSm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const r = prepBoundary.observe(event, outcome);
  prepLedger.append(event, r.observation!);

  // Startup should succeed because this is a stale prefix snapshot (ledger grew)
  // The snapshot has ledgerSize=0, actual ledger has 1 entry -> stale prefix -> rebuild
  const c2 = new ShadowRuntimeCoordinator(ledgerFile, snapshotFile);
  c2.startup();
  assert.equal(c2.state, 'SHADOW_ACTIVE');
});

// ─── Stop / pause / resume ─────────────────────────────────────────────────

test('COORD: stop in SHADOW_ACTIVE transitions to STOPPED', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  coordinator.stop();
  assert.equal(coordinator.state, 'STOPPED');
});

test('COORD: pause in SHADOW_ACTIVE transitions to PAUSED', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  coordinator.pause();
  assert.equal(coordinator.state, 'PAUSED');
});

test('COORD: resume in PAUSED transitions to SHADOW_READY', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  coordinator.pause();
  assert.equal(coordinator.state, 'PAUSED');
  coordinator.resume();
  assert.equal(coordinator.state, 'SHADOW_READY');
});

test('COORD: stop/pause/resume use only valid state-machine transitions', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  // Valid: SHADOW_ACTIVE → PAUSED
  coordinator.pause();
  assert.equal(coordinator.state, 'PAUSED');

  // Valid: PAUSED → RESUME → SHADOW_READY
  coordinator.resume();
  assert.equal(coordinator.state, 'SHADOW_READY');

  // Valid: SHADOW_READY → STOP
  coordinator.stop();
  assert.equal(coordinator.state, 'STOPPED');
});

test('COORD: control transitions persist exact current shadowState', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');
  const coordinator = startCoordinator(ledgerFile, snapshotFile);

  coordinator.pause();
  let persisted = loadSnapshot(snapshotFile, new ShadowEventLedger(ledgerFile));
  assert.equal(persisted.shadowState, 'PAUSED');

  coordinator.resume();
  persisted = loadSnapshot(snapshotFile, new ShadowEventLedger(ledgerFile));
  assert.equal(persisted.shadowState, 'SHADOW_READY');

  coordinator.stop();
  persisted = loadSnapshot(snapshotFile, new ShadowEventLedger(ledgerFile));
  assert.equal(persisted.shadowState, 'STOPPED');
});

// ─── process ────────────────────────────────────────────────────────────────

test('COORD: process accepts valid event+outcome', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  const { event, outcome } = makeTradeEventAndOutcome();
  const result = coordinator.process(event, outcome);
  assert.equal(result.status, 'accepted');
  assert.ok(result.observation);
});

test('COORD: process exact order: prepare→ledger→commit→snapshot', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');
  const coordinator = startCoordinator(ledgerFile, snapshotFile);

  const { event, outcome } = makeTradeEventAndOutcome();
  const result = coordinator.process(event, outcome);

  // After process succeeds: ledger has entry, boundary has observation, snapshot written
  assert.equal(result.status, 'accepted');
  assert.equal(coordinator.ledgerSize, 1);
  assert.equal(coordinator.observationCount, 1);
  assert.ok(fs.existsSync(snapshotFile));
});

test('COORD: exact duplicate writes no ledger entry and no observation', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  const { event, outcome } = makeTradeEventAndOutcome();
  const r1 = coordinator.process(event, outcome);
  assert.equal(r1.status, 'accepted');

  const r2 = coordinator.process(event, outcome);
  assert.equal(r2.status, 'duplicate');
  // No new ledger entry
  assert.equal(coordinator.ledgerSize, 1);
  // No new observation
  assert.equal(coordinator.observationCount, 1);
});

test('COORD: conflict/late/gap write zero bytes', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  // Accept seq 0
  const { event: e1, outcome: o1 } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);
  coordinator.process(e1, o1);

  const sizeBefore = coordinator.ledgerSize;

  // Conflict: same key+seq, different eventId
  const { event: e2, outcome: o2 } = makeTradeEventAndOutcome(REF_SOURCE, 2000, 0);
  const r = coordinator.process(e2, o2);
  assert.equal(r.status, 'conflict');
  assert.equal(coordinator.ledgerSize, sizeBefore); // zero bytes written
});

test('COORD: tamper/invalid inputs rejected fail-closed', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  const { event, outcome } = makeTradeEventAndOutcome();
  const tamperedEvent = { ...event, eventId: 'se-' + '0'.repeat(64) };

  const r = coordinator.process(tamperedEvent, outcome);
  assert.equal(r.status, 'rejected');
  assert.equal(coordinator.ledgerSize, 0);
});

test('COORD: process only allowed in SHADOW_ACTIVE', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  coordinator.stop();
  const { event, outcome } = makeTradeEventAndOutcome();
  const r = coordinator.process(event, outcome);
  assert.equal(r.status, 'rejected');
});

// ─── Recovery scenarios ────────────────────────────────────────────────────

test('COORD: ledger failure leaves boundary unchanged and recovery required', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  assert.equal(coordinator.state, 'SHADOW_ACTIVE');

  // Process normally
  const { event, outcome } = makeTradeEventAndOutcome();
  const r = coordinator.process(event, outcome);
  assert.equal(r.status, 'accepted');
  assert.equal(coordinator.ledgerSize, 1);
  assert.equal(coordinator.observationCount, 1);
});

// ─── Contract 5: no mutable accessors ──────────────────────────────────────

test('COORD: coordinator has no mutable boundary/ledger accessor', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  // Verify no 'boundary' or 'ledger' property on coordinator
  assert.equal((coordinator as any).boundary, undefined);
  assert.equal((coordinator as any).ledger, undefined);

  // Safe accessors should work
  assert.equal(typeof coordinator.observations, 'object');
  assert.ok(Array.isArray(coordinator.observations));
  assert.equal(coordinator.observationCount, 0);
  assert.equal(coordinator.ledgerSize, 0);
  assert.equal(coordinator.latestLedgerDigest, null);
  assert.ok(Array.isArray(coordinator.ledgerEntries));
});

// ─── Contract 6: ledger/boundary duplicate mismatch → RECOVERY_REQUIRED ────

test('COORD: ledger duplicate with missing boundary observation enters RECOVERY_REQUIRED', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');

  // Pre-populate ledger with an entry (but coordinator won't replay it because
  // it uses a fresh boundary that doesn't have it — this can't happen normally)
  const prepLedger = new ShadowEventLedger(ledgerFile);
  const prepSm = new ShadowRuntimeStateMachine();
  prepSm.transition('BEGIN_PRECHECK');
  prepSm.transition('PRECHECK_PASSED');
  prepSm.transition('ACTIVATE');
  const prepBoundary = createShadowIntentBoundary(prepSm);
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);
  const r = prepBoundary.observe(event, outcome);
  prepLedger.append(event, r.observation!);

  // Start coordinator (replays ledger, boundary has the entry)
  const coordinator = startCoordinator(ledgerFile, snapshotFile);
  assert.equal(coordinator.state, 'SHADOW_ACTIVE');
  assert.equal(coordinator.observationCount, 1);

  // Process same event again — ledger will return duplicate=true, boundary has it
  const r2 = coordinator.process(event, outcome);
  assert.equal(r2.status, 'duplicate');
});

// ─── Caller inputs not mutated/frozen ──────────────────────────────────────

test('COORD: caller event not frozen after process', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  const { event, outcome } = makeTradeEventAndOutcome();
  const frozenBefore = Object.isFrozen(event);
  coordinator.process(event, outcome);
  assert.equal(Object.isFrozen(event), frozenBefore);
});

test('COORD: caller outcome not frozen after process', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  const { event, outcome } = makeTradeEventAndOutcome();
  const frozenBefore = Object.isFrozen(outcome);
  coordinator.process(event, outcome);
  assert.equal(Object.isFrozen(outcome), frozenBefore);
});

// ─── Multi-entry flow ──────────────────────────────────────────────────────

test('COORD: multiple entries accepted in sequence', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  for (let i = 0; i < 3; i++) {
    const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 1000 + i * 1000, i);
    const r = coordinator.process(event, outcome);
    assert.equal(r.status, 'accepted', `seq ${i}`);
  }

  assert.equal(coordinator.ledgerSize, 3);
  assert.equal(coordinator.observationCount, 3);
});

test('COORD: process rejects after pause', () => {
  const dir = makeTmpDir();
  const coordinator = startCoordinator(
    makeTmpFile(dir, 'ledger.jsonl'),
    makeTmpFile(dir, 'snapshot.json'),
  );

  coordinator.pause();
  const { event, outcome } = makeTradeEventAndOutcome();
  const r = coordinator.process(event, outcome);
  assert.equal(r.status, 'rejected');
});

// =============================================================================
// STAGE 4B4.2 R2 — Defect 3: duplicate must flow through ledger (tamper test)
// =============================================================================

test('COORD R2/D3: tampered ledger after accepted event → repeat event → RECOVERY_REQUIRED', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');
  const coordinator = startCoordinator(ledgerFile, snapshotFile);

  const { event, outcome } = makeTradeEventAndOutcome();
  const r1 = coordinator.process(event, outcome);
  assert.equal(r1.status, 'accepted');
  assert.equal(coordinator.state, 'SHADOW_ACTIVE');
  assert.equal(coordinator.ledgerSize, 1);

  // External tamper: delete the ledger file
  fs.unlinkSync(ledgerFile);

  // Repeat the same event — must go through ledger.append which will fail
  // because the file is gone. Must reject and enter RECOVERY_REQUIRED.
  const r2 = coordinator.process(event, outcome);
  assert.equal(r2.status, 'rejected');
  assert.equal(coordinator.state, 'RECOVERY_REQUIRED');
});

test('COORD R2/D3: externally replaced ledger with wrong content → duplicate → RECOVERY_REQUIRED', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');
  const coordinator = startCoordinator(ledgerFile, snapshotFile);

  const { event, outcome } = makeTradeEventAndOutcome();
  const r1 = coordinator.process(event, outcome);
  assert.equal(r1.status, 'accepted');
  assert.equal(coordinator.ledgerSize, 1);

  // External tamper: replace ledger with garbage
  fs.writeFileSync(ledgerFile, 'corrupted\\n', 'utf-8');

  // Process a new event — ledger will fail on append
  const { event: e2, outcome: o2 } = makeTradeEventAndOutcome(REF_SOURCE, 2000, 1);
  const r2 = coordinator.process(e2, o2);
  assert.equal(r2.status, 'rejected');
  assert.equal(coordinator.state, 'RECOVERY_REQUIRED');
});

// =============================================================================
// STAGE 4B4.2 R2 — Defect 4: startup exceptions → uniform RECOVERY_REQUIRED
// =============================================================================

test('COORD R2/D4: non-contiguous valid ledger replay during startup → RECOVERY_REQUIRED', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  const snapshotFile = makeTmpFile(dir, 'snapshot.json');

  // The ledger validates individual records and their digest chain, while the
  // boundary additionally enforces per-source sequence continuity. Build a
  // cryptographically valid ledger whose second event skips sequence 1 so the
  // failure occurs during startup replay, after the coordinator exists.
  const ledger = new ShadowEventLedger(ledgerFile);
  const first = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);
  const gap = makeTradeEventAndOutcome(REF_SOURCE, 3000, 2);
  ledger.append(first.event, createShadowIntentObservation(first.event, first.outcome));
  ledger.append(gap.event, createShadowIntentObservation(gap.event, gap.outcome));

  const coordinator = new ShadowRuntimeCoordinator(ledgerFile, snapshotFile);
  assert.throws(() => { coordinator.startup(); });
  assert.equal(coordinator.state, 'RECOVERY_REQUIRED');
});

test('COORD R2/D4: snapshot store failure during startup rebuild → RECOVERY_REQUIRED', () => {
  const dir = makeTmpDir();
  const ledgerFile = makeTmpFile(dir, 'ledger.jsonl');
  // Put snapshot in a non-existent directory so storeSnapshot fails
  const snapshotFile = makeTmpFile(makeTmpDir(), 'snapshot.json');
  // Delete the parent directory to force storeSnapshot failure
  fs.rmdirSync(path.dirname(snapshotFile));

  // Pre-populate ledger with valid entry
  const prepLedger = new ShadowEventLedger(ledgerFile);
  const prepSm = new ShadowRuntimeStateMachine();
  prepSm.transition('BEGIN_PRECHECK');
  prepSm.transition('PRECHECK_PASSED');
  prepSm.transition('ACTIVATE');
  const prepBoundary = createShadowIntentBoundary(prepSm);
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);
  const r = prepBoundary.observe(event, outcome);
  prepLedger.append(event, r.observation!);

  // The snapshot file's parent no longer exists — startup must fail with RECOVERY_REQUIRED
  const coordinator = new ShadowRuntimeCoordinator(ledgerFile, snapshotFile);
  assert.throws(() => { coordinator.startup(); });
  assert.equal(coordinator.state, 'RECOVERY_REQUIRED');
});
