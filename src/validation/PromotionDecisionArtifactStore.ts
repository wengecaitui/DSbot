// Stage 4A6: offline, append-only persistence for promotion evidence.

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ValidationReport } from './ValidationTypes';
import { deepFreeze } from './ValidationTypes';
import {
  evaluateStrategyPromotion,
  type StrategyPromotionDecision,
  type StrategyPromotionPolicy,
} from './StrategyPromotionGate';

export const PROMOTION_ARTIFACT_CONTRACT_VERSION = '4A6-R1' as const;
export const PROMOTION_ARTIFACT_INTEGRITY_ALGORITHM = 'sha256' as const;

export interface PromotionDecisionArtifact {
  readonly artifactContractVersion: typeof PROMOTION_ARTIFACT_CONTRACT_VERSION;
  readonly integrityAlgorithm: typeof PROMOTION_ARTIFACT_INTEGRITY_ALGORITHM;
  readonly artifactId: string;
  readonly report: ValidationReport;
  readonly policy: StrategyPromotionPolicy;
  readonly decision: StrategyPromotionDecision;
}

export interface PromotionDecisionArtifactStoreConfig {
  readonly dir: string;
}

function invalid(reason: string): never {
  throw new Error(`PROMOTION_ARTIFACT_INVALID:${reason}`);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return invalid('UNSUPPORTED_VALUE');
}

function artifactPayload(
  report: ValidationReport,
  policy: StrategyPromotionPolicy,
  decision: StrategyPromotionDecision,
): object {
  return {
    artifactContractVersion: PROMOTION_ARTIFACT_CONTRACT_VERSION,
    integrityAlgorithm: PROMOTION_ARTIFACT_INTEGRITY_ALGORITHM,
    report,
    policy,
    decision,
  };
}

function digest(payload: object): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Create an owned, immutable artifact without freezing caller-owned inputs. */
export function createPromotionDecisionArtifact(
  report: ValidationReport,
  policy: StrategyPromotionPolicy,
): PromotionDecisionArtifact {
  const ownedReport = jsonClone(report);
  const ownedPolicy = jsonClone(policy);
  const decision = jsonClone(evaluateStrategyPromotion(ownedReport, ownedPolicy));
  const payload = artifactPayload(ownedReport, ownedPolicy, decision);
  return deepFreeze({ ...payload, artifactId: digest(payload) } as PromotionDecisionArtifact);
}

/**
 * Verify checksum and re-run the Stage 4A5 gate from the persisted report and policy.
 * SHA-256 makes corruption/tampering detectable; it is not a signature or identity proof.
 */
export function verifyPromotionDecisionArtifact(value: unknown): PromotionDecisionArtifact {
  if (!value || typeof value !== 'object') invalid('NOT_OBJECT');
  const artifact = value as PromotionDecisionArtifact;
  if (artifact.artifactContractVersion !== PROMOTION_ARTIFACT_CONTRACT_VERSION) invalid('CONTRACT_VERSION');
  if (artifact.integrityAlgorithm !== PROMOTION_ARTIFACT_INTEGRITY_ALGORITHM) invalid('INTEGRITY_ALGORITHM');
  if (!/^[a-f0-9]{64}$/.test(artifact.artifactId)) invalid('ARTIFACT_ID');
  if (!artifact.report || !artifact.policy || !artifact.decision) invalid('PAYLOAD_MISSING');

  let expectedDecision: StrategyPromotionDecision;
  try {
    expectedDecision = evaluateStrategyPromotion(jsonClone(artifact.report), jsonClone(artifact.policy));
  } catch {
    return invalid('GATE_REEVALUATION_FAILED');
  }
  if (!sameValue(artifact.decision, expectedDecision)) invalid('DECISION_MISMATCH');
  const expectedId = digest(artifactPayload(artifact.report, artifact.policy, artifact.decision));
  if (artifact.artifactId !== expectedId) invalid('DIGEST_MISMATCH');
  return deepFreeze(jsonClone(artifact));
}

function assertDecisionId(decisionId: string): void {
  if (!/^[a-f0-9]{64}$/.test(decisionId)) invalid('DECISION_ID');
}

export class PromotionDecisionArtifactStore {
  private readonly dir: string;

  constructor(config: PromotionDecisionArtifactStoreConfig) {
    if (!config.dir || !path.isAbsolute(config.dir)) invalid('ABSOLUTE_DIRECTORY_REQUIRED');
    this.dir = config.dir;
  }

  private artifactPath(decisionId: string): string {
    assertDecisionId(decisionId);
    return path.join(this.dir, `${decisionId}.json`);
  }

  /** Persist once. Re-saving identical evidence is idempotent; overwrite is impossible. */
  async save(value: PromotionDecisionArtifact): Promise<PromotionDecisionArtifact> {
    const artifact = verifyPromotionDecisionArtifact(value);
    const finalPath = this.artifactPath(artifact.decision.decisionId);
    await fs.promises.mkdir(this.dir, { recursive: true });
    const tempPath = path.join(this.dir, `.${artifact.decision.decisionId}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.promises.open(tempPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.promises.link(tempPath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.load(artifact.decision.decisionId);
        if (!existing || existing.artifactId !== artifact.artifactId) {
          throw new Error('PROMOTION_ARTIFACT_COLLISION');
        }
      }
    } finally {
      await fs.promises.unlink(tempPath).catch(() => undefined);
    }
    return artifact;
  }

  async load(decisionId: string): Promise<PromotionDecisionArtifact | null> {
    const filename = this.artifactPath(decisionId);
    let content: string;
    try {
      content = await fs.promises.readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return invalid('INVALID_JSON');
    }
    const artifact = verifyPromotionDecisionArtifact(parsed);
    if (artifact.decision.decisionId !== decisionId) invalid('FILENAME_ID_MISMATCH');
    return artifact;
  }
}
