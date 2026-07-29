/**
 * ShadowDecisionOutcome — validated immutable decision outcome.
 *
 * Factory creates deep-frozen, factory-branded immutable ShadowDecisionOutcome
 * from FastPipelineResult-like input. The private brand is not caller-supplied.
 */
import type { TradeIntent } from '../types/trade-intent';
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';

// ─── Types ───────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 'cloddsbot.shadow.outcome.v1' as const;

export type ShadowDecision = 'trade' | 'defense' | 'skip';
export type ShadowDirection = 'long' | 'short' | 'hold';

export type RiskAdmission =
  | { readonly status: 'admitted' }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'not_applicable' };

export interface ShadowDecisionOutcome {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly decision: ShadowDecision;
  readonly direction: ShadowDirection;
  readonly reason: string;
  readonly blockedReason: string | null;
  readonly intentId: string | null;
  readonly riskAdmission: RiskAdmission;
}

/** Narrow structural input matching FastPipelineResult fields needed. */
export interface ShadowDecisionResultInput {
  exchange: ExchangeId;
  decision: 'trade' | 'skip' | 'defense';
  direction?: 'long' | 'short' | 'hold';
  symbol?: string;
  positionUsd?: number;
  tradeIntent?: TradeIntent;
  reason: string;
}

// ─── Private brand ────────────────────────────────────────────────────────────

const BRAND = Symbol('ShadowDecisionOutcome');

/**
 * Mark obj with a secure private brand: own, non-enumerable,
 * non-writable, non-configurable data property with value true.
 * Prevents prototype-inherited or forged brand detection.
 */
