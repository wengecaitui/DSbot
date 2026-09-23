/**
 * Gate.io authenticated read client (L1A).
 *
 * This is a thin, closed client over the single injected L0 transport. It adds explicit credentials,
 * a fresh server-time-derived timestamp and endpoint-specific methods; it does not create transport,
 * discover credentials, retry, poll or expose any mutation method.
 */
import {
  GATEIO_L0_INITIAL_CONTRACT,
  GATEIO_READ_ENDPOINTS,
  type GateIoQueryParameter,
  type GateIoReadCredential,
  type GateIoReadEndpoint,
  type GateIoReadTransport,
} from './GateIoReadContracts';
import {
  GateIoReadTransportError,
  type GateIoReadTransportErrorCode,
} from './GateIoReadTransport';
import {
  GateIoReadClockError,
  signedGateIoTimestamp,
  type GateIoReadClock,
  type GateIoReadClockFailureReason,
  type GateIoServerTimeObservation,
} from './GateIoReadClock';

export type GateIoReadFailureReason =
  | GateIoReadTransportErrorCode
  | GateIoReadClockFailureReason
  | 'GATEIO_AUTH_READ_NOT_CONFIGURED'
  | 'GATEIO_READ_CREDENTIALS_UNAVAILABLE'
  | 'GATEIO_READ_CLIENT_UNAVAILABLE'
  | 'ACCOUNT_TRUTH_UNKNOWN'
  | 'ACCOUNT_TRUTH_MALFORMED'
  | 'ACCOUNT_TRUTH_STALE'
  | 'POSITION_TRUTH_MALFORMED'
  | 'POSITION_TRUTH_UNKNOWN'
  | 'OPEN_ORDERS_MALFORMED'
  | 'TRADES_MALFORMED'
  | 'INSTRUMENT_FACTS_UNKNOWN'
  | 'INSTRUMENT_FACTS_MALFORMED'
  | 'MARKET_RULES_UNKNOWN'
  | 'MARK_PRICE_UNKNOWN'
  | 'MARK_PRICE_STALE'
  | 'CONTRACT_NOT_OPENABLE';

export interface GateIoReadIdentity {
  readonly exchange: 'gateio';
  readonly accountId: string;
  readonly settle: 'USDT';
}

export interface GateIoReadFailureProvenance {
  readonly reason: GateIoReadFailureReason;
  readonly endpoint: GateIoReadEndpoint;
  readonly transportCode: GateIoReadTransportErrorCode;
  readonly httpStatus: number | null;
  readonly gateLabel: string | null;
}

export class GateIoReadClientError extends Error {
  constructor(
    readonly reason: GateIoReadFailureReason,
    readonly failureProvenance: GateIoReadFailureProvenance | null = null,
  ) {
    super(reason);
    this.name = 'GateIoReadClientError';
  }
}

export interface GateIoAuthenticatedReadClient {
  getServerTime(): Promise<unknown>;
  getAccount(): Promise<unknown>;
  getPositions(): Promise<unknown>;
  getOpenOrders(): Promise<unknown>;
  getRecentTrades(): Promise<unknown>;
  getContract(): Promise<unknown>;
  getTicker(): Promise<unknown>;
}

export interface GateIoAuthenticatedReadClientOptions {
  readonly transport: GateIoReadTransport;
  readonly credential: GateIoReadCredential | null;
  readonly clock: GateIoReadClock;
  /** Live getter for the most recent factual server-time observation. */
  readonly serverTimeObservation: () => GateIoServerTimeObservation | null;
}

function fail(reason: GateIoReadFailureReason): never {
  throw new GateIoReadClientError(reason);
}

function requireCredential(credential: GateIoReadCredential | null): GateIoReadCredential {
  if (credential === null) fail('GATEIO_READ_CREDENTIALS_UNAVAILABLE');
  if (typeof credential.apiKey !== 'string' || credential.apiKey.length === 0
      || typeof credential.secretKey !== 'string' || credential.secretKey.length === 0) {
    fail('GATEIO_READ_CREDENTIALS_UNAVAILABLE');
  }
  return credential;
}

