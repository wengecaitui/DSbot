// Stage 4B2: Paper Readiness Review Contract — independent reverification, fail-closed.
// Builds on 4B1 ActivationContract without modification. No paper/live execution.

import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import {
  ACTIVATION_CONTRACT_VERSION,
  REQUESTED_SCOPE,
  REFERENCE_FIXTURE_LABEL,
  canonicalJson,
  canonicalSha256,
  verifyProductionEligibility,
  verifyReferenceEligibilityFixture,
  type ActivationIdentity,
  type ActivationEligibilityProof,
  type Stage4AArtifactTextBundle,
  type TrustedActivationApprover,
  type ActivationDecision,
} from './ActivationContract';

export const PAPER_READINESS_SCHEMA = 'stage-4b2.paper-readiness-review.v1' as const;
export const PAPER_READINESS_REQUEST_SCHEMA = 'stage-4b2.paper-readiness-request.v1' as const;
export const PAPER_READINESS_DECISION_SCHEMA = 'stage-4b2.paper-readiness-decision.v1' as const;
export const PAPER_READINESS_AUDIT_SCHEMA = 'stage-4b2.paper-readiness-audit.v1' as const;
export const STAGE_4B2_VERIFIED_BASELINE = 'eee580cb7a25f67cb65aecd9a0a82f71b4921121' as const;
const PAPER_READINESS_DOMAIN = 'CloddsBot:PaperReadinessReview:stage-4b2.v1' as const;

export type PaperReadinessState = 'UNREVIEWED' | 'ARTIFACTS_REVERIFIED' | 'REVIEW_BLOCKED';
export type PaperReadinessReviewMode = 'PRODUCTION' | 'REFERENCE';

export const PAPER_READINESS_REASONS = {
  NO_ACTIVATION_REVIEW_READY_STRATEGY: 'BLOCKED_NO_ACTIVATION_REVIEW_READY_STRATEGY',
  ARTIFACT_REVERIFICATION_FAILED: 'ARTIFACT_REVERIFICATION_FAILED',
  STAGE_4A_NOT_CLOSED: 'STAGE_4A_NOT_CLOSED',
  STAGE_4A14_SOURCE_DETECTED: 'STAGE_4A14_SOURCE_DETECTED',
  PROMOTION_NOT_ELIGIBLE: 'PROMOTION_NOT_ELIGIBLE',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  BASELINE_MISMATCH: 'BASELINE_MISMATCH',
  DIGEST_MISMATCH: 'DIGEST_MISMATCH',
  SIGNATURE_MISSING: 'SIGNATURE_MISSING',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  SIGNER_UNKNOWN: 'SIGNER_UNKNOWN',
  SIGNER_KEY_REPLACED: 'SIGNER_KEY_REPLACED',
  REQUEST_EXPIRED: 'REQUEST_EXPIRED',
  MODE_NOT_ALLOWED: 'MODE_NOT_ALLOWED',
  LIVE_EXECUTION_CHANGES: 'LIVE_EXECUTION_CHANGES',
  PAPER_RUNTIME_CHANGES: 'PAPER_RUNTIME_CHANGES',
  AUDIT_TAMPERED: 'AUDIT_TAMPERED',
  AUDIT_CHAIN_BROKEN: 'AUDIT_CHAIN_BROKEN',
  REPLAY_REJECTED: 'REPLAY_REJECTED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  TERMINAL_STATE: 'TERMINAL_STATE',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  SELF_CONSISTENT_FORGERY: 'SELF_CONSISTENT_FORGERY',
  FAKE_PROOF_DETECTED: 'FAKE_PROOF_DETECTED',
} as const;

export type PaperReadinessReasonCode = typeof PAPER_READINESS_REASONS[keyof typeof PAPER_READINESS_REASONS];

// ── Artifact Verifier ─────────────────────────────────────────
export interface ArtifactReverificationResult {
  readonly artifactsDigest: string;
  readonly identityDigest: string;
  readonly stage4AClosed: boolean;
  readonly liveExecutionChanges: false;
  readonly paperApproved: false;
  readonly promotionEligible: boolean;
  readonly reasonCodes: readonly PaperReadinessReasonCode[];
}

