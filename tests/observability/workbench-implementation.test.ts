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
    privateConfig: { hardRisk: () => ({
      exchange: 'bitget', accountId: 'paper-1', enabled: true, locked: false,
      totalCapitalUsd: 1_000, maxSinglePositionPct: 0.1, maxSinglePositionAbsUsd: 100,
    }) },
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
    const entrySource = readFileSync('web/index.html', 'utf8');
    const mainSource = readFileSync('web/src/main.tsx', 'utf8');

    assert.match(appSource, /workbenchQueries/);
    assert.doesNotMatch(appSource, /\bfetch\s*\(/);
    assert.match(clientSource, /method:\s*'GET'/);
    assert.doesNotMatch(clientSource, /method:\s*'(?:POST|PUT|PATCH|DELETE)'/);
    assert.match(clientSource, /\/api\/workbench\/v1/);
    assert.match(querySource, /workbenchQueryKeys/);
    assert.match(querySource, /refetchInterval/);
    assert.match(appSource, /Connecting to \{label\}/);
    assert.match(appSource, /role="alert"/);
    assert.match(entrySource, /class="boot-screen"/);
    assert.match(entrySource, /application gateway URL ending in \/workbench\//);
    assert.match(mainSource, /WorkbenchErrorBoundary/);
    assert.match(mainSource, /WORKBENCH RENDER FAILED/);
    assert.match(clientSource, /Authentication is required/);
    assert.match(clientSource, /standalone frontend preview/);
  });

  it('provides an AI-key-independent preview without mounting a production runtime', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const previewSource = readFileSync('src/bin/workbench-server.ts', 'utf8');

    assert.match(packageJson.scripts['workbench:serve'], /dist\/bin\/workbench-server\.js/);
    assert.match(previewSource, /mode: 'read-only-preview'/);
    assert.match(previewSource, /hermes: \(\) => null/);
    assert.doesNotMatch(previewSource, /createProductionSpine|new ProductionSpine/);
    assert.doesNotMatch(previewSource, /ANTHROPIC_API_KEY/);
  });
});

describe('UI-U0/U1 trusted terminal presentation contract', () => {
  const appSource = readFileSync('web/src/App.tsx', 'utf8');
  const primitiveSource = readFileSync('web/src/components/Primitives.tsx', 'utf8');
  const stylesSource = readFileSync('web/src/styles.css', 'utf8');

  it('preserves route IDs while presenting operations as Evidence', () => {
    for (const route of ['overview', 'market', 'trading', 'research', 'policy', 'safety', 'operations', 'data', 'settings']) {
      assert.match(appSource, new RegExp(`id: '${route}'`));
    }
    assert.match(appSource, /id: 'operations', label: 'Evidence'/);
    assert.match(appSource, /next === 'overview' \? '\/workbench\/' : `\/workbench\/\$\{next\}`/);
  });

  it('keeps the UI read-only and renders future execution only as locked architecture', () => {
    assert.match(appSource, /Execution control surface/);
    assert.match(appSource, /<LockedControl/);
    assert.match(appSource, /ProductionSpine → PreTradeRiskGateway → OMS → ExecutionAdapter/);
    assert.doesNotMatch(appSource, /<button[^>]*>\s*(?:BUY|SELL|Buy|Sell|Place order|Cancel order)/);
    assert.doesNotMatch(appSource, /\b(?:submitOrder|placeOrder|cancelOrder|setLiveReady|activateLiveReadiness)\s*\(/);
  });

  it('renders unavailable and missing states without inventing flat or financial values', () => {
    assert.match(appSource, /CHART SOURCE UNAVAILABLE/);
    assert.match(appSource, /missing ≠ flat/);
    assert.match(appSource, /No observed position is not evidence of a flat account/);
    assert.match(appSource, /TickFlow operationalization is not claimed/);
    assert.match(appSource, /formatMoney\(account\?\.equityUsd\)/);
    assert.doesNotMatch(appSource, /(?:Equity|PnL|exposure)[^\n]{0,80}value=(?:"|\{)\s*[-+]?\d/);
  });

  it('never paints stale, unknown, unavailable, or locked states as verified green', () => {
    const factualGoodBranch = primitiveSource.match(/if \(\[(.*?)\]\.includes\(value\)\) return 'good';/s)?.[1] ?? '';
    assert.doesNotMatch(factualGoodBranch, /STALE|UNKNOWN|UNAVAILABLE|LOCKED|OBSERVED/);
    assert.match(primitiveSource, /return 'neutral'/);
    assert.match(stylesSource, /\.tone-good \{ color: var\(--green\)/);
    assert.match(stylesSource, /\.tone-info \{ color: var\(--cyan\)/);
  });

  it('separates observed, verified, and authorized evidence states', () => {
    assert.match(appSource, />OBSERVED</);
    assert.match(appSource, />VERIFIED</);
    assert.match(appSource, />AUTHORIZED</);
    assert.match(appSource, /CI success cannot stand in for Phase 10 verification/);
    assert.match(appSource, /Phase 10 cannot activate Live/);
    assert.match(appSource, /NOT_AUTHORIZED/);
    assert.match(appSource, /NOT_ACTIVATED/);
  });

  it('keeps the research evidence skeleton visible when upstream data is absent', () => {
    const researchPage = appSource.slice(
      appSource.indexOf('function ResearchPage'),
      appSource.indexOf('function PolicyPage'),
    );

    assert.match(researchPage, /const data = query\.data\?\.data/);
    assert.doesNotMatch(researchPage, /<EnvelopeFrame/);
    assert.match(researchPage, /No canonical dataset dictionary is exposed/);
    assert.match(researchPage, /NOT IMPLEMENTED \/ NOT VERIFIED/);
  });

  it('keeps capability dimensions independent and missing evidence unknown', () => {
    for (const heading of ['Implemented', 'Configured', 'Connected', 'Read Verified', 'Write Routed', 'Activated']) {
      assert.match(primitiveSource, new RegExp(`<th>${heading}<\\/th>`));
    }
    assert.match(appSource, /readVerified: 'UNKNOWN'/);
    assert.match(appSource, /writeRouted: 'LOCKED'/);
    assert.match(appSource, /activated: 'NOT_ACTIVATED'/);
    assert.doesNotMatch(appSource, /readVerified: data \?/);
  });

  it('places chart and pre-trade risk in distinct rows at the narrower desktop breakpoint', () => {
    const narrowerDesktop = stylesSource.slice(
      stylesSource.indexOf('@media (max-width: 1180px)'),
      stylesSource.indexOf('@media (max-width: 820px)'),
    );

    assert.match(narrowerDesktop, /\.trading-chart\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/s);
    assert.match(narrowerDesktop, /\.trading-risk\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/s);
    assert.doesNotMatch(narrowerDesktop, /\.trading-chart,\s*\.trading-risk\s*\{/);
    assert.match(stylesSource, /\.trading-watchlist \.availability-notice\s*\{[^}]*flex-direction:\s*column;/s);
    assert.match(stylesSource, /\.trading-watchlist \.availability-notice p\s*\{[^}]*text-align:\s*left;/s);
  });
});
