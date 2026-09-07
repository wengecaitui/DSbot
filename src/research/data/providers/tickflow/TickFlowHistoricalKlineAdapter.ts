import { createHash } from 'node:crypto';
import type { ProviderManifest } from '../../ProviderManifestContract';
import {
  assertRawResearchRecord,
  assertResearchFetchRequest,
  type RawResearchRecord,
  type ResearchFetchPage,
  type ResearchFetchRequest,
  type ResearchProviderAdapter,
} from '../../ResearchProviderAdapterContract';

export const TICKFLOW_FREE_ORIGIN = 'https://free-api.tickflow.org';
export const TICKFLOW_KLINE_PATH = '/v1/klines';
export const TICKFLOW_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const PROVIDER_ID = 'tickflow';
const ADAPTER_ID = 'tickflow-historical-kline-v1';
const ADAPTER_VERSION = '1.0.0';
const MANIFEST_VERSION = '1.0.0';
const MANIFEST_REFERENCE = 'tickflow:manifest:historical-kline-v1';
const PERIOD = '1d';
const ADJUST = 'none';
const CN_EXCHANGE_SYMBOL = /^\d{6}\.(?:SH|SZ|BJ)$/;
const REQUIRED_COLUMNS = ['timestamp', 'open', 'high', 'low', 'close', 'volume', 'amount'] as const;
const OPTIONAL_COLUMNS = ['open_interest', 'prev_close', 'settlement_price'] as const;

export interface TickFlowHistoricalKlineConfiguration {
  readonly symbol: string;
}

export interface TickFlowAdapterDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => string;
}

type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
type CompactColumns = Record<RequiredColumn, readonly number[]>
  & Partial<Record<OptionalColumn, readonly number[]>>;

function fail(reason: string): never {
  const error = new Error(`PHASE_9G_TICKFLOW_INVALID:${reason}`);
  error.name = 'TickFlowProviderError';
  throw error;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('TickFlow request aborted', 'AbortError');
}

function canonicalIso(value: unknown, reason: string): string {
  if (typeof value !== 'string') fail(reason);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(reason);
  return value;
}

function exactConfiguration(value: unknown): TickFlowHistoricalKlineConfiguration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('CONFIGURATION');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) fail('CONFIGURATION_SYMBOL_PROPERTY');
  if (Object.keys(descriptors).length !== 1 || descriptors.symbol === undefined) fail('CONFIGURATION_FIELDS');
  if (descriptors.symbol.get !== undefined || descriptors.symbol.set !== undefined) fail('CONFIGURATION_ACCESSOR');
  const symbol = descriptors.symbol.value;
  if (typeof symbol !== 'string' || !CN_EXCHANGE_SYMBOL.test(symbol)) fail('CONFIGURATION_SYMBOL');
  return Object.freeze({ symbol });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

export const TICKFLOW_PROVIDER_MANIFEST: ProviderManifest = deepFreeze({
  schemaVersion: '1.0.0',
  manifestVersion: MANIFEST_VERSION,
  providerId: PROVIDER_ID,
  adapterId: ADAPTER_ID,
  adapterVersion: ADAPTER_VERSION,
  dataDomains: ['market-bars'],
  marketScopes: ['CN-SH-SZ-BJ-6digit-symbols'],
  transport: { kind: 'request-response', protocol: 'HTTPS-REST' },
  auth: { mode: 'NONE', credentialReferences: [] },
  pagination: {
    mode: 'count-bounded',
    boundedPage: true,
    maximumRecordsPerPage: 10_000,
    cursorSupported: false,
  },
  ordering: {
    guarantee: 'provider-response-order-unverified',
    keys: ['provider-response-order'],
  },
  duplicates: {
    semantics: 'duplicate-timestamp-rejected',
    stableSourceRecordId: true,
  },
  rateLimit: {
    semantics: 'provider-IP-rate-limit-no-automatic-retry',
    retryAfterSupported: false,
  },
  revisions: {
    semantics: 'provider-revision-identity-not-exposed',
    sourceRevisionAvailable: false,
  },
  licensing: {
    redistributionAllowed: false,
    license: 'provider-data-terms-review-required',
    attribution: 'TickFlow',
  },
  timeSemantics: {
    eventTimeSource: 'TickFlow kline timestamp milliseconds converted exactly to UTC ISO',
    availableAtSource: null,
    availableAtRule: null,
    availableAtAuthority: 'UNKNOWN',
  },
  productionAuthority: false,
});

