import * as path from 'path';
import type { ObservableEventSourceAdapter } from '../contracts';
import { DEFAULT_EVIDENCE_COMMAND_TIMEOUT_MS, assertEvidenceTimeout, runBoundedEvidenceCommand } from '../bounded-command';
import { createPollingAdapter } from './polling-adapter';

export interface GitSnapshot { branch: string; head: string; upstream?: string; entries: string[]; }
export interface GitWorkspaceAdapterOptions {
  repoPath: string;
  intervalMs?: number;
  commandTimeoutMs?: number;
  runCommand?: (args: readonly string[], timeoutMs: number) => Promise<string>;
  readSnapshot?: () => Promise<GitSnapshot>;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

async function readGitSnapshot(run: (args: readonly string[]) => Promise<string>): Promise<GitSnapshot> {
  const [branch, head, upstream, status] = await Promise.all([
    run(['branch', '--show-current']), run(['rev-parse', 'HEAD']),
    run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ''),
    run(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  return { branch, head, upstream: upstream || undefined, entries: status ? status.split(/\r?\n/).sort() : [] };
}

export function createGitWorkspaceAdapter(options: GitWorkspaceAdapterOptions): ObservableEventSourceAdapter {
  const repoPath = path.resolve(options.repoPath);
  const commandTimeoutMs = assertEvidenceTimeout(options.commandTimeoutMs ?? DEFAULT_EVIDENCE_COMMAND_TIMEOUT_MS);
  const run = options.runCommand
    ? (args: readonly string[]) => options.runCommand!(args, commandTimeoutMs)
    : (args: readonly string[]) => runBoundedEvidenceCommand('git', args, { cwd: repoPath, timeoutMs: commandTimeoutMs, maxBuffer: 2 * 1024 * 1024 });
  const readSnapshot = options.readSnapshot ?? (() => readGitSnapshot(run));
  let previous: GitSnapshot | undefined;
  let previousSerialized: string | undefined;
  return createPollingAdapter({
    name: 'git-workspace', intervalMs: options.intervalMs, onSuccess: options.onSuccess, onError: options.onError,
    async poll(sink) {
      const current = await readSnapshot();
      const serialized = JSON.stringify(current);
      if (serialized === previousSerialized) return;
      const initial = previous === undefined;
      const headChanged = previous !== undefined && previous.head !== current.head;
      await sink.emit({
        actor: initial ? 'system' : 'runtime', source: 'git',
        action: initial ? 'git.snapshot' : headChanged ? 'git.head_changed' : 'git.workspace_changed',
        target: repoPath, cwd: repoPath, command: 'git status --porcelain=v1 --untracked-files=all',
        riskClass: initial ? 'R0_READ_ONLY' : headChanged ? 'R2_STATEFUL_OPERATION' : 'R1_REVERSIBLE_WORKSPACE_WRITE',
        evidenceLevel: 'VERIFIED_OBSERVED', before: previous, after: current,
      });
      previous = structuredClone(current);
      previousSerialized = serialized;
    },
  });
}
