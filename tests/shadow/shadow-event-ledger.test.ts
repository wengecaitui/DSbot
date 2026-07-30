/**
 * TDD adversarial coverage for ShadowEventLedger.
 *
 * REFERENCE SHADOW INFRASTRUCTURE ONLY.
 * NOT APPROVED FOR PAPER TESTNET OR LIVE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as os from 'node:os';
const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');

import { createCanonicalShadowEvent, verifyCanonicalShadowEvent } from '../../src/shadow/CanonicalShadowEvent';
import { createShadowIntentObservation, verifyShadowIntentObservation } from '../../src/shadow/ShadowIntentObservation';
import { createShadowDecisionOutcome } from '../../src/shadow/ShadowDecisionOutcome';
import { REF_EXCHANGE, REF_SYMBOL, REF_SOURCE, REF_REASON, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, makeRefTradeIntent } from '../helpers/shadow-reference-fixtures';

import { ShadowEventLedger } from '../../src/shadow/ShadowEventLedger';
import { canonicalSerialize } from '../../src/shadow/CanonicalJson';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLedgerPath(label: string): string {
  const dir = path.join(os.tmpdir(), 'shadow-ledger-test-' + label);
  return path.join(dir, 'ledger.jsonl');
}

function cleanLedgerFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeLedgerDir(filePath: string): void {
  cleanLedgerFile(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function makeTradeEventAndObs() {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const obs = createShadowIntentObservation(event, outcome);
  return { event, obs, outcome, intent };
}

// ─── Cycle 1: Empty/new ledger + deterministic genesis ────────────────────

test('L1: new ledger with nonexistent file is empty (size=0)', () => {
  const p = makeLedgerPath('nonexistent');
  makeLedgerDir(p);
  const ledger = new ShadowEventLedger(p);
  assert.equal(ledger.size, 0);
  assert.equal(ledger.latestDigest, null);
  assert.deepEqual(ledger.getEntries(), []);
});

test('L2: new ledger with empty file is empty (size=0)', () => {
  const p = makeLedgerPath('empty-file');
  makeLedgerDir(p);
  fs.writeFileSync(p, '', 'utf-8');
  const ledger = new ShadowEventLedger(p);
  assert.equal(ledger.size, 0);
  assert.equal(ledger.latestDigest, null);
});

test('L3: genesis entry has ledgerSequence=0 and previousEntryDigest of 64 zeroes', () => {
  const p = makeLedgerPath('genesis');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  const result = ledger.append(event, obs);
  assert.equal(result.duplicate, false);
  const entries = ledger.getEntries();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.schemaVersion, 'cloddsbot.shadow.ledger-entry.v1');
  assert.equal(entry.ledgerSequence, 0);
  assert.equal(entry.previousEntryDigest, '0'.repeat(64));
  assert.ok(/^[a-f0-9]{64}$/.test(entry.entryDigest));
});

test('L4: genesis entryDigest is deterministic SHA-256 over canonical fields', () => {
  const p1 = makeLedgerPath('digest-det-1');
  makeLedgerDir(p1);
  const { event, obs } = makeTradeEventAndObs();
  const ledger1 = new ShadowEventLedger(p1);
  ledger1.append(event, obs);
  const e1 = ledger1.getEntries()[0];

  const p2 = makeLedgerPath('digest-det-2');
  makeLedgerDir(p2);
  const ledger2 = new ShadowEventLedger(p2);
  ledger2.append(event, obs);
  const e2 = ledger2.getEntries()[0];

  assert.equal(e1.entryDigest, e2.entryDigest);
});

test('L5: entry fields are deeply frozen', () => {
  const p = makeLedgerPath('frozen');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);
  const entry = ledger.getEntries()[0];
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.event));
  assert.ok(Object.isFrozen(entry.observation));
});

test('L6: ledger rejects missing parent directory', () => {
  const badPath = path.join(os.tmpdir(), 'nonexistent-parent-' + Date.now(), 'sub', 'ledger.jsonl');
  assert.throws(() => new ShadowEventLedger(badPath), /parent directory/i);
});

test('L7: normal file path accepted (symlink detection in constructor)', () => {
  const p = makeLedgerPath('symlink-check');
  makeLedgerDir(p);
  fs.writeFileSync(p, '', 'utf-8');
  const ledger = new ShadowEventLedger(p);
  assert.equal(ledger.size, 0);
});

// ─── Cycle 2: Append → reopen + digest chain ──────────────────────────────

test('L8: append then reopen yields byte-identical verified entry', () => {
  const p = makeLedgerPath('reopen');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger1 = new ShadowEventLedger(p);
  ledger1.append(event, obs);
  const e1 = ledger1.getEntries()[0];

  const ledger2 = new ShadowEventLedger(p);
  assert.equal(ledger2.size, 1);
  const e2 = ledger2.getEntries()[0];

  assert.equal(e2.schemaVersion, e1.schemaVersion);
  assert.equal(e2.ledgerSequence, e1.ledgerSequence);
  assert.equal(e2.previousEntryDigest, e1.previousEntryDigest);
  assert.equal(e2.event.eventId, e1.event.eventId);
  assert.equal(e2.observation.observationId, e1.observation.observationId);
  assert.equal(e2.entryDigest, e1.entryDigest);
});

test('L9: two entries form a valid digest chain', () => {
  const p = makeLedgerPath('chain');
  makeLedgerDir(p);

  const intent1 = makeRefTradeIntent();
  const outcome1 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent1, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event1 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome1);
  const obs1 = createShadowIntentObservation(event1, outcome1);

  const intent2 = makeRefTradeIntent({ intentId: 'ti-ref-diff-222222222222222222', direction: 'short', positionUsd: 2000 });
  const outcome2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'short', symbol: REF_SYMBOL, positionUsd: 2000, tradeIntent: intent2, reason: 'Different' },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event2 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS + 1, REF_SOURCE_SEQUENCE + 1, outcome2);
  const obs2 = createShadowIntentObservation(event2, outcome2);

  const ledger = new ShadowEventLedger(p);
  ledger.append(event1, obs1);
  ledger.append(event2, obs2);

  assert.equal(ledger.size, 2);
  const entries = ledger.getEntries();
  assert.equal(entries[0].ledgerSequence, 0);
  assert.equal(entries[0].previousEntryDigest, '0'.repeat(64));
  assert.equal(entries[1].ledgerSequence, 1);
  assert.equal(entries[1].previousEntryDigest, entries[0].entryDigest);
  assert.equal(ledger.latestDigest, entries[1].entryDigest);
});

test('L10: reopen after two entries verifies full digest chain', () => {
  const p = makeLedgerPath('reopen-chain');
  makeLedgerDir(p);

  const intent1 = makeRefTradeIntent();
  const outcome1 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent1, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event1 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome1);
  const obs1 = createShadowIntentObservation(event1, outcome1);

  const outcome2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'skip', symbol: REF_SYMBOL, reason: 'No signal' },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event2 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS + 100, REF_SOURCE_SEQUENCE + 1, outcome2);
  const obs2 = createShadowIntentObservation(event2, outcome2);

  const ledger1 = new ShadowEventLedger(p);
  ledger1.append(event1, obs1);
  ledger1.append(event2, obs2);

  const ledger2 = new ShadowEventLedger(p);
  assert.equal(ledger2.size, 2);
  const entries = ledger2.getEntries();
  assert.equal(entries[0].ledgerSequence, 0);
  assert.equal(entries[1].ledgerSequence, 1);
  assert.equal(entries[1].previousEntryDigest, entries[0].entryDigest);
});

test('L11: getByEventId returns correct entry', () => {
  const p = makeLedgerPath('get-by-id');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const found = ledger.getByEventId(event.eventId);
  assert.ok(found !== null);
  assert.equal(found!.event.eventId, event.eventId);

  const notFound = ledger.getByEventId('se-' + '0'.repeat(64));
  assert.equal(notFound, null);
});

// ─── Cycle 3: Duplicate detection ─────────────────────────────────────────

test('L12: exact duplicate returns {duplicate:true} and writes zero bytes', () => {
  const p = makeLedgerPath('exact-dup');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  const r1 = ledger.append(event, obs);
  assert.equal(r1.duplicate, false);
  assert.equal(ledger.size, 1);

  const r2 = ledger.append(event, obs);
  assert.equal(r2.duplicate, true);
  assert.equal(ledger.size, 1);
});

test('L13: exact duplicate after reopen returns {duplicate:true}', () => {
  const p = makeLedgerPath('reopen-dup');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger1 = new ShadowEventLedger(p);
  ledger1.append(event, obs);

  const ledger2 = new ShadowEventLedger(p);
  const r2 = ledger2.append(event, obs);
  assert.equal(r2.duplicate, true);
  assert.equal(ledger2.size, 1);
});

test('L14: duplicate eventId with different observation in file => reopen rejected', () => {
  const p = makeLedgerPath('dup-ev-file');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  // Manually craft a second line with same eventId but different observation
  const firstLine = fs.readFileSync(p, 'utf-8').split('\n')[0];
  const firstEntry = JSON.parse(firstLine);
  // Modify observation's observationId to create a "different" observation
  firstEntry.observation = JSON.parse(JSON.stringify(firstEntry.observation));
  firstEntry.observation.observationId = 'so-' + 'f'.repeat(64);
  firstEntry.ledgerSequence = 1;
  firstEntry.previousEntryDigest = firstEntry.entryDigest;
  firstEntry.entryDigest = 'd'.repeat(64); // Will fail verification anyway

  fs.appendFileSync(p, JSON.stringify(firstEntry) + '\n', 'utf-8');

  assert.throws(() => new ShadowEventLedger(p), /invalid|duplicate|observation/i);
});

test('L15: duplicate observationId with different event in file => reopen rejected', () => {
  const p = makeLedgerPath('dup-obs-file');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const firstLine = fs.readFileSync(p, 'utf-8').split('\n')[0];
  const firstEntry = JSON.parse(firstLine);
  firstEntry.event = JSON.parse(JSON.stringify(firstEntry.event));
  firstEntry.event.eventId = 'se-' + 'f'.repeat(64);
  firstEntry.ledgerSequence = 1;
  firstEntry.previousEntryDigest = firstEntry.entryDigest;
  firstEntry.entryDigest = 'e'.repeat(64);

  fs.appendFileSync(p, JSON.stringify(firstEntry) + '\n', 'utf-8');

  assert.throws(() => new ShadowEventLedger(p), /invalid|duplicate|observation/i);
});

// ─── Cycle 4: Tamper detection on reopen ──────────────────────────────────

function writeFileContent(filePath: string, content: string): void {
  cleanLedgerFile(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

test('L16: tampered event in file => reopen rejected', () => {
  const p = makeLedgerPath('tamper-event');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  let content = fs.readFileSync(p, 'utf-8');
  content = content.replace(/"eventType":"trade"/, '"eventType":"skip"');
  writeFileContent(p, content);

  assert.throws(() => new ShadowEventLedger(p), /event/i);
});

test('L17: tampered previousEntryDigest => reopen rejected', () => {
  const p = makeLedgerPath('tamper-prev');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  let content = fs.readFileSync(p, 'utf-8');
  content = content.replace(/"previousEntryDigest":"0{64}"/, '"previousEntryDigest":"' + 'a'.repeat(64) + '"');
  writeFileContent(p, content);

  assert.throws(() => new ShadowEventLedger(p), /previousEntryDigest/i);
});

test('L18: tampered entry digest => reopen rejected', () => {
  const p = makeLedgerPath('tamper-digest');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  let content = fs.readFileSync(p, 'utf-8');
  content = content.replace(/"entryDigest":"[a-f0-9]{64}"/, '"entryDigest":"' + 'b'.repeat(64) + '"');
  writeFileContent(p, content);

  assert.throws(() => new ShadowEventLedger(p), /entryDigest/i);
});

test('L19: tampered sequence => reopen rejected', () => {
  const p = makeLedgerPath('tamper-seq');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  let content = fs.readFileSync(p, 'utf-8');
  content = content.replace(/"ledgerSequence":0/, '"ledgerSequence":5');
  writeFileContent(p, content);

  assert.throws(() => new ShadowEventLedger(p), /sequence/i);
});

test('L20: tampered schema version => reopen rejected', () => {
  const p = makeLedgerPath('tamper-schema');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  let content = fs.readFileSync(p, 'utf-8');
  content = content.replace('"schemaVersion":"cloddsbot.shadow.ledger-entry.v1"', '"schemaVersion":"cloddsbot.shadow.ledger-entry.v2"');
  writeFileContent(p, content);

  assert.throws(() => new ShadowEventLedger(p), /schemaVersion/i);
});

test('L21: extra field in entry => reopen rejected', () => {
  const p = makeLedgerPath('tamper-extra');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  let content = fs.readFileSync(p, 'utf-8');
  content = content.replace('{', '{"extraField":true,');
  writeFileContent(p, content);

  assert.throws(() => new ShadowEventLedger(p), /non-canonical|key|extra/i);
});

// ─── Cycle 5: File-level corruption ────────────────────────────────────────

test('L22: truncated/partial last line => reopen rejected', () => {
  const p = makeLedgerPath('truncated');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  let content = fs.readFileSync(p, 'utf-8').trim();
  content = content.slice(0, -10) + '\n';
  writeFileContent(p, content);

  assert.throws(() => new ShadowEventLedger(p), /malformed|invalid/i);
});

test('L23: blank line between records => reopen rejected', () => {
  const p = makeLedgerPath('blank-line');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const lines = fs.readFileSync(p, 'utf-8').split('\n');
  const content = lines[0] + '\n\n' + (lines[1] || '') + '\n';
  writeFileContent(p, content);

  assert.throws(() => new ShadowEventLedger(p), /blank/i);
});

test('L24: BOM at start of file => reopen rejected', () => {
  const p = makeLedgerPath('bom');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const content = fs.readFileSync(p, 'utf-8');
  const bomContent = '\uFEFF' + content;
  writeFileContent(p, bomContent);

  assert.throws(() => new ShadowEventLedger(p), /BOM/i);
});

test('L25: malformed JSON => reopen rejected', () => {
  const p = makeLedgerPath('malformed');
  makeLedgerDir(p);
  fs.writeFileSync(p, 'this is not json at all!\n', 'utf-8');
  assert.throws(() => new ShadowEventLedger(p), /JSON/i);
});

test('L26: missing final LF => reopen rejected', () => {
  const p = makeLedgerPath('no-lf');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const content = fs.readFileSync(p, 'utf-8').trimEnd();
  writeFileContent(p, content);

  assert.throws(() => new ShadowEventLedger(p), /LF|trailing/i);
});

// ─── Cycle 6: Caller immutability + getter attacks + external change ───────

test('L27: caller event is not mutated after append', () => {
  const p = makeLedgerPath('caller-mut');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const eventIdBefore = event.eventId;
  const obsIdBefore = obs.observationId;

  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  assert.equal(event.eventId, eventIdBefore);
  assert.equal(obs.observationId, obsIdBefore);
});

test('L28: caller event is not frozen by ledger', () => {
  const p = makeLedgerPath('caller-not-frozen');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();

  const eventCopy = JSON.parse(JSON.stringify(event));
  const obsCopy = JSON.parse(JSON.stringify(obs));

  const ledger = new ShadowEventLedger(p);
  ledger.append(eventCopy as any, obsCopy as any);

  assert.equal(Object.isFrozen(eventCopy), false);
  assert.equal(Object.isFrozen(obsCopy), false);
});

test('L29: getter/accessor on event payload does not execute or pass verification', () => {
  let getterCalled = false;
  const maliciousPayload = {
    decision: 'trade', direction: 'long', reason: 'test',
    blockedReason: null, intentId: 'ti-test',
    riskAdmission: { status: 'admitted' },
  };
  const eventWithGetter = {
    schemaVersion: 'cloddsbot.shadow.event.v1',
    exchange: REF_EXCHANGE, symbol: REF_SYMBOL, source: REF_SOURCE,
    eventType: 'trade', eventTimeMs: REF_EVENT_TIME_MS,
    sourceSequence: REF_SOURCE_SEQUENCE,
    payloadDigest: '0'.repeat(64), eventId: 'se-' + '0'.repeat(64),
    payload: maliciousPayload,
  };
  Object.defineProperty(eventWithGetter.payload, 'getterAttack', {
    get() { getterCalled = true; return 'evil'; },
    enumerable: true, configurable: true,
  });

  const result = verifyCanonicalShadowEvent(eventWithGetter);
  assert.equal(result, null);
  assert.equal(getterCalled, false);
});

test('L30: return arrays/values are snapshots, not internal references', () => {
  const p = makeLedgerPath('snapshot');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const entries1 = ledger.getEntries();
  const entries2 = ledger.getEntries();
  assert.notStrictEqual(entries1, entries2);
});

test('L31: external file change between open and append fails closed', () => {
  const p = makeLedgerPath('ext-change');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  // Externally append garbage to the file
  fs.appendFileSync(p, 'garbage data to change file size\n', 'utf-8');

  const intent2 = makeRefTradeIntent({ intentId: 'ti-ref-ext-22222222222222', direction: 'short', positionUsd: 2000 });
  const outcome2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'short', symbol: REF_SYMBOL, positionUsd: 2000, tradeIntent: intent2, reason: 'External' },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event2 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS + 100, REF_SOURCE_SEQUENCE + 1, outcome2);
  const obs2 = createShadowIntentObservation(event2, outcome2);

  assert.throws(() => ledger.append(event2, obs2), /external|modification|fail-closed/i);
});

// ─── Cycle 7: Import isolation + deterministic digest ──────────────────────

test('L32: ShadowEventLedger does not import from paper/execution/router/adapters', () => {
  const modulePath = path.resolve(__dirname, '..', '..', 'src', 'shadow', 'ShadowEventLedger.ts');
  const src = fs.readFileSync(modulePath, 'utf-8');
  const forbidden = ['paper', 'execution', 'router', 'adapters', 'trading', 'fill', 'order', 'balance', 'position', 'fee', 'PnL'];
  for (const word of forbidden) {
    const importRegex = new RegExp(`from\\s+['"][^'"]*${word}`, 'i');
    assert.ok(!importRegex.test(src), `ShadowEventLedger must not import from "${word}"`);
  }
});

test('L33: entry digest does not include Date.now or process time', () => {
  const p = makeLedgerPath('no-date');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();

  const ledger1 = new ShadowEventLedger(p);
  ledger1.append(event, obs);
  const d1 = ledger1.getEntries()[0].entryDigest;

  cleanLedgerFile(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const start = Date.now();
  while (Date.now() - start < 10) { /* busy-wait */ }
  const ledger2 = new ShadowEventLedger(p);
  ledger2.append(event, obs);
  const d2 = ledger2.getEntries()[0].entryDigest;

  assert.equal(d1, d2);
});

