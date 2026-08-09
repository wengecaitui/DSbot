// Phase 3: PaperExecutionAdapter — uses real PaperBroker/PaperExecutionService
import type { OmsOrder, ExecutionAdapter, ExecutionResult, OmsConfirmedFill } from './oms-types';
import type { TradeIntent } from '../types/trade-intent';
import type { PaperExecutionService } from '../paper/PaperExecutionService';
import type { ExecuteParams } from '../paper/PaperExecutionService';
import type { ExchangeId } from '../data/MarketIdentity';
import { simulateFill } from '../paper/FillSimulator';
import type { FillSimulatorConfig } from '../paper/FillSimulator';

export class PaperExecutionAdapter implements ExecutionAdapter {
  private params: ExecuteParams;
  private counter = 0;

  constructor(params: ExecuteParams) {
    this.params = { markPriceUsd: params.markPriceUsd, feeBps: params.feeBps,
      slippageBps: params.slippageBps, executedAtMs: params.executedAtMs,
      fillIdPrefix: params.fillIdPrefix };
  }

  async submit(order: OmsOrder): Promise<ExecutionResult> {
    const counter = ++this.counter;

    // Build minimal TradeIntent with approved size for FillSimulator
    // NOTE: different intentId to avoid canonical identity conflict
    const intent: TradeIntent = {
      intentId: `oms-${order.intentId}`,
      exchange: order.exchange as ExchangeId,
      symbol: order.symbol,
      direction: order.side === 'buy' ? 'long' : 'short',
      orderType: 'market',
      positionUsd: order.approvedNotionalUsd,
      source: 'oms-adapter',
      createdAt: this.params.executedAtMs,
      reason: 'oms-approved',
      biasUpdatedAt: this.params.executedAtMs,
    };

    const simCfg: FillSimulatorConfig = {
      markPriceUsd: this.params.markPriceUsd,
      feeBps: this.params.feeBps,
      slippageBps: this.params.slippageBps,
      executedAtMs: this.params.executedAtMs,
      fillIdPrefix: this.params.fillIdPrefix,
    };

    const { fill: rawFill } = simulateFill(intent, simCfg, counter);

    const omsFill: OmsConfirmedFill = {
      fillId: rawFill.fillId,
      exchange: rawFill.exchange,
      symbol: rawFill.symbol,
      side: rawFill.side,
      quantity: rawFill.quantity,
      price: rawFill.priceUsd,
      executedAt: rawFill.executedAt,
      orderId: order.orderId,
      intentId: order.intentId,
    };

    return { status: 'filled', fill: omsFill };
  }
}
