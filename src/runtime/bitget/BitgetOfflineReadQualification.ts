/**
 * Bitget offline read qualification (L1A Q0).
 *
 * Runs the real L0 transport (with an injected fake fetch) and the real foundation against declared
 * fixtures to prove - offline, with no real credential and no network - that:
 *   normalization works, the endpoint contract is closed, the signing path is exercised,
 *   account/instrument aggregation works, freshness works, and missing/malformed inputs fail closed.
 *
 * The receipt can never claim real connectivity or a real read.
 */
import {
  BITGET_L0_PRODUCTION_ORIGIN,
  BITGET_L1A_INITIAL_SYMBOL,
  BITGET_READ_ENDPOINTS,
  type BitgetReadCredential,
  type BitgetReadFailureReason,
  type BitgetReadTransport,
} from './BitgetReadContracts';
import {
  createBitgetReadTransport,
  getBitgetReadRequestCount,
  hasProductionBitgetReadTransportProvenance,
} from './BitgetReadTransport';
import {
  evaluateBitgetNewEntryReadiness,
  createBitgetAuthenticatedReadFoundation,
  BITGET_L1A_SOURCE,
  BITGET_L1A_VERSION,
  type BitgetEntryReadiness,
} from './BitgetAuthenticatedReadFoundation';
import { BITGET_SIGNED_TIMESTAMP_WINDOW_MS, MAX_BITGET_SERVER_TIME_SKEW_MS } from './BitgetReadClock';
import type { BitgetReadIdentity } from './BitgetAuthenticatedReadClient';

export const BITGET_L1A_Q0_SCHEMA_VERSION = 'BITGET_L1A_Q0_V1' as const;
export const BITGET_Q0_MAX_ACCOUNT_SNAPSHOT_GETS = 5 as const;
export const BITGET_Q0_MAX_INSTRUMENT_SNAPSHOT_GETS = 3 as const;

export interface BitgetOfflineFetchPayloads {
  readonly serverTime?: unknown;
  readonly accounts?: unknown;
  readonly positions?: unknown;
  readonly pendingOrders?: unknown;
  readonly fills?: unknown;
  readonly contracts?: unknown;
  readonly symbolPrice?: unknown;
  /** Endpoints answered with an exchange error envelope instead of data. */
  readonly reject?: readonly string[];
  /** Every request fails at the transport layer (fetch throws). */
  readonly networkFailure?: boolean;
}

export interface CapturedOfflineRequest {
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
}

/**
 * Distinguishing contract fixture: sizeMultiplier (0.01) deliberately differs from 10^-volumePlace
 * (0.001), so a precision unit can never masquerade as the order-quantity multiple.
 */
const defaultContracts: Record<string, unknown> = {
  symbol: 'ETHUSDT', symbolStatus: 'normal', minTradeNum: '0.001', minTradeUSDT: '5',
  pricePlace: '2', priceEndStep: '1', volumePlace: '3', sizeMultiplier: '0.01',
  minLever: '1', maxLever: '125',
};

const defaultSymbolPrice: Record<string, unknown> = {
  symbol: 'ETHUSDT', price: '2009.5', indexPrice: '2008.75', markPrice: '2010.5', ts: '1799000000000',
};

const defaultPayloads = Object.freeze({
  serverTime: { serverTime: '1799000000000' } as unknown,
  accounts: [{
    marginCoin: 'USDT', accountEquity: '1000.5', available: '900.25', locked: '10.5', unrealizedPL: '0',
  }] as unknown,
  positions: [{
    symbol: 'ETHUSDT', holdSide: 'long', total: '1.5', openPriceAvg: '2000', markPrice: '2010.5',
    unrealizedPL: '15.75', leverage: '10', marginMode: 'crossed', posMode: 'hedge_mode',
    liquidationPrice: '1800', uTime: '1799000000000',
  }] as unknown,
  pendingOrders: [{
    orderId: '9001', clientOid: 'cli-1', symbol: 'ETHUSDT', side: 'buy', posSide: 'long',
    orderType: 'limit', status: 'live', price: '1950', size: '0.5', baseVolume: '0',
    reduceOnly: false, marginMode: 'crossed', leverage: '10',
    cTime: '1799000000000', uTime: '1799000000000',
  }] as unknown,
  fills: [{
    tradeId: '7001', orderId: '7000', symbol: 'ETHUSDT', side: 'buy', tradeSide: 'open',
    price: '1999.5', baseVolume: '0.25', quoteVolume: '499.875', posMode: 'hedge_mode',
    profit: '0', cTime: '1799000000000',
    feeDetail: [{ feeCoin: 'USDT', totalFee: '0.2', totalDeductionFee: '0', deduction: false }],
  }] as unknown,
  contracts: [defaultContracts] as unknown,
  symbolPrice: [defaultSymbolPrice] as unknown,
});

