// PRE-4A4-R2: Deterministic security exception validation — pure function, injectable clock.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

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
  UNEXPECTED_ANCHOR_IMPORTER: 'SECURITY_EXCEPTION_UNEXPECTED_ANCHOR_IMPORTER',
  ANCHOR_IMPORTER_MISSING: 'SECURITY_EXCEPTION_ANCHOR_IMPORTER_MISSING',
  ANCHOR_SOURCE_DRIFT: 'SECURITY_EXCEPTION_ANCHOR_SOURCE_DRIFT',
  ANCHOR_WORKSPACE_REACHABLE: 'SECURITY_EXCEPTION_ANCHOR_WORKSPACE_REACHABLE',
});

const REQUIRED_FIELDS = ['advisoryId', 'package', 'severity', 'reason', 'owner', 'createdAt', 'expiresAt', 'maximumLifetimeDays', 'compensatingControls', 'removalCondition'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GHSA_RE = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const CVE_RE = /^CVE-\d{4}-\d+$/;
const DEPENDENCY_TYPES = ['dependencies', 'optionalDependencies'];
const REQUIRED_RUNTIME_SOURCE_ROOTS = ['src', 'web/src'];
const REQUIRED_RUNTIME_SOURCE_EXTENSIONS = ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'];
const REQUIRED_EXCLUDED_DIRECTORY_NAMES = ['__fixtures__', '__generated__', '__tests__', 'build', 'dist', 'docs', 'fixtures', 'generated', 'node_modules', 'test', 'tests'];
const SOURCE_RULE_KINDS = ['moduleImport'];
const SOURCE_GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
const REQUIRED_ANCHOR_MODULES = ['@coral-xyz/anchor', '@project-serum/anchor'];
const REQUIRED_SOURCE_RULES = [
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

function anchorSourceFingerprintShapeIsValid(fingerprint, guard) {
  if (!fingerprint
    || !exactStringSet(fingerprint.modules, REQUIRED_ANCHOR_MODULES)
    || !Array.isArray(fingerprint.auditedImporters)
    || fingerprint.auditedImporters.length === 0) return false;
  const paths = fingerprint.auditedImporters.map((entry) => entry?.path);
  return new Set(paths).size === paths.length
    && fingerprint.auditedImporters.every((entry) =>
      entry
      && typeof entry.path === 'string'
      && entry.path === normalizeRepositoryPath(entry.path)
      && isRuntimeSourcePath(entry.path, guard)
      && typeof entry.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(entry.sha256));
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

function sha256Source(source) {
  // Git stores these text sources with LF; canonicalize Windows checkout endings
  // so the same audited source has one fingerprint on local and GitHub runners.
  return createHash('sha256').update(source.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

function anchorModuleForSpecifier(specifier) {
  return REQUIRED_ANCHOR_MODULES.find((moduleName) =>
    specifier === moduleName || specifier.startsWith(`${moduleName}/`)) ?? null;
}

function literalModuleSpecifier(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function inspectAnchorImports(source) {
  const sourceFile = ts.createSourceFile('runtime-source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = [];
  let workspaceReachable = false;

  const record = (specifier, namedBindings) => {
    const moduleName = anchorModuleForSpecifier(specifier);
    if (!moduleName) return;
    imports.push({ moduleName, specifier });
    const suffix = specifier.slice(moduleName.length);
    if (/(?:^|\/)workspace(?:\/|\.|$)/i.test(suffix)) workspaceReachable = true;
    if (
      namedBindings &&
      (ts.isNamedImports(namedBindings) || ts.isNamedExports(namedBindings))
    ) {
      for (const element of namedBindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'workspace') workspaceReachable = true;
      }
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalModuleSpecifier(node.moduleSpecifier);
      if (specifier) record(specifier, node.importClause?.namedBindings);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalModuleSpecifier(node.moduleSpecifier);
      if (specifier) {
        record(specifier, node.exportClause);
        // Re-exporting the full Anchor namespace/object invalidates the audited boundary.
        if (
          anchorModuleForSpecifier(specifier) &&
          (!node.exportClause || ts.isNamespaceExport(node.exportClause))
        ) workspaceReachable = true;
      }
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression) {
      const specifier = literalModuleSpecifier(node.moduleReference.expression);
      if (specifier) record(specifier);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const specifier = literalModuleSpecifier(node.arguments[0]);
        if (specifier) record(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { imports, workspaceReachable };
}

function ruleMatchesSource(rule, source) {
  const moduleName = escapeRegExp(rule.value);
  const moduleSpecifier = `${moduleName}(?:/[^'"\\x60\\s)]+)?`;
  return new RegExp(`(?:\\bfrom${SOURCE_GAP}|\\bimport${SOURCE_GAP}(?:\\(${SOURCE_GAP})?|\\brequire${SOURCE_GAP}(?:\\?\\.${SOURCE_GAP})?\\(${SOURCE_GAP})['"\\x60]${moduleSpecifier}['"\\x60]`, 'm').test(source);
}

export function validateSourceReachabilityGuard(registry, runtimeSources) {
  const guard = registry?.sourceReachabilityGuard;
  if (!sourceReachabilityGuardShapeIsValid(guard)) {
    return [{ code: ERROR_CODES.REACHABILITY_GUARD_FAILED, detail: 'sourceReachabilityGuard is missing, malformed, or has a narrowed scan boundary' }];
  }
  const anchorFingerprint = registry?.anchorSourceFingerprint;
  if (!anchorSourceFingerprintShapeIsValid(anchorFingerprint, guard)) {
    return [{ code: ERROR_CODES.ANCHOR_SOURCE_DRIFT, detail: 'anchorSourceFingerprint is missing, malformed, narrowed, or outside the audited runtime boundary' }];
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

  const expectedImporters = new Map(anchorFingerprint.auditedImporters.map((entry) => [entry.path, entry.sha256]));
  const currentImporters = new Map();
  for (const source of sources) {
    const path = normalizeRepositoryPath(source.path);
    const inspection = inspectAnchorImports(source.content);
    if (inspection.imports.length === 0) continue;
    currentImporters.set(path, source);
    if (inspection.workspaceReachable) {
      errors.push({ code: ERROR_CODES.ANCHOR_WORKSPACE_REACHABLE, detail: `${path} directly reaches or re-exports Anchor workspace` });
    }
    if (!expectedImporters.has(path)) {
      errors.push({ code: ERROR_CODES.UNEXPECTED_ANCHOR_IMPORTER, detail: `${path} is not an audited Anchor importer` });
    }
  }
  for (const [path, expectedSha256] of expectedImporters) {
    const source = currentImporters.get(path);
    if (!source) {
      errors.push({ code: ERROR_CODES.ANCHOR_IMPORTER_MISSING, detail: `${path} is missing from the current Anchor importer set` });
    } else if (sha256Source(source.content) !== expectedSha256) {
      errors.push({ code: ERROR_CODES.ANCHOR_SOURCE_DRIFT, detail: `${path} source SHA-256 differs from the audited fingerprint` });
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

export function runSecurityExceptionNegativeProbes(registry, lockfile, runtimeSources) {
  const guard = registry.sourceReachabilityGuard;
  if (!Array.isArray(runtimeSources) || runtimeSources.length === 0) throw new Error('negative probes require the complete runtime source inventory');
  let passed = 0;
  const expectCode = (label, errors, code) => {
    if (!errors.some((error) => error.code === code)) throw new Error(`negative probe unexpectedly passed: ${label}`);
    passed += 1;
  };
  const expectPass = (label, probeRegistry, sources) => {
    const errors = validateSourceReachabilityGuard(probeRegistry, sources);
    if (errors.length > 0) throw new Error(`positive probe unexpectedly failed: ${label}: ${JSON.stringify(errors)}`);
    passed += 1;
  };

  expectPass('current audited Anchor importer set', registry, runtimeSources);
  expectPass('LF checkout Anchor importer fingerprints', registry, runtimeSources.map((source) => ({
    ...source,
    content: source.content.replaceAll('\r\n', '\n'),
  })));
  for (const [label, content] of [
    ['generic config.workspace', 'export const value = config.workspace;'],
    ['generic CSS .workspace', 'export const css = `.workspace { display: grid; }`;'],
    ['generic workspace type field', 'export interface Config { workspace: string }'],
  ]) {
    expectPass(label, registry, [...runtimeSources, { path: `src/security-${label.replaceAll(' ', '-')}.ts`, content }]);
  }

  for (const moduleName of REQUIRED_ANCHOR_MODULES) {
    const moduleLabel = moduleName.includes('coral') ? 'coral' : 'serum';
    for (const [form, content] of [
      ['side-effect', `import '${moduleName}';`],
      ['namespace', `import * as a from '${moduleName}'; a.Wallet;`],
      ['default', `import a from '${moduleName}'; a.Wallet;`],
      ['named', `import { BN } from '${moduleName}';`],
      ['require', `const a = require('${moduleName}'); a.Wallet;`],
      ['dynamic', `const a = await import('${moduleName}'); a.Wallet;`],
    ]) {
      const sources = [...runtimeSources, { path: `src/unexpected-${moduleLabel}-${form}.ts`, content }];
      expectCode(`new ${moduleName} ${form} importer`, validateSourceReachabilityGuard(registry, sources), ERROR_CODES.UNEXPECTED_ANCHOR_IMPORTER);
    }
  }

  const auditedPath = registry.anchorSourceFingerprint.auditedImporters[0].path;
  const mutateAudited = (suffix) => runtimeSources.map((source) =>
    normalizeRepositoryPath(source.path) === auditedPath ? { ...source, content: `${source.content}\n${suffix}\n` } : source);
  expectCode('audited importer workspace member drift', validateSourceReachabilityGuard(registry, mutateAudited('a.workspace.Program;')), ERROR_CODES.ANCHOR_SOURCE_DRIFT);
  expectCode('audited importer workspace destructuring drift', validateSourceReachabilityGuard(registry, mutateAudited('const { workspace: ws } = a;')), ERROR_CODES.ANCHOR_SOURCE_DRIFT);
  expectCode('audited importer unrelated source drift', validateSourceReachabilityGuard(registry, mutateAudited('// requires renewed source audit')), ERROR_CODES.ANCHOR_SOURCE_DRIFT);
  expectCode('missing audited importer', validateSourceReachabilityGuard(registry, runtimeSources.filter((source) => normalizeRepositoryPath(source.path) !== auditedPath)), ERROR_CODES.ANCHOR_IMPORTER_MISSING);

  for (const moduleName of REQUIRED_ANCHOR_MODULES) {
    const sources = [...runtimeSources, { path: `src/workspace-${moduleName.includes('coral') ? 'coral' : 'serum'}.ts`, content: `import ws from '${moduleName}/dist/cjs/workspace.js';` }];
    expectCode(`${moduleName} workspace submodule`, validateSourceReachabilityGuard(registry, sources), ERROR_CODES.ANCHOR_WORKSPACE_REACHABLE);
    const namedSources = [...runtimeSources, { path: `src/named-${moduleName.includes('coral') ? 'coral' : 'serum'}.ts`, content: `import { workspace as ws } from '${moduleName}';` }];
    expectCode(`${moduleName} named workspace import`, validateSourceReachabilityGuard(registry, namedSources), ERROR_CODES.ANCHOR_WORKSPACE_REACHABLE);
    const namespaceExportSources = [...runtimeSources, { path: `src/export-${moduleName.includes('coral') ? 'coral' : 'serum'}.ts`, content: `export * as anchor from '${moduleName}';` }];
    expectCode(`${moduleName} namespace re-export`, validateSourceReachabilityGuard(registry, namespaceExportSources), ERROR_CODES.ANCHOR_WORKSPACE_REACHABLE);
  }

  for (const [label, content] of [
    ['direct toml import', "import toml from 'toml';"],
    ['direct rustbin import', "const rustbin = require('@metaplex-foundation/rustbin');"],
    ['direct jayson import', "import jayson from 'jayson';"],
    ['direct stream-json import', "import { pick } from 'stream-json/filters/Pick';"],
  ]) {
    expectCode(label, validateSourceReachabilityGuard(registry, [...runtimeSources, { path: `src/${label.replaceAll(' ', '-')}.ts`, content }]), ERROR_CODES.REACHABILITY_GUARD_FAILED);
  }

  const narrowed = clone(registry);
  narrowed.anchorSourceFingerprint.auditedImporters.pop();
  expectCode('narrowed Anchor fingerprint', validateSourceReachabilityGuard(narrowed, runtimeSources), ERROR_CODES.UNEXPECTED_ANCHOR_IMPORTER);
  const removed = clone(registry);
  delete removed.anchorSourceFingerprint;
  expectCode('removed Anchor fingerprint', validateSourceReachabilityGuard(removed, runtimeSources), ERROR_CODES.ANCHOR_SOURCE_DRIFT);

  const excludedErrors = validateSourceReachabilityGuard(registry, [
    ...runtimeSources,
    { path: 'docs/security.md', content: "import toml from 'toml'; import { workspace } from '@coral-xyz/anchor';" },
    { path: 'tests/security/reachability.test.ts', content: "import jayson from 'jayson';" },
    { path: 'src/__tests__/fixture.ts', content: "import { pick } from 'stream-json/filters/Pick';" },
  ]);
  if (excludedErrors.length > 0) throw new Error('excluded docs/tests negative probe produced a false positive');
  passed += 1;

  const fingerprintMutations = [
    ['integrity mismatch', ERROR_CODES.INTEGRITY_MISMATCH, (registryCopy, lockfileCopy) => {
      const target = registryCopy.exceptions[0].dependencyFingerprint.topology[0];
      lockfileCopy.packages[target.packagePath].integrity = 'sha512-negative-probe-mismatch';
    }],
    ['version mismatch', ERROR_CODES.VERSION_MISMATCH, (registryCopy, lockfileCopy) => {
      const target = registryCopy.exceptions[0].dependencyFingerprint.topology[0];
      lockfileCopy.packages[target.packagePath].version = '0.0.0-negative-probe';
    }],
    ['unexpected dependency consumer', ERROR_CODES.UNEXPECTED_CONSUMER, (_registryCopy, lockfileCopy) => {
      lockfileCopy.packages['node_modules/security-negative-probe'] = { version: '1.0.0', dependencies: { 'stream-json': '^1.9.1' } };
    }],
  ];
  for (const [label, code, mutate] of fingerprintMutations) {
    const registryCopy = clone(registry);
    const lockfileCopy = clone(lockfile);
    mutate(registryCopy, lockfileCopy);
    expectCode(label, validateDependencyFingerprint(registryCopy.exceptions[0], lockfileCopy), code);
  }

  for (const [label, mutate, code] of [
    ['expiry', (registryCopy) => { registryCopy.exceptions[0].expiresAt = '2026-09-05'; }, ERROR_CODES.EXPIRED],
    ['wildcard', (registryCopy) => { registryCopy.exceptions[0].advisoryId = '*'; }, ERROR_CODES.WILDCARD],
  ]) {
    const registryCopy = clone(registry);
    mutate(registryCopy);
    const result = validateAuditExceptions({ registry: registryCopy, allowlist: { allowlist: registry.exceptions.map((entry) => entry.advisoryId) }, now: '2026-09-05' });
    expectCode(label, result.errors, code);
  }
  const unauthorized = validateAuditExceptions({ registry, allowlist: { allowlist: [...registry.exceptions.map((entry) => entry.advisoryId), 'GHSA-aaaa-bbbb-cccc'] }, now: '2026-09-05' });
  expectCode('unauthorized GHSA allowlist entry', unauthorized.errors, ERROR_CODES.ALLOWLIST_MISMATCH);

  return { passed, total: passed, guard, anchorSourceFingerprint: registry.anchorSourceFingerprint };
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
    const probes = runSecurityExceptionNegativeProbes(registry, lockfile, runtimeSources);
    console.log(`[OK] negative security probes: ${probes.passed}/${probes.total}`);
  } catch (error) {
    console.error(`[FAIL] ${ERROR_CODES.REACHABILITY_GUARD_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  for (const v of result.valid) console.log(`[OK] ${v}`);
  console.log('[OK] allowlist ↔ registry consistent');
}
