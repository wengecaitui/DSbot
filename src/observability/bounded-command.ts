import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const DEFAULT_EVIDENCE_COMMAND_TIMEOUT_MS = 5_000;

export interface BoundedEvidenceCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly signal?: AbortSignal;
}

export class EvidenceCommandTimeoutError extends Error {
  readonly code = 'EVIDENCE_COMMAND_TIMEOUT';
  constructor(readonly timeoutMs: number) {
    super(`Evidence command timed out after ${timeoutMs} ms`);
    this.name = 'EvidenceCommandTimeoutError';
  }
}

export function assertEvidenceTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error('evidence command timeout must be an integer greater than or equal to 100');
  }
  return timeoutMs;
}

/** Uses child_process' native timeout so the child is terminated, not orphaned. */
export async function runBoundedEvidenceCommand(
  executable: string,
  args: readonly string[],
  options: BoundedEvidenceCommandOptions = {},
): Promise<string> {
  const timeoutMs = assertEvidenceTimeout(options.timeoutMs ?? DEFAULT_EVIDENCE_COMMAND_TIMEOUT_MS);
  try {
    const result = await execFile(executable, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      signal: options.signal,
    });
    return result.stdout.trim();
  } catch (cause) {
    const processError = cause as NodeJS.ErrnoException & { killed?: boolean };
    if (!options.signal?.aborted && processError.killed) {
      throw new EvidenceCommandTimeoutError(timeoutMs);
    }
    throw cause;
  }
}
