#!/usr/bin/env node
import * as readline from 'readline';
import * as path from 'path';
import { homedir } from 'os';
import { createAuditLedger } from '../observability/audit-ledger';
import type { RawObservableEvent } from '../observability/contracts';
import { createObservableMonitor } from '../observability/monitor';
import { createObservableStateProjector } from '../observability/state-projector';
import { createHermesLogAdapter } from '../observability/adapters/hermes-log-adapter';
import { createGitWorkspaceAdapter } from '../observability/adapters/git-workspace-adapter';
import { createWorkspaceFileAdapter } from '../observability/adapters/filesystem-adapter';
import {
  createHermesRuntimeAdapter,
  HERMES_REQUIRED_RUNTIME_PORTS,
} from '../observability/adapters/hermes-runtime-adapter';
import { createObservabilityDashboardServer } from '../observability/dashboard/dashboard-server';
import { createObservableAlertEngine } from '../observability/alert-engine';
import { createTaskActivityProjector } from '../observability/task-activity-projector';
import { createRemediationAdvisor } from '../observability/remediation-advisor';
import { createProjectControlCenter } from '../observability/project-control-center';

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): void {
  console.log([
    'Usage:',
    '  npm run monitor:hermes -- [--write] [--root <dir>] [--run-id <id>]',
    '  npm run monitor:hermes -- --realtime [options]',
    '',
    'Default mode reads RawObservableEvent JSON lines from stdin.',
    'Realtime mode watches Hermes logs/runtime and the repository.',
    'All modes are dry-run unless --write is supplied.',
    '--write appends events to <root>/events/YYYY-MM-DD.jsonl.',
    '',
    'Realtime options:',
    '  --repo <dir>          Repository to watch (default: current directory)',
    '  --hermes-home <dir>   Hermes data directory',
    '  --interval <ms>       Poll interval, minimum 100 (default: 2000)',
    '  --duration <ms>       Stop automatically; omitted means until Ctrl+C',
    '  --all-log-lines       Emit unclassified Hermes log lines',
    '  --no-files            Disable workspace filesystem events',
    '  --no-git              Disable Git snapshots',
    '  --no-logs             Disable Hermes log tailing',
    '  --no-runtime          Disable process, port and health probes',
    '  --dashboard           Serve the local realtime dashboard',
    '  --dashboard-port <n>  Dashboard port (default: 8765)',
    '  --quiet               Hide raw JSON events in the terminal',
  ].join('\n'));
}

function numericOption(name: string, fallback?: number): number | undefined {
  const raw = optionValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function defaultHermesHome(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'hermes');
}

