import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { createInMemoryEventJournal } from '../../src/kernel/InMemoryEventJournal';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { OmsCore } from '../../src/oms/OmsCore';
import type { OmsOrder } from '../../src/oms/oms-types';
import {
  BinanceFuturesExecutionAdapter,
  toBinanceFuturesClientOrderId,
  type BinanceFuturesExecutionClient,
  type BinanceFuturesMarketOrderRequest,
  type BinanceFuturesMarketOrderResult,
} from '../../src/exchanges/binance-futures/BinanceFuturesExecutionAdapter';
import {
  createProductionSpine,
  reconcileRecoveredState,
  recoverAndStart,
} from '../../src/position/ProductionSpine';
import { evaluatePreTradeRisk } from '../../src/risk/PreTradeRiskGateway';
import { createApplicationProductionRuntimeOwner } from '../../src/runtime/production/ProductionRuntimeOwner';
import {
  DIRECT_MUTATION_SURFACES,
  setDirectMutationQuarantined,
} from '../../src/agents/handlers/direct-exchange-execution';
import { binanceHandlers } from '../../src/agents/handlers/binance';
import { bybitHandlers } from '../../src/agents/handlers/bybit';
import { opinionHandlers } from '../../src/agents/handlers/opinion';
import { predictfunHandlers } from '../../src/agents/handlers/predictfun';
import tradingFuturesSkill, {
  isTradingFuturesMutationCommand,
} from '../../src/skills/bundled/trading-futures/index';
import type { HandlerContext } from '../../src/agents/handlers/types';

const OMS_ORDER_ID = 'a'.repeat(64);

function order(patch: Partial<OmsOrder> = {}): OmsOrder {
  return {
    orderId: OMS_ORDER_ID,
    intentId: 'intent-l0',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    action: 'open',
    side: 'buy',
    orderType: 'market',
    approvedNotionalUsd: 100,
    ...patch,
  };
}

function client(
  submit: (request: BinanceFuturesMarketOrderRequest) => Promise<BinanceFuturesMarketOrderResult>,
  facts: { mark?: number; stepSize?: number; minQty?: number; minNotional?: number } = {},
): BinanceFuturesExecutionClient & { readonly requests: BinanceFuturesMarketOrderRequest[] } {
  const requests: BinanceFuturesMarketOrderRequest[] = [];
  return {
    requests,
    async getMarkPrice() { return facts.mark ?? 25; },
    async getInstrumentRules() {
      return {
        stepSize: facts.stepSize ?? 0.1,
        minQty: facts.minQty ?? 0.1,
        minNotional: facts.minNotional ?? 5,
      };
    },
    async submitMarketOrder(request) {
      requests.push(request);
      return submit(request);
    },
  };
}

function filled(request: BinanceFuturesMarketOrderRequest): BinanceFuturesMarketOrderResult {
  return {
    status: 'FILLED',
    clientOrderId: request.newClientOrderId,
    orderId: 'exchange-order-1',
    symbol: request.symbol,
    side: request.side,
    executedQty: request.quantity,
    averagePrice: 25,
    updatedAt: 1_000,
  };
}

const hardRisk = () => ({
  exchange: 'binance' as const,
  accountId: 'live-l0',
  enabled: true as const,
  locked: false,
  totalCapitalUsd: 1_000,
  maxSinglePositionPct: 0.1,
  maxSinglePositionAbsUsd: 100,
});