export interface BitgetOfflineFetch {
  readonly fetchImpl: (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  readonly captured: CapturedOfflineRequest[];
}

export function createBitgetOfflineFetch(payloads: BitgetOfflineFetchPayloads = {}): BitgetOfflineFetch {
  const data: Record<string, unknown> = {
    [BITGET_READ_ENDPOINTS.SERVER_TIME]: payloads.serverTime ?? defaultPayloads.serverTime,
    [BITGET_READ_ENDPOINTS.ACCOUNTS]: payloads.accounts ?? defaultPayloads.accounts,
    [BITGET_READ_ENDPOINTS.POSITIONS]: payloads.positions ?? defaultPayloads.positions,
    [BITGET_READ_ENDPOINTS.PENDING_ORDERS]: payloads.pendingOrders ?? defaultPayloads.pendingOrders,
    [BITGET_READ_ENDPOINTS.FILLS]: payloads.fills ?? defaultPayloads.fills,
    [BITGET_READ_ENDPOINTS.CONTRACTS]: payloads.contracts ?? defaultPayloads.contracts,
    [BITGET_READ_ENDPOINTS.SYMBOL_PRICE]: payloads.symbolPrice ?? defaultPayloads.symbolPrice,
  };
  const reject = new Set<string>(payloads.reject ?? []);
  const captured: CapturedOfflineRequest[] = [];
  return Object.freeze({
    captured,
    async fetchImpl(input: string, init: RequestInit) {
      captured.push({ url: input, headers: (init.headers ?? undefined) as Record<string, string> | undefined });
      if (payloads.networkFailure === true) throw new Error('offline network failure');
      const path = input.replace('https://api.bitget.com', '').split('?')[0] ?? '';
      const body = reject.has(path)
        ? { code: '40012', msg: 'offline fixture rejection', requestTime: 1, data: null }
        : { code: '00000', msg: 'success', requestTime: 1, data: data[path] ?? null };
      return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
    },
  });
}

export interface BitgetOfflineQualificationRequest {
  readonly runId: string;
  readonly identity: BitgetReadIdentity;
  readonly credential: BitgetReadCredential | null;
  readonly symbol?: string;
  readonly now: () => number;
  readonly payloads?: BitgetOfflineFetchPayloads;
}

export interface BitgetOfflineQualificationReceipt {
  readonly SCHEMA_VERSION: typeof BITGET_L1A_Q0_SCHEMA_VERSION;
  readonly MODE: 'OFFLINE_SIMULATION';
  readonly RUN_ID: string;
  readonly SYMBOL: string;
  readonly SOURCE: typeof BITGET_L1A_SOURCE;
  readonly VERSION: typeof BITGET_L1A_VERSION;
  readonly TRANSPORT_PROVENANCE: boolean;
  readonly SIGNED_TIMESTAMP_WINDOW_MS: number;
  readonly MAX_SERVER_TIME_SKEW_MS: number;
  readonly ACCOUNT_SNAPSHOT_GET_BUDGET: number;
  readonly INSTRUMENT_SNAPSHOT_GET_BUDGET: number;
  readonly ACCOUNT_SNAPSHOT_GETS: number;
  readonly INSTRUMENT_SNAPSHOT_GETS: number;
  readonly ACCOUNT_TRUTH_AVAILABLE: boolean;
  readonly INSTRUMENT_FACTS_AVAILABLE: boolean;
  readonly ACCOUNT_STATE: string | null;
  readonly BALANCE_COUNT: number | null;
  readonly POSITION_COUNT: number | null;
  readonly OPEN_ORDER_COUNT: number | null;
  readonly RECENT_FILL_COUNT: number | null;
  readonly FEE_DETAIL_ENTRIES: number | null;
  readonly ACCOUNT_FRESHNESS: string | null;
  readonly MARK_PRICE_FRESHNESS: string | null;
  readonly MIN_QTY: number | null;
  readonly QUANTITY_MULTIPLE: number | null;
  readonly QUANTITY_MULTIPLE_BASIS: 'SIZE_MULTIPLIER';
  readonly QUANTITY_PRECISION: number | null;
  readonly QUANTITY_PRECISION_BASIS: 'VOLUME_PLACE';
  readonly PRICE_STEP: number | null;
  readonly PRICE_STEP_BASIS: 'PRICE_END_STEP_AT_PRICE_PLACE';
  readonly PRICE_PRECISION: number | null;
  readonly ENTRY_READINESS: BitgetEntryReadiness | null;
  readonly CHECKS: Readonly<Record<string, boolean>>;
  readonly FAIL_CLOSED_CASES: Readonly<Record<string, string | null>>;
  readonly REAL_CREDENTIAL_USED: false;
  readonly FIXTURE_CREDENTIAL_USED: boolean;
  readonly REAL_NETWORK_USED: false;
  readonly PRODUCTION_CONNECTIVITY_VERIFIED: false;
  readonly REAL_READ_VERIFIED: false;
  readonly EXECUTION_AUTHORITY: false;
  readonly LIVE_READY: false;
  readonly SECRET_LEAK_SCAN: Readonly<Record<string, boolean>>;
}

interface OfflineScenario {
  readonly transport: BitgetReadTransport;
  readonly foundation: ReturnType<typeof createBitgetAuthenticatedReadFoundation>;
  readonly captured: CapturedOfflineRequest[];
}

function scenario(
  request: BitgetOfflineQualificationRequest,
  payloads: BitgetOfflineFetchPayloads,
  credential: BitgetReadCredential | null = request.credential,
): OfflineScenario {
  const offline = createBitgetOfflineFetch(payloads);
  const transport = createBitgetReadTransport(offline.fetchImpl as never);
  const foundation = createBitgetAuthenticatedReadFoundation({
    transport,
    identity: request.identity,
    now: request.now,
    credential,
  });
  return { transport, foundation, captured: offline.captured };
}

export async function runBitgetOfflineReadQualification(
  request: BitgetOfflineQualificationRequest,
): Promise<BitgetOfflineQualificationReceipt> {
  const symbol = request.symbol ?? BITGET_L1A_INITIAL_SYMBOL;

  // Happy path: 5 GETs for the account snapshot, 3 GETs for the instrument snapshot.
  const happy = scenario(request, request.payloads ?? {});
  const accountTruth = await happy.foundation.accountTruth();
  const accountSnapshotGets = getBitgetReadRequestCount(happy.transport)?.total ?? 0;
  const instrumentRun = scenario(request, request.payloads ?? {});
  const instrumentFacts = await instrumentRun.foundation.instrumentFacts(symbol);
  const instrumentSnapshotGets = getBitgetReadRequestCount(instrumentRun.transport)?.total ?? 0;
  const readiness = evaluateBitgetNewEntryReadiness({ accountTruth, instrumentFacts });

  const authRequests = happy.captured.filter((entry) => entry.headers !== undefined);
  const publicRequests = happy.captured.filter((entry) => entry.headers === undefined);
  const signingExercised = authRequests.length > 0
    && authRequests.every((entry) => typeof entry.headers?.['ACCESS-SIGN'] === 'string'
      && (entry.headers['ACCESS-SIGN'] ?? '').length > 0
      && typeof entry.headers['ACCESS-PASSPHRASE'] === 'string'
      && entry.headers['ACCESS-TIMESTAMP'] !== undefined);
  const originOnly = happy.captured.every((entry) => entry.url.startsWith(BITGET_L0_PRODUCTION_ORIGIN));
  const credential = request.credential;
  const credentialNotInUrl = credential === null || happy.captured.every((entry) =>
    !entry.url.includes(credential.apiKey) && !entry.url.includes(credential.secretKey)
    && !entry.url.includes(credential.passphrase));

  // Drifted endpoint must be rejected before any fetch happens.
  const drifted = scenario(request, {});
  const driftedBefore = drifted.captured.length;
  let driftedRejected = false;
  try {
    await drifted.transport.get({ endpoint: '/api/v2/mix/position/all' as never, query: [] });
  } catch {
    driftedRejected = true;
  }
  const driftedFetches = drifted.captured.length - driftedBefore;

  // Fail-closed / readiness scenarios.
  const flat = scenario(request, { positions: [] });
  const flatResult = await flat.foundation.accountTruth();
  const malformedPositions = scenario(request, { positions: { not: 'an array' } });
  const malformedPositionsResult = await malformedPositions.foundation.accountTruth();
  const malformedBalance = scenario(request, {
    accounts: [{ marginCoin: 'USDT', accountEquity: 'not-a-number', available: '1', locked: '0', unrealizedPL: '0' }],
  });
  const malformedBalanceResult = await malformedBalance.foundation.accountTruth();
  const malformedFills = scenario(request, { fills: [{ tradeId: '1' }] });
  const malformedFillsResult = await malformedFills.foundation.accountTruth();
  const malformedOrders = scenario(request, { pendingOrders: [{ orderId: '1' }] });
  const malformedOrdersResult = await malformedOrders.foundation.accountTruth();
  const missingSymbol = scenario(request, {
    contracts: [{ ...defaultContracts, symbol: 'BTCUSDT' }],
  });
  const missingSymbolResult = await missingSymbol.foundation.instrumentFacts(symbol);
  const maintained = scenario(request, {
    contracts: [{ ...defaultContracts, symbolStatus: 'maintain' }],
  });
  const maintainedFacts = await maintained.foundation.instrumentFacts(symbol);
  const maintainedReadiness = evaluateBitgetNewEntryReadiness({ accountTruth, instrumentFacts: maintainedFacts });
  const stalePrice = scenario(request, {
    symbolPrice: [{ ...defaultSymbolPrice, ts: '1798000000000' }],
  });
  const staleFacts = await stalePrice.foundation.instrumentFacts(symbol);
  const staleReadiness = evaluateBitgetNewEntryReadiness({ accountTruth, instrumentFacts: staleFacts });
  const unknownPriceTime = scenario(request, {
    symbolPrice: [{ symbol, price: '1', indexPrice: '1', markPrice: '1' }],
  });
  const unknownPriceFacts = await unknownPriceTime.foundation.instrumentFacts(symbol);
  const skippedRules = scenario(request, {
    contracts: [{ ...defaultContracts, priceEndStep: '0' }],
  });
  const skippedRulesResult = await skippedRules.foundation.instrumentFacts(symbol);
  const missingQuantityMultiple = scenario(request, {
    contracts: [{ ...defaultContracts, sizeMultiplier: undefined }],
  });
  const missingQuantityMultipleResult = await missingQuantityMultiple.foundation.instrumentFacts(symbol);
  const missingPrecision = scenario(request, {
    contracts: [{ ...defaultContracts, volumePlace: undefined }],
  });
  const missingPrecisionResult = await missingPrecision.foundation.instrumentFacts(symbol);
  const zeroMultiple = scenario(request, {
    contracts: [{ ...defaultContracts, sizeMultiplier: '0' }],
  });
  const zeroMultipleResult = await zeroMultiple.foundation.instrumentFacts(symbol);
  const distinguishingPrice = scenario(request, {
    contracts: [{ ...defaultContracts, pricePlace: '1', priceEndStep: '5' }],
  });
  const distinguishingPriceFacts = await distinguishingPrice.foundation.instrumentFacts(symbol);
  const skew = scenario(request, { serverTime: { serverTime: '1799000900000' } });
  const skewResult = await skew.foundation.accountTruth();
  const unconfigured = scenario(request, {}, null);
  const unconfiguredResult = await unconfigured.foundation.accountTruth();
  const unconfiguredGets = getBitgetReadRequestCount(unconfigured.transport)?.total ?? 0;
  const networkFailure = scenario(request, { networkFailure: true });
  const networkFailureResult = await networkFailure.foundation.accountTruth();
  const rejectedEnvelope = scenario(request, { reject: [BITGET_READ_ENDPOINTS.ACCOUNTS] });
  const rejectedEnvelopeResult = await rejectedEnvelope.foundation.accountTruth();

  const failClosed: Record<string, string | null> = {
    MISSING_CREDENTIAL: unconfiguredResult.reason,
    MALFORMED_POSITIONS: malformedPositionsResult.reason,
    MALFORMED_BALANCE: malformedBalanceResult.reason,
    MALFORMED_FILLS: malformedFillsResult.reason,
    MALFORMED_OPEN_ORDERS: malformedOrdersResult.reason,
    MISSING_SYMBOL: missingSymbolResult.reason,
    MAINTENANCE_CONTRACT: maintainedReadiness.safeToOpen ? null : (maintainedReadiness.blockers[0] ?? null),
    STALE_MARK_PRICE: staleReadiness.safeToOpen ? null : (staleReadiness.blockers[0] ?? null),
    UNKNOWN_MARK_PRICE_TIMESTAMP: unknownPriceFacts.value?.freshness === 'UNKNOWN' ? 'MARK_PRICE_UNKNOWN' : null,
    UNDERIVABLE_CONTRACT_RULES: skippedRulesResult.reason,
    MISSING_SIZE_MULTIPLIER: missingQuantityMultipleResult.reason,
    MISSING_VOLUME_PLACE: missingPrecisionResult.reason,
    ZERO_SIZE_MULTIPLIER: zeroMultipleResult.reason,
    CLOCK_SKEW: skewResult.reason,
    NETWORK_FAILURE: networkFailureResult.reason,
    EXCHANGE_REJECTION: rejectedEnvelopeResult.reason,
  };

  const feeEntryCount = accountTruth.value?.recentFills[0]?.feeDetail.length ?? 0;
  const checks: Record<string, boolean> = {
    ACCOUNT_TRUTH_NORMALIZED: accountTruth.availability === 'AVAILABLE' && accountTruth.value !== null,
    INSTRUMENT_FACTS_NORMALIZED: instrumentFacts.availability === 'AVAILABLE' && instrumentFacts.value !== null,
    ACCOUNT_SNAPSHOT_WITHIN_GET_BUDGET: accountSnapshotGets > 0
      && accountSnapshotGets <= BITGET_Q0_MAX_ACCOUNT_SNAPSHOT_GETS,
    INSTRUMENT_SNAPSHOT_WITHIN_GET_BUDGET: instrumentSnapshotGets > 0
      && instrumentSnapshotGets <= BITGET_Q0_MAX_INSTRUMENT_SNAPSHOT_GETS,
    SIGNING_PATH_EXERCISED: signingExercised,
    PUBLIC_READS_UNAUTHENTICATED: publicRequests.every((entry) => entry.headers === undefined),
    ORIGIN_FIXED_ONLY: originOnly,
    CREDENTIAL_ABSENT_FROM_URLS: credentialNotInUrl,
    FEE_DETAIL_PRESERVED: feeEntryCount === 1,
    ENDPOINT_DRIFT_REJECTED_BEFORE_FETCH: driftedRejected && driftedFetches === 0,
    FLAT_ONLY_FROM_FACTUAL_POSITIONS: flatResult.value?.accountState === 'FLAT'
      && malformedPositionsResult.value === null,
    MALFORMED_POSITIONS_NOT_FLAT: malformedPositionsResult.reason === 'POSITION_TRUTH_MALFORMED',
    MALFORMED_BALANCE_FAILS_CLOSED: malformedBalanceResult.reason === 'ACCOUNT_TRUTH_MALFORMED',
    MALFORMED_FILLS_FAILS_CLOSED: malformedFillsResult.reason === 'FILLS_MALFORMED',
    MALFORMED_OPEN_ORDERS_FAILS_CLOSED: malformedOrdersResult.reason === 'OPEN_ORDERS_MALFORMED',
    MISSING_SYMBOL_FAILS_CLOSED: missingSymbolResult.reason === 'MARKET_RULES_UNKNOWN',
    UNDERIVABLE_RULES_FAILS_CLOSED: skippedRulesResult.reason === 'MARKET_RULES_UNKNOWN',
    MISSING_SIZE_MULTIPLIER_FAILS_CLOSED: missingQuantityMultipleResult.reason === 'MARKET_RULES_UNKNOWN',
    MISSING_VOLUME_PLACE_FAILS_CLOSED: missingPrecisionResult.reason === 'MARKET_RULES_UNKNOWN',
    ZERO_SIZE_MULTIPLIER_FAILS_CLOSED: zeroMultipleResult.reason === 'MARKET_RULES_UNKNOWN',
    QUANTITY_MULTIPLE_IS_SIZE_MULTIPLIER: instrumentFacts.value?.quantityMultiple === 0.01,
    QUANTITY_PRECISION_IS_VOLUME_PLACE: instrumentFacts.value?.quantityPrecision === 3,
    QUANTITY_MULTIPLE_IS_NOT_PRECISION_UNIT: instrumentFacts.value !== null
      && instrumentFacts.value.quantityMultiple !== 1 / 10 ** instrumentFacts.value.quantityPrecision,
    PRICE_STEP_IS_END_STEP_AT_PRICE_PLACE: instrumentFacts.value?.priceStep === 0.01
      && instrumentFacts.value?.pricePrecision === 2,
    DISTINGUISHING_PRICE_STEP_DERIVED: distinguishingPriceFacts.value?.priceStep === 0.5
      && distinguishingPriceFacts.value?.pricePrecision === 1,
    MAINTENANCE_BLOCKS_OPENING: maintainedReadiness.safeToOpen === false,
    STALE_MARK_BLOCKS_OPENING: staleReadiness.safeToOpen === false,
    UNKNOWN_MARK_TIMESTAMP_NOT_FRESH: unknownPriceFacts.value?.freshness === 'UNKNOWN',
    CLOCK_SKEW_FAILS_CLOSED: skewResult.reason === 'BITGET_CLOCK_SKEW_INVALID',
    UNCONFIGURED_FAILS_CLOSED: unconfiguredResult.reason === 'BITGET_READ_CREDENTIALS_UNAVAILABLE',
    UNCONFIGURED_MAKES_NO_REQUEST: unconfiguredGets === 0,
    NETWORK_FAILURE_FAILS_CLOSED: networkFailureResult.reason !== null,
    EXCHANGE_REJECTION_FAILS_CLOSED: rejectedEnvelopeResult.reason !== null,
    ENTRY_READINESS_SAFE_ON_VALID_FIXTURE: readiness.safeToOpen === true,
    CLOSE_REDUCE_NOT_GATED_BY_ENTRY_FRESHNESS: readiness.closeOrReduceBlockedByEntryFreshness === false,
    NO_PRODUCTION_PROVENANCE: hasProductionBitgetReadTransportProvenance(happy.transport) === false,
  };

  const serialized = JSON.stringify(checks) + JSON.stringify(failClosed);
  const secretLeakScan = {
    API_KEY_IN_RECEIPT: credential !== null && serialized.includes(credential.apiKey),
    SECRET_IN_RECEIPT: credential !== null && serialized.includes(credential.secretKey),
    PASSPHRASE_IN_RECEIPT: credential !== null && serialized.includes(credential.passphrase),
    SIGNATURE_IN_RECEIPT: /ACCESS-SIGN/.test(serialized),
    ACCESS_SIGN_IN_CAPTURED_URL: happy.captured.some((entry) => entry.url.includes('ACCESS-SIGN')),
  };

  return Object.freeze({
    SCHEMA_VERSION: BITGET_L1A_Q0_SCHEMA_VERSION,
    MODE: 'OFFLINE_SIMULATION' as const,
    RUN_ID: request.runId,
    SYMBOL: symbol,
    SOURCE: BITGET_L1A_SOURCE,
    VERSION: BITGET_L1A_VERSION,
    TRANSPORT_PROVENANCE: hasProductionBitgetReadTransportProvenance(happy.transport),
    SIGNED_TIMESTAMP_WINDOW_MS: BITGET_SIGNED_TIMESTAMP_WINDOW_MS,
    MAX_SERVER_TIME_SKEW_MS: MAX_BITGET_SERVER_TIME_SKEW_MS,
    ACCOUNT_SNAPSHOT_GET_BUDGET: BITGET_Q0_MAX_ACCOUNT_SNAPSHOT_GETS,
    INSTRUMENT_SNAPSHOT_GET_BUDGET: BITGET_Q0_MAX_INSTRUMENT_SNAPSHOT_GETS,
    ACCOUNT_SNAPSHOT_GETS: accountSnapshotGets,
    INSTRUMENT_SNAPSHOT_GETS: instrumentSnapshotGets,
    ACCOUNT_TRUTH_AVAILABLE: accountTruth.availability === 'AVAILABLE',
    INSTRUMENT_FACTS_AVAILABLE: instrumentFacts.availability === 'AVAILABLE',
    ACCOUNT_STATE: accountTruth.value?.accountState ?? null,
    BALANCE_COUNT: accountTruth.value?.balances.length ?? null,
    POSITION_COUNT: accountTruth.value?.positions.length ?? null,
    OPEN_ORDER_COUNT: accountTruth.value?.openOrders.length ?? null,
    RECENT_FILL_COUNT: accountTruth.value?.recentFills.length ?? null,
    FEE_DETAIL_ENTRIES: accountTruth.value === null ? null : feeEntryCount,
    ACCOUNT_FRESHNESS: accountTruth.value?.freshness ?? null,
    MARK_PRICE_FRESHNESS: instrumentFacts.value?.freshness ?? null,
    MIN_QTY: instrumentFacts.value?.minQty ?? null,
    QUANTITY_MULTIPLE: instrumentFacts.value?.quantityMultiple ?? null,
    QUANTITY_MULTIPLE_BASIS: 'SIZE_MULTIPLIER' as const,
    QUANTITY_PRECISION: instrumentFacts.value?.quantityPrecision ?? null,
    QUANTITY_PRECISION_BASIS: 'VOLUME_PLACE' as const,
    PRICE_STEP: instrumentFacts.value?.priceStep ?? null,
    PRICE_STEP_BASIS: 'PRICE_END_STEP_AT_PRICE_PLACE' as const,
    PRICE_PRECISION: instrumentFacts.value?.pricePrecision ?? null,
    ENTRY_READINESS: readiness,
    CHECKS: Object.freeze(checks),
    FAIL_CLOSED_CASES: Object.freeze(failClosed),
    REAL_CREDENTIAL_USED: false as const,
    FIXTURE_CREDENTIAL_USED: request.credential !== null,
    REAL_NETWORK_USED: false as const,
    PRODUCTION_CONNECTIVITY_VERIFIED: false as const,
    REAL_READ_VERIFIED: false as const,
    EXECUTION_AUTHORITY: false as const,
    LIVE_READY: false as const,
    SECRET_LEAK_SCAN: Object.freeze(secretLeakScan),
  });
}

export function bitgetOfflineQualificationFailedReasons(
  receipt: BitgetOfflineQualificationReceipt,
): readonly BitgetReadFailureReason[] {
  const reasons: BitgetReadFailureReason[] = [];
  for (const value of Object.values(receipt.FAIL_CLOSED_CASES)) {
    if (value !== null) reasons.push(value as BitgetReadFailureReason);
  }
  return Object.freeze(reasons);
}
