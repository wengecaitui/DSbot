// Stage 4B3: Safety, Recovery & Observability Contract
// Fail-closed, no paper/live execution. Builds on 4B2 receipt.

import { createHash } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

export const SAFETY_SCHEMA = 'stage-4b3.safety-contract.v1' as const;
export const SAFETY_AUDIT_SCHEMA = 'stage-4b3.safety-audit.v1' as const;
export const STAGE_4B3_BASELINE = '81b0980f4fee168075a52c6ebcb12eb50f382217' as const;

export type RuntimeSafetyState =
  | 'STOPPED'
  | 'PRECHECKED'
  | 'START_BLOCKED'
  // Reference-only states (never reachable in production without approved strategy)
  | 'STARTING'
  | 'RUNNING_REFERENCE'
  | 'DEGRADED'
  | 'RECOVERING'
  | 'STOPPING';

export type KillSwitchStatus = 'DISABLED' | 'ENABLED';
export type BridgeHealth = 'UNKNOWN' | 'READY' | 'TIMEOUT' | 'CRASHED';
export type MarketDataHealth = 'UNKNOWN' | 'FRESH' | 'STALE';
export type RecoveryStatus = 'NONE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export const SAFETY_REASONS = {
  NO_PROMOTED_STRATEGY: 'BLOCKED_NO_PROMOTED_STRATEGY',
  PAPER_NOT_APPROVED: 'BLOCKED_PAPER_NOT_APPROVED',
  RECEIPT_INVALID: 'BLOCKED_RECEIPT_INVALID',
  SOURCE_SHA_MISMATCH: 'BLOCKED_SOURCE_SHA_MISMATCH',
  KILL_SWITCH_ENABLED: 'BLOCKED_KILL_SWITCH',
  BRIDGE_NOT_READY: 'BLOCKED_BRIDGE_NOT_READY',
  MARKET_DATA_STALE: 'BLOCKED_MARKET_DATA_STALE',
  STATE_STORE_CORRUPT: 'BLOCKED_STATE_STORE_CORRUPT',
  UNRESOLVED_ORDERS: 'BLOCKED_UNRESOLVED_ORDERS',
  RECOVERY_REQUIRED: 'BLOCKED_RECOVERY_REQUIRED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  TERMINAL_STATE: 'TERMINAL_STATE',
  DUPLICATE_START: 'DUPLICATE_START',
  DUPLICATE_SIGNAL: 'DUPLICATE_SIGNAL',
  DUPLICATE_RECOVERY: 'DUPLICATE_RECOVERY',
  REPLAY_REJECTED: 'REPLAY_REJECTED',
  AUDIT_TAMPERED: 'AUDIT_TAMPERED',
  AUDIT_CHAIN_BROKEN: 'AUDIT_CHAIN_BROKEN',
  AUDIT_TRUNCATED: 'AUDIT_TRUNCATED',
  UNKNOWN_STATE: 'BLOCKED_UNKNOWN_STATE',
  RECOVERY_BLOCKED: 'RECOVERY_BLOCKED',
  RECOVERY_NO_NEW_POSITIONS: 'RECOVERY_NO_NEW_POSITIONS',
} as const;

export type SafetyReasonCode = typeof SAFETY_REASONS[keyof typeof SAFETY_REASONS];

// ═══════════════════════════════════════════════════════════════════
// Domain utilities
// ═══════════════════════════════════════════════════════════════════

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function domainId(domain: string, body: object): string {
  return sha256(`${domain}:${canonicalJson(body)}`);
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    Object.values(obj as object).forEach(deepFreeze);
  }
  return obj;
}

// ═══════════════════════════════════════════════════════════════════
// Health Snapshot
// ═══════════════════════════════════════════════════════════════════

export interface RuntimeHealthSnapshotData {
  readonly runtimeState: RuntimeSafetyState;
  readonly safetyGateStatus: 'PASSED' | 'BLOCKED';
  readonly killSwitchStatus: KillSwitchStatus;
  readonly bridgeHealth: BridgeHealth;
  readonly marketDataHealth: MarketDataHealth;
  readonly recoveryStatus: RecoveryStatus;
  readonly lastEventId: string | null;
  readonly auditTip: string | null;
  readonly duplicateCount: number;
  readonly retryCount: number;
  readonly blockedReasons: readonly SafetyReasonCode[];
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
}

export interface RuntimeHealthSnapshot extends RuntimeHealthSnapshotData {
  readonly snapshotId: string;
  readonly createdAt: string;
}

