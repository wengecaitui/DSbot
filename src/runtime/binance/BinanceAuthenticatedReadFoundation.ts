export const BINANCE_L1A_SOURCE = 'BINANCE_FUTURES_API' as const;
export const BINANCE_L1A_SCHEMA_VERSION = 'BINANCE_L1A_V1' as const;

export type BinanceReadFreshness = 'FRESH' | 'STALE' | 'UNKNOWN';
export type BinanceReadAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

export interface BinanceReadIdentity {
  readonly exchange: 'binance';
  readonly accountId: string;
}

/** Secret values are passed only to an injected client factory and are never returned. */
export interface BinanceReadCredentials {
  readonly apiKey: string;
  readonly secretKey: string;
}

export interface BinanceReadSecretProvider {
  getReadCredentials(identity: BinanceReadIdentity): Promise<BinanceReadCredentials | null>;
}

export interface BinanceRawBalance {
  readonly asset: string;
  readonly walletBalance: string | number;
  readonly availableBalance: string | number;
}

export interface BinanceRawPosition {
  readonly symbol: string;
  readonly positionAmt: string | number;
  readonly entryPrice: string | number;
  readonly markPrice?: string | number;
  readonly unrealizedProfit: string | number;
  readonly marginType: string;
  readonly leverage: string | number;
  readonly updateTime?: number;
}

export interface BinanceRawAccount {
  readonly balances?: readonly BinanceRawBalance[];
  readonly positions?: readonly BinanceRawPosition[];
  readonly updateTime?: number;
  readonly sequence?: string | number;
}

export interface BinanceRawOpenOrder {
  readonly orderId: string | number;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: string;
  readonly positionSide?: string;
  readonly type: string;
  readonly status: string;
  readonly price: string | number;
  readonly origQty: string | number;
  readonly executedQty: string | number;
  readonly reduceOnly?: boolean;
  readonly updateTime?: number;
}

export interface BinanceRawFill {
  readonly id: string | number;
  readonly orderId: string | number;
  readonly symbol: string;
  readonly side: string;
  readonly price: string | number;
  readonly qty: string | number;
  readonly quoteQty: string | number;
  readonly commission: string | number;
  readonly commissionAsset: string;
  readonly time: number;
}

export interface BinanceRawMarkPrice {
  readonly symbol: string;
  readonly markPrice: string | number;
  readonly time?: number;
}

export interface BinanceRawInstrumentRules {
  readonly symbol: string;
  readonly tickSize: string | number;
  readonly stepSize: string | number;
  readonly minQty: string | number;
  readonly minNotional: string | number;
  readonly status: string;
}

/** Deliberately contains no submit, cancel, modify, leverage, or margin mutation. */
export interface BinanceAuthenticatedReadClient {
  getServerTime(): Promise<number>;
  getAccount(): Promise<BinanceRawAccount>;
  getOpenOrders(): Promise<readonly BinanceRawOpenOrder[]>;
  getRecentFills(): Promise<readonly BinanceRawFill[]>;
  getMarkPrice(symbol: string): Promise<BinanceRawMarkPrice>;
  getInstrumentRules(symbol: string): Promise<BinanceRawInstrumentRules | null>;
}

export interface BinanceAuthenticatedReadClientFactory {
  create(
    identity: BinanceReadIdentity,
    credentials: BinanceReadCredentials,
  ): BinanceAuthenticatedReadClient;
}

export interface BinanceFreshnessObservation {
  readonly status: BinanceReadFreshness;
  readonly ageMs: number | null;
  readonly staleAfterMs: number;
}

export interface BinanceBalanceFact {
  readonly asset: string;
  readonly walletBalance: number;
  readonly availableBalance: number;
}

export interface BinancePositionFact {
  readonly symbol: string;
  readonly quantity: number;
  readonly side: 'LONG' | 'SHORT' | 'FLAT';
  readonly entryPrice: number;
  readonly markPrice: number | null;
  readonly unrealizedPnl: number;
  readonly marginMode: 'CROSS' | 'ISOLATED';
  readonly leverage: number;
  readonly updatedAt: number | null;
}

