/**
 * Gate.io authenticated read foundation (L1A).
 *
 * Converts the seven closed L0 GET reads into immutable canonical observations. It neither creates
 * a transport nor discovers credentials, and every unavailable/unknown result carries null value.
 */
import {
  GATEIO_L0_INITIAL_CONTRACT,
  type GateIoReadCredential,
  type GateIoReadTransport,
} from './GateIoReadContracts';
import {
  GateIoReadClientError,
  createGateIoAuthenticatedReadClient,
  type GateIoReadFailureProvenance,
  type GateIoReadFailureReason,
  type GateIoReadIdentity,
} from './GateIoAuthenticatedReadClient';
import {
  GateIoReadClockError,
  createGateIoReadClock,
  gateIoFreshnessFromObservation,
  observeGateIoServerTime,
  signedGateIoTimestamp,
  type GateIoReadClock,
  type GateIoReadFreshness,
  type GateIoServerTimeObservation,
} from './GateIoReadClock';
import { gateIoReadTransportBudget, hasProductionGateIoReadTransportProvenance } from './GateIoReadTransport';
import { GateIoG3BudgetDenial, type GateIoG3RunBudget } from './GateIoG3RunBudget';

export const MAX_GATEIO_ACCOUNT_TRUTH_GETS = 5 as const;
export const MAX_GATEIO_INSTRUMENT_FACTS_GETS = 3 as const;
export const MAX_GATEIO_L1A_COMBINED_GETS = 8 as const;
export const GATEIO_L1A_SOURCE = 'gateio-usdt-futures-read' as const;
export const GATEIO_L1A_SCHEMA_VERSION = 'gateio-l1a-v1' as const;
export const GATEIO_L1A_SNAPSHOT_FRESHNESS_MS = 30_000 as const;
export const GATEIO_KNOWN_CONTRACT_STATUSES = Object.freeze([
  'prelaunch', 'trading', 'delisting', 'delisted', 'circuit_breaker',
] as const);
export const GATEIO_OPENABLE_CONTRACT_STATUS = 'trading' as const;

export type GateIoReadAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

export interface GateIoFoundationReadResult<T> {
  readonly availability: GateIoReadAvailability;
  readonly value: T | null;
  readonly reason: GateIoReadFailureReason | null;
  readonly failureProvenance: GateIoReadFailureProvenance | null;
}

export interface GateIoCanonicalAccount {
  readonly currency: 'USDT';
  readonly total: number;
  readonly available: number;
  readonly unrealizedPnl: number | null;
  readonly orderMargin: number | null;
  readonly inDualMode: boolean | null;
  readonly positionMode: string | null;
  readonly marginMode: GateIoAccountMarginMode | null;
}

/**
 * Gate reports the account margin mode as a numeric code, not as text:
 * 0 classic | 1 multi-currency | 2 portfolio | 3 single-currency. The code is kept as a number — it is
 * never rendered as a string — and any other value or type fails closed rather than being coerced.
 */
export type GateIoAccountMarginMode = 0 | 1 | 2 | 3;

export type GateIoPositionMode = 'single' | 'dual_long' | 'dual_short';

export interface GateIoCanonicalPosition {
  readonly contract: typeof GATEIO_L0_INITIAL_CONTRACT;
  readonly signedSize: number;
  /** Factual Gate quote-value exposure witness; F-09 proved size alone can be zero after decimal fills. */
  readonly quoteValue: number;
  readonly mode: GateIoPositionMode;
  readonly marginMode: string | null;
  readonly leverage: number | null;
  readonly entryPrice: number | null;
  readonly markPrice: number | null;
  readonly liquidationPrice: number | null;
  readonly unrealizedPnl: number | null;
  readonly realizedPnl: number | null;
  readonly margin: number | null;
  readonly updatedAt: number;
}

export interface GateIoCanonicalOpenOrder {
  readonly orderId: string;
  readonly clientText: string | null;
  readonly contract: typeof GATEIO_L0_INITIAL_CONTRACT;
  readonly signedSize: number;
  readonly remainingSize: number;
  readonly price: number | null;
  readonly fillPrice: number | null;
  readonly timeInForce: string;
  readonly status: 'open';
  readonly reduceOnly: boolean;
  readonly close: boolean;
  readonly createdAt: number;
  readonly updatedAt: number | null;
}

