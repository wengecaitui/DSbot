// PRE-4A4-R2: Deterministic security exception validation — pure function, injectable clock.

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
});

const REQUIRED_FIELDS = ['advisoryId', 'package', 'severity', 'reason', 'owner', 'createdAt', 'expiresAt', 'maximumLifetimeDays', 'compensatingControls', 'removalCondition'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GHSA_RE = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const CVE_RE = /^CVE-\d{4}-\d+$/;
const DEPENDENCY_TYPES = ['dependencies', 'optionalDependencies'];

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
    && Array.isArray(target.consumers)
    && target.consumers.every((consumer) =>
      consumer
      && typeof consumer.path === 'string' && consumer.path.startsWith('node_modules/')
      && typeof consumer.version === 'string' && consumer.version.length > 0
      && DEPENDENCY_TYPES.includes(consumer.dependencyType)
      && typeof consumer.dependencySpecifier === 'string' && consumer.dependencySpecifier.length > 0));
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
  const { registry, allowlist, now, lockfile } = input;
  const enforceDependencyFingerprint = input.enforceDependencyFingerprint === true || Boolean(lockfile);
  if (!registry || !Array.isArray(registry.exceptions)) { errors.push({ code: ERROR_CODES.SCHEMA_INVALID, detail: 'missing or invalid exceptions array' }); return { errors, valid }; }
  if (typeof now !== 'string' || !isValidDate(now)) { errors.push({ code: ERROR_CODES.INVALID_DATE, detail: `invalid now date: ${now}` }); return { errors, valid }; }
  const nowDate = new Date(now + 'T00:00:00Z');
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

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
  const result = validateAuditExceptions({ registry, allowlist, lockfile, now, enforceDependencyFingerprint: true });
  if (result.errors.length > 0) { for (const e of result.errors) console.error(`[FAIL] ${e.code}: ${e.detail}`); process.exit(1); }
  for (const v of result.valid) console.log(`[OK] ${v}`);
  console.log('[OK] allowlist ↔ registry consistent');
}