export interface ActivationArtifactVerifier {
  reverifyArtifacts(bundle: Stage4AArtifactTextBundle): ArtifactReverificationResult;
  verifyIdentity(identity: ActivationIdentity, proof: ActivationEligibilityProof): boolean;
  detectStage4A14(bundle: Stage4AArtifactTextBundle): boolean;
}

export function createArtifactVerifier(baselineCommit: string): ActivationArtifactVerifier {
  if (baselineCommit !== STAGE_4B2_VERIFIED_BASELINE) {
    return {
      reverifyArtifacts: () => ({ artifactsDigest: '', identityDigest: '', stage4AClosed: false, liveExecutionChanges: false, paperApproved: false, promotionEligible: false, reasonCodes: [PAPER_READINESS_REASONS.BASELINE_MISMATCH] }),
      verifyIdentity: () => false,
      detectStage4A14: () => false,
    };
  }

  return {
    reverifyArtifacts(bundle: Stage4AArtifactTextBundle): ArtifactReverificationResult {
      const reasons: PaperReadinessReasonCode[] = [];
      const proof = verifyProductionEligibility(bundle, baselineCommit);
      const stage4AClosed = !proof.reasonCodes.includes('STAGE_4A_NOT_CLOSED' as any);
      const promotionEligible = proof.status === 'ELIGIBLE_FOR_ACTIVATION_REVIEW';
      if (!stage4AClosed) reasons.push(PAPER_READINESS_REASONS.STAGE_4A_NOT_CLOSED);
      if (!promotionEligible) reasons.push(PAPER_READINESS_REASONS.PROMOTION_NOT_ELIGIBLE);
      if (proof.reasonCodes.includes('STAGE_4A14_SOURCE_REJECTED' as any)) reasons.push(PAPER_READINESS_REASONS.STAGE_4A14_SOURCE_DETECTED);

      const artifactsDigest = canonicalSha256(bundle);
      const identityDigest = proof.identity ? canonicalSha256(proof.identity) : '';
      return { artifactsDigest, identityDigest, stage4AClosed, liveExecutionChanges: false, paperApproved: false, promotionEligible, reasonCodes: [...new Set(reasons)] };
    },
    verifyIdentity(identity: ActivationIdentity, proof: ActivationEligibilityProof): boolean {
      if (!proof.identity) return false;
      return canonicalJson(identity) === canonicalJson(proof.identity);
    },
    detectStage4A14(bundle: Stage4AArtifactTextBundle): boolean {
      try { const proof = verifyProductionEligibility(bundle, baselineCommit); return proof.reasonCodes.includes('STAGE_4A14_SOURCE_REJECTED' as any); }
      catch { return false; }
    },
  };
}

// ── Paper Readiness Review Request ─────────────────────────────
export interface PaperReadinessReviewRequest {
  readonly schemaVersion: typeof PAPER_READINESS_REQUEST_SCHEMA;
  readonly eligibilityProofId: string;
  readonly artifactDigest: string;
  readonly requesterId: string;
  readonly mode: PaperReadinessReviewMode;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly requestId: string;
}

export function createPaperReadinessReviewRequest(
  proofId: string,
  artifactDigest: string,
  requesterId: string,
  mode: PaperReadinessReviewMode,
  issuedAt: string,
  expiresAt: string,
): PaperReadinessReviewRequest {
  if (typeof proofId !== 'string' || proofId.length === 0) throw new Error('REQUEST_INVALID:PROOF_ID');
  if (typeof artifactDigest !== 'string' || artifactDigest.length !== 64) throw new Error('REQUEST_INVALID:ARTIFACT_DIGEST');
  if (mode !== 'PRODUCTION' && mode !== 'REFERENCE') throw new Error('MODE_NOT_ALLOWED');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(issuedAt)) throw new Error('REQUEST_INVALID:ISSUED_AT');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)) throw new Error('REQUEST_INVALID:EXPIRES_AT');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error('REQUEST_EXPIRED');
  const body: Omit<PaperReadinessReviewRequest, 'requestId'> = { schemaVersion: PAPER_READINESS_REQUEST_SCHEMA, eligibilityProofId: proofId, artifactDigest, requesterId, mode, issuedAt, expiresAt };
  return Object.freeze({ ...body, requestId: canonicalSha256({ domain: 'CloddsBot:PaperReadinessReviewRequest:v1', ...body }) });
}

