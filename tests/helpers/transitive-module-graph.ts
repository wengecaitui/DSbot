/**
 * Stage 4B4.1 Atomic Task 3: Transitive module dependency graph verifier.
 *
 * Uses the TypeScript Compiler API with the real repository tsconfig to:
 * - Resolve every import/export/require edge statically
 * - Detect all edge forms: ImportDeclaration, ExportDeclaration,
 *   ImportEqualsDeclaration, dynamic import('literal'), require('literal')
 * - Type-only imports are FOLLOWED (transitive), and reaching a forbidden
 *   module through a type-only edge is a HARD FAILURE (not warning).
 * - Cycle protection
 * - Deterministic normalized relative paths
 * - Human-readable import chain reports on violation
 */

import * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Map from resolved absolute file path to set of resolved dependency paths */
export type TransitiveGraph = Map<string, Set<string>>;

export interface IsolationViolation {
  /** The entry file path */
  entry: string;
  /** The forbidden file reached */
  forbidden: string;
  /** Human-readable import chain from entry to forbidden */
  chain: string[];
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const sourceFileCache = new Map<string, ts.SourceFile>();
const parsedCommandLineCache = new Map<string, ts.ParsedCommandLine>();
let _repoRoot: string | undefined;

export interface GraphBuildOptions {
  /** Defaults to the repository's real tsconfig.json. Used only by temp-fixture tests. */
  readonly tsconfigPath?: string;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function normPath(p: string): string {
  return path.normalize(p).replace(/\\/g, '/');
}

export function resolveRepoRoot(fromPath: string): string {
  if (_repoRoot) return _repoRoot;

  // Try from the provided path first
  let dir = path.dirname(path.resolve(fromPath));
  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      _repoRoot = normPath(dir);
      return _repoRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: try from current working directory
  dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      _repoRoot = normPath(dir);
      return _repoRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Could not find tsconfig.json from ${fromPath} or ${process.cwd()}`);
}

function getCompilerOptions(repoRoot: string, explicitTsconfigPath?: string): ts.CompilerOptions {
  const tsconfigPath = normPath(explicitTsconfigPath ?? path.join(repoRoot, 'tsconfig.json'));
  const cached = parsedCommandLineCache.get(tsconfigPath);
  if (cached) return cached.options;
  const rawConfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (rawConfig.error) {
    throw new Error(`Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(rawConfig.error.messageText, '\n')}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    rawConfig.config, ts.sys, path.dirname(tsconfigPath), undefined, tsconfigPath,
  );
  parsedCommandLineCache.set(tsconfigPath, parsed);
  return parsed.options;
}

function getSourceFile(filePath: string): ts.SourceFile {
  const key = normPath(filePath);
  const cached = sourceFileCache.get(key);
  if (cached) return cached;
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.ES2022, true);
  sourceFileCache.set(key, sf);
  return sf;
}

function isInRepo(filePath: string): boolean {
  if (!_repoRoot) return false;
  const repoNorm = normPath(_repoRoot) + '/';
  return normPath(filePath).startsWith(repoNorm);
}

// ─── Module resolution ───────────────────────────────────────────────────────

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/**
 * Resolve a module specifier from a source file path.
 * For files inside the repository: uses TypeScript real module resolution.
 * For files outside (adversarial fixtures): uses manual path resolution.
 */
function resolveModuleSpecifier(
  specifier: string,
  sourceFilePath: string,
  compilerOptions: ts.CompilerOptions,
): string | null {
  // Non-relative → skip (npm packages etc.)
  const sourceDir = path.dirname(path.resolve(sourceFilePath));

  // Try TypeScript real resolution first (handles path aliases, node_modules)
  const result = ts.resolveModuleName(
    specifier, sourceFilePath, compilerOptions, ts.sys,
  );
  if (result.resolvedModule) {
    const resolved = normPath(result.resolvedModule.resolvedFileName);
    if (isInRepo(sourceFilePath)) return isInRepo(resolved) ? resolved : null;

    // Adversarial fixtures live outside the repository. Confine traversal to
    // their temporary tree while still exercising TypeScript resolution.
    const fixtureRoot = normPath(path.dirname(path.resolve(sourceFilePath))) + '/';
    return resolved.startsWith(fixtureRoot) ? resolved : null;
    // Bundler resolution doesn't resolve extensionless imports — fall through
  }

  // Unresolved bare specifiers are external packages, not repository edges.
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;

  // Extension-based resolution (needed for Bundler mode + adversarial fixtures)
  const joined = path.resolve(sourceDir, specifier);

  // Direct file match with extensions
  for (const ext of TS_EXTENSIONS) {
    const candidate = joined + ext;
    if (fs.existsSync(candidate)) return normPath(candidate);
  }

  // Index file resolution
  for (const ext of TS_EXTENSIONS) {
    const candidate = path.join(joined, 'index' + ext);
    if (fs.existsSync(candidate)) return normPath(candidate);
  }

  // Directory resolution with package.json "main"
  if (fs.existsSync(joined) && fs.statSync(joined).isDirectory()) {
    const pkgJson = path.join(joined, 'package.json');
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
        if (pkg.main) {
          const mainPath = path.resolve(joined, pkg.main);
          return normPath(mainPath);
        }
      } catch { /* ignore */ }
    }
  }

  return null;
}

