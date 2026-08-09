// Stage 3B4C13: Instance-based Paper Execution Service with dynamic execution input.
import type { ExchangeId } from '../data/MarketIdentity';
import type { PaperAccountConfig, PaperAccountSnapshot, PaperLedgerEntry } from '../types/paper-account';
import type { TradeIntent } from '../types/trade-intent';
import type { FillSimulatorConfig } from './FillSimulator';
import { PaperBroker, type PaperBrokerPersistence, type PaperBrokerResult } from './PaperBroker';
import { canonicalizePaperAccountConfig } from '../types/paper-account';

export type PaperExecutionStatus = 'applied' | 'duplicate' | 'rejected' | 'failed';

export interface PaperExecutionEvent {
  status: PaperExecutionStatus;
  fillId?: string;
  executedPriceUsd?: number;
  quantity?: number;
  feeUsd?: number;
  snapshot: PaperAccountSnapshot;
  error?: string;
}

/** Per-execute simulation parameters — all explicit, no stored defaults. */
export interface ExecuteParams {
  markPriceUsd: number;
  feeBps: number;
  slippageBps: number;
  executedAtMs: number;
  fillIdPrefix?: string;
}

export class PaperExecutionService {
  private broker: PaperBroker;
  private counter = 0;
  private canonical: PaperAccountConfig;

  private constructor(broker: PaperBroker, config: PaperAccountConfig) {
    this.broker = broker;
    this.canonical = canonicalizePaperAccountConfig(config);
  }

  /** Open a service bound to one canonical account + persistence. */
  static async open(config: PaperAccountConfig, persistence: PaperBrokerPersistence): Promise<PaperExecutionService> {
    const canonical = canonicalizePaperAccountConfig(config);
    const broker = await PaperBroker.open(canonical, persistence);
    const svc = new PaperExecutionService(broker, config);
    svc.counter = broker.snapshot().sequence;
    return svc;
  }

  /** Stage 4A1-R1: read-only identity — canonical config, no internal state leaked. */
  getIdentity(): { readonly accountId: string; readonly exchange: ExchangeId } {
    return { accountId: this.canonical.accountId, exchange: this.canonical.exchange };
  }

  snapshot(): PaperAccountSnapshot { return this.broker.snapshot(); }
  entries(): readonly PaperLedgerEntry[] { return this.broker.entries(); }

  /** Phase 3 OMS: Execute with explicit approved notional — original intent identity preserved. */
  async executeApproved(
    intent: TradeIntent,
    approvedNotionalUsd: number,
    params: ExecuteParams,
  ): Promise<PaperExecutionEvent> {
    const counter = ++this.counter;
    const simCfg: FillSimulatorConfig = {
      markPriceUsd: params.markPriceUsd,
      feeBps: params.feeBps,
      slippageBps: params.slippageBps,
      executedAtMs: params.executedAtMs,
      fillIdPrefix: params.fillIdPrefix,
    };
    // Synthetic intent for paper sizing — different intentId to avoid canonical identity conflict
    const synthetic: TradeIntent = {
      intentId: `oms-${intent.intentId}-${counter}`,
      exchange: intent.exchange,
      symbol: intent.symbol,
      direction: intent.direction,
      orderType: intent.orderType,
      positionUsd: approvedNotionalUsd,
      source: intent.source,
      createdAt: intent.createdAt,
      reason: `oms-${intent.reason ?? ''}`,
      biasUpdatedAt: intent.biasUpdatedAt,
    };
    try {
      const result: PaperBrokerResult = await this.broker.execute(synthetic, simCfg, counter);
      return {
        status: result.status,
        fillId: result.fill.fillId,
        executedPriceUsd: result.fill.priceUsd,
        quantity: result.fill.quantity,
        feeUsd: result.fill.feeUsd,
        snapshot: result.snapshot,
      };
    } catch (err: any) {
      return { status: 'failed', snapshot: this.broker.snapshot(), error: err?.message ?? String(err) };
    }
  }

  /** Execute a risk-admitted intent with dynamic simulation parameters. */
  async execute(intent: TradeIntent, params: ExecuteParams): Promise<PaperExecutionEvent> {
    const counter = ++this.counter;
    const simCfg: FillSimulatorConfig = {
      markPriceUsd: params.markPriceUsd,
      feeBps: params.feeBps,
      slippageBps: params.slippageBps,
      executedAtMs: params.executedAtMs,
      fillIdPrefix: params.fillIdPrefix,
    };
    try {
      const result: PaperBrokerResult = await this.broker.execute(intent, simCfg, counter);
      return {
        status: result.status,
        fillId: result.fill.fillId,
        executedPriceUsd: result.fill.priceUsd,
        quantity: result.fill.quantity,
        feeUsd: result.fill.feeUsd,
        snapshot: result.snapshot,
      };
    } catch (err: any) {
      return { status: 'failed', snapshot: this.broker.snapshot(), error: err?.message ?? String(err) };
    }
  }
}