export interface GateIoCanonicalTrade {
  readonly tradeId: string;
  readonly orderId: string;
  readonly contract: typeof GATEIO_L0_INITIAL_CONTRACT;
  readonly signedSize: number;
  /** Signed as reported by Gate: 0, positive or negative are all legal factual values. */
  readonly closeSize: number;
  readonly price: number;
  readonly clientText: string | null;
  readonly fee: number;
  readonly pointFee: number;
  readonly role: 'maker' | 'taker';
  readonly tradeValue: number;
  /** Gate epoch seconds; fractional seconds are preserved exactly as reported. */
  readonly createdAt: number;
}

export interface GateIoCanonicalAccountTruth {
  readonly identity: GateIoReadIdentity;
  readonly account: GateIoCanonicalAccount;
  readonly positions: readonly GateIoCanonicalPosition[];
  readonly openOrders: readonly GateIoCanonicalOpenOrder[];
  readonly recentTrades: readonly GateIoCanonicalTrade[];
  readonly serverTimeMs: number;
  readonly observedAtMs: number;
  readonly freshness: GateIoReadFreshness;
  readonly source: typeof GATEIO_L1A_SOURCE;
  readonly schemaVersion: typeof GATEIO_L1A_SCHEMA_VERSION;
  readonly accountState: 'FLAT' | 'OPEN';
  readonly accountStateBasis: 'FACTUAL_POSITIONS_RESPONSE';
}

export interface GateIoCanonicalInstrumentFacts {
  readonly contract: typeof GATEIO_L0_INITIAL_CONTRACT;
  readonly contractStatus: string;
  readonly contractOpenable: boolean;
  readonly inDelisting: boolean;
  readonly contractMultiplier: number;
  readonly minOrderSize: number;
  readonly maxOrderSize: number;
  readonly decimalSizeEnabled: boolean;
  readonly priceStep: number;
  readonly markPriceStep: number;
  readonly minLeverage: number;
  readonly maxLeverage: number;
  readonly markPrice: number;
  readonly indexPrice: number;
  readonly lastPrice: number;
  /** Optional factual ticker fields; a G3 market projection must reject missing values. */
  readonly bestBid?: number | null;
  readonly bestAsk?: number | null;
  readonly volume24h?: number | null;
  readonly high24h?: number | null;
  readonly low24h?: number | null;
  readonly makerFeeRate: number;
  readonly takerFeeRate: number;
  readonly fundingRate: number;
  readonly serverTimeMs: number;
  readonly observedAtMs: number;
  readonly freshness: GateIoReadFreshness;
  readonly source: typeof GATEIO_L1A_SOURCE;
  readonly schemaVersion: typeof GATEIO_L1A_SCHEMA_VERSION;
}

export interface GateIoEntryReadiness {
  readonly safeToOpen: boolean;
  readonly blockers: readonly GateIoReadFailureReason[];
  readonly closeOrReduceBlockedByEntryFreshness: false;
}

export interface GateIoAuthenticatedReadStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly identity: GateIoReadIdentity;
  readonly lastObservedAt: number | null;
  readonly reason: GateIoReadFailureReason | null;
  readonly realClientDefaultWired: false;
  readonly realCredentialDiscovery: false;
}

export interface GateIoAuthenticatedReadFoundation {
  accountTruth(): Promise<GateIoFoundationReadResult<GateIoCanonicalAccountTruth>>;
  instrumentFacts(): Promise<GateIoFoundationReadResult<GateIoCanonicalInstrumentFacts>>;
  /** Uses only the latest bounded public server-time observation; no new I/O. */
  signedTimestamp(): string;
  status(): GateIoAuthenticatedReadStatus;
}

export interface GateIoAuthenticatedReadFoundationOptions {
  readonly transport: GateIoReadTransport;
  readonly identity: GateIoReadIdentity;
  readonly now: () => number;
  readonly credential: GateIoReadCredential | null;
  readonly runBudget?: GateIoG3RunBudget;
}

class GateIoMalformedPayload extends Error {
  constructor(readonly reason: GateIoReadFailureReason) {
    super(reason);
    this.name = 'GateIoMalformedPayload';
  }
}

function malformed(reason: GateIoReadFailureReason): never {
  throw new GateIoMalformedPayload(reason);
}

function tagged<T>(reason: GateIoReadFailureReason, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof GateIoMalformedPayload) malformed(reason);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function array(value: unknown, reason: GateIoReadFailureReason): readonly unknown[] {
  if (!Array.isArray(value)) malformed(reason);
  return value;
}

