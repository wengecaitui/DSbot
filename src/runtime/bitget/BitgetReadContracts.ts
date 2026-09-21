/**
 * Bitget read contracts (L0 transport boundary + L1A read vocabulary).
 *
 * The endpoint allowlist is the single source of truth for what the transport may call. Endpoints
 * that are known to be drifted or unverified are declared separately and are NOT callable.
 *
 * Nothing in this module performs I/O, reads the environment or holds credentials.
 *
 * ENDPOINT PROVENANCE: the allowlist below follows the Architecture Gatekeeper's mandated
 * current-contract set for Bitget Classic/USDT-FUTURES. This host cannot reach www.bitget.com or
 * docs.bitget.com (connections fail) and the available text proxy returned only 404 templates, so
 * the official documentation could NOT be independently re-fetched during this phase; the endpoint
 * facts are therefore reported as mandate-sourced, not doc-verified. See the phase report.
 */

export const BITGET_L0_PRODUCTION_ORIGIN = 'https://api.bitget.com' as const;

export const BITGET_L1A_PRODUCT_TYPE = 'USDT-FUTURES' as const;
export const BITGET_L1A_MARGIN_COIN = 'USDT' as const;
export const BITGET_L1A_INITIAL_SYMBOL = 'ETHUSDT' as const;
export const BITGET_L1A_SCHEMA_VERSION = 'BITGET_L1A_V1' as const;
/** Product-type alias kept for the L0 transport suite and older call sites. */
export const PRODUCT_TYPE_USDT_FUTURES = BITGET_L1A_PRODUCT_TYPE;

/** Callable GET read endpoints. Closed vocabulary: the transport rejects anything else. */
export const BITGET_READ_ENDPOINTS = Object.freeze({
  SERVER_TIME: '/api/v2/public/time',
  CONTRACTS: '/api/v2/mix/market/contracts',
  SYMBOL_PRICE: '/api/v2/mix/market/symbol-price',
  ACCOUNTS: '/api/v2/mix/account/accounts',
  POSITIONS: '/api/v2/mix/position/all-position',
  PENDING_ORDERS: '/api/v2/mix/order/orders-pending',
  FILLS: '/api/v2/mix/order/fills',
} as const);

export type BitgetReadEndpoint =
  typeof BITGET_READ_ENDPOINTS[keyof typeof BITGET_READ_ENDPOINTS];

/**
 * Endpoints that must never be called from this codebase. `/api/v2/mix/position/all` was the
 * previous (drifted) value and `/api/v2/mix/market/tickers` is the superseded market endpoint;
 * they are retained here only so tests can prove they are rejected.
 */
export const BITGET_DRIFTED_ENDPOINTS = Object.freeze({
  MIX_POSITION_ALL: '/api/v2/mix/position/all',
  MIX_TICKERS: '/api/v2/mix/market/tickers',
} as const);

/** Read families that exist upstream but are not required by the L1A snapshot: NOT callable. */
export const BITGET_READ_ENDPOINTS_REQUIRING_L1A_VERIFICATION: readonly string[] = Object.freeze([
  '/api/v2/mix/order/detail',
  '/api/v2/mix/order/history-orders',
  '/api/v2/mix/position/history-position',
]);

export type BitgetReadKind = 'PUBLIC_READ' | 'AUTHENTICATED_READ';

export interface BitgetQueryParameter {
  readonly name: string;
  readonly value: string;
}

export interface BitgetReadCredential {
  readonly apiKey: string;
  readonly secretKey: string;
  readonly passphrase: string;
}

/** Closed transport request: origin, HTTP method and body are intentionally not caller-controlled. */
export interface BitgetReadTransportRequest {
  readonly endpoint: BitgetReadEndpoint;
  readonly query: readonly BitgetQueryParameter[];
  readonly credential?: BitgetReadCredential;
  /** Explicitly injected millisecond timestamp string; the client never reads a hidden clock. */
  readonly timestamp?: string;
}

