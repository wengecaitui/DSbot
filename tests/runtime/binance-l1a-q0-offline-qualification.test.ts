import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  createBinanceAuthenticatedReadFoundation,
  evaluateBinanceNewEntryReadiness,
  type BinanceAuthenticatedReadBindings,
  type BinanceAuthenticatedReadClient,
  type BinanceRawAccount,
  type BinanceRawInstrumentRules,
} from '../../src/runtime/binance/BinanceAuthenticatedReadFoundation';
import {
  BINANCE_L1A_READ_CLIENT_METHODS,
  createBinanceOfflineQualificationReceipt,
  type BinanceOfflineQualificationEvidence,
} from '../../src/runtime/binance/BinanceOfflineReadQualification';

const identity = Object.freeze({ exchange: 'binance' as const, accountId: 'q0-offline-fixture' });
const OBSERVED_AT = 10_000;
const SERVER_TIME = 9_950;
const ACCOUNT_UPDATE_TIME = 9_900;
const MARK_PRICE_TIME = 9_925;

function account(overrides: Partial<BinanceRawAccount> = {}): BinanceRawAccount {
  return {
    balances: [
      { asset: 'USDT', walletBalance: '125.50', availableBalance: '100.25' },
      { asset: 'USDC', walletBalance: '0', availableBalance: '0' },
    ],
    positions: [{
      symbol: 'BTCUSDT', positionAmt: '0.02', entryPrice: '50000', markPrice: '51000',
      unrealizedProfit: '20', marginType: 'isolated', leverage: '5', updateTime: 9_875,
    }],
    updateTime: ACCOUNT_UPDATE_TIME,
    sequence: 'offline-42',
    ...overrides,
  };
}

function client(overrides: Partial<BinanceAuthenticatedReadClient> = {}): BinanceAuthenticatedReadClient {
  return {
    async getServerTime() { return SERVER_TIME; },
    async getAccount() { return account(); },
    async getOpenOrders() {
      return [{
        orderId: 7, clientOrderId: 'offline-client-7', symbol: 'BTCUSDT', side: 'BUY',
        positionSide: 'BOTH', type: 'LIMIT', status: 'NEW', price: '49000', origQty: '0.01',
        executedQty: '0', reduceOnly: false, updateTime: 9_850,
      }];
    },
    async getRecentFills() {
      return [{
        id: 8, orderId: 6, symbol: 'BTCUSDT', side: 'BUY', price: '50000', qty: '0.02',
        quoteQty: '1000', commission: '0.4', commissionAsset: 'USDT', time: 9_800,
      }];
    },
    async getMarkPrice(symbol) { return { symbol, markPrice: '51000', time: MARK_PRICE_TIME }; },
    async getInstrumentRules(symbol) {
      return {
        symbol, tickSize: '0.1', stepSize: '0.001', minQty: '0.001',
        minNotional: '5', status: 'TRADING',
      };
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
      async getReadCredentials() {
        return { apiKey: 'offline-fixture-api-key', secretKey: 'offline-fixture-secret-key' };
      },
    },
    clientFactory: { create: () => readClient },
    now: () => OBSERVED_AT,
    staleAfterMs: 1_000,
    ...overrides,
  };
}

