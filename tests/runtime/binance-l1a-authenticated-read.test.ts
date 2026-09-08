import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  createBinanceAuthenticatedReadFoundation,
  evaluateBinanceNewEntryReadiness,
  type BinanceAuthenticatedReadClient,
  type BinanceAuthenticatedReadBindings,
  type BinanceRawAccount,
  type BinanceRawInstrumentRules,
  type BinanceRawMarkPrice,
} from '../../src/runtime/binance/BinanceAuthenticatedReadFoundation';
import { createApplicationProductionRuntimeOwner } from '../../src/runtime/production/ProductionRuntimeOwner';
import { createProductionSpine } from '../../src/position/ProductionSpine';

const identity = Object.freeze({ exchange: 'binance' as const, accountId: 'l1a-test' });

function account(overrides: Partial<BinanceRawAccount> = {}): BinanceRawAccount {
  return {
    balances: [
      { asset: 'USDT', walletBalance: '125.50', availableBalance: '100.25' },
      { asset: 'USDC', walletBalance: '0', availableBalance: '0' },
    ],
    positions: [
      {
        symbol: 'BTCUSDT', positionAmt: '0.02', entryPrice: '50000', markPrice: '51000',
        unrealizedProfit: '20', marginType: 'isolated', leverage: '5', updateTime: 9_700,
      },
      {
        symbol: 'ETHUSDT', positionAmt: '-0.5', entryPrice: '3000', markPrice: '2900',
        unrealizedProfit: '50', marginType: 'cross', leverage: '3', updateTime: 9_800,
      },
    ],
    updateTime: 9_900,
    sequence: 42,
    ...overrides,
  };
}

function client(overrides: Partial<BinanceAuthenticatedReadClient> = {}): BinanceAuthenticatedReadClient {
  return {
    async getServerTime() { return 10_000; },
    async getAccount() { return account(); },
    async getOpenOrders() {
      return [{
        orderId: 7,
        clientOrderId: 'client-7',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'BOTH',
        type: 'LIMIT',
        status: 'NEW',
        price: '49000',
        origQty: '0.01',
        executedQty: '0',
        reduceOnly: false,
        updateTime: 9_850,
      }];
    },
    async getRecentFills() {
      return [{
        id: 8,
        orderId: 6,
        symbol: 'ETHUSDT',
        side: 'SELL',
        price: '3000',
        qty: '0.5',
        quoteQty: '1500',
        commission: '0.6',
        commissionAsset: 'USDT',
        time: 9_800,
      }];
    },
    async getMarkPrice(symbol) { return { symbol, markPrice: '51000', time: 9_900 }; },
    async getInstrumentRules(symbol) {
      return { symbol, tickSize: '0.1', stepSize: '0.001', minQty: '0.001', minNotional: '5', status: 'TRADING' };
    },
    ...overrides,
  };
}

function bindings(
  readClient: BinanceAuthenticatedReadClient,
  overrides: Partial<BinanceAuthenticatedReadBindings> = {},
): BinanceAuthenticatedReadBindings {
  return {
    secretProvider: {
      async getReadCredentials() { return { apiKey: 'fake-api-key', secretKey: 'fake-secret-key' }; },
    },
    clientFactory: { create: () => readClient },
    now: () => 10_000,
    staleAfterMs: 1_000,
    ...overrides,
  };
}