// ─── Cycle 8: Canonical JSONL ──────────────────────────────────────────────

test('L34: non-canonical key order => reopen rejected', () => {
  const p = makeLedgerPath('noncanon-key');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  // Read and rebuild with key order different from canonicalSerialize
  const rawLine = fs.readFileSync(p, 'utf-8').split('\n')[0];
  const parsed = JSON.parse(rawLine);
  // Reorder: put entryDigest first, schemaVersion last
  const reordered: Record<string, unknown> = {
    entryDigest: parsed.entryDigest,
    observation: parsed.observation,
    event: parsed.event,
    previousEntryDigest: parsed.previousEntryDigest,
    ledgerSequence: parsed.ledgerSequence,
    schemaVersion: parsed.schemaVersion,
  };

  writeFileContent(p, JSON.stringify(reordered) + '\n');

  // Currently: JSON.parse succeeds — RED (should reject non-canonical)
  // After fix: must reject because raw bytes != canonicalSerialize(parsed)
  assert.throws(() => new ShadowEventLedger(p), /canonical|format/i);
});

test('L35: non-canonical whitespace (extra spaces) => reopen rejected', () => {
  const p = makeLedgerPath('noncanon-ws');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const rawLine = fs.readFileSync(p, 'utf-8').split('\n')[0];
  const parsed = JSON.parse(rawLine);
  // Add extra whitespace — canonicalSerialize has none
  const withWhitespace = JSON.stringify(parsed, null, 2);
  writeFileContent(p, withWhitespace + '\n');

  assert.throws(() => new ShadowEventLedger(p), /non-canonical|malformed|format/i);
});

