/**
 * Phase 9A provider-manifest contract for the Research Data Plane.
 *
 * This is descriptive research metadata only. It does not normalize records,
 * establish dataset eligibility, publish production market data, or grant any
 * trading authority.
 */

export const AVAILABLE_AT_AUTHORITIES = [
  'PROVIDER_FIELD',
  'DOCUMENTED_RULE',
  'UNKNOWN',
] as const;

export type AvailableAtAuthority = (typeof AVAILABLE_AT_AUTHORITIES)[number];

export const CREDENTIAL_REFERENCE_SOURCES = [
  'ENVIRONMENT',
  'SECRET_MANAGER',
  'RUNTIME_INJECTION',
] as const;

export type CredentialReferenceSource = (typeof CREDENTIAL_REFERENCE_SOURCES)[number];

export interface ProviderCredentialReference {
  readonly source: CredentialReferenceSource;
  /** Opaque locator only, for example `env:RESEARCH_API_KEY`; never a value. */
  readonly reference: string;
}

export interface ProviderManifest {
  readonly schemaVersion: string;
  readonly manifestVersion: string;
  readonly providerId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly dataDomains: readonly string[];
  readonly marketScopes: readonly string[];
  readonly transport: {
    readonly kind: string;
    readonly protocol: string;
  };
  readonly auth: {
    readonly mode: 'NONE' | 'EXTERNAL_REFERENCE';
    readonly credentialReferences: readonly ProviderCredentialReference[];
  };
  readonly pagination: {
    readonly mode: string;
    readonly boundedPage: true;
    readonly maximumRecordsPerPage: number;
    readonly cursorSupported: boolean;
  };
  readonly ordering: {
    readonly guarantee: string;
    readonly keys: readonly string[];
  };
  readonly duplicates: {
    readonly semantics: string;
    readonly stableSourceRecordId: boolean;
  };
  readonly rateLimit: {
    readonly semantics: string;
    readonly retryAfterSupported: boolean;
  };
  readonly revisions: {
    readonly semantics: string;
    readonly sourceRevisionAvailable: boolean;
  };
  readonly licensing: {
    readonly redistributionAllowed: boolean;
    readonly license: string;
    readonly attribution: string | null;
  };
  readonly timeSemantics: {
    readonly eventTimeSource: string;
    readonly availableAtSource: string | null;
    readonly availableAtRule: string | null;
    readonly availableAtAuthority: AvailableAtAuthority;
  };
  readonly productionAuthority: false;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/;
const EXTERNAL_REFERENCE = /^(env|secret-manager|runtime):[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const SECRET_VALUE = /(?:bearer\s+\S+|-----BEGIN [^-]*PRIVATE KEY-----|(?:password|passphrase|private[_-]?key|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+)/i;
const URI_WITH_USERINFO = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]*@/;
const SENSITIVE_KEY_WORDS = new Set([
  'authorization', 'cookie', 'credential', 'credentials', 'password',
  'passphrase', 'secret', 'token',
]);

function configurationKeyWords(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function isSensitiveConfigurationKey(key: string): boolean {
  const words = configurationKeyWords(key);
  const compact = words.join('');
  if (compact === 'credentialreferences') return false;
  return words.some((word) => SENSITIVE_KEY_WORDS.has(word))
    || compact.includes('apikey')
    || compact.includes('privatekey');
}

function violation(reason: string): never {
  throw new Error(`PHASE_9A_PROVIDER_MANIFEST_INVALID:${reason}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) violation(`${name}_NOT_OBJECT`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    violation(`${name}_FIELDS`);
  }
}

function text(value: unknown, name: string, pattern: RegExp = IDENTIFIER): string {
  if (typeof value !== 'string' || !pattern.test(value)) violation(name);
  return value;
}

function textList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) violation(name);
  const values = value.map((item, index) => text(item, `${name}_${index}`));
  if (new Set(values).size !== values.length) violation(`${name}_DUPLICATE`);
  return values;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') violation(name);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) violation(name);
  return value as number;
}

function nullableText(value: unknown, name: string): string | null {
  if (value === null) return null;
  return text(value, name, /^\S(?:.{0,510}\S)?$/);
}

function assertCredentialReference(value: unknown): void {
  const candidate = record(value, 'AUTH_REFERENCE');
  exactKeys(candidate, ['source', 'reference'], 'AUTH_REFERENCE');
  if (!CREDENTIAL_REFERENCE_SOURCES.includes(candidate.source as CredentialReferenceSource)) {
    violation('AUTH_REFERENCE_SOURCE');
  }
  const reference = text(candidate.reference, 'AUTH_REFERENCE_VALUE', EXTERNAL_REFERENCE);
  const expectedPrefix: Record<CredentialReferenceSource, string> = {
    ENVIRONMENT: 'env:',
    SECRET_MANAGER: 'secret-manager:',
    RUNTIME_INJECTION: 'runtime:',
  };
  if (!reference.startsWith(expectedPrefix[candidate.source as CredentialReferenceSource])) {
    violation('AUTH_REFERENCE_SOURCE_MISMATCH');
  }
}

/**
 * Reject credential material in adapter configuration. Secret-shaped fields
 * may contain only an external locator, never inline material.
 */
export function assertExternalReferenceOnlyConfiguration(value: unknown): void {
  const seen = new WeakSet<object>();

  function inspect(current: unknown, path: string): void {
    if (typeof current === 'string') {
      if (SECRET_VALUE.test(current) || URI_WITH_USERINFO.test(current)) violation(`INLINE_SECRET:${path}`);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (Object.getOwnPropertySymbols(current).length > 0) {
      violation(`CONFIGURATION_SYMBOL_PROPERTY:${path}`);
    }
    if (seen.has(current)) violation(`CONFIGURATION_CYCLE:${path}`);
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        current.forEach((item, index) => inspect(item, `${path}[${index}]`));
        return;
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor.get !== undefined || descriptor.set !== undefined) violation(`CONFIGURATION_ACCESSOR:${path}.${key}`);
        const item = descriptor.value;
        if (isSensitiveConfigurationKey(key)) {
          if (typeof item !== 'string' || !EXTERNAL_REFERENCE.test(item)) {
            violation(`INLINE_SECRET:${path}.${key}`);
          }
        } else {
          inspect(item, `${path}.${key}`);
        }
      }
    } finally {
      seen.delete(current);
    }
  }

  inspect(value, '$');
}

/** Strict, fail-closed runtime validator for untrusted manifest input. */
export function assertProviderManifest(value: unknown): asserts value is ProviderManifest {
  const manifest = record(value, 'ROOT');
  exactKeys(manifest, [
    'schemaVersion', 'manifestVersion', 'providerId', 'adapterId', 'adapterVersion',
    'dataDomains', 'marketScopes', 'transport', 'auth', 'pagination', 'ordering',
    'duplicates', 'rateLimit', 'revisions', 'licensing', 'timeSemantics',
    'productionAuthority',
  ], 'ROOT');

  text(manifest.schemaVersion, 'SCHEMA_VERSION', VERSION);
  text(manifest.manifestVersion, 'MANIFEST_VERSION', VERSION);
  text(manifest.providerId, 'PROVIDER_ID');
  text(manifest.adapterId, 'ADAPTER_ID');
  text(manifest.adapterVersion, 'ADAPTER_VERSION', VERSION);
  textList(manifest.dataDomains, 'DATA_DOMAINS');
  textList(manifest.marketScopes, 'MARKET_SCOPES');

  const transport = record(manifest.transport, 'TRANSPORT');
  exactKeys(transport, ['kind', 'protocol'], 'TRANSPORT');
  text(transport.kind, 'TRANSPORT_KIND');
  text(transport.protocol, 'TRANSPORT_PROTOCOL');

  const auth = record(manifest.auth, 'AUTH');
  exactKeys(auth, ['mode', 'credentialReferences'], 'AUTH');
  if (auth.mode !== 'NONE' && auth.mode !== 'EXTERNAL_REFERENCE') violation('AUTH_MODE');
  if (!Array.isArray(auth.credentialReferences)) violation('AUTH_REFERENCES');
  auth.credentialReferences.forEach(assertCredentialReference);
  if (auth.mode === 'NONE' && auth.credentialReferences.length !== 0) violation('AUTH_NONE_WITH_REFERENCES');
  if (auth.mode === 'EXTERNAL_REFERENCE' && auth.credentialReferences.length === 0) violation('AUTH_REFERENCE_REQUIRED');

  const pagination = record(manifest.pagination, 'PAGINATION');
  exactKeys(pagination, ['mode', 'boundedPage', 'maximumRecordsPerPage', 'cursorSupported'], 'PAGINATION');
  text(pagination.mode, 'PAGINATION_MODE');
  if (pagination.boundedPage !== true) violation('PAGINATION_MUST_BE_BOUNDED');
  positiveInteger(pagination.maximumRecordsPerPage, 'MAXIMUM_RECORDS_PER_PAGE');
  boolean(pagination.cursorSupported, 'CURSOR_SUPPORTED');

  const ordering = record(manifest.ordering, 'ORDERING');
  exactKeys(ordering, ['guarantee', 'keys'], 'ORDERING');
  text(ordering.guarantee, 'ORDERING_GUARANTEE');
  textList(ordering.keys, 'ORDERING_KEYS');

  const duplicates = record(manifest.duplicates, 'DUPLICATES');
  exactKeys(duplicates, ['semantics', 'stableSourceRecordId'], 'DUPLICATES');
  text(duplicates.semantics, 'DUPLICATE_SEMANTICS');
  boolean(duplicates.stableSourceRecordId, 'STABLE_SOURCE_RECORD_ID');

  const rateLimit = record(manifest.rateLimit, 'RATE_LIMIT');
  exactKeys(rateLimit, ['semantics', 'retryAfterSupported'], 'RATE_LIMIT');
  text(rateLimit.semantics, 'RATE_LIMIT_SEMANTICS');
  boolean(rateLimit.retryAfterSupported, 'RETRY_AFTER_SUPPORTED');

  const revisions = record(manifest.revisions, 'REVISIONS');
  exactKeys(revisions, ['semantics', 'sourceRevisionAvailable'], 'REVISIONS');
  text(revisions.semantics, 'REVISION_SEMANTICS');
  boolean(revisions.sourceRevisionAvailable, 'SOURCE_REVISION_AVAILABLE');

  const licensing = record(manifest.licensing, 'LICENSING');
  exactKeys(licensing, ['redistributionAllowed', 'license', 'attribution'], 'LICENSING');
  boolean(licensing.redistributionAllowed, 'REDISTRIBUTION_ALLOWED');
  text(licensing.license, 'LICENSE', /^\S(?:.{0,254}\S)?$/);
  nullableText(licensing.attribution, 'ATTRIBUTION');

  const time = record(manifest.timeSemantics, 'TIME_SEMANTICS');
  exactKeys(time, ['eventTimeSource', 'availableAtSource', 'availableAtRule', 'availableAtAuthority'], 'TIME_SEMANTICS');
  text(time.eventTimeSource, 'EVENT_TIME_SOURCE', /^\S(?:.{0,510}\S)?$/);
  nullableText(time.availableAtSource, 'AVAILABLE_AT_SOURCE');
  nullableText(time.availableAtRule, 'AVAILABLE_AT_RULE');
  if (!AVAILABLE_AT_AUTHORITIES.includes(time.availableAtAuthority as AvailableAtAuthority)) {
    violation('AVAILABLE_AT_AUTHORITY');
  }
  if (time.availableAtAuthority === 'PROVIDER_FIELD' && time.availableAtSource === null) {
    violation('PROVIDER_FIELD_SOURCE_REQUIRED');
  }
  if (time.availableAtAuthority === 'DOCUMENTED_RULE' && time.availableAtRule === null) {
    violation('DOCUMENTED_AVAILABLE_AT_RULE_REQUIRED');
  }
  if (time.availableAtAuthority === 'UNKNOWN' && (time.availableAtSource !== null || time.availableAtRule !== null)) {
    violation('UNKNOWN_AVAILABLE_AT_MUST_REMAIN_UNKNOWN');
  }

  if (manifest.productionAuthority !== false) violation('PRODUCTION_AUTHORITY_MUST_BE_FALSE');
  assertExternalReferenceOnlyConfiguration(manifest);
}

export const PHASE_9A_PROVIDER_MANIFEST_BOUNDARY = Object.freeze({
  phase: '9A',
  delivery: 'CONTRACT_ONLY',
  boundedContext: 'src/research/data',
  researchDataIsProductionMarketData: false,
  productionAuthority: false,
  secretValuesAllowed: false,
  credentialMaterialPolicy: 'EXTERNAL_REFERENCE_ONLY',
  backtestEligibilityImplemented: false,
  normalizationImplemented: false,
} as const);
