import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { validatePolicyPublication } from '../../events/validatePolicySnapshot';
import { validateTradingEventPayload } from '../../events/validateTradingEventPayload';
import type { TradingEventPayloadMap } from '../../events/TradingEvent';
import type { ProductionSpine } from '../../position/ProductionSpine';
import { createFileEventJournal, type FileEventJournal } from '../../recovery/FileEventJournal';
import type { MarketBiasReportFull } from '../../types/market-bias';
import type { CompiledPolicy } from '../../types/policy-snapshot';
import { establishVerifiedLiveFlatBaseline, verifyGateIoLiveFlatBaseline,
  type VerifiedGateIoLiveFlatBaselineInput } from './establishVerifiedLiveFlatBaseline';

export interface GateIoLiveBootstrapInput {
  /** Compose the existing, unstarted Spine with this SAME FileEventJournal before calling.
   * Bootstrap never creates a Runtime, Spine, OMS, risk gateway or position authority.
   */
  readonly spine: Pick<ProductionSpine, 'kernel' | 'positionStore' | 'policyStore' | 'oms'>;
  readonly journal: FileEventJournal;
  readonly journalPath: string;
  readonly truthPort: VerifiedGateIoLiveFlatBaselineInput['truthPort'];
  readonly truth: VerifiedGateIoLiveFlatBaselineInput['truth'];
  readonly accountId: string;
  readonly now: () => number;
  readonly researchReport: MarketBiasReportFull;
  /** Explicit receipt time, part of the existing research payload/event identity.
   * Never replaced by a bootstrap clock sample or the report's generation time.
   */
  readonly researchReceivedAt: number;
  /** Explicit operator-owned input. Provenance and fields are never defaulted or rewritten. */
  readonly policy: CompiledPolicy;
  readonly policyMaxLifetimeMs: number;
}

/** One-shot synchronous publication only. The caller owns the read capture and lifecycle.
 * Reuses FileEventJournal's integrity format and Kernel's real publication validators.
 * On ANY error stop: a partially written journal is preserved, never retried or erased.
 */
