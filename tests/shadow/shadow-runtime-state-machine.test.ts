/**
 * TDD adversarial coverage for ShadowRuntimeStateMachine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowRuntimeStateMachine, ShadowState } from '../../src/shadow/ShadowRuntimeStateMachine';

// ─── Initial state ───────────────────────────────────────────────────────────

test('SM: initial state is STOPPED', () => {
  const sm = new ShadowRuntimeStateMachine();
  assert.equal(sm.state, 'STOPPED' as ShadowState);
});

// ─── All 19 allowed transitions (test each) ─────────────────────────────────

// STOPPED
test('SM: STOPPED + BEGIN_PRECHECK → PRECHECKED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  assert.equal(sm.state, 'PRECHECKED' as ShadowState);
});

test('SM: STOPPED + FAIL → FAILED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('FAIL');
  assert.equal(sm.state, 'FAILED' as ShadowState);
});

// PRECHECKED
test('SM: PRECHECKED + PRECHECK_PASSED → SHADOW_READY', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  assert.equal(sm.state, 'SHADOW_READY' as ShadowState);
});

test('SM: PRECHECKED + PRECHECK_FAILED → FAILED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_FAILED');
  assert.equal(sm.state, 'FAILED' as ShadowState);
});

test('SM: PRECHECKED + STOP → STOPPED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('STOP');
  assert.equal(sm.state, 'STOPPED' as ShadowState);
});

// SHADOW_READY
test('SM: SHADOW_READY + ACTIVATE → SHADOW_ACTIVE', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('ACTIVATE');
  assert.equal(sm.state, 'SHADOW_ACTIVE' as ShadowState);
});

test('SM: SHADOW_READY + STOP → STOPPED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('STOP');
  assert.equal(sm.state, 'STOPPED' as ShadowState);
});

test('SM: SHADOW_READY + FAIL → FAILED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('FAIL');
  assert.equal(sm.state, 'FAILED' as ShadowState);
});

// SHADOW_ACTIVE
test('SM: SHADOW_ACTIVE + PAUSE → PAUSED', () => {
  const sm = activateMachine();
  sm.transition('PAUSE');
  assert.equal(sm.state, 'PAUSED' as ShadowState);
});

test('SM: SHADOW_ACTIVE + RECOVERY_REQUIRED → RECOVERY_REQUIRED', () => {
  const sm = activateMachine();
  sm.transition('RECOVERY_REQUIRED');
  assert.equal(sm.state, 'RECOVERY_REQUIRED' as ShadowState);
});

test('SM: SHADOW_ACTIVE + STOP → STOPPED', () => {
  const sm = activateMachine();
  sm.transition('STOP');
  assert.equal(sm.state, 'STOPPED' as ShadowState);
});

test('SM: SHADOW_ACTIVE + FAIL → FAILED', () => {
  const sm = activateMachine();
  sm.transition('FAIL');
  assert.equal(sm.state, 'FAILED' as ShadowState);
});

// PAUSED
test('SM: PAUSED + RESUME → SHADOW_READY', () => {
  const sm = activateMachine();
  sm.transition('PAUSE');
  sm.transition('RESUME');
  assert.equal(sm.state, 'SHADOW_READY' as ShadowState);
});

test('SM: PAUSED + RECOVERY_REQUIRED → RECOVERY_REQUIRED', () => {
  const sm = activateMachine();
  sm.transition('PAUSE');
  sm.transition('RECOVERY_REQUIRED');
  assert.equal(sm.state, 'RECOVERY_REQUIRED' as ShadowState);
});

test('SM: PAUSED + STOP → STOPPED', () => {
  const sm = activateMachine();
  sm.transition('PAUSE');
  sm.transition('STOP');
  assert.equal(sm.state, 'STOPPED' as ShadowState);
});

test('SM: PAUSED + FAIL → FAILED', () => {
  const sm = activateMachine();
  sm.transition('PAUSE');
  sm.transition('FAIL');
  assert.equal(sm.state, 'FAILED' as ShadowState);
});

// RECOVERY_REQUIRED
test('SM: RECOVERY_REQUIRED + BEGIN_PRECHECK → PRECHECKED', () => {
  const sm = activateMachine();
  sm.transition('RECOVERY_REQUIRED');
  sm.transition('BEGIN_PRECHECK');
  assert.equal(sm.state, 'PRECHECKED' as ShadowState);
});

test('SM: RECOVERY_REQUIRED + STOP → STOPPED', () => {
  const sm = activateMachine();
  sm.transition('RECOVERY_REQUIRED');
  sm.transition('STOP');
  assert.equal(sm.state, 'STOPPED' as ShadowState);
});

test('SM: RECOVERY_REQUIRED + FAIL → FAILED', () => {
  const sm = activateMachine();
  sm.transition('RECOVERY_REQUIRED');
  sm.transition('FAIL');
  assert.equal(sm.state, 'FAILED' as ShadowState);
});

// ─── STOPPED is restartable ──────────────────────────────────────────────────

test('SM: STOPPED is restartable (full cycle)', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('STOP');
  assert.equal(sm.state, 'STOPPED' as ShadowState);
  // Can restart
  sm.transition('BEGIN_PRECHECK');
  assert.equal(sm.state, 'PRECHECKED' as ShadowState);
});

// ─── FAILED is terminal ──────────────────────────────────────────────────────

test('SM: FAILED terminal — every event throws', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('FAIL');
  assert.equal(sm.state, 'FAILED' as ShadowState);

  for (const event of ['BEGIN_PRECHECK', 'PRECHECK_PASSED', 'PRECHECK_FAILED',
    'ACTIVATE', 'PAUSE', 'RESUME', 'RECOVERY_REQUIRED', 'STOP', 'FAIL']) {
    assert.throws(() => sm.transition(event as any));
    assert.equal(sm.state, 'FAILED' as ShadowState); // state unchanged
  }
});

// ─── Invalid transitions for every state ────────────────────────────────────

function invalidTransitionsFor(state: ShadowState, event: string) {
  test(`SM: invalid — ${state} rejects ${event}`, () => {
    const sm = new ShadowRuntimeStateMachine();
    navigateTo(sm, state);
    assert.throws(() => sm.transition(event as any));
  });
}

// STOPPED invalid events
for (const e of ['PRECHECK_PASSED', 'PRECHECK_FAILED', 'ACTIVATE', 'PAUSE', 'RESUME', 'RECOVERY_REQUIRED', 'STOP']) {
  invalidTransitionsFor('STOPPED', e);
}

// PRECHECKED invalid events
for (const e of ['BEGIN_PRECHECK', 'ACTIVATE', 'PAUSE', 'RESUME', 'FAIL']) {
  invalidTransitionsFor('PRECHECKED', e);
}

// SHADOW_READY invalid events
for (const e of ['BEGIN_PRECHECK', 'PRECHECK_PASSED', 'PRECHECK_FAILED', 'PAUSE', 'RESUME']) {
  invalidTransitionsFor('SHADOW_READY', e);
}

// SHADOW_ACTIVE invalid events
for (const e of ['BEGIN_PRECHECK', 'PRECHECK_PASSED', 'PRECHECK_FAILED', 'ACTIVATE', 'RESUME']) {
  invalidTransitionsFor('SHADOW_ACTIVE', e);
}

// PAUSED invalid events
for (const e of ['BEGIN_PRECHECK', 'PRECHECK_PASSED', 'PRECHECK_FAILED', 'ACTIVATE', 'PAUSE']) {
  invalidTransitionsFor('PAUSED', e);
}

// RECOVERY_REQUIRED invalid events
for (const e of ['PRECHECK_PASSED', 'PRECHECK_FAILED', 'ACTIVATE', 'PAUSE', 'RESUME', 'RECOVERY_REQUIRED']) {
  invalidTransitionsFor('RECOVERY_REQUIRED', e);
}

// FAILED — already covered above

// ─── 4B4.2 new transitions ──────────────────────────────────────────────────

test('SM: PRECHECKED + RECOVERY_REQUIRED → RECOVERY_REQUIRED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('RECOVERY_REQUIRED');
  assert.equal(sm.state, 'RECOVERY_REQUIRED' as ShadowState);
});

test('SM: SHADOW_READY + RECOVERY_REQUIRED → RECOVERY_REQUIRED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('RECOVERY_REQUIRED');
  assert.equal(sm.state, 'RECOVERY_REQUIRED' as ShadowState);
});

// RECOVERY_REQUIRED still restartable after new entry paths
test('SM: RECOVERY_REQUIRED from PRECHECKED is restartable via BEGIN_PRECHECK', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('RECOVERY_REQUIRED');
  assert.equal(sm.state, 'RECOVERY_REQUIRED');
  sm.transition('BEGIN_PRECHECK');
  assert.equal(sm.state, 'PRECHECKED');
});

// ─── canTransition ───────────────────────────────────────────────────────────

test('SM: canTransition returns true for valid transitions', () => {
  const sm = new ShadowRuntimeStateMachine();
  assert.equal(sm.canTransition('BEGIN_PRECHECK'), true);
  assert.equal(sm.canTransition('FAIL'), true);
  assert.equal(sm.canTransition('ACTIVATE'), false);
});

test('SM: canTransition returns false for invalid transitions', () => {
  const sm = activateMachine();
  assert.equal(sm.canTransition('ACTIVATE'), false); // already active
  assert.equal(sm.canTransition('PAUSE'), true);
});

// ─── State is immutable from outside ─────────────────────────────────────────

test('SM: state is readonly', () => {
  const sm = new ShadowRuntimeStateMachine();
  const s = sm.state;
  assert.equal(s, 'STOPPED');
  // Verify state cannot be overwritten via property access
  try {
    (sm as any).state = 'FAILED';
  } catch {
    // Expected: strict mode should throw on getter-only property assignment
  }
  // Regardless of throw, state should not be modifiable
  assert.equal(sm.state, 'STOPPED');
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function activateMachine(): ShadowRuntimeStateMachine {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('ACTIVATE');
  return sm;
}

function navigateTo(sm: ShadowRuntimeStateMachine, target: ShadowState) {
  const state = sm.state as ShadowState;
  if (state === target) return;

  // STOPPED → ...
  if (state === 'STOPPED') {
    if (target === 'FAILED') { sm.transition('FAIL'); return; }
    sm.transition('BEGIN_PRECHECK'); // → PRECHECKED
    return navigateTo(sm, target);
  }

  // PRECHECKED → ...
  if (state === 'PRECHECKED') {
    if (target === 'FAILED') { sm.transition('PRECHECK_FAILED'); return; }
    if (target === 'STOPPED') { sm.transition('STOP'); return; }
    sm.transition('PRECHECK_PASSED'); // → SHADOW_READY
    return navigateTo(sm, target);
  }

  // SHADOW_READY → ...
  if (state === 'SHADOW_READY') {
    if (target === 'FAILED') { sm.transition('FAIL'); return; }
    if (target === 'STOPPED') { sm.transition('STOP'); return; }
    sm.transition('ACTIVATE'); // → SHADOW_ACTIVE
    return navigateTo(sm, target);
  }

  // SHADOW_ACTIVE → ...
  if (state === 'SHADOW_ACTIVE') {
    sm.transition('PAUSE'); // → PAUSED
    return navigateTo(sm, target);
  }

  // PAUSED → ...
  if (state === 'PAUSED') {
    if (target === 'RECOVERY_REQUIRED') { sm.transition('RECOVERY_REQUIRED'); return; }
    if (target === 'STOPPED') { sm.transition('STOP'); return; }
    if (target === 'FAILED') { sm.transition('FAIL'); return; }
    sm.transition('RESUME'); // → SHADOW_READY
    return navigateTo(sm, target);
  }

  // RECOVERY_REQUIRED → ...
  if (state === 'RECOVERY_REQUIRED') {
    sm.transition('BEGIN_PRECHECK'); // → PRECHECKED
    return navigateTo(sm, target);
  }
}
