import {
  BINANCE_L1A_SCHEMA_VERSION,
  BINANCE_L1A_SOURCE,
  type BinanceAccountTruthSnapshot,
  type BinanceAuthenticatedReadStatus,
  type BinanceInstrumentFactsSnapshot,
  type BinanceReadIdentity,
  type BinanceReadResult,
} from './BinanceAuthenticatedReadFoundation';
import {
  BINANCE_L1A_Q0_SCHEMA_VERSION,
  BINANCE_L1A_READ_CLIENT_METHODS,
  type BinanceOfflineQualificationReceipt,
} from './BinanceOfflineReadQualification';

export const BINANCE_L1A_Q1_SCHEMA_VERSION = 'BINANCE_L1A_Q1_V1' as const;
export const MAX_QUALIFICATION_SYMBOLS = 3 as const;

export type BinanceAuthenticatedReadQualificationMode =
  | 'OFFLINE_SIMULATION'
  | 'REAL_AUTHENTICATED_NETWORK';

export interface BinanceAuthenticatedReadQualificationRequestInput {
  readonly qualificationMode: BinanceAuthenticatedReadQualificationMode;
  readonly runId: string;
  readonly identity: BinanceReadIdentity;
  readonly requestedSymbols: readonly string[];
}

export interface BinanceAuthenticatedReadQualificationRequest {
  readonly SCHEMA_VERSION: typeof BINANCE_L1A_Q1_SCHEMA_VERSION;
  readonly QUALIFICATION_MODE: BinanceAuthenticatedReadQualificationMode;
  readonly RUN_ID: string;
  readonly IDENTITY: BinanceReadIdentity;
  readonly REQUESTED_SYMBOLS: readonly string[];
  readonly ACCOUNT_READ_LIMIT: 1;
  readonly INSTRUMENT_READ_LIMIT_PER_SYMBOL: 1;
  readonly RETRY_ALLOWED: false;
  readonly POLLING_ALLOWED: false;
  readonly MUTATION_ALLOWED: false;
}

export interface BinanceQualificationInstrumentEvidence {
  readonly requestedSymbol: string;
  readonly result: BinanceReadResult<BinanceInstrumentFactsSnapshot>;
}

export interface BinanceQualificationInstrumentReadCount {
  readonly symbol: string;
  readonly count: number;
}

export interface BinanceQualificationInvocationCounts {
  readonly accountTruthReadCount: number;
  readonly instrumentFactsReadCounts: readonly BinanceQualificationInstrumentReadCount[];
}

export type BinanceQualificationTransportClassification =
  | 'NO_ERROR'
  | 'EXPECTED_FAILURE'
  | 'UNEXPECTED_FAILURE';

export interface BinanceAuthenticatedReadQualificationEvidence {
  readonly request: BinanceAuthenticatedReadQualificationRequest;
  readonly readClientMethodNames: readonly string[];
  readonly statusBeforeRead: BinanceAuthenticatedReadStatus;
  readonly statusAfterRead: BinanceAuthenticatedReadStatus;
  readonly accountResult: BinanceReadResult<BinanceAccountTruthSnapshot>;
  readonly instrumentResults: readonly BinanceQualificationInstrumentEvidence[];
  readonly transportClassification: BinanceQualificationTransportClassification;
  readonly invocationCounts: BinanceQualificationInvocationCounts;
  readonly unexpectedErrorCodes: readonly string[];
  readonly mutationAttemptCount: number;
  readonly authNetworkUsed: boolean;
  readonly realCredentialUsed: boolean;
  readonly productionConnectivityVerified: boolean;
  readonly q0Receipt: BinanceOfflineQualificationReceipt | null;
}

