// Stage 4B1: offline, fail-closed activation readiness contract. No runtime activation exists here.

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

export const ACTIVATION_CONTRACT_VERSION = 'stage-4b1.activation-contract.v1' as const;
export const ACTIVATION_PROOF_SCHEMA = 'stage-4b1.activation-eligibility-proof.v1' as const;
export const ACTIVATION_REQUEST_SCHEMA = 'stage-4b1.activation-request.v1' as const;
export const ACTIVATION_DECISION_SCHEMA = 'stage-4b1.activation-decision.v1' as const;
export const ACTIVATION_AUDIT_SCHEMA = 'stage-4b1.activation-audit.v1' as const;
export const ACTIVATION_APPROVAL_SCHEMA = 'stage-4b1.activation-approval.v1' as const;
export const REFERENCE_FIXTURE_LABEL = 'REFERENCE TEST FIXTURE ONLY' as const;
export const REQUESTED_SCOPE = 'PAPER_READINESS_REVIEW' as const;
const APPROVAL_DOMAIN = 'CloddsBot:ActivationApproval:stage-4b1.activation-contract.v1' as const;

export type ActivationState =
  | 'INACTIVE'
  | 'ELIGIBILITY_CHECKED'
  | 'ACTIVATION_REQUESTED'
  | 'ACTIVATION_BLOCKED'
  | 'ACTIVATION_REVIEW_READY';

export type EligibilityStatus = 'ELIGIBLE_FOR_ACTIVATION_REVIEW' | 'BLOCKED_NO_PROMOTED_STRATEGY' | 'BLOCKED_INVALID_EVIDENCE';

export const ACTIVATION_REASONS = {
  NO_PROMOTED_STRATEGY: 'BLOCKED_NO_PROMOTED_STRATEGY',
  ARTIFACT_MALFORMED: 'ARTIFACT_MALFORMED',
  ARTIFACT_DIGEST_INVALID: 'ARTIFACT_DIGEST_INVALID',
  ARTIFACT_BINDING_MISMATCH: 'ARTIFACT_BINDING_MISMATCH',
  STAGE_4A_NOT_CLOSED: 'STAGE_4A_NOT_CLOSED',
  STAGE_4A14_SOURCE_REJECTED: 'STAGE_4A14_SOURCE_REJECTED',
  PROMOTION_FALSE: 'PROMOTION_FALSE',
  PROMOTION_COUNT_MISMATCH: 'PROMOTION_COUNT_MISMATCH',
  STRATEGY_BINDING_MISMATCH: 'STRATEGY_BINDING_MISMATCH',
  EVIDENCE_BINDING_MISSING: 'EVIDENCE_BINDING_MISSING',
  EVIDENCE_BINDING_INCOMPLETE: 'EVIDENCE_BINDING_INCOMPLETE',
  EVIDENCE_DUPLICATE: 'EVIDENCE_DUPLICATE',
  EVIDENCE_FOREIGN_FAMILY: 'EVIDENCE_FOREIGN_FAMILY',
  EVIDENCE_RELABELLED: 'EVIDENCE_RELABELLED',
  REFERENCE_FIXTURE_REJECTED: 'REFERENCE_FIXTURE_REJECTED',
  REQUEST_INVALID: 'REQUEST_INVALID',
  REQUEST_BINDING_MISMATCH: 'REQUEST_BINDING_MISMATCH',
  APPROVAL_MISSING: 'APPROVAL_MISSING',
  APPROVAL_MALFORMED: 'APPROVAL_MALFORMED',
  APPROVAL_UNTRUSTED_KEY: 'APPROVAL_UNTRUSTED_KEY',
  APPROVAL_DUPLICATE_APPROVER: 'APPROVAL_DUPLICATE_APPROVER',
  APPROVAL_NOT_YET_VALID: 'APPROVAL_NOT_YET_VALID',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_SIGNATURE_INVALID: 'APPROVAL_SIGNATURE_INVALID',
  APPROVAL_BINDING_MISMATCH: 'APPROVAL_BINDING_MISMATCH',
  REPLAY_REJECTED: 'REPLAY_REJECTED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  TERMINAL_STATE: 'TERMINAL_STATE',
  AUDIT_INVALID: 'AUDIT_INVALID',
} as const;

export type ActivationReasonCode = typeof ACTIVATION_REASONS[keyof typeof ACTIVATION_REASONS];

export interface ActivationIdentity {
  readonly strategyId: string;
  readonly specId: string;
  readonly strategyVersion: string;
  readonly semanticFingerprint: string;
  readonly lineageId: string;
}

export interface ActivationEligibilityProof {
  readonly schemaVersion: typeof ACTIVATION_PROOF_SCHEMA;
  readonly contractVersion: typeof ACTIVATION_CONTRACT_VERSION;
  readonly mode: 'PRODUCTION' | 'REFERENCE';
  readonly status: EligibilityStatus | 'REFERENCE_CONTRACT_VERIFIED';
  readonly reasonCodes: readonly ActivationReasonCode[];
  readonly baselineCommit: string;
  readonly identity: ActivationIdentity | null;
  readonly sourceBindings: Readonly<Record<string, string>>;
  readonly counts: {
    readonly candidateStrategies: number;
    readonly promotionEligible: number;
    readonly consumedWindows: number;
    readonly consumedEvaluations: number;
  };
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
  readonly proofId: string;
}

export interface ActivationRequest {
  readonly schemaVersion: typeof ACTIVATION_REQUEST_SCHEMA;
  readonly eligibilityProofId: string;
  readonly identity: ActivationIdentity;
  readonly requestedScope: typeof REQUESTED_SCOPE;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly requestId: string;
}