function brand<T extends object>(obj: T): T {
  Object.defineProperty(obj, BRAND, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return obj;
}

/**
 * Check the brand using Object.getOwnPropertyDescriptor on the
 * object itself, requiring the exact descriptor value true.
 * Never uses `BRAND in obj` — prototype-inherited brands are rejected.
 */
function hasBrand(obj: unknown): obj is ShadowDecisionOutcome {
  if (obj === null || typeof obj !== 'object') return false;
  const desc = Object.getOwnPropertyDescriptor(obj, BRAND);
  return desc !== undefined
    && desc.value === true
    && desc.writable === false
    && desc.enumerable === false
    && desc.configurable === false
    && desc.get === undefined
    && desc.set === undefined;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Known valid decision values. */
const VALID_DECISIONS: ReadonlySet<string> = new Set(['trade', 'defense', 'skip']);

export function createShadowDecisionOutcome(
  result: ShadowDecisionResultInput,
  signalExchange: ExchangeId,
  signalSymbol: string,
): ShadowDecisionOutcome {
  // Validate signal exchange via runtime type guard
  if (!isExchangeId(signalExchange)) {
    throw new Error(
      `ShadowDecisionOutcome: invalid signalExchange: ${JSON.stringify(signalExchange)}`,
    );
  }

  // Validate signal symbol
  if (typeof signalSymbol !== 'string' || signalSymbol.length === 0) {
    throw new Error('ShadowDecisionOutcome: signalSymbol must be non-empty string');
  }

  // Validate exchange match
  if (result.exchange !== signalExchange) {
    throw new Error(
      `ShadowDecisionOutcome: result exchange "${result.exchange}" !== signalExchange "${signalExchange}"`,
    );
  }

  // Validate symbol match if result has symbol
  if (result.symbol !== undefined && result.symbol !== signalSymbol) {
    throw new Error(
      `ShadowDecisionOutcome: result symbol "${result.symbol}" !== signalSymbol "${signalSymbol}"`,
    );
  }

  const symbol = result.symbol ?? signalSymbol;

  // Validate reason — must be non-empty after trim
  const reason = result.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('ShadowDecisionOutcome: reason must be non-empty string');
  }

  // Explicitly reject unknown decision values
  if (!VALID_DECISIONS.has(result.decision)) {
    throw new Error(
      `ShadowDecisionOutcome: unknown decision "${result.decision}"`,
    );
  }

  const decision: ShadowDecision = result.decision;

  let direction: ShadowDirection;
  let blockedReason: string | null;
  let riskAdmission: RiskAdmission;
  let intentId: string | null;

  if (decision === 'trade') {
    // Trade: direction must be long or short
    if (result.direction !== 'long' && result.direction !== 'short') {
      throw new Error(
        `ShadowDecisionOutcome: trade requires direction long/short, got ${result.direction}`,
      );
    }
    direction = result.direction;

    // Trade requires TradeIntent
    const tradeIntent = result.tradeIntent;
    if (!tradeIntent) {
      throw new Error('ShadowDecisionOutcome: trade requires tradeIntent');
    }

    // Validate tradeIntent.intentId is non-empty
    if (typeof tradeIntent.intentId !== 'string' || tradeIntent.intentId.length === 0) {
      throw new Error(
        `ShadowDecisionOutcome: tradeIntent.intentId must be non-empty string, got ${JSON.stringify(tradeIntent.intentId)}`,
      );
    }

    // Cross-check intent fields
    if (tradeIntent.exchange !== signalExchange) {
      throw new Error(
        `ShadowDecisionOutcome: tradeIntent exchange "${tradeIntent.exchange}" !== signalExchange "${signalExchange}"`,
      );
    }
    if (tradeIntent.symbol !== symbol) {
      throw new Error(
        `ShadowDecisionOutcome: tradeIntent symbol "${tradeIntent.symbol}" !== "${symbol}"`,
      );
    }
    if (tradeIntent.direction !== direction) {
      throw new Error(
        `ShadowDecisionOutcome: tradeIntent direction "${tradeIntent.direction}" !== "${direction}"`,
      );
    }

    // positionUsd checks
    const positionUsd = result.positionUsd;
    if (typeof positionUsd !== 'number' || !Number.isFinite(positionUsd) || positionUsd <= 0) {
      throw new Error(
        `ShadowDecisionOutcome: trade requires positive finite positionUsd, got ${positionUsd}`,
      );
    }
    if (positionUsd !== tradeIntent.positionUsd) {
      throw new Error(
        `ShadowDecisionOutcome: positionUsd ${positionUsd} !== tradeIntent.positionUsd ${tradeIntent.positionUsd}`,
      );
    }

    blockedReason = null;
    intentId = tradeIntent.intentId;
    riskAdmission = { status: 'admitted' };
  } else if (decision === 'defense') {
    // Defense: no TradeIntent
    if (result.tradeIntent) {
      throw new Error('ShadowDecisionOutcome: defense forbids TradeIntent');
    }
    direction = 'hold';
    blockedReason = reason.trim();
    intentId = null;
    riskAdmission = { status: 'blocked', reason: reason.trim() };
  } else {
    // Skip (explicitly reachable only for 'skip' — unknown decisions rejected above)
    if (result.tradeIntent) {
      throw new Error('ShadowDecisionOutcome: skip forbids TradeIntent');
    }
    direction = 'hold';
    blockedReason = null;
    intentId = null;
    riskAdmission = { status: 'not_applicable' };
  }

  const outcome: ShadowDecisionOutcome = {
    schemaVersion: SCHEMA_VERSION,
    exchange: signalExchange,
    symbol,
    decision,
    direction,
    reason: reason.trim(),
    blockedReason,
    intentId,
    riskAdmission,
  };

  // Brand and deep-freeze
  brand(outcome);
  Object.freeze(outcome);
  Object.freeze(riskAdmission);

  return outcome;
}

// ─── Type guard / verifier ───────────────────────────────────────────────────

export function isShadowDecisionOutcome(value: unknown): value is ShadowDecisionOutcome {
  if (!hasBrand(value)) return false;

  const o = value as unknown as Record<string, unknown>;

  if (o.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof o.exchange !== 'string' || !o.exchange) return false;
  if (typeof o.symbol !== 'string' || !o.symbol) return false;
  if (o.decision !== 'trade' && o.decision !== 'defense' && o.decision !== 'skip') return false;
  if (o.direction !== 'long' && o.direction !== 'short' && o.direction !== 'hold') return false;
  if (typeof o.reason !== 'string' || !o.reason) return false;
  if (o.blockedReason !== null && typeof o.blockedReason !== 'string') return false;
  if (o.intentId !== null && typeof o.intentId !== 'string') return false;

  const ra = o.riskAdmission as RiskAdmission | undefined;
  if (!ra || typeof ra !== 'object') return false;
  if (ra.status === 'admitted') {
    // OK
  } else if (ra.status === 'blocked') {
    if (typeof ra.reason !== 'string') return false;
  } else if (ra.status === 'not_applicable') {
    // OK
  } else {
    return false;
  }

  // Semantic consistency
  if (o.decision === 'trade') {
    if (o.direction !== 'long' && o.direction !== 'short') return false;
    if (o.intentId === null) return false;
    if (ra.status !== 'admitted') return false;
    if (o.blockedReason !== null) return false;
  } else if (o.decision === 'defense') {
    if (o.direction !== 'hold') return false;
    if (o.intentId !== null) return false;
    if (typeof o.blockedReason !== 'string' || !o.blockedReason) return false;
    if (ra.status !== 'blocked') return false;
  } else {
    // skip
    if (o.direction !== 'hold') return false;
    if (o.intentId !== null) return false;
    if (o.blockedReason !== null) return false;
    if (ra.status !== 'not_applicable') return false;
  }

  if (!Object.isFrozen(value)) return false;

  return true;
}
