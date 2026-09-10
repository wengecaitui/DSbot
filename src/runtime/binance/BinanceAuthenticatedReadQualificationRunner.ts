import {
  createBinanceAuthenticatedReadFoundation,
  type BinanceAuthenticatedReadClient,
  type BinanceAuthenticatedReadStatus,
  type BinanceInstrumentFactsSnapshot,
  type BinanceReadCredentials,
  type BinanceReadFailureReason,
  type BinanceReadIdentity,
  type BinanceReadResult,
  type BinanceReadSecretProvider,
} from './BinanceAuthenticatedReadFoundation';
import {
  createBinanceAuthenticatedReadQualificationRequest,
  evaluateBinanceAuthenticatedReadQualification,
  type BinanceAuthenticatedReadQualificationReceipt,
  type BinanceQualificationInstrumentEvidence,
} from './BinanceAuthenticatedReadQualification';
import {
  BINANCE_L1A_Q0_SCHEMA_VERSION,
  BINANCE_L1A_READ_CLIENT_METHODS,
  type BinanceOfflineQualificationReceipt,
} from './BinanceOfflineReadQualification';
import {
  MAX_BINANCE_TIME_OFFSET_MS,
  createBinanceUsdMAuthenticatedReadClientFactory,
} from './BinanceUsdMAuthenticatedReadClient';
import {
  BINANCE_USDM_READ_ENDPOINTS,
  type BinanceUsdMReadEndpoint,
  type BinanceUsdMReadTransport,
  type BinanceUsdMReadTransportRequest,
} from './BinanceUsdMReadTransport';
import {
  BINANCE_L1A_SCHEMA_VERSION,
  BINANCE_L1A_SOURCE,
} from './BinanceAuthenticatedReadFoundation';

export const MAX_BINANCE_TIME_PREFLIGHT_ROUND_TRIP_MS = 5_000 as const;