export interface ActivationApprovalStatement {
  readonly schemaVersion: typeof ACTIVATION_APPROVAL_SCHEMA;
  readonly eligibilityProofId: string;
  readonly requestId: string;
  readonly identity: ActivationIdentity;
  readonly requestedScope: typeof REQUESTED_SCOPE;
  readonly approverId: string;
  readonly keyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ActivationApproval extends ActivationApprovalStatement {
  readonly signature: string;
}

export interface TrustedActivationApprover {
  readonly approverId: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export interface ActivationDecision {
  readonly schemaVersion: typeof ACTIVATION_DECISION_SCHEMA;
  readonly contractVersion: typeof ACTIVATION_CONTRACT_VERSION;
  readonly mode: 'PRODUCTION' | 'REFERENCE';
  readonly status: 'ACTIVATION_BLOCKED' | 'ACTIVATION_REVIEW_READY' | 'REFERENCE_CONTRACT_VERIFIED';
  readonly reasonCodes: readonly ActivationReasonCode[];
  readonly eligibilityProofId: string;
  readonly requestId: string | null;
  readonly requestedScope: typeof REQUESTED_SCOPE | null;
  readonly verifiedApproverIds: readonly string[];
  readonly paperApproved: false;
  readonly testnetApproved: false;
  readonly liveApproved: false;
  readonly decisionId: string;
}

export interface Stage4AArtifactTextBundle {
  readonly candidateManifestJson: string;
  readonly promotionDecisionJson: string;
  readonly consumedEvidenceSeedJson: string;
  readonly governanceContractJson: string;
  readonly closureAuditJson: string;
}

interface ParsedBundle {
  manifest: Record<string, unknown>;
  promotion: Record<string, unknown>;
  seed: Record<string, unknown>;
  governance: Record<string, unknown>;
  closure: Record<string, unknown>;
}

type CanonicalValue = null | boolean | string | number | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue };

function fail(message: string): never { throw new Error(message); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.trim() === value; }
function shaPattern(value: unknown, length = 64): value is string { return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value); }

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('ACTIVATION_CANONICAL_INVALID:NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return fail('ACTIVATION_CANONICAL_INVALID:UNSUPPORTED_VALUE');
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function domainId(domain: string, payload: unknown): string { return canonicalSha256({ domain, payload }); }

function safeClone<T>(value: T): T {
  canonicalJson(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  }
  return value;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/**
 * Preserve JSON number lexemes for cross-language self-digests. Stage 4A digests were
 * emitted by Python, where 1.0 and 1 are distinct canonical tokens after parsing.
 */
function tagNumberLexemes(json: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < json.length) {
    const char = json[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      index++;
      continue;
    }
    if (char === '"') { inString = true; output += char; index++; continue; }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const match = json.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!match) fail('ACTIVATION_ARTIFACT_INVALID:NUMBER');
      output += JSON.stringify(`\u0000NUMBER:${match[0]}`);
      index += match[0].length;
      continue;
    }
    output += char;
    index++;
  }
  return output;
}

function lexicalCanonical(value: unknown): string {
  if (typeof value === 'string' && value.startsWith('\u0000NUMBER:')) return value.slice(8);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(lexicalCanonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${lexicalCanonical(value[key])}`).join(',')}}`;
  return fail('ACTIVATION_ARTIFACT_INVALID:LEXICAL_VALUE');
}

function verifyRawSelfDigest(json: string, idField: string): Record<string, unknown> {
  if (typeof json !== 'string' || json.length === 0) fail('ARTIFACT_MALFORMED');
  let plain: unknown;
  let lexical: unknown;
  try {
    plain = JSON.parse(json);
    lexical = JSON.parse(tagNumberLexemes(json));
  } catch {
    return fail('ARTIFACT_MALFORMED');
  }
  if (!isRecord(plain) || !isRecord(lexical) || !shaPattern(plain[idField])) fail('ARTIFACT_MALFORMED');
  const lexicalId = lexical[idField];
  delete lexical[idField];
  const calculated = createHash('sha256').update(lexicalCanonical(lexical), 'utf8').digest('hex');
  if (lexicalId !== plain[idField] || calculated !== plain[idField]) fail('ARTIFACT_DIGEST_INVALID');
  return safeClone(plain);
}

function parseBundle(input: Stage4AArtifactTextBundle): ParsedBundle {
  return {
    manifest: verifyRawSelfDigest(input.candidateManifestJson, 'manifestId'),
    promotion: verifyRawSelfDigest(input.promotionDecisionJson, 'receiptId'),
    seed: verifyRawSelfDigest(input.consumedEvidenceSeedJson, 'seedId'),
    governance: verifyRawSelfDigest(input.governanceContractJson, 'contractId'),
    closure: verifyRawSelfDigest(input.closureAuditJson, 'auditId'),
  };
}

function proofPayload(proof: Omit<ActivationEligibilityProof, 'proofId'>): object { return proof; }

function blockedProof(
  status: EligibilityStatus,
  reasons: readonly ActivationReasonCode[],
  baselineCommit = '',
  bindings: Readonly<Record<string, string>> = {},
  counts = { candidateStrategies: 0, promotionEligible: 0, consumedWindows: 0, consumedEvaluations: 0 },
): ActivationEligibilityProof {
  const body: Omit<ActivationEligibilityProof, 'proofId'> = {
    schemaVersion: ACTIVATION_PROOF_SCHEMA,
    contractVersion: ACTIVATION_CONTRACT_VERSION,
    mode: 'PRODUCTION',
    status,
    reasonCodes: [...new Set(reasons)].sort(),
    baselineCommit,
    identity: null,
    sourceBindings: { ...bindings },
    counts: { ...counts },
    paperApproved: false,
    testnetApproved: false,
    liveApproved: false,
  };
  return immutable({ ...body, proofId: domainId('CloddsBot:ActivationEligibilityProof:v1', proofPayload(body)) });
}

function field(record: Record<string, unknown>, key: string): unknown { return record[key]; }
function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = field(record, key);
  if (!isRecord(value)) fail('ARTIFACT_MALFORMED');
  return value;
}
function arrayField(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = field(record, key);
  if (!Array.isArray(value)) fail('ARTIFACT_MALFORMED');
  return value;
}

