/**
 * FastPipeline — 快路径执行器
 *
 * 职责：执行 Execution Pipeline（秒级突击队）
 * - Spread-Scanner 信号触发，调用 providers.fastProvider
 * - 读取 MarketBiasReport + 技术分析 + 账户状态
 * - Risk Team 拦截 → 出决策
 *
 * 目标延迟：< 2 秒
 *
 * Stage 3B4C4: exchange-bound. Config requires exchange. Signal exchange validated
 * at method start. All fail-closed paths return decision='skip' with config.exchange.
 *
 * Stage 3A4: 可选 marketData 注入 —— 在 IndicatorService 之前
 *
 * Stage 3B4C7: risk chain upgraded from `killSwitch.check(symbol, 0)` to
 *   DecisionEngine → PositionSizer → KillSwitch.check(realPositionUsd) → TradeIntent.
 *
 * Stage 4B4.1: deterministic time — Clock/ElapsedClock injection, zero Date.now,
 *   domain time monotonicity guard, future bias report fail-closed, idempotent
 *   createdAt + intentId for identical inputs at same domain time.
 */

import { EventEmitter } from 'events';
import type { ExchangeId } from '../data/MarketIdentity';
import { assertExchangeId, isExchangeId } from '../data/MarketIdentity';
import { IndicatorService } from './IndicatorService';
import type { FastDecisionContext } from './FastDecisionContext';
import { MarketBiasReportFull } from '../types/market-bias';
import { evaluate as decisionEngineEvaluate } from './DecisionEngine';
import type { EngineInput } from './DecisionEngine';
import type { MarketSnapshotStore } from '../data/MarketSnapshot';
import type { CandleSeriesStore } from '../data/CandleSeriesStore';
import type { Series } from '../data/types';
import type { ExecutionQuote } from '../types/execution-quote';
import { computePositionUsd } from './PositionSizer';
import type { TradeIntent } from '../types/trade-intent';
import { createTradeIntent } from '../types/trade-intent';
import { validateTradeCandidate } from './TradeIntentValidation';
import type { DomainClock, ElapsedClock } from '../runtime/Clock';
import { systemDomainClock, systemElapsedClock } from '../runtime/Clock';

export interface FastPipelineMarketData {
  readonly exchange: ExchangeId;
  readonly snapshotStore: MarketSnapshotStore;
  readonly candleStore: CandleSeriesStore;
  interval?: string;
  minimumSeries?: number;
  seriesLimit?: number;
  maxKlineAgeMs?: number;
}

export interface FastPipelineConfig {
  readonly exchange: ExchangeId;
  router: FastDecisionContext;
  indicatorService: IndicatorService;
  model?: string;
  mockLatencyMs?: number;
  marketData?: FastPipelineMarketData;
  /** Stage 4B4.1: injectable domain wall-clock. Defaults to systemDomainClock. */
  clock?: DomainClock;
  /** Stage 4B4.1: injectable monotonic elapsed clock. Defaults to systemElapsedClock. */
  elapsedClock?: ElapsedClock;
}

export interface FastPipelineResult {
  readonly exchange: ExchangeId;
  decision: 'trade' | 'skip' | 'defense';
  direction?: 'long' | 'short' | 'hold';
  symbol?: string;
  positionUsd?: number;
  tradeIntent?: TradeIntent;
  /** Stage 3B4C14: execution quote from same-snapshot ticker (trade only). */
  executionQuote?: ExecutionQuote;
  reason: string;
  elapsedMs: number;
  biasReport: MarketBiasReportFull | null;
}

export class FastPipeline extends EventEmitter {
  private config: FastPipelineConfig;
  /** Stage 4B4.1: resolved domain clock — always defined after construction. */
  private clock: DomainClock;
  /** Stage 4B4.1: resolved elapsed clock — always defined after construction. */
  private elapsedClock: ElapsedClock;
  /** Stage 4B4.1: last accepted domain timestamp for monotonicity guard. */
  private lastAcceptedDomainTime: number = -1;

