import type { MarketSnapshot } from '../data/MarketSnapshot';
import type { CoordinatorSnapshot } from '../hermes/types';
import type { ProductionSpine } from '../position/ProductionSpine';
import type { RecoveryResult } from '../recovery/RecoveryManager';
import type { VersionedPolicySnapshot } from '../types/policy-snapshot';
import type {
  BinanceAccountTruthSnapshot,
  BinanceAuthenticatedReadFoundation,
  BinanceInstrumentFactsSnapshot,
  BinanceReadResult,
} from '../runtime/binance/BinanceAuthenticatedReadFoundation';
import type { ObservableAgentEvent } from './contracts';
import type { OperationsEvidenceBridgeStatus } from './OperationsEvidenceReadBridge';
import type { ProjectControlCenterSnapshot } from './project-control-center';
import {
  createWorkbenchOverviewSnapshot,
  WORKBENCH_V1_ROUTES,
  type AccountOverviewSnapshot,
  type ActivityOverviewSnapshot,
  type BinanceAccountReadObservation,
  type BinanceInstrumentReadObservation,
  type BinanceReadOverviewSnapshot,
  type MarketOverviewSnapshot,
  type OperationsOverviewSnapshot,
  type PersistentTerminalStatusSnapshot,
  type PositionOverviewRecord,
  type ReadOnlySnapshot,
  type ResearchOverviewSnapshot,
  type RuntimeHealth,
  type RuntimeOverviewSnapshot,
  type SafetyOverviewSnapshot,
  type SnapshotFreshness,
  type SnapshotProvenance,
  type TradingEnvironment,
  type TradingOverviewSnapshot,
  type WorkbenchOverviewSnapshot,
} from './workbench-contract';

export interface RuntimeReadEvidence {
  readonly health: RuntimeHealth;
  readonly environment: TradingEnvironment;
  readonly mode: string | null;
}

export interface PolicyOverviewSnapshot {
  readonly policies: readonly VersionedPolicySnapshot[];
}

export interface DataSourceEvidence {
  readonly sourceId: string;
  readonly source: string;
  readonly status: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE' | 'UNKNOWN';
  readonly lastUpdatedAt: number | null;
  readonly version: number | null;
}

export interface DataOverviewSnapshot {
  readonly sources: readonly DataSourceEvidence[];
}

export interface WorkbenchStatusResponse {
  readonly capturedAt: number;
  readonly status: PersistentTerminalStatusSnapshot;
}

export interface WorkbenchReadAdapterOptions {
  readonly now: () => number;
  readonly runtime: () => RuntimeReadEvidence;
  readonly hermes: () => CoordinatorSnapshot | null;
  /** Existing canonical spine only. The adapter never creates a runtime. */
  readonly productionSpine?: () => ProductionSpine | null;
  /** Exact recovery result when the owning runtime retained one. */
  readonly recovery?: () => RecoveryResult | null;
  readonly projectControlCenter?: () => ProjectControlCenterSnapshot | null;
  readonly activity?: () => readonly ObservableAgentEvent[];
  readonly operationsEvidenceStatus?: () => OperationsEvidenceBridgeStatus;
  /** Existing internal L1A read-only foundation. The adapter never creates a client. */
  readonly binanceAuthenticatedRead?: () => BinanceAuthenticatedReadFoundation | null;
}

export interface WorkbenchReadAdapter {
  overview(): WorkbenchOverviewSnapshot;
  runtime(): ReadOnlySnapshot<RuntimeOverviewSnapshot>;
  market(): ReadOnlySnapshot<MarketOverviewSnapshot>;
  trading(): ReadOnlySnapshot<TradingOverviewSnapshot>;
  account(): ReadOnlySnapshot<AccountOverviewSnapshot>;
  binanceRead(): Promise<ReadOnlySnapshot<BinanceReadOverviewSnapshot>>;
  safety(): ReadOnlySnapshot<SafetyOverviewSnapshot>;
  research(): ReadOnlySnapshot<ResearchOverviewSnapshot>;
  activity(): ReadOnlySnapshot<ActivityOverviewSnapshot>;
  operations(): ReadOnlySnapshot<OperationsOverviewSnapshot>;
  policy(): ReadOnlySnapshot<PolicyOverviewSnapshot>;
  data(): ReadOnlySnapshot<DataOverviewSnapshot>;
  status(): WorkbenchStatusResponse;
  routes(): typeof WORKBENCH_V1_ROUTES;
}

function assertNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('workbench capture time must be finite and non-negative');
  return value;
}

function provenance(
  capturedAt: number,
  source: string,
  sourceSequence: number | null = null,
  sourceVersion: number | null = null,
  lastUpdatedAt: number | null = null,
): SnapshotProvenance {
  return { capturedAt, source, sourceSequence, sourceVersion, lastUpdatedAt };
}

function unavailable<T>(capturedAt: number, source: string, reason: string): ReadOnlySnapshot<T> {
  return {
    availability: 'UNAVAILABLE',
    freshness: 'UNKNOWN',
    provenance: provenance(capturedAt, source),
    data: null,
    reason,
  };
}

function maxFinite(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) : null;
}

function marketFreshness(markets: readonly MarketSnapshot[]): SnapshotFreshness {
  if (markets.length === 0) return 'UNKNOWN';
  return markets.some((market) => market.isStale) ? 'STALE' : 'FRESH';
}

function spineOrNull(options: WorkbenchReadAdapterOptions): ProductionSpine | null {
  return options.productionSpine?.() ?? null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

type ProjectableBinanceSnapshot = {
  readonly freshness: { readonly status: SnapshotFreshness };
  readonly source: string;
} & (
  | { readonly accountUpdateTime: number }
  | { readonly markPriceTime: number | null }
);

function mapBinanceResult<T extends ProjectableBinanceSnapshot>(
  capturedAt: number,
  fallbackSource: string,
  observed: BinanceReadResult<T>,
): ReadOnlySnapshot<T> {
  if (observed.availability === 'AVAILABLE' && observed.value !== null) {
    const value = structuredClone(observed.value);
    const lastUpdatedAt = 'accountUpdateTime' in value ? value.accountUpdateTime : value.markPriceTime;
    return deepFreeze({
      availability: 'AVAILABLE',
      freshness: value.freshness.status,
      provenance: provenance(capturedAt, value.source, null, null, lastUpdatedAt),
      data: value,
    });
  }
  return deepFreeze({
    availability: observed.availability === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'UNKNOWN',
    freshness: 'UNKNOWN',
    provenance: provenance(capturedAt, fallbackSource),
    data: null,
    reason: observed.reason ?? 'BINANCE_READ_RESULT_INVALID',
  });
}

function withoutAccountIdentity(snapshot: BinanceAccountTruthSnapshot): BinanceAccountReadObservation {
  const {
    accountState, balances, positions, openOrders, recentFills, serverTime,
    accountUpdateTime, observedAt, freshness, source, schemaVersion, sequence,
  } = structuredClone(snapshot);
  return {
    accountState, balances, positions, openOrders, recentFills, serverTime,
    accountUpdateTime, observedAt, freshness, source, schemaVersion, sequence,
  };
}

function binanceSymbols(options: WorkbenchReadAdapterOptions): readonly string[] | null {
  const spine = spineOrNull(options);
  if (!spine) return null;
  return Object.freeze([...new Set(
    spine.marketStore.getAllSnapshots()
      .filter((snapshot) => snapshot.exchange === 'binance')
      .map((snapshot) => snapshot.symbol),
  )].sort((left, right) => left.localeCompare(right)));
}

function combinedFreshness(snapshots: readonly ReadOnlySnapshot<unknown>[]): SnapshotFreshness {
  if (snapshots.some((snapshot) => snapshot.freshness === 'STALE')) return 'STALE';
  if (snapshots.length > 0 && snapshots.every((snapshot) => snapshot.freshness === 'FRESH')) return 'FRESH';
  return 'UNKNOWN';
}

function readPositions(spine: ProductionSpine, markets: readonly MarketSnapshot[]): PositionOverviewRecord[] {
  const records = new Map<string, PositionOverviewRecord>();
  for (const resolution of spine.positionStore.listResolved()) {
    if (!resolution.snapshot) continue;
    const { exchange, symbol } = resolution.snapshot;
    records.set(`${exchange}:${symbol}`, { exchange, symbol, resolution });
  }
  // A tracked market with no initialized position is factually "missing", not flat.
  for (const market of markets) {
    const key = `${market.exchange}:${market.symbol}`;
    if (!records.has(key)) {
      records.set(key, {
        exchange: market.exchange,
        symbol: market.symbol,
        resolution: spine.positionStore.resolve(market.exchange, market.symbol),
      });
    }
  }
  return [...records.values()].sort((left, right) =>
    `${left.exchange}:${left.symbol}`.localeCompare(`${right.exchange}:${right.symbol}`));
}

export function createWorkbenchReadAdapter(options: WorkbenchReadAdapterOptions): WorkbenchReadAdapter {
  function capture(): number {
    return assertNow(options.now());
  }

  function runtime(capturedAt = capture()): ReadOnlySnapshot<RuntimeOverviewSnapshot> {
    const evidence = options.runtime();
    const hermes = options.hermes();
    return {
      availability: 'AVAILABLE',
      freshness: hermes?.health === 'healthy' ? 'FRESH' : 'UNKNOWN',
      provenance: provenance(
        capturedAt,
        'gateway-lifecycle+HandshakeCoordinator',
        hermes?.generation ?? null,
        hermes?.generation ?? null,
        hermes?.lastHealthConfirmedAt ?? hermes?.startedAt ?? null,
      ),
      data: { ...evidence, hermes },
    };
  }

  function market(capturedAt = capture()): ReadOnlySnapshot<MarketOverviewSnapshot> {
    const spine = spineOrNull(options);
    if (!spine) return unavailable(capturedAt, 'KernelMarketStateStore', 'canonical production spine is not mounted');
    const instruments = [...spine.marketStore.getAllSnapshots()].sort((left, right) =>
      `${left.exchange}:${left.symbol}`.localeCompare(`${right.exchange}:${right.symbol}`));
    const freshness = marketFreshness(instruments);
    return {
      availability: instruments.length > 0 ? 'AVAILABLE' : 'INCOMPLETE',
      freshness,
      provenance: provenance(
        capturedAt,
        'KernelMarketStateStore',
        maxFinite(instruments.map((item) => item.snapshotVersion)),
        maxFinite(instruments.map((item) => item.snapshotVersion)),
        maxFinite(instruments.map((item) => item.lastUpdatedAt)),
      ),
      data: { instruments, regime: null },
      ...(instruments.length === 0 ? { reason: 'no canonical market snapshots are available' } : {}),
    };
  }

  function trading(capturedAt = capture()): ReadOnlySnapshot<TradingOverviewSnapshot> {
    const spine = spineOrNull(options);
    if (!spine) return unavailable(capturedAt, 'KernelPositionStateStore+OmsOrderStore+PositionPlanStore', 'canonical production spine is not mounted');
    const markets = [...spine.marketStore.getAllSnapshots()].sort((left, right) =>
      `${left.exchange}:${left.symbol}`.localeCompare(`${right.exchange}:${right.symbol}`));
    const positions = readPositions(spine, markets);
    const orders = [...spine.oms.getStore().list()].sort((left, right) => left.orderId.localeCompare(right.orderId));
    const protectivePlans = [...spine.planStore.list()].sort((left, right) => left.planId.localeCompare(right.planId));
    const versions = [
      ...positions.map((item) => item.resolution.snapshot?.positionVersion),
      ...orders.map((item) => item.orderVersion),
      ...protectivePlans.map((item) => item.planVersion),
    ];
    return {
      availability: 'AVAILABLE',
      freshness: marketFreshness(markets),
      provenance: provenance(capturedAt, 'KernelPositionStateStore+OmsOrderStore+PositionPlanStore', maxFinite(versions), maxFinite(versions)),
      data: { positions, orders, protectivePlans },
    };
  }

  function account(capturedAt = capture()): ReadOnlySnapshot<AccountOverviewSnapshot> {
    const spine = spineOrNull(options);
    if (!spine) return unavailable(capturedAt, 'ProductionSpine.accounting', 'canonical production spine is not mounted');
    const accounting = spine.accounting.snapshot();
    const tradeLifecycle = spine.accounting.lifecycle();
    return {
      availability: accounting.valuationStatus === 'COMPLETE' ? 'AVAILABLE' : 'INCOMPLETE',
      freshness: accounting.valuationStatus === 'COMPLETE' ? 'FRESH' : 'UNKNOWN',
      provenance: provenance(
        capturedAt,
        accounting.source,
        accounting.sourceLedgerSequence,
        accounting.sourceLedgerSequence,
        accounting.sourceLedgerUpdatedAt,
      ),
      data: { accounting, tradeLifecycle },
      ...(accounting.valuationStatus === 'COMPLETE' ? {} : { reason: 'canonical runtime accounting is incomplete' }),
    };
  }

  async function binanceRead(): Promise<ReadOnlySnapshot<BinanceReadOverviewSnapshot>> {
    const capturedAt = capture();
    let foundation: BinanceAuthenticatedReadFoundation | null;
    try {
      foundation = options.binanceAuthenticatedRead?.() ?? null;
    } catch {
      return unavailable(capturedAt, 'Binance authenticated-read projection', 'BINANCE_READ_FOUNDATION_UNAVAILABLE');
    }
    if (!foundation) {
      return unavailable(capturedAt, 'Binance authenticated-read projection', 'BINANCE_READ_FOUNDATION_UNAVAILABLE');
    }

    let accountResult: ReadOnlySnapshot<BinanceAccountReadObservation>;
    try {
      const observed = await foundation.accountTruth.read();
      accountResult = mapBinanceResult(capturedAt, 'BinanceAccountTruthPort', {
        availability: observed.availability,
        value: observed.value === null ? null : withoutAccountIdentity(observed.value),
        reason: observed.reason,
      });
    } catch {
      accountResult = deepFreeze({
        availability: 'UNKNOWN', freshness: 'UNKNOWN',
        provenance: provenance(capturedAt, 'BinanceAccountTruthPort'), data: null,
        reason: 'BINANCE_ACCOUNT_READ_FAILED',
      });
    }

    const symbols = binanceSymbols(options);
    let instrumentResult: ReadOnlySnapshot<readonly BinanceInstrumentReadObservation[]>;
    if (!symbols || symbols.length === 0) {
      instrumentResult = unavailable(
        capturedAt,
        'KernelMarketStateStore+BinanceInstrumentFactsPort',
        'CANONICAL_BINANCE_SYMBOL_SOURCE_UNAVAILABLE',
      );
    } else {
      const observations: BinanceInstrumentReadObservation[] = [];
      for (const symbol of symbols) {
        let observation: ReadOnlySnapshot<BinanceInstrumentFactsSnapshot>;
        try {
          observation = mapBinanceResult(
            capturedAt,
            'BinanceInstrumentFactsPort',
            await foundation.instrumentFacts.read(symbol),
          );
        } catch {
          observation = deepFreeze({
            availability: 'UNKNOWN', freshness: 'UNKNOWN',
            provenance: provenance(capturedAt, 'BinanceInstrumentFactsPort'), data: null,
            reason: 'BINANCE_INSTRUMENT_READ_FAILED',
          });
        }
        observations.push(deepFreeze({ requestedSymbol: symbol, observation }));
      }
      const observationsFreshness = combinedFreshness(observations.map((item) => item.observation));
      const allAvailable = observations.every((item) => item.observation.availability === 'AVAILABLE');
      instrumentResult = deepFreeze({
        availability: allAvailable ? 'AVAILABLE' : 'INCOMPLETE',
        freshness: observationsFreshness,
        provenance: provenance(
          capturedAt,
          'KernelMarketStateStore+BinanceInstrumentFactsPort',
          null,
          null,
          maxFinite(observations.map((item) => item.observation.provenance.lastUpdatedAt)),
        ),
        data: observations,
        ...(allAvailable ? {} : { reason: 'one or more Binance instrument observations are unavailable' }),
      });
    }

    let rawStatus;
    try {
      rawStatus = foundation.status();
    } catch {
      return unavailable(capturedAt, 'Binance authenticated-read projection', 'BINANCE_READ_STATUS_UNAVAILABLE');
    }
    const status = deepFreeze({
      implemented: true as const,
      configured: rawStatus.configured,
      connected: rawStatus.connected,
      lastObservedAt: rawStatus.lastObservedAt,
      reason: rawStatus.reason,
      realClientDefaultWired: rawStatus.realClientDefaultWired,
      realCredentialDiscovery: rawStatus.realCredentialDiscovery,
      readVerified: false as const,
      writeRouted: false as const,
      activated: false as const,
    });
    const freshness = combinedFreshness([accountResult, instrumentResult]);
    const complete = accountResult.availability === 'AVAILABLE' && instrumentResult.availability === 'AVAILABLE';
    return deepFreeze({
      availability: complete ? 'AVAILABLE' : 'INCOMPLETE',
      freshness,
      provenance: provenance(
        capturedAt,
        'BinanceAccountTruthPort+BinanceInstrumentFactsPort',
        null,
        null,
        rawStatus.lastObservedAt,
      ),
      data: {
        status,
        account: accountResult,
        instruments: instrumentResult,
        canonicalReconciliationEstablished: false as const,
      },
      ...(complete ? {} : { reason: 'Binance exchange observations are incomplete or unavailable' }),
    });
  }

  function safety(capturedAt = capture()): ReadOnlySnapshot<SafetyOverviewSnapshot> {
    const spine = spineOrNull(options);
    if (!spine) return unavailable(capturedAt, 'ProductionSpine safety gate', 'canonical production spine is not mounted');
    const recovery = options.recovery?.() ?? null;
    const reconciliation = spine.lastReconciliationReport;
    const mode = spine.protection.getMode();
    const hardRisk = spine.privateConfig.hardRisk();
    const blockers: string[] = [];
    if (!spine.recoveryVerified) blockers.push('recovery is not verified');
    if (!spine.reconciliationVerified) blockers.push('reconciliation is not verified');
    if (mode !== 'live') blockers.push('LIVE_READY is not established');
    if (hardRisk.locked) blockers.push(hardRisk.lockReason ?? 'kill switch is locked');
    const incomplete = recovery === null || reconciliation === null;
    return {
      availability: incomplete ? 'INCOMPLETE' : 'AVAILABLE',
      freshness: reconciliation ? 'FRESH' : 'UNKNOWN',
      provenance: provenance(capturedAt, 'ProductionSpine safety gate', null, null, reconciliation?.capturedAt ?? null),
      data: {
        recovery,
        reconciliation,
        liveReady: {
          status: mode === 'live' ? 'READY' : 'NOT_READY',
          authority: 'ProductionSpine safety gate',
          mutableFromWorkbench: false,
          blockers,
        },
        killSwitch: {
          status: hardRisk.locked ? 'TRIGGERED' : 'CLEAR',
          authority: 'ProductionSpine hardRisk snapshot',
          reason: hardRisk.lockReason ?? null,
          mutableFromWorkbench: false,
        },
        riskBlockers: blockers,
      },
      ...(incomplete ? { reason: 'one or more canonical safety reports are unavailable' } : {}),
    };
  }

  function research(capturedAt = capture()): ReadOnlySnapshot<ResearchOverviewSnapshot> {
    return unavailable(capturedAt, 'research-data-plane', 'no canonical research provider or job runtime is mounted');
  }

  function activity(capturedAt = capture()): ReadOnlySnapshot<ActivityOverviewSnapshot> {
    if (!options.activity) return unavailable(capturedAt, 'observability-event-source', 'runtime event source is not mounted');
    const events = [...options.activity()];
    const evidenceStatus = options.operationsEvidenceStatus?.() ?? null;
    const current = evidenceStatus?.availability === 'AVAILABLE' && evidenceStatus.freshness === 'FRESH';
    return {
      availability: current ? 'AVAILABLE' : 'INCOMPLETE',
      freshness: current && events.length > 0
        ? 'FRESH'
        : evidenceStatus?.freshness === 'STALE' ? 'STALE' : 'UNKNOWN',
      provenance: provenance(capturedAt, 'OperationsEvidenceReadBridge', null, null, evidenceStatus?.lastUpdatedAt ?? null),
      data: { events },
      ...(!current ? { reason: 'Activity evidence is unavailable, incomplete, stopped, or stale' } : {}),
    };
  }

  function operations(capturedAt = capture()): ReadOnlySnapshot<OperationsOverviewSnapshot> {
    const hermes = options.hermes();
    const projectControlCenter = options.projectControlCenter?.() ?? null;
    const recentEvents = options.activity ? [...options.activity()] : [];
    const evidenceStatus = options.operationsEvidenceStatus?.() ?? null;
    const incomplete = projectControlCenter === null
      || !options.activity
      || evidenceStatus === null
      || evidenceStatus.availability !== 'AVAILABLE';
    return {
      availability: incomplete ? 'INCOMPLETE' : 'AVAILABLE',
      freshness: evidenceStatus?.freshness ?? 'UNKNOWN',
      provenance: provenance(capturedAt, 'OperationsEvidenceReadBridge+ProjectControlCenter', null, null, evidenceStatus?.lastUpdatedAt ?? null),
      data: {
        hermes,
        recentEvents,
        projectControlCenter,
        evidenceStatus: evidenceStatus ? structuredClone(evidenceStatus) : null,
        controlCenterDomain: 'operations',
      },
      ...(incomplete ? { reason: 'Operations evidence is unavailable, incomplete, stopped, or stale' } : {}),
    };
  }

  function policy(capturedAt = capture()): ReadOnlySnapshot<PolicyOverviewSnapshot> {
    const spine = spineOrNull(options);
    if (!spine) return unavailable(capturedAt, 'KernelPolicyStore', 'canonical production spine is not mounted');
    const exchanges = [...new Set(spine.marketStore.getAllSnapshots().map((item) => item.exchange))].sort();
    const policies = exchanges
      .map((exchange) => spine.policyStore.getLatest(exchange))
      .filter((item): item is VersionedPolicySnapshot => item !== undefined)
      .sort((left, right) => left.exchange.localeCompare(right.exchange));
    return {
      availability: policies.length > 0 ? 'AVAILABLE' : 'INCOMPLETE',
      freshness: policies.length > 0 ? 'FRESH' : 'UNKNOWN',
      provenance: provenance(capturedAt, 'KernelPolicyStore', maxFinite(policies.map((item) => item.policyVersion)), maxFinite(policies.map((item) => item.policyVersion)), maxFinite(policies.map((item) => item.publishedAt))),
      data: { policies },
      ...(policies.length > 0 ? {} : { reason: 'no canonical policy snapshots are available' }),
    };
  }

  function data(capturedAt = capture()): ReadOnlySnapshot<DataOverviewSnapshot> {
    const spine = spineOrNull(options);
    if (!spine) return unavailable(capturedAt, 'KernelMarketStateStore', 'canonical production spine is not mounted');
    const markets = [...spine.marketStore.getAllSnapshots()].sort((left, right) =>
      `${left.exchange}:${left.symbol}`.localeCompare(`${right.exchange}:${right.symbol}`));
    const sources = markets.map((item) => ({
      sourceId: `${item.exchange}:${item.symbol}`,
      source: 'KernelMarketStateStore',
      status: item.isStale ? 'STALE' as const : 'AVAILABLE' as const,
      lastUpdatedAt: item.lastUpdatedAt,
      version: item.snapshotVersion,
    }));
    return {
      availability: sources.length > 0 ? 'AVAILABLE' : 'INCOMPLETE',
      freshness: marketFreshness(markets),
      provenance: provenance(capturedAt, 'KernelMarketStateStore', maxFinite(markets.map((item) => item.snapshotVersion)), maxFinite(markets.map((item) => item.snapshotVersion)), maxFinite(markets.map((item) => item.lastUpdatedAt))),
      data: { sources },
      ...(sources.length > 0 ? {} : { reason: 'no canonical data source evidence is available' }),
    };
  }

  function overview(): WorkbenchOverviewSnapshot {
    const capturedAt = capture();
    return createWorkbenchOverviewSnapshot({
      capturedAt,
      runtime: runtime(capturedAt),
      market: market(capturedAt),
      trading: trading(capturedAt),
      account: account(capturedAt),
      safety: safety(capturedAt),
      research: research(capturedAt),
      activity: activity(capturedAt),
    });
  }

  function status(): WorkbenchStatusResponse {
    const capturedAt = capture();
    const runtimeSnapshot = runtime(capturedAt);
    const marketSnapshot = market(capturedAt);
    const safetySnapshot = safety(capturedAt);
    return {
      capturedAt,
      status: {
        environment: runtimeSnapshot.data?.environment ?? 'unknown',
        marketFreshness: marketSnapshot.freshness,
        recovery: safetySnapshot.data?.recovery?.mode ?? 'unknown',
        reconciliation: safetySnapshot.data?.reconciliation?.outcome ?? 'UNKNOWN',
        liveReady: safetySnapshot.data?.liveReady.status ?? 'UNKNOWN',
        killSwitch: safetySnapshot.data?.killSwitch.status ?? 'UNKNOWN',
        hermes: runtimeSnapshot.data?.hermes?.health ?? 'unknown',
      },
    };
  }

  return {
    overview,
    runtime,
    market,
    trading,
    account,
    binanceRead,
    safety,
    research,
    activity,
    operations,
    policy,
    data,
    status,
    routes: () => WORKBENCH_V1_ROUTES,
  };
}
