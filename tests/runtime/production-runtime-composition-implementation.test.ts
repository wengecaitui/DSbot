import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createMarketDataRuntime, type MarketDataCollectorPort } from '../../src/runtime/market/MarketDataRuntime';
import type { MarketDataRuntime } from '../../src/runtime/market/MarketDataRuntime';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { createProductionSpine, type ProductionSpine } from '../../src/position/ProductionSpine';
import {
  assertCanonicalHardRiskSource,
  createApplicationProductionRuntimeOwner,
  createLegacyWriteAuthorityPolicy,
  type CanonicalHardRiskSource,
  type ProductionRuntimeConfig,
} from '../../src/runtime/production/ProductionRuntimeOwner';
import { LEGACY_WRITE_CAPABLE_PATHS } from '../../src/runtime/production/ProductionRuntimeCompositionContract';

interface CollectorProbe {
  readonly collector: MarketDataCollectorPort;
  readonly starts: () => number;
  readonly stops: () => number;
}

function collectorProbe(startError?: Error): CollectorProbe {
  let starts = 0;
  let stops = 0;
  let tickerHandler: Parameters<MarketDataCollectorPort['onTicker']>[0] | null = null;
  let klineHandler: Parameters<MarketDataCollectorPort['onKline']>[0] | null = null;
  return {
    collector: {
      async start() {
        starts += 1;
        if (startError) throw startError;
      },
      stop() { stops += 1; },
      onTicker(handler) { tickerHandler = handler; },
      onKline(handler) { klineHandler = handler; },
    },
    starts: () => starts,
    stops: () => stops,
  };
}

function runtimeConfig(dir: string, accountId: string): ProductionRuntimeConfig {
  return {
    enabled: true,
    mode: 'paper',
    exchange: 'bitget',
    accountId,
    journalPath: join(dir, 'journal', 'events.jsonl'),
    paperLedgerDir: join(dir, 'paper'),
    initialCashUsd: 100_000,
    hardRisk: {
      enabled: true,
      locked: false,
      totalCapitalUsd: 100_000,
      maxSinglePositionPct: 0.1,
      maxSinglePositionAbsUsd: 5_000,
    },
    market: {
      entries: [{
        symbol: 'BTC/USDT',
        exchangeSymbol: 'BTCUSDT',
        intervals: ['1m'],
        ticker: true,
      }],
      staleAfterMs: 60_000,
    },
  };
}

function marketOverride(probe: CollectorProbe) {
  return {
    createMarketRuntime: () => createMarketDataRuntime({ collectorFactory: () => probe.collector }),
  };
}