function verifyProductionEligibilityUnchecked(inputValue: Stage4AArtifactTextBundle): ActivationEligibilityProof {
  let input: Stage4AArtifactTextBundle;
  try { input = safeClone(inputValue); } catch { return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.ARTIFACT_MALFORMED]); }
  let artifacts: ParsedBundle;
  try { artifacts = parseBundle(input); } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return blockedProof('BLOCKED_INVALID_EVIDENCE', [
      message.includes('DIGEST') ? ACTIVATION_REASONS.ARTIFACT_DIGEST_INVALID : ACTIVATION_REASONS.ARTIFACT_MALFORMED,
    ]);
  }
  const { manifest, promotion, seed, governance, closure } = artifacts;
  const bindings = {
    candidateManifestId: String(manifest.manifestId ?? ''),
    promotionDecisionReceiptId: String(promotion.receiptId ?? ''),
    consumedEvidenceSeedId: String(seed.seedId ?? ''),
    evidenceGovernanceContractId: String(governance.contractId ?? ''),
    stage4AClosureAuditId: String(closure.auditId ?? ''),
  };
  const countsObject = isRecord(promotion.counts) ? promotion.counts : {};
  const counts = {
    candidateStrategies: Number(manifest.candidateCount ?? -1),
    promotionEligible: Number(countsObject.promotionEligible ?? -1),
    consumedWindows: Number(seed.windowCount ?? -1),
    consumedEvaluations: Number(seed.evaluationCount ?? -1),
  };
  const reasons: ActivationReasonCode[] = [];
  const closureBindings = isRecord(closure.artifactBindings) ? closure.artifactBindings : {};
  const approvalValues = [
    isRecord(promotion.approvals) ? promotion.approvals : {}, governance, closure,
  ];
  const expectedSchemas = manifest.schemaVersion === 'stage-4a12.candidate-manifest.v1'
    && promotion.schemaVersion === 'stage-4a12.public-promotion-decision.v1'
    && seed.schemaVersion === 'stage-4a13.consumed-evidence-seed.v1'
    && governance.schemaVersion === 'stage-4a13.governance-contract.v1'
    && closure.schemaVersion === 'stage-4a.closure-audit.v1';
  if (!expectedSchemas) reasons.push(ACTIVATION_REASONS.ARTIFACT_BINDING_MISMATCH);
  if (promotion.candidateManifestId !== manifest.manifestId
      || seed.sourceReceiptId !== promotion.receiptId
      || seed.sourceProofId !== promotion.privateProofId
      || seed.holdoutRunId !== promotion.holdoutRunId
      || closureBindings.candidateManifestId !== manifest.manifestId
      || closureBindings.promotionDecisionReceiptId !== promotion.receiptId
      || closureBindings.consumedEvidenceSeedId !== seed.seedId
      || closureBindings.evidenceGovernanceContractId !== governance.contractId) {
    reasons.push(ACTIVATION_REASONS.ARTIFACT_BINDING_MISMATCH);
  }
  if (closure.stage4AClosed !== true || closure.nextStage !== 'STAGE 4B1 STRATEGY ACTIVATION CONTRACT') {
    reasons.push(ACTIVATION_REASONS.STAGE_4A_NOT_CLOSED);
  }
  if (closure.stage4A14Authorized !== false || String(promotion.engineCommit ?? '').includes('4a14')) {
    reasons.push(ACTIVATION_REASONS.STAGE_4A14_SOURCE_REJECTED);
  }
  const forbiddenApproval = approvalValues.some(value => ['paperApproved', 'testnetApproved', 'liveApproved']
    .some(key => value[key] !== false));
  if (forbiddenApproval || closure.liveExecutionChanges !== false) reasons.push(ACTIVATION_REASONS.ARTIFACT_BINDING_MISMATCH);
  const specs = arrayField(manifest, 'specs');
  const decisions = arrayField(promotion, 'decisions');
  if (!Number.isInteger(counts.candidateStrategies) || counts.candidateStrategies !== specs.length
      || counts.candidateStrategies !== decisions.length || counts.candidateStrategies !== Number(countsObject.candidateStrategiesGenerated)
      || !Number.isInteger(counts.promotionEligible)
      || counts.promotionEligible !== decisions.filter(item => isRecord(item) && item.promotionEligible === true).length
      || counts.consumedWindows !== arrayField(seed, 'windows').length
      || counts.consumedEvaluations !== arrayField(seed, 'evaluations').length) {
    reasons.push(ACTIVATION_REASONS.PROMOTION_COUNT_MISMATCH);
  }
  for (const decisionValue of decisions) {
    if (!isRecord(decisionValue)) { reasons.push(ACTIVATION_REASONS.ARTIFACT_MALFORMED); continue; }
    const spec = specs.find(value => isRecord(value) && value.strategyId === decisionValue.strategyId);
    if (!isRecord(spec) || spec.specId !== decisionValue.specId || spec.label === REFERENCE_FIXTURE_LABEL) {
      reasons.push(ACTIVATION_REASONS.STRATEGY_BINDING_MISMATCH);
    }
  }
  const windows = arrayField(seed, 'windows').filter(isRecord);
  const evaluations = arrayField(seed, 'evaluations').filter(isRecord);
  const windowById = new Map<string, Record<string, unknown>>();
  for (const window of windows) {
    if (!shaPattern(window.windowId) || windowById.has(window.windowId) || window.state !== 'CONSUMED'
        || !shaPattern(window.evidenceFingerprint) || !shaPattern(window.datasetId)) {
      reasons.push(ACTIVATION_REASONS.EVIDENCE_DUPLICATE);
      continue;
    }
    windowById.set(window.windowId, window);
  }
  const evaluationIds = new Set<string>();
  const sourceEvaluationIds = new Set<string>();
  const semanticByStrategy = new Map<string, string>();
  for (const evaluation of evaluations) {
    const spec = specs.find(value => isRecord(value) && value.strategyId === evaluation.strategyId);
    const window = typeof evaluation.windowId === 'string' ? windowById.get(evaluation.windowId) : undefined;
    if (!isRecord(spec) || evaluation.specId !== spec.specId || !shaPattern(evaluation.semanticFingerprint)) {
      reasons.push(ACTIVATION_REASONS.STRATEGY_BINDING_MISMATCH); continue;
    }
    const previousFingerprint = semanticByStrategy.get(String(evaluation.strategyId));
    if (previousFingerprint && previousFingerprint !== evaluation.semanticFingerprint) reasons.push(ACTIVATION_REASONS.EVIDENCE_FOREIGN_FAMILY);
    semanticByStrategy.set(String(evaluation.strategyId), evaluation.semanticFingerprint);
    const expectedEvaluationId = canonicalSha256({
      semanticFingerprint: evaluation.semanticFingerprint,
      evidenceFingerprint: evaluation.evidenceFingerprint,
    });
    if (!window || evaluation.evidenceFingerprint !== window.evidenceFingerprint
        || evaluation.datasetId !== window.datasetId || evaluation.opensAt !== window.opensAt
        || evaluation.closesAt !== window.closesAt || evaluation.evaluationId !== expectedEvaluationId
        || evaluation.state !== 'CONSUMED' || evaluation.evaluationCount !== 1 || !shaPattern(evaluation.resultDigest)) {
      reasons.push(ACTIVATION_REASONS.EVIDENCE_BINDING_INCOMPLETE);
    }
    if (!shaPattern(evaluation.evaluationId) || evaluationIds.has(evaluation.evaluationId)
        || !shaPattern(evaluation.sourceEvaluationId) || sourceEvaluationIds.has(evaluation.sourceEvaluationId)) {
      reasons.push(ACTIVATION_REASONS.EVIDENCE_DUPLICATE);
    }
    if (typeof evaluation.evaluationId === 'string') evaluationIds.add(evaluation.evaluationId);
    if (typeof evaluation.sourceEvaluationId === 'string') sourceEvaluationIds.add(evaluation.sourceEvaluationId);
  }
  if (specs.some(spec => !isRecord(spec) || evaluations.filter(event => event.strategyId === spec.strategyId).length !== 10)) {
    reasons.push(ACTIVATION_REASONS.EVIDENCE_BINDING_MISSING);
  }
  if (reasons.length > 0) return blockedProof('BLOCKED_INVALID_EVIDENCE', reasons, String(closure.baselineCommit ?? ''), bindings, counts);
  if (counts.promotionEligible === 0) {
    return blockedProof('BLOCKED_NO_PROMOTED_STRATEGY', [ACTIVATION_REASONS.NO_PROMOTED_STRATEGY], String(closure.baselineCommit ?? ''), bindings, counts);
  }
  if (counts.promotionEligible !== 1) return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.PROMOTION_COUNT_MISMATCH], String(closure.baselineCommit ?? ''), bindings, counts);
  return verifyPromotedCandidateEvidence(artifacts, bindings, counts);
}

