/**
 * Bitget L0 read transport.
 *
 * One closed GET-only read transport: fixed production origin, endpoint allowlist, canonical query
 * serialization shared byte-for-byte with the signature, Bitget V2 signing, an unforgeable
 * production provenance marker, request counters and a sanitized error taxonomy.
 *
 * It performs no retry, no polling, no mutation and holds no credential of its own.
 */
import {
  BITGET_L0_PRODUCTION_ORIGIN,
  BITGET_READ_API_CODE_PATTERN,
  BITGET_READ_ENDPOINTS,
  BITGET_READ_SUCCESS_CODE,
  BITGET_READ_TIMESTAMP_PATTERN,
  MAX_BITGET_ERROR_BODY_CHARACTERS,
  bitgetEndpointContract,
  bitgetQueryValueValid,
  canonicalBitgetQuery,
  type BitgetEndpointContract,
  type BitgetReadCredential,
  type BitgetReadEndpoint,
  type BitgetReadTransport,
  type BitgetReadTransportRequest,
} from './BitgetReadContracts';
import { signBitgetV2Request } from './BitgetV2Signer';

export const BITGET_L0_SIGNED_HTTP_METHOD = 'GET' as const;
export const MAX_BITGET_CREDENTIAL_CHARACTERS = 512 as const;

/**
 * Hard ceiling for every Bitget REST response body, fixed in source. It is deliberately not a
 * parameter: callers cannot raise it, disable it, or replace it with `Infinity`, and no remote value
 * can influence it.
 */
export const MAX_BITGET_RESPONSE_BYTES = 1_048_576 as const;

/** Sanitized error taxonomy. `BITGET_READ_REQUEST_INVALID` is the local pre-fetch fail-closed code. */
export type BitgetReadTransportErrorCode =
  | 'BITGET_READ_REQUEST_INVALID'
  | 'BITGET_READ_NETWORK_FAILED'
  | 'BITGET_READ_HTTP_FAILED'
  | 'BITGET_READ_API_REJECTED'
  | 'BITGET_READ_RESPONSE_INVALID'
  | 'BITGET_READ_RESPONSE_TOO_LARGE';

/**
 * Public transport error. It can carry a code, the HTTP status and the exchange's numeric code
 * string only - never a raw body, exchange message, headers, credential or signature.
 */
export class BitgetReadTransportError extends Error {
  constructor(
    readonly code: BitgetReadTransportErrorCode,
    readonly httpStatus: number | null = null,
    readonly bitgetCode: string | null = null,
  ) {
    super(code);
    this.name = 'BitgetReadTransportError';
  }
}

export interface BitgetReadableBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel?(reason?: unknown): Promise<void> | void;
  };
}

/** Response surface the transport is willing to consume; everything beyond `text` is optional. */
export interface BitgetReadResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null } | null;
  readonly body?: BitgetReadableBody | null;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type BitgetReadFetch = (
  input: string,
  init: RequestInit,
) => Promise<BitgetReadResponse>;

declare const BITGET_L0_PRODUCTION_TRANSPORT: unique symbol;

/** Nominal capability returned only by the closed production constructor. */
export interface BitgetProductionReadTransport extends BitgetReadTransport {
  readonly [BITGET_L0_PRODUCTION_TRANSPORT]: true;
}

interface BitgetRequestCounters {
  total: number;
  byEndpoint: Map<string, number>;
}

interface ValidatedRequest {
  readonly endpoint: BitgetReadEndpoint;
  readonly canonicalQuery: string;
  readonly credential: BitgetReadCredential | null;
  readonly timestamp: string | null;
}

const PRODUCTION_TRANSPORTS = new WeakSet<object>();
const REQUEST_COUNTERS = new WeakMap<object, BitgetRequestCounters>();

function fail(code: BitgetReadTransportErrorCode): never {
  throw new BitgetReadTransportError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCredential(value: unknown): value is BitgetReadCredential {
  if (!isRecord(value)) return false;
  const credential = value as Record<string, unknown>;
  return ['apiKey', 'secretKey', 'passphrase'].every((field) => {
    const entry = credential[field];
    return typeof entry === 'string' && entry.length > 0
      && entry.length <= MAX_BITGET_CREDENTIAL_CHARACTERS;
  });
}

function responseTooLarge(status: number): BitgetReadTransportError {
  return new BitgetReadTransportError('BITGET_READ_RESPONSE_TOO_LARGE', status, null);
}

/** `Content-Length` is a cheap early hint only - it is never treated as the authority. */
function declaredLengthExceedsLimit(response: BitgetReadResponse): boolean {
  const headers = response.headers;
  const getter = headers?.get;
  if (headers === null || headers === undefined || typeof getter !== 'function') return false;
  let raw: unknown;
  try {
    raw = getter.call(headers, 'content-length');
  } catch {
    return false;
  }
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!/^[0-9]{1,20}$/.test(trimmed)) return false;
  const declared = Number(trimmed);
  return Number.isSafeInteger(declared) && declared > MAX_BITGET_RESPONSE_BYTES;
}

function concatenateChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Bounded response ingestion. Every path enforces MAX_BITGET_RESPONSE_BYTES on real UTF-8 bytes and
 * fails closed with BITGET_READ_RESPONSE_TOO_LARGE; the offending body is never retained, returned,
 * logged or attached to the error.
 *
 * Order: declaration precheck -> streamed byte accounting -> arrayBuffer -> legacy text shape.
 */
async function readBoundedResponseText(response: BitgetReadResponse): Promise<string> {
  if (declaredLengthExceedsLimit(response)) throw responseTooLarge(response.status);
  const body = response.body;
  const reader = body === null || body === undefined || typeof body.getReader !== 'function'
    ? null
    : body.getReader();
  if (reader !== null) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(0);
      total += chunk.byteLength;
      if (total > MAX_BITGET_RESPONSE_BYTES) {
        try {
          await reader.cancel?.();
        } catch {
          // The reader is already unusable; the size verdict stands.
        }
        throw responseTooLarge(response.status);
      }
      chunks.push(chunk);
    }
    return new TextDecoder().decode(concatenateChunks(chunks, total));
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BITGET_RESPONSE_BYTES) throw responseTooLarge(response.status);
    return new TextDecoder().decode(new Uint8Array(buffer));
  }
  // Legacy injected response shape with no stream: bytes are measured once materialized, so this is
  // a bounded check rather than a bounded read. Every real `Response` takes a path above.
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BITGET_RESPONSE_BYTES) {
    throw responseTooLarge(response.status);
  }
  return text;
}

async function extractBitgetCode(response: BitgetReadResponse): Promise<string | null> {
  try {
    const body = await readBoundedResponseText(response);
    if (body.length > MAX_BITGET_ERROR_BODY_CHARACTERS) return null;
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || typeof parsed.code !== 'string') return null;
    return BITGET_READ_API_CODE_PATTERN.test(parsed.code) ? parsed.code : null;
  } catch (error) {
    if (error instanceof BitgetReadTransportError) throw error;
    return null;
  }
}

function validateRequest(request: BitgetReadTransportRequest): ValidatedRequest {
  if (!isRecord(request)) fail('BITGET_READ_REQUEST_INVALID');
  const endpoint = request.endpoint;
  const contract: BitgetEndpointContract | null = bitgetEndpointContract(endpoint);
  if (contract === null) fail('BITGET_READ_REQUEST_INVALID');
  if (!Array.isArray(request.query)) fail('BITGET_READ_REQUEST_INVALID');
  const allowed = new Set<string>([...contract.required, ...contract.optional]);
  const seen = new Set<string>();
  for (const parameter of request.query) {
    if (!isRecord(parameter)) fail('BITGET_READ_REQUEST_INVALID');
    const name = parameter.name;
    const value = parameter.value;
    if (typeof name !== 'string' || typeof value !== 'string') fail('BITGET_READ_REQUEST_INVALID');
    if (!allowed.has(name) || seen.has(name)) fail('BITGET_READ_REQUEST_INVALID');
    if (!bitgetQueryValueValid(endpoint as BitgetReadEndpoint, name, value)) {
      fail('BITGET_READ_REQUEST_INVALID');
    }
    seen.add(name);
  }
  for (const required of contract.required) {
    if (!seen.has(required)) fail('BITGET_READ_REQUEST_INVALID');
  }
  let canonicalQuery: string;
  try {
    canonicalQuery = canonicalBitgetQuery(request.query);
  } catch {
    fail('BITGET_READ_REQUEST_INVALID');
  }
  if (contract.kind === 'PUBLIC_READ') {
    if (request.credential !== undefined || request.timestamp !== undefined) {
      fail('BITGET_READ_REQUEST_INVALID');
    }
    return Object.freeze({ endpoint: endpoint as BitgetReadEndpoint, canonicalQuery, credential: null, timestamp: null });
  }
  if (!validCredential(request.credential)) fail('BITGET_READ_REQUEST_INVALID');
  const timestamp = request.timestamp;
  if (typeof timestamp !== 'string' || !BITGET_READ_TIMESTAMP_PATTERN.test(timestamp)) {
    fail('BITGET_READ_REQUEST_INVALID');
  }
  return Object.freeze({
    endpoint: endpoint as BitgetReadEndpoint,
    canonicalQuery,
    credential: request.credential as BitgetReadCredential,
    timestamp,
  });
}

function authenticatedHeaders(
  request: ValidatedRequest,
): Readonly<Record<string, string>> | null {
  const { credential, timestamp, canonicalQuery, endpoint } = request;
  if (credential === null || timestamp === null) return null;
  const { signature } = signBitgetV2Request({
    secretKey: credential.secretKey,
    timestamp,
    method: BITGET_L0_SIGNED_HTTP_METHOD,
    requestPath: endpoint,
    canonicalQuery,
    body: '',
  });
  return Object.freeze({
    'ACCESS-KEY': credential.apiKey,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': credential.passphrase,
    'Content-Type': 'application/json',
  });
}