describe('Phase 8A application production runtime owner', () => {
  it('creates one spine, publishes the exact reference, and boots without orders or LIVE_READY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase8a-owner-'));
    const secondDir = mkdtempSync(join(tmpdir(), 'phase8a-second-owner-'));
    const probe = collectorProbe();
    const secondProbe = collectorProbe();
    let creations = 0;
    let authoritative: ProductionSpine | null = null;
    let ownerMarketRuntime: MarketDataRuntime | null = null;
    const owner = createApplicationProductionRuntimeOwner(runtimeConfig(dir, 'paper_owner'), {
      createMarketRuntime() {
        ownerMarketRuntime = createMarketDataRuntime({ collectorFactory: () => probe.collector });
        return ownerMarketRuntime;
      },
      async createSpine(config) {
        creations += 1;
        assert.strictEqual(config.marketRuntime, ownerMarketRuntime);
        authoritative = await createProductionSpine(config);
        return authoritative;
      },
    });
    const secondOwner = createApplicationProductionRuntimeOwner(runtimeConfig(secondDir, 'paper_owner'), {
      ...marketOverride(secondProbe),
      async createSpine(config) {
        return createProductionSpine(config);
      },
    });

    try {
      assert.equal(owner.read.productionSpine(), null);
      assert.deepEqual(Object.keys(owner.read).sort(), [
        'identity', 'productionSpine', 'reconciliation', 'recovery', 'status',
      ]);
      await owner.start();

      assert.equal(creations, 1);
      assert.ok(authoritative);
      for (let read = 0; read < 20; read += 1) {
        assert.strictEqual(owner.read.productionSpine(), authoritative);
      }
      assert.equal(owner.read.status().spineCreations, 1);
      assert.equal(owner.read.status().state, 'READY_FOR_MARKET');
      assert.equal(owner.read.recovery()?.recoveryVerified, true);
      assert.equal(owner.read.reconciliation()?.reconciliationVerified, true);
      assert.equal(authoritative.oms.getStore().list().length, 0, 'boot submits no OMS request');
      assert.equal(authoritative.protection.getSubmittedCount(), 0, 'boot submits no protective request');
      assert.equal(authoritative.protection.getMode(), 'replay', 'boot never grants LIVE_READY');
      assert.equal(probe.starts(), 1);

      await owner.start();
      assert.equal(creations, 1, 'repeated owner start cannot create a second spine');
      await assert.rejects(() => secondOwner.start(), /SECOND_PRODUCTION_RUNTIME_OWNER_FORBIDDEN/);
      assert.equal(secondOwner.read.status().spineCreations, 0);
      assert.equal(secondOwner.read.productionSpine(), null);

      await owner.stop();
      await owner.stop();
      assert.equal(owner.read.productionSpine(), null);
      assert.equal(probe.stops(), 1);
      assert.equal(owner.read.status().state, 'STOPPED');
    } finally {
      await secondOwner.stop();
      await owner.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(secondDir, { recursive: true, force: true });
    }
  });

  it('keeps missing config, incomplete identity, and placeholder hard risk unavailable', async () => {
    const absent = createApplicationProductionRuntimeOwner(undefined);
    await absent.start();
    assert.equal(absent.read.status().state, 'NOT_CONFIGURED');
    assert.equal(absent.read.productionSpine(), null);

    const dir = mkdtempSync(join(tmpdir(), 'phase8a-invalid-'));
    try {
      const missingAccount = createApplicationProductionRuntimeOwner({
        ...runtimeConfig(dir, 'will_be_removed'),
        accountId: undefined,
      });
      await missingAccount.start();
      assert.equal(missingAccount.read.status().state, 'NOT_CONFIGURED');
      assert.equal(missingAccount.read.status().spineCreations, 0);
      assert.equal(missingAccount.legacyWrites.mode, 'QUARANTINED');

      const zeroRisk = createApplicationProductionRuntimeOwner({
        ...runtimeConfig(dir, 'zero_risk'),
        hardRisk: {
          enabled: true,
          locked: false,
          totalCapitalUsd: 0,
          maxSinglePositionPct: 0.1,
          maxSinglePositionAbsUsd: 0,
        },
      });
      await zeroRisk.start();
      assert.equal(zeroRisk.read.status().state, 'NOT_CONFIGURED');
      assert.match(zeroRisk.read.status().reason ?? '', /PLACEHOLDER_REJECTED/);
      assert.equal(zeroRisk.read.productionSpine(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects raw KillSwitch-shaped, incomplete, and mismatched hard-risk sources', () => {
    const identity = { exchange: 'bitget' as const, accountId: 'risk_owner' };
    const rawKillSwitchLike = {
      identity,
      snapshot: () => ({
        exchange: 'bitget',
        currentExposureUsd: 0,
        todayRealizedLossUsd: 0,
        todayUnrealizedLossUsd: 0,
        openPositions: 0,
        isTriggered: false,
      }),
    } as unknown as CanonicalHardRiskSource;
    assert.throws(
      () => assertCanonicalHardRiskSource(identity, rawKillSwitchLike),
      /HARD_RISK_(?:INCOMPLETE|IDENTITY_MISMATCH)/,
    );

    const mismatched = {
      identity: { exchange: 'bitget' as const, accountId: 'other' },
      snapshot: () => ({
        exchange: 'bitget' as const,
        accountId: 'other',
        enabled: true as const,
        locked: false,
        totalCapitalUsd: 100_000,
        maxSinglePositionPct: 0.1,
        maxSinglePositionAbsUsd: 5_000,
      }),
    };
    assert.throws(() => assertCanonicalHardRiskSource(identity, mismatched), /HARD_RISK_IDENTITY_MISMATCH/);
  });

  it('fails closed before creating a spine when durable journal open fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase8a-durability-'));
    const probe = collectorProbe();
    let creations = 0;
    const owner = createApplicationProductionRuntimeOwner(runtimeConfig(dir, 'durability_failure'), {
      ...marketOverride(probe),
      createJournal() { throw new Error('JOURNAL_OPEN_FAILED'); },
      async createSpine(config) {
        creations += 1;
        return createProductionSpine(config);
      },
    });
    try {
      await assert.rejects(() => owner.start(), /JOURNAL_OPEN_FAILED/);
      assert.equal(creations, 0);
      assert.equal(owner.read.productionSpine(), null);
      assert.equal(owner.read.status().state, 'RECOVERY_FAILED');
    } finally {
      await owner.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed before creating a spine when durable paper persistence cannot open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase8a-ledger-durability-'));
    const probe = collectorProbe();
    let creations = 0;
    const owner = createApplicationProductionRuntimeOwner(runtimeConfig(dir, 'ledger_failure'), {
      ...marketOverride(probe),
      createPaperPersistence() { throw new Error('PAPER_LEDGER_OPEN_FAILED'); },
      async createSpine(config) {
        creations += 1;
        return createProductionSpine(config);
      },
    });
    try {
      await assert.rejects(() => owner.start(), /PAPER_LEDGER_OPEN_FAILED/);
      assert.equal(creations, 0);
      assert.equal(owner.read.productionSpine(), null);
      assert.equal(owner.read.status().state, 'RECOVERY_FAILED');
    } finally {
      await owner.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a partial start and keeps shutdown idempotent when market startup fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase8a-rollback-'));
    const probe = collectorProbe(new Error('COLLECTOR_START_FAILED'));
    let captured: ProductionSpine | null = null;
    const owner = createApplicationProductionRuntimeOwner(runtimeConfig(dir, 'market_failure'), {
      ...marketOverride(probe),
      async createSpine(config) {
        captured = await createProductionSpine(config);
        return captured;
      },
    });
    try {
      await assert.rejects(() => owner.start(), /COLLECTOR_START_FAILED/);
      assert.ok(captured);
      assert.equal(owner.read.status().state, 'MARKET_FAILED');
      assert.equal(owner.read.productionSpine(), null);
      assert.equal(captured.protection.getMode(), 'replay');
      assert.equal(probe.starts(), 1);
      assert.equal(probe.stops(), 1);
      await owner.stop();
      await owner.stop();
      assert.equal(probe.stops(), 1);
    } finally {
      await owner.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('quarantines every reviewed legacy write path with one fail-closed policy', () => {
    const policy = createLegacyWriteAuthorityPolicy(true);
    assert.equal(policy.mode, 'QUARANTINED');
    assert.deepEqual(policy.paths, LEGACY_WRITE_CAPABLE_PATHS);
    for (const path of LEGACY_WRITE_CAPABLE_PATHS) assert.equal(policy.canUse(path), false, path);

    const gatewaySource = readFileSync('src/gateway/index.ts', 'utf8');
    assert.match(gatewaySource, /createApplicationProductionRuntimeOwner\(config\.productionRuntime\)/);
    assert.match(gatewaySource, /productionSpine: productionRuntimeOwner\.read\.productionSpine/);
    assert.match(gatewaySource, /recovery: productionRuntimeOwner\.read\.recovery/);
    assert.match(gatewaySource, /await productionRuntimeOwner\.start\(\)/);
    assert.match(gatewaySource, /await productionRuntimeOwner\.stop\(\)/);
    assert.match(gatewaySource, /config\.trading\?\.enabled && legacyExecutionAllowed/);
    assert.match(gatewaySource, /legacyExecutionAllowed && config\.copyTrading\?\.enabled/);
    assert.match(gatewaySource, /legacyExecutionAllowed && config\.arbitrageExecution\?\.enabled/);
    assert.match(gatewaySource, /legacyExecutionAllowed && signalRouterCfg\?\.enabled/);
    assert.match(gatewaySource, /if \(legacyExecutionAllowed\) \{\s*httpGateway\.setDCARouter/);
  });

  it('recovers SUBMISSION_UNKNOWN without retrying and refuses mismatched reconciliation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase8a-unknown-'));
    const config: ProductionRuntimeConfig = {
      ...runtimeConfig(dir, 'unknown_owner'),
      journalPath: join(dir, 'events.jsonl'),
    };
    const journalPath = config.journalPath!;
    const journal = createFileEventJournal(journalPath);
    const kernel = createTradingKernel({ exchange: 'bitget', journal });
    kernel.publish('order.created', {
      order: {
        orderId: 'unknown-order',
        intentId: 'unknown-intent',
        exchange: 'bitget',
        symbol: 'BTC/USDT',
        action: 'open',
        side: 'buy',
        orderType: 'market',
        approvedNotionalUsd: 1_000,
      },
    });
    kernel.publish('order.submission.unknown', { orderId: 'unknown-order', reason: 'transport timeout' });
    journal.close();

    const probe = collectorProbe();
    let captured: ProductionSpine | null = null;
    let adapterSubmissions = 0;
    const owner = createApplicationProductionRuntimeOwner(config, {
      ...marketOverride(probe),
      async createSpine(spineConfig) {
        const spine = await createProductionSpine(spineConfig);
        const originalSubmit = spine.adapter.submit.bind(spine.adapter);
        spine.adapter.submit = async (order) => {
          adapterSubmissions += 1;
          return originalSubmit(order);
        };
        captured = spine;
        return spine;
      },
    });
    try {
      await assert.rejects(() => owner.start(), /PRODUCTION_RUNTIME_RECONCILIATION_FAILED/);
      assert.ok(captured);
      assert.equal(captured.oms.getStore().get('unknown-order')?.status, 'SUBMISSION_UNKNOWN');
      assert.equal(adapterSubmissions, 0, 'recovery/startup never resubmits unknown orders');
      assert.equal(owner.read.productionSpine(), null);
      assert.equal(owner.read.status().state, 'RECONCILIATION_FAILED');
      assert.equal(probe.starts(), 0, 'market starts only after reconciliation succeeds');
    } finally {
      await owner.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
