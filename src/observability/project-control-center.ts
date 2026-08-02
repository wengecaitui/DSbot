import { execFile as execFileCallback } from 'node:child_process';
import { readFile as readFileDefault } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ObservableAgentEvent } from './contracts';

const execFile = promisify(execFileCallback);

export const CONTROL_CENTER_STATUSES = [
  'PLANNED',
  'IMPLEMENTING',
  'LOCAL_VERIFIED',
  'PUSHED',
  'PR_OPEN',
  'REMOTE_CI_VERIFIED',
  'MERGED',
  'INTEGRATION_VERIFIED',
  'CLOSED',
  'BLOCKED',
] as const;

export type ControlCenterStatus = typeof CONTROL_CENTER_STATUSES[number];
export type ApprovalEnvironment = 'replay' | 'shadow' | 'paper' | 'testnet' | 'live';

export interface ControlCenterApproval {
  approved: false;
  source: string;
  limitation: string;
}

export interface ControlCenterConfig {
  schemaVersion: '1.0';
  repository: string;
  integrationBranch: string;
  deliveryBranch: string;
  currentCapability: string;
  currentTask: string;
  activeAgent: string;
  nextAction: string;
  requiredLocalGates: Array<{
    id: string;
    executable: string;
    args: string[];
  }>;
  requiredRemoteChecks: string[];
  promotedStrategyCount: 0;
  blockers: string[];
  approvals: Record<ApprovalEnvironment, ControlCenterApproval>;
}

export interface ControlCenterCheck {
  name: string;
  status: string;
  conclusion?: string;
  url?: string;
}

export interface ControlCenterPullRequest {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headSha: string;
  mergeSha?: string;
  reviewDecision?: string;
  checks: ControlCenterCheck[];
}

export interface ControlCenterTestEvidence {
  gateId?: string;
  command: string;
  exitCode: number;
  completedAt: string;
  commitSha?: string;
  beforeSha?: string;
  afterSha?: string;
  beforeClean?: boolean;
  afterClean?: boolean;
  source: 'evidence-file' | 'observable-event';
  summary?: string;
}

export interface ProjectControlCenterSnapshot {
  schemaVersion: '1.0';
  kind: 'dsbot.project-control-center';
  generatedAt: string;
  status: ControlCenterStatus;
  currentCapability: string;
  currentTask: string;
  activeAgent: string;
  repository: {
    identity: string;
    identityVerified: boolean;
    branch: string;
    worktree: string;
    commitSha: string;
    upstream?: string;
    changedFiles: string[];
    integrationBranch: string;
    integrationHead?: string;
  };
  pullRequest?: ControlCenterPullRequest;
  ci: {
    status: 'PASS' | 'FAIL' | 'PENDING' | 'UNAVAILABLE';
    checks: ControlCenterCheck[];
    requiredChecks: string[];
    missingRequiredChecks: string[];
    headShaMatchesDeliveryRef: boolean;
  };
  localTests: ControlCenterTestEvidence[];
  remoteTests: ControlCenterCheck[];
  blockers: string[];
  dataGaps: string[];
  nextAction: string;
  eventTimeline: Array<{
    timestamp: string;
    actor: string;
    action: string;
    result?: 'PASS' | 'FAIL' | 'OBSERVED';
    evidenceId?: string;
  }>;
  promotedStrategyCount: 0;
  approvals: Record<ApprovalEnvironment, ControlCenterApproval>;
  boundaries: {
    readOnlyDashboard: true;
    dashboardGrantsApproval: false;
    tradingEnvironmentActivated: false;
  };
}

interface TestEvidenceFile {
  schemaVersion: '2.0';
  commands: Array<Omit<ControlCenterTestEvidence, 'source' | 'commitSha'>>;
}

interface GhPullRequest {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  mergeCommit?: { oid?: string } | null;
  reviewDecision?: string;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    detailsUrl?: string;
  }>;
}

export interface ProjectControlCenterOptions {
  repoPath: string;
  configPath?: string;
  testEvidencePath?: string;
  config?: ControlCenterConfig;
  runCommand?: (executable: string, args: string[], cwd: string) => Promise<string>;
  readFile?: (file: string) => Promise<string>;
  now?: () => Date;
  maxTimeline?: number;
}