/** Fail-closed production verification over exact serialized Stage 4A artifacts. */
export function verifyProductionEligibility(inputValue: Stage4AArtifactTextBundle): ActivationEligibilityProof {
  try {
    return verifyProductionEligibilityUnchecked(inputValue);
  } catch {
    return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.ARTIFACT_MALFORMED]);
  }
}

function verifyPromotedCandidateEvidence(
  artifacts: ParsedBundle,
  bindings: Readonly<Record<string, string>>,
  counts: ActivationEligibilityProof['counts'],
): ActivationEligibilityProof {
  const specs = arrayField(artifacts.manifest, 'specs').filter(isRecord);
  const decisions = arrayField(artifacts.promotion, 'decisions').filter(isRecord);
  const candidate = decisions.find(item => item.promotionEligible === true);
  const spec = specs.find(item => item.strategyId === candidate?.strategyId);
  if (!candidate || !spec) return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.STRATEGY_BINDING_MISMATCH]);
  const required = ['strategyId', 'specId', 'version', 'semanticFingerprint', 'lineageId'];
  const identityRaw = {
    strategyId: candidate.strategyId,
    specId: candidate.specId,
    strategyVersion: candidate.strategyVersion ?? spec.version,
    semanticFingerprint: candidate.semanticFingerprint,
    lineageId: candidate.lineageId,
  };
  if (required.some((_, index) => !nonEmpty(Object.values(identityRaw)[index]))) {
    return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.STRATEGY_BINDING_MISMATCH]);
  }
  const identity = identityRaw as ActivationIdentity;
  if (identity.specId !== spec.specId || identity.strategyVersion !== spec.version) {
    return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.STRATEGY_BINDING_MISMATCH]);
  }
  const evaluations = arrayField(artifacts.seed, 'evaluations').filter(isRecord);
  const matching = evaluations.filter(event => event.semanticFingerprint === identity.semanticFingerprint);
  const seen = new Set<string>();
  if (matching.length === 0) return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.EVIDENCE_BINDING_MISSING]);
  for (const event of matching) {
    if (event.strategyId !== identity.strategyId || event.specId !== identity.specId) {
      return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.EVIDENCE_RELABELLED]);
    }
    if (event.state !== 'CONSUMED' || event.evaluationCount !== 1 || !shaPattern(event.resultDigest)) {
      return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.EVIDENCE_BINDING_INCOMPLETE]);
    }
    const key = `${String(event.semanticFingerprint)}:${String(event.evidenceFingerprint)}`;
    if (seen.has(key)) return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.EVIDENCE_DUPLICATE]);
    seen.add(key);
  }
  const foreign = evaluations.some(event => event.strategyId === identity.strategyId && event.semanticFingerprint !== identity.semanticFingerprint);
  if (foreign) return blockedProof('BLOCKED_INVALID_EVIDENCE', [ACTIVATION_REASONS.EVIDENCE_FOREIGN_FAMILY]);
  const body: Omit<ActivationEligibilityProof, 'proofId'> = {
    schemaVersion: ACTIVATION_PROOF_SCHEMA, contractVersion: ACTIVATION_CONTRACT_VERSION, mode: 'PRODUCTION',
    status: 'ELIGIBLE_FOR_ACTIVATION_REVIEW', reasonCodes: [], baselineCommit: String(artifacts.closure.baselineCommit),
    identity: { ...identity }, sourceBindings: { ...bindings }, counts: { ...counts },
    paperApproved: false, testnetApproved: false, liveApproved: false,
  };
  return immutable({ ...body, proofId: domainId('CloddsBot:ActivationEligibilityProof:v1', body) });
}

function assertProductionProof(proof: ActivationEligibilityProof): void {
  const { proofId: _proofId, ...body } = proof;
  if (proof.mode !== 'PRODUCTION' || proof.status !== 'ELIGIBLE_FOR_ACTIVATION_REVIEW'
      || !proof.identity || proof.proofId !== domainId('CloddsBot:ActivationEligibilityProof:v1', proofPayload(body))) {
    fail('ACTIVATION_REQUEST_REJECTED');
  }
}

