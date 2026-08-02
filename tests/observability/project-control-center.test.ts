import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObservableAgentEvent } from '../../src/observability/contracts';
import {
  CONTROL_CENTER_STATUSES,
  createProjectControlCenter,
  type ControlCenterConfig,
} from '../../src/observability/project-control-center';

const HEAD = '1'.repeat(40);
const MERGE = '2'.repeat(40);

function config(): ControlCenterConfig {
  const approval = (source: string) => ({ approved: false as const, source, limitation: 'Not authorized' });
  return {
    schemaVersion: '1.0', repository: 'wengecaitui/DSbot',
    integrationBranch: 'feature/orangeai-split', deliveryBranch: 'agent/project-control-center',
    currentCapability: 'Project Control Center', currentTask: 'Evidence loop',
    activeAgent: 'Codex', nextAction: 'Verify',
    requiredLocalGates: [{ id: 'focused', executable: 'npm.cmd', args: ['run', 'test:control-center'] }],
    requiredRemoteChecks: ['build'], promotedStrategyCount: 0, blockers: [],
    approvals: {
      replay: approval('replay'), shadow: approval('shadow'), paper: approval('paper'),
      testnet: approval('testnet'), live: approval('live'),
    },
  };
}

function runner(input: {
  status?: string;
  remote?: string;
  integrationHead?: string;
  githubIntegrationHead?: string;
  remoteBranchHead?: string;
  githubRemoteBranchHead?: string;
  prs?: unknown[];
}) {
  return async (executable: string, args: string[]): Promise<string> => {
    const key = `${executable} ${args.join(' ')}`;
    if (key.includes('rev-parse --show-toplevel')) return 'E:/repo';
    if (key.includes('branch --show-current')) return 'agent/project-control-center';
    if (key.includes('rev-parse HEAD')) return HEAD;
    if (key.includes('remote get-url origin')) return input.remote ?? 'https://github.com/wengecaitui/DSbot.git';
    if (key.includes('@{upstream}')) return 'origin/agent/project-control-center';
    if (key.includes('status --porcelain')) return input.status ?? '';
    if (key.includes('ls-remote --heads origin refs/heads/feature/orangeai-split')) {
      if (!input.integrationHead) throw new Error('missing integration ref');
      return `${input.integrationHead}\trefs/heads/feature/orangeai-split`;
    }
    if (key.includes('ls-remote --heads origin refs/heads/agent/project-control-center')) {
      if (!input.remoteBranchHead) throw new Error('missing branch ref');
      return `${input.remoteBranchHead}\trefs/heads/agent/project-control-center`;
    }
    if (key.includes('rev-parse refs/heads/agent/project-control-center')) return input.remoteBranchHead ?? HEAD;
    if (executable === 'gh' && args[0] === 'api') {
      const route = args[1] ?? '';
      if (route.includes('feature%2Forangeai-split') && input.githubIntegrationHead) return input.githubIntegrationHead;
      if (route.includes('agent%2Fproject-control-center') && input.githubRemoteBranchHead) return input.githubRemoteBranchHead;
      throw new Error('missing GitHub ref');
    }
    if (executable === 'gh') return JSON.stringify(input.prs ?? []);
    throw new Error(`Unexpected command: ${key}`);
  };
}

test('Control Center exposes the exact workflow vocabulary and fail-closed approvals', async () => {
  assert.deepEqual(CONTROL_CENTER_STATUSES, [
    'PLANNED', 'IMPLEMENTING', 'LOCAL_VERIFIED', 'PUSHED', 'PR_OPEN',
    'REMOTE_CI_VERIFIED', 'MERGED', 'INTEGRATION_VERIFIED', 'CLOSED', 'BLOCKED',
  ]);
  const center = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ status: ' M src/a.ts', integrationHead: HEAD }),
    readFile: async () => { throw new Error('no local evidence'); },
    now: () => new Date('2026-08-02T00:00:00.000Z'),
  });
  await center.refresh();
  const snapshot = center.snapshot();
  assert.equal(snapshot.status, 'IMPLEMENTING');
  assert.deepEqual(snapshot.repository.changedFiles, ['src/a.ts']);
  assert.equal(snapshot.repository.identityVerified, true);
  assert.equal(snapshot.promotedStrategyCount, 0);
  assert.equal(Object.values(snapshot.approvals).every(value => value.approved === false), true);
  assert.equal(snapshot.boundaries.tradingEnvironmentActivated, false);
  assert.equal(snapshot.dataGaps.some(item => item.includes('Local test evidence unavailable')), true);
});

test('Control Center falls back to authenticated GitHub when git remote-head lookup fails', async () => {
  const center = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ githubIntegrationHead: MERGE }),
    readFile: async () => { throw new Error('no local evidence'); },
  });
  await center.refresh();
  assert.equal(center.snapshot().repository.integrationHead, MERGE);
  assert.equal(center.snapshot().dataGaps.some(item => item.includes('Remote integration ref')), false);

  const unavailable = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({}),
    readFile: async () => { throw new Error('no local evidence'); },
  });
  await unavailable.refresh();
  assert.equal(unavailable.snapshot().repository.integrationHead, undefined);
  assert.equal(unavailable.snapshot().dataGaps.some(item => item.includes('unavailable from Git and GitHub')), true);
});

