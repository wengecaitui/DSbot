/**
 * ShadowRuntimeStateMachine — 7-state FSM for shadow execution lifecycle.
 *
 * States: STOPPED (initial, restartable), PRECHECKED, SHADOW_READY,
 *         SHADOW_ACTIVE, PAUSED, RECOVERY_REQUIRED, FAILED (terminal).
 */
export type ShadowState =
  | 'STOPPED'
  | 'PRECHECKED'
  | 'SHADOW_READY'
  | 'SHADOW_ACTIVE'
  | 'PAUSED'
  | 'RECOVERY_REQUIRED'
  | 'FAILED';

export type ShadowStateEvent =
  | 'BEGIN_PRECHECK'
  | 'PRECHECK_PASSED'
  | 'PRECHECK_FAILED'
  | 'ACTIVATE'
  | 'PAUSE'
  | 'RESUME'
  | 'RECOVERY_REQUIRED'
  | 'STOP'
  | 'FAIL';

// ─── Transition table ────────────────────────────────────────────────────────

// Map<fromState, Map<event, toState>>
const TRANSITIONS = new Map<ShadowState, Map<ShadowStateEvent, ShadowState>>();

function add(from: ShadowState, event: ShadowStateEvent, to: ShadowState) {
  if (!TRANSITIONS.has(from)) TRANSITIONS.set(from, new Map());
  TRANSITIONS.get(from)!.set(event, to);
}

// STOPPED
add('STOPPED', 'BEGIN_PRECHECK', 'PRECHECKED');
add('STOPPED', 'FAIL', 'FAILED');

// PRECHECKED
add('PRECHECKED', 'PRECHECK_PASSED', 'SHADOW_READY');
add('PRECHECKED', 'PRECHECK_FAILED', 'FAILED');
add('PRECHECKED', 'STOP', 'STOPPED');

// SHADOW_READY
add('SHADOW_READY', 'ACTIVATE', 'SHADOW_ACTIVE');
add('SHADOW_READY', 'STOP', 'STOPPED');
add('SHADOW_READY', 'FAIL', 'FAILED');

// SHADOW_ACTIVE
add('SHADOW_ACTIVE', 'PAUSE', 'PAUSED');
add('SHADOW_ACTIVE', 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
add('SHADOW_ACTIVE', 'STOP', 'STOPPED');
add('SHADOW_ACTIVE', 'FAIL', 'FAILED');

// PAUSED
add('PAUSED', 'RESUME', 'SHADOW_READY');
add('PAUSED', 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
add('PAUSED', 'STOP', 'STOPPED');
add('PAUSED', 'FAIL', 'FAILED');

// RECOVERY_REQUIRED
add('RECOVERY_REQUIRED', 'BEGIN_PRECHECK', 'PRECHECKED');
add('RECOVERY_REQUIRED', 'STOP', 'STOPPED');
add('RECOVERY_REQUIRED', 'FAIL', 'FAILED');

// FAILED — terminal, no outgoing transitions

// ─── Class ────────────────────────────────────────────────────────────────────

export class ShadowRuntimeStateMachine {
  private _state: ShadowState = 'STOPPED';

  get state(): ShadowState {
    return this._state;
  }

  canTransition(event: ShadowStateEvent): boolean {
    const stateTransitions = TRANSITIONS.get(this._state);
    if (!stateTransitions) return false;
    return stateTransitions.has(event);
  }

  transition(event: ShadowStateEvent): void {
    const stateTransitions = TRANSITIONS.get(this._state);
    if (!stateTransitions) {
      throw new Error(
        `ShadowRuntimeStateMachine: no transitions from state ${this._state}`,
      );
    }

    const next = stateTransitions.get(event);
    if (!next) {
      throw new Error(
        `ShadowRuntimeStateMachine: invalid transition ${event} from state ${this._state}`,
      );
    }

    this._state = next;
  }
}
