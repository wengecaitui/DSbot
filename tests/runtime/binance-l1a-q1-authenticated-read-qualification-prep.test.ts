import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  BINANCE_L1A_SCHEMA_VERSION,
  BINANCE_L1A_SOURCE,
  type BinanceAccountTruthSnapshot,
  type BinanceAuthenticatedReadStatus,
  type BinanceInstrumentFactsSnapshot,
  type BinanceReadResult,
} from '../../src/runtime/binance/BinanceAuthenticatedReadFoundation';
import {
  BINANCE_L1A_Q0_SCHEMA_VERSION,
  BINANCE_L1A_READ_CLIENT_METHODS,
  type BinanceOfflineQualificationReceipt,
} from '../../src/runtime/binance/BinanceOfflineReadQualification';
import {
  BINANCE_L1A_Q1_SCHEMA_VERSION,
  MAX_QUALIFICATION_SYMBOLS,
  createBinanceAuthenticatedReadQualificationRequest,
  evaluateBinanceAuthenticatedReadQualification,
  type BinanceAuthenticatedReadQualificationEvidence,
} from '../../src/runtime/binance/BinanceAuthenticatedReadQualification';

const identity = Object.freeze({ exchange: 'binance' as const, accountId: 'q1-logical-account' });
const SYMBOLS = Object.freeze(['ADAUSDT', 'SOLUSDT']);
const OBSERVED_AT = 10_000;
const SERVER_TIME = 9_950;

const q0Checks = Object.freeze({
  NOT_CONFIGURED_FAIL_CLOSED: true,
  CREDENTIALS_UNAVAILABLE_FAIL_CLOSED: true,
  TRANSPORT_FAILURE_FAIL_CLOSED: true,
  ACCOUNT_TRUTH_NORMALIZED: true,
  INSTRUMENT_FACTS_NORMALIZED: true,
  STALE_MARK_BLOCKS_ENTRY_ONLY: true,
  MISSING_RULES_BLOCK_ENTRY_ONLY: true,
  MISSING_ACCOUNT_NOT_FLAT: true,
  UNKNOWN_BALANCE_NOT_ZERO: true,
  UNKNOWN_POSITION_NOT_ZERO: true,
  TIMES_AND_FRESHNESS_DETERMINISTIC: true,
  READ_CLIENT_SURFACE_EXACT: true,
  MUTATION_METHOD_UNREACHABLE: true,
  RECEIPT_CANNOT_GRANT_AUTHORITY: true,
});

const validQ0Receipt: BinanceOfflineQualificationReceipt = Object.freeze({
  QUALIFICATION_MODE: 'OFFLINE',
  SCHEMA_VERSION: BINANCE_L1A_Q0_SCHEMA_VERSION,
  READ_SOURCE: BINANCE_L1A_SOURCE,
  READ_SCHEMA_VERSION: BINANCE_L1A_SCHEMA_VERSION,
  AUTH_NETWORK_USED: false,
  REAL_CREDENTIAL_USED: false,
  REAL_CREDENTIAL_DISCOVERY: false,
  PRODUCTION_CONNECTIVITY_VERIFIED: false,
  READ_CONTRACT_VERIFIED: true,
  FAIL_CLOSED_VERIFIED: true,
  MUTATION_SURFACE_PRESENT: false,
  LIVE_READY: false,
  EXECUTION_AUTHORITY_GRANTED: false,
  READY_FOR_REAL_READ_QUALIFICATION: true,
  ACCOUNT_OBSERVED_AT: OBSERVED_AT,
  ACCOUNT_SERVER_TIME: SERVER_TIME,
  INSTRUMENT_OBSERVED_AT: OBSERVED_AT,
  INSTRUMENT_SERVER_TIME: SERVER_TIME,
  CHECKS: q0Checks,
});

