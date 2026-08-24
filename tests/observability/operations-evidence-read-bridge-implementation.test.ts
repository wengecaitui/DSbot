import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createOperationsEvidenceReadBridge,
  createOperationsEvidenceSourceHealthModel,
  type OperationsEvidenceReadBridge,
} from '../../src/observability/OperationsEvidenceReadBridge';
import { createPollingAdapter } from '../../src/observability/adapters/polling-adapter';
import { createGitWorkspaceAdapter } from '../../src/observability/adapters/git-workspace-adapter';
import { createHermesRuntimeAdapter } from '../../src/observability/adapters/hermes-runtime-adapter';
import { createHermesLogAdapter } from '../../src/observability/adapters/hermes-log-adapter';
import { createWorkbenchReadAdapter } from '../../src/observability/workbench-read-adapter';
import { createProjectControlCenter, type ControlCenterConfig } from '../../src/observability/project-control-center';
import { EvidenceCommandTimeoutError, runBoundedEvidenceCommand } from '../../src/observability/bounded-command';
import type { CoordinatorSnapshot } from '../../src/hermes/types';
import type {
  ObservableAgentEvent,
  ObservableEventSink,
  ObservableEventSourceAdapter,
  RawObservableEvent,
} from '../../src/observability/contracts';
import type { ProjectControlCenter, ProjectControlCenterSnapshot } from '../../src/observability/project-control-center';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makePccSnapshot(): ProjectControlCenterSnapshot {
  const approval = { approved: false as const, source: 'test', limitation: 'test' };
  return {
    schemaVersion: '1.0',
    kind: 'dsbot.project-control-center',
    generatedAt: new Date(0).toISOString(),
    status: 'IMPLEMENTING',
    currentCapability: 'Phase 8B',
    currentTask: 'test',
    activeAgent: 'test',
    repository: { identity: 'wengecaitui/DSbot', identityVerified: true, branch: 'main', worktree: '/repo', commitSha: 'a'.repeat(40), changedFiles: [], integrationBranch: 'feature/orangeai-split' },
    ci: { status: 'UNAVAILABLE', checks: [], requiredChecks: [], missingRequiredChecks: [], headShaMatchesDeliveryRef: false },
    localTests: [],
    remoteTests: [],
    runtimeSmokeVerified: false,
    blockers: [],
    dataGaps: [],
    nextAction: '',
    eventTimeline: [],
    promotedStrategyCount: 0,
    approvals: { replay: approval, shadow: approval, paper: approval, testnet: approval, live: approval },
    boundaries: { readOnlyDashboard: true, dashboardGrantsApproval: false, tradingEnvironmentActivated: false },
  } as ProjectControlCenterSnapshot;
}

function fakePcc(opts?: { refreshError?: Error }) {
  let refreshes = 0;
  const observed: ObservableAgentEvent[] = [];
  const snapshot = makePccSnapshot();
  const pcc: ProjectControlCenter = {
    async refresh() { refreshes += 1; if (opts?.refreshError) throw opts.refreshError; },
    observe(event: ObservableAgentEvent) { observed.push(event); },
    snapshot() { return snapshot; },
  };
  return { pcc, refreshes: () => refreshes, observed: () => observed, snapshot };
}

function fakeAdapter(name: string, events: RawObservableEvent[] = [], opts?: { startError?: Error; stopError?: Error }) {
  let starts = 0;
  let stops = 0;
  const adapter: ObservableEventSourceAdapter = {
    name,
    async start(sink: ObservableEventSink) {
      starts += 1;
      if (opts?.startError) throw opts.startError;
      for (const event of events) await sink.emit(event);
    },
    async stop() {
      stops += 1;
      if (opts?.stopError) throw opts.stopError;
    },
  };
  return { adapter, starts: () => starts, stops: () => stops };
}

function rawEvent(partial: Partial<RawObservableEvent> & { action: string; source: RawObservableEvent['source'] }): RawObservableEvent {
  return partial;
}

const bridgeSource = () => readFileSync(new URL('../../src/observability/OperationsEvidenceReadBridge.ts', import.meta.url), 'utf8');
const gatewaySource = () => readFileSync(new URL('../../src/gateway/index.ts', import.meta.url), 'utf8');