// ── Paper Readiness Review Policy ─────────────────────────────
export interface PaperReadinessReviewDecision {
  readonly schemaVersion: typeof PAPER_READINESS_DECISION_SCHEMA;
  readonly mode: PaperReadinessReviewMode;
  readonly status: PaperReadinessState;
  readonly reviewEligible: false;
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
  readonly reasonCodes: readonly PaperReadinessReasonCode[];
  readonly requestId: string | null;
  readonly decisionId: string;
}

function blockedDecision(mode: PaperReadinessReviewMode, reasons: readonly PaperReadinessReasonCode[], requestId: string | null = null): PaperReadinessReviewDecision {
  const body: Omit<PaperReadinessReviewDecision, 'decisionId'> = { schemaVersion: PAPER_READINESS_DECISION_SCHEMA, mode, status: 'REVIEW_BLOCKED', reviewEligible: false, paperApproved: false, testnetApproved: false, liveApproved: false, reasonCodes: [...new Set(reasons)].sort(), requestId };
  return Object.freeze({ ...body, decisionId: canonicalSha256({ domain: 'CloddsBot:PaperReadinessReviewDecision:v1', ...body }) });
}

export class PaperReadinessReviewPolicy {
  readonly verifier: ActivationArtifactVerifier;
  readonly trustedSigners: readonly TrustedActivationApprover[];
  readonly baselineCommit: string;
  private consumedRequestIds = new Set<string>();
  private _paperRuntimeChanges = false;
  private _liveExecutionChanges = false;

  constructor(opts: { baselineCommit: string; trustedSigners?: readonly TrustedActivationApprover[] }) {
    this.baselineCommit = opts.baselineCommit;
    this.trustedSigners = opts.trustedSigners ?? [];
    this.verifier = createArtifactVerifier(opts.baselineCommit);
  }

  get paperRuntimeChanges(): boolean { return this._paperRuntimeChanges; }
  get liveExecutionChanges(): boolean { return this._liveExecutionChanges; }

  evaluateRequest(
    request: PaperReadinessReviewRequest,
    proof: ActivationEligibilityProof,
    bundle: Stage4AArtifactTextBundle,
    nowMs: number,
  ): PaperReadinessReviewDecision {
    const reasons: PaperReadinessReasonCode[] = [];

    // 1. Baseline check
    if (this.baselineCommit !== STAGE_4B2_VERIFIED_BASELINE) reasons.push(PAPER_READINESS_REASONS.BASELINE_MISMATCH);

    // 2. Mode check — only PRODUCTION allowed for real reviews
    if (request.mode === 'REFERENCE') return blockedDecision('REFERENCE', [PAPER_READINESS_REASONS.MODE_NOT_ALLOWED], request.requestId);

    // 3. Request validity
    if (request.schemaVersion !== PAPER_READINESS_REQUEST_SCHEMA) reasons.push(PAPER_READINESS_REASONS.REQUEST_EXPIRED);
    if (nowMs < Date.parse(request.issuedAt) || nowMs >= Date.parse(request.expiresAt)) reasons.push(PAPER_READINESS_REASONS.REQUEST_EXPIRED);

    // 4. Replay check
    if (this.consumedRequestIds.has(request.requestId)) { reasons.push(PAPER_READINESS_REASONS.REPLAY_REJECTED); }
    this.consumedRequestIds.add(request.requestId);

    // 5. Independent reverification of 4B1 artifacts
    const reverified = this.verifier.reverifyArtifacts(bundle);
    if (!reverified.stage4AClosed) reasons.push(PAPER_READINESS_REASONS.STAGE_4A_NOT_CLOSED);
    if (reverified.artifactDigest !== request.artifactDigest) reasons.push(PAPER_READINESS_REASONS.DIGEST_MISMATCH);
    if (!reverified.promotionEligible) reasons.push(PAPER_READINESS_REASONS.NO_ACTIVATION_REVIEW_READY_STRATEGY);

    // 6. Proof identity verification (not trusting proof.verified by caller)
    if (proof.mode !== 'PRODUCTION') reasons.push(PAPER_READINESS_REASONS.FAKE_PROOF_DETECTED);
    const verified = verifyProductionEligibility(bundle, this.baselineCommit);
    if (canonicalJson(verified) !== canonicalJson(proof)) reasons.push(PAPER_READINESS_REASONS.FAKE_PROOF_DETECTED);

    // 7. Self-consistent forgery check
    if (proof.status === 'ELIGIBLE_FOR_ACTIVATION_REVIEW' && proof.identity) {
      if (!this.verifier.verifyIdentity(proof.identity, proof)) reasons.push(PAPER_READINESS_REASONS.IDENTITY_MISMATCH);
    }

    // 8. Stage 4A14 detection
    if (this.verifier.detectStage4A14(bundle)) reasons.push(PAPER_READINESS_REASONS.STAGE_4A14_SOURCE_DETECTED);

    // 9. Signature verification if trusted signers configured
    if (this.trustedSigners.length > 0 && (!proof.identity || proof.paperApproved !== false)) {
      reasons.push(PAPER_READINESS_REASONS.SIGNER_UNKNOWN);
    }

    // 10. Live execution and Paper Runtime changes
    if (this._liveExecutionChanges) reasons.push(PAPER_READINESS_REASONS.LIVE_EXECUTION_CHANGES);
    if (this._paperRuntimeChanges) reasons.push(PAPER_READINESS_REASONS.PAPER_RUNTIME_CHANGES);

    return blockedDecision('PRODUCTION', reasons.length > 0 ? reasons : [PAPER_READINESS_REASONS.NO_ACTIVATION_REVIEW_READY_STRATEGY], request.requestId);
  }
}

