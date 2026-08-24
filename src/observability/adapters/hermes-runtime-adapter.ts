import { promises as fs } from 'fs';
import { execFile as execFileCallback } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { promisify } from 'util';
import type { ObservableEventSourceAdapter } from '../contracts';
import { createPollingAdapter } from './polling-adapter';

const execFile = promisify(execFileCallback);
export const HERMES_REQUIRED_RUNTIME_PORTS = [8_642] as const;
export interface RuntimeProcessState { name: string; pid: number; alive: boolean; }
export interface RuntimePortState { host: string; port: number; listening: boolean; }
export interface HermesRuntimeSnapshot {
  gateway?: { pid?: number; state?: string; activeAgents?: number; restartRequested?: boolean; platforms?: Record<string, string>; updatedAt?: string; };
  processes: RuntimeProcessState[];
  ports: RuntimePortState[];
  health?: { url: string; ok: boolean; status?: number };
}
export interface HermesRuntimeAdapterOptions {
  stateFile: string;
  intervalMs?: number;
  processNames?: string[];
  ports?: Array<{ host?: string; port: number }>;
  healthUrl?: string;
  probe?: () => Promise<HermesRuntimeSnapshot>;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function probePort(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
async function discoverProcesses(names: string[]): Promise<RuntimeProcessState[]> {
  const safeNames = names.filter(name => /^[A-Za-z0-9_.-]+$/.test(name));
  if (safeNames.length === 0) return [];
  if (process.platform === 'win32') {
    const quoted = safeNames.map(name => `'${name}'`).join(',');
    const command = `Get-Process -Name ${quoted} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | ConvertTo-Json -Compress`;
    const result = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, maxBuffer: 1024 * 1024 });
    if (!result.stdout.trim()) return [];
    const decoded = JSON.parse(result.stdout) as { Id: number; ProcessName: string } | Array<{ Id: number; ProcessName: string }>;
    return (Array.isArray(decoded) ? decoded : [decoded]).map(item => ({ name: item.ProcessName, pid: item.Id, alive: true }));
  }
  const result = await execFile('ps', ['-eo', 'pid=,comm='], { maxBuffer: 1024 * 1024 });
  return result.stdout.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !safeNames.includes(path.basename(match[2]))) return [];
    return [{ name: path.basename(match[2]), pid: Number(match[1]), alive: true }];
  });
}

export function createHermesRuntimeAdapter(options: HermesRuntimeAdapterOptions): ObservableEventSourceAdapter {
  const stateFile = path.resolve(options.stateFile);
  const ports = options.ports ?? [];
  const processNames = options.processNames ?? ['Hermes'];
  let previous: HermesRuntimeSnapshot | undefined;
  let serialized: string | undefined;
  const defaultProbe = async (): Promise<HermesRuntimeSnapshot> => {
    let gateway: HermesRuntimeSnapshot['gateway'];
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
      const platforms = Object.fromEntries(Object.entries((raw.platforms as Record<string, { state?: string }> | undefined) ?? {}).map(([name, value]) => [name, value.state ?? 'unknown']));
      gateway = {
        pid: typeof raw.pid === 'number' ? raw.pid : undefined,
        state: typeof raw.gateway_state === 'string' ? raw.gateway_state : undefined,
        activeAgents: typeof raw.active_agents === 'number' ? raw.active_agents : undefined,
        restartRequested: typeof raw.restart_requested === 'boolean' ? raw.restart_requested : undefined,
        platforms, updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
      };
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    const discovered: RuntimeProcessState[] = await discoverProcesses(processNames).catch((): RuntimeProcessState[] => []);
    if (gateway?.pid) discovered.push({ name: 'hermes-gateway', pid: gateway.pid, alive: isPidAlive(gateway.pid) });
    const portStates = await Promise.all(ports.map(async item => ({ host: item.host ?? '127.0.0.1', port: item.port, listening: await probePort(item.host ?? '127.0.0.1', item.port) })));
    let health: HermesRuntimeSnapshot['health'];
    if (options.healthUrl) {
      try {
        const response = await fetch(options.healthUrl, { signal: AbortSignal.timeout(1_500) });
        health = { url: options.healthUrl, ok: response.ok, status: response.status };
      } catch { health = { url: options.healthUrl, ok: false }; }
    }
    return { gateway, processes: discovered.sort((a, b) => a.pid - b.pid), ports: portStates.sort((a, b) => a.port - b.port), health };
  };
  const probe = options.probe ?? defaultProbe;
  return createPollingAdapter({
    name: 'hermes-runtime', intervalMs: options.intervalMs, onSuccess: options.onSuccess, onError: options.onError,
    async poll(sink) {
      const current = await probe();
      const currentSerialized = JSON.stringify(current);
      if (currentSerialized === serialized) return;
      const initial = previous === undefined;
      const unhealthy = current.health?.ok === false || current.ports.some(port => !port.listening) || current.processes.some(item => !item.alive);
      await sink.emit({
        actor: 'runtime', source: 'process', action: initial ? 'runtime.snapshot' : unhealthy ? 'runtime.degraded' : 'runtime.changed',
        target: stateFile, riskClass: 'R0_READ_ONLY', evidenceLevel: 'VERIFIED_OBSERVED', before: previous, after: current,
        result: { ok: !unhealthy, summary: unhealthy ? 'One or more runtime probes are unhealthy' : 'Runtime probes healthy' },
      });
      previous = structuredClone(current); serialized = currentSerialized;
    },
  });
}