async function evidence(): Promise<BinanceOfflineQualificationEvidence> {
  const validClient = client();
  const notConfigured = await createBinanceAuthenticatedReadFoundation(identity).accountTruth.read();
  const credentialsUnavailable = await createBinanceAuthenticatedReadFoundation(
    identity,
    bindings(validClient, { secretProvider: { async getReadCredentials() { return null; } } }),
  ).accountTruth.read();
  const transportFailure = await createBinanceAuthenticatedReadFoundation(identity, bindings(client({
    async getAccount() { throw new Error('deterministic offline transport failure'); },
  }))).accountTruth.read();
  const valid = createBinanceAuthenticatedReadFoundation(identity, bindings(validClient));
  const validAccount = await valid.accountTruth.read();
  const validInstrument = await valid.instrumentFacts.read('BTCUSDT');
  const staleInstrument = await createBinanceAuthenticatedReadFoundation(identity, bindings(client({
    async getMarkPrice(symbol) { return { symbol, markPrice: '51000', time: 1_000 }; },
  }))).instrumentFacts.read('BTCUSDT');
  const missingRules = await createBinanceAuthenticatedReadFoundation(identity, bindings(client({
    async getInstrumentRules(): Promise<BinanceRawInstrumentRules | null> { return null; },
  }))).instrumentFacts.read('BTCUSDT');
  const missingAccount = await createBinanceAuthenticatedReadFoundation(identity, bindings(client({
    async getAccount() { return account({ balances: undefined }); },
  }))).accountTruth.read();
  const unknownBalance = await createBinanceAuthenticatedReadFoundation(identity, bindings(client({
    async getAccount() {
      return account({
        balances: [{
          asset: 'USDT',
          walletBalance: undefined as unknown as string,
          availableBalance: '100.25',
        }],
      });
    },
  }))).accountTruth.read();
  const unknownPosition = await createBinanceAuthenticatedReadFoundation(identity, bindings(client({
    async getAccount() {
      return account({
        positions: [{
          symbol: 'BTCUSDT',
          positionAmt: undefined as unknown as string,
          entryPrice: '50000',
          markPrice: '51000',
          unrealizedProfit: '20',
          marginType: 'isolated',
          leverage: '5',
          updateTime: 9_875,
        }],
      });
    },
  }))).accountTruth.read();

  return {
    notConfigured,
    credentialsUnavailable,
    transportFailure,
    validAccount,
    validInstrument,
    staleInstrument,
    missingRules,
    missingAccount,
    unknownBalance,
    unknownPosition,
    readClient: validClient,
    expectedTimes: {
      accountObservedAt: OBSERVED_AT,
      accountServerTime: SERVER_TIME,
      accountUpdateTime: ACCOUNT_UPDATE_TIME,
      instrumentObservedAt: OBSERVED_AT,
      instrumentServerTime: SERVER_TIME,
      markPriceTime: MARK_PRICE_TIME,
      staleAfterMs: 1_000,
    },
  };
}

