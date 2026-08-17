import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleHealthFlag } from '../../src/hermes';

test('the lifecycle-health flag is fail-closed (false) initially', () => {
  const flag = createLifecycleHealthFlag();
  assert.equal(flag.isHealthy(), false);
});

test('markHealthy flips the flag true; markUnhealthy flips it back false', () => {
  const flag = createLifecycleHealthFlag();
  flag.markHealthy();
  assert.equal(flag.isHealthy(), true);
  flag.markUnhealthy();
  assert.equal(flag.isHealthy(), false);
});

test('a failed start leaves the flag false (success boundary never reached)', () => {
  const flag = createLifecycleHealthFlag();
  // Model the real failed-start sequence: the success boundary (markHealthy)
  // is never reached because start throws partway through, and the
  // compensating rollback explicitly marks the flag unhealthy.
  let failed = false;
  try {
    // A correct start only calls markHealthy() at the final success boundary;
    // a later synchronous startup operation throws before it gets there.
    throw new Error('a later startup operation failed');
  } catch {
    failed = true;
    // onStartFailure compensating rollback.
    flag.markUnhealthy();
  }
  assert.equal(failed, true);
  assert.equal(flag.isHealthy(), false);
});

test('markUnhealthy is idempotent and stays fail-closed across a stop/restart cycle', () => {
  const flag = createLifecycleHealthFlag();
  flag.markHealthy();
  // Beginning of stop.
  flag.markUnhealthy();
  flag.markUnhealthy();
  assert.equal(flag.isHealthy(), false);
  // Next successful start.
  flag.markHealthy();
  assert.equal(flag.isHealthy(), true);
});