test('L35a: append uses canonicalSerialize format (no whitespace, sorted keys)', () => {
  const p = makeLedgerPath('canonical-format');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const rawLine = fs.readFileSync(p, 'utf-8').split('\n')[0];
  const parsed = JSON.parse(rawLine);
  const canonForm = canonicalSerialize(parsed);
  assert.equal(rawLine, canonForm);
});

// ─── Cycle 9: Strict UTF-8 ────────────────────────────────────────────────

test('L36: invalid UTF-8 bytes => reopen rejected', () => {
  const p = makeLedgerPath('bad-utf8');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  // Write a file with an invalid UTF-8 byte sequence (0xFF is never valid UTF-8)
  const rawBuf = fs.readFileSync(p);
  // Corrupt a byte in the middle to be 0xFF
  const pos = Math.floor(rawBuf.length / 2);
  rawBuf[pos] = 0xFF;

  // Write raw bytes directly (not through writeFileContent which re-encodes)
  cleanLedgerFile(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rawBuf);

  // Strict UTF-8 decoder should reject
  assert.throws(() => new ShadowEventLedger(p), /UTF|encoding/i);
});

// ─── Cycle 10: Cryptographically valid duplicate on reopen ────────────────

test('L37: cryptographically valid chained duplicate => reopen rejected', () => {
  const p = makeLedgerPath('chain-dup');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  // Build a second entry that is a cryptographically valid chain link
  // but reuses the same event and observation (same eventId + observationId)
  const firstLine = fs.readFileSync(p, 'utf-8').split('\n')[0];
  const firstEntry = JSON.parse(firstLine);

  // Compute the second entry's digest correctly
  const DOMAIN = 'CLODDSBOT_SHADOW_LEDGER_ENTRY\u0000v1\u0000';
  const nodeCrypto = require('node:crypto');

  const entryWithoutDigest = {
    schemaVersion: 'cloddsbot.shadow.ledger-entry.v1',
    ledgerSequence: 1,
    previousEntryDigest: firstEntry.entryDigest,
    // Reuse the identical event and observation
    event: firstEntry.event,
    observation: firstEntry.observation,
  };

  const preimage = DOMAIN + canonicalSerialize(entryWithoutDigest);
  const entryDigest = nodeCrypto.createHash('sha256').update(preimage, 'utf8').digest('hex');

  const secondEntry = {
    ...entryWithoutDigest,
    entryDigest,
  };

  // Write both entries
  writeFileContent(p, firstLine + '\n' + canonicalSerialize(secondEntry) + '\n');

  // Currently: duplicate detection loops over this.#entries (empty during reopen)
  //   so the duplicate is NOT detected — RED
  // After fix: must reject as duplicate
  assert.throws(() => new ShadowEventLedger(p), /duplicate/i);
});

