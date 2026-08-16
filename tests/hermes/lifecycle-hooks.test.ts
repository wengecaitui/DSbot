import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandshakeCoordinator, createLifecycleHookRegistry } from '../../src/hermes';
import { createClock } from './helpers';

function fakeLifecycle() {
  const calls: string[] = [];
  return {
    calls,
    lifecycle: {
      async start() {
        calls.push('start');
      },
      async stop() {
        calls.push('stop');
      },
    },
  };
}

test('adapt delegates to the existing lifecycle exactly once per cycle', async () => {
  const registry = createLifecycleHookRegistry();
  const { calls, lifecycle } = fakeLifecycle();
  const adapted = registry.adapt(lifecycle);

  await adapted.start();
  await adapted.start(); // no double start
  await adapted.stop();
  await adapted.stop(); // no double stop

  assert.deepEqual(calls, ['start', 'stop']);
});

test('start/stop hooks run around the delegate and observe cycles', async () => {
  const registry = createLifecycleHookRegistry();
  const { lifecycle } = fakeLifecycle();
  const events: string[] = [];
  registry.register('a', {
    onStart: () => events.push('a:start'),
    onStop: () => events.push('a:stop'),
  });
  registry.register('b', {
    onStart: () => events.push('b:start'),
  });

  const adapted = registry.adapt(lifecycle);
  await adapted.start();
  await adapted.stop();
  await adapted.start();
  await adapted.stop();

  assert.deepEqual(events, ['a:start', 'b:start', 'a:stop', 'a:start', 'b:start', 'a:stop']);
  assert.equal(registry.getSnapshot().cycle, 2);
});

test('hook failure is contained and observable; delegate still runs', async () => {
  const registry = createLifecycleHookRegistry();
  const { calls, lifecycle } = fakeLifecycle();
  registry.register('boom', {
    onStart: () => {
      throw new Error('start hook exploded');
    },
    onStop: () => {
      throw new Error('stop hook exploded');
    },
  });

  const adapted = registry.adapt(lifecycle);
  await adapted.start(); // must not throw
  await adapted.stop(); // must not throw
  assert.deepEqual(calls, ['start', 'stop']); // delegate unaffected

  const snap = registry.getSnapshot();
  assert.equal(snap.errors.length, 2);
  assert.equal(snap.errors[0].name, 'boom');
  assert.equal(snap.errors[0].phase, 'start');
  assert.equal(snap.errors[0].message, 'start hook exploded');
  assert.equal(snap.errors[1].phase, 'stop');
});

test('unregister removes hooks; list reflects registered names', () => {
  const registry = createLifecycleHookRegistry();
  const un = registry.register('x', { onStart: () => {} });
  registry.register('y', { onStart: () => {} });
  assert.deepEqual(registry.list().sort(), ['x', 'y']);
  un();
  assert.deepEqual(registry.list(), ['y']);
});

test('registry snapshot is a defensive copy', () => {
  const registry = createLifecycleHookRegistry();
  registry.register('x', { onStart: () => {} });
  const snap = registry.getSnapshot();
  (snap.registered as string[]).push('injected');
  assert.deepEqual(registry.getSnapshot().registered, ['x']);
});

test('concurrent starts call the delegate exactly once', async () => {
  const registry = createLifecycleHookRegistry();
  let startCalls = 0;
  let releaseStart!: () => void;
  const gate = new Promise<void>(resolve => { releaseStart = resolve; });
  const lifecycle = {
    async start() { startCalls += 1; await gate; },
    async stop() {},
  };
  const adapted = registry.adapt(lifecycle);
  const p1 = adapted.start();
  const p2 = adapted.start();
  releaseStart();
  await Promise.all([p1, p2]);
  assert.equal(startCalls, 1);
  assert.equal(registry.getSnapshot().running, true);
});

