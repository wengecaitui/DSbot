/**
 * Bitget authenticated read client (L1A).
 *
 * Built strictly on top of the L0 `BitgetReadTransport` - no second transport is created here.
 * Credentials are only ever taken from an explicitly injected object (or an injected provider
 * interface); this module contains no environment, dotenv or filesystem implementation.
 *
 * The surface is GET-read only: server time, contracts, symbol price, accounts, positions, pending
 * orders and fills. There is no place/cancel/modify/leverage/margin/position-mode method.
 */
import {
  BITGET_L1A_MARGIN_COIN,
  BITGET_L1A_PRODUCT_TYPE,
  BITGET_READ_ENDPOINTS,
  type BitgetQueryParameter,
  type BitgetReadCredential,
  type BitgetReadFailureReason,
  type BitgetReadTransport,
} from './BitgetReadContracts';
import { signedBitgetTimestamp, type BitgetReadClock } from './BitgetReadClock';

export const BITGET_L1A_FILL_LIMIT = 50 as const;
export const MAX_BITGET_FILL_LIMIT = 100 as const;

export interface BitgetReadIdentity {
  readonly exchange: 'bitget';
  readonly accountId: string;
}

/** Provider interface only: this phase ships no implementation that reads secrets from anywhere. */
export interface BitgetReadSecretProvider {
  getReadCredentials(identity: BitgetReadIdentity): Promise<BitgetReadCredential | null>;
}

export interface BitgetReadFillOptions {
  readonly symbol?: string;
  readonly limit?: number;
}

export interface BitgetAuthenticatedReadClient {
  getServerTime(): Promise<unknown>;
  getContracts(symbol?: string): Promise<unknown>;
  getSymbolPrice(symbol: string): Promise<unknown>;
  getAccounts(): Promise<unknown>;
  getPositions(): Promise<unknown>;
  getPendingOrders(symbol?: string): Promise<unknown>;
  getRecentFills(options?: BitgetReadFillOptions): Promise<unknown>;
}

export interface BitgetAuthenticatedReadClientOptions {
  readonly transport: BitgetReadTransport;
  /** Explicitly injected credential, or null when the client is not configured. */
  readonly credential: BitgetReadCredential | null;
  readonly clock: BitgetReadClock;
  /** Offset from a factual server-time observation: a fixed number or a live getter. */
  readonly serverTimeOffsetMs?: number | (() => number);
}

export class BitgetReadClientError extends Error {
  constructor(readonly reason: BitgetReadFailureReason) {
    super(reason);
    this.name = 'BitgetReadClientError';
  }
}

function fail(reason: BitgetReadFailureReason): never {
  throw new BitgetReadClientError(reason);
}

function productTypeParameter(): BitgetQueryParameter {
  return { name: 'productType', value: BITGET_L1A_PRODUCT_TYPE };
}

function requireCredential(credential: BitgetReadCredential | null): BitgetReadCredential {
  if (credential === null) fail('BITGET_READ_CREDENTIALS_UNAVAILABLE');
  const { apiKey, secretKey, passphrase } = credential;
  if (typeof apiKey !== 'string' || apiKey.length === 0
      || typeof secretKey !== 'string' || secretKey.length === 0
      || typeof passphrase !== 'string' || passphrase.length === 0) {
    fail('BITGET_READ_CREDENTIALS_UNAVAILABLE');
  }
  return credential;
}

/**
 * Map an L0 transport failure onto an L1A reason. An exchange that answered and rejected the read is
 * reported as an API rejection rather than being collapsed into a transport failure.
 */
function transportFailureReason(error: unknown): BitgetReadFailureReason {
  const code = (error as { code?: string }).code;
  if (code === 'BITGET_READ_API_REJECTED' || code === 'BITGET_READ_HTTP_FAILED') {
    return 'BITGET_READ_API_REJECTED';
  }
  return 'BITGET_READ_TRANSPORT_FAILED';
}

/** Public reads carry no credential and no timestamp; the transport enforces that too. */
async function publicRead(
  transport: BitgetReadTransport,
  endpoint: Parameters<BitgetReadTransport['get']>[0]['endpoint'],
  query: readonly BitgetQueryParameter[],
): Promise<unknown> {
  try {
    return await transport.get({ endpoint, query });
  } catch (error) {
    fail(transportFailureReason(error));
  }
}