// ── State Machine ─────────────────────────────────────────────
const READINESS_TRANSITIONS: Readonly<Record<PaperReadinessState, readonly PaperReadinessState[]>> = {
  UNREVIEWED: ['ARTIFACTS_REVERIFIED', 'REVIEW_BLOCKED'],
  ARTIFACTS_REVERIFIED: ['REVIEW_BLOCKED'],
  REVIEW_BLOCKED: [],
};

export class PaperReadinessReviewStateMachine {
  private _state: PaperReadinessState = 'UNREVIEWED';
  private _requestIds = new Set<string>();

  get state(): PaperReadinessState { return this._state; }

  transition(next: PaperReadinessState, requestId?: string): PaperReadinessState {
    if (READINESS_TRANSITIONS[this._state].length === 0) throw new Error(`INVALID_TRANSITION:${PAPER_READINESS_REASONS.TERMINAL_STATE}`);
    if (!READINESS_TRANSITIONS[this._state].includes(next)) throw new Error(`INVALID_TRANSITION:${PAPER_READINESS_REASONS.INVALID_TRANSITION}`);
    if (requestId) {
      if (this._requestIds.has(requestId)) throw new Error(`INVALID_TRANSITION:${PAPER_READINESS_REASONS.REPLAY_REJECTED}`);
      this._requestIds.add(requestId);
    }
    this._state = next;
    return this._state;
  }
}

// ── Append-Only Audit ─────────────────────────────────────────
export interface PaperReadinessAuditEvent {
  readonly schemaVersion: typeof PAPER_READINESS_AUDIT_SCHEMA;
  readonly sequence: number;
  readonly timestamp: string;
  readonly previousEventId: string | null;
  readonly fromState: PaperReadinessState | null;
  readonly toState: PaperReadinessState;
  readonly eventType: 'ROOT' | 'TRANSITION';
  readonly payloadDigest: string;
  readonly requestId: string | null;
  readonly eventId: string;
}

function auditEventId(event: Omit<PaperReadinessAuditEvent, 'eventId'>): string {
  return canonicalSha256({ domain: 'CloddsBot:PaperReadinessAuditEvent:v1', ...event });
}

export class AppendOnlyPaperReadinessAudit {
  private events: PaperReadinessAuditEvent[];

