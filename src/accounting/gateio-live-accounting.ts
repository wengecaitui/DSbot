// Phase G8H1: Gate.io Live accounting read-model — pure derivation from existing factual sources.
//
// Pure and deterministic: no clock, no filesystem, no network, no credentials, no global state.
// Identical inputs produce an identical (deeply frozen) output, and the inputs are never mutated.
//
// Fail-closed rules (never fuzzy): unknown order in the lineage, a fill without resolvable order lineage,
// conflicting duplicate order ids, a fill side that contradicts its order side, or an impossible
// open/close side relationship all throw instead of producing a partial snapshot.
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { GateIoCanonicalInstrumentFacts } from '../runtime/gateio/GateIoAuthenticatedReadFoundation';
import { addQuantity, multiplyQuantity, subtractQuantity } from '../types/decimal-quantity';
import type { AccountingCompleteness, GateIoLiveAccountingInput, GateIoLiveAccountingSnapshot,
  GateIoLiveAction, GateIoLiveFillFact, GateIoLiveFeeAttribution, GateIoLiveOrderLineage,
  GateIoLivePositionFact, GateIoLiveTradeFact } from './gateio-live-accounting-types';
import { GATEIO_LIVE_ACCOUNTING_AUTONOMOUS_RISK_BLOCKERS } from './gateio-live-accounting-types';

const ACTIONS: readonly GateIoLiveAction[] = ['open', 'close', 'reduce', 'emergency_exit'];
const INSTRUMENT_CONTRACT = 'ETH_USDT';

function fail(code: string): never {
  throw new Error(code);
}

function assertFinite(value: number, code: string): number {
  if (!Number.isFinite(value)) fail(code);
  return value;
}

