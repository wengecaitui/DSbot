import { createHmac } from 'node:crypto';
import {
  type BinanceAuthenticatedReadClient,
  type BinanceAuthenticatedReadClientFactory,
  type BinanceRawAccount,
  type BinanceRawFill,
  type BinanceRawInstrumentRules,
  type BinanceRawMarkPrice,
  type BinanceRawOpenOrder,
  type BinanceRawPosition,
  type BinanceReadCredentials,
  type BinanceReadIdentity,
} from './BinanceAuthenticatedReadFoundation';
import { MAX_QUALIFICATION_SYMBOLS } from './BinanceAuthenticatedReadQualification';
import {
  BINANCE_USDM_READ_ENDPOINTS,
  type BinanceUsdMQueryParameter,
  type BinanceUsdMReadEndpoint,
  type BinanceUsdMReadTransport,
} from './BinanceUsdMReadTransport';

export const DEFAULT_BINANCE_RECV_WINDOW_MS = 5_000 as const;
export const MAX_BINANCE_RECV_WINDOW_MS = 60_000 as const;
export const RECENT_FILL_LIMIT_PER_SYMBOL = 50 as const;
export const MAX_BINANCE_TIME_OFFSET_MS = 60_000 as const;

export interface BinanceUsdMAuthenticatedReadClientOptions {
  readonly identity: BinanceReadIdentity;
  readonly requestedSymbols: readonly string[];
  readonly credentials: BinanceReadCredentials;
  readonly timeOffsetMs: number;
  readonly now: () => number;
  readonly transport: BinanceUsdMReadTransport;
  readonly recvWindowMs?: number;
}

export interface BinanceUsdMAuthenticatedReadClientFactoryOptions {
  readonly requestedSymbols: readonly string[];
  readonly timeOffsetMs: number;
  readonly now: () => number;
  readonly transport: BinanceUsdMReadTransport;
  readonly recvWindowMs?: number;
}

export class BinanceUsdMReadClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BinanceUsdMReadClientError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function numeric(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value));
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function canonicalSymbol(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{2,24}$/.test(value);
}

function fail(code: string): never {
  throw new BinanceUsdMReadClientError(code);
}

function validateScope(symbols: readonly string[]): readonly string[] {
  if (!Array.isArray(symbols) || symbols.length === 0 || symbols.length > MAX_QUALIFICATION_SYMBOLS
      || !symbols.every(canonicalSymbol) || new Set(symbols).size !== symbols.length) {
    fail('BINANCE_USDM_SYMBOL_SCOPE_INVALID');
  }
  return Object.freeze([...symbols].sort());
}

function validateIdentity(identity: BinanceReadIdentity): BinanceReadIdentity {
  if (!identity || identity.exchange !== 'binance'
      || !nonEmpty(identity.accountId) || !/^[A-Za-z0-9_-]{1,64}$/.test(identity.accountId)) {
    fail('BINANCE_USDM_IDENTITY_INVALID');
  }
  return Object.freeze({ exchange: 'binance', accountId: identity.accountId });
}

function validateCredentials(credentials: BinanceReadCredentials): BinanceReadCredentials {
  if (!credentials || !nonEmpty(credentials.apiKey) || !nonEmpty(credentials.secretKey)) {
    fail('BINANCE_USDM_CREDENTIALS_INVALID');
  }
  return Object.freeze({ apiKey: credentials.apiKey, secretKey: credentials.secretKey });
}

function validateClock(now: () => number, timeOffsetMs: number): void {
  if (typeof now !== 'function' || !Number.isSafeInteger(timeOffsetMs)
      || Math.abs(timeOffsetMs) > MAX_BINANCE_TIME_OFFSET_MS) {
    fail('BINANCE_USDM_TIME_CONFIGURATION_INVALID');
  }
}

function validateRecvWindow(value: number | undefined): number {
  const recvWindowMs = value ?? DEFAULT_BINANCE_RECV_WINDOW_MS;
  if (!Number.isSafeInteger(recvWindowMs) || recvWindowMs <= 0
      || recvWindowMs > MAX_BINANCE_RECV_WINDOW_MS) {
    fail('BINANCE_USDM_RECV_WINDOW_INVALID');
  }
  return recvWindowMs;
}

function parameter(name: string, value: string | number): BinanceUsdMQueryParameter {
  return Object.freeze({ name, value: String(value) });
}

function canonicalParameters(
  parameters: readonly BinanceUsdMQueryParameter[],
): readonly BinanceUsdMQueryParameter[] {
  return Object.freeze([...parameters]
    .sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value))
    .map((entry) => Object.freeze({ name: entry.name, value: entry.value })));
}