// ─── AST edge extraction ─────────────────────────────────────────────────────

interface ImportEdge {
  specifier: string;
  isTypeOnly: boolean;
  edgeKind: string;
}

function extractEdges(sourceFile: ts.SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = [];

  function visit(node: ts.Node) {
    // ImportDeclaration
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        const hasOnlyTypeNamedImports =
          node.importClause?.isTypeOnly === true ||
          (node.importClause?.namedBindings !== undefined &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.length > 0 &&
            node.importClause.namedBindings.elements.every(e => e.isTypeOnly));

        const isTypeOnly = node.importClause?.isTypeOnly === true || hasOnlyTypeNamedImports;

        edges.push({
          specifier: moduleSpecifier.text,
          isTypeOnly,
          edgeKind: isTypeOnly
            ? 'type-only import'
            : (node.importClause ? 'import' : 'side-effect import'),
        });
      }
    }

    // ExportDeclaration
    if (ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        edges.push({
          specifier: moduleSpecifier.text,
          isTypeOnly: node.isTypeOnly,
          edgeKind: node.isTypeOnly
            ? 'type-only export'
            : (node.exportClause ? 'named export' : 'export barrel'),
        });
      }
    }

    // ImportEqualsDeclaration
    if (ts.isImportEqualsDeclaration(node)) {
      if (node.moduleReference && ts.isExternalModuleReference(node.moduleReference)) {
        const expr = node.moduleReference.expression;
        if (ts.isStringLiteral(expr)) {
          edges.push({
            specifier: expr.text,
            isTypeOnly: false,
            edgeKind: 'import equals require',
          });
        }
      }
    }

    // CallExpression: import('literal') and require('literal')
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const args = node.arguments;

      if (args.length === 1 && ts.isStringLiteral(args[0])) {
        const specifier = args[0].text;

        // import('literal') — dynamic import
        if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          edges.push({
            specifier,
            isTypeOnly: false,
            edgeKind: 'dynamic import',
          });
        }

        // require('literal')
        if (ts.isIdentifier(callee) && callee.text === 'require') {
          edges.push({
            specifier,
            isTypeOnly: false,
            edgeKind: 'require',
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return edges;
}

// ─── Forbidden check ─────────────────────────────────────────────────────────

function isForbiddenPath(
  filePath: string,
  forbiddenSegments: string[],
): string | null {
  const normalized = normPath(filePath);
  const parts = normalized.split('/');
  const fileName = parts[parts.length - 1] || '';
  const fileNameLower = fileName.toLowerCase();
  const fileNameWithoutExt = fileNameLower.replace(/\.[^.]+$/, '');

  for (const forbidden of forbiddenSegments) {
    const lowerForbidden = forbidden.toLowerCase();

    // Exact match on any path segment (handles directory names like src/execution/)
    for (const part of parts) {
      const lower = part.toLowerCase();
      const withoutExt = lower.replace(/\.[^.]+$/, '');
      if (lower === lowerForbidden || withoutExt === lowerForbidden) {
        return forbidden;
      }
    }

    // Substring match in the target filename (handles filenames like ExecutionRouter.ts)
    // but NOT in directory segments (avoid false positives from words in paths)
    if (fileNameWithoutExt.includes(lowerForbidden)) {
      return forbidden;
    }
  }

  return null;
}

// ─── Graph building ──────────────────────────────────────────────────────────

export function buildTransitiveGraph(
  entryFiles: string[],
  options: GraphBuildOptions = {},
): TransitiveGraph {
  const repoRoot = resolveRepoRoot(entryFiles[0] || __dirname);
  const compilerOptions = getCompilerOptions(repoRoot, options.tsconfigPath);

  const graph: TransitiveGraph = new Map();
  const visited = new Set<string>();

  function walk(filePath: string): void {
    const key = normPath(filePath);
    if (visited.has(key)) return;
    visited.add(key);

    if (!graph.has(key)) graph.set(key, new Set());

    if (!fs.existsSync(filePath)) return;

    const sf = getSourceFile(filePath);
    const edges = extractEdges(sf);

    for (const edge of edges) {
      const resolved = resolveModuleSpecifier(edge.specifier, filePath, compilerOptions);
      if (resolved && fs.existsSync(resolved)) {
        const resolvedKey = normPath(resolved);
        graph.get(key)!.add(resolvedKey);

        if (!visited.has(resolvedKey)) {
          walk(resolved);
        }
      } else if (edge.specifier.startsWith('.') || edge.specifier.startsWith('/')) {
        throw new Error(
          `Transitive graph: unresolved local ${edge.edgeKind} "${edge.specifier}" from ${key}`,
        );
      }
    }
  }

  for (const entry of [...entryFiles].sort((a, b) => normPath(a).localeCompare(normPath(b)))) {
    walk(path.resolve(entry));
  }

  return graph;
}

// ─── Chain finding ───────────────────────────────────────────────────────────

function findChain(
  entry: string,
  targetKey: string,
  graph: TransitiveGraph,
): string[] {
  const entryKey = normPath(entry);
  if (entryKey === targetKey) return [entryKey];

  const parent = new Map<string, string>();
  const queue: string[] = [entryKey];
  const seen = new Set<string>([entryKey]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetKey) {
      const chain: string[] = [];
      let node: string | undefined = current;
      while (node !== undefined) {
        chain.unshift(node);
        node = parent.get(node);
      }
      return chain;
    }

    const deps = graph.get(current);
    if (deps) {
      for (const dep of deps) {
        if (!seen.has(dep)) {
          seen.add(dep);
          parent.set(dep, current);
          queue.push(dep);
        }
      }
    }
  }

  return [];
}

// ─── Public assertion APIs ───────────────────────────────────────────────────

export function assertForwardIsolation(
  entryFiles: string[],
  forbiddenSegments: string[],
  options: GraphBuildOptions = {},
): IsolationViolation[] {
  const repoRoot = resolveRepoRoot(entryFiles[0] || '.');
  const graph = buildTransitiveGraph(entryFiles, options);
  const violations: IsolationViolation[] = [];

  for (const [nodeKey, deps] of graph.entries()) {
    for (const depKey of deps) {
      const forbidden = isForbiddenPath(depKey, forbiddenSegments);
      if (forbidden) {
        // Find which entry leads to this dep
        for (const entry of entryFiles) {
          const entryKey = normPath(path.resolve(entry));
          const chain = findChain(entryKey, depKey, graph);
          if (chain.length > 0) {
            const repoNorm = normPath(repoRoot) + '/';
            const relativeChain = chain.map(p =>
              p.startsWith(repoNorm) ? p.slice(repoNorm.length) : p,
            );
            const chainStr = relativeChain.join(' → ');

            violations.push({
              entry: chain[0].startsWith(repoNorm) ? chain[0].slice(repoNorm.length) : chain[0],
              forbidden: chain[chain.length - 1].startsWith(repoNorm)
                ? chain[chain.length - 1].slice(repoNorm.length)
                : chain[chain.length - 1],
              chain: relativeChain,
            });

            const msg = [
              `Forward isolation VIOLATION: shadow entry reaches forbidden module.`,
              `  Forbidden segment: "${forbidden}"`,
              `  Chain: ${chainStr}`,
            ].join('\n');
            throw new Error(msg);
          }
        }
      }
    }
  }

  return violations;
}

export function assertReverseIsolation(
  sourceFile: string,
  targetDir: string,
): IsolationViolation[] {
  const repoRoot = resolveRepoRoot(sourceFile);
  const graph = buildTransitiveGraph([sourceFile]);
  const targetDirNorm = normPath(targetDir) + '/';
  const violations: IsolationViolation[] = [];

  const sourceKey = normPath(path.resolve(sourceFile));

  function collectReachable(startKey: string, collected: Set<string>): void {
    const deps = graph.get(startKey);
    if (!deps) return;
    for (const depKey of deps) {
      if (!collected.has(depKey)) {
        collected.add(depKey);
        collectReachable(depKey, collected);
      }
    }
  }

  const reachable = new Set<string>([sourceKey]);
  collectReachable(sourceKey, reachable);

  for (const nodeKey of reachable) {
    if (nodeKey.startsWith(targetDirNorm)) {
      const chain = findChain(sourceKey, nodeKey, graph);
      const repoNorm = normPath(repoRoot) + '/';
      const relativeChain = chain.map(p =>
        p.startsWith(repoNorm) ? p.slice(repoNorm.length) : p,
      );
      const chainStr = relativeChain.join(' → ');

      violations.push({
        entry: chain[0].startsWith(repoNorm) ? chain[0].slice(repoNorm.length) : chain[0],
        forbidden: chain[chain.length - 1].startsWith(repoNorm)
          ? chain[chain.length - 1].slice(repoNorm.length)
          : chain[chain.length - 1],
        chain: relativeChain,
      });

      throw new Error(
        `Reverse isolation VIOLATION: ${path.relative(repoRoot, sourceKey)} ` +
        `reaches shadow module at ${path.relative(repoRoot, nodeKey)}\n` +
        `  Chain: ${chainStr}`,
      );
    }
  }

  return violations;
}
