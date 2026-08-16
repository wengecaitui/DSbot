import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandshakeCoordinator } from '../../src/hermes';
import type { PullResult } from '../../src/hermes';
import { createClock, createIdFactory } from './helpers';

function coordinator(overrides: Record<string, unknown> = {}) {
  const clock = createClock();
  const ids = createIdFactory();
  const options = {
    now: clock.now,
    randomId: ids,
    receiptTtlMs: 30_000,
    healthFreshnessMs: 10_000,
    // A real (non-null) instruction so receipt-semantics tests can authorize;
    // fail-closed supply cases inject their own supplier via overrides.
    instructionSupplier: () => ({ op: 'pull' }),
    ...overrides,
  };
  return { c: createHandshakeCoordinator(options), clock, ids };
}

function authorized(result: PullResult): asserts result is Extract<PullResult, { authorized: true }> {
  assert.equal(result.authorized, true);
}

function rejected(result: PullResult, reason: string) {
  assert.equal(result.authorized, false);
  assert.equal((result as Extract<PullResult, { authorized: false }>).reason, reason);
}

// ─── lifecycle start/stop idempotency and generation changes ────────────────
test('default state is non-authorizing and stopped', async () => {
  const { c } = coordinator();
  assert.equal(c.getSnapshot().state, 'stopped');
  assert.equal(c.getSnapshot().generation, 0);
  const confirm = await c.confirmHealth();
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.reason, 'STOPPED');
  rejected(await c.pullInstruction('anything'), 'STOPPED');
});

test('start is idempotent within a cycle; stop is idempotent; generation advances on restart', async () => {
  const { c } = coordinator();
  await c.start();
  assert.equal(c.getSnapshot().generation, 1);
  await c.start(); // no double start
  assert.equal(c.getSnapshot().generation, 1);
  assert.equal(c.getSnapshot().state, 'running');

  await c.stop();
  await c.stop(); // no double stop
  assert.equal(c.getSnapshot().state, 'stopped');

  await c.start();
  assert.equal(c.getSnapshot().generation, 2);
});

// ─── health receipt issuance only in an authorizing healthy/running state ──
test('confirmHealth issues a non-empty receipt only when running and healthy', async () => {
  const { c } = coordinator({ healthCollector: () => 'healthy' });
  await c.start();
  const confirm = await c.confirmHealth();
  assert.equal(confirm.confirmed, true);
  assert.equal(confirm.generation, 1);
  assert.ok(typeof confirm.receipt === 'string' && confirm.receipt.length > 0);
  assert.equal(confirm.circuitState, 'closed');
});

test('unhealthy collection issues no receipt and records UNHEALTHY', async () => {
  const { c } = coordinator({ healthCollector: () => 'unhealthy' });
  await c.start();
  const confirm = await c.confirmHealth();
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.receipt, null);
  assert.equal(confirm.reason, 'UNHEALTHY');
});

test('a throwing health collector is contained and treated as unhealthy', async () => {
  const { c } = coordinator({
    healthCollector: () => {
      throw new Error('collector boom');
    },
  });
  await c.start();
  const confirm = await c.confirmHealth();
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.reason, 'UNHEALTHY');
});

// ─── timeout / unhealthy / stopped rejection ────────────────────────────────
test('stopped state rejects a previously-issued receipt', async () => {
  const { c } = coordinator({ healthCollector: () => 'healthy' });
  await c.start();
  const { receipt } = await c.confirmHealth();
  await c.stop();
  rejected(await c.pullInstruction(receipt!), 'STOPPED');
});

test('unhealthy state rejects a previously-issued receipt', async () => {
  let healthy = true;
  const { c } = coordinator({ healthCollector: () => (healthy ? 'healthy' : 'unhealthy') });
  await c.start();
  const { receipt } = await c.confirmHealth();
  healthy = false;
  await c.confirmHealth(); // now unhealthy
  rejected(await c.pullInstruction(receipt!), 'UNHEALTHY');
});

