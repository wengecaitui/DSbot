/**
 * Gate.io API v4 L0 read contracts.
 *
 * This is a closed, GET-only vocabulary. Callers choose a typed endpoint and validated query
 * parameters; they cannot supply an origin, HTTP method, body or arbitrary path.
 */

export const GATEIO_L0_LIVE_ORIGIN = 'https://api.gateio.ws' as const;
export const GATEIO_L0_TESTNET_ORIGIN = 'https://api-testnet.gateapi.io' as const;
export const GATEIO_API_PREFIX = '/api/v4' as const;
export const GATEIO_L0_SETTLE = 'usdt' as const;
export const GATEIO_L0_INITIAL_CONTRACT = 'ETH_USDT' as const;

/** Futures wire negotiation only; not caller-controlled and not part of the v4 signature input. */
export const GATEIO_FUTURES_DECIMAL_SIZE_HEADERS = Object.freeze({
  'X-Gate-Size-Decimal': '1',
} as const);

export const GATEIO_READ_ENDPOINTS = Object.freeze({
  SERVER_TIME: '/api/v4/spot/time',
  CONTRACT: '/api/v4/futures/usdt/contracts/ETH_USDT',
  TICKERS: '/api/v4/futures/usdt/tickers',
  ACCOUNTS: '/api/v4/futures/usdt/accounts',
  POSITIONS: '/api/v4/futures/usdt/positions',
  OPEN_ORDERS: '/api/v4/futures/usdt/orders',
  MY_TRADES: '/api/v4/futures/usdt/my_trades',
  ACCOUNT_BOOK: '/api/v4/futures/usdt/account_book',
} as const);

export type GateIoReadEndpoint =
  typeof GATEIO_READ_ENDPOINTS[keyof typeof GATEIO_READ_ENDPOINTS];

export type GateIoReadKind = 'PUBLIC_READ' | 'AUTHENTICATED_READ';

export interface GateIoQueryParameter {
  readonly name: string;
  readonly value: string;
}

/** One bounded account-book page request. It is not evidence of historical completeness. */
export interface GateIoAccountBookPageRequest {
  readonly contract?: string;
  readonly limit?: number;
  readonly offset?: number;
  /** Exact int64 Unix-seconds text; never routed through a JS binary number. */
  readonly from?: string;
  /** Exact int64 Unix-seconds text; never routed through a JS binary number. */
  readonly to?: string;
  readonly type?: string;
}

export interface GateIoReadCredential {
  readonly apiKey: string;
  readonly secretKey: string;
}

/** Origin, method and body are deliberately absent from the caller-controlled request. */
export interface GateIoReadTransportRequest {
  readonly endpoint: GateIoReadEndpoint;
  readonly query: readonly GateIoQueryParameter[];
  readonly credential?: GateIoReadCredential;
  /** Explicit Unix-seconds timestamp. The transport never discovers or reads a hidden clock. */
  readonly timestamp?: string;
}

export interface GateIoReadTransport {
  get(request: GateIoReadTransportRequest): Promise<unknown>;
}

export interface GateIoEndpointContract {
  readonly kind: GateIoReadKind;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly responseShape: 'SERVER_TIME' | 'OBJECT' | 'ARRAY';
}