export interface BinanceAuthenticatedReadQualificationChecks {
  readonly REQUEST_SHAPE_EXACT: boolean;
  readonly RUN_ID_VALID: boolean;
  readonly QUALIFICATION_MODE_VALID: boolean;
  readonly MODE_EVIDENCE_CONSISTENT: boolean;
  readonly IDENTITY_EXPLICIT: boolean;
  readonly READ_CLIENT_SURFACE_EXACT: boolean;
  readonly MUTATION_METHOD_UNREACHABLE: boolean;
  readonly READ_SOURCE_SCHEMA_MATCH: boolean;
  readonly STATUS_CONFIGURED: boolean;
  readonly STATUS_CONNECTED_AFTER_READ: boolean;
  readonly ACCOUNT_AVAILABLE: boolean;
  readonly ACCOUNT_IDENTITY_MATCH: boolean;
  readonly ACCOUNT_FRESHNESS_KNOWN: boolean;
  readonly ACCOUNT_FRESHNESS_FRESH: boolean;
  readonly ACCOUNT_SERVER_TIME_VALID: boolean;
  readonly ACCOUNT_OBSERVED_TIME_VALID: boolean;
  readonly BALANCE_FACTS_NORMALIZED: boolean;
  readonly POSITION_FACTS_NORMALIZED: boolean;
  readonly ACCOUNT_STATE_CONSISTENT: boolean;
  readonly OPEN_ORDER_FACTS_NORMALIZED: boolean;
  readonly RECENT_FILL_FACTS_NORMALIZED: boolean;
  readonly INSTRUMENTS_REQUESTED_NONEMPTY: boolean;
  readonly INSTRUMENT_FACTS_AVAILABLE: boolean;
  readonly SYMBOL_IDENTITY_MATCH: boolean;
  readonly MARK_PRICE_POSITIVE: boolean;
  readonly TICK_SIZE_POSITIVE: boolean;
  readonly STEP_SIZE_POSITIVE: boolean;
  readonly MIN_QTY_POSITIVE: boolean;
  readonly MIN_NOTIONAL_POSITIVE: boolean;
  readonly CONTRACT_STATUS_PRESENT: boolean;
  readonly INSTRUMENT_FRESHNESS_KNOWN: boolean;
  readonly INSTRUMENT_FRESHNESS_FRESH: boolean;
  readonly INSTRUMENT_TIMES_VALID: boolean;
  readonly ACCOUNT_READ_COUNT_EXACT: boolean;
  readonly INSTRUMENT_READ_COUNTS_BOUNDED: boolean;
  readonly NO_UNEXPECTED_TRANSPORT_ERROR: boolean;
  readonly NO_MUTATION_ATTEMPT: boolean;
  readonly NO_SECRET_IN_RECEIPT: boolean;
  readonly Q0_PRECONDITION_SATISFIED: boolean;
}

export interface BinanceAuthenticatedReadQualificationReceipt {
  readonly QUALIFICATION_MODE: BinanceAuthenticatedReadQualificationMode;
  readonly SCHEMA_VERSION: typeof BINANCE_L1A_Q1_SCHEMA_VERSION;
  readonly READ_SOURCE: typeof BINANCE_L1A_SOURCE;
  readonly READ_SCHEMA_VERSION: typeof BINANCE_L1A_SCHEMA_VERSION;
  readonly RUN_ID: string | null;
  readonly IDENTITY_BOUND: boolean;
  readonly IDENTITY: BinanceReadIdentity | null;
  readonly REQUESTED_SYMBOLS: readonly string[];
  readonly AUTH_NETWORK_USED: boolean;
  readonly REAL_CREDENTIAL_USED: boolean;
  readonly REAL_CREDENTIAL_DISCOVERY: false;
  readonly PRODUCTION_CONNECTIVITY_VERIFIED: boolean;
  readonly REAL_READ_VERIFIED: boolean;
  readonly READ_CLIENT_SURFACE_EXACT: boolean;
  readonly MUTATION_SURFACE_PRESENT: boolean;
  readonly ACCOUNT_READ_AVAILABLE: boolean;
  readonly INSTRUMENT_READS_AVAILABLE: boolean;
  readonly STATUS_CONFIGURED: boolean;
  readonly STATUS_CONNECTED: boolean;
  readonly ACCOUNT_STATE: 'FLAT' | 'OPEN' | null;
  readonly BALANCE_COUNT: number | null;
  readonly POSITION_COUNT: number | null;
  readonly ACCOUNT_OBSERVED_AT: number | null;
  readonly ACCOUNT_SERVER_TIME: number | null;
  readonly LAST_OBSERVED_AT: number | null;
  readonly Q0_PRECONDITION_SATISFIED: boolean;
  readonly Q0_RECEIPT_USED_AS_ACCOUNT_TRUTH: false;
  readonly Q0_RECEIPT_USED_AS_MARKET_TRUTH: false;
  readonly Q0_RECEIPT_IMPLIES_CONNECTIVITY: false;
  readonly CHECKS: BinanceAuthenticatedReadQualificationChecks;
  readonly LIVE_READY: false;
  readonly EXECUTION_AUTHORITY_GRANTED: false;
  readonly TESTNET_AUTHORITY_GRANTED: false;
  readonly REAL_ORDER_AUTHORITY_GRANTED: false;
  readonly READY_FOR_L1B_EVALUATION: boolean;
}

