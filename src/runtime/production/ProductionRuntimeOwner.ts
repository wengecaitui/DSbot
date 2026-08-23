import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { ExchangeId } from '../../data/MarketIdentity';
import { isExchangeId } from '../../data/MarketIdentity';
import type { MarketDataCollectorPort, MarketDataRuntime } from '../market/MarketDataRuntime';
import { createMarketDataRuntime } from '../market/MarketDataRuntime';
import type { SubscriptionPlan } from '../market/UniverseManager';
import { createBinanceMarketDataProvider } from '../trading/BinanceMarketDataProvider';
import { createBitgetMarketDataProvider } from '../trading/BitgetMarketDataProvider';
import { PaperLedgerStore } from '../../paper/PaperLedgerStore';
import type { PaperBrokerPersistence } from '../../paper/PaperBroker';
import type { PaperAccountConfig } from '../../types/paper-account';
import { canonicalizePaperAccountConfig } from '../../types/paper-account';
import type { AccountBoundHardRiskSnapshot } from '../../risk/pretrade-risk-types';
import { createFileEventJournal, type FileEventJournal } from '../../recovery/FileEventJournal';
import type { RecoveryResult } from '../../recovery/RecoveryManager';
import type { ReconciliationReport } from '../../reconciliation/reconciliation-types';
import {
  createProductionSpine,
  recoverAndStart,
  reconcileRecoveredState,
  type ProductionSpine,
  type ProductionSpineConfig,
} from '../../position/ProductionSpine';
import {
  LEGACY_WRITE_CAPABLE_PATHS,
  createProductionSpineReadBinding,
  type ProductionRuntimeState,
} from './ProductionRuntimeCompositionContract';

export interface ProductionRuntimeIdentity {
  readonly exchange: ExchangeId;
  readonly accountId: string;
}

export interface ProductionRuntimeHardRiskConfig {
  readonly enabled: true;
  readonly locked: boolean;
  readonly lockReason?: string;
  readonly totalCapitalUsd: number;
  readonly maxSinglePositionPct: number;
  readonly maxSinglePositionAbsUsd: number;
}

export interface ProductionRuntimeMarketEntry {
  readonly symbol: string;
  readonly exchangeSymbol: string;
  readonly intervals: readonly string[];
  readonly ticker: true;
}

export interface ProductionRuntimeConfig {
  readonly enabled: boolean;
  readonly mode?: 'paper';
  readonly exchange?: ExchangeId;
  readonly accountId?: string;
  readonly journalPath?: string;
  readonly checkpointPath?: string;
  readonly paperLedgerDir?: string;
  readonly initialCashUsd?: number;
  readonly hardRisk?: ProductionRuntimeHardRiskConfig;
  readonly market?: {
    readonly entries: readonly ProductionRuntimeMarketEntry[];
    readonly staleAfterMs?: number;
  };
}

export interface CanonicalHardRiskSource {
  readonly identity: ProductionRuntimeIdentity;
  snapshot(): AccountBoundHardRiskSnapshot;
}

export type LegacyWriteAuthorityMode = 'QUARANTINED' | 'LEGACY_UNCHANGED';

export interface LegacyWriteAuthorityPolicy {
  readonly mode: LegacyWriteAuthorityMode;
  readonly paths: typeof LEGACY_WRITE_CAPABLE_PATHS;
  canUse(path: (typeof LEGACY_WRITE_CAPABLE_PATHS)[number]): boolean;
}

export interface ProductionRuntimeStatusSnapshot {
  readonly state: ProductionRuntimeState;
  readonly identity: ProductionRuntimeIdentity | null;
  readonly reason: string | null;
  readonly spineCreations: number;
  readonly legacyWritePolicy: LegacyWriteAuthorityMode;
}

/**
 * Phase 8A public read surface. Exposes evidence only — never the mutable
 * ProductionSpine, its OMS/kernel/adapter/service/stores, or any recovery,
 * reconciliation, execution, or activation authority.
 */
export interface ProductionRuntimePublicReadView {
  status(): ProductionRuntimeStatusSnapshot;
  identity(): ProductionRuntimeIdentity | null;
  recovery(): RecoveryResult | null;
  reconciliation(): ReconciliationReport | null;
}