function decimal(
  value: unknown,
  options: { readonly positive?: boolean; readonly nonNegative?: boolean } = {},
): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) malformed('ACCOUNT_TRUTH_MALFORMED');
  if (options.positive === true && parsed <= 0) malformed('ACCOUNT_TRUTH_MALFORMED');
  if (options.nonNegative === true && parsed < 0) malformed('ACCOUNT_TRUTH_MALFORMED');
  return parsed;
}

function optionalDecimal(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') malformed('ACCOUNT_TRUTH_MALFORMED');
  return decimal(value);
}

/**
 * Strict Gate epoch-time parser. Gate reports create/update times as doubles, so fractional seconds
 * are legitimate facts and are preserved exactly — never rounded, floored or truncated. Only a finite
 * positive number, or a positive plain-decimal numeric string, is accepted.
 */
function timestamp(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) malformed('ACCOUNT_TRUTH_MALFORMED');
  return parsed;
}

function optionalTimestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return timestamp(value);
}

function identifier(value: unknown): string {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  malformed('ACCOUNT_TRUTH_MALFORMED');
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && value.length > 0) return value;
  malformed('ACCOUNT_TRUTH_MALFORMED');
}

/** Gate reports the account margin mode as a numeric code; anything else fails closed instead of coercing. */
function accountMarginMode(value: unknown): GateIoAccountMarginMode | null {
  if (value === undefined || value === null) return null;
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  malformed('ACCOUNT_TRUTH_MALFORMED');
}

function text(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  malformed('ACCOUNT_TRUTH_MALFORMED');
}

function boolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  malformed('ACCOUNT_TRUTH_MALFORMED');
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  return boolean(value);
}

function contract(value: unknown): typeof GATEIO_L0_INITIAL_CONTRACT {
  if (value !== GATEIO_L0_INITIAL_CONTRACT) malformed('ACCOUNT_TRUTH_MALFORMED');
  return GATEIO_L0_INITIAL_CONTRACT;
}

function positionMode(value: unknown): GateIoPositionMode {
  if (value === 'single' || value === 'dual_long' || value === 'dual_short') return value;
  malformed('POSITION_TRUTH_MALFORMED');
}

export function normalizeGateIoAccount(raw: unknown): GateIoCanonicalAccount {
  return tagged('ACCOUNT_TRUTH_MALFORMED', () => {
    if (!isRecord(raw)) malformed('ACCOUNT_TRUTH_MALFORMED');
    if (typeof raw.currency !== 'string' || raw.currency.toUpperCase() !== 'USDT') {
      malformed('ACCOUNT_TRUTH_MALFORMED');
    }
    return Object.freeze({
      currency: 'USDT' as const,
      total: decimal(raw.total),
      available: decimal(raw.available, { nonNegative: true }),
      unrealizedPnl: optionalDecimal(raw.unrealised_pnl),
      orderMargin: optionalDecimal(raw.order_margin),
      inDualMode: optionalBoolean(raw.in_dual_mode),
      positionMode: optionalText(raw.position_mode),
      marginMode: accountMarginMode(raw.margin_mode),
    });
  });
}

export function normalizeGateIoPosition(raw: unknown): GateIoCanonicalPosition {
  return tagged('POSITION_TRUTH_MALFORMED', () => {
    if (!isRecord(raw)) malformed('POSITION_TRUTH_MALFORMED');
    const signedSize = decimal(raw.size);
    const quoteValue = decimal(raw.value);
    const mode = positionMode(raw.mode ?? raw.hedge_status);
    if ((mode === 'dual_long' && signedSize < 0) || (mode === 'dual_short' && signedSize > 0)) {
      malformed('POSITION_TRUTH_MALFORMED');
    }
    const entryPrice = optionalDecimal(raw.entry_price);
    const markPrice = optionalDecimal(raw.mark_price);
    if ((signedSize !== 0 || quoteValue !== 0) && (entryPrice === null || entryPrice <= 0
      || markPrice === null || markPrice <= 0)) {
      malformed('POSITION_TRUTH_MALFORMED');
    }
    return Object.freeze({
      contract: contract(raw.contract),
      signedSize,
      quoteValue,
      mode,
      marginMode: optionalText(raw.pos_margin_mode),
      leverage: optionalDecimal(raw.leverage ?? raw.lever),
      entryPrice,
      markPrice,
      liquidationPrice: optionalDecimal(raw.liq_price ?? raw.liquidation_price),
      unrealizedPnl: optionalDecimal(raw.unrealised_pnl),
      realizedPnl: optionalDecimal(raw.realised_pnl),
      margin: optionalDecimal(raw.margin),
      updatedAt: timestamp(raw.update_time),
    });
  });
}

