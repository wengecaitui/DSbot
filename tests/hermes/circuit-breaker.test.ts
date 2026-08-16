import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandshakeCircuitBreaker } from '../../src/hermes';
import { createClock } from './helpers';

test('breaker starts closed and allows pull and probe', () => {
  const b = createHandshakeCircuitBreaker();
  assert.equal(b.getState().state, 'closed');
  assert.equal(b.allowsPull(), true);
  assert.equal(b.acquireProbe(), true);
});

test('opens after the failure threshold is reached', () => {
  const b = createHandshakeCircuitBreaker({ failureThreshold: 3 });
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.getState().state, 'closed');
  assert.equal(b.getState().consecutiveFailures, 2);
  b.recordFailure();
  assert.equal(b.getState().state, 'open');
  assert.equal(b.allowsPull(), false);
  assert.equal(b.acquireProbe(), false); // within cooldown
});

test('success resets the failure count in closed state', () => {
  const b = createHandshakeCircuitBreaker({ failureThreshold: 3 });
  b.recordFailure();
  b.recordFailure();
  b.recordSuccess();
  assert.equal(b.getState().consecutiveFailures, 0);
  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.getState().state, 'open');
});

test('cooldown probe: half-open permits one attempt, success recovers to closed', () => {
  const clock = createClock();
  const b = createHandshakeCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: clock.now });
  b.recordFailure(); // open
  assert.equal(b.getState().state, 'open');
  assert.equal(b.acquireProbe(), false);
  clock.advance(30_001);
  assert.equal(b.acquireProbe(), true); // half-open probe
  assert.equal(b.getState().state, 'half_open');
  assert.equal(b.acquireProbe(), false); // only one probe at a time
  b.recordSuccess(); // probe succeeds → recovery
  assert.equal(b.getState().state, 'closed');
  assert.equal(b.allowsPull(), true);
});

test('cooldown probe: a failed probe re-opens immediately', () => {
  const clock = createClock();
  const b = createHandshakeCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: clock.now });
  b.recordFailure(); // open
  clock.advance(30_001);
  b.acquireProbe(); // half-open
  b.recordFailure(); // probe fails → re-open
  assert.equal(b.getState().state, 'open');
  assert.equal(b.getState().consecutiveFailures, 2);
});

test('re-open: after recovery, subsequent failures open it again', () => {
  const clock = createClock();
  const b = createHandshakeCircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, now: clock.now });
  b.recordFailure();
  b.recordFailure(); // open
  clock.advance(10_001);
  b.acquireProbe();
  b.recordSuccess(); // recovered
  assert.equal(b.getState().state, 'closed');
  b.recordFailure();
  b.recordFailure(); // re-open
  assert.equal(b.getState().state, 'open');
});

test('reset returns to closed with zero failures', () => {
  const b = createHandshakeCircuitBreaker({ failureThreshold: 1 });
  b.recordFailure();
  assert.equal(b.getState().state, 'open');
  b.reset();
  assert.equal(b.getState().state, 'closed');
  assert.equal(b.getState().consecutiveFailures, 0);
});

test('invalid threshold and cooldown fall back to defaults', () => {
  const b = createHandshakeCircuitBreaker({ failureThreshold: 0, cooldownMs: -1 });
  assert.equal(b.getState().state, 'closed');
  b.recordFailure();
  b.recordFailure();
  b.recordFailure(); // default threshold 3
  assert.equal(b.getState().state, 'open');
});