export const GATEIO_READ_ENDPOINT_CONTRACTS: Readonly<
Record<GateIoReadEndpoint, GateIoEndpointContract>
> = Object.freeze({
  [GATEIO_READ_ENDPOINTS.SERVER_TIME]: Object.freeze({
    kind: 'PUBLIC_READ' as const,
    required: Object.freeze([]),
    optional: Object.freeze([]),
    responseShape: 'SERVER_TIME' as const,
  }),
  [GATEIO_READ_ENDPOINTS.CONTRACT]: Object.freeze({
    kind: 'PUBLIC_READ' as const,
    required: Object.freeze([]),
    optional: Object.freeze([]),
    responseShape: 'OBJECT' as const,
  }),
  [GATEIO_READ_ENDPOINTS.TICKERS]: Object.freeze({
    kind: 'PUBLIC_READ' as const,
    required: Object.freeze(['contract']),
    optional: Object.freeze([]),
    responseShape: 'ARRAY' as const,
  }),
  [GATEIO_READ_ENDPOINTS.ACCOUNTS]: Object.freeze({
    kind: 'AUTHENTICATED_READ' as const,
    required: Object.freeze([]),
    optional: Object.freeze([]),
    responseShape: 'OBJECT' as const,
  }),
  [GATEIO_READ_ENDPOINTS.POSITIONS]: Object.freeze({
    kind: 'AUTHENTICATED_READ' as const,
    required: Object.freeze([]),
    optional: Object.freeze([]),
    responseShape: 'ARRAY' as const,
  }),
  [GATEIO_READ_ENDPOINTS.OPEN_ORDERS]: Object.freeze({
    kind: 'AUTHENTICATED_READ' as const,
    required: Object.freeze(['status']),
    optional: Object.freeze(['contract']),
    responseShape: 'ARRAY' as const,
  }),
  [GATEIO_READ_ENDPOINTS.MY_TRADES]: Object.freeze({
    kind: 'AUTHENTICATED_READ' as const,
    required: Object.freeze(['contract']),
    optional: Object.freeze([]),
    responseShape: 'ARRAY' as const,
  }),
  [GATEIO_READ_ENDPOINTS.ACCOUNT_BOOK]: Object.freeze({
    kind: 'AUTHENTICATED_READ' as const,
    required: Object.freeze([]),
    optional: Object.freeze(['contract', 'limit', 'offset', 'from', 'to', 'type']),
    responseShape: 'ARRAY' as const,
  }),
});

const QUERY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** Current Gate v4 signed timestamp range in Unix seconds; millisecond values are rejected. */
export const GATEIO_TIMESTAMP_PATTERN: RegExp = /^[0-9]{1,10}$/;
export const GATEIO_SAFE_LABEL_PATTERN: RegExp = /^[A-Z][A-Z0-9_]{0,63}$/;

export class GateIoReadContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GateIoReadContractError';
  }
}

function fail(code: string): never {
  throw new GateIoReadContractError(code);
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** One canonical serializer supplies both emitted and signed query bytes. */
export function canonicalGateIoQuery(parameters: readonly GateIoQueryParameter[]): string {
  if (!Array.isArray(parameters)) fail('GATEIO_READ_QUERY_INVALID');
  const values = new Map<string, string>();
  for (const parameter of parameters) {
    if (typeof parameter !== 'object' || parameter === null) fail('GATEIO_READ_QUERY_INVALID');
    const { name, value } = parameter as GateIoQueryParameter;
    if (typeof name !== 'string' || !QUERY_NAME_PATTERN.test(name)) {
      fail('GATEIO_READ_QUERY_INVALID');
    }
    if (typeof value !== 'string' || value.length === 0 || values.has(name)) {
      fail('GATEIO_READ_QUERY_INVALID');
    }
    values.set(name, value);
  }
  return [...values.keys()]
    .sort(compareNames)
    .map((name) => `${encodeComponent(name)}=${encodeComponent(values.get(name) ?? '')}`)
    .join('&');
}

export function gateIoEndpointContract(endpoint: unknown): GateIoEndpointContract | null {
  if (typeof endpoint !== 'string') return null;
  const contracts = GATEIO_READ_ENDPOINT_CONTRACTS as Readonly<
  Record<string, GateIoEndpointContract>
  >;
  return Object.prototype.hasOwnProperty.call(contracts, endpoint) ? contracts[endpoint] ?? null : null;
}

const GATEIO_ACCOUNT_BOOK_INT64_MAX = '9223372036854775807';
const GATEIO_ACCOUNT_BOOK_INT64_MIN = '-9223372036854775808';

function int64Text(value: string): boolean {
  if (!/^-?[0-9]{1,19}$/.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed >= BigInt(GATEIO_ACCOUNT_BOOK_INT64_MIN)
      && parsed <= BigInt(GATEIO_ACCOUNT_BOOK_INT64_MAX);
  } catch {
    return false;
  }
}

function safeAccountBookText(value: string): boolean {
  return value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function gateIoQueryValueValid(
  endpoint: GateIoReadEndpoint,
  name: string,
  value: string,
): boolean {
  if (name === 'contract') {
    return endpoint === GATEIO_READ_ENDPOINTS.ACCOUNT_BOOK
      ? GATEIO_SAFE_LABEL_PATTERN.test(value)
      : value === GATEIO_L0_INITIAL_CONTRACT;
  }
  if (name === 'status') return value === 'open';
  if (endpoint !== GATEIO_READ_ENDPOINTS.ACCOUNT_BOOK) return false;
  if (name === 'limit') {
    return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
  }
  if (name === 'offset') {
    return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value));
  }
  if (name === 'from' || name === 'to') return int64Text(value);
  if (name === 'type') return safeAccountBookText(value);
  return false;
}

