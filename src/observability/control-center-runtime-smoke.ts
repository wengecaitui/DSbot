import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile as readFileDefault, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const CONTROL_CENTER_RUNTIME_BLOCKER_PREFIX = 'CONTROL_CENTER_RUNTIME_UNVERIFIED:';
export const REQUIRED_RUNTIME_SMOKE_CHECK_IDS = [
  'repository-binding',
  'docker-daemon',
  'compose-config',
  'compose-services',
  'dashboard-project',
  'devlake-http',
  'devlake-config-ui',
  'grafana-health',
  'infinity-datasource-health',
  'infinity-dashboard-query',
] as const;

export interface RuntimeSmokeCheck {
  id: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

export interface ControlCenterRuntimeSmokeReceipt {
  schemaVersion: '1.0';
  kind: 'dsbot.control-center-runtime-smoke';
  completedAt: string;
  status: 'PASS' | 'FAIL';
  repository: {
    identity: string;
    commitSha: string;
    integrationBranch: string;
    integrationHead?: string;
    cleanBefore: boolean;
    cleanAfter: boolean;
  };
  composeDefinitionSha256: string;
  checks: RuntimeSmokeCheck[];
  safety: {
    replayApproved: false;
    shadowApproved: false;
    paperApproved: false;
    testnetApproved: false;
    liveApproved: false;
    tradingEnvironmentActivated: false;
  };
  limitations: string[];
}

interface RuntimeConfig {
  repository: string;
  integrationBranch: string;
}

interface RuntimeProjectSnapshot {
  repository?: { identity?: unknown; commitSha?: unknown; integrationHead?: unknown };
  approvals?: Record<string, { approved?: unknown }>;
  boundaries?: { tradingEnvironmentActivated?: unknown };
}

interface ComposeService {
  Service?: string;
  State?: string;
  Health?: string;
}

export interface RuntimeSmokeOptions {
  repoPath: string;
  envPath: string;
  outputPath?: string;
  now?: () => Date;
  runCommand?: (executable: string, args: string[], cwd: string) => Promise<string>;
  request?: (url: string, init?: RequestInit) => Promise<Response>;
  readFile?: (file: string) => Promise<string>;
  requestTimeoutMs?: number;
}

function normalizeRepository(remote: string): string {
  const normalized = remote.trim().replace(/\\/g, '/').replace(/\.git$/, '');
  const match = normalized.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i);
  return (match?.[1] ?? normalized).toLowerCase();
}

function parseRemoteHead(value: string): string | undefined {
  const sha = value.trim().split(/\s+/)[0];
  return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
}

function parseComposeServices(value: string): ComposeService[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as ComposeService | ComposeService[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as ComposeService);
  }
}

