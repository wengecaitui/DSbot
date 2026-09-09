import type { PropsWithChildren, ReactNode } from 'react';
import type { Availability, Freshness, Provenance } from '../api/types';

type Tone = 'good' | 'info' | 'warn' | 'bad' | 'neutral';

export type CapabilityValue = 'YES' | 'NO' | 'OBSERVED' | 'VERIFIED' | 'AUTHORIZED' | 'UNKNOWN' | 'UNAVAILABLE' | 'LOCKED' | 'NOT_ACTIVATED';

export interface CapabilityRow {
  capability: string;
  implemented: CapabilityValue;
  configured: CapabilityValue;
  connected: CapabilityValue;
  readVerified: CapabilityValue;
  writeRouted: CapabilityValue;
  activated: CapabilityValue;
}

function toneFor(value: string): Tone {
  if (['HEALTHY', 'AVAILABLE', 'FRESH', 'READY', 'MATCH', 'CLEAR', 'healthy', 'running', 'COMPLETE'].includes(value)) return 'good';
  if (['READ_ONLY', 'OBSERVED', 'IMPLEMENTED'].includes(value)) return 'info';
  if (['STALE', 'INCOMPLETE', 'NOT_READY', 'half_open'].includes(value)) return 'warn';
  if (['UNHEALTHY', 'TRIGGERED', 'FAILED', 'open', 'unhealthy'].includes(value)) return 'bad';
  return 'neutral';
}

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const label = value ?? 'UNKNOWN';
  return <span className={`status-badge tone-${toneFor(label)}`}><i />{label}</span>;
}

export function Panel({ title, eyebrow, action, children, className = '' }: PropsWithChildren<{ title: string; eyebrow?: string; action?: ReactNode; className?: string }>) {
  return <section className={`panel ${className}`}>
    <header className="panel-header">
      <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>
      {action}
    </header>
    <div className="panel-body">{children}</div>
  </section>;
}

export function Metric({ label, value, meta }: { label: string; value: ReactNode; meta?: ReactNode }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong>{meta && <small>{meta}</small>}</div>;
}

export function SectionHeader({ index, title, detail, action }: { index: string; title: string; detail?: string; action?: ReactNode }) {
  return <div className="section-header">
    <span>{index}</span>
    <div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>
    {action && <div className="section-action">{action}</div>}
  </div>;
}

export function FreshnessStamp({ capturedAt, lastUpdatedAt, freshness }: { capturedAt: number | null; lastUpdatedAt: number | null; freshness: Freshness }) {
  const ageMs = capturedAt !== null && lastUpdatedAt !== null ? Math.max(0, capturedAt - lastUpdatedAt) : null;
  const age = ageMs === null ? 'AGE UNKNOWN' : ageMs < 1_000 ? `${ageMs}ms old` : `${Math.round(ageMs / 1_000)}s old`;
  return <div className="freshness-stamp"><StatusBadge value={freshness} /><span>{age}</span><time>{formatTime(capturedAt)}</time></div>;
}

export function LockedControl({ title, detail }: { title: string; detail: string }) {
  return <div className="locked-control" aria-disabled="true"><span>LOCKED</span><div><strong>{title}</strong><p>{detail}</p></div></div>;
}

export function CapabilityState({ value }: { value: CapabilityValue }) {
  return <StatusBadge value={value} />;
}

export function CapabilityMatrix({ rows }: { rows: CapabilityRow[] }) {
  return <div className="table-wrap capability-matrix"><table>
    <thead><tr><th>Capability</th><th>Implemented</th><th>Configured</th><th>Connected</th><th>Read Verified</th><th>Write Routed</th><th>Activated</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.capability}>
      <td><b>{row.capability}</b></td>
      <td><CapabilityState value={row.implemented} /></td>
      <td><CapabilityState value={row.configured} /></td>
      <td><CapabilityState value={row.connected} /></td>
      <td><CapabilityState value={row.readVerified} /></td>
      <td><CapabilityState value={row.writeRouted} /></td>
      <td><CapabilityState value={row.activated} /></td>
    </tr>)}</tbody>
  </table></div>;
}

export function AvailabilityNotice({ availability, freshness, reason }: { availability: Availability; freshness: Freshness; reason?: string }) {
  if (availability === 'AVAILABLE' && freshness === 'FRESH') return null;
  return <div className="availability-notice">
    <div><StatusBadge value={availability} /><StatusBadge value={freshness} /></div>
    <p>{reason ?? 'The canonical source did not establish a current complete value.'}</p>
  </div>;
}

export function ProvenanceLine({ value }: { value: Provenance }) {
  return <div className="provenance">
    <span>source <b>{value.source}</b></span>
    <span>version <b>{value.sourceVersion ?? 'UNKNOWN'}</b></span>
    <span>updated <b>{formatTime(value.lastUpdatedAt)}</b></span>
  </div>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span>∅</span><div><strong>{title}</strong><p>{detail}</p></div></div>;
}

export function formatMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? 'UNAVAILABLE' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? 'UNAVAILABLE' : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

export function formatTime(value: number | null | undefined): string {
  return value === null || value === undefined ? 'UNKNOWN' : new Date(value).toLocaleString();
}
