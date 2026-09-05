// PRE-4A4-R2: Deterministic security exception validation — pure function, injectable clock.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

export const ERROR_CODES = Object.freeze({
  SCHEMA_INVALID: 'SECURITY_EXCEPTION_SCHEMA_INVALID',
  DUPLICATE: 'SECURITY_EXCEPTION_DUPLICATE',
  DUPLICATE_CVE: 'SECURITY_EXCEPTION_DUPLICATE_CVE',
  WILDCARD: 'SECURITY_EXCEPTION_WILDCARD_FORBIDDEN',
  EXPIRED: 'SECURITY_EXCEPTION_EXPIRED',
  LIFETIME: 'SECURITY_EXCEPTION_LIFETIME_EXCEEDED',
  ALLOWLIST_MISMATCH: 'SECURITY_EXCEPTION_ALLOWLIST_MISMATCH',
  ALLOWLIST_MISSING: 'SECURITY_EXCEPTION_ALLOWLIST_MISSING',
  INVALID_DATE: 'SECURITY_EXCEPTION_INVALID_DATE',
  INVALID_DATE_ORDER: 'SECURITY_EXCEPTION_INVALID_DATE_ORDER',
  INVALID_LIFETIME: 'SECURITY_EXCEPTION_INVALID_LIFETIME',
  INVALID_GHSA: 'SECURITY_EXCEPTION_INVALID_GHSA',
  INVALID_CVE: 'SECURITY_EXCEPTION_INVALID_CVE',
  MISSING_FIELD: 'SECURITY_EXCEPTION_MISSING_FIELD',
  FINGERPRINT_MISSING: 'SECURITY_EXCEPTION_FINGERPRINT_MISSING',
  PACKAGE_MISSING: 'SECURITY_EXCEPTION_PACKAGE_MISSING',
  VERSION_MISMATCH: 'SECURITY_EXCEPTION_VERSION_MISMATCH',
  DEPENDENCY_EDGE_MISMATCH: 'SECURITY_EXCEPTION_DEPENDENCY_EDGE_MISMATCH',
  UNEXPECTED_CONSUMER: 'SECURITY_EXCEPTION_UNEXPECTED_CONSUMER',
  INTEGRITY_MISMATCH: 'SECURITY_EXCEPTION_INTEGRITY_MISMATCH',
  REACHABILITY_GUARD_FAILED: 'SECURITY_EXCEPTION_REACHABILITY_GUARD_FAILED',
});