const healthyHermes: CoordinatorSnapshot = {
  state: 'running', generation: 1, health: 'healthy', circuitState: 'closed',
  consecutiveHealthFailures: 0, startedAt: 1, stoppedAt: null,
  lastHealthConfirmedAt: 1, lastHealthStatus: 'healthy',
  trackedReceiptCount: 0, consumedReceiptCount: 0,
};

function workbenchFor(bridge: OperationsEvidenceReadBridge) {
  return createWorkbenchReadAdapter({
    now: () => Date.now(),
    runtime: () => ({ health: 'HEALTHY', environment: 'unknown', mode: 'test' }),
    hermes: () => healthyHermes,
    projectControlCenter: bridge.read.projectControlCenter,
    activity: bridge.read.activity,
    operationsEvidenceStatus: bridge.read.status,
  });
}

describe('Phase 8B Operations Evidence Read Bridge implementation', () => {
  describe('ownership and lifecycle', () => {
    it('creates exactly one bridge and repeated start does not duplicate sources', async () => {
      const probe = fakeAdapter('probe');
      const bridge = createOperationsEvidenceReadBridge({ sources: [probe.adapter] });
      await bridge.start();
      await bridge.start();
      assert.equal(probe.starts(), 1, 'repeated start must not start the source twice');
      assert.equal(bridge.read.status().running, true);
      await bridge.stop();
      await bridge.stop();
      assert.equal(probe.stops(), 1, 'repeated stop must not stop the source twice');
      assert.equal(bridge.read.status().running, false);
    });

    it('isolates a failing source start without throwing', async () => {
      const failing = fakeAdapter('failing', [], { startError: new Error('SOURCE_START_FAILED') });
      const bridge = createOperationsEvidenceReadBridge({ sources: [failing.adapter] });
      await assert.doesNotReject(() => bridge.start());
      assert.equal(bridge.read.status().running, false, 'bridge must not claim running on source-start failure');
      assert.ok(bridge.read.status().sourceFailures >= 1);
    });

    it('isolates a failing source stop without throwing', async () => {
      const failing = fakeAdapter('stop-failing', [], { stopError: new Error('SOURCE_STOP_FAILED') });
      const bridge = createOperationsEvidenceReadBridge({ sources: [failing.adapter] });
      await bridge.start();
      await assert.doesNotReject(() => bridge.stop());
      assert.equal(bridge.read.status().running, false);
    });

    it('exposes only read evidence — no start/stop/sources/control on the read view', () => {
      const bridge = createOperationsEvidenceReadBridge({});
      const readKeys = Object.keys(bridge.read).sort();
      assert.deepEqual(readKeys, ['activity', 'projectControlCenter', 'status']);
      for (const forbidden of ['start', 'stop', 'monitor', 'sources', 'sink', 'ingest']) {
        assert.ok(!(forbidden in bridge.read), `read view must not expose ${forbidden}`);
      }
    });
  });

  describe('workbench binding', () => {
    it('publishes actually defensive PCC evidence after a successful refresh', async () => {
      const { pcc, snapshot } = fakePcc();
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc });
      await bridge.start();
      const published = bridge.read.projectControlCenter();
      assert.ok(published, 'PCC must be published after refresh');
      assert.notStrictEqual(published, snapshot, 'bridge must not expose the injected snapshot reference');
      assert.deepEqual(published, snapshot);
      published.repository.commitSha = 'b'.repeat(40);
      assert.equal(bridge.read.projectControlCenter()?.repository.commitSha, 'a'.repeat(40));
      assert.equal(bridge.read.status().projectControlCenterAvailable, true);
      await bridge.stop();
    });

    it('publishes null PCC when refresh fails (no stale-snapshot masquerade)', async () => {
      const { pcc } = fakePcc({ refreshError: new Error('PCC_REFRESH_FAILED') });
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc });
      await bridge.start();
      assert.equal(bridge.read.projectControlCenter(), null);
      assert.equal(bridge.read.status().projectControlCenterAvailable, false);
      assert.ok(bridge.read.status().sourceFailures >= 1);
      await bridge.stop();
    });

    it('routes normalized source events into the bounded activity buffer', async () => {
      const probe = fakeAdapter('events', [
        rawEvent({ source: 'process', action: 'runtime.observed', evidenceLevel: 'VERIFIED_OBSERVED' }),
        rawEvent({ source: 'git', action: 'git.snapshot', evidenceLevel: 'VERIFIED_OBSERVED' }),
      ]);
      const bridge = createOperationsEvidenceReadBridge({ sources: [probe.adapter] });
      await bridge.start();
      const activity = bridge.read.activity();
      assert.equal(activity.length, 2);
      assert.ok(activity.every((event) => event.schemaVersion === '1.0' && event.eventId));
    });

    it('feeds normalized events into Project Control Center observation', async () => {
      const { pcc, observed } = fakePcc();
      const probe = fakeAdapter('events', [rawEvent({ source: 'tool', action: 'tool.observed' })]);
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [probe.adapter] });
      await bridge.start();
      assert.equal(observed().length, 1);
      await bridge.stop();
    });
  });

  describe('current source failure truth', () => {
    it('makes a configured Git poll failure visible and prevents AVAILABLE/FRESH Operations', async () => {
      const health = createOperationsEvidenceSourceHealthModel([{ source: 'git-workspace', configured: true }]);
      const callbacks = health.callbacks('git-workspace');
      const adapter = createGitWorkspaceAdapter({
        repoPath: '.', intervalMs: 100,
        readSnapshot: async () => { throw new Error('GIT_POLL_FAILED'); },
        onSuccess: callbacks.onSuccess, onError: callbacks.onError,
      });
      const { pcc } = fakePcc();
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [adapter], sourceHealth: health });
      await bridge.start();
      const status = bridge.read.status();
      assert.equal(status.sources[0].state, 'FAILING');
      assert.equal(status.sources[0].lastError, 'GIT_POLL_FAILED');
      const operations = workbenchFor(bridge).operations();
      assert.notEqual(operations.availability, 'AVAILABLE');
      assert.notEqual(operations.freshness, 'FRESH', 'healthy HandshakeCoordinator cannot mask source failure');
      await bridge.stop();
    });

    it('makes a configured Hermes runtime poll failure visible', async () => {
      const health = createOperationsEvidenceSourceHealthModel([{ source: 'hermes-runtime', configured: true }]);
      const callbacks = health.callbacks('hermes-runtime');
      const adapter = createHermesRuntimeAdapter({
        stateFile: 'missing-state.json', intervalMs: 100,
        probe: async () => { throw new Error('HERMES_RUNTIME_POLL_FAILED'); },
        onSuccess: callbacks.onSuccess, onError: callbacks.onError,
      });
      const { pcc } = fakePcc();
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [adapter], sourceHealth: health });
      await bridge.start();
      assert.deepEqual(
        bridge.read.status().sources.map(({ source, state, lastError }) => ({ source, state, lastError })),
        [{ source: 'hermes-runtime', state: 'FAILING', lastError: 'HERMES_RUNTIME_POLL_FAILED' }],
      );
      await bridge.stop();
    });

    it('makes a configured Hermes log poll failure visible', async () => {
      const health = createOperationsEvidenceSourceHealthModel([{ source: 'hermes-log', configured: true }]);
      const callbacks = health.callbacks('hermes-log');
      const adapter = createHermesLogAdapter({
        files: ['hermes.log'], intervalMs: 100,
        readStat: async () => { throw Object.assign(new Error('HERMES_LOG_POLL_FAILED'), { code: 'EACCES' }); },
        onSuccess: callbacks.onSuccess, onError: callbacks.onError,
      });
      const { pcc } = fakePcc();
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [adapter], sourceHealth: health });
      await bridge.start();
      assert.equal(bridge.read.status().sources[0].state, 'FAILING');
      assert.equal(bridge.read.status().sources[0].lastError, 'HERMES_LOG_POLL_FAILED');
      await bridge.stop();
    });

    it('recovers current source health after a later successful poll', async () => {
      let attempts = 0;
      const health = createOperationsEvidenceSourceHealthModel([{ source: 'git-workspace', configured: true }]);
      const callbacks = health.callbacks('git-workspace');
      const adapter = createGitWorkspaceAdapter({
        repoPath: '.', intervalMs: 100,
        readSnapshot: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('TRANSIENT_GIT_FAILURE');
          return { branch: 'repair', head: 'c'.repeat(40), entries: [] };
        },
        onSuccess: callbacks.onSuccess, onError: callbacks.onError,
      });
      const { pcc } = fakePcc();
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [adapter], sourceHealth: health });
      await bridge.start();
      assert.equal(bridge.read.status().sources[0].state, 'FAILING');
      await sleep(180);
      const recovered = bridge.read.status();
      assert.equal(recovered.sources[0].state, 'HEALTHY');
      assert.equal(recovered.sources[0].failureCount, 1, 'history remains diagnostic, not current health');
      assert.equal(recovered.availability, 'AVAILABLE');
      assert.equal(recovered.freshness, 'FRESH');
      await bridge.stop();
    });

    it('distinguishes unconfigured from configured-and-failing sources', () => {
      const health = createOperationsEvidenceSourceHealthModel([
        { source: 'git-workspace', configured: false },
        { source: 'hermes-runtime', configured: true },
      ]);
      health.callbacks('hermes-runtime').onError(new Error('FAILED'));
      assert.deepEqual(
        health.snapshot().map(({ source, configured, state }) => ({ source, configured, state })),
        [
          { source: 'git-workspace', configured: false, state: 'UNCONFIGURED' },
          { source: 'hermes-runtime', configured: true, state: 'FAILING' },
        ],
      );
    });
  });

  describe('Activity evidence truth', () => {
    it('keeps healthy buffered activity AVAILABLE/FRESH', async () => {
      const { pcc } = fakePcc();
      const probe = fakeAdapter('activity', [rawEvent({ source: 'process', action: 'runtime.observed' })]);
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [probe.adapter] });
      await bridge.start();
      const activity = workbenchFor(bridge).activity();
      assert.equal(activity.availability, 'AVAILABLE');
      assert.equal(activity.freshness, 'FRESH');
      assert.equal(activity.data?.events.length, 1);
      assert.equal(activity.provenance.lastUpdatedAt, bridge.read.status().lastUpdatedAt);
      await bridge.stop();
    });

    it('keeps historical events readable but not AVAILABLE/FRESH after bridge stop', async () => {
      const { pcc } = fakePcc();
      const probe = fakeAdapter('activity', [rawEvent({ source: 'process', action: 'runtime.observed' })]);
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [probe.adapter] });
      await bridge.start();
      await bridge.stop();
      const activity = workbenchFor(bridge).activity();
      assert.equal(activity.data?.events.length, 1);
      assert.notEqual(activity.availability, 'AVAILABLE');
      assert.notEqual(activity.freshness, 'FRESH');
    });

    it('cannot report buffered activity AVAILABLE/FRESH while a configured source is failing', async () => {
      const health = createOperationsEvidenceSourceHealthModel([{ source: 'git-workspace', configured: true }]);
      const probe = fakeAdapter('activity', [rawEvent({ source: 'git', action: 'git.snapshot' })]);
      const { pcc } = fakePcc();
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [probe.adapter], sourceHealth: health });
      await bridge.start();
      health.callbacks('git-workspace').onError(new Error('GIT_FAILED'));
      const activity = workbenchFor(bridge).activity();
      assert.equal(activity.data?.events.length, 1);
      assert.equal(activity.availability, 'INCOMPLETE');
      assert.equal(activity.freshness, 'STALE');
      await bridge.stop();
    });
  });

  describe('published error redaction', () => {
    it('redacts and bounds source/PCC error messages before Workbench publication', async () => {
      const rawError = [
        'Authorization: Bearer BEARER_SECRET',
        'token=TOKEN_SECRET',
        'password=PASSWORD_SECRET',
        'apiKey=APIKEY_SECRET',
        'x'.repeat(1_000),
      ].join(' ');
      const health = createOperationsEvidenceSourceHealthModel([{ source: 'git-workspace', configured: true }]);
      health.callbacks('git-workspace').onError(new Error(rawError));
      const { pcc } = fakePcc({ refreshError: new Error(rawError) });
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sourceHealth: health });
      await bridge.start();
      const serialized = JSON.stringify(workbenchFor(bridge).operations());
      for (const secret of ['BEARER_SECRET', 'TOKEN_SECRET', 'PASSWORD_SECRET', 'APIKEY_SECRET']) {
        assert.ok(!serialized.includes(secret), `Workbench must not expose ${secret}`);
      }
      assert.match(serialized, /<REDACTED>/);
      const status = bridge.read.status();
      assert.ok((status.sources[0].lastError?.length ?? 0) <= 512);
      assert.ok((status.projectControlCenter.lastError?.length ?? 0) <= 512);
      await bridge.stop();
    });
  });

  describe('Project Control Center freshness and terminal lifecycle', () => {
    it('refreshes PCC again and publishes changed HEAD, PR, and CI evidence', async () => {
      let refreshes = 0;
      let current = makePccSnapshot();
      const pcc: ProjectControlCenter = {
        async refresh() {
          refreshes += 1;
          if (refreshes === 2) {
            current = structuredClone(current);
            current.repository.commitSha = 'd'.repeat(40);
            current.pullRequest = { number: 125, url: 'https://example.test/pr/125', state: 'OPEN', isDraft: true, headSha: 'd'.repeat(40), checks: [] };
            current.ci.status = 'PASS';
          }
        },
        observe() {},
        snapshot() { return current; },
      };
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, projectControlCenterRefreshIntervalMs: 100 });
      await bridge.start();
      assert.equal(bridge.read.projectControlCenter()?.repository.commitSha, 'a'.repeat(40));
      await sleep(150);
      const refreshed = bridge.read.projectControlCenter();
      assert.ok(refreshes >= 2);
      assert.equal(refreshed?.repository.commitSha, 'd'.repeat(40));
      assert.equal(refreshed?.pullRequest?.number, 125);
      assert.equal(refreshed?.ci.status, 'PASS');
      assert.ok(bridge.read.status().projectControlCenter.lastSuccessfulRefreshAt !== null);
      await bridge.stop();
    });

    it('retains last-known-good PCC as STALE after refresh failure', async () => {
      let refreshes = 0;
      const snapshot = makePccSnapshot();
      const pcc: ProjectControlCenter = {
        async refresh() {
          refreshes += 1;
          if (refreshes > 1) throw new Error('PCC_REFRESH_FAILED_AFTER_START');
        },
        observe() {},
        snapshot() { return snapshot; },
      };
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, projectControlCenterRefreshIntervalMs: 100 });
      await bridge.start();
      await sleep(150);
      assert.equal(bridge.read.projectControlCenter()?.repository.commitSha, 'a'.repeat(40));
      assert.equal(bridge.read.status().projectControlCenter.state, 'FAILING');
      assert.equal(bridge.read.status().freshness, 'STALE');
      const operations = workbenchFor(bridge).operations();
      assert.equal(operations.availability, 'INCOMPLETE');
      assert.equal(operations.freshness, 'STALE', 'handshake health is not Operations freshness authority');
      await bridge.stop();
    });

    it('marks PCC stale when successful evidence exceeds its bounded maximum age', async () => {
      let clock = 1_000;
      const { pcc } = fakePcc();
      const bridge = createOperationsEvidenceReadBridge({
        projectControlCenter: pcc,
        projectControlCenterRefreshIntervalMs: 100,
        now: () => clock,
      });
      await bridge.start();
      assert.equal(bridge.read.status().freshness, 'FRESH');
      clock = 1_201;
      assert.equal(bridge.read.status().freshness, 'STALE');
      assert.equal(workbenchFor(bridge).operations().availability, 'INCOMPLETE');
      await bridge.stop();
    });

    it('stops both PCC refresh and source polling with no orphan activity', async () => {
      let refreshes = 0;
      let polls = 0;
      const snapshot = makePccSnapshot();
      const pcc: ProjectControlCenter = {
        async refresh() { refreshes += 1; }, observe() {}, snapshot() { return snapshot; },
      };
      const poller = createPollingAdapter({ name: 'poll-probe', intervalMs: 100, poll: () => { polls += 1; } });
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [poller], projectControlCenterRefreshIntervalMs: 100 });
      await bridge.start();
      await sleep(150);
      await bridge.stop();
      const stopped = { refreshes, polls };
      await sleep(180);
      assert.deepEqual({ refreshes, polls }, stopped);
      assert.equal(bridge.read.status().projectControlCenter.state, 'STOPPED');
      assert.equal(bridge.read.status().availability, 'UNAVAILABLE');
    });

    it('rejects start after stop instead of silently reusing the old start promise', async () => {
      const bridge = createOperationsEvidenceReadBridge({});
      await bridge.start();
      await bridge.stop();
      await assert.rejects(() => bridge.start(), /terminal after stop/);
    });

    it('turns a hanging PCC command into bounded evidence failure without blocking start', async () => {
      const config = JSON.parse(readFileSync(new URL('../../config/control-center/project-state.json', import.meta.url), 'utf8')) as ControlCenterConfig;
      const pcc = createProjectControlCenter({
        repoPath: '.', config,
        readFile: async () => { throw new Error('not needed before command timeout'); },
        runCommand: (_executable, _args, _cwd, signal) => new Promise((_resolve, reject) => {
          const fail = () => reject(signal?.reason ?? new Error('aborted'));
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail, { once: true });
        }),
      });
      const bridge = createOperationsEvidenceReadBridge({
        projectControlCenter: pcc,
        projectControlCenterRefreshTimeoutMs: 100,
      });
      const started = Date.now();
      await bridge.start();
      assert.ok(Date.now() - started < 1_000, 'initial evidence timeout must not hang gateway progression');
      assert.equal(bridge.read.status().running, true);
      assert.equal(bridge.read.status().projectControlCenter.state, 'FAILING');
      assert.match(bridge.read.status().projectControlCenter.lastError ?? '', /timed out after 100 ms/);
      await bridge.stop();
    });

    it('aborts an in-flight PCC refresh so stop remains bounded', async () => {
      let refreshes = 0;
      let aborts = 0;
      const snapshot = makePccSnapshot();
      const pcc: ProjectControlCenter = {
        async refresh(signal) {
          refreshes += 1;
          if (refreshes === 1) return;
          await new Promise<void>((_resolve, reject) => {
            const fail = () => { aborts += 1; reject(signal?.reason ?? new Error('aborted')); };
            if (signal?.aborted) fail();
            else signal?.addEventListener('abort', fail, { once: true });
          });
        },
        observe() {}, snapshot() { return snapshot; },
      };
      const bridge = createOperationsEvidenceReadBridge({
        projectControlCenter: pcc,
        projectControlCenterRefreshIntervalMs: 100,
        projectControlCenterRefreshTimeoutMs: 10_000,
      });
      await bridge.start();
      await sleep(150);
      const stopped = Date.now();
      await bridge.stop();
      assert.ok(Date.now() - stopped < 1_000, 'stop must abort rather than await a hanging refresh deadline');
      assert.equal(aborts, 1);
      const afterStop = refreshes;
      await sleep(150);
      assert.equal(refreshes, afterStop);
    });
  });

  describe('native command deadlines', () => {
    it('terminates a timed-out child process instead of leaving orphan work', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'phase8b-command-'));
      const marker = join(directory, 'orphan.txt');
      try {
        const child = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 500); setInterval(() => {}, 1000);`;
        await assert.rejects(
          () => runBoundedEvidenceCommand(process.execPath, ['-e', child], { timeoutMs: 100 }),
          EvidenceCommandTimeoutError,
        );
        await sleep(600);
        assert.equal(existsSync(marker), false, 'terminated child must not execute delayed work');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('publishes a Git command timeout as FAILING source status', async () => {
      const health = createOperationsEvidenceSourceHealthModel([{ source: 'git-workspace', configured: true }]);
      const callbacks = health.callbacks('git-workspace');
      const adapter = createGitWorkspaceAdapter({
        repoPath: '.', intervalMs: 100, commandTimeoutMs: 100,
        runCommand: async () => { throw new EvidenceCommandTimeoutError(100); },
        onSuccess: callbacks.onSuccess, onError: callbacks.onError,
      });
      const { pcc } = fakePcc();
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc, sources: [adapter], sourceHealth: health });
      await bridge.start();
      assert.equal(bridge.read.status().sources[0].state, 'FAILING');
      assert.match(bridge.read.status().sources[0].lastError ?? '', /timed out after 100 ms/);
      await bridge.stop();
    });
  });

  describe('event buffer semantics', () => {
    it('bounds the recent-event buffer', async () => {
      const events = Array.from({ length: 30 }, (_, i) => rawEvent({ source: 'process', action: `e${i}` }));
      const probe = fakeAdapter('burst', events);
      const bridge = createOperationsEvidenceReadBridge({ sources: [probe.adapter], maxRecentEvents: 10 });
      await bridge.start();
      assert.equal(bridge.read.activity().length, 10);
    });

    it('deduplicates by eventId', async () => {
      const dup = rawEvent({ eventId: 'dup-1', source: 'process', action: 'x' });
      const probe = fakeAdapter('dup', [dup, dup, rawEvent({ eventId: 'dup-1', source: 'process', action: 'x' })]);
      const bridge = createOperationsEvidenceReadBridge({ sources: [probe.adapter] });
      await bridge.start();
      assert.equal(bridge.read.activity().length, 1);
    });

    it('preserves deterministic insertion order', async () => {
      const events = [
        rawEvent({ eventId: 'a', source: 'process', action: 'a' }),
        rawEvent({ eventId: 'b', source: 'git', action: 'b' }),
        rawEvent({ eventId: 'c', source: 'log', action: 'c' }),
      ];
      const probe = fakeAdapter('order', events);
      const bridge = createOperationsEvidenceReadBridge({ sources: [probe.adapter] });
      await bridge.start();
      assert.deepEqual(bridge.read.activity().map((e) => e.eventId), ['a', 'b', 'c']);
    });

    it('returns defensive copies that callers cannot mutate', async () => {
      const probe = fakeAdapter('copy', [rawEvent({ source: 'process', action: 'x' })]);
      const bridge = createOperationsEvidenceReadBridge({ sources: [probe.adapter] });
      await bridge.start();
      const first = bridge.read.activity();
      (first[0] as { action: string }).action = 'mutated';
      const second = bridge.read.activity();
      assert.equal(second.length, 1);
      assert.equal(second[0].action, 'x');
    });

    it('redacts secret-bearing raw evidence before it reaches Workbench', async () => {
      const probe = fakeAdapter('secret', [
        rawEvent({
          source: 'log',
          action: 'credential.observed',
          command: 'export HERMES_BRIDGE_TOKEN=real-bridge-token && ./hermes',
          after: { apiKey: 'sk-REAL-SECRET', api_secret: 's3cr3t', Authorization: 'Bearer tok123', password: 'hunter2', privateKey: 'PRIVATE', cookie: 'session=abc' },
        }),
      ]);
      const bridge = createOperationsEvidenceReadBridge({ sources: [probe.adapter] });
      await bridge.start();
      const activity = bridge.read.activity();
      assert.equal(activity.length, 1);
      const event = activity[0];
      const serialized = JSON.stringify(event);
      assert.ok(!serialized.includes('real-bridge-token'));
      assert.ok(!serialized.includes('sk-REAL-SECRET'));
      assert.ok(!serialized.includes('s3cr3t'));
      assert.ok(!serialized.includes('tok123'));
      assert.ok(!serialized.includes('hunter2'));
      assert.ok(event.commandDigest?.startsWith('sha256:'));
      const after = event.after as Record<string, unknown>;
      assert.equal(after.apiKey, '<REDACTED>');
      assert.equal(after.api_secret, '<REDACTED>');
      assert.equal(after.Authorization, '<REDACTED>');
    });
  });

  describe('Hermes authority separation', () => {
    it('surfaces external Hermes runtime evidence as Operations activity only', async () => {
      const probe = fakeAdapter('hermes-runtime', [
        rawEvent({ actor: 'runtime', source: 'process', action: 'runtime.degraded', evidenceLevel: 'VERIFIED_OBSERVED', after: { health: { ok: false } } }),
      ]);
      const bridge = createOperationsEvidenceReadBridge({ sources: [probe.adapter] });
      await bridge.start();
      const activity = bridge.read.activity();
      assert.equal(activity.length, 1);
      assert.equal(activity[0].actor, 'runtime');
    });

    it('never imports HandshakeCoordinator, kernel, OMS, or risk authority', () => {
      const source = bridgeSource();
      assert.doesNotMatch(source, /from ['"]\.\.\/hermes/);
      assert.doesNotMatch(source, /from ['"]\.\.\/kernel/);
      assert.doesNotMatch(source, /from ['"]\.\.\/oms/);
      assert.doesNotMatch(source, /from ['"]\.\.\/risk/);
      assert.doesNotMatch(source, /activateLiveReadiness|setLiveReady/);
      const gateway = gatewaySource();
      assert.match(gateway, /hermes: \(\) => hermesCoordinator\.getSnapshot\(\)/, 'runtime.hermes must stay bound to the coordinator snapshot');
    });

    it('wires all actual gateway adapters into source health and Workbench status', () => {
      const gateway = gatewaySource();
      assert.equal((gateway.match(/onError: health\.onError/g) ?? []).length, 3);
      assert.equal((gateway.match(/onSuccess: health\.onSuccess/g) ?? []).length, 3);
      assert.match(gateway, /sourceHealth: operationsEvidenceSourceHealth/);
      assert.match(gateway, /operationsEvidenceStatus: operationsEvidenceBridge\.read\.status/);
    });
  });

  describe('failure isolation and authority boundary', () => {
    it('does not import or reference trading authority from the bridge', () => {
      const source = bridgeSource();
      for (const forbidden of ['OmsCore', 'TradingKernel', 'PreTradeRiskGateway', 'executeThroughGateway', 'submitRequest', 'submitOrder', 'retryOrder', 'activateLiveReadiness', 'reconcileRecoveredState', 'recoverAndStart']) {
        assert.doesNotMatch(source, new RegExp(forbidden), `bridge must not reference ${forbidden}`);
      }
    });

    it('source failure degrades evidence without mutating trading state', async () => {
      const failing = fakeAdapter('git-fail', [], { startError: new Error('GIT_PROBE_FAILED') });
      const bridge = createOperationsEvidenceReadBridge({ sources: [failing.adapter] });
      await bridge.start();
      assert.equal(bridge.read.status().running, false);
      assert.equal(bridge.read.status().sourceFailures, 1);
      assert.deepEqual(bridge.read.activity(), []);
    });

    it('Project Control Center approvals remain false', () => {
      const projectState = JSON.parse(readFileSync(new URL('../../config/control-center/project-state.json', import.meta.url), 'utf8')) as {
        approvals: Record<string, { approved: boolean }>;
        boundaries?: Record<string, unknown>;
      };
      for (const environment of ['replay', 'shadow', 'paper', 'testnet', 'live']) {
        assert.equal(projectState.approvals[environment].approved, false, `${environment} must stay false`);
      }
    });

    it('bridge has no polling timer leak after stop', async () => {
      let polls = 0;
      const poller = createPollingAdapter({ name: 'poll-probe', intervalMs: 100, poll: () => { polls += 1; } });
      const bridge = createOperationsEvidenceReadBridge({ sources: [poller] });
      await bridge.start();
      await sleep(250);
      assert.ok(polls >= 1);
      await bridge.stop();
      const afterStop = polls;
      await sleep(250);
      assert.equal(polls, afterStop, 'no orphan polling timer after stop');
    });
  });

  it('defensive: bridge and read view are frozen', () => {
    const bridge = createOperationsEvidenceReadBridge({});
    assert.ok(Object.isFrozen(bridge));
    assert.ok(Object.isFrozen(bridge.read));
  });
});