test('Control Center derives remote CI and integration verification from PR evidence', async () => {
  const successfulPr = {
    number: 91, url: 'https://github.com/wengecaitui/DSbot/pull/91', state: 'OPEN', isDraft: true,
    headRefOid: HEAD, mergeCommit: null, reviewDecision: '',
    statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.test/check' }],
  };
  const open = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ integrationHead: HEAD, remoteBranchHead: HEAD, prs: [successfulPr] }),
    readFile: async () => { throw new Error('missing'); },
  });
  await open.refresh();
  assert.equal(open.snapshot().status, 'REMOTE_CI_VERIFIED');
  assert.equal(open.snapshot().ci.status, 'PASS');

  const merged = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ integrationHead: MERGE, remoteBranchHead: HEAD, prs: [{ ...successfulPr, state: 'MERGED', mergeCommit: { oid: MERGE } }] }),
    readFile: async () => { throw new Error('missing'); },
  });
  await merged.refresh();
  assert.equal(merged.snapshot().status, 'INTEGRATION_VERIFIED');
});

test('Control Center does not verify remote CI when a required check is absent', async () => {
  const strict = config();
  strict.requiredRemoteChecks = ['build', 'security'];
  const center = createProjectControlCenter({
    repoPath: 'E:/repo', config: strict,
    runCommand: runner({
      integrationHead: HEAD, remoteBranchHead: HEAD,
      prs: [{
        number: 91, url: 'https://github.com/wengecaitui/DSbot/pull/91', state: 'OPEN', isDraft: true,
        headRefOid: HEAD, mergeCommit: null,
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }],
    }),
    readFile: async () => { throw new Error('missing'); },
  });
  await center.refresh();
  assert.equal(center.snapshot().ci.status, 'PENDING');
  assert.equal(center.snapshot().status, 'PR_OPEN');
});

test('Control Center requires SUCCESS for required checks and rejects skipped or neutral', async () => {
  for (const conclusion of ['SKIPPED', 'NEUTRAL']) {
    const center = createProjectControlCenter({
      repoPath: 'E:/repo', config: config(),
      runCommand: runner({
        integrationHead: HEAD, remoteBranchHead: HEAD,
        prs: [{
          number: 91, url: 'https://github.com/wengecaitui/DSbot/pull/91', state: 'OPEN', isDraft: true,
          headRefOid: HEAD, mergeCommit: null,
          statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion }],
        }],
      }),
      readFile: async () => { throw new Error('missing'); },
    });
    await center.refresh();
    assert.equal(center.snapshot().ci.status, 'PENDING');
    assert.equal(center.snapshot().status, 'PR_OPEN');
  }
});

test('Control Center does not verify stale PR checks or a dirty delivery worktree', async () => {
  const successfulPr = {
    number: 91, url: 'https://github.com/wengecaitui/DSbot/pull/91', state: 'OPEN', isDraft: true,
    headRefOid: HEAD, mergeCommit: null,
    statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  const stale = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ integrationHead: HEAD, remoteBranchHead: '3'.repeat(40), prs: [successfulPr] }),
    readFile: async () => { throw new Error('missing'); },
  });
  await stale.refresh();
  assert.equal(stale.snapshot().status, 'PR_OPEN');
  assert.equal(stale.snapshot().ci.status, 'PENDING');
  assert.equal(stale.snapshot().ci.headShaMatchesDeliveryRef, false);

  const dirty = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ status: ' M src/a.ts', integrationHead: HEAD, remoteBranchHead: HEAD, prs: [successfulPr] }),
    readFile: async () => { throw new Error('missing'); },
  });
  await dirty.refresh();
  assert.equal(dirty.snapshot().status, 'IMPLEMENTING');
});

test('Control Center records test exit codes from observable evidence without inferring a percentage', async () => {
  const center = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ integrationHead: HEAD }),
    readFile: async () => { throw new Error('missing'); },
  });
  const event: ObservableAgentEvent = {
    schemaVersion: '1.0', eventId: 'test-1', runId: 'run-1', timestamp: '2026-08-02T00:00:00.000Z',
    actor: 'hermes', source: 'tool', action: 'test.completed', target: 'npm.cmd run typecheck',
    riskClass: 'R0_READ_ONLY', evidenceLevel: 'VERIFIED_TESTED', result: { ok: true, exitCode: 0, summary: 'passed' },
  };
  center.observe(event);
  await center.refresh();
  const snapshot = center.snapshot();
  assert.equal(snapshot.localTests[0]?.command, 'npm.cmd run typecheck');
  assert.equal(snapshot.localTests[0]?.exitCode, 0);
  assert.equal(snapshot.eventTimeline[0]?.evidenceId, 'test-1');
  assert.equal('observedProgress' in snapshot, false);
});

