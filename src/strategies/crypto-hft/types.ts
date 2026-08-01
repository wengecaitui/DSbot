/**
 * Crypto HFT — Types for 15-minute Polymarket crypto market trading
 *
 * Ported from firstorder.rs with all real thresholds and execution patterns.
 */

// ── Order Execution ─────────────────────────────────────────────────────────

/** How to execute an entry or exit order */
export type OrderMode =
  | 'maker'        // GTC postOnly — 0% fee, rejected if would cross
  | 'taker'        // GTC — crosses spread, pays taker fee
  | 'fok'          // Fill-or-Kill — immediate full fill or cancel
  | 'maker_then_taker';  // Try maker first, escalate to taker on timeout

export interface OrderExecution {
  mode: OrderMode;
  /** Maker timeout before escalating to taker (ms). Only for maker_then_taker. */
  makerTimeoutMs: number;
  /** Price buffer for taker orders: +/- this many cents (default 0.01) */
  takerBufferCents: number;
  /** For maker exits: buffer below ask to post in spread */
  makerExitBufferCents: number;
}

// ── Taker Fee (Polymarket formula) ──────────────────────────────────────────

/** fee_per_share = 0.125 * (price * (1 - price))^2 */
export function takerFee(price: number): number {
  return 0.125 * Math.pow(price * (1 - price), 2);
}

