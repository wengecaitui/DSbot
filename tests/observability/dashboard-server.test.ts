import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import type { ObservableAgentEvent } from '../../src/observability/contracts';
import type { ObservableAlert } from '../../src/observability/alert-engine';
import type { RemediationRecommendation } from '../../src/observability/remediation-advisor';
import type { ProjectControlCenterSnapshot } from '../../src/observability/project-control-center';
import { createObservabilityDashboardServer } from '../../src/observability/dashboard/dashboard-server';
import { DASHBOARD_HTML, DASHBOARD_JS } from '../../src/observability/dashboard/page';

const event: ObservableAgentEvent = {
  schemaVersion: '1.0', eventId: 'dashboard-event', runId: 'dashboard-test',
  timestamp: '2026-07-16T00:00:00.000Z', actor: 'runtime', source: 'process',
  action: 'runtime.snapshot', riskClass: 'R0_READ_ONLY', evidenceLevel: 'VERIFIED_OBSERVED',
  result: { ok: true },
};
const alert: ObservableAlert = {
  schemaVersion: '1.0', alertId: 'alert-1', ruleId: 'runtime-unhealthy', fingerprint: 'runtime-unhealthy|runtime.snapshot|',
  severity: 'critical', title: 'Runtime unhealthy', message: 'Health probe failed',
  firstSeenAt: event.timestamp, lastSeenAt: event.timestamp, occurrences: 1,
  eventId: event.eventId, action: event.action, riskClass: event.riskClass, approval: 'NOT_REQUIRED',
};
const recommendation: RemediationRecommendation = {
  schemaVersion: '1.0', recommendationId: 'recommendation:alert-1', alertId: alert.alertId,
  ruleId: alert.ruleId, priority: 'HIGH', status: 'VERIFY_FIRST', title: 'Check runtime',
  diagnosis: 'A runtime probe failed', possibleImpact: 'Monitoring may be stale',
  steps: ['Inspect health'], verification: ['Health returns 200'], requiresApproval: false,
  autoFixAvailable: false, evidenceEventId: event.eventId, updatedAt: event.timestamp,
};
const project: ProjectControlCenterSnapshot = {
  schemaVersion: '1.0', kind: 'dsbot.project-control-center', generatedAt: event.timestamp,
  status: 'IMPLEMENTING', currentCapability: 'Project Control Center', currentTask: 'Evidence loop', activeAgent: 'Codex',
  repository: {
    identity: 'wengecaitui/dsbot', identityVerified: true, branch: 'agent/project-control-center',
    worktree: 'E:/repo', commitSha: '1'.repeat(40), changedFiles: ['src/a.ts'],
    integrationBranch: 'feature/orangeai-split', integrationHead: '2'.repeat(40),
  },
  ci: {
    status: 'UNAVAILABLE', checks: [], requiredChecks: ['build'], missingRequiredChecks: ['build'],
    headShaMatchesDeliveryRef: false,
  },
  localTests: [], remoteTests: [], blockers: [], dataGaps: ['No CI evidence'],
  nextAction: 'Verify', eventTimeline: [], promotedStrategyCount: 0,
  approvals: Object.fromEntries(['replay', 'shadow', 'paper', 'testnet', 'live'].map(name => [name, {
    approved: false, source: name, limitation: 'Not authorized',
  }])) as ProjectControlCenterSnapshot['approvals'],
  boundaries: { readOnlyDashboard: true, dashboardGrantsApproval: false, tradingEnvironmentActivated: false },
};

function createDashboard(maxEvents = 500) {
  return createObservabilityDashboardServer({
    port: 0, maxEvents,
    stateProvider: () => ({
      totalEvents: 1, lastEventAt: event.timestamp, lastEventId: event.eventId,
      countsByActor: { runtime: 1 }, countsBySource: { process: 1 },
      countsByRisk: { R0_READ_ONLY: 1 }, lastEventBySource: { process: event }, recentEventIds: [event.eventId],
    }),
    activityProvider: () => ({
      currentTask: {
        taskId: 'task-1', status: 'ACTIVE', firstSeenAt: event.timestamp, lastSeenAt: event.timestamp,
        lastAction: 'tool.completed', toolEvents: 1, errorEvents: 0, workspaceEvents: 0,
        stages: { taskObserved: true, toolObserved: true, workspaceChanged: false, completionObserved: false },
      },
      recentTasks: [], lastHermesEventAt: event.timestamp, lastHermesAction: 'tool.completed',
    }),
    projectProvider: () => project,
  });
}

