import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObservableAgentEvent } from '../../src/observability/contracts';
import { createTaskActivityProjector } from '../../src/observability/task-activity-projector';

function event(action: string, overrides: Partial<ObservableAgentEvent> = {}): ObservableAgentEvent {
  return {
    schemaVersion: '1.0', eventId: action, runId: 'run', taskId: 'task-1',
    timestamp: '2026-07-16T00:00:00.000Z', actor: 'hermes', source: 'log',
    action, riskClass: 'R0_READ_ONLY', evidenceLevel: 'VERIFIED_OBSERVED', ...overrides,
  };
}

test('task projector advances only from observable stages', () => {
  const projector = createTaskActivityProjector();
  projector.apply(event('task.started'));
  assert.equal(projector.snapshot().currentTask?.status, 'ACTIVE');
  projector.apply(event('tool.completed'));
  assert.equal(projector.snapshot().currentTask?.stages.toolObserved, true);
  projector.apply(event('filesystem.changed', { source: 'filesystem' }));
  assert.equal(projector.snapshot().currentTask?.stages.workspaceChanged, true);
  projector.apply(event('task.completed'));
  const task = projector.snapshot().currentTask;
  assert.equal(task?.stages.completionObserved, true);
  assert.equal(task?.status, 'COMPLETED');
});

test('task projector records errors and does not invent tasks without taskId', () => {
  const projector = createTaskActivityProjector();
  projector.apply(event('tool.observed', { taskId: undefined }));
  assert.equal(projector.snapshot().recentTasks.length, 0);
  projector.apply(event('log.error'));
  assert.equal(projector.snapshot().currentTask?.status, 'ERROR');
  assert.equal(projector.snapshot().currentTask?.errorEvents, 1);
});

test('task snapshots are bounded and defensive', () => {
  const projector = createTaskActivityProjector(2);
  projector.apply(event('task.started', { taskId: 'one', timestamp: '2026-07-16T00:00:01.000Z' }));
  projector.apply(event('task.started', { taskId: 'two', timestamp: '2026-07-16T00:00:02.000Z' }));
  projector.apply(event('task.started', { taskId: 'three', timestamp: '2026-07-16T00:00:03.000Z' }));
  const snapshot = projector.snapshot();
  assert.deepEqual(snapshot.recentTasks.map(task => task.taskId), ['three', 'two']);
  snapshot.recentTasks[0].lastAction = 'mutated';
  assert.notEqual(projector.snapshot().recentTasks[0].lastAction, 'mutated');
});