export interface ApplicationProductionRuntimeOwner {
  readonly read: ProductionRuntimePublicReadView;
  /**
   * Internal Workbench spine provider only. Resolves the exact owner spine (or
   * null); wired exclusively into WorkbenchReadAdapter inside createGateway and
   * never exposed through the public AppGateway.productionRuntime surface.
   */
  readonly authoritativeSpine: () => ProductionSpine | null;
  readonly legacyWrites: LegacyWriteAuthorityPolicy;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type RecoveryEvidence = RecoveryResult & { readonly errors?: readonly unknown[] };

export interface ProductionRuntimeOwnerDependencies {
  createJournal(path: string): FileEventJournal;
  createPaperPersistence(config: PaperAccountConfig, baseDir: string): PaperBrokerPersistence;
  createMarketRuntime(
    identity: ProductionRuntimeIdentity,
    plan: SubscriptionPlan,
    staleAfterMs: number | undefined,
  ): MarketDataRuntime;
  createHardRiskSource(
    identity: ProductionRuntimeIdentity,
    config: ProductionRuntimeHardRiskConfig,
  ): CanonicalHardRiskSource;
  createSpine(config: ProductionSpineConfig): Promise<ProductionSpine>;
  recover(
    spine: ProductionSpine,
    journal: FileEventJournal,
    checkpointPath?: string,
  ): Promise<RecoveryEvidence>;
  reconcile(spine: ProductionSpine): Promise<ReconciliationReport>;
}

interface ValidatedProductionRuntimeConfig {
  readonly identity: ProductionRuntimeIdentity;
  readonly journalPath: string;
  readonly checkpointPath?: string;
  readonly paperLedgerDir: string;
  readonly paperAccount: PaperAccountConfig;
  readonly hardRisk: ProductionRuntimeHardRiskConfig;
  readonly marketPlan: SubscriptionPlan;
  readonly marketStaleAfterMs?: number;
}

const activeOwners = new Map<string, symbol>();

function identityKey(identity: ProductionRuntimeIdentity): string {
  return `${identity.exchange}:${identity.accountId}`;
}

function copyIdentity(identity: ProductionRuntimeIdentity): ProductionRuntimeIdentity {
  return Object.freeze({ exchange: identity.exchange, accountId: identity.accountId });
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateAbsolutePath(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || !isAbsolute(value)) {
    throw new Error(`${name} must be an explicit absolute path`);
  }
  return value;
}

function validateHardRiskFacts(
  identity: ProductionRuntimeIdentity,
  snapshot: AccountBoundHardRiskSnapshot,
): AccountBoundHardRiskSnapshot {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('HARD_RISK_INCOMPLETE: snapshot is missing');
  if (snapshot.exchange !== identity.exchange || snapshot.accountId !== identity.accountId) {
    throw new Error('HARD_RISK_IDENTITY_MISMATCH');
  }
  if (snapshot.enabled !== true || typeof snapshot.locked !== 'boolean') {
    throw new Error('HARD_RISK_INCOMPLETE: enabled and locked must be explicit');
  }
  if (!Number.isFinite(snapshot.totalCapitalUsd) || snapshot.totalCapitalUsd <= 0) {
    throw new Error('HARD_RISK_PLACEHOLDER_REJECTED: totalCapitalUsd must be finite and positive');
  }
  if (
    !Number.isFinite(snapshot.maxSinglePositionPct)
    || snapshot.maxSinglePositionPct <= 0
    || snapshot.maxSinglePositionPct > 1
  ) {
    throw new Error('HARD_RISK_INCOMPLETE: maxSinglePositionPct must be in (0, 1]');
  }
  if (!Number.isFinite(snapshot.maxSinglePositionAbsUsd) || snapshot.maxSinglePositionAbsUsd <= 0) {
    throw new Error('HARD_RISK_PLACEHOLDER_REJECTED: maxSinglePositionAbsUsd must be finite and positive');
  }
  if (snapshot.locked && (typeof snapshot.lockReason !== 'string' || snapshot.lockReason.trim().length === 0)) {
    throw new Error('HARD_RISK_INCOMPLETE: locked snapshots require a reason');
  }
  return snapshot;
}

export function assertCanonicalHardRiskSource(
  identity: ProductionRuntimeIdentity,
  source: CanonicalHardRiskSource,
): AccountBoundHardRiskSnapshot {
  if (
    !source
    || source.identity?.exchange !== identity.exchange
    || source.identity?.accountId !== identity.accountId
    || typeof source.snapshot !== 'function'
  ) {
    throw new Error('HARD_RISK_IDENTITY_MISMATCH');
  }
  return validateHardRiskFacts(identity, source.snapshot());
}

export function createConfiguredCanonicalHardRiskSource(
  identity: ProductionRuntimeIdentity,
  config: ProductionRuntimeHardRiskConfig,
): CanonicalHardRiskSource {
  const sourceIdentity = copyIdentity(identity);
  const snapshot = Object.freeze<AccountBoundHardRiskSnapshot>({
    exchange: sourceIdentity.exchange,
    accountId: sourceIdentity.accountId,
    enabled: config.enabled,
    locked: config.locked,
    ...(config.lockReason === undefined ? {} : { lockReason: config.lockReason }),
    totalCapitalUsd: config.totalCapitalUsd,
    maxSinglePositionPct: config.maxSinglePositionPct,
    maxSinglePositionAbsUsd: config.maxSinglePositionAbsUsd,
  });
  validateHardRiskFacts(sourceIdentity, snapshot);
  return Object.freeze({ identity: sourceIdentity, snapshot: () => snapshot });
}

export function createLegacyWriteAuthorityPolicy(runtimeRequested: boolean): LegacyWriteAuthorityPolicy {
  const mode: LegacyWriteAuthorityMode = runtimeRequested ? 'QUARANTINED' : 'LEGACY_UNCHANGED';
  return Object.freeze({
    mode,
    paths: LEGACY_WRITE_CAPABLE_PATHS,
    canUse: (_path: (typeof LEGACY_WRITE_CAPABLE_PATHS)[number]) => mode !== 'QUARANTINED',
  });
}

function validateMarketPlan(config: ProductionRuntimeConfig['market']): SubscriptionPlan {
  if (!config || !Array.isArray(config.entries) || config.entries.length === 0) {
    throw new Error('market.entries must contain an explicit subscription universe');
  }
  const seen = new Set<string>();
  const entries = config.entries.map((entry) => {
    if (!entry || typeof entry.symbol !== 'string' || entry.symbol.length === 0 || /\s/.test(entry.symbol)) {
      throw new Error('market entry symbol must be explicit and canonical');
    }
    if (
      typeof entry.exchangeSymbol !== 'string'
      || entry.exchangeSymbol.length === 0
      || /\s/.test(entry.exchangeSymbol)
    ) {
      throw new Error(`market entry ${entry.symbol} requires exchangeSymbol`);
    }
    if (!Array.isArray(entry.intervals) || entry.intervals.length === 0) {
      throw new Error(`market entry ${entry.symbol} requires intervals`);
    }
    if (entry.intervals.some((interval: unknown) => typeof interval !== 'string' || interval.length === 0)) {
      throw new Error(`market entry ${entry.symbol} has an invalid interval`);
    }
    if (entry.ticker !== true) throw new Error(`market entry ${entry.symbol} must enable ticker ingestion`);
    if (seen.has(entry.symbol)) throw new Error(`market entry ${entry.symbol} is duplicated`);
    seen.add(entry.symbol);
    return Object.freeze({
      symbol: entry.symbol,
      exchangeSymbol: entry.exchangeSymbol,
      intervals: Object.freeze([...entry.intervals]),
      ticker: true as const,
    });
  });
  return Object.freeze({ version: 1, entries: Object.freeze(entries) });
}

function validateConfig(config: ProductionRuntimeConfig): ValidatedProductionRuntimeConfig {
  if (config.mode !== 'paper') throw new Error('mode must be explicitly paper');
  if (!isExchangeId(config.exchange)) throw new Error('exchange must be explicitly bitget or binance');
  if (typeof config.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.accountId)) {
    throw new Error('accountId must be explicit and valid');
  }
  const identity = copyIdentity({ exchange: config.exchange, accountId: config.accountId });
  const journalPath = validateAbsolutePath('journalPath', config.journalPath);
  const paperLedgerDir = validateAbsolutePath('paperLedgerDir', config.paperLedgerDir);
  const checkpointPath = config.checkpointPath === undefined
    ? undefined
    : validateAbsolutePath('checkpointPath', config.checkpointPath);
  const paperAccount = canonicalizePaperAccountConfig({
    exchange: identity.exchange,
    accountId: identity.accountId,
    initialCashUsd: config.initialCashUsd ?? Number.NaN,
  });
  if (!config.hardRisk) throw new Error('hardRisk facts are required');
  createConfiguredCanonicalHardRiskSource(identity, config.hardRisk);
  const marketPlan = validateMarketPlan(config.market);
  const marketStaleAfterMs = config.market?.staleAfterMs;
  if (
    marketStaleAfterMs !== undefined
    && (!Number.isFinite(marketStaleAfterMs) || marketStaleAfterMs <= 0)
  ) {
    throw new Error('market.staleAfterMs must be finite and positive');
  }
  return {
    identity,
    journalPath,
    ...(checkpointPath === undefined ? {} : { checkpointPath }),
    paperLedgerDir,
    paperAccount,
    hardRisk: config.hardRisk,
    marketPlan,
    ...(marketStaleAfterMs === undefined ? {} : { marketStaleAfterMs }),
  };
}

function ensureWritableDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  accessSync(path, constants.W_OK);
}

function createDurableJournal(path: string): FileEventJournal {
  ensureWritableDirectory(dirname(path));
  if (existsSync(path)) accessSync(path, constants.R_OK | constants.W_OK);
  return createFileEventJournal(path);
}

function createOwnerMarketRuntime(
  identity: ProductionRuntimeIdentity,
  plan: SubscriptionPlan,
  staleAfterMs: number | undefined,
): MarketDataRuntime {
  const provider = identity.exchange === 'bitget'
    ? createBitgetMarketDataProvider({})
    : createBinanceMarketDataProvider({});
  return createMarketDataRuntime({
    collectorFactory: () => provider.createCollector(plan),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  });
}

const defaultDependencies: ProductionRuntimeOwnerDependencies = {
  createJournal: createDurableJournal,
  createPaperPersistence(config, baseDir) {
    ensureWritableDirectory(baseDir);
    return new PaperLedgerStore(config, { baseDir });
  },
  createMarketRuntime: createOwnerMarketRuntime,
  createHardRiskSource: createConfiguredCanonicalHardRiskSource,
  createSpine: createProductionSpine,
  recover: recoverAndStart,
  reconcile: reconcileRecoveredState,
};

export function createApplicationProductionRuntimeOwner(
  config: ProductionRuntimeConfig | undefined,
  dependencyOverrides: Partial<ProductionRuntimeOwnerDependencies> = {},
): ApplicationProductionRuntimeOwner {
  const dependencies: ProductionRuntimeOwnerDependencies = { ...defaultDependencies, ...dependencyOverrides };
  const legacyWrites = createLegacyWriteAuthorityPolicy(config?.enabled === true);
  const binding = createProductionSpineReadBinding<ProductionSpine>();
  let validated: ValidatedProductionRuntimeConfig | null = null;
  let state: ProductionRuntimeState = config?.enabled === false ? 'DISABLED' : 'NOT_CONFIGURED';
  let reason: string | null = null;
  let authoritativeSpine: ProductionSpine | null = null;
  let marketRuntime: MarketDataRuntime | null = null;
  let journal: FileEventJournal | null = null;
  let recoveryEvidence: RecoveryResult | null = null;
  let reconciliationEvidence: ReconciliationReport | null = null;
  let spineCreations = 0;
  let reservation: symbol | null = null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let terminal = false;
  let cleanupComplete = false;

  if (config?.enabled === true) {
    try {
      validated = validateConfig(config);
      state = 'STOPPED';
    } catch (error) {
      reason = failureMessage(error);
      state = 'NOT_CONFIGURED';
    }
  } else if (config === undefined) {
    reason = 'authoritative production runtime is not configured';
  } else {
    reason = 'authoritative production runtime is disabled';
  }

  function releaseReservation(): void {
    if (!validated || reservation === null) return;
    const key = identityKey(validated.identity);
    if (activeOwners.get(key) === reservation) activeOwners.delete(key);
    reservation = null;
  }

  function reserveIdentity(identity: ProductionRuntimeIdentity): void {
    const key = identityKey(identity);
    if (activeOwners.has(key)) throw new Error(`SECOND_PRODUCTION_RUNTIME_OWNER_FORBIDDEN: ${key}`);
    reservation = Symbol(key);
    activeOwners.set(key, reservation);
  }

  function cleanupOwnedResources(): readonly unknown[] {
    binding.owner.makeUnavailable();
    const failures: unknown[] = [];
    if (!cleanupComplete) {
      try { authoritativeSpine?.protection.stop(); } catch (error) { failures.push(error); }
      try { marketRuntime?.stop(); } catch (error) { failures.push(error); }
      try { journal?.close(); } catch (error) { failures.push(error); }
      if (failures.length === 0) cleanupComplete = true;
    }
    return failures;
  }

  const read: ProductionRuntimePublicReadView = Object.freeze({
    status(): ProductionRuntimeStatusSnapshot {
      return Object.freeze({
        state,
        identity: validated ? copyIdentity(validated.identity) : null,
        reason,
        spineCreations,
        legacyWritePolicy: legacyWrites.mode,
      });
    },
    identity: () => (validated ? copyIdentity(validated.identity) : null),
    recovery: () => recoveryEvidence,
    reconciliation: () => reconciliationEvidence,
  });

  async function start(): Promise<void> {
    if (!validated) return;
    if (terminal) throw new Error('PRODUCTION_RUNTIME_OWNER_TERMINAL');
    if (startPromise) return startPromise;

    startPromise = (async () => {
      state = 'STARTING';
      reason = null;
      let failureState: ProductionRuntimeState = 'RECOVERY_FAILED';
      try {
        reserveIdentity(validated.identity);
        const hardRiskSource = dependencies.createHardRiskSource(validated.identity, validated.hardRisk);
        assertCanonicalHardRiskSource(validated.identity, hardRiskSource);

        journal = dependencies.createJournal(validated.journalPath);
        const persistence = dependencies.createPaperPersistence(validated.paperAccount, validated.paperLedgerDir);
        marketRuntime = dependencies.createMarketRuntime(
          validated.identity,
          validated.marketPlan,
          validated.marketStaleAfterMs,
        );
        const readHardRisk = (): AccountBoundHardRiskSnapshot =>
          assertCanonicalHardRiskSource(validated!.identity, hardRiskSource);

        authoritativeSpine = await dependencies.createSpine({
          exchange: validated.identity.exchange,
          accountId: validated.identity.accountId,
          paperAccount: validated.paperAccount,
          persistence,
          journal,
          hardRisk: readHardRisk,
          marketRuntime,
        });
        spineCreations += 1;
        if (spineCreations !== 1) throw new Error('SECOND_PRODUCTION_SPINE_FORBIDDEN');
        binding.owner.bind(authoritativeSpine);

        state = 'RECOVERING';
        const recovered = await dependencies.recover(
          authoritativeSpine,
          journal,
          validated.checkpointPath,
        );
        recoveryEvidence = recovered;
        if (!recovered.recoveryVerified) throw new Error('PRODUCTION_RUNTIME_RECOVERY_FAILED');
        state = 'RECOVERY_VERIFIED';

        state = 'RECONCILING';
        failureState = 'RECONCILIATION_FAILED';
        const reconciliation = await dependencies.reconcile(authoritativeSpine);
        reconciliationEvidence = reconciliation;
        if (!reconciliation.reconciliationVerified) {
          throw new Error(`PRODUCTION_RUNTIME_RECONCILIATION_FAILED: ${reconciliation.outcome}`);
        }

        authoritativeSpine.protection.start();
        failureState = 'MARKET_FAILED';
        await marketRuntime.start();
        state = 'READY_FOR_MARKET';
        binding.owner.makeAvailable(authoritativeSpine);
      } catch (error) {
        state = failureState;
        reason = failureMessage(error);
        terminal = true;
        const cleanupFailures = cleanupOwnedResources();
        if (cleanupFailures.length === 0) {
          binding.owner.close();
          releaseReservation();
        }
        // On rollback cleanup failure the singleton reservation stays held (fail-closed).
        throw error;
      }
    })();
    return startPromise;
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      binding.owner.makeUnavailable();
      if (state !== 'DISABLED' && state !== 'NOT_CONFIGURED') state = 'STOPPING';
      terminal = true;
      const cleanupFailures = cleanupOwnedResources();
      if (cleanupFailures.length === 0) {
        binding.owner.close();
        releaseReservation();
        if (state !== 'DISABLED' && state !== 'NOT_CONFIGURED') state = 'STOPPED';
      } else if (state !== 'DISABLED' && state !== 'NOT_CONFIGURED') {
        // Fail closed: retain the singleton reservation; do not claim a clean STOPPED.
        state = 'STOP_FAILED';
      }
    })();
    return stopPromise;
  }

  return Object.freeze({ read, authoritativeSpine: binding.provider.productionSpine, legacyWrites, start, stop });
}

/** Test-only convenience type for injected collectors; production uses exchange providers. */
export type ProductionRuntimeCollectorFactory = () => MarketDataCollectorPort;