describe('Live L0 authoritative execution preparation', () => {
  it('preserves Paper defaults while limited-live uses only injected execution and truth ports', async () => {
    const paper = await createProductionSpine({ exchange: 'binance', hardRisk });
    assert.equal(paper.executionMode, 'paper');
    assert.ok(paper.service);

    let truthCalls = 0;
    const fakeClient = client(async request => filled(request));
    const limited = await createProductionSpine({
      exchange: 'binance',
      accountId: 'live-l0',
      hardRisk,
      journal: createInMemoryEventJournal(),
      execution: {
        mode: 'limited-live',
        adapter: new BinanceFuturesExecutionAdapter(fakeClient),
        truthPort: {
          async acquireTruth() {
            truthCalls += 1;
            return {
              identity: { exchange: 'binance', accountId: 'live-l0' },
              orders: [], fills: [], positions: [],
              capturedAt: 1,
              source: 'binance-futures-fake',
              complete: true,
            };
          },
        },
      },
    });
    assert.equal(limited.executionMode, 'limited-live');
    assert.equal(limited.service, null);
    assert.throws(() => limited.accounting.snapshot(), /ACCOUNTING_UNAVAILABLE_L0/);
    assert.throws(() => limited.accounting.lifecycle(), /LIFECYCLE_UNAVAILABLE_L0/);

    const recovered = await recoverAndStart(limited, limited.kernel.journal() as never);
    assert.equal(recovered.recoveryVerified, true);
    const report = await reconcileRecoveredState(limited);
    assert.equal(report.outcome, 'MATCH');
    assert.equal(truthCalls, 1);
  });

  it('keeps default application composition unable to activate a real client or create persistence', async () => {
    const journalPath = join(tmpdir(), `live-l0-not-created-${process.pid}.jsonl`);
    let journalCreations = 0;
    let persistenceCreations = 0;
    const owner = createApplicationProductionRuntimeOwner({
      enabled: true,
      mode: 'limited-live',
      exchange: 'binance',
      accountId: 'live-l0-default',
      journalPath,
      hardRisk: {
        enabled: true,
        locked: false,
        totalCapitalUsd: 1_000,
        maxSinglePositionPct: 0.1,
        maxSinglePositionAbsUsd: 100,
      },
      market: { entries: [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }] },
    }, {
      createJournal() { journalCreations += 1; throw new Error('unexpected journal'); },
      createPaperPersistence() { persistenceCreations += 1; throw new Error('unexpected persistence'); },
    });
    await assert.rejects(() => owner.start(), /LIVE_EXECUTION_NOT_ACTIVATED_L0/);
    assert.equal(journalCreations, 0);
    assert.equal(persistenceCreations, 0);
    assert.equal(existsSync(journalPath), false);
    assert.equal(owner.authoritativeSpine(), null);
    await owner.stop();

    const ownerSource = readFileSync('src/runtime/production/ProductionRuntimeOwner.ts', 'utf8');
    const adapterSource = readFileSync(
      'src/exchanges/binance-futures/BinanceFuturesExecutionAdapter.ts',
      'utf8',
    );
    assert.match(ownerSource, /createLimitedLiveExecution: \(\) => null/);
    assert.doesNotMatch(adapterSource, /process\.env|from ['"]binance['"]|USDMClient/);
  });

  it('passes an explicitly injected limited-live binding into the single owner spine seam', async () => {
    const binding = {
      adapter: new BinanceFuturesExecutionAdapter(client(async request => filled(request))),
      truthPort: {
        async acquireTruth() {
          return {
            identity: { exchange: 'binance' as const, accountId: 'live-l0-injected' },
            orders: [], fills: [], positions: [], capturedAt: 1,
            source: 'binance-futures-fake', complete: true,
          };
        },
      },
    };
    let capturedExecution: unknown;
    let persistenceCreations = 0;
    let resolverCalls = 0;
    const owner = createApplicationProductionRuntimeOwner({
      enabled: true,
      mode: 'limited-live',
      exchange: 'binance',
      accountId: 'live-l0-injected',
      journalPath: join(tmpdir(), `live-l0-injected-${process.pid}.jsonl`),
      hardRisk: {
        enabled: true,
        locked: false,
        totalCapitalUsd: 1_000,
        maxSinglePositionPct: 0.1,
        maxSinglePositionAbsUsd: 100,
      },
      market: { entries: [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }] },
    }, {
      createLimitedLiveExecution(identity) {
        resolverCalls += 1;
        assert.deepEqual(identity, { exchange: 'binance', accountId: 'live-l0-injected' });
        return binding;
      },
      createJournal() {
        return { close() {} } as never;
      },
      createPaperPersistence() {
        persistenceCreations += 1;
        throw new Error('paper persistence must remain absent');
      },
      createMarketRuntime() {
        return { stop() {} } as never;
      },
      async createSpine(config) {
        capturedExecution = config.execution;
        throw new Error('WIRING_CAPTURE_COMPLETE');
      },
    });
    await assert.rejects(() => owner.start(), /WIRING_CAPTURE_COMPLETE/);
    assert.equal(resolverCalls, 1);
    assert.equal(persistenceCreations, 0);
    assert.deepEqual(capturedExecution, { mode: 'limited-live', ...binding });
    await owner.stop();
  });

  it('derives a deterministic client order ID and normalizes approved notional through factual rules', async () => {
    const fake = client(async request => filled(request), { mark: 30, stepSize: 0.1 });
    const adapter = new BinanceFuturesExecutionAdapter(fake);
    const first = await adapter.submit(order());
    const second = await adapter.submit(order());
    assert.equal(first.status, 'filled');
    assert.equal(second.status, 'filled');
    assert.equal(fake.requests[0].newClientOrderId, toBinanceFuturesClientOrderId(OMS_ORDER_ID));
    assert.equal(fake.requests[1].newClientOrderId, fake.requests[0].newClientOrderId);
    assert.equal(fake.requests[0].quantity, 3.3);
    assert.equal(Number.isInteger(fake.requests[0].quantity * 10), true);
  });

  it('fails closed on missing facts, invalid step size, minimum quantity, and minimum notional', async () => {
    const missingMark = client(async request => filled(request));
    missingMark.getMarkPrice = async () => { throw new Error('unavailable'); };
    assert.deepEqual(await new BinanceFuturesExecutionAdapter(missingMark).submit(order()), {
      status: 'rejected', reason: 'MISSING_MARK_PRICE',
    });

    const missingRules = client(async request => filled(request));
    missingRules.getInstrumentRules = async () => { throw new Error('unavailable'); };
    assert.deepEqual(await new BinanceFuturesExecutionAdapter(missingRules).submit(order()), {
      status: 'rejected', reason: 'MISSING_INSTRUMENT_RULES',
    });

    for (const [facts, reason] of [
      [{ stepSize: 0 }, 'INVALID_STEP_SIZE'],
      [{ mark: 1_000, stepSize: 0.001, minQty: 1 }, 'BELOW_MIN_QTY'],
      [{ mark: 25, minNotional: 101 }, 'BELOW_MIN_NOTIONAL'],
      [{ mark: 1_000, stepSize: 1 }, 'NORMALIZED_QTY_ZERO'],
    ] as const) {
      const fake = client(async request => filled(request), facts);
      assert.deepEqual(await new BinanceFuturesExecutionAdapter(fake).submit(order()), {
        status: 'rejected', reason,
      });
      assert.equal(fake.requests.length, 0);
    }
  });

  it('sets reduceOnly for reduce, close, and emergency exit but never for open', async () => {
    for (const action of ['open', 'reduce', 'close', 'emergency_exit'] as const) {
      const fake = client(async request => filled(request));
      const result = await new BinanceFuturesExecutionAdapter(fake).submit(order({ action }));
      assert.equal(result.status, 'filled');
      assert.equal(fake.requests[0].reduceOnly, action !== 'open');
    }
  });

  it('maps transport ambiguity, malformed results, and partial fills to unknown without retry', async () => {
    const transport = client(async () => { throw new Error('timeout'); });
    assert.deepEqual(await new BinanceFuturesExecutionAdapter(transport).submit(order()), {
      status: 'unknown', reason: 'TRANSPORT_AMBIGUITY',
    });
    assert.equal(transport.requests.length, 1);

    const partial = client(async request => ({
      ...filled(request), status: 'PARTIALLY_FILLED', executedQty: request.quantity / 2,
    }));
    assert.deepEqual(await new BinanceFuturesExecutionAdapter(partial).submit(order()), {
      status: 'unknown', reason: 'PARTIAL_FILL_FULL_LIFECYCLE_REQUIRED',
    });

    const inconsistentFilled = client(async request => ({
      ...filled(request), executedQty: request.quantity / 2,
    }));
    assert.deepEqual(await new BinanceFuturesExecutionAdapter(inconsistentFilled).submit(order()), {
      status: 'unknown', reason: 'PARTIAL_FILL_FULL_LIFECYCLE_REQUIRED',
    });

    const malformed = client(async request => ({ ...filled(request), clientOrderId: 'wrong' }));
    assert.deepEqual(await new BinanceFuturesExecutionAdapter(malformed).submit(order()), {
      status: 'unknown', reason: 'MALFORMED_EXCHANGE_RESULT',
    });

    const omsClient = client(async () => { throw new Error('timeout'); });
    const oms = new OmsCore(createTradingKernel({ exchange: 'binance' }), new BinanceFuturesExecutionAdapter(omsClient));
    const intent = {
      intentId: 'unknown-once', exchange: 'binance' as const, symbol: 'BTCUSDT',
      direction: 'long' as const, orderType: 'market' as const, positionUsd: 100,
      source: 'test', createdAt: 1, reason: 'test', biasUpdatedAt: 1,
    };
    assert.equal((await oms.submitRequest(intent, 'open', 100)).status, 'submission_unknown');
    assert.equal((await oms.submitRequest(intent, 'open', 100)).status, 'duplicate');
    assert.equal(omsClient.requests.length, 1);
  });

  it('enforces one position and no scaling only for open actions in the existing risk gateway', () => {
    const common = {
      intent: {
        intentId: 'risk-l0', exchange: 'binance' as const, symbol: 'ETH/USDT',
        direction: 'long' as const, orderType: 'market' as const, positionUsd: 50,
        source: 'test', createdAt: 1, reason: 'test', biasUpdatedAt: 1,
      },
      marketSnapshot: {
        exchange: 'binance' as const, symbol: 'ETH/USDT', isStale: false,
        ticker: { ticker: { last: 25 } },
      } as never,
      policyResolution: {
        status: 'active' as const, allowNewEntries: true, directionBias: 'neutral' as const,
        maxPositionMultiplier: 1,
      } as never,
      hardRisk: hardRisk(),
      positionLimits: { maxConcurrentPositions: 1, openPositionCount: 1, allowScale: false },
    };
    const second = evaluatePreTradeRisk({
      ...common, action: 'open',
      positionResolution: { status: 'flat', side: 'flat', signedQuantity: 0, averageEntryPrice: 0, snapshot: null },
    });
    assert.deepEqual(second, { decision: 'REJECTED', reasonCode: 'POSITION_LIMIT_REACHED' });

    const noScale = evaluatePreTradeRisk({
      ...common, action: 'open',
      positionResolution: { status: 'open', side: 'long', signedQuantity: 2, averageEntryPrice: 25, snapshot: {} },
    } as never);
    assert.deepEqual(noScale, { decision: 'REJECTED', reasonCode: 'POSITION_LIMIT_REACHED' });

    const close = evaluatePreTradeRisk({
      ...common,
      action: 'close',
      intent: { ...common.intent, direction: 'short' },
      positionResolution: { status: 'open', side: 'long', signedQuantity: 2, averageEntryPrice: 25, snapshot: {} },
    } as never);
    assert.equal(close.decision, 'ADMITTED');
  });

  it('quarantines every reviewed Agent and Skill mutation while read-only paths remain available', async () => {
    const context = {} as HandlerContext;
    setDirectMutationQuarantined(true);
    try {
      assert.deepEqual(DIRECT_MUTATION_SURFACES, [
        'binance', 'bybit', 'opinion', 'predictfun', 'trading-futures',
      ]);
      for (const handler of [
        binanceHandlers.binance_futures_long,
        binanceHandlers.binance_futures_short,
        binanceHandlers.binance_futures_close,
        bybitHandlers.bybit_long,
        bybitHandlers.bybit_short,
        bybitHandlers.bybit_close,
        opinionHandlers.opinion_place_order,
        opinionHandlers.opinion_cancel_order,
        opinionHandlers.opinion_cancel_all_orders,
        opinionHandlers.opinion_redeem,
        opinionHandlers.opinion_enable_trading,
        opinionHandlers.opinion_split,
        opinionHandlers.opinion_merge,
        predictfunHandlers.predictfun_create_order,
        predictfunHandlers.predictfun_cancel_orders,
        predictfunHandlers.predictfun_redeem_positions,
        predictfunHandlers.predictfun_merge_positions,
        predictfunHandlers.predictfun_set_approvals,
      ]) {
        const result = await handler({}, context);
        assert.match(result, /quarantined/i);
      }

      for (const command of [
        'open', 'long', 'short', 'close', 'closeall', 'close-all', 'limit',
        'stop', 'sl', 'tp', 'cancel', 'cancelall', 'leverage', 'margin',
      ]) {
        assert.equal(isTradingFuturesMutationCommand(command), true, command);
        assert.match(await tradingFuturesSkill.handle(command), /quarantined/i, command);
      }
      for (const command of [
        'positions', 'orders', 'balance', 'account', 'price', 'book', 'markets',
        'funding', 'pnl', 'history', 'trades', 'orderhistory', 'exchanges', 'help',
      ]) {
        assert.equal(isTradingFuturesMutationCommand(command), false, command);
      }
      assert.doesNotMatch(await tradingFuturesSkill.handle('help'), /quarantined/i);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({
        code: 0, success: true, result: [], data: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      try {
        assert.doesNotMatch(await opinionHandlers.opinion_markets({}, context), /quarantined/i);
        assert.doesNotMatch(await predictfunHandlers.predictfun_markets({}, context), /quarantined/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      setDirectMutationQuarantined(false);
    }
  });
});