// ─── Cycle 11: External mutation (same-size tamper) ───────────────────────

test('L38: same-size external tamper => reopen rejected', () => {
  const p = makeLedgerPath('same-size-tamper');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  // Read the file and tamper in-place (same size)
  const buf = fs.readFileSync(p);
  // Corrupt a hex digit in a digest — same size, different content
  const content = buf.toString('utf-8');
  const tampered = content.replace(/[a-f0-9](?=[a-f0-9]{63}")/, (m) => m === 'a' ? 'b' : 'a');
  if (tampered === content) {
    // Fallback if regex didn't match — corrupt a known position
    const idx = content.indexOf('"previousEntryDigest":"0000');
    if (idx >= 0) {
      const t = content.substring(0, idx + 24) + '1' + content.substring(idx + 25);
      writeFileContent(p, t);
    }
  } else {
    writeFileContent(p, tampered);
  }

  // Currently: size check passes (same size) — RED (should detect content change)
  // After fix: content digest or byte-binding detects tamper
  assert.throws(() => new ShadowEventLedger(p), /tamper|modification|mismatch|fail-closed/i);
});

test('L39: exact duplicate after same-size external replace => rejected', () => {
  const p = makeLedgerPath('same-size-replace');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  // Tamper content within same byte size — replace hex chars
  const content = fs.readFileSync(p, 'utf-8');
  const tampered = content.replace(/"reason":"[^"]*"/, '"reason":"TAMPERED_SAME_SIZE"');
  writeFileContent(p, tampered);

  // Should reject — same size but different content (detected via digest/integrity)
  assert.throws(() => new ShadowEventLedger(p), /tamper|modification|mismatch|invalid|fail-closed/i);
});

// ─── Cycle 12: Immutable snapshots ─────────────────────────────────────────

test('L40: getEntries array is frozen', () => {
  const p = makeLedgerPath('frozen-arr');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const entries = ledger.getEntries();
  assert.ok(Object.isFrozen(entries), 'getEntries array must be frozen');
});

test('L41: getEntries entry/event/observation/riskAdmission deeply immutable', () => {
  const p = makeLedgerPath('deep-immutable');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const entry = ledger.getEntries()[0];
  assert.ok(Object.isFrozen(entry), 'entry must be frozen');
  assert.ok(Object.isFrozen(entry.event), 'entry.event must be frozen');
  assert.ok(Object.isFrozen(entry.observation), 'entry.observation must be frozen');
  assert.ok(Object.isFrozen(entry.event.payload), 'entry.event.payload must be frozen');
  assert.ok(Object.isFrozen(entry.observation.riskAdmission), 'entry.observation.riskAdmission must be frozen');
});

test('L42: getEntries does not expose mutable internal references', () => {
  const p = makeLedgerPath('no-internal-ref');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);
  ledger.append(event, obs);

  const entries1 = ledger.getEntries();
  const entries2 = ledger.getEntries();
  // Each call returns a new array
  assert.notStrictEqual(entries1, entries2);
  // But entries within should be different object references from internal storage
  assert.notStrictEqual(entries1[0], entries2[0]);
  // Modifying the returned array doesn't affect the ledger
  const sizeBefore = ledger.size;
  try { (entries1 as any).push({}); } catch { /* frozen */ }
  assert.equal(ledger.size, sizeBefore);
});

// ─── Cycle 13: Write/fsync/post-write failure semantics (direct mock) ──────

function withMock<T>(obj: any, method: string, impl: (...args: any[]) => any, fn: () => T): T {
  const orig = obj[method];
  obj[method] = impl;
  try {
    return fn();
  } finally {
    obj[method] = orig;
  }
}

test('L43: write failure (appendFileSync throws) leaves in-memory state unchanged', () => {
  const p = makeLedgerPath('write-fail');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  const sizeBefore = ledger.size;
  const digestBefore = ledger.latestDigest;

  withMock(fs, 'appendFileSync', () => { throw new Error('simulated write failure'); }, () => {
    assert.throws(
      () => ledger.append(event, obs),
      /write/i,
    );

    // State must be unchanged
    assert.equal(ledger.size, sizeBefore);
    assert.equal(ledger.latestDigest, digestBefore);
  });
});

test('L44: fsync failure leaves in-memory state unchanged and closes fd', () => {
  const p = makeLedgerPath('fsync-fail');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  let closeCalled = false;

  const sizeBefore = ledger.size;
  const digestBefore = ledger.latestDigest;

  withMock(fs, 'fsyncSync', () => { throw new Error('simulated fsync failure'); }, () => {
    withMock(fs, 'closeSync', () => { closeCalled = true; }, () => {
      assert.throws(
        () => ledger.append(event, obs),
        /fsync/i,
      );
    });
  });

  // State must be unchanged
  assert.equal(ledger.size, sizeBefore);
  assert.equal(ledger.latestDigest, digestBefore);
  // fd must be closed in finally
  assert.ok(closeCalled, 'fd must be closed after fsync failure');
});

test('L44a: write failure before open leaves no fd and subsequent append succeeds', () => {
  const p = makeLedgerPath('fd-close');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  withMock(fs, 'appendFileSync', () => { throw new Error('simulated write failure'); }, () => {
    assert.throws(() => ledger.append(event, obs));
  });

  // Subsequent append should succeed (fd was closed)
  const result = ledger.append(event, obs);
  assert.equal(result.duplicate, false);
  assert.equal(ledger.size, 1);
});

test('L44b: close failure leaves in-memory state unchanged', () => {
  const p = makeLedgerPath('close-fail');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  withMock(fs, 'closeSync', () => { throw new Error('simulated close failure'); }, () => {
    assert.throws(() => ledger.append(event, obs), /close/i);
  });

  assert.equal(ledger.size, 0);
  assert.equal(ledger.latestDigest, null);
  assert.deepEqual(ledger.getEntries(), []);
});

// ─── RED: Post-write verification transactional ordering ───────────────────

test('L43b: post-write reread failure (readFileSync throws) leaves state unchanged', () => {
  const p = makeLedgerPath('reread-fail');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  withMock(fs, 'readFileSync', () => { throw new Error('ENOENT: post-write file disappeared'); }, () => {
    assert.throws(
      () => ledger.append(event, obs),
      /ENOENT|read|fail/i,
    );

    // RED: current code mutates #entries before readFileSync — must stay unchanged
    assert.equal(ledger.size, 0, 'size must remain unchanged after post-write read failure');
    assert.equal(ledger.latestDigest, null, 'digest must remain unchanged after post-write read failure');
  });
});

test('L43c: post-write size anomaly leaves state unchanged', () => {
  const p = makeLedgerPath('size-anomaly');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  // First append succeeds (builds verified state)
  ledger.append(event, obs);
  assert.equal(ledger.size, 1);

  const intent2 = makeRefTradeIntent({ intentId: 'ti-ref-size-222222222222222', direction: 'short', positionUsd: 2000 });
  const outcome2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'short', symbol: REF_SYMBOL, positionUsd: 2000, tradeIntent: intent2, reason: 'Test' },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event2 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS + 1, REF_SOURCE_SEQUENCE + 1, outcome2);
  const obs2 = createShadowIntentObservation(event2, outcome2);

  // Capture the content of the first entry, then mock readFileSync to return truncated data
  const originalReadFileSync = fs.readFileSync;
  let readCount = 0;
  const sizeBefore = ledger.size;
  const digestBefore = ledger.latestDigest;

  withMock(fs, 'readFileSync', (...args: any[]) => {
    readCount++;
    const actual = (originalReadFileSync as any)(...args) as Buffer;
    if (readCount === 1) return actual;
    // Return only the first entry's content (truncated — wrong size)
    return actual.subarray(0, actual.length - 10);
  }, () => {
    assert.throws(
      () => ledger.append(event2, obs2),
      /size|mismatch|fail-closed/i,
    );

    // RED: current code has no post-write size check, so #entries is already mutated
    assert.equal(ledger.size, sizeBefore, 'size must remain unchanged after post-write size anomaly');
    assert.equal(ledger.latestDigest, digestBefore, 'digest must remain unchanged after post-write size anomaly');
  });
  assert.equal(readCount, 2, 'must exercise precheck and post-write reread');
});

