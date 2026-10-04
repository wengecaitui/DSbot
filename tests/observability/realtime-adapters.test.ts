import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import type { RawObservableEvent } from '../../src/observability/contracts';
import { createGitWorkspaceAdapter, type GitSnapshot } from '../../src/observability/adapters/git-workspace-adapter';
import { createHermesLogAdapter } from '../../src/observability/adapters/hermes-log-adapter';
import {
  createHermesRuntimeAdapter,
  HERMES_REQUIRED_RUNTIME_PORTS,
  type HermesRuntimeSnapshot,
} from '../../src/observability/adapters/hermes-runtime-adapter';
import { createWorkspaceFileAdapter } from '../../src/observability/adapters/filesystem-adapter';

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for observable event');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function collectingSink(events: RawObservableEvent[]) {
  return { emit(event: RawObservableEvent) { events.push(event); } };
}

test('Workspace file adapter normalizes Chokidar v4 unknown errors without changing lifecycle', async () => {
  class FakeWatcher extends EventEmitter {
    closeCalls = 0;
    async close(): Promise<void> { this.closeCalls += 1; }
  }

  const watcher = new FakeWatcher();
  const originalWatch = chokidar.watch;
  chokidar.watch = (() => {
    queueMicrotask(() => watcher.emit('ready'));
    return watcher as unknown as FSWatcher;
  }) as typeof chokidar.watch;

  const received: Error[] = [];
  const adapter = createWorkspaceFileAdapter({
    rootPath: '.',
    onError: error => { received.push(error); },
  });
  const nativeError = new Error('native');
  const payloads: unknown[] = [nativeError, 'string failure', { code: 'OBJECT_FAILURE' }, null, undefined];

  try {
    await adapter.start(collectingSink([]));
    for (const payload of payloads) watcher.emit('error', payload);

    assert.equal(received.length, payloads.length, 'each watcher error must reach the callback exactly once');
    assert.equal(received[0], nativeError, 'native Error identity must be preserved');
    for (let index = 1; index < payloads.length; index += 1) {
      assert.ok(received[index] instanceof Error);
      assert.equal(received[index]?.cause, payloads[index]);
    }

    await adapter.stop();
    await adapter.stop();
    assert.equal(watcher.closeCalls, 1, 'stop remains idempotent');
  } finally {
    chokidar.watch = originalWatch;
    await adapter.stop();
  }
});

test('Hermes log adapter tails classified lines and stops cleanly', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hermes-log-adapter-'));
  const file = path.join(root, 'agent.log');
  await fs.writeFile(file, 'historical line\n');
  const events: RawObservableEvent[] = [];
  const adapter = createHermesLogAdapter({ files: [file], intervalMs: 100, startAtEnd: true });
  try {
    await adapter.start(collectingSink(events));
    assert.equal(events[0]?.action, 'log.watch_started');
    await fs.appendFile(file, 'HERMES_BACKEND_READY port=60825\n');
    await waitFor(() => events.some(event => event.action === 'runtime.ready'));
    await fs.appendFile(file, '[20260710_001346_d117fd] agent.tool_executor: tool terminal completed\n');
    await waitFor(() => events.some(event => event.action === 'tool.completed'));
    assert.equal(events.find(event => event.action === 'tool.completed')?.taskId, '20260710_001346_d117fd');
    assert.equal(events.some(event => JSON.stringify(event.after).includes('historical line')), false);
    await adapter.stop();
    const count = events.length;
    await fs.appendFile(file, 'ERROR after stop\n');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(events.length, count);
  } finally {
    await adapter.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Git adapter distinguishes initial, workspace and HEAD changes', async () => {
  const events: RawObservableEvent[] = [];
  let snapshot: GitSnapshot = { branch: 'feature', head: 'a', entries: [] };
  const adapter = createGitWorkspaceAdapter({ repoPath: '.', intervalMs: 100, readSnapshot: async () => structuredClone(snapshot) });
  try {
    await adapter.start(collectingSink(events));
    assert.equal(events[0]?.action, 'git.snapshot');
    snapshot = { ...snapshot, entries: [' M file.ts'] };
    await waitFor(() => events.some(event => event.action === 'git.workspace_changed'));
    snapshot = { ...snapshot, head: 'b' };
    await waitFor(() => events.some(event => event.action === 'git.head_changed'));
    assert.equal(events.at(-1)?.riskClass, 'R2_STATEFUL_OPERATION');
  } finally { await adapter.stop(); }
});

test('Hermes runtime defaults require only the stable gateway port', () => {
  assert.deepEqual(HERMES_REQUIRED_RUNTIME_PORTS, [8_642]);
});

test('Runtime adapter emits only when observable runtime state changes', async () => {
  const events: RawObservableEvent[] = [];
  let snapshot: HermesRuntimeSnapshot = {
    gateway: { pid: 7, state: 'running', activeAgents: 0 },
    processes: [{ name: 'Hermes', pid: 7, alive: true }],
    ports: [{ host: '127.0.0.1', port: 8642, listening: true }],
    health: { url: 'http://127.0.0.1:8642/health', ok: true, status: 200 },
  };
  const adapter = createHermesRuntimeAdapter({ stateFile: 'state.json', intervalMs: 100, probe: async () => structuredClone(snapshot) });
  try {
    await adapter.start(collectingSink(events));
    assert.equal(events[0]?.action, 'runtime.snapshot');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(events.length, 1);
    snapshot = { ...snapshot, ports: [{ host: '127.0.0.1', port: 8642, listening: false }] };
    await waitFor(() => events.some(event => event.action === 'runtime.degraded'));
    assert.equal(events.at(-1)?.result?.ok, false);
  } finally { await adapter.stop(); }
});

test('Workspace file adapter reports post-ready file changes', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'workspace-file-adapter-'));
  const events: RawObservableEvent[] = [];
  const adapter = createWorkspaceFileAdapter({ rootPath: root, awaitWriteFinishMs: 100 });
  try {
    await adapter.start(collectingSink(events));
    assert.equal(events[0]?.action, 'filesystem.watch_started');
    const file = path.join(root, 'observed.txt');
    await fs.writeFile(file, 'one');
    await waitFor(() => events.some(event => event.action === 'filesystem.added'));
    await fs.writeFile(file, 'two');
    await waitFor(() => events.some(event => event.action === 'filesystem.changed'));
  } finally {
    await adapter.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