export function normalizeGateIoOpenOrder(raw: unknown): GateIoCanonicalOpenOrder {
  return tagged('OPEN_ORDERS_MALFORMED', () => {
    if (!isRecord(raw)) malformed('OPEN_ORDERS_MALFORMED');
    if (raw.status !== 'open') malformed('OPEN_ORDERS_MALFORMED');
    return Object.freeze({
      orderId: identifier(raw.id),
      clientText: optionalText(raw.text),
      contract: contract(raw.contract),
      signedSize: decimal(raw.size),
      remainingSize: decimal(raw.left, { nonNegative: true }),
      price: optionalDecimal(raw.price),
      fillPrice: optionalDecimal(raw.fill_price),
      timeInForce: text(raw.tif),
      status: 'open' as const,
      reduceOnly: boolean(raw.is_reduce_only),
      close: boolean(raw.is_close),
      createdAt: timestamp(raw.create_time),
      updatedAt: optionalTimestamp(raw.update_time),
    });
  });
}

export function normalizeGateIoTrade(raw: unknown): GateIoCanonicalTrade {
  return tagged('TRADES_MALFORMED', () => {
    if (!isRecord(raw)) malformed('TRADES_MALFORMED');
    if (raw.role !== 'maker' && raw.role !== 'taker') malformed('TRADES_MALFORMED');
    return Object.freeze({
      tradeId: identifier(raw.id),
      orderId: identifier(raw.order_id),
      contract: contract(raw.contract),
      signedSize: decimal(raw.size),
      // Gate reports close_size as a signed factual value: 0, positive and negative are all legal.
      // The sign is preserved exactly as reported; no open/close direction is derived here.
      closeSize: decimal(raw.close_size),
      price: decimal(raw.price, { positive: true }),
      clientText: optionalText(raw.text),
      fee: decimal(raw.fee),
      pointFee: decimal(raw.point_fee),
      role: raw.role,
      tradeValue: decimal(raw.trade_value),
      createdAt: timestamp(raw.create_time),
    });
  });
}

interface GateIoContractRule {
  readonly contract: typeof GATEIO_L0_INITIAL_CONTRACT;
  readonly status: string;
  readonly inDelisting: boolean;
  readonly openable: boolean;
  readonly multiplier: number;
  readonly minSize: number;
  readonly maxSize: number;
  readonly decimalSize: boolean;
  readonly priceStep: number;
  readonly markPriceStep: number;
  readonly minLeverage: number;
  readonly maxLeverage: number;
  readonly makerFeeRate: number;
  readonly takerFeeRate: number;
}

export function normalizeGateIoContract(raw: unknown): GateIoContractRule {
  return tagged('INSTRUMENT_FACTS_MALFORMED', () => {
    if (!isRecord(raw)) malformed('INSTRUMENT_FACTS_MALFORMED');
    const status = text(raw.status);
    const inDelisting = boolean(raw.in_delisting);
    const minSize = decimal(raw.order_size_min, { positive: true });
    const maxSize = decimal(raw.order_size_max, { positive: true });
    const minLeverage = decimal(raw.leverage_min, { positive: true });
    const maxLeverage = decimal(raw.leverage_max, { positive: true });
    if (minSize > maxSize || minLeverage > maxLeverage) malformed('MARKET_RULES_UNKNOWN');
    return Object.freeze({
      contract: contract(raw.name ?? raw.contract),
      status,
      inDelisting,
      openable: status === GATEIO_OPENABLE_CONTRACT_STATUS && !inDelisting,
      multiplier: decimal(raw.quanto_multiplier, { positive: true }),
      minSize,
      maxSize,
      decimalSize: boolean(raw.enable_decimal),
      priceStep: decimal(raw.order_price_round, { positive: true }),
      markPriceStep: decimal(raw.mark_price_round, { positive: true }),
      minLeverage,
      maxLeverage,
      makerFeeRate: decimal(raw.maker_fee_rate),
      takerFeeRate: decimal(raw.taker_fee_rate),
    });
  });
}

