#!/usr/bin/env node
// check-audit-exceptions.mjs — validates exception registry against schema + expiry + allowlist consistency.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use cwd for testability; fall back to script dir
const ROOT = process.env.AUDIT_EXCEPTIONS_ROOT || process.cwd();
const REGISTRY_PATH = resolve(ROOT, 'security/audit-exceptions.json');
const ALLOWLIST_PATH = resolve(ROOT, '.audit-ci.jsonc');

const ERROR = {
  SCHEMA_INVALID: 'SECURITY_EXCEPTION_SCHEMA_INVALID',
  DUPLICATE: 'SECURITY_EXCEPTION_DUPLICATE',
  WILDCARD: 'SECURITY_EXCEPTION_WILDCARD_FORBIDDEN',
  EXPIRED: 'SECURITY_EXCEPTION_EXPIRED',
  LIFETIME: 'SECURITY_EXCEPTION_LIFETIME_EXCEEDED',
  ALLOWLIST_MISMATCH: 'SECURITY_EXCEPTION_ALLOWLIST_MISMATCH',
};

function fail(code, detail) { console.error(`[FAIL] ${code}: ${detail}`); process.exitCode = 1; }
function ok(msg) { console.log(`[OK] ${msg}`); }

// 1. Load + schema
if (!existsSync(REGISTRY_PATH)) { fail(ERROR.SCHEMA_INVALID, `registry not found: ${REGISTRY_PATH}`); process.exit(1); }
let registry;
try { registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')); } catch (e) { fail(ERROR.SCHEMA_INVALID, `invalid JSON: ${e.message}`); process.exit(1); }
if (!registry.exceptions || !Array.isArray(registry.exceptions)) { fail(ERROR.SCHEMA_INVALID, 'missing or invalid "exceptions" array'); process.exit(1); }
ok('schema valid');

// 2. Validate each exception
const now = new Date();
const seen = new Set();
for (const ex of registry.exceptions) {
  const fields = ['advisoryId','package','reason','owner','createdAt','expiresAt','removalCondition'];
  for (const f of fields) { if (!ex[f]) { fail(ERROR.SCHEMA_INVALID, `missing field "${f}" in ${ex.advisoryId || '<unknown>'}`); } }
  // Wildcard check
  if (ex.package === '*') { fail(ERROR.WILDCARD, `wildcard package forbidden: ${ex.advisoryId}`); }
  if (ex.advisoryId === '*' || ex.advisoryId.includes('*')) { fail(ERROR.WILDCARD, `wildcard advisoryId forbidden: ${ex.advisoryId}`); }
  // Duplicate check
  if (seen.has(ex.advisoryId)) { fail(ERROR.DUPLICATE, `duplicate advisoryId: ${ex.advisoryId}`); }
  seen.add(ex.advisoryId);
  // Expiry
  const expires = new Date(ex.expiresAt);
  if (isNaN(expires.getTime())) { fail(ERROR.SCHEMA_INVALID, `invalid expiresAt: ${ex.expiresAt} for ${ex.advisoryId}`); }
  else if (expires <= now) { fail(ERROR.EXPIRED, `${ex.advisoryId} expired ${ex.expiresAt} (now=${now.toISOString().slice(0,10)})`); }
  // Lifetime check
  const createdAt = new Date(ex.createdAt);
  const diffDays = Math.ceil((expires - createdAt) / 86400000);
  if (diffDays > 30) { fail(ERROR.LIFETIME, `${ex.advisoryId} lifetime ${diffDays}d exceeds 30d max`); }
  ok(`${ex.advisoryId}: expires ${ex.expiresAt} (${diffDays}d), valid`);
}

// 3. Allowlist consistency
if (existsSync(ALLOWLIST_PATH)) {
  try {
    const raw = readFileSync(ALLOWLIST_PATH, 'utf8');
    const allowlist = JSON.parse(raw);
    const allowed = allowlist.allowlist || [];
    const registryIds = new Set(registry.exceptions.map(e => e.advisoryId));
    for (const a of allowed) {
      if (typeof a === 'string' && !registryIds.has(a)) { fail(ERROR.ALLOWLIST_MISMATCH, `allowlist entry "${a}" not in registry`); }
    }
    for (const id of registryIds) {
      if (!allowed.some(a => a === id)) { fail(ERROR.ALLOWLIST_MISMATCH, `registry entry "${id}" not in allowlist`); }
    }
    ok('allowlist ↔ registry consistent');
  } catch (e) { fail(ERROR.SCHEMA_INVALID, `cannot parse allowlist: ${e.message}`); }
} else { ok('no allowlist file — skipping consistency check'); }

if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
process.exit(0);
