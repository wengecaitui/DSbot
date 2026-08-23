import type { ProductionSpine } from '../../position/ProductionSpine';

/**
 * Phase 8A is an ownership contract only. These states describe orchestration
 * and read availability; they do not grant Recovery, Reconciliation, or
 * LIVE_READY authority.
 */
export const PRODUCTION_RUNTIME_STATES = [
  'DISABLED',
  'NOT_CONFIGURED',
  'STARTING',
  'RECOVERING',
  'RECOVERY_FAILED',
  'RECOVERY_VERIFIED',
  'RECONCILING',
  'RECONCILIATION_FAILED',
  'MARKET_FAILED',
  'READY_FOR_MARKET',
  'LIVE_READY',
  'STOPPING',
  'STOPPED',
] as const;

export type ProductionRuntimeState = (typeof PRODUCTION_RUNTIME_STATES)[number];

export const LEGACY_WRITE_CAPABLE_PATHS = Object.freeze([
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
] as const);

export interface ProductionRuntimeCompositionContract {
  readonly phase: '8A';
  readonly delivery: 'CONTRACT_ONLY';
  readonly currentProductionSpineOwner: null;
  readonly proposedOwner: 'APP_GATEWAY_PRODUCTION_RUNTIME_OWNER';
  readonly compositionRoot: 'createGateway';
  readonly startupOwner: 'AppGateway.start';
  readonly shutdownOwner: 'AppGateway.stop';
  readonly singletonScope: 'EXCHANGE_ACCOUNT';
  readonly maximumSpinesPerScope: 1;
  readonly secondSpineAllowed: false;
  readonly durableJournalRequired: true;
  readonly durablePaperLedgerRequired: true;
  readonly explicitAccountIdentityRequired: true;
  readonly explicitExchangeIdentityRequired: true;
  readonly marketRuntimeIdentity: 'OWNER_INSTANCE';
  readonly hardRiskIdentity: 'TYPED_EXCHANGE_ACCOUNT_CANONICAL_SOURCE';
  readonly rawCurrentKillSwitchSnapshotQualifiesAsHardRisk: false;
  readonly hardRiskMustMatchExchangeAccountRuntimeIdentity: true;
  readonly hardRiskTypeEscapeAllowed: false;
  readonly recoverySpineIdentity: 'OWNER_INSTANCE';
  readonly reconciliationSpineIdentity: 'OWNER_INSTANCE';
  readonly workbenchSpineIdentity: 'OWNER_INSTANCE';
  readonly workbenchCanCreateRuntime: false;
  readonly workbenchCanActivateRuntime: false;
  readonly applicationBootSubmitsOrders: false;
  readonly applicationBootGrantsLiveReady: false;
  readonly submissionUnknownAutoRetry: false;
  readonly dualExecutionAuthorityAllowed: false;
  readonly legacyExecutionMayBypassAuthoritativeSpine: false;
  readonly legacyWritePathPolicy: 'DISABLE_OR_SAME_SPINE_PRETRADE_OMS';
  readonly projectControlCenterBridgePhase: '8B';
  readonly activityBridgePhase: '8B';
}

export const PHASE_8A_PRODUCTION_RUNTIME_CONTRACT: ProductionRuntimeCompositionContract = Object.freeze({
  phase: '8A',
  delivery: 'CONTRACT_ONLY',
  currentProductionSpineOwner: null,
  proposedOwner: 'APP_GATEWAY_PRODUCTION_RUNTIME_OWNER',
  compositionRoot: 'createGateway',
  startupOwner: 'AppGateway.start',
  shutdownOwner: 'AppGateway.stop',
  singletonScope: 'EXCHANGE_ACCOUNT',
  maximumSpinesPerScope: 1,
  secondSpineAllowed: false,
  durableJournalRequired: true,
  durablePaperLedgerRequired: true,
  explicitAccountIdentityRequired: true,
  explicitExchangeIdentityRequired: true,
  marketRuntimeIdentity: 'OWNER_INSTANCE',
  hardRiskIdentity: 'TYPED_EXCHANGE_ACCOUNT_CANONICAL_SOURCE',
  rawCurrentKillSwitchSnapshotQualifiesAsHardRisk: false,
  hardRiskMustMatchExchangeAccountRuntimeIdentity: true,
  hardRiskTypeEscapeAllowed: false,
  recoverySpineIdentity: 'OWNER_INSTANCE',
  reconciliationSpineIdentity: 'OWNER_INSTANCE',
  workbenchSpineIdentity: 'OWNER_INSTANCE',
  workbenchCanCreateRuntime: false,
  workbenchCanActivateRuntime: false,
  applicationBootSubmitsOrders: false,
  applicationBootGrantsLiveReady: false,
  submissionUnknownAutoRetry: false,
  dualExecutionAuthorityAllowed: false,
  legacyExecutionMayBypassAuthoritativeSpine: false,
  legacyWritePathPolicy: 'DISABLE_OR_SAME_SPINE_PRETRADE_OMS',
  projectControlCenterBridgePhase: '8B',
  activityBridgePhase: '8B',
});