async function runRealtime(write: boolean, rootDir: string, runId: string): Promise<void> {
  const repoPath = path.resolve(optionValue('--repo') ?? process.cwd());
  const hermesHome = path.resolve(optionValue('--hermes-home') ?? defaultHermesHome());
  const intervalMs = numericOption('--interval', 2_000) ?? 2_000;
  const durationMs = numericOption('--duration');
  const dashboardEnabled = process.argv.includes('--dashboard');
  const quiet = process.argv.includes('--quiet');
  const dashboardPort = numericOption('--dashboard-port', 8_765) ?? 8_765;
  if (dashboardPort > 65_535) throw new Error('--dashboard-port must be at most 65535');
  const projector = createObservableStateProjector(500);
  const alertEngine = createObservableAlertEngine();
  const activityProjector = createTaskActivityProjector();
  const remediationAdvisor = createRemediationAdvisor();
  const projectControlCenter = dashboardEnabled ? createProjectControlCenter({ repoPath }) : undefined;
  let projectRefreshTimer: NodeJS.Timeout | undefined;
  const ledger = write ? createAuditLedger({ rootDir }) : undefined;
  const onAdapterError = (error: Error) => process.stderr.write(`[adapter] ${error.message}\n`);
  const sources = [];

  if (!process.argv.includes('--no-logs')) {
    sources.push(createHermesLogAdapter({
      files: ['agent.log', 'desktop.log', 'gateway.log', 'errors.log'].map(file => path.join(hermesHome, 'logs', file)),
      intervalMs, startAtEnd: true, emitUnclassified: process.argv.includes('--all-log-lines'), onError: onAdapterError,
    }));
  }
  if (!process.argv.includes('--no-runtime')) {
    sources.push(createHermesRuntimeAdapter({
      stateFile: path.join(hermesHome, 'gateway_state.json'), intervalMs,
      processNames: ['Hermes'],
      ports: HERMES_REQUIRED_RUNTIME_PORTS.map(port => ({ port })),
      healthUrl: 'http://127.0.0.1:8642/health', onError: onAdapterError,
    }));
  }
  if (!process.argv.includes('--no-git')) {
    sources.push(createGitWorkspaceAdapter({ repoPath, intervalMs, onError: onAdapterError }));
  }
  if (!process.argv.includes('--no-files')) {
    sources.push(createWorkspaceFileAdapter({ rootPath: repoPath, onError: onAdapterError }));
  }

  const dashboard = dashboardEnabled ? createObservabilityDashboardServer({
    port: dashboardPort,
    stateProvider: () => projector.snapshot(),
    activityProvider: () => activityProjector.snapshot(),
    projectProvider: () => projectControlCenter!.snapshot(),
  }) : undefined;
  const monitor = createObservableMonitor({
    sources, projector, ledger, defaultRunId: runId,
    onEvent(event) {
      activityProjector.apply(event);
      projectControlCenter?.observe(event);
      dashboard?.publish(event);
      for (const alert of alertEngine.evaluate(event)) {
        dashboard?.publishAlert(alert);
        const recommendation = remediationAdvisor.recommend(alert);
        if (recommendation) dashboard?.publishRecommendation(recommendation);
        if (alert.severity !== 'info') {
          process.stderr.write(`[alert:${alert.severity}] ${alert.title}: ${alert.message}\n`);
        }
      }
      if (!quiet) process.stdout.write(`${JSON.stringify(event)}\n`);
    },
    onError(error, context) { process.stderr.write(`[${context}] ${error.message}\n`); },
  });
  try {
    if (projectControlCenter) {
      await projectControlCenter.refresh();
      projectRefreshTimer = setInterval(() => {
        void projectControlCenter.refresh().catch(onAdapterError);
      }, Math.max(5_000, intervalMs * 5));
    }
    const dashboardUrl = await dashboard?.start();
    if (dashboardUrl) process.stderr.write(`Dashboard ready: ${dashboardUrl}\n`);
    await monitor.start();
    process.stderr.write(`Hermes realtime monitor started (${write ? 'write' : 'dry-run'}; ${sources.length} adapters).\n`);
    await new Promise<void>(resolve => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        process.off('SIGINT', finish);
        process.off('SIGTERM', finish);
        resolve();
      };
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
      if (durationMs !== undefined) timer = setTimeout(finish, durationMs);
    });
  } finally {
    if (projectRefreshTimer) clearInterval(projectRefreshTimer);
    try { if (monitor.isRunning) await monitor.stop(); }
    finally { await dashboard?.stop(); }
  }
  const finalState = projector.snapshot();
  process.stderr.write(quiet
    ? `Hermes realtime monitor stopped (${finalState.totalEvents} events, ${alertEngine.snapshot().length} alerts).\n`
    : `Hermes realtime monitor stopped. ${JSON.stringify(finalState)}\n`);
}

async function runStdin(write: boolean, rootDir: string, runId: string): Promise<void> {
  const projector = createObservableStateProjector();
  const ledger = write ? createAuditLedger({ rootDir }) : undefined;
  const monitor = createObservableMonitor({
    projector, ledger, defaultRunId: runId,
    onEvent(event) { process.stdout.write(`${JSON.stringify(event)}\n`); },
  });
  await monitor.start();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim().length === 0) continue;
    let raw: RawObservableEvent;
    try { raw = JSON.parse(line) as RawObservableEvent; }
    catch (cause) {
      process.stderr.write(`Invalid JSON line: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 2;
      continue;
    }
    try { await monitor.ingest(raw); }
    catch (cause) {
      process.stderr.write(`Event rejected: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    }
  }
  await monitor.stop();
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const write = process.argv.includes('--write');
  const rootDir = optionValue('--root') ?? '.runtime-observability';
  const runId = optionValue('--run-id') ?? `stdin-${Date.now()}`;
  if (process.argv.includes('--realtime') || process.argv.includes('--dashboard')) await runRealtime(write, rootDir, runId);
  else await runStdin(write, rootDir, runId);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
