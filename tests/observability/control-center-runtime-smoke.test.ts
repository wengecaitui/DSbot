import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  isCurrentPassingRuntimeReceipt,
  redactRuntimeSmokeDetail,
  verifyControlCenterRuntime,
  type ControlCenterRuntimeSmokeReceipt,
} from '../../src/observability/control-center-runtime-smoke';

const HEAD = 'a'.repeat(40);

function definition(file: string): string {
  if (file.endsWith('dsbot-project-state.json')) return JSON.stringify({ panels: [{ targets: [{ refId: 'A', datasource: { uid: 'dsbot-control-center', type: 'yesoreyeram-infinity-datasource' }, source: 'url', url: 'http://host.docker.internal:8765/api/project', url_options: { method: 'GET' } }] }] });
  if (file.endsWith('project-state.json')) return JSON.stringify({ repository: 'wengecaitui/DSbot', integrationBranch: 'feature/orangeai-split' });
  return file.endsWith('docker-compose.yml') ? 'services: {}' : 'datasources: []';
}

function commandRunner(integrationHead = HEAD) {
  return async (executable: string, args: string[]): Promise<string> => {
    const command = `${executable} ${args.join(' ')}`;
    if (command.includes('remote get-url origin')) return 'https://github.com/wengecaitui/DSbot.git';
    if (command.includes('rev-parse HEAD')) return HEAD;
    if (command.includes('status --porcelain')) return '';
    if (command.includes('ls-remote --heads')) return `${integrationHead}\trefs/heads/feature/orangeai-split`;
    if (command.startsWith('docker info')) return '"28.0.0"';
    if (command.includes('compose') && command.includes('config --quiet')) return '';
    if (command.includes('compose') && command.includes('ps --format json')) return JSON.stringify([
      { Service: 'mysql', State: 'running', Health: 'healthy' },
      { Service: 'devlake', State: 'running' },
      { Service: 'config-ui', State: 'running' },
      { Service: 'grafana', State: 'running' },
    ]);
    throw new Error(`Unexpected command: ${command}`);
  };
}

function request(url: string): Promise<Response> {
  if (url.endsWith('/api/project')) return Promise.resolve(Response.json({
    repository: { identity: 'wengecaitui/dsbot', commitSha: HEAD, integrationHead: HEAD },
    approvals: Object.fromEntries(['replay', 'shadow', 'paper', 'testnet', 'live'].map(name => [name, { approved: false }])),
    boundaries: { tradingEnvironmentActivated: false },
  }));
  if (url.endsWith('/api/health')) return Promise.resolve(Response.json({ database: 'ok' }));
  if (url.includes('/api/datasources/')) return Promise.resolve(Response.json({ status: 'OK' }));
  if (url.endsWith('/api/ds/query')) return Promise.resolve(Response.json({ results: { A: { frames: [{
    schema: { fields: [{ name: 'Repository' }, { name: 'SHA' }] },
    data: { values: [['wengecaitui/dsbot'], [HEAD]] },
  }] } } }));
  return Promise.resolve(new Response('ok', { status: 200 }));
}

test('runtime smoke proves the already-running Infinity path without changing containers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsbot-runtime-smoke-'));
  const oldUser = process.env.GRAFANA_ADMIN_USER;
  const oldPassword = process.env.GRAFANA_ADMIN_PASSWORD;
  process.env.GRAFANA_ADMIN_USER = 'test-user';
  process.env.GRAFANA_ADMIN_PASSWORD = 'test-password';
  try {
    const outputPath = path.join(root, 'receipt.json');
    const receipt = await verifyControlCenterRuntime({
      repoPath: 'E:/repo', envPath: 'E:/repo/.env', outputPath,
      runCommand: commandRunner(), request, readFile: async file => definition(file),
      now: () => new Date('2026-08-02T00:00:00.000Z'),
    });
    assert.equal(receipt.status, 'PASS', JSON.stringify(receipt));
    assert.equal(receipt.checks.some(check => check.id === 'infinity-dashboard-query'), true);
    assert.equal(isCurrentPassingRuntimeReceipt(receipt, 'wengecaitui/dsbot', HEAD, HEAD, 'feature/orangeai-split', receipt.composeDefinitionSha256), true);
    const serialized = await readFile(outputPath, 'utf8');
    assert.equal(serialized.includes('test-password'), false);
    assert.equal(serialized.includes('Authorization'), false);
  } finally {
    if (oldUser === undefined) delete process.env.GRAFANA_ADMIN_USER; else process.env.GRAFANA_ADMIN_USER = oldUser;
    if (oldPassword === undefined) delete process.env.GRAFANA_ADMIN_PASSWORD; else process.env.GRAFANA_ADMIN_PASSWORD = oldPassword;
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime smoke fails closed when HEAD is not the remote integration HEAD', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsbot-runtime-smoke-stale-'));
  try {
    const receipt = await verifyControlCenterRuntime({
      repoPath: 'E:/repo', envPath: 'E:/repo/.env', outputPath: path.join(root, 'receipt.json'),
      runCommand: commandRunner('b'.repeat(40)), request, readFile: async file => definition(file),
    });
    assert.equal(receipt.status, 'FAIL');
    assert.match(receipt.checks.at(-1)?.detail ?? '', /HEAD to equal remote integration HEAD/);
    assert.equal(isCurrentPassingRuntimeReceipt(receipt, 'wengecaitui/dsbot', HEAD, HEAD, 'feature/orangeai-split', receipt.composeDefinitionSha256), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime receipt validation rejects omitted safety fields', () => {
  const receipt = {
    schemaVersion: '1.0', kind: 'dsbot.control-center-runtime-smoke', status: 'PASS', completedAt: new Date().toISOString(),
    repository: { identity: 'wengecaitui/dsbot', commitSha: HEAD, integrationBranch: 'feature/orangeai-split', integrationHead: HEAD, cleanBefore: true, cleanAfter: true },
    composeDefinitionSha256: '0'.repeat(64), checks: [{ id: 'x', status: 'PASS', detail: 'ok' }], safety: {}, limitations: [],
  } as unknown as ControlCenterRuntimeSmokeReceipt;
  assert.equal(isCurrentPassingRuntimeReceipt(receipt, 'wengecaitui/dsbot', HEAD, HEAD, 'feature/orangeai-split', receipt.composeDefinitionSha256), false);
});

