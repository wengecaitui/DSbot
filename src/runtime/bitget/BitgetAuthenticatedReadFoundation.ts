/**
 * Bitget authenticated read foundation (L1A).
 *
 * Turns the raw payloads of the authenticated read client into canonical, fail-closed snapshots:
 * account truth (balances / positions / open orders / fills), instrument facts (contract rules +
 * symbol price), freshness and new-entry readiness.
 *
 * Invariants enforced here:
 *   - MISSING != FLAT != ZERO. Only a factually successful, structurally valid positions response
 *     with an empty array may produce accountState = FLAT. A missing, failed or malformed positions
 *     read yields availability != AVAILABLE with value = null, never FLAT.
 *   - No numeric coercion: NaN/Infinity/-Infinity/"" are malformed, not 0.
 *   - No hidden clock: observedAt comes from the injected now(); exchange timestamps come from the
 *     factual response; a missing/future/invalid exchange timestamp never counts as fresh.
 *   - Unknown contract status is never treated as TRADING.
 *   - Entry freshness never gates close/reduce authority.
 *   - Nothing here reads the environment or wires a real client by default.
 */
import {
  BITGET_L1A_INITIAL_SYMBOL,
  BITGET_L1A_SCHEMA_VERSION,
  availableBitget,
  unavailableBitget,
  unknownBitget,
  type BitgetReadCredential,
  type BitgetReadFailureReason,
  type BitgetReadFreshness,
  type BitgetReadResult,
} from './BitgetReadContracts';
import {
  createBitgetReadClock,
  observeBitgetServerTime,
  type BitgetReadClock,
  type BitgetServerTimeObservation,
} from './BitgetReadClock';
import {
  BitgetReadClientError,
  createBitgetAuthenticatedReadClient,
  BITGET_L1A_FILL_LIMIT,
  type BitgetReadIdentity,
} from './BitgetAuthenticatedReadClient';

export const BITGET_L1A_SOURCE = 'bitget-usdm-read' as const;
export const BITGET_L1A_VERSION = BITGET_L1A_SCHEMA_VERSION;
export const ACCOUNT_FRESHNESS_WINDOW_MS = 10_000 as const;
export const MARK_PRICE_FRESHNESS_WINDOW_MS = 10_000 as const;

/** Only an explicitly safe contract status may open a new position. */
export const BITGET_OPENABLE_SYMBOL_STATUSES: readonly string[] = Object.freeze(['normal']);
export const BITGET_KNOWN_SYMBOL_STATUSES: readonly string[] = Object.freeze([
  'normal', 'listed', 'maintain', 'limit_open', 'restrictedAPI', 'off',
]);

export interface BitgetCanonicalBalance {
  readonly marginCoin: string;
  readonly equity: number;
  readonly available: number;
  readonly locked: number;
  readonly unrealizedPL: number;
}

export interface BitgetCanonicalPosition {
  readonly symbol: string;
  readonly holdSide: 'LONG' | 'SHORT';
  readonly quantity: number;
  readonly entryPrice: number;
  readonly markPrice: number;
  readonly unrealizedPL: number;
  readonly leverage: number;
  readonly marginMode: 'CROSS' | 'ISOLATED';
  readonly posMode: string | null;
  readonly liquidationPrice: number | null;
  readonly updatedAt: number;
}