export function createActivationRequest(
  proofInput: ActivationEligibilityProof,
  issuedAt: string,
  expiresAt: string,
): ActivationRequest {
  const proof = safeClone(proofInput);
  assertProductionProof(proof);
  if (!canonicalIso(issuedAt) || !canonicalIso(expiresAt) || Date.parse(expiresAt) <= Date.parse(issuedAt)) fail('ACTIVATION_REQUEST_INVALID');
  const body: Omit<ActivationRequest, 'requestId'> = {
    schemaVersion: ACTIVATION_REQUEST_SCHEMA,
    eligibilityProofId: proof.proofId,
    identity: safeClone(proof.identity!),
    requestedScope: REQUESTED_SCOPE,
    issuedAt,
    expiresAt,
  };
  return immutable({ ...body, requestId: domainId('CloddsBot:ActivationRequest:v1', body) });
}

export function makeActivationApprovalSigningPayload(statementInput: ActivationApprovalStatement): Buffer {
  const statement = safeClone(statementInput);
  return Buffer.from(canonicalJson({ domain: APPROVAL_DOMAIN, statement }), 'utf8');
}

function decision(
  mode: ActivationDecision['mode'], status: ActivationDecision['status'], reasons: readonly ActivationReasonCode[],
  proofId: string, requestId: string | null, approvers: readonly string[] = [],
): ActivationDecision {
  const body: Omit<ActivationDecision, 'decisionId'> = {
    schemaVersion: ACTIVATION_DECISION_SCHEMA, contractVersion: ACTIVATION_CONTRACT_VERSION, mode, status,
    reasonCodes: [...new Set(reasons)].sort(), eligibilityProofId: proofId, requestId,
    requestedScope: requestId ? REQUESTED_SCOPE : null, verifiedApproverIds: [...approvers].sort(),
    paperApproved: false, testnetApproved: false, liveApproved: false,
  };
  return immutable({ ...body, decisionId: domainId('CloddsBot:ActivationDecision:v1', body) });
}

function trustedKeys(entries: readonly TrustedActivationApprover[]): Map<string, TrustedActivationApprover & { key: KeyObject }> {
  const result = new Map<string, TrustedActivationApprover & { key: KeyObject }>();
  for (const entry of safeClone(entries)) {
    if (!nonEmpty(entry.approverId) || !nonEmpty(entry.keyId) || typeof entry.publicKeyPem !== 'string' || entry.publicKeyPem.trim().length === 0
        || entry.publicKeyPem.includes('PRIVATE KEY') || result.has(entry.keyId)) fail('ACTIVATION_APPROVER_POLICY_INVALID');
    let key: KeyObject;
    try { key = createPublicKey(entry.publicKeyPem); } catch { return fail('ACTIVATION_APPROVER_POLICY_INVALID'); }
    if (key.asymmetricKeyType !== 'ed25519') fail('ACTIVATION_APPROVER_POLICY_INVALID');
    result.set(entry.keyId, { ...entry, key });
  }
  return result;
}

export function evaluateActivationDecision(
  proofInput: ActivationEligibilityProof,
  requestInput: ActivationRequest | null,
  approvalsInput: readonly ActivationApproval[],
  trustedInput: readonly TrustedActivationApprover[],
  nowMs: number,
  consumedRequestIds: readonly string[] = [],
): ActivationDecision {
  let proof: ActivationEligibilityProof;
  try { proof = safeClone(proofInput); } catch { return decision('PRODUCTION', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.REQUEST_INVALID], '', null); }
  if (proof.mode !== 'PRODUCTION') return decision('PRODUCTION', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.REFERENCE_FIXTURE_REJECTED], proof.proofId ?? '', requestInput?.requestId ?? null);
  if (proof.status !== 'ELIGIBLE_FOR_ACTIVATION_REVIEW' || !proof.identity) {
    return decision('PRODUCTION', 'ACTIVATION_BLOCKED', proof.reasonCodes.length ? proof.reasonCodes : [ACTIVATION_REASONS.PROMOTION_FALSE], proof.proofId, null);
  }
  if (!requestInput) return decision('PRODUCTION', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.APPROVAL_MISSING], proof.proofId, null);
  let request: ActivationRequest;
  let approvals: readonly ActivationApproval[];
  try { request = safeClone(requestInput); approvals = safeClone(approvalsInput); } catch {
    return decision('PRODUCTION', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.REQUEST_INVALID], proof.proofId, null);
  }
  const requestId = domainId('CloddsBot:ActivationRequest:v1', (({ requestId: _, ...body }) => body)(request));
  if (request.schemaVersion !== ACTIVATION_REQUEST_SCHEMA || request.requestId !== requestId
      || request.eligibilityProofId !== proof.proofId || canonicalJson(request.identity) !== canonicalJson(proof.identity)
      || request.requestedScope !== REQUESTED_SCOPE || !canonicalIso(request.issuedAt) || !canonicalIso(request.expiresAt)) {
    return decision('PRODUCTION', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.REQUEST_BINDING_MISMATCH], proof.proofId, request.requestId ?? null);
  }
  if (consumedRequestIds.includes(request.requestId)) return decision('PRODUCTION', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.REPLAY_REJECTED], proof.proofId, request.requestId);
  if (!Number.isFinite(nowMs) || nowMs < Date.parse(request.issuedAt) || nowMs >= Date.parse(request.expiresAt)) {
    return decision('PRODUCTION', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.REQUEST_INVALID], proof.proofId, request.requestId);
  }
  if (!Array.isArray(approvals) || approvals.length === 0) return decision('PRODUCTION', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.APPROVAL_MISSING], proof.proofId, request.requestId);
  let keys: Map<string, TrustedActivationApprover & { key: KeyObject }>;
  try { keys = trustedKeys(trustedInput); } catch { return decision('PRODUCTION', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.APPROVAL_UNTRUSTED_KEY], proof.proofId, request.requestId); }
  const reasons: ActivationReasonCode[] = [];
  const seen = new Set<string>();
  const verified: string[] = [];
  for (const approvalValue of approvals as readonly unknown[]) {
    if (!isRecord(approvalValue) || !nonEmpty(approvalValue.approverId) || !nonEmpty(approvalValue.keyId)
        || !nonEmpty(approvalValue.signature)) { reasons.push(ACTIVATION_REASONS.APPROVAL_MALFORMED); continue; }
    const approval = approvalValue as unknown as ActivationApproval;
    if (seen.has(approval.approverId)) { reasons.push(ACTIVATION_REASONS.APPROVAL_DUPLICATE_APPROVER); continue; }
    seen.add(approval.approverId);
    const key = keys.get(approval.keyId);
    if (!key || key.approverId !== approval.approverId) { reasons.push(ACTIVATION_REASONS.APPROVAL_UNTRUSTED_KEY); continue; }
    const statement = (({ signature: _signature, ...body }) => body)(approval) as ActivationApprovalStatement;
    if (statement.schemaVersion !== ACTIVATION_APPROVAL_SCHEMA || statement.eligibilityProofId !== proof.proofId
        || statement.requestId !== request.requestId || canonicalJson(statement.identity) !== canonicalJson(proof.identity)
        || statement.requestedScope !== REQUESTED_SCOPE) { reasons.push(ACTIVATION_REASONS.APPROVAL_BINDING_MISMATCH); continue; }
    if (!canonicalIso(statement.issuedAt) || !canonicalIso(statement.expiresAt) || Date.parse(statement.expiresAt) <= Date.parse(statement.issuedAt)) {
      reasons.push(ACTIVATION_REASONS.APPROVAL_MALFORMED); continue;
    }
    if (nowMs < Date.parse(statement.issuedAt)) { reasons.push(ACTIVATION_REASONS.APPROVAL_NOT_YET_VALID); continue; }
    if (nowMs >= Date.parse(statement.expiresAt)) { reasons.push(ACTIVATION_REASONS.APPROVAL_EXPIRED); continue; }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(approval.signature) || approval.signature.length % 4 !== 0) {
      reasons.push(ACTIVATION_REASONS.APPROVAL_MALFORMED); continue;
    }
    const signature = Buffer.from(approval.signature, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== approval.signature
        || !verifySignature(null, makeActivationApprovalSigningPayload(statement), key.key, signature)) {
      reasons.push(ACTIVATION_REASONS.APPROVAL_SIGNATURE_INVALID); continue;
    }
    verified.push(approval.approverId);
  }
  if (reasons.length > 0 || verified.length === 0) return decision('PRODUCTION', 'ACTIVATION_BLOCKED', reasons.length ? reasons : [ACTIVATION_REASONS.APPROVAL_MISSING], proof.proofId, request.requestId, verified);
  return decision('PRODUCTION', 'ACTIVATION_REVIEW_READY', [], proof.proofId, request.requestId, verified);
}

