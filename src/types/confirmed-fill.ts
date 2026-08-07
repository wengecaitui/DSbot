// Phase 1B3: ConfirmedFill — canonical, environment-neutral execution fill
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';

export interface ConfirmedFill {
  readonly fillId: string;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly price: number;
  readonly executedAt: number;
}

export function validateConfirmedFill(f: unknown): ConfirmedFill {
  if (!f || typeof f !== 'object') throw new Error('CONFIRMED_FILL_INVALID: not an object');
  const fill = f as Record<string, unknown>;

  if (typeof fill.fillId !== 'string' || fill.fillId.length === 0) throw new Error('CONFIRMED_FILL_INVALID: fillId');
  if (!isExchangeId(fill.exchange as string)) throw new Error('CONFIRMED_FILL_INVALID: exchange');
  if (typeof fill.symbol !== 'string' || fill.symbol.length === 0) throw new Error('CONFIRMED_FILL_INVALID: symbol');
  if (fill.side !== 'buy' && fill.side !== 'sell') throw new Error('CONFIRMED_FILL_INVALID: side');
  if (typeof fill.quantity !== 'number' || !Number.isFinite(fill.quantity) || fill.quantity <= 0) throw new Error('CONFIRMED_FILL_INVALID: quantity');
  if (typeof fill.price !== 'number' || !Number.isFinite(fill.price) || fill.price <= 0) throw new Error('CONFIRMED_FILL_INVALID: price');
  if (typeof fill.executedAt !== 'number' || !Number.isSafeInteger(fill.executedAt) || fill.executedAt < 0) throw new Error('CONFIRMED_FILL_INVALID: executedAt');

  return f as ConfirmedFill;
}

export function canonicalizeConfirmedFill(fill: ConfirmedFill): ConfirmedFill {
  return { fillId: fill.fillId, exchange: fill.exchange, symbol: fill.symbol, side: fill.side,
    quantity: fill.quantity, price: fill.price, executedAt: fill.executedAt };
}
