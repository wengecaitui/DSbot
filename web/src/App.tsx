import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workbenchQueries } from './api/queries';
import type { Availability, Freshness, ReadEnvelope } from './api/types';
import {
  AvailabilityNotice,
  CapabilityMatrix,
  EmptyState,
  formatMoney,
  formatNumber,
  formatTime,
  FreshnessStamp,
  LockedControl,
  Metric,
  Panel,
  ProvenanceLine,
  SectionHeader,
  StatusBadge,
  type CapabilityRow,
} from './components/Primitives';

type RouteId = 'overview' | 'market' | 'trading' | 'research' | 'policy' | 'safety' | 'operations' | 'data' | 'settings';

const ROUTES: Array<{ id: RouteId; label: string; glyph: string; group: string }> = [
  { id: 'overview', label: 'Overview', glyph: '◫', group: 'Terminal' },
  { id: 'market', label: 'Market', glyph: '⌁', group: 'Terminal' },
  { id: 'trading', label: 'Trading', glyph: '⇄', group: 'Terminal' },
  { id: 'research', label: 'Research', glyph: '◇', group: 'Intelligence' },
  { id: 'policy', label: 'Policy', glyph: '◈', group: 'Intelligence' },
  { id: 'safety', label: 'Safety', glyph: '⬡', group: 'Control' },
  { id: 'operations', label: 'Evidence', glyph: '⌘', group: 'Control' },
  { id: 'data', label: 'Data', glyph: '▦', group: 'System' },
  { id: 'settings', label: 'Settings', glyph: '⚙', group: 'System' },
];

function routeFromPath(): RouteId {
  const segment = window.location.pathname.replace(/^\/workbench\/?/, '').split('/')[0];
  return ROUTES.some((route) => route.id === segment) ? segment as RouteId : 'overview';
}