interface GateIoTickerFacts {
  readonly markPrice: number;
  readonly indexPrice: number;
  readonly lastPrice: number;
  readonly fundingRate: number;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly volume24h: number | null;
  readonly high24h: number | null;
  readonly low24h: number | null;
}

export function normalizeGateIoTicker(raw: unknown): GateIoTickerFacts {
  return tagged('INSTRUMENT_FACTS_MALFORMED', () => {
    const values = array(raw, 'INSTRUMENT_FACTS_MALFORMED');
    if (values.length !== 1 || !isRecord(values[0])) malformed('INSTRUMENT_FACTS_MALFORMED');
    const entry = values[0];
    if (entry.contract !== GATEIO_L0_INITIAL_CONTRACT) malformed('INSTRUMENT_FACTS_MALFORMED');
    return Object.freeze({
      markPrice: decimal(entry.mark_price, { positive: true }),
      indexPrice: decimal(entry.index_price, { positive: true }),
      lastPrice: decimal(entry.last, { positive: true }),
      fundingRate: decimal(entry.funding_rate),
      bestBid: optionalDecimal(entry.highest_bid),
      bestAsk: optionalDecimal(entry.lowest_ask),
      volume24h: optionalDecimal(entry.volume_24h),
      high24h: optionalDecimal(entry.high_24h),
      low24h: optionalDecimal(entry.low_24h),
    });
  });
}

function result<T>(
  availability: GateIoReadAvailability,
  value: T | null,
  reason: GateIoReadFailureReason | null,
  failureProvenance: GateIoReadFailureProvenance | null = null,
): GateIoFoundationReadResult<T> {
  if (availability !== 'AVAILABLE' && value !== null) throw new Error('GATEIO_RESULT_INVALID');
  return Object.freeze({ availability, value, reason, failureProvenance });
}

function available<T>(value: T): GateIoFoundationReadResult<T> {
  return result('AVAILABLE', value, null);
}

function failed<T>(error: unknown, fallback: GateIoReadFailureReason): GateIoFoundationReadResult<T> {
  if (error instanceof GateIoG3BudgetDenial) return result<T>('UNKNOWN', null, error.reasonCode);
  if (error instanceof GateIoReadClientError) {
    const availability = error.reason === 'GATEIO_READ_CREDENTIALS_UNAVAILABLE'
      || error.reason === 'GATEIO_AUTH_READ_NOT_CONFIGURED' ? 'UNAVAILABLE' : 'UNKNOWN';
    return result<T>(availability, null, error.reason, error.failureProvenance);
  }
  if (error instanceof GateIoMalformedPayload) return result<T>('UNKNOWN', null, error.reason);
  if (error instanceof GateIoReadClockError) return result<T>('UNKNOWN', null, error.reason);
  return result<T>('UNKNOWN', null, fallback);
}

function validateIdentity(identity: GateIoReadIdentity): GateIoReadIdentity {
  if (!isRecord(identity) || identity.exchange !== 'gateio' || identity.settle !== 'USDT'
      || typeof identity.accountId !== 'string' || identity.accountId.trim().length === 0) {
    throw new GateIoReadClientError('GATEIO_AUTH_READ_NOT_CONFIGURED');
  }
  return Object.freeze({ exchange: 'gateio', accountId: identity.accountId, settle: 'USDT' });
}

function validInstrumentRules(facts: GateIoCanonicalInstrumentFacts): boolean {
  const positive = [facts.contractMultiplier, facts.minOrderSize, facts.maxOrderSize,
    facts.priceStep, facts.markPriceStep, facts.minLeverage, facts.maxLeverage, facts.markPrice];
  return positive.every((value) => Number.isFinite(value) && value > 0)
    && facts.minOrderSize <= facts.maxOrderSize && facts.minLeverage <= facts.maxLeverage;
}