const REQUIRED_FIELDS = ['advisoryId', 'package', 'severity', 'reason', 'owner', 'createdAt', 'expiresAt', 'maximumLifetimeDays', 'compensatingControls', 'removalCondition'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GHSA_RE = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const CVE_RE = /^CVE-\d{4}-\d+$/;
const DEPENDENCY_TYPES = ['dependencies', 'optionalDependencies'];
const REQUIRED_RUNTIME_SOURCE_ROOTS = ['src', 'web/src'];
const REQUIRED_RUNTIME_SOURCE_EXTENSIONS = ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'];
const REQUIRED_EXCLUDED_DIRECTORY_NAMES = ['__fixtures__', '__generated__', '__tests__', 'build', 'dist', 'docs', 'fixtures', 'generated', 'node_modules', 'test', 'tests'];
const SOURCE_RULE_KINDS = ['moduleImport', 'memberAccess'];
const SOURCE_GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
const REQUIRED_SOURCE_RULES = [
  { id: 'anchor-workspace-runtime-use', kind: 'memberAccess', value: 'workspace' },
  { id: 'toml-direct-runtime-import', kind: 'moduleImport', value: 'toml' },
  { id: 'rustbin-direct-runtime-import', kind: 'moduleImport', value: '@metaplex-foundation/rustbin' },
  { id: 'jayson-direct-runtime-import-or-transport-use', kind: 'moduleImport', value: 'jayson' },
  { id: 'stream-json-direct-runtime-import-or-filter-use', kind: 'moduleImport', value: 'stream-json' },
];

function isValidDate(s) { if (!DATE_RE.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }

function resolveLockedDependency(packages, consumerPath, packageName) {
  let directory = consumerPath;
  while (true) {
    const candidate = directory ? `${directory}/node_modules/${packageName}` : `node_modules/${packageName}`;
    if (packages[candidate]) return candidate;
    if (!directory) return null;
    const separator = directory.lastIndexOf('/');
    directory = separator === -1 ? '' : directory.slice(0, separator);
  }
}

function fingerprintShapeIsValid(fingerprint) {
  if (!fingerprint || !Array.isArray(fingerprint.topology) || fingerprint.topology.length === 0) return false;
  return fingerprint.topology.every((target) =>
    target
    && typeof target.packageName === 'string' && target.packageName.length > 0
    && typeof target.packagePath === 'string' && target.packagePath.startsWith('node_modules/')
    && typeof target.version === 'string' && target.version.length > 0
    && typeof target.integrity === 'string' && target.integrity.startsWith('sha512-')
    && Array.isArray(target.consumers)
    && target.consumers.every((consumer) =>
      consumer
      && typeof consumer.path === 'string' && consumer.path.startsWith('node_modules/')
      && typeof consumer.version === 'string' && consumer.version.length > 0
      && DEPENDENCY_TYPES.includes(consumer.dependencyType)
      && typeof consumer.dependencySpecifier === 'string' && consumer.dependencySpecifier.length > 0));
}

function exactStringSet(actual, required) {
  return Array.isArray(actual)
    && actual.length === required.length
    && new Set(actual).size === actual.length
    && required.every((value) => actual.includes(value));
}

function sourceReachabilityGuardShapeIsValid(guard) {
  return guard
    && exactStringSet(guard.runtimeSourceRoots, REQUIRED_RUNTIME_SOURCE_ROOTS)
    && exactStringSet(guard.sourceExtensions, REQUIRED_RUNTIME_SOURCE_EXTENSIONS)
    && exactStringSet(guard.excludedDirectoryNames, REQUIRED_EXCLUDED_DIRECTORY_NAMES)
    && Array.isArray(guard.rules)
    && guard.rules.length === REQUIRED_SOURCE_RULES.length
    && new Set(guard.rules.map((rule) => rule?.id)).size === guard.rules.length
    && guard.rules.every((rule) =>
      rule
      && typeof rule.id === 'string' && rule.id.length > 0
      && SOURCE_RULE_KINDS.includes(rule.kind)
      && typeof rule.value === 'string' && rule.value.length > 0)
    && REQUIRED_SOURCE_RULES.every((required) => guard.rules.some((rule) =>
      rule.id === required.id && rule.kind === required.kind && rule.value === required.value));
}

function normalizeRepositoryPath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isRuntimeSourcePath(path, guard) {
  const normalized = normalizeRepositoryPath(path);
  const root = guard.runtimeSourceRoots.find((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`));
  if (!root || !guard.sourceExtensions.includes(extname(normalized).toLowerCase())) return false;
  const relativeSegments = normalized.slice(root.length).split('/').filter(Boolean);
  return !relativeSegments.some((segment) => guard.excludedDirectoryNames.includes(segment.toLowerCase()));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ruleMatchesSource(rule, source) {
  if (rule.kind === 'memberAccess') {
    // Temporary, deliberately conservative property guard: the receiver's name
    // and module provenance must not affect admission. Also covers optional
    // chaining, computed literal keys, destructuring and named imports/exports.
    // Unrelated workspace properties (including object literals) may be rejected.
    const member = escapeRegExp(rule.value);
    const literal = `(?:'${member}'|"${member}"|\\x60${member}\\x60)`;
    const memberPattern = `\\.${SOURCE_GAP}${member}\\b|\\[${SOURCE_GAP}${literal}${SOURCE_GAP}\\]`;
    const bindingPattern = `[{,]${SOURCE_GAP}(?:${member}\\b|${literal})`;
    if (new RegExp(`(?:${memberPattern}|${bindingPattern})`, 'i').test(source)) return true;
    // A direct workspace submodule import reaches the same sink without any
    // property access. Keep ordinary Anchor imports (Wallet/Provider/BN) allowed.
    return /['"`]@(?:coral-xyz|project-serum)\/anchor(?:\/[^'"`\s]*)?\/workspace(?:[./'"`])/.test(source);
  }
  const moduleName = escapeRegExp(rule.value);
  const moduleSpecifier = `${moduleName}(?:/[^'"\\x60\\s)]+)?`;
  return new RegExp(`(?:\\bfrom${SOURCE_GAP}|\\bimport${SOURCE_GAP}(?:\\(${SOURCE_GAP})?|\\brequire${SOURCE_GAP}(?:\\?\\.${SOURCE_GAP})?\\(${SOURCE_GAP})['"\\x60]${moduleSpecifier}['"\\x60]`, 'm').test(source);
}

export function validateSourceReachabilityGuard(registry, runtimeSources) {
  const guard = registry?.sourceReachabilityGuard;
  if (!sourceReachabilityGuardShapeIsValid(guard)) {
    return [{ code: ERROR_CODES.REACHABILITY_GUARD_FAILED, detail: 'sourceReachabilityGuard is missing, malformed, or has a narrowed scan boundary' }];
  }
  if (!Array.isArray(runtimeSources) || runtimeSources.length === 0) {
    return [{ code: ERROR_CODES.REACHABILITY_GUARD_FAILED, detail: 'runtime source inventory is missing or empty' }];
  }
  if (runtimeSources.some((source) => !source || typeof source.path !== 'string' || typeof source.content !== 'string')) {
    return [{ code: ERROR_CODES.REACHABILITY_GUARD_FAILED, detail: 'runtime source inventory contains a malformed entry' }];
  }
  const normalizedPaths = runtimeSources.map((source) => normalizeRepositoryPath(source.path));
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    return [{ code: ERROR_CODES.REACHABILITY_GUARD_FAILED, detail: 'runtime source inventory contains duplicate paths' }];
  }

  const errors = [];
  const sources = runtimeSources
    .filter((source) => isRuntimeSourcePath(source.path, guard))
    .sort((a, b) => normalizeRepositoryPath(a.path).localeCompare(normalizeRepositoryPath(b.path)));
  if (sources.length === 0) {
    return [{ code: ERROR_CODES.REACHABILITY_GUARD_FAILED, detail: 'runtime source inventory contains no files inside the declared scan boundary' }];
  }

  for (const source of sources) {
    for (const rule of guard.rules) {
      if (ruleMatchesSource(rule, source.content)) {
        errors.push({
          code: ERROR_CODES.REACHABILITY_GUARD_FAILED,
          detail: `${normalizeRepositoryPath(source.path)} violates source reachability rule ${rule.id}`,
        });
      }
    }
  }
  return errors;
}

export function collectRuntimeSources(root, guard) {
  if (!sourceReachabilityGuardShapeIsValid(guard)) throw new Error('sourceReachabilityGuard is missing, malformed, or has a narrowed scan boundary');
  const sources = [];
  const visit = (absoluteDirectory) => {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (guard.excludedDirectoryNames.includes(entry.name.toLowerCase())) continue;
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic link is forbidden in runtime source inventory: ${normalizeRepositoryPath(relative(root, absolutePath))}`);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && guard.sourceExtensions.includes(extname(entry.name).toLowerCase())) {
        sources.push({ path: normalizeRepositoryPath(relative(root, absolutePath)), content: readFileSync(absolutePath, 'utf8') });
      }
    }
  };
  for (const sourceRoot of guard.runtimeSourceRoots) {
    const absoluteRoot = resolve(root, sourceRoot);
    if (!existsSync(absoluteRoot)) throw new Error(`runtime source root is missing: ${sourceRoot}`);
    visit(absoluteRoot);
  }
  return sources;
}

export function validateDependencyFingerprint(exception, lockfile) {
  const errors = [];
  const fingerprint = exception?.dependencyFingerprint;
  const packages = lockfile?.packages;
  if (!fingerprintShapeIsValid(fingerprint)) {
    errors.push({ code: ERROR_CODES.FINGERPRINT_MISSING, detail: `${exception?.advisoryId || '<unknown>'}: dependencyFingerprint is missing or malformed` });
    return errors;
  }
  if (!packages || typeof packages !== 'object') {
    errors.push({ code: ERROR_CODES.PACKAGE_MISSING, detail: `${exception.advisoryId}: package-lock packages map is missing` });
    return errors;
  }
  if (!fingerprint.topology.some((target) => target.packageName === exception.package)) {
    errors.push({ code: ERROR_CODES.DEPENDENCY_EDGE_MISMATCH, detail: `${exception.advisoryId}: fingerprint does not track affected package ${exception.package}` });
  }

  const seenTargets = new Set();
  for (const target of fingerprint.topology) {
    if (seenTargets.has(target.packagePath)) {
      errors.push({ code: ERROR_CODES.FINGERPRINT_MISSING, detail: `${exception.advisoryId}: duplicate fingerprint target ${target.packagePath}` });
      continue;
    }
    seenTargets.add(target.packagePath);
    const targetEntry = packages[target.packagePath];
    if (!targetEntry) {
      errors.push({ code: ERROR_CODES.PACKAGE_MISSING, detail: `${exception.advisoryId}: missing ${target.packagePath}` });
      continue;
    }
    if (targetEntry.version !== target.version) {
      errors.push({ code: ERROR_CODES.VERSION_MISMATCH, detail: `${exception.advisoryId}: ${target.packagePath} expected ${target.version}, found ${targetEntry.version || '<missing>'}` });
    }
    if (targetEntry.integrity !== target.integrity) {
      errors.push({ code: ERROR_CODES.INTEGRITY_MISMATCH, detail: `${exception.advisoryId}: ${target.packagePath} integrity does not match the authorized fingerprint` });
    }

    const expectedConsumers = new Map();
    for (const consumer of target.consumers) {
      const key = `${consumer.path}\u0000${consumer.dependencyType}`;
      if (expectedConsumers.has(key)) {
        errors.push({ code: ERROR_CODES.FINGERPRINT_MISSING, detail: `${exception.advisoryId}: duplicate consumer ${consumer.path} (${consumer.dependencyType})` });
      }
      expectedConsumers.set(key, consumer);
    }

    const currentConsumers = new Set();
    for (const [consumerPath, consumerEntry] of Object.entries(packages)) {
      for (const dependencyType of DEPENDENCY_TYPES) {
        if (!Object.prototype.hasOwnProperty.call(consumerEntry?.[dependencyType] || {}, target.packageName)) continue;
        if (resolveLockedDependency(packages, consumerPath, target.packageName) === target.packagePath) {
          const key = `${consumerPath}\u0000${dependencyType}`;
          currentConsumers.add(key);
          if (!expectedConsumers.has(key)) {
            errors.push({ code: ERROR_CODES.UNEXPECTED_CONSUMER, detail: `${exception.advisoryId}: unexpected ${target.packageName} consumer ${consumerPath || '<root>'} (${dependencyType})` });
          }
        }
      }
    }

    for (const [key, consumer] of expectedConsumers) {
      const consumerEntry = packages[consumer.path];
      if (!consumerEntry) {
        errors.push({ code: ERROR_CODES.PACKAGE_MISSING, detail: `${exception.advisoryId}: missing consumer ${consumer.path}` });
        continue;
      }
      if (consumerEntry.version !== consumer.version) {
        errors.push({ code: ERROR_CODES.VERSION_MISMATCH, detail: `${exception.advisoryId}: ${consumer.path} expected ${consumer.version}, found ${consumerEntry.version || '<missing>'}` });
      }
      const actualSpecifier = consumerEntry[consumer.dependencyType]?.[target.packageName];
      const resolvedPath = resolveLockedDependency(packages, consumer.path, target.packageName);
      if (!currentConsumers.has(key) || actualSpecifier !== consumer.dependencySpecifier || resolvedPath !== target.packagePath) {
        errors.push({ code: ERROR_CODES.DEPENDENCY_EDGE_MISMATCH, detail: `${exception.advisoryId}: ${consumer.path} -> ${target.packageName} expected ${consumer.dependencyType}:${consumer.dependencySpecifier} at ${target.packagePath}, found ${actualSpecifier || '<missing>'} at ${resolvedPath || '<unresolved>'}` });
      }
    }
  }
  return errors;
}

export function validateAuditExceptions(input) {
  const errors = [];
  const valid = [];
  const { registry, allowlist, now, lockfile, runtimeSources } = input;
  const enforceDependencyFingerprint = input.enforceDependencyFingerprint === true || Boolean(lockfile);
  const enforceSourceReachabilityGuard = input.enforceSourceReachabilityGuard === true || Boolean(runtimeSources);
  if (!registry || !Array.isArray(registry.exceptions)) { errors.push({ code: ERROR_CODES.SCHEMA_INVALID, detail: 'missing or invalid exceptions array' }); return { errors, valid }; }
  if (typeof now !== 'string' || !isValidDate(now)) { errors.push({ code: ERROR_CODES.INVALID_DATE, detail: `invalid now date: ${now}` }); return { errors, valid }; }
  const nowDate = new Date(now + 'T00:00:00Z');
  if (enforceSourceReachabilityGuard) errors.push(...validateSourceReachabilityGuard(registry, runtimeSources));
  const seenGHSA = new Set();
  const seenCVE = new Set();
  for (const ex of registry.exceptions) {
    for (const f of REQUIRED_FIELDS) { if (!ex[f]) { errors.push({ code: ERROR_CODES.MISSING_FIELD, detail: `missing "${f}" in ${ex.advisoryId || '<unknown>'}` }); } }
    if (ex.package === '*' || ex.advisoryId === '*' || ex.advisoryId.includes('*')) { errors.push({ code: ERROR_CODES.WILDCARD, detail: `wildcard forbidden: ${ex.advisoryId}` }); }
    if (!GHSA_RE.test(ex.advisoryId)) { errors.push({ code: ERROR_CODES.INVALID_GHSA, detail: `invalid GHSA: ${ex.advisoryId}` }); }
    if (ex.relatedCves) { for (const c of ex.relatedCves) { if (!CVE_RE.test(c)) { errors.push({ code: ERROR_CODES.INVALID_CVE, detail: `invalid CVE: ${c}` }); } if (seenCVE.has(c)) { errors.push({ code: ERROR_CODES.DUPLICATE_CVE, detail: `duplicate CVE: ${c}` }); } seenCVE.add(c); } }
    if (seenGHSA.has(ex.advisoryId)) { errors.push({ code: ERROR_CODES.DUPLICATE, detail: `duplicate advisoryId: ${ex.advisoryId}` }); } seenGHSA.add(ex.advisoryId);
    if (enforceDependencyFingerprint) errors.push(...validateDependencyFingerprint(ex, lockfile));
    if (!isValidDate(ex.createdAt)) { errors.push({ code: ERROR_CODES.INVALID_DATE, detail: `invalid createdAt: ${ex.createdAt}` }); }
    if (!isValidDate(ex.expiresAt)) { errors.push({ code: ERROR_CODES.INVALID_DATE, detail: `invalid expiresAt: ${ex.expiresAt}` }); }
    if (isValidDate(ex.createdAt) && isValidDate(ex.expiresAt)) {
      const created = new Date(ex.createdAt + 'T00:00:00Z');
      const expires = new Date(ex.expiresAt + 'T00:00:00Z');
      if (created >= expires) { errors.push({ code: ERROR_CODES.INVALID_DATE_ORDER, detail: `${ex.advisoryId}: createdAt ${ex.createdAt} >= expiresAt ${ex.expiresAt}` }); }
      const diffDays = Math.ceil((expires.getTime() - created.getTime()) / 86400000);
      if (expires <= nowDate) { errors.push({ code: ERROR_CODES.EXPIRED, detail: `${ex.advisoryId}: expired ${ex.expiresAt} (now=${now})` }); }
      const max = ex.maximumLifetimeDays;
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 30) { errors.push({ code: ERROR_CODES.INVALID_LIFETIME, detail: `${ex.advisoryId}: invalid maximumLifetimeDays=${max}` }); }
      else if (diffDays > max) { errors.push({ code: ERROR_CODES.LIFETIME, detail: `${ex.advisoryId}: lifetime ${diffDays}d > max ${max}d` }); }
      if (errors.every(e => e.code !== ERROR_CODES.EXPIRED && e.code !== ERROR_CODES.INVALID_DATE && e.code !== ERROR_CODES.INVALID_DATE_ORDER && e.code !== ERROR_CODES.LIFETIME && e.code !== ERROR_CODES.INVALID_LIFETIME && e.code !== ERROR_CODES.INVALID_GHSA && e.code !== ERROR_CODES.MISSING_FIELD && e.code !== ERROR_CODES.DUPLICATE && e.code !== ERROR_CODES.DUPLICATE_CVE && e.code !== ERROR_CODES.WILDCARD && e.code !== ERROR_CODES.INVALID_CVE)) {
        valid.push(`${ex.advisoryId}: expires ${ex.expiresAt} (${diffDays}d)`);
      }
    }
  }
  if (!allowlist || !Array.isArray(allowlist.allowlist)) { errors.push({ code: ERROR_CODES.ALLOWLIST_MISSING, detail: 'allowlist file missing or invalid' }); return { errors, valid }; }
  const regIds = new Set(registry.exceptions.map(e => e.advisoryId));
  for (const a of allowlist.allowlist) { if (typeof a === 'string' && !regIds.has(a)) { errors.push({ code: ERROR_CODES.ALLOWLIST_MISMATCH, detail: `allowlist "${a}" not in registry` }); } }
  for (const id of regIds) { if (!allowlist.allowlist.some(a => a === id)) { errors.push({ code: ERROR_CODES.ALLOWLIST_MISMATCH, detail: `registry "${id}" not in allowlist` }); } }
  return { errors, valid };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function runSecurityExceptionNegativeProbes(registry, lockfile) {
  const guard = registry.sourceReachabilityGuard;
  const clean = { path: 'src/security-probe.ts', content: 'export const safe = true;' };
  const reachabilityCases = [
    ['anchor.workspace', 'const program = anchor.workspace.Dsbot;'],
    ['aliased dynamic import', "const a = await import('@coral-xyz/anchor'); a.workspace.Program;"],
    ['optional member', 'a?.workspace.Program;'],
    ['single-quoted bracket', "a['workspace'].Program;"],
    ['double-quoted bracket', 'a["workspace"].Program;'],
    ['template-literal bracket', 'a[`workspace`].Program;'],
    ['optional bracket', "a?.['workspace'].Program;"],
    ['destructuring', 'const { workspace } = anchor;'],
    ['renamed destructuring', 'const { workspace: ws } = anchor;'],
    ['later destructuring member', 'const { BN, workspace: ws } = a;'],
    ['comment-separated member', 'a /* receiver */ ?. /* member */ workspace.Program;'],
    ['comment-separated destructuring', 'const { /* key */ workspace: ws } = a;'],
    ['computed destructuring', 'const { ["workspace"]: ws } = a;'],
    ['quoted destructuring', 'const { "workspace": ws } = a;'],
    ['unrelated receiver', 'unrelated.workspace;'],
    ['direct toml import', "import toml from 'toml';"],
    ['direct rustbin import', "const rustbin = require('@metaplex-foundation/rustbin');"],
    ['jayson TCP/TLS reachability', "import jayson from 'jayson'; jayson.Server.tcp({}); jayson.Server.tls({});"],
    ['vulnerable stream-json filters', "import { pick } from 'stream-json/filters/Pick'; import { ignore } from 'stream-json/filters/Ignore'; import { filter } from 'stream-json/filters/Filter'; import { replace } from 'stream-json/filters/Replace';"],
  ];
  for (const moduleName of ['@coral-xyz/anchor', '@project-serum/anchor']) {
    reachabilityCases.push(
      [`${moduleName} namespace alias`, `import * as a from '${moduleName}'; a.workspace.Program;`],
      [`${moduleName} named import`, `import { workspace } from '${moduleName}';`],
      [`${moduleName} renamed import`, `import { BN, workspace as ws } from '${moduleName}';`],
      [`${moduleName} direct require`, `const { workspace } = require('${moduleName}');`],
      [`${moduleName} renamed require`, `const { workspace: ws } = require('${moduleName}');`],
      [`${moduleName} direct dynamic import`, `const { workspace } = await import('${moduleName}');`],
      [`${moduleName} workspace submodule`, `import ws from '${moduleName}/dist/cjs/workspace.js';`],
    );
  }
  let passed = 0;
  for (const [label, content] of reachabilityCases) {
    for (const root of REQUIRED_RUNTIME_SOURCE_ROOTS) {
      const errors = validateSourceReachabilityGuard(registry, [{ path: `${root}/security-probe.ts`, content }]);
      if (!errors.some((error) => error.code === ERROR_CODES.REACHABILITY_GUARD_FAILED)) throw new Error(`negative probe unexpectedly passed: ${root}: ${label}`);
      passed += 1;
    }
  }
  for (const moduleName of ['@coral-xyz/anchor', '@project-serum/anchor']) {
    for (const member of ['Wallet', 'AnchorProvider', 'BN']) {
      for (const root of REQUIRED_RUNTIME_SOURCE_ROOTS) {
        const content = `const anchor = await import('${moduleName}'); anchor.${member};`;
        const errors = validateSourceReachabilityGuard(registry, [{ path: `${root}/security-probe.ts`, content }]);
        if (errors.length > 0) throw new Error(`safe Anchor probe rejected: ${root}: ${moduleName}.${member}`);
        passed += 1;
      }
    }
  }
  const excludedErrors = validateSourceReachabilityGuard(registry, [
    clean,
    { path: 'docs/security.md', content: "import toml from 'toml'; anchor.workspace" },
    { path: 'tests/security/reachability.test.ts', content: "import jayson from 'jayson';" },
    { path: 'src/__tests__/fixture.ts', content: "import { pick } from 'stream-json/filters/Pick';" },
    ...REQUIRED_RUNTIME_SOURCE_ROOTS.flatMap((root) => REQUIRED_EXCLUDED_DIRECTORY_NAMES.map((directory) => ({
      path: `${root}/${directory}/security-probe.ts`, content: 'const { workspace: ws } = a; a.workspace;',
    }))),
  ]);
  if (excludedErrors.length > 0) throw new Error('excluded docs/tests negative probe produced a false positive');

  const integrityRegistry = clone(registry);
  const integrityLockfile = clone(lockfile);
  const target = integrityRegistry.exceptions[0].dependencyFingerprint.topology[0];
  integrityLockfile.packages[target.packagePath].integrity = 'sha512-negative-probe-mismatch';
  const integrityErrors = validateDependencyFingerprint(integrityRegistry.exceptions[0], integrityLockfile);
  if (!integrityErrors.some((error) => error.code === ERROR_CODES.INTEGRITY_MISMATCH)) throw new Error('integrity mismatch negative probe unexpectedly passed');
  return { passed: passed + 2, total: passed + 2, guard };
}

// CLI entry — only runs when executed directly
const isCLI = process.argv[1] && (process.argv[1].endsWith('check-audit-exceptions.mjs') || process.argv[1].endsWith('check-audit-exceptions.js'));
if (isCLI) {
  const ROOT = process.cwd();
  const regPath = resolve(ROOT, 'security/audit-exceptions.json');
  const alPath = resolve(ROOT, '.audit-ci.jsonc');
  const lockPath = resolve(ROOT, 'package-lock.json');
  if (!existsSync(regPath)) { process.exit(1); }
  if (!existsSync(alPath)) { console.error(`[FAIL] ${ERROR_CODES.ALLOWLIST_MISSING}: allowlist file not found`); process.exit(1); }
  if (!existsSync(lockPath)) { console.error(`[FAIL] ${ERROR_CODES.PACKAGE_MISSING}: package-lock.json not found`); process.exit(1); }
  const registry = JSON.parse(readFileSync(regPath, 'utf8'));
  const allowlist = JSON.parse(readFileSync(alPath, 'utf8'));
  const lockfile = JSON.parse(readFileSync(lockPath, 'utf8'));
  const now = new Date().toISOString().slice(0, 10);
  let runtimeSources;
  try {
    runtimeSources = collectRuntimeSources(ROOT, registry.sourceReachabilityGuard);
  } catch (error) {
    console.error(`[FAIL] ${ERROR_CODES.REACHABILITY_GUARD_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const result = validateAuditExceptions({ registry, allowlist, lockfile, runtimeSources, now, enforceDependencyFingerprint: true, enforceSourceReachabilityGuard: true });
  if (result.errors.length > 0) { for (const e of result.errors) console.error(`[FAIL] ${e.code}: ${e.detail}`); process.exit(1); }
  try {
    const probes = runSecurityExceptionNegativeProbes(registry, lockfile);
    console.log(`[OK] negative security probes: ${probes.passed}/${probes.total}`);
  } catch (error) {
    console.error(`[FAIL] ${ERROR_CODES.REACHABILITY_GUARD_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  for (const v of result.valid) console.log(`[OK] ${v}`);
  console.log('[OK] allowlist ↔ registry consistent');
}
