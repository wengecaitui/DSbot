import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  createCryptoHftEngine,
  createPositionManager,
  evaluateRegimeGateTicks,
} from '../../src/strategies/crypto-hft/index.js';
import {
  DEFAULT_ENGINE_CONFIG,
  createHftDivergenceEngine,
} from '../../src/strategies/hft-divergence/strategy.js';
import { createDivPositionManager } from '../../src/strategies/hft-divergence/position-manager.js';

const FUTURE_EXPIRY = 4_000_000_000_000;

function openCryptoPosition(manager: ReturnType<typeof createPositionManager>, asset = 'BTC') {
  return manager.open({
    strategy: 'test',
    asset,
    direction: 'up',
    tokenId: `${asset}-up`,
    conditionId: `${asset}-condition`,
    entryPrice: 0.5,
    shares: 10,
    expiresAt: FUTURE_EXPIRY,
    wasMaker: true,
  });
}

function openDivergencePosition(manager: ReturnType<typeof createDivPositionManager>, asset = 'BTC') {
  return manager.open({
    asset,
    direction: 'up',
    tokenId: `${asset}-up`,
    conditionId: `${asset}-condition`,
    strategyTag: 'test',
    entryPrice: 0.5,
    shares: 10,
    expiresAt: FUTURE_EXPIRY,
  });
}

describe('paper-inspired risk controls — fail-closed integration', () => {
  it('regime warm-up and empty observations block new entries', () => {
    assert.equal(evaluateRegimeGateTicks([]), false);
    assert.equal(evaluateRegimeGateTicks([{ price: 100, ts: 1_000 }]), false);
  });

  it('invalid constructor risk config is rejected in both engines', () => {
    assert.throws(
      () => createCryptoHftEngine({} as never, null, { adaptiveSlNormalK: 0 }),
      /Invalid crypto HFT risk config/,
    );
    assert.throws(
      () => createHftDivergenceEngine({} as never, null, { adaptiveSlNormalK: 0 }),
      /Invalid HFT divergence risk config/,
    );
  });

  it('invalid divergence update is rejected without mutating active config', () => {
    const engine = createHftDivergenceEngine({} as never, null, {});
    const before = engine.getConfig();
    engine.updateConfig({ adaptiveSlNormalK: 0 });
    assert.deepEqual(engine.getConfig(), before);
  });
});

describe('paper-inspired risk controls — default-off equivalence', () => {
  it('crypto fixed stop retains live-config semantics when adaptive stop is disabled', () => {
    let config = {
      ...DEFAULT_CONFIG,
      stopLossPct: 12,
      adaptiveStoplossEnabled: false,
      takeProfitPct: 1_000,
      forceExitSec: -1,
      minTimeLeftSec: -1,
      ratchetEnabled: false,
      trailingEnabled: false,
      staleProfitPct: 1_000,
      stagnantProfitPct: 1_000,
    };
    const manager = createPositionManager(() => config);
    const position = openCryptoPosition(manager);
    config = { ...config, stopLossPct: 5 };
    manager.tick(position.id, 0.45, null);
    const exits = manager.checkExits(() => null, 10_000);
    assert.equal(exits[0]?.reason, 'stop_loss');
  });

  it('crypto adaptive stop stays frozen at entry when enabled', () => {
    let config = {
      ...DEFAULT_CONFIG,
      stopLossPct: 12,
      adaptiveStoplossEnabled: true,
      adaptiveSlBasePct: 12,
      takeProfitPct: 1_000,
      forceExitSec: -1,
      minTimeLeftSec: -1,
      ratchetEnabled: false,
      trailingEnabled: false,
      staleProfitPct: 1_000,
      stagnantProfitPct: 1_000,
    };
    const manager = createPositionManager(() => config);
    const position = openCryptoPosition(manager);
    assert.equal(position.effectiveStopLossPct, 18);
    config = { ...config, stopLossPct: 5 };
    manager.tick(position.id, 0.45, null);
    assert.equal(manager.checkExits(() => null, 10_000).length, 0);
  });

  it('divergence fixed stop retains live-config semantics while adaptive stop stays frozen', () => {
    let config = {
      ...DEFAULT_ENGINE_CONFIG,
      stopLossPct: 12,
      adaptiveStoplossEnabled: false,
      takeProfitPct: 1_000,
      forceExitSec: -1,
      timeExitSec: -1,
      trailingActivationPct: 1_000,
    };
    const fixedManager = createDivPositionManager(() => config);
    const fixed = openDivergencePosition(fixedManager);
    config = { ...config, stopLossPct: 5 };
    fixedManager.tick(fixed.id, 0.45);
    assert.equal(fixedManager.checkExits(10_000)[0]?.reason, 'stop_loss');

    config = {
      ...config,
      stopLossPct: 12,
      adaptiveStoplossEnabled: true,
      adaptiveSlBasePct: 12,
    };
    const adaptiveManager = createDivPositionManager(() => config);
    const adaptive = openDivergencePosition(adaptiveManager, 'ETH');
    assert.equal(adaptive.effectiveStopLossPct, 18);
    config = { ...config, stopLossPct: 5 };
    adaptiveManager.tick(adaptive.id, 0.45);
    assert.equal(adaptiveManager.checkExits(10_000).length, 0);
  });
});

