import { assertPlainInertData } from '../dictionary/ResearchDictionaryValidation';

export const RESEARCH_INERT_PAYLOAD_CODEC_VERSION = 'RESEARCH_INERT_PAYLOAD_V1' as const;

export type InertPayloadNode =
  | { readonly tag: 'NULL' }
  | { readonly tag: 'UNDEFINED' }
  | { readonly tag: 'BOOLEAN'; readonly value: boolean }
  | { readonly tag: 'STRING'; readonly value: string }
  | { readonly tag: 'NUMBER'; readonly value: number }
  | { readonly tag: 'NEGATIVE_ZERO' }
  | { readonly tag: 'NAN' }
  | { readonly tag: 'POSITIVE_INFINITY' }
  | { readonly tag: 'NEGATIVE_INFINITY' }
  | { readonly tag: 'BIGINT'; readonly value: string }
  | { readonly tag: 'ARRAY'; readonly items: readonly InertPayloadNode[] }
  | { readonly tag: 'OBJECT'; readonly entries: readonly (readonly [string, InertPayloadNode])[] };

function codecViolation(reason: string): never {
  throw new Error(`PHASE_9D_INERT_PAYLOAD_INVALID:${reason}`);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function encodeValidated(value: unknown): InertPayloadNode {
  if (value === null) return { tag: 'NULL' };
  if (value === undefined) return { tag: 'UNDEFINED' };
  if (typeof value === 'boolean') return { tag: 'BOOLEAN', value };
  if (typeof value === 'string') return { tag: 'STRING', value };
  if (typeof value === 'bigint') return { tag: 'BIGINT', value: value.toString(10) };
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return { tag: 'NEGATIVE_ZERO' };
    if (Number.isNaN(value)) return { tag: 'NAN' };
    if (value === Infinity) return { tag: 'POSITIVE_INFINITY' };
    if (value === -Infinity) return { tag: 'NEGATIVE_INFINITY' };
    return { tag: 'NUMBER', value };
  }
  if (Array.isArray(value)) {
    return { tag: 'ARRAY', items: value.map(encodeValidated) };
  }
  if (typeof value !== 'object') codecViolation('UNSUPPORTED_VALUE');
  const record = value as Record<string, unknown>;
  const entries = Object.getOwnPropertyNames(record)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((key) => [key, encodeValidated(record[key])] as const);
  return { tag: 'OBJECT', entries };
}

/** Descriptor validation runs before all property reads, so accessors never execute. */
export function encodeInertPayload(value: unknown): InertPayloadNode {
  assertPlainInertData(value, 'RESEARCH_INERT_PAYLOAD');
  return deepFreeze(encodeValidated(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], reason: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    codecViolation(`${reason}_FIELDS`);
  }
}

function decodeNode(value: unknown, path: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) codecViolation(`${path}_NODE`);
  const node = value as Record<string, unknown>;
  if (typeof node.tag !== 'string') codecViolation(`${path}_TAG`);
  switch (node.tag) {
    case 'NULL': exactKeys(node, ['tag'], path); return null;
    case 'UNDEFINED': exactKeys(node, ['tag'], path); return undefined;
    case 'BOOLEAN':
      exactKeys(node, ['tag', 'value'], path);
      if (typeof node.value !== 'boolean') codecViolation(`${path}_BOOLEAN`);
      return node.value;
    case 'STRING':
      exactKeys(node, ['tag', 'value'], path);
      if (typeof node.value !== 'string') codecViolation(`${path}_STRING`);
      return node.value;
    case 'NUMBER':
      exactKeys(node, ['tag', 'value'], path);
      if (typeof node.value !== 'number' || !Number.isFinite(node.value) || Object.is(node.value, -0)) {
        codecViolation(`${path}_NUMBER`);
      }
      return node.value;
    case 'NEGATIVE_ZERO': exactKeys(node, ['tag'], path); return -0;
    case 'NAN': exactKeys(node, ['tag'], path); return Number.NaN;
    case 'POSITIVE_INFINITY': exactKeys(node, ['tag'], path); return Infinity;
    case 'NEGATIVE_INFINITY': exactKeys(node, ['tag'], path); return -Infinity;
    case 'BIGINT':
      exactKeys(node, ['tag', 'value'], path);
      if (typeof node.value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(node.value)) codecViolation(`${path}_BIGINT`);
      return BigInt(node.value);
    case 'ARRAY': {
      exactKeys(node, ['tag', 'items'], path);
      if (!Array.isArray(node.items)) codecViolation(`${path}_ARRAY`);
      return node.items.map((item, index) => decodeNode(item, `${path}_${index}`));
    }
    case 'OBJECT': {
      exactKeys(node, ['tag', 'entries'], path);
      if (!Array.isArray(node.entries)) codecViolation(`${path}_OBJECT`);
      const result: Record<string, unknown> = Object.create(null);
      let previous: string | undefined;
      for (let index = 0; index < node.entries.length; index += 1) {
        const entry = node.entries[index];
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
          codecViolation(`${path}_ENTRY_${index}`);
        }
        if (previous !== undefined && entry[0] <= previous) codecViolation(`${path}_ENTRY_ORDER`);
        previous = entry[0];
        Object.defineProperty(result, entry[0], {
          value: decodeNode(entry[1], `${path}_${entry[0]}`), enumerable: true, writable: true, configurable: true,
        });
      }
      return result;
    }
    default: return codecViolation(`${path}_UNSUPPORTED_TAG`);
  }
}

export function decodeInertPayload(value: unknown): unknown {
  assertPlainInertData(value, 'RESEARCH_INERT_PAYLOAD_NODE');
  return deepFreeze(decodeNode(value, 'ROOT'));
}

export function canonicalInertPayloadEncoding(value: unknown): string {
  return JSON.stringify(encodeInertPayload(value));
}

export const PHASE_9D_INERT_PAYLOAD_BOUNDARY = Object.freeze({
  codecVersion: RESEARCH_INERT_PAYLOAD_CODEC_VERSION,
  executableTypesAllowed: false,
  customToJsonExecuted: false,
  prototypeSemanticsPreserved: false,
  productionAuthority: false,
} as const);