export interface ProjectControlCenter {
  refresh(): Promise<void>;
  observe(event: ObservableAgentEvent): void;
  snapshot(): ProjectControlCenterSnapshot;
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
}

function validateConfig(value: unknown): ControlCenterConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Control Center config must be an object');
  const config = value as ControlCenterConfig;
  if (config.schemaVersion !== '1.0') throw new Error('Unsupported Control Center config schema');
  for (const field of ['repository', 'integrationBranch', 'deliveryBranch', 'currentCapability', 'currentTask', 'activeAgent', 'nextAction'] as const) {
    assertNonEmpty(config[field], field);
  }
  if (config.promotedStrategyCount !== 0) throw new Error('promotedStrategyCount must remain zero until authoritative promotion evidence exists');
  if (!Array.isArray(config.blockers) || config.blockers.some(item => typeof item !== 'string')) throw new Error('blockers must be a string array');
  if (!Array.isArray(config.requiredRemoteChecks) || config.requiredRemoteChecks.length === 0 || config.requiredRemoteChecks.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error('requiredRemoteChecks must be a non-empty string array');
  }
  if (!Array.isArray(config.requiredLocalGates) || config.requiredLocalGates.length === 0) throw new Error('requiredLocalGates must be non-empty');
  const gateIds = new Set<string>();
  for (const gate of config.requiredLocalGates) {
    assertNonEmpty(gate?.id, 'local gate id');
    assertNonEmpty(gate?.executable, 'local gate executable');
    if (!Array.isArray(gate.args) || gate.args.some(argument => typeof argument !== 'string')) throw new Error('local gate args must be strings');
    if (gateIds.has(gate.id)) throw new Error(`duplicate local gate id: ${gate.id}`);
    gateIds.add(gate.id);
  }
  for (const environment of ['replay', 'shadow', 'paper', 'testnet', 'live'] as const) {
    const approval = config.approvals?.[environment];
    if (!approval || approval.approved !== false) throw new Error(`${environment} approval must fail closed`);
    assertNonEmpty(approval.source, `${environment}.source`);
    assertNonEmpty(approval.limitation, `${environment}.limitation`);
  }
  return structuredClone(config);
}

function normalizeRepository(remote: string): string {
  const normalized = remote.trim().replace(/\\/g, '/').replace(/\.git$/, '');
  const match = normalized.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i);
  return match?.[1]?.toLowerCase() ?? normalized.toLowerCase();
}

function parseChangedFiles(status: string): string[] {
  if (!status.trim()) return [];
  return status.split(/\r?\n/).map(line => line.slice(3).trim()).filter(Boolean).sort();
}

function parseCheck(check: NonNullable<GhPullRequest['statusCheckRollup']>[number]): ControlCenterCheck {
  return {
    name: check.name ?? check.context ?? 'unnamed-check',
    status: check.status ?? 'UNKNOWN',
    conclusion: check.conclusion || undefined,
    url: check.detailsUrl || undefined,
  };
}

function ciStatus(checks: ControlCenterCheck[], requiredChecks: string[]): ProjectControlCenterSnapshot['ci']['status'] {
  if (checks.length === 0) return 'UNAVAILABLE';
  if (checks.some(check => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(check.conclusion ?? ''))) return 'FAIL';
  const observed = new Map(checks.map(check => [check.name, check]));
  if (requiredChecks.some(name => observed.get(name)?.conclusion !== 'SUCCESS')) return 'PENDING';
  if (checks.every(check => ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion ?? ''))) return 'PASS';
  return 'PENDING';
}

