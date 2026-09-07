/**
 * Phase 10 deterministic evidence aggregation.
 *
 * This gate reverifies exact artifact content where an existing in-memory
 * verifier is available and rejects unauthenticated workflow summaries. It
 * grants no Paper, Testnet, Live, or production authority and performs no I/O.
 */
import { createHash } from 'node:crypto';
import {
  REFERENCE_PROOF_CONTRACT_VERSION,
  verifyReferenceInfrastructureProof,
} from './ReferenceInfrastructureProof';
import {
  STAGE_4B2_RECEIPT_SCHEMA,
  verifyStage4B2Receipt,
} from './PaperReadinessReview';
import {
  RECEIPT_4B3_SCHEMA,
  type Stage4B3Receipt,
  verifyStage4B3Receipt,
} from './RuntimeSafety';
import { SHADOW_RUNTIME_PROOF_SCHEMA_VERSION } from '../shadow/ShadowRuntimeProof';

export const PRODUCTION_READINESS_EVIDENCE_FAMILIES = Object.freeze([
  'CI',
  'SECURITY',
  'REFERENCE_INFRASTRUCTURE_PROOF',
  'INDICATOR_ASSET_READINESS_PROOF',
  'STAGE_4B2_PAPER_READINESS_RECEIPT',
  'STAGE_4B3_SAFETY_RECEIPT',
  'STAGE_4B4_SHADOW_RUNTIME_PROOF',
] as const);

export type ProductionReadinessEvidenceFamily =
  typeof PRODUCTION_READINESS_EVIDENCE_FAMILIES[number];

export type ProductionReadinessState =
  | 'EVIDENCE_INVALID'
  | 'BLOCKED'
  | 'READY_FOR_ACTIVATION_DECISION';

export const PRODUCTION_READINESS_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000;

interface ExactHeadWorkflowObservationBase {
  readonly family: ProductionReadinessEvidenceFamily;
  readonly headSha: string;
  readonly workflow: string;
  readonly runId: number;
  readonly status: 'COMPLETED' | 'IN_PROGRESS' | 'UNKNOWN';
  readonly conclusion: 'SUCCESS' | 'FAILURE' | 'CANCELLED' | 'UNKNOWN';
  readonly completedAt: string;
  readonly validUntil: string;
}

export interface CiEvidenceObservation extends ExactHeadWorkflowObservationBase {
  readonly family: 'CI';
}

export interface SecurityExceptionObservation {
  readonly advisoryId: string;
  readonly package: string;
  readonly expiresAt: string;
}

export interface SecurityEvidenceObservation extends ExactHeadWorkflowObservationBase {
  readonly family: 'SECURITY';
  readonly exceptions: readonly SecurityExceptionObservation[];
}

interface ExistingArtifactEvidenceObservationBase extends ExactHeadWorkflowObservationBase {
  readonly artifactContract: string;
  readonly artifactSha256: string;
  readonly artifactJson: string;
}

export interface ReferenceInfrastructureEvidenceObservation
  extends ExistingArtifactEvidenceObservationBase {
  readonly family: 'REFERENCE_INFRASTRUCTURE_PROOF';
}

export interface IndicatorAssetReadinessEvidenceObservation
  extends ExistingArtifactEvidenceObservationBase {
  readonly family: 'INDICATOR_ASSET_READINESS_PROOF';
}

export interface Stage4B2EvidenceObservation extends ExistingArtifactEvidenceObservationBase {
  readonly family: 'STAGE_4B2_PAPER_READINESS_RECEIPT';
  readonly stage4AClosureAuditId: string;
  readonly stage4B1ArtifactJson: string;
}

export interface Stage4B3EvidenceObservation extends ExistingArtifactEvidenceObservationBase {
  readonly family: 'STAGE_4B3_SAFETY_RECEIPT';
  readonly stage4B2ReceiptJson: string;
}

export interface Stage4B4EvidenceObservation extends ExistingArtifactEvidenceObservationBase {
  readonly family: 'STAGE_4B4_SHADOW_RUNTIME_PROOF';
}

export type ExistingArtifactEvidenceObservation =
  | ReferenceInfrastructureEvidenceObservation
  | IndicatorAssetReadinessEvidenceObservation
  | Stage4B2EvidenceObservation
  | Stage4B3EvidenceObservation
  | Stage4B4EvidenceObservation;

