import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createGatewayServer } from '../../src/gateway/server';
import {
  bindHandshakeToLifecycle,
  createHandshakeCoordinator,
  createLifecycleHealthFlag,
  createLifecycleHookRegistry,
} from '../../src/hermes';
import { createIdFactory, getFreePort } from './helpers';

function runningCoordinator() {
  return createHandshakeCoordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => ({ op: 'test' }),
    randomId: createIdFactory(),
  });
}

test('a fully successful delegate start runs coordinator.start() only at the success boundary', async () => {
  const coordinator = runningCoordinator();
  const events: string[] = [];
  const lifecycle = {
    async start() {
      events.push('delegate:start');
    },
    async stop() {
      events.push('delegate:stop');
    },
  };
  const registry = createLifecycleHookRegistry();
  const bound = bindHandshakeToLifecycle(lifecycle, { coordinator, registry });

  await bound.start();
  // The onStart hook (coordinator.start) runs after the delegate start returned.
  assert.equal(coordinator.getSnapshot().state, 'running');
  assert.equal(coordinator.getSnapshot().generation, 1);
  assert.deepEqual(events, ['delegate:start']);
  assert.equal(registry.getSnapshot().running, true);
});

test('a failed delegate start leaves the coordinator STOPPED/non-authorizing and preserves the original error', async () => {
  const coordinator = runningCoordinator();
  const rollbacks: string[] = [];
  const lifecycle = {
    async start() {
      throw new Error('feeds failed to start');
    },
    async stop() {},
  };
  const bound = bindHandshakeToLifecycle(lifecycle, {
    coordinator,
    onStartFailure: () => {
      rollbacks.push('rollback');
    },
  });

  await assert.rejects(bound.start(), /feeds failed to start/);
  assert.deepEqual(rollbacks, ['rollback']);

  // The coordinator was never started, so it cannot authorize anything.
  assert.equal(coordinator.getSnapshot().state, 'stopped');
  assert.equal(coordinator.getSnapshot().startedAt, null);
  const confirm = await coordinator.confirmHealth();
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.reason, 'STOPPED');
  const pull = await coordinator.pullInstruction('whatever');
  assert.equal(pull.authorized, false);
  assert.equal(pull.reason, 'STOPPED');
});

test('when onStartFailure throws, the original start error identity is still rethrown', async () => {
  const coordinator = runningCoordinator();
  const original = new Error('original start failure');
  const lifecycle = {
    async start() {
      throw original;
    },
    async stop() {},
  };
  const bound = bindHandshakeToLifecycle(lifecycle, {
    coordinator,
    onStartFailure: async () => {
      // The compensating rollback itself fails — this must NOT replace the
      // original start error.
      throw new Error('rollback also failed');
    },
  });

  let caught: unknown;
  try {
    await bound.start();
  } catch (error) {
    caught = error;
  }

  // The SAME original error object — not the rollback error — is rethrown.
  assert.equal(caught, original);
  assert.equal((caught as Error).message, 'original start failure');

  // The coordinator remains stopped/non-authorizing.
  assert.equal(coordinator.getSnapshot().state, 'stopped');
});

test('a failed start after the HTTP listener came up releases the port, and a retry can start', async () => {
  const port = await getFreePort();
  const httpGateway = createGatewayServer({ port, cors: false, auth: {} });
  const coordinator = runningCoordinator();

  let attempts = 0;
  const delegate = {
    async start() {
      attempts += 1;
      await httpGateway.start(); // the HTTP listener is up from here on
      if (attempts === 1) {
        throw new Error('a dependency after HTTP start failed');
      }
    },
    async stop() {
      await httpGateway.stop();
    },
  };

  const bound = bindHandshakeToLifecycle(delegate, {
    coordinator,
    onStartFailure: async () => {
      await httpGateway.stop(); // compensating rollback closes the listener
    },
  });

  // First attempt fails after the listener is already listening.
  await assert.rejects(bound.start(), /a dependency after HTTP start failed/);
  assert.equal(coordinator.getSnapshot().state, 'stopped');

  // Retry on the SAME port succeeds only if the listener was actually released
  // (a leaked listener would raise EADDRINUSE).
  await bound.start();
  assert.equal(coordinator.getSnapshot().state, 'running');
  assert.equal(coordinator.getSnapshot().generation, 1);

  // And a running coordinator authorizes health and issues a receipt.
  const confirm = await coordinator.confirmHealth();
  assert.equal(confirm.confirmed, true);
  assert.ok(confirm.receipt);

  await bound.stop();
  assert.equal(coordinator.getSnapshot().state, 'stopped');
});