export function bootstrapGateIoLiveJournal(input: GateIoLiveBootstrapInput) {
  const { spine, journal, journalPath } = input;
  if (typeof journalPath !== 'string' || !isAbsolute(journalPath)
      || typeof journal?.filePath !== 'string' || !isAbsolute(journal.filePath)
      || resolve(journal.filePath) !== resolve(journalPath) || spine.kernel.journal() !== journal
      || journal.eventCount !== 0 || journal.lastSequence !== 0
      || journal.readFromLogicalSequence(1).length !== 0
      || spine.policyStore.getLatest('gateio') !== undefined) {
    throw new Error('GATEIO_BOOTSTRAP_JOURNAL_DENIED');
  }
  if (existsSync(journalPath)) {
    const stat = lstatSync(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0 || stat.nlink !== 1)
      throw new Error('GATEIO_BOOTSTRAP_JOURNAL_DENIED');
  }
  const time = input.now();
  let researchPayload: TradingEventPayloadMap['research.bias.updated'];
  try {
    if (!Number.isSafeInteger(time) || time < 0
        || !Number.isSafeInteger(input.researchReceivedAt) || input.researchReceivedAt < 0
        || input.researchReceivedAt > time) throw new Error('INVALID_RESEARCH_RECEIPT_TIME');
    const payload = { report: input.researchReport, receivedAt: input.researchReceivedAt };
    validateTradingEventPayload('research.bias.updated', payload);
    if (payload.report.exchange !== 'gateio') throw new Error('RESEARCH_EXCHANGE_MISMATCH');
    researchPayload = structuredClone(payload);
    validateTradingEventPayload('research.bias.updated', researchPayload);
  } catch {
    throw new Error('GATEIO_BOOTSTRAP_RESEARCH_DENIED');
  }
  let policy: CompiledPolicy;
  try {
    if (!Number.isSafeInteger(time) || time < 0
        || !Number.isSafeInteger(input.policyMaxLifetimeMs) || input.policyMaxLifetimeMs <= 0)
      throw new Error('INVALID_CLOCK_OR_POLICY_WINDOW');
    // Structural preflight only. Genuine provenance is checked against the actual seq2
    // research envelope below, NOT inferred from a well-shaped ID or an earlier sequence.
    validatePolicyPublication(input.policy, 3, time, input.policyMaxLifetimeMs);
    policy = structuredClone(input.policy);
    validatePolicyPublication(policy, 3, time, input.policyMaxLifetimeMs);
    const rule = policy.symbolRules['ETH/USDT'];
    if (policy.exchange !== 'gateio' || policy.effectiveAt > time || policy.expiresAt <= time
        || !policy.allowNewEntries || !Number.isFinite(policy.maxPositionMultiplier)
        || policy.maxPositionMultiplier <= 0 || policy.blockedSymbols.includes('ETH/USDT')
        || (policy.allowedSymbols.length > 0 && !policy.allowedSymbols.includes('ETH/USDT'))
        || (rule && (!rule.allowNewEntries || !Number.isFinite(rule.maxPositionMultiplier)
          || rule.maxPositionMultiplier <= 0))) throw new Error('INELIGIBLE_POLICY');
  } catch {
    throw new Error('GATEIO_BOOTSTRAP_POLICY_DENIED');
  }
  const baselineInput: VerifiedGateIoLiveFlatBaselineInput = {
    kernel: spine.kernel, positionStore: spine.positionStore, oms: spine.oms,
    truthPort: input.truthPort, truth: input.truth,
    accountId: input.accountId, symbol: 'ETH/USDT', now: input.now,
  };
  verifyGateIoLiveFlatBaseline(baselineInput);
  // Exclusive creation for a new path; never truncate or replace an existing file.
  const fd = openSync(journalPath, existsSync(journalPath) ? 'r+' : 'wx', 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1)
      throw new Error('GATEIO_BOOTSTRAP_JOURNAL_DENIED');
    const baseline = establishVerifiedLiveFlatBaseline(baselineInput);
    const research = spine.kernel.publish('research.bias.updated', researchPayload);
    const researchEnvelope = research.envelope;
    const journaledResearch = journal.getByEventId(researchEnvelope.kernelEventId);
    if (research.status !== 'accepted' || research.failures !== 0
        || researchEnvelope.type !== 'research.bias.updated' || researchEnvelope.kernelLogicalSequence !== 2
        || journal.readFromLogicalSequence(1, 3).length !== 2 || journaledResearch?.type !== 'research.bias.updated'
        || journaledResearch.kernelLogicalSequence !== 2) {
      throw new Error('GATEIO_BOOTSTRAP_RESEARCH_NOT_APPLIED');
    }
    if (policy.sourceResearchSequence !== researchEnvelope.kernelLogicalSequence
        || policy.sourceResearchEventId !== researchEnvelope.kernelEventId) {
      // Preserve baseline + research for inspection. Never repair the policy or retry publication.
      throw new Error('GATEIO_BOOTSTRAP_POLICY_PROVENANCE_MISMATCH');
    }
    validatePolicyPublication(policy, 3, input.now(), input.policyMaxLifetimeMs);
    const published = spine.kernel.publish('policy.snapshot.published', { policy });
    if (published.status !== 'accepted' || published.failures !== 0 || published.envelope.kernelLogicalSequence !== 3)
      throw new Error('GATEIO_BOOTSTRAP_POLICY_NOT_APPLIED');
    const resolution = spine.policyStore.resolve('gateio', 'ETH/USDT');
    if (resolution.status !== 'active' || !resolution.allowNewEntries
        || !Number.isFinite(resolution.maxPositionMultiplier) || resolution.maxPositionMultiplier <= 0)
      throw new Error('GATEIO_BOOTSTRAP_POLICY_NOT_ACTIVE');
    fsyncSync(fd);
    const reopened = createFileEventJournal(journalPath); // recomputes checksums/sequence from disk
    const events = reopened.readFromLogicalSequence(1);
    if (reopened.eventCount !== 3 || reopened.lastSequence !== 3
        || events[0]?.type !== 'position.baseline.confirmed' || events[1]?.type !== 'research.bias.updated'
        || events[2]?.type !== 'policy.snapshot.published'
        || JSON.stringify(events) !== JSON.stringify(journal.readFromLogicalSequence(1)))
      throw new Error('GATEIO_BOOTSTRAP_JOURNAL_INTEGRITY_FAILED');
    reopened.close();
    return Object.freeze({ baseline, journalPath, eventCount: 3 as const,
      researchEventId: researchEnvelope.kernelEventId, researchSequence: researchEnvelope.kernelLogicalSequence,
      researchSynthesized: false as const,
      policySource: 'EXPLICIT_OPERATOR_COMPILED_POLICY' as const, policySynthesized: false as const,
      integrityVerified: true as const, liveReady: false as const, executionAuthority: false as const });
  } finally {
    closeSync(fd);
  }
}
