import type {
  ExecutionAdapter,
  ExecutionResult,
  OmsConfirmedFill,
  OmsOrder,
} from '../../oms/oms-types';

export interface BinanceFuturesInstrumentRules {
  readonly stepSize: number;
  readonly minQty: number;
  readonly minNotional: number;
}

export interface BinanceFuturesMarketOrderRequest {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly type: 'MARKET';
  readonly quantity: number;
  readonly newClientOrderId: string;
  readonly reduceOnly: boolean;
}

export interface BinanceFuturesMarketOrderResult {
  readonly status: string;
  readonly clientOrderId: string;
  readonly orderId?: string | number;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly executedQty?: number;
  readonly averagePrice?: number;
  readonly updatedAt?: number;
  readonly rejectionReason?: string;
}

/** Future L1 binds this port to a credential-owning SDK client. L0 uses fakes only. */
export interface BinanceFuturesExecutionClient {
  getMarkPrice(symbol: string): Promise<number>;
  getInstrumentRules(symbol: string): Promise<BinanceFuturesInstrumentRules>;
  submitMarketOrder(request: BinanceFuturesMarketOrderRequest): Promise<BinanceFuturesMarketOrderResult>;
}

const OMS_ORDER_ID = /^[a-f0-9]{64}$/;

export function toBinanceFuturesClientOrderId(orderId: string): string {
  if (!OMS_ORDER_ID.test(orderId)) throw new Error('INVALID_OMS_ORDER_ID');
  return `dsb_${orderId.slice(0, 32)}`;
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const fraction = coefficient.split('.')[1]?.length ?? 0;
  return Math.max(0, fraction - exponent);
}

function normalizeDownToStep(rawQuantity: number, stepSize: number): number | null {
  const places = decimalPlaces(stepSize);
  if (places > 12) return null;
  const scale = 10 ** places;
  const stepUnits = Math.round(stepSize * scale);
  const rawScaled = rawQuantity * scale;
  if (!Number.isSafeInteger(stepUnits) || stepUnits <= 0 || !Number.isFinite(rawScaled)) return null;
  const normalizedUnits = Math.floor((rawScaled + Number.EPSILON * scale) / stepUnits) * stepUnits;
  if (!Number.isSafeInteger(normalizedUnits)) return null;
  return normalizedUnits / scale;
}

function rejected(reason: string): ExecutionResult {
  return { status: 'rejected', reason };
}

function unknown(reason: string): ExecutionResult {
  return { status: 'unknown', reason };
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 8;
}

/**
 * L0 execution adapter. It owns no credentials, environment lookup, retry loop,
 * or network implementation. All exchange facts and submission are injected.
 */
export class BinanceFuturesExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly client: BinanceFuturesExecutionClient) {}

  async submit(order: OmsOrder): Promise<ExecutionResult> {
    if (order.exchange !== 'binance') return rejected('EXCHANGE_MISMATCH');
    if (!Number.isFinite(order.approvedNotionalUsd) || order.approvedNotionalUsd <= 0) {
      return rejected('INVALID_APPROVED_NOTIONAL');
    }

    let clientOrderId: string;
    try {
      clientOrderId = toBinanceFuturesClientOrderId(order.orderId);
    } catch {
      return rejected('INVALID_OMS_ORDER_ID');
    }

    let markPrice: number;
    try {
      markPrice = await this.client.getMarkPrice(order.symbol);
    } catch {
      return rejected('MISSING_MARK_PRICE');
    }
    if (!Number.isFinite(markPrice) || markPrice <= 0) return rejected('MISSING_MARK_PRICE');

    let rules: BinanceFuturesInstrumentRules;
    try {
      rules = await this.client.getInstrumentRules(order.symbol);
    } catch {
      return rejected('MISSING_INSTRUMENT_RULES');
    }
    if (!rules || typeof rules !== 'object') return rejected('MISSING_INSTRUMENT_RULES');
    if (!Number.isFinite(rules.stepSize) || rules.stepSize <= 0) return rejected('INVALID_STEP_SIZE');
    if (!Number.isFinite(rules.minQty) || rules.minQty <= 0 ||
        !Number.isFinite(rules.minNotional) || rules.minNotional <= 0) {
      return rejected('MISSING_INSTRUMENT_RULES');
    }

    const rawQuantity = order.approvedNotionalUsd / markPrice;
    const quantity = normalizeDownToStep(rawQuantity, rules.stepSize);
    if (quantity === null) return rejected('INVALID_STEP_SIZE');
    if (!(quantity > 0)) return rejected('NORMALIZED_QTY_ZERO');
    if (quantity < rules.minQty) return rejected('BELOW_MIN_QTY');
    if (quantity * markPrice < rules.minNotional) return rejected('BELOW_MIN_NOTIONAL');

    const request: BinanceFuturesMarketOrderRequest = Object.freeze({
      symbol: order.symbol,
      side: order.side === 'buy' ? 'BUY' : 'SELL',
      type: 'MARKET',
      quantity,
      newClientOrderId: clientOrderId,
      reduceOnly: order.action === 'reduce' || order.action === 'close' || order.action === 'emergency_exit',
    });

    let result: BinanceFuturesMarketOrderResult;
    try {
      result = await this.client.submitMarketOrder(request);
    } catch {
      return unknown('TRANSPORT_AMBIGUITY');
    }

    if (!result || typeof result !== 'object' ||
        result.clientOrderId !== clientOrderId ||
        result.symbol !== request.symbol || result.side !== request.side ||
        typeof result.status !== 'string') {
      return unknown('MALFORMED_EXCHANGE_RESULT');
    }

    if (result.status === 'PARTIALLY_FILLED') {
      return unknown('PARTIAL_FILL_FULL_LIFECYCLE_REQUIRED');
    }
    if (result.status === 'REJECTED') {
      return rejected(result.rejectionReason || 'EXCHANGE_REJECTED');
    }
    if (result.status === 'NEW' || result.status === 'ACCEPTED') {
      return { status: 'accepted' };
    }
    if (result.status !== 'FILLED') return unknown('MALFORMED_EXCHANGE_RESULT');

    if (typeof result.executedQty !== 'number' || !Number.isFinite(result.executedQty) ||
        typeof result.averagePrice !== 'number' || !Number.isFinite(result.averagePrice) ||
        typeof result.updatedAt !== 'number' || !Number.isSafeInteger(result.updatedAt) || result.updatedAt < 0 ||
        (typeof result.orderId !== 'string' && typeof result.orderId !== 'number')) {
      return unknown('MALFORMED_EXCHANGE_RESULT');
    }
    if (!sameNumber(result.executedQty, quantity)) {
      return result.executedQty > 0 && result.executedQty < quantity
        ? unknown('PARTIAL_FILL_FULL_LIFECYCLE_REQUIRED')
        : unknown('MALFORMED_EXCHANGE_RESULT');
    }
    if (!(result.averagePrice > 0)) return unknown('MALFORMED_EXCHANGE_RESULT');

    const fill: OmsConfirmedFill = Object.freeze({
      fillId: `binance-futures:${String(result.orderId)}`,
      orderId: order.orderId,
      intentId: order.intentId,
      exchange: order.exchange,
      symbol: order.symbol,
      side: order.side,
      quantity: result.executedQty,
      price: result.averagePrice,
      executedAt: result.updatedAt,
    });
    return { status: 'filled', fill };
  }
}