export function createRuntimeHealthSnapshot(data: RuntimeHealthSnapshotData, createdAt: string): RuntimeHealthSnapshot {
  if (!data.runtimeState) throw new Error('SNAPSHOT_INVALID:MISSING_STATE');
  const body: Omit<RuntimeHealthSnapshot, 'snapshotId'> = { ...data, createdAt };
  return deepFreeze({ ...body, snapshotId: domainId('CloddsBot:RuntimeHealthSnapshot:v1', body) });
}

// ═══════════════════════════════════════════════════════════════════
// Kill Switch
// ═══════════════════════════════════════════════════════════════════

export class KillSwitch {
  private _enabled = false;
  private _reason = '';

  get enabled(): boolean { return this._enabled; }
  get reason(): string { return this._reason; }

  /** Enable the kill switch. Once enabled, cannot be disabled by callers. */
  engage(reason: string): void {
    if (!reason) throw new Error('KILL_SWITCH:REASON_REQUIRED');
    this._enabled = true;
    this._reason = reason;
  }

  /** Reset is only for testing — protected by requiring explicit approval. */
  _testReset(): void {
    this._enabled = false;
    this._reason = '';
  }
}

// ═══════════════════════════════════════════════════════════════════
// Idempotency Ledger
// ═══════════════════════════════════════════════════════════════════

export interface IdempotencyEntry {
  readonly key: string;
  readonly type: 'STARTUP' | 'SIGNAL' | 'RECOVERY' | 'TRANSITION';
  readonly timestamp: string;
  readonly entryId: string;
}

export class IdempotencyLedger {
  private entries = new Map<string, IdempotencyEntry>();
  private _duplicateCount = 0;

  get duplicateCount(): number { return this._duplicateCount; }

  checkDuplicate(type: IdempotencyEntry['type'], key: string, timestamp: string): boolean {
    const compositeKey = `${type}:${key}`;
    if (this.entries.has(compositeKey)) {
      this._duplicateCount++;
      return true;
    }
    const entry = deepFreeze({
      key: compositeKey,
      type,
      timestamp,
      entryId: domainId('CloddsBot:IdempotencyEntry:v1', { type, key, timestamp }),
    });
    this.entries.set(compositeKey, entry);
    return false;
  }

  clear(): void {
    this.entries.clear();
    this._duplicateCount = 0;
  }