test('L43c2: post-write same-size content anomaly leaves state unchanged', () => {
  const p = makeLedgerPath('content-anomaly');
  makeLedgerDir(p);
  fs.writeFileSync(p, '', 'utf8');
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  const originalReadFileSync = fs.readFileSync;
  let readCount = 0;
  withMock(fs, 'readFileSync', (...args: any[]) => {
    readCount++;
    const actual = (originalReadFileSync as any)(...args) as Buffer;
    if (readCount === 1) return actual;
    const changed = Buffer.from(actual);
    changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
    return changed;
  }, () => {
    assert.throws(() => ledger.append(event, obs), /content mismatch|fail-closed/i);
  });

  assert.equal(readCount, 2, 'must exercise post-write content verification');
  assert.equal(ledger.size, 0);
  assert.equal(ledger.latestDigest, null);
});

test('L43d: post-write symlink detection leaves state unchanged', () => {
  const p = makeLedgerPath('post-symlink');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  let mockActive = false;
  const origLstatSync = fs.lstatSync;

  const sizeBefore = ledger.size;
  const digestBefore = ledger.latestDigest;

  withMock(fs, 'lstatSync', (target: Parameters<typeof fs.lstatSync>[0]) => {
    if (mockActive) {
      return {
        isSymbolicLink: () => true,
        isFile: () => true,
        isDirectory: () => false,
        dev: 0, ino: 0, mode: 0, nlink: 1, uid: 0, gid: 0, rdev: 0,
        size: 0, blksize: 4096, blocks: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0,
        birthtimeMs: 0, atime: new Date(0), mtime: new Date(0), ctime: new Date(0),
        birthtime: new Date(0),
      } as fs.Stats;
    }
    return origLstatSync(target);
  }, () => {
    mockActive = true;
    assert.throws(
      () => ledger.append(event, obs),
      /symlink|reparse|fail-closed/i,
    );

    // RED: current code mutates #entries before post-write symlink check
    assert.equal(ledger.size, sizeBefore, 'size must remain unchanged after post-write symlink detection');
    assert.equal(ledger.latestDigest, digestBefore, 'digest must remain unchanged after post-write symlink detection');
  });
});

