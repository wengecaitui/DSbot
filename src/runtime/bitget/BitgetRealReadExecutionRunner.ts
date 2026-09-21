/**
 * Bitget L1A real authenticated-read execution runner (execution prep).
 *
 * One-shot, GET-only, budget-capped runner for a future single real authenticated read against Bitget
 * USDT-FUTURES. This phase builds and tests it OFFLINE: no real credential, no api.bitget.com, no
 * Demo/Testnet, no execution authority.
 *
 * Provenance model (the reason a fake cannot claim a real run):
 *   1. the production transport is created only by the L0 `createProductionBitgetReadTransport()`,
 *      which binds the ambient `globalThis.fetch` and accepts no caller-supplied fetch;
 *   2. membership is tracked in a module-private WeakSet, so a structural lookalike, a caller boolean
 *      or a branded object can never satisfy `hasProductionBitgetReadTransportProvenance`;
 *   3. request counters live in a module-private WeakMap, so a run's GET count cannot be faked;
 *   4. the receipt MODE is DERIVED from (1)+(3)+(an explicit authorization) and is never taken from a
 *      caller string. The mode label identifies which code path ran; it never certifies that a real
 *      exchange answered - `PRODUCTION_CONNECTIVITY_VERIFIED`/`REAL_READ_VERIFIED` stay false and
 *      remain an auditor's verdict, not a runner self-claim.
 *
 * Credentials: explicit injection only. This module contains no environment, dotenv or filesystem
 * access and never discovers `.bitget.env`.
 */
import {
  BITGET_L0_PRODUCTION_ORIGIN,
  BITGET_L1A_INITIAL_SYMBOL,
  BITGET_L1A_MARGIN_COIN,
  BITGET_L1A_PRODUCT_TYPE,
  BITGET_READ_ENDPOINTS,
  type BitgetReadCredential,
  type BitgetReadFailureReason,
  type BitgetReadTransport,
} from './BitgetReadContracts';
import {
  BitgetReadTransportError,
  createBitgetReadTransport,
  createProductionBitgetReadTransport,
  getBitgetReadRequestCount,
  hasProductionBitgetReadTransportProvenance,
  type BitgetReadFetch,
} from './BitgetReadTransport';
import {
  createBitgetReadClock,
  observeBitgetServerTime,
  type BitgetReadClock,
  type BitgetServerTimeObservation,
} from './BitgetReadClock';
import {
  BitgetReadClientError,
  type BitgetReadIdentity,
} from './BitgetAuthenticatedReadClient';
import {
  BITGET_L1A_SOURCE,
  BITGET_L1A_VERSION,
  createBitgetAuthenticatedReadFoundation,
  evaluateBitgetNewEntryReadiness,
  type BitgetCanonicalAccountTruth,
  type BitgetCanonicalInstrumentFacts,
  type BitgetEntryReadiness,
} from './BitgetAuthenticatedReadFoundation';
import { BITGET_Q0_MAX_ACCOUNT_SNAPSHOT_GETS, BITGET_Q0_MAX_INSTRUMENT_SNAPSHOT_GETS } from './BitgetOfflineReadQualification';

export const BITGET_REAL_READ_SCHEMA_VERSION = 'BITGET_L1A_REAL_READ_V1' as const;

export const BITGET_REAL_READ_MODES = Object.freeze({
  OFFLINE_SIMULATION: 'OFFLINE_SIMULATION',
  REAL_AUTHENTICATED_NETWORK: 'REAL_AUTHENTICATED_NETWORK',
} as const);
export type BitgetRealReadMode = typeof BITGET_REAL_READ_MODES[keyof typeof BITGET_REAL_READ_MODES];

/** Strict GET ceiling for the whole run: 1 server-time preflight + 5 account + 3 instrument. */
export const MAX_BITGET_REAL_READ_GETS = 9 as const;
export const MAX_BITGET_SERVER_TIME_PREFLIGHT_GETS = 1 as const;
export const MAX_BITGET_REAL_READ_ACCOUNT_GETS = BITGET_Q0_MAX_ACCOUNT_SNAPSHOT_GETS;
export const MAX_BITGET_REAL_READ_INSTRUMENT_GETS = BITGET_Q0_MAX_INSTRUMENT_SNAPSHOT_GETS;

