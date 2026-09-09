import {
  BINANCE_L1A_SCHEMA_VERSION,
  BINANCE_L1A_SOURCE,
  evaluateBinanceNewEntryReadiness,
  type BinanceAccountTruthSnapshot,
  type BinanceAuthenticatedReadClient,
  type BinanceInstrumentFactsSnapshot,
  type BinanceNewEntryReadBlocker,
  type BinanceReadResult,
} from './BinanceAuthenticatedReadFoundation';

export const BINANCE_L1A_Q0_SCHEMA_VERSION = 'BINANCE_L1A_Q0_V1' as const;

export const BINANCE_L1A_READ_CLIENT_METHODS = Object.freeze([
  'getAccount',
  'getInstrumentRules',
  'getMarkPrice',
  'getOpenOrders',
  'getRecentFills',
  'getServerTime',
] as const);

export interface BinanceOfflineQualificationExpectedTimes {
  readonly accountObservedAt: number;
  readonly accountServerTime: number;
  readonly accountUpdateTime: number;
  readonly instrumentObservedAt: number;
  readonly instrumentServerTime: number;
  readonly markPriceTime: number;
  readonly staleAfterMs: number;
}

export interface BinanceOfflineQualificationEvidence {
  readonly notConfigured: BinanceReadResult<BinanceAccountTruthSnapshot>;
  readonly credentialsUnavailable: BinanceReadResult<BinanceAccountTruthSnapshot>;
  readonly transportFailure: BinanceReadResult<BinanceAccountTruthSnapshot>;
  readonly validAccount: BinanceReadResult<BinanceAccountTruthSnapshot>;
  readonly validInstrument: BinanceReadResult<BinanceInstrumentFactsSnapshot>;
  readonly staleInstrument: BinanceReadResult<BinanceInstrumentFactsSnapshot>;
  readonly missingRules: BinanceReadResult<BinanceInstrumentFactsSnapshot>;
  readonly missingAccount: BinanceReadResult<BinanceAccountTruthSnapshot>;
  readonly unknownBalance: BinanceReadResult<BinanceAccountTruthSnapshot>;
  readonly unknownPosition: BinanceReadResult<BinanceAccountTruthSnapshot>;
  readonly readClient: BinanceAuthenticatedReadClient;
  readonly expectedTimes: BinanceOfflineQualificationExpectedTimes;
}

export interface BinanceOfflineQualificationChecks {
  readonly NOT_CONFIGURED_FAIL_CLOSED: boolean;
  readonly CREDENTIALS_UNAVAILABLE_FAIL_CLOSED: boolean;
  readonly TRANSPORT_FAILURE_FAIL_CLOSED: boolean;
  readonly ACCOUNT_TRUTH_NORMALIZED: boolean;
  readonly INSTRUMENT_FACTS_NORMALIZED: boolean;
  readonly STALE_MARK_BLOCKS_ENTRY_ONLY: boolean;
  readonly MISSING_RULES_BLOCK_ENTRY_ONLY: boolean;
  readonly MISSING_ACCOUNT_NOT_FLAT: boolean;
  readonly UNKNOWN_BALANCE_NOT_ZERO: boolean;
  readonly UNKNOWN_POSITION_NOT_ZERO: boolean;
  readonly TIMES_AND_FRESHNESS_DETERMINISTIC: boolean;
  readonly READ_CLIENT_SURFACE_EXACT: boolean;
  readonly MUTATION_METHOD_UNREACHABLE: boolean;
  readonly RECEIPT_CANNOT_GRANT_AUTHORITY: boolean;
}

export interface BinanceOfflineQualificationReceipt {
  readonly QUALIFICATION_MODE: 'OFFLINE';
  readonly SCHEMA_VERSION: typeof BINANCE_L1A_Q0_SCHEMA_VERSION;
  readonly READ_SOURCE: typeof BINANCE_L1A_SOURCE;
  readonly READ_SCHEMA_VERSION: typeof BINANCE_L1A_SCHEMA_VERSION;
  readonly AUTH_NETWORK_USED: false;
  readonly REAL_CREDENTIAL_USED: false;
  readonly REAL_CREDENTIAL_DISCOVERY: false;
  readonly PRODUCTION_CONNECTIVITY_VERIFIED: false;
  readonly READ_CONTRACT_VERIFIED: boolean;
  readonly FAIL_CLOSED_VERIFIED: boolean;
  readonly MUTATION_SURFACE_PRESENT: boolean;
  readonly LIVE_READY: false;
  readonly EXECUTION_AUTHORITY_GRANTED: false;
  readonly READY_FOR_REAL_READ_QUALIFICATION: boolean;
  readonly ACCOUNT_OBSERVED_AT: number | null;
  readonly ACCOUNT_SERVER_TIME: number | null;
  readonly INSTRUMENT_OBSERVED_AT: number | null;
  readonly INSTRUMENT_SERVER_TIME: number | null;
  readonly CHECKS: BinanceOfflineQualificationChecks;
}