// ─── Cycle 14: Path-chain safety + filePath validation ────────────────────

test('L45: ancestor symlink/junction => constructor rejected', async (t) => {
  const baseDir = path.join(os.tmpdir(), 'shadow-ledger-test-symlink-' + Date.now());
  const realDir = path.join(baseDir, 'real');
  const linkDir = path.join(baseDir, 'link');
  const ledgerPath = path.join(linkDir, 'ledger.jsonl');

  cleanLedgerFile(ledgerPath);
  fs.mkdirSync(realDir, { recursive: true });

  let symlinkCreated = false;
  try {
    fs.symlinkSync(realDir, linkDir, 'junction');
    symlinkCreated = true;
  } catch {
    try {
      fs.symlinkSync(realDir, linkDir, 'dir');
      symlinkCreated = true;
    } catch {
      // OS privilege restriction
    }
  }

  if (!symlinkCreated) {
    t.skip('OS denied symlink creation (privilege restriction)');
    return;
  }

  // Create the file inside the real dir so the parent dirs exist
  fs.writeFileSync(path.join(realDir, 'ledger.jsonl'), '', 'utf-8');
  try {
    assert.throws(
      () => new ShadowEventLedger(ledgerPath),
      /symlink|reparse|redirect|junction|fail-closed/i,
    );
  } finally {
    cleanLedgerFile(ledgerPath);
  }
});