export interface BinanceAuthenticatedReadQualificationRunnerInput {
  readonly runId: string;
  readonly identity: BinanceReadIdentity;
  readonly requestedSymbols: readonly string[];
  readonly q0Receipt: BinanceOfflineQualificationReceipt | null;
  readonly secretProvider: BinanceReadSecretProvider;
  readonly transport: BinanceUsdMReadTransport;
  readonly now: () => number;
  readonly staleAfterMs?: number;
  readonly recvWindowMs?: number;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function credentialsAvailable(value: BinanceReadCredentials | null): value is BinanceReadCredentials {
  return value !== null
    && typeof value.apiKey === 'string' && value.apiKey.trim().length > 0
    && typeof value.secretKey === 'string' && value.secretKey.trim().length > 0;
}

function q0PreconditionSatisfied(receipt: BinanceOfflineQualificationReceipt | null): boolean {
  return receipt !== null
    && receipt.QUALIFICATION_MODE === 'OFFLINE'
    && receipt.SCHEMA_VERSION === BINANCE_L1A_Q0_SCHEMA_VERSION
    && receipt.READ_SOURCE === BINANCE_L1A_SOURCE
    && receipt.READ_SCHEMA_VERSION === BINANCE_L1A_SCHEMA_VERSION
    && receipt.AUTH_NETWORK_USED === false
    && receipt.REAL_CREDENTIAL_USED === false
    && receipt.REAL_CREDENTIAL_DISCOVERY === false
    && receipt.PRODUCTION_CONNECTIVITY_VERIFIED === false
    && receipt.READ_CONTRACT_VERIFIED === true
    && receipt.FAIL_CLOSED_VERIFIED === true
    && receipt.MUTATION_SURFACE_PRESENT === false
    && receipt.LIVE_READY === false
    && receipt.EXECUTION_AUTHORITY_GRANTED === false
    && receipt.READY_FOR_REAL_READ_QUALIFICATION === true;
}

function failureStatus(reason: BinanceReadFailureReason): BinanceAuthenticatedReadStatus {
  return Object.freeze({
    configured: false,
    connected: false,
    identity: null,
    lastObservedAt: null,
    reason,
    realClientDefaultWired: false,
    realCredentialDiscovery: false,
  });
}

function failedResult<T>(reason: BinanceReadFailureReason): BinanceReadResult<T> {
  return Object.freeze({ availability: 'UNAVAILABLE', value: null, reason });
}

function failureReceipt(
  request: ReturnType<typeof createBinanceAuthenticatedReadQualificationRequest>,
  q0Receipt: BinanceOfflineQualificationReceipt | null,
  reason: BinanceReadFailureReason,
  transportFailure: boolean,
  errorCode: string | null,
): BinanceAuthenticatedReadQualificationReceipt {
  const status = failureStatus(reason);
  return evaluateBinanceAuthenticatedReadQualification({
    request,
    readClientMethodNames: Object.freeze([]),
    statusBeforeRead: status,
    statusAfterRead: status,
    accountResult: failedResult(reason),
    instrumentResults: Object.freeze(request.REQUESTED_SYMBOLS.map((requestedSymbol) => Object.freeze({
      requestedSymbol,
      result: failedResult<BinanceInstrumentFactsSnapshot>(reason),
    }))),
    transportClassification: transportFailure ? 'UNEXPECTED_FAILURE' : 'EXPECTED_FAILURE',
    invocationCounts: Object.freeze({
      accountTruthReadCount: 0,
      instrumentFactsReadCounts: Object.freeze(request.REQUESTED_SYMBOLS.map((symbol) => Object.freeze({
        symbol,
        count: 0,
      }))),
    }),
    unexpectedErrorCodes: Object.freeze(errorCode ? [errorCode] : []),
    mutationAttemptCount: 0,
    authNetworkUsed: false,
    realCredentialUsed: false,
    productionConnectivityVerified: false,
    q0Receipt,
  });
}

function inspectClientMethodNames(client: BinanceAuthenticatedReadClient): readonly string[] {
  const names = new Set<string>();
  let target: object | null = client;
  let unsafe = false;
  while (target !== null && target !== Object.prototype) {
    for (const key of Reflect.ownKeys(target)) {
      if (key === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (typeof key !== 'string' || !descriptor || descriptor.get || descriptor.set
          || typeof descriptor.value !== 'function') {
        unsafe = true;
        continue;
      }
      names.add(key);
    }
    target = Object.getPrototypeOf(target);
  }
  return Object.freeze(unsafe ? ['UNSAFE_CLIENT_SURFACE'] : [...names].sort());
}

function serverTimeFrom(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null
      || !timestamp((payload as { readonly serverTime?: unknown }).serverTime)) {
    throw new Error('BINANCE_Q1_TIME_PREFLIGHT_INVALID');
  }
  return (payload as { readonly serverTime: number }).serverTime;
}

function countFor(
  counts: ReadonlyMap<BinanceUsdMReadEndpoint, number>,
  endpoint: BinanceUsdMReadEndpoint,
): number {
  return counts.get(endpoint) ?? 0;
}

export async function runBinanceAuthenticatedReadQualification(
  input: BinanceAuthenticatedReadQualificationRunnerInput,
): Promise<BinanceAuthenticatedReadQualificationReceipt> {
  const q0Receipt = input.q0Receipt;
  const secretProvider = input.secretProvider;
  const transport = input.transport;
  const now = input.now;
  const staleAfterMs = input.staleAfterMs;
  const recvWindowMs = input.recvWindowMs;
  const request = createBinanceAuthenticatedReadQualificationRequest({
    qualificationMode: 'REAL_AUTHENTICATED_NETWORK',
    runId: input.runId,
    identity: input.identity,
    requestedSymbols: input.requestedSymbols,
  });

  if (!q0PreconditionSatisfied(q0Receipt)) {
    return failureReceipt(
      request, q0Receipt, 'BINANCE_AUTH_READ_NOT_CONFIGURED', false, null,
    );
  }
  if (!secretProvider || typeof secretProvider.getReadCredentials !== 'function') {
    return failureReceipt(
      request, q0Receipt, 'BINANCE_READ_CREDENTIALS_UNAVAILABLE', false, null,
    );
  }

  let credentials: BinanceReadCredentials | null;
  try {
    credentials = await secretProvider.getReadCredentials(request.IDENTITY);
  } catch {
    credentials = null;
  }
  if (!credentialsAvailable(credentials)) {
    return failureReceipt(
      request, q0Receipt, 'BINANCE_READ_CREDENTIALS_UNAVAILABLE', false, null,
    );
  }
  const runCredentials = Object.freeze({
    apiKey: credentials.apiKey,
    secretKey: credentials.secretKey,
  });

  if (!transport || typeof transport.get !== 'function' || typeof now !== 'function') {
    return failureReceipt(
      request, q0Receipt, 'BINANCE_READ_CLIENT_UNAVAILABLE', false, null,
    );
  }

  const endpointCounts = new Map<BinanceUsdMReadEndpoint, number>();
  let transportFailed = false;
  let authenticatedRequestCount = 0;
  const observedTransport: BinanceUsdMReadTransport = Object.freeze({
    async get(transportRequest: BinanceUsdMReadTransportRequest) {
      endpointCounts.set(
        transportRequest.endpoint,
        countFor(endpointCounts, transportRequest.endpoint) + 1,
      );
      if (transportRequest.apiKey !== undefined) authenticatedRequestCount += 1;
      try {
        return await transport.get(transportRequest);
      } catch {
        transportFailed = true;
        throw new Error('BINANCE_Q1_SANITIZED_TRANSPORT_FAILURE');
      }
    },
  });

  let timeOffsetMs: number;
  try {
    const localBefore = now();
    if (!timestamp(localBefore)) throw new Error('BINANCE_Q1_LOCAL_TIME_INVALID');
    const serverTime = serverTimeFrom(await observedTransport.get(Object.freeze({
      endpoint: BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME,
      query: Object.freeze([]),
    })));
    const localAfter = now();
    if (!timestamp(localAfter) || localAfter < localBefore
        || localAfter - localBefore > MAX_BINANCE_TIME_PREFLIGHT_ROUND_TRIP_MS) {
      throw new Error('BINANCE_Q1_TIME_PREFLIGHT_WINDOW_INVALID');
    }
    const localMidpoint = localBefore + Math.floor((localAfter - localBefore) / 2);
    timeOffsetMs = serverTime - localMidpoint;
    if (!Number.isSafeInteger(timeOffsetMs) || Math.abs(timeOffsetMs) > MAX_BINANCE_TIME_OFFSET_MS) {
      throw new Error('BINANCE_Q1_TIME_OFFSET_INVALID');
    }
  } catch {
    return failureReceipt(
      request,
      q0Receipt,
      'BINANCE_READ_TRANSPORT_FAILED',
      true,
      'BINANCE_Q1_TIME_PREFLIGHT_FAILED',
    );
  }

  let client: BinanceAuthenticatedReadClient;
  let foundation: ReturnType<typeof createBinanceAuthenticatedReadFoundation>;
  try {
    const clientFactory = createBinanceUsdMAuthenticatedReadClientFactory({
      requestedSymbols: request.REQUESTED_SYMBOLS,
      timeOffsetMs,
      now,
      transport: observedTransport,
      ...(recvWindowMs === undefined ? {} : { recvWindowMs }),
    });
    client = clientFactory.create(request.IDENTITY, runCredentials);
    const runSecretProvider: BinanceReadSecretProvider = Object.freeze({
      async getReadCredentials() {
        return runCredentials;
      },
    });
    foundation = createBinanceAuthenticatedReadFoundation(request.IDENTITY, {
      secretProvider: runSecretProvider,
      clientFactory,
      now,
      ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    });
  } catch {
    return failureReceipt(
      request, q0Receipt, 'BINANCE_READ_CLIENT_UNAVAILABLE', false, null,
    );
  }

  const statusBeforeRead = foundation.status();
  const accountResult = await foundation.accountTruth.read();
  const instrumentResults: readonly BinanceQualificationInstrumentEvidence[] = Object.freeze(
    await Promise.all(request.REQUESTED_SYMBOLS.map(async (requestedSymbol) => Object.freeze({
      requestedSymbol,
      result: await foundation.instrumentFacts.read(requestedSymbol),
    }))),
  );
  const statusAfterRead = foundation.status();
  const allInstrumentsAvailable = instrumentResults.every((entry) =>
    entry.result.availability === 'AVAILABLE' && entry.result.value !== null && entry.result.reason === null);
  const symbolCount = request.REQUESTED_SYMBOLS.length;
  const expectedTransportShape = countFor(endpointCounts, BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME) === symbolCount + 2
    && countFor(endpointCounts, BINANCE_USDM_READ_ENDPOINTS.ACCOUNT) === 1
    && countFor(endpointCounts, BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS) === symbolCount
    && countFor(endpointCounts, BINANCE_USDM_READ_ENDPOINTS.USER_TRADES) === symbolCount
    && countFor(endpointCounts, BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE) === symbolCount
    && countFor(endpointCounts, BINANCE_USDM_READ_ENDPOINTS.EXCHANGE_INFO) === 1;
  const expectedAuthenticatedRequests = 1 + (2 * symbolCount);
  const productionConnectivityVerified = transportFailed === false
    && expectedTransportShape
    && authenticatedRequestCount === expectedAuthenticatedRequests
    && accountResult.availability === 'AVAILABLE'
    && accountResult.value !== null
    && accountResult.reason === null
    && allInstrumentsAvailable;

  return evaluateBinanceAuthenticatedReadQualification({
    request,
    readClientMethodNames: inspectClientMethodNames(client),
    statusBeforeRead,
    statusAfterRead,
    accountResult,
    instrumentResults,
    transportClassification: transportFailed ? 'UNEXPECTED_FAILURE' : 'NO_ERROR',
    invocationCounts: Object.freeze({
      accountTruthReadCount: 1,
      instrumentFactsReadCounts: Object.freeze(request.REQUESTED_SYMBOLS.map((symbol) => Object.freeze({
        symbol,
        count: 1,
      }))),
    }),
    unexpectedErrorCodes: Object.freeze(transportFailed ? ['BINANCE_Q1_TRANSPORT_FAILED'] : []),
    mutationAttemptCount: 0,
    authNetworkUsed: authenticatedRequestCount > 0,
    realCredentialUsed: authenticatedRequestCount > 0,
    productionConnectivityVerified,
    q0Receipt,
  });
}

export const BINANCE_Q1_EXPECTED_READ_CLIENT_METHODS = BINANCE_L1A_READ_CLIENT_METHODS;