const REQUEST_KEYS = Object.freeze([
  'ACCOUNT_READ_LIMIT',
  'IDENTITY',
  'INSTRUMENT_READ_LIMIT_PER_SYMBOL',
  'MUTATION_ALLOWED',
  'POLLING_ALLOWED',
  'QUALIFICATION_MODE',
  'REQUESTED_SYMBOLS',
  'RETRY_ALLOWED',
  'RUN_ID',
  'SCHEMA_VERSION',
] as const);

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasExactDataKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== expected.length) return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  if (!actual.every((key, index) => key === wanted[index])) return false;
  return actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && !descriptor.get && !descriptor.set;
  });
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isCanonicalSymbol(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{2,24}$/.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isIdentity(value: unknown): value is BinanceReadIdentity {
  return hasExactDataKeys(value, ['accountId', 'exchange'])
    && value.exchange === 'binance'
    && isAccountId(value.accountId);
}

function validRequestedSymbols(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUALIFICATION_SYMBOLS) return false;
  if (!value.every(isCanonicalSymbol)) return false;
  return new Set(value).size === value.length;
}

function validRequest(request: unknown): request is BinanceAuthenticatedReadQualificationRequest {
  if (!hasExactDataKeys(request, REQUEST_KEYS)) return false;
  const requestedSymbols = request.REQUESTED_SYMBOLS;
  if (!validRequestedSymbols(requestedSymbols)) return false;
  return request.SCHEMA_VERSION === BINANCE_L1A_Q1_SCHEMA_VERSION
    && (request.QUALIFICATION_MODE === 'OFFLINE_SIMULATION'
      || request.QUALIFICATION_MODE === 'REAL_AUTHENTICATED_NETWORK')
    && isRunId(request.RUN_ID)
    && isIdentity(request.IDENTITY)
    && [...requestedSymbols].sort().every((symbol, index) => symbol === requestedSymbols[index])
    && request.ACCOUNT_READ_LIMIT === 1
    && request.INSTRUMENT_READ_LIMIT_PER_SYMBOL === 1
    && request.RETRY_ALLOWED === false
    && request.POLLING_ALLOWED === false
    && request.MUTATION_ALLOWED === false;
}

function normalizedMethodNames(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) return null;
  if (new Set(value).size !== value.length) return null;
  return Object.freeze([...value].sort());
}

function exactReadSurface(methodNames: readonly string[] | null): boolean {
  if (!methodNames) return false;
  const expected = [...BINANCE_L1A_READ_CLIENT_METHODS].sort();
  return methodNames.length === expected.length
    && methodNames.every((name, index) => name === expected[index]);
}

function mutationSurfacePresent(methodNames: readonly string[] | null): boolean {
  if (!methodNames) return true;
  const allowed = new Set<string>(BINANCE_L1A_READ_CLIENT_METHODS);
  return methodNames.some((name) => !allowed.has(name)
    || /submit|place|createOrder|cancel|modify|amend|setLeverage|setMargin|transfer|withdraw/i.test(name));
}

function identityMatches(value: BinanceReadIdentity | null | undefined, expected: BinanceReadIdentity): boolean {
  return value?.exchange === expected.exchange && value.accountId === expected.accountId;
}

