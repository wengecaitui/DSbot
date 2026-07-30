/**
 * Stage 4B4.3 — deterministic shadow-runtime proof tests.
 * REFERENCE SHADOW INFRASTRUCTURE PROOF ONLY.
 * NOT A STRATEGY BACKTEST. NOT APPROVED FOR PAPER, TESTNET OR LIVE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalSerialize } from '../../src/shadow/CanonicalJson';
import { createCanonicalShadowEvent } from '../../src/shadow/CanonicalShadowEvent';
import { createShadowDecisionOutcome } from '../../src/shadow/ShadowDecisionOutcome';
import { ShadowRuntimeCoordinator } from '../../src/shadow/ShadowRuntimeCoordinator';
import {
  createShadowRuntimeProof,
  verifyShadowRuntimeProof,
  SHADOW_RUNTIME_PROOF_SCHEMA_VERSION,
  STAGE_4B4_2_BASELINE,
  type ShadowRuntimeProof,
  type ShadowRuntimeProofContext,
} from '../../src/shadow/ShadowRuntimeProof';
import {
  REF_EXCHANGE, REF_SYMBOL, REF_SOURCE, REF_REASON, REF_EVENT_TIME_MS,
  makeRefTradeIntent,
} from '../helpers/shadow-reference-fixtures';

const SOURCE_COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);

function fixture(decisions: readonly ('trade' | 'skip')[] = ['trade']): {
  context: ShadowRuntimeProofContext;
  ledgerFile: string;
  snapshotFile: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-shadow-proof-'));
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const snapshotFile = path.join(dir, 'snapshot.json');
  const coordinator = new ShadowRuntimeCoordinator(ledgerFile, snapshotFile);
  coordinator.startup();
  decisions.forEach((decision, index) => {
    const outcome = decision === 'trade'
      ? createShadowDecisionOutcome({
        exchange: REF_EXCHANGE,
        decision: 'trade',
        direction: 'long',
        symbol: REF_SYMBOL,
        positionUsd: 1500,
        tradeIntent: makeRefTradeIntent(),
        reason: REF_REASON,
      }, REF_EXCHANGE, REF_SYMBOL)
      : createShadowDecisionOutcome({
        exchange: REF_EXCHANGE,
        decision: 'skip',
        reason: 'REFERENCE NO SIGNAL',
      }, REF_EXCHANGE, REF_SYMBOL);
    const event = createCanonicalShadowEvent(
      REF_SOURCE,
      REF_EVENT_TIME_MS + index,
      index,
      outcome,
    );
    assert.equal(coordinator.process(event, outcome).status, 'accepted');
  });
  coordinator.stop();
  return {
    ledgerFile,
    snapshotFile,
    context: {
      sourceCommit: SOURCE_COMMIT,
      implementationBaseline: STAGE_4B4_2_BASELINE,
      ledgerFile,
      snapshotFile,
    },
  };
}

function mutableCopy(proof: ShadowRuntimeProof): Record<string, unknown> {
  return JSON.parse(JSON.stringify(proof)) as Record<string, unknown>;
}

test('PROOF: real coordinator lifecycle creates exact deterministic fail-closed artifact', () => {
  const { context, ledgerFile, snapshotFile } = fixture();
  const first = createShadowRuntimeProof(context);
  const second = createShadowRuntimeProof(context);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, SHADOW_RUNTIME_PROOF_SCHEMA_VERSION);
  assert.equal(first.proofScope, 'REFERENCE SHADOW INFRASTRUCTURE PROOF ONLY');
  assert.equal(first.strategyBacktest, false);
  assert.equal(first.approvalStatement, 'NOT APPROVED FOR PAPER, TESTNET OR LIVE');
  assert.equal(first.runtimeState, 'STOPPED');
  assert.equal(first.zeroAdapterCalls, 0);
  assert.equal(first.paperApproved, false);
  assert.equal(first.testnetApproved, false);
  assert.equal(first.liveApproved, false);
  assert.equal(first.ledgerSize, 1);
  assert.match(first.ledgerDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.ledgerSha256,
    crypto.createHash('sha256').update(fs.readFileSync(ledgerFile)).digest('hex'));
  assert.equal(first.snapshotSha256,
    crypto.createHash('sha256').update(fs.readFileSync(snapshotFile)).digest('hex'));
  assert.deepEqual(Object.keys(first), [
    'schemaVersion', 'proofScope', 'strategyBacktest', 'approvalStatement',
    'sourceCommit', 'implementationBaseline', 'runtimeState', 'ledgerSize',
    'ledgerDigest', 'snapshotId', 'ledgerSha256', 'snapshotSha256', 'eventIds',
    'observationIds', 'zeroAdapterCalls', 'paperApproved', 'testnetApproved',
    'liveApproved', 'proofId',
  ]);
  const json = canonicalSerialize(first);
  assert.equal(json.includes(dirName(ledgerFile)), false);
  assert.equal(json.includes(dirName(snapshotFile)), false);
  assert.equal(verifyShadowRuntimeProof(first, context)?.proofId, first.proofId);
});

function dirName(file: string): string {
  return path.dirname(file).replace(/\\/g, '\\\\');
}

test('PROOF: source and implementation binding changes ID and context mismatch rejects', () => {
  const { context } = fixture();
  const proof = createShadowRuntimeProof(context);
  const otherSource = createShadowRuntimeProof({ ...context, sourceCommit: OTHER_COMMIT });
  const otherBaseline = createShadowRuntimeProof({ ...context, implementationBaseline: OTHER_COMMIT });
  assert.notEqual(proof.proofId, otherSource.proofId);
  assert.notEqual(proof.proofId, otherBaseline.proofId);
  assert.equal(verifyShadowRuntimeProof(proof, { ...context, sourceCommit: OTHER_COMMIT }), null);
  assert.equal(verifyShadowRuntimeProof(proof, { ...context, implementationBaseline: OTHER_COMMIT }), null);
});

test('PROOF: every top-level field tamper fails, including approval flips and fake IDs', () => {
  const { context } = fixture(['trade', 'trade']);
  const proof = createShadowRuntimeProof(context);
  for (const key of Object.keys(proof)) {
    const tampered = mutableCopy(proof);
    const value = tampered[key];
    if (typeof value === 'boolean') tampered[key] = !value;
    else if (typeof value === 'number') tampered[key] = value + 1;
    else if (Array.isArray(value)) tampered[key] = [...value].reverse();
    else tampered[key] = `${String(value)}-tampered`;
    if (key !== 'proofId') tampered.proofId = 'srp-' + 'f'.repeat(64);
    assert.equal(verifyShadowRuntimeProof(tampered, context), null, key);
  }
  const extra = { ...mutableCopy(proof), unexpected: true };
  assert.equal(verifyShadowRuntimeProof(extra, context), null);
  const missing = mutableCopy(proof);
  delete missing.runtimeState;
  assert.equal(verifyShadowRuntimeProof(missing, context), null);
});

test('PROOF: evidence byte mutation and stale snapshot fail closed', () => {
  {
    const { context, ledgerFile } = fixture();
    const proof = createShadowRuntimeProof(context);
    fs.appendFileSync(ledgerFile, ' ');
    assert.equal(verifyShadowRuntimeProof(proof, context), null);
    assert.throws(() => createShadowRuntimeProof(context));
  }
  {
    const { context, snapshotFile } = fixture();
    const proof = createShadowRuntimeProof(context);
    const bytes = fs.readFileSync(snapshotFile);
    bytes[10] ^= 1;
    fs.writeFileSync(snapshotFile, bytes);
    assert.equal(verifyShadowRuntimeProof(proof, context), null);
    assert.throws(() => createShadowRuntimeProof(context));
  }
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-shadow-stale-'));
    const ledgerFile = path.join(dir, 'ledger.jsonl');
    const snapshotFile = path.join(dir, 'snapshot.json');
    const coordinator = new ShadowRuntimeCoordinator(ledgerFile, snapshotFile);
    coordinator.startup();
    const outcome = createShadowDecisionOutcome({
      exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL,
      positionUsd: 1500, tradeIntent: makeRefTradeIntent(), reason: REF_REASON,
    }, REF_EXCHANGE, REF_SYMBOL);
    const first = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, 0, outcome);
    assert.equal(coordinator.process(first, outcome).status, 'accepted');
    const stale = fs.readFileSync(snapshotFile);
    const second = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS + 1, 1, outcome);
    assert.equal(coordinator.process(second, outcome).status, 'accepted');
    coordinator.stop();
    fs.writeFileSync(snapshotFile, stale);
    assert.throws(() => createShadowRuntimeProof({
      sourceCommit: SOURCE_COMMIT,
      implementationBaseline: STAGE_4B4_2_BASELINE,
      ledgerFile,
      snapshotFile,
    }));
  }
});

test('PROOF: empty and non-trade-only evidence cannot produce a proof', () => {
  const empty = fixture([]);
  assert.throws(() => createShadowRuntimeProof(empty.context), /empty ledger/);
  const skip = fixture(['skip']);
  assert.throws(() => createShadowRuntimeProof(skip.context), /trade intent/);
});

test('PROOF: verifier never invokes caller getters and returns independent frozen data', () => {
  const { context } = fixture();
  const proof = createShadowRuntimeProof(context);
  let getterCalls = 0;
  const accessor = mutableCopy(proof);
  Object.defineProperty(accessor, 'proofId', {
    enumerable: true,
    get() { getterCalls++; return proof.proofId; },
  });
  assert.equal(verifyShadowRuntimeProof(accessor, context), null);
  assert.equal(getterCalls, 0);

  const caller = mutableCopy(proof);
  const verified = verifyShadowRuntimeProof(caller, context);
  assert.ok(verified);
  assert.notEqual(verified, caller);
  assert.equal(Object.isFrozen(caller), false);
  assert.equal(Object.isFrozen(caller.eventIds as object), false);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.eventIds), true);
  assert.equal(Object.isFrozen(verified.observationIds), true);
});

test('PROOF: non-plain, symbol, hidden, malformed arrays and proxies reject', () => {
  const { context } = fixture();
  const proof = createShadowRuntimeProof(context);
  assert.equal(verifyShadowRuntimeProof(Object.create(mutableCopy(proof)), context), null);
  const symbolic = mutableCopy(proof);
  Object.defineProperty(symbolic, Symbol('x'), { value: 1 });
  assert.equal(verifyShadowRuntimeProof(symbolic, context), null);
  const hidden = mutableCopy(proof);
  Object.defineProperty(hidden, 'proofId', { value: proof.proofId, enumerable: false });
  assert.equal(verifyShadowRuntimeProof(hidden, context), null);
  const sparse = mutableCopy(proof);
  sparse.eventIds = new Array(1);
  assert.equal(verifyShadowRuntimeProof(sparse, context), null);
  let ordinaryGets = 0;
  const proxy = new Proxy(mutableCopy(proof), {
    get(target, property, receiver) {
      ordinaryGets++;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.ok(verifyShadowRuntimeProof(proxy, context));
  assert.equal(ordinaryGets, 0);
});

test('PROOF: source has no forbidden runtime dependency', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/shadow/ShadowRuntimeProof.ts'), 'utf8');
  for (const forbidden of [
    'FillSimulator', 'PaperFill', '/execution', '/router', '/adapters',
    'PaperBroker', 'Testnet', 'LiveTrading',
  ]) {
    assert.equal(source.includes(`from '${forbidden}`), false, forbidden);
    assert.equal(source.includes(`require('${forbidden}`), false, forbidden);
  }
});
