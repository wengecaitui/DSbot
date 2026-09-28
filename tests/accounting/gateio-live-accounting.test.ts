// Phase G8H1: Gate.io Live accounting read-model — focused tests (A–R).
//
// These tests use factually shaped fixtures taken from the proven G8G canary (order/fill ids, quantities,
// prices and Gate trade rows) so the gross-PnL regression is the real one. No network, no filesystem,
// no credential and no production journal is touched by any case here.
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { computeGateIoLiveAccounting } from '../../src/accounting/gateio-live-accounting';
import type { GateIoLiveAccountingSnapshot } from '../../src/accounting/gateio-live-accounting-types';
import type { GateIoCanonicalAccountTruth, GateIoCanonicalInstrumentFacts } from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import type { KernelEventEnvelope } from '../../src/kernel/KernelEventEnvelope';

const ACCOUNT_ID = '55315368';
const CAPTURED_AT = 1790609300000;

// Real G8G canary identities.
const OPEN_ORDER_ID = 'eb4f71bb74df18bd7dcfa7820c6d07a1b24819a4b80ed0e5525dfc8eedb0c782';
const CLOSE_ORDER_ID = 'a80b4c7924e4e4f2d0b4e51717bb92481f29f82199ee4e18ea8b7386e40e6b16';
const OPEN_EXCHANGE_ID = '63894858307372921';
const CLOSE_EXCHANGE_ID = '63894858307373781';

interface PositionOverrides { signedSize?: number; quoteValue?: number; mode?: string; realizedPnl?: number | null; unrealizedPnl?: number | null; entryPrice?: number | null; markPrice?: number | null }

function leg(over: PositionOverrides = {}) {
  return { contract: 'ETH_USDT', signedSize: over.signedSize ?? 0, quoteValue: over.quoteValue ?? 0,
    mode: over.mode ?? 'dual_long', marginMode: 'cross', leverage: 10, entryPrice: over.entryPrice ?? 0,
    markPrice: over.markPrice ?? 2666.2, liquidationPrice: 0, unrealizedPnl: over.unrealizedPnl ?? 0,
    realizedPnl: over.realizedPnl === undefined ? 0 : over.realizedPnl, margin: 0, updatedAt: CAPTURED_AT - 1000 };
}

function trade(over: Partial<Record<'tradeId' | 'orderId', string>> & { fee?: number; pointFee?: number; price?: number; signedSize?: number; createdAtMs?: number } = {}) {
  return { tradeId: over.tradeId ?? '927723041', orderId: over.orderId ?? OPEN_EXCHANGE_ID, contract: 'ETH_USDT',
    signedSize: over.signedSize ?? 1, closeSize: 0, price: over.price ?? 2665.87, clientText: null,
    fee: over.fee ?? 0.001332935, pointFee: over.pointFee ?? 0, role: 'taker' as const, tradeValue: null,
    createdAt: 1790609223, createdAtSecondsExact: null, createdAtMs: over.createdAtMs ?? 1790609223260 };
}

function truth(over: { positions?: unknown[]; recentTrades?: unknown[]; unrealizedPnl?: number | null;
  accountState?: 'FLAT' | 'OPEN'; openOrders?: unknown[] } = {}): GateIoCanonicalAccountTruth {
  return {
    identity: { exchange: 'gateio', accountId: ACCOUNT_ID, settle: 'USDT' },
    account: { currency: 'USDT', total: 17.200485745, available: 17.200485745,
      unrealizedPnl: over.unrealizedPnl === undefined ? 0 : over.unrealizedPnl, orderMargin: 0,
      inDualMode: true, positionMode: 'dual', marginMode: 3 },
    positions: (over.positions ?? [leg({ mode: 'dual_long' }), leg({ mode: 'dual_short' })]) as never,
    openOrders: (over.openOrders ?? []) as never,
    recentTrades: (over.recentTrades ?? []) as never,
    serverTimeMs: CAPTURED_AT - 500, observedAtMs: CAPTURED_AT - 400, freshness: 'FRESH',
    source: 'gateio-live-read', schemaVersion: 1, accountState: over.accountState ?? 'FLAT',
    accountStateBasis: 'FACTUAL_POSITIONS_RESPONSE',
  } as unknown as GateIoCanonicalAccountTruth;
}