function plainRecord(value: unknown, reason: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(reason);
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, reason: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(reason);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail(`${reason}_SPARSE`);
  }
  return value;
}

function finiteNumber(value: unknown, reason: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    fail(reason);
  }
  return value;
}

function validateColumns(value: unknown, limit: number): CompactColumns {
  const root = plainRecord(value, 'RESPONSE_ROOT');
  const data = plainRecord(root.data, 'RESPONSE_DATA');
  const columns = {} as Record<string, readonly number[]>;
  let length: number | undefined;

  for (const name of REQUIRED_COLUMNS) {
    const column = denseArray(data[name], `RESPONSE_${name.toUpperCase()}`);
    length ??= column.length;
    if (column.length !== length) fail('RESPONSE_COLUMN_LENGTH');
    columns[name] = column as readonly number[];
  }
  if (length! > limit) fail('RESPONSE_RECORD_LIMIT');

  for (const name of OPTIONAL_COLUMNS) {
    if (!(name in data)) continue;
    const column = denseArray(data[name], `RESPONSE_${name.toUpperCase()}`);
    if (column.length !== length) fail('RESPONSE_COLUMN_LENGTH');
    columns[name] = column as readonly number[];
  }

  const timestamps = new Set<number>();
  for (let index = 0; index < length!; index += 1) {
    const timestamp = columns.timestamp[index];
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail('RESPONSE_TIMESTAMP');
    try {
      new Date(timestamp).toISOString();
    } catch {
      fail('RESPONSE_TIMESTAMP');
    }
    if (timestamps.has(timestamp)) fail('RESPONSE_DUPLICATE_TIMESTAMP');
    timestamps.add(timestamp);

    const open = finiteNumber(columns.open[index], 'RESPONSE_OPEN', true);
    const high = finiteNumber(columns.high[index], 'RESPONSE_HIGH', true);
    const low = finiteNumber(columns.low[index], 'RESPONSE_LOW', true);
    const close = finiteNumber(columns.close[index], 'RESPONSE_CLOSE', true);
    if (low > high || high < open || high < close || low > open || low > close) fail('RESPONSE_OHLC_RELATION');
    if (!Number.isSafeInteger(columns.volume[index]) || columns.volume[index] < 0) fail('RESPONSE_VOLUME');
    finiteNumber(columns.amount[index], 'RESPONSE_AMOUNT');
    for (const name of OPTIONAL_COLUMNS) {
      if (columns[name] !== undefined) finiteNumber(columns[name][index], `RESPONSE_${name.toUpperCase()}`);
    }
  }
  return columns as CompactColumns;
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) fail('RESPONSE_CONTENT_LENGTH');
    if (Number(declaredLength) > TICKFLOW_MAX_RESPONSE_BYTES) fail('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (reader === undefined) fail('RESPONSE_BODY');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    if (signal.aborted) throw abortReason(signal);
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > TICKFLOW_MAX_RESPONSE_BYTES) {
      void reader.cancel();
      fail('RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('RESPONSE_ENCODING');
  }
}

function requestUrl(symbol: string, limit: number): string {
  const url = new URL(TICKFLOW_KLINE_PATH, TICKFLOW_FREE_ORIGIN);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('period', PERIOD);
  url.searchParams.set('count', String(limit));
  url.searchParams.set('adjust', ADJUST);
  return url.toString();
}

function assertOfficialResponse(response: Response): void {
  if (response.status >= 300 && response.status < 400) fail('REDIRECT_REJECTED');
  let observed: URL;
  try {
    observed = new URL(response.url);
  } catch {
    fail('RESPONSE_URL');
  }
  if (observed.origin !== TICKFLOW_FREE_ORIGIN || observed.pathname !== TICKFLOW_KLINE_PATH) {
    fail('REDIRECT_REJECTED');
  }
  if (!response.ok) fail(`HTTP_${response.status}`);
}