/** Deterministic DTO validation/serialization for exactly one account-book page. */
export function gateIoAccountBookPageQuery(
  request: GateIoAccountBookPageRequest,
): readonly GateIoQueryParameter[] {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    fail('GATEIO_ACCOUNT_BOOK_QUERY_INVALID');
  }
  const raw = request as Record<string, unknown>;
  const allowed = new Set(['contract', 'limit', 'offset', 'from', 'to', 'type']);
  if (Object.keys(raw).some((name) => !allowed.has(name))) {
    fail('GATEIO_ACCOUNT_BOOK_QUERY_INVALID');
  }
  const entries: GateIoQueryParameter[] = [];
  const add = (name: keyof GateIoAccountBookPageRequest, value: string): void => {
    if (!gateIoQueryValueValid(GATEIO_READ_ENDPOINTS.ACCOUNT_BOOK, name, value)) {
      fail('GATEIO_ACCOUNT_BOOK_QUERY_INVALID');
    }
    entries.push(Object.freeze({ name, value }));
  };
  if (request.contract !== undefined) {
    if (typeof request.contract !== 'string') fail('GATEIO_ACCOUNT_BOOK_QUERY_INVALID');
    add('contract', request.contract);
  }
  if (request.from !== undefined) {
    if (typeof request.from !== 'string') fail('GATEIO_ACCOUNT_BOOK_QUERY_INVALID');
    add('from', request.from);
  }
  if (request.limit !== undefined) {
    if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
      fail('GATEIO_ACCOUNT_BOOK_QUERY_INVALID');
    }
    add('limit', String(request.limit));
  }
  if (request.offset !== undefined) {
    if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
      fail('GATEIO_ACCOUNT_BOOK_QUERY_INVALID');
    }
    add('offset', String(request.offset));
  }
  if (request.to !== undefined) {
    if (typeof request.to !== 'string') fail('GATEIO_ACCOUNT_BOOK_QUERY_INVALID');
    add('to', request.to);
  }
  if (request.type !== undefined) {
    if (typeof request.type !== 'string') fail('GATEIO_ACCOUNT_BOOK_QUERY_INVALID');
    add('type', request.type);
  }
  return Object.freeze(entries);
}

/** Freeze the exact request facts that will be serialized and later attached as capture provenance. */
export function normalizeGateIoAccountBookPageRequest(
  request: GateIoAccountBookPageRequest,
): Readonly<GateIoAccountBookPageRequest> {
  const query = gateIoAccountBookPageQuery(request);
  const normalized: {
    contract?: string;
    from?: string;
    limit?: number;
    offset?: number;
    to?: string;
    type?: string;
  } = {};
  for (const { name, value } of query) {
    if (name === 'limit' || name === 'offset') normalized[name] = Number(value);
    else if (name === 'contract' || name === 'from' || name === 'to' || name === 'type') {
      normalized[name] = value;
    }
  }
  return Object.freeze(normalized);
}

export function gateIoTimestampValid(value: unknown): value is string {
  if (typeof value !== 'string' || !GATEIO_TIMESTAMP_PATTERN.test(value)) return false;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0;
}

/** Strict Gate international server-time normalization. No malformed value becomes zero. */
export function normalizeGateIoServerTime(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[0-9]{1,20}$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('GATEIO_SERVER_TIME_INVALID');
  return parsed;
}
