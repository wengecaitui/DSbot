import type { ObservableAgentEvent } from './contracts';

export type ObservedTaskStatus = 'ACTIVE' | 'COMPLETED' | 'ERROR';

export interface ObservedTaskSummary {
  taskId: string;
  status: ObservedTaskStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAction: string;
  lastTarget?: string;
  toolEvents: number;
  errorEvents: number;
  workspaceEvents: number;
  stages: {
    taskObserved: boolean;
    toolObserved: boolean;
    workspaceChanged: boolean;
    completionObserved: boolean;
  };
}

export interface TaskActivitySnapshot {
  currentTask?: ObservedTaskSummary;
  recentTasks: ObservedTaskSummary[];
  lastHermesEventAt?: string;
  lastHermesAction?: string;
}

export interface TaskActivityProjector {
  apply(event: ObservableAgentEvent): void;
  snapshot(): TaskActivitySnapshot;
}

export function createTaskActivityProjector(maxTasks = 20): TaskActivityProjector {
  if (!Number.isInteger(maxTasks) || maxTasks <= 0) throw new Error('maxTasks must be a positive integer');
  const tasks = new Map<string, ObservedTaskSummary>();
  let lastHermesEventAt: string | undefined;
  let lastHermesAction: string | undefined;

  return {
    apply(event) {
      if (event.actor === 'hermes') {
        lastHermesEventAt = event.timestamp;
        lastHermesAction = event.action;
      }
      if (!event.taskId) return;
      let task = tasks.get(event.taskId);
      if (!task) {
        task = {
          taskId: event.taskId, status: 'ACTIVE', firstSeenAt: event.timestamp,
          lastSeenAt: event.timestamp, lastAction: event.action,
          toolEvents: 0, errorEvents: 0, workspaceEvents: 0,
          stages: { taskObserved: true, toolObserved: false, workspaceChanged: false, completionObserved: false },
        };
        tasks.set(event.taskId, task);
      }
      task.lastSeenAt = event.timestamp;
      task.lastAction = event.action;
      task.lastTarget = event.target;
      if (event.source === 'tool' || event.action.startsWith('tool.')) {
        task.toolEvents += 1;
        task.stages.toolObserved = true;
      }
      if (event.source === 'filesystem' || event.source === 'git') {
        task.workspaceEvents += 1;
        task.stages.workspaceChanged = true;
      }
      if (event.action === 'task.completed') {
        task.status = 'COMPLETED';
        task.stages.completionObserved = true;
      } else if (event.action === 'log.error' || event.result?.ok === false) {
        task.status = 'ERROR';
        task.errorEvents += 1;
      } else if (task.status !== 'COMPLETED') {
        task.status = 'ACTIVE';
      }
      while (tasks.size > maxTasks) tasks.delete(tasks.keys().next().value as string);
    },
    snapshot() {
      const recentTasks = [...tasks.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
      const currentTask = recentTasks.find(task => task.status === 'ACTIVE') ?? recentTasks[0];
      return structuredClone({ currentTask, recentTasks, lastHermesEventAt, lastHermesAction });
    },
  };
}