function createReadTransport(fetchImpl: BitgetReadFetch): BitgetReadTransport {
  const counters: BitgetRequestCounters = { total: 0, byEndpoint: new Map<string, number>() };
  const transport = {
    async get(request: BitgetReadTransportRequest): Promise<unknown> {
      const validated = validateRequest(request);
      // The signature query and the emitted query are the same bytes by construction.
      const url = validated.canonicalQuery.length === 0
        ? `${BITGET_L0_PRODUCTION_ORIGIN}${validated.endpoint}`
        : `${BITGET_L0_PRODUCTION_ORIGIN}${validated.endpoint}?${validated.canonicalQuery}`;
      const headers = authenticatedHeaders(validated);
      counters.total += 1;
      counters.byEndpoint.set(validated.endpoint, (counters.byEndpoint.get(validated.endpoint) ?? 0) + 1);
      let response: BitgetReadResponse;
      try {
        response = await fetchImpl(url, Object.freeze({
          method: BITGET_L0_SIGNED_HTTP_METHOD,
          redirect: 'error',
          ...(headers === null ? {} : { headers }),
        }));
      } catch {
        // Single attempt: no retry, no polling, no backoff.
        throw new BitgetReadTransportError('BITGET_READ_NETWORK_FAILED');
      }
      if (!response.ok) {
        const bitgetCode = await extractBitgetCode(response);
        throw new BitgetReadTransportError('BITGET_READ_HTTP_FAILED', response.status, bitgetCode);
      }
      let text: string;
      try {
        text = await readBoundedResponseText(response);
      } catch (error) {
        if (error instanceof BitgetReadTransportError) throw error;
        throw new BitgetReadTransportError('BITGET_READ_RESPONSE_INVALID', response.status, null);
      }
      let parsed: unknown;
      try {
        // Raw text is used for parsing only and is never retained, returned or logged.
        parsed = JSON.parse(text);
      } catch {
        throw new BitgetReadTransportError('BITGET_READ_RESPONSE_INVALID', response.status, null);
      }
      if (!isRecord(parsed) || typeof parsed.code !== 'string'
          || !BITGET_READ_API_CODE_PATTERN.test(parsed.code)) {
        throw new BitgetReadTransportError('BITGET_READ_RESPONSE_INVALID', response.status, null);
      }
      // HTTP 2xx with an exchange error code is a rejection, never a success.
      if (parsed.code !== BITGET_READ_SUCCESS_CODE) {
        throw new BitgetReadTransportError('BITGET_READ_API_REJECTED', response.status, parsed.code);
      }
      if (!Object.prototype.hasOwnProperty.call(parsed, 'data')) {
        throw new BitgetReadTransportError('BITGET_READ_RESPONSE_INVALID', response.status, null);
      }
      return parsed.data;
    },
  };
  const frozen = Object.freeze(transport);
  REQUEST_COUNTERS.set(frozen, counters);
  return frozen;
}

/** Injectable transport for tests and simulation; it carries no production provenance. */
export function createBitgetReadTransport(fetchImpl: BitgetReadFetch): BitgetReadTransport {
  return createReadTransport(fetchImpl);
}

/**
 * Closed production capability. Construction performs no I/O, accepts no caller-supplied fetch and
 * binds the ambient `globalThis.fetch`. Membership lives in a module-private WeakSet so structural
 * lookalikes, caller booleans or branded objects cannot forge provenance.
 */
export function createProductionBitgetReadTransport(): BitgetProductionReadTransport {
  if (typeof globalThis.fetch !== 'function') fail('BITGET_READ_REQUEST_INVALID');
  const transport = createReadTransport(globalThis.fetch.bind(globalThis) as BitgetReadFetch);
  PRODUCTION_TRANSPORTS.add(transport);
  return transport as BitgetProductionReadTransport;
}

export function hasProductionBitgetReadTransportProvenance(
  value: unknown,
): value is BitgetProductionReadTransport {
  return typeof value === 'object' && value !== null && PRODUCTION_TRANSPORTS.has(value);
}

export interface BitgetReadRequestCount {
  readonly total: number;
  readonly byEndpoint: Readonly<Record<string, number>>;
}

export function getBitgetReadRequestCount(transport: unknown): BitgetReadRequestCount | null {
  if (typeof transport !== 'object' || transport === null) return null;
  const counters = REQUEST_COUNTERS.get(transport);
  if (counters === undefined) return null;
  return Object.freeze({
    total: counters.total,
    byEndpoint: Object.freeze(Object.fromEntries(counters.byEndpoint)),
  });
}

export { BITGET_READ_ENDPOINTS, BITGET_L0_PRODUCTION_ORIGIN };
