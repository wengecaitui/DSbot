/**
 * REFERENCE TEST FIXTURE ONLY
 * NOT APPROVED FOR PAPER TESTNET OR LIVE
 */
export const SHADOW_FIXTURE_LABEL = "REFERENCE TEST FIXTURE ONLY" as const;
export const SHADOW_FIXTURE_DISCLAIMER = "NOT APPROVED FOR PAPER TESTNET OR LIVE" as const;

import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { TradeIntent } from '../../src/types/trade-intent';

// ─── Constants ────────────────────────────────────────────────────────────────

export const REF_EXCHANGE: ExchangeId = 'bitget' as ExchangeId;
export const REF_SYMBOL = 'BTCUSDT';
export const REF_SOURCE = 'spread-scanner';
export const REF_REASON = 'Strong bullish momentum + OB confluence';
export const REF_EVENT_TIME_MS = 1_000_000_000_000;
export const REF_SOURCE_SEQUENCE = 0;

// ─── Minimal valid TradeIntent for trade outcome tests ───────────────────────

export function makeRefTradeIntent(overrides?: Partial<TradeIntent>): TradeIntent {
  return {
    intentId: 'ti-ref-0123456789abcdef0123456789ab',
    exchange: REF_EXCHANGE,
    symbol: REF_SYMBOL,
    direction: 'long',
    orderType: 'market',
    positionUsd: 1500,
    source: REF_SOURCE,
    createdAt: REF_EVENT_TIME_MS,
    reason: REF_REASON,
    biasUpdatedAt: REF_EVENT_TIME_MS - 1000,
    ...overrides,
  };
}

// ─── Production transition chain (real FSM, no bypass) ───────────────────────

import { ShadowRuntimeStateMachine } from '../../src/shadow/ShadowRuntimeStateMachine';

export function bootstrapShadowActive(): ShadowRuntimeStateMachine {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('ACTIVATE');
  return sm;
}
