// PRE-4A4-R1: Security exception validation tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve('scripts/check-audit-exceptions.mjs');
function mkTmp() { const d = resolve(tmpdir(), `sec-test-${Math.random().toString(36).slice(2,6)}`); mkdirSync(d,{recursive:true}); mkdirSync(resolve(d,'security'),{recursive:true}); return d; }

function runCheck(tmpDir, registry, allowlist) {
  writeFileSync(resolve(tmpDir,'security/audit-exceptions.json'), JSON.stringify(registry,null,2));
  if (allowlist !== undefined) writeFileSync(resolve(tmpDir,'.audit-ci.jsonc'), JSON.stringify(allowlist,null,2));
  try { execSync(`node "${SCRIPT}"`, { cwd: tmpDir, stdio: 'pipe', timeout: 5000 }); return { exit: 0 }; }
  catch (e) { const out = e.stderr && typeof e.stderr === 'object' ? e.stderr.toString() : (e.stderr || ''); return { exit: e.status || 1, stderr: out }; }
}

const EX_TEMPLATE = { advisoryId: 'GHSA-test', package: 'pkg', relatedCves: [], severity: 'high', reason: 'reason', owner: 'sec', createdAt: '2026-07-25', expiresAt: '2026-08-24', maximumLifetimeDays: 30, compensatingControls: [], removalCondition: 'when fixed' };

test('1. valid exception passes', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [EX_TEMPLATE] }, { allowlist: ['GHSA-test'] }); rmSync(d,{recursive:true}); assert.equal(r.exit, 0);
});
test('2. expired exception fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [{...EX_TEMPLATE,expiresAt:'2020-01-01'}] }, { allowlist: ['GHSA-test'] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0); assert.ok(r.stderr.includes('SECURITY_EXCEPTION_EXPIRED'));
});
test('3. lifetime >30 fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [{...EX_TEMPLATE,expiresAt:'2026-08-26'}] }, { allowlist: ['GHSA-test'] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0); assert.ok(r.stderr.includes('SECURITY_EXCEPTION_LIFETIME_EXCEEDED'));
});
test('4. missing owner fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [{...EX_TEMPLATE,owner:''}] }, { allowlist: ['GHSA-test'] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0); assert.ok(r.stderr.includes('SECURITY_EXCEPTION_SCHEMA_INVALID'));
});
test('5. missing reason fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [{...EX_TEMPLATE,reason:''}] }, { allowlist: ['GHSA-test'] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0);
});
test('6. missing removalCondition fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [{...EX_TEMPLATE,removalCondition:''}] }, { allowlist: ['GHSA-test'] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0);
});
test('7. duplicate advisoryId fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [EX_TEMPLATE, {...EX_TEMPLATE}] }, { allowlist: ['GHSA-test'] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0); assert.ok(r.stderr.includes('SECURITY_EXCEPTION_DUPLICATE'));
});
test('8. wildcard package fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [{...EX_TEMPLATE,package:'*'}] }, { allowlist: ['GHSA-test'] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0); assert.ok(r.stderr.includes('SECURITY_EXCEPTION_WILDCARD_FORBIDDEN'));
});
test('9. invalid date fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [{...EX_TEMPLATE,expiresAt:'not-a-date'}] }, { allowlist: ['GHSA-test'] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0);
});
test('10. allowlist mismatch fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [EX_TEMPLATE] }, { allowlist: ['GHSA-extra'] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0); assert.ok(r.stderr.includes('SECURITY_EXCEPTION_ALLOWLIST_MISMATCH'));
});
test('11. empty list passes', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [] }, { allowlist: [] }); rmSync(d,{recursive:true}); assert.equal(r.exit, 0);
});
test('12. registry entry not in allowlist fails', () => {
  const d = mkTmp(); const r = runCheck(d, { exceptions: [EX_TEMPLATE] }, { allowlist: [] }); rmSync(d,{recursive:true}); assert.ok(r.exit !== 0); assert.ok(r.stderr.includes('SECURITY_EXCEPTION_ALLOWLIST_MISMATCH'));
});
