import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleHookRegistry } from '../../src/hermes';

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