async function privateRead(
  transport: BitgetReadTransport,
  credential: BitgetReadCredential | null,
  clock: BitgetReadClock,
  serverTimeOffsetMs: number,
  endpoint: Parameters<BitgetReadTransport['get']>[0]['endpoint'],
  query: readonly BitgetQueryParameter[],
): Promise<unknown> {
  const injected = requireCredential(credential);
  // A clock/skew failure is reported as such rather than as a transport failure.
  let timestamp: string;
  try {
    timestamp = signedBitgetTimestamp(clock, serverTimeOffsetMs);
  } catch (error) {
    const reason = (error as { reason?: BitgetReadFailureReason }).reason;
    fail(reason ?? 'OBSERVATION_TIME_INVALID');
  }
  try {
    // The transport signs exactly this timestamp and sends it as ACCESS-TIMESTAMP.
    return await transport.get({ endpoint, query, credential: injected, timestamp });
  } catch (error) {
    fail(transportFailureReason(error));
  }
}

export function createBitgetAuthenticatedReadClient(
  options: BitgetAuthenticatedReadClientOptions,
): BitgetAuthenticatedReadClient {
  if (typeof options !== 'object' || options === null) fail('BITGET_READ_CLIENT_UNAVAILABLE');
  const { transport, credential, clock } = options;
  if (typeof transport !== 'object' || transport === null
      || typeof transport.get !== 'function') {
    fail('BITGET_READ_CLIENT_UNAVAILABLE');
  }
  if (typeof clock !== 'object' || clock === null || typeof clock.now !== 'function') {
    fail('BITGET_READ_CLIENT_UNAVAILABLE');
  }
  const offsetProvider = (): number => (typeof options.serverTimeOffsetMs === 'function'
    ? options.serverTimeOffsetMs()
    : (typeof options.serverTimeOffsetMs === 'number' ? options.serverTimeOffsetMs : 0));

  return Object.freeze({
    async getServerTime(): Promise<unknown> {
      return publicRead(transport, BITGET_READ_ENDPOINTS.SERVER_TIME, []);
    },
    async getContracts(symbol?: string): Promise<unknown> {
      const query = symbol === undefined
        ? [productTypeParameter()]
        : [productTypeParameter(), { name: 'symbol', value: symbol }];
      return publicRead(transport, BITGET_READ_ENDPOINTS.CONTRACTS, query);
    },
    async getSymbolPrice(symbol: string): Promise<unknown> {
      return publicRead(transport, BITGET_READ_ENDPOINTS.SYMBOL_PRICE, [
        productTypeParameter(),
        { name: 'symbol', value: symbol },
      ]);
    },
    async getAccounts(): Promise<unknown> {
      return privateRead(transport, credential, clock, offsetProvider(), BITGET_READ_ENDPOINTS.ACCOUNTS, [
        productTypeParameter(),
        { name: 'marginCoin', value: BITGET_L1A_MARGIN_COIN },
      ]);
    },
    async getPositions(): Promise<unknown> {
      return privateRead(transport, credential, clock, offsetProvider(), BITGET_READ_ENDPOINTS.POSITIONS, [
        productTypeParameter(),
      ]);
    },
    async getPendingOrders(symbol?: string): Promise<unknown> {
      const query = symbol === undefined
        ? [productTypeParameter()]
        : [productTypeParameter(), { name: 'symbol', value: symbol }];
      return privateRead(transport, credential, clock, offsetProvider(), BITGET_READ_ENDPOINTS.PENDING_ORDERS, query);
    },
    async getRecentFills(options: BitgetReadFillOptions = {}): Promise<unknown> {
      const limit = options.limit ?? BITGET_L1A_FILL_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BITGET_FILL_LIMIT) {
        fail('FILLS_MALFORMED');
      }
      const query: BitgetQueryParameter[] = [productTypeParameter()];
      if (options.symbol !== undefined) query.push({ name: 'symbol', value: options.symbol });
      query.push({ name: 'limit', value: String(limit) });
      return privateRead(transport, credential, clock, offsetProvider(), BITGET_READ_ENDPOINTS.FILLS, query);
    },
  });
}