function accountAvailable(
  result: BinanceReadResult<BinanceAccountTruthSnapshot>,
): result is BinanceReadResult<BinanceAccountTruthSnapshot> & { readonly value: BinanceAccountTruthSnapshot } {
  return result?.availability === 'AVAILABLE' && result.reason === null && isRecord(result.value);
}

function instrumentAvailable(
  result: BinanceReadResult<BinanceInstrumentFactsSnapshot>,
): result is BinanceReadResult<BinanceInstrumentFactsSnapshot> & { readonly value: BinanceInstrumentFactsSnapshot } {
  return result?.availability === 'AVAILABLE' && result.reason === null && isRecord(result.value);
}

function balancesNormalized(account: BinanceAccountTruthSnapshot | null): boolean {
  return account !== null && Array.isArray(account.balances) && account.balances.every((balance) =>
    isRecord(balance)
    && typeof balance.asset === 'string'
    && balance.asset.trim().length > 0
    && isFiniteNumber(balance.walletBalance)
    && isFiniteNumber(balance.availableBalance));
}

function positionsNormalized(account: BinanceAccountTruthSnapshot | null): boolean {
  return account !== null && Array.isArray(account.positions) && account.positions.every((position) =>
    isRecord(position)
    && isCanonicalSymbol(position.symbol)
    && isFiniteNumber(position.quantity)
    && position.side === (position.quantity > 0 ? 'LONG' : position.quantity < 0 ? 'SHORT' : 'FLAT')
    && isNonNegative(position.entryPrice)
    && (position.markPrice === null || isNonNegative(position.markPrice))
    && isFiniteNumber(position.unrealizedPnl)
    && (position.marginMode === 'CROSS' || position.marginMode === 'ISOLATED')
    && isPositive(position.leverage)
    && (position.updatedAt === null || isTimestamp(position.updatedAt)));
}

function openOrdersNormalized(account: BinanceAccountTruthSnapshot | null): boolean {
  return account !== null && Array.isArray(account.openOrders) && account.openOrders.every((order) =>
    isRecord(order)
    && typeof order.orderId === 'string' && order.orderId.length > 0
    && typeof order.clientOrderId === 'string' && order.clientOrderId.length > 0
    && isCanonicalSymbol(order.symbol)
    && (order.side === 'BUY' || order.side === 'SELL')
    && (order.positionSide === null || order.positionSide === 'BOTH'
      || order.positionSide === 'LONG' || order.positionSide === 'SHORT')
    && typeof order.type === 'string' && order.type.length > 0
    && typeof order.status === 'string' && order.status.length > 0
    && isNonNegative(order.price)
    && isNonNegative(order.originalQuantity)
    && isNonNegative(order.executedQuantity)
    && (order.reduceOnly === null || typeof order.reduceOnly === 'boolean')
    && (order.updatedAt === null || isTimestamp(order.updatedAt)));
}

function recentFillsNormalized(account: BinanceAccountTruthSnapshot | null): boolean {
  return account !== null && Array.isArray(account.recentFills) && account.recentFills.every((fill) =>
    isRecord(fill)
    && typeof fill.fillId === 'string' && fill.fillId.length > 0
    && typeof fill.orderId === 'string' && fill.orderId.length > 0
    && isCanonicalSymbol(fill.symbol)
    && (fill.side === 'BUY' || fill.side === 'SELL')
    && isPositive(fill.price)
    && isPositive(fill.quantity)
    && isNonNegative(fill.quoteQuantity)
    && isFiniteNumber(fill.commission)
    && typeof fill.commissionAsset === 'string' && fill.commissionAsset.length > 0
    && isTimestamp(fill.executedAt));
}

function freshnessKnown(value: unknown): value is {
  readonly status: 'FRESH' | 'STALE';
  readonly ageMs: number;
  readonly staleAfterMs: number;
} {
  if (!isRecord(value)) return false;
  return (value.status === 'FRESH' || value.status === 'STALE')
    && isNonNegative(value.ageMs)
    && isPositive(value.staleAfterMs);
}