function deriveStatus(input: {
  config: ControlCenterConfig;
  branch: string;
  head: string;
  remoteBranchHead?: string;
  deliveryReferenceHead?: string;
  integrationHead?: string;
  changedFiles: string[];
  localTests: ControlCenterTestEvidence[];
  pullRequest?: ControlCenterPullRequest;
}): ControlCenterStatus {
  if (input.config.blockers.length > 0) return 'BLOCKED';
  if (input.changedFiles.length > 0) return 'IMPLEMENTING';
  const pr = input.pullRequest;
  if (pr?.state === 'MERGED') {
    if (!input.deliveryReferenceHead || pr.headSha !== input.deliveryReferenceHead) return 'BLOCKED';
    if (pr.mergeSha && input.integrationHead === pr.mergeSha) return 'INTEGRATION_VERIFIED';
    return 'MERGED';
  }
  if (pr) {
    if (pr.state !== 'OPEN') return 'BLOCKED';
    if (pr.headSha !== input.deliveryReferenceHead) return 'PR_OPEN';
    if (input.branch === input.config.deliveryBranch && pr.headSha !== input.head) return 'PR_OPEN';
    if (ciStatus(pr.checks, input.config.requiredRemoteChecks) === 'PASS') return 'REMOTE_CI_VERIFIED';
    return 'PR_OPEN';
  }
  if (input.remoteBranchHead === input.head) return 'PUSHED';
  const currentCommitTests = input.localTests.filter(test => test.commitSha === input.head && test.gateId);
  const passingGateIds = new Set(currentCommitTests.filter(test => test.exitCode === 0).map(test => test.gateId));
  if (input.config.requiredLocalGates.every(gate => passingGateIds.has(gate.id))) return 'LOCAL_VERIFIED';
  if (input.changedFiles.length > 0 || input.branch === input.config.deliveryBranch) return 'IMPLEMENTING';
  return 'PLANNED';
}

