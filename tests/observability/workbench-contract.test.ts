import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { RuntimeAccountingSnapshot } from '../../src/accounting/runtime-accounting-types';
import type { MarketSnapshot } from '../../src/data/MarketSnapshot';
import type { OmsOrderSnapshot } from '../../src/oms/oms-types';
import {
  createWorkbenchOverviewSnapshot,
  WORKBENCH_V1_BOUNDARIES,
  WORKBENCH_V1_READ_RESOURCES,
  WORKBENCH_V1_ROUTES,
  type ReadOnlySnapshot,
  type WorkbenchOverviewInput,
} from '../../src/observability/workbench-contract';

const provenance = {
  capturedAt: 1_000,
  source: 'contract-test',
  sourceSequence: 7,
  sourceVersion: 3,
  lastUpdatedAt: 900,
} as const;

function available<T>(data: T, freshness: 'FRESH' | 'STALE' | 'UNKNOWN' = 'FRESH'): ReadOnlySnapshot<T> {
  return { availability: 'AVAILABLE', freshness, provenance, data };
}

function incomplete<T>(data: T, freshness: 'FRESH' | 'STALE' | 'UNKNOWN'): ReadOnlySnapshot<T> {
  return { availability: 'INCOMPLETE', freshness, provenance, data, reason: 'partial canonical evidence' };
}

function unknown<T>(reason: string): ReadOnlySnapshot<T> {
  return {
    availability: 'UNKNOWN',
    freshness: 'UNKNOWN',
    provenance: { capturedAt: null, source: 'not-established', sourceSequence: null, sourceVersion: null, lastUpdatedAt: null },
    data: null,
    reason,
  };
}

function market(symbol: string, isStale: boolean): MarketSnapshot {
  return {
    exchange: 'bitget', symbol, ticker: null, klines: {}, snapshotVersion: 2,
    generatedAt: 1_000, lastUpdatedAt: 900, ageMs: 100, isStale,
  };
}

function order(orderId: string, status: OmsOrderSnapshot['status']): OmsOrderSnapshot {
  return {
    orderId, intentId: `intent-${orderId}`, exchange: 'bitget', symbol: 'BTC/USDT',
    action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 100,
    status, orderVersion: 1, sourceKernelEventId: 'a'.repeat(64),
  };
}

const canonicalAccounting: RuntimeAccountingSnapshot = {
  accountId: 'paper-1', exchange: 'bitget', sourceLedgerSequence: 9,
  sourceLedgerUpdatedAt: 800, source: 'production-spine', capturedAt: 1_000,
  initialCashUsd: 1_000, cashUsd: 900, realizedPnlUsd: -5, totalFeesUsd: 2,
  processedFills: 1, valuationStatus: 'INCOMPLETE', unrealizedPnlUsd: null,
  equityUsd: null, grossExposureUsd: null, netExposureUsd: null, openPositions: 1,
  positions: [{
    exchange: 'bitget', symbol: 'BTC/USDT', side: 'long', signedQuantity: 1,
    averageEntryPriceUsd: 100, markPriceUsd: null, marketSnapshotVersion: null,
    marketLastUpdatedAt: null, marketValueUsd: null, unrealizedPnlUsd: null,
  }],
  fees: { totalFeesUsd: 2, summedFillFeesUsd: 2, reconciled: true },
  slippage: {
    status: 'INCOMPLETE', totalObservedSlippageUsd: null, partialObservedSlippageUsd: 0,
    attributedFills: [], unattributedFillCount: 1,
  },
};

function fixture(): WorkbenchOverviewInput {
  return {
    capturedAt: 1_000,
    runtime: available({ health: 'UNKNOWN', environment: 'paper', mode: 'paper', hermes: null }),
    market: incomplete({ instruments: [market('Z/USDT', true), market('A/USDT', true)], regime: null }, 'STALE'),
    trading: available({
      positions: [
        {
          exchange: 'bitget', symbol: 'Z/USDT',
          resolution: {
            status: 'open', side: 'long', signedQuantity: 1, averageEntryPrice: 100,
            snapshot: { exchange: 'bitget', symbol: 'Z/USDT', side: 'long', signedQuantity: 1, averageEntryPrice: 100, positionVersion: 2, sourceKernelEventId: 'b'.repeat(64) },
          },
        },
        {
          exchange: 'bitget', symbol: 'A/USDT',
          resolution: { status: 'missing', side: 'flat', signedQuantity: 0, averageEntryPrice: 0, snapshot: null },
        },
      ],
      orders: [order('order-z', 'SUBMISSION_UNKNOWN'), order('order-a', 'FILLED')],
      protectivePlans: [],
    }),
    account: incomplete({ accounting: canonicalAccounting, tradeLifecycle: null }, 'UNKNOWN'),
    safety: incomplete({
      recovery: null,
      reconciliation: null,
      liveReady: { status: 'UNKNOWN', authority: 'ProductionSpine safety gate', mutableFromWorkbench: false, blockers: ['reconciliation unavailable'] },
      killSwitch: { status: 'UNKNOWN', authority: 'not-established', reason: null, mutableFromWorkbench: false },
      riskBlockers: ['risk source unavailable'],
    }, 'UNKNOWN'),
    research: available({
      providers: [
        { providerId: 'z-provider', status: 'UNKNOWN', datasets: [], normalized: false, authoritativeForExecution: false },
        { providerId: 'a-provider', status: 'UNAVAILABLE', datasets: [], normalized: false, authoritativeForExecution: false },
      ],
      evidence: [
        { evidenceId: 'z', kind: 'ai-interpretation', producedBy: 'ai', sourceEvidenceIds: ['a'], authoritativeForExecution: false },
        { evidenceId: 'a', kind: 'factor', producedBy: 'deterministic', sourceEvidenceIds: [], authoritativeForExecution: false },
      ],
      jobs: [
        { jobId: 'z-job', state: 'UNKNOWN', progress: null, updatedAt: null, canCancelFromWorkbenchV1: false },
        { jobId: 'a-job', state: 'FAILED', progress: null, updatedAt: 5, canCancelFromWorkbenchV1: false },
      ],
      backtestWorkspace: {
        modes: ['factor', 'strategy', 'optimizer', 'walk-forward'],
        antiOverfitSplit: ['TRAIN', 'VALIDATION', 'LOCKED_TEST'],
        optimizationMayReadValidation: false,
        optimizationMayReadLockedTest: false,
      },
    }),
    activity: unknown('event adapter unavailable'),
  };
}