export interface BitgetReadTransport {
  get(request: BitgetReadTransportRequest): Promise<unknown>;
}

export interface BitgetEndpointContract {
  readonly kind: BitgetReadKind;
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export const BITGET_READ_ENDPOINT_CONTRACTS: Readonly<Record<BitgetReadEndpoint, BitgetEndpointContract>> =
  Object.freeze({
    [BITGET_READ_ENDPOINTS.SERVER_TIME]: Object.freeze({
      kind: 'PUBLIC_READ' as const, required: Object.freeze([]), optional: Object.freeze([]),
    }),
    [BITGET_READ_ENDPOINTS.CONTRACTS]: Object.freeze({
      kind: 'PUBLIC_READ' as const,
      required: Object.freeze(['productType']),
      optional: Object.freeze(['symbol']),
    }),
    [BITGET_READ_ENDPOINTS.SYMBOL_PRICE]: Object.freeze({
      kind: 'PUBLIC_READ' as const,
      required: Object.freeze(['productType', 'symbol']),
      optional: Object.freeze([]),
    }),
    [BITGET_READ_ENDPOINTS.ACCOUNTS]: Object.freeze({
      kind: 'AUTHENTICATED_READ' as const,
      required: Object.freeze(['productType']),
      optional: Object.freeze(['marginCoin']),
    }),
    [BITGET_READ_ENDPOINTS.POSITIONS]: Object.freeze({
      kind: 'AUTHENTICATED_READ' as const,
      required: Object.freeze(['productType']),
      optional: Object.freeze(['marginCoin']),
    }),
    [BITGET_READ_ENDPOINTS.PENDING_ORDERS]: Object.freeze({
      kind: 'AUTHENTICATED_READ' as const,
      required: Object.freeze(['productType']),
      optional: Object.freeze(['symbol']),
    }),
    [BITGET_READ_ENDPOINTS.FILLS]: Object.freeze({
      kind: 'AUTHENTICATED_READ' as const,
      required: Object.freeze(['productType']),
      optional: Object.freeze(['symbol', 'limit']),
    }),
  });

const QUERY_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,24}$/;
const LIMIT_PATTERN = /^[0-9]{1,3}$/;

export class BitgetReadContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BitgetReadContractError';
  }
}

function fail(code: string): never {
  throw new BitgetReadContractError(code);
}

/**
 * RFC 3986 percent encoding: encodeURIComponent leaves !'()* unescaped, which is not canonical for a
 * query component, so those are escaped explicitly.
 */
function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Byte-order comparison so ordering never depends on the host locale. */
function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Deterministic canonical query: stable key ordering, strict encoding, no silent coercion.
 * `undefined`/`null`/numeric/array/object values are contract violations rather than empty strings.
 */
export function canonicalBitgetQuery(parameters: readonly BitgetQueryParameter[]): string {
  if (!Array.isArray(parameters)) fail('BITGET_READ_QUERY_INVALID');
  const values = new Map<string, string>();
  for (const parameter of parameters) {
    if (typeof parameter !== 'object' || parameter === null) fail('BITGET_READ_QUERY_INVALID');
    const { name, value } = parameter as BitgetQueryParameter;
    if (typeof name !== 'string' || !QUERY_NAME_PATTERN.test(name)) fail('BITGET_READ_QUERY_INVALID');
    if (typeof value !== 'string' || value.length === 0) fail('BITGET_READ_QUERY_INVALID');
    if (values.has(name)) fail('BITGET_READ_QUERY_INVALID');
    values.set(name, value);
  }
  const ordered = [...values.keys()].sort(compareNames);
  return ordered.map((name) => `${encodeComponent(name)}=${encodeComponent(values.get(name) ?? '')}`).join('&');
}

