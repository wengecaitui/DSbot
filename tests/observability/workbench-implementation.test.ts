import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { RuntimeAccountingSnapshot } from '../../src/accounting/runtime-accounting-types';
import type { TradeLifecycle } from '../../src/accounting/trade-lifecycle-types';
import type { MarketSnapshot } from '../../src/data/MarketSnapshot';
import type { CoordinatorSnapshot } from '../../src/hermes/types';
import type { OmsOrderSnapshot } from '../../src/oms/oms-types';
import type { ProductionSpine } from '../../src/position/ProductionSpine';
import { createServer } from '../../src/gateway/server';
import { createWorkbenchRouter } from '../../src/gateway/workbench-routes';
import { createWorkbenchReadAdapter } from '../../src/observability/workbench-read-adapter';
import { getFreePort } from '../hermes/helpers';

const hermes: CoordinatorSnapshot = {
  state: 'running', generation: 4, health: 'healthy', circuitState: 'closed',
  consecutiveHealthFailures: 0, startedAt: 900, stoppedAt: null,
  lastHealthConfirmedAt: 990, lastHealthStatus: 'healthy',
  trackedReceiptCount: 0, consumedReceiptCount: 0,
};

const market: MarketSnapshot = {
  exchange: 'bitget', symbol: 'BTC/USDT', ticker: null, klines: {},
  snapshotVersion: 11, generatedAt: 1_000, lastUpdatedAt: 800, ageMs: 200, isStale: true,
};

const accounting: RuntimeAccountingSnapshot = {
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
  slippage: { status: 'INCOMPLETE', totalObservedSlippageUsd: null, partialObservedSlippageUsd: 0, attributedFills: [], unattributedFillCount: 1 },
};

const lifecycle: TradeLifecycle = {
  accountId: 'paper-1', exchange: 'bitget', sourceLedgerSequence: 9,
  sourceLedgerUpdatedAt: 800, trades: [], grossRealizedPnlUsd: -3,
  totalFeesUsd: 2, realizedPnlUsd: -5, netPnlUsd: -5,
  closedTrades: 0, winningTrades: 0, losingTrades: 0, breakEvenTrades: 0, profitFactor: 0,
};

const unknownOrder: OmsOrderSnapshot = {
  orderId: 'order-z', intentId: 'intent-z', exchange: 'bitget', symbol: 'BTC/USDT',
  action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 100,
  status: 'SUBMISSION_UNKNOWN', orderVersion: 12, sourceKernelEventId: 'a'.repeat(64),
};

function fakeSpine(): ProductionSpine {
  return {
    marketStore: { getAllSnapshots: () => [market] },
    positionStore: {
      listResolved: () => [],
      resolve: () => ({ status: 'missing', snapshot: null, side: 'flat', signedQuantity: 0, averageEntryPrice: 0 }),
    },
    oms: { getStore: () => ({ list: () => [unknownOrder] }) },
    planStore: { list: () => [] },
    accounting: { snapshot: () => accounting, lifecycle: () => lifecycle },
    policyStore: { getLatest: () => undefined },
    protection: { getMode: () => 'replay' },
    privateConfig: { hardRisk: () => ({ exchange: 'bitget', currentExposureUsd: 10, todayRealizedLossUsd: 0, todayUnrealizedLossUsd: 0, openPositions: 1, isTriggered: false }) },
    recoveryVerified: false,
    reconciliationVerified: false,
    lastReconciliationReport: null,
  } as unknown as ProductionSpine;
}

function adapter(withSpine = true) {
  const spine = fakeSpine();
  return createWorkbenchReadAdapter({
    now: () => 1_000,
    runtime: () => ({ health: 'HEALTHY', environment: 'paper', mode: 'paper' }),
    hermes: () => hermes,
    productionSpine: withSpine ? () => spine : undefined,
  });
}