export type ProductionReadinessEvidenceObservation =
  | CiEvidenceObservation
  | SecurityEvidenceObservation
  | ExistingArtifactEvidenceObservation;

export interface ProductionReadinessEvidenceInput {
  readonly candidateHead: string;
  readonly evaluationTime: string;
  readonly evidence: readonly ProductionReadinessEvidenceObservation[];
}

export interface ProductionReadinessEvidenceResult {
  readonly candidateHead: string;
  readonly state: ProductionReadinessState;
  readonly evidenceValid: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly activationDecisionEligible: boolean;
  readonly productionAuthority: false;
  readonly testnetAuthority: false;
  readonly liveAuthority: false;
}

const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GHSA = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CHECK_KEYS = Object.freeze([
  'completedAt', 'conclusion', 'family', 'headSha', 'runId', 'status', 'validUntil', 'workflow',
]);
const ARTIFACT_KEYS = Object.freeze([
  ...CHECK_KEYS, 'artifactContract', 'artifactJson', 'artifactSha256',
].sort());
const STAGE_4B2_KEYS = Object.freeze([
  ...ARTIFACT_KEYS, 'stage4AClosureAuditId', 'stage4B1ArtifactJson',
].sort());
const STAGE_4B3_KEYS = Object.freeze([...ARTIFACT_KEYS, 'stage4B2ReceiptJson'].sort());
const SECURITY_KEYS = Object.freeze([...CHECK_KEYS, 'exceptions'].sort());
const INPUT_KEYS = Object.freeze(['candidateHead', 'evaluationTime', 'evidence']);
const EXCEPTION_KEYS = Object.freeze(['advisoryId', 'expiresAt', 'package']);

const EXPECTED = Object.freeze({
  CI: Object.freeze({ workflow: '.github/workflows/ci.yml', contract: null }),
  SECURITY: Object.freeze({ workflow: '.github/workflows/security.yml', contract: null }),
  REFERENCE_INFRASTRUCTURE_PROOF: Object.freeze({
    workflow: '.github/workflows/reference-infrastructure-proof.yml',
    contract: REFERENCE_PROOF_CONTRACT_VERSION,
  }),
  INDICATOR_ASSET_READINESS_PROOF: Object.freeze({
    workflow: '.github/workflows/indicator-asset-readiness.yml',
    contract: 'stage-4a9.asset-readiness.v1',
  }),
  STAGE_4B2_PAPER_READINESS_RECEIPT: Object.freeze({
    workflow: '.github/workflows/stage-4b2-receipt.yml',
    contract: STAGE_4B2_RECEIPT_SCHEMA,
  }),
  STAGE_4B3_SAFETY_RECEIPT: Object.freeze({
    workflow: '.github/workflows/stage-4b3-receipt.yml',
    contract: RECEIPT_4B3_SCHEMA,
  }),
  STAGE_4B4_SHADOW_RUNTIME_PROOF: Object.freeze({
    workflow: '.github/workflows/stage-4b4-shadow-proof.yml',
    contract: SHADOW_RUNTIME_PROOF_SCHEMA_VERSION,
  }),
} satisfies Record<ProductionReadinessEvidenceFamily, { readonly workflow: string; readonly contract: string | null }>);

const WARNINGS = Object.freeze([
  'INT64_JS_SAFE_INTEGER_LIMITATION',
  'PYTHON_BRIDGE_PARALLEL_STARTUP_TIMING_INSTABILITY',
]);

// Repository-owned mirror of the unresolved exception in
// security/audit-exceptions.json. It stays fail-closed until an ordinary source
// change removes it after the independent remediation is complete.
const REPOSITORY_SECURITY_BLOCKERS = Object.freeze([
  Object.freeze({
    advisoryId: 'GHSA-528h-pc64-c93x',
    package: 'stream-json',
    expiresAt: '2026-09-11',
  }),
]);

type PlainValue = null | string | number | boolean | PlainValue[] | { [key: string]: PlainValue };

