/**
 * Phase 8B — Operations Evidence Read Bridge implementation.
 *
 * Owns the observational evidence plane that feeds the Workbench Operations
 * domain: a Project Control Center snapshot, a bounded recent-event buffer of
 * normalized/redacted ObservableAgentEvent records, and (optionally) read-only
 * source adapters. It is an EVIDENCE PLANE, never a CONTROL PLANE.
 *
 * The bridge never touches trading authority: no OMS, no risk admission, no
 * recovery, no reconciliation, no LIVE_READY, no order submission, and no
 * generic command execution. External Hermes runtime evidence is
 * OBSERVED_SOURCE_ONLY and never mutates HandshakeCoordinator health.
 */

import { createObservableMonitor } from './monitor';
import { createObservableStateProjector } from './state-projector';
import type { ObservableAgentEvent, ObservableEventSourceAdapter } from './contracts';
import type { ProjectControlCenter, ProjectControlCenterSnapshot } from './project-control-center';

export interface OperationsEvidenceBridgeStatus {
  readonly running: boolean;
  readonly startedAt: number | null;
  readonly stoppedAt: number | null;
  readonly sourceCount: number;
  readonly recentEventCount: number;
  readonly projectControlCenterAvailable: boolean;
  readonly sourceFailures: number;
}

export interface OperationsEvidenceReadBridgeOptions {
  /** Injected Project Control Center instance (optional). The bridge never constructs one. */
  readonly projectControlCenter?: ProjectControlCenter;
  /** Read-only source adapters (optional). Empty by default — external paths are opt-in. */
  readonly sources?: readonly ObservableEventSourceAdapter[];
  readonly maxRecentEvents?: number;
  readonly defaultRunId?: string;
  /** Evidence-plane failure observer. Never influences trading authority. */
  readonly onSourceFailure?: (source: string, error: Error) => void;
  readonly now?: () => number;
}

export interface OperationsEvidenceReadView {
  projectControlCenter(): ProjectControlCenterSnapshot | null;
  activity(): readonly ObservableAgentEvent[];
  status(): OperationsEvidenceBridgeStatus;
}

export interface OperationsEvidenceReadBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly read: OperationsEvidenceReadView;
}

export function createOperationsEvidenceReadBridge(
  options: OperationsEvidenceReadBridgeOptions = {},
): OperationsEvidenceReadBridge {
  const maxRecentEvents = options.maxRecentEvents ?? 500;
  if (!Number.isInteger(maxRecentEvents) || maxRecentEvents <= 0) {
    throw new Error('maxRecentEvents must be a positive integer');
  }
  const now = options.now ?? (() => Date.now());
  const projectControlCenter = options.projectControlCenter ?? null;
  const sources = [...(options.sources ?? [])];

  // ── Bounded recent-event buffer (dedup by eventId, defensive copy on read) ──
  const events: ObservableAgentEvent[] = [];
  const bufferedIds = new Set<string>();
  let sourceFailures = 0;

  function recordFailure(source: string, error: Error): void {
    sourceFailures += 1;
    try { options.onSourceFailure?.(source, error); } catch { /* never escalate evidence failure */ }
  }

  function pushEvent(event: ObservableAgentEvent): void {
    if (bufferedIds.has(event.eventId)) return; // no duplicate eventId publication
    bufferedIds.add(event.eventId);
    events.push(structuredClone(event));
    while (events.length > maxRecentEvents) {
      const evicted = events.shift()!;
      bufferedIds.delete(evicted.eventId);
    }
    try { projectControlCenter?.observe(event); } catch (error) {
      recordFailure('project-control-center.observe', error instanceof Error ? error : new Error(String(error)));
    }
  }

  const monitor = createObservableMonitor({
    sources,
    projector: createObservableStateProjector(maxRecentEvents),
    defaultRunId: options.defaultRunId,
    onEvent: (event) => { pushEvent(event); },
    onError: (error, context) => { recordFailure(context, error); },
  });

  let running = false;
  let startedAt: number | null = null;
  let stoppedAt: number | null = null;
  let pccAvailable = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  function snapshotActivity(): readonly ObservableAgentEvent[] {
    return events.map((event) => structuredClone(event));
  }

  const read: OperationsEvidenceReadView = Object.freeze({
    projectControlCenter(): ProjectControlCenterSnapshot | null {
      if (!pccAvailable || !projectControlCenter) return null;
      try { return projectControlCenter.snapshot(); } catch { return null; }
    },
    activity: snapshotActivity,
    status(): OperationsEvidenceBridgeStatus {
      return Object.freeze({
        running,
        startedAt,
        stoppedAt,
        sourceCount: sources.length,
        recentEventCount: events.length,
        projectControlCenterAvailable: pccAvailable,
        sourceFailures,
      });
    },
  });

  async function start(): Promise<void> {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      // 1. Refresh Project Control Center first; failure is isolated to the evidence plane.
      if (projectControlCenter) {
        try {
          await projectControlCenter.refresh();
          pccAvailable = true;
        } catch (error) {
          pccAvailable = false;
          recordFailure('project-control-center.refresh', error instanceof Error ? error : new Error(String(error)));
        }
      }
      // 2. Start the observable monitor (and its sources). A source-start failure is
      //    rolled back by the monitor and reported via its onError hook; it is isolated
      //    here and never becomes a trading side effect.
      try {
        await monitor.start();
        running = true;
        startedAt = now();
      } catch {
        running = false;
      }
    })();
    return startPromise;
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      running = false;
      stoppedAt = now();
      pccAvailable = false;
      // Wait for in-flight normalized events; stop failures are already reported by
      // the monitor's onError hook and must not prevent authoritative trading shutdown.
      try {
        await monitor.stop();
      } catch { /* already reported */ }
    })();
    return stopPromise;
  }

  return Object.freeze({ start, stop, read });
}
