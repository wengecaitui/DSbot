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

test('generation-mismatched receipt is rejected after a restart', async () => {
  const { c } = coordinator({ healthCollector: () => 'healthy' });
  await c.start();
  const first = await c.confirmHealth();
  await c.stop();
  await c.start(); // generation 2
  await c.confirmHealth(); // healthy in generation 2
  rejected(await c.pullInstruction(first.receipt!), 'GENERATION_MISMATCH');
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
test('instruction supplier is injected and deterministic; its failure yields null instruction', async () => {
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

test('a throwing instruction supplier still authorizes but yields null instruction', async () => {
  const { c } = coordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => {
      throw new Error('no instruction');
    },
  });
  await c.start();
  const { receipt } = await c.confirmHealth();
  const result = await c.pullInstruction(receipt!);
  assert.equal(result.authorized, true);
  if (result.authorized) assert.equal(result.instruction, null);
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

// ─── no network / trading side effects with defaults ────────────────────────
test('default configuration performs no I/O: pure health, null instruction, no-op flush', async () => {
  const c = createHandshakeCoordinator(); // all defaults
  await c.start();
  const confirm = await c.confirmHealth();
  assert.equal(confirm.confirmed, true); // default collector is always healthy (pure)
  const result = await c.pullInstruction(confirm.receipt!);
  assert.equal(result.authorized, true);
  if (result.authorized) assert.equal(result.instruction, null);
});
