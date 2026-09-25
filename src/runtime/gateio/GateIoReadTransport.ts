/**
 * Closed Gate.io API v4 L0 read transport.
 *
 * Fixed live origin, GET-only endpoint allowlist, deterministic shared query bytes, bounded response
 * ingestion, private factual request evidence and unforgeable production provenance. There is no
 * retry, polling, backoff, fallback origin, credential discovery or trading authority here.
 */
import {
  GATEIO_L0_LIVE_ORIGIN,
  GATEIO_L0_TESTNET_ORIGIN,
  GATEIO_READ_ENDPOINTS,
  GATEIO_SAFE_LABEL_PATTERN,
  canonicalGateIoQuery,
  gateIoEndpointContract,
  gateIoQueryValueValid,
  gateIoTimestampValid,
  normalizeGateIoServerTime,
  type GateIoEndpointContract,
  type GateIoReadCredential,
  type GateIoReadEndpoint,
  type GateIoReadTransport,
  type GateIoReadTransportRequest,
} from './GateIoReadContracts';
import { GATEIO_V4_L0_SIGNED_METHOD, signGateIoV4Request } from './GateIoV4Signer';
import { GateIoG3RunBudget } from './GateIoG3RunBudget';

export const MAX_GATEIO_RESPONSE_BYTES = 1_048_576 as const;
export const MAX_GATEIO_CREDENTIAL_CHARACTERS = 512 as const;

export type GateIoReadTransportErrorCode =
  | 'GATEIO_READ_REQUEST_INVALID'
  | 'GATEIO_READ_NETWORK_FAILED'
  | 'GATEIO_READ_HTTP_FAILED'
  | 'GATEIO_READ_API_REJECTED'
  | 'GATEIO_READ_RESPONSE_INVALID'
  | 'GATEIO_READ_RESPONSE_TOO_LARGE';

/** Safe metadata only. The original request, response, body, message, headers and credentials die here. */
export class GateIoReadTransportError extends Error {
  constructor(
    readonly code: GateIoReadTransportErrorCode,
    readonly endpoint: GateIoReadEndpoint | null = null,
    readonly httpStatus: number | null = null,
    readonly gateLabel: string | null = null,
  ) {
    super(code);
    this.name = 'GateIoReadTransportError';
  }
}

export interface GateIoReadableBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel?(reason?: unknown): Promise<void> | void;
  };
}

export interface GateIoReadResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null } | null;
  readonly body?: GateIoReadableBody | null;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type GateIoReadFetch = (input: string, init: RequestInit) => Promise<GateIoReadResponse>;

declare const GATEIO_L0_PRODUCTION_TRANSPORT: unique symbol;

export interface GateIoProductionReadTransport extends GateIoReadTransport {
  readonly [GATEIO_L0_PRODUCTION_TRANSPORT]: true;
}

interface GateIoRequestCounters {
  total: number;
  byEndpoint: Map<string, number>;
  sequence: GateIoReadEndpoint[];
}

interface ValidatedRequest {
  readonly endpoint: GateIoReadEndpoint;
  readonly contract: GateIoEndpointContract;
  readonly canonicalQuery: string;
  readonly credential: GateIoReadCredential | null;
  readonly timestamp: string | null;
}

const PRODUCTION_TRANSPORTS = new WeakSet<object>();
const REQUEST_COUNTERS = new WeakMap<object, GateIoRequestCounters>();
const TRANSPORT_ENVIRONMENTS = new WeakMap<object, 'live' | 'testnet'>();
const TRANSPORT_BUDGETS = new WeakMap<object, GateIoG3RunBudget>();

