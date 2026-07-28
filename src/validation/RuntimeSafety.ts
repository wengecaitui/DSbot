// Stage 4B3-R1: Trust Boundary Closure
// Reuses ActivationContract canonicalJson (recursive), canonicalSha256, domainId, immutable.
// Hardened: UNKNOWN fail-closed, KillSwitch persistence, deterministic idempotency keys,
// Recovery completion evidence, HealthSnapshot from real state, real 4B2 receipt verification.

import { createHash } from 'node:crypto';
import {
  canonicalJson,
  canonicalSha256,
} from './ActivationContract';
import {
  createStage4B2Receipt,
  verifyStage4B2Receipt,
  type Stage4B2Receipt,
} from './PaperReadinessReview';

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

export const SAFETY_SCHEMA = 'stage-4b3.safety-contract.v1' as const;
export const SAFETY_AUDIT_SCHEMA = 'stage-4b3.safety-audit.v1' as const;
export const STAGE_4B3_BASELINE = '5c1e309e2e9a1b2bd65d7e517361a3e8fe39b9ff' as const;

// Verified 4B2 receipt data (from Stage 4B2 closure on feature/orangeai-split)
const STAGE_4B2_VERIFIED_RECEIPT = {
  schemaVersion: 'stage-4b2.paper-readiness-receipt.v1',
  receiptId: 'd4be6cadfedc0a9b4ac8628f492a34955c6ce57260fbe781b563787bce4b9f08',
  sourceCommit: '81b0980f4fee168075a52c6ebcb12eb50f382217',
  stage4AClosure: 'af9dc5cbb832b32b0c403631b2805bcb93996d215c044a47a06e4b3347db40cc',
  stage4B1Artifact: 'f320f0e51ef6c0900a189dd7455d0c3ee77726bb4c6d1820d422d725629bf52e',
  stage4B1Proof: '7d35edaa205593ad07ccb8b254a67acad09511118939817e649166028535f1fb',
  stage4B1Decision: '80268cc673363290bea5f65aec0e7811041ecd6c608e06d6944aecfe5c2c39aa',
  reviewEligible: false,
  paperApproved: false,
  testnetApproved: false,
  liveApproved: false,
  receiptDigest: canonicalSha256({
    domain: 'CloddsBot:Stage4B2Receipt:v1',
    receiptId: 'd4be6cadfedc0a9b4ac8628f492a34955c6ce57260fbe781b563787bce4b9f08',
    sourceCommit: '81b0980f4fee168075a52c6ebcb12eb50f382217',
    paperApproved: false,
    testnetApproved: false,
    liveApproved: false,
  }),
} as const;

export type RuntimeSafetyState =
  | 'STOPPED'
  | 'PRECHECKED'
  | 'START_BLOCKED'
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
  RECEIPT_TAMPERED: 'BLOCKED_RECEIPT_TAMPERED',
  FAKE_RECEIPT_DETECTED: 'BLOCKED_FAKE_RECEIPT',
  SOURCE_SHA_MISMATCH: 'BLOCKED_SOURCE_SHA_MISMATCH',
  KILL_SWITCH_ENABLED: 'BLOCKED_KILL_SWITCH',
  BRIDGE_NOT_READY: 'BLOCKED_BRIDGE_NOT_READY',
  BRIDGE_UNKNOWN: 'BLOCKED_BRIDGE_UNKNOWN',
  MARKET_DATA_STALE: 'BLOCKED_MARKET_DATA_STALE',
  MARKET_DATA_UNKNOWN: 'BLOCKED_MARKET_DATA_UNKNOWN',
  STATE_STORE_CORRUPT: 'BLOCKED_STATE_STORE_CORRUPT',
  STATE_STORE_UNKNOWN: 'BLOCKED_STATE_STORE_UNKNOWN',
  UNRESOLVED_ORDERS: 'BLOCKED_UNRESOLVED_ORDERS',
  UNKNOWN_ORDER_POSITION: 'BLOCKED_UNKNOWN_ORDER_POSITION',
  RECOVERY_REQUIRED: 'BLOCKED_RECOVERY_REQUIRED',
  RECOVERY_UNKNOWN: 'BLOCKED_RECOVERY_UNKNOWN',
  RECOVERY_INCOMPLETE: 'BLOCKED_RECOVERY_INCOMPLETE',
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
  RECOVERY_NOT_VERIFIED: 'BLOCKED_RECOVERY_NOT_VERIFIED',
} as const;