export interface BitgetCanonicalOpenOrder {
  readonly orderId: string;
  readonly clientOid: string | null;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly posSide: string | null;
  readonly orderType: string;
  readonly status: string;
  readonly price: number | null;
  readonly size: number;
  readonly executedSize: number;
  readonly reduceOnly: boolean | null;
  readonly marginMode: string | null;
  readonly leverage: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BitgetCanonicalFillFee {
  readonly feeCoin: string;
  readonly totalFee: number;
  readonly totalDeductionFee: number;
  readonly deduction: boolean;
}

export interface BitgetCanonicalFill {
  readonly tradeId: string;
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly tradeSide: string | null;
  readonly price: number;
  readonly baseVolume: number;
  readonly quoteVolume: number;
  readonly posMode: string | null;
  readonly profit: number | null;
  readonly feeDetail: readonly BitgetCanonicalFillFee[];
  readonly createdAt: number;
}

export type BitgetAccountState = 'FLAT' | 'OPEN';

export interface BitgetCanonicalAccountTruth {
  readonly identity: BitgetReadIdentity;
  readonly balances: readonly BitgetCanonicalBalance[];
  readonly positions: readonly BitgetCanonicalPosition[];
  readonly openOrders: readonly BitgetCanonicalOpenOrder[];
  readonly recentFills: readonly BitgetCanonicalFill[];
  readonly serverTime: number;
  readonly observedAt: number;
  readonly freshness: BitgetReadFreshness;
  readonly source: typeof BITGET_L1A_SOURCE;
  readonly schemaVersion: typeof BITGET_L1A_SCHEMA_VERSION;
  readonly accountState: BitgetAccountState;
  readonly accountStateBasis: 'FACTUAL_POSITIONS_RESPONSE';
}

/**
 * Quantity semantics (verified contract facts):
 *   sizeMultiplier = quantity multiplier  -> a valid order quantity must be > minTradeNum and an
 *                    exact multiple of this value. It is NOT a precision unit.
 *   volumePlace    = decimal places of the quantity (precision only). It is NOT a quantity multiple.
 * The two are separate constraints and must never be collapsed into one field.
 */
export type BitgetQuantityMultipleBasis = 'SIZE_MULTIPLIER';
export type BitgetQuantityPrecisionBasis = 'VOLUME_PLACE';
export type BitgetPriceStepBasis = 'PRICE_END_STEP_AT_PRICE_PLACE';

export interface BitgetCanonicalContractRule {
  readonly symbol: string;
  readonly status: string;
  readonly openable: boolean;
  readonly openableReason: BitgetReadFailureReason | null;
  /** Minimum quantity (minTradeNum). A floor, not a multiple and not a precision. */
  readonly minQty: number;
  readonly minNotional: number;
  /** Valid order quantity multiple, parsed from sizeMultiplier. */
  readonly quantityMultiple: number;
  readonly quantityMultipleBasis: BitgetQuantityMultipleBasis;
  /** Maximum quantity decimal precision, parsed from volumePlace. */
  readonly quantityPrecision: number;
  readonly quantityPrecisionBasis: BitgetQuantityPrecisionBasis;
  readonly priceStep: number;
  readonly priceStepBasis: BitgetPriceStepBasis;
  /** Price decimal places, parsed from pricePlace. */
  readonly pricePrecision: number;
  readonly minLeverage: number;
  readonly maxLeverage: number;
}

export interface BitgetCanonicalInstrumentFacts {
  readonly symbol: string;
  readonly markPrice: number;
  readonly indexPrice: number;
  readonly marketPrice: number;
  readonly priceTimestamp: number | null;
  readonly minQty: number;
  readonly minNotional: number;
  readonly quantityMultiple: number;
  readonly quantityPrecision: number;
  readonly priceStep: number;
  readonly pricePrecision: number;
  readonly contractStatus: string;
  readonly contractOpenable: boolean;
  readonly minLeverage: number;
  readonly maxLeverage: number;
  readonly serverTime: number;
  readonly observedAt: number;
  readonly freshness: BitgetReadFreshness;
  readonly source: typeof BITGET_L1A_SOURCE;
  readonly schemaVersion: typeof BITGET_L1A_SCHEMA_VERSION;
}

export interface BitgetEntryReadiness {
  readonly safeToOpen: boolean;
  readonly blockers: readonly BitgetReadFailureReason[];
  readonly closeOrReduceBlockedByEntryFreshness: false;
}

export interface BitgetAuthenticatedReadStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly identity: BitgetReadIdentity | null;
  readonly lastObservedAt: number | null;
  readonly reason: BitgetReadFailureReason | null;
  readonly realClientDefaultWired: false;
  readonly realCredentialDiscovery: false;
}

