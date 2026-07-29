/**
 * Stage 4B4.1 Atomic Task 3: Transitive module dependency isolation proof.
 *
 * Tests that the shadow module tree is transitively isolated from execution,
 * trading, fill simulation, and all real-order paths. Uses the TypeScript
 * Compiler API via the real repository tsconfig to resolve every import edge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  buildTransitiveGraph,
  assertForwardIsolation,
  assertReverseIsolation,
  resolveRepoRoot,
  type TransitiveGraph,
  type IsolationViolation,
} from '../helpers/transitive-module-graph';

// ─── Constants ────────────────────────────────────────────────────────────────

const REPO_ROOT = resolveRepoRoot(__dirname);
const SHADOW_DIR = path.resolve(REPO_ROOT, 'src/shadow');

/** Forbidden normalized repository-relative path segments/names */
const FORBIDDEN_SEGMENTS = [
  'paper', 'testnet', 'live', 'execution', 'fill', 'fills',
  'TradingRuntime', 'ExecutionRouter', 'PythonBridgeDaemon', 'FillSimulator', 'tests',
];

/** Paths that must not be reached in forward assertion */
const FORBIDDEN_PATH_PATTERNS = [
  'tests/',
];

// ─── Real module set collection ──────────────────────────────────────────────

function collectShadowEntries(): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(SHADOW_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts') && entry.name !== 'index.ts') {
      files.push(path.resolve(SHADOW_DIR, entry.name));
    }
  }
  // Also include the barrel index.ts
  const barrelIndex = path.resolve(SHADOW_DIR, 'index.ts');
  if (fs.existsSync(barrelIndex)) {
    files.push(barrelIndex);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Check if a resolved file path matches forbidden segments/names.
 * Classification operates only on resolved module file paths, not comments.
 */
function isForbiddenPath(resolvedPath: string): boolean {
  const normalized = path.normalize(resolvedPath).replace(/\\/g, '/');
  const repoRootNorm = path.normalize(REPO_ROOT).replace(/\\/g, '/') + '/';

  // Only check files in this repository
  if (!normalized.startsWith(repoRootNorm)) return false;

  const relative = normalized.slice(repoRootNorm.length);

  // Check for test directory
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (relative.startsWith(pattern)) return true;
  }

  // Check segments — use path parts for accurate matching
  const parts = relative.split('/');
  for (const part of parts) {
    const lower = part.toLowerCase();
    for (const forbidden of FORBIDDEN_SEGMENTS) {
      const lowerForbidden = forbidden.toLowerCase();
      // Exact match on normalized path segment
      if (lower === lowerForbidden) return true;
      // Match on filename without extension
      const withoutExt = lower.replace(/\.[^.]+$/, '');
      if (withoutExt === lowerForbidden) return true;
    }
  }

  return false;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('TD1: graph builder returns valid TransitiveGraph with all shadow entries', () => {
  const entries = collectShadowEntries();
  assert.ok(entries.length >= 6, 'at least 6 shadow source files expected');
  const graph = buildTransitiveGraph(entries);
  assert.ok(graph instanceof Map, 'graph must be a Map');
  // Graph keys use forward-slash normalized paths
  const norm = (p: string) => path.normalize(p).replace(/\\/g, '/');
  assert.ok(graph.size >= entries.length, 'graph must contain all entries');
  for (const entry of entries) {
    assert.ok(graph.has(norm(entry)), `graph must contain entry: ${entry}`);
  }
});

test('TD2: forward isolation — no shadow entry transitively reaches forbidden modules', () => {
  const entries = collectShadowEntries();
  const violations = assertForwardIsolation(entries, FORBIDDEN_SEGMENTS);
  assert.equal(violations.length, 0, `found ${violations.length} forward isolation violation(s)`);
});

test('TD3: reverse isolation — FastPipeline must not transitively reach any shadow file', () => {
  const fastPipelinePath = path.resolve(REPO_ROOT, 'src/pipeline/FastPipeline.ts');
  const violations = assertReverseIsolation(fastPipelinePath, SHADOW_DIR);
  assert.equal(violations.length, 0, `found ${violations.length} reverse isolation violation(s)`);
});

test('TD4: shadow index barrel correctly re-exports all shadow modules', () => {
  const entries = collectShadowEntries();
  const graph = buildTransitiveGraph(entries);
  const barrelKey = path.resolve(SHADOW_DIR, 'index.ts');
  const norm = (p: string) => path.normalize(p).replace(/\\/g, '/');

  const deps = graph.get(norm(barrelKey));
  assert.ok(deps, 'index.ts must be in graph');
  // Every non-index shadow source should be reachable from the barrel
  for (const entry of entries) {
    if (norm(entry) === norm(barrelKey)) continue;
    assert.ok(
      deps!.has(norm(entry)),
      `barrel must reference: ${path.basename(entry)}`,
    );
  }
});

// ─── Adversarial fixture tests ─────────────────────────────────────────────

test('TD5: detector catches side-effect import to forbidden module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const cleanFile = path.join(dir, 'clean.ts');
    const forbiddenFile = path.join(dir, 'src_execution_router.ts');
    fs.writeFileSync(cleanFile, `import './src_execution_router';\n`);
    fs.writeFileSync(forbiddenFile, 'export const x = 1;\n');

    const mockEntries = [cleanFile];
    const mockForbidden = ['execution', 'router'];

    assert.throws(
      () => assertForwardIsolation(mockEntries, mockForbidden),
      /isolation/i,
      'side-effect import to forbidden module should be caught',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD6: detector catches type-only import to forbidden module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const cleanFile = path.join(dir, 'clean.ts');
    const forbiddenFile = path.join(dir, 'paper_fill.ts');
    fs.writeFileSync(cleanFile, `import type { X } from './paper_fill';\n`);
    fs.writeFileSync(forbiddenFile, 'export type X = number;\n');

    const mockEntries = [cleanFile];
    const mockForbidden = ['paper'];

    assert.throws(
      () => assertForwardIsolation(mockEntries, mockForbidden),
      /isolation/i,
      'type-only import to forbidden module should be caught',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD7: detector catches type-only export re-export', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const cleanFile = path.join(dir, 'clean.ts');
    const forbiddenFile = path.join(dir, 'testnet_adapter.ts');
    fs.writeFileSync(cleanFile, `export type { T } from './testnet_adapter';\n`);
    fs.writeFileSync(forbiddenFile, 'export type T = string;\n');

    const mockEntries = [cleanFile];
    const mockForbidden = ['testnet'];

    assert.throws(
      () => assertForwardIsolation(mockEntries, mockForbidden),
      /isolation/i,
      'type-only export re-export should be caught',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD8: detector catches export barrel to forbidden module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const cleanFile = path.join(dir, 'clean.ts');
    const forbiddenFile = path.join(dir, 'live_order.ts');
    fs.writeFileSync(cleanFile, `export * from './live_order';\n`);
    fs.writeFileSync(forbiddenFile, 'export const live = true;\n');

    const mockEntries = [cleanFile];
    const mockForbidden = ['live'];

    assert.throws(
      () => assertForwardIsolation(mockEntries, mockForbidden),
      /isolation/i,
      'export barrel to forbidden module should be caught',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD9: detector catches import equals require to forbidden module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const cleanFile = path.join(dir, 'clean.ts');
    const forbiddenFile = path.join(dir, 'fills_utils.ts');
    fs.writeFileSync(cleanFile, `import fills = require('./fills_utils');\n`);
    fs.writeFileSync(forbiddenFile, 'export = { foo: 1 };\n');

    const mockEntries = [cleanFile];
    const mockForbidden = ['fills'];

    assert.throws(
      () => assertForwardIsolation(mockEntries, mockForbidden),
      /isolation/i,
      'import equals require to forbidden module should be caught',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD10: detector catches dynamic import to forbidden module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const cleanFile = path.join(dir, 'clean.ts');
    const forbiddenFile = path.join(dir, 'execution_handler.ts');
    fs.writeFileSync(cleanFile, `const x = import('./execution_handler');\n`);
    fs.writeFileSync(forbiddenFile, 'export const handler = 1;\n');

    const mockEntries = [cleanFile];
    const mockForbidden = ['execution'];

    assert.throws(
      () => assertForwardIsolation(mockEntries, mockForbidden),
      /isolation/i,
      'dynamic import to forbidden module should be caught',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD11: detector catches require literal to forbidden module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const cleanFile = path.join(dir, 'clean.ts');
    const forbiddenFile = path.join(dir, 'paper_trading.ts');
    fs.writeFileSync(cleanFile, `const x = require('./paper_trading');\n`);
    fs.writeFileSync(forbiddenFile, 'export const y = 2;\n');

    const mockEntries = [cleanFile];
    const mockForbidden = ['paper'];

    assert.throws(
      () => assertForwardIsolation(mockEntries, mockForbidden),
      /isolation/i,
      'require literal to forbidden module should be caught',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD12: detector handles index resolution in forbidden path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const subDir = path.join(dir, 'execution');
    fs.mkdirSync(subDir);
    const cleanFile = path.join(dir, 'clean.ts');
    const forbiddenFile = path.join(subDir, 'index.ts');
    fs.writeFileSync(cleanFile, `import { foo } from './execution';\n`);
    fs.writeFileSync(forbiddenFile, 'export const foo = 42;\n');

    const mockEntries = [cleanFile];
    const mockForbidden = ['execution'];

    assert.throws(
      () => assertForwardIsolation(mockEntries, mockForbidden),
      /isolation/i,
      'index resolution to forbidden module should be caught',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD13: detector handles cycles without infinite loop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  const norm = (p: string) => path.normalize(p).replace(/\\/g, '/');
  try {
    const aFile = path.join(dir, 'a.ts');
    const bFile = path.join(dir, 'b.ts');
    fs.writeFileSync(aFile, `import { y } from './b';\nexport const x = 1;\n`);
    fs.writeFileSync(bFile, `import { x } from './a';\nexport const y = 2;\n`);

    const graph = buildTransitiveGraph([aFile]);
    assert.ok(graph.has(norm(aFile)));
    assert.ok(graph.has(norm(bFile)));
    // Both files reachable despite cycle
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD14: TypeScript path alias resolves to a forbidden module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    const entryFile = path.join(srcDir, 'entry.ts');
    const forbiddenFile = path.join(srcDir, 'execution_alias.ts');
    const tsconfigPath = path.join(dir, 'tsconfig.json');
    fs.writeFileSync(entryFile, `import { run } from '@fixture/execution_alias';\nexport const value = run;\n`);
    fs.writeFileSync(forbiddenFile, 'export const run = 1;\n');
    fs.writeFileSync(tsconfigPath, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'Bundler',
        baseUrl: '.',
        paths: { '@fixture/*': ['src/*'] },
      },
      include: ['src/**/*.ts'],
    }));

    assert.throws(
      () => assertForwardIsolation(
        [entryFile],
        ['execution'],
        { tsconfigPath },
      ),
      /isolation/i,
      'path alias to forbidden module should be caught via TypeScript resolution',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD15: detector catches transitive forbidden leaf via chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const entryFile = path.join(dir, 'entry.ts');
    const middleFile = path.join(dir, 'middle.ts');
    const forbiddenFile = path.join(dir, 'fill_sim.ts');
    fs.writeFileSync(entryFile, `import { m } from './middle';\n`);
    fs.writeFileSync(middleFile, `import { f } from './fill_sim';\nexport const m = f;\n`);
    fs.writeFileSync(forbiddenFile, 'export const f = 99;\n');

    const mockEntries = [entryFile];
    const mockForbidden = ['fill'];

    assert.throws(
      () => assertForwardIsolation(mockEntries, mockForbidden),
      /isolation/i,
      'transitive forbidden leaf should be caught',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TD16: violation messages contain human-readable import chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-isolation-'));
  try {
    const entryFile = path.join(dir, 'entry.ts');
    const forbiddenFile = path.join(dir, 'paper_api.ts');
    fs.writeFileSync(entryFile, `import { api } from './paper_api';\n`);
    fs.writeFileSync(forbiddenFile, 'export const api = 1;\n');

    try {
      assertForwardIsolation([entryFile], ['paper']);
      assert.fail('should have thrown');
    } catch (err: any) {
      const msg = err.message;
      assert.ok(msg.includes('entry.ts'), 'message should include entry file name');
      assert.ok(msg.includes('paper_api'), 'message should include forbidden file name');
      assert.ok(msg.includes('→') || msg.includes('->'), 'message should show chain direction');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
