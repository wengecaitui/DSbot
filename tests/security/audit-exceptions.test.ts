// PRE-4A4-R2: Deterministic security exception validation tests — 23 tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAuditExceptions, ERROR_CODES } from '../../scripts/check-audit-exceptions.mjs';

const EX = { advisoryId:'GHSA-f88m-g3jw-g9cj', package:'sharp', severity:'high', reason:'r', owner:'s', createdAt:'2026-07-25', expiresAt:'2026-08-24', maximumLifetimeDays:30, compensatingControls:[], removalCondition:'x' };
const AL = { allowlist:['GHSA-f88m-g3jw-g9cj'] };

test('1. valid passes', () => { const r=validateAuditExceptions({registry:{exceptions:[EX]},allowlist:AL,now:'2026-08-01'}); assert.equal(r.errors.length,0); assert.ok(r.valid.length>0); });
test('2. expiresAt==now fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[EX]},allowlist:AL,now:'2026-08-24'}).errors.some(e=>e.code===ERROR_CODES.EXPIRED)); });
test('3. expiresAt<now fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[EX]},allowlist:AL,now:'2026-08-25'}).errors.some(e=>e.code===ERROR_CODES.EXPIRED)); });
test('4. lifetime>30 fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,createdAt:'2026-07-25',expiresAt:'2026-08-25'}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.LIFETIME)); });
test('5. invalid createdAt fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,createdAt:'bad'}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.INVALID_DATE)); });
test('6. invalid expiresAt fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,expiresAt:'not-a-date'}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.INVALID_DATE)); });
test('7. createdAt>=expiresAt fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,createdAt:'2026-08-24',expiresAt:'2026-08-24'}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.INVALID_DATE_ORDER)); });
test('8. createdAt>expiresAt fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,createdAt:'2026-08-25',expiresAt:'2026-08-24'}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.INVALID_DATE_ORDER)); });
test('9. invalid GHSA fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,advisoryId:'not-a-ghsa'}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.INVALID_GHSA)); });
test('10. invalid CVE fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,relatedCves:['bad-cve']}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.INVALID_CVE)); });
test('11. duplicate advisoryId fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[EX,EX]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.DUPLICATE)); });
test('12. duplicate CVE fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,relatedCves:['CVE-2026-33327','CVE-2026-33327']}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.DUPLICATE_CVE)); });
test('13. wildcard advisoryId fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,advisoryId:'GHSA-*'}]},allowlist:['GHSA-*'],now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.WILDCARD)); });
test('14. maximumLifetimeDays=0 fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,maximumLifetimeDays:0}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.INVALID_LIFETIME)); });
test('15. maximumLifetimeDays=31 fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,maximumLifetimeDays:31}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.INVALID_LIFETIME)); });
test('16. allowlist missing fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[EX]},allowlist:{allowlist:[]},now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.ALLOWLIST_MISMATCH)); });
test('17. allowlist mismatch fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[EX]},allowlist:{allowlist:['GHSA-extra']},now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.ALLOWLIST_MISMATCH)); });
test('18. missing owner fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,owner:''}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.MISSING_FIELD)); });
test('19. missing reason fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,reason:''}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.MISSING_FIELD)); });
test('20. missing removalCondition fails', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[{...EX,removalCondition:''}]},allowlist:AL,now:'2026-08-01'}).errors.some(e=>e.code===ERROR_CODES.MISSING_FIELD)); });
test('21. empty exceptions passes', () => { const r=validateAuditExceptions({registry:{exceptions:[]},allowlist:AL,now:'2026-08-01'}); assert.equal(r.errors.length,1); assert.ok(r.errors[0].code===ERROR_CODES.ALLOWLIST_MISMATCH); });
test('22. empty exceptions + allowlist passes', () => { const r=validateAuditExceptions({registry:{exceptions:[]},allowlist:{allowlist:[]},now:'2026-08-01'}); assert.equal(r.errors.length,0); });
test('23. stable after 2026-08-24 (expired, fails)', () => { assert.ok(validateAuditExceptions({registry:{exceptions:[EX]},allowlist:AL,now:'2026-09-01'}).errors.some(e=>e.code===ERROR_CODES.EXPIRED)); });