export interface BinanceOpenOrderFact {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly positionSide: 'BOTH' | 'LONG' | 'SHORT' | null;
  readonly type: string;
  readonly status: string;
  readonly price: number;
  readonly originalQuantity: number;
  readonly executedQuantity: number;
  readonly reduceOnly: boolean | null;
  readonly updatedAt: number | null;
}

export interface BinanceRecentFillFact {
  readonly fillId: string;
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly price: number;
  readonly quantity: number;
  readonly quoteQuantity: number;
  readonly commission: number;
  readonly commissionAsset: string;
  readonly executedAt: number;
}

export interface BinanceAccountTruthSnapshot {
  readonly identity: BinanceReadIdentity;
  readonly accountState: 'FLAT' | 'OPEN';
  readonly balances: readonly BinanceBalanceFact[];
  readonly positions: readonly BinancePositionFact[];
  readonly openOrders: readonly BinanceOpenOrderFact[];
  readonly recentFills: readonly BinanceRecentFillFact[];
  readonly serverTime: number;
  readonly accountUpdateTime: number;
  readonly observedAt: number;
  readonly freshness: BinanceFreshnessObservation;
  readonly source: typeof BINANCE_L1A_SOURCE;
  readonly schemaVersion: typeof BINANCE_L1A_SCHEMA_VERSION;
  readonly sequence: string | null;
}

export interface BinanceInstrumentFactsSnapshot {
  readonly symbol: string;
  readonly markPrice: number;
  readonly tickSize: number;
  readonly stepSize: number;
  readonly minQty: number;
  readonly minNotional: number;
  readonly contractStatus: string;
  readonly serverTime: number;
  readonly markPriceTime: number | null;
  readonly observedAt: number;
  readonly freshness: BinanceFreshnessObservation;
  readonly source: typeof BINANCE_L1A_SOURCE;
  readonly schemaVersion: typeof BINANCE_L1A_SCHEMA_VERSION;
}

export type BinanceReadFailureReason =
  | 'BINANCE_AUTH_READ_NOT_CONFIGURED'
  | 'BINANCE_READ_CREDENTIALS_UNAVAILABLE'
  | 'BINANCE_READ_CLIENT_UNAVAILABLE'
  | 'BINANCE_READ_TRANSPORT_FAILED'
  | 'ACCOUNT_TRUTH_MISSING'
  | 'ACCOUNT_TRUTH_MALFORMED'
  | 'MARK_PRICE_UNKNOWN'
  | 'MARKET_RULES_UNKNOWN'
  | 'INSTRUMENT_FACTS_MALFORMED'
  | 'OBSERVATION_TIME_INVALID';

export type BinanceReadResult<T> = Readonly<{
  availability: BinanceReadAvailability;
  value: T | null;
  reason: BinanceReadFailureReason | null;
}>;

export interface BinanceAccountTruthPort {
  read(): Promise<BinanceReadResult<BinanceAccountTruthSnapshot>>;
}

export interface BinanceInstrumentFactsPort {
  read(symbol: string): Promise<BinanceReadResult<BinanceInstrumentFactsSnapshot>>;
}

export interface BinanceAuthenticatedReadStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly identity: BinanceReadIdentity | null;
  readonly lastObservedAt: number | null;
  readonly reason: BinanceReadFailureReason | null;
  readonly realClientDefaultWired: false;
  readonly realCredentialDiscovery: false;
}

export interface BinanceAuthenticatedReadFoundation {
  readonly accountTruth: BinanceAccountTruthPort;
  readonly instrumentFacts: BinanceInstrumentFactsPort;
  status(): BinanceAuthenticatedReadStatus;
}

export interface BinanceAuthenticatedReadBindings {
  readonly secretProvider: BinanceReadSecretProvider;
  readonly clientFactory: BinanceAuthenticatedReadClientFactory;
  readonly now: () => number;
  readonly staleAfterMs?: number;
}

