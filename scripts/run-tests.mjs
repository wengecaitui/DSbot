// Stage 4A4-R8-RC1: Deterministic cross-platform test discovery and execution.
// Uses the project's existing `glob` dependency (npm:glob@^10.3.10).
import { globSync } from 'glob';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const listOnly = process.argv.includes('--list');

// 1. Discover test files using the project's existing glob
const rawFiles = globSync('tests/**/*.test.ts', {
  cwd: root,
  nodir: true,
  absolute: false,
});

if (rawFiles.length === 0) {
  console.error('ERROR: No test files discovered in tests/**/*.test.ts');
  process.exit(1);
}

// 2. Normalize backslashes to forward slashes and sort deterministically
const files = rawFiles.map(f => f.replace(/\\/g, '/')).sort();

// 3. Build manifest: sorted paths joined by LF + trailing LF
const manifest = files.join('\n') + '\n';
const sha256 = createHash('sha256').update(manifest).digest('hex');

console.log(`DISCOVERED_TEST_FILES=${files.length}`);
console.log(`TEST_MANIFEST_SHA256=${sha256}`);

if (listOnly) {
  // --list: print paths after count/hash without running tests
  for (const f of files) console.log(f);
  process.exit(0);
}

// 4. Spawn node with --test, --import tsx, --import test-setup, and explicit sorted files
const args = [
  '--test',
  '--import', 'tsx',
  '--import', './tests/helpers/test-setup.ts',
  ...files,
];

const child = spawn(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

// 5. Relay SIGINT/SIGTERM to child
let relayed = false;
function relay(signal) {
  if (!relayed) {
    relayed = true;
    child.kill(signal);
  }
}
const onSigint = () => relay('SIGINT');
const onSigterm = () => relay('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

child.on('error', error => {
  console.error(`ERROR: Failed to start test runner: ${error.message}`);
  process.exitCode = 1;
});

// 6. Propagate child exit code
child.on('exit', (code, sig) => {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  if (sig) {
    process.exitCode = sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 1;
    return;
  }
  process.exitCode = code ?? 1;
});