function fail(code: GateIoReadTransportErrorCode): never {
  throw new GateIoReadTransportError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCredential(value: unknown): value is GateIoReadCredential {
  if (!isRecord(value)) return false;
  return ['apiKey', 'secretKey'].every((field) => {
    const entry = value[field];
    return typeof entry === 'string' && entry.length > 0
      && entry.length <= MAX_GATEIO_CREDENTIAL_CHARACTERS;
  });
}

function safeStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function responseTooLarge(endpoint: GateIoReadEndpoint, status: number): GateIoReadTransportError {
  return new GateIoReadTransportError(
    'GATEIO_READ_RESPONSE_TOO_LARGE', endpoint, safeStatus(status), null,
  );
}

function declaredLengthExceedsLimit(response: GateIoReadResponse): boolean {
  const getter = response.headers?.get;
  if (typeof getter !== 'function') return false;
  let raw: unknown;
  try {
    raw = getter.call(response.headers, 'content-length');
  } catch {
    return false;
  }
  if (typeof raw !== 'string' || !/^[0-9]{1,20}$/.test(raw.trim())) return false;
  const declared = Number(raw.trim());
  return Number.isSafeInteger(declared) && declared > MAX_GATEIO_RESPONSE_BYTES;
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

async function readBoundedResponseText(
  response: GateIoReadResponse,
  endpoint: GateIoReadEndpoint,
): Promise<string> {
  if (declaredLengthExceedsLimit(response)) throw responseTooLarge(endpoint, response.status);
  const reader = response.body === null || response.body === undefined
    || typeof response.body.getReader !== 'function'
    ? null
    : response.body.getReader();
  if (reader !== null) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(0);
      total += chunk.byteLength;
      if (total > MAX_GATEIO_RESPONSE_BYTES) {
        try {
          await reader.cancel?.();
        } catch {
          // Size verdict is final even if cancellation itself fails.
        }
        throw responseTooLarge(endpoint, response.status);
      }
      chunks.push(chunk);
    }
    return new TextDecoder().decode(concatenateChunks(chunks, total));
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_GATEIO_RESPONSE_BYTES) {
      throw responseTooLarge(endpoint, response.status);
    }
    return new TextDecoder().decode(new Uint8Array(buffer));
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_GATEIO_RESPONSE_BYTES) {
    throw responseTooLarge(endpoint, response.status);
  }
  return text;
}

function validateRequest(request: GateIoReadTransportRequest): ValidatedRequest {
  if (!isRecord(request)) fail('GATEIO_READ_REQUEST_INVALID');
  const endpoint = request.endpoint;
  const contract = gateIoEndpointContract(endpoint);
  if (contract === null || !Array.isArray(request.query)) fail('GATEIO_READ_REQUEST_INVALID');
  const allowed = new Set<string>([...contract.required, ...contract.optional]);
  const seen = new Set<string>();
  for (const parameter of request.query) {
    if (!isRecord(parameter)) fail('GATEIO_READ_REQUEST_INVALID');
    const { name, value } = parameter;
    if (typeof name !== 'string' || typeof value !== 'string'
        || !allowed.has(name) || seen.has(name) || !gateIoQueryValueValid(name, value)) {
      fail('GATEIO_READ_REQUEST_INVALID');
    }
    seen.add(name);
  }
  for (const required of contract.required) {
    if (!seen.has(required)) fail('GATEIO_READ_REQUEST_INVALID');
  }
  let canonicalQuery: string;
  try {
    canonicalQuery = canonicalGateIoQuery(request.query);
  } catch {
    fail('GATEIO_READ_REQUEST_INVALID');
  }
  if (contract.kind === 'PUBLIC_READ') {
    if (request.credential !== undefined || request.timestamp !== undefined) {
      fail('GATEIO_READ_REQUEST_INVALID');
    }
    return Object.freeze({
      endpoint: endpoint as GateIoReadEndpoint,
      contract,
      canonicalQuery,
      credential: null,
      timestamp: null,
    });
  }
  if (!validCredential(request.credential) || !gateIoTimestampValid(request.timestamp)) {
    fail('GATEIO_READ_REQUEST_INVALID');
  }
  return Object.freeze({
    endpoint: endpoint as GateIoReadEndpoint,
    contract,
    canonicalQuery,
    credential: request.credential,
    timestamp: request.timestamp,
  });
}