describe('Phase 7C authoritative workbench reads', () => {
  it('passes canonical accounting and lifecycle through without filling unavailable economics', () => {
    const result = adapter().account();
    assert.equal(result.availability, 'INCOMPLETE');
    assert.deepEqual(result.data?.accounting, accounting);
    assert.deepEqual(result.data?.tradeLifecycle, lifecycle);
    assert.equal(result.data?.accounting?.equityUsd, null);
    assert.equal(result.data?.accounting?.unrealizedPnlUsd, null);
    assert.equal(result.data?.accounting?.slippage.totalObservedSlippageUsd, null);
    assert.equal(result.provenance.sourceSequence, accounting.sourceLedgerSequence);
  });

  it('preserves missing positions, SUBMISSION_UNKNOWN, stale market state and stable ordering', () => {
    const read = adapter();
    const trading = read.trading();
    const markets = read.market();
    assert.equal(trading.data?.positions[0]?.resolution.status, 'missing');
    assert.equal(trading.data?.orders[0]?.status, 'SUBMISSION_UNKNOWN');
    assert.equal(markets.freshness, 'STALE');
    assert.equal(markets.data?.instruments[0]?.symbol, 'BTC/USDT');
    const overview = read.overview();
    assert.equal(overview.trading.data?.orders[0]?.status, 'SUBMISSION_UNKNOWN');
    assert.equal(overview.capturedAt, 1_000);
    for (const domain of ['runtime', 'market', 'trading', 'account', 'safety', 'research', 'activity'] as const) {
      assert.equal(overview[domain].provenance.capturedAt, overview.capturedAt);
    }
  });

  it('keeps LIVE_READY, recovery, reconciliation and Project Control Center read-only/fail-closed', () => {
    const read = adapter();
    const safety = read.safety();
    const operations = read.operations();
    assert.equal(safety.availability, 'INCOMPLETE');
    assert.equal(safety.data?.liveReady.status, 'NOT_READY');
    assert.equal(safety.data?.liveReady.mutableFromWorkbench, false);
    assert.equal(safety.data?.recovery, null);
    assert.equal(safety.data?.reconciliation, null);
    assert.equal(operations.data?.controlCenterDomain, 'operations');
    assert.equal(operations.data?.projectControlCenter, null);
    assert.equal(read.status().status.reconciliation, 'UNKNOWN');
  });

  it('reports absent canonical sources as unavailable instead of healthy defaults', () => {
    const read = adapter(false);
    assert.equal(read.market().availability, 'UNAVAILABLE');
    assert.equal(read.trading().availability, 'UNAVAILABLE');
    assert.equal(read.account().availability, 'UNAVAILABLE');
    assert.equal(read.safety().availability, 'UNAVAILABLE');
    assert.equal(read.status().status.marketFreshness, 'UNKNOWN');
    assert.equal(read.status().status.liveReady, 'UNKNOWN');
  });
});

describe('Phase 7C GET-only workbench router', () => {
  it('registers only GET resources and rejects mutation methods without reading a resource', async () => {
    let runtimeReads = 0;
    const read = createWorkbenchReadAdapter({
      now: () => 1_000,
      runtime: () => {
        runtimeReads += 1;
        return { health: 'HEALTHY', environment: 'unknown', mode: 'gateway' };
      },
      hermes: () => hermes,
    });
    const router = createWorkbenchRouter(read);
    const routeMethods = (router as any).stack
      .filter((layer: any) => layer.route)
      .flatMap((layer: any) => Object.keys(layer.route.methods));
    assert.ok(routeMethods.length > 0);
    assert.ok(routeMethods.every((method: string) => method === 'get'));

    const originalToken = process.env.CLODDS_TOKEN;
    delete process.env.CLODDS_TOKEN;
    const port = await getFreePort();
    const server = createServer({ port, cors: false, auth: {} });
    server.setWorkbenchRouter(router);
    await server.start();
    try {
      const getResponse = await fetch(`http://127.0.0.1:${port}/api/workbench/v1/runtime`);
      assert.equal(getResponse.status, 200);
      assert.equal((await getResponse.json() as any).data.health, 'HEALTHY');
      assert.equal(runtimeReads, 1);

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await fetch(`http://127.0.0.1:${port}/api/workbench/v1/runtime`, { method });
        assert.equal(response.status, 405);
        assert.deepEqual(await response.json(), { error: 'workbench_read_only', allowedMethods: ['GET'] });
      }
      assert.equal(runtimeReads, 1, 'mutation attempts never invoke the read provider');
    } finally {
      await server.stop();
      if (originalToken === undefined) delete process.env.CLODDS_TOKEN;
      else process.env.CLODDS_TOKEN = originalToken;
    }
  });
});

describe('Phase 7C shared frontend query boundary', () => {
  it('keeps network reads in the typed GET-only client and pages on shared query options', () => {
    const appSource = readFileSync('web/src/App.tsx', 'utf8');
    const clientSource = readFileSync('web/src/api/client.ts', 'utf8');
    const querySource = readFileSync('web/src/api/queries.ts', 'utf8');

    assert.match(appSource, /workbenchQueries/);
    assert.doesNotMatch(appSource, /\bfetch\s*\(/);
    assert.match(clientSource, /method:\s*'GET'/);
    assert.doesNotMatch(clientSource, /method:\s*'(?:POST|PUT|PATCH|DELETE)'/);
    assert.match(clientSource, /\/api\/workbench\/v1/);
    assert.match(querySource, /workbenchQueryKeys/);
    assert.match(querySource, /refetchInterval/);
  });
});