function freshnessConsistent(
  value: unknown,
  observedAt: unknown,
  exchangeTime: unknown,
): boolean {
  if (!freshnessKnown(value) || !isTimestamp(observedAt) || !isTimestamp(exchangeTime)
      || exchangeTime > observedAt) return false;
  const ageMs = observedAt - exchangeTime;
  return value.ageMs === ageMs
    && value.status === (ageMs <= value.staleAfterMs ? 'FRESH' : 'STALE');
}

function instrumentEvidenceComplete(
  evidence: readonly BinanceQualificationInstrumentEvidence[],
  requestedSymbols: readonly string[],
): boolean {
  if (evidence.length !== requestedSymbols.length) return false;
  if (!evidence.every((entry) => isRecord(entry)
      && hasExactDataKeys(entry, ['requestedSymbol', 'result'])
      && isCanonicalSymbol(entry.requestedSymbol)
      && isRecord(entry.result))) return false;
  const names = evidence.map((entry) => entry.requestedSymbol);
  return names.every(isCanonicalSymbol)
    && new Set(names).size === names.length
    && [...names].sort().every((symbol, index) => symbol === requestedSymbols[index]);
}

function invocationCountsBounded(
  counts: BinanceQualificationInvocationCounts,
  requestedSymbols: readonly string[],
): boolean {
  if (!isRecord(counts) || counts.accountTruthReadCount !== 1
      || !Array.isArray(counts.instrumentFactsReadCounts)
      || counts.instrumentFactsReadCounts.length !== requestedSymbols.length) return false;
  const bySymbol = new Map<string, number>();
  for (const entry of counts.instrumentFactsReadCounts) {
    if (!isRecord(entry) || !isCanonicalSymbol(entry.symbol)
        || !Number.isSafeInteger(entry.count) || entry.count !== 1
        || bySymbol.has(entry.symbol)) return false;
    bySymbol.set(entry.symbol, entry.count);
  }
  return requestedSymbols.every((symbol) => bySymbol.get(symbol) === 1);
}

function errorCodesValid(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((code) => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code));
}

function containsSensitiveMaterial(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') {
    return /\bBearer\s+|api[_-]?key\s*[:=]|secret[_-]?key\s*[:=]|authorization\s*[:=]|cookie\s*[:=]/i.test(value);
  }
  if (!isRecord(value)) return typeof value === 'function' || typeof value === 'symbol';
  if (seen.has(value)) return true;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || /api.?key|secret.?key|authorization|headers?|cookies?|request.?signing/i.test(key)) {
      return true;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || containsSensitiveMaterial(descriptor.value, seen)) {
      return true;
    }
  }
  seen.delete(value);
  return false;
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

export function createBinanceAuthenticatedReadQualificationRequest(
  input: BinanceAuthenticatedReadQualificationRequestInput,
): BinanceAuthenticatedReadQualificationRequest {
  if (!isRecord(input)
      || (input.qualificationMode !== 'OFFLINE_SIMULATION'
        && input.qualificationMode !== 'REAL_AUTHENTICATED_NETWORK')) {
    throw new Error('BINANCE_Q1_QUALIFICATION_MODE_INVALID');
  }
  if (!isRunId(input.runId)) throw new Error('BINANCE_Q1_RUN_ID_INVALID');
  if (!isIdentity(input.identity)) throw new Error('BINANCE_Q1_IDENTITY_INVALID');
  if (!validRequestedSymbols(input.requestedSymbols)) {
    throw new Error('BINANCE_Q1_REQUESTED_SYMBOLS_INVALID');
  }
  const requestedSymbols = Object.freeze([...input.requestedSymbols].sort());
  const identity = Object.freeze({ exchange: 'binance' as const, accountId: input.identity.accountId });
  return Object.freeze({
    SCHEMA_VERSION: BINANCE_L1A_Q1_SCHEMA_VERSION,
    QUALIFICATION_MODE: input.qualificationMode,
    RUN_ID: input.runId,
    IDENTITY: identity,
    REQUESTED_SYMBOLS: requestedSymbols,
    ACCOUNT_READ_LIMIT: 1,
    INSTRUMENT_READ_LIMIT_PER_SYMBOL: 1,
    RETRY_ALLOWED: false,
    POLLING_ALLOWED: false,
    MUTATION_ALLOWED: false,
  });
}