function basicAuthorization(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

export function controlCenterDefinitionSha256(contents: string[]): string {
  return createHash('sha256').update(contents.join('\n---\n')).digest('hex');
}

export function redactRuntimeSmokeDetail(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets.filter(item => item.length > 0).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[AUTH REDACTED]')
    .replace(/\b(password|passwd|secret|token|authorization|cookie|api[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new Error(`${label} returned invalid JSON`); }
}

function assertFailClosedProject(value: unknown, repository: string, head: string): void {
  if (!value || typeof value !== 'object') throw new Error('Dashboard project response must be an object');
  const project = value as RuntimeProjectSnapshot;
  if (project.repository?.identity?.toString().toLowerCase() !== repository.toLowerCase()) throw new Error('Dashboard repository identity mismatch');
  if (project.repository?.commitSha !== head || project.repository?.integrationHead !== head) throw new Error('Dashboard project SHA is not bound to integration HEAD');
  for (const environment of ['replay', 'shadow', 'paper', 'testnet', 'live']) {
    if (project.approvals?.[environment]?.approved !== false) throw new Error(`Dashboard ${environment} approval is not fail closed`);
  }
  if (project.boundaries?.tradingEnvironmentActivated !== false) throw new Error('Dashboard reports a trading environment as activated');
}

function frameFieldValues(frame: unknown, name: string): unknown[] {
  if (!frame || typeof frame !== 'object') return [];
  const typed = frame as { schema?: { fields?: Array<{ name?: unknown }> }; data?: { values?: unknown[][] } };
  const index = typed.schema?.fields?.findIndex(field => field.name === name) ?? -1;
  if (index < 0 || !Array.isArray(typed.data?.values?.[index])) return [];
  return typed.data.values[index];
}

function assertInfinityQuery(value: unknown, repository: string, head: string): number {
  if (!value || typeof value !== 'object') throw new Error('Grafana Infinity query returned invalid JSON');
  const result = (value as { results?: { A?: { error?: unknown; frames?: unknown[] } } }).results?.A;
  if (!result || result.error) throw new Error('Grafana Infinity query reported an error');
  const frames = Array.isArray(result.frames) ? result.frames : [];
  if (frames.length === 0) throw new Error('Grafana Infinity query returned no frames');
  const hasBoundRow = frames.some(frame => {
    const repositories = frameFieldValues(frame, 'Repository');
    const shas = frameFieldValues(frame, 'SHA');
    return repositories.some((item, index) => String(item).toLowerCase() === repository.toLowerCase() && String(shas[index]) === head);
  });
  if (!hasBoundRow) {
    throw new Error('Grafana Infinity query frame is not bound to the DSbot repository and current SHA');
  }
  return frames.length;
}

async function writeReceipt(file: string, receipt: ControlCenterRuntimeSmokeReceipt): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, file);
}

export async function verifyControlCenterRuntime(options: RuntimeSmokeOptions): Promise<ControlCenterRuntimeSmokeReceipt> {
  const repoPath = path.resolve(options.repoPath);
  const envPath = path.resolve(options.envPath);
  const outputPath = path.resolve(options.outputPath ?? path.join(repoPath, '.runtime-observability', 'control-center-runtime-smoke.json'));
  const now = options.now ?? (() => new Date());
  const request = options.request ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('requestTimeoutMs must be a positive integer');
  const probe = (url: string, init: RequestInit = {}): Promise<Response> => request(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
  });
  const readFile = options.readFile ?? (file => readFileDefault(file, 'utf8'));
  const runCommand = options.runCommand ?? (async (executable, args, cwd) => {
    const result = await execFile(executable, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim();
  });
  const config = JSON.parse(await readFile(path.join(repoPath, 'config', 'control-center', 'project-state.json'))) as RuntimeConfig;
  const composePath = path.join(repoPath, 'deployments', 'control-center', 'docker-compose.yml');
  const dashboardPath = path.join(repoPath, 'deployments', 'control-center', 'grafana', 'dashboards', 'dsbot-project-state.json');
  const datasourcePath = path.join(repoPath, 'deployments', 'control-center', 'grafana', 'provisioning', 'datasources', 'datasources.yml');
  const definitionContent = await Promise.all([composePath, dashboardPath, datasourcePath].map(readFile));
  const composeDefinitionSha256 = controlCenterDefinitionSha256(definitionContent);
  const checks: RuntimeSmokeCheck[] = [];
  let identity = 'unavailable';
  let head = 'unavailable';
  let integrationHead: string | undefined;
  let cleanBefore = false;

  const pass = (id: string, detail: string): void => { checks.push({ id, status: 'PASS', detail }); };
  try {
    const [remote, observedHead, status, remoteHead] = await Promise.all([
      runCommand('git', ['remote', 'get-url', 'origin'], repoPath),
      runCommand('git', ['rev-parse', 'HEAD'], repoPath),
      runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoPath),
      runCommand('git', ['ls-remote', '--heads', 'origin', `refs/heads/${config.integrationBranch}`], repoPath),
    ]);
    identity = normalizeRepository(remote);
    head = observedHead.trim();
    integrationHead = parseRemoteHead(remoteHead);
    cleanBefore = status === '';
    if (identity !== config.repository.toLowerCase()) throw new Error('Repository identity does not match Control Center config');
    if (!cleanBefore) throw new Error('Runtime smoke requires a clean worktree');
    if (!integrationHead || head !== integrationHead) throw new Error('Runtime smoke requires HEAD to equal remote integration HEAD');
    pass('repository-binding', `${identity}@${head}`);

    await runCommand('docker', ['info', '--format', '{{json .ServerVersion}}'], repoPath);
    pass('docker-daemon', 'Docker daemon is reachable');
    await runCommand('docker', ['compose', '-f', composePath, '--env-file', envPath, 'config', '--quiet'], repoPath);
    pass('compose-config', `definition sha256:${composeDefinitionSha256}`);
    const services = parseComposeServices(await runCommand('docker', ['compose', '-f', composePath, '--env-file', envPath, 'ps', '--format', 'json'], repoPath));
    const byName = new Map(services.map(service => [service.Service, service]));
    for (const serviceName of ['mysql', 'devlake', 'config-ui', 'grafana']) {
      const service = byName.get(serviceName);
      if (service?.State?.toLowerCase() !== 'running') throw new Error(`${serviceName} container is not running`);
      if (serviceName === 'mysql' && service.Health?.toLowerCase() !== 'healthy') throw new Error('mysql container is not healthy');
    }
    pass('compose-services', 'mysql, devlake, config-ui and grafana are running; mysql is healthy');

    const dashboard = await responseJson(await probe('http://127.0.0.1:8765/api/project'), 'Dashboard API');
    assertFailClosedProject(dashboard, config.repository, head);
    pass('dashboard-project', 'Repository/SHA binding and all authorization boundaries verified');
    const devLake = await probe('http://127.0.0.1:8080/swagger/index.html');
    if (!devLake.ok) throw new Error(`DevLake Swagger returned HTTP ${devLake.status}`);
    pass('devlake-http', `Swagger HTTP ${devLake.status}`);
    const configUi = await probe('http://127.0.0.1:4000/');
    if (!configUi.ok) throw new Error(`DevLake Config UI returned HTTP ${configUi.status}`);
    pass('devlake-config-ui', `HTTP ${configUi.status}`);

    const grafanaUser = process.env.GRAFANA_ADMIN_USER;
    const grafanaPassword = process.env.GRAFANA_ADMIN_PASSWORD;
    if (!grafanaUser || !grafanaPassword) throw new Error('Grafana credentials are unavailable in process environment');
    const authorization = basicAuthorization(grafanaUser, grafanaPassword);
    const grafanaHealth = await responseJson(await probe('http://127.0.0.1:3002/api/health'), 'Grafana health');
    if ((grafanaHealth as { database?: unknown }).database !== 'ok') throw new Error('Grafana database health is not ok');
    pass('grafana-health', 'Grafana database health is ok');
    const headers = { Authorization: authorization, 'Content-Type': 'application/json' };
    const datasourceHealth = await responseJson(await probe('http://127.0.0.1:3002/api/datasources/uid/dsbot-control-center/health', { headers }), 'Grafana datasource health');
    const datasourceStatus = (datasourceHealth as { status?: unknown }).status;
    if (typeof datasourceStatus !== 'string' || datasourceStatus.toUpperCase() !== 'OK') throw new Error('Grafana datasource health did not report OK');
    pass('infinity-datasource-health', 'Grafana accepted the provisioned Infinity datasource');
    const dashboardDefinition = JSON.parse(definitionContent[1]) as { panels?: Array<{ targets?: unknown[] }> };
    const target = dashboardDefinition.panels?.flatMap(panel => panel.targets ?? []).find(candidate => {
      if (!candidate || typeof candidate !== 'object') return false;
      const typed = candidate as { datasource?: { uid?: unknown; type?: unknown }; source?: unknown; url?: unknown; url_options?: { method?: unknown } };
      return typed.datasource?.uid === 'dsbot-control-center'
        && typed.datasource.type === 'yesoreyeram-infinity-datasource'
        && typed.source === 'url'
        && typed.url === 'http://host.docker.internal:8765/api/project'
        && typed.url_options?.method === 'GET';
    });
    if (!target || typeof target !== 'object') throw new Error('Expected DSbot Control Center Infinity query target is missing');
    const infinityPayload = { queries: [target], from: `${Date.now() - 60_000}`, to: `${Date.now()}` };
    const infinityResult = await responseJson(await probe('http://127.0.0.1:3002/api/ds/query', {
      method: 'POST', headers, body: JSON.stringify(infinityPayload),
    }), 'Grafana Infinity query');
    const frameCount = assertInfinityQuery(infinityResult, config.repository, head);
    pass('infinity-dashboard-query', `Grafana executed the provisioned query and returned ${frameCount} frame(s)`);

    const cleanAfter = (await runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoPath)) === '';
    const afterHead = (await runCommand('git', ['rev-parse', 'HEAD'], repoPath)).trim();
    if (!cleanAfter || afterHead !== head) throw new Error('Repository changed during runtime smoke');
    const receipt: ControlCenterRuntimeSmokeReceipt = {
      schemaVersion: '1.0', kind: 'dsbot.control-center-runtime-smoke', completedAt: now().toISOString(), status: 'PASS',
      repository: { identity, commitSha: head, integrationBranch: config.integrationBranch, integrationHead, cleanBefore, cleanAfter },
      composeDefinitionSha256, checks,
      safety: { replayApproved: false, shadowApproved: false, paperApproved: false, testnetApproved: false, liveApproved: false, tradingEnvironmentActivated: false },
      limitations: ['DevLake HTTP availability does not prove that a GitHub connection or collection blueprint has completed.'],
    };
    await writeReceipt(outputPath, receipt);
    return receipt;
  } catch (error) {
    const secretValues = [
      process.env.DEVLAKE_MYSQL_ROOT_PASSWORD,
      process.env.DEVLAKE_DB_PASSWORD,
      process.env.DEVLAKE_ENCRYPTION_SECRET,
      process.env.DEVLAKE_ADMIN_PASSWORD,
      process.env.GRAFANA_ADMIN_PASSWORD,
    ].filter((value): value is string => typeof value === 'string');
    const detail = redactRuntimeSmokeDetail(error instanceof Error ? error.message : String(error), secretValues);
    checks.push({ id: 'runtime-smoke', status: 'FAIL', detail });
    let cleanAfter = false;
    try { cleanAfter = (await runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoPath)) === ''; } catch {}
    const receipt: ControlCenterRuntimeSmokeReceipt = {
      schemaVersion: '1.0', kind: 'dsbot.control-center-runtime-smoke', completedAt: now().toISOString(), status: 'FAIL',
      repository: { identity, commitSha: head, integrationBranch: config.integrationBranch, integrationHead, cleanBefore, cleanAfter },
      composeDefinitionSha256, checks,
      safety: { replayApproved: false, shadowApproved: false, paperApproved: false, testnetApproved: false, liveApproved: false, tradingEnvironmentActivated: false },
      limitations: ['Runtime integration remains unverified; no container or trading environment was started or changed.'],
    };
    await writeReceipt(outputPath, receipt);
    return receipt;
  }
}