export interface BitgetAuthenticatedReadFoundation {
  accountTruth(): Promise<BitgetReadResult<BitgetCanonicalAccountTruth>>;
  instrumentFacts(symbol?: string): Promise<BitgetReadResult<BitgetCanonicalInstrumentFacts>>;
  status(): BitgetAuthenticatedReadStatus;
}

export interface BitgetAuthenticatedReadFoundationOptions {
  /** L0 transport. The foundation builds the read client on top of it; no second transport exists. */
  readonly transport: Parameters<typeof createBitgetAuthenticatedReadClient>[0]['transport'];
  readonly identity: BitgetReadIdentity;
  /** Explicit clock injection; the foundation never reads a hidden clock. */
  readonly now: () => number;
  /** Explicitly injected credential or null. No environment/file discovery is performed here. */
  readonly credential: BitgetReadCredential | null;
}

class BitgetMalformedPayload extends Error {
  constructor(readonly reason: BitgetReadFailureReason) {
    super(reason);
    this.name = 'BitgetMalformedPayload';
  }
}

function malformed(reason: BitgetReadFailureReason): never {
  throw new BitgetMalformedPayload(reason);
}

/** Re-tag any nested malformed-payload marker with the caller's own failure reason. */
function tagged<T>(reason: BitgetReadFailureReason, produce: () => T): T {
  try {
    return produce();
  } catch (error) {
    if (error instanceof BitgetMalformedPayload) malformed(reason);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, reason: BitgetReadFailureReason): readonly unknown[] {
  if (!Array.isArray(value)) malformed(reason);
  return value;
}

/** Strict decimal parsing: NaN/Infinity/-Infinity/blank are malformed, never 0. */
function decimal(
  value: unknown,
  options: { readonly nonNegative?: boolean; readonly positive?: boolean } = {},
): number {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) malformed('ACCOUNT_TRUTH_MALFORMED');
  if (options.nonNegative === true && parsed < 0) malformed('ACCOUNT_TRUTH_MALFORMED');
  if (options.positive === true && parsed <= 0) malformed('ACCOUNT_TRUTH_MALFORMED');
  return parsed;
}

function optionalDecimal(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) malformed('ACCOUNT_TRUTH_MALFORMED');
  return parsed;
}

function integer(value: unknown, options: { readonly min?: number } = {}): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) malformed('OBSERVATION_TIME_INVALID');
  if (options.min !== undefined && parsed < options.min) malformed('OBSERVATION_TIME_INVALID');
  return parsed;
}

function identifier(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  malformed('ACCOUNT_TRUTH_MALFORMED');
}

function optionalIdentifier(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return identifier(value);
}

function text(value: unknown, reason: BitgetReadFailureReason): string {
  if (typeof value === 'string' && value.length > 0) return value;
  malformed(reason);
}

function side(value: unknown): 'BUY' | 'SELL' {
  const raw = typeof value === 'string' ? value.toUpperCase() : '';
  if (raw === 'BUY') return 'BUY';
  if (raw === 'SELL') return 'SELL';
  malformed('ACCOUNT_TRUTH_MALFORMED');
}

function holdSide(value: unknown): 'LONG' | 'SHORT' {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'long') return 'LONG';
  if (raw === 'short') return 'SHORT';
  malformed('POSITION_TRUTH_MALFORMED');
}

function marginMode(value: unknown): 'CROSS' | 'ISOLATED' {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'crossed' || raw === 'cross') return 'CROSS';
  if (raw === 'isolated') return 'ISOLATED';
  malformed('POSITION_TRUTH_MALFORMED');
}

function parseSymbol(value: unknown, reason: BitgetReadFailureReason): string {
  if (typeof value === 'string' && /^[A-Z0-9]{2,24}$/.test(value)) return value;
  malformed(reason);
}