export function bitgetEndpointContract(endpoint: unknown): BitgetEndpointContract | null {
  if (typeof endpoint !== 'string') return null;
  const contracts = BITGET_READ_ENDPOINT_CONTRACTS as Readonly<Record<string, BitgetEndpointContract>>;
  return Object.prototype.hasOwnProperty.call(contracts, endpoint) ? contracts[endpoint] ?? null : null;
}

/** Per-endpoint value validation. Unknown parameter names are rejected, not silently forwarded. */
export function bitgetQueryValueValid(endpoint: BitgetReadEndpoint, name: string, value: string): boolean {
  void endpoint;
  if (name === 'productType') return value === BITGET_L1A_PRODUCT_TYPE;
  if (name === 'marginCoin') return value === BITGET_L1A_MARGIN_COIN;
  if (name === 'symbol') return SYMBOL_PATTERN.test(value);
  if (name === 'limit') return LIMIT_PATTERN.test(value) && Number(value) >= 1 && Number(value) <= 100;
  return false;
}

export const BITGET_READ_TIMESTAMP_PATTERN: RegExp = /^[0-9]{1,20}$/;
export const BITGET_READ_API_CODE_PATTERN: RegExp = /^[0-9]{1,8}$/;
export const BITGET_READ_SUCCESS_CODE = '00000' as const;
export const MAX_BITGET_ERROR_BODY_CHARACTERS = 4_096 as const;

// ── L1A read result vocabulary ──────────────────────────────────────────────────────────────────

export type BitgetReadAvailability = 'AVAILABLE' | 'UNKNOWN' | 'UNAVAILABLE';
export type BitgetReadFreshness = 'FRESH' | 'STALE' | 'UNKNOWN';

/** Fail-closed reason vocabulary. Never collapse these into a single generic failure. */
export type BitgetReadFailureReason =
  | 'BITGET_AUTH_READ_NOT_CONFIGURED'
  | 'BITGET_READ_CREDENTIALS_UNAVAILABLE'
  | 'BITGET_READ_CLIENT_UNAVAILABLE'
  | 'BITGET_READ_TRANSPORT_FAILED'
  | 'BITGET_READ_API_REJECTED'
  | 'BITGET_SERVER_TIME_INVALID'
  | 'BITGET_CLOCK_SKEW_INVALID'
  | 'ACCOUNT_TRUTH_MISSING'
  | 'ACCOUNT_TRUTH_MALFORMED'
  | 'POSITION_TRUTH_MALFORMED'
  | 'POSITION_TRUTH_UNKNOWN'
  | 'OPEN_ORDERS_MALFORMED'
  | 'FILLS_MALFORMED'
  | 'MARK_PRICE_UNKNOWN'
  | 'MARK_PRICE_STALE'
  | 'MARKET_RULES_UNKNOWN'
  | 'CONTRACT_NOT_OPENABLE'
  | 'INSTRUMENT_FACTS_MALFORMED'
  | 'OBSERVATION_TIME_INVALID'
  | 'OBSERVATION_TIME_FUTURE';

/**
 * Result envelope. `UNKNOWN` lives here, never inside a factual value: an unavailable or malformed
 * observation is `availability !== 'AVAILABLE'` with `value === null`, so it can never be mistaken
 * for a factual FLAT/zero state.
 */
export interface BitgetReadResult<T> {
  readonly availability: BitgetReadAvailability;
  readonly value: T | null;
  readonly reason: BitgetReadFailureReason | null;
}

export function availableBitget<T>(value: T): BitgetReadResult<T> {
  return Object.freeze({ availability: 'AVAILABLE' as const, value, reason: null });
}

export function unavailableBitget<T>(reason: BitgetReadFailureReason): BitgetReadResult<T> {
  return Object.freeze({ availability: 'UNAVAILABLE' as const, value: null, reason });
}

export function unknownBitget<T>(reason: BitgetReadFailureReason): BitgetReadResult<T> {
  return Object.freeze({ availability: 'UNKNOWN' as const, value: null, reason });
}