test('Control Center rejects dirty-worktree test evidence as a local verification gate', async () => {
  const center = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ status: ' M src/a.ts', integrationHead: HEAD }),
    readFile: async () => JSON.stringify({
      schemaVersion: '2.0',
      commands: [{
        gateId: 'focused', command: 'npm.cmd run test:control-center', exitCode: 0,
        completedAt: '2026-08-02T00:00:00.000Z', beforeSha: HEAD, afterSha: HEAD,
        beforeClean: false, afterClean: false,
      }],
    }),
  });
  await center.refresh();
  const snapshot = center.snapshot();
  assert.equal(snapshot.localTests.length, 0);
  assert.equal(snapshot.status, 'IMPLEMENTING');
  assert.equal(snapshot.dataGaps.some(item => item.includes('Missing clean SHA-bound local gates')), true);
});

test('Control Center requires every configured clean SHA-bound local gate', async () => {
  const strict = config();
  strict.requiredLocalGates.push({ id: 'build', executable: 'npm.cmd', args: ['run', 'build'] });
  const evidence = (commands: unknown[]) => JSON.stringify({ schemaVersion: '2.0', commands });
  const focused = {
    gateId: 'focused', command: 'npm.cmd run test:control-center', exitCode: 0,
    completedAt: '2026-08-02T00:00:00.000Z', beforeSha: HEAD, afterSha: HEAD,
    beforeClean: true, afterClean: true,
  };
  const partial = createProjectControlCenter({
    repoPath: 'E:/repo', config: strict, runCommand: runner({ integrationHead: HEAD }),
    readFile: async () => evidence([focused]),
  });
  await partial.refresh();
  assert.equal(partial.snapshot().status, 'IMPLEMENTING');
  assert.equal(partial.snapshot().dataGaps.some(item => item.includes('build')), true);

  const complete = createProjectControlCenter({
    repoPath: 'E:/repo', config: strict, runCommand: runner({ integrationHead: HEAD }),
    readFile: async () => evidence([focused, {
      gateId: 'build', command: 'npm.cmd run build', exitCode: 0,
      completedAt: '2026-08-02T00:01:00.000Z', beforeSha: HEAD, afterSha: HEAD,
      beforeClean: true, afterClean: true,
    }]),
  });
  await complete.refresh();
  assert.equal(complete.snapshot().status, 'LOCAL_VERIFIED');
});

test('Control Center blocks closed PRs and merged PRs not bound to the delivery identity', async () => {
  const basePr = {
    number: 91, url: 'https://github.com/wengecaitui/DSbot/pull/91', isDraft: false,
    headRefOid: HEAD, statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  const closed = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ integrationHead: HEAD, remoteBranchHead: HEAD, prs: [{ ...basePr, state: 'CLOSED', mergeCommit: null }] }),
    readFile: async () => { throw new Error('missing'); },
  });
  await closed.refresh();
  assert.equal(closed.snapshot().status, 'BLOCKED');
  assert.equal(closed.snapshot().blockers.some(item => item.includes('closed without merge')), true);

  const staleMerged = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ integrationHead: MERGE, remoteBranchHead: '3'.repeat(40), prs: [{ ...basePr, state: 'MERGED', mergeCommit: { oid: MERGE } }] }),
    readFile: async () => { throw new Error('missing'); },
  });
  await staleMerged.refresh();
  assert.equal(staleMerged.snapshot().status, 'BLOCKED');
  assert.equal(staleMerged.snapshot().blockers.some(item => item.includes('does not bind')), true);
});

test('Control Center discloses missing remote delivery evidence when a local ref binds a merged PR', async () => {
  const center = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({
      integrationHead: MERGE,
      prs: [{
        number: 91, url: 'https://github.com/wengecaitui/DSbot/pull/91', state: 'MERGED', isDraft: false,
        headRefOid: HEAD, mergeCommit: { oid: MERGE },
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }],
    }),
    readFile: async () => { throw new Error('missing'); },
  });
  await center.refresh();
  assert.equal(center.snapshot().status, 'INTEGRATION_VERIFIED');
  assert.equal(center.snapshot().dataGaps.some(item => item.includes('local ref is identity continuity only')), true);
});

test('Control Center blocks on repository identity mismatch and never relaxes approvals', async () => {
  const center = createProjectControlCenter({
    repoPath: 'E:/repo', config: config(),
    runCommand: runner({ remote: 'https://github.com/attacker/not-dsbot.git', integrationHead: HEAD }),
    readFile: async () => { throw new Error('missing'); },
  });
  await center.refresh();
  const snapshot = center.snapshot();
  assert.equal(snapshot.status, 'BLOCKED');
  assert.equal(snapshot.repository.identityVerified, false);
  assert.equal(snapshot.approvals.live.approved, false);
  assert.equal(snapshot.boundaries.dashboardGrantsApproval, false);
});
