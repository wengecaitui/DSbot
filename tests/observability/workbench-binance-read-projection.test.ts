import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ProductionSpine } from '../../src/position/ProductionSpine';
import type {
  BinanceAccountTruthSnapshot,
  BinanceAuthenticatedReadFoundation,
  BinanceInstrumentFactsSnapshot,
  BinanceReadAvailability,
  BinanceReadResult,
} from '../../src/runtime/binance/BinanceAuthenticatedReadFoundation';
import { createServer } from '../../src/gateway/server';
import { createWorkbenchRouter } from '../../src/gateway/workbench-routes';
import { createWorkbenchReadAdapter } from '../../src/observability/workbench-read-adapter';
import { getFreePort } from '../hermes/helpers';

const accountSnapshot: BinanceAccountTruthSnapshot = Object.freeze({
  identity: Object.freeze({ exchange: 'binance', accountId: 'u2-fixture' }),
  accountState: 'OPEN',
  balances: Object.freeze([{ asset: 'USDT', walletBalance: 125.5, availableBalance: 100.25 }]),
  positions: Object.freeze([{
    symbol: 'BTCUSDT', quantity: 0.02, side: 'LONG', entryPrice: 50_000,
    markPrice: 51_000, unrealizedPnl: 20, marginMode: 'ISOLATED', leverage: 5, updatedAt: 9_700,
  }]),
  openOrders: Object.freeze([{
    orderId: '7', clientOrderId: 'client-7', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH',
    type: 'LIMIT', status: 'NEW', price: 49_000, originalQuantity: 0.01,
    executedQuantity: 0, reduceOnly: false, updatedAt: 9_850,
  }]),
  recentFills: Object.freeze([{
    fillId: '8', orderId: '6', symbol: 'ETHUSDT', side: 'SELL', price: 3_000,
    quantity: 0.5, quoteQuantity: 1_500, commission: 0.6, commissionAsset: 'USDT', executedAt: 9_800,
  }]),
  serverTime: 10_000,
  accountUpdateTime: 9_900,
  observedAt: 10_000,
  freshness: Object.freeze({ status: 'FRESH', ageMs: 100, staleAfterMs: 1_000 }),
  source: 'BINANCE_FUTURES_API',
  schemaVersion: 'BINANCE_L1A_V1',
  sequence: '42',
});

function instrumentSnapshot(symbol: string, freshness: 'FRESH' | 'STALE' = 'FRESH'): BinanceInstrumentFactsSnapshot {
  return Object.freeze({
    symbol, markPrice: symbol === 'BTCUSDT' ? 51_000 : 2_900,
    tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5,
    contractStatus: 'TRADING', serverTime: 10_000, markPriceTime: freshness === 'FRESH' ? 9_900 : 1_000,
    observedAt: 10_000,
    freshness: Object.freeze({ status: freshness, ageMs: freshness === 'FRESH' ? 100 : 9_000, staleAfterMs: 1_000 }),
    source: 'BINANCE_FUTURES_API', schemaVersion: 'BINANCE_L1A_V1',
  });
}

function result<T>(availability: BinanceReadAvailability, value: T | null, reason: any = null): BinanceReadResult<T> {
  return Object.freeze({ availability, value, reason });
}

function spine(markets: Array<{ exchange: string; symbol: string }>): ProductionSpine {
  return { marketStore: { getAllSnapshots: () => markets } } as unknown as ProductionSpine;
}

function foundation(options: {
  account?: BinanceReadResult<BinanceAccountTruthSnapshot>;
  instrument?: (symbol: string) => BinanceReadResult<BinanceInstrumentFactsSnapshot>;
  instrumentCalls?: string[];
  accountCalls?: { value: number };
  configured?: boolean;
  connected?: boolean;
} = {}): BinanceAuthenticatedReadFoundation {
  return {
    accountTruth: { async read() { if (options.accountCalls) options.accountCalls.value += 1; return options.account ?? result('AVAILABLE', accountSnapshot); } },
    instrumentFacts: { async read(symbol) { options.instrumentCalls?.push(symbol); return options.instrument?.(symbol) ?? result('AVAILABLE', instrumentSnapshot(symbol)); } },
    status: () => Object.freeze({
      configured: options.configured ?? true,
      connected: options.connected ?? true,
      identity: Object.freeze({ exchange: 'binance', accountId: 'u2-fixture' }),
      lastObservedAt: 10_000,
      reason: null,
      realClientDefaultWired: false,
      realCredentialDiscovery: false,
    }),
  };
}

