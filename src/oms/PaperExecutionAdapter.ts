// Phase 3: PaperExecutionAdapter — adapted paper execution
import type { ExchangeId } from '../data/MarketIdentity';
import type { OmsOrder, ExecutionAdapter, ExecutionResult, OmsConfirmedFill } from './oms-types';

export interface PaperAdapterConfig {
  markPriceUsd: number;
  feeBps: number;
  slippageBps: number;
  executedAtMs: number;
  fillIdPrefix: string;
  counter: number;
}

export class PaperExecutionAdapter implements ExecutionAdapter {
  private config: PaperAdapterConfig;

  constructor(config: PaperAdapterConfig) {
    this.config = { ...config };
  }

  async submit(order: OmsOrder): Promise<ExecutionResult> {
    const cfg = this.config;
    cfg.counter++;

    // Simulate fill using approvedNotionalUsd (NOT intent.positionUsd)
    const executedPriceUsd = cfg.markPriceUsd;
    const slippageFactor = 1 + (order.side === 'buy' ? 1 : -1) * (cfg.slippageBps / 10000);
    const actualPrice = roundUsd(executedPriceUsd * slippageFactor);
    const quantity = roundQuantity(order.approvedNotionalUsd / actualPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { status: 'rejected', reason: `Invalid quantity: ${quantity}` };
    }

    const fill: OmsConfirmedFill = {
      fillId: `${cfg.fillIdPrefix}--${cfg.counter}`,
      exchange: order.exchange,
      symbol: order.symbol,
      side: order.side,
      quantity,
      price: actualPrice,
      executedAt: cfg.executedAtMs,
      orderId: order.orderId,
      intentId: order.intentId,
    };

    return { status: 'filled', fill };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundQuantity(value: number): number {
  return Math.round(value * 100000) / 100000;
}