function payloadHash(payload: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function buildRecords(
  columns: CompactColumns,
  configuration: TickFlowHistoricalKlineConfiguration,
  request: ResearchFetchRequest,
  ingestedAt: string,
): readonly RawResearchRecord[] {
  const records: RawResearchRecord[] = [];
  const provenanceDigest = createHash('sha256').update(request.requestId, 'utf8').digest('hex').slice(0, 32);
  for (let index = 0; index < columns.timestamp.length; index += 1) {
    const timestamp = columns.timestamp[index];
    const payload = Object.freeze({
      symbol: configuration.symbol,
      period: PERIOD,
      adjust: ADJUST,
      timestamp,
      open: columns.open[index],
      high: columns.high[index],
      low: columns.low[index],
      close: columns.close[index],
      volume: columns.volume[index],
      amount: columns.amount[index],
      ...(columns.open_interest === undefined ? {} : { open_interest: columns.open_interest[index] }),
      ...(columns.prev_close === undefined ? {} : { prev_close: columns.prev_close[index] }),
      ...(columns.settlement_price === undefined ? {} : { settlement_price: columns.settlement_price[index] }),
    });
    const record: RawResearchRecord = Object.freeze({
      providerId: PROVIDER_ID,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      sourceDatasetRef: `tickflow:historical-kline:${configuration.symbol}:${PERIOD}:${ADJUST}`,
      sourceRecordId: `tickflow:${configuration.symbol}:${PERIOD}:${ADJUST}:${timestamp}`,
      eventTime: new Date(timestamp).toISOString(),
      availableAt: null,
      availableAtAuthority: 'UNKNOWN',
      ingestedAt,
      payload,
      payloadHash: payloadHash(payload),
      manifestVersion: MANIFEST_VERSION,
      manifestReference: MANIFEST_REFERENCE,
      requestId: request.requestId,
      sourceProvenanceRef: `tickflow:free-api:v1-klines:${provenanceDigest}`,
    });
    assertRawResearchRecord(record);
    records.push(record);
  }
  return Object.freeze(records);
}

export function createTickFlowHistoricalKlineAdapter(
  configurationValue: unknown,
  dependencies: TickFlowAdapterDependencies = {},
): ResearchProviderAdapter {
  const configuration = exactConfiguration(configurationValue);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? (() => new Date().toISOString());

  return Object.freeze({
    describe(): ProviderManifest {
      return TICKFLOW_PROVIDER_MANIFEST;
    },

    validateConfiguration(candidate: unknown): void {
      const validated = exactConfiguration(candidate);
      if (validated.symbol !== configuration.symbol) fail('CONFIGURATION_MISMATCH');
    },

    async fetch(request: ResearchFetchRequest, callerSignal: AbortSignal): Promise<ResearchFetchPage> {
      assertResearchFetchRequest(request);
      if (request.cursor !== undefined) fail('CURSOR_UNSUPPORTED');
      if (request.range !== undefined) fail('RANGE_UNSUPPORTED');
      if (callerSignal.aborted) throw abortReason(callerSignal);

      const controller = new AbortController();
      const timeoutError = new Error('PHASE_9G_TICKFLOW_INVALID:REQUEST_TIMEOUT');
      timeoutError.name = 'TickFlowProviderError';
      const onCallerAbort = (): void => controller.abort(abortReason(callerSignal));
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      const timer = setTimeout(() => controller.abort(timeoutError), request.timeoutMs);
      const abortPromise = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(abortReason(controller.signal)), { once: true });
      });

      const operation = async (): Promise<ResearchFetchPage> => {
        const response = await fetchImplementation(requestUrl(configuration.symbol, request.limit), {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'manual',
          signal: controller.signal,
        });
        assertOfficialResponse(response);
        const body = await readBoundedBody(response, controller.signal);
        let decoded: unknown;
        try {
          decoded = JSON.parse(body);
        } catch {
          fail('RESPONSE_JSON');
        }
        const columns = validateColumns(decoded, request.limit);
        const ingestedAt = canonicalIso(now(), 'INGESTED_AT');
        return Object.freeze({
          records: buildRecords(columns, configuration, request, ingestedAt),
          nextCursor: null,
          complete: true,
        });
      };

      try {
        return await Promise.race([operation(), abortPromise]);
      } catch (error) {
        if (callerSignal.aborted) throw abortReason(callerSignal);
        if (controller.signal.reason === timeoutError) throw timeoutError;
        if (error instanceof Error && error.name === 'TickFlowProviderError') throw error;
        fail('TRANSPORT_FAILURE');
      } finally {
        clearTimeout(timer);
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
    },
  });
}