function adapter(readFoundation: BinanceAuthenticatedReadFoundation, markets: Array<{ exchange: string; symbol: string }>) {
  return createWorkbenchReadAdapter({
    now: () => 10_000,
    runtime: () => ({ health: 'UNKNOWN', environment: 'unknown', mode: null }),
    hermes: () => null,
    productionSpine: () => spine(markets),
    binanceAuthenticatedRead: () => readFoundation,
  });
}

describe('Workbench U2 Binance exchange-observation projection', () => {
  it('preserves available account, balances, positions, orders, fills and instrument rules exactly', async () => {
    const calls: string[] = [];
    const read = adapter(foundation({
      instrumentCalls: calls,
      instrument: (symbol) => result('AVAILABLE', instrumentSnapshot(symbol, symbol === 'ETHUSDT' ? 'STALE' : 'FRESH')),
    }), [
      { exchange: 'binance', symbol: 'ETHUSDT' },
      { exchange: 'bitget', symbol: 'IGNORED' },
      { exchange: 'binance', symbol: 'BTCUSDT' },
      { exchange: 'binance', symbol: 'ETHUSDT' },
    ]);
    const projected = await read.binanceRead();
    assert.equal(projected.availability, 'AVAILABLE');
    assert.equal(projected.freshness, 'STALE');
    assert.deepEqual(projected.data?.account.data, {
      accountState: accountSnapshot.accountState,
      balances: accountSnapshot.balances,
      positions: accountSnapshot.positions,
      openOrders: accountSnapshot.openOrders,
      recentFills: accountSnapshot.recentFills,
      serverTime: accountSnapshot.serverTime,
      accountUpdateTime: accountSnapshot.accountUpdateTime,
      observedAt: accountSnapshot.observedAt,
      freshness: accountSnapshot.freshness,
      source: accountSnapshot.source,
      schemaVersion: accountSnapshot.schemaVersion,
      sequence: accountSnapshot.sequence,
    });
    assert.deepEqual(projected.data?.account.data?.balances, accountSnapshot.balances);
    assert.deepEqual(projected.data?.account.data?.positions, accountSnapshot.positions);
    assert.deepEqual(projected.data?.account.data?.openOrders, accountSnapshot.openOrders);
    assert.deepEqual(projected.data?.account.data?.recentFills, accountSnapshot.recentFills);
    assert.deepEqual(calls, ['BTCUSDT', 'ETHUSDT'], 'canonical symbols are unique and deterministic');
    assert.deepEqual(projected.data?.instruments.data?.map((item) => item.requestedSymbol), calls);
    assert.deepEqual(projected.data?.instruments.data?.[0].observation.data, instrumentSnapshot('BTCUSDT'));
    assert.equal(projected.data?.instruments.data?.[1].observation.freshness, 'STALE');
    assert.equal(projected.data?.canonicalReconciliationEstablished, false);
  });

  it('preserves UNAVAILABLE and UNKNOWN as data=null and never fabricates FLAT or zero', async () => {
    for (const availability of ['UNAVAILABLE', 'UNKNOWN'] as const) {
      const projected = await adapter(foundation({
        account: result(availability, null, availability === 'UNAVAILABLE' ? 'BINANCE_AUTH_READ_NOT_CONFIGURED' : 'ACCOUNT_TRUTH_MISSING'),
        instrument: () => result(availability, null, 'MARK_PRICE_UNKNOWN'),
      }), [{ exchange: 'binance', symbol: 'BTCUSDT' }]).binanceRead();
      const account = projected.data?.account;
      const instrument = projected.data?.instruments.data?.[0].observation;
      assert.equal(account?.availability, availability);
      assert.equal(account?.freshness, 'UNKNOWN');
      assert.equal(account?.data, null);
      assert.notEqual(account?.data?.accountState, 'FLAT');
      assert.equal(instrument?.data, null);
      assert.notEqual(instrument?.data?.markPrice, 0);
      assert.doesNotMatch(JSON.stringify(projected), /"walletBalance":0|"quantity":0|"markPrice":0/);
    }
  });

  it('displays FLAT only when the available source snapshot explicitly says FLAT', async () => {
    const explicitFlat = Object.freeze({ ...accountSnapshot, accountState: 'FLAT' as const, positions: Object.freeze([]) });
    const projected = await adapter(foundation({ account: result('AVAILABLE', explicitFlat) }), [
      { exchange: 'binance', symbol: 'BTCUSDT' },
    ]).binanceRead();
    assert.equal(projected.data?.account.data?.accountState, 'FLAT');
  });

  it('does not call instrumentFacts without a canonical Binance symbol source', async () => {
    const calls: string[] = [];
    const projected = await adapter(foundation({ instrumentCalls: calls }), [
      { exchange: 'bitget', symbol: 'BTCUSDT' },
    ]).binanceRead();
    assert.deepEqual(calls, []);
    assert.equal(projected.data?.instruments.availability, 'UNAVAILABLE');
    assert.equal(projected.data?.instruments.data, null);
    assert.equal(projected.data?.instruments.reason, 'CANONICAL_BINANCE_SYMBOL_SOURCE_UNAVAILABLE');
  });

  it('keeps capability dimensions independent and serialized output credential-free', async () => {
    const projected = await adapter(foundation({ configured: false, connected: false }), [
      { exchange: 'binance', symbol: 'BTCUSDT' },
    ]).binanceRead();
    assert.deepEqual(projected.data?.status, {
      implemented: true, configured: false, connected: false, lastObservedAt: 10_000, reason: null,
      realClientDefaultWired: false, realCredentialDiscovery: false,
      readVerified: false, writeRouted: false, activated: false,
    });
    const serialized = JSON.stringify(projected);
    assert.doesNotMatch(serialized, /"(?:apiKey|secretKey|Authorization|credentials|credentialObject)"\s*:|BINANCE_API|fake-secret/i);
    assert.doesNotMatch(serialized, /u2-fixture|accountId/);
  });

  it('awaits the GET-only endpoint and mutation methods cannot invoke Binance reads', async () => {
    const accountCalls = { value: 0 };
    const instrumentCalls: string[] = [];
    const read = adapter(foundation({ accountCalls, instrumentCalls }), [{ exchange: 'binance', symbol: 'BTCUSDT' }]);
    const router = createWorkbenchRouter(read);
    const routeMethods = (router as any).stack.filter((layer: any) => layer.route)
      .flatMap((layer: any) => Object.keys(layer.route.methods));
    assert.ok(routeMethods.every((method: string) => method === 'get'));

    const originalToken = process.env.CLODDS_TOKEN;
    delete process.env.CLODDS_TOKEN;
    const port = await getFreePort();
    const server = createServer({ port, cors: false, auth: {} });
    server.setWorkbenchRouter(router);
    await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workbench/v1/binance-read`);
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.data.account.data.accountState, 'OPEN');
      assert.equal(accountCalls.value, 1);
      assert.deepEqual(instrumentCalls, ['BTCUSDT']);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const blocked = await fetch(`http://127.0.0.1:${port}/api/workbench/v1/binance-read`, { method });
        assert.equal(blocked.status, 405);
      }
      assert.equal(accountCalls.value, 1);
      assert.deepEqual(instrumentCalls, ['BTCUSDT']);
    } finally {
      await server.stop();
      if (originalToken === undefined) delete process.env.CLODDS_TOKEN;
      else process.env.CLODDS_TOKEN = originalToken;
    }
  });

  it('contains no Q0 receipt, credential discovery, network client, or mutation surface', () => {
    const files = [
      'src/observability/workbench-contract.ts',
      'src/observability/workbench-read-adapter.ts',
      'src/gateway/workbench-routes.ts',
      'web/src/api/types.ts',
      'web/src/api/client.ts',
      'web/src/api/queries.ts',
      'web/src/App.tsx',
    ];
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    assert.doesNotMatch(source, /BinanceOfflineQualificationReceipt/);
    assert.doesNotMatch(source, /process\.env|dotenv|secretKey|BINANCE_API|axios|https\.request|WebSocket/);
    assert.doesNotMatch(source, /\b(?:submitOrder|placeOrder|cancelOrder|modifyOrder|setLeverage|setMarginMode)\s*\(/);
    assert.match(readFileSync('web/src/api/queries.ts', 'utf8'), /binanceRead:.*retry: false/);
  });
});