function authenticatedHeaders(request: ValidatedRequest): Readonly<Record<string, string>> | null {
  if (request.credential === null || request.timestamp === null) return null;
  const { signature } = signGateIoV4Request({
    secretKey: request.credential.secretKey,
    timestamp: request.timestamp,
    method: GATEIO_V4_L0_SIGNED_METHOD,
    requestUrl: request.endpoint,
    canonicalQuery: request.canonicalQuery,
    body: '',
  });
  return Object.freeze({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    KEY: request.credential.apiKey,
    Timestamp: request.timestamp,
    SIGN: signature,
  });
}

function safeLabel(parsed: unknown): string | null {
  if (!isRecord(parsed) || typeof parsed.label !== 'string') return null;
  return GATEIO_SAFE_LABEL_PATTERN.test(parsed.label) ? parsed.label : null;
}

const MAX_GATEIO_SIGNED_INT64 = '9223372036854775807';
const EXACT_POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * JSON.parse's source context is the token authority before an unsafe JSON number is rounded.
 * This stays endpoint/field scoped: price, quantity, fee and timestamps use the normal parser.
 */
function exactTradeIdentifier(value: unknown, source: string | undefined): unknown {
  if (typeof value !== 'number' && typeof value !== 'string') return value;
  const token = typeof value === 'number' ? source : value;
  if (typeof token !== 'string' || !EXACT_POSITIVE_INTEGER.test(token)
      || token.length > MAX_GATEIO_SIGNED_INT64.length
      || (token.length === MAX_GATEIO_SIGNED_INT64.length
        && token > MAX_GATEIO_SIGNED_INT64)) {
    throw new Error('GATEIO_TRADE_EXACT_ID_INVALID');
  }
  return token;
}

/** Detect duplicate identifier keys that JSON.parse would otherwise silently collapse. */
function tradeIdentifierKeysUnique(raw: string): boolean {
  const stack: ('array' | 'object')[] = [];
  let counts: { id: number; order_id: number } | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      const start = index;
      index += 1;
      for (; index < raw.length; index += 1) {
        if (raw[index] === '\\') { index += 1; continue; }
        if (raw[index] === '"') break;
      }
      if (stack.length === 2 && stack[0] === 'array' && stack[1] === 'object') {
        let after = index + 1;
        while (after < raw.length && /\s/.test(raw[after]!)) after += 1;
        if (raw[after] === ':') {
          const key = JSON.parse(raw.slice(start, index + 1)) as string;
          if (key === 'id' || key === 'order_id') {
            if (counts === null) return false;
            counts[key] += 1;
          }
        }
      }
      continue;
    }
    if (char === '[') stack.push('array');
    else if (char === '{') {
      if (stack.length === 1 && stack[0] === 'array') {
        counts = { id: 0, order_id: 0 };
      }
      stack.push('object');
    } else if (char === '}') {
      if (stack.length === 2 && stack[0] === 'array' && stack[1] === 'object') {
        if (counts?.id !== 1 || counts.order_id !== 1) return false;
        counts = null;
      }
      stack.pop();
    } else if (char === ']') stack.pop();
  }
  // The caller separately checks the parsed array shape, including a valid empty array.
  return stack.length === 0 && counts === null;
}

function parseGateIoRecentTrades(raw: string): unknown {
  const evidence = new WeakMap<object, Map<'id' | 'order_id', string | undefined>>();
  const parsed: unknown = JSON.parse(raw, function (this: unknown, key: string, value: unknown,
    context?: { readonly source?: string }) {
    if ((key === 'id' || key === 'order_id') && isRecord(this)) {
      const fields = evidence.get(this) ?? new Map<'id' | 'order_id', string | undefined>();
      fields.set(key, context?.source);
      evidence.set(this, fields);
    }
    return value;
  });
  if (!Array.isArray(parsed) || !tradeIdentifierKeysUnique(raw))
    throw new Error('GATEIO_TRADE_EXACT_ID_INVALID');
  return parsed.map((entry: unknown) => {
    if (!isRecord(entry)) return entry;
    const fields = evidence.get(entry);
    return {
      ...entry,
      id: exactTradeIdentifier(entry.id, fields?.get('id')),
      order_id: exactTradeIdentifier(entry.order_id, fields?.get('order_id')),
    };
  });
}