describe('Binance L1A Q0 offline qualification', () => {
  it('issues a deterministic offline-only receipt after all fourteen checks pass', async () => {
    const proof = await evidence();
    const first = createBinanceOfflineQualificationReceipt(proof);
    const second = createBinanceOfflineQualificationReceipt(proof);

    assert.deepEqual(first, second);
    assert.equal(first.QUALIFICATION_MODE, 'OFFLINE');
    assert.equal(first.AUTH_NETWORK_USED, false);
    assert.equal(first.REAL_CREDENTIAL_USED, false);
    assert.equal(first.REAL_CREDENTIAL_DISCOVERY, false);
    assert.equal(first.PRODUCTION_CONNECTIVITY_VERIFIED, false);
    assert.equal(first.READ_CONTRACT_VERIFIED, true);
    assert.equal(first.FAIL_CLOSED_VERIFIED, true);
    assert.equal(first.MUTATION_SURFACE_PRESENT, false);
    assert.equal(first.LIVE_READY, false);
    assert.equal(first.EXECUTION_AUTHORITY_GRANTED, false);
    assert.equal(first.READY_FOR_REAL_READ_QUALIFICATION, true);
    assert.equal(Object.values(first.CHECKS).length, 14);
    assert.equal(Object.values(first.CHECKS).every(Boolean), true);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.CHECKS), true);
    assert.doesNotMatch(JSON.stringify(first), /offline-fixture-(api|secret)-key/);
  });

  it('keeps missing account truth distinct from flat and unknown numeric facts distinct from zero', async () => {
    const proof = await evidence();

    assert.equal(proof.missingAccount.availability, 'UNKNOWN');
    assert.equal(proof.missingAccount.value, null);
    assert.equal(proof.missingAccount.reason, 'ACCOUNT_TRUTH_MISSING');
    assert.notEqual(proof.missingAccount.value?.accountState, 'FLAT');
    assert.equal(proof.unknownBalance.value, null);
    assert.equal(proof.unknownBalance.reason, 'ACCOUNT_TRUTH_MALFORMED');
    assert.equal(proof.unknownPosition.value, null);
    assert.equal(proof.unknownPosition.reason, 'ACCOUNT_TRUTH_MALFORMED');
    assert.equal(proof.validAccount.value?.balances.find(({ asset }) => asset === 'USDC')?.walletBalance, 0);
    assert.equal(proof.validAccount.value?.accountState, 'OPEN');
  });

  it('blocks new entries on unknown account, missing rules, and stale marks without blocking close/reduce', async () => {
    const proof = await evidence();
    for (const [accountResult, instrumentResult, expectedBlocker] of [
      [proof.notConfigured, proof.validInstrument, 'ACCOUNT_TRUTH_UNKNOWN'],
      [proof.validAccount, proof.missingRules, 'MARKET_RULES_UNKNOWN'],
      [proof.validAccount, proof.staleInstrument, 'MARK_PRICE_STALE'],
    ] as const) {
      const readiness = evaluateBinanceNewEntryReadiness(accountResult, instrumentResult);
      assert.equal(readiness.safeToOpen, false);
      assert.ok(readiness.blockers.includes(expectedBlocker));
      assert.equal(readiness.closeOrReduceBlockedByEntryFreshness, false);
    }
  });

  it('rejects own, prototype, and accessor mutation surfaces without invoking them', async () => {
    const proof = await evidence();
    const ownMutationClient = client();
    Object.defineProperty(ownMutationClient, 'cancelOrder', {
      value: async () => { throw new Error('must remain unreachable'); },
    });
    const prototypeMutationClient = Object.assign(Object.create({
      async setLeverage() { throw new Error('must remain unreachable'); },
    }), client()) as BinanceAuthenticatedReadClient;
    let accessorCalls = 0;
    const accessorMutationClient = client();
    Object.defineProperty(accessorMutationClient, 'modifyOrder', {
      get() {
        accessorCalls += 1;
        return async () => { throw new Error('must remain unreachable'); };
      },
    });

    for (const readClient of [ownMutationClient, prototypeMutationClient, accessorMutationClient]) {
      const receipt = createBinanceOfflineQualificationReceipt({ ...proof, readClient });
      assert.equal(receipt.CHECKS.READ_CLIENT_SURFACE_EXACT, false);
      assert.equal(receipt.CHECKS.MUTATION_METHOD_UNREACHABLE, false);
      assert.equal(receipt.MUTATION_SURFACE_PRESENT, true);
      assert.equal(receipt.READY_FOR_REAL_READ_QUALIFICATION, false);
      assert.equal(receipt.LIVE_READY, false);
      assert.equal(receipt.EXECUTION_AUTHORITY_GRANTED, false);
    }
    assert.equal(accessorCalls, 0);
  });

  it('cannot convert incomplete fail-closed evidence into qualification success', async () => {
    const proof = await evidence();
    const receipt = createBinanceOfflineQualificationReceipt({
      ...proof,
      credentialsUnavailable: proof.validAccount,
    });

    assert.equal(receipt.CHECKS.CREDENTIALS_UNAVAILABLE_FAIL_CLOSED, false);
    assert.equal(receipt.FAIL_CLOSED_VERIFIED, false);
    assert.equal(receipt.READY_FOR_REAL_READ_QUALIFICATION, false);
    assert.equal(receipt.LIVE_READY, false);
    assert.equal(receipt.EXECUTION_AUTHORITY_GRANTED, false);
  });

  it('contains no network, credential-discovery, mutation, or production authority wiring', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'src/runtime/binance/BinanceOfflineReadQualification.ts',
    ), 'utf8');

    assert.deepEqual([...BINANCE_L1A_READ_CLIENT_METHODS].sort(), [
      'getAccount',
      'getInstrumentRules',
      'getMarkPrice',
      'getOpenOrders',
      'getRecentFills',
      'getServerTime',
    ]);
    assert.doesNotMatch(source, /process\.env|fetch\(|axios|WebSocket|https?:\/\//);
    assert.doesNotMatch(source, /ProductionRuntimeOwner|ProductionSpine|ExecutionGateway|OrderLifecycle|Reconciliation/);
    assert.doesNotMatch(
      source,
      /export\s+(?:async\s+)?(?:function|const|class)\s+\w*(?:submit|place|cancel|modify|leverage|margin)/i,
    );
  });
});