function clonePlainData(value: unknown, ancestors = new WeakSet<object>()): PlainValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NON_FINITE_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new Error('UNSUPPORTED_VALUE');
  if (ancestors.has(value)) throw new Error('CYCLIC_VALUE');
  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('SYMBOL_KEY');
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('INVALID_ARRAY');
      if (Object.getOwnPropertyNames(value).length !== length + 1) throw new Error('SPARSE_ARRAY');
      const copy: PlainValue[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.get || descriptor.set || descriptor.enumerable !== true) {
          throw new Error('INVALID_ARRAY_PROPERTY');
        }
        copy.push(clonePlainData(descriptor.value, ancestors));
      }
      return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('NON_PLAIN_OBJECT');
    const copy: Record<string, PlainValue> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set || descriptor.enumerable !== true) {
        throw new Error('INVALID_OBJECT_PROPERTY');
      }
      copy[key] = clonePlainData(descriptor.value, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function isRecord(value: PlainValue | undefined): value is Record<string, PlainValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, PlainValue>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function timestampMs(value: PlainValue | undefined): number | null {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

function dateMs(value: PlainValue | undefined): number | null {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) return null;
  return milliseconds;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseArtifact(value: PlainValue | undefined): unknown {
  if (typeof value !== 'string') throw new Error('ARTIFACT_JSON_INVALID');
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ARTIFACT_JSON_INVALID');
  }
  return parsed;
}

function reverifyArtifact(
  family: ExistingArtifactEvidenceObservation['family'],
  observation: Record<string, PlainValue>,
  candidateHead: string,
): string | null {
  if (typeof observation.artifactJson !== 'string' ||
      typeof observation.artifactSha256 !== 'string' ||
      !SHA256.test(observation.artifactSha256) ||
      sha256(observation.artifactJson) !== observation.artifactSha256) {
    return `ARTIFACT_BYTES_INVALID:${family}`;
  }

  let artifact: unknown;
  try {
    artifact = parseArtifact(observation.artifactJson);
  } catch {
    return `ARTIFACT_CONTENT_INVALID:${family}`;
  }

  try {
    if (family === 'REFERENCE_INFRASTRUCTURE_PROOF') {
      verifyReferenceInfrastructureProof(artifact, {
        expectedRepository: 'wengecaitui/DSbot',
        expectedSourceCommit: candidateHead,
        expectedWorkflow: '.github/workflows/reference-infrastructure-proof.yml',
      });
      return null;
    }

    if (family === 'STAGE_4B2_PAPER_READINESS_RECEIPT') {
      if (typeof observation.stage4AClosureAuditId !== 'string' ||
          typeof observation.stage4B1ArtifactJson !== 'string') {
        return `ARTIFACT_SUPPORTING_EVIDENCE_INVALID:${family}`;
      }
      const stage4B1Artifact = parseArtifact(observation.stage4B1ArtifactJson);
      verifyStage4B2Receipt(artifact, {
        sourceCommit: candidateHead,
        stage4AClosureAuditId: observation.stage4AClosureAuditId,
        stage4B1Artifact,
        stage4B1ArtifactSourceSha256: sha256(observation.stage4B1ArtifactJson),
      });
      return null;
    }

    if (family === 'STAGE_4B3_SAFETY_RECEIPT') {
      if (typeof observation.stage4B2ReceiptJson !== 'string') {
        return `ARTIFACT_SUPPORTING_EVIDENCE_INVALID:${family}`;
      }
      const receipt = artifact as Stage4B3Receipt;
      verifyStage4B3Receipt(
        receipt,
        observation.stage4B2ReceiptJson,
        sha256(observation.stage4B2ReceiptJson),
      );
      if (receipt.sourceCommit !== candidateHead) {
        return `ARTIFACT_HEAD_MISMATCH:${family}`;
      }
      return null;
    }
  } catch {
    return `ARTIFACT_REVERIFICATION_FAILED:${family}`;
  }

  // These existing verifiers require repository or ledger/snapshot reads.
  // Under this gate's no-I/O boundary, their content cannot be authenticated.
  return `ARTIFACT_REVERIFICATION_UNAVAILABLE:${family}`;
}

function frozenResult(
  candidateHead: string,
  state: ProductionReadinessState,
  evidenceValid: boolean,
  blockers: Iterable<string>,
): ProductionReadinessEvidenceResult {
  const result: ProductionReadinessEvidenceResult = {
    candidateHead,
    state,
    evidenceValid,
    blockers: Object.freeze([...new Set(blockers)].sort()),
    warnings: WARNINGS,
    activationDecisionEligible: state === 'READY_FOR_ACTIVATION_DECISION',
    productionAuthority: false,
    testnetAuthority: false,
    liveAuthority: false,
  };
  return Object.freeze(result);
}

function candidateHeadWithoutAccessors(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, 'candidateHead');
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : '';
  } catch {
    return '';
  }
}