function facts(over: Partial<GateIoCanonicalInstrumentFacts> = {}): GateIoCanonicalInstrumentFacts {
  return { contract: 'ETH_USDT', contractStatus: 'trading', contractOpenable: true, inDelisting: false,
    contractMultiplier: 0.01, minOrderSize: 0.1, maxOrderSize: 10000000, markPrice: 2666.2, lastPrice: 2666.08,
    indexPrice: 2666.3, fundingRate: 0.000015, decimalSizeEnabled: true, freshness: 'FRESH',
    ...over } as unknown as GateIoCanonicalInstrumentFacts;
}

let seq = 0;
function envelope(type: string, payload: unknown): KernelEventEnvelope {
  seq += 1;
  return { kernelEventId: `id-${seq}`, kernelLogicalSequence: seq, kernelTimestamp: CAPTURED_AT - 9000 + seq,
    type, payload } as unknown as KernelEventEnvelope;
}

/** The journal lineage of the proven canary (OPEN then CLOSE), built from real ids. */
function canaryEvents(): KernelEventEnvelope[] {
  seq = 0;
  return [
    envelope('order.created', { order: { orderId: OPEN_ORDER_ID, intentId: 'ti-open', exchange: 'gateio',
      symbol: 'ETH/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 2.66920654 } }),
    envelope('order.submitted', { orderId: OPEN_ORDER_ID }),
    envelope('order.execution.prepared', { orderId: OPEN_ORDER_ID, preparation: { requestedQuantity: 0.001,
      venueQuantity: 0.1, quantityMultiplier: 0.01, clientOrderId: 't-dsb-1', reduceOnly: false } }),
    envelope('execution.fill.confirmed', { fill: { fillId: '63894858307372921', exchange: 'gateio',
      symbol: 'ETH/USDT', side: 'buy', quantity: 0.001, price: 2665.87, executedAt: 1790609223260 },
      execution: { orderId: OPEN_ORDER_ID, exchangeOrderId: OPEN_EXCHANGE_ID, requestedQuantity: 0.001,
        cumulativeFilledQuantity: 0.001, remainingQuantity: 0, cumulativeNotional: 2.66587,
        executedAt: 1790609223260, status: 'FILLED' } }),
    envelope('order.created', { order: { orderId: CLOSE_ORDER_ID, intentId: 'ti-close', exchange: 'gateio',
      symbol: 'ETH/USDT', action: 'close', side: 'sell', orderType: 'market', approvedNotionalUsd: 2.66674 } }),
    envelope('order.submitted', { orderId: CLOSE_ORDER_ID }),
    envelope('order.execution.prepared', { orderId: CLOSE_ORDER_ID, preparation: { requestedQuantity: 0.001,
      venueQuantity: 0.1, quantityMultiplier: 0.01, clientOrderId: 't-dsb-2', reduceOnly: true } }),
    envelope('execution.fill.confirmed', { fill: { fillId: '63894858307373781', exchange: 'gateio',
      symbol: 'ETH/USDT', side: 'sell', quantity: 0.001, price: 2665.69, executedAt: 1790609224134 },
      execution: { orderId: CLOSE_ORDER_ID, exchangeOrderId: CLOSE_EXCHANGE_ID, requestedQuantity: 0.001,
        cumulativeFilledQuantity: 0.001, remainingQuantity: 0, cumulativeNotional: 2.66569,
        executedAt: 1790609224134, status: 'FILLED' } }),
  ];
}

const compute = (over: { truth?: GateIoCanonicalAccountTruth; events?: KernelEventEnvelope[]; instrumentFacts?: GateIoCanonicalInstrumentFacts | null } = {}) =>
  computeGateIoLiveAccounting({ capturedAt: CAPTURED_AT, accountTruth: over.truth ?? truth(),
    instrumentFacts: over.instrumentFacts === undefined ? facts() : over.instrumentFacts,
    events: over.events ?? [] });

describe('Gate.io Live accounting read model', () => {
  it('A: factual flat dual-leg account produces exactly zero exposure', () => {
    const s = compute();
    assert.strictEqual(s.grossExposureUsd, 0);
    assert.strictEqual(s.netExposureUsd, 0);
    assert.strictEqual(s.positionCount, 2);
    assert.strictEqual(s.accountState, 'FLAT');
    assert.strictEqual(s.openOrderCount, 0);
  });

  it('B: open long derives signed base quantity and exposure from factual quoteValue', () => {
    const s = compute({ truth: truth({ positions: [leg({ mode: 'dual_long', signedSize: 0.1, quoteValue: 266.62, entryPrice: 2666.2 })] }) });
    assert.strictEqual(s.positions[0].signedBaseQuantity, 0.001);
    assert.strictEqual(s.positions[0].baseQuantityStatus, 'COMPLETE');
    assert.strictEqual(s.grossExposureUsd, 266.62);
    assert.strictEqual(s.netExposureUsd, 266.62);
  });

  it('C: open short keeps the exposure sign', () => {
    const s = compute({ truth: truth({ positions: [leg({ mode: 'dual_short', signedSize: -0.1, quoteValue: -266.62 })] }) });
    assert.strictEqual(s.grossExposureUsd, 266.62);
    assert.strictEqual(s.netExposureUsd, -266.62);
    assert.strictEqual(s.positions[0].signedBaseQuantity, -0.001);
  });

  it('D: a null account unrealizedPnl is INCOMPLETE/never zero', () => {
    const s = compute({ truth: truth({ unrealizedPnl: null }) });
    assert.strictEqual(s.accountUnrealizedPnlUsd, null);
    assert.strictEqual(s.accountUnrealizedPnlStatus, 'INCOMPLETE');
    assert.notStrictEqual(s.accountUnrealizedPnlUsd, 0);
  });

  it('E: exact OPEN/CLOSE lineage is rebuilt from journal events', () => {
    const s = compute({ events: canaryEvents() });
    assert.strictEqual(s.orders.length, 2);
    assert.strictEqual(s.confirmedFillCount, 2);
    assert.deepStrictEqual(s.orders.map((o) => o.action), ['open', 'close']);
    assert.deepStrictEqual(s.orders.map((o) => o.reduceOnly), [false, true]);
    assert.deepStrictEqual(s.fills.map((f) => f.side), ['buy', 'sell']);
    assert.strictEqual(s.fills[0].exchangeOrderId, OPEN_EXCHANGE_ID);
    assert.strictEqual(s.executionLineageStatus, 'COMPLETE');
    assert.strictEqual(s.executionLineageDurability, 'COMPLETE');
  });

  it('F: conflicting duplicate order lineage fails closed', () => {
    seq = 0;
    const conflicting = [envelope('order.created', { order: { orderId: OPEN_ORDER_ID, exchange: 'gateio',
      symbol: 'ETH/USDT', action: 'open', side: 'buy', approvedNotionalUsd: 2.66920654 } }),
      envelope('order.created', { order: { orderId: OPEN_ORDER_ID, exchange: 'gateio', symbol: 'ETH/USDT',
        action: 'close', side: 'sell', approvedNotionalUsd: 2.66920654 } })];
    assert.throws(() => compute({ events: conflicting }), /GATEIO_LIVE_ACCOUNTING_ORDER_CONFLICT/);
  });

  it('G: several Gate trades correlate exactly to one OMS order', () => {
    const s = compute({ events: canaryEvents(), truth: truth({ recentTrades: [
      trade({ tradeId: 't1', orderId: OPEN_EXCHANGE_ID, fee: 0.001, pointFee: 0.0002, price: 2665.87 }),
      trade({ tradeId: 't2', orderId: OPEN_EXCHANGE_ID, fee: 0.000332935, pointFee: 0.0001, price: 2665.9 }),
      trade({ tradeId: 't3', orderId: CLOSE_EXCHANGE_ID, fee: 0.001332845, pointFee: 0, price: 2665.69 }),
    ] }) });
    assert.strictEqual(s.fees.status, 'COMPLETE');
    assert.strictEqual(s.fees.attributedTradeCount, 3);
    assert.deepStrictEqual(s.trades.map((t) => t.correlatedAction), ['open', 'open', 'close']);
    assert.strictEqual(s.fees.rawFeeSum, 0.00266578);
    assert.strictEqual(s.fees.rawPointFeeSum, 0.0003);
  });

  it('H: an unmatched Gate trade never contaminates canary fee attribution', () => {
    const s = compute({ events: canaryEvents(), truth: truth({ recentTrades: [
      trade({ tradeId: 't1', orderId: OPEN_EXCHANGE_ID, fee: 0.001332935 }),
      trade({ tradeId: 't3', orderId: CLOSE_EXCHANGE_ID, fee: 0.001332845 }),
      trade({ tradeId: 't9', orderId: '99999999999999999', fee: 123.456 }),
    ] }) });
    assert.strictEqual(s.fees.unmatchedTradeCount, 1);
    assert.strictEqual(s.trades.find((t) => t.tradeId === 't9')?.correlatedAction, null);
    assert.strictEqual(s.fees.status, 'COMPLETE');
    assert.strictEqual(s.fees.rawFeeSum, 0.00266578);   // the stray 123.456 is excluded
    assert.strictEqual(s.fees.unattributedFillCount, 0);
  });

  it('H2: a missing trade row for one leg leaves attribution INCOMPLETE with null sums', () => {
    const s = compute({ events: canaryEvents(), truth: truth({ recentTrades: [
      trade({ tradeId: 't1', orderId: OPEN_EXCHANGE_ID, fee: 0.001332935 }),
      trade({ tradeId: 't9', orderId: '99999999999999999', fee: 123.456 }),
    ] }) });
    assert.strictEqual(s.fees.status, 'INCOMPLETE');
    assert.strictEqual(s.fees.unattributedFillCount, 1);
    assert.strictEqual(s.fees.rawFeeSum, null);
    assert.strictEqual(s.fees.rawPointFeeSum, null);
  });

  it('I: a fill whose order has no exchange identity stays unattributed (INCOMPLETE, null sums)', () => {
    seq = 0;
    const s = compute({ events: [envelope('order.created', { order: { orderId: OPEN_ORDER_ID, exchange: 'gateio',
      symbol: 'ETH/USDT', action: 'open', side: 'buy', approvedNotionalUsd: 2.6 } }),
      envelope('order.execution.prepared', { orderId: OPEN_ORDER_ID, preparation: { requestedQuantity: 0.001,
        venueQuantity: 0.1, quantityMultiplier: 0.01, clientOrderId: 't-dsb-1', reduceOnly: false } }),
      envelope('execution.fill.confirmed', { fill: { fillId: 'f1', exchange: 'gateio', symbol: 'ETH/USDT',
        side: 'buy', quantity: 0.001, price: 2665.87, executedAt: CAPTURED_AT },
        execution: { orderId: OPEN_ORDER_ID, requestedQuantity: 0.001, cumulativeFilledQuantity: 0.001,
          remainingQuantity: 0, cumulativeNotional: 2.66587, executedAt: CAPTURED_AT, status: 'FILLED' } })],
      truth: truth({ recentTrades: [trade({ orderId: OPEN_EXCHANGE_ID })] }) });
    assert.strictEqual(s.confirmedFillCount, 1);
    assert.strictEqual(s.fills[0].exchangeOrderId, null);
    assert.strictEqual(s.fees.status, 'INCOMPLETE');
    assert.strictEqual(s.fees.unattributedFillCount, 1);
    assert.strictEqual(s.fees.rawFeeSum, null);
    assert.strictEqual(s.fees.rawPointFeeSum, null);
  });

  it('I2: a fill with no resolvable order lineage fails closed', () => {
    seq = 0;
    assert.throws(() => compute({ events: [envelope('execution.fill.confirmed', { fill: { fillId: 'orphan',
      exchange: 'gateio', symbol: 'ETH/USDT', side: 'buy', quantity: 0.001, price: 2665.87, executedAt: CAPTURED_AT } })] }),
      /GATEIO_LIVE_ACCOUNTING_ORDER_ID_INVALID/);
  });

  it('J: raw fee facts are preserved while the fee cashflow stays null', () => {
    const s = compute({ events: canaryEvents(), truth: truth({ recentTrades: [
      trade({ tradeId: 't1', orderId: OPEN_EXCHANGE_ID, fee: 0.001332935, pointFee: 0 }),
      trade({ tradeId: 't3', orderId: CLOSE_EXCHANGE_ID, fee: 0.001332845, pointFee: 0 }),
    ] }) });
    assert.strictEqual(s.fees.rawFeeSum, 0.00266578);
    assert.strictEqual(s.fees.rawPointFeeSum, 0);
    assert.strictEqual(s.fees.feeCashflowUsd, null);
    assert.strictEqual(s.fees.cashflowSemantics, 'UNPROVEN');
  });

  it('K: a current funding rate is metadata only — the funding payment is UNAVAILABLE', () => {
    const s = compute({ instrumentFacts: facts({ fundingRate: 0.000015 }) });
    assert.strictEqual(s.currentFundingRateMetadata, 0.000015);
    assert.strictEqual(s.fundingPaymentStatus, 'UNAVAILABLE');
    assert.strictEqual(s.fundingPaymentUsd, null);
  });

  it('L: canary gross PnL regression = -0.00018 (fees and funding never subtracted)', () => {
    const s = compute({ events: canaryEvents() });
    assert.strictEqual(s.grossTradingPnlUsd, -0.00018);
    assert.strictEqual(s.grossTradingPnlStatus, 'COMPLETE');
  });

  it('M: without a factual execution reference the slippage stays INCOMPLETE', () => {
    const s = compute({ events: canaryEvents() });
    assert.strictEqual(s.slippageStatus, 'INCOMPLETE');
    assert.strictEqual(s.totalObservedSlippageUsd, null);
  });

  it('N: daily / high-water / drawdown are explicitly unavailable', () => {
    const s = compute({ events: canaryEvents() });
    assert.strictEqual(s.dailyRealizedLossUsd, null);
    assert.strictEqual(s.dailyRealizedLossStatus, 'UNAVAILABLE');
    assert.strictEqual(s.dailyTotalLossUsd, null);
    assert.strictEqual(s.dailyTotalLossStatus, 'UNAVAILABLE');
    assert.strictEqual(s.highWaterAccountTotalUsd, null);
    assert.strictEqual(s.highWaterStatus, 'UNAVAILABLE');
    assert.strictEqual(s.drawdownUsd, null);
    assert.strictEqual(s.drawdownPct, null);
    assert.strictEqual(s.drawdownStatus, 'UNAVAILABLE');
    assert.strictEqual(s.dailyRealizedPnlUsd, null);
    assert.strictEqual(s.lifetimeRealizedPnlUsd, null);
  });

  it('O: autonomousRiskReady is false with the full current source set, with exact blockers', () => {
    const s = compute({ events: canaryEvents(), truth: truth({ recentTrades: [
      trade({ tradeId: 't1', orderId: OPEN_EXCHANGE_ID }), trade({ tradeId: 't3', orderId: CLOSE_EXCHANGE_ID }) ] }) });
    assert.strictEqual(s.fees.status, 'COMPLETE');
    assert.strictEqual(s.autonomousRiskReady, false);
    assert.deepStrictEqual([...s.autonomousRiskBlockers], [
      'FUNDING_PAYMENT_HISTORY_UNAVAILABLE', 'FEE_CASHFLOW_SEMANTICS_UNPROVEN', 'DAILY_LOSS_HISTORY_UNAVAILABLE',
      'HIGH_WATER_HISTORY_UNAVAILABLE', 'DRAWDOWN_HISTORY_UNAVAILABLE', 'LIVE_ACCOUNT_SNAPSHOT_NOT_DURABLE']);
    assert.strictEqual(s.accountSnapshotDurability, 'INCOMPLETE');
    assert.strictEqual(s.riskHistoryDurability, 'UNAVAILABLE');
  });

  it('P: identical inputs give byte-identical, deeply frozen output (no ambient clock)', () => {
    const inputA = { truth: truth({ recentTrades: [trade({})] }), events: canaryEvents() };
    const first = compute(inputA);
    const second = compute({ truth: truth({ recentTrades: [trade({})] }), events: canaryEvents() });
    assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.positions));
    assert.ok(Object.isFrozen(first.fees));
  });

  it('Q: the input objects are never mutated', () => {
    const accountTruth = truth({ positions: [leg({ signedSize: 0.1, quoteValue: 266.62 })] });
    const events = canaryEvents();
    const truthBefore = JSON.stringify(accountTruth);
    const eventsBefore = JSON.stringify(events);
    const snapshot = compute({ truth: accountTruth, events });
    assert.strictEqual(JSON.stringify(accountTruth), truthBefore);
    assert.strictEqual(JSON.stringify(events), eventsBefore);
    assert.strictEqual(snapshot.capturedAt, CAPTURED_AT);
    // the projection reports the input capture time, never a sampled clock value
    assert.strictEqual(compute({ truth: accountTruth, events, instrumentFacts: facts() }).capturedAt, CAPTURED_AT);
  });

  it('R: no filesystem/network/credential surface is used, and no completeness flag is silently numeric', () => {
    const s: GateIoLiveAccountingSnapshot = compute();
    for (const value of [s.fundingPaymentUsd, s.totalObservedSlippageUsd, s.drawdownUsd, s.drawdownPct,
      s.highWaterAccountTotalUsd, s.dailyTotalLossUsd, s.dailyRealizedLossUsd, s.dailyRealizedPnlUsd,
      s.lifetimeRealizedPnlUsd, s.fees.feeCashflowUsd]) {
      assert.strictEqual(value, null);           // missing facts are never zero
    }
    assert.strictEqual(compute().accountTruthSource, 'gateio-live-read');
    assert.strictEqual(compute().exchange, 'gateio');
    assert.strictEqual(compute().accountId, ACCOUNT_ID);
  });
});
