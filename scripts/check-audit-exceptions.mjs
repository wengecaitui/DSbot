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
});

const REQUIRED_FIELDS = ['advisoryId', 'package', 'reason', 'owner', 'createdAt', 'expiresAt', 'removalCondition'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GHSA_RE = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const CVE_RE = /^CVE-\d{4}-\d+$/;

function isValidDate(s) { if (!DATE_RE.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }

export function validateAuditExceptions(input) {
  const errors = [];
  const valid = [];
  const { registry, allowlist, now } = input;
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
  if (!existsSync(regPath)) { process.exit(1); }
  if (!existsSync(alPath)) { console.error(`[FAIL] ${ERROR_CODES.ALLOWLIST_MISSING}: allowlist file not found`); process.exit(1); }
  const registry = JSON.parse(readFileSync(regPath, 'utf8'));
  const allowlist = JSON.parse(readFileSync(alPath, 'utf8'));
  const now = new Date().toISOString().slice(0, 10);
  const result = validateAuditExceptions({ registry, allowlist, now });
  if (result.errors.length > 0) { for (const e of result.errors) console.error(`[FAIL] ${e.code}: ${e.detail}`); process.exit(1); }
  for (const v of result.valid) console.log(`[OK] ${v}`);
  console.log('[OK] allowlist ↔ registry consistent');
}