export function isCurrentPassingRuntimeReceipt(
  value: unknown,
  identity: string,
  head: string,
  integrationHead: string | undefined,
  integrationBranch: string,
  expectedDefinitionSha256: string,
): value is ControlCenterRuntimeSmokeReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as ControlCenterRuntimeSmokeReceipt;
  return receipt.schemaVersion === '1.0'
    && receipt.kind === 'dsbot.control-center-runtime-smoke'
    && receipt.status === 'PASS'
    && receipt.repository?.identity?.toLowerCase() === identity.toLowerCase()
    && receipt.repository.commitSha === head
    && receipt.repository.integrationHead === integrationHead
    && receipt.repository.integrationBranch === integrationBranch
    && head === integrationHead
    && receipt.repository.cleanBefore === true
    && receipt.repository.cleanAfter === true
    && Array.isArray(receipt.checks)
    && receipt.checks.length === REQUIRED_RUNTIME_SMOKE_CHECK_IDS.length
    && new Set(receipt.checks.map(check => check.id)).size === REQUIRED_RUNTIME_SMOKE_CHECK_IDS.length
    && REQUIRED_RUNTIME_SMOKE_CHECK_IDS.every(id => receipt.checks.some(check => check.id === id))
    && receipt.checks.every(check => check.status === 'PASS')
    && /^[a-f0-9]{64}$/.test(receipt.composeDefinitionSha256)
    && receipt.composeDefinitionSha256 === expectedDefinitionSha256
    && !Number.isNaN(Date.parse(receipt.completedAt))
    && Array.isArray(receipt.limitations)
    && receipt.safety?.replayApproved === false
    && receipt.safety.shadowApproved === false
    && receipt.safety.paperApproved === false
    && receipt.safety.testnetApproved === false
    && receipt.safety.liveApproved === false
    && receipt.safety.tradingEnvironmentActivated === false;
}