export const BITGET_REAL_READ_BUDGET_EXCEEDED = 'BITGET_REAL_READ_BUDGET_EXCEEDED' as const;

/** Sanitized diagnostic: code/status/reason only - never a body, exchange message or credential. */
export interface BitgetReadDiagnostic {
  readonly phase: 'SERVER_TIME_PREFLIGHT' | 'ACCOUNT_TRUTH' | 'INSTRUMENT_FACTS' | 'REQUEST';
  readonly endpoint: string | null;
  readonly transportCode: string | null;
  readonly httpStatus: number | null;
  readonly bitgetCode: string | null;
  readonly reason: BitgetReadFailureReason | string | null;
}

export interface BitgetRealReadRunnerOptions {
  /** Explicitly injected credential. No environment or file discovery is performed. */
  readonly credential: BitgetReadCredential | null;
  readonly identity: BitgetReadIdentity;
  readonly symbol?: string;
  /** Explicit clock injection. */
  readonly now: () => number;
  readonly runId: string;
  /**
   * Simulation-only injection. When present the runner can never claim real-network mode, because the
   * transport is created through the injectable factory and therefore carries no production
   * provenance.
   */
  readonly fetchImpl?: BitgetReadFetch;
  /** Explicit authorization evidence; without it the derived mode stays OFFLINE_SIMULATION. */
  readonly realReadAuthorized?: boolean;
}

export interface BitgetRealReadReceipt {
  readonly SCHEMA_VERSION: typeof BITGET_REAL_READ_SCHEMA_VERSION;
  readonly MODE: BitgetRealReadMode;
  readonly MODE_IS_EVIDENCE_DERIVED: true;
  readonly MODE_STRING_PROVES_NETWORK: false;
  readonly RUN_ID: string;
  readonly SYMBOL: string;
  readonly PRODUCT_TYPE: typeof BITGET_L1A_PRODUCT_TYPE;
  readonly MARGIN_COIN: typeof BITGET_L1A_MARGIN_COIN;
  readonly SOURCE: typeof BITGET_L1A_SOURCE;
  readonly VERSION: typeof BITGET_L1A_VERSION;
  readonly PRODUCTION_TRANSPORT_PROVENANCE: boolean;
  readonly REAL_READ_AUTHORIZED: boolean;
  readonly SERVER_TIME_PREFLIGHT_PERFORMED: boolean;
  readonly SERVER_TIME_OBSERVED: boolean;
  readonly SERVER_TIME_OFFSET_MS: number | null;
  readonly SERVER_TIME_WITHIN_SKEW: boolean;
  readonly ACCOUNT_TRUTH_AVAILABLE: boolean;
  readonly INSTRUMENT_FACTS_AVAILABLE: boolean;
  readonly ACCOUNT_STATE: string | null;
  readonly POSITION_COUNT: number | null;
  readonly OPEN_ORDER_COUNT: number | null;
  readonly RECENT_FILL_COUNT: number | null;
  readonly ENTRY_READINESS: BitgetEntryReadiness | null;
  readonly NETWORK_REQUEST_COUNT: number;
  readonly REQUEST_COUNT_BY_ENDPOINT: Readonly<Record<string, number>>;
  readonly MAX_REAL_READ_GETS: number;
  readonly GETS_WITHIN_BUDGET: boolean;
  readonly REQUEST_SEQUENCE: readonly string[];
  readonly DIAGNOSTICS: readonly BitgetReadDiagnostic[];
  readonly FAILURE_REASON: BitgetReadFailureReason | string | null;
  readonly REAL_CREDENTIAL_USED: false;
  readonly REAL_CREDENTIAL_DISCOVERY: false;
  readonly CREDENTIAL_INJECTED: boolean;
  readonly EXECUTION_AUTHORITY: false;
  readonly TESTNET_AUTHORITY: false;
  readonly REAL_ORDER_AUTHORITY: false;
  readonly PRODUCTION_CONNECTIVITY_VERIFIED: false;
  readonly REAL_READ_VERIFIED: false;
  readonly BITGET_ACCOUNT_TRUTH_VERIFIED: false;
  readonly BITGET_POSITION_TRUTH_VERIFIED: false;
  readonly BITGET_ORDER_TRUTH_VERIFIED: false;
  readonly BITGET_FILL_TRUTH_VERIFIED: false;
  readonly LIVE_READY: false;
}

