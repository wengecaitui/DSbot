/**
 * Bitget L0 read contracts.
 *
 * Closed vocabulary for the Bitget authenticated-read foundation: the single production origin,
 * the GET-only read endpoint allowlist and the deterministic canonical query serializer that both
 * the signature preimage and the emitted request URL are built from.
 *
 * Nothing in this module performs I/O, reads the environment or holds credentials.
 */

export const BITGET_L0_PRODUCTION_ORIGIN = 'https://api.bitget.com' as const;

export const PRODUCT_TYPE_USDT_FUTURES = 'USDT-FUTURES' as const;

/**
 * Endpoint allowlist confirmed by existing repository facts (the audited Bitget reference client)
 * and the official Bitget V2 contract. Anything not confirmed is deliberately absent and must be
 * verified in L1A before it can be used; see BITGET_READ_ENDPOINTS_REQUIRING_L1A_VERIFICATION.
 */
export const BITGET_READ_ENDPOINTS = Object.freeze({
  SERVER_TIME: '/api/v2/public/time',
  MIX_TICKERS: '/api/v2/mix/market/tickers',
  MIX_ACCOUNTS: '/api/v2/mix/account/accounts',
  MIX_POSITIONS: '/api/v2/mix/position/all',
} as const);

export type BitgetReadEndpoint =
  typeof BITGET_READ_ENDPOINTS[keyof typeof BITGET_READ_ENDPOINTS];

/** Candidate endpoint families deferred to L1A; NOT callable in L0. */
export const BITGET_READ_ENDPOINTS_REQUIRING_L1A_VERIFICATION: readonly string[] = Object.freeze([
  '/api/v2/mix/market/contracts',
  '/api/v2/mix/order/orders-pending',
  '/api/v2/mix/order/fills',
  '/api/v2/mix/order/detail',
  '/api/v2/mix/account/account',
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
  /** Explicitly injected millisecond timestamp string; L0 never reads a clock. */
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
    [BITGET_READ_ENDPOINTS.MIX_TICKERS]: Object.freeze({
      kind: 'PUBLIC_READ' as const,
      required: Object.freeze(['productType']),
      optional: Object.freeze(['symbol']),
    }),
    [BITGET_READ_ENDPOINTS.MIX_ACCOUNTS]: Object.freeze({
      kind: 'AUTHENTICATED_READ' as const,
      required: Object.freeze(['productType']),
      optional: Object.freeze(['marginCoin']),
    }),
    [BITGET_READ_ENDPOINTS.MIX_POSITIONS]: Object.freeze({
      kind: 'AUTHENTICATED_READ' as const,
      required: Object.freeze(['productType']),
      optional: Object.freeze(['symbol', 'marginCoin']),
    }),
  });

const QUERY_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,24}$/;
const MARGIN_COIN_PATTERN = /^[A-Z0-9]{2,10}$/;

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
 * RFC 3986 percent encoding: encodeURIComponent leaves !'()* unescaped, which is not canonical
 * for a query component, so those are escaped explicitly.
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
  if (name === 'productType') return value === PRODUCT_TYPE_USDT_FUTURES;
  if (name === 'symbol') return SYMBOL_PATTERN.test(value);
  if (name === 'marginCoin') return MARGIN_COIN_PATTERN.test(value);
  void endpoint;
  return false;
}

export const BITGET_READ_TIMESTAMP_PATTERN: RegExp = /^[0-9]{1,20}$/;
export const BITGET_READ_API_CODE_PATTERN: RegExp = /^[0-9]{1,8}$/;
export const BITGET_READ_SUCCESS_CODE = '00000' as const;
export const MAX_BITGET_ERROR_BODY_CHARACTERS = 4_096 as const;
