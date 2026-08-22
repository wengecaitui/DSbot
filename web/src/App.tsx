import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workbenchQueries } from './api/queries';
import type { Availability, Freshness, ReadEnvelope } from './api/types';
import {
  AvailabilityNotice,
  EmptyState,
  formatMoney,
  formatNumber,
  formatTime,
  Metric,
  Panel,
  ProvenanceLine,
  StatusBadge,
} from './components/Primitives';

type RouteId = 'overview' | 'market' | 'trading' | 'research' | 'policy' | 'safety' | 'operations' | 'data' | 'settings';

const ROUTES: Array<{ id: RouteId; label: string; glyph: string; group: string }> = [
  { id: 'overview', label: 'Overview', glyph: '◫', group: 'Terminal' },
  { id: 'market', label: 'Market', glyph: '⌁', group: 'Terminal' },
  { id: 'trading', label: 'Trading', glyph: '⇄', group: 'Terminal' },
  { id: 'research', label: 'Research', glyph: '◇', group: 'Intelligence' },
  { id: 'policy', label: 'Policy', glyph: '◈', group: 'Intelligence' },
  { id: 'safety', label: 'Safety', glyph: '⬡', group: 'Control' },
  { id: 'operations', label: 'Operations', glyph: '⌘', group: 'Control' },
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
  return <div className="query-failure"><StatusBadge value="UNAVAILABLE" /><p>{message}</p></div>;
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
  if (query.isError) return <div className="persistent-status status-offline"><b>READ LINK UNAVAILABLE</b><span>{query.error.message}</span></div>;
  const status = query.data?.status;
  const items = [
    ['ENV', status?.environment], ['MARKET', status?.marketFreshness], ['RECOVERY', status?.recovery],
    ['RECON', status?.reconciliation], ['LIVE_READY', status?.liveReady], ['KILL', status?.killSwitch], ['HERMES', status?.hermes],
  ];
  return <div className="persistent-status">
    <div className="status-title"><i /><span>READ-ONLY</span></div>
    <div className="status-items">{items.map(([label, value]) => <div key={label}><small>{label}</small><StatusBadge value={value} /></div>)}</div>
    <time>{query.data ? formatTime(query.data.capturedAt) : 'CONNECTING'}</time>
  </div>;
}

function OverviewPage() {
  const query = useQuery(workbenchQueries.overview());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  if (!query.data) return <div className="loading-grid" />;
  const view = query.data;
  const account = view.account.data?.accounting;
  const safety = view.safety.data;
  return <>
    <PageHeading eyebrow="Terminal / Overview" title="System truth, without shortcuts" detail="Canonical runtime facts, their freshness, and every unavailable boundary in one read-only surface." status={view.runtime.data?.health} />
    <div className="metric-strip">
      <Metric label="Equity" value={formatMoney(account?.equityUsd)} meta={account?.valuationStatus ?? view.account.availability} />
      <Metric label="Realized PnL" value={formatMoney(account?.realizedPnlUsd)} meta="canonical ledger" />
      <Metric label="Gross exposure" value={formatMoney(account?.grossExposureUsd)} meta={account?.valuationStatus ?? 'UNAVAILABLE'} />
      <Metric label="Open positions" value={account ? account.openPositions : 'UNAVAILABLE'} meta="missing ≠ flat" />
      <Metric label="LIVE_READY" value={<StatusBadge value={safety?.liveReady.status} />} meta="display only" />
    </div>
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
          <Metric label="Positions observed" value={trading.positions.length} />
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
          {value.riskBlockers.map(blocker => <p key={blocker} className="blocker">{blocker}</p>)}
        </div>}</EnvelopeFrame>
      </Panel>
      <Panel title="Recent activity" eyebrow="Observed evidence" className="panel-wide">
        <EnvelopeFrame envelope={view.activity}>{activity => activity.events.length ? <EventTable events={activity.events.slice(-8)} /> : <EmptyState title="No recent events" detail="No canonical observability event source has emitted evidence." />}</EnvelopeFrame>
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
  const [tab, setTab] = useState('Positions');
  const trading = useQuery(workbenchQueries.trading());
  const account = useQuery(workbenchQueries.account());
  if (trading.isError || account.isError) return <QueryFailure message={(trading.error ?? account.error)?.message ?? 'Trading read failed'} />;
  return <><PageHeading eyebrow="Terminal / Trading" title="Positions, orders, accounting" detail="Canonical states are passed through; this screen has no execution controls." />
    <Tabs values={['Positions', 'Orders', 'Accounting']} active={tab} onChange={setTab} />
    {tab === 'Positions' && trading.data && <Panel title="Position resolution" eyebrow="missing ≠ flat"><EnvelopeFrame envelope={trading.data}>{data => data.positions.length ? <div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Venue</th><th>Status</th><th>Side</th><th>Quantity</th><th>Average entry</th></tr></thead><tbody>{data.positions.map(item => <tr key={`${item.exchange}:${item.symbol}`}><td><b>{item.symbol}</b></td><td>{item.exchange}</td><td><StatusBadge value={item.resolution.status} /></td><td>{item.resolution.side}</td><td>{formatNumber(item.resolution.signedQuantity, 8)}</td><td>{item.resolution.status === 'missing' ? 'UNAVAILABLE' : formatNumber(item.resolution.averageEntryPrice)}</td></tr>)}</tbody></table></div> : <EmptyState title="No position evidence" detail="No initialized or tracked position resolution is available." />}</EnvelopeFrame></Panel>}
    {tab === 'Orders' && trading.data && <Panel title="OMS orders" eyebrow="Exact status"><EnvelopeFrame envelope={trading.data}>{data => data.orders.length ? <div className="table-wrap"><table><thead><tr><th>Order</th><th>Instrument</th><th>Action</th><th>Side</th><th>Status</th><th>Version</th></tr></thead><tbody>{data.orders.map(order => <tr key={order.orderId}><td className="mono">{order.orderId}</td><td>{order.symbol}</td><td>{order.action}</td><td>{order.side}</td><td><StatusBadge value={order.status} /></td><td>{order.orderVersion}</td></tr>)}</tbody></table></div> : <EmptyState title="No OMS orders" detail="The canonical order store returned an empty read set." />}</EnvelopeFrame></Panel>}
    {tab === 'Accounting' && account.data && <Panel title="Runtime accounting" eyebrow="No browser recomputation"><EnvelopeFrame envelope={account.data}>{data => data.accounting ? <div className="metric-grid"><Metric label="Cash" value={formatMoney(data.accounting.cashUsd)} /><Metric label="Equity" value={formatMoney(data.accounting.equityUsd)} meta={data.accounting.valuationStatus} /><Metric label="Realized PnL" value={formatMoney(data.accounting.realizedPnlUsd)} /><Metric label="Unrealized PnL" value={formatMoney(data.accounting.unrealizedPnlUsd)} /><Metric label="Net exposure" value={formatMoney(data.accounting.netExposureUsd)} /><Metric label="Fees" value={formatMoney(data.accounting.totalFeesUsd)} /><Metric label="Slippage" value={formatMoney(data.accounting.slippage.totalObservedSlippageUsd)} meta={data.accounting.slippage.status} /><Metric label="Closed trades" value={data.tradeLifecycle?.closedTrades ?? 'UNAVAILABLE'} /></div> : <EmptyState title="Accounting unavailable" detail="No canonical RuntimeAccounting projection is mounted." />}</EnvelopeFrame></Panel>}
  </>;
}