export function normalizeBitgetBalance(raw: unknown): BitgetCanonicalBalance {
  if (!isRecord(raw)) malformed('ACCOUNT_TRUTH_MALFORMED');
  return tagged('ACCOUNT_TRUTH_MALFORMED', () => Object.freeze({
    marginCoin: text(raw.marginCoin, 'ACCOUNT_TRUTH_MALFORMED'),
    equity: decimal(raw.accountEquity),
    available: decimal(raw.available, { nonNegative: true }),
    locked: decimal(raw.locked, { nonNegative: true }),
    unrealizedPL: decimal(raw.unrealizedPL),
  }));
}

export function normalizeBitgetPosition(raw: unknown): BitgetCanonicalPosition {
  if (!isRecord(raw)) malformed('POSITION_TRUTH_MALFORMED');
  return tagged('POSITION_TRUTH_MALFORMED', () => Object.freeze({
    symbol: parseSymbol(raw.symbol, 'POSITION_TRUTH_MALFORMED'),
    holdSide: holdSide(raw.holdSide),
    quantity: decimal(raw.total, { positive: true }),
    entryPrice: decimal(raw.openPriceAvg, { positive: true }),
    markPrice: decimal(raw.markPrice, { positive: true }),
    unrealizedPL: decimal(raw.unrealizedPL),
    leverage: decimal(raw.leverage, { positive: true }),
    marginMode: marginMode(raw.marginMode),
    posMode: optionalIdentifier(raw.posMode),
    liquidationPrice: optionalDecimal(raw.liquidationPrice),
    updatedAt: integer(raw.uTime, { min: 0 }),
  }));
}

export function normalizeBitgetOpenOrder(raw: unknown): BitgetCanonicalOpenOrder {
  if (!isRecord(raw)) malformed('OPEN_ORDERS_MALFORMED');
  return tagged('OPEN_ORDERS_MALFORMED', () => Object.freeze({
    orderId: identifier(raw.orderId),
    clientOid: optionalIdentifier(raw.clientOid),
    symbol: parseSymbol(raw.symbol, 'OPEN_ORDERS_MALFORMED'),
    side: side(raw.side),
    posSide: optionalIdentifier(raw.posSide),
    orderType: text(raw.orderType, 'OPEN_ORDERS_MALFORMED'),
    status: text(raw.status, 'OPEN_ORDERS_MALFORMED'),
    price: optionalDecimal(raw.price),
    size: decimal(raw.size, { nonNegative: true }),
    executedSize: raw.baseVolume === undefined ? 0 : decimal(raw.baseVolume, { nonNegative: true }),
    reduceOnly: typeof raw.reduceOnly === 'boolean' ? raw.reduceOnly : null,
    marginMode: optionalIdentifier(raw.marginMode),
    leverage: optionalDecimal(raw.leverage),
    createdAt: integer(raw.cTime, { min: 0 }),
    updatedAt: integer(raw.uTime, { min: 0 }),
  }));
}

/**
 * Fee detail is preserved entry-by-entry so later accounting never has to re-derive it from a single
 * collapsed number.
 */
export function normalizeBitgetFillFee(raw: unknown): BitgetCanonicalFillFee {
  if (!isRecord(raw)) malformed('FILLS_MALFORMED');
  return tagged('FILLS_MALFORMED', () => Object.freeze({
    feeCoin: text(raw.feeCoin, 'FILLS_MALFORMED'),
    totalFee: decimal(raw.totalFee),
    totalDeductionFee: raw.totalDeductionFee === undefined ? 0 : decimal(raw.totalDeductionFee),
    deduction: raw.deduction === true,
  }));
}

export function normalizeBitgetFill(raw: unknown): BitgetCanonicalFill {
  return tagged('FILLS_MALFORMED', () => {
    if (!isRecord(raw)) malformed('FILLS_MALFORMED');
    const feeDetail = raw.feeDetail === undefined
      ? []
      : asArray(raw.feeDetail, 'FILLS_MALFORMED').map(normalizeBitgetFillFee);
    return Object.freeze({
      tradeId: identifier(raw.tradeId),
      orderId: identifier(raw.orderId),
      symbol: parseSymbol(raw.symbol, 'FILLS_MALFORMED'),
      side: side(raw.side),
      tradeSide: optionalIdentifier(raw.tradeSide),
      price: decimal(raw.price, { positive: true }),
      baseVolume: decimal(raw.baseVolume, { positive: true }),
      quoteVolume: decimal(raw.quoteVolume, { nonNegative: true }),
      posMode: optionalIdentifier(raw.posMode),
      profit: optionalDecimal(raw.profit),
      feeDetail: Object.freeze(feeDetail),
      createdAt: integer(raw.cTime, { min: 0 }),
    });
  });
}

