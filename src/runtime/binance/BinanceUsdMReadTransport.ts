export const BINANCE_USDM_BASE_ORIGIN = 'https://fapi.binance.com' as const;

export const BINANCE_USDM_READ_ENDPOINTS = Object.freeze({
  SERVER_TIME: '/fapi/v1/time',
  ACCOUNT: '/fapi/v3/account',
  OPEN_ORDERS: '/fapi/v1/openOrders',
  USER_TRADES: '/fapi/v1/userTrades',
  MARK_PRICE: '/fapi/v1/premiumIndex',
  EXCHANGE_INFO: '/fapi/v1/exchangeInfo',
} as const);

export type BinanceUsdMReadEndpoint =
  typeof BINANCE_USDM_READ_ENDPOINTS[keyof typeof BINANCE_USDM_READ_ENDPOINTS];

export interface BinanceUsdMQueryParameter {
  readonly name: string;
  readonly value: string;
}

/** Closed transport request: origin and HTTP method are intentionally not caller-controlled. */
export interface BinanceUsdMReadTransportRequest {
  readonly endpoint: BinanceUsdMReadEndpoint;
  readonly query: readonly BinanceUsdMQueryParameter[];
  readonly apiKey?: string;
}

export interface BinanceUsdMReadTransport {
  get(request: BinanceUsdMReadTransportRequest): Promise<unknown>;
}

declare const BINANCE_USDM_PRODUCTION_TRANSPORT: unique symbol;

/** Nominal capability returned only by the closed production constructor. */
export interface BinanceUsdMProductionReadTransport extends BinanceUsdMReadTransport {
  readonly [BINANCE_USDM_PRODUCTION_TRANSPORT]: true;
}

export type BinanceUsdMFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export class BinanceUsdMReadTransportError extends Error {
  constructor(readonly code: string, readonly status: number | null = null) {
    super(code);
    this.name = 'BinanceUsdMReadTransportError';
  }
}

const ALLOWED_ENDPOINTS = new Set<string>(Object.values(BINANCE_USDM_READ_ENDPOINTS));
const PRODUCTION_TRANSPORTS = new WeakSet<object>();
const SECURE_ENDPOINTS = new Set<BinanceUsdMReadEndpoint>([
  BINANCE_USDM_READ_ENDPOINTS.ACCOUNT,
  BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS,
  BINANCE_USDM_READ_ENDPOINTS.USER_TRADES,
]);

function validQueryParameter(value: unknown): value is BinanceUsdMQueryParameter {
  return typeof value === 'object' && value !== null
    && typeof (value as BinanceUsdMQueryParameter).name === 'string'
    && (value as BinanceUsdMQueryParameter).name.length > 0
    && typeof (value as BinanceUsdMQueryParameter).value === 'string';
}

function validateRequest(request: BinanceUsdMReadTransportRequest): void {
  if (!request || !ALLOWED_ENDPOINTS.has(request.endpoint)
      || !Array.isArray(request.query) || !request.query.every(validQueryParameter)
      || (request.apiKey !== undefined && request.apiKey.length === 0)) {
    throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_REQUEST_INVALID');
  }
  const byName = new Map(request.query.map((entry) => [entry.name, entry.value]));
  if (byName.size !== request.query.length) {
    throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_REQUEST_INVALID');
  }
  const exactNames = (expected: readonly string[]) =>
    byName.size === expected.length && expected.every((name) => byName.has(name));
  const secure = SECURE_ENDPOINTS.has(request.endpoint);
  if (secure !== (request.apiKey !== undefined)) {
    throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_REQUEST_INVALID');
  }
  if (secure && (!exactNames(request.endpoint === BINANCE_USDM_READ_ENDPOINTS.ACCOUNT
    ? ['recvWindow', 'signature', 'timestamp']
    : request.endpoint === BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS
      ? ['recvWindow', 'signature', 'symbol', 'timestamp']
      : ['limit', 'recvWindow', 'signature', 'symbol', 'timestamp'])
    || !/^[a-f0-9]{64}$/.test(byName.get('signature') ?? '')
    || !/^[0-9]+$/.test(byName.get('timestamp') ?? '')
    || !/^[0-9]+$/.test(byName.get('recvWindow') ?? '')
    || Number(byName.get('recvWindow')) > 60_000)) {
    throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_REQUEST_INVALID');
  }
  if (request.endpoint === BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME
      || request.endpoint === BINANCE_USDM_READ_ENDPOINTS.EXCHANGE_INFO) {
    if (!exactNames([])) throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_REQUEST_INVALID');
  } else if (request.endpoint === BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE) {
    if (!exactNames(['symbol'])) throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_REQUEST_INVALID');
  }
  if ((request.endpoint === BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS
      || request.endpoint === BINANCE_USDM_READ_ENDPOINTS.USER_TRADES
      || request.endpoint === BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE)
      && !/^[A-Z0-9]{2,24}$/.test(byName.get('symbol') ?? '')) {
    throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_REQUEST_INVALID');
  }
  if (request.endpoint === BINANCE_USDM_READ_ENDPOINTS.USER_TRADES
      && (!/^[0-9]+$/.test(byName.get('limit') ?? '') || Number(byName.get('limit')) <= 0)) {
    throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_REQUEST_INVALID');
  }
}

function createReadTransport(fetchImpl: BinanceUsdMFetch): BinanceUsdMReadTransport {
  return Object.freeze({
    async get(request: BinanceUsdMReadTransportRequest): Promise<unknown> {
      validateRequest(request);
      const url = new URL(request.endpoint, BINANCE_USDM_BASE_ORIGIN);
      for (const parameter of request.query) {
        url.searchParams.append(parameter.name, parameter.value);
      }
      const headers = request.apiKey === undefined
        ? undefined
        : Object.freeze({ 'X-MBX-APIKEY': request.apiKey });
      let response: Pick<Response, 'ok' | 'status' | 'json'>;
      try {
        response = await fetchImpl(url, Object.freeze({
          method: 'GET',
          redirect: 'error',
          ...(headers ? { headers } : {}),
        }));
      } catch {
        throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_NETWORK_FAILED');
      }
      if (!response.ok) {
        throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_HTTP_FAILED', response.status);
      }
      try {
        return await response.json();
      } catch {
        throw new BinanceUsdMReadTransportError('BINANCE_USDM_READ_RESPONSE_INVALID');
      }
    },
  });
}

/** Injectable transport for simulation and deterministic tests; it carries no production provenance. */
export function createBinanceUsdMReadTransport(
  fetchImpl: BinanceUsdMFetch,
): BinanceUsdMReadTransport {
  return createReadTransport(fetchImpl);
}

/**
 * Closed production capability. Construction performs no I/O and accepts no caller-supplied transport.
 * Membership is held out-of-band so structural lookalikes and caller booleans cannot forge it.
 */
export function createProductionBinanceUsdMReadTransport(): BinanceUsdMProductionReadTransport {
  const transport = createReadTransport(globalThis.fetch.bind(globalThis));
  PRODUCTION_TRANSPORTS.add(transport);
  return transport as BinanceUsdMProductionReadTransport;
}

export function hasProductionBinanceUsdMReadTransportProvenance(
  value: unknown,
): value is BinanceUsdMProductionReadTransport {
  return typeof value === 'object' && value !== null && PRODUCTION_TRANSPORTS.has(value);
}