function queryString(parameters: readonly BinanceUsdMQueryParameter[]): string {
  const query = new URLSearchParams();
  for (const entry of parameters) query.append(entry.name, entry.value);
  return query.toString();
}

function adaptServerTime(payload: unknown): number {
  if (!isRecord(payload) || !timestamp(payload.serverTime)) fail('BINANCE_USDM_SERVER_TIME_INVALID');
  return payload.serverTime;
}

function adaptBalance(value: unknown): NonNullable<BinanceRawAccount['balances']>[number] {
  if (!isRecord(value) || !nonEmpty(value.asset)
      || !numeric(value.walletBalance) || !numeric(value.availableBalance)) {
    fail('BINANCE_USDM_ACCOUNT_RESPONSE_INVALID');
  }
  return Object.freeze({
    asset: value.asset,
    walletBalance: value.walletBalance,
    availableBalance: value.availableBalance,
  });
}

function adaptPosition(value: unknown): BinanceRawPosition {
  if (!isRecord(value) || !canonicalSymbol(value.symbol)
      || !numeric(value.positionAmt) || !numeric(value.entryPrice)
      || !numeric(value.unrealizedProfit) || !nonEmpty(value.marginType)
      || !numeric(value.leverage)
      || (value.markPrice !== undefined && !numeric(value.markPrice))
      || (value.updateTime !== undefined && !timestamp(value.updateTime))) {
    fail('BINANCE_USDM_ACCOUNT_RESPONSE_INVALID');
  }
  return Object.freeze({
    symbol: value.symbol,
    positionAmt: value.positionAmt,
    entryPrice: value.entryPrice,
    ...(value.markPrice === undefined ? {} : { markPrice: value.markPrice }),
    unrealizedProfit: value.unrealizedProfit,
    marginType: value.marginType,
    leverage: value.leverage,
    ...(value.updateTime === undefined ? {} : { updateTime: value.updateTime }),
  });
}

function adaptAccount(payload: unknown): BinanceRawAccount {
  if (!isRecord(payload) || !Array.isArray(payload.assets)
      || !Array.isArray(payload.positions) || !timestamp(payload.updateTime)) {
    fail('BINANCE_USDM_ACCOUNT_RESPONSE_INVALID');
  }
  return Object.freeze({
    balances: Object.freeze(payload.assets.map(adaptBalance)),
    positions: Object.freeze(payload.positions.map(adaptPosition)),
    updateTime: payload.updateTime,
  });
}

function adaptOpenOrder(value: unknown): BinanceRawOpenOrder {
  if (!isRecord(value) || (!nonEmpty(value.orderId) && !timestamp(value.orderId))
      || !nonEmpty(value.clientOrderId) || !canonicalSymbol(value.symbol)
      || !nonEmpty(value.side) || !nonEmpty(value.type) || !nonEmpty(value.status)
      || !numeric(value.price) || !numeric(value.origQty) || !numeric(value.executedQty)
      || (value.positionSide !== undefined && !nonEmpty(value.positionSide))
      || (value.reduceOnly !== undefined && typeof value.reduceOnly !== 'boolean')
      || (value.updateTime !== undefined && !timestamp(value.updateTime))) {
    fail('BINANCE_USDM_OPEN_ORDERS_RESPONSE_INVALID');
  }
  return Object.freeze({
    orderId: value.orderId as string | number,
    clientOrderId: value.clientOrderId,
    symbol: value.symbol,
    side: value.side,
    ...(value.positionSide === undefined ? {} : { positionSide: value.positionSide }),
    type: value.type,
    status: value.status,
    price: value.price,
    origQty: value.origQty,
    executedQty: value.executedQty,
    ...(value.reduceOnly === undefined ? {} : { reduceOnly: value.reduceOnly }),
    ...(value.updateTime === undefined ? {} : { updateTime: value.updateTime }),
  });
}

function adaptFill(value: unknown): BinanceRawFill {
  if (!isRecord(value) || (!nonEmpty(value.id) && !timestamp(value.id))
      || (!nonEmpty(value.orderId) && !timestamp(value.orderId))
      || !canonicalSymbol(value.symbol) || !nonEmpty(value.side)
      || !numeric(value.price) || !numeric(value.qty) || !numeric(value.quoteQty)
      || !numeric(value.commission) || !nonEmpty(value.commissionAsset)
      || !timestamp(value.time)) {
    fail('BINANCE_USDM_USER_TRADES_RESPONSE_INVALID');
  }
  return Object.freeze({
    id: value.id as string | number,
    orderId: value.orderId as string | number,
    symbol: value.symbol,
    side: value.side,
    price: value.price,
    qty: value.qty,
    quoteQty: value.quoteQty,
    commission: value.commission,
    commissionAsset: value.commissionAsset,
    time: value.time,
  });
}