function ResearchPage() {
  const [tab, setTab] = useState('Evidence');
  const query = useQuery(workbenchQueries.research());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  return <><PageHeading eyebrow="Intelligence / Research" title="Research evidence, separated from execution" detail="Unsupported providers and jobs stay unavailable; no A-share or backtest data is fabricated." status={query.data?.availability} />
    <Tabs values={['Evidence', 'Providers', 'Backtest', 'Regime']} active={tab} onChange={setTab} />
    {query.data && <Panel title={tab} eyebrow="Non-authoritative research"><EnvelopeFrame envelope={query.data}>{data => {
      if (tab === 'Evidence') return data.evidence.length ? <div className="compact-list">{data.evidence.map(item => <div key={item.evidenceId}><b>{item.kind}</b><span>{item.producedBy}</span><StatusBadge value="READ_ONLY" /></div>)}</div> : <EmptyState title="No research evidence" detail="No deterministic research evidence is currently mounted." />;
      if (tab === 'Providers') return data.providers.length ? <div className="compact-list">{data.providers.map(item => <div key={item.providerId}><b>{item.providerId}</b><span>{item.datasets.join(', ') || 'no datasets'}</span><StatusBadge value={item.status} /></div>)}</div> : <EmptyState title="No providers mounted" detail="TickFlow, AkShare, scraping, and external production feeds are not implemented in V1." />;
      return <EmptyState title={`${tab} workspace reserved`} detail="The canonical runtime does not expose this capability. No optimizer, walk-forward executor, or synthetic result is present." />;
    }}</EnvelopeFrame></Panel>}
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
  const [tab, setTab] = useState('Hermes');
  const query = useQuery(workbenchQueries.operations());
  if (query.isError) return <QueryFailure message={query.error.message} />;
  return <><PageHeading eyebrow="Control / Operations" title="Runtime and delivery evidence" detail="Project Control Center remains Operations-only and cannot grant trading approval." status={query.data?.freshness} />
    <Tabs values={['Hermes', 'Events', 'Control Center']} active={tab} onChange={setTab} />
    {query.data && <Panel title={tab} eyebrow="Read-only operations"><EnvelopeFrame envelope={query.data}>{data => {
      if (tab === 'Hermes') return data.hermes ? <div className="metric-grid"><Metric label="State" value={<StatusBadge value={data.hermes.state} />} /><Metric label="Health" value={<StatusBadge value={data.hermes.health} />} /><Metric label="Circuit" value={<StatusBadge value={data.hermes.circuitState} />} /><Metric label="Generation" value={data.hermes.generation} /></div> : <EmptyState title="Hermes unavailable" detail="No coordinator snapshot was provided." />;
      if (tab === 'Events') return data.recentEvents.length ? <EventTable events={data.recentEvents} /> : <EmptyState title="Events unavailable" detail="No factual runtime event source is mounted." />;
      return data.projectControlCenter ? <div><div className="metric-grid"><Metric label="Status" value={data.projectControlCenter.status} /><Metric label="Capability" value={data.projectControlCenter.currentCapability} /><Metric label="Task" value={data.projectControlCenter.currentTask} /></div><div className="boundary-strip"><StatusBadge value={data.projectControlCenter.boundaries.readOnlyDashboard ? 'READ_ONLY' : 'UNKNOWN'} /><StatusBadge value={data.projectControlCenter.boundaries.dashboardGrantsApproval ? 'APPROVAL_ENABLED' : 'NO_APPROVAL'} /><StatusBadge value={data.projectControlCenter.boundaries.tradingEnvironmentActivated ? 'TRADING_ACTIVE' : 'TRADING_INACTIVE'} /></div></div> : <EmptyState title="Project Control Center unavailable" detail="Engineering evidence was not mounted into the application gateway." />;
    }}</EnvelopeFrame></Panel>}
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