export interface BitgetRealReadRunner {
  /** True when this runner was built on the closed production transport. */
  productionTransportProvenance(): boolean;
  /** No I/O happens before `run()`; this exists so tests can prove that. */
  requestCount(): number;
  run(): Promise<BitgetRealReadReceipt>;
}

/** Boundary predicate for the run-wide GET ceiling. */
export function bitgetRealReadBudgetCheck(totalGets: number): { readonly withinBudget: boolean } {
  return Object.freeze({ withinBudget: Number.isSafeInteger(totalGets) && totalGets >= 0 && totalGets <= MAX_BITGET_REAL_READ_GETS });
}

/**
 * Mode derivation. Real-network mode requires production provenance AND at least one counted request
 * AND an explicit authorization. A mode string on its own never proves a network round trip.
 */
export function deriveBitgetRealReadMode(input: {
  readonly productionTransportProvenance: boolean;
  readonly networkRequestCount: number;
  readonly realReadAuthorized: boolean;
}): BitgetRealReadMode {
  const real = input.productionTransportProvenance === true
    && Number.isSafeInteger(input.networkRequestCount)
    && input.networkRequestCount > 0
    && input.realReadAuthorized === true;
  return real ? BITGET_REAL_READ_MODES.REAL_AUTHENTICATED_NETWORK : BITGET_REAL_READ_MODES.OFFLINE_SIMULATION;
}

function sanitizeError(error: unknown, phase: BitgetReadDiagnostic['phase'], endpoint: string | null): BitgetReadDiagnostic {
  if (error instanceof BitgetReadTransportError) {
    return Object.freeze({
      phase,
      endpoint,
      transportCode: error.code,
      httpStatus: typeof error.httpStatus === 'number' ? error.httpStatus : null,
      bitgetCode: typeof error.bitgetCode === 'string' ? error.bitgetCode : null,
      reason: null,
    });
  }
  if (error instanceof BitgetReadClientError) {
    return Object.freeze({ phase, endpoint, transportCode: null, httpStatus: null, bitgetCode: null, reason: error.reason });
  }
  const reason = (error as { reason?: string }).reason;
  return Object.freeze({
    phase,
    endpoint,
    transportCode: null,
    httpStatus: null,
    bitgetCode: null,
    reason: typeof reason === 'string' ? reason : 'BITGET_READ_CLIENT_UNAVAILABLE',
  });
}

/**
 * Failure-reason mapping for the sanitized receipt. Mirrors the L1A client: an exchange that answered
 * and rejected the read is reported as an API rejection, a clock error keeps its own reason, and
 * anything else at the transport layer is a transport failure.
 */
function reasonFromError(error: unknown, fallback: BitgetReadFailureReason | string): BitgetReadFailureReason | string {
  const code = (error as { code?: unknown }).code;
  if (code === 'BITGET_READ_API_REJECTED' || code === 'BITGET_READ_HTTP_FAILED') {
    return 'BITGET_READ_API_REJECTED';
  }
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : fallback;
}

/** Same strictness as the foundation: only a decimal numeric string or a number may be a server time. */
function readBitgetServerTimeField(payload: unknown): unknown {
  const entry = Array.isArray(payload) ? payload[0] : payload;
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = (entry as Record<string, unknown>).serverTime ?? (entry as Record<string, unknown>).server_time ?? null;
  if (typeof raw === 'string') {
    return /^[0-9]{1,20}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  }
  return raw;
}