function availableAccount(
  result: BinanceReadResult<BinanceAccountTruthSnapshot>,
): BinanceAccountTruthSnapshot | null {
  return result.availability === 'AVAILABLE' && result.reason === null ? result.value : null;
}

function availableInstrument(
  result: BinanceReadResult<BinanceInstrumentFactsSnapshot>,
): BinanceInstrumentFactsSnapshot | null {
  return result.availability === 'AVAILABLE' && result.reason === null ? result.value : null;
}

function unavailableAccount(
  result: BinanceReadResult<BinanceAccountTruthSnapshot>,
  availability: 'UNAVAILABLE' | 'UNKNOWN',
  reason: string,
): boolean {
  return result.availability === availability && result.value === null && result.reason === reason;
}

function entryBlocked(
  account: BinanceReadResult<BinanceAccountTruthSnapshot>,
  instrument: BinanceReadResult<BinanceInstrumentFactsSnapshot>,
  blocker: BinanceNewEntryReadBlocker,
): boolean {
  const readiness = evaluateBinanceNewEntryReadiness(account, instrument);
  return readiness.safeToOpen === false
    && readiness.blockers.includes(blocker)
    && readiness.closeOrReduceBlockedByEntryFreshness === false;
}

interface ReadClientSurface {
  readonly methodNames: readonly string[];
  readonly containsUnexpectedSurface: boolean;
}

function inspectReadClientSurface(readClient: BinanceAuthenticatedReadClient): ReadClientSurface {
  const methodNames = new Set<string>();
  let containsUnexpectedSurface = false;
  let target: object | null = readClient;
  while (target !== null && target !== Object.prototype) {
    for (const key of Reflect.ownKeys(target)) {
      if (key === 'constructor') continue;
      if (typeof key !== 'string') {
        containsUnexpectedSurface = true;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== 'function') {
        containsUnexpectedSurface = true;
        continue;
      }
      methodNames.add(key);
    }
    target = Object.getPrototypeOf(target);
  }
  return Object.freeze({
    methodNames: Object.freeze([...methodNames].sort()),
    containsUnexpectedSurface,
  });
}