test('L46: ancestor symlink in middle of path => constructor rejected', async (t) => {
  // Even when target itself is not a symlink, an ancestor in the path
  // (e.g., grandparent) must be detected
  const baseDir = path.join(os.tmpdir(), 'shadow-ledger-test-anc-sym-' + Date.now());
  const realGrandparent = path.join(baseDir, 'real-gp');
  const linkGrandparent = path.join(baseDir, 'link-gp');
  const childDir = 'child';
  const ledgerPath = path.join(linkGrandparent, childDir, 'ledger.jsonl');

  cleanLedgerFile(ledgerPath);
  fs.mkdirSync(path.join(realGrandparent, childDir), { recursive: true });

  let symlinkCreated = false;
  try {
    fs.symlinkSync(realGrandparent, linkGrandparent, 'junction');
    symlinkCreated = true;
  } catch {
    try {
      fs.symlinkSync(realGrandparent, linkGrandparent, 'dir');
      symlinkCreated = true;
    } catch {
      // skip
    }
  }

  if (!symlinkCreated) {
    t.skip('OS denied symlink creation (privilege restriction)');
    return;
  }

  fs.writeFileSync(path.join(realGrandparent, childDir, 'ledger.jsonl'), '', 'utf-8');
  try {
    assert.throws(
      () => new ShadowEventLedger(ledgerPath),
      /symlink|reparse|redirect|junction|fail-closed/i,
    );
  } finally {
    cleanLedgerFile(ledgerPath);
  }
});