function accountSnapshot(
  overrides: Partial<BinanceAccountTruthSnapshot> = {},
): BinanceAccountTruthSnapshot {
  return {
    identity,
    accountState: 'FLAT',
    balances: [{ asset: 'USDT', walletBalance: 0, availableBalance: 0 }],
    positions: [],
    openOrders: [],
    recentFills: [],
    serverTime: SERVER_TIME,
    accountUpdateTime: 9_900,
    observedAt: OBSERVED_AT,
    freshness: { status: 'FRESH', ageMs: 100, staleAfterMs: 1_000 },
    source: BINANCE_L1A_SOURCE,
    schemaVersion: BINANCE_L1A_SCHEMA_VERSION,
    sequence: 'q1-1',
    ...overrides,
  };
}

function instrumentSnapshot(
  symbol: string,
  overrides: Partial<BinanceInstrumentFactsSnapshot> = {},
): BinanceInstrumentFactsSnapshot {
  return {
    symbol,
    markPrice: 100,
    tickSize: 0.01,
    stepSize: 0.001,
    minQty: 0.001,
    minNotional: 5,
    contractStatus: 'TRADING',
    serverTime: SERVER_TIME,
    markPriceTime: 9_925,
    observedAt: OBSERVED_AT,
    freshness: { status: 'FRESH', ageMs: 75, staleAfterMs: 1_000 },
    source: BINANCE_L1A_SOURCE,
    schemaVersion: BINANCE_L1A_SCHEMA_VERSION,
    ...overrides,
  };
}

function available<T>(value: T): BinanceReadResult<T> {
  return Object.freeze({ availability: 'AVAILABLE', value, reason: null });
}

function unknown<T>(reason: BinanceReadResult<T>['reason']): BinanceReadResult<T> {
  return Object.freeze({ availability: 'UNKNOWN', value: null, reason });
}

function unavailable<T>(reason: BinanceReadResult<T>['reason']): BinanceReadResult<T> {
  return Object.freeze({ availability: 'UNAVAILABLE', value: null, reason });
}

function status(overrides: Partial<BinanceAuthenticatedReadStatus> = {}): BinanceAuthenticatedReadStatus {
  return {
    configured: true,
    connected: false,
    identity,
    lastObservedAt: null,
    reason: null,
    realClientDefaultWired: false,
    realCredentialDiscovery: false,
    ...overrides,
  };
}

function validEvidence(
  overrides: Partial<BinanceAuthenticatedReadQualificationEvidence> = {},
): BinanceAuthenticatedReadQualificationEvidence {
  const request = createBinanceAuthenticatedReadQualificationRequest({
    qualificationMode: 'OFFLINE_SIMULATION',
    runId: 'q1-offline-run-001',
    identity,
    requestedSymbols: SYMBOLS,
  });
  return {
    request,
    readClientMethodNames: BINANCE_L1A_READ_CLIENT_METHODS,
    statusBeforeRead: status(),
    statusAfterRead: status({ connected: true, lastObservedAt: OBSERVED_AT }),
    accountResult: available(accountSnapshot()),
    instrumentResults: request.REQUESTED_SYMBOLS.map((symbol) => ({
      requestedSymbol: symbol,
      result: available(instrumentSnapshot(symbol)),
    })),
    transportClassification: 'NO_ERROR',
    invocationCounts: {
      accountTruthReadCount: 1,
      instrumentFactsReadCounts: request.REQUESTED_SYMBOLS.map((symbol) => ({ symbol, count: 1 })),
    },
    unexpectedErrorCodes: [],
    mutationAttemptCount: 0,
    authNetworkUsed: false,
    realCredentialUsed: false,
    productionConnectivityVerified: false,
    q0Receipt: validQ0Receipt,
    ...overrides,
  };
}

function receipt(overrides: Partial<BinanceAuthenticatedReadQualificationEvidence> = {}) {
  return evaluateBinanceAuthenticatedReadQualification(validEvidence(overrides));
}