export type BitgetPricePayload = {
  readonly markPrice: number;
  readonly indexPrice: number;
  readonly marketPrice: number;
  readonly priceTimestamp: number | null;
};

/** `/api/v2/mix/market/symbol-price`: market price, index price and mark price for one symbol. */
export function normalizeBitgetSymbolPrice(payload: unknown, symbol: string): BitgetPricePayload {
  return tagged('INSTRUMENT_FACTS_MALFORMED', () => {
    const entry = Array.isArray(payload) ? payload[0] : payload;
    if (!isRecord(entry)) malformed('INSTRUMENT_FACTS_MALFORMED');
    const observedSymbol = parseSymbol(entry.symbol ?? symbol, 'INSTRUMENT_FACTS_MALFORMED');
    if (observedSymbol !== symbol) malformed('INSTRUMENT_FACTS_MALFORMED');
    const priceTimestamp = entry.ts === undefined || entry.ts === null ? null : integer(entry.ts, { min: 0 });
    return Object.freeze({
      markPrice: decimal(entry.markPrice, { positive: true }),
      indexPrice: decimal(entry.indexPrice, { positive: true }),
      marketPrice: decimal(entry.price, { positive: true }),
      priceTimestamp,
    });
  });
}

/**
 * Contract rule normalization.
 *
 * PRICE (verified): priceEndStep is the step coefficient at pricePlace decimals, so
 *   priceStep = priceEndStep / 10^pricePlace
 * e.g. pricePlace=1, priceEndStep=5 -> 0.5 ; pricePlace=2, priceEndStep=1 -> 0.01.
 * pricePrecision is reported separately as pricePlace.
 *
 * QUANTITY (verified): sizeMultiplier and volumePlace are two different constraints and are kept
 * apart deliberately:
 *   quantityMultiple  = sizeMultiplier  -> a valid order quantity must be a multiple of this
 *   quantityPrecision = volumePlace     -> decimal places of the quantity
 * volumePlace is NEVER converted into an order-quantity multiple, and no unproven relation such as
 * sizeMultiplier == 10^-volumePlace is asserted anywhere.
 *
 * Any missing/invalid required field fails closed as MARKET_RULES_UNKNOWN rather than substituting a
 * derived value.
 */
export function normalizeBitgetContractRule(raw: unknown): BitgetCanonicalContractRule {
  return tagged('MARKET_RULES_UNKNOWN', () => {
    if (!isRecord(raw)) malformed('INSTRUMENT_FACTS_MALFORMED');
    const symbol = parseSymbol(raw.symbol, 'INSTRUMENT_FACTS_MALFORMED');
    const status = text(raw.symbolStatus, 'INSTRUMENT_FACTS_MALFORMED');
    const pricePlace = integer(raw.pricePlace, { min: 0 });
    const priceEndStep = integer(raw.priceEndStep, { min: 1 });
    const volumePlace = integer(raw.volumePlace, { min: 0 });
    // Defensive range guard only: not a relation between fields.
    if (pricePlace > 12 || volumePlace > 12) malformed('MARKET_RULES_UNKNOWN');
    const priceStep = priceEndStep / 10 ** pricePlace;
    if (!Number.isFinite(priceStep) || priceStep <= 0) malformed('MARKET_RULES_UNKNOWN');
    // The quantity multiple is the venue's own field, never a value derived from volumePlace.
    const quantityMultiple = decimal(raw.sizeMultiplier, { positive: true });
    const minLeverage = decimal(raw.minLever, { positive: true });
    const maxLeverage = decimal(raw.maxLever, { positive: true });
    if (minLeverage > maxLeverage) malformed('MARKET_RULES_UNKNOWN');
    const openable = BITGET_OPENABLE_SYMBOL_STATUSES.includes(status);
    return Object.freeze({
      symbol,
      status,
      openable,
      openableReason: openable ? null : 'CONTRACT_NOT_OPENABLE',
      minQty: decimal(raw.minTradeNum, { positive: true }),
      minNotional: decimal(raw.minTradeUSDT, { positive: true }),
      quantityMultiple,
      quantityMultipleBasis: 'SIZE_MULTIPLIER' as const,
      quantityPrecision: volumePlace,
      quantityPrecisionBasis: 'VOLUME_PLACE' as const,
      priceStep,
      priceStepBasis: 'PRICE_END_STEP_AT_PRICE_PLACE' as const,
      pricePrecision: pricePlace,
      minLeverage,
      maxLeverage,
    });
  });
}

