import type {
  ExecutionAdapter,
  ExecutionResult,
  OmsConfirmedFill,
  OmsOrder,
} from '../../oms/oms-types';
import {
  GATEIO_L0_INITIAL_CONTRACT,
} from '../../runtime/gateio/GateIoReadContracts';
import type {
  GateIoCanonicalInstrumentFacts,
} from '../../runtime/gateio/GateIoAuthenticatedReadFoundation';

export const GATEIO_G1_CANONICAL_SYMBOL = 'ETH/USDT' as const;
export const GATEIO_CLIENT_TEXT_PREFIX = 't-dsb-' as const;
export const GATEIO_CLIENT_TEXT_MAX_LENGTH = 28 as const;
/** F-09 is proven only for ETH_USDT: Gate accepts one decimal contract place, minimum 0.1. */
export const GATEIO_ETH_DECIMAL_CONTRACT_STEP = 0.1 as const;
export const GATEIO_ETH_DECIMAL_CONTRACT_SCALE = 10 as const;
/** Exact F-09 adversarial condition: a close mark 0.1% above the exposure valuation mark. */
export const GATEIO_CLOSE_MARK_DRIFT_RATIO = 0.001 as const;

export interface GateIoFuturesMarketOrderRequest {
  readonly contract: typeof GATEIO_L0_INITIAL_CONTRACT;
  /** Gate contract count: buy is positive and sell is negative. */
  readonly size: number;
  readonly price: '0';
  readonly tif: 'ioc';
  readonly reduceOnly: boolean;
  readonly text: string;
}

/**
 * Safe normalized output port for the future network-owning client.
 * Raw bodies are never accepted here. Int64 identifiers have already become exact strings or null.
 * executedAt is factual Gate epoch seconds and is converted explicitly by this adapter.
 */
export interface GateIoFuturesMarketOrderResult {
  readonly status: 'REJECTED' | 'ACCEPTED' | 'OPEN' | 'PARTIALLY_FILLED' | 'FINISHED';
  readonly clientText: string;
  readonly contract: string;
  readonly signedFilledSize: number;
  readonly averagePrice: number | null;
  readonly executedAt: number | null;
  readonly tradeId: string | null;
  readonly exchangeOrderId?: string | null;
  readonly rejectionReason?: string;
}

/** Future G2 owns network binding. G1 accepts only this injected two-method port. */
export interface GateIoFuturesExecutionClient {
  getInstrumentFacts(symbol: string): Promise<GateIoCanonicalInstrumentFacts | null>;
  submitMarketOrder(
    request: GateIoFuturesMarketOrderRequest,
    purpose?: 'PROOF' | 'EMERGENCY_CLEANUP',
  ): Promise<GateIoFuturesMarketOrderResult>;
}

const OMS_ORDER_ID = /^[a-f0-9]{64}$/;
const EXACT_INT64_STRING = /^[0-9]+$/;

export function toGateIoClientText(orderId: string): string {
  if (!OMS_ORDER_ID.test(orderId)) throw new Error('INVALID_OMS_ORDER_ID');
  const available = GATEIO_CLIENT_TEXT_MAX_LENGTH - GATEIO_CLIENT_TEXT_PREFIX.length;
  return `${GATEIO_CLIENT_TEXT_PREFIX}${orderId.slice(0, available)}`;
}

/** Convert factual Gate epoch seconds to the canonical integer millisecond timestamp. */
export function gateIoExecutionSecondsToMilliseconds(seconds: unknown): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function rejected(reason: string): ExecutionResult {
  return { status: 'rejected', reason };
}

function unknown(reason: string): ExecutionResult {
  return { status: 'unknown', reason };
}

function instrumentFactsValid(
  value: GateIoCanonicalInstrumentFacts | null,
): value is GateIoCanonicalInstrumentFacts {
  if (value === null || typeof value !== 'object') return false;
  if (value.contract !== GATEIO_L0_INITIAL_CONTRACT || value.contractOpenable !== true
      || typeof value.decimalSizeEnabled !== 'boolean') return false;
  const positive = [
    value.markPrice, value.contractMultiplier, value.minOrderSize, value.maxOrderSize,
  ];
  return positive.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry > 0)
    && value.minOrderSize <= value.maxOrderSize
    && (value.decimalSizeEnabled === false
      || value.minOrderSize === GATEIO_ETH_DECIMAL_CONTRACT_STEP);
}