test('stale health confirmation times out and is rejected', async () => {
  const { c, clock } = coordinator({
    healthCollector: () => 'healthy',
    receiptTtlMs: 100_000,
    healthFreshnessMs: 10_000,
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  clock.advance(10_001); // freshness exceeded, but receipt not yet expired
  rejected(await c.pullInstruction(receipt!), 'TIMED_OUT');
});

// ─── expiry / replay / generation-mismatch rejection ───────────────────────
test('expired receipt is rejected', async () => {
  const { c, clock } = coordinator({
    healthCollector: () => 'healthy',
    receiptTtlMs: 10_000,
    healthFreshnessMs: 1_000_000,
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  clock.advance(10_001); // receipt expired, but health still fresh
  rejected(await c.pullInstruction(receipt!), 'EXPIRED_RECEIPT');
});

test('replayed receipt is rejected after a single successful use', async () => {
  const { c } = coordinator({ healthCollector: () => 'healthy' });
  await c.start();
  const { receipt } = await c.confirmHealth();
  authorized(await c.pullInstruction(receipt!));
  rejected(await c.pullInstruction(receipt!), 'REPLAYED_RECEIPT');
});

test('a prior-generation receipt cannot authorize after a restart', async () => {
  const { c } = coordinator({ healthCollector: () => 'healthy' });
  await c.start();
  const first = await c.confirmHealth();
  await c.stop();
  await c.start(); // generation 2 clears prior-generation receipts
  await c.confirmHealth(); // healthy in generation 2
  const result = await c.pullInstruction(first.receipt!);
  assert.equal(result.authorized, false);
  const reason = (result as Extract<PullResult, { authorized: false }>).reason;
  assert.ok(['UNKNOWN_RECEIPT', 'GENERATION_MISMATCH'].includes(reason));
});

test('empty and unknown receipts are rejected', async () => {
  const { c } = coordinator({ healthCollector: () => 'healthy' });
  await c.start();
  await c.confirmHealth();
  rejected(await c.pullInstruction(''), 'EMPTY_RECEIPT');
  rejected(await c.pullInstruction('bogus-not-issued'), 'UNKNOWN_RECEIPT');
});

// ─── concurrent pull race: exactly one consumer succeeds ────────────────────
test('two concurrent pulls of the same receipt authorize exactly one consumer', async () => {
  const { c } = coordinator({ healthCollector: () => 'healthy' });
  await c.start();
  const { receipt } = await c.confirmHealth();
  const [a, b] = await Promise.all([
    c.pullInstruction(receipt!),
    c.pullInstruction(receipt!),
  ]);
  const authorizedCount = [a, b].filter(r => r.authorized).length;
  assert.equal(authorizedCount, 1);
  const reasons = [a, b]
    .filter(r => !r.authorized)
    .map(r => (r as Extract<PullResult, { authorized: false }>).reason);
  assert.deepEqual(reasons, ['REPLAYED_RECEIPT']);
});

// ─── circuit open, cooldown probe, recovery, re-open ────────────────────────
test('consecutive health failures open the circuit; cooldown probe recovers; it can re-open', async () => {
  let healthy = false;
  const { c, clock } = coordinator({
    healthCollector: () => (healthy ? 'healthy' : 'unhealthy'),
    breaker: { failureThreshold: 3, cooldownMs: 30_000 },
  });
  await c.start();

  // Trip the circuit open with three consecutive unhealthy confirmations.
  await c.confirmHealth();
  await c.confirmHealth();
  const third = await c.confirmHealth();
  assert.equal(third.circuitState, 'open');
  assert.equal(c.getSnapshot().circuitState, 'open');

  // While open (within cooldown), health confirmation is blocked.
  healthy = true;
  const blocked = await c.confirmHealth();
  assert.equal(blocked.confirmed, false);
  assert.equal(blocked.reason, 'CIRCUIT_OPEN');

  // After cooldown, a healthy confirmation is a half-open probe → recovery.
  clock.advance(30_001);
  const recovered = await c.confirmHealth();
  assert.equal(recovered.confirmed, true);
  assert.equal(recovered.circuitState, 'closed');
  assert.equal(c.getSnapshot().circuitState, 'closed');

  // Re-open with three more failures.
  healthy = false;
  await c.confirmHealth();
  await c.confirmHealth();
  const reopen = await c.confirmHealth();
  assert.equal(reopen.circuitState, 'open');
});

test('an open circuit rejects an otherwise-valid pull', async () => {
  let healthy = true;
  const { c } = coordinator({
    healthCollector: () => (healthy ? 'healthy' : 'unhealthy'),
    breaker: { failureThreshold: 1, cooldownMs: 60_000 },
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  healthy = false;
  await c.confirmHealth(); // single failure opens the circuit (threshold 1)
  assert.equal(c.getSnapshot().circuitState, 'open');
  rejected(await c.pullInstruction(receipt!), 'CIRCUIT_OPEN');
});

// ─── instruction supply is injected; failure does not re-open the handshake ─
test('instruction supplier is injected and deterministic; a real payload is returned', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => ({ op: 'pull', id: 42 }),
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  const result = await c.pullInstruction(receipt!);
  assert.equal(result.authorized, true);
  if (result.authorized) {
    assert.deepEqual(result.instruction, { op: 'pull', id: 42 });
  }
});

test('a throwing instruction supplier rejects the pull fail-closed', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => {
      throw new Error('no instruction');
    },
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  rejected(await c.pullInstruction(receipt!), 'INSTRUCTION_UNAVAILABLE');
});

test('a null instruction supplier rejects the pull fail-closed', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => null,
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  rejected(await c.pullInstruction(receipt!), 'INSTRUCTION_UNAVAILABLE');
});

test('an undefined instruction supplier rejects the pull fail-closed', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => undefined,
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  rejected(await c.pullInstruction(receipt!), 'INSTRUCTION_UNAVAILABLE');
});

test('a never-resolving instruction supplier times out and rejects fail-closed', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => new Promise(() => {}),
    instructionTimeoutMs: 50,
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  rejected(await c.pullInstruction(receipt!), 'INSTRUCTION_UNAVAILABLE');
});

test('a failed pull consumes its receipt: replay is rejected after supplier failure', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => null,
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  rejected(await c.pullInstruction(receipt!), 'INSTRUCTION_UNAVAILABLE');
  rejected(await c.pullInstruction(receipt!), 'REPLAYED_RECEIPT');
});