export function bitgetFreshnessFrom(observedAt: number, exchangeTimestamp: number | null, windowMs: number): BitgetReadFreshness {
  if (exchangeTimestamp === null) return 'UNKNOWN';
  const age = observedAt - exchangeTimestamp;
  if (age < 0) return 'UNKNOWN';
  return age <= windowMs ? 'FRESH' : 'STALE';
}

export function evaluateBitgetNewEntryReadiness(input: {
  readonly accountTruth: BitgetReadResult<BitgetCanonicalAccountTruth>;
  readonly instrumentFacts: BitgetReadResult<BitgetCanonicalInstrumentFacts>;
}): BitgetEntryReadiness {
  const blockers: BitgetReadFailureReason[] = [];
  const { accountTruth, instrumentFacts } = input;
  if (accountTruth.availability !== 'AVAILABLE' || accountTruth.value === null) {
    blockers.push(accountTruth.reason ?? 'ACCOUNT_TRUTH_MISSING');
    blockers.push('POSITION_TRUTH_UNKNOWN');
  }
  if (instrumentFacts.availability !== 'AVAILABLE' || instrumentFacts.value === null) {
    blockers.push(instrumentFacts.reason ?? 'INSTRUMENT_FACTS_MALFORMED');
  } else {
    const facts = instrumentFacts.value;
    if (facts.contractStatus === '' || !BITGET_KNOWN_SYMBOL_STATUSES.includes(facts.contractStatus)) {
      blockers.push('MARKET_RULES_UNKNOWN');
    } else if (!facts.contractOpenable) {
      blockers.push('CONTRACT_NOT_OPENABLE');
    }
    // Incomplete quantity/price rules must never permit a new entry.
    const positiveRules = [facts.minQty, facts.quantityMultiple, facts.priceStep];
    const precisionRules = [facts.quantityPrecision, facts.pricePrecision];
    if (positiveRules.some((value) => !Number.isFinite(value) || value <= 0)
      || precisionRules.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      blockers.push('MARKET_RULES_UNKNOWN');
    }
    if (facts.freshness === 'UNKNOWN') blockers.push('MARK_PRICE_UNKNOWN');
    else if (facts.freshness === 'STALE') blockers.push('MARK_PRICE_STALE');
  }
  const unique = [...new Set(blockers)];
  return Object.freeze({
    safeToOpen: unique.length === 0,
    blockers: Object.freeze(unique),
    // Entry freshness never gates closing or reducing.
    closeOrReduceBlockedByEntryFreshness: false as const,
  });
}

function extractServerTime(payload: unknown): unknown {
  const entry = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(entry)) return null;
  return entry.serverTime ?? entry.server_time ?? null;
}

function reasonOf(error: unknown, fallback: BitgetReadFailureReason): BitgetReadFailureReason {
  if (error instanceof BitgetReadClientError) return error.reason;
  if (error instanceof BitgetMalformedPayload) return error.reason;
  const reason = (error as { reason?: BitgetReadFailureReason }).reason;
  return typeof reason === 'string' ? reason : fallback;
}