export type BinanceNewEntryReadBlocker =
  | 'ACCOUNT_TRUTH_UNKNOWN'
  | 'MARKET_RULES_UNKNOWN'
  | 'MARK_PRICE_UNKNOWN'
  | 'MARK_PRICE_STALE'
  | 'CONTRACT_NOT_TRADING';

export interface BinanceNewEntryReadiness {
  readonly safeToOpen: boolean;
  readonly blockers: readonly BinanceNewEntryReadBlocker[];
  /** Entry freshness never grants authority to block factual close/reduce paths. */
  readonly closeOrReduceBlockedByEntryFreshness: false;
}

const DEFAULT_STALE_AFTER_MS = 5_000;

class NormalizationFailure extends Error {
  constructor(readonly reason: BinanceReadFailureReason) {
    super(reason);
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function identifier(value: unknown): string | null {
  if (typeof value === 'string') return nonEmpty(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function number(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function freshness(observedAt: number, exchangeTime: number | null, staleAfterMs: number): BinanceFreshnessObservation {
  if (exchangeTime === null || exchangeTime > observedAt) {
    return Object.freeze({ status: 'UNKNOWN', ageMs: null, staleAfterMs });
  }
  const ageMs = observedAt - exchangeTime;
  return Object.freeze({ status: ageMs <= staleAfterMs ? 'FRESH' : 'STALE', ageMs, staleAfterMs });
}

function result<T>(
  availability: BinanceReadAvailability,
  value: T | null,
  reason: BinanceReadFailureReason | null,
): BinanceReadResult<T> {
  return Object.freeze({ availability, value, reason });
}

function copyIdentity(identity: BinanceReadIdentity): BinanceReadIdentity {
  return Object.freeze({ exchange: 'binance', accountId: identity.accountId });
}

function normalizeAccount(
  identity: BinanceReadIdentity,
  raw: BinanceRawAccount,
  rawOrders: readonly BinanceRawOpenOrder[],
  rawFills: readonly BinanceRawFill[],
  serverTime: number,
  observedAt: number,
  staleAfterMs: number,
): BinanceAccountTruthSnapshot {
  if (!raw || !Array.isArray(raw.balances) || !Array.isArray(raw.positions)) {
    throw new NormalizationFailure('ACCOUNT_TRUTH_MISSING');
  }
  if (!Array.isArray(rawOrders) || !Array.isArray(rawFills)) {
    throw new NormalizationFailure('ACCOUNT_TRUTH_MISSING');
  }
  const accountUpdateTime = timestamp(raw.updateTime);
  if (accountUpdateTime === null) throw new NormalizationFailure('ACCOUNT_TRUTH_MISSING');

  try {
    const balances = Object.freeze(raw.balances.map((entry): BinanceBalanceFact => {
      const asset = nonEmpty(entry.asset);
      const walletBalance = number(entry.walletBalance);
      const availableBalance = number(entry.availableBalance);
      if (!asset || walletBalance === null || availableBalance === null) throw new Error();
      return Object.freeze({ asset, walletBalance, availableBalance });
    }));
    const positions = Object.freeze(raw.positions.map((entry): BinancePositionFact => {
      const symbol = nonEmpty(entry.symbol);
      const quantity = number(entry.positionAmt);
      const entryPrice = nonNegative(entry.entryPrice);
      const markPrice = entry.markPrice === undefined ? null : nonNegative(entry.markPrice);
      const unrealizedPnl = number(entry.unrealizedProfit);
      const leverage = positive(entry.leverage);
      const margin = nonEmpty(entry.marginType)?.toUpperCase();
      const updatedAt = entry.updateTime === undefined ? null : timestamp(entry.updateTime);
      if (!symbol || quantity === null || entryPrice === null ||
          (entry.markPrice !== undefined && markPrice === null) || unrealizedPnl === null ||
          leverage === null || (margin !== 'CROSS' && margin !== 'ISOLATED') ||
          (entry.updateTime !== undefined && updatedAt === null)) throw new Error();
      return Object.freeze({
        symbol,
        quantity,
        side: quantity > 0 ? 'LONG' : quantity < 0 ? 'SHORT' : 'FLAT',
        entryPrice,
        markPrice,
        unrealizedPnl,
        marginMode: margin,
        leverage,
        updatedAt,
      });
    }));
    const openOrders = Object.freeze(rawOrders.map((entry): BinanceOpenOrderFact => {
      const orderId = identifier(entry.orderId);
      const clientOrderId = nonEmpty(entry.clientOrderId);
      const symbol = nonEmpty(entry.symbol);
      const side = nonEmpty(entry.side)?.toUpperCase();
      const positionSide = entry.positionSide === undefined ? null : nonEmpty(entry.positionSide)?.toUpperCase();
      const type = nonEmpty(entry.type);
      const status = nonEmpty(entry.status);
      const price = nonNegative(entry.price);
      const originalQuantity = nonNegative(entry.origQty);
      const executedQuantity = nonNegative(entry.executedQty);
      const updatedAt = entry.updateTime === undefined ? null : timestamp(entry.updateTime);
      if (!orderId || !clientOrderId || !symbol || (side !== 'BUY' && side !== 'SELL') ||
          (positionSide !== null && positionSide !== 'BOTH' && positionSide !== 'LONG' && positionSide !== 'SHORT') ||
          !type || !status || price === null || originalQuantity === null || executedQuantity === null ||
          (entry.reduceOnly !== undefined && typeof entry.reduceOnly !== 'boolean') ||
          (entry.updateTime !== undefined && updatedAt === null)) throw new Error();
      return Object.freeze({
        orderId,
        clientOrderId,
        symbol,
        side,
        positionSide: positionSide ?? null,
        type,
        status,
        price,
        originalQuantity,
        executedQuantity,
        reduceOnly: entry.reduceOnly ?? null,
        updatedAt,
      });
    }));
    const recentFills = Object.freeze(rawFills.map((entry): BinanceRecentFillFact => {
      const fillId = identifier(entry.id);
      const orderId = identifier(entry.orderId);
      const symbol = nonEmpty(entry.symbol);
      const side = nonEmpty(entry.side)?.toUpperCase();
      const price = positive(entry.price);
      const quantity = positive(entry.qty);
      const quoteQuantity = nonNegative(entry.quoteQty);
      const commission = number(entry.commission);
      const commissionAsset = nonEmpty(entry.commissionAsset);
      const executedAt = timestamp(entry.time);
      if (!fillId || !orderId || !symbol || (side !== 'BUY' && side !== 'SELL') ||
          price === null || quantity === null || quoteQuantity === null || commission === null ||
          !commissionAsset || executedAt === null) throw new Error();
      return Object.freeze({
        fillId,
        orderId,
        symbol,
        side,
        price,
        quantity,
        quoteQuantity,
        commission,
        commissionAsset,
        executedAt,
      });
    }));
    const sequence = raw.sequence === undefined ? null : identifier(raw.sequence);
    if (raw.sequence !== undefined && sequence === null) throw new Error();
    return Object.freeze({
      identity: copyIdentity(identity),
      accountState: positions.some((position) => position.quantity !== 0) ? 'OPEN' : 'FLAT',
      balances,
      positions,
      openOrders,
      recentFills,
      serverTime,
      accountUpdateTime,
      observedAt,
      freshness: freshness(observedAt, accountUpdateTime, staleAfterMs),
      source: BINANCE_L1A_SOURCE,
      schemaVersion: BINANCE_L1A_SCHEMA_VERSION,
      sequence,
    });
  } catch (error) {
    if (error instanceof NormalizationFailure) throw error;
    throw new NormalizationFailure('ACCOUNT_TRUTH_MALFORMED');
  }
}

function normalizeInstrument(
  requestedSymbol: string,
  rawMark: BinanceRawMarkPrice,
  rawRules: BinanceRawInstrumentRules,
  serverTime: number,
  observedAt: number,
  staleAfterMs: number,
): BinanceInstrumentFactsSnapshot {
  try {
    const markSymbol = nonEmpty(rawMark.symbol);
    const rulesSymbol = nonEmpty(rawRules.symbol);
    const markPrice = positive(rawMark.markPrice);
    const tickSize = positive(rawRules.tickSize);
    const stepSize = positive(rawRules.stepSize);
    const minQty = positive(rawRules.minQty);
    const minNotional = positive(rawRules.minNotional);
    const contractStatus = nonEmpty(rawRules.status);
    const markPriceTime = rawMark.time === undefined ? null : timestamp(rawMark.time);
    if (!markSymbol || !rulesSymbol || markSymbol !== requestedSymbol || rulesSymbol !== requestedSymbol ||
        markPrice === null || tickSize === null || stepSize === null || minQty === null ||
        minNotional === null || !contractStatus || (rawMark.time !== undefined && markPriceTime === null)) {
      throw new Error();
    }
    return Object.freeze({
      symbol: requestedSymbol,
      markPrice,
      tickSize,
      stepSize,
      minQty,
      minNotional,
      contractStatus,
      serverTime,
      markPriceTime,
      observedAt,
      freshness: freshness(observedAt, markPriceTime, staleAfterMs),
      source: BINANCE_L1A_SOURCE,
      schemaVersion: BINANCE_L1A_SCHEMA_VERSION,
    });
  } catch {
    throw new NormalizationFailure('INSTRUMENT_FACTS_MALFORMED');
  }
}

export function evaluateBinanceNewEntryReadiness(
  account: BinanceReadResult<BinanceAccountTruthSnapshot>,
  instrument: BinanceReadResult<BinanceInstrumentFactsSnapshot>,
): BinanceNewEntryReadiness {
  const blockers: BinanceNewEntryReadBlocker[] = [];
  if (account.availability !== 'AVAILABLE' || account.value === null || account.value.freshness.status !== 'FRESH') {
    blockers.push('ACCOUNT_TRUTH_UNKNOWN');
  }
  if (instrument.availability !== 'AVAILABLE' || instrument.value === null) {
    blockers.push(instrument.reason === 'MARKET_RULES_UNKNOWN' ? 'MARKET_RULES_UNKNOWN' : 'MARK_PRICE_UNKNOWN');
  } else {
    if (instrument.value.freshness.status !== 'FRESH') blockers.push('MARK_PRICE_STALE');
    if (instrument.value.contractStatus !== 'TRADING') blockers.push('CONTRACT_NOT_TRADING');
  }
  return Object.freeze({
    safeToOpen: blockers.length === 0,
    blockers: Object.freeze(blockers),
    closeOrReduceBlockedByEntryFreshness: false,
  });
}

export function createBinanceAuthenticatedReadFoundation(
  identity: BinanceReadIdentity | null,
  bindings?: BinanceAuthenticatedReadBindings,
): BinanceAuthenticatedReadFoundation {
  const boundIdentity = identity && nonEmpty(identity.accountId) ? copyIdentity(identity) : null;
  const configured = boundIdentity !== null && bindings !== undefined;
  const staleAfterMs = bindings?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error('BINANCE_READ_STALE_AFTER_INVALID');
  }
  let connected = false;
  let lastObservedAt: number | null = null;
  let statusReason: BinanceReadFailureReason | null = configured ? null : 'BINANCE_AUTH_READ_NOT_CONFIGURED';

  function status(): BinanceAuthenticatedReadStatus {
    return Object.freeze({
      configured,
      connected,
      identity: boundIdentity ? copyIdentity(boundIdentity) : null,
      lastObservedAt,
      reason: statusReason,
      realClientDefaultWired: false,
      realCredentialDiscovery: false,
    });
  }

  async function resolveClient(): Promise<BinanceReadResult<BinanceAuthenticatedReadClient>> {
    if (!configured || !boundIdentity || !bindings) {
      return result('UNAVAILABLE', null, 'BINANCE_AUTH_READ_NOT_CONFIGURED');
    }
    let credentials: BinanceReadCredentials | null;
    try {
      credentials = await bindings.secretProvider.getReadCredentials(copyIdentity(boundIdentity));
    } catch {
      connected = false;
      statusReason = 'BINANCE_READ_CREDENTIALS_UNAVAILABLE';
      return result('UNAVAILABLE', null, statusReason);
    }
    if (!credentials || !nonEmpty(credentials.apiKey) || !nonEmpty(credentials.secretKey)) {
      connected = false;
      statusReason = 'BINANCE_READ_CREDENTIALS_UNAVAILABLE';
      return result('UNAVAILABLE', null, statusReason);
    }
    try {
      const client = bindings.clientFactory.create(copyIdentity(boundIdentity), Object.freeze({
        apiKey: credentials.apiKey,
        secretKey: credentials.secretKey,
      }));
      return result('AVAILABLE', client, null);
    } catch {
      connected = false;
      statusReason = 'BINANCE_READ_CLIENT_UNAVAILABLE';
      return result('UNKNOWN', null, statusReason);
    }
  }

  function observeNow(): number {
    const observedAt = bindings?.now();
    if (timestamp(observedAt) === null) throw new NormalizationFailure('OBSERVATION_TIME_INVALID');
    return observedAt!;
  }

  const accountTruth: BinanceAccountTruthPort = Object.freeze({
    async read() {
      const resolved = await resolveClient();
      if (!resolved.value) return result(resolved.availability, null, resolved.reason);
      try {
        const [serverTimeRaw, rawAccount, rawOrders, rawFills] = await Promise.all([
          resolved.value.getServerTime(),
          resolved.value.getAccount(),
          resolved.value.getOpenOrders(),
          resolved.value.getRecentFills(),
        ]);
        const serverTime = timestamp(serverTimeRaw);
        if (serverTime === null) throw new NormalizationFailure('ACCOUNT_TRUTH_MALFORMED');
        const observedAt = observeNow();
        const snapshot = normalizeAccount(
          boundIdentity!, rawAccount, rawOrders, rawFills, serverTime, observedAt, staleAfterMs,
        );
        connected = true;
        lastObservedAt = observedAt;
        statusReason = null;
        return result('AVAILABLE', snapshot, null);
      } catch (error) {
        connected = false;
        const reason = error instanceof NormalizationFailure ? error.reason : 'BINANCE_READ_TRANSPORT_FAILED';
        statusReason = reason;
        return result('UNKNOWN', null, reason);
      }
    },
  });

  const instrumentFacts: BinanceInstrumentFactsPort = Object.freeze({
    async read(symbolInput: string) {
      const symbol = nonEmpty(symbolInput)?.toUpperCase();
      if (!symbol) return result('UNKNOWN', null, 'INSTRUMENT_FACTS_MALFORMED');
      const resolved = await resolveClient();
      if (!resolved.value) return result(resolved.availability, null, resolved.reason);
      try {
        const [serverTimeRaw, rawMark, rawRules] = await Promise.all([
          resolved.value.getServerTime(),
          resolved.value.getMarkPrice(symbol),
          resolved.value.getInstrumentRules(symbol),
        ]);
        if (rawRules === null) {
          connected = false;
          statusReason = 'MARKET_RULES_UNKNOWN';
          return result('UNKNOWN', null, statusReason);
        }
        const serverTime = timestamp(serverTimeRaw);
        if (serverTime === null) throw new NormalizationFailure('INSTRUMENT_FACTS_MALFORMED');
        const observedAt = observeNow();
        const snapshot = normalizeInstrument(symbol, rawMark, rawRules, serverTime, observedAt, staleAfterMs);
        connected = true;
        lastObservedAt = observedAt;
        statusReason = null;
        return result('AVAILABLE', snapshot, null);
      } catch (error) {
        connected = false;
        const reason = error instanceof NormalizationFailure ? error.reason : 'BINANCE_READ_TRANSPORT_FAILED';
        statusReason = reason;
        return result('UNKNOWN', null, reason);
      }
    },
  });

  return Object.freeze({ accountTruth, instrumentFacts, status });
}
