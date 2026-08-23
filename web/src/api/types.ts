export type Availability = 'AVAILABLE' | 'INCOMPLETE' | 'UNAVAILABLE' | 'UNKNOWN';
export type Freshness = 'FRESH' | 'STALE' | 'UNKNOWN';

export interface Provenance {
  capturedAt: number | null;
  source: string;
  sourceSequence: number | null;
  sourceVersion: number | null;
  lastUpdatedAt: number | null;
}

export interface ReadEnvelope<T> {
  availability: Availability;
  freshness: Freshness;
  provenance: Provenance;
  data: T | null;
  reason?: string;
}

export interface HermesSnapshot {
  state: 'stopped' | 'running';
  generation: number;
  health: 'healthy' | 'unhealthy' | 'unknown';
  circuitState: 'closed' | 'open' | 'half_open';
  lastHealthConfirmedAt: number | null;
}

export interface RuntimeSnapshot {
  health: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
  environment: string;
  mode: string | null;
  hermes: HermesSnapshot | null;
}

export interface MarketSnapshot {
  exchange: string;
  symbol: string;
  ticker: { ticker?: { last?: number; bestBid?: number; bestAsk?: number; volume24h?: number } } | null;
  snapshotVersion: number;
  generatedAt: number;
  lastUpdatedAt: number;
  ageMs: number;
  isStale: boolean;
}

export interface PositionRecord {
  exchange: string;
  symbol: string;
  resolution: {
    status: 'missing' | 'flat' | 'open';
    side: 'long' | 'short' | 'flat';
    signedQuantity: number;
    averageEntryPrice: number;
  };
}

export interface OrderSnapshot {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  action: 'open' | 'close';
  status: string;
  orderVersion: number;
}

export interface AccountingSnapshot {
  accountId: string;
  exchange: string;
  valuationStatus: 'COMPLETE' | 'INCOMPLETE';
  cashUsd: number;
  equityUsd: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number | null;
  grossExposureUsd: number | null;
  netExposureUsd: number | null;
  totalFeesUsd: number;
  openPositions: number;
  slippage: { status: string; totalObservedSlippageUsd: number | null };
}

export interface LifecycleSnapshot {
  trades: Array<{ tradeId: string; symbol: string; side: string; status: string; netPnlUsd: number }>;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  profitFactor: number;
}

export interface SafetySnapshot {
  recovery: { mode: string; recoveryVerified: boolean } | null;
  reconciliation: { outcome: string; reconciliationVerified: boolean; capturedAt: number; issues: unknown[] } | null;
  liveReady: { status: 'READY' | 'NOT_READY' | 'UNKNOWN'; mutableFromWorkbench: false; blockers: string[] };
  killSwitch: { status: 'TRIGGERED' | 'CLEAR' | 'UNKNOWN'; reason: string | null; mutableFromWorkbench: false };
  riskBlockers: string[];
}

export interface ActivityEvent {
  eventId: string;
  timestamp: string;
  actor: string;
  source: string;
  action: string;
  evidenceLevel: string;
  result?: { ok: boolean; summary?: string };
}

export interface ResearchSnapshot {
  providers: Array<{ providerId: string; status: string; datasets: string[]; authoritativeForExecution: false }>;
  evidence: Array<{ evidenceId: string; kind: string; producedBy: string; authoritativeForExecution: false }>;
  jobs: Array<{ jobId: string; state: string; progress: number | null; canCancelFromWorkbenchV1: false }>;
}

export interface ProjectControlCenter {
  status: string;
  currentCapability: string;
  currentTask: string;
  boundaries: { readOnlyDashboard: true; dashboardGrantsApproval: false; tradingEnvironmentActivated: false };
}

export interface OverviewSnapshot {
  schemaVersion: '1.0';
  kind: 'dsbot.workbench.overview';
  capturedAt: number;
  capabilities: { canRead: true; canTrade: false; canMutateRuntime: false; canGrantApproval: false; canSetLiveReady: false };
  runtime: ReadEnvelope<RuntimeSnapshot>;
  market: ReadEnvelope<{ instruments: MarketSnapshot[]; regime: { label: string; evidenceId: string } | null }>;
  trading: ReadEnvelope<{ positions: PositionRecord[]; orders: OrderSnapshot[]; protectivePlans: Array<{ planId: string; symbol: string; status: string }> }>;
  account: ReadEnvelope<{ accounting: AccountingSnapshot | null; tradeLifecycle: LifecycleSnapshot | null }>;
  safety: ReadEnvelope<SafetySnapshot>;
  research: ReadEnvelope<ResearchSnapshot>;
  activity: ReadEnvelope<{ events: ActivityEvent[] }>;
}

export interface OperationsSnapshot {
  hermes: HermesSnapshot | null;
  recentEvents: ActivityEvent[];
  projectControlCenter: ProjectControlCenter | null;
  controlCenterDomain: 'operations';
}

export interface StatusResponse {
  capturedAt: number;
  status: {
    environment: string;
    marketFreshness: Freshness;
    recovery: string;
    reconciliation: string;
    liveReady: string;
    killSwitch: string;
    hermes: string;
  };
}

export interface PolicySnapshot {
  policies: Array<{ exchange: string; policyVersion: number; publishedAt: number; allowNewEntries: boolean; riskLevel: string; status?: string }>;
}

export interface DataSnapshot {
  sources: Array<{ sourceId: string; source: string; status: string; lastUpdatedAt: number | null; version: number | null }>;
}