test('L47: empty filePath => constructor rejected', () => {
  assert.throws(
    () => new ShadowEventLedger(''),
    /path|filePath|empty/i,
  );
});

test('L48: directory target => constructor rejected', () => {
  const dir = path.join(os.tmpdir(), 'shadow-ledger-test-dir-target-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  try {
    assert.throws(
      () => new ShadowEventLedger(dir),
      /directory|not a file/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('L49: non-directory parent => constructor rejected', () => {
  const baseDir = path.join(os.tmpdir(), 'shadow-ledger-test-nd-parent-' + Date.now());
  fs.mkdirSync(baseDir, { recursive: true });
  const fileAsParent = path.join(baseDir, 'not-a-dir');
  fs.writeFileSync(fileAsParent, 'i am a file, not a directory', 'utf-8');
  const ledgerPath = path.join(fileAsParent, 'ledger.jsonl');

  try {
    assert.throws(
      () => new ShadowEventLedger(ledgerPath),
      /parent|directory|not a directory/i,
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── Cycle 15: Export hygiene — no test/mock/failure injection symbols ─────

test('L49a: externally created file after nonexistent open is rejected', () => {
  const p = makeLedgerPath('appeared-after-open');
  makeLedgerDir(p);
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  fs.writeFileSync(p, '', 'utf8');
  assert.throws(() => ledger.append(event, obs), /external file creation|fail-closed/i);
  assert.equal(ledger.size, 0);
});

test('L49b: externally deleted verified empty file is rejected', () => {
  const p = makeLedgerPath('deleted-empty');
  makeLedgerDir(p);
  fs.writeFileSync(p, '', 'utf8');
  const { event, obs } = makeTradeEventAndObs();
  const ledger = new ShadowEventLedger(p);

  fs.unlinkSync(p);
  assert.throws(() => ledger.append(event, obs), /external|modification check failed|ENOENT/i);
  assert.equal(ledger.size, 0);
});

test('L50: ShadowEventLedger.ts exports no test/mock/failure/unsafe symbols', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'shadow', 'ShadowEventLedger.ts'),
    'utf-8',
  );

  // Production source must not contain any __test-prefixed symbols
  assert.ok(!/__test/i.test(src), 'ShadowEventLedger.ts must not contain __test symbols');

  // Must not contain failure injection or backdoor seams
  const forbiddenPatterns = ['__mock', 'failureInjection', 'unsafeBackdoor', '__backdoor'];
  for (const pattern of forbiddenPatterns) {
    assert.ok(
      !src.includes(pattern),
      `ShadowEventLedger.ts must not contain "${pattern}" symbol`,
    );
  }

  // Class must not export static test-named accessors
  assert.ok(
    !/static\s+get\s+__test/.test(src),
    'ShadowEventLedger class must not export static __test getter',
  );
  assert.ok(
    !/static\s+set\s+__test/.test(src),
    'ShadowEventLedger class must not export static __test setter',
  );
});
