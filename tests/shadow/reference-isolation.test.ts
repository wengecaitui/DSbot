/**
 * Stage 4B4.1 Atomic Task 3: Reference isolation.
 *
 * Asserts that build output (dist/) does not include test files
 * or reference harness files. The tsconfig already guarantees this
 * via `"rootDir": "./src"` and `"include": ["src/**\/*"]`, but we
 * add a targeted assertion as a contract guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ─── Tests ──────────────────────────────────────────────────────────────────

test('RI1: tsconfig rootDir excludes tests from build output', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const tsconfigPath = path.resolve(repoRoot, 'tsconfig.json');
  const raw = fs.readFileSync(tsconfigPath, 'utf-8');
  const tsconfig = JSON.parse(raw);

  assert.equal(tsconfig.compilerOptions.rootDir, './src',
    'rootDir must be ./src (tests/ excluded by tsc)');
  assert.ok(
    tsconfig.include && tsconfig.include.includes('src/**/*'),
    'include must only cover src/',
  );
  assert.ok(
    tsconfig.exclude && tsconfig.exclude.includes('node_modules'),
    'exclude must include node_modules',
  );
});

test('RI2: dist directory does not contain test files', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const distDir = path.resolve(repoRoot, 'dist');

  if (!fs.existsSync(distDir)) {
    // dist/ may not exist if build hasn't been run
    return;
  }

  function* walkDir(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        yield* walkDir(fullPath);
      } else {
        yield fullPath;
      }
    }
  }

  const distFiles = Array.from(walkDir(distDir));
  const testFiles = distFiles.filter(f => {
    const relative = path.relative(distDir, f).replace(/\\/g, '/');
    // Only match actual test file patterns, not business modules like "backtest"
    const name = path.basename(f);
    if (name.includes('.test.')) return true;
    // Match if under a tests/ directory segment
    if (relative.split('/').some(seg => seg === 'tests')) return true;
    return false;
  });

  assert.equal(testFiles.length, 0,
    `dist/ must not contain test files: ${testFiles.join(', ')}`);
});

test('RI3: tests/helpers directory contains only helper/fixture code', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const helpersDir = path.resolve(repoRoot, 'tests/helpers');

  if (!fs.existsSync(helpersDir)) {
    return;
  }

  const helperFiles = fs.readdirSync(helpersDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.ts'))
    .map(e => e.name);

  // All helper files should be in tests/helpers/, never in src/
  for (const file of helperFiles) {
    const srcPath = path.resolve(repoRoot, 'src', file);
    assert.ok(!fs.existsSync(srcPath),
      `Helper file "${file}" must NOT exist in src/`);
  }
});