export interface ReferenceEligibilityFixture {
  readonly label: typeof REFERENCE_FIXTURE_LABEL;
  readonly identity: ActivationIdentity;
  readonly evidence: readonly {
    readonly strategyId: string; readonly specId: string; readonly strategyVersion: string;
    readonly semanticFingerprint: string; readonly lineageId: string; readonly evidenceFingerprint: string;
    readonly resultDigest: string; readonly state: 'CONSUMED'; readonly evaluationCount: 1;
  }[];
}

/** Test-only semantic oracle. Its REFERENCE mode is explicitly rejected by production decision APIs. */
export function verifyReferenceEligibilityFixture(inputValue: ReferenceEligibilityFixture): ActivationEligibilityProof {
  const input = safeClone(inputValue);
  if (input.label !== REFERENCE_FIXTURE_LABEL || !input.identity || input.evidence.length < 1) fail('REFERENCE_FIXTURE_INVALID');
  const seen = new Set<string>();
  for (const event of input.evidence) {
    if (event.strategyId !== input.identity.strategyId || event.specId !== input.identity.specId
        || event.strategyVersion !== input.identity.strategyVersion || event.semanticFingerprint !== input.identity.semanticFingerprint
        || event.lineageId !== input.identity.lineageId) fail('REFERENCE_FIXTURE_FOREIGN_OR_RELABELLED');
    if (event.state !== 'CONSUMED' || event.evaluationCount !== 1 || !shaPattern(event.evidenceFingerprint) || !shaPattern(event.resultDigest)) {
      fail('REFERENCE_FIXTURE_EVIDENCE_INCOMPLETE');
    }
    const evaluationIdentity = `${event.semanticFingerprint}:${event.evidenceFingerprint}`;
    if (seen.has(evaluationIdentity)) fail('REFERENCE_FIXTURE_EVIDENCE_DUPLICATE');
    seen.add(evaluationIdentity);
  }
  const body: Omit<ActivationEligibilityProof, 'proofId'> = {
    schemaVersion: ACTIVATION_PROOF_SCHEMA, contractVersion: ACTIVATION_CONTRACT_VERSION, mode: 'REFERENCE',
    status: 'REFERENCE_CONTRACT_VERIFIED', reasonCodes: [], baselineCommit: '', identity: safeClone(input.identity),
    sourceBindings: {}, counts: { candidateStrategies: 1, promotionEligible: 0, consumedWindows: input.evidence.length, consumedEvaluations: input.evidence.length },
    paperApproved: false, testnetApproved: false, liveApproved: false,
  };
  return immutable({ ...body, proofId: domainId('CloddsBot:ReferenceActivationEligibilityProof:v1', body) });
}

export interface ReferenceActivationRequest {
  readonly schemaVersion: 'stage-4b1.reference-activation-request.v1';
  readonly label: typeof REFERENCE_FIXTURE_LABEL;
  readonly eligibilityProofId: string;
  readonly identity: ActivationIdentity;
  readonly requestedScope: typeof REQUESTED_SCOPE;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly requestId: string;
}

