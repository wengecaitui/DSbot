// Stage 4A7: detached approval verification. This module never handles private keys.

import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { deepFreeze } from './ValidationTypes';
import {
  verifyPromotionDecisionArtifact,
  type PromotionDecisionArtifact,
} from './PromotionDecisionArtifactStore';

export const PROMOTION_APPROVAL_CONTRACT_VERSION = '4A7-R1' as const;
const SIGNING_DOMAIN = 'CloddsBot:PromotionApproval:4A7-R1' as const;

export interface TrustedPromotionApprover {
  readonly approverId: string;
  readonly keyId: string;
  /** PEM-encoded Ed25519 public key. Private keys are intentionally unsupported. */
  readonly publicKeyPem: string;
}

export interface PromotionApprovalPolicy {
  readonly minApprovals: number;
  readonly requiredApproverIds: readonly string[];
  readonly maxAttestationAgeMs: number;
  readonly trustedApprovers: readonly TrustedPromotionApprover[];
}

export interface PromotionApprovalStatement {
  readonly approvalContractVersion: typeof PROMOTION_APPROVAL_CONTRACT_VERSION;
  readonly artifactId: string;
  readonly decisionId: string;
  readonly approverId: string;
  readonly keyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface PromotionApprovalAttestation extends PromotionApprovalStatement {
  /** Base64-encoded detached Ed25519 signature over makePromotionApprovalSigningPayload(). */
  readonly signature: string;
}

export const PROMOTION_APPROVAL_REASONS = {
  ARTIFACT_INVALID: 'ARTIFACT_INVALID',
  DECISION_NOT_PROMOTABLE: 'DECISION_NOT_PROMOTABLE',
  ATTESTATION_MALFORMED: 'ATTESTATION_MALFORMED',
  ATTESTATION_CONTRACT_MISMATCH: 'ATTESTATION_CONTRACT_MISMATCH',
  ARTIFACT_BINDING_MISMATCH: 'ARTIFACT_BINDING_MISMATCH',
  DECISION_BINDING_MISMATCH: 'DECISION_BINDING_MISMATCH',
  UNTRUSTED_APPROVER: 'UNTRUSTED_APPROVER',
  KEY_BINDING_MISMATCH: 'KEY_BINDING_MISMATCH',
  TIMESTAMP_INVALID: 'TIMESTAMP_INVALID',
  ATTESTATION_NOT_YET_VALID: 'ATTESTATION_NOT_YET_VALID',
  ATTESTATION_EXPIRED: 'ATTESTATION_EXPIRED',
  ATTESTATION_TOO_OLD: 'ATTESTATION_TOO_OLD',
  SIGNATURE_ENCODING_INVALID: 'SIGNATURE_ENCODING_INVALID',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  DUPLICATE_APPROVER_ATTESTATION: 'DUPLICATE_APPROVER_ATTESTATION',
  REQUIRED_APPROVER_MISSING: 'REQUIRED_APPROVER_MISSING',
  INSUFFICIENT_APPROVALS: 'INSUFFICIENT_APPROVALS',
} as const;

export type PromotionApprovalReasonCode =
  typeof PROMOTION_APPROVAL_REASONS[keyof typeof PROMOTION_APPROVAL_REASONS];

export interface PromotionApprovalReason {
  readonly code: PromotionApprovalReasonCode;
  readonly detail: string;
}

export interface PromotionApprovalDecision {
  readonly approvalContractVersion: typeof PROMOTION_APPROVAL_CONTRACT_VERSION;
  readonly artifactId: string;
  readonly decisionId: string;
  readonly status: 'approved' | 'rejected';
  readonly verifiedApproverIds: readonly string[];
  readonly reasons: readonly PromotionApprovalReason[];
}

interface ValidatedApprover extends TrustedPromotionApprover {
  readonly publicKey: KeyObject;
}

function invalidPolicy(field: string): never {
  throw new Error(`INVALID_PROMOTION_APPROVAL_POLICY:${field}`);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function validatePolicy(policy: PromotionApprovalPolicy): Map<string, ValidatedApprover> {
  if (!policy || typeof policy !== 'object') invalidPolicy('shape');
  if (!Number.isInteger(policy.minApprovals) || policy.minApprovals < 1) invalidPolicy('minApprovals');
  if (!Number.isInteger(policy.maxAttestationAgeMs) || policy.maxAttestationAgeMs < 1) {
    invalidPolicy('maxAttestationAgeMs');
  }
  if (!Array.isArray(policy.requiredApproverIds) || !Array.isArray(policy.trustedApprovers)) {
    invalidPolicy('shape');
  }
  const required = new Set<string>();
  for (const id of policy.requiredApproverIds) {
    if (!nonEmpty(id) || required.has(id)) invalidPolicy('requiredApproverIds');
    required.add(id);
  }

  const byKey = new Map<string, ValidatedApprover>();
  const trustedIds = new Set<string>();
  for (const entry of policy.trustedApprovers) {
    const publicKeyPresent = typeof entry.publicKeyPem === 'string' && entry.publicKeyPem.trim().length > 0;
    if (!nonEmpty(entry.approverId) || !nonEmpty(entry.keyId) || !publicKeyPresent || byKey.has(entry.keyId)) {
      invalidPolicy('trustedApprovers');
    }
    if (!entry.publicKeyPem.includes('-----BEGIN PUBLIC KEY-----') ||
        !entry.publicKeyPem.includes('-----END PUBLIC KEY-----') ||
        entry.publicKeyPem.includes('PRIVATE KEY')) {
      invalidPolicy('publicKeyPem');
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(entry.publicKeyPem);
    } catch {
      return invalidPolicy('publicKeyPem');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') invalidPolicy('publicKeyType');
    byKey.set(entry.keyId, { ...entry, publicKey });
    trustedIds.add(entry.approverId);
  }
  if (policy.minApprovals > trustedIds.size) invalidPolicy('minApprovals');
  for (const id of required) if (!trustedIds.has(id)) invalidPolicy('requiredApproverIds');
  return byKey;
}

/** Exact domain-separated bytes an external signer must sign. */
export function makePromotionApprovalSigningPayload(statement: PromotionApprovalStatement): Buffer {
  const payload = {
    domain: SIGNING_DOMAIN,
    approvalContractVersion: statement.approvalContractVersion,
    artifactId: statement.artifactId,
    decisionId: statement.decisionId,
    approverId: statement.approverId,
    keyId: statement.keyId,
    issuedAt: statement.issuedAt,
    expiresAt: statement.expiresAt,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function decodeSignature(value: string): Buffer | null {
  if (!nonEmpty(value) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === value ? decoded : null;
}

/** Pure, fail-closed verification. nowMs is explicit so time is deterministic and auditable. */
export function evaluatePromotionApprovals(
  artifactInput: unknown,
  attestations: readonly PromotionApprovalAttestation[],
  policy: PromotionApprovalPolicy,
  nowMs: number,
): PromotionApprovalDecision {
  const trustedByKey = validatePolicy(policy);
  if (!Number.isFinite(nowMs)) throw new Error('INVALID_PROMOTION_APPROVAL_TIME');
  const reasons: PromotionApprovalReason[] = [];
  const reject = (code: PromotionApprovalReasonCode, detail: string): void => { reasons.push({ code, detail }); };

  let artifact: PromotionDecisionArtifact | undefined;
  try {
    artifact = verifyPromotionDecisionArtifact(artifactInput);
  } catch {
    reject(PROMOTION_APPROVAL_REASONS.ARTIFACT_INVALID, 'Stage 4A6 artifact verification failed');
  }
  if (artifact?.decision.status !== 'promote') {
    reject(PROMOTION_APPROVAL_REASONS.DECISION_NOT_PROMOTABLE, 'promotion decision status must be promote');
  }

  const verified = new Set<string>();
  const seenApprovers = new Set<string>();
  const rawAttestations: readonly unknown[] = Array.isArray(attestations) ? attestations : [];
  if (!Array.isArray(attestations)) {
    reject(PROMOTION_APPROVAL_REASONS.ATTESTATION_MALFORMED, 'attestations must be an array');
  }
  const validShape: PromotionApprovalAttestation[] = [];
  rawAttestations.forEach((value, index) => {
    if (!value || typeof value !== 'object') {
      reject(PROMOTION_APPROVAL_REASONS.ATTESTATION_MALFORMED, `index=${index}`);
    } else {
      validShape.push(value as PromotionApprovalAttestation);
    }
  });
  const ordered = validShape.sort((a, b) => {
    const left = `${String(a.approverId)}\0${String(a.keyId)}\0${String(a.signature)}`;
    const right = `${String(b.approverId)}\0${String(b.keyId)}\0${String(b.signature)}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  for (const attestation of ordered) {
    const prefix = `approver=${String(attestation.approverId)}`;
    if (seenApprovers.has(attestation.approverId)) {
      reject(PROMOTION_APPROVAL_REASONS.DUPLICATE_APPROVER_ATTESTATION, prefix);
      continue;
    }
    seenApprovers.add(attestation.approverId);
    if (attestation.approvalContractVersion !== PROMOTION_APPROVAL_CONTRACT_VERSION) {
      reject(PROMOTION_APPROVAL_REASONS.ATTESTATION_CONTRACT_MISMATCH, prefix); continue;
    }
    if (attestation.artifactId !== artifact?.artifactId) {
      reject(PROMOTION_APPROVAL_REASONS.ARTIFACT_BINDING_MISMATCH, prefix); continue;
    }
    if (attestation.decisionId !== artifact?.decision.decisionId) {
      reject(PROMOTION_APPROVAL_REASONS.DECISION_BINDING_MISMATCH, prefix); continue;
    }
    const trusted = trustedByKey.get(attestation.keyId);
    if (!trusted) {
      reject(PROMOTION_APPROVAL_REASONS.UNTRUSTED_APPROVER, prefix); continue;
    }
    if (trusted.approverId !== attestation.approverId) {
      reject(PROMOTION_APPROVAL_REASONS.KEY_BINDING_MISMATCH, prefix); continue;
    }
    const issuedAt = Date.parse(attestation.issuedAt);
    const expiresAt = Date.parse(attestation.expiresAt);
    const canonicalTimes = Number.isFinite(issuedAt) && Number.isFinite(expiresAt) &&
      new Date(issuedAt).toISOString() === attestation.issuedAt &&
      new Date(expiresAt).toISOString() === attestation.expiresAt;
    if (!canonicalTimes || expiresAt <= issuedAt) {
      reject(PROMOTION_APPROVAL_REASONS.TIMESTAMP_INVALID, prefix); continue;
    }
    if (nowMs < issuedAt) {
      reject(PROMOTION_APPROVAL_REASONS.ATTESTATION_NOT_YET_VALID, prefix); continue;
    }
    if (nowMs >= expiresAt) {
      reject(PROMOTION_APPROVAL_REASONS.ATTESTATION_EXPIRED, prefix); continue;
    }
    if (nowMs - issuedAt > policy.maxAttestationAgeMs) {
      reject(PROMOTION_APPROVAL_REASONS.ATTESTATION_TOO_OLD, prefix); continue;
    }
    const signature = decodeSignature(attestation.signature);
    if (!signature) {
      reject(PROMOTION_APPROVAL_REASONS.SIGNATURE_ENCODING_INVALID, prefix); continue;
    }
    if (!verifySignature(null, makePromotionApprovalSigningPayload(attestation), trusted.publicKey, signature)) {
      reject(PROMOTION_APPROVAL_REASONS.SIGNATURE_INVALID, prefix); continue;
    }
    verified.add(attestation.approverId);
  }

  for (const required of [...policy.requiredApproverIds].sort()) {
    if (!verified.has(required)) {
      reject(PROMOTION_APPROVAL_REASONS.REQUIRED_APPROVER_MISSING, `approver=${required}`);
    }
  }
  if (verified.size < policy.minApprovals) {
    reject(PROMOTION_APPROVAL_REASONS.INSUFFICIENT_APPROVALS,
      `actual=${verified.size},required=${policy.minApprovals}`);
  }
  const verifiedApproverIds = [...verified].sort();
  return deepFreeze({
    approvalContractVersion: PROMOTION_APPROVAL_CONTRACT_VERSION,
    artifactId: artifact?.artifactId ?? '',
    decisionId: artifact?.decision.decisionId ?? '',
    status: reasons.length === 0 ? 'approved' : 'rejected',
    verifiedApproverIds,
    reasons,
  });
}