function scaledInteger(value: number, scale: number, direction: 'down' | 'up'): number | null {
  const scaled = value * scale;
  if (!Number.isFinite(scaled) || scaled <= 0) return null;
  // Remove only binary floating-point dust at an already factual contract boundary.
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8;
  let units = Math.floor(scaled + tolerance);
  if (direction === 'up') {
    const upper = Math.ceil(scaled - tolerance);
    const relativeGap = upper > 0 ? (upper - scaled) / upper : Number.POSITIVE_INFINITY;
    // Do not turn an arbitrary fractional approval into a larger close. Restore only the narrow
    // next-step shortfall proven by F-09 mark drift; otherwise retain downward normalization.
    if (relativeGap <= GATEIO_CLOSE_MARK_DRIFT_RATIO + tolerance) units = upper;
  }
  return Number.isSafeInteger(units) && units > 0 ? units : null;
}

/**
 * Normalize ETH_USDT contracts without inventing a wider exchange rule.
 * Entry never grows the approved amount. A reduce-only action may restore the next factual step
 * only inside the proven mark-drift ratio; this prevents a newer, slightly higher mark from
 * under-sizing the existing exposure without turning arbitrary fractional approval into authority.
 */
export function normalizeGateIoEthContracts(
  rawContracts: number,
  facts: GateIoCanonicalInstrumentFacts,
  action: OmsOrder['action'],
): number | null {
  const scale = facts.decimalSizeEnabled ? GATEIO_ETH_DECIMAL_CONTRACT_SCALE : 1;
  if (facts.decimalSizeEnabled && facts.minOrderSize !== GATEIO_ETH_DECIMAL_CONTRACT_STEP) {
    return null;
  }
  const direction = action === 'reduce' || action === 'close' || action === 'emergency_exit'
    ? 'up' : 'down';
  const units = scaledInteger(rawContracts, scale, direction);
  if (units === null) return null;
  const contracts = units / scale;
  return Number.isFinite(contracts) && contracts > 0 ? contracts : null;
}

export function gateIoEthContractSizeValid(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return false;
  const units = Math.abs(value) * GATEIO_ETH_DECIMAL_CONTRACT_SCALE;
  const nearest = Math.round(units);
  const tolerance = Number.EPSILON * Math.max(1, units) * 8;
  return Number.isSafeInteger(nearest) && Math.abs(units - nearest) <= tolerance;
}

function contractSizeUnits(value: number): number {
  return Math.round(value * GATEIO_ETH_DECIMAL_CONTRACT_SCALE);
}

function sameContractSize(left: number, right: number): boolean {
  return gateIoEthContractSizeValid(left) && gateIoEthContractSizeValid(right)
    && contractSizeUnits(left) === contractSizeUnits(right);
}

function exchangeOrderIdValid(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length > 0);
}

function attributionValid(
  result: GateIoFuturesMarketOrderResult,
  request: GateIoFuturesMarketOrderRequest,
): boolean {
  if (result.clientText !== request.text || result.contract !== request.contract
      || !exchangeOrderIdValid(result.exchangeOrderId)
      || typeof result.signedFilledSize !== 'number'
      || !Number.isFinite(result.signedFilledSize)) return false;
  if ((result.signedFilledSize !== 0 && !gateIoEthContractSizeValid(result.signedFilledSize))
      || !gateIoEthContractSizeValid(request.size)) return false;
  if (result.signedFilledSize !== 0
      && Math.sign(result.signedFilledSize) !== Math.sign(request.size)) return false;
  return contractSizeUnits(Math.abs(result.signedFilledSize))
    <= contractSizeUnits(Math.abs(request.size));
}

/**
 * Local G1 adapter only. It owns no credential, environment, transport, SDK, clock, retry,
 * account truth, position truth, reconciliation authority, or event-publishing authority.
 */