// ─── snapshot mutation resistance ───────────────────────────────────────────
test('coordinator snapshot is frozen and does not expose internal mutation', async () => {
  const { c } = coordinator({ healthCollector: () => 'healthy' });
  await c.start();
  await c.confirmHealth();
  const snap = c.getSnapshot();
  assert.ok(Object.isFrozen(snap));
  const before = c.getSnapshot();
  // Attempt to mutate the snapshot (non-strict mode silently no-ops on frozen objects).
  (snap as unknown as Record<string, unknown>).generation = 9999;
  (snap as unknown as Record<string, unknown>).health = 'unhealthy';
  const after = c.getSnapshot();
  assert.deepEqual(after, before);
  assert.equal(after.generation, 1);
});

// ─── fail-closed defaults and receipt identity/storage ──────────────────────
test('default configuration is fail-closed: no injected health dependency or instruction authorizes', async () => {
  const c = createHandshakeCoordinator(); // all defaults
  await c.start();
  const confirm = await c.confirmHealth();
  assert.equal(confirm.confirmed, false); // no real health dependency
  assert.equal(confirm.receipt, null);
  rejected(await c.pullInstruction('anything'), 'UNHEALTHY');
});

test('an injected ID source that yields empty IDs fails closed instead of falling back to crypto', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    randomId: () => '',
  });
  await c.start();
  const confirm = await c.confirmHealth();
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.receipt, null);
  assert.equal(confirm.reason, 'RECEIPT_UNAVAILABLE');
});

test('a colliding ID does not overwrite an existing receipt and is retried to a unique value', async () => {
  const sequence = ['dup', 'dup', 'unique', 'unique', 'unique'];
  let call = 0;
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    randomId: () => sequence[call++],
  });
  await c.start();
  const first = await c.confirmHealth();
  assert.equal(first.confirmed, true);
  assert.equal(first.receipt, 'dup');

  const second = await c.confirmHealth();
  assert.equal(second.confirmed, true);
  assert.equal(second.receipt, 'unique');

  // Neither receipt was overwritten: both remain independently usable.
  authorized(await c.pullInstruction(first.receipt!));
  authorized(await c.pullInstruction(second.receipt!));
});

test('expired receipts are pruned deterministically, bounding tracked growth', async () => {
  const { c, clock } = coordinator({
    healthCollector: () => 'healthy',
    receiptTtlMs: 1_000,
    healthFreshnessMs: 1_000_000,
  });
  await c.start();
  await c.confirmHealth(); // receipt 1
  await c.confirmHealth(); // receipt 2
  assert.equal(c.getSnapshot().trackedReceiptCount, 2);

  clock.advance(1_001); // both expire
  await c.confirmHealth(); // prunes the two expired receipts, issues a third
  assert.equal(c.getSnapshot().trackedReceiptCount, 1);
});