describe('Binance L1A authenticated read foundation', () => {
  it('defaults to unconfigured/unconnected and missing account truth is not a flat account', async () => {
    const foundation = createBinanceAuthenticatedReadFoundation(identity);
    assert.deepEqual(foundation.status(), {
      configured: false,
      connected: false,
      identity,
      lastObservedAt: null,
      reason: 'BINANCE_AUTH_READ_NOT_CONFIGURED',
      realClientDefaultWired: false,
      realCredentialDiscovery: false,
    });
    const missing = await foundation.accountTruth.read();
    assert.equal(missing.availability, 'UNAVAILABLE');
    assert.equal(missing.value, null);
    assert.notEqual(missing.value?.accountState, 'FLAT');
  });

  it('requires explicitly injected credentials and never sends absent credentials to a client factory', async () => {
    let factoryCalls = 0;
    const foundation = createBinanceAuthenticatedReadFoundation(identity, bindings(client(), {
      secretProvider: { async getReadCredentials() { return null; } },
      clientFactory: { create() { factoryCalls += 1; return client(); } },
    }));
    assert.equal(foundation.status().configured, true);
    const unavailable = await foundation.accountTruth.read();
    assert.equal(unavailable.availability, 'UNAVAILABLE');
    assert.equal(unavailable.reason, 'BINANCE_READ_CREDENTIALS_UNAVAILABLE');
    assert.equal(factoryCalls, 0);
    assert.equal(foundation.status().connected, false);
  });

  it('preserves zero balances, position signs, margin/leverage, orders, fills and exchange timestamps', async () => {
    const foundation = createBinanceAuthenticatedReadFoundation(identity, bindings(client()));
    const observed = await foundation.accountTruth.read();
    assert.equal(observed.availability, 'AVAILABLE');
    assert.ok(observed.value);
    assert.equal(observed.value.accountState, 'OPEN');
    assert.equal(observed.value.balances[1].walletBalance, 0, 'zero is a factual value, not missing');
    assert.deepEqual(observed.value.positions.map((position) => ({
      symbol: position.symbol,
      quantity: position.quantity,
      side: position.side,
      marginMode: position.marginMode,
      leverage: position.leverage,
    })), [
      { symbol: 'BTCUSDT', quantity: 0.02, side: 'LONG', marginMode: 'ISOLATED', leverage: 5 },
      { symbol: 'ETHUSDT', quantity: -0.5, side: 'SHORT', marginMode: 'CROSS', leverage: 3 },
    ]);
    assert.deepEqual(observed.value.openOrders[0], {
      orderId: '7', clientOrderId: 'client-7', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH',
      type: 'LIMIT', status: 'NEW', price: 49_000, originalQuantity: 0.01,
      executedQuantity: 0, reduceOnly: false, updatedAt: 9_850,
    });
    assert.deepEqual(observed.value.recentFills[0], {
      fillId: '8', orderId: '6', symbol: 'ETHUSDT', side: 'SELL', price: 3_000,
      quantity: 0.5, quoteQuantity: 1_500, commission: 0.6,
      commissionAsset: 'USDT', executedAt: 9_800,
    });
    assert.equal(observed.value.serverTime, 10_000);
    assert.equal(observed.value.accountUpdateTime, 9_900);
    assert.equal(observed.value.observedAt, 10_000);
    assert.deepEqual(observed.value.freshness, { status: 'FRESH', ageMs: 100, staleAfterMs: 1_000 });
    assert.equal(observed.value.sequence, '42');
    assert.equal(foundation.status().connected, true);
    assert.equal(foundation.status().lastObservedAt, 10_000);
    assert.doesNotMatch(JSON.stringify({ observed, status: foundation.status() }), /fake-api-key|fake-secret-key/);
  });

  it('distinguishes a factual flat account from missing balances or positions', async () => {
    const flat = createBinanceAuthenticatedReadFoundation(identity, bindings(client({
      async getAccount() { return account({ balances: [], positions: [] }); },
    })));
    const flatResult = await flat.accountTruth.read();
    assert.equal(flatResult.availability, 'AVAILABLE');
    assert.equal(flatResult.value?.accountState, 'FLAT');
    assert.deepEqual(flatResult.value?.balances, []);

    for (const missing of [account({ balances: undefined }), account({ positions: undefined })]) {
      const unknown = createBinanceAuthenticatedReadFoundation(identity, bindings(client({
        async getAccount() { return missing; },
      })));
      const unknownResult = await unknown.accountTruth.read();
      assert.equal(unknownResult.availability, 'UNKNOWN');
      assert.equal(unknownResult.value, null);
      assert.equal(unknownResult.reason, 'ACCOUNT_TRUTH_MISSING');
    }
  });

  it('preserves instrument rules and marks stale price facts without inventing exchange time', async () => {
    const fresh = createBinanceAuthenticatedReadFoundation(identity, bindings(client()));
    const freshResult = await fresh.instrumentFacts.read('btcusdt');
    assert.equal(freshResult.availability, 'AVAILABLE');
    assert.deepEqual(freshResult.value, {
      symbol: 'BTCUSDT',
      markPrice: 51_000,
      tickSize: 0.1,
      stepSize: 0.001,
      minQty: 0.001,
      minNotional: 5,
      contractStatus: 'TRADING',
      serverTime: 10_000,
      markPriceTime: 9_900,
      observedAt: 10_000,
      freshness: { status: 'FRESH', ageMs: 100, staleAfterMs: 1_000 },
      source: 'BINANCE_FUTURES_API',
      schemaVersion: 'BINANCE_L1A_V1',
    });

    const staleMark: BinanceRawMarkPrice = { symbol: 'BTCUSDT', markPrice: '51000', time: 1_000 };
    const stale = createBinanceAuthenticatedReadFoundation(identity, bindings(client({
      async getMarkPrice() { return staleMark; },
    })));
    const staleResult = await stale.instrumentFacts.read('BTCUSDT');
    assert.equal(staleResult.value?.freshness.status, 'STALE');
    assert.equal(staleResult.value?.markPriceTime, 1_000);
    assert.ok(evaluateBinanceNewEntryReadiness(await fresh.accountTruth.read(), staleResult)
      .blockers.includes('MARK_PRICE_STALE'));

    const noTimestamp = createBinanceAuthenticatedReadFoundation(identity, bindings(client({
      async getMarkPrice(symbol) { return { symbol, markPrice: '51000' }; },
    })));
    const unknownFreshness = await noTimestamp.instrumentFacts.read('BTCUSDT');
    assert.equal(unknownFreshness.value?.markPriceTime, null);
    assert.equal(unknownFreshness.value?.freshness.status, 'UNKNOWN');
  });

  it('fails closed when exchange rules are missing without blocking close/reduce by entry freshness', async () => {
    const foundation = createBinanceAuthenticatedReadFoundation(identity, bindings(client({
      async getInstrumentRules(): Promise<BinanceRawInstrumentRules | null> { return null; },
    })));
    const accountResult = await foundation.accountTruth.read();
    const rulesResult = await foundation.instrumentFacts.read('BTCUSDT');
    assert.equal(rulesResult.availability, 'UNKNOWN');
    assert.equal(rulesResult.reason, 'MARKET_RULES_UNKNOWN');
    const readiness = evaluateBinanceNewEntryReadiness(accountResult, rulesResult);
    assert.equal(readiness.safeToOpen, false);
    assert.ok(readiness.blockers.includes('MARKET_RULES_UNKNOWN'));
    assert.equal(readiness.closeOrReduceBlockedByEntryFreshness, false);
  });

  it('treats unavailable account truth as unsafe to open and requires no mutation client methods', async () => {
    const readClient = client();
    assert.deepEqual(Object.keys(readClient).sort(), [
      'getAccount', 'getInstrumentRules', 'getMarkPrice', 'getOpenOrders', 'getRecentFills', 'getServerTime',
    ]);
    assert.equal(Object.keys(readClient).some((name) => /submit|order|cancel|modify|leverage|margin/i.test(name)
      && name !== 'getOpenOrders'), false);
    const unavailable = createBinanceAuthenticatedReadFoundation(identity);
    const fresh = createBinanceAuthenticatedReadFoundation(identity, bindings(readClient));
    const readiness = evaluateBinanceNewEntryReadiness(
      await unavailable.accountTruth.read(),
      await fresh.instrumentFacts.read('BTCUSDT'),
    );
    assert.equal(readiness.safeToOpen, false);
    assert.ok(readiness.blockers.includes('ACCOUNT_TRUTH_UNKNOWN'));
  });

  it('composition defaults to no real client and preserves Paper/non-activation behavior', async () => {
    const owner = createApplicationProductionRuntimeOwner(undefined);
    assert.deepEqual(owner.read.binanceAuthenticatedReadStatus(), owner.binanceAuthenticatedRead.status());
    assert.equal(owner.read.binanceAuthenticatedReadStatus().configured, false);
    assert.equal(owner.read.binanceAuthenticatedReadStatus().connected, false);
    const configuredOwner = createApplicationProductionRuntimeOwner({
      enabled: true,
      mode: 'paper',
      exchange: 'binance',
      accountId: 'l1a-test',
      journalPath: resolve(process.cwd(), '.l1a-test-unused', 'journal.jsonl'),
      paperLedgerDir: resolve(process.cwd(), '.l1a-test-unused', 'paper'),
      initialCashUsd: 1_000,
      hardRisk: {
        enabled: true, locked: false, totalCapitalUsd: 1_000,
        maxSinglePositionPct: 0.1, maxSinglePositionAbsUsd: 100,
      },
      market: {
        entries: [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }],
      },
    });
    assert.deepEqual(configuredOwner.read.binanceAuthenticatedReadStatus().identity, identity);
    assert.equal(configuredOwner.read.binanceAuthenticatedReadStatus().configured, false);
    assert.equal(configuredOwner.read.binanceAuthenticatedReadStatus().connected, false);
    const paper = await createProductionSpine({
      exchange: 'binance',
      accountId: 'l1a-test',
      hardRisk: () => ({
        exchange: 'binance', accountId: 'l1a-test', enabled: true, locked: false,
        totalCapitalUsd: 1_000, maxSinglePositionPct: 0.1, maxSinglePositionAbsUsd: 100,
      }),
    });
    assert.equal(paper.executionMode, 'paper');
    assert.equal(paper.protection.getMode(), 'replay');
    assert.equal(paper.oms.getStore().list().length, 0);
  });

  it('contains no implicit credential discovery, real client construction, logging, or exchange-truth clock fabrication', () => {
    const source = readFileSync(resolve(
      process.cwd(), 'src/runtime/binance/BinanceAuthenticatedReadFoundation.ts',
    ), 'utf8');
    assert.doesNotMatch(source, /process\.env|Date\.now|logger|console\.|new\s+USDMClient|submitMarketOrder|cancelOrder/);
    const ownerSource = readFileSync(resolve(
      process.cwd(), 'src/runtime/production/ProductionRuntimeOwner.ts',
    ), 'utf8');
    assert.match(ownerSource, /createLimitedLiveExecution: \(\) => null/);
  });
});