  constructor(config: FastPipelineConfig) {
    super();

    assertExchangeId('FastPipeline', config.exchange);

    if (config.router.exchange !== config.exchange) {
      throw new Error(
        `FastPipeline: router.exchange (${config.router.exchange}) !== config.exchange (${config.exchange})`,
      );
    }

    if (config.marketData) {
      const md = config.marketData;
      if (!isExchangeId(md.exchange)) {
        throw new Error(`FastPipeline: marketData.exchange must be a valid ExchangeId, got ${JSON.stringify(md.exchange)}`);
      }
      if (md.exchange !== config.exchange) {
        throw new Error(
          `FastPipeline: marketData.exchange (${md.exchange}) !== config.exchange (${config.exchange})`,
        );
      }
      if (!md.interval || typeof md.interval !== 'string') {
        throw new Error('FastPipeline: marketData.interval must be a non-empty string');
      }
      if (md.minimumSeries !== undefined) {
        if (!Number.isInteger(md.minimumSeries) || md.minimumSeries <= 0) {
          throw new Error(`FastPipeline: marketData.minimumSeries must be a positive integer, got ${md.minimumSeries}`);
        }
      }
      if (md.seriesLimit !== undefined) {
        if (!Number.isInteger(md.seriesLimit) || md.seriesLimit <= 0) {
          throw new Error(`FastPipeline: marketData.seriesLimit must be a positive integer, got ${md.seriesLimit}`);
        }
        const min = md.minimumSeries ?? 100;
        if (md.seriesLimit < min) {
          throw new Error(`FastPipeline: marketData.seriesLimit (${md.seriesLimit}) < marketData.minimumSeries (${min})`);
        }
      }
      if (md.maxKlineAgeMs !== undefined) {
        if (typeof md.maxKlineAgeMs !== 'number' || !Number.isFinite(md.maxKlineAgeMs) || md.maxKlineAgeMs <= 0) {
          throw new Error(`FastPipeline: marketData.maxKlineAgeMs must be a finite positive number, got ${md.maxKlineAgeMs}`);
        }
      }
    }
    this.config = {
      model: config.model ?? 'glm-5.2-flash',
      mockLatencyMs: config.mockLatencyMs ?? 50,
      ...config,
    };
    // Stage 4B4.1: resolve clocks to non-optional private fields.
    this.clock = config.clock ?? systemDomainClock;
    this.elapsedClock = config.elapsedClock ?? systemElapsedClock;
  }

  /** Stage 4A1-R1: read-only exchange identity. */
  getExchange(): ExchangeId { return this.config.exchange; }

  /** Stage 4B4.1: validate domain timestamp before any decision work. */
  private assertValidDomainTime(domainNow: number): void {
    if (!Number.isFinite(domainNow)) {
      throw new Error(`FastPipeline: domain time must be finite, got ${domainNow}`);
    }
    if (domainNow < 0) {
      throw new Error(`FastPipeline: domain time must be non-negative, got ${domainNow}`);
    }
    if (!Number.isSafeInteger(domainNow)) {
      throw new Error(`FastPipeline: domain time must be a safe integer, got ${domainNow}`);
    }
  }

  /** Stage 4B4.1: validate elapsed end tick is valid and >= start. */
  private readElapsed(start: number): number {
    const end = this.elapsedClock.now();
    if (!Number.isFinite(end) || end < 0) {
      throw new Error(`FastPipeline: elapsed clock returned invalid end tick: ${end}`);
    }
    if (end < start) {
      throw new Error(`FastPipeline: elapsed clock went backward: end ${end} < start ${start}`);
    }
    return end - start;
  }