  constructor(eventsInput: readonly PaperReadinessAuditEvent[] = [], expectedTipId?: string) {
    this.events = JSON.parse(JSON.stringify(eventsInput));
    this.validate(expectedTipId);
  }

  get tipId(): string | null { return this.events.at(-1)?.eventId ?? null; }
  get all(): readonly PaperReadinessAuditEvent[] { return Object.freeze([...this.events]); }

  append(opts: { timestamp: string; fromState: PaperReadinessState | null; toState: PaperReadinessState; eventType: 'ROOT' | 'TRANSITION'; payload: unknown; requestId?: string | null }): PaperReadinessAuditEvent {
    this.validate();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(opts.timestamp)) throw new Error(`AUDIT_INVALID:TIMESTAMP`);
    const seq = this.events.length;
    const prev = this.events.at(-1);
    if (seq === 0) {
      if (opts.eventType !== 'ROOT' || opts.fromState !== null || opts.toState !== 'UNREVIEWED') throw new Error(`AUDIT_INVALID:ROOT`);
    } else {
      if (opts.eventType !== 'TRANSITION' || opts.fromState !== prev!.toState || !READINESS_TRANSITIONS[opts.fromState].includes(opts.toState)) {
        throw new Error(`AUDIT_INVALID:TRANSITION`);
      }
    }
    const body: Omit<PaperReadinessAuditEvent, 'eventId'> = {
      schemaVersion: PAPER_READINESS_AUDIT_SCHEMA, sequence: seq, timestamp: opts.timestamp,
      previousEventId: prev?.eventId ?? null, fromState: opts.fromState, toState: opts.toState,
      eventType: opts.eventType, payloadDigest: canonicalSha256({ domain: 'CloddsBot:PaperReadinessAuditPayload:v1', payload: opts.payload }),
      requestId: opts.requestId ?? null,
    };
    const event = Object.freeze({ ...body, eventId: auditEventId(body) });
    this.events.push(event);
    return event;
  }

  validate(expectedTipId?: string): void {
    const requests = new Set<string>();
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      const p = this.events[i - 1];
      const body = (({ eventId: _, ...r }) => r)(e);
      if (e.schemaVersion !== PAPER_READINESS_AUDIT_SCHEMA || e.sequence !== i || e.previousEventId !== (p?.eventId ?? null)
          || e.eventId !== auditEventId(body)) throw new Error(`AUDIT_INVALID:${PAPER_READINESS_REASONS.AUDIT_CHAIN_BROKEN}`);
      if (i === 0) {
        if (e.eventType !== 'ROOT' || e.fromState !== null || e.toState !== 'UNREVIEWED') throw new Error(`AUDIT_INVALID`);
      } else if (e.eventType !== 'TRANSITION' || e.fromState !== p.toState || !READINESS_TRANSITIONS[e.fromState].includes(e.toState)) {
        throw new Error(`AUDIT_INVALID:${PAPER_READINESS_REASONS.INVALID_TRANSITION}`);
      }
      if (e.requestId) {
        if (requests.has(e.requestId)) throw new Error(`AUDIT_INVALID:${PAPER_READINESS_REASONS.REPLAY_REJECTED}`);
        requests.add(e.requestId);
      }
    }
    if (expectedTipId !== undefined && this.tipId !== expectedTipId) throw new Error(`AUDIT_INVALID:${PAPER_READINESS_REASONS.AUDIT_TAMPERED}`);
  }
}

// ── Production blocked audit builder ──────────────────────────
export function createRealBlockedPaperReadinessAudit(timestamp: string): AppendOnlyPaperReadinessAudit {
  const audit = new AppendOnlyPaperReadinessAudit();
  audit.append({ timestamp, fromState: null, toState: 'UNREVIEWED', eventType: 'ROOT', payload: { schemaVersion: PAPER_READINESS_SCHEMA, baselineCommit: STAGE_4B2_VERIFIED_BASELINE } });
  audit.append({ timestamp, fromState: 'UNREVIEWED', toState: 'REVIEW_BLOCKED', eventType: 'TRANSITION', payload: { reason: PAPER_READINESS_REASONS.NO_ACTIVATION_REVIEW_READY_STRATEGY, paperApproved: false, liveApproved: false } });
  return audit;
}