export function takerFeePct(price: number): number {
  if (price === 0) return 0;
  return (takerFee(price) / price) * 100;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface CryptoHftConfig {
  /** Assets to trade */
  assets: string[];

  // ── Sizing ──
  sizeUsd: number;
  /** Min shares to survive taker fee round-trip */
  minShares: number;
  maxShares: number;
  maxPositionUsd: number;
  maxPositions: number;

  // ── Round timing ──
  roundDurationSec: number;
  /** Don't enter if fewer than this many seconds left */
  minTimeLeftSec: number;
  /** Don't enter in the first N seconds (spreads unstable) */
  minRoundAgeSec: number;
  /** Force exit at this many seconds before expiry */
  forceExitSec: number;
  /** Warmup: don't trade for N seconds after engine start */
  warmupSec: number;

  // ── Entry execution ──
  entryOrder: OrderExecution;
  /** Max orderbook staleness before skipping entry (ms) */
  maxOrderbookStaleMs: number;

  // ── Exit execution ──
  exitOrder: OrderExecution;
  /** Use maker exits only for TP and TIME exits (not SL — speed matters) */
  makerExitsForTpOnly: boolean;
  /** Cooldown between sell attempts (ms) */
  sellCooldownMs: number;
  /** Share buffer subtracted from exit size for rounding (e.g. 0.02) */
  exitShareBuffer: number;

  // ── Take Profit / Stop Loss ──
  takeProfitPct: number;
  stopLossPct: number;

  // ── Price-Level Adaptive Initial Stop (AdaptiveTrend-Inspired, arXiv 2602.11708) ──
  // Paper-inspired, project-specific binary-market heuristic. NOT an exact
  // reproduction of AdaptiveTrend's dynamic trailing stop. Entry-price
  // distance from 0.50 is a project-specific uncertainty proxy, NOT measured
  // ATR and NOT verified realized volatility.
  adaptiveStoplossEnabled: boolean;
  /** Base stop loss % before uncertainty adjustment (default = stopLossPct) */
  adaptiveSlBasePct: number;
  /** k when entry near 0.50 (ATM zone, |dist| <= 0.15) */
  adaptiveSlHighK: number;
  /** k for MID zone (0.15 < |dist| <= 0.25) — nominal baseline */
  adaptiveSlNormalK: number;
  /** k when entry near edges (EDGE zone, |dist| > 0.25) */
  adaptiveSlLowK: number;
  /** Cap on effective stop as multiple of base (default 1.5) */
  adaptiveSlMaxMultiplier: number;

  // ── Ratchet floor (progressive giveback from confirmed high) ──
  ratchetEnabled: boolean;
  /** Number of consecutive ticks near high to confirm HWM */
  ratchetConfirmTicks: number;
  /** Tolerance % for HWM confirmation (within this % of high = "near") */
  ratchetConfirmTolerancePct: number;

  // ── Trailing stop ──
  trailingEnabled: boolean;

  // ── Time-aware trailing (tightens as expiry approaches) ──
  trailingLatePct: number;    // <3 min left
  trailingMidPct: number;     // 3-7 min left
  trailingWidePct: number;    // >7 min left

  // ── Advanced exits ──
  /** Exit if up >= this % and bid unchanged for staleSeconds */
  staleProfitPct: number;
  staleProfitBidUnchangedSec: number;
  /** Exit if at +N% for M seconds without progress */
  stagnantProfitPct: number;
  stagnantDurationSec: number;
  /** Exit on depth collapse: depth dropped this % while price dropping */
  depthCollapseThresholdPct: number;

  // ── Risk ──
  maxDailyLossUsd: number;
  /** Cooldown after stop loss hit (seconds) */
  stopLossCooldownSec: number;
  /** Cooldown after any exit before re-entering same coin+direction (seconds) */
  exitCooldownSec: number;
  negRisk: boolean;
  dryRun: boolean;

  // ── Realized Cost-Drag Circuit Breaker (arXiv 2607.19453-inspired) ──
  // Inspired by the paper's finding that predictive accuracy does not
  // guarantee tradable profitability. Project-specific FEES_ONLY cost model:
  // only entry + exit fees are counted — NOT spread, slippage, market
  // impact, or funding (data not available in this strategy layer).
  costHurdleGateEnabled: boolean;
  /** Block new entries when fee/gross ratio strictly exceeds this (0.5 = 50%) */
  costHurdleMaxCostRatio: number;
  /** Rolling window for cost ratio calculation (completed trades) */
  costHurdleWindowTrades: number;
  /** Min completed trades before the breaker may activate (warming-up gate) */
  costHurdleMinCompletedTrades: number;
  /** Cooldown (seconds) before a single probe entry is allowed after a block */
  costHurdleBlockCooldownSec: number;
  /** Max successful entries per rolling 60-min window (0 = disabled) */
  costHurdleMaxTradesPerHour: number;

  // ── Regime Gate (SUSA-Inspired, arXiv 2607.22491) ──
  /** Enable 4-state deterministic regime heuristic: blocks entries in persistent_stress/UNKNOWN */
  regimeGateEnabled: boolean;
}

// ── Orderbook ───────────────────────────────────────────────────────────────

export interface OrderbookSnapshot {
  tokenId: string;
  bids: Array<[number, number]>; // [price, size]
  asks: Array<[number, number]>;
  bidDepth: number;
  askDepth: number;
  obi: number;               // (bidDepth - askDepth) / (bidDepth + askDepth)
  spread: number;             // bestAsk - bestBid
  spreadPct: number;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  timestamp: number;
}

export type ObiCategory = 'bid_heavy' | 'bid_lean' | 'balanced' | 'ask_lean' | 'ask_heavy';

export function categorizeObi(obi: number): ObiCategory {
  if (obi > 0.3) return 'bid_heavy';
  if (obi > 0) return 'bid_lean';
  if (obi > -0.3) return 'balanced';
  if (obi > -0.6) return 'ask_lean';
  return 'ask_heavy';
}

// ── Market ──────────────────────────────────────────────────────────────────

export interface CryptoMarket {
  asset: string;
  conditionId: string;
  questionId: string;
  upTokenId: string;
  downTokenId: string;
  upPrice: number;
  downPrice: number;
  expiresAt: number;
  /** Current round slot (expiresAt / roundDuration) */
  roundSlot: number;
  negRisk: boolean;
  question: string;
}

export interface RoundState {
  slot: number;
  expiresAt: number;
  markets: CryptoMarket[];
  /** Seconds since round started */
  ageSec: number;
  /** Seconds until round expires */
  timeLeftSec: number;
}

// ── Signal ──────────────────────────────────────────────────────────────────

export type SignalDirection = 'up' | 'down';

export interface TradeSignal {
  strategy: string;
  asset: string;
  direction: SignalDirection;
  tokenId: string;
  conditionId: string;
  price: number;
  confidence: number;
  reason: string;
  /** Which order mode this strategy recommends */
  orderMode: OrderMode;
  /** Features that triggered the signal (for logging/analysis) */
  features: Record<string, number>;
  timestamp: number;
}

// ── Position ────────────────────────────────────────────────────────────────

export interface OpenPosition {
  id: string;
  strategy: string;
  asset: string;
  direction: SignalDirection;
  tokenId: string;
  conditionId: string;
  entryPrice: number;
  currentPrice: number;
  shares: number;
  costUsd: number;
  wasMakerEntry: boolean;
  entryFeePct: number;

  // HWM tracking
  highWaterMark: number;
  /** Consecutive ticks near HWM for confirmation */
  hwmConfirmCount: number;
  confirmedHigh: number;

  // Timing
  enteredAt: number;
  expiresAt: number;

  // Bid staleness tracking (for stale profit exit)
  lastBidPrice: number;
  bidUnchangedSince: number;

  // Stagnant tracking
  lastProgressAt: number;
  lastProgressPct: number;

  // Depth tracking
  initialDepth: number;

  // PnL timeline
  highPnlPct: number;
  lowPnlPct: number;
  wasEverPositive: boolean;

  // ── Frozen at entry (adaptive stop, never recomputed per-tick) ──
  /** Effective stop loss % frozen when the position was opened. */
  effectiveStopLossPct: number;
  /** Policy version used at entry (immutable). */
  adaptiveStopPolicyVersion: string;
  /** Entry price used to select the stop zone (immutable). */
  adaptiveStopEntryPrice: number;
  /** Whether the adaptive stop policy was enabled at entry. */
  adaptiveStopEnabledAtEntry: boolean;
}

export type ExitReason =
  | 'take_profit'
  | 'stop_loss'
  | 'ratchet_floor'
  | 'trailing_stop'
  | 'depth_collapse'
  | 'stale_profit'
  | 'stagnant_profit'
  | 'time_exit'
  | 'force_exit'
  | 'manual';

export interface ClosedPosition extends OpenPosition {
  exitPrice: number;
  exitReason: ExitReason;
  exitedAt: number;
  wasMakerExit: boolean;
  exitFeePct: number;
  pnlUsd: number;
  pnlPct: number;
  /** Net PnL after fees */
  netPnlUsd: number;
  netPnlPct: number;
  holdTimeSec: number;
}

// ── Cost-Drag Audit (arXiv 2607.19453-inspired) ────────────────────────────
// Single source of truth for these types lives in src/strategies/shared/
// cost-drag.ts. Re-exported here for backward compatibility so existing
// importers of './types.js' keep working.

import type { CostModelScope, CostHurdleStatus, TradeCostSample } from '../shared/cost-drag.js';
export { COST_MODEL_SCOPE } from '../shared/cost-drag.js';
export type { CostModelScope, CostHurdleStatus, TradeCostSample };

// ── Stats ───────────────────────────────────────────────────────────────────

export interface HftStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  dailyPnlUsd: number;
  openPositions: number;
  bestTradePct: number;
  worstTradePct: number;
  avgHoldTimeSec: number;
  makerEntryRate: number;
  makerExitRate: number;
  exitReasons: Record<string, number>;

  // ── Cost-Drag Audit (arXiv 2607.19453-inspired) ──
  /** Amount-weighted gross return in basis points over the rolling window. */
  grossBps: number;
  /** Amount-weighted net return in basis points over the rolling window. */
  netBps: number;
  /** Amount-weighted fees in basis points (FEES_ONLY scope). */
  costBps: number;
  /** Fee/gross ratio; null when aggregate gross <= 0. */
  costToGrossRatio: number | null;
  /** FEES_ONLY — spread/slippage/impact/funding are NOT modeled. */
  costModelScope: CostModelScope;
  /** Current breaker status (DISABLED/WARMING_UP/NO_POSITIVE_GROSS/OK/BLOCKED/PROBE_IN_FLIGHT). */
  costHurdleStatus: CostHurdleStatus;
  /** Entries successfully opened in the rolling 60-min window. */
  hourlyTradeCount: number;
  /** Basis for hourlyTradeCount: successful OPENED positions, not fills/closes. */
  hourlyTradeCountBasis: 'OPENED_POSITIONS';
}

// ── Presets ──────────────────────────────────────────────────────────────────

export interface StrategyPreset {
  name: string;
  description: string;
  config: Partial<CryptoHftConfig>;
  /** Which strategies to enable */
  strategies: Record<string, boolean>;
  createdAt: number;
}
