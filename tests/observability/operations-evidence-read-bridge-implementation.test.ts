import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  createOperationsEvidenceReadBridge,
  type OperationsEvidenceReadBridge,
} from '../../src/observability/OperationsEvidenceReadBridge';
import { createPollingAdapter } from '../../src/observability/adapters/polling-adapter';
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
    it('publishes exact defensive PCC evidence after a successful refresh', async () => {
      const { pcc, snapshot } = fakePcc();
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc });
      await bridge.start();
      const published = bridge.read.projectControlCenter();
      assert.ok(published, 'PCC must be published after refresh');
      assert.strictEqual(published, snapshot, 'bridge must return the exact injected snapshot');
      assert.equal(bridge.read.status().projectControlCenterAvailable, true);
    });

    it('publishes null PCC when refresh fails (no stale-snapshot masquerade)', async () => {
      const { pcc } = fakePcc({ refreshError: new Error('PCC_REFRESH_FAILED') });
      const bridge = createOperationsEvidenceReadBridge({ projectControlCenter: pcc });
      await bridge.start();
      assert.equal(bridge.read.projectControlCenter(), null);
      assert.equal(bridge.read.status().projectControlCenterAvailable, false);
      assert.ok(bridge.read.status().sourceFailures >= 1);
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
