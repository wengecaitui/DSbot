import { createHash } from 'crypto';

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|password|private[_-]?key|secret|token|credentials?)/i;
const INLINE_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_-]*)(\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/g;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const URI_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^@\s/?#]+)@/gi;
const SECRET_VALUE = '<REDACTED>';

export interface RedactionResult<T> {
  value: T;
  redactions: string[];
}

export function digestCommand(command: string): string {
  return `sha256:${createHash('sha256').update(command, 'utf8').digest('hex')}`;
}

export function redactText(input: string): RedactionResult<string> {
  const redactions = new Set<string>();
  let value = input.replace(URI_USERINFO, (_match, scheme: string) => {
    redactions.add('uri_userinfo');
    return `${scheme}${SECRET_VALUE}@`;
  });
  value = value.replace(BEARER, () => {
    redactions.add('bearer');
    return `Bearer ${SECRET_VALUE}`;
  });
  value = value.replace(INLINE_ASSIGNMENT, (match, key: string, separator: string) => {
    if (!SENSITIVE_KEY.test(key)) return match;
    redactions.add(key.toLowerCase());
    return `${key}${separator}${SECRET_VALUE}`;
  });
  return { value, redactions: [...redactions].sort() };
}

export function redactValue<T>(input: T): RedactionResult<T> {
  const redactions = new Set<string>();
  const seen = new WeakSet<object>();

  function visit(value: unknown, key?: string): unknown {
    if (key && SENSITIVE_KEY.test(key)) {
      redactions.add(key.toLowerCase());
      return SECRET_VALUE;
    }
    if (typeof value === 'string') {
      const result = redactText(value);
      result.redactions.forEach(item => redactions.add(item));
      return result.value;
    }
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) {
      redactions.add('circular_reference');
      return '<CIRCULAR>';
    }
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => visit(item));

    const copy: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      copy[childKey] = visit(childValue, childKey);
    }
    return copy;
  }

  return { value: visit(input) as T, redactions: [...redactions].sort() };
}