export function evaluateGateIoEntryReadiness(input: {
  readonly accountTruth: GateIoFoundationReadResult<GateIoCanonicalAccountTruth>;
  readonly instrumentFacts: GateIoFoundationReadResult<GateIoCanonicalInstrumentFacts>;
}): GateIoEntryReadiness {
  const blockers: GateIoReadFailureReason[] = [];
  const { accountTruth, instrumentFacts } = input;
  if (accountTruth.availability !== 'AVAILABLE' || accountTruth.value === null) {
    blockers.push(accountTruth.reason ?? 'ACCOUNT_TRUTH_UNKNOWN');
    blockers.push('POSITION_TRUTH_UNKNOWN');
  } else if (accountTruth.value.freshness !== 'FRESH') {
    blockers.push('ACCOUNT_TRUTH_STALE');
  }
  if (instrumentFacts.availability !== 'AVAILABLE' || instrumentFacts.value === null) {
    blockers.push(instrumentFacts.reason ?? 'INSTRUMENT_FACTS_UNKNOWN');
  } else {
    const facts = instrumentFacts.value;
    if (!(GATEIO_KNOWN_CONTRACT_STATUSES as readonly string[]).includes(facts.contractStatus)) {
      blockers.push('MARKET_RULES_UNKNOWN');
    } else if (!facts.contractOpenable || facts.inDelisting) {
      blockers.push('CONTRACT_NOT_OPENABLE');
    }
    if (!validInstrumentRules(facts)) blockers.push('MARKET_RULES_UNKNOWN');
    if (!Number.isFinite(facts.markPrice) || facts.markPrice <= 0) blockers.push('MARK_PRICE_UNKNOWN');
    if (facts.freshness === 'UNKNOWN') blockers.push('MARK_PRICE_UNKNOWN');
    if (facts.freshness === 'STALE') blockers.push('MARK_PRICE_STALE');
  }
  const unique = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    safeToOpen: unique.length === 0,
    blockers: unique,
    closeOrReduceBlockedByEntryFreshness: false as const,
  });
}