export function evaluateBinanceAuthenticatedReadQualification(
  evidence: BinanceAuthenticatedReadQualificationEvidence,
): BinanceAuthenticatedReadQualificationReceipt {
  const requestIsValid = validRequest(evidence.request);
  const requestedSymbols = requestIsValid ? evidence.request.REQUESTED_SYMBOLS : Object.freeze([]);
  const identity = requestIsValid ? evidence.request.IDENTITY : null;
  const methodNames = normalizedMethodNames(evidence.readClientMethodNames);
  const surfaceExact = exactReadSurface(methodNames);
  const hasMutationSurface = mutationSurfacePresent(methodNames);
  const accountIsAvailable = accountAvailable(evidence.accountResult);
  const account = accountIsAvailable ? evidence.accountResult.value : null;
  const instrumentsComplete = requestIsValid
    && Array.isArray(evidence.instrumentResults)
    && instrumentEvidenceComplete(evidence.instrumentResults, requestedSymbols);
  const availableInstruments = instrumentsComplete
    ? evidence.instrumentResults.filter((entry) => instrumentAvailable(entry.result))
    : [];
  const allInstrumentsAvailable = instrumentsComplete
    && availableInstruments.length === requestedSymbols.length;
  const instrumentSnapshots = allInstrumentsAvailable
    ? availableInstruments.map((entry) => entry.result.value!)
    : [];
  const mode = requestIsValid ? evidence.request.QUALIFICATION_MODE : 'OFFLINE_SIMULATION';
  const realMode = mode === 'REAL_AUTHENTICATED_NETWORK';
  const modeEvidenceConsistent = realMode
    ? evidence.authNetworkUsed === true
      && evidence.realCredentialUsed === true
      && evidence.productionConnectivityVerified === true
    : evidence.authNetworkUsed === false
      && evidence.realCredentialUsed === false
      && evidence.productionConnectivityVerified === false;
  const noUnexpectedTransportError = evidence.transportClassification === 'NO_ERROR'
    && errorCodesValid(evidence.unexpectedErrorCodes)
    && evidence.unexpectedErrorCodes.length === 0;
  const noSecretMaterial = containsSensitiveMaterial(evidence) === false;

  const checks: BinanceAuthenticatedReadQualificationChecks = Object.freeze({
    REQUEST_SHAPE_EXACT: requestIsValid,
    RUN_ID_VALID: requestIsValid && isRunId(evidence.request.RUN_ID),
    QUALIFICATION_MODE_VALID: requestIsValid,
    MODE_EVIDENCE_CONSISTENT: modeEvidenceConsistent,
    IDENTITY_EXPLICIT: identity !== null,
    READ_CLIENT_SURFACE_EXACT: surfaceExact,
    MUTATION_METHOD_UNREACHABLE: hasMutationSurface === false,
    READ_SOURCE_SCHEMA_MATCH: account !== null
      && account.source === BINANCE_L1A_SOURCE
      && account.schemaVersion === BINANCE_L1A_SCHEMA_VERSION
      && allInstrumentsAvailable
      && instrumentSnapshots.every((snapshot) => snapshot.source === BINANCE_L1A_SOURCE
        && snapshot.schemaVersion === BINANCE_L1A_SCHEMA_VERSION),
    STATUS_CONFIGURED: identity !== null
      && evidence.statusBeforeRead?.configured === true
      && evidence.statusAfterRead?.configured === true
      && identityMatches(evidence.statusBeforeRead.identity, identity)
      && identityMatches(evidence.statusAfterRead.identity, identity)
      && evidence.statusBeforeRead.realClientDefaultWired === false
      && evidence.statusAfterRead.realClientDefaultWired === false
      && evidence.statusBeforeRead.realCredentialDiscovery === false
      && evidence.statusAfterRead.realCredentialDiscovery === false,
    STATUS_CONNECTED_AFTER_READ: evidence.statusAfterRead?.connected === true
      && evidence.statusAfterRead.reason === null
      && isTimestamp(evidence.statusAfterRead.lastObservedAt),
    ACCOUNT_AVAILABLE: accountIsAvailable,
    ACCOUNT_IDENTITY_MATCH: identity !== null && account !== null && identityMatches(account.identity, identity),
    ACCOUNT_FRESHNESS_KNOWN: account !== null
      && freshnessConsistent(account.freshness, account.observedAt, account.accountUpdateTime),
    ACCOUNT_FRESHNESS_FRESH: account?.freshness?.status === 'FRESH',
    ACCOUNT_SERVER_TIME_VALID: account !== null && isTimestamp(account.serverTime),
    ACCOUNT_OBSERVED_TIME_VALID: account !== null && isTimestamp(account.observedAt),
    BALANCE_FACTS_NORMALIZED: balancesNormalized(account),
    POSITION_FACTS_NORMALIZED: positionsNormalized(account),
    ACCOUNT_STATE_CONSISTENT: account !== null
      && positionsNormalized(account)
      && (account.accountState === 'FLAT' || account.accountState === 'OPEN')
      && account.accountState === (account.positions.some((position) => position.quantity !== 0) ? 'OPEN' : 'FLAT'),
    OPEN_ORDER_FACTS_NORMALIZED: openOrdersNormalized(account),
    RECENT_FILL_FACTS_NORMALIZED: recentFillsNormalized(account),
    INSTRUMENTS_REQUESTED_NONEMPTY: requestIsValid && requestedSymbols.length > 0,
    INSTRUMENT_FACTS_AVAILABLE: allInstrumentsAvailable,
    SYMBOL_IDENTITY_MATCH: allInstrumentsAvailable
      && availableInstruments.every((entry) => entry.result.value?.symbol === entry.requestedSymbol),
    MARK_PRICE_POSITIVE: allInstrumentsAvailable && instrumentSnapshots.every((snapshot) => isPositive(snapshot.markPrice)),
    TICK_SIZE_POSITIVE: allInstrumentsAvailable && instrumentSnapshots.every((snapshot) => isPositive(snapshot.tickSize)),
    STEP_SIZE_POSITIVE: allInstrumentsAvailable && instrumentSnapshots.every((snapshot) => isPositive(snapshot.stepSize)),
    MIN_QTY_POSITIVE: allInstrumentsAvailable && instrumentSnapshots.every((snapshot) => isPositive(snapshot.minQty)),
    MIN_NOTIONAL_POSITIVE: allInstrumentsAvailable
      && instrumentSnapshots.every((snapshot) => isPositive(snapshot.minNotional)),
    CONTRACT_STATUS_PRESENT: allInstrumentsAvailable
      && instrumentSnapshots.every((snapshot) => typeof snapshot.contractStatus === 'string'
        && snapshot.contractStatus.trim().length > 0),
    INSTRUMENT_FRESHNESS_KNOWN: allInstrumentsAvailable
      && instrumentSnapshots.every((snapshot) =>
        freshnessConsistent(snapshot.freshness, snapshot.observedAt, snapshot.markPriceTime)),
    INSTRUMENT_FRESHNESS_FRESH: allInstrumentsAvailable
      && instrumentSnapshots.every((snapshot) =>
        freshnessKnown(snapshot.freshness) && snapshot.freshness.status === 'FRESH'),
    INSTRUMENT_TIMES_VALID: allInstrumentsAvailable
      && instrumentSnapshots.every((snapshot) => isTimestamp(snapshot.serverTime)
        && isTimestamp(snapshot.observedAt)
        && isTimestamp(snapshot.markPriceTime)),
    ACCOUNT_READ_COUNT_EXACT: evidence.invocationCounts?.accountTruthReadCount === 1,
    INSTRUMENT_READ_COUNTS_BOUNDED: requestIsValid
      && invocationCountsBounded(evidence.invocationCounts, requestedSymbols),
    NO_UNEXPECTED_TRANSPORT_ERROR: noUnexpectedTransportError,
    NO_MUTATION_ATTEMPT: evidence.mutationAttemptCount === 0,
    NO_SECRET_IN_RECEIPT: noSecretMaterial,
    Q0_PRECONDITION_SATISFIED: q0PreconditionSatisfied(evidence.q0Receipt),
  });

  const allChecksPass = Object.values(checks).every((value) => value === true);
  const authNetworkUsed = realMode && evidence.authNetworkUsed === true;
  const realCredentialUsed = realMode && evidence.realCredentialUsed === true;
  const productionConnectivityVerified = realMode
    && evidence.productionConnectivityVerified === true
    && checks.STATUS_CONNECTED_AFTER_READ
    && checks.ACCOUNT_AVAILABLE
    && checks.INSTRUMENT_FACTS_AVAILABLE;
  const realReadVerified = realMode
    && authNetworkUsed
    && realCredentialUsed
    && productionConnectivityVerified
    && allChecksPass;
  const normalizedBalances = balancesNormalized(account);
  const normalizedPositions = positionsNormalized(account);

  return Object.freeze({
    QUALIFICATION_MODE: mode,
    SCHEMA_VERSION: BINANCE_L1A_Q1_SCHEMA_VERSION,
    READ_SOURCE: BINANCE_L1A_SOURCE,
    READ_SCHEMA_VERSION: BINANCE_L1A_SCHEMA_VERSION,
    RUN_ID: requestIsValid ? evidence.request.RUN_ID : null,
    IDENTITY_BOUND: checks.IDENTITY_EXPLICIT && checks.ACCOUNT_IDENTITY_MATCH,
    IDENTITY: identity ? Object.freeze({ exchange: 'binance', accountId: identity.accountId }) : null,
    REQUESTED_SYMBOLS: Object.freeze([...requestedSymbols]),
    AUTH_NETWORK_USED: authNetworkUsed,
    REAL_CREDENTIAL_USED: realCredentialUsed,
    REAL_CREDENTIAL_DISCOVERY: false,
    PRODUCTION_CONNECTIVITY_VERIFIED: productionConnectivityVerified,
    REAL_READ_VERIFIED: realReadVerified,
    READ_CLIENT_SURFACE_EXACT: surfaceExact,
    MUTATION_SURFACE_PRESENT: hasMutationSurface,
    ACCOUNT_READ_AVAILABLE: accountIsAvailable,
    INSTRUMENT_READS_AVAILABLE: allInstrumentsAvailable,
    STATUS_CONFIGURED: checks.STATUS_CONFIGURED,
    STATUS_CONNECTED: checks.STATUS_CONNECTED_AFTER_READ,
    ACCOUNT_STATE: checks.ACCOUNT_STATE_CONSISTENT && normalizedBalances && normalizedPositions
      ? account!.accountState
      : null,
    BALANCE_COUNT: normalizedBalances ? account!.balances.length : null,
    POSITION_COUNT: normalizedPositions ? account!.positions.length : null,
    ACCOUNT_OBSERVED_AT: account !== null && isTimestamp(account.observedAt) ? account.observedAt : null,
    ACCOUNT_SERVER_TIME: account !== null && isTimestamp(account.serverTime) ? account.serverTime : null,
    LAST_OBSERVED_AT: isTimestamp(evidence.statusAfterRead?.lastObservedAt)
      ? evidence.statusAfterRead.lastObservedAt
      : null,
    Q0_PRECONDITION_SATISFIED: checks.Q0_PRECONDITION_SATISFIED,
    Q0_RECEIPT_USED_AS_ACCOUNT_TRUTH: false,
    Q0_RECEIPT_USED_AS_MARKET_TRUTH: false,
    Q0_RECEIPT_IMPLIES_CONNECTIVITY: false,
    CHECKS: checks,
    LIVE_READY: false,
    EXECUTION_AUTHORITY_GRANTED: false,
    TESTNET_AUTHORITY_GRANTED: false,
    REAL_ORDER_AUTHORITY_GRANTED: false,
    READY_FOR_L1B_EVALUATION: realReadVerified,
  });
}
