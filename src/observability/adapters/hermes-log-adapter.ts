import { promises as fs } from 'fs';
import * as path from 'path';
import type { ObservableEventSink, ObservableEventSourceAdapter } from '../contracts';
import { createPollingAdapter } from './polling-adapter';

export interface HermesLogAdapterOptions {
  files: string[];
  intervalMs?: number;
  startAtEnd?: boolean;
  emitUnclassified?: boolean;
  maxBytesPerPoll?: number;
  /** Testable/read-only stat seam; defaults to fs.stat. */
  readStat?: (file: string) => Promise<{ size: number }>;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

interface FileCursor { offset: number; carry: string; initialized: boolean; unavailable: boolean; }

function classify(line: string): { action: string; category: string } | undefined {
  if (/HERMES_(?:DASHBOARD|BACKEND)_READY|\bREADY\b/i.test(line)) return { action: 'runtime.ready', category: 'READY' };
  if (/UnicodeDecodeError|Traceback|\b(?:ERROR|FATAL)\b|exception|failed|crash|timeout/i.test(line)) return { action: 'log.error', category: 'ERROR' };
  if (/\b(?:task|turn|session)\b.*\b(?:completed|finished|ended)\b|run_complete/i.test(line)) return { action: 'task.completed', category: 'TASK' };
  if (/\b(?:task|turn|session)\b.*\b(?:started|begin|created)\b/i.test(line)) return { action: 'task.started', category: 'TASK' };
  if (/\btool(?:_executor)?\b|\[tool\]|tool call/i.test(line)) return { action: /\bcompleted\b/i.test(line) ? 'tool.completed' : 'tool.observed', category: 'TOOL' };
  if (/\b(?:task|session|turn|agent\.conversation_loop)\b/i.test(line)) return { action: 'task.observed', category: 'TASK' };
  if (/\b(?:process|spawn|pid|daemon)\b/i.test(line)) return { action: 'process.log_observed', category: 'PROCESS' };
  if (/\bcron\b/i.test(line)) return { action: 'cron.observed', category: 'CRON' };
  if (/\bgateway\b/i.test(line)) return { action: 'gateway.observed', category: 'GATEWAY' };
  return undefined;
}

export function createHermesLogAdapter(options: HermesLogAdapterOptions): ObservableEventSourceAdapter {
  const files = [...new Set(options.files.map(file => path.resolve(file)))];
  const cursors = new Map<string, FileCursor>();
  const startAtEnd = options.startAtEnd ?? true;
  const maxBytesPerPoll = options.maxBytesPerPoll ?? 256 * 1024;
  const readStat = options.readStat ?? ((file: string) => fs.stat(file));
  if (!Number.isInteger(maxBytesPerPoll) || maxBytesPerPoll <= 0) throw new Error('maxBytesPerPoll must be a positive integer');

  async function emitLine(sink: ObservableEventSink, file: string, line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    const classification = classify(trimmed);
    if (!classification && !options.emitUnclassified) return;
    const taskId = trimmed.match(/\[([0-9]{8}_[0-9]{6}_[A-Za-z0-9-]+)\]/)?.[1];
    await sink.emit({
      actor: 'hermes', source: 'log', action: classification?.action ?? 'log.line', target: file,
      taskId,
      riskClass: 'R0_READ_ONLY', evidenceLevel: 'VERIFIED_OBSERVED',
      after: { category: classification?.category ?? 'OTHER', file: path.basename(file), message: trimmed.slice(0, 4_000) },
    });
  }

  return createPollingAdapter({
    name: 'hermes-log', intervalMs: options.intervalMs, onSuccess: options.onSuccess, onError: options.onError,
    async poll(sink) {
      for (const file of files) {
        let cursor = cursors.get(file);
        if (!cursor) { cursor = { offset: 0, carry: '', initialized: false, unavailable: false }; cursors.set(file, cursor); }
        let stat;
        try { stat = await readStat(file); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
          if (!cursor.unavailable) {
            cursor.unavailable = true;
            await sink.emit({ actor: 'system', source: 'log', action: 'log.unavailable', target: file, evidenceLevel: 'VERIFIED_OBSERVED', after: { code: 'ENOENT' } });
          }
          continue;
        }
        if (cursor.unavailable) {
          cursor.unavailable = false;
          await sink.emit({ actor: 'system', source: 'log', action: 'log.available', target: file, evidenceLevel: 'VERIFIED_OBSERVED' });
        }
        if (!cursor.initialized) {
          cursor.offset = startAtEnd ? stat.size : 0;
          cursor.initialized = true;
          await sink.emit({ actor: 'system', source: 'log', action: 'log.watch_started', target: file, evidenceLevel: 'VERIFIED_OBSERVED', after: { offset: cursor.offset } });
          continue;
        }
        if (stat.size < cursor.offset) {
          const before = cursor.offset; cursor.offset = 0; cursor.carry = '';
          await sink.emit({ actor: 'system', source: 'log', action: 'log.rotated_or_truncated', target: file, evidenceLevel: 'VERIFIED_OBSERVED', before: { offset: before }, after: { size: stat.size } });
        }
        if (stat.size === cursor.offset) continue;
        const bytesToRead = Math.min(stat.size - cursor.offset, maxBytesPerPoll);
        const handle = await fs.open(file, 'r');
        try {
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = await handle.read(buffer, 0, bytesToRead, cursor.offset);
          cursor.offset += bytesRead;
          const lines = (cursor.carry + buffer.subarray(0, bytesRead).toString('utf8')).split(/\r?\n/);
          cursor.carry = lines.pop() ?? '';
          for (const line of lines) await emitLine(sink, file, line);
        } finally { await handle.close(); }
      }
    },
  });
}
