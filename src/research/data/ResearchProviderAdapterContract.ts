import {
  type AvailableAtAuthority,
  type ProviderManifest,
  assertExternalReferenceOnlyConfiguration,
  assertProviderManifest,
} from './ProviderManifestContract';

export const MAX_RESEARCH_FETCH_RECORDS = 10_000;
export const MAX_RESEARCH_FETCH_TIMEOUT_MS = 60_000;

export interface ResearchFetchRange {
  readonly startInclusive: string;
  readonly endExclusive: string;
}

export interface ResearchFetchRequest {
  readonly requestId: string;
  readonly limit: number;
  readonly timeoutMs: number;
  readonly cursor?: string;
  readonly range?: ResearchFetchRange;
}

export interface SourceRevisionMetadata {
  readonly revisionId: string;
  readonly observedAt?: string;
}

export interface RawResearchRecord {
  readonly providerId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceDatasetRef: string;
  readonly sourceRecordId: string;
  readonly eventTime: string;
  readonly availableAt: string | null;
  readonly availableAtAuthority: AvailableAtAuthority;
  readonly ingestedAt: string;
  readonly payload: unknown;
  /** Existing digest only. Phase 9A does not derive or canonicalize it. */
  readonly payloadHash: string;
  readonly manifestVersion: string;
  readonly manifestReference: string;
  readonly requestId: string;
  readonly sourceProvenanceRef: string;
  readonly sourceRevision?: SourceRevisionMetadata;
}

export interface ResearchFetchPage {
  readonly records: readonly RawResearchRecord[];
  readonly nextCursor: string | null;
  readonly complete: boolean;
}

/** The complete public surface allowed for a Phase 9A research provider. */
export interface ResearchProviderAdapter {
  describe(): ProviderManifest;
  validateConfiguration(configuration: unknown): void;
  fetch(request: ResearchFetchRequest, signal: AbortSignal): Promise<ResearchFetchPage>;
}

export const FORBIDDEN_RESEARCH_PROVIDER_CAPABILITIES = Object.freeze([
  'start',
  'stop',
  'stream',
  'subscribe',
  'trade',
  'submitOrder',
  'cancelOrder',
  'publishToMarketRuntime',
  'setLiveReady',
  'production.write',
  'runCommand',
  'spawnProcess',
  'writeFile',
  'deleteFile',
  'gitCommit',
  'gitPush',
] as const);

export const PHASE_9A_PIT_RULE = Object.freeze({
  distinctTimes: Object.freeze(['event_time', 'available_at', 'ingested_at'] as const),
  visibilityRule: 'available_at <= decision_time',
  unknownAvailableAtAuthorityCanBeRawEvidence: true,
  unknownAvailableAtAuthorityProvesPointInTimeSafety: false,
  backtestEligibilityStateImplemented: false,
} as const);

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_METHODS = new Set(['describe', 'validateConfiguration', 'fetch']);

function violation(reason: string): never {
  throw new Error(`PHASE_9A_RESEARCH_ADAPTER_INVALID:${reason}`);
}

function iso(value: unknown, name: string): string {
  if (typeof value !== 'string') violation(name);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) violation(name);
  return value;
}

function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) violation(name);
  return value;
}

function publicMemberNames(adapter: object): readonly string[] {
  const names = new Set<string>();
  let current: object | null = adapter;
  while (current !== null && current !== Object.prototype) {
    const symbols = Object.getOwnPropertySymbols(current);
    if (symbols.length > 0) {
      violation(`ADAPTER_SYMBOL_PROPERTY_FORBIDDEN:${String(symbols[0])}`);
    }
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) violation(`ADAPTER_ACCESSOR:${name}`);
      names.add(name);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names];
}

/** Reject any public capability beyond the three read-only contract methods. */
export function assertResearchProviderAdapterSurface(value: unknown): asserts value is ResearchProviderAdapter {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) violation('ADAPTER_NOT_OBJECT');
  const adapter = value as Record<string, unknown>;
  for (const required of ALLOWED_METHODS) {
    if (typeof adapter[required] !== 'function') violation(`ADAPTER_METHOD_REQUIRED:${required}`);
  }
  const members = publicMemberNames(value as object);
  for (const member of members) {
    if (!ALLOWED_METHODS.has(member)) violation(`ADAPTER_CAPABILITY_FORBIDDEN:${member}`);
  }
  for (const forbidden of FORBIDDEN_RESEARCH_PROVIDER_CAPABILITIES) {
    if (forbidden in adapter) violation(`ADAPTER_CAPABILITY_FORBIDDEN:${forbidden}`);
  }
}