export class GateIoFuturesExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly client: GateIoFuturesExecutionClient) {}

  async submit(order: OmsOrder): Promise<ExecutionResult> {
    if (order.exchange !== 'gateio') return rejected('EXCHANGE_MISMATCH');
    if (order.symbol !== GATEIO_G1_CANONICAL_SYMBOL) {
      return rejected('MISSING_INSTRUMENT_FACTS');
    }
    if (!Number.isFinite(order.approvedNotionalUsd) || order.approvedNotionalUsd <= 0) {
      return rejected('INVALID_APPROVED_NOTIONAL');
    }

    let text: string;
    try {
      text = toGateIoClientText(order.orderId);
    } catch {
      return rejected('INVALID_OMS_ORDER_ID');
    }

    let facts: GateIoCanonicalInstrumentFacts | null;
    try {
      facts = await this.client.getInstrumentFacts(order.symbol);
    } catch {
      return rejected('MISSING_INSTRUMENT_FACTS');
    }
    if (!instrumentFactsValid(facts)) return rejected('MISSING_INSTRUMENT_FACTS');

    const rawContracts = order.approvedNotionalUsd / (facts.markPrice * facts.contractMultiplier);
    if (!Number.isFinite(rawContracts) || rawContracts <= 0) {
      return rejected('INVALID_APPROVED_NOTIONAL');
    }
    const contracts = normalizeGateIoEthContracts(rawContracts, facts, order.action);
    if (contracts === null) {
      return rejected('NORMALIZED_SIZE_ZERO');
    }
    if (contracts < facts.minOrderSize
        || (order.action !== 'reduce' && order.action !== 'close'
          && order.action !== 'emergency_exit'
          && rawContracts < facts.minOrderSize)) {
      return rejected('BELOW_MIN_ORDER_SIZE');
    }
    if (contracts > facts.maxOrderSize) return rejected('ABOVE_MAX_ORDER_SIZE');

    const request: GateIoFuturesMarketOrderRequest = Object.freeze({
      contract: GATEIO_L0_INITIAL_CONTRACT,
      size: order.side === 'buy' ? contracts : -contracts,
      price: '0',
      tif: 'ioc',
      reduceOnly: order.action === 'reduce'
        || order.action === 'close'
        || order.action === 'emergency_exit',
      text,
    });

    let result: GateIoFuturesMarketOrderResult;
    try {
      result = await this.client.submitMarketOrder(
        request, order.action === 'emergency_exit' ? 'EMERGENCY_CLEANUP' : 'PROOF',
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null
          && 'decision' in error && error.decision === 'DENIED'
          && 'reasonCode' in error
          && (error.reasonCode === 'MUTATION_CAP_EXCEEDED'
            || error.reasonCode === 'GATEIO_EXECUTION_REQUEST_INVALID')) {
        return rejected(error.reasonCode);
      }
      return unknown('TRANSPORT_AMBIGUITY');
    }

    if (!result || typeof result !== 'object' || !attributionValid(result, request)) {
      return unknown('MALFORMED_EXCHANGE_RESULT');
    }

    if (result.status === 'REJECTED') {
      if (result.signedFilledSize !== 0) return unknown('MALFORMED_EXCHANGE_RESULT');
      return rejected(result.rejectionReason || 'EXCHANGE_REJECTED');
    }
    if (result.status === 'ACCEPTED' || result.status === 'OPEN') {
      return result.signedFilledSize === 0
        ? { status: 'accepted' }
        : unknown('PARTIAL_FILL_FULL_LIFECYCLE_REQUIRED');
    }
    if (result.status === 'PARTIALLY_FILLED') {
      return unknown('PARTIAL_FILL_FULL_LIFECYCLE_REQUIRED');
    }
    if (result.status !== 'FINISHED') return unknown('MALFORMED_EXCHANGE_RESULT');

    if (contractSizeUnits(Math.abs(result.signedFilledSize))
        < contractSizeUnits(Math.abs(request.size))) {
      return unknown('PARTIAL_FILL_FULL_LIFECYCLE_REQUIRED');
    }
    if (!sameContractSize(Math.abs(result.signedFilledSize), Math.abs(request.size))
        || typeof result.averagePrice !== 'number'
        || !Number.isFinite(result.averagePrice) || result.averagePrice <= 0
        || typeof result.tradeId !== 'string' || !EXACT_INT64_STRING.test(result.tradeId)) {
      return unknown('MALFORMED_EXCHANGE_RESULT');
    }
    const executedAt = gateIoExecutionSecondsToMilliseconds(result.executedAt);
    if (executedAt === null) return unknown('MALFORMED_EXCHANGE_RESULT');
    const quantity = Math.abs(result.signedFilledSize) * facts.contractMultiplier;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return unknown('MALFORMED_EXCHANGE_RESULT');
    }

    const fill: OmsConfirmedFill = Object.freeze({
      fillId: result.tradeId,
      orderId: order.orderId,
      intentId: order.intentId,
      exchange: 'gateio',
      symbol: order.symbol,
      side: order.side,
      quantity,
      price: result.averagePrice,
      executedAt,
    });
    return { status: 'filled', fill };
  }
}