function adaptMarkPrice(payload: unknown, requestedSymbol: string): BinanceRawMarkPrice {
  if (!isRecord(payload) || payload.symbol !== requestedSymbol
      || !numeric(payload.markPrice) || !timestamp(payload.time)) {
    fail('BINANCE_USDM_MARK_PRICE_RESPONSE_INVALID');
  }
  return Object.freeze({
    symbol: requestedSymbol,
    markPrice: payload.markPrice,
    time: payload.time,
  });
}

function filterByType(filters: readonly unknown[], type: string): Record<string, unknown> | null {
  const match = filters.find((entry) => isRecord(entry) && entry.filterType === type);
  return isRecord(match) ? match : null;
}

function adaptInstrumentRules(payload: unknown, requestedSymbol: string): BinanceRawInstrumentRules | null {
  if (!isRecord(payload) || !Array.isArray(payload.symbols)) {
    fail('BINANCE_USDM_EXCHANGE_INFO_RESPONSE_INVALID');
  }
  const symbol = payload.symbols.find((entry) => isRecord(entry) && entry.symbol === requestedSymbol);
  if (!isRecord(symbol)) return null;
  if (!nonEmpty(symbol.status) || !Array.isArray(symbol.filters)) {
    fail('BINANCE_USDM_EXCHANGE_INFO_RESPONSE_INVALID');
  }
  const price = filterByType(symbol.filters, 'PRICE_FILTER');
  const lot = filterByType(symbol.filters, 'LOT_SIZE');
  const notional = filterByType(symbol.filters, 'MIN_NOTIONAL')
    ?? filterByType(symbol.filters, 'NOTIONAL');
  const minNotional = notional?.notional ?? notional?.minNotional;
  if (!price || !lot || !notional || !numeric(price.tickSize)
      || !numeric(lot.stepSize) || !numeric(lot.minQty) || !numeric(minNotional)) {
    return null;
  }
  return Object.freeze({
    symbol: requestedSymbol,
    tickSize: price.tickSize,
    stepSize: lot.stepSize,
    minQty: lot.minQty,
    minNotional,
    status: symbol.status,
  });
}

function deduplicate<T>(values: readonly T[], keyOf: (value: T) => string): readonly T[] {
  const byKey = new Map<string, T>();
  for (const value of values) if (!byKey.has(keyOf(value))) byKey.set(keyOf(value), value);
  return Object.freeze([...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value));
}

