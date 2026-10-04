import * as path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ObservableEventSink, ObservableEventSourceAdapter } from '../contracts';

export interface WorkspaceFileAdapterOptions {
  rootPath: string;
  ignored?: Array<string | RegExp>;
  awaitWriteFinishMs?: number;
  onError?: (error: Error) => void;
}

function normalizeWatcherError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error('Workspace file watcher emitted a non-Error payload', { cause });
}

export function createWorkspaceFileAdapter(options: WorkspaceFileAdapterOptions): ObservableEventSourceAdapter {
  const rootPath = path.resolve(options.rootPath);
  const ignored = options.ignored ?? [
    /(^|[\\/])\.git([\\/]|$)/, /(^|[\\/])node_modules([\\/]|$)/,
    /(^|[\\/])dist([\\/]|$)/, /(^|[\\/])\.runtime-observability([\\/]|$)/,
    /(^|[\\/])nul([\\/]|$)/,
  ];
  let watcher: FSWatcher | undefined;
  let running = false;
  return {
    name: 'workspace-files',
    async start(sink: ObservableEventSink) {
      if (running) return;
      running = true;
      watcher = chokidar.watch(rootPath, {
        ignored, ignoreInitial: true, persistent: true,
        awaitWriteFinish: { stabilityThreshold: options.awaitWriteFinishMs ?? 300, pollInterval: 100 },
      });
      const emit = (action: string, file: string) => {
        void Promise.resolve(sink.emit({
          actor: 'runtime', source: 'filesystem', action, target: path.resolve(file), cwd: rootPath,
          riskClass: 'R1_REVERSIBLE_WORKSPACE_WRITE', evidenceLevel: 'VERIFIED_OBSERVED',
        })).catch((error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error))));
      };
      watcher.on('add', file => emit('filesystem.added', file));
      watcher.on('change', file => emit('filesystem.changed', file));
      watcher.on('unlink', file => emit('filesystem.deleted', file));
      watcher.on('error', error => options.onError?.(normalizeWatcherError(error)));
      await new Promise<void>((resolve, reject) => {
        watcher?.once('ready', resolve);
        watcher?.once('error', reject);
      });
      await sink.emit({ actor: 'system', source: 'filesystem', action: 'filesystem.watch_started', target: rootPath, evidenceLevel: 'VERIFIED_OBSERVED' });
    },
    async stop() {
      if (!running) return;
      running = false;
      const current = watcher; watcher = undefined;
      await current?.close();
    },
  };
}
