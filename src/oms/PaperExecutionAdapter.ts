// Phase 3: PaperExecutionAdapter — reuses existing FillSimulator/PaperBroker
import type { ExchangeId } from '../data/MarketIdentity';
import type { OmsOrder, ExecutionAdapter, ExecutionResult, OmsConfirmedFill } from './oms-types';
import type { TradeIntent } from '../types/trade-intent';
import type { FillSimulatorConfig } from '../paper/FillSimulator';
import { simulateFill } from '../paper/FillSimulator';

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

    // Build a minimal TradeIntent for FillSimulator with approved size
    const intent: TradeIntent = {
      intentId: order.intentId,
      exchange: order.exchange as ExchangeId,
      symbol: order.symbol,
      direction: order.side === 'buy' ? 'long' : 'short',
      orderType: 'market',
      positionUsd: order.approvedNotionalUsd, // ← approved size, NOT original
      source: 'paper-adapter',
      createdAt: cfg.executedAtMs,
      reason: 'oms-paper',
      biasUpdatedAt: cfg.executedAtMs,
    };

    const simConfig: FillSimulatorConfig = {
      markPriceUsd: cfg.markPriceUsd,
      feeBps: cfg.feeBps,
      slippageBps: cfg.slippageBps,
      executedAtMs: cfg.executedAtMs,
      fillIdPrefix: cfg.fillIdPrefix,
    };

    const { fill } = simulateFill(intent, simConfig, cfg.counter);

    const omsFill: OmsConfirmedFill = {
      fillId: fill.fillId,
      exchange: fill.exchange,
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.priceUsd,
      executedAt: fill.executedAt,
      orderId: order.orderId,
      intentId: order.intentId,
    };

    return { status: 'filled', fill: omsFill };
  }
}
