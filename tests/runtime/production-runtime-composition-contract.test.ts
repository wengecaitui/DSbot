import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PHASE_8A_PRODUCTION_RUNTIME_CONTRACT,
  LEGACY_WRITE_CAPABLE_PATHS,
  PRODUCTION_RUNTIME_STATES,
  assertAuthoritativeSpineIdentity,
  assertProductionRuntimeCompositionContract,
  createProductionSpineReadBinding,
  type ProductionRuntimeCompositionContract,
} from '../../src/runtime/production/ProductionRuntimeCompositionContract';

function weakened(
  patch: Partial<Record<keyof ProductionRuntimeCompositionContract, unknown>>,
): ProductionRuntimeCompositionContract {
  return { ...PHASE_8A_PRODUCTION_RUNTIME_CONTRACT, ...patch } as ProductionRuntimeCompositionContract;
}

describe('Phase 8A authoritative production runtime composition contract', () => {
  it('accepts the frozen single-owner contract and includes every fail-closed orchestration state', () => {
    assert.doesNotThrow(() => assertProductionRuntimeCompositionContract(PHASE_8A_PRODUCTION_RUNTIME_CONTRACT));
    for (const state of [
      'DISABLED', 'NOT_CONFIGURED', 'STARTING', 'RECOVERING', 'RECOVERY_FAILED',
      'RECOVERY_VERIFIED', 'RECONCILING', 'RECONCILIATION_FAILED',
      'READY_FOR_MARKET', 'LIVE_READY',
    ]) {
      assert.ok(PRODUCTION_RUNTIME_STATES.includes(state as never), `missing state ${state}`);
    }
  });

  it('rejects a second spine, in-memory durability, Workbench authority, boot trading, and automatic retry', () => {
    for (const patch of [
      { maximumSpinesPerScope: 2 },
      { secondSpineAllowed: true },
      { durableJournalRequired: false },
      { durablePaperLedgerRequired: false },
      { workbenchCanCreateRuntime: true },
      { workbenchCanActivateRuntime: true },
      { applicationBootSubmitsOrders: true },
      { applicationBootGrantsLiveReady: true },
      { submissionUnknownAutoRetry: true },
    ]) {
      assert.throws(
        () => assertProductionRuntimeCompositionContract(weakened(patch)),
        /PHASE_8A_CONTRACT_VIOLATION/,
      );
    }
  });

  it('rejects dual execution authority and freezes every reviewed legacy write surface', () => {
    assert.deepEqual(LEGACY_WRITE_CAPABLE_PATHS, [
      'POST /api/orders',
      'agent execution',
      'SignalRouter',
      'CopyTrading',
      'ArbitrageExecutor',
      'DCA',
      'TWAP',
      'Bracket',
      'TriggerOrderManager',
      'ExecutionQueue',
      'position auto-close',
    ]);
    for (const patch of [
      { dualExecutionAuthorityAllowed: true },
      { legacyExecutionMayBypassAuthoritativeSpine: true },
      { legacyWritePathPolicy: 'KEEP_LEGACY_EXECUTION' },
    ]) {
      assert.throws(
        () => assertProductionRuntimeCompositionContract(weakened(patch)),
        /legacy write paths must be disabled or use the owner spine PreTradeRiskGateway and OMS/,
      );
    }
  });

  it('rejects raw KillSwitch snapshots, identity mismatch, and hard-risk type escapes', () => {
    assert.equal(PHASE_8A_PRODUCTION_RUNTIME_CONTRACT.rawCurrentKillSwitchSnapshotQualifiesAsHardRisk, false);
    for (const patch of [
      { rawCurrentKillSwitchSnapshotQualifiesAsHardRisk: true },
      { hardRiskMustMatchExchangeAccountRuntimeIdentity: false },
      { hardRiskTypeEscapeAllowed: true },
      { hardRiskIdentity: 'RAW_KILL_SWITCH_SNAPSHOT' },
    ]) {
      assert.throws(
        () => assertProductionRuntimeCompositionContract(weakened(patch)),
        /hard risk|hard-risk/,
      );
    }
  });

  it('binds Workbench to the exact owner spine without creating on repeated reads', () => {
    let runtimeCreations = 0;
    const authoritativeSpine = { id: 'bitget:paper-main' };
    runtimeCreations += 1;
    const binding = createProductionSpineReadBinding<typeof authoritativeSpine>();

    binding.owner.bind(authoritativeSpine);
    assert.equal(binding.provider.productionSpine(), null, 'bound is not automatically readable');
    binding.owner.makeAvailable(authoritativeSpine);

    for (let i = 0; i < 20; i += 1) {
      assert.strictEqual(binding.provider.productionSpine(), authoritativeSpine);
    }
    assert.equal(runtimeCreations, 1, 'Workbench reads cannot create runtimes');
    assert.deepEqual(Object.keys(binding.provider), ['productionSpine']);
  });

  it('forbids rebinding recovery, reconciliation, or Workbench to a second identity', () => {
    const authoritativeSpine = { id: 'owner' };
    const secondSpine = { id: 'dashboard-copy' };
    const binding = createProductionSpineReadBinding<typeof authoritativeSpine>();
    binding.owner.bind(authoritativeSpine);

    assert.throws(() => binding.owner.bind(secondSpine), /SECOND_PRODUCTION_SPINE_FORBIDDEN/);
    for (const operation of ['RECOVERY', 'RECONCILIATION', 'WORKBENCH'] as const) {
      assert.throws(
        () => assertAuthoritativeSpineIdentity(authoritativeSpine, secondSpine, operation),
        new RegExp(`${operation}_SECOND_PRODUCTION_SPINE_FORBIDDEN`),
      );
      assert.doesNotThrow(() => assertAuthoritativeSpineIdentity(authoritativeSpine, authoritativeSpine, operation));
    }
  });

  it('fails closed before availability and after idempotent shutdown without creating a replacement', () => {
    const authoritativeSpine = { id: 'owner' };
    const binding = createProductionSpineReadBinding<typeof authoritativeSpine>();
    assert.equal(binding.provider.productionSpine(), null);

    binding.owner.bind(authoritativeSpine);
    binding.owner.makeAvailable(authoritativeSpine);
    assert.strictEqual(binding.provider.productionSpine(), authoritativeSpine);

    binding.owner.makeUnavailable();
    assert.equal(binding.provider.productionSpine(), null);
    binding.owner.close();
    binding.owner.close();
    assert.equal(binding.provider.productionSpine(), null);
    assert.throws(() => binding.owner.bind({ id: 'replacement' }), /PRODUCTION_SPINE_BINDING_CLOSED/);
  });
});