export function assertResearchFetchRequest(value: unknown): asserts value is ResearchFetchRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) violation('REQUEST_NOT_OBJECT');
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (keys.some((key) => !['requestId', 'limit', 'timeoutMs', 'cursor', 'range'].includes(key))) violation('REQUEST_FIELDS');
  id(request.requestId, 'REQUEST_ID');
  if (!Number.isSafeInteger(request.limit) || (request.limit as number) < 1 || (request.limit as number) > MAX_RESEARCH_FETCH_RECORDS) {
    violation('REQUEST_LIMIT');
  }
  if (!Number.isSafeInteger(request.timeoutMs) || (request.timeoutMs as number) < 1 || (request.timeoutMs as number) > MAX_RESEARCH_FETCH_TIMEOUT_MS) {
    violation('REQUEST_TIMEOUT');
  }
  if (request.cursor !== undefined) id(request.cursor, 'REQUEST_CURSOR');
  if (request.range !== undefined) {
    if (request.range === null || typeof request.range !== 'object' || Array.isArray(request.range)) violation('REQUEST_RANGE');
    const range = request.range as Record<string, unknown>;
    if (Object.keys(range).sort().join(',') !== 'endExclusive,startInclusive') violation('REQUEST_RANGE_FIELDS');
    const start = iso(range.startInclusive, 'REQUEST_RANGE_START');
    const end = iso(range.endExclusive, 'REQUEST_RANGE_END');
    if (Date.parse(start) >= Date.parse(end)) violation('REQUEST_RANGE_ORDER');
  }
}

export function assertRawResearchRecord(value: unknown): asserts value is RawResearchRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) violation('RAW_RECORD_NOT_OBJECT');
  const raw = value as Record<string, unknown>;
  const required = [
    'providerId', 'adapterId', 'adapterVersion', 'sourceDatasetRef', 'sourceRecordId',
    'eventTime', 'availableAt', 'availableAtAuthority', 'ingestedAt', 'payload',
    'payloadHash', 'manifestVersion', 'manifestReference', 'requestId', 'sourceProvenanceRef',
  ];
  const allowed = new Set([...required, 'sourceRevision']);
  if (required.some((key) => !(key in raw)) || Object.keys(raw).some((key) => !allowed.has(key))) violation('RAW_RECORD_FIELDS');
  for (const key of ['providerId', 'adapterId', 'adapterVersion', 'sourceDatasetRef', 'sourceRecordId', 'manifestVersion', 'manifestReference', 'requestId', 'sourceProvenanceRef']) {
    id(raw[key], `RAW_RECORD_${key}`);
  }
  iso(raw.eventTime, 'RAW_RECORD_EVENT_TIME');
  iso(raw.ingestedAt, 'RAW_RECORD_INGESTED_AT');
  if (raw.availableAt !== null) iso(raw.availableAt, 'RAW_RECORD_AVAILABLE_AT');
  if (!['PROVIDER_FIELD', 'DOCUMENTED_RULE', 'UNKNOWN'].includes(raw.availableAtAuthority as string)) {
    violation('RAW_RECORD_AVAILABLE_AT_AUTHORITY');
  }
  if (raw.availableAtAuthority === 'UNKNOWN' && raw.availableAt !== null) {
    violation('UNKNOWN_AVAILABLE_AT_CANNOT_ASSERT_TIMESTAMP');
  }
  if (typeof raw.payloadHash !== 'string' || !SHA256.test(raw.payloadHash)) violation('RAW_RECORD_PAYLOAD_HASH');
  if (raw.sourceRevision !== undefined) {
    if (raw.sourceRevision === null || typeof raw.sourceRevision !== 'object' || Array.isArray(raw.sourceRevision)) {
      violation('RAW_RECORD_SOURCE_REVISION');
    }
    const revision = raw.sourceRevision as Record<string, unknown>;
    const keys = Object.keys(revision);
    if (!keys.includes('revisionId') || keys.some((key) => !['revisionId', 'observedAt'].includes(key))) {
      violation('RAW_RECORD_SOURCE_REVISION_FIELDS');
    }
    id(revision.revisionId, 'RAW_RECORD_SOURCE_REVISION_ID');
    if (revision.observedAt !== undefined) iso(revision.observedAt, 'RAW_RECORD_SOURCE_REVISION_OBSERVED_AT');
  }
}