test('concurrent stops call the delegate exactly once', async () => {
  const registry = createLifecycleHookRegistry();
  const calls: string[] = [];
  let releaseStop!: () => void;
  const gate = new Promise<void>(resolve => { releaseStop = resolve; });
  const lifecycle = {
    async start() { calls.push('start'); },
    async stop() { calls.push('stop'); await gate; },
  };
  const adapted = registry.adapt(lifecycle);
  await adapted.start();
  const p1 = adapted.stop();
  const p2 = adapted.stop();
  releaseStop();
  await Promise.all([p1, p2]);
  assert.deepEqual(calls, ['start', 'stop']);
  assert.equal(registry.getSnapshot().running, false);
});

test('a failing delegate start propagates, restores non-running, and retries cleanly', async () => {
  const registry = createLifecycleHookRegistry();
  let startCalls = 0;
  const lifecycle = {
    async start() {
      startCalls += 1;
      if (startCalls === 1) throw new Error('start failed');
    },
    async stop() {},
  };
  const adapted = registry.adapt(lifecycle);

  await assert.rejects(adapted.start(), /start failed/);
  assert.equal(registry.getSnapshot().running, false); // retryable

  await adapted.start(); // retry succeeds
  assert.equal(startCalls, 2);
  assert.equal(registry.getSnapshot().running, true);
});

test('a failing delegate stop propagates and stays conservatively running for retry', async () => {
  const registry = createLifecycleHookRegistry();
  let stopCalls = 0;
  const lifecycle = {
    async start() {},
    async stop() {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error('stop failed');
    },
  };
  const adapted = registry.adapt(lifecycle);

  await adapted.start();
  await assert.rejects(adapted.stop(), /stop failed/);
  assert.equal(registry.getSnapshot().running, true); // conservative

  await adapted.stop(); // retry succeeds
  assert.equal(stopCalls, 2);
  assert.equal(registry.getSnapshot().running, false);
});

test('the injected clock drives hook and error contexts', async () => {
  const clock = createClock(42_000);
  const registry = createLifecycleHookRegistry({ now: clock.now });
  const lifecycle = { async start() {}, async stop() {} };
  const seen: number[] = [];
  registry.register('ok', { onStart: ctx => seen.push(ctx.at) });
  registry.register('boom', { onStart: () => { throw new Error('boom'); } });
  const adapted = registry.adapt(lifecycle);
  clock.advance(7);
  await adapted.start();
  assert.equal(seen[0], 42_007);
  assert.equal(registry.getSnapshot().errors[0].at, 42_007);
});

test('the delegate start completes before any onStart hook runs (event order)', async () => {
  const registry = createLifecycleHookRegistry();
  const events: string[] = [];
  const lifecycle = {
    async start() {
      events.push('delegate:start');
    },
    async stop() {
      events.push('delegate:stop');
    },
  };
  registry.register('hook', {
    onStart: () => events.push('hook:start'),
    onStop: () => events.push('hook:stop'),
  });
  const adapted = registry.adapt(lifecycle);
  await adapted.start();
  await adapted.stop();
  assert.deepEqual(events, ['delegate:start', 'hook:start', 'delegate:stop', 'hook:stop']);
});

test('a failing delegate start runs no onStart hook and leaves a bound coordinator non-authorizing', async () => {
  const registry = createLifecycleHookRegistry();
  const coordinator = createHandshakeCoordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => ({ op: 'pull' }),
  });
  const started: string[] = [];
  // Phase 7B-style binding: the coordinator starts via the onStart hook.
  registry.register('handshake', {
    onStart: () => {
      started.push('hook');
      return coordinator.start();
    },
  });
  const lifecycle = {
    async start() {
      throw new Error('gateway start failed');
    },
    async stop() {},
  };
  const adapted = registry.adapt(lifecycle);

  await assert.rejects(adapted.start(), /gateway start failed/);
  assert.deepEqual(started, []); // no onStart hook ran
  assert.equal(registry.getSnapshot().running, false);

  // The bound coordinator was never started, so it cannot authorize health.
  assert.equal(coordinator.getSnapshot().state, 'stopped');
  const confirm = await coordinator.confirmHealth();
  assert.equal(confirm.confirmed, false);
  assert.equal(confirm.reason, 'STOPPED');
});