test('dashboard serves loopback UI, project state, collaboration context and security headers', async () => {
  const dashboard = createDashboard();
  try {
    const url = await dashboard.start();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    dashboard.publish(event);
    dashboard.publishAlert(alert);
    dashboard.publishRecommendation(recommendation);

    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /DSbot Project Control Center/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);

    const state = await fetch(`${url}/api/state`).then(response => response.json()) as {
      monitor: { totalEvents: number }; recentEvents: ObservableAgentEvent[]; recentAlerts: ObservableAlert[];
      activity: { currentTask?: { taskId: string } }; recommendations: RemediationRecommendation[];
      project: ProjectControlCenterSnapshot;
    };
    assert.equal(state.monitor.totalEvents, 1);
    assert.equal(state.recentEvents[0]?.eventId, event.eventId);
    assert.equal(state.recentAlerts[0]?.alertId, alert.alertId);
    assert.equal(state.activity.currentTask?.taskId, 'task-1');
    assert.equal(state.recommendations[0]?.recommendationId, recommendation.recommendationId);
    assert.equal(state.project.status, 'IMPLEMENTING');

    const projectState = await fetch(`${url}/api/project`).then(response => response.json()) as ProjectControlCenterSnapshot;
    assert.equal(projectState.repository.identityVerified, true);
    assert.equal(projectState.approvals.paper.approved, false);

    const collaboration = await fetch(`${url}/api/collaboration-context`).then(response => response.json()) as {
      kind: string; channel: string; capabilities: { canExecuteCommands: boolean; canSendMessages: boolean };
      safetyBoundary: { dashboardDoesNotGrantApproval: boolean; productionChangesRequireSeparateAuthorization: boolean };
      recentEvents: ObservableAgentEvent[]; recentAlerts: ObservableAlert[]; recommendations: RemediationRecommendation[];
      project: ProjectControlCenterSnapshot;
    };
    assert.equal(collaboration.kind, 'dsbot.collaboration.context');
    assert.equal(collaboration.channel, 'dashboard-loopback-read-only');
    assert.equal(collaboration.capabilities.canExecuteCommands, false);
    assert.equal(collaboration.capabilities.canSendMessages, false);
    assert.equal(collaboration.safetyBoundary.dashboardDoesNotGrantApproval, true);
    assert.equal(collaboration.safetyBoundary.productionChangesRequireSeparateAuthorization, true);
    assert.equal(collaboration.project.status, 'IMPLEMENTING');
    assert.equal(collaboration.recentEvents[0]?.eventId, event.eventId);

    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    assert.equal((await fetch(`${url}/api/health`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}/api/project`, { method: 'POST' })).status, 405);
  } finally {
    await dashboard.stop();
  }
  assert.equal(dashboard.isRunning, false);
});
test('dashboard browser script is syntactically valid', () => {
  assert.doesNotThrow(() => new Script(DASHBOARD_JS));
});

test('dashboard keeps existing observability controls and removes subjective progress', () => {
  assert.match(DASHBOARD_HTML, /id="project"/);
  assert.match(DASHBOARD_HTML, /id="technicalPanel"/);
  assert.match(DASHBOARD_HTML, /id="dialogCodeExplanation"/);
  assert.match(DASHBOARD_HTML, /原始技术证据（保持原始输出）/);
  assert.match(DASHBOARD_HTML, /id="collaborationObjective"/);
  assert.match(DASHBOARD_HTML, /协作包不构成审批，不会直接发送消息或执行命令/);
  assert.match(DASHBOARD_JS, /function setTechnical/);
  assert.match(DASHBOARD_JS, /querySelector\('\.bell'\)\.addEventListener/);
  assert.match(DASHBOARD_JS, /querySelectorAll\('\.nav-item'\)/);
  assert.match(DASHBOARD_JS, /function evidenceExplanation/);
  assert.match(DASHBOARD_JS, /不能据此推断 Agent 的隐藏思维/);
  assert.match(DASHBOARD_JS, /function initAmbient/);
  assert.match(DASHBOARD_JS, /requestAnimationFrame\(draw\)/);
  assert.match(DASHBOARD_JS, /prefers-reduced-motion/);
  assert.match(DASHBOARD_JS, /function buildCollaborationBundle/);
  assert.match(DASHBOARD_JS, /thisBundleGrantsApproval:false/);
  assert.match(DASHBOARD_JS, /fetch\('\/api\/collaboration-context'\)/);
  assert.match(DASHBOARD_JS, /fetch\('\/api\/project'\)/);
  assert.match(DASHBOARD_JS, /new Blob/);
  assert.doesNotMatch(DASHBOARD_JS, /observedProgress/);
  assert.doesNotMatch(DASHBOARD_HTML, /completion percentage/i);
});

test('dashboard ring buffer remains bounded', async () => {
  const dashboard = createDashboard(2);
  try {
    const url = await dashboard.start();
    dashboard.publish({ ...event, eventId: 'one' });
    dashboard.publish({ ...event, eventId: 'two' });
    dashboard.publish({ ...event, eventId: 'three' });
    const state = await fetch(`${url}/api/state`).then(response => response.json()) as { recentEvents: ObservableAgentEvent[] };
    assert.deepEqual(state.recentEvents.map(item => item.eventId), ['two', 'three']);
  } finally { await dashboard.stop(); }
});

test('project endpoint fails closed when no provider is configured', async () => {
  const dashboard = createObservabilityDashboardServer({
    port: 0,
    stateProvider: () => ({ totalEvents: 0, countsByActor: {}, countsBySource: {}, countsByRisk: {}, lastEventBySource: {}, recentEventIds: [] }),
  });
  try {
    const url = await dashboard.start();
    const response = await fetch(`${url}/api/project`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'project_evidence_unavailable' });
  } finally { await dashboard.stop(); }
});