function throwTransportFailure(error: unknown, expectedEndpoint: GateIoReadEndpoint): never {
  if (!(error instanceof GateIoReadTransportError)) {
    throw new GateIoReadClientError('GATEIO_READ_NETWORK_FAILED');
  }
  // Endpoint comes from the validated L0 request. A null or mismatched endpoint is not reflected as
  // a different endpoint; the client method's exact endpoint remains the fail-closed fallback.
  const endpoint = error.endpoint === expectedEndpoint ? error.endpoint : expectedEndpoint;
  const reason: GateIoReadFailureReason = error.code;
  throw new GateIoReadClientError(reason, Object.freeze({
    reason,
    endpoint,
    transportCode: error.code,
    httpStatus: error.httpStatus,
    gateLabel: error.gateLabel,
  }));
}

async function publicRead(
  transport: GateIoReadTransport,
  endpoint: GateIoReadEndpoint,
  query: readonly GateIoQueryParameter[],
): Promise<unknown> {
  try {
    return await transport.get({ endpoint, query });
  } catch (error) {
    throwTransportFailure(error, endpoint);
  }
}

async function authenticatedRead(
  transport: GateIoReadTransport,
  credential: GateIoReadCredential | null,
  clock: GateIoReadClock,
  observation: GateIoServerTimeObservation | null,
  endpoint: GateIoReadEndpoint,
  query: readonly GateIoQueryParameter[],
): Promise<unknown> {
  const injected = requireCredential(credential);
  let timestamp: string;
  try {
    timestamp = signedGateIoTimestamp(clock, observation);
  } catch (error) {
    if (error instanceof GateIoReadClockError) fail(error.reason);
    fail('OBSERVATION_TIME_INVALID');
  }
  try {
    return await transport.get({ endpoint, query, credential: injected, timestamp });
  } catch (error) {
    throwTransportFailure(error, endpoint);
  }
}

function contractParameter(): GateIoQueryParameter {
  return { name: 'contract', value: GATEIO_L0_INITIAL_CONTRACT };
}

export function createGateIoAuthenticatedReadClient(
  options: GateIoAuthenticatedReadClientOptions,
): GateIoAuthenticatedReadClient {
  if (typeof options !== 'object' || options === null) fail('GATEIO_READ_CLIENT_UNAVAILABLE');
  const { transport, credential, clock, serverTimeObservation } = options;
  if (typeof transport !== 'object' || transport === null || typeof transport.get !== 'function'
      || typeof clock !== 'object' || clock === null || typeof clock.now !== 'function'
      || typeof serverTimeObservation !== 'function') {
    fail('GATEIO_READ_CLIENT_UNAVAILABLE');
  }

  return Object.freeze({
    async getServerTime(): Promise<unknown> {
      return publicRead(transport, GATEIO_READ_ENDPOINTS.SERVER_TIME, []);
    },
    async getAccount(): Promise<unknown> {
      return authenticatedRead(
        transport, credential, clock, serverTimeObservation(), GATEIO_READ_ENDPOINTS.ACCOUNTS, [],
      );
    },
    async getPositions(): Promise<unknown> {
      return authenticatedRead(
        transport, credential, clock, serverTimeObservation(), GATEIO_READ_ENDPOINTS.POSITIONS, [],
      );
    },
    async getOpenOrders(): Promise<unknown> {
      return authenticatedRead(
        transport, credential, clock, serverTimeObservation(), GATEIO_READ_ENDPOINTS.OPEN_ORDERS,
        [contractParameter(), { name: 'status', value: 'open' }],
      );
    },
    async getRecentTrades(): Promise<unknown> {
      return authenticatedRead(
        transport, credential, clock, serverTimeObservation(), GATEIO_READ_ENDPOINTS.MY_TRADES,
        [contractParameter()],
      );
    },
    async getContract(): Promise<unknown> {
      return publicRead(transport, GATEIO_READ_ENDPOINTS.CONTRACT, []);
    },
    async getTicker(): Promise<unknown> {
      return publicRead(transport, GATEIO_READ_ENDPOINTS.TICKERS, [contractParameter()]);
    },
  });
}