test('a consumed receipt is retained for replay until expiry, then pruned', async () => {
  const { c, clock } = coordinator({
    healthCollector: () => 'healthy',
    receiptTtlMs: 1_000,
    healthFreshnessMs: 1_000_000,
  });
  await c.start();
  const { receipt } = await c.confirmHealth(); // receipt 1 at t0
  authorized(await c.pullInstruction(receipt!)); // consumed
  clock.advance(500); // t0 + 500
  await c.confirmHealth(); // receipt 2 at t0+500
  assert.equal(c.getSnapshot().trackedReceiptCount, 2); // tombstone retained
  rejected(await c.pullInstruction(receipt!), 'REPLAYED_RECEIPT'); // replay still detected

  clock.advance(501); // t0 + 1001: receipt 1 expired, receipt 2 still live
  await c.confirmHealth(); // prunes the expired tombstone (receipt 1) only
  assert.equal(c.getSnapshot().trackedReceiptCount, 2); // receipt 2 + receipt 3
  rejected(await c.pullInstruction(receipt!), 'UNKNOWN_RECEIPT'); // pruned → gone
});

test('the tracked-receipt map enforces a maximum bound and fails closed when full', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    receiptTtlMs: 1_000_000,
    healthFreshnessMs: 1_000_000,
    maxTrackedReceipts: 2,
  });
  await c.start();
  const a = await c.confirmHealth();
  const b = await c.confirmHealth();
  assert.equal(a.confirmed, true);
  assert.equal(b.confirmed, true);
  assert.equal(c.getSnapshot().trackedReceiptCount, 2);

  const full = await c.confirmHealth();
  assert.equal(full.confirmed, false);
  assert.equal(full.reason, 'RECEIPT_UNAVAILABLE');
  assert.equal(c.getSnapshot().trackedReceiptCount, 2);
});

test('a capacity-saturated restart starts generation 2 with zero tracked receipts and can issue immediately', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    receiptTtlMs: 1_000_000,
    healthFreshnessMs: 1_000_000,
    maxTrackedReceipts: 2,
  });
  await c.start(); // generation 1
  const a = await c.confirmHealth();
  const b = await c.confirmHealth();
  assert.equal(a.confirmed, true);
  assert.equal(b.confirmed, true);
  assert.equal(c.getSnapshot().trackedReceiptCount, 2);

  await c.stop();
  await c.start(); // generation 2
  assert.equal(c.getSnapshot().generation, 2);
  assert.equal(c.getSnapshot().trackedReceiptCount, 0); // prior receipts cleared
  assert.equal(c.getSnapshot().consumedReceiptCount, 0);

  const gen2 = await c.confirmHealth();
  assert.equal(gen2.confirmed, true); // can issue despite prior saturation
  assert.equal(c.getSnapshot().trackedReceiptCount, 1);
});

test('a receipt is expired exactly at the TTL boundary (now === expiresAt)', async () => {
  const { c, clock } = coordinator({
    healthCollector: () => 'healthy',
    receiptTtlMs: 1_000,
    healthFreshnessMs: 1_000_000,
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  clock.advance(1_000); // exactly expiresAt
  rejected(await c.pullInstruction(receipt!), 'EXPIRED_RECEIPT');
});

test('expired receipts are pruned exactly at the TTL boundary', async () => {
  const { c, clock } = coordinator({
    healthCollector: () => 'healthy',
    receiptTtlMs: 1_000,
    healthFreshnessMs: 1_000_000,
  });
  await c.start();
  await c.confirmHealth(); // receipt 1 at t0
  assert.equal(c.getSnapshot().trackedReceiptCount, 1);
  clock.advance(1_000); // exactly expiresAt
  await c.confirmHealth(); // prunes receipt 1, issues receipt 2
  assert.equal(c.getSnapshot().trackedReceiptCount, 1);
});

test('a whitespace-only injected receipt ID is unavailable', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    randomId: () => '   ',
  });
  await c.start();
  const confirm = await c.confirmHealth();
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.receipt, null);
  assert.equal(confirm.reason, 'RECEIPT_UNAVAILABLE');
});

test('a non-string injected receipt ID is unavailable', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    randomId: () => 123 as unknown as string,
  });
  await c.start();
  const confirm = await c.confirmHealth();
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.receipt, null);
  assert.equal(confirm.reason, 'RECEIPT_UNAVAILABLE');
});