test('runtime smoke rejects Infinity frames that split repository and SHA evidence across rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsbot-runtime-smoke-frame-'));
  const oldUser = process.env.GRAFANA_ADMIN_USER;
  const oldPassword = process.env.GRAFANA_ADMIN_PASSWORD;
  process.env.GRAFANA_ADMIN_USER = 'test-user';
  process.env.GRAFANA_ADMIN_PASSWORD = 'test-password';
  try {
    const badRequest = (url: string): Promise<Response> => {
      if (url.endsWith('/api/ds/query')) return Promise.resolve(Response.json({ results: { A: { frames: [
        { schema: { fields: [{ name: 'Repository' }, { name: 'SHA' }] }, data: { values: [['wengecaitui/dsbot'], ['b'.repeat(40)]] } },
        { schema: { fields: [{ name: 'Repository' }, { name: 'SHA' }] }, data: { values: [['attacker/not-dsbot'], [HEAD]] } },
      ] } } }));
      return request(url);
    };
    const receipt = await verifyControlCenterRuntime({
      repoPath: 'E:/repo', envPath: 'E:/repo/.env', outputPath: path.join(root, 'receipt.json'),
      runCommand: commandRunner(), request: badRequest, readFile: async file => definition(file),
    });
    assert.equal(receipt.status, 'FAIL');
    assert.match(receipt.checks.at(-1)?.detail ?? '', /current SHA/);
  } finally {
    if (oldUser === undefined) delete process.env.GRAFANA_ADMIN_USER; else process.env.GRAFANA_ADMIN_USER = oldUser;
    if (oldPassword === undefined) delete process.env.GRAFANA_ADMIN_PASSWORD; else process.env.GRAFANA_ADMIN_PASSWORD = oldPassword;
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime smoke redacts known and generic credentials from failure receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsbot-runtime-smoke-redaction-'));
  const oldDb = process.env.DEVLAKE_DB_PASSWORD;
  const oldGrafana = process.env.GRAFANA_ADMIN_PASSWORD;
  process.env.DEVLAKE_DB_PASSWORD = 'db-super-secret';
  process.env.GRAFANA_ADMIN_PASSWORD = 'grafana-super-secret';
  try {
    const base = commandRunner();
    const receipt = await verifyControlCenterRuntime({
      repoPath: 'E:/repo', envPath: 'E:/repo/.env', outputPath: path.join(root, 'receipt.json'),
      runCommand: async (executable, args) => {
        if (executable === 'docker' && args[0] === 'info') throw new Error('db-super-secret token=generic-secret grafana-super-secret');
        return base(executable, args);
      },
      request, readFile: async file => definition(file),
    });
    const serialized = JSON.stringify(receipt);
    assert.equal(receipt.status, 'FAIL');
    for (const secret of ['db-super-secret', 'grafana-super-secret', 'generic-secret']) assert.equal(serialized.includes(secret), false);
    assert.equal(redactRuntimeSmokeDetail('Authorization: Basic abc123', []).includes('abc123'), false);
  } finally {
    if (oldDb === undefined) delete process.env.DEVLAKE_DB_PASSWORD; else process.env.DEVLAKE_DB_PASSWORD = oldDb;
    if (oldGrafana === undefined) delete process.env.GRAFANA_ADMIN_PASSWORD; else process.env.GRAFANA_ADMIN_PASSWORD = oldGrafana;
    await rm(root, { recursive: true, force: true });
  }
});