  async execute(signal: {
    exchange: ExchangeId;
    source: string;
    symbol: string;
    signalData?: Record<string, unknown>;
  }): Promise<FastPipelineResult> {
    // Stage 4B4.1: read domain clock exactly once.
    const domainTimestamp = this.clock.now();
    this.assertValidDomainTime(domainTimestamp);

    // Stage 4B4.1: monotonicity guard — decreasing domain time rejects.
    // Equal timestamps are accepted (replay, burst, or wall clock stall).
    if (this.lastAcceptedDomainTime >= 0 && domainTimestamp < this.lastAcceptedDomainTime) {
      throw new Error(
        `FastPipeline: domain time decreased from ${this.lastAcceptedDomainTime} to ${domainTimestamp}`,
      );
    }

    // Stage 4B4.1: read elapsed start exactly once after valid domain capture.
    // Validate immediately — do NOT accept domain state before start is valid.
    const elapsedStart = this.elapsedClock.now();
    if (!Number.isFinite(elapsedStart) || elapsedStart < 0) {
      throw new Error(
        `FastPipeline: elapsed start tick invalid: ${elapsedStart}`,
      );
    }

    this.lastAcceptedDomainTime = domainTimestamp;

    if (signal.exchange !== this.config.exchange) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        symbol: signal.symbol,
        reason: `exchange mismatch: signal has ${signal.exchange}, pipeline bound to ${this.config.exchange}`,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport: null,
      };
    }

    const biasReport = this.config.router.getBiasReport();

    if (biasReport && !isExchangeId((biasReport as { exchange?: unknown }).exchange)) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        symbol: signal.symbol,
        reason: 'Invalid report.exchange — fail closed',
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport: null,
      };
    }
    if (biasReport && (biasReport as { exchange: ExchangeId }).exchange !== this.config.exchange) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        symbol: signal.symbol,
        reason: `report.exchange mismatch: got ${(biasReport as { exchange: ExchangeId }).exchange}, expected ${this.config.exchange}`,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport: null,
      };
    }

    if (!biasReport) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        reason: 'No MarketBiasReport available — wait for SlowPath to complete',
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport: null,
      };
    }

    // Stage 4B4.1: future bias report — fail-closed defense.
    // A report with updatedAt later than domain time means the report claims
    // to come from the future (clock skew, test injection, or corrupted data).
    if (biasReport.updatedAt > domainTimestamp) {
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        symbol: signal.symbol,
        reason: `MarketBiasReport updatedAt (${biasReport.updatedAt}) is in the future relative to domain time (${domainTimestamp}) — fail closed`,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport,
      };
    }

    // Stage 4B4.1: use the captured domain timestamp for staleness, not Date.now.
    const reportAgeMs = domainTimestamp - biasReport.updatedAt;
    const maxAgeMs = this.config.router.getConfig().maxBiasReportAgeHours * 60 * 60 * 1000;
    if (reportAgeMs > maxAgeMs) {
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        symbol: signal.symbol,
        reason: `Stale MarketBiasReport: ${Math.round(reportAgeMs / 3600000)}h > ${this.config.router.getConfig().maxBiasReportAgeHours}h — KillSwitch activated`,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport,
      };
    }

    if (!biasReport.whitelist.includes(signal.symbol)) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        symbol: signal.symbol,
        reason: `${signal.symbol} not in MarketBiasReport whitelist`,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport,
      };
    }

    // Stage 3B4C7-R1: explicit lock check BEFORE market data & indicator work.
    // Uses getLockState() — a read-only query that does NOT involve positionUsd.
    const killSwitch = this.config.router.killSwitch;
    if (killSwitch) {
      const lockState = killSwitch.getLockState(this.config.exchange);
      if (lockState.locked) {
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          symbol: signal.symbol,
          reason: lockState.reason ?? 'KillSwitch locked',
          elapsedMs: this.readElapsed(elapsedStart),
          biasReport,
        };
      }
    }

    // Step 4: 市场数据守卫 + OHLCV 序列注入
    const md = this.config.marketData;
    let series: Series[] | null = null;

    if (md) {
      const interval = md.interval ?? '1m';
      const minimumSeries = md.minimumSeries ?? 100;
      const seriesLimit = md.seriesLimit ?? 200;
      const maxKlineAgeMs = md.maxKlineAgeMs ?? 120_000;
      const exchange = md.exchange;
      const symKey = `${exchange}:${signal.symbol}`;

      const snapshot = md.snapshotStore.getSnapshot(exchange, signal.symbol);
      if (!snapshot) {
        return {
          exchange: this.config.exchange,
          decision: 'skip',
          symbol: signal.symbol,
          reason: `[MD] no snapshot for ${symKey} — wait for market data`,
          elapsedMs: this.readElapsed(elapsedStart),
          biasReport,
        };
      }

      // ─── Stage 3B4C14: capture execution quote from same snapshot ───
      const tickerWrapper = snapshot.ticker;
      let executionQuote: ExecutionQuote | undefined;
      if (tickerWrapper && typeof tickerWrapper.ticker.last === 'number' && Number.isFinite(tickerWrapper.ticker.last) && tickerWrapper.ticker.last > 0 &&
          typeof tickerWrapper.ticker.ts === 'number' && Number.isFinite(tickerWrapper.ticker.ts) && tickerWrapper.ticker.ts >= 0) {
        executionQuote = {
          exchange: snapshot.exchange,
          symbol: snapshot.symbol,
          markPriceUsd: tickerWrapper.ticker.last,
          executedAtMs: tickerWrapper.ticker.ts,
          snapshotVersion: snapshot.snapshotVersion,
        };
      }

      if (snapshot.isStale) {
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          symbol: signal.symbol,
          reason: `[MD] snapshot stale (${snapshot.ageMs}ms) for ${symKey}`,
          elapsedMs: this.readElapsed(elapsedStart),
          biasReport,
        };
      }

      const targetKline = snapshot.klines[interval];
      if (!targetKline) {
        return {
          exchange: this.config.exchange,
          decision: 'skip',
          symbol: signal.symbol,
          reason: `[MD] snapshot missing ${interval} kline for ${symKey}`,
          elapsedMs: this.readElapsed(elapsedStart),
          biasReport,
        };
      }

      const klineAgeMs = snapshot.generatedAt - targetKline.receivedAt;
      if (klineAgeMs > maxKlineAgeMs) {
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          symbol: signal.symbol,
          reason: `[MD] ${interval} kline stale (${klineAgeMs}ms > ${maxKlineAgeMs}ms) for ${symKey}`,
          elapsedMs: this.readElapsed(elapsedStart),
          biasReport,
        };
      }

      if (!md.candleStore.hasMinimumSeries(exchange, signal.symbol, interval, minimumSeries)) {
        const available = md.candleStore.getSeries(exchange, signal.symbol, interval, seriesLimit).length;
        return {
          exchange: this.config.exchange,
          decision: 'skip',
          symbol: signal.symbol,
          reason: `[MD] insufficient candle history for ${symKey} ${interval}: ${available}/${minimumSeries}`,
          elapsedMs: this.readElapsed(elapsedStart),
          biasReport,
        };
      }

      const pulled = md.candleStore.getSeries(exchange, signal.symbol, interval, seriesLimit);
      series = pulled;

      const lastTs = pulled[pulled.length - 1]?.ts;
      if (typeof lastTs !== 'number' || lastTs !== targetKline.kline.ts) {
        return {
          exchange: this.config.exchange,
          decision: 'skip',
          symbol: signal.symbol,
          reason: `[MD] snapshot/candle desync for ${symKey} ${interval}: snapshotTs=${targetKline.kline.ts} candleTs=${lastTs ?? 'none'}`,
          elapsedMs: this.readElapsed(elapsedStart),
          biasReport,
        };
      }

      const indicatorResults = await this.config.indicatorService.calculateAll({
        asset: signal.symbol,
        series,
      });

      return this.decide(signal, biasReport, indicatorResults, elapsedStart, domainTimestamp, executionQuote);
    }

    const indicatorResults = await this.config.indicatorService.calculateAll({
      asset: signal.symbol,
    });

    return this.decide(signal, biasReport, indicatorResults, elapsedStart, domainTimestamp, undefined);
  }

  /**
   * Decision Engine + position sizing + risk admission chain.
   *
   * Stage 3B4C7-R1: unified rejection helper, runtime direction validation,
   * bias.direction === deResult.direction gate, PositionSizer symbol+direction.
   * Stage 3B4C14: executionQuote attached to trade results only.
   * Stage 4B4.1: uses elapsedStart (not domain time) for elapsedMs;
   * domainTimestamp passed through for createdAt.
   */
  private decide(
    signal: { exchange: ExchangeId; source: string; symbol: string; signalData?: Record<string, unknown> },
    biasReport: MarketBiasReportFull,
    indicatorResults: import('../types/indicators').IndicatorResult[],
    elapsedStart: number,
    domainTimestamp: number,
    executionQuote?: ExecutionQuote,
  ): FastPipelineResult {
    const bias = biasReport.assets.find(a => a.symbol === signal.symbol);

    const deInput: EngineInput = {
      symbol: signal.symbol,
      indicators: indicatorResults,
      bias: bias ? { direction: bias.direction, confidence: bias.confidence } : null,
    };
    const deResult = decisionEngineEvaluate(deInput);

    this.emit('decision_made', {
      exchange: this.config.exchange,
      symbol: signal.symbol,
      bias: bias?.direction ?? 'hold',
      decision: deResult.decision,
      elapsedMs: this.readElapsed(elapsedStart),
    });

    // Not a trade decision — return immediately, no position, no TradeIntent.
    if (deResult.decision !== 'trade') {
      return {
        exchange: this.config.exchange,
        decision: deResult.decision,
        direction: deResult.direction,
        symbol: signal.symbol,
        reason: deResult.reason,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport,
      };
    }

    // ─── Stage 3B4C7-R1: unified rejection helper ───
    const emitRejected = (
      stage: 'direction_validation' | 'bias_validation' | 'position_sizing' | 'risk_admission' | 'intent_creation',
      reason: string,
      requestedPositionUsd?: number,
    ) => {
      this.emit('trade_intent_rejected', {
        exchange: this.config.exchange,
        symbol: signal.symbol,
        stage,
        reason,
        ...(requestedPositionUsd !== undefined ? { requestedPositionUsd } : {}),
      });
    };

    // ─── Stage 3B4C7-R2: candidate validation via pure function ───
    const candidate = validateTradeCandidate({
      engineDecision: deResult.decision,
      engineDirection: deResult.direction,
      biasDirection: bias?.direction,
      symbol: signal.symbol,
    });
    if (!candidate.ok) {
      emitRejected(candidate.stage, candidate.reason);
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        direction: 'hold',
        symbol: signal.symbol,
        reason: candidate.reason,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport,
      };
    }
    const dir: 'long' | 'short' = candidate.direction;
    // validateTradeCandidate guarantees bias exists and direction matches
    const asset = bias!;

    // Validate suggestedPositionPct
    const suggestedPct = asset.suggestedPositionPct;
    if (typeof suggestedPct !== 'number' || !Number.isFinite(suggestedPct) || suggestedPct <= 0 || suggestedPct > 1) {
      const reason = `[SIZER] ${signal.symbol}: invalid suggestedPositionPct=${suggestedPct}`;
      emitRejected('position_sizing', reason);
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        direction: 'hold',
        symbol: signal.symbol,
        reason,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport,
      };
    }

    // ─── Position sizing ───
    let requestedPositionUsd: number;
    try {
      const ksConfig = this.config.router.killSwitch?.getConfig() ?? { totalCapitalUsd: 0 };
      requestedPositionUsd = computePositionUsd({
        totalCapitalUsd: ksConfig.totalCapitalUsd,
        suggestedPositionPct: suggestedPct,
        symbol: signal.symbol,
        direction: dir,
      });
    } catch (err) {
      const reason = `[SIZER] ${signal.symbol}: position sizing error: ${err}`;
      emitRejected('position_sizing', reason);
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        direction: 'hold',
        symbol: signal.symbol,
        reason,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport,
      };
    }

    // ─── Risk admission ───
    const killSwitch = this.config.router.killSwitch;
    if (killSwitch) {
      const riskCheck = killSwitch.check(this.config.exchange, signal.symbol, requestedPositionUsd);
      if (!riskCheck.allowed) {
        const reason = `[RISK] ${riskCheck.reason ?? `${signal.symbol} rejected at $${requestedPositionUsd.toFixed(0)}`}`;
        emitRejected('risk_admission', riskCheck.reason ?? reason, requestedPositionUsd);
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          direction: 'hold',
          symbol: signal.symbol,
          reason,
          elapsedMs: this.readElapsed(elapsedStart),
          biasReport,
        };
      }
    }

    // ─── Intent creation ───
    let tradeIntent: TradeIntent;
    try {
      tradeIntent = createTradeIntent({
        exchange: this.config.exchange,
        symbol: signal.symbol,
        direction: dir,
        positionUsd: requestedPositionUsd,
        source: signal.source,
        reason: deResult.reason,
        biasUpdatedAt: biasReport.updatedAt,
        // Stage 4B4.1: explicit domain timestamp for deterministic createdAt.
        createdAt: domainTimestamp,
      });
    } catch (err) {
      const reason = `[INTENT] ${signal.symbol}: createTradeIntent error: ${err}`;
      emitRejected('intent_creation', reason, requestedPositionUsd);
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        direction: 'hold',
        symbol: signal.symbol,
        reason,
        elapsedMs: this.readElapsed(elapsedStart),
        biasReport,
      };
    }

    this.emit('trade_intent_created', {
      exchange: this.config.exchange,
      symbol: signal.symbol,
      tradeIntent,
    });

    return {
      exchange: this.config.exchange,
      decision: 'trade',
      direction: dir,
      symbol: signal.symbol,
      positionUsd: requestedPositionUsd,
      tradeIntent,
      executionQuote,
      reason: deResult.reason,
      elapsedMs: this.readElapsed(elapsedStart),
      biasReport,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
