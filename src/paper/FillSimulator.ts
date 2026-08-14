// Stage 3B4C9-R2: SHA-256 deterministic fill ID based on canonical fill data.
import * as crypto from 'crypto';
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { TradeIntent } from '../types/trade-intent';
import type { PaperFill } from '../types/paper-fill';
import { validatePaperFill } from '../types/paper-fill';
import { roundUsd, roundQuantity } from './PaperLedgerMath';

export interface FillSimulatorConfig {
  markPriceUsd: number;
  feeBps: number;
  slippageBps: number;
  executedAtMs: number;
  fillIdPrefix?: string;
  /** Phase 5B: optional OMS correlation metadata carried onto the fill. */
  sourceOrderId?: string;
  sourceIntentId?: string;
}

const DEFAULT_PREFIX = 'sim';
const MAX_FILLID_LEN = 128;
const PREFIX_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface SimulateResult {
  fill: PaperFill;
  executedPriceUsd: number;
  quantity: number;
  executedNotionalUsd: number;
  feeUsd: number;
}

/** R2: SHA-256 deterministic fillId based on canonical fill fields. */
/** R4/S13: fillId binds intentId + canonical fill data. */
function computeFillId(
  intentId: string, exchange: ExchangeId, symbol: string, side: 'buy' | 'sell',
  quantity: number, priceUsd: number, feeUsd: number, executedAt: number,
  prefix: string,
): string {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix))
    throw new Error(`FillSimulator: fillIdPrefix must match /^[A-Za-z0-9_-]{1,32}$/, got ${JSON.stringify(prefix)}`);
  const canonical = `${intentId}|${exchange}|${symbol}|${side}|${quantity}|${priceUsd}|${feeUsd}|${executedAt}`;
  const digest = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  const id = `${prefix}-${digest}`;
  if (id.length > MAX_FILLID_LEN)
    throw new Error(`FillSimulator: fillId too long (${id.length} > ${MAX_FILLID_LEN})`);
  return id;
}

function validateIntent(intent: TradeIntent): void {
  if (!isExchangeId(intent.exchange)) throw new Error(`FillSimulator: invalid exchange ${JSON.stringify(intent.exchange)}`);
  if (intent.direction !== 'long' && intent.direction !== 'short') throw new Error(`FillSimulator: direction must be long/short, got ${intent.direction}`);
  if (intent.orderType !== 'market') throw new Error(`FillSimulator: orderType must be market, got ${intent.orderType}`);
  if (!intent.symbol || typeof intent.symbol !== 'string') throw new Error('FillSimulator: symbol must be non-empty');
  if (typeof intent.positionUsd !== 'number' || !Number.isFinite(intent.positionUsd) || intent.positionUsd <= 0)
    throw new Error(`FillSimulator: positionUsd must be finite positive, got ${intent.positionUsd}`);
  if (typeof intent.createdAt !== 'number' || !Number.isInteger(intent.createdAt) || intent.createdAt < 0)
    throw new Error(`FillSimulator: createdAt must be non-negative integer, got ${intent.createdAt}`);
  if (typeof intent.biasUpdatedAt !== 'number' || !Number.isInteger(intent.biasUpdatedAt) || intent.biasUpdatedAt < 0)
    throw new Error(`FillSimulator: biasUpdatedAt must be non-negative integer, got ${intent.biasUpdatedAt}`);
}

function validateConfig(config: FillSimulatorConfig, direction: string): void {
  if (!Number.isFinite(config.markPriceUsd) || config.markPriceUsd <= 0)
    throw new Error('FillSimulator: markPriceUsd must be finite positive');
  if (!Number.isFinite(config.feeBps) || config.feeBps < 0)
    throw new Error('FillSimulator: feeBps must be finite non-negative');
  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 0)
    throw new Error('FillSimulator: slippageBps must be finite non-negative');
  if (!Number.isInteger(config.executedAtMs) || config.executedAtMs < 0)
    throw new Error('FillSimulator: executedAtMs must be non-negative integer');
  if (direction === 'short' && config.slippageBps >= 10_000)
    throw new Error(`FillSimulator: short slippageBps=${config.slippageBps} must be < 10000 (would zero or negate price)`);
}

export function simulateFill(intent: TradeIntent, config: FillSimulatorConfig, counter: number): SimulateResult {
  if (!Number.isInteger(counter) || counter < 0) throw new Error(`FillSimulator: counter must be non-negative integer, got ${counter}`);
  validateIntent(intent);
  validateConfig(config, intent.direction);
  if (config.executedAtMs < intent.createdAt) throw new Error('FillSimulator: executedAtMs < intent.createdAt');

  const isBuy = intent.direction === 'long';
  const slipMult = 1 + (isBuy ? 1 : -1) * config.slippageBps / 10_000;
  const executedPriceUsd = roundUsd(config.markPriceUsd * slipMult);
  const quantity = roundQuantity(intent.positionUsd / executedPriceUsd);
  const executedNotionalUsd = roundUsd(quantity * executedPriceUsd);
  const feeUsd = roundUsd(executedNotionalUsd * config.feeBps / 10_000);

  // Post-round validation
  if (!Number.isFinite(executedPriceUsd) || executedPriceUsd <= 0)
    throw new Error(`FillSimulator: executedPriceUsd=${executedPriceUsd} after rounding`);
  if (!Number.isFinite(quantity) || quantity <= 0)
    throw new Error(`FillSimulator: quantity=${quantity} after rounding`);
  if (!Number.isFinite(executedNotionalUsd) || executedNotionalUsd <= 0)
    throw new Error(`FillSimulator: executedNotionalUsd=${executedNotionalUsd} after rounding`);
  if (!Number.isFinite(feeUsd) || feeUsd < 0)
    throw new Error(`FillSimulator: feeUsd=${feeUsd} after rounding`);

  const side = isBuy ? 'buy' as const : 'sell' as const;
  const prefix = config.fillIdPrefix ?? DEFAULT_PREFIX;
  const fillId = computeFillId(intent.intentId, intent.exchange, intent.symbol, side, quantity, executedPriceUsd, feeUsd, config.executedAtMs, prefix);
  const fill: PaperFill = {
    fillId, exchange: intent.exchange, symbol: intent.symbol, side, quantity, priceUsd: executedPriceUsd, feeUsd, executedAt: config.executedAtMs,
    sourceOrderId: config.sourceOrderId, sourceIntentId: config.sourceIntentId,
    executionReferencePriceUsd: config.markPriceUsd,
  };
  validatePaperFill(fill);
  return { fill, executedPriceUsd, quantity, executedNotionalUsd, feeUsd };
}