describe('Phase 7C workbench contract boundaries', () => {
  it('freezes domain routes and exposes no trading/runtime control capability', () => {
    assert.deepStrictEqual(WORKBENCH_V1_ROUTES.map(route => route.id), [
      'overview', 'market', 'trading', 'research', 'policy', 'safety', 'operations', 'data', 'settings',
    ]);
    assert.deepStrictEqual(WORKBENCH_V1_ROUTES.find(route => route.id === 'operations')?.tabs, ['hermes', 'events', 'control-center']);
    assert.strictEqual(WORKBENCH_V1_BOUNDARIES.readOnly, true);
    assert.deepStrictEqual(WORKBENCH_V1_BOUNDARIES.allowedHttpMethods, ['GET']);
    assert.deepStrictEqual(WORKBENCH_V1_BOUNDARIES.tradingControlCapabilities, []);
    assert.strictEqual(WORKBENCH_V1_BOUNDARIES.dashboardGrantsApproval, false);
    assert.strictEqual(WORKBENCH_V1_BOUNDARIES.liveReadyIsMutable, false);
    assert.strictEqual(WORKBENCH_V1_BOUNDARIES.controlCenterDomain, 'operations');
    assert.strictEqual(WORKBENCH_V1_BOUNDARIES.controlCenterIncludedInTradingOverview, false);
    assert.ok(WORKBENCH_V1_READ_RESOURCES.every(resource => !('method' in resource) && !('path' in resource)), 'transport paths intentionally remain an implementation decision');
  });

  it('preserves unknown, stale, incomplete, missing, and SUBMISSION_UNKNOWN without economic recomputation', () => {
    const snapshot = createWorkbenchOverviewSnapshot(fixture());
    assert.strictEqual(snapshot.market.availability, 'INCOMPLETE');
    assert.strictEqual(snapshot.market.freshness, 'STALE');
    assert.strictEqual(snapshot.account.availability, 'INCOMPLETE');
    assert.strictEqual(snapshot.account.data.accounting?.valuationStatus, 'INCOMPLETE');
    assert.strictEqual(snapshot.account.data.accounting?.equityUsd, null);
    assert.strictEqual(snapshot.account.data.accounting?.unrealizedPnlUsd, null);
    assert.strictEqual(snapshot.account.data.accounting?.slippage.totalObservedSlippageUsd, null);
    assert.strictEqual(snapshot.trading.data.positions[0].symbol, 'A/USDT', 'positions stably ordered');
    assert.strictEqual(snapshot.trading.data.positions[0].resolution.status, 'missing');
    assert.strictEqual(snapshot.trading.data.orders[1].status, 'SUBMISSION_UNKNOWN');
    assert.strictEqual(snapshot.safety.data.liveReady.status, 'UNKNOWN');
    assert.strictEqual(snapshot.safety.data.liveReady.mutableFromWorkbench, false);
    assert.strictEqual(snapshot.safety.data.reconciliation, null);
    assert.strictEqual(snapshot.research.data.evidence.find(item => item.producedBy === 'ai')?.authoritativeForExecution, false);
  });

  it('is deterministic, stably ordered, defensive, and deeply immutable', () => {
    const source = fixture();
    const first = createWorkbenchOverviewSnapshot(source);
    const second = createWorkbenchOverviewSnapshot(source);
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(first.market.data?.instruments.map(item => item.symbol), ['A/USDT', 'Z/USDT']);
    assert.deepStrictEqual(first.research.data?.providers.map(item => item.providerId), ['a-provider', 'z-provider']);
    assert.deepStrictEqual(first.research.data?.jobs.map(item => item.jobId), ['a-job', 'z-job']);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.trading));
    assert.ok(Object.isFrozen(first.trading.data?.orders));
    assert.ok(Object.isFrozen(first.account.data?.accounting?.positions[0]));

    (source.trading.data!.orders as OmsOrderSnapshot[]).reverse();
    assert.deepStrictEqual(first.trading.data?.orders.map(item => item.orderId), ['order-a', 'order-z'], 'source mutation cannot change snapshot');
  });

  it('rejects fabricated data on absent envelopes and never reads a hidden clock/random source', () => {
    const bad = fixture() as any;
    bad.activity = { ...bad.activity, data: { events: [] } };
    assert.throws(() => createWorkbenchOverviewSnapshot(bad), /must carry data: null/);

    const source = readFileSync(new URL('../../src/observability/workbench-contract.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Date\.now\s*\(/);
    assert.doesNotMatch(source, /Math\.random\s*\(/);
    assert.doesNotMatch(source, /from ['"]\.\.\/kernel\/TradingKernel['"]/);
    assert.doesNotMatch(source, /from ['"]\.\.\/oms\/OmsCore['"]/);
  });
});