/** Evaluate immutable evidence content for one exact candidate head. */
export function evaluateProductionReadinessEvidence(
  input: ProductionReadinessEvidenceInput,
): ProductionReadinessEvidenceResult {
  const fallbackHead = candidateHeadWithoutAccessors(input);
  let cloned: PlainValue;
  try {
    cloned = clonePlainData(input);
  } catch {
    return frozenResult(fallbackHead, 'EVIDENCE_INVALID', false, ['EVIDENCE_INPUT_NOT_PLAIN_DATA']);
  }
  if (!isRecord(cloned) || !hasExactKeys(cloned, INPUT_KEYS)) {
    return frozenResult(fallbackHead, 'EVIDENCE_INVALID', false, ['EVIDENCE_INPUT_SHAPE_INVALID']);
  }

  const candidateHead = typeof cloned.candidateHead === 'string' ? cloned.candidateHead : fallbackHead;
  const errors = new Set<string>();
  const activationBlockers = new Set<string>();
  if (!GIT_SHA.test(candidateHead)) errors.add('CANDIDATE_HEAD_INVALID');

  const evaluationMs = timestampMs(cloned.evaluationTime);
  if (evaluationMs === null) errors.add('EVALUATION_TIME_INVALID');
  if (evaluationMs !== null) {
    for (const exception of REPOSITORY_SECURITY_BLOCKERS) {
      const expiryMs = dateMs(exception.expiresAt)!;
      const lifecycle = evaluationMs >= expiryMs ? 'EXPIRED' : 'ACTIVE';
      activationBlockers.add(`SECURITY_EXCEPTION_${lifecycle}:${exception.advisoryId}`);
    }
  }
  if (!Array.isArray(cloned.evidence)) {
    errors.add('EVIDENCE_COLLECTION_INVALID');
    return frozenResult(candidateHead, 'EVIDENCE_INVALID', false, errors);
  }

  const seen = new Set<string>();
  for (const raw of cloned.evidence) {
    if (!isRecord(raw)) {
      errors.add('EVIDENCE_OBSERVATION_INVALID');
      continue;
    }
    const family = typeof raw.family === 'string' ? raw.family : '';
    if (!(PRODUCTION_READINESS_EVIDENCE_FAMILIES as readonly string[]).includes(family)) {
      errors.add('UNKNOWN_EVIDENCE_FAMILY');
      continue;
    }
    const typedFamily = family as ProductionReadinessEvidenceFamily;
    if (seen.has(typedFamily)) errors.add(`DUPLICATE_EVIDENCE:${typedFamily}`);
    seen.add(typedFamily);

    const expectedKeys = typedFamily === 'SECURITY'
      ? SECURITY_KEYS
      : typedFamily === 'CI'
        ? CHECK_KEYS
        : typedFamily === 'STAGE_4B2_PAPER_READINESS_RECEIPT'
          ? STAGE_4B2_KEYS
          : typedFamily === 'STAGE_4B3_SAFETY_RECEIPT'
            ? STAGE_4B3_KEYS
            : ARTIFACT_KEYS;
    if (!hasExactKeys(raw, expectedKeys)) errors.add(`EVIDENCE_SHAPE_INVALID:${typedFamily}`);

    if (typeof raw.headSha !== 'string' || !GIT_SHA.test(raw.headSha)) {
      errors.add(`EVIDENCE_HEAD_INVALID:${typedFamily}`);
    } else if (raw.headSha !== candidateHead) {
      errors.add(`EVIDENCE_HEAD_MISMATCH:${typedFamily}`);
    }
    if (raw.workflow !== EXPECTED[typedFamily].workflow) {
      errors.add(`EVIDENCE_WORKFLOW_MISMATCH:${typedFamily}`);
    }
    if (!Number.isSafeInteger(raw.runId) || (raw.runId as number) <= 0) {
      errors.add(`EVIDENCE_RUN_ID_INVALID:${typedFamily}`);
    }
    if (raw.status !== 'COMPLETED') errors.add(`EVIDENCE_STATUS_INVALID:${typedFamily}`);
    if (raw.conclusion !== 'SUCCESS') errors.add(`EVIDENCE_CONCLUSION_FAILED:${typedFamily}`);

    const completedMs = timestampMs(raw.completedAt);
    const validUntilMs = timestampMs(raw.validUntil);
    if (completedMs === null || validUntilMs === null) {
      errors.add(`EVIDENCE_TIME_INVALID:${typedFamily}`);
    } else {
      if (completedMs >= validUntilMs ||
          validUntilMs - completedMs > PRODUCTION_READINESS_MAX_EVIDENCE_AGE_MS) {
        errors.add(`EVIDENCE_TIME_INVALID:${typedFamily}`);
      }
      if (evaluationMs !== null) {
        if (completedMs > evaluationMs) errors.add(`EVIDENCE_NOT_YET_OBSERVED:${typedFamily}`);
        if (evaluationMs >= validUntilMs ||
            evaluationMs - completedMs >= PRODUCTION_READINESS_MAX_EVIDENCE_AGE_MS) {
          errors.add(`EVIDENCE_STALE:${typedFamily}`);
        }
      }
    }

    const contract = EXPECTED[typedFamily].contract;
    if (contract !== null) {
      if (raw.artifactContract !== contract) errors.add(`EVIDENCE_CONTRACT_MISMATCH:${typedFamily}`);
      const verificationError = reverifyArtifact(
        typedFamily as ExistingArtifactEvidenceObservation['family'],
        raw,
        candidateHead,
      );
      if (verificationError !== null) {
        errors.add(verificationError);
      }
    } else {
      // CI and Security expose no repository-owned, offline-verifiable receipt.
      // A caller-created workflow summary cannot establish GitHub workflow truth.
      errors.add(`UNVERIFIED_EXTERNAL_OBSERVATION:${typedFamily}`);
    }

    if (typedFamily === 'SECURITY') {
      if (!Array.isArray(raw.exceptions)) {
        errors.add('SECURITY_EXCEPTIONS_INVALID');
        continue;
      }
      const exceptionIds = new Set<string>();
      for (const exception of raw.exceptions) {
        if (!isRecord(exception) || !hasExactKeys(exception, EXCEPTION_KEYS)) {
          errors.add('SECURITY_EXCEPTION_INVALID');
          continue;
        }
        const advisoryId = exception.advisoryId;
        const packageName = exception.package;
        const expiryMs = dateMs(exception.expiresAt);
        if (typeof advisoryId !== 'string' || !GHSA.test(advisoryId) ||
            typeof packageName !== 'string' || packageName.length === 0 || expiryMs === null) {
          errors.add('SECURITY_EXCEPTION_INVALID');
          continue;
        }
        if (exceptionIds.has(advisoryId)) errors.add(`DUPLICATE_SECURITY_EXCEPTION:${advisoryId}`);
        exceptionIds.add(advisoryId);
        const lifecycle = evaluationMs !== null && evaluationMs >= expiryMs ? 'EXPIRED' : 'ACTIVE';
        activationBlockers.add(`SECURITY_EXCEPTION_${lifecycle}:${advisoryId}`);
      }
    }
  }

  for (const family of PRODUCTION_READINESS_EVIDENCE_FAMILIES) {
    if (!seen.has(family)) errors.add(`MISSING_EVIDENCE:${family}`);
  }
  if (errors.size !== 0) {
    return frozenResult(candidateHead, 'EVIDENCE_INVALID', false, [...errors, ...activationBlockers]);
  }
  if (activationBlockers.size !== 0) {
    return frozenResult(candidateHead, 'BLOCKED', true, activationBlockers);
  }
  return frozenResult(candidateHead, 'READY_FOR_ACTIVATION_DECISION', true, []);
}