export function createBitgetAuthenticatedReadFoundation(
  options: BitgetAuthenticatedReadFoundationOptions,
): BitgetAuthenticatedReadFoundation {
  const { transport, identity, now } = options;
  const credential = options.credential ?? null;
  const clock: BitgetReadClock = createBitgetReadClock(now);
  let serverTimeOffsetMs = 0;
  // The client signs with exactly the offset the foundation observed, read lazily per request.
  const client = createBitgetAuthenticatedReadClient({
    transport,
    credential,
    clock,
    serverTimeOffsetMs: () => serverTimeOffsetMs,
  });
  let lastObservation: BitgetServerTimeObservation | null = null;
  let lastObservedAt: number | null = null;
  let lastReason: BitgetReadFailureReason | null = null;
  let configured = credential !== null;

  async function observeServerTime(): Promise<BitgetReadResult<number>> {
    const startedMs = clock.now();
    let payload: unknown;
    try {
      payload = await client.getServerTime();
    } catch (error) {
      const reason = reasonOf(error, 'BITGET_READ_TRANSPORT_FAILED');
      lastReason = reason;
      return reason === 'BITGET_READ_TRANSPORT_FAILED'
        ? unknownBitget<number>(reason)
        : unknownBitget<number>(reason);
    }
    const receivedMs = clock.now();
    const rawServerTime = extractServerTime(payload);
    // Strict: only a decimal numeric string (or a number) may become a server time. null/''/junk is
    // passed through unchanged so the clock validator rejects it instead of coercing it to 0.
    const serverTimeMs = typeof rawServerTime === 'string'
      ? (/^[0-9]{1,20}$/.test(rawServerTime.trim()) ? Number(rawServerTime.trim()) : rawServerTime)
      : rawServerTime;
    try {
      const observation = observeBitgetServerTime({ serverTimeMs, requestStartedMs: startedMs, responseReceivedMs: receivedMs });
      lastObservation = observation;
      serverTimeOffsetMs = observation.offsetMs;
      configured = configured || credential !== null;
      return availableBitget(observation.serverTimeMs);
    } catch (error) {
      const reason = reasonOf(error, 'BITGET_SERVER_TIME_INVALID');
      lastReason = reason;
      return unknownBitget<number>(reason);
    }
  }

  async function accountTruth(): Promise<BitgetReadResult<BitgetCanonicalAccountTruth>> {
    if (credential === null) {
      lastReason = 'BITGET_READ_CREDENTIALS_UNAVAILABLE';
      return unavailableBitget<BitgetCanonicalAccountTruth>('BITGET_READ_CREDENTIALS_UNAVAILABLE');
    }
    // Request budget: server time + accounts + positions + pending orders + fills = 5 GETs, no retry.
    const serverTime = await observeServerTime();
    if (serverTime.availability !== 'AVAILABLE' || serverTime.value === null) {
      return unknownBitget<BitgetCanonicalAccountTruth>(serverTime.reason ?? 'BITGET_SERVER_TIME_INVALID');
    }
    try {
      const accountsPayload = await client.getAccounts();
      const balances = asArray(accountsPayload, 'ACCOUNT_TRUTH_MALFORMED').map(normalizeBitgetBalance);
      const positionsPayload = await client.getPositions();
      const positions = asArray(positionsPayload, 'POSITION_TRUTH_MALFORMED').map(normalizeBitgetPosition);
      const pendingPayload = await client.getPendingOrders();
      const openOrders = asArray(pendingPayload, 'OPEN_ORDERS_MALFORMED').map(normalizeBitgetOpenOrder);
      const fillsPayload = await client.getRecentFills({ limit: BITGET_L1A_FILL_LIMIT });
      const recentFills = asArray(fillsPayload, 'FILLS_MALFORMED').map(normalizeBitgetFill);
      const observedAt = clock.now();
      lastObservedAt = observedAt;
      lastReason = null;
      const value: BitgetCanonicalAccountTruth = Object.freeze({
        identity,
        balances: Object.freeze(balances),
        positions: Object.freeze(positions),
        openOrders: Object.freeze(openOrders),
        recentFills: Object.freeze(recentFills),
        serverTime: serverTime.value,
        observedAt,
        freshness: bitgetFreshnessFrom(observedAt, serverTime.value, ACCOUNT_FRESHNESS_WINDOW_MS),
        source: BITGET_L1A_SOURCE,
        schemaVersion: BITGET_L1A_SCHEMA_VERSION,
        // FLAT requires this factual, structurally valid positions response; see the module header.
        accountState: positions.length === 0 ? 'FLAT' : 'OPEN',
        accountStateBasis: 'FACTUAL_POSITIONS_RESPONSE' as const,
      });
      return availableBitget(value);
    } catch (error) {
      const reason = reasonOf(error, 'ACCOUNT_TRUTH_MALFORMED');
      lastReason = reason;
      return unavailableBitget<BitgetCanonicalAccountTruth>(reason);
    }
  }

  async function instrumentFacts(symbol: string = BITGET_L1A_INITIAL_SYMBOL): Promise<BitgetReadResult<BitgetCanonicalInstrumentFacts>> {
    // Request budget: server time + contracts + symbol price = 3 GETs, no retry.
    const serverTime = await observeServerTime();
    if (serverTime.availability !== 'AVAILABLE' || serverTime.value === null) {
      return unknownBitget<BitgetCanonicalInstrumentFacts>(serverTime.reason ?? 'BITGET_SERVER_TIME_INVALID');
    }
    try {
      const contractsPayload = await client.getContracts(symbol);
      const contracts = asArray(contractsPayload, 'INSTRUMENT_FACTS_MALFORMED');
      const match = contracts.find((entry) => isRecord(entry) && entry.symbol === symbol);
      if (match === undefined) {
        lastReason = 'MARKET_RULES_UNKNOWN';
        return unknownBitget<BitgetCanonicalInstrumentFacts>('MARKET_RULES_UNKNOWN');
      }
      const rule = normalizeBitgetContractRule(match);
      const pricePayload = await client.getSymbolPrice(symbol);
      const prices = normalizeBitgetSymbolPrice(pricePayload, symbol);
      const observedAt = clock.now();
      lastObservedAt = observedAt;
      lastReason = null;
      const value: BitgetCanonicalInstrumentFacts = Object.freeze({
        symbol,
        markPrice: prices.markPrice,
        indexPrice: prices.indexPrice,
        marketPrice: prices.marketPrice,
        priceTimestamp: prices.priceTimestamp,
        minQty: rule.minQty,
        minNotional: rule.minNotional,
        quantityMultiple: rule.quantityMultiple,
        quantityPrecision: rule.quantityPrecision,
        priceStep: rule.priceStep,
        pricePrecision: rule.pricePrecision,
        contractStatus: rule.status,
        contractOpenable: rule.openable,
        minLeverage: rule.minLeverage,
        maxLeverage: rule.maxLeverage,
        serverTime: serverTime.value,
        observedAt,
        freshness: bitgetFreshnessFrom(observedAt, prices.priceTimestamp, MARK_PRICE_FRESHNESS_WINDOW_MS),
        source: BITGET_L1A_SOURCE,
        schemaVersion: BITGET_L1A_SCHEMA_VERSION,
      });
      return availableBitget(value);
    } catch (error) {
      const reason = reasonOf(error, 'INSTRUMENT_FACTS_MALFORMED');
      lastReason = reason;
      return unavailableBitget<BitgetCanonicalInstrumentFacts>(reason);
    }
  }

  return Object.freeze({
    accountTruth,
    instrumentFacts,
    status(): BitgetAuthenticatedReadStatus {
      return Object.freeze({
        configured,
        connected: lastObservedAt !== null && lastReason === null,
        identity,
        lastObservedAt,
        reason: lastReason,
        realClientDefaultWired: false as const,
        realCredentialDiscovery: false as const,
      });
    },
  });
}