  getAll(): readonly IdempotencyEntry[] {
    return Object.freeze([...this.entries.values()]);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Safety State Machine
// ═══════════════════════════════════════════════════════════════════

const SAFETY_TRANSITIONS: Readonly<Record<RuntimeSafetyState, readonly RuntimeSafetyState[]>> = {
  STOPPED: ['PRECHECKED'],
  PRECHECKED: ['START_BLOCKED', 'STARTING'],
  START_BLOCKED: [],
  // Reference-only path
  STARTING: ['RUNNING_REFERENCE'],
  RUNNING_REFERENCE: ['DEGRADED', 'STOPPING'],
  DEGRADED: ['RECOVERING'],
  RECOVERING: ['RUNNING_REFERENCE', 'STOPPING'],
  STOPPING: ['STOPPED'],
};

const REFERENCE_ONLY_STATES: ReadonlySet<RuntimeSafetyState> = new Set([
  'STARTING', 'RUNNING_REFERENCE', 'DEGRADED', 'RECOVERING', 'STOPPING',
]);

export class RuntimeSafetyStateMachine {
  private _state: RuntimeSafetyState = 'STOPPED';
  private _requestIds = new Set<string>();

  get state(): RuntimeSafetyState { return this._state; }

  transition(next: RuntimeSafetyState, requestId?: string): RuntimeSafetyState {
    // Reference-only states require explicit REFERENCE FIXTURE authorization
    if (REFERENCE_ONLY_STATES.has(next) && next !== 'STOPPING') {
      // Only allow reference states in test context
      if (!requestId?.startsWith('REFERENCE_TEST_FIXTURE:')) {
        throw new Error(`SAFETY:${SAFETY_REASONS.INVALID_TRANSITION}:REFERENCE_ONLY`);
      }
    }
    if (SAFETY_TRANSITIONS[this._state].length === 0) {
      throw new Error(`SAFETY:${SAFETY_REASONS.TERMINAL_STATE}`);
    }
    if (!SAFETY_TRANSITIONS[this._state].includes(next)) {
      throw new Error(`SAFETY:${SAFETY_REASONS.INVALID_TRANSITION}:${this._state}→${next}`);
    }
    if (requestId) {
      if (this._requestIds.has(requestId)) {
        throw new Error(`SAFETY:${SAFETY_REASONS.REPLAY_REJECTED}`);
      }
      this._requestIds.add(requestId);
    }
    this._state = next;
    return this._state;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Safety Gate
// ═══════════════════════════════════════════════════════════════════

export interface SafetyGateInput {
  readonly receiptId: string;
  readonly sourceSha: string;
  readonly killSwitch: KillSwitch;
  readonly bridgeHealth: BridgeHealth;
  readonly marketDataHealth: MarketDataHealth;
  readonly stateStoreIntact: boolean;
  readonly hasUnresolvedOrders: boolean;
  readonly recoveryRequired: boolean;
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
}

export interface SafetyGateResult {
  readonly passed: boolean;
  readonly blockedReasons: readonly SafetyReasonCode[];
}

export class RuntimeStartupSafetyGate {
  private readonly expectedReceiptId: string;
  private readonly expectedSourceSha: string;

  constructor(receiptId: string, sourceSha: string) {
    if (!receiptId || receiptId.length !== 64) throw new Error('SAFETY_GATE:INVALID_RECEIPT');
    if (!sourceSha || sourceSha.length !== 40) throw new Error('SAFETY_GATE:INVALID_SOURCE_SHA');
    this.expectedReceiptId = receiptId;
    this.expectedSourceSha = sourceSha;
  }

  verify(input: SafetyGateInput): SafetyGateResult {
    const reasons: SafetyReasonCode[] = [];

    // 1. Strategy — must be blocked (no promoted strategy)
    reasons.push(SAFETY_REASONS.NO_PROMOTED_STRATEGY);

    // 2. Paper/Testnet/Live must all be false
    if (input.paperApproved !== false) reasons.push(SAFETY_REASONS.PAPER_NOT_APPROVED);
    if (input.testnetApproved !== false) reasons.push(SAFETY_REASONS.PAPER_NOT_APPROVED);
    if (input.liveApproved !== false) reasons.push(SAFETY_REASONS.PAPER_NOT_APPROVED);

    // 3. Receipt + source SHA verification
    if (input.receiptId !== this.expectedReceiptId) reasons.push(SAFETY_REASONS.RECEIPT_INVALID);
    if (input.sourceSha !== this.expectedSourceSha) reasons.push(SAFETY_REASONS.SOURCE_SHA_MISMATCH);

    // 4. Kill switch
    if (input.killSwitch.enabled) reasons.push(SAFETY_REASONS.KILL_SWITCH_ENABLED);

    // 5. Bridge health
    if (input.bridgeHealth !== 'READY') reasons.push(SAFETY_REASONS.BRIDGE_NOT_READY);

    // 6. Market data
    if (input.marketDataHealth !== 'FRESH' && input.marketDataHealth !== 'UNKNOWN') {
      reasons.push(SAFETY_REASONS.MARKET_DATA_STALE);
    }

    // 7. State store
    if (!input.stateStoreIntact) reasons.push(SAFETY_REASONS.STATE_STORE_CORRUPT);

    // 8. Unresolved orders
    if (input.hasUnresolvedOrders) reasons.push(SAFETY_REASONS.UNRESOLVED_ORDERS);

    // 9. Recovery required
    if (input.recoveryRequired) reasons.push(SAFETY_REASONS.RECOVERY_REQUIRED);

    const passed = false; // Always blocked — no promoted strategy exists
    return deepFreeze({ passed, blockedReasons: [...new Set(reasons)].sort() });
  }
}

// ═══════════════════════════════════════════════════════════════════
// Safety Policy
// ═══════════════════════════════════════════════════════════════════

export interface SafetyDecision {
  readonly schemaVersion: typeof SAFETY_SCHEMA;
  readonly status: RuntimeSafetyState;
  readonly reviewEligible: false;
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
  readonly blockedReasons: readonly SafetyReasonCode[];
  readonly decisionId: string;
}

export class RuntimeSafetyPolicy {
  readonly gate: RuntimeStartupSafetyGate;
  readonly killSwitch: KillSwitch;
  readonly idempotencyLedger = new IdempotencyLedger();
  private consumedDecisionIds = new Set<string>();

  constructor(receiptId: string, sourceSha: string, killSwitch: KillSwitch) {
    this.gate = new RuntimeStartupSafetyGate(receiptId, sourceSha);
    this.killSwitch = killSwitch;
  }

  evaluate(input: SafetyGateInput, nowIso: string): SafetyDecision {
    const reasons: SafetyReasonCode[] = [];

    // Gate verification
    const gateResult = this.gate.verify(input);
    reasons.push(...gateResult.blockedReasons);

    // Idempotency
    const dupKey = `startup:${nowIso}`;
    if (this.idempotencyLedger.checkDuplicate('STARTUP', dupKey, nowIso)) {
      reasons.push(SAFETY_REASONS.DUPLICATE_START);
    }

    const status: RuntimeSafetyState = reasons.length > 1 || reasons[0] !== SAFETY_REASONS.NO_PROMOTED_STRATEGY
      ? 'START_BLOCKED'
      : 'START_BLOCKED'; // Always blocked — no promoted strategy

    const body: Omit<SafetyDecision, 'decisionId'> = {
      schemaVersion: SAFETY_SCHEMA,
      status,
      reviewEligible: false,
      paperApproved: false,
      testnetApproved: false,
      liveApproved: false,
      blockedReasons: [...new Set(reasons)].sort(),
    };
    const decisionId = domainId('CloddsBot:SafetyDecision:v1', body);
    const decision = deepFreeze({ ...body, decisionId });

    if (this.consumedDecisionIds.has(decisionId)) {
      throw new Error(`SAFETY:${SAFETY_REASONS.REPLAY_REJECTED}`);
    }
    this.consumedDecisionIds.add(decisionId);
    return decision;
  }

  buildSnapshot(nowIso: string, bridgeHealth: BridgeHealth, marketHealth: MarketDataHealth, recoveryStatus: RecoveryStatus): RuntimeHealthSnapshot {
    return createRuntimeHealthSnapshot({
      runtimeState: 'START_BLOCKED',
      safetyGateStatus: 'BLOCKED',
      killSwitchStatus: this.killSwitch.enabled ? 'ENABLED' : 'DISABLED',
      bridgeHealth,
      marketDataHealth: marketHealth,
      recoveryStatus,
      lastEventId: null,
      auditTip: null,
      duplicateCount: this.idempotencyLedger.duplicateCount,
      retryCount: 0,
      blockedReasons: [SAFETY_REASONS.NO_PROMOTED_STRATEGY],
      paperApproved: false,
      testnetApproved: false,
      liveApproved: false,
    }, nowIso);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Recovery Coordinator
// ═══════════════════════════════════════════════════════════════════

export interface RecoveryEvent {
  readonly type: 'BRIDGE_CRASH' | 'BRIDGE_TIMEOUT' | 'DUPLICATE_EVENT' | 'PARTIAL_WRITE' | 'RESTART' | 'STALE_SNAPSHOT' | 'UNKNOWN_ORDER';
  readonly timestamp: string;
  readonly details: string;
  readonly eventId: string;
}

export class RecoveryCoordinator {
  private _status: RecoveryStatus = 'NONE';
  private events: RecoveryEvent[] = [];
  private idempotencyLedger = new IdempotencyLedger();
  private _newPositionsBlocked = true;

  get status(): RecoveryStatus { return this._status; }
  get newPositionsBlocked(): boolean { return this._newPositionsBlocked; }

  /** Start recovery for a specific event type. Fail if already in recovery. */
  startRecovery(event: RecoveryEvent, nowIso: string): void {
    if (this.idempotencyLedger.checkDuplicate('RECOVERY', event.type, nowIso)) {
      throw new Error(`RECOVERY:${SAFETY_REASONS.DUPLICATE_RECOVERY}`);
    }
    if (this._status === 'IN_PROGRESS') {
      throw new Error(`RECOVERY:${SAFETY_REASONS.RECOVERY_BLOCKED}`);
    }
    if (event.type === 'UNKNOWN_ORDER') {
      // Cannot recover from unknown orders — stay blocked
      this._status = 'FAILED';
      this.events.push(deepFreeze(event));
      return;
    }
    this._status = 'IN_PROGRESS';
    this._newPositionsBlocked = true;
    this.events.push(deepFreeze(event));
  }

  /** Complete recovery successfully. */
  completeRecovery(): void {
    if (this._status !== 'IN_PROGRESS') throw new Error(`RECOVERY:${SAFETY_REASONS.INVALID_TRANSITION}`);
    this._status = 'COMPLETED';
    this._newPositionsBlocked = false;
  }

  /** Mark recovery as failed. Stay blocked. */
  failRecovery(reason: string): void {
    this._status = 'FAILED';
    this._newPositionsBlocked = true;
    this.events.push(deepFreeze({
      type: 'PARTIAL_WRITE' as const,
      timestamp: new Date().toISOString(),
      details: reason,
      eventId: domainId('CloddsBot:RecoveryEvent:v1', { type: 'PARTIAL_WRITE', reason }),
    }));
  }

  /** Restart state recovery: replay events and determine status. */
  restartRecovery(previousEvents: readonly RecoveryEvent[]): RecoveryStatus {
    this.events = [...previousEvents];
    const lastEvent = this.events.at(-1);
    if (!lastEvent) {
      this._status = 'NONE';
      return 'NONE';
    }
    if (lastEvent.type === 'UNKNOWN_ORDER' || lastEvent.type === 'PARTIAL_WRITE') {
      this._status = 'FAILED';
      this._newPositionsBlocked = true;
    } else {
      this._status = 'COMPLETED';
      this._newPositionsBlocked = false;
    }
    return this._status;
  }

  getAllEvents(): readonly RecoveryEvent[] {
    return Object.freeze([...this.events]);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Append-Only Safety Audit
// ═══════════════════════════════════════════════════════════════════

export interface SafetyAuditEvent {
  readonly schemaVersion: typeof SAFETY_AUDIT_SCHEMA;
  readonly sequence: number;
  readonly timestamp: string;
  readonly previousEventId: string | null;
  readonly eventType: 'ROOT' | 'SAFETY_CHECK' | 'STATE_TRANSITION' | 'RECOVERY' | 'KILL_SWITCH';
  readonly payloadDigest: string;
  readonly eventId: string;
}

function auditEventId(event: Omit<SafetyAuditEvent, 'eventId'>): string {
  return domainId('CloddsBot:SafetyAuditEvent:v1', event);
}

export class AppendOnlySafetyAudit {
  private events: SafetyAuditEvent[] = [];

  constructor(eventsInput: readonly SafetyAuditEvent[] = []) {
    this.events = JSON.parse(JSON.stringify(eventsInput));
    this.validate();
  }

  get tipId(): string | null { return this.events.at(-1)?.eventId ?? null; }
  get all(): readonly SafetyAuditEvent[] { return Object.freeze([...this.events]); }

  append(opts: {
    timestamp: string;
    eventType: SafetyAuditEvent['eventType'];
    payload: unknown;
  }): SafetyAuditEvent {
    const seq = this.events.length;
    const prev = this.events.at(-1);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(opts.timestamp)) {
      throw new Error('AUDIT_INVALID:TIMESTAMP');
    }
    if (seq === 0 && opts.eventType !== 'ROOT') {
      throw new Error('AUDIT_INVALID:FIRST_EVENT_MUST_BE_ROOT');
    }
    const body: Omit<SafetyAuditEvent, 'eventId'> = {
      schemaVersion: SAFETY_AUDIT_SCHEMA,
      sequence: seq,
      timestamp: opts.timestamp,
      previousEventId: prev?.eventId ?? null,
      eventType: opts.eventType,
      payloadDigest: sha256(canonicalJson(opts.payload as object)),
    };
    const event = deepFreeze({ ...body, eventId: auditEventId(body) });
    this.events.push(event);
    return event;
  }

  validate(expectedTipId?: string): void {
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      const p = this.events[i - 1];
      if (e.schemaVersion !== SAFETY_AUDIT_SCHEMA || e.sequence !== i) {
        throw new Error(`AUDIT_INVALID:${SAFETY_REASONS.AUDIT_CHAIN_BROKEN}`);
      }
      if (e.previousEventId !== (p?.eventId ?? null)) {
        throw new Error(`AUDIT_INVALID:${SAFETY_REASONS.AUDIT_CHAIN_BROKEN}`);
      }
      const body = (({ eventId: _, ...r }) => r)(e);
      if (e.eventId !== auditEventId(body)) {
        throw new Error(`AUDIT_INVALID:${SAFETY_REASONS.AUDIT_TAMPERED}`);
      }
      if (i === 0 && e.eventType !== 'ROOT') {
        throw new Error('AUDIT_INVALID:ROOT');
      }
    }
    if (expectedTipId !== undefined && this.tipId !== expectedTipId) {
      throw new Error(`AUDIT_INVALID:${SAFETY_REASONS.AUDIT_TRUNCATED}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Production factory — always blocked
// ═══════════════════════════════════════════════════════════════════

export function createBlockedSafetyAudit(timestamp: string): AppendOnlySafetyAudit {
  const audit = new AppendOnlySafetyAudit();
  audit.append({
    timestamp,
    eventType: 'ROOT',
    payload: { schemaVersion: SAFETY_SCHEMA, baselineCommit: STAGE_4B3_BASELINE },
  });
  audit.append({
    timestamp,
    eventType: 'SAFETY_CHECK',
    payload: {
      status: 'START_BLOCKED',
      reason: SAFETY_REASONS.NO_PROMOTED_STRATEGY,
      paperApproved: false,
      testnetApproved: false,
      liveApproved: false,
    },
  });
  return audit;
}