export function createBitgetRealReadRunner(options: BitgetRealReadRunnerOptions): BitgetRealReadRunner {
  const symbol = options.symbol ?? BITGET_L1A_INITIAL_SYMBOL;
  const credential = options.credential ?? null;
  const realReadAuthorized = options.realReadAuthorized === true;
  const clock: BitgetReadClock = createBitgetReadClock(options.now);

  // Construction performs no I/O: the production transport factory only binds the ambient fetch.
  const transport: BitgetReadTransport = options.fetchImpl === undefined
    ? createProductionBitgetReadTransport()
    : createBitgetReadTransport(options.fetchImpl);
  const productionProvenance = hasProductionBitgetReadTransportProvenance(transport);

  const diagnostics: BitgetReadDiagnostic[] = [];
  const requestSequence: string[] = [];

  function counter(): { total: number; byEndpoint: Readonly<Record<string, number>> } {
    const counts = getBitgetReadRequestCount(transport);
    return counts ?? { total: 0, byEndpoint: Object.freeze({}) };
  }

  async function run(): Promise<BitgetRealReadReceipt> {
    let serverTimeObservation: BitgetServerTimeObservation | null = null;
    let serverTimePreflightPerformed = false;
    let accountTruth: { availability: string; value: BitgetCanonicalAccountTruth | null; reason: BitgetReadFailureReason | null } | null = null;
    let instrumentFacts: { availability: string; value: BitgetCanonicalInstrumentFacts | null; reason: BitgetReadFailureReason | null } | null = null;
    let failureReason: BitgetReadFailureReason | string | null = null;

    if (credential === null) {
      failureReason = 'BITGET_READ_CREDENTIALS_UNAVAILABLE';
    } else {
      // Phase 1: server-time preflight (public, exactly one GET). Issued through the L0 transport
      // directly so the sanitized diagnostic keeps the exchange's numeric rejection code.
      serverTimePreflightPerformed = true;
      requestSequence.push(BITGET_READ_ENDPOINTS.SERVER_TIME);
      try {
        const startedMs = clock.now();
        const payload = await transport.get({
          endpoint: BITGET_READ_ENDPOINTS.SERVER_TIME,
          query: [],
        });
        const receivedMs = clock.now();
        serverTimeObservation = observeBitgetServerTime({
          serverTimeMs: readBitgetServerTimeField(payload),
          requestStartedMs: startedMs,
          responseReceivedMs: receivedMs,
        });
      } catch (error) {
        diagnostics.push(sanitizeError(error, 'SERVER_TIME_PREFLIGHT', BITGET_READ_ENDPOINTS.SERVER_TIME));
        failureReason = reasonFromError(error, 'BITGET_READ_TRANSPORT_FAILED');
      }
      if (counter().total > MAX_BITGET_SERVER_TIME_PREFLIGHT_GETS) {
        diagnostics.push(Object.freeze({
          phase: 'REQUEST' as const,
          endpoint: null,
          transportCode: BITGET_REAL_READ_BUDGET_EXCEEDED,
          httpStatus: null,
          bitgetCode: null,
          reason: BITGET_REAL_READ_BUDGET_EXCEEDED,
        }));
        failureReason = failureReason ?? BITGET_REAL_READ_BUDGET_EXCEEDED;
      }

      if (failureReason === null) {
        const foundation = createBitgetAuthenticatedReadFoundation({
          transport,
          identity: options.identity,
          now: options.now,
          credential,
        });
        // Phase 2: account truth (<= 5 GETs).
        accountTruth = await foundation.accountTruth();
        for (const endpoint of [
          BITGET_READ_ENDPOINTS.ACCOUNTS,
          BITGET_READ_ENDPOINTS.POSITIONS,
          BITGET_READ_ENDPOINTS.PENDING_ORDERS,
          BITGET_READ_ENDPOINTS.FILLS,
        ]) {
          requestSequence.push(endpoint);
        }
        if (accountTruth.availability === 'AVAILABLE') {
          // Phase 3: instrument facts (<= 3 GETs).
          instrumentFacts = await foundation.instrumentFacts(symbol);
          requestSequence.push(BITGET_READ_ENDPOINTS.CONTRACTS, BITGET_READ_ENDPOINTS.SYMBOL_PRICE);
          if (instrumentFacts.availability !== 'AVAILABLE') {
            failureReason = instrumentFacts.reason ?? 'INSTRUMENT_FACTS_MALFORMED';
            diagnostics.push(sanitizeError(
              Object.assign(new Error('instrument'), { reason: instrumentFacts.reason }),
              'INSTRUMENT_FACTS',
              BITGET_READ_ENDPOINTS.CONTRACTS,
            ));
          }
        } else {
          failureReason = accountTruth.reason ?? 'ACCOUNT_TRUTH_MISSING';
          diagnostics.push(sanitizeError(
            Object.assign(new Error('account'), { reason: accountTruth.reason }),
            'ACCOUNT_TRUTH',
            BITGET_READ_ENDPOINTS.ACCOUNTS,
          ));
        }
      }
    }

    const counts = counter();
    const budget = bitgetRealReadBudgetCheck(counts.total);
    const mode = deriveBitgetRealReadMode({
      productionTransportProvenance: productionProvenance,
      networkRequestCount: counts.total,
      realReadAuthorized,
    });
    const readiness = accountTruth !== null && instrumentFacts !== null
      ? evaluateBitgetNewEntryReadiness({
        accountTruth: accountTruth as never,
        instrumentFacts: instrumentFacts as never,
      })
      : null;

    return Object.freeze({
      SCHEMA_VERSION: BITGET_REAL_READ_SCHEMA_VERSION,
      MODE: mode,
      MODE_IS_EVIDENCE_DERIVED: true as const,
      MODE_STRING_PROVES_NETWORK: false as const,
      RUN_ID: options.runId,
      SYMBOL: symbol,
      PRODUCT_TYPE: BITGET_L1A_PRODUCT_TYPE,
      MARGIN_COIN: BITGET_L1A_MARGIN_COIN,
      SOURCE: BITGET_L1A_SOURCE,
      VERSION: BITGET_L1A_VERSION,
      PRODUCTION_TRANSPORT_PROVENANCE: productionProvenance,
      REAL_READ_AUTHORIZED: realReadAuthorized,
      SERVER_TIME_PREFLIGHT_PERFORMED: serverTimePreflightPerformed,
      SERVER_TIME_OBSERVED: serverTimeObservation !== null,
      SERVER_TIME_OFFSET_MS: serverTimeObservation === null ? null : serverTimeObservation.offsetMs,
      SERVER_TIME_WITHIN_SKEW: serverTimeObservation !== null
        && Math.abs(serverTimeObservation.offsetMs) <= 30_000,
      ACCOUNT_TRUTH_AVAILABLE: accountTruth?.availability === 'AVAILABLE',
      INSTRUMENT_FACTS_AVAILABLE: instrumentFacts?.availability === 'AVAILABLE',
      ACCOUNT_STATE: accountTruth?.value?.accountState ?? null,
      POSITION_COUNT: accountTruth?.value?.positions.length ?? null,
      OPEN_ORDER_COUNT: accountTruth?.value?.openOrders.length ?? null,
      RECENT_FILL_COUNT: accountTruth?.value?.recentFills.length ?? null,
      ENTRY_READINESS: readiness,
      NETWORK_REQUEST_COUNT: counts.total,
      REQUEST_COUNT_BY_ENDPOINT: counts.byEndpoint,
      MAX_REAL_READ_GETS: MAX_BITGET_REAL_READ_GETS,
      GETS_WITHIN_BUDGET: budget.withinBudget,
      REQUEST_SEQUENCE: Object.freeze([...requestSequence]),
      DIAGNOSTICS: Object.freeze([...diagnostics]),
      FAILURE_REASON: failureReason,
      // Authority is fixed false in this phase: verification belongs to the auditor, not the runner.
      REAL_CREDENTIAL_USED: false as const,
      REAL_CREDENTIAL_DISCOVERY: false as const,
      CREDENTIAL_INJECTED: credential !== null,
      EXECUTION_AUTHORITY: false as const,
      TESTNET_AUTHORITY: false as const,
      REAL_ORDER_AUTHORITY: false as const,
      PRODUCTION_CONNECTIVITY_VERIFIED: false as const,
      REAL_READ_VERIFIED: false as const,
      BITGET_ACCOUNT_TRUTH_VERIFIED: false as const,
      BITGET_POSITION_TRUTH_VERIFIED: false as const,
      BITGET_ORDER_TRUTH_VERIFIED: false as const,
      BITGET_FILL_TRUTH_VERIFIED: false as const,
      LIVE_READY: false as const,
    });
  }

  return Object.freeze({
    productionTransportProvenance: () => productionProvenance,
    requestCount: () => counter().total,
    run,
  });
}

export { BITGET_L0_PRODUCTION_ORIGIN };
