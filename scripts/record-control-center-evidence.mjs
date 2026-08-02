import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rawArgs = process.argv.slice(2);
const gateIndex = rawArgs.indexOf('--gate');
if (gateIndex < 0 || !rawArgs[gateIndex + 1]) {
  console.error('Usage: npm run control-center:run -- --gate <gate-id> <executable> [args...]');
  process.exit(2);
}
const gateId = rawArgs[gateIndex + 1];
const command = rawArgs.slice(gateIndex + 2);
if (command.length === 0) {
  console.error('A gate executable is required');
  process.exit(2);
}

const repoPath = process.cwd();
const configPath = path.join(repoPath, 'config', 'control-center', 'project-state.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const gate = config.requiredLocalGates?.find(candidate => candidate.id === gateId);
if (!gate || typeof gate.executable !== 'string' || !Array.isArray(gate.args)) {
  console.error(`Unknown Control Center gate: ${gateId}`);
  process.exit(2);
}
if (command[0] !== gate.executable || JSON.stringify(command.slice(1)) !== JSON.stringify(gate.args)) {
  console.error(`Gate command mismatch for ${gateId}; expected: ${[gate.executable, ...gate.args].join(' ')}`);
  process.exit(2);
}

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

const beforeSha = await git(['rev-parse', 'HEAD']);
const beforeStatus = await git(['status', '--porcelain=v1', '--untracked-files=all']);
if (!/^[a-f0-9]{40}$/.test(beforeSha) || beforeStatus !== '') {
  console.error('Control Center gate evidence requires a clean Git worktree before execution');
  process.exit(2);
}

const startedAt = Date.now();
let childExecutable = command[0];
let childArguments = command.slice(1);
if (process.platform === 'win32' && childExecutable.toLowerCase() === 'npm.cmd') {
  if (!process.env.npm_execpath) {
    console.error('npm_execpath is required to execute npm.cmd gates without a command shell');
    process.exit(2);
  }
  childExecutable = process.env.npm_node_execpath ?? process.execPath;
  childArguments = [process.env.npm_execpath, ...childArguments];
}
const child = spawn(childExecutable, childArguments, {
  cwd: repoPath,
  stdio: 'inherit',
  windowsHide: true,
  shell: false,
});
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', code => resolve(code ?? 1));
});
const afterSha = await git(['rev-parse', 'HEAD']);
const afterStatus = await git(['status', '--porcelain=v1', '--untracked-files=all']);
const afterClean = afterStatus === '';
const stableBinding = beforeSha === afterSha && afterClean;

const root = path.join(repoPath, '.runtime-observability');
const target = path.join(root, 'control-center-tests.json');
const temporary = `${target}.${process.pid}.tmp`;
let commands = [];
try {
  const existing = JSON.parse(await readFile(target, 'utf8'));
  if (existing.schemaVersion === '2.0' && Array.isArray(existing.commands)) {
    commands = existing.commands.filter(item =>
      item.beforeSha === beforeSha && item.afterSha === beforeSha && item.beforeClean === true && item.afterClean === true,
    );
  }
} catch {}
commands = commands.filter(item => item.gateId !== gateId);
commands.push({
  gateId,
  command: [gate.executable, ...gate.args].join(' '),
  exitCode,
  completedAt: new Date().toISOString(),
  beforeSha,
  afterSha,
  beforeClean: true,
  afterClean,
  summary: `exit ${exitCode}; duration ${Date.now() - startedAt}ms`,
});
await mkdir(root, { recursive: true });
await writeFile(temporary, `${JSON.stringify({ schemaVersion: '2.0', commands: commands.slice(-50) }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
await rename(temporary, target);

if (!stableBinding) {
  console.error('Gate changed HEAD or tracked worktree state; evidence is retained but cannot verify the new state');
  process.exitCode = 3;
} else {
  process.exitCode = exitCode;
}