function useRoute() {
  const [route, setRoute] = useState<RouteId>(routeFromPath);
  useEffect(() => {
    const onPopState = () => setRoute(routeFromPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = (next: RouteId) => {
    const path = next === 'overview' ? '/workbench/' : `/workbench/${next}`;
    window.history.pushState({}, '', path);
    setRoute(next);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };
  return { route, navigate };
}

function QueryFailure({ message }: { message: string }) {
  return <div className="query-failure" role="alert"><StatusBadge value="UNAVAILABLE" /><strong>Read-only data link unavailable</strong><p>{message}</p></div>;
}

function LoadingState({ label }: { label: string }) {
  return <div className="loading-grid" role="status" aria-live="polite">
    <i aria-hidden="true" />
    <strong>Connecting to {label}</strong>
    <p>Waiting for a factual response from the application gateway.</p>
  </div>;
}

function EnvelopeFrame<T>({ envelope, children }: { envelope: ReadEnvelope<T>; children: (data: T) => ReactNode }) {
  return <>
    <AvailabilityNotice availability={envelope.availability} freshness={envelope.freshness} reason={envelope.reason} />
    {envelope.data ? children(envelope.data) : <EmptyState title={envelope.availability} detail={envelope.reason ?? 'Canonical evidence is not available.'} />}
    <ProvenanceLine value={envelope.provenance} />
  </>;
}

function Tabs({ values, active, onChange }: { values: string[]; active: string; onChange: (value: string) => void }) {
  return <div className="tabs" role="tablist">{values.map((value) =>
    <button key={value} role="tab" aria-selected={active === value} className={active === value ? 'active' : ''} onClick={() => onChange(value)}>{value}</button>)}</div>;
}

function PageHeading({ eyebrow, title, detail, status }: { eyebrow: string; title: string; detail: string; status?: string }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{detail}</p></div>{status && <StatusBadge value={status} />}</div>;
}

function PersistentStatus() {
  const query = useQuery(workbenchQueries.status());
  const runtimeQuery = useQuery(workbenchQueries.runtime());
  if (query.isPending) return <div className="persistent-status status-connecting"><div className="status-title"><i /><span>READ-ONLY</span></div><b>CONNECTING TO APPLICATION GATEWAY</b></div>;
  if (query.isError) return <div className="persistent-status status-offline"><b>READ LINK UNAVAILABLE</b><span>{query.error.message}</span></div>;
  const status = query.data?.status;
  const items = [
    ['ENV', status?.environment], ['MODE', runtimeQuery.data?.data?.mode], ['MARKET', status?.marketFreshness], ['RECOVERY', status?.recovery],
    ['RECON', status?.reconciliation], ['LIVE_READY', status?.liveReady], ['KILL', status?.killSwitch], ['HERMES', status?.hermes],
  ];
  return <div className="persistent-status">
    <div className="status-title"><i /><span>READ-ONLY</span></div>
    <div className="status-items">{items.map(([label, value]) => <div key={label}><small>{label}</small><StatusBadge value={value} /></div>)}</div>
    {query.data ? <FreshnessStamp capturedAt={query.data.capturedAt} lastUpdatedAt={runtimeQuery.data?.provenance.lastUpdatedAt ?? null} freshness={runtimeQuery.data?.freshness ?? 'UNKNOWN'} /> : <time>CONNECTING</time>}
  </div>;
}

function OverviewPage() {
  const query = useQuery(workbenchQueries.overview());
  const operations = useQuery(workbenchQueries.operations());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  if (!query.data) return <LoadingState label="the Overview read model" />;
  const view = query.data;
  const account = view.account.data?.accounting;
  const safety = view.safety.data;
  const positions = view.trading.data?.positions ?? [];
  return <>
    <PageHeading eyebrow="Terminal / Global Command Center" title="Authoritative state at a glance" detail="Dense operational truth from existing read projections. Missing, stale and unverified evidence stays visible and never becomes a healthy default." status={view.runtime.data?.health} />
    <div className="metric-strip command-kpis">
      <Metric label="Runtime" value={<StatusBadge value={view.runtime.data?.health} />} meta={view.runtime.freshness} />
      <Metric label="Market" value={<StatusBadge value={view.market.freshness} />} meta={`${view.market.data?.instruments.length ?? 0} observed`} />
      <Metric label="Equity" value={formatMoney(account?.equityUsd)} meta={account?.valuationStatus ?? view.account.availability} />
      <Metric label="Realized PnL" value={formatMoney(account?.realizedPnlUsd)} meta="canonical ledger" />
      <Metric label="Gross exposure" value={formatMoney(account?.grossExposureUsd)} meta={account?.valuationStatus ?? 'UNAVAILABLE'} />
      <Metric label="Open positions" value={account ? account.openPositions : 'UNAVAILABLE'} meta="missing ≠ flat" />
      <Metric label="LIVE_READY" value={<StatusBadge value={safety?.liveReady.status} />} meta="observed, not mutable" />
      <Metric label="Kill switch" value={<StatusBadge value={safety?.killSwitch.status} />} meta={safety?.killSwitch.reason ?? 'reason unavailable'} />
    </div>
    <SectionHeader index="01" title="System flow & authority" detail="One read path. The future write path is represented only as locked architecture." />
    <Panel title="Canonical read flow" eyebrow="Presentation boundary" className="panel-wide terminal-panel">
      <div className="authority-flow">
        <div><small>SOURCE</small><b>Canonical stores</b><StatusBadge value={view.runtime.availability} /></div><i>→</i>
        <div><small>PROJECTION</small><b>Workbench API</b><StatusBadge value="READ_ONLY" /></div><i>→</i>
        <div><small>CONTRACT</small><b>ReadEnvelope</b><StatusBadge value={view.runtime.freshness} /></div><i>→</i>
        <div><small>SURFACE</small><b>Command Center</b><StatusBadge value="OBSERVED" /></div>
      </div>
      <LockedControl title="UI Intent → ProductionSpine → PreTradeRiskGateway → OMS → ExecutionAdapter" detail="No current Workbench route can enter this chain or mutate LIVE_READY." />
      <ProvenanceLine value={view.runtime.provenance} />
    </Panel>
    <SectionHeader index="02" title="Market, positions & exposure" detail="Financial values are rendered only when the canonical read model supplies them." />
    <div className="dashboard-grid">
      <Panel title="Runtime" eyebrow="Authority" action={<StatusBadge value={view.runtime.freshness} />}>
        <EnvelopeFrame envelope={view.runtime}>{runtime => <div className="key-grid">
          <Metric label="Health" value={<StatusBadge value={runtime.health} />} />
          <Metric label="Environment" value={runtime.environment} />
          <Metric label="Mode" value={runtime.mode ?? 'UNKNOWN'} />
          <Metric label="Hermes" value={<StatusBadge value={runtime.hermes?.health} />} />
        </div>}</EnvelopeFrame>
      </Panel>
      <Panel title="Market state" eyebrow="Tracked facts" action={<StatusBadge value={view.market.freshness} />}>
        <EnvelopeFrame envelope={view.market}>{market => market.instruments.length ? <div className="compact-list">{market.instruments.slice(0, 5).map(item =>
          <div key={`${item.exchange}:${item.symbol}`}><b>{item.symbol}</b><span>{item.exchange}</span><strong>{item.ticker?.ticker?.last === undefined ? 'UNAVAILABLE' : formatNumber(item.ticker.ticker.last)}</strong><StatusBadge value={item.isStale ? 'STALE' : 'FRESH'} /></div>)}</div>
          : <EmptyState title="No tracked markets" detail="The canonical market store has not published a snapshot." />}</EnvelopeFrame>
      </Panel>
      <Panel title="Trading state" eyebrow="Positions & orders">
        <EnvelopeFrame envelope={view.trading}>{trading => <div className="key-grid">
          <Metric label="Positions observed" value={positions.length} />
          <Metric label="Orders observed" value={trading.orders.length} />
          <Metric label="Unknown submissions" value={trading.orders.filter(order => order.status === 'SUBMISSION_UNKNOWN').length} />
          <Metric label="Protection plans" value={trading.protectivePlans.length} />
        </div>}</EnvelopeFrame>
      </Panel>
      <Panel title="Safety" eyebrow="Fail-closed" action={<StatusBadge value={safety?.liveReady.status} />}>
        <EnvelopeFrame envelope={view.safety}>{value => <div className="safety-stack">
          <div><span>Recovery</span><StatusBadge value={value.recovery?.mode ?? 'UNKNOWN'} /></div>
          <div><span>Reconciliation</span><StatusBadge value={value.reconciliation?.outcome ?? 'UNKNOWN'} /></div>
          <div><span>Kill / risk</span><StatusBadge value={value.killSwitch.status} /></div>
          <div><span>Activation</span><StatusBadge value="NOT_ACTIVATED" /></div>
          {value.riskBlockers.map(blocker => <p key={blocker} className="blocker">{blocker}</p>)}
        </div>}</EnvelopeFrame>
      </Panel>
      <Panel title="Recent activity" eyebrow="Observed evidence" className="panel-wide">
        <EnvelopeFrame envelope={view.activity}>{activity => activity.events.length ? <EventTable events={activity.events.slice(-8)} /> : <EmptyState title="No recent events" detail="No canonical observability event source has emitted evidence." />}</EnvelopeFrame>
      </Panel>
      <Panel title="Operations evidence" eyebrow="Observed, not approved" className="panel-wide">
        {operations.isError ? <EmptyState title="UNAVAILABLE" detail="Operations evidence query failed; no status is inferred." /> : operations.data ? <EnvelopeFrame envelope={operations.data}>{data => <div className="operations-summary">
          <Metric label="Hermes" value={<StatusBadge value={data.hermes?.health} />} meta="runtime observation" />
          <Metric label="Events" value={data.recentEvents.length} meta="observed records" />
          <Metric label="Control center" value={<StatusBadge value={data.projectControlCenter?.status ?? 'UNAVAILABLE'} />} meta="cannot grant approval" />
          <Metric label="Activation" value={<StatusBadge value="NOT_ACTIVATED" />} meta="no Live authority" />
        </div>}</EnvelopeFrame> : <LoadingState label="Operations evidence" />}
      </Panel>
    </div>
  </>;
}

function MarketPage() {
  const query = useQuery(workbenchQueries.market());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  return <><PageHeading eyebrow="Terminal / Market" title="Market facts and freshness" detail="No quote is presented without its source age and stale state." status={query.data?.freshness} />
    {query.data && <Panel title="Tracked instruments" eyebrow="KernelMarketStateStore"><EnvelopeFrame envelope={query.data}>{data => data.instruments.length ? <div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Venue</th><th>Last</th><th>Bid</th><th>Ask</th><th>Version</th><th>Freshness</th><th>Updated</th></tr></thead><tbody>{data.instruments.map(item => <tr key={`${item.exchange}:${item.symbol}`}><td><b>{item.symbol}</b></td><td>{item.exchange}</td><td>{formatNumber(item.ticker?.ticker?.last)}</td><td>{formatNumber(item.ticker?.ticker?.bestBid)}</td><td>{formatNumber(item.ticker?.ticker?.bestAsk)}</td><td>{item.snapshotVersion}</td><td><StatusBadge value={item.isStale ? 'STALE' : 'FRESH'} /></td><td>{formatTime(item.lastUpdatedAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="No factual instruments" detail="The market store has no snapshots; the terminal will not invent a watchlist." />}</EnvelopeFrame></Panel>}
  </>;
}

function TradingPage() {
  const trading = useQuery(workbenchQueries.trading());
  const account = useQuery(workbenchQueries.account());
  const market = useQuery(workbenchQueries.market());
  const safety = useQuery(workbenchQueries.safety());
  if (trading.isError || account.isError) return <QueryFailure message={(trading.error ?? account.error)?.message ?? 'Trading read failed'} />;
  const latest = market.data?.data?.instruments[0];
  return <><PageHeading eyebrow="Terminal / Execution Observability" title="Trading state without an order ticket" detail="Market context, risk observations, OMS state and account facts share one read-only surface. No control here can submit, cancel or modify an order." status={trading.data?.freshness} />
    <div className="trading-layout">
      <Panel title="Instrument facts" eyebrow="Watchlist / canonical market" className="trading-watchlist">
        {market.isError ? <EmptyState title="UNAVAILABLE" detail="Market read failed; no instrument facts are inferred." /> : market.data ? <EnvelopeFrame envelope={market.data}>{data => data.instruments.length ? <div className="compact-list">{data.instruments.slice(0, 8).map(item => <div key={`${item.exchange}:${item.symbol}`}><b>{item.symbol}</b><span>{item.exchange}</span><strong>{formatNumber(item.ticker?.ticker?.last)}</strong><StatusBadge value={item.isStale ? 'STALE' : 'FRESH'} /></div>)}</div> : <EmptyState title="No factual watchlist" detail="The market store has no observed instruments." />}</EnvelopeFrame> : <LoadingState label="market facts" />}
      </Panel>
      <Panel title={latest?.symbol ?? 'Market context'} eyebrow="Chart / price observation" className="trading-chart">
        <div className="market-fact-strip"><Metric label="Last" value={formatNumber(latest?.ticker?.ticker?.last)} /><Metric label="Bid" value={formatNumber(latest?.ticker?.ticker?.bestBid)} /><Metric label="Ask" value={formatNumber(latest?.ticker?.ticker?.bestAsk)} /><Metric label="Mark" value="UNAVAILABLE" /><Metric label="Index" value="UNAVAILABLE" /><Metric label="Funding" value="UNAVAILABLE" /></div>
        <div className="chart-unavailable"><span>CHART SOURCE UNAVAILABLE</span><p>No canonical time-series projection is exposed to Workbench. A decorative price curve would be false evidence.</p></div>
        {market.data && <FreshnessStamp capturedAt={market.data.provenance.capturedAt} lastUpdatedAt={latest?.lastUpdatedAt ?? market.data.provenance.lastUpdatedAt} freshness={market.data.freshness} />}
      </Panel>
      <Panel title="Strategy & pre-trade risk" eyebrow="Observation only" className="trading-risk">
        <div className="observation-lanes"><div><span>Strategy intent</span><StatusBadge value="UNAVAILABLE" /><p>No canonical strategy-intent read source is mounted.</p></div><div><span>Risk admission</span><StatusBadge value={safety.data?.availability ?? 'UNKNOWN'} /><p>{safety.data?.data?.riskBlockers.join(' · ') || 'No verified pre-trade decision is available.'}</p></div></div>
        <LockedControl title="Execution control surface" detail="Order entry is not implemented in Workbench. Future writes must traverse ProductionSpine → PreTradeRiskGateway → OMS → ExecutionAdapter." />
      </Panel>
      <Panel title="OMS order timeline" eyebrow="Exact status" className="trading-orders">
        {trading.data && <EnvelopeFrame envelope={trading.data}>{data => data.orders.length ? <div className="table-wrap"><table><thead><tr><th>Order ID</th><th>Instrument</th><th>Intent</th><th>Side</th><th>Status</th><th>Version</th></tr></thead><tbody>{data.orders.map(order => <tr key={order.orderId}><td className="mono">{order.orderId}</td><td>{order.symbol}</td><td>{order.action}</td><td>{order.side}</td><td><StatusBadge value={order.status} /></td><td className="mono">v{order.orderVersion}</td></tr>)}</tbody></table></div> : <EmptyState title="No OMS orders" detail="The canonical order store returned an empty read set." />}</EnvelopeFrame>}
      </Panel>
      <Panel title="Positions" eyebrow="missing ≠ flat" className="trading-positions">
        {trading.data && <EnvelopeFrame envelope={trading.data}>{data => data.positions.length ? <div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Venue</th><th>Resolution</th><th>Side</th><th>Quantity</th><th>Average entry</th></tr></thead><tbody>{data.positions.map(item => <tr key={`${item.exchange}:${item.symbol}`}><td><b>{item.symbol}</b></td><td>{item.exchange}</td><td><StatusBadge value={item.resolution.status} /></td><td>{item.resolution.side}</td><td>{item.resolution.status === 'missing' ? 'UNAVAILABLE' : formatNumber(item.resolution.signedQuantity, 8)}</td><td>{item.resolution.status === 'missing' ? 'UNAVAILABLE' : formatNumber(item.resolution.averageEntryPrice)}</td></tr>)}</tbody></table></div> : <EmptyState title="No position evidence" detail="No observed position is not evidence of a flat account." />}</EnvelopeFrame>}
      </Panel>
      <Panel title="Protective plans" eyebrow="Plan store" className="trading-protection">
        {trading.data && <EnvelopeFrame envelope={trading.data}>{data => data.protectivePlans.length ? <div className="compact-list">{data.protectivePlans.map(plan => <div key={plan.planId}><b>{plan.symbol}</b><span className="mono">{plan.planId}</span><StatusBadge value={plan.status} /></div>)}</div> : <EmptyState title="UNAVAILABLE" detail="No protective-plan evidence is available; protection is not assumed." />}</EnvelopeFrame>}
      </Panel>
      <Panel title="Account facts" eyebrow="No browser recomputation" className="trading-account">
        {account.data && <EnvelopeFrame envelope={account.data}>{data => data.accounting ? <div className="metric-grid"><Metric label="Cash" value={formatMoney(data.accounting.cashUsd)} /><Metric label="Equity" value={formatMoney(data.accounting.equityUsd)} meta={data.accounting.valuationStatus} /><Metric label="Realized PnL" value={formatMoney(data.accounting.realizedPnlUsd)} /><Metric label="Unrealized PnL" value={formatMoney(data.accounting.unrealizedPnlUsd)} /><Metric label="Net exposure" value={formatMoney(data.accounting.netExposureUsd)} /><Metric label="Fees" value={formatMoney(data.accounting.totalFeesUsd)} /><Metric label="Slippage" value={formatMoney(data.accounting.slippage.totalObservedSlippageUsd)} meta={data.accounting.slippage.status} /><Metric label="Closed trades" value={data.tradeLifecycle?.closedTrades ?? 'UNAVAILABLE'} /></div> : <EmptyState title="Accounting unavailable" detail="No canonical RuntimeAccounting projection is mounted." />}</EnvelopeFrame>}
      </Panel>
    </div>
  </>;
}

function ResearchPage() {
  const query = useQuery(workbenchQueries.research());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  const data = query.data?.data;
  const providers = data?.providers ?? [];
  const evidence = data?.evidence ?? [];
  return <><PageHeading eyebrow="Intelligence / Research Data Hub" title="Data lineage before conclusions" detail="Provider ingress, point-in-time controls and evaluation boundaries are presented as separate evidence stages. Unsupported stages remain unavailable." status={query.data?.availability} />
    {query.data && <AvailabilityNotice availability={query.data.availability} freshness={query.data.freshness} reason={query.data.reason} />}
    <SectionHeader index="01" title="Research pipeline" detail="An observed provider never implies canonicalization, PIT qualification, storage, or decision eligibility." />
    <div className="research-pipeline">
      <div><small>01</small><b>Provider Ingress</b><StatusBadge value={providers.length ? 'OBSERVED' : 'UNAVAILABLE'} /></div><i>→</i>
      <div><small>02</small><b>Canonical Dictionary</b><StatusBadge value="UNAVAILABLE" /></div><i>→</i>
      <div><small>03</small><b>PIT Dataset</b><StatusBadge value="UNAVAILABLE" /></div><i>→</i>
      <div><small>04</small><b>Storage</b><StatusBadge value="UNAVAILABLE" /></div><i>→</i>
      <div><small>05</small><b>Decision View</b><StatusBadge value="UNAVAILABLE" /></div>
    </div>
    <div className="research-grid">
      <Panel title="Providers" eyebrow="Ingress observations">
        {providers.length ? <div className="compact-list">{providers.map(item => <div key={item.providerId}><b>{item.providerId}</b><span>{item.datasets.join(', ') || 'no datasets'}</span><StatusBadge value={item.status} /></div>)}</div> : <EmptyState title="UNAVAILABLE" detail="No provider is mounted. TickFlow operationalization is not claimed." />}
      </Panel>
      <Panel title="Datasets" eyebrow="Dictionary / availability">
        {providers.some(item => item.datasets.length) ? <div className="compact-list">{providers.flatMap(provider => provider.datasets.map(dataset => <div key={`${provider.providerId}:${dataset}`}><b>{dataset}</b><span>{provider.providerId}</span><StatusBadge value="OBSERVED" /></div>))}</div> : <EmptyState title="UNAVAILABLE" detail="No canonical dataset dictionary is exposed by the current read model." />}
      </Panel>
      <Panel title="PIT & lineage" eyebrow="Version authority">
        <div className="fact-register"><div><span>PIT status</span><StatusBadge value="NOT_VERIFIED" /></div><div><span>Version</span><b className="mono">UNKNOWN</b></div><div><span>Lineage</span><StatusBadge value="UNAVAILABLE" /></div><div><span>Availability</span><StatusBadge value={query.data?.availability ?? 'UNAVAILABLE'} /></div></div>
      </Panel>
      <Panel title="Evaluation boundaries" eyebrow="Anti-overfit contract">
        <div className="split-boundaries"><div><span>TRAIN</span><StatusBadge value="UNAVAILABLE" /></div><i>→</i><div><span>VALIDATION</span><StatusBadge value="UNAVAILABLE" /></div><i>⊣</i><div><span>LOCKED TEST</span><StatusBadge value="LOCKED" /></div></div>
        <p className="boundary-copy">No split ranges or dataset identity were supplied. The labels describe required isolation, not completed evidence.</p>
      </Panel>
      <Panel title="Backtest evidence" eyebrow="No synthetic results" className="panel-wide">
        {evidence.length ? <div className="table-wrap"><table><thead><tr><th>Evidence ID</th><th>Kind</th><th>Producer</th><th>Authority</th></tr></thead><tbody>{evidence.map(item => <tr key={item.evidenceId}><td className="mono">{item.evidenceId}</td><td>{item.kind}</td><td>{item.producedBy}</td><td><StatusBadge value="READ_ONLY" /></td></tr>)}</tbody></table></div> : <EmptyState title="NOT IMPLEMENTED / NOT VERIFIED" detail="No deterministic backtest, optimizer, walk-forward, or locked-test evidence is mounted." />}
      </Panel>
    </div>
    {query.data && <ProvenanceLine value={query.data.provenance} />}
  </>;
}

function PolicyPage() {
  const query = useQuery(workbenchQueries.policy());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  return <><PageHeading eyebrow="Intelligence / Policy" title="Published policy evidence" detail="Read-only policy snapshots cannot grant approval or bypass risk admission." status={query.data?.availability} />
    {query.data && <Panel title="Policy snapshots" eyebrow="KernelPolicyStore"><EnvelopeFrame envelope={query.data}>{data => data.policies.length ? <div className="table-wrap"><table><thead><tr><th>Exchange</th><th>Version</th><th>Published</th><th>New entries</th><th>Risk</th></tr></thead><tbody>{data.policies.map(item => <tr key={`${item.exchange}:${item.policyVersion}`}><td>{item.exchange}</td><td>{item.policyVersion}</td><td>{formatTime(item.publishedAt)}</td><td><StatusBadge value={item.allowNewEntries ? 'ALLOWED_BY_POLICY' : 'BLOCKED_BY_POLICY'} /></td><td>{item.riskLevel}</td></tr>)}</tbody></table></div> : <EmptyState title="Policy unavailable" detail="No canonical policy snapshot exists for a tracked exchange." />}</EnvelopeFrame></Panel>}
  </>;
}

function SafetyPage() {
  const [tab, setTab] = useState('Risk');
  const query = useQuery(workbenchQueries.safety());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  const data = query.data?.data;
  return <><PageHeading eyebrow="Control / Safety" title="Safety state is display-only" detail="Recovery, reconciliation and LIVE_READY remain owned by ProductionSpine." status={data?.liveReady.status ?? query.data?.availability} />
    <Tabs values={['Risk', 'Recovery', 'Reconciliation']} active={tab} onChange={setTab} />
    {query.data && <Panel title={tab} eyebrow="Canonical safety gate"><EnvelopeFrame envelope={query.data}>{value => tab === 'Risk' ? <div className="metric-grid"><Metric label="LIVE_READY" value={<StatusBadge value={value.liveReady.status} />} meta="immutable from workbench" /><Metric label="Kill switch" value={<StatusBadge value={value.killSwitch.status} />} meta={value.killSwitch.reason ?? 'no reason reported'} />{value.riskBlockers.map(blocker => <div className="blocker-card" key={blocker}>{blocker}</div>)}</div> : tab === 'Recovery' ? (value.recovery ? <pre className="evidence-json">{JSON.stringify(value.recovery, null, 2)}</pre> : <EmptyState title="Recovery unavailable" detail="Unavailable is not verified. The owning runtime did not retain a canonical RecoveryResult." />) : (value.reconciliation ? <pre className="evidence-json">{JSON.stringify(value.reconciliation, null, 2)}</pre> : <EmptyState title="Reconciliation unavailable" detail="Unavailable is explicitly not MATCH." />)}</EnvelopeFrame></Panel>}
  </>;
}

function EventTable({ events }: { events: Array<{ eventId: string; timestamp: string; actor: string; action: string; evidenceLevel: string }> }) {
  return <div className="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Evidence</th></tr></thead><tbody>{events.map(event => <tr key={event.eventId}><td>{event.timestamp}</td><td>{event.actor}</td><td>{event.action}</td><td><StatusBadge value={event.evidenceLevel} /></td></tr>)}</tbody></table></div>;
}

function OperationsPage() {
  const query = useQuery(workbenchQueries.operations());
  const runtime = useQuery(workbenchQueries.runtime());
  const safety = useQuery(workbenchQueries.safety());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  const data = query.data?.data;
  const capabilityRows: CapabilityRow[] = [
    { capability: 'Workbench read API', implemented: 'YES', configured: data ? 'OBSERVED' : 'UNKNOWN', connected: data ? 'OBSERVED' : 'UNKNOWN', readVerified: 'UNKNOWN', writeRouted: 'LOCKED', activated: 'NOT_ACTIVATED' },
    { capability: 'Hermes coordination', implemented: data?.hermes ? 'OBSERVED' : 'UNKNOWN', configured: 'UNKNOWN', connected: data?.hermes ? 'OBSERVED' : 'UNKNOWN', readVerified: 'UNKNOWN', writeRouted: 'LOCKED', activated: 'NOT_ACTIVATED' },
    { capability: 'Trading authority', implemented: 'UNKNOWN', configured: runtime.data?.data?.mode ? 'OBSERVED' : 'UNKNOWN', connected: 'UNKNOWN', readVerified: 'UNKNOWN', writeRouted: 'LOCKED', activated: 'NOT_ACTIVATED' },
  ];
  return <><PageHeading eyebrow="Control / Production Readiness Evidence" title="Evidence is not authority" detail="Observed, verified and authorized are independent states. CI success cannot stand in for Phase 10 verification, and Phase 10 cannot activate Live." status={query.data?.freshness} />
    <div className="trust-lanes">
      <div><span>OBSERVED</span><StatusBadge value={data ? 'OBSERVED' : 'UNAVAILABLE'} /><p>A read projection returned data.</p></div>
      <div><span>VERIFIED</span><StatusBadge value="UNKNOWN" /><p>No authenticatable verification receipt is exposed here.</p></div>
      <div><span>AUTHORIZED</span><StatusBadge value="NOT_AUTHORIZED" /><p>Workbench cannot grant approval or activate trading.</p></div>
    </div>
    <SectionHeader index="01" title="Readiness register" detail="Unavailable evidence remains explicit; no caller summary is upgraded into proof." action={query.data && <FreshnessStamp capturedAt={query.data.provenance.capturedAt} lastUpdatedAt={query.data.provenance.lastUpdatedAt} freshness={query.data.freshness} />} />
    <div className="evidence-register">
      <div><span>Exact Git SHA</span><b className="mono">UNAVAILABLE</b><StatusBadge value="NOT_VERIFIED" /></div>
      <div><span>CI</span><b>Repository receipt</b><StatusBadge value="UNAVAILABLE" /></div>
      <div><span>Security</span><b>Repository receipt</b><StatusBadge value="UNAVAILABLE" /></div>
      <div><span>Proof / receipt families</span><b>Offline verification</b><StatusBadge value="UNAVAILABLE" /></div>
      <div><span>Exceptions</span><b>Security observation</b><StatusBadge value="UNKNOWN" /></div>
      <div><span>Runtime mode</span><b className="mono">{runtime.data?.data?.mode ?? 'UNKNOWN'}</b><StatusBadge value={runtime.data?.availability ?? 'UNKNOWN'} /></div>
      <div><span>Activation eligibility</span><b>Safety observation</b><StatusBadge value={safety.data?.data?.liveReady.status ?? 'UNKNOWN'} /></div>
      <div><span>Live activation</span><b>Authority state</b><StatusBadge value="NOT_ACTIVATED" /></div>
    </div>
    <SectionHeader index="02" title="Independent capability matrix" detail="A known state in one column never fills another column." />
    <Panel title="Capability state" eyebrow="Missing evidence → UNKNOWN / UNAVAILABLE" className="panel-wide terminal-panel"><CapabilityMatrix rows={capabilityRows} /></Panel>
    <SectionHeader index="03" title="Runtime observations" detail="Operational telemetry is preserved as observation, not transformed into authorization." />
    <div className="operations-grid">
      <Panel title="Hermes" eyebrow="Coordinator observation">
        {data?.hermes ? <div className="metric-grid"><Metric label="State" value={<StatusBadge value={data.hermes.state} />} /><Metric label="Health" value={<StatusBadge value={data.hermes.health} />} /><Metric label="Circuit" value={<StatusBadge value={data.hermes.circuitState} />} /><Metric label="Generation" value={data.hermes.generation} /></div> : <EmptyState title="UNAVAILABLE" detail="No coordinator snapshot was provided." />}
      </Panel>
      <Panel title="Blockers & warnings" eyebrow="Fail-closed summary">
        <div className="safety-stack"><div><span>Risk blockers</span><b>{safety.data?.data?.riskBlockers.length ?? 'UNKNOWN'}</b></div><div><span>Recovery</span><StatusBadge value={safety.data?.data?.recovery?.mode ?? 'UNKNOWN'} /></div><div><span>Reconciliation</span><StatusBadge value={safety.data?.data?.reconciliation?.outcome ?? 'UNKNOWN'} /></div></div>
      </Panel>
      <Panel title="Recent evidence events" eyebrow="Observed records" className="panel-wide">
        {data?.recentEvents.length ? <EventTable events={data.recentEvents} /> : <EmptyState title="UNAVAILABLE" detail="No factual runtime event source is mounted." />}
      </Panel>
      <Panel title="Project Control Center" eyebrow="Operations only" className="panel-wide">
        {data?.projectControlCenter ? <><div className="operations-summary"><Metric label="Status" value={data.projectControlCenter.status} /><Metric label="Capability" value={data.projectControlCenter.currentCapability} /><Metric label="Task" value={data.projectControlCenter.currentTask} /><Metric label="Approval" value={<StatusBadge value="NO_APPROVAL" />} /></div><div className="boundary-strip"><StatusBadge value={data.projectControlCenter.boundaries.readOnlyDashboard ? 'READ_ONLY' : 'UNKNOWN'} /><StatusBadge value={data.projectControlCenter.boundaries.dashboardGrantsApproval ? 'APPROVAL_ENABLED' : 'NO_APPROVAL'} /><StatusBadge value={data.projectControlCenter.boundaries.tradingEnvironmentActivated ? 'TRADING_ACTIVE' : 'NOT_ACTIVATED'} /></div></> : <EmptyState title="UNAVAILABLE" detail="Engineering evidence was not mounted into the application gateway." />}
      </Panel>
    </div>
  </>;
}

function DataPage() {
  const query = useQuery(workbenchQueries.data());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  return <><PageHeading eyebrow="System / Data" title="Sources and provenance" detail="This is source evidence, not a backend DataHub." status={query.data?.freshness} />
    {query.data && <Panel title="Canonical data sources" eyebrow="No second data universe"><EnvelopeFrame envelope={query.data}>{data => data.sources.length ? <div className="table-wrap"><table><thead><tr><th>Source ID</th><th>Authority</th><th>Status</th><th>Version</th><th>Updated</th></tr></thead><tbody>{data.sources.map(source => <tr key={source.sourceId}><td className="mono">{source.sourceId}</td><td>{source.source}</td><td><StatusBadge value={source.status} /></td><td>{source.version ?? 'UNKNOWN'}</td><td>{formatTime(source.lastUpdatedAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="No source evidence" detail="No canonical market source is mounted; no provider data is fabricated." />}</EnvelopeFrame></Panel>}
  </>;
}

function SettingsPage() {
  const [density, setDensity] = useState(() => localStorage.getItem('dsbot.workbench.density') ?? 'compact');
  const [contrast, setContrast] = useState(() => localStorage.getItem('dsbot.workbench.contrast') ?? 'standard');
  useEffect(() => {
    document.documentElement.dataset.density = density;
    document.documentElement.dataset.contrast = contrast;
    localStorage.setItem('dsbot.workbench.density', density);
    localStorage.setItem('dsbot.workbench.contrast', contrast);
  }, [density, contrast]);
  return <><PageHeading eyebrow="System / Settings" title="Presentation preferences" detail="These local preferences cannot alter server facts, risk, execution, or approval." />
    <Panel title="Local display" eyebrow="Client preference only"><div className="settings-grid"><label><span>Information density</span><select value={density} onChange={event => setDensity(event.target.value)}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></label><label><span>Contrast</span><select value={contrast} onChange={event => setContrast(event.target.value)}><option value="standard">Standard</option><option value="high">High</option></select></label></div><div className="boundary-note"><b>Boundary</b><p>Saved in this browser only. No request is sent and no runtime state is changed.</p></div></Panel>
  </>;
}

function ActivePage({ route }: { route: RouteId }) {
  switch (route) {
    case 'market': return <MarketPage />;
    case 'trading': return <TradingPage />;
    case 'research': return <ResearchPage />;
    case 'policy': return <PolicyPage />;
    case 'safety': return <SafetyPage />;
    case 'operations': return <OperationsPage />;
    case 'data': return <DataPage />;
    case 'settings': return <SettingsPage />;
    default: return <OverviewPage />;
  }
}

export function App() {
  const { route, navigate } = useRoute();
  const groups = useMemo(() => [...new Set(ROUTES.map(item => item.group))], []);
  return <div className="terminal-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">DS</div><div><strong>DSbot</strong><span>Quant Terminal</span></div></div>
      <nav>{groups.map(group => <div className="nav-group" key={group}><p>{group}</p>{ROUTES.filter(item => item.group === group).map(item => <button key={item.id} className={route === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><i>{item.glyph}</i><span>{item.label}</span></button>)}</div>)}</nav>
      <div className="sidebar-boundary"><StatusBadge value="READ_ONLY" /><p>Presentation cannot trade, approve, recover, reconcile, or set LIVE_READY.</p></div>
    </aside>
    <div className="terminal-main">
      <PersistentStatus />
      <main><ActivePage route={route} /></main>
      <footer><span>DSbot Quant Terminal V1</span><span>Canonical facts → read projections → presentation</span></footer>
    </div>
  </div>;
}