export interface ReferenceActivationApproval {
  readonly schemaVersion: 'stage-4b1.reference-activation-approval.v1';
  readonly label: typeof REFERENCE_FIXTURE_LABEL;
  readonly eligibilityProofId: string;
  readonly requestId: string;
  readonly identity: ActivationIdentity;
  readonly requestedScope: typeof REQUESTED_SCOPE;
  readonly approverId: string;
  readonly keyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export function createReferenceActivationRequest(
  proofInput: ActivationEligibilityProof,
  issuedAt: string,
  expiresAt: string,
): ReferenceActivationRequest {
  const proof = safeClone(proofInput);
  if (proof.mode !== 'REFERENCE' || proof.status !== 'REFERENCE_CONTRACT_VERIFIED' || !proof.identity
      || !canonicalIso(issuedAt) || !canonicalIso(expiresAt) || Date.parse(expiresAt) <= Date.parse(issuedAt)) fail('REFERENCE_REQUEST_INVALID');
  const body: Omit<ReferenceActivationRequest, 'requestId'> = {
    schemaVersion: 'stage-4b1.reference-activation-request.v1', label: REFERENCE_FIXTURE_LABEL,
    eligibilityProofId: proof.proofId, identity: safeClone(proof.identity), requestedScope: REQUESTED_SCOPE,
    issuedAt, expiresAt,
  };
  return immutable({ ...body, requestId: domainId('CloddsBot:ReferenceActivationRequest:v1', body) });
}

export function makeReferenceApprovalSigningPayload(statementInput: Omit<ReferenceActivationApproval, 'signature'>): Buffer {
  return Buffer.from(canonicalJson({ domain: 'CloddsBot:ReferenceActivationApproval:v1', statement: safeClone(statementInput) }), 'utf8');
}

/** Exercises detached-signature wiring without producing a production-compatible decision. */
export function evaluateReferenceContractDecision(
  proofInput: ActivationEligibilityProof,
  requestInput: ReferenceActivationRequest,
  approvalsInput: readonly ReferenceActivationApproval[],
  trustedInput: readonly TrustedActivationApprover[],
  nowMs: number,
): ActivationDecision {
  const proof = safeClone(proofInput);
  const request = safeClone(requestInput);
  const approvals = safeClone(approvalsInput);
  if (proof.mode !== 'REFERENCE' || proof.status !== 'REFERENCE_CONTRACT_VERIFIED' || !proof.identity
      || request.label !== REFERENCE_FIXTURE_LABEL || request.schemaVersion !== 'stage-4b1.reference-activation-request.v1') {
    return decision('REFERENCE', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.REFERENCE_FIXTURE_REJECTED], proof.proofId ?? '', request.requestId ?? null);
  }
  const requestBody = (({ requestId: _requestId, ...body }) => body)(request);
  if (request.requestId !== domainId('CloddsBot:ReferenceActivationRequest:v1', requestBody)
      || request.eligibilityProofId !== proof.proofId || canonicalJson(request.identity) !== canonicalJson(proof.identity)
      || request.requestedScope !== REQUESTED_SCOPE || !canonicalIso(request.issuedAt) || !canonicalIso(request.expiresAt)
      || nowMs < Date.parse(request.issuedAt) || nowMs >= Date.parse(request.expiresAt)) {
    return decision('REFERENCE', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.REQUEST_BINDING_MISMATCH], proof.proofId, request.requestId);
  }
  let keys: Map<string, TrustedActivationApprover & { key: KeyObject }>;
  try { keys = trustedKeys(trustedInput); } catch { return decision('REFERENCE', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.APPROVAL_UNTRUSTED_KEY], proof.proofId, request.requestId); }
  if (!Array.isArray(approvals) || approvals.length === 0) return decision('REFERENCE', 'ACTIVATION_BLOCKED', [ACTIVATION_REASONS.APPROVAL_MISSING], proof.proofId, request.requestId);
  const reasons: ActivationReasonCode[] = [];
  const seen = new Set<string>();
  const verified: string[] = [];
  for (const approval of approvals) {
    if (approval.label !== REFERENCE_FIXTURE_LABEL || approval.schemaVersion !== 'stage-4b1.reference-activation-approval.v1'
        || !nonEmpty(approval.approverId) || !nonEmpty(approval.keyId) || !nonEmpty(approval.signature)) {
      reasons.push(ACTIVATION_REASONS.APPROVAL_MALFORMED); continue;
    }
    if (seen.has(approval.approverId)) { reasons.push(ACTIVATION_REASONS.APPROVAL_DUPLICATE_APPROVER); continue; }
    seen.add(approval.approverId);
    const key = keys.get(approval.keyId);
    if (!key || key.approverId !== approval.approverId) { reasons.push(ACTIVATION_REASONS.APPROVAL_UNTRUSTED_KEY); continue; }
    const statement = (({ signature: _signature, ...body }) => body)(approval);
    if (statement.eligibilityProofId !== proof.proofId || statement.requestId !== request.requestId
        || canonicalJson(statement.identity) !== canonicalJson(proof.identity) || statement.requestedScope !== REQUESTED_SCOPE) {
      reasons.push(ACTIVATION_REASONS.APPROVAL_BINDING_MISMATCH); continue;
    }
    if (!canonicalIso(statement.issuedAt) || !canonicalIso(statement.expiresAt)) { reasons.push(ACTIVATION_REASONS.APPROVAL_MALFORMED); continue; }
    if (nowMs < Date.parse(statement.issuedAt)) { reasons.push(ACTIVATION_REASONS.APPROVAL_NOT_YET_VALID); continue; }
    if (nowMs >= Date.parse(statement.expiresAt)) { reasons.push(ACTIVATION_REASONS.APPROVAL_EXPIRED); continue; }
    const signature = Buffer.from(approval.signature, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== approval.signature
        || !verifySignature(null, makeReferenceApprovalSigningPayload(statement), key.key, signature)) {
      reasons.push(ACTIVATION_REASONS.APPROVAL_SIGNATURE_INVALID); continue;
    }
    verified.push(approval.approverId);
  }
  return reasons.length === 0 && verified.length > 0
    ? decision('REFERENCE', 'REFERENCE_CONTRACT_VERIFIED', [], proof.proofId, request.requestId, verified)
    : decision('REFERENCE', 'ACTIVATION_BLOCKED', reasons.length ? reasons : [ACTIVATION_REASONS.APPROVAL_MISSING], proof.proofId, request.requestId, verified);
}

const TRANSITIONS: Readonly<Record<ActivationState, readonly ActivationState[]>> = {
  INACTIVE: ['ELIGIBILITY_CHECKED'],
  ELIGIBILITY_CHECKED: ['ACTIVATION_REQUESTED', 'ACTIVATION_BLOCKED'],
  ACTIVATION_REQUESTED: ['ACTIVATION_REVIEW_READY', 'ACTIVATION_BLOCKED'],
  ACTIVATION_BLOCKED: [],
  ACTIVATION_REVIEW_READY: [],
};