function sumExact(values: readonly number[]): number {
  return values.reduce((total, value) => addQuantity(total, value), 0);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

/** Only a finite, contract-matching multiplier makes a base quantity derivable; otherwise it stays null. */
function usableMultiplier(facts: GateIoCanonicalInstrumentFacts | null | undefined): number | null {
  if (!facts || typeof facts !== 'object') return null;
  if (facts.contract !== INSTRUMENT_CONTRACT) return null;
  if (typeof facts.contractMultiplier !== 'number' || !Number.isFinite(facts.contractMultiplier)
      || facts.contractMultiplier <= 0) return null;
  return facts.contractMultiplier;
}

interface OrderDraft {
  orderId: string; intentId: string | null; action: GateIoLiveAction; side: 'buy' | 'sell';
  approvedNotionalUsd: number | null; submitted: boolean; rejected: boolean; rejectionReason: string | null;
  submissionUnknown: boolean; prepared: boolean; reduceOnly: boolean | null; venueQuantity: number | null;
  requestedQuantity: number | null; exchangeOrderId: string | null; fillIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rebuilds exact order lineage from kernel events. Only orderId identity is used — never proximity. */
function buildLineage(events: readonly KernelEventEnvelope[]):
  { orders: OrderDraft[]; fills: GateIoLiveFillFact[]; actionByOrderId: Map<string, GateIoLiveAction> } {
  const orders = new Map<string, OrderDraft>();
  const orderSide = new Map<string, 'buy' | 'sell'>();
  const fills: GateIoLiveFillFact[] = [];

  const requireOrder = (orderId: unknown): OrderDraft => {
    if (typeof orderId !== 'string' || orderId.length === 0) fail('GATEIO_LIVE_ACCOUNTING_ORDER_ID_INVALID');
    const draft = orders.get(orderId);
    if (!draft) fail('GATEIO_LIVE_ACCOUNTING_UNKNOWN_ORDER_IN_LINEAGE');
    return draft;
  };

  for (const envelope of events) {
    const payload = envelope.payload as unknown;
    if (envelope.type === 'order.created') {
      const order = isRecord(payload) ? payload.order : undefined;
      if (!isRecord(order)) fail('GATEIO_LIVE_ACCOUNTING_ORDER_PAYLOAD_INVALID');
      const orderId = order.orderId;
      const action = order.action as GateIoLiveAction;
      const side = order.side as 'buy' | 'sell';
      if (typeof orderId !== 'string' || orderId.length === 0) fail('GATEIO_LIVE_ACCOUNTING_ORDER_ID_INVALID');
      if (order.exchange !== 'gateio') fail('GATEIO_LIVE_ACCOUNTING_IDENTITY_MISMATCH');
      if (!ACTIONS.includes(action) || (side !== 'buy' && side !== 'sell')) fail('GATEIO_LIVE_ACCOUNTING_ACTION_INVALID');
      const approved = order.approvedNotionalUsd;
      const approvedNotionalUsd = typeof approved === 'number' ? assertFinite(approved, 'GATEIO_LIVE_ACCOUNTING_NOTIONAL_NON_FINITE') : null;
      const existing = orders.get(orderId);
      if (existing) {
        if (existing.action !== action || existing.side !== side || existing.approvedNotionalUsd !== approvedNotionalUsd)
          fail('GATEIO_LIVE_ACCOUNTING_ORDER_CONFLICT');
        continue;
      }
      orders.set(orderId, { orderId, intentId: typeof order.intentId === 'string' ? order.intentId : null, action, side,
        approvedNotionalUsd, submitted: false, rejected: false, rejectionReason: null, submissionUnknown: false,
        prepared: false, reduceOnly: null, venueQuantity: null, requestedQuantity: null, exchangeOrderId: null, fillIds: [] });
      orderSide.set(orderId, side);
      continue;
    }
    if (envelope.type === 'order.submitted') {
      requireOrder(isRecord(payload) ? payload.orderId : undefined).submitted = true;
      continue;
    }
    if (envelope.type === 'order.rejected') {
      const draft = requireOrder(isRecord(payload) ? payload.orderId : undefined);
      draft.rejected = true;
      const reason = isRecord(payload) ? payload.reason : undefined;
      draft.rejectionReason = typeof reason === 'string' ? reason : null;
      continue;
    }
    if (envelope.type === 'order.submission.unknown') {
      requireOrder(isRecord(payload) ? payload.orderId : undefined).submissionUnknown = true;
      continue;
    }
    if (envelope.type === 'order.execution.prepared') {
      const draft = requireOrder(isRecord(payload) ? payload.orderId : undefined);
      const preparation = isRecord(payload) ? payload.preparation : undefined;
      if (!isRecord(preparation)) fail('GATEIO_LIVE_ACCOUNTING_PREPARATION_INVALID');
      draft.prepared = true;
      draft.reduceOnly = preparation.reduceOnly === true;
      if (typeof preparation.venueQuantity === 'number') draft.venueQuantity = assertFinite(preparation.venueQuantity, 'GATEIO_LIVE_ACCOUNTING_QUANTITY_NON_FINITE');
      if (typeof preparation.requestedQuantity === 'number') draft.requestedQuantity = assertFinite(preparation.requestedQuantity, 'GATEIO_LIVE_ACCOUNTING_QUANTITY_NON_FINITE');
      continue;
    }
    if (envelope.type === 'order.execution.observed') {
      const execution = isRecord(payload) ? payload.execution : undefined;
      if (!isRecord(execution)) fail('GATEIO_LIVE_ACCOUNTING_OBSERVATION_INVALID');
      const draft = requireOrder(execution.orderId);
      if (typeof execution.exchangeOrderId === 'string' && execution.exchangeOrderId.length > 0) {
        if (draft.exchangeOrderId !== null && draft.exchangeOrderId !== execution.exchangeOrderId)
          fail('GATEIO_LIVE_ACCOUNTING_ORDER_CONFLICT');
        draft.exchangeOrderId = execution.exchangeOrderId;
      }
      continue;
    }
    if (envelope.type === 'execution.fill.confirmed') {
      const fill = isRecord(payload) ? payload.fill : undefined;
      if (!isRecord(fill)) fail('GATEIO_LIVE_ACCOUNTING_FILL_INVALID');
      const execution = isRecord(payload) ? payload.execution : undefined;
      const orderId = typeof execution === 'object' && execution !== null && typeof (execution as Record<string, unknown>).orderId === 'string'
        ? (execution as Record<string, unknown>).orderId as string
        : (typeof fill.orderId === 'string' ? fill.orderId : undefined);
      const draft = requireOrder(orderId);
      if (typeof fill.fillId !== 'string' || fill.fillId.length === 0) fail('GATEIO_LIVE_ACCOUNTING_FILL_INVALID');
      if (fill.side !== 'buy' && fill.side !== 'sell') fail('GATEIO_LIVE_ACCOUNTING_FILL_INVALID');
      if (fill.side !== draft.side) fail('GATEIO_LIVE_ACCOUNTING_FILL_SIDE_CONFLICT');
      const quantity = typeof fill.quantity === 'number' ? assertFinite(fill.quantity, 'GATEIO_LIVE_ACCOUNTING_QUANTITY_NON_FINITE') : fail('GATEIO_LIVE_ACCOUNTING_QUANTITY_INVALID');
      const price = typeof fill.price === 'number' ? assertFinite(fill.price, 'GATEIO_LIVE_ACCOUNTING_PRICE_NON_FINITE') : fail('GATEIO_LIVE_ACCOUNTING_PRICE_INVALID');
      const executedAt = typeof fill.executedAt === 'number' && Number.isSafeInteger(fill.executedAt) ? fill.executedAt : fail('GATEIO_LIVE_ACCOUNTING_EXECUTED_AT_INVALID');
      if (draft.fillIds.includes(fill.fillId)) fail('GATEIO_LIVE_ACCOUNTING_FILL_CONFLICT');
      draft.fillIds.push(fill.fillId);
      if (typeof execution === 'object' && execution !== null) {
        const exchangeOrderId = (execution as Record<string, unknown>).exchangeOrderId;
        if (typeof exchangeOrderId === 'string' && exchangeOrderId.length > 0) {
          if (draft.exchangeOrderId !== null && draft.exchangeOrderId !== exchangeOrderId) fail('GATEIO_LIVE_ACCOUNTING_ORDER_CONFLICT');
          draft.exchangeOrderId = exchangeOrderId;
        }
      }
      fills.push({ fillId: fill.fillId, orderId: draft.orderId, intentId: draft.intentId, action: draft.action, side: fill.side,
        quantity, price, executedAt, reduceOnly: draft.reduceOnly, exchangeOrderId: draft.exchangeOrderId });
      continue;
    }
  }

  // Impossible action/side relationship: an OPEN must oppose the side(s) that reduce the same lifecycle.
  const opens = new Set<string>();
  for (const fill of fills) if (fill.action === 'open') opens.add(fill.side);
  for (const fill of fills) {
    if (fill.action !== 'open' && opens.has(fill.side)) fail('GATEIO_LIVE_ACCOUNTING_ACTION_SIDE_CONFLICT');
  }

  const actionByOrderId = new Map<string, GateIoLiveAction>();
  for (const draft of orders.values()) actionByOrderId.set(draft.orderId, draft.action);
  return { orders: [...orders.values()], fills, actionByOrderId };
}

export function computeGateIoLiveAccounting(input: GateIoLiveAccountingInput): GateIoLiveAccountingSnapshot {
  const { capturedAt, accountTruth, instrumentFacts, events } = input;
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) fail('GATEIO_LIVE_ACCOUNTING_CAPTURED_AT_INVALID');
  if (!accountTruth || typeof accountTruth !== 'object') fail('GATEIO_LIVE_ACCOUNTING_TRUTH_REQUIRED');
  if (accountTruth.identity?.exchange !== 'gateio') fail('GATEIO_LIVE_ACCOUNTING_IDENTITY_MISMATCH');
  const accountId = accountTruth.identity.accountId;
  if (typeof accountId !== 'string' || accountId.length === 0) fail('GATEIO_LIVE_ACCOUNTING_IDENTITY_MISMATCH');
  if (!Array.isArray(events)) fail('GATEIO_LIVE_ACCOUNTING_EVENTS_REQUIRED');

  const { orders, fills } = buildLineage(events);
  const multiplier = usableMultiplier(instrumentFacts);

  // ── account facts ─────────────────────────────────────────────────────────
  const accountTotalUsd = assertFinite(accountTruth.account.total, 'GATEIO_LIVE_ACCOUNTING_TOTAL_NON_FINITE');
  const availableBalanceUsd = assertFinite(accountTruth.account.available, 'GATEIO_LIVE_ACCOUNTING_AVAILABLE_NON_FINITE');
  const rawUnrealized = accountTruth.account.unrealizedPnl;
  const accountUnrealizedPnlUsd = typeof rawUnrealized === 'number' && Number.isFinite(rawUnrealized) ? rawUnrealized : null;
  const accountUnrealizedPnlStatus: AccountingCompleteness = accountUnrealizedPnlUsd === null ? 'INCOMPLETE' : 'COMPLETE';

  // ── positions / exposure (exposure only from factual Gate quoteValue) ─────
  const positions: GateIoLivePositionFact[] = accountTruth.positions.map((leg) => {
    const quoteValue = assertFinite(leg.quoteValue, 'GATEIO_LIVE_ACCOUNTING_EXPOSURE_NON_FINITE');
    const signedSize = assertFinite(leg.signedSize, 'GATEIO_LIVE_ACCOUNTING_SIZE_NON_FINITE');
    const signedBaseQuantity = multiplier === null ? null : multiplyQuantity(signedSize, multiplier);
    return { contract: leg.contract, mode: leg.mode, signedSize, signedBaseQuantity,
      baseQuantityStatus: signedBaseQuantity === null ? 'INCOMPLETE' : 'COMPLETE', quoteValue,
      entryPrice: leg.entryPrice ?? null, markPrice: leg.markPrice ?? null,
      realizedPnl: leg.realizedPnl ?? null, unrealizedPnl: leg.unrealizedPnl ?? null, updatedAt: leg.updatedAt };
  });
  const grossExposureUsd = sumExact(positions.map((leg) => Math.abs(leg.quoteValue)));
  const netExposureUsd = sumExact(positions.map((leg) => leg.quoteValue));
  assertFinite(grossExposureUsd, 'GATEIO_LIVE_ACCOUNTING_EXPOSURE_NON_FINITE');
  assertFinite(netExposureUsd, 'GATEIO_LIVE_ACCOUNTING_EXPOSURE_NON_FINITE');

  // ── realized PnL: observed per-position subtotal only ─────────────────────
  const realizedAll = positions.length > 0 && positions.every((leg) => leg.realizedPnl !== null);
  const observedPositionRealizedPnlUsd = realizedAll
    ? sumExact(positions.map((leg) => leg.realizedPnl as number)) : null;
  const observedPositionRealizedPnlStatus: AccountingCompleteness = observedPositionRealizedPnlUsd === null ? 'INCOMPLETE' : 'COMPLETE';

  // ── exact Gate trade correlation (order identity only) ────────────────────
  // The Gate trade's orderId is the exchange order identity; correlation is exact or nothing.
  const exchangeIds = new Map<string, GateIoLiveAction>();
  for (const order of orders) if (order.exchangeOrderId) exchangeIds.set(order.exchangeOrderId, order.action);
  const trades: GateIoLiveTradeFact[] = accountTruth.recentTrades.map((trade) => ({
    tradeId: trade.tradeId, orderId: trade.orderId, signedSize: trade.signedSize, price: trade.price,
    fee: trade.fee, pointFee: trade.pointFee, role: trade.role, createdAtMs: trade.createdAtMs,
    correlatedAction: exchangeIds.get(trade.orderId) ?? null,
  }));
  const matchedTrades = trades.filter((trade) => trade.correlatedAction !== null);
  const unmatchedTradeCount = trades.length - matchedTrades.length;
  const ordersWithFills = orders.filter((order) => order.fillIds.length > 0);
  // A fill is unattributed when its order has no exchange identity or no exactly corrlated trade exists.
  const unattributedFillCount = ordersWithFills.filter((order) => order.exchangeOrderId === null
    || !matchedTrades.some((trade) => trade.orderId === order.exchangeOrderId))
    .reduce((n, order) => n + order.fillIds.length, 0);
  const feesComplete = ordersWithFills.length > 0 && unattributedFillCount === 0;
  const fees: GateIoLiveFeeAttribution = {
    status: ordersWithFills.length === 0 ? 'UNAVAILABLE' : (feesComplete ? 'COMPLETE' : 'INCOMPLETE'),
    cashflowSemantics: 'UNPROVEN',
    rawFeeSum: feesComplete ? sumExact(matchedTrades.map((trade) => trade.fee)) : null,
    rawPointFeeSum: feesComplete ? sumExact(matchedTrades.map((trade) => trade.pointFee)) : null,
    feeCashflowUsd: null,
    attributedTradeCount: matchedTrades.length,
    unmatchedTradeCount,
    unattributedFillCount,
  };

  // ── gross execution PnL (never net of fees or funding) ────────────────────
  const openFills = fills.filter((fill) => fill.action === 'open');
  const closeFills = fills.filter((fill) => fill.action === 'close' || fill.action === 'reduce' || fill.action === 'emergency_exit');
  let grossTradingPnlUsd: number | null = null;
  if (openFills.length === 1 && closeFills.length === 1 && openFills[0].side !== closeFills[0].side
      && openFills[0].quantity === closeFills[0].quantity) {
    const open = openFills[0], close = closeFills[0];
    const perUnit = open.side === 'buy' ? subtractQuantity(close.price, open.price) : subtractQuantity(open.price, close.price);
    grossTradingPnlUsd = multiplyQuantity(open.quantity, perUnit);
  }
  const grossTradingPnlStatus: AccountingCompleteness = fills.length === 0 ? 'UNAVAILABLE'
    : (grossTradingPnlUsd === null ? 'INCOMPLETE' : 'COMPLETE');

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const snapshot: GateIoLiveAccountingSnapshot = {
    exchange: 'gateio',
    accountId,
    capturedAt,
    accountObservedAt: accountTruth.observedAtMs,
    accountServerTimeMs: accountTruth.serverTimeMs,
    accountTruthSource: accountTruth.source,
    accountFreshness: accountTruth.freshness,
    journalLastSequence: lastEvent ? lastEvent.kernelLogicalSequence : null,
    journalLastEventId: lastEvent ? lastEvent.kernelEventId : null,
    accountTotalUsd,
    availableBalanceUsd,
    accountUnrealizedPnlUsd,
    accountUnrealizedPnlStatus,
    positionMode: accountTruth.account.positionMode ?? null,
    accountState: accountTruth.accountState,
    openOrderCount: accountTruth.openOrders.length,
    positions,
    positionCount: positions.length,
    grossExposureUsd,
    netExposureUsd,
    observedPositionRealizedPnlUsd,
    observedPositionRealizedPnlStatus,
    dailyRealizedPnlUsd: null,
    dailyRealizedPnlStatus: 'UNAVAILABLE',
    lifetimeRealizedPnlUsd: null,
    lifetimeRealizedPnlStatus: 'UNAVAILABLE',
    confirmedFillCount: fills.length,
    orders: orders.map((order): GateIoLiveOrderLineage => ({ ...order, fillIds: [...order.fillIds] })),
    fills: fills.map((fill) => ({ ...fill })),
    executionLineageStatus: fills.length > 0 && orders.length > 0 ? 'COMPLETE' : 'INCOMPLETE',
    executionLineageDurability: 'COMPLETE',
    trades,
    tradedGateOrderIds: [...exchangeIds.keys()],
    fees,
    grossTradingPnlUsd,
    grossTradingPnlStatus,
    currentFundingRateMetadata: typeof instrumentFacts?.fundingRate === 'number' && Number.isFinite(instrumentFacts.fundingRate)
      ? instrumentFacts.fundingRate : null,
    fundingPaymentStatus: 'UNAVAILABLE',
    fundingPaymentUsd: null,
    slippageStatus: 'INCOMPLETE',
    totalObservedSlippageUsd: null,
    dailyRealizedLossUsd: null,
    dailyRealizedLossStatus: 'UNAVAILABLE',
    dailyTotalLossUsd: null,
    dailyTotalLossStatus: 'UNAVAILABLE',
    highWaterAccountTotalUsd: null,
    highWaterStatus: 'UNAVAILABLE',
    drawdownUsd: null,
    drawdownPct: null,
    drawdownStatus: 'UNAVAILABLE',
    accountSnapshotDurability: 'INCOMPLETE',
    riskHistoryDurability: 'UNAVAILABLE',
    autonomousRiskReady: false,
    autonomousRiskBlockers: [...GATEIO_LIVE_ACCOUNTING_AUTONOMOUS_RISK_BLOCKERS],
  };
  return deepFreeze(snapshot);
}