export function assertResearchFetchPage(value: unknown, request: ResearchFetchRequest): asserts value is ResearchFetchPage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) violation('PAGE_NOT_OBJECT');
  const page = value as Record<string, unknown>;
  if (Object.keys(page).sort().join(',') !== 'complete,nextCursor,records') violation('PAGE_FIELDS');
  if (!Array.isArray(page.records) || page.records.length > request.limit) violation('PAGE_RECORD_BOUND');
  page.records.forEach(assertRawResearchRecord);
  if (typeof page.complete !== 'boolean') violation('PAGE_COMPLETE');
  if (page.nextCursor !== null) id(page.nextCursor, 'PAGE_NEXT_CURSOR');
  if (page.complete === true && page.nextCursor !== null) violation('COMPLETE_PAGE_HAS_CURSOR');
  if (page.complete === false && page.nextCursor === null) violation('INCOMPLETE_PAGE_MISSING_CURSOR');
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('Research provider fetch aborted', 'AbortError');
}

/**
 * Contract boundary for a future adapter call. `timeoutMs` is a required,
 * bounded input; Phase 9A does not create a timer or race the adapter promise.
 * A concrete adapter must own its transport deadline and cancel its I/O when
 * the signal aborts. This guard only ensures an observed abort can never be
 * converted into a successful (including partial) page.
 */
export async function fetchOneResearchPage(
  adapter: ResearchProviderAdapter,
  request: ResearchFetchRequest,
  signal: AbortSignal,
): Promise<ResearchFetchPage> {
  assertResearchProviderAdapterSurface(adapter);
  assertResearchFetchRequest(request);
  const manifest = validateAdapterDescription(adapter);
  if (request.limit > manifest.pagination.maximumRecordsPerPage) {
    violation('REQUEST_EXCEEDS_MANIFEST_PAGE_BOUND');
  }
  if (signal.aborted) throw abortReason(signal);
  const page = await adapter.fetch(request, signal);
  if (signal.aborted) throw abortReason(signal);
  assertResearchFetchPage(page, request);
  for (const record of page.records) {
    if (
      record.providerId !== manifest.providerId
      || record.adapterId !== manifest.adapterId
      || record.adapterVersion !== manifest.adapterVersion
      || record.manifestVersion !== manifest.manifestVersion
      || record.requestId !== request.requestId
    ) {
      violation('PAGE_PROVENANCE_MISMATCH');
    }
  }
  return page;
}

export function validateResearchProviderConfiguration(
  adapter: ResearchProviderAdapter,
  configuration: unknown,
): void {
  assertResearchProviderAdapterSurface(adapter);
  assertExternalReferenceOnlyConfiguration(configuration);
  adapter.validateConfiguration(configuration);
}

/** UNKNOWN is raw evidence only and can never prove historical visibility. */
export function hasProvablePointInTimeVisibility(
  record: Pick<RawResearchRecord, 'availableAt' | 'availableAtAuthority'>,
  decisionTime: string,
): boolean {
  const decision = iso(decisionTime, 'DECISION_TIME');
  if (record.availableAtAuthority === 'UNKNOWN' || record.availableAt === null) return false;
  const availableAt = iso(record.availableAt, 'AVAILABLE_AT');
  return Date.parse(availableAt) <= Date.parse(decision);
}

export function validateAdapterDescription(adapter: ResearchProviderAdapter): ProviderManifest {
  assertResearchProviderAdapterSurface(adapter);
  const manifest = adapter.describe();
  assertProviderManifest(manifest);
  return manifest;
}

export const PHASE_9A_RESEARCH_ADAPTER_BOUNDARY = Object.freeze({
  phase: '9A',
  delivery: 'CONTRACT_ONLY',
  statefulLifecycleAllowed: false,
  continuousStreamingAllowed: false,
  pagesPerFetch: 1,
  readOnly: true,
  requestTimeoutMustBeEnforcedByAdapter: true,
  genericTimeoutWrapperImplemented: false,
  transportDeadlineEnforcementDeferredToConcreteAdapter: true,
  ownedIoCancellationMustBeProvenByConcreteAdapter: true,
  abortMustRejectWithoutSuccessfulPartialPage: true,
  productionAuthority: false,
  realProviderImplemented: false,
  networkImplementationAdded: false,
} as const);