export class ActivationStateMachine {
  #state: ActivationState = 'INACTIVE';
  #requestIds = new Set<string>();
  get state(): ActivationState { return this.#state; }
  transition(next: ActivationState, requestId?: string): ActivationState {
    if (TRANSITIONS[this.#state].length === 0) fail(`ACTIVATION_STATE_ERROR:${ACTIVATION_REASONS.TERMINAL_STATE}`);
    if (!TRANSITIONS[this.#state].includes(next)) fail(`ACTIVATION_STATE_ERROR:${ACTIVATION_REASONS.INVALID_TRANSITION}`);
    if (next === 'ACTIVATION_REQUESTED') {
      if (!nonEmpty(requestId) || this.#requestIds.has(requestId)) fail(`ACTIVATION_STATE_ERROR:${ACTIVATION_REASONS.REPLAY_REJECTED}`);
      this.#requestIds.add(requestId);
    } else if (requestId && !this.#requestIds.has(requestId)) fail(`ACTIVATION_STATE_ERROR:${ACTIVATION_REASONS.REQUEST_BINDING_MISMATCH}`);
    this.#state = next;
    return this.#state;
  }
}

export interface ActivationAuditEvent {
  readonly schemaVersion: 'stage-4b1.activation-audit-event.v1';
  readonly sequence: number;
  readonly timestamp: string;
  readonly previousEventId: string | null;
  readonly fromState: ActivationState | null;
  readonly toState: ActivationState;
  readonly eventType: 'ROOT' | 'TRANSITION';
  readonly payloadDigest: string;
  readonly requestId: string | null;
  readonly eventId: string;
}

function auditEventId(event: Omit<ActivationAuditEvent, 'eventId'>): string { return domainId('CloddsBot:ActivationAuditEvent:v1', event); }

export class AppendOnlyActivationAudit {
  #events: ActivationAuditEvent[];
  constructor(eventsInput: readonly ActivationAuditEvent[] = [], expectedTipId?: string) {
    this.#events = safeClone(eventsInput) as ActivationAuditEvent[];
    this.validate(expectedTipId);
  }
  get events(): readonly ActivationAuditEvent[] { return immutable(safeClone(this.#events)); }
  get tipId(): string | null { return this.#events.at(-1)?.eventId ?? null; }
  append(inputValue: {
    timestamp: string; fromState: ActivationState | null; toState: ActivationState;
    eventType: 'ROOT' | 'TRANSITION'; payload: unknown; requestId?: string | null;
  }): ActivationAuditEvent {
    this.validate();
    const input = safeClone(inputValue);
    if (!canonicalIso(input.timestamp)) fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.AUDIT_INVALID}`);
    const sequence = this.#events.length;
    const previous = this.#events.at(-1);
    if (sequence === 0) {
      if (input.eventType !== 'ROOT' || input.fromState !== null || input.toState !== 'INACTIVE') fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.INVALID_TRANSITION}`);
    } else {
      if (input.eventType !== 'TRANSITION' || input.fromState !== previous!.toState
          || !TRANSITIONS[input.fromState].includes(input.toState)) fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.INVALID_TRANSITION}`);
      if (input.toState === 'ACTIVATION_REQUESTED' && (!nonEmpty(input.requestId) || this.#events.some(event => event.requestId === input.requestId))) {
        fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.REPLAY_REJECTED}`);
      }
      if (input.requestId && input.toState !== 'ACTIVATION_REQUESTED'
          && !this.#events.some(event => event.requestId === input.requestId)) fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.REQUEST_BINDING_MISMATCH}`);
    }
    const body: Omit<ActivationAuditEvent, 'eventId'> = {
      schemaVersion: 'stage-4b1.activation-audit-event.v1', sequence, timestamp: input.timestamp,
      previousEventId: previous?.eventId ?? null, fromState: input.fromState, toState: input.toState,
      eventType: input.eventType, payloadDigest: domainId('CloddsBot:ActivationAuditPayload:v1', input.payload),
      requestId: input.requestId ?? null,
    };
    const event = immutable({ ...body, eventId: auditEventId(body) });
    this.#events.push(event);
    return event;
  }
  validate(expectedTipId?: string): void {
    const requests = new Set<string>();
    for (let index = 0; index < this.#events.length; index++) {
      const event = this.#events[index];
      const previous = this.#events[index - 1];
      const body = (({ eventId: _, ...rest }) => rest)(event);
      if (event.schemaVersion !== 'stage-4b1.activation-audit-event.v1' || event.sequence !== index
          || event.previousEventId !== (previous?.eventId ?? null) || event.eventId !== auditEventId(body)
          || !canonicalIso(event.timestamp) || !shaPattern(event.payloadDigest)) fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.AUDIT_INVALID}`);
      if (index === 0) {
        if (event.eventType !== 'ROOT' || event.fromState !== null || event.toState !== 'INACTIVE') fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.INVALID_TRANSITION}`);
      } else if (event.eventType !== 'TRANSITION' || event.fromState !== previous.toState || !TRANSITIONS[event.fromState].includes(event.toState)) {
        fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.INVALID_TRANSITION}`);
      }
      if (event.requestId) {
        if (event.toState === 'ACTIVATION_REQUESTED') {
          if (requests.has(event.requestId)) fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.REPLAY_REJECTED}`);
          requests.add(event.requestId);
        } else if (!requests.has(event.requestId)) fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.REQUEST_BINDING_MISMATCH}`);
      }
    }
    if (expectedTipId !== undefined && this.tipId !== expectedTipId) fail(`ACTIVATION_AUDIT_ERROR:${ACTIVATION_REASONS.AUDIT_INVALID}`);
  }
}

export function createRealBlockedAudit(proof: ActivationEligibilityProof, timestamp: string): AppendOnlyActivationAudit {
  if (proof.mode !== 'PRODUCTION' || proof.status !== 'BLOCKED_NO_PROMOTED_STRATEGY') fail('REAL_BLOCKED_AUDIT_PROOF_INVALID');
  const audit = new AppendOnlyActivationAudit();
  audit.append({ timestamp, fromState: null, toState: 'INACTIVE', eventType: 'ROOT', payload: { contractVersion: ACTIVATION_CONTRACT_VERSION } });
  audit.append({ timestamp, fromState: 'INACTIVE', toState: 'ELIGIBILITY_CHECKED', eventType: 'TRANSITION', payload: { proofId: proof.proofId } });
  audit.append({ timestamp, fromState: 'ELIGIBILITY_CHECKED', toState: 'ACTIVATION_BLOCKED', eventType: 'TRANSITION', payload: { proofId: proof.proofId, reasonCodes: proof.reasonCodes } });
  return audit;
}