/** Fail closed if a future composition plan weakens any Phase 8A invariant. */
export function assertProductionRuntimeCompositionContract(
  value: ProductionRuntimeCompositionContract,
): void {
  const violations: string[] = [];
  if (value.delivery !== 'CONTRACT_ONLY') violations.push('Phase 8A cannot claim implementation delivery');
  if (value.currentProductionSpineOwner !== null) violations.push('repository currently has no production spine owner');
  if (value.compositionRoot !== 'createGateway') violations.push('runtime must use the existing application composition root');
  if (value.startupOwner !== 'AppGateway.start' || value.shutdownOwner !== 'AppGateway.stop') {
    violations.push('AppGateway must own the complete runtime lifecycle');
  }
  if (value.singletonScope !== 'EXCHANGE_ACCOUNT' || value.maximumSpinesPerScope !== 1 || value.secondSpineAllowed) {
    violations.push('exactly one spine is allowed per exchange/account scope');
  }
  if (!value.durableJournalRequired || !value.durablePaperLedgerRequired) {
    violations.push('authoritative runtime durability cannot fall back to memory');
  }
  if (!value.explicitAccountIdentityRequired || !value.explicitExchangeIdentityRequired) {
    violations.push('runtime identity must be explicit');
  }
  if (value.marketRuntimeIdentity !== 'OWNER_INSTANCE') violations.push('market runtime must be the owner instance');
  if (value.hardRiskIdentity !== 'TYPED_EXCHANGE_ACCOUNT_CANONICAL_SOURCE') {
    violations.push('hard risk must use a typed exchange/account canonical source');
  }
  if (
    value.rawCurrentKillSwitchSnapshotQualifiesAsHardRisk
    || !value.hardRiskMustMatchExchangeAccountRuntimeIdentity
    || value.hardRiskTypeEscapeAllowed
  ) {
    violations.push('raw KillSwitch snapshots and type escapes cannot satisfy the hard-risk boundary');
  }
  if (
    value.recoverySpineIdentity !== 'OWNER_INSTANCE'
    || value.reconciliationSpineIdentity !== 'OWNER_INSTANCE'
    || value.workbenchSpineIdentity !== 'OWNER_INSTANCE'
  ) {
    violations.push('recovery, reconciliation, and Workbench must use the owner spine');
  }
  if (value.workbenchCanCreateRuntime || value.workbenchCanActivateRuntime) {
    violations.push('Workbench is read-only and cannot own lifecycle authority');
  }
  if (value.applicationBootSubmitsOrders || value.applicationBootGrantsLiveReady) {
    violations.push('application boot cannot trade or grant LIVE_READY');
  }
  if (value.submissionUnknownAutoRetry) violations.push('SUBMISSION_UNKNOWN cannot auto-retry');
  if (
    value.dualExecutionAuthorityAllowed
    || value.legacyExecutionMayBypassAuthoritativeSpine
    || value.legacyWritePathPolicy !== 'DISABLE_OR_SAME_SPINE_PRETRADE_OMS'
  ) {
    violations.push('legacy write paths must be disabled or use the owner spine PreTradeRiskGateway and OMS');
  }
  if (value.projectControlCenterBridgePhase !== '8B' || value.activityBridgePhase !== '8B') {
    violations.push('operations evidence bridges are deferred to Phase 8B');
  }
  if (violations.length > 0) throw new Error(`PHASE_8A_CONTRACT_VIOLATION: ${violations.join('; ')}`);
}

export interface WorkbenchProductionSpineProvider<TSpine extends object = ProductionSpine> {
  /** Returns the exact owner instance or null. It never creates or restarts a runtime. */
  readonly productionSpine: () => TSpine | null;
}

export interface ProductionSpineReadBindingOwner<TSpine extends object = ProductionSpine> {
  /** Bind the one authoritative identity. Rebinding to another object is P0. */
  bind(spine: TSpine): void;
  /** Make the already-bound instance readable; this grants no trading authority. */
  makeAvailable(spine: TSpine): void;
  /** Fail closed before partial startup or shutdown cleanup begins. */
  makeUnavailable(): void;
  /** Idempotently seal the binding. A closed binding cannot create a replacement. */
  close(): void;
}

/**
 * Minimal same-reference read binding contract for the future composition.
 * It owns no ProductionSpine and exposes no creation, execution, recovery,
 * reconciliation, or activation method to Workbench.
 */
export function createProductionSpineReadBinding<TSpine extends object = ProductionSpine>(): {
  readonly provider: WorkbenchProductionSpineProvider<TSpine>;
  readonly owner: ProductionSpineReadBindingOwner<TSpine>;
} {
  let authoritative: TSpine | null = null;
  let available = false;
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error('PRODUCTION_SPINE_BINDING_CLOSED');
  }

  function assertIdentity(candidate: TSpine): void {
    if (authoritative !== null && authoritative !== candidate) {
      throw new Error('SECOND_PRODUCTION_SPINE_FORBIDDEN');
    }
  }

  const provider = Object.freeze({
    productionSpine: (): TSpine | null => (available && !closed ? authoritative : null),
  });

  const owner = Object.freeze({
    bind(spine: TSpine): void {
      assertOpen();
      assertIdentity(spine);
      authoritative = spine;
    },
    makeAvailable(spine: TSpine): void {
      assertOpen();
      assertIdentity(spine);
      if (authoritative === null) throw new Error('PRODUCTION_SPINE_NOT_BOUND');
      available = true;
    },
    makeUnavailable(): void {
      available = false;
    },
    close(): void {
      if (closed) return;
      available = false;
      authoritative = null;
      closed = true;
    },
  });

  return Object.freeze({ provider, owner });
}

export function assertAuthoritativeSpineIdentity<TSpine extends object>(
  authoritative: TSpine,
  candidate: TSpine,
  operation: 'RECOVERY' | 'RECONCILIATION' | 'WORKBENCH',
): void {
  if (authoritative !== candidate) {
    throw new Error(`${operation}_SECOND_PRODUCTION_SPINE_FORBIDDEN`);
  }
}