export function createBinanceUsdMAuthenticatedReadClient(
  options: BinanceUsdMAuthenticatedReadClientOptions,
): BinanceAuthenticatedReadClient {
  validateIdentity(options.identity);
  const symbols = validateScope(options.requestedSymbols);
  const credentials = validateCredentials(options.credentials);
  const now = options.now;
  const timeOffsetMs = options.timeOffsetMs;
  const transport = options.transport;
  validateClock(now, timeOffsetMs);
  const recvWindowMs = validateRecvWindow(options.recvWindowMs);
  if (!transport || typeof transport.get !== 'function') {
    fail('BINANCE_USDM_TRANSPORT_INVALID');
  }

  function signedTimestamp(): number {
    const localTime = now();
    const value = localTime + timeOffsetMs;
    if (!timestamp(localTime) || !timestamp(value)) fail('BINANCE_USDM_SIGNED_TIMESTAMP_INVALID');
    return value;
  }

  async function publicGet(endpoint: BinanceUsdMReadEndpoint, query: readonly BinanceUsdMQueryParameter[] = []) {
    return transport.get(Object.freeze({ endpoint, query: canonicalParameters(query) }));
  }

  async function signedGet(endpoint: BinanceUsdMReadEndpoint, query: readonly BinanceUsdMQueryParameter[] = []) {
    const unsigned = canonicalParameters([
      ...query,
      parameter('recvWindow', recvWindowMs),
      parameter('timestamp', signedTimestamp()),
    ]);
    const signature = createHmac('sha256', credentials.secretKey)
      .update(queryString(unsigned))
      .digest('hex');
    return transport.get(Object.freeze({
      endpoint,
      query: Object.freeze([...unsigned, parameter('signature', signature)]),
      apiKey: credentials.apiKey,
    }));
  }

  let exchangeInfo: Promise<unknown> | null = null;
  function readExchangeInfo(): Promise<unknown> {
    exchangeInfo ??= publicGet(BINANCE_USDM_READ_ENDPOINTS.EXCHANGE_INFO);
    return exchangeInfo;
  }

  return Object.freeze({
    async getServerTime() {
      return adaptServerTime(await publicGet(BINANCE_USDM_READ_ENDPOINTS.SERVER_TIME));
    },
    async getAccount() {
      return adaptAccount(await signedGet(BINANCE_USDM_READ_ENDPOINTS.ACCOUNT));
    },
    async getOpenOrders() {
      const responses = await Promise.all(symbols.map(async (symbol) => {
        const payload = await signedGet(
          BINANCE_USDM_READ_ENDPOINTS.OPEN_ORDERS,
          [parameter('symbol', symbol)],
        );
        if (!Array.isArray(payload)) fail('BINANCE_USDM_OPEN_ORDERS_RESPONSE_INVALID');
        const orders = payload.map(adaptOpenOrder);
        if (orders.some((order) => order.symbol !== symbol)) {
          fail('BINANCE_USDM_OPEN_ORDERS_SYMBOL_MISMATCH');
        }
        return orders;
      }));
      return deduplicate(responses.flat(), (order) => `${order.symbol}:${String(order.orderId)}`);
    },
    async getRecentFills() {
      const responses = await Promise.all(symbols.map(async (symbol) => {
        const payload = await signedGet(
          BINANCE_USDM_READ_ENDPOINTS.USER_TRADES,
          [parameter('limit', RECENT_FILL_LIMIT_PER_SYMBOL), parameter('symbol', symbol)],
        );
        if (!Array.isArray(payload)) fail('BINANCE_USDM_USER_TRADES_RESPONSE_INVALID');
        const fills = payload.map(adaptFill);
        if (fills.some((fill) => fill.symbol !== symbol)) {
          fail('BINANCE_USDM_USER_TRADES_SYMBOL_MISMATCH');
        }
        return fills;
      }));
      return deduplicate(responses.flat(), (fill) => `${fill.symbol}:${String(fill.id)}`);
    },
    async getMarkPrice(symbolInput: string) {
      const symbol = canonicalSymbol(symbolInput) && symbols.includes(symbolInput) ? symbolInput : null;
      if (!symbol) fail('BINANCE_USDM_MARK_PRICE_SYMBOL_OUT_OF_SCOPE');
      const payload = await publicGet(
        BINANCE_USDM_READ_ENDPOINTS.MARK_PRICE,
        [parameter('symbol', symbol)],
      );
      return adaptMarkPrice(payload, symbol);
    },
    async getInstrumentRules(symbolInput: string) {
      const symbol = canonicalSymbol(symbolInput) && symbols.includes(symbolInput) ? symbolInput : null;
      if (!symbol) fail('BINANCE_USDM_RULES_SYMBOL_OUT_OF_SCOPE');
      return adaptInstrumentRules(await readExchangeInfo(), symbol);
    },
  });
}

export function createBinanceUsdMAuthenticatedReadClientFactory(
  options: BinanceUsdMAuthenticatedReadClientFactoryOptions,
): BinanceAuthenticatedReadClientFactory {
  const symbols = validateScope(options.requestedSymbols);
  const timeOffsetMs = options.timeOffsetMs;
  const now = options.now;
  const transport = options.transport;
  const recvWindowMs = options.recvWindowMs;
  let client: BinanceAuthenticatedReadClient | null = null;
  let identityKey: string | null = null;
  let apiKey: string | null = null;
  let secretKey: string | null = null;
  return Object.freeze({
    create(identity: BinanceReadIdentity, credentials: BinanceReadCredentials) {
      const boundIdentity = validateIdentity(identity);
      const boundCredentials = validateCredentials(credentials);
      const nextIdentityKey = `${boundIdentity.exchange}:${boundIdentity.accountId}`;
      if (client !== null) {
        if (identityKey !== nextIdentityKey || apiKey !== boundCredentials.apiKey
            || secretKey !== boundCredentials.secretKey) {
          fail('BINANCE_USDM_RUN_SCOPE_REBIND_FORBIDDEN');
        }
        return client;
      }
      identityKey = nextIdentityKey;
      apiKey = boundCredentials.apiKey;
      secretKey = boundCredentials.secretKey;
      client = createBinanceUsdMAuthenticatedReadClient({
        identity: boundIdentity,
        requestedSymbols: symbols,
        credentials: boundCredentials,
        timeOffsetMs,
        now,
        transport,
        ...(recvWindowMs === undefined ? {} : { recvWindowMs }),
      });
      return client;
    },
  });
}
