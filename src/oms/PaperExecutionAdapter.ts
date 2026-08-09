// Phase 3: PaperExecutionAdapter — uses real PaperExecutionService/PaperBroker/PaperAccountLedger/persistence
import type { OmsOrder, ExecutionAdapter, ExecutionResult, OmsConfirmedFill } from './oms-types';
import type { TradeIntent } from '../types/trade-intent';
import type { PaperExecutionService, ExecuteParams } from '../paper/PaperExecutionService';
import type { ExchangeId } from '../data/MarketIdentity';

export class PaperExecutionAdapter implements ExecutionAdapter {
  constructor(
    private service: PaperExecutionService,
    private params: ExecuteParams,
  ) {}

  async submit(order: OmsOrder): Promise<ExecutionResult> {
    // Build original TradeIntent for identity only (positionUsd preserved)
    const intent: TradeIntent = {
      intentId: order.intentId,
      exchange: order.exchange as ExchangeId,
      symbol: order.symbol,
      direction: order.side === 'buy' ? 'long' : 'short',
      orderType: 'market',
      positionUsd: order.approvedNotionalUsd, // preserved for identity, sizing from approvedNotionalUsd
      source: 'oms-adapter',
      createdAt: this.params.executedAtMs,
      reason: 'oms-approved',
      biasUpdatedAt: this.params.executedAtMs,
    };

    // Execute through real PaperExecutionService → PaperBroker → PaperAccountLedger → persistence
    const paperEvent = await this.service.executeApproved(intent, order.approvedNotionalUsd, this.params);

    if (paperEvent.status === 'applied') {
      const omsFill: OmsConfirmedFill = {
        fillId: paperEvent.fillId!,
        exchange: order.exchange,
        symbol: order.symbol,
        side: order.side,
        quantity: paperEvent.quantity!,
        price: paperEvent.executedPriceUsd!,
        executedAt: this.params.executedAtMs,
        orderId: order.orderId,
        intentId: order.intentId,
      };
      return { status: 'filled', fill: omsFill };
    }

    if (paperEvent.status === 'duplicate') {
      return { status: 'rejected', reason: 'duplicate fill' };
    }

    if (paperEvent.status === 'rejected') {
      return { status: 'rejected', reason: 'paper execution rejected' };
    }

    return { status: 'unknown', reason: paperEvent.error ?? 'paper execution failed' };
  }
}
