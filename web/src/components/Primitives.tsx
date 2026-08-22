import type { PropsWithChildren, ReactNode } from 'react';
import type { Availability, Freshness, Provenance } from '../api/types';

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

function toneFor(value: string): Tone {
  if (['HEALTHY', 'AVAILABLE', 'FRESH', 'READY', 'MATCH', 'CLEAR', 'healthy', 'running', 'COMPLETE'].includes(value)) return 'good';
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