function exactReadClientSurface(methodNames: readonly string[]): boolean {
  const actual = [...methodNames].sort();
  const expected = [...BINANCE_L1A_READ_CLIENT_METHODS].sort();
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function mutationSurfacePresent(methodNames: readonly string[]): boolean {
  const allowed = new Set<string>(BINANCE_L1A_READ_CLIENT_METHODS);
  return methodNames.some((name) => !allowed.has(name)
    || /submit|place|createOrder|cancel|modify|amend|setLeverage|setMargin/i.test(name));
}

export function createBinanceOfflineQualificationReceipt(
  evidence: BinanceOfflineQualificationEvidence,
): BinanceOfflineQualificationReceipt {
  const account = availableAccount(evidence.validAccount);
  const instrument = availableInstrument(evidence.validInstrument);
  const staleInstrument = availableInstrument(evidence.staleInstrument);
  const readClientSurface = inspectReadClientSurface(evidence.readClient);
  const hasMutationSurface = readClientSurface.containsUnexpectedSurface
    || mutationSurfacePresent(readClientSurface.methodNames);

  const checks: BinanceOfflineQualificationChecks = Object.freeze({
    NOT_CONFIGURED_FAIL_CLOSED:
      unavailableAccount(evidence.notConfigured, 'UNAVAILABLE', 'BINANCE_AUTH_READ_NOT_CONFIGURED')
      && entryBlocked(evidence.notConfigured, evidence.validInstrument, 'ACCOUNT_TRUTH_UNKNOWN'),
    CREDENTIALS_UNAVAILABLE_FAIL_CLOSED:
      unavailableAccount(evidence.credentialsUnavailable, 'UNAVAILABLE', 'BINANCE_READ_CREDENTIALS_UNAVAILABLE')
      && entryBlocked(evidence.credentialsUnavailable, evidence.validInstrument, 'ACCOUNT_TRUTH_UNKNOWN'),
    TRANSPORT_FAILURE_FAIL_CLOSED:
      unavailableAccount(evidence.transportFailure, 'UNKNOWN', 'BINANCE_READ_TRANSPORT_FAILED')
      && entryBlocked(evidence.transportFailure, evidence.validInstrument, 'ACCOUNT_TRUTH_UNKNOWN'),
    ACCOUNT_TRUTH_NORMALIZED: account !== null
      && account.freshness.status === 'FRESH'
      && Array.isArray(account.balances)
      && Array.isArray(account.positions)
      && Array.isArray(account.openOrders)
      && Array.isArray(account.recentFills),
    INSTRUMENT_FACTS_NORMALIZED: instrument !== null
      && instrument.freshness.status === 'FRESH'
      && instrument.markPrice > 0
      && instrument.tickSize > 0
      && instrument.stepSize > 0
      && instrument.minQty > 0
      && instrument.minNotional > 0
      && instrument.contractStatus === 'TRADING',
    STALE_MARK_BLOCKS_ENTRY_ONLY: staleInstrument !== null
      && staleInstrument.freshness.status === 'STALE'
      && entryBlocked(evidence.validAccount, evidence.staleInstrument, 'MARK_PRICE_STALE'),
    MISSING_RULES_BLOCK_ENTRY_ONLY:
      evidence.missingRules.availability === 'UNKNOWN'
      && evidence.missingRules.value === null
      && evidence.missingRules.reason === 'MARKET_RULES_UNKNOWN'
      && entryBlocked(evidence.validAccount, evidence.missingRules, 'MARKET_RULES_UNKNOWN'),
    MISSING_ACCOUNT_NOT_FLAT:
      evidence.missingAccount.value === null
      && evidence.missingAccount.reason === 'ACCOUNT_TRUTH_MISSING',
    UNKNOWN_BALANCE_NOT_ZERO:
      evidence.unknownBalance.value === null
      && evidence.unknownBalance.reason === 'ACCOUNT_TRUTH_MALFORMED',
    UNKNOWN_POSITION_NOT_ZERO:
      evidence.unknownPosition.value === null
      && evidence.unknownPosition.reason === 'ACCOUNT_TRUTH_MALFORMED',
    TIMES_AND_FRESHNESS_DETERMINISTIC: account !== null
      && instrument !== null
      && account.observedAt === evidence.expectedTimes.accountObservedAt
      && account.serverTime === evidence.expectedTimes.accountServerTime
      && account.accountUpdateTime === evidence.expectedTimes.accountUpdateTime
      && instrument.observedAt === evidence.expectedTimes.instrumentObservedAt
      && instrument.serverTime === evidence.expectedTimes.instrumentServerTime
      && instrument.markPriceTime === evidence.expectedTimes.markPriceTime
      && account.freshness.status === 'FRESH'
      && account.freshness.ageMs === account.observedAt - account.accountUpdateTime
      && account.freshness.staleAfterMs === evidence.expectedTimes.staleAfterMs
      && instrument.freshness.status === 'FRESH'
      && instrument.freshness.ageMs === instrument.observedAt - instrument.markPriceTime
      && instrument.freshness.staleAfterMs === evidence.expectedTimes.staleAfterMs,
    READ_CLIENT_SURFACE_EXACT: readClientSurface.containsUnexpectedSurface === false
      && exactReadClientSurface(readClientSurface.methodNames),
    MUTATION_METHOD_UNREACHABLE: hasMutationSurface === false,
    RECEIPT_CANNOT_GRANT_AUTHORITY: true,
  });

  const readContractVerified = checks.ACCOUNT_TRUTH_NORMALIZED
    && checks.INSTRUMENT_FACTS_NORMALIZED
    && checks.TIMES_AND_FRESHNESS_DETERMINISTIC
    && checks.READ_CLIENT_SURFACE_EXACT;
  const failClosedVerified = checks.NOT_CONFIGURED_FAIL_CLOSED
    && checks.CREDENTIALS_UNAVAILABLE_FAIL_CLOSED
    && checks.TRANSPORT_FAILURE_FAIL_CLOSED
    && checks.STALE_MARK_BLOCKS_ENTRY_ONLY
    && checks.MISSING_RULES_BLOCK_ENTRY_ONLY
    && checks.MISSING_ACCOUNT_NOT_FLAT
    && checks.UNKNOWN_BALANCE_NOT_ZERO
    && checks.UNKNOWN_POSITION_NOT_ZERO;
  const allChecksPass = Object.values(checks).every((value) => value === true);

  return Object.freeze({
    QUALIFICATION_MODE: 'OFFLINE',
    SCHEMA_VERSION: BINANCE_L1A_Q0_SCHEMA_VERSION,
    READ_SOURCE: BINANCE_L1A_SOURCE,
    READ_SCHEMA_VERSION: BINANCE_L1A_SCHEMA_VERSION,
    AUTH_NETWORK_USED: false,
    REAL_CREDENTIAL_USED: false,
    REAL_CREDENTIAL_DISCOVERY: false,
    PRODUCTION_CONNECTIVITY_VERIFIED: false,
    READ_CONTRACT_VERIFIED: readContractVerified,
    FAIL_CLOSED_VERIFIED: failClosedVerified,
    MUTATION_SURFACE_PRESENT: hasMutationSurface,
    LIVE_READY: false,
    EXECUTION_AUTHORITY_GRANTED: false,
    READY_FOR_REAL_READ_QUALIFICATION: allChecksPass,
    ACCOUNT_OBSERVED_AT: account?.observedAt ?? null,
    ACCOUNT_SERVER_TIME: account?.serverTime ?? null,
    INSTRUMENT_OBSERVED_AT: instrument?.observedAt ?? null,
    INSTRUMENT_SERVER_TIME: instrument?.serverTime ?? null,
    CHECKS: checks,
  });
}