function normalizeSuccessfulResponse(
  validated: ValidatedRequest,
  parsed: unknown,
  httpStatus: number,
): unknown {
  if (validated.contract.responseShape === 'SERVER_TIME') {
    if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, 'server_time')) {
      throw new GateIoReadTransportError(
        'GATEIO_READ_RESPONSE_INVALID', validated.endpoint, httpStatus, null,
      );
    }
    let serverTime: number;
    try {
      serverTime = normalizeGateIoServerTime(parsed.server_time);
    } catch {
      throw new GateIoReadTransportError(
        'GATEIO_READ_RESPONSE_INVALID', validated.endpoint, httpStatus, null,
      );
    }
    return Object.freeze({ server_time: serverTime });
  }
  if (validated.contract.responseShape === 'OBJECT' && isRecord(parsed)) return parsed;
  if (validated.contract.responseShape === 'ARRAY' && Array.isArray(parsed)) return parsed;
  throw new GateIoReadTransportError(
    'GATEIO_READ_RESPONSE_INVALID', validated.endpoint, httpStatus, null,
  );
}

function responseSurfaceValid(value: unknown): value is GateIoReadResponse {
  if (!isRecord(value)) return false;
  return typeof value.ok === 'boolean'
    && safeStatus(value.status) !== null
    && typeof value.text === 'function';
}

function createReadTransport(
  fetchImpl: GateIoReadFetch, environment: 'live' | 'testnet',
  budget: GateIoG3RunBudget | null,
): GateIoReadTransport {
  if (typeof fetchImpl !== 'function') fail('GATEIO_READ_REQUEST_INVALID');
  const origin = environment === 'testnet' ? GATEIO_L0_TESTNET_ORIGIN : GATEIO_L0_LIVE_ORIGIN;
  const counters: GateIoRequestCounters = {
    total: 0,
    byEndpoint: new Map<string, number>(),
    sequence: [],
  };
  const transport = {
    async get(request: GateIoReadTransportRequest): Promise<unknown> {
      const validated = validateRequest(request);
      const url = validated.canonicalQuery.length === 0
        ? `${origin}${validated.endpoint}`
        : `${origin}${validated.endpoint}?${validated.canonicalQuery}`;
      const headers = authenticatedHeaders(validated);
      budget?.consumeReadRequest();
      counters.total += 1;
      counters.byEndpoint.set(
        validated.endpoint,
        (counters.byEndpoint.get(validated.endpoint) ?? 0) + 1,
      );
      counters.sequence.push(validated.endpoint);
      let response: GateIoReadResponse;
      try {
        response = await fetchImpl(url, Object.freeze({
          method: GATEIO_V4_L0_SIGNED_METHOD,
          redirect: 'error',
          ...(headers === null ? {} : { headers }),
        }));
      } catch {
        throw new GateIoReadTransportError(
          'GATEIO_READ_NETWORK_FAILED', validated.endpoint, null, null,
        );
      }
      if (!responseSurfaceValid(response)) {
        throw new GateIoReadTransportError(
          'GATEIO_READ_RESPONSE_INVALID', validated.endpoint, null, null,
        );
      }
      let text: string;
      try {
        text = await readBoundedResponseText(response, validated.endpoint);
      } catch (error) {
        if (error instanceof GateIoReadTransportError) throw error;
        throw new GateIoReadTransportError(
          'GATEIO_READ_RESPONSE_INVALID', validated.endpoint, safeStatus(response.status), null,
        );
      }
      let parsed: unknown;
      try {
        parsed = validated.endpoint === GATEIO_READ_ENDPOINTS.MY_TRADES
          ? parseGateIoRecentTrades(text) : JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new GateIoReadTransportError(
            'GATEIO_READ_HTTP_FAILED', validated.endpoint, response.status, null,
          );
        }
        throw new GateIoReadTransportError(
          'GATEIO_READ_RESPONSE_INVALID', validated.endpoint, response.status, null,
        );
      }
      const label = safeLabel(parsed);
      if (label !== null) {
        throw new GateIoReadTransportError(
          'GATEIO_READ_API_REJECTED', validated.endpoint, response.status, label,
        );
      }
      if (!response.ok) {
        throw new GateIoReadTransportError(
          'GATEIO_READ_HTTP_FAILED', validated.endpoint, response.status, null,
        );
      }
      return normalizeSuccessfulResponse(validated, parsed, response.status);
    },
  };
  const frozen = Object.freeze(transport);
  REQUEST_COUNTERS.set(frozen, counters);
  TRANSPORT_ENVIRONMENTS.set(frozen, environment);
  if (budget !== null) TRANSPORT_BUDGETS.set(frozen, budget);
  return frozen;
}