describe('paper-inspired risk controls — cost probe lifecycle', () => {
  it('failed probe rearms the full cooldown instead of allowing repeated probes', () => {
    let now = 1_000_000;
    const config = {
      ...DEFAULT_CONFIG,
      maxPositions: 10,
      maxDailyLossUsd: 1_000_000,
      stopLossCooldownSec: 0,
      exitCooldownSec: 0,
      costHurdleGateEnabled: true,
      costHurdleMinCompletedTrades: 1,
      costHurdleWindowTrades: 10,
      costHurdleMaxCostRatio: 0.5,
      costHurdleBlockCooldownSec: 60,
      costHurdleMaxTradesPerHour: 0,
    };
    const manager = createPositionManager(() => config, { nowMs: () => now });

    const seed = openCryptoPosition(manager, 'BTC');
    now += 1_000;
    manager.close(seed.id, 0.51, 'manual', false);
    const blocked = manager.canOpen();
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason ?? '', /Cost breaker/);

    now += 60_000;
    assert.equal(manager.canOpen().ok, true);
    const probe = openCryptoPosition(manager, 'ETH');
    now += 1_000;
    manager.close(probe.id, 0.51, 'manual', false);

    const reblocked = manager.canOpen();
    assert.equal(reblocked.ok, false);
    assert.match(reblocked.reason ?? '', /probe in 60s/);
  });

  it('successful probe clears audit status immediately on settlement', () => {
    let now = 2_000_000;
    const config = {
      ...DEFAULT_CONFIG,
      maxPositions: 10,
      maxDailyLossUsd: 1_000_000,
      stopLossCooldownSec: 0,
      exitCooldownSec: 0,
      costHurdleGateEnabled: true,
      costHurdleMinCompletedTrades: 1,
      costHurdleWindowTrades: 10,
      costHurdleMaxCostRatio: 0.5,
      costHurdleBlockCooldownSec: 60,
      costHurdleMaxTradesPerHour: 0,
    };
    const manager = createPositionManager(() => config, { nowMs: () => now });

    const seed = openCryptoPosition(manager, 'BTC');
    now += 1_000;
    manager.close(seed.id, 0.51, 'manual', false);
    assert.equal(manager.canOpen().ok, false);

    now += 60_000;
    assert.equal(manager.canOpen().ok, true);
    const probe = openCryptoPosition(manager, 'ETH');
    now += 1_000;
    manager.close(probe.id, 0.8, 'manual', true);

    assert.equal(manager.getStats().costHurdleStatus, 'OK');
  });
});
