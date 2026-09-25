/**
 * Pure, bounded Gate JSON identity recovery. JSON.parse source tokens are authoritative;
 * rounded JavaScript numbers are never used to reconstruct exchange identifiers.
 */
export const MAX_GATEIO_EXACT_JSON_BYTES = 1_048_576 as const;
const MAX_SIGNED_INT64 = '9223372036854775807';
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export interface GateIoExactInt64Spec {
  readonly shape: 'object' | 'array';
  readonly fields: readonly string[];
  /** Numeric lexical facts recovered with the same per-element attribution as identifiers. */
  readonly decimalFields?: readonly string[];
  /** API-rejection objects may have no order id; present fields are still exact. */
  readonly required?: boolean;
}

const DECIMAL_SOURCES = new WeakMap<object, ReadonlyMap<string, string>>();

export function gateIoExactDecimalSource(entry: object, field: string): string | null {
  return DECIMAL_SOURCES.get(entry)?.get(field) ?? null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactIdentifier(value: unknown, source: string | undefined): string {
  const token = typeof value === 'number' ? source : value;
  if (typeof token !== 'string' || !POSITIVE_INTEGER.test(token)
      || token.length > MAX_SIGNED_INT64.length
      || (token.length === MAX_SIGNED_INT64.length && token > MAX_SIGNED_INT64)) {
    throw new Error('GATEIO_EXACT_INT64_INVALID');
  }
  return token;
}

/**
 * JSON.parse silently keeps the last duplicate object key. This narrow lexical check counts
 * only specified top-level keys, never treats quoted text or nested objects as identities.
 */
function unambiguousFields(raw: string, spec: GateIoExactInt64Spec): boolean {
  const stack: ('array' | 'object')[] = [];
  const allFields = [...spec.fields, ...(spec.decimalFields ?? [])];
  const wanted = new Set(allFields);
  // Decimal source capture is optional at L0: malformed/missing factual trade time is
  // rejected by L1A, while exact-int64-only transport fixtures retain their old contract.
  const required = new Set(spec.required === false ? [] : spec.fields);
  const objectDepth = spec.shape === 'object' ? 1 : 2;
  let counts: Map<string, number> | null = null;
  let objects = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      const start = index;
      index += 1;
      for (; index < raw.length; index += 1) {
        if (raw[index] === '\\') { index += 1; continue; }
        if (raw[index] === '"') break;
      }
      if (stack.length === objectDepth && stack[objectDepth - 1] === 'object') {
        let after = index + 1;
        while (after < raw.length && /\s/.test(raw[after]!)) after += 1;
        if (raw[after] === ':') {
          const key = JSON.parse(raw.slice(start, index + 1)) as string;
          if (wanted.has(key)) {
            if (counts === null) return false;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
      continue;
    }
    if (char === '[') stack.push('array');
    else if (char === '{') {
      if (stack.length === objectDepth - 1
          && (spec.shape === 'object' || stack[0] === 'array')) {
        counts = new Map(allFields.map((field) => [field, 0]));
        objects += 1;
      }
      stack.push('object');
    } else if (char === '}') {
      if (stack.length === objectDepth && stack[objectDepth - 1] === 'object') {
        if (counts === null || allFields.some((field) =>
          required.has(field) ? counts?.get(field) !== 1 : (counts?.get(field) ?? 0) > 1))
          return false;
        counts = null;
      }
      stack.pop();
    } else if (char === ']') stack.pop();
  }
  return stack.length === 0 && counts === null
    && (spec.shape === 'array' || objects === 1);
}

export function parseGateIoExactInt64Json(raw: string, spec: GateIoExactInt64Spec): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_GATEIO_EXACT_JSON_BYTES
      || !spec || (spec.shape !== 'object' && spec.shape !== 'array')
      || !Array.isArray(spec.fields) || spec.fields.length === 0
      || new Set(spec.fields).size !== spec.fields.length
      || spec.fields.some((field) => typeof field !== 'string' || field.length === 0)
      || (spec.decimalFields !== undefined && (!Array.isArray(spec.decimalFields)
        || spec.decimalFields.some((field) => typeof field !== 'string' || field.length === 0)))
      || new Set([...spec.fields, ...(spec.decimalFields ?? [])]).size
        !== spec.fields.length + (spec.decimalFields?.length ?? 0)) {
    throw new Error('GATEIO_EXACT_INT64_INVALID');
  }
  const wanted = new Set([...spec.fields, ...(spec.decimalFields ?? [])]);
  const evidence = new WeakMap<object, Map<string, string | undefined>>();
  const parsed: unknown = JSON.parse(raw, function (this: unknown, key: string, value: unknown,
    context?: { readonly source?: string }) {
    if (wanted.has(key) && record(this)) {
      const fields = evidence.get(this) ?? new Map<string, string | undefined>();
      fields.set(key, context?.source);
      evidence.set(this, fields);
    }
    return value;
  });
  if ((spec.shape === 'object' && !record(parsed))
      || (spec.shape === 'array' && !Array.isArray(parsed))
      || !unambiguousFields(raw, spec)) throw new Error('GATEIO_EXACT_INT64_INVALID');
  const recover = (entry: unknown): unknown => {
    if (!record(entry)) throw new Error('GATEIO_EXACT_INT64_INVALID');
    const fields = evidence.get(entry);
    const recovered = { ...entry };
    for (const field of spec.fields) {
      if (spec.required === false && !Object.prototype.hasOwnProperty.call(entry, field)) continue;
      recovered[field] = exactIdentifier(entry[field], fields?.get(field));
    }
    const decimalSources = new Map<string, string>();
    for (const field of spec.decimalFields ?? []) {
      if (typeof entry[field] === 'number') {
        const source = fields?.get(field);
        if (typeof source !== 'string') throw new Error('GATEIO_EXACT_DECIMAL_INVALID');
        decimalSources.set(field, source);
      }
    }
    if (decimalSources.size > 0) DECIMAL_SOURCES.set(recovered, decimalSources);
    return recovered;
  };
  return Array.isArray(parsed) ? parsed.map(recover) : recover(parsed);
}