test('stop and restart preserve the generation invariant and invalidate old receipts', async () => {
  const coordinator = runningCoordinator();
  const lifecycle = { async start() {}, async stop() {} };
  const bound = bindHandshakeToLifecycle(lifecycle, { coordinator });

  await bound.start();
  assert.equal(coordinator.getSnapshot().generation, 1);
  const r1 = await coordinator.confirmHealth();
  assert.ok(r1.receipt);

  await bound.stop();
  assert.equal(coordinator.getSnapshot().state, 'stopped');

  await bound.start();
  assert.equal(coordinator.getSnapshot().generation, 2);
  // Make generation 2 healthy so the pull reaches the receipt gate.
  const r2 = await coordinator.confirmHealth();
  assert.ok(r2.receipt);

  // The generation-1 receipt was cleared and can no longer authorize.
  const replay = await coordinator.pullInstruction(r1.receipt as string);
  assert.equal(replay.authorized, false);
  assert.equal(replay.reason, 'UNKNOWN_RECEIPT');

  await bound.stop();
});

test('concurrent start calls start the coordinator exactly once', async () => {
  const coordinator = runningCoordinator();
  let startCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lifecycle = {
    async start() {
      startCalls += 1;
      await gate;
    },
    async stop() {},
  };
  const bound = bindHandshakeToLifecycle(lifecycle, { coordinator });

  const p1 = bound.start();
  const p2 = bound.start();
  release();
  await Promise.all([p1, p2]);

  assert.equal(startCalls, 1);
  assert.equal(coordinator.getSnapshot().generation, 1);
  assert.equal(coordinator.getSnapshot().state, 'running');
});

test('an explicit registry is reused and reports the bound handshake hook', async () => {
  const coordinator = runningCoordinator();
  const registry = createLifecycleHookRegistry();
  const lifecycle = { async start() {}, async stop() {} };
  bindHandshakeToLifecycle(lifecycle, { coordinator, registry });

  assert.deepEqual(registry.list(), ['hermes-handshake']);
});

test('a failed delegate start leaves the lifecycle-health flag false (rollback marks unhealthy)', async () => {
  // Wire the authoritative lifecycle-health flag into the coordinator exactly
  // as createGateway does: the coordinator's health collector reads the flag.
  const flag = createLifecycleHealthFlag();
  const coordinator = createHandshakeCoordinator({
    healthCollector: () => (flag.isHealthy() ? 'healthy' : 'unhealthy'),
    randomId: createIdFactory(),
  });
  const lifecycle = {
    async start() {
      // Simulate a partial start that (incorrectly, in a future regression)
      // flipped the flag true before a later synchronous startup op threw.
      flag.markHealthy();
      throw new Error('a later startup operation failed');
    },
    async stop() {
      flag.markUnhealthy();
    },
  };
  const bound = bindHandshakeToLifecycle(lifecycle, {
    coordinator,
    onStartFailure: () => {
      // Compensating rollback explicitly marks the flag unhealthy.
      flag.markUnhealthy();
    },
  });

  await assert.rejects(bound.start(), /a later startup operation failed/);

  // The flag is false after the failed start, so the coordinator's health
  // collector reports unhealthy and no receipt can be issued.
  assert.equal(flag.isHealthy(), false);
  const confirm = await coordinator.confirmHealth();
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.reason, 'STOPPED');
});

test('a failed delegate stop revokes authorization at stop-begin: the prior receipt cannot authorize and stop stays retryable', async () => {
  const coordinator = runningCoordinator();
  let stopAttempts = 0;
  const lifecycle = {
    async start() {},
    async stop() {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error('delegate stop failed');
    },
  };
  const bound = bindHandshakeToLifecycle(lifecycle, { coordinator });

  // 1. Start successfully.
  await bound.start();
  assert.equal(coordinator.getSnapshot().state, 'running');
  assert.equal(coordinator.getSnapshot().generation, 1);

  // 2. Confirm health and obtain a real valid receipt.
  const confirm = await coordinator.confirmHealth();
  assert.equal(confirm.confirmed, true);
  assert.ok(confirm.receipt);

  // 3-4. Begin stop; the delegate stop throws.
  await assert.rejects(bound.stop(), /delegate stop failed/);

  // 5. The coordinator is now non-authorizing (fail-closed at stop-begin).
  assert.equal(coordinator.getSnapshot().state, 'stopped');

  // 6. The previously valid receipt cannot authorize an instruction pull.
  const pull = await coordinator.pullInstruction(confirm.receipt as string);
  assert.equal(pull.authorized, false);

  // No new receipt may be issued either.
  const reConfirm = await coordinator.confirmHealth();
  assert.equal(reConfirm.confirmed, false);

  // The failed stop must not spuriously advance the generation.
  assert.equal(coordinator.getSnapshot().generation, 1);

  // 7. A subsequent stop retry remains possible.
  await bound.stop();
  assert.equal(stopAttempts, 2);
  assert.equal(coordinator.getSnapshot().state, 'stopped');

  // 8. After successful stop + restart, normal generation behavior holds.
  await bound.start();
  assert.equal(coordinator.getSnapshot().state, 'running');
  assert.equal(coordinator.getSnapshot().generation, 2);
  const confirm2 = await coordinator.confirmHealth();
  assert.equal(confirm2.confirmed, true);
  assert.ok(confirm2.receipt);
});