export function createGateIoAuthenticatedReadFoundation(
  options: GateIoAuthenticatedReadFoundationOptions,
): GateIoAuthenticatedReadFoundation {
  const transportBudget = gateIoReadTransportBudget(options.transport);
  if (transportBudget !== null && options.runBudget !== transportBudget)
    throw new GateIoReadClientError('GATEIO_AUTH_READ_NOT_CONFIGURED');
  const identity = validateIdentity(options.identity);
  const clock: GateIoReadClock = createGateIoReadClock(options.now);
  const credential = options.credential ?? null;
  const productionTransport = hasProductionGateIoReadTransportProvenance(options.transport);
  let observation: GateIoServerTimeObservation | null = null;
  let lastObservedAt: number | null = null;
  let lastReason: GateIoReadFailureReason | null = null;
  const client = createGateIoAuthenticatedReadClient({
    transport: options.transport,
    credential,
    clock,
    serverTimeObservation: () => observation,
  });

  async function synchronizeTime(): Promise<GateIoFoundationReadResult<GateIoServerTimeObservation>> {
    try {
      const requestStartedMs = clock.now();
      const payload = await client.getServerTime();
      const responseReceivedMs = clock.now();
      if (!isRecord(payload)) malformed('GATEIO_SERVER_TIME_INVALID');
      observation = observeGateIoServerTime({
        requestStartedMs,
        serverTimeMs: payload.server_time,
        responseReceivedMs,
      });
      return available(observation);
    } catch (error) {
      observation = null;
      return failed(error, 'GATEIO_SERVER_TIME_INVALID');
    }
  }

  function remember<T>(read: GateIoFoundationReadResult<T>): GateIoFoundationReadResult<T> {
    lastReason = read.reason;
    return read;
  }

  async function accountTruth(): Promise<GateIoFoundationReadResult<GateIoCanonicalAccountTruth>> {
    if (credential === null) {
      return remember(result<GateIoCanonicalAccountTruth>(
        'UNAVAILABLE', null, 'GATEIO_READ_CREDENTIALS_UNAVAILABLE',
      ));
    }
    try { options.runBudget?.beginAccountTruth(); }
    catch (error) { return remember(failed(error, 'ACCOUNT_TRUTH_UNKNOWN')); }
    const time = await synchronizeTime();
    if (time.value === null) return remember(result<GateIoCanonicalAccountTruth>(
      time.availability, null, time.reason ?? 'GATEIO_SERVER_TIME_INVALID', time.failureProvenance,
    ));
    try {
      const account = normalizeGateIoAccount(await client.getAccount());
      const positions = array(
        await client.getPositions(), 'POSITION_TRUTH_MALFORMED',
      ).map(normalizeGateIoPosition);
      // The L1A canonical scope accepts only ETH_USDT, so prove both factual legs.
      const modes = positions.map((entry) => entry.mode);
      if (account.inDualMode === null
          || (account.inDualMode && (modes.length !== 2
            || modes.filter((mode) => mode === 'dual_long').length !== 1
            || modes.filter((mode) => mode === 'dual_short').length !== 1))
          || (!account.inDualMode && modes.some((mode) => mode !== 'single'))
          || (!account.inDualMode && modes.length > 1)) {
        malformed('POSITION_TRUTH_MALFORMED');
      }
      const openOrders = array(
        await client.getOpenOrders(), 'OPEN_ORDERS_MALFORMED',
      ).map(normalizeGateIoOpenOrder);
      const recentTrades = array(
        await client.getRecentTrades(), 'TRADES_MALFORMED',
      ).map(normalizeGateIoTrade);
      const observedAtMs = clock.now();
      lastObservedAt = observedAtMs;
      const value: GateIoCanonicalAccountTruth = Object.freeze({
        identity,
        account,
        positions: Object.freeze(positions),
        openOrders: Object.freeze(openOrders),
        recentTrades: Object.freeze(recentTrades),
        serverTimeMs: time.value.serverTimeMs,
        observedAtMs,
        freshness: gateIoFreshnessFromObservation(observedAtMs, time.value),
        source: GATEIO_L1A_SOURCE,
        schemaVersion: GATEIO_L1A_SCHEMA_VERSION,
        accountState: positions.some((entry) => Math.abs(entry.signedSize) > 0
          || Math.abs(entry.quoteValue) > 0) ? 'OPEN' : 'FLAT',
        accountStateBasis: 'FACTUAL_POSITIONS_RESPONSE' as const,
      });
      return remember(available(value));
    } catch (error) {
      return remember(failed(error, 'ACCOUNT_TRUTH_MALFORMED'));
    }
  }

  async function instrumentFacts(): Promise<GateIoFoundationReadResult<GateIoCanonicalInstrumentFacts>> {
    try { options.runBudget?.beginInstrumentFacts(); }
    catch (error) { return remember(failed(error, 'INSTRUMENT_FACTS_UNKNOWN')); }
    const time = await synchronizeTime();
    if (time.value === null) return remember(result<GateIoCanonicalInstrumentFacts>(
      time.availability, null, time.reason ?? 'GATEIO_SERVER_TIME_INVALID', time.failureProvenance,
    ));
    try {
      const rule = normalizeGateIoContract(await client.getContract());
      const ticker = normalizeGateIoTicker(await client.getTicker());
      const observedAtMs = clock.now();
      lastObservedAt = observedAtMs;
      const value: GateIoCanonicalInstrumentFacts = Object.freeze({
        contract: rule.contract,
        contractStatus: rule.status,
        contractOpenable: rule.openable,
        inDelisting: rule.inDelisting,
        contractMultiplier: rule.multiplier,
        minOrderSize: rule.minSize,
        maxOrderSize: rule.maxSize,
        decimalSizeEnabled: rule.decimalSize,
        priceStep: rule.priceStep,
        markPriceStep: rule.markPriceStep,
        minLeverage: rule.minLeverage,
        maxLeverage: rule.maxLeverage,
        markPrice: ticker.markPrice,
        indexPrice: ticker.indexPrice,
        lastPrice: ticker.lastPrice,
        bestBid: ticker.bestBid,
        bestAsk: ticker.bestAsk,
        volume24h: ticker.volume24h,
        high24h: ticker.high24h,
        low24h: ticker.low24h,
        makerFeeRate: rule.makerFeeRate,
        takerFeeRate: rule.takerFeeRate,
        fundingRate: ticker.fundingRate,
        serverTimeMs: time.value.serverTimeMs,
        observedAtMs,
        freshness: gateIoFreshnessFromObservation(observedAtMs, time.value),
        source: GATEIO_L1A_SOURCE,
        schemaVersion: GATEIO_L1A_SCHEMA_VERSION,
      });
      return remember(available(value));
    } catch (error) {
      return remember(failed(error, 'INSTRUMENT_FACTS_MALFORMED'));
    }
  }

  return Object.freeze({
    accountTruth,
    instrumentFacts,
    signedTimestamp: () => signedGateIoTimestamp(clock, observation),
    status(): GateIoAuthenticatedReadStatus {
      return Object.freeze({
        configured: credential !== null,
        // An injected fake can prove the contract but can never prove production connectivity.
        connected: productionTransport && lastObservedAt !== null && lastReason === null,
        identity,
        lastObservedAt,
        reason: lastReason,
        realClientDefaultWired: false as const,
        realCredentialDiscovery: false as const,
      });
    },
  });
}