export function createProjectControlCenter(options: ProjectControlCenterOptions): ProjectControlCenter {
  const repoPath = path.resolve(options.repoPath);
  const configPath = path.resolve(repoPath, options.configPath ?? 'config/control-center/project-state.json');
  const testEvidencePath = path.resolve(repoPath, options.testEvidencePath ?? '.runtime-observability/control-center-tests.json');
  const readFile = options.readFile ?? (file => readFileDefault(file, 'utf8'));
  const runCommand = options.runCommand ?? (async (executable, args, cwd) => {
    const result = await execFile(executable, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim();
  });
  const now = options.now ?? (() => new Date());
  const maxTimeline = options.maxTimeline ?? 100;
  if (!Number.isInteger(maxTimeline) || maxTimeline <= 0) throw new Error('maxTimeline must be a positive integer');

  const fixedConfig = options.config ? validateConfig(options.config) : undefined;
  let snapshot: ProjectControlCenterSnapshot | undefined;
  const observedTests: ControlCenterTestEvidence[] = [];
  const timeline: ProjectControlCenterSnapshot['eventTimeline'] = [];

  function pushTimeline(item: ProjectControlCenterSnapshot['eventTimeline'][number]): void {
    timeline.push(item);
    while (timeline.length > maxTimeline) timeline.shift();
  }

  async function optional(executable: string, args: string[]): Promise<string | undefined> {
    try { return await runCommand(executable, args, repoPath); } catch { return undefined; }
  }

  function parseCommitSha(value: string | undefined): string | undefined {
    const sha = value?.trim().split(/\s+/)[0];
    return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
  }

  async function readRemoteHead(current: ControlCenterConfig, branch: string): Promise<string | undefined> {
    const gitHead = parseCommitSha(await optional('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]));
    if (gitHead) return gitHead;
    return parseCommitSha(await optional('gh', [
      'api', `repos/${current.repository}/commits/${encodeURIComponent(branch)}`, '--jq', '.sha',
    ]));
  }

  async function loadTests(head: string, current: ControlCenterConfig, dataGaps: string[]): Promise<ControlCenterTestEvidence[]> {
    let fileTests: ControlCenterTestEvidence[] = [];
    try {
      const parsed = JSON.parse(await readFile(testEvidencePath)) as TestEvidenceFile;
      if (parsed.schemaVersion !== '2.0' || !Array.isArray(parsed.commands)) throw new Error('schema mismatch');
      const gateById = new Map(current.requiredLocalGates.map(gate => [gate.id, gate]));
      for (const command of parsed.commands) {
        assertNonEmpty(command.gateId, 'test gateId');
        assertNonEmpty(command.command, 'test command');
        assertNonEmpty(command.completedAt, 'test completedAt');
        if (!Number.isInteger(command.exitCode) || command.exitCode < 0) throw new Error('invalid test exit code');
        if (!/^[a-f0-9]{40}$/.test(command.beforeSha ?? '') || !/^[a-f0-9]{40}$/.test(command.afterSha ?? '')) throw new Error('invalid gate SHA');
        const gate = gateById.get(command.gateId);
        if (!gate) throw new Error(`unknown local gate: ${command.gateId}`);
        const expectedCommand = [gate.executable, ...gate.args].join(' ');
        if (command.command !== expectedCommand) throw new Error(`local gate command mismatch: ${command.gateId}`);
      }
      const latestByGate = new Map<string, ControlCenterTestEvidence>();
      for (const command of parsed.commands) {
        if (command.beforeSha !== head || command.afterSha !== head || command.beforeClean !== true || command.afterClean !== true) continue;
        latestByGate.set(command.gateId!, { ...command, commitSha: head, source: 'evidence-file' as const });
      }
      fileTests = [...latestByGate.values()];
      const observedGateIds = new Set(fileTests.map(test => test.gateId));
      const missingLocalGates = current.requiredLocalGates.filter(gate => !observedGateIds.has(gate.id)).map(gate => gate.id);
      if (missingLocalGates.length) dataGaps.push(`Missing clean SHA-bound local gates: ${missingLocalGates.join(', ')}`);
    } catch {
      dataGaps.push(`Local test evidence unavailable at ${testEvidencePath}`);
    }
    return [...fileTests, ...observedTests].filter(test => !test.commitSha || test.commitSha === head).slice(-50);
  }

  async function loadPullRequest(current: ControlCenterConfig, expectedHead: string | undefined, dataGaps: string[]): Promise<ControlCenterPullRequest | undefined> {
    try {
      const raw = await runCommand('gh', [
        'pr', 'list', '--repo', current.repository, '--head', current.deliveryBranch,
        '--state', 'all', '--limit', '10',
        '--json', 'number,url,state,isDraft,headRefOid,mergeCommit,reviewDecision,statusCheckRollup',
      ], repoPath);
      const items = JSON.parse(raw) as GhPullRequest[];
      const item = items.find(candidate => expectedHead !== undefined && candidate.headRefOid === expectedHead) ?? items[0];
      if (!item) return undefined;
      const checks = (item.statusCheckRollup ?? []).map(parseCheck).sort((a, b) => a.name.localeCompare(b.name));
      return {
        number: item.number,
        url: item.url,
        state: item.state,
        isDraft: item.isDraft,
        headSha: item.headRefOid,
        mergeSha: item.mergeCommit?.oid || undefined,
        reviewDecision: item.reviewDecision || undefined,
        checks,
      };
    } catch {
      dataGaps.push('GitHub PR/CI evidence unavailable from authenticated gh CLI');
      return undefined;
    }
  }

  return {
    async refresh() {
      const dataGaps: string[] = [];
      const current = fixedConfig ?? validateConfig(JSON.parse(await readFile(configPath)));
      const [worktree, branch, head, remote, upstream, status, integrationHead, remoteBranchHead, localDeliveryHead] = await Promise.all([
        runCommand('git', ['rev-parse', '--show-toplevel'], repoPath),
        runCommand('git', ['branch', '--show-current'], repoPath),
        runCommand('git', ['rev-parse', 'HEAD'], repoPath),
        runCommand('git', ['remote', 'get-url', 'origin'], repoPath),
        optional('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
        runCommand('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'], repoPath),
        readRemoteHead(current, current.integrationBranch),
        readRemoteHead(current, current.deliveryBranch),
        optional('git', ['rev-parse', `refs/heads/${current.deliveryBranch}`]),
      ]);
      const deliveryReferenceHead = remoteBranchHead ?? (/^[a-f0-9]{40}$/.test(localDeliveryHead ?? '') ? localDeliveryHead : undefined);
      const identity = normalizeRepository(remote);
      const identityVerified = identity === current.repository.toLowerCase();
      if (!identityVerified) dataGaps.push(`Repository identity mismatch: expected ${current.repository}, observed ${identity}`);
      if (!integrationHead) dataGaps.push(`Remote integration ref origin/${current.integrationBranch} is unavailable from Git and GitHub`);
      if (!remoteBranchHead) {
        dataGaps.push(`Remote delivery ref origin/${current.deliveryBranch} is unavailable from Git and GitHub; any local ref is identity continuity only`);
      }
      const changedFiles = parseChangedFiles(status);
      const localTests = await loadTests(head, current, dataGaps);
      const pullRequest = await loadPullRequest(current, deliveryReferenceHead, dataGaps);
      const checks = pullRequest?.checks ?? [];
      const headShaMatchesDeliveryRef = pullRequest !== undefined && pullRequest.headSha === remoteBranchHead;
      const observedCheckNames = new Set(checks.map(check => check.name));
      const missingRequiredChecks = current.requiredRemoteChecks.filter(name => !observedCheckNames.has(name));
      if (pullRequest && pullRequest.state !== 'MERGED' && !headShaMatchesDeliveryRef) {
        dataGaps.push('PR head SHA does not match the observed remote delivery branch');
      }
      if (pullRequest && pullRequest.state !== 'MERGED' && branch === current.deliveryBranch && pullRequest.headSha !== head) {
        dataGaps.push('Local delivery branch HEAD does not match the PR head SHA');
      }
      const dynamicBlockers = [...current.blockers];
      if (!identityVerified) dynamicBlockers.push('Repository identity mismatch');
      if (pullRequest?.state === 'CLOSED') dynamicBlockers.push('Delivery PR is closed without merge');
      if (pullRequest?.state === 'MERGED' && (!deliveryReferenceHead || pullRequest.headSha !== deliveryReferenceHead)) {
        dynamicBlockers.push('Merged PR head does not bind to the current delivery branch identity');
      }
      const generatedAt = now().toISOString();
      const statusValue = identityVerified
        ? deriveStatus({ config: current, branch, head, remoteBranchHead, deliveryReferenceHead, integrationHead, changedFiles, localTests, pullRequest })
        : 'BLOCKED';
      snapshot = {
        schemaVersion: '1.0',
        kind: 'dsbot.project-control-center',
        generatedAt,
        status: statusValue,
        currentCapability: current.currentCapability,
        currentTask: current.currentTask,
        activeAgent: current.activeAgent,
        repository: {
          identity,
          identityVerified,
          branch: branch || '(detached)',
          worktree: path.resolve(worktree),
          commitSha: head,
          upstream: upstream || undefined,
          changedFiles,
          integrationBranch: current.integrationBranch,
          integrationHead,
        },
        pullRequest,
        ci: {
          status: pullRequest && pullRequest.state !== 'MERGED' && !headShaMatchesDeliveryRef
            ? 'PENDING'
            : ciStatus(checks, current.requiredRemoteChecks),
          checks,
          requiredChecks: [...current.requiredRemoteChecks],
          missingRequiredChecks,
          headShaMatchesDeliveryRef,
        },
        localTests,
        remoteTests: checks,
        blockers: dynamicBlockers,
        dataGaps,
        nextAction: current.nextAction,
        eventTimeline: structuredClone(timeline),
        promotedStrategyCount: 0,
        approvals: structuredClone(current.approvals),
        boundaries: {
          readOnlyDashboard: true,
          dashboardGrantsApproval: false,
          tradingEnvironmentActivated: false,
        },
      };
    },
    observe(event) {
      const result = event.result?.ok === true ? 'PASS' : event.result?.ok === false ? 'FAIL' : 'OBSERVED';
      pushTimeline({ timestamp: event.timestamp, actor: event.actor, action: event.action, result, evidenceId: event.eventId });
      if (snapshot) snapshot.eventTimeline = structuredClone(timeline);
      const searchable = `${event.action} ${event.target ?? ''} ${event.result?.summary ?? ''}`;
      if (event.result?.exitCode !== undefined && /(?:test|typecheck|build|security|audit)/i.test(searchable)) {
        observedTests.push({
          command: event.target ?? event.action,
          exitCode: event.result.exitCode,
          completedAt: event.timestamp,
          source: 'observable-event',
          summary: event.result.summary,
        });
        while (observedTests.length > 50) observedTests.shift();
        if (snapshot) snapshot.localTests = [...snapshot.localTests, observedTests.at(-1)!].slice(-50);
      }
    },
    snapshot() {
      if (!snapshot) throw new Error('Project Control Center has not been refreshed');
      return structuredClone(snapshot);
    },
  };
}