describe('Binance L1A Q1 authenticated-read qualification prep', () => {
  it('1. OFFLINE_SIMULATION can never verify a real authenticated read', () => {
    const observed = receipt();
    assert.equal(observed.QUALIFICATION_MODE, 'OFFLINE_SIMULATION');
    assert.equal(observed.REAL_READ_VERIFIED, false);
    assert.equal(Object.values(observed.CHECKS).every(Boolean), true);
  });

  it('2. offline mode records no authenticated network use', () => {
    assert.equal(receipt().AUTH_NETWORK_USED, false);
  });

  it('3. offline mode records no real credential use or discovery', () => {
    assert.equal(receipt().REAL_CREDENTIAL_USED, false);
    assert.equal(receipt().REAL_CREDENTIAL_DISCOVERY, false);
  });

  it('4. offline mode cannot verify production connectivity', () => {
    assert.equal(receipt().PRODUCTION_CONNECTIVITY_VERIFIED, false);
  });

  it('5. the exact inherited six-method read surface passes', () => {
    const observed = receipt();
    assert.equal(observed.READ_CLIENT_SURFACE_EXACT, true);
    assert.equal(observed.MUTATION_SURFACE_PRESENT, false);
    assert.deepEqual([...BINANCE_L1A_READ_CLIENT_METHODS].sort(), [
      'getAccount', 'getInstrumentRules', 'getMarkPrice',
      'getOpenOrders', 'getRecentFills', 'getServerTime',
    ]);
  });

  it('6. any seventh callable surface fails exact validation', () => {
    const observed = receipt({ readClientMethodNames: [...BINANCE_L1A_READ_CLIENT_METHODS, 'diagnostic'] });
    assert.equal(observed.READ_CLIENT_SURFACE_EXACT, false);
    assert.equal(observed.MUTATION_SURFACE_PRESENT, true);
  });

  it('7. submitOrder surface fails closed', () => {
    assert.equal(receipt({ readClientMethodNames: [...BINANCE_L1A_READ_CLIENT_METHODS, 'submitOrder'] })
      .MUTATION_SURFACE_PRESENT, true);
  });

  it('8. cancelOrder surface fails closed', () => {
    assert.equal(receipt({ readClientMethodNames: [...BINANCE_L1A_READ_CLIENT_METHODS, 'cancelOrder'] })
      .MUTATION_SURFACE_PRESENT, true);
  });

  it('9. setLeverage surface fails closed', () => {
    assert.equal(receipt({ readClientMethodNames: [...BINANCE_L1A_READ_CLIENT_METHODS, 'setLeverage'] })
      .MUTATION_SURFACE_PRESENT, true);
  });

  it('10. an explicit Binance logical identity is required', () => {
    assert.throws(() => createBinanceAuthenticatedReadQualificationRequest({
      qualificationMode: 'OFFLINE_SIMULATION',
      runId: 'q1-offline-run-001',
      identity: null as never,
      requestedSymbols: SYMBOLS,
    }), /BINANCE_Q1_IDENTITY_INVALID/);
  });

  it('11. account identity mismatch fails qualification', () => {
    const mismatched = accountSnapshot({
      identity: { exchange: 'binance', accountId: 'different-account' },
    });
    assert.equal(receipt({ accountResult: available(mismatched) }).CHECKS.ACCOUNT_IDENTITY_MATCH, false);
  });

  it('12. an empty symbol set is rejected by the request contract', () => {
    assert.throws(() => createBinanceAuthenticatedReadQualificationRequest({
      qualificationMode: 'OFFLINE_SIMULATION', runId: 'q1-run', identity, requestedSymbols: [],
    }), /BINANCE_Q1_REQUESTED_SYMBOLS_INVALID/);
  });

  it('13. duplicate symbols are rejected instead of silently collapsing reads', () => {
    assert.throws(() => createBinanceAuthenticatedReadQualificationRequest({
      qualificationMode: 'OFFLINE_SIMULATION', runId: 'q1-run', identity,
      requestedSymbols: ['SOLUSDT', 'SOLUSDT'],
    }), /BINANCE_Q1_REQUESTED_SYMBOLS_INVALID/);
  });

  it('14. symbol count over the conservative maximum is rejected', () => {
    assert.equal(MAX_QUALIFICATION_SYMBOLS, 3);
    assert.throws(() => createBinanceAuthenticatedReadQualificationRequest({
      qualificationMode: 'OFFLINE_SIMULATION', runId: 'q1-run', identity,
      requestedSymbols: ['ADAUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'],
    }), /BINANCE_Q1_REQUESTED_SYMBOLS_INVALID/);
  });

  it('15. requested symbols are ordered deterministically', () => {
    const first = createBinanceAuthenticatedReadQualificationRequest({
      qualificationMode: 'OFFLINE_SIMULATION', runId: 'q1-run', identity,
      requestedSymbols: ['SOLUSDT', 'ADAUSDT'],
    });
    const second = createBinanceAuthenticatedReadQualificationRequest({
      qualificationMode: 'OFFLINE_SIMULATION', runId: 'q1-run', identity,
      requestedSymbols: ['ADAUSDT', 'SOLUSDT'],
    });
    assert.deepEqual(first, second);
    assert.deepEqual(first.REQUESTED_SYMBOLS, ['ADAUSDT', 'SOLUSDT']);
  });

  it('16. an AVAILABLE normalized account is recognized', () => {
    const observed = receipt();
    assert.equal(observed.ACCOUNT_READ_AVAILABLE, true);
    assert.equal(observed.CHECKS.BALANCE_FACTS_NORMALIZED, true);
  });

  it('17. UNKNOWN account truth fails qualification', () => {
    const observed = receipt({ accountResult: unknown('BINANCE_READ_TRANSPORT_FAILED') });
    assert.equal(observed.CHECKS.ACCOUNT_AVAILABLE, false);
    assert.equal(observed.REAL_READ_VERIFIED, false);
  });

  it('18. UNAVAILABLE account truth fails qualification', () => {
    const observed = receipt({ accountResult: unavailable('BINANCE_READ_CREDENTIALS_UNAVAILABLE') });
    assert.equal(observed.CHECKS.ACCOUNT_AVAILABLE, false);
    assert.equal(observed.REAL_READ_VERIFIED, false);
  });

  it('19. missing account truth is never projected as FLAT', () => {
    const observed = receipt({ accountResult: unknown('ACCOUNT_TRUTH_MISSING') });
    assert.equal(observed.ACCOUNT_STATE, null);
    assert.notEqual(observed.ACCOUNT_STATE, 'FLAT');
  });

  it('20. an unknown balance is not converted to zero', () => {
    const malformed = accountSnapshot({
      balances: [{ asset: 'USDT', walletBalance: Number.NaN, availableBalance: 0 }],
    });
    const observed = receipt({ accountResult: available(malformed) });
    assert.equal(observed.CHECKS.BALANCE_FACTS_NORMALIZED, false);
    assert.equal(observed.BALANCE_COUNT, null);
  });

  it('21. an unknown position is not converted to zero', () => {
    const malformed = accountSnapshot({
      positions: [{
        symbol: 'SOLUSDT', quantity: Number.NaN, side: 'FLAT', entryPrice: 0,
        markPrice: 100, unrealizedPnl: 0, marginMode: 'CROSS', leverage: 1, updatedAt: 9_900,
      }],
    });
    const observed = receipt({ accountResult: available(malformed) });
    assert.equal(observed.CHECKS.POSITION_FACTS_NORMALIZED, false);
    assert.equal(observed.POSITION_COUNT, null);
  });

  it('22. a missing instrument result fails qualification', () => {
    assert.equal(receipt({ instrumentResults: [] }).CHECKS.INSTRUMENT_FACTS_AVAILABLE, false);
  });

  it('23. an unknown mark price fails qualification', () => {
    const base = validEvidence();
    const instrumentResults = base.instrumentResults.map((entry, index) => index === 0
      ? { ...entry, result: unknown<BinanceInstrumentFactsSnapshot>('MARK_PRICE_UNKNOWN') }
      : entry);
    assert.equal(receipt({ instrumentResults }).CHECKS.INSTRUMENT_FACTS_AVAILABLE, false);
  });

  it('24. a stale mark cannot satisfy Q1 freshness', () => {
    const base = validEvidence();
    const instrumentResults = base.instrumentResults.map((entry, index) => index === 0
      ? {
          ...entry,
          result: available(instrumentSnapshot(entry.requestedSymbol, {
            freshness: { status: 'STALE', ageMs: 5_001, staleAfterMs: 1_000 },
          })),
        }
      : entry);
    assert.equal(receipt({ instrumentResults }).CHECKS.INSTRUMENT_FRESHNESS_FRESH, false);
  });

  it('25. instrument symbol mismatch fails identity binding', () => {
    const base = validEvidence();
    const instrumentResults = base.instrumentResults.map((entry, index) => index === 0
      ? { ...entry, result: available(instrumentSnapshot('XRPUSDT')) }
      : entry);
    assert.equal(receipt({ instrumentResults }).CHECKS.SYMBOL_IDENTITY_MATCH, false);
  });

  it('26. malformed market rules fail qualification', () => {
    const base = validEvidence();
    const instrumentResults = base.instrumentResults.map((entry, index) => index === 0
      ? { ...entry, result: available(instrumentSnapshot(entry.requestedSymbol, { tickSize: 0, minNotional: 0 })) }
      : entry);
    const observed = receipt({ instrumentResults });
    assert.equal(observed.CHECKS.TICK_SIZE_POSITIVE, false);
    assert.equal(observed.CHECKS.MIN_NOTIONAL_POSITIVE, false);
  });

  it('27. accountTruth.read count must be exactly one', () => {
    const base = validEvidence();
    assert.equal(receipt({
      invocationCounts: { ...base.invocationCounts, accountTruthReadCount: 2 },
    }).CHECKS.ACCOUNT_READ_COUNT_EXACT, false);
  });

  it('28. instrument reads over one per requested symbol fail without retry', () => {
    const base = validEvidence();
    const counts = base.invocationCounts.instrumentFactsReadCounts.map((entry, index) =>
      index === 0 ? { ...entry, count: 2 } : entry);
    assert.equal(receipt({
      invocationCounts: { accountTruthReadCount: 1, instrumentFactsReadCounts: counts },
    }).CHECKS.INSTRUMENT_READ_COUNTS_BOUNDED, false);
  });

  it('29. any mutation-attempt evidence fails qualification', () => {
    assert.equal(receipt({ mutationAttemptCount: 1 }).CHECKS.NO_MUTATION_ATTEMPT, false);
  });

  it('30. an unexpected apiKey field is rejected and never serialized', () => {
    const evidence = { ...validEvidence(), apiKey: 'do-not-serialize-q1' } as unknown as BinanceAuthenticatedReadQualificationEvidence;
    const observed = evaluateBinanceAuthenticatedReadQualification(evidence);
    assert.equal(observed.CHECKS.NO_SECRET_IN_RECEIPT, false);
    assert.doesNotMatch(JSON.stringify(observed), /do-not-serialize-q1/);
  });

  it('31. an unexpected secretKey field is rejected and never serialized', () => {
    const evidence = { ...validEvidence(), secretKey: 'do-not-serialize-q1' } as unknown as BinanceAuthenticatedReadQualificationEvidence;
    const observed = evaluateBinanceAuthenticatedReadQualification(evidence);
    assert.equal(observed.CHECKS.NO_SECRET_IN_RECEIPT, false);
    assert.doesNotMatch(JSON.stringify(observed), /do-not-serialize-q1/);
  });

  it('32. Authorization material is rejected and never serialized', () => {
    const evidence = { ...validEvidence(), Authorization: 'Bearer do-not-serialize-q1' } as unknown as BinanceAuthenticatedReadQualificationEvidence;
    const observed = evaluateBinanceAuthenticatedReadQualification(evidence);
    assert.equal(observed.CHECKS.NO_SECRET_IN_RECEIPT, false);
    assert.doesNotMatch(JSON.stringify(observed), /Bearer do-not-serialize-q1/);
  });

  it('33. Q0 satisfies only the offline prerequisite contract', () => {
    const observed = receipt();
    assert.equal(observed.Q0_PRECONDITION_SATISFIED, true);
    assert.equal(observed.CHECKS.Q0_PRECONDITION_SATISFIED, true);
  });

  it('34. Q0 cannot establish account truth, market truth, or connectivity', () => {
    const observed = receipt();
    assert.equal(observed.Q0_RECEIPT_USED_AS_ACCOUNT_TRUTH, false);
    assert.equal(observed.Q0_RECEIPT_USED_AS_MARKET_TRUTH, false);
    assert.equal(observed.Q0_RECEIPT_IMPLIES_CONNECTIVITY, false);
    assert.equal(observed.PRODUCTION_CONNECTIVITY_VERIFIED, false);
  });

  it('35. every execution and activation authority remains literal false', () => {
    const observed = receipt();
    assert.equal(observed.LIVE_READY, false);
    assert.equal(observed.EXECUTION_AUTHORITY_GRANTED, false);
    assert.equal(observed.TESTNET_AUTHORITY_GRANTED, false);
    assert.equal(observed.REAL_ORDER_AUTHORITY_GRANTED, false);
    assert.equal(observed.READY_FOR_L1B_EVALUATION, false);
  });

  it('36. configured and connected status must be identity-bound', () => {
    const observed = receipt();
    assert.equal(observed.STATUS_CONFIGURED, true);
    assert.equal(observed.STATUS_CONNECTED, true);
    const mismatched = status({
      connected: true,
      lastObservedAt: OBSERVED_AT,
      identity: { exchange: 'binance', accountId: 'different-account' },
    });
    assert.equal(receipt({ statusAfterRead: mismatched }).CHECKS.STATUS_CONFIGURED, false);
  });

  it('37. unexpected transport failure remains factual failure', () => {
    const observed = receipt({
      transportClassification: 'UNEXPECTED_FAILURE',
      unexpectedErrorCodes: ['TRANSPORT_ABORTED'],
    });
    assert.equal(observed.CHECKS.NO_UNEXPECTED_TRANSPORT_ERROR, false);
    assert.equal(observed.REAL_READ_VERIFIED, false);
  });

  it('38. timestamps and repeated evaluation are deterministic', () => {
    const proof = validEvidence();
    const first = evaluateBinanceAuthenticatedReadQualification(proof);
    const second = evaluateBinanceAuthenticatedReadQualification(proof);
    assert.deepEqual(first, second);
    assert.equal(first.ACCOUNT_OBSERVED_AT, OBSERVED_AT);
    assert.equal(first.ACCOUNT_SERVER_TIME, SERVER_TIME);
    assert.equal(first.LAST_OBSERVED_AT, OBSERVED_AT);
  });

  it('39. request, receipt, identity, symbols, and checks are immutable', () => {
    const proof = validEvidence();
    const observed = evaluateBinanceAuthenticatedReadQualification(proof);
    assert.equal(Object.isFrozen(proof.request), true);
    assert.equal(Object.isFrozen(proof.request.IDENTITY), true);
    assert.equal(Object.isFrozen(proof.request.REQUESTED_SYMBOLS), true);
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(Object.isFrozen(observed.IDENTITY), true);
    assert.equal(Object.isFrozen(observed.REQUESTED_SYMBOLS), true);
    assert.equal(Object.isFrozen(observed.CHECKS), true);
  });

  it('40. Q1 prep adds no network, credential discovery, production owner, or mutation implementation', () => {
    const source = readFileSync(resolve(
      process.cwd(), 'src/runtime/binance/BinanceAuthenticatedReadQualification.ts',
    ), 'utf8');
    assert.equal(BINANCE_L1A_Q1_SCHEMA_VERSION, 'BINANCE_L1A_Q1_V1');
    assert.equal(validQ0Receipt.SCHEMA_VERSION, BINANCE_L1A_Q0_SCHEMA_VERSION);
    assert.equal(validQ0Receipt.READ_SCHEMA_VERSION, BINANCE_L1A_SCHEMA_VERSION);
    assert.doesNotMatch(source, /process\.env|dotenv|fetch\(|axios|https\.request|WebSocket|Binance REST|HMAC|recvWindow/);
    assert.doesNotMatch(source, /ProductionRuntimeOwner|ProductionSpine|PreTradeRiskGateway|OmsCore|PositionManager/);
    assert.doesNotMatch(source, /export\s+(?:async\s+)?(?:function|const|class)\s+\w*(?:submit|place|cancel|modify|leverage|margin)/i);
  });

  it('41. source or schema drift fails qualification', () => {
    const drifted = accountSnapshot({ schemaVersion: 'DRIFTED' as never });
    assert.equal(receipt({ accountResult: available(drifted) }).CHECKS.READ_SOURCE_SCHEMA_MATCH, false);
  });

  it('42. a fabricated FRESH label with inconsistent age fails qualification', () => {
    const fabricated = accountSnapshot({
      freshness: { status: 'FRESH', ageMs: 1, staleAfterMs: 1_000 },
    });
    assert.equal(receipt({ accountResult: available(fabricated) }).CHECKS.ACCOUNT_FRESHNESS_KNOWN, false);
  });

  it('43. FLAT cannot coexist with a factual nonzero position', () => {
    const inconsistent = accountSnapshot({
      accountState: 'FLAT',
      positions: [{
        symbol: 'SOLUSDT', quantity: 1, side: 'LONG', entryPrice: 100,
        markPrice: 101, unrealizedPnl: 1, marginMode: 'CROSS', leverage: 1, updatedAt: 9_900,
      }],
    });
    assert.equal(receipt({ accountResult: available(inconsistent) }).CHECKS.ACCOUNT_STATE_CONSISTENT, false);
  });

  it('44. offline evidence cannot claim network, credential, or connectivity facts', () => {
    const observed = receipt({
      authNetworkUsed: true,
      realCredentialUsed: true,
      productionConnectivityVerified: true,
    });
    assert.equal(observed.CHECKS.MODE_EVIDENCE_CONSISTENT, false);
    assert.equal(observed.AUTH_NETWORK_USED, false);
    assert.equal(observed.REAL_CREDENTIAL_USED, false);
    assert.equal(observed.PRODUCTION_CONNECTIVITY_VERIFIED, false);
    assert.equal(observed.REAL_READ_VERIFIED, false);
  });

  it('45. tampered request shape fails closed without exposing request fields', () => {
    const base = validEvidence();
    const request = { ...base.request, EXTRA_FIELD: 'not-allowed' } as never;
    const observed = receipt({ request });
    assert.equal(observed.CHECKS.REQUEST_SHAPE_EXACT, false);
    assert.equal(observed.RUN_ID, null);
    assert.deepEqual(observed.REQUESTED_SYMBOLS, []);
    assert.equal(observed.REAL_READ_VERIFIED, false);
  });

  it('46. malformed position facts fail closed without projecting FLAT', () => {
    const malformed = accountSnapshot({ positions: [null] as never });
    const observed = receipt({ accountResult: available(malformed) });
    assert.equal(observed.CHECKS.POSITION_FACTS_NORMALIZED, false);
    assert.equal(observed.CHECKS.ACCOUNT_STATE_CONSISTENT, false);
    assert.equal(observed.ACCOUNT_STATE, null);
    assert.equal(observed.REAL_READ_VERIFIED, false);
  });

  it('47. malformed instrument evidence fails closed without throwing', () => {
    const observed = receipt({ instrumentResults: [null] as never });
    assert.equal(observed.CHECKS.INSTRUMENT_FACTS_AVAILABLE, false);
    assert.equal(observed.CHECKS.INSTRUMENT_FRESHNESS_FRESH, false);
    assert.equal(observed.REAL_READ_VERIFIED, false);
  });

  it('48. malformed instrument freshness fails closed without throwing', () => {
    const malformed = instrumentSnapshot({ freshness: null as never });
    const observed = receipt({
      instrumentResults: [{ requestedSymbol: 'SOLUSDT', result: available(malformed) }],
    });
    assert.equal(observed.CHECKS.INSTRUMENT_FRESHNESS_KNOWN, false);
    assert.equal(observed.CHECKS.INSTRUMENT_FRESHNESS_FRESH, false);
    assert.equal(observed.REAL_READ_VERIFIED, false);
  });

  it('49. REAL_AUTHENTICATED_NETWORK label alone cannot verify a real read', () => {
    const request = createBinanceAuthenticatedReadQualificationRequest({
      qualificationMode: 'REAL_AUTHENTICATED_NETWORK',
      runId: 'q1-real-mode-label-only',
      identity,
      requestedSymbols: SYMBOLS,
    });

    const labelOnly = receipt({ request });
    assert.equal(labelOnly.QUALIFICATION_MODE, 'REAL_AUTHENTICATED_NETWORK');
    assert.equal(labelOnly.CHECKS.REQUEST_SHAPE_EXACT, true);
    assert.equal(labelOnly.CHECKS.MODE_EVIDENCE_CONSISTENT, false);
    assert.equal(Object.entries(labelOnly.CHECKS)
      .filter(([name]) => name !== 'MODE_EVIDENCE_CONSISTENT')
      .every(([, passed]) => passed), true);
    assert.equal(labelOnly.AUTH_NETWORK_USED, false);
    assert.equal(labelOnly.REAL_CREDENTIAL_USED, false);
    assert.equal(labelOnly.PRODUCTION_CONNECTIVITY_VERIFIED, false);
    assert.equal(labelOnly.REAL_READ_VERIFIED, false);
    assert.equal(labelOnly.LIVE_READY, false);
    assert.equal(labelOnly.EXECUTION_AUTHORITY_GRANTED, false);
    assert.equal(labelOnly.TESTNET_AUTHORITY_GRANTED, false);
    assert.equal(labelOnly.REAL_ORDER_AUTHORITY_GRANTED, false);

    const missingAuthNetwork = receipt({
      request,
      authNetworkUsed: false,
      realCredentialUsed: true,
      productionConnectivityVerified: true,
    });
    assert.equal(missingAuthNetwork.CHECKS.MODE_EVIDENCE_CONSISTENT, false);
    assert.equal(Object.entries(missingAuthNetwork.CHECKS)
      .filter(([name]) => name !== 'MODE_EVIDENCE_CONSISTENT')
      .every(([, passed]) => passed), true);
    assert.equal(missingAuthNetwork.REAL_READ_VERIFIED, false);

    const missingRealCredential = receipt({
      request,
      authNetworkUsed: true,
      realCredentialUsed: false,
      productionConnectivityVerified: true,
    });
    assert.equal(missingRealCredential.CHECKS.MODE_EVIDENCE_CONSISTENT, false);
    assert.equal(Object.entries(missingRealCredential.CHECKS)
      .filter(([name]) => name !== 'MODE_EVIDENCE_CONSISTENT')
      .every(([, passed]) => passed), true);
    assert.equal(missingRealCredential.REAL_READ_VERIFIED, false);
  });
});
