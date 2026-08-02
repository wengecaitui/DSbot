import type { ObservableAgentEvent } from '../contracts';
import type { ObservableAlert } from '../alert-engine';
import type { RemediationRecommendation } from '../remediation-advisor';
import { redactValue } from '../redaction';
import type { ObservableStateSnapshot } from '../state-projector';
import type { TaskActivitySnapshot } from '../task-activity-projector';
import type { ProjectControlCenterSnapshot } from '../project-control-center';

export interface DashboardCollaborationContext {
  schemaVersion: '1.0';
  kind: 'dsbot.collaboration.context';
  generatedAt: string;
  channel: 'dashboard-loopback-read-only';
  capabilities: {
    canReadContext: true;
    canExecuteCommands: false;
    canSendMessages: false;
    canPersistDrafts: false;
  };
  safetyBoundary: {
    evidenceIsRedacted: true;
    dashboardDoesNotGrantApproval: true;
    productionChangesRequireSeparateAuthorization: true;
  };
  monitor: ObservableStateSnapshot;
  activity: TaskActivitySnapshot;
  project?: ProjectControlCenterSnapshot;
  recentEvents: ObservableAgentEvent[];
  recentAlerts: ObservableAlert[];
  recommendations: RemediationRecommendation[];
}

interface DashboardCollaborationContextInput {
  monitor: ObservableStateSnapshot;
  activity: TaskActivitySnapshot;
  project?: ProjectControlCenterSnapshot;
  recentEvents: ObservableAgentEvent[];
  recentAlerts: ObservableAlert[];
  recommendations: RemediationRecommendation[];
  generatedAt?: string;
  maxItems?: number;
}

export function createDashboardCollaborationContext(
  input: DashboardCollaborationContextInput,
): DashboardCollaborationContext {
  const maxItems = input.maxItems ?? 100;
  if (!Number.isInteger(maxItems) || maxItems <= 0) {
    throw new Error('Collaboration context maxItems must be a positive integer');
  }
  const monitor = redactValue(structuredClone(input.monitor)).value;
  const activity = redactValue(structuredClone(input.activity)).value;
  const project = input.project === undefined ? undefined : redactValue(structuredClone(input.project)).value;
  const recentEvents = redactValue(structuredClone(input.recentEvents.slice(-maxItems))).value;
  const recentAlerts = redactValue(structuredClone(input.recentAlerts.slice(-maxItems))).value;
  const recommendations = redactValue(structuredClone(input.recommendations.slice(-maxItems))).value;
  return {
    schemaVersion: '1.0',
    kind: 'dsbot.collaboration.context',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    channel: 'dashboard-loopback-read-only',
    capabilities: {
      canReadContext: true,
      canExecuteCommands: false,
      canSendMessages: false,
      canPersistDrafts: false,
    },
    safetyBoundary: {
      evidenceIsRedacted: true,
      dashboardDoesNotGrantApproval: true,
      productionChangesRequireSeparateAuthorization: true,
    },
    monitor,
    activity,
    project,
    recentEvents,
    recentAlerts,
    recommendations,
  };
}