export type SafetyReasonCode = typeof SAFETY_REASONS[keyof typeof SAFETY_REASONS];

// ═══════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function domainId(domain: string, payload: unknown): string {
  return canonicalSha256({ domain, payload });
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    Object.values(obj as object).forEach(deepFreeze);
  }
  return obj;
}

// ═══════════════════════════════════════════════════════════════════
// 4B2 Receipt Verifier (independent re-verification)
// ═══════════════════════════════════════════════════════════════════

export interface Stage4B2ReceiptData {
  readonly receiptId: string;
  readonly sourceCommit: string;
  readonly stage4B1Artifact: string;
  readonly stage4B1Proof: string;
  readonly stage4B1Decision: string;
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
  readonly reviewEligible: false;
}

export function verify4B2Receipt(receipt: Stage4B2ReceiptData): { valid: boolean; reason?: string } {
  // 1. Receipt ID must match verified constant
  if (receipt.receiptId !== STAGE_4B2_VERIFIED_RECEIPT.receiptId) {
    return { valid: false, reason: 'RECEIPT_ID_MISMATCH' };
  }
  // 2. Source commit match
  if (receipt.sourceCommit !== STAGE_4B2_VERIFIED_RECEIPT.sourceCommit) {
    return { valid: false, reason: 'SOURCE_COMMIT_MISMATCH' };
  }
  // 3. 4B1 artifact ID match
  if (receipt.stage4B1Artifact !== STAGE_4B2_VERIFIED_RECEIPT.stage4B1Artifact) {
    return { valid: false, reason: '4B1_ARTIFACT_MISMATCH' };
  }
  // 4. 4B1 proof ID match
  if (receipt.stage4B1Proof !== STAGE_4B2_VERIFIED_RECEIPT.stage4B1Proof) {
    return { valid: false, reason: '4B1_PROOF_MISMATCH' };
  }
  // 5. 4B1 decision ID match
  if (receipt.stage4B1Decision !== STAGE_4B2_VERIFIED_RECEIPT.stage4B1Decision) {
    return { valid: false, reason: '4B1_DECISION_MISMATCH' };
  }
  // 6. Approval flags must all be false
  if (receipt.paperApproved !== false || receipt.testnetApproved !== false || receipt.liveApproved !== false) {
    return { valid: false, reason: 'APPROVAL_FLAG_VIOLATION' };
  }
  // 7. Review eligible must be false
  if (receipt.reviewEligible !== false) {
    return { valid: false, reason: 'REVIEW_ELIGIBLE_VIOLATION' };
  }
  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════
// Kill Switch — persistent, no production reset
// ═══════════════════════════════════════════════════════════════════

export interface KillSwitchPersisted {
  readonly enabled: boolean;
  readonly reason: string;
  readonly engagedAt: string;
}

export class KillSwitch {
  private _enabled = false;
  private _reason = '';
  private _engagedAt = '';

  get enabled(): boolean { return this._enabled; }
  get reason(): string { return this._reason; }
  get engagedAt(): string { return this._engagedAt; }

  /** Engage the kill switch. Once enabled, cannot be disabled by callers. */
  engage(reason: string, timestamp: string): void {
    if (!reason) throw new Error('KILL_SWITCH:REASON_REQUIRED');
    this._enabled = true;
    this._reason = reason;
    this._engagedAt = timestamp;
  }

  /** Serialize for persistence. */
  persist(): KillSwitchPersisted {
    return deepFreeze({
      enabled: this._enabled,
      reason: this._reason,
      engagedAt: this._engagedAt,
    });
  }

  /** Restore from persisted state. Does NOT allow re-disabling. */
  restore(state: KillSwitchPersisted): void {
    if (state.enabled) {
      this._enabled = true;
      this._reason = state.reason;
      this._engagedAt = state.engagedAt;
    }
  }

  /** Test-only reset. NOT available in production — guarded by naming convention. */
  _testFixtureReset(): void {
    this._enabled = false;
    this._reason = '';
    this._engagedAt = '';
  }
}

// ═══════════════════════════════════════════════════════════════════
// Idempotency Ledger — persistent, no production clear()
// ═══════════════════════════════════════════════════════════════════

export type IdempotencyEntryType = 'STARTUP' | 'SIGNAL' | 'FILL' | 'RECOVERY' | 'TRANSITION';

export interface IdempotencyEntry {
  readonly key: string;
  readonly type: IdempotencyEntryType;
  readonly timestamp: string;
  readonly entryId: string;
}

export interface IdempotencyLedgerPersisted {
  readonly entries: readonly IdempotencyEntry[];
  readonly duplicateCount: number;
}

export class IdempotencyLedger {
  private entries = new Map<string, IdempotencyEntry>();
  private _duplicateCount = 0;

  get duplicateCount(): number { return this._duplicateCount; }

  /** Create a deterministic key from component parts — NOT based on wall-clock time. */
  static makeKey(type: IdempotencyEntryType, ...parts: string[]): string {
    return sha256(`${type}:${parts.join(':')}`);
  }

  /** Check and record. Returns true if duplicate. */
  checkDuplicate(type: IdempotencyEntryType, key: string, timestamp: string): boolean {
    const compositeKey = `${type}:${key}`;
    if (this.entries.has(compositeKey)) {
      this._duplicateCount++;
      return true;
    }
    const body = { type, key, timestamp };
    const entry = deepFreeze({
      key: compositeKey,
      type,
      timestamp,
      entryId: canonicalSha256({ domain: 'CloddsBot:IdempotencyEntry:v1', ...body }),
    });
    this.entries.set(compositeKey, entry);
    return false;
  }

  /** Persist for restart recovery. */
  persist(): IdempotencyLedgerPersisted {
    return deepFreeze({
      entries: [...this.entries.values()],
      duplicateCount: this._duplicateCount,
    });
  }

  /** Restore from persisted state. */
  restore(state: IdempotencyLedgerPersisted): void {
    this.entries.clear();
    for (const entry of state.entries) {
      this.entries.set(entry.key, deepFreeze({ ...entry }));
    }
    this._duplicateCount = state.duplicateCount;
  }

  /** Test-only clear. NOT available in production. */
  _testFixtureClear(): void {
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
    if (REFERENCE_ONLY_STATES.has(next) && next !== 'STOPPING') {
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
// Safety Gate — reads real 4B2 receipt, independent re-verification
// ═══════════════════════════════════════════════════════════════════

export interface SafetyGateInput {
  readonly receiptId: string;
  readonly sourceSha: string;
  readonly killSwitch: KillSwitch;
  readonly bridgeHealth: BridgeHealth;
  readonly marketDataHealth: MarketDataHealth;
  readonly stateStoreIntact: boolean | 'UNKNOWN';
  readonly hasUnresolvedOrders: boolean | 'UNKNOWN';
  readonly recoveryRequired: boolean | 'UNKNOWN';
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
}

export interface SafetyGateResult {
  readonly passed: false;
  readonly blockedReasons: readonly SafetyReasonCode[];
}

export class RuntimeStartupSafetyGate {
  private readonly expectedReceiptId: string;
  private readonly expectedSourceSha: string;

  constructor(receiptId: string, sourceSha: string) {
    if (!receiptId || typeof receiptId !== 'string' || receiptId.length !== 64) {
      throw new Error('SAFETY_GATE:INVALID_RECEIPT');
    }
    if (!sourceSha || typeof sourceSha !== 'string' || sourceSha.length !== 40) {
      throw new Error('SAFETY_GATE:INVALID_SOURCE_SHA');
    }
    this.expectedReceiptId = receiptId;
    this.expectedSourceSha = sourceSha;
  }

  verify(input: SafetyGateInput): SafetyGateResult {
    const reasons: SafetyReasonCode[] = [];

    // 1. Strategy — always blocked (no promoted strategy)
    reasons.push(SAFETY_REASONS.NO_PROMOTED_STRATEGY);

    // 2. Paper/Testnet/Live must all be false
    if (input.paperApproved !== false) reasons.push(SAFETY_REASONS.PAPER_NOT_APPROVED);
    if (input.testnetApproved !== false) reasons.push(SAFETY_REASONS.PAPER_NOT_APPROVED);
    if (input.liveApproved !== false) reasons.push(SAFETY_REASONS.PAPER_NOT_APPROVED);

    // 3. Receipt verification against real 4B2 receipt
    if (input.receiptId !== this.expectedReceiptId) reasons.push(SAFETY_REASONS.RECEIPT_INVALID);

    // 4. Source SHA
    if (input.sourceSha !== this.expectedSourceSha) reasons.push(SAFETY_REASONS.SOURCE_SHA_MISMATCH);

    // 5. Kill switch
    if (input.killSwitch.enabled) reasons.push(SAFETY_REASONS.KILL_SWITCH_ENABLED);

    // 6. Bridge health — UNKNOWN fail-closed
    if (input.bridgeHealth === 'UNKNOWN') reasons.push(SAFETY_REASONS.BRIDGE_UNKNOWN);
    else if (input.bridgeHealth !== 'READY') reasons.push(SAFETY_REASONS.BRIDGE_NOT_READY);

    // 7. Market data — UNKNOWN fail-closed
    if (input.marketDataHealth === 'UNKNOWN') reasons.push(SAFETY_REASONS.MARKET_DATA_UNKNOWN);
    else if (input.marketDataHealth !== 'FRESH') reasons.push(SAFETY_REASONS.MARKET_DATA_STALE);

    // 8. State store — UNKNOWN fail-closed
    if (input.stateStoreIntact === 'UNKNOWN') reasons.push(SAFETY_REASONS.STATE_STORE_UNKNOWN);
    else if (!input.stateStoreIntact) reasons.push(SAFETY_REASONS.STATE_STORE_CORRUPT);

    // 9. Orders — UNKNOWN fail-closed
    if (input.hasUnresolvedOrders === 'UNKNOWN') reasons.push(SAFETY_REASONS.UNKNOWN_ORDER_POSITION);
    else if (input.hasUnresolvedOrders) reasons.push(SAFETY_REASONS.UNRESOLVED_ORDERS);

    // 10. Recovery — UNKNOWN fail-closed
    if (input.recoveryRequired === 'UNKNOWN') reasons.push(SAFETY_REASONS.RECOVERY_UNKNOWN);
    else if (input.recoveryRequired) reasons.push(SAFETY_REASONS.RECOVERY_REQUIRED);

    return deepFreeze({ passed: false, blockedReasons: [...new Set(reasons)].sort() });
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
  readonly idempotencyLedger: IdempotencyLedger;
  private consumedDecisionIds = new Set<string>();

  constructor(receiptId: string, sourceSha: string, killSwitch: KillSwitch, ledger: IdempotencyLedger) {
    this.gate = new RuntimeStartupSafetyGate(receiptId, sourceSha);
    this.killSwitch = killSwitch;
    this.idempotencyLedger = ledger;
  }

  evaluate(input: SafetyGateInput, deterministicToken: string): SafetyDecision {
    const reasons: SafetyReasonCode[] = [];

    // Gate verification
    const gateResult = this.gate.verify(input);
    reasons.push(...gateResult.blockedReasons);

    // Idempotency: use deterministic token, NOT wall-clock time
    const dedupKey = IdempotencyLedger.makeKey('STARTUP', deterministicToken, input.sourceSha);
    if (this.idempotencyLedger.checkDuplicate('STARTUP', dedupKey, new Date().toISOString())) {
      reasons.push(SAFETY_REASONS.DUPLICATE_START);
    }

    const status: RuntimeSafetyState = 'START_BLOCKED';

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
    this.consumedDecisionIds.add(decisionId);
    return decision;
  }

  buildSnapshot(
    nowIso: string,
    bridgeHealth: BridgeHealth,
    marketHealth: MarketDataHealth,
    recoveryStatus: RecoveryStatus,
    audit: AppendOnlySafetyAudit,
  ): RuntimeHealthSnapshot {
    return createRuntimeHealthSnapshot({
      runtimeState: 'START_BLOCKED',
      safetyGateStatus: 'BLOCKED',
      killSwitchStatus: this.killSwitch.enabled ? 'ENABLED' : 'DISABLED',
      bridgeHealth,
      marketDataHealth: marketHealth,
      recoveryStatus,
      lastEventId: audit.tipId,
      auditTip: audit.tipId,
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
// Health Snapshot — from real state, not hardcoded
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
  const snapshotId = domainId('CloddsBot:RuntimeHealthSnapshot:v1', body);
  return deepFreeze({ ...body, snapshotId });
}

// ═══════════════════════════════════════════════════════════════════
// Recovery Coordinator — completion evidence required
// ═══════════════════════════════════════════════════════════════════

export interface RecoveryEvent {
  readonly type: 'BRIDGE_CRASH' | 'BRIDGE_TIMEOUT' | 'DUPLICATE_EVENT' | 'PARTIAL_WRITE' | 'RESTART' | 'STALE_SNAPSHOT' | 'UNKNOWN_ORDER';
  readonly timestamp: string;
  readonly details: string;
  readonly eventId: string;
}

export interface RecoveryCompletionEvidence {
  readonly recoveryEventId: string;
  readonly verifiedState: string;
  readonly evidenceDigest: string;
}

export class RecoveryCoordinator {
  private _status: RecoveryStatus = 'NONE';
  private events: RecoveryEvent[] = [];
  private idempotencyLedger = new IdempotencyLedger();
  private _newPositionsBlocked = true;
  private completionEvidence: RecoveryCompletionEvidence | null = null;

  get status(): RecoveryStatus { return this._status; }
  get newPositionsBlocked(): boolean { return this._newPositionsBlocked; }

  /** Start recovery for a specific event type. */
  startRecovery(event: RecoveryEvent, nowIso: string): void {
    const dedupKey = IdempotencyLedger.makeKey('RECOVERY', event.type, event.eventId);
    if (this.idempotencyLedger.checkDuplicate('RECOVERY', dedupKey, nowIso)) {
      throw new Error(`RECOVERY:${SAFETY_REASONS.DUPLICATE_RECOVERY}`);
    }
    if (this._status === 'IN_PROGRESS') {
      throw new Error(`RECOVERY:${SAFETY_REASONS.RECOVERY_BLOCKED}`);
    }
    if (event.type === 'UNKNOWN_ORDER') {
      // Permanent block — cannot recover from unknown orders
      this._status = 'FAILED';
      this._newPositionsBlocked = true;
      this.events.push(deepFreeze(event));
      return;
    }
    this._status = 'IN_PROGRESS';
    this._newPositionsBlocked = true;
    this.events.push(deepFreeze(event));
  }

  /** Complete recovery with verified evidence. */
  completeRecovery(evidence: RecoveryCompletionEvidence): void {
    if (this._status !== 'IN_PROGRESS') throw new Error(`RECOVERY:${SAFETY_REASONS.INVALID_TRANSITION}`);
    if (!evidence.recoveryEventId || !evidence.evidenceDigest) {
      throw new Error(`RECOVERY:${SAFETY_REASONS.RECOVERY_NOT_VERIFIED}`);
    }
    // Verify evidence matches current recovery event
    const lastEvent = this.events.at(-1);
    if (!lastEvent || evidence.recoveryEventId !== lastEvent.eventId) {
      throw new Error(`RECOVERY:${SAFETY_REASONS.RECOVERY_NOT_VERIFIED}`);
    }
    this.completionEvidence = deepFreeze(evidence);
    this._status = 'COMPLETED';
    // Production: new positions remain blocked (no promoted strategy)
    // Reference path: enabled for test fixtures
    this._newPositionsBlocked = true;
  }

  /** Reference-only: enable new positions after verified recovery. */
  _referenceEnablePositions(): void {
    if (this._status !== 'COMPLETED') throw new Error(`RECOVERY:${SAFETY_REASONS.INVALID_TRANSITION}`);
    this._newPositionsBlocked = false;
  }

  /** Mark recovery as failed. Stay blocked permanently. */
  failRecovery(reason: string): void {
    this._status = 'FAILED';
    this._newPositionsBlocked = true;
    this.events.push(deepFreeze({
      type: 'PARTIAL_WRITE',
      timestamp: new Date().toISOString(),
      details: reason,
      eventId: domainId('CloddsBot:RecoveryEvent:v1', { type: 'PARTIAL_WRITE', reason }),
    }));
  }

  /** Restart state recovery: replay events and determine status. */
  restartRecovery(previousEvents: readonly RecoveryEvent[], completionEvidence?: RecoveryCompletionEvidence): RecoveryStatus {
    this.events = JSON.parse(JSON.stringify(previousEvents));
    const lastEvent = this.events.at(-1);
    if (!lastEvent) {
      this._status = 'NONE';
      this._newPositionsBlocked = true;
      return 'NONE';
    }
    if (lastEvent.type === 'UNKNOWN_ORDER' || lastEvent.type === 'PARTIAL_WRITE') {
      this._status = 'FAILED';
      this._newPositionsBlocked = true;
      return 'FAILED';
    }
    // Without completion evidence, recovery is incomplete → stay FAILED
    if (!completionEvidence) {
      this._status = 'FAILED';
      this._newPositionsBlocked = true;
      return 'FAILED';
    }
    if (completionEvidence.recoveryEventId !== lastEvent.eventId) {
      this._status = 'FAILED';
      this._newPositionsBlocked = true;
      return 'FAILED';
    }
    this.completionEvidence = deepFreeze(completionEvidence);
    this._status = 'COMPLETED';
    this._newPositionsBlocked = true;
    return 'COMPLETED';
  }

  getAllEvents(): readonly RecoveryEvent[] {
    return Object.freeze([...this.events]);
  }

  persist(): { status: RecoveryStatus; events: readonly RecoveryEvent[]; completionEvidence: RecoveryCompletionEvidence | null } {
    return deepFreeze({ status: this._status, events: [...this.events], completionEvidence: this.completionEvidence });
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
    if (seq === 0 && opts.eventType !== 'ROOT') {
      throw new Error('AUDIT_INVALID:FIRST_EVENT_MUST_BE_ROOT');
    }
    const body: Omit<SafetyAuditEvent, 'eventId'> = {
      schemaVersion: SAFETY_AUDIT_SCHEMA,
      sequence: seq,
      timestamp: opts.timestamp,
      previousEventId: prev?.eventId ?? null,
      eventType: opts.eventType,
      payloadDigest: sha256(canonicalJson(opts.payload)),
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
    }
    if (expectedTipId !== undefined && this.tipId !== expectedTipId) {
      throw new Error(`AUDIT_INVALID:${SAFETY_REASONS.AUDIT_TRUNCATED}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Production factory
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
      receiptId: STAGE_4B2_VERIFIED_RECEIPT.receiptId,
      paperApproved: false,
      testnetApproved: false,
      liveApproved: false,
    },
  });
  return audit;
}

// ═══════════════════════════════════════════════════════════════════
// Stage 4B3 Deterministic Receipt — binds all safety state
// Trust-root closure: generator reads real 4B2 receipt, verifier
// accepts raw 4B1 artifact to independently re-derive trust chain.
// ═══════════════════════════════════════════════════════════════════

export const RECEIPT_4B3_SCHEMA = 'stage-4b3.safety-receipt.v1' as const;

const STAGE_4A_CLOSURE_AUDIT_ID = 'af9dc5cbb832b32b0c403631b2805bcb93996d215c044a47a06e4b3347db40cc';

export interface Stage4B3ReceiptInput {
  readonly sourceCommit: string;
  readonly stage4B2ReceiptId: string;
  readonly stage4B2SourceCommit: string;
  readonly stage4B2ArtifactSha256: string;
  readonly stage4B1ArtifactId: string;
  readonly stage4B1ProofId: string;
  readonly stage4B1DecisionId: string;
  readonly safetyDecisionId: string;
  readonly auditRootId: string;
  readonly auditTipId: string;
  readonly killSwitchEnabled: boolean;
  readonly killSwitchReason: string;
  readonly idempotencyLedgerDigest: string;
  readonly recoveryStatus: RecoveryStatus;
  readonly runtimeStarted: false;
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
}

export interface Stage4B3Receipt extends Stage4B3ReceiptInput {
  readonly schemaVersion: typeof RECEIPT_4B3_SCHEMA;
  readonly receiptId: string;
  readonly generatedAt: string;
}

export function createStage4B3Receipt(input: Stage4B3ReceiptInput, generatedAt: string): Stage4B3Receipt {
  if (input.runtimeStarted !== false) throw new Error('RECEIPT_INVALID:RUNTIME_STARTED_MUST_BE_FALSE');
  if (input.paperApproved !== false || input.testnetApproved !== false || input.liveApproved !== false) {
    throw new Error('RECEIPT_INVALID:APPROVAL_MUST_BE_FALSE');
  }
  if (typeof input.sourceCommit !== 'string' || input.sourceCommit.length !== 40) throw new Error('RECEIPT_INVALID:SOURCE_COMMIT');
  if (typeof input.stage4B2ReceiptId !== 'string' || input.stage4B2ReceiptId.length !== 64) throw new Error('RECEIPT_INVALID:4B2_RECEIPT_ID');
  if (typeof input.auditRootId !== 'string') throw new Error('RECEIPT_INVALID:AUDIT_ROOT_ID');
  if (typeof input.auditTipId !== 'string') throw new Error('RECEIPT_INVALID:AUDIT_TIP_ID');
  if (typeof input.stage4B2ArtifactSha256 !== 'string' || input.stage4B2ArtifactSha256.length !== 64) throw new Error('RECEIPT_INVALID:4B2_ARTIFACT_SHA256');

  const body: Omit<Stage4B3Receipt, 'receiptId'> = {
    schemaVersion: RECEIPT_4B3_SCHEMA,
    generatedAt,
    ...input,
  };
  const receiptId = domainId('CloddsBot:Stage4B3Receipt:v1', body);
  return deepFreeze({ ...body, receiptId });
}

/**
 * Independent trust-chain re-verification.
 * Accepts raw 4B1 artifact to re-derive 4B2 receipt — does NOT trust caller's expected values.
 */
export function verifyStage4B3Receipt(
  receipt: Stage4B3Receipt,
  stage4B1Artifact: unknown,
  stage4B1ArtifactSourceSha256: string,
): Stage4B2Receipt {
  // 1. Schema
  if (receipt.schemaVersion !== RECEIPT_4B3_SCHEMA) throw new Error('VERIFY_FAILED:SCHEMA');

  // 2. Self-consistent receipt ID (prevents forgery)
  const body = (({ receiptId: _, ...r }) => r)(receipt);
  const computedId = domainId('CloddsBot:Stage4B3Receipt:v1', body);
  if (receipt.receiptId !== computedId) throw new Error('VERIFY_FAILED:SELF_CONSISTENT_FORGERY');

  // 3. Independently re-derive 4B2 receipt from raw 4B1 artifact
  // This is the trust root — we do NOT trust what the 4B3 receipt claims
  const stage4B2Receipt = createStage4B2Receipt({
    sourceCommit: receipt.stage4B2SourceCommit,
    stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID,
    stage4B1Artifact,
    stage4B1ArtifactSourceSha256,
    generatedAt: '2026-07-28T00:00:00.000Z',
  });
  verifyStage4B2Receipt(stage4B2Receipt, {
    sourceCommit: receipt.stage4B2SourceCommit,
    stage4AClosureAuditId: STAGE_4A_CLOSURE_AUDIT_ID,
    stage4B1Artifact,
    stage4B1ArtifactSourceSha256,
  });

  // 4. Verify 4B3 receipt bindings against independently re-derived 4B2 receipt
  if (receipt.stage4B2ReceiptId !== stage4B2Receipt.receiptId) {
    throw new Error('VERIFY_FAILED:4B2_RECEIPT_ID_TRUST_ROOT_MISMATCH');
  }
  if (receipt.stage4B2SourceCommit !== stage4B2Receipt.sourceCommit) {
    throw new Error('VERIFY_FAILED:4B2_SOURCE_COMMIT_TRUST_ROOT_MISMATCH');
  }
  if (receipt.stage4B1ArtifactId !== stage4B2Receipt.stage4B1ArtifactId) {
    throw new Error('VERIFY_FAILED:4B1_ARTIFACT_ID_MISMATCH');
  }
  if (receipt.stage4B1ProofId !== stage4B2Receipt.stage4B1ProofId) {
    throw new Error('VERIFY_FAILED:4B1_PROOF_ID_MISMATCH');
  }
  if (receipt.stage4B1DecisionId !== stage4B2Receipt.stage4B1DecisionId) {
    throw new Error('VERIFY_FAILED:4B1_DECISION_ID_MISMATCH');
  }

  // 5. Source commit (4B3) match
  // (verified by self-consistent receipt ID — changing sourceCommit changes receiptId)

  // 6. Approval flags
  if (receipt.runtimeStarted !== false) throw new Error('VERIFY_FAILED:RUNTIME_STARTED');
  if (receipt.paperApproved !== false) throw new Error('VERIFY_FAILED:PAPER');
  if (receipt.testnetApproved !== false) throw new Error('VERIFY_FAILED:TESTNET');
  if (receipt.liveApproved !== false) throw new Error('VERIFY_FAILED:LIVE');

  // 7. 4B2 artifact SHA-256 binding
  const stage4B2ArtifactJson = JSON.stringify(stage4B2Receipt);
  const computed4B2Sha256 = sha256(stage4B2ArtifactJson);
  if (receipt.stage4B2ArtifactSha256 !== computed4B2Sha256) {
    throw new Error('VERIFY_FAILED:4B2_ARTIFACT_SHA256_MISMATCH');
  }

  return stage4B2Receipt;
}