/** Simulation/test constructor. An injected fetch can never receive production provenance. */
export function createGateIoReadTransport(fetchImpl: GateIoReadFetch): GateIoReadTransport {
  return createReadTransport(fetchImpl, 'live', null);
}

/** Explicit TestNet binding; the same L0 validation, signer and parser own every GET. */
export function createGateIoTestnetReadTransport(
  fetchImpl: GateIoReadFetch, budget: GateIoG3RunBudget,
): GateIoReadTransport {
  if (!(budget instanceof GateIoG3RunBudget)) fail('GATEIO_READ_REQUEST_INVALID');
  return createReadTransport(fetchImpl, 'testnet', budget);
}

/** Closed production constructor: binds ambient fetch, performs zero I/O, accepts no fetch argument. */
export function createProductionGateIoReadTransport(): GateIoProductionReadTransport {
  if (typeof globalThis.fetch !== 'function') fail('GATEIO_READ_REQUEST_INVALID');
  const transport = createReadTransport(globalThis.fetch.bind(globalThis) as GateIoReadFetch, 'live', null);
  PRODUCTION_TRANSPORTS.add(transport);
  return transport as GateIoProductionReadTransport;
}

export function hasProductionGateIoReadTransportProvenance(
  value: unknown,
): value is GateIoProductionReadTransport {
  return typeof value === 'object' && value !== null && PRODUCTION_TRANSPORTS.has(value);
}

export function gateIoReadTransportEnvironment(value: unknown): 'live' | 'testnet' | null {
  return typeof value === 'object' && value !== null
    ? TRANSPORT_ENVIRONMENTS.get(value) ?? null : null;
}

export function gateIoReadTransportBudget(value: unknown): GateIoG3RunBudget | null {
  return typeof value === 'object' && value !== null
    ? TRANSPORT_BUDGETS.get(value) ?? null : null;
}

export interface GateIoReadRequestCount {
  readonly total: number;
  readonly byEndpoint: Readonly<Record<string, number>>;
}

export function getGateIoReadRequestCount(transport: unknown): GateIoReadRequestCount | null {
  if (typeof transport !== 'object' || transport === null) return null;
  const counters = REQUEST_COUNTERS.get(transport);
  if (counters === undefined) return null;
  return Object.freeze({
    total: counters.total,
    byEndpoint: Object.freeze(Object.fromEntries(counters.byEndpoint)),
  });
}

export function getGateIoReadRequestSequence(
  transport: unknown,
): readonly GateIoReadEndpoint[] | null {
  if (typeof transport !== 'object' || transport === null) return null;
  const counters = REQUEST_COUNTERS.get(transport);
  if (counters === undefined) return null;
  return Object.freeze([...counters.sequence]);
}

export { GATEIO_L0_LIVE_ORIGIN, GATEIO_READ_ENDPOINTS };
