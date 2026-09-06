import { createHash } from 'node:crypto';
import {
  assertResearchStorageInterchange,
  type ResearchStorageInterchange,
} from './ResearchStorageContract';

function identityViolation(reason: string): never {
  throw new Error(`PHASE_9D_RESEARCH_STORAGE_INVALID:${reason}`);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0)!;
    const rightPoint = rightPoints[index].codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) identityViolation('NON_CANONICAL_JSON');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      identityViolation('NON_CANONICAL_JSON');
    }
  }
}

/** Match Python json.dumps() float spelling for the normalized canonical FLOAT64 value. */
function pythonFloatLiteral(value: number): string {
  if (!Number.isFinite(value)) identityViolation('NON_CANONICAL_JSON');
  if (Object.is(value, -0)) return '-0.0';
  if (value === 0) return '0.0';
  const absolute = Math.abs(value);
  if (absolute >= 1e-4 && absolute < 1e16) {
    const fixed = value.toString();
    return fixed.includes('.') ? fixed : `${fixed}.0`;
  }
  return value.toExponential().replace(/e([+-])(\d)$/, 'e$10$2');
}

function canonicalPythonJson(
  value: unknown,
  floatPresences: ReadonlySet<object>,
  forceFloat = false,
): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (forceFloat) return pythonFloatLiteral(value);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) identityViolation('NON_CANONICAL_JSON');
    return /[.eE]/.test(encoded) ? pythonFloatLiteral(value) : encoded;
  }
  if (typeof value === 'string') {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalPythonJson(item, floatPresences)).join(',')}]`;
  }
  if (typeof value !== 'object' || value === undefined) identityViolation('NON_CANONICAL_JSON');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodePoints);
  return `{${keys.map((key) => {
    assertUnicodeScalarString(key);
    const encodedKey = JSON.stringify(key);
    const encodedValue = canonicalPythonJson(
      record[key],
      floatPresences,
      floatPresences.has(record) && key === 'value',
    );
    return `${encodedKey}:${encodedValue}`;
  }).join(',')}}`;
}

/**
 * Phase 9D's pure exact-identity capability. It mirrors the durable Python
 * normalize_research_storage_identity + canonical_json_bytes SHA-256 preimage.
 */
export function deriveResearchStorageBundleId(value: unknown): string {
  assertResearchStorageInterchange(value);
  const interchange: ResearchStorageInterchange = value;
  const floatPresences = new Set<object>();
  for (const record of interchange.canonicalDataset.records) {
    for (const field of record.fields) {
      if (field.logicalType === 'FLOAT64' && field.presence.state === 'VALUE') {
        floatPresences.add(field.presence);
      }
    }
  }
  const canonical = canonicalPythonJson(interchange, floatPresences);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
