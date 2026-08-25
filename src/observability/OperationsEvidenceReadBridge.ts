/**
 * Phase 8B — Operations Evidence Read Bridge implementation.
 *
 * This is an evidence plane only. It publishes defensively copied Project
 * Control Center and normalized activity evidence plus the current health of
 * configured read sources. None of these facts can influence trading authority.
 */

import { createObservableMonitor } from './monitor';
import { createObservableStateProjector } from './state-projector';
import type { ObservableAgentEvent, ObservableEventSourceAdapter } from './contracts';
import type { ProjectControlCenter, ProjectControlCenterSnapshot } from './project-control-center';
import { redactText } from './redaction';

const MAX_EVIDENCE_ERROR_LENGTH = 512;

function sanitizeEvidenceError(error: Error): string {
  return redactText(error.message).value.slice(0, MAX_EVIDENCE_ERROR_LENGTH);
}

export type OperationsEvidenceSourceState = 'UNCONFIGURED' | 'STOPPED' | 'HEALTHY' | 'FAILING';
export type OperationsEvidenceAvailability = 'AVAILABLE' | 'INCOMPLETE' | 'UNAVAILABLE';
export type OperationsEvidenceFreshness = 'FRESH' | 'STALE' | 'UNKNOWN';

export interface OperationsEvidenceSourceStatus {
  readonly source: string;
  readonly configured: boolean;
  readonly state: OperationsEvidenceSourceState;
  readonly lastSuccessfulPollAt: number | null;
  readonly lastFailureAt: number | null;
  readonly failureCount: number;
  readonly lastError: string | null;
}

export interface ProjectControlCenterEvidenceStatus {
  readonly configured: boolean;
  readonly state: OperationsEvidenceSourceState;
  readonly lastSuccessfulRefreshAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastError: string | null;
}

export interface OperationsEvidenceBridgeStatus {
  readonly running: boolean;
  readonly startedAt: number | null;
  readonly stoppedAt: number | null;
  readonly sourceCount: number;
  readonly recentEventCount: number;
  readonly projectControlCenterAvailable: boolean;
  readonly sourceFailures: number;
  readonly sources: readonly OperationsEvidenceSourceStatus[];
  readonly projectControlCenter: ProjectControlCenterEvidenceStatus;
  readonly availability: OperationsEvidenceAvailability;
  readonly freshness: OperationsEvidenceFreshness;
  readonly lastUpdatedAt: number | null;
}

export interface OperationsEvidenceSourceHealthCallbacks {
  readonly onSuccess: () => void;
  readonly onError: (error: Error) => void;
}

export interface OperationsEvidenceSourceHealthModel {
  callbacks(source: string): OperationsEvidenceSourceHealthCallbacks;
  snapshot(): readonly OperationsEvidenceSourceStatus[];
  stop(): void;
}

export interface OperationsEvidenceSourceConfiguration {
  readonly source: string;
  readonly configured: boolean;
}

/** Current-state model shared by adapter callbacks and the bridge. */
export function createOperationsEvidenceSourceHealthModel(
  configurations: readonly OperationsEvidenceSourceConfiguration[],
  now: () => number = () => Date.now(),
): OperationsEvidenceSourceHealthModel {
  const statuses = new Map<string, OperationsEvidenceSourceStatus>();
  for (const configuration of configurations) {
    if (statuses.has(configuration.source)) throw new Error(`duplicate evidence source: ${configuration.source}`);
    statuses.set(configuration.source, {
      source: configuration.source,
      configured: configuration.configured,
      state: configuration.configured ? 'STOPPED' : 'UNCONFIGURED',
      lastSuccessfulPollAt: null,
      lastFailureAt: null,
      failureCount: 0,
      lastError: null,
    });
  }

  function update(source: string, updater: (current: OperationsEvidenceSourceStatus) => OperationsEvidenceSourceStatus): void {
    const current = statuses.get(source);
    if (!current) throw new Error(`unknown evidence source: ${source}`);
    if (!current.configured) return;
    statuses.set(source, updater(current));
  }

  return Object.freeze({
    callbacks(source: string): OperationsEvidenceSourceHealthCallbacks {
      if (!statuses.has(source)) throw new Error(`unknown evidence source: ${source}`);
      return Object.freeze({
        onSuccess(): void {
          update(source, (current) => ({
            ...current,
            state: 'HEALTHY',
            lastSuccessfulPollAt: now(),
            lastError: null,
          }));
        },
        onError(error: Error): void {
          update(source, (current) => ({
            ...current,
            state: 'FAILING',
            lastFailureAt: now(),
            failureCount: current.failureCount + 1,
            lastError: sanitizeEvidenceError(error),
          }));
        },
      });
    },
    snapshot(): readonly OperationsEvidenceSourceStatus[] {
      return [...statuses.values()]
        .sort((left, right) => left.source.localeCompare(right.source))
        .map((status) => Object.freeze({ ...status }));
    },
    stop(): void {
      for (const [source, current] of statuses) {
        if (current.configured) statuses.set(source, { ...current, state: 'STOPPED' });
      }
    },
  });
}

export interface OperationsEvidenceReadBridgeOptions {
  readonly projectControlCenter?: ProjectControlCenter;
  readonly sources?: readonly ObservableEventSourceAdapter[];
  /** Current status populated by configured adapters' success/error callbacks. */
  readonly sourceHealth?: OperationsEvidenceSourceHealthModel;
  readonly maxRecentEvents?: number;
  readonly defaultRunId?: string;
  /** Bounded PCC refresh interval. Default 30 seconds; minimum 100 ms. */
  readonly projectControlCenterRefreshIntervalMs?: number;
  /** Hard deadline for a PCC refresh. Default 10 seconds; minimum 100 ms. */
  readonly projectControlCenterRefreshTimeoutMs?: number;
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
  const pccRefreshIntervalMs = options.projectControlCenterRefreshIntervalMs ?? 30_000;
  if (!Number.isInteger(pccRefreshIntervalMs) || pccRefreshIntervalMs < 100) {
    throw new Error('projectControlCenterRefreshIntervalMs must be an integer greater than or equal to 100');
  }
  const pccRefreshTimeoutMs = options.projectControlCenterRefreshTimeoutMs ?? 10_000;
  if (!Number.isInteger(pccRefreshTimeoutMs) || pccRefreshTimeoutMs < 100) {
    throw new Error('projectControlCenterRefreshTimeoutMs must be an integer greater than or equal to 100');
  }
  const now = options.now ?? (() => Date.now());
  const projectControlCenter = options.projectControlCenter ?? null;
  const sources = [...(options.sources ?? [])];

  function validatedSourceStatuses(): readonly OperationsEvidenceSourceStatus[] {
    if (sources.length > 0 && !options.sourceHealth) {
      throw new Error('sourceHealth is required when evidence sources are configured');
    }
    const statuses = options.sourceHealth?.snapshot() ?? [];
    const statusBySource = new Map<string, OperationsEvidenceSourceStatus>();
    for (const status of statuses) {
      if (statusBySource.has(status.source)) {
        throw new Error(`duplicate evidence source health: ${status.source}`);
      }
      statusBySource.set(status.source, status);
    }
    const adapterNames = new Set<string>();
    for (const source of sources) {
      if (adapterNames.has(source.name)) {
        throw new Error(`duplicate evidence source adapter: ${source.name}`);
      }
      adapterNames.add(source.name);
      const status = statusBySource.get(source.name);
      if (!status) throw new Error(`missing evidence source health: ${source.name}`);
      if (!status.configured) throw new Error(`evidence source health is unconfigured: ${source.name}`);
    }
    for (const status of statuses) {
      if (status.configured && !adapterNames.has(status.source)) {
        throw new Error(`configured evidence source health has no adapter: ${status.source}`);
      }
    }
    return statuses;
  }

  // Validate the ownership mapping before any source can start. The same
  // validation is repeated on reads so a custom mutable health provider cannot
  // silently drop or duplicate an instantiated adapter later.
  validatedSourceStatuses();

  const events: ObservableAgentEvent[] = [];
  const bufferedIds = new Set<string>();
  let bridgeFailures = 0;

  function recordFailure(source: string, error: Error): void {
    bridgeFailures += 1;
    try { options.onSourceFailure?.(source, error); } catch { /* evidence observers cannot escalate */ }
  }

  function pushEvent(event: ObservableAgentEvent): void {
    if (bufferedIds.has(event.eventId)) return;
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

  type Lifecycle = 'NEW' | 'STARTING' | 'RUNNING' | 'STOPPED';
  let lifecycle: Lifecycle = 'NEW';
  let lifecycleGeneration = 0;
  let running = false;
  let startedAt: number | null = null;
  let stoppedAt: number | null = null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let pccRefreshTimer: NodeJS.Timeout | undefined;
  let pccRefreshInFlight: Promise<void> | null = null;
  let pccRefreshAbort: AbortController | null = null;
  let pccSnapshot: ProjectControlCenterSnapshot | null = null;
  let pccState: OperationsEvidenceSourceState = projectControlCenter ? 'STOPPED' : 'UNCONFIGURED';
  let pccLastSuccessfulRefreshAt: number | null = null;
  let pccLastFailureAt: number | null = null;
  let pccLastError: string | null = null;

  function isStopped(): boolean {
    return lifecycle === 'STOPPED';
  }

  function sourceStatuses(): readonly OperationsEvidenceSourceStatus[] {
    return validatedSourceStatuses();
  }

  async function refreshProjectControlCenter(): Promise<void> {
    if (!projectControlCenter) return;
    if (pccRefreshInFlight) return pccRefreshInFlight;
    const generation = lifecycleGeneration;
    const controller = new AbortController();
    pccRefreshAbort = controller;
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Project Control Center refresh timed out after ${pccRefreshTimeoutMs} ms`));
    }, pccRefreshTimeoutMs);
    const operation = (async () => {
      try {
        await projectControlCenter.refresh(controller.signal);
        controller.signal.throwIfAborted();
        const refreshed = structuredClone(projectControlCenter.snapshot());
        if (lifecycle !== 'STOPPED' && lifecycleGeneration === generation) {
          pccSnapshot = refreshed;
          pccState = 'HEALTHY';
          pccLastSuccessfulRefreshAt = now();
          pccLastError = null;
        }
      } catch (cause) {
        const abortReason = controller.signal.aborted && controller.signal.reason instanceof Error
          ? controller.signal.reason : null;
        const error = abortReason ?? (cause instanceof Error ? cause : new Error(String(cause)));
        if (lifecycle !== 'STOPPED' && lifecycleGeneration === generation) {
          pccState = 'FAILING';
          pccLastFailureAt = now();
          pccLastError = sanitizeEvidenceError(error);
          recordFailure('project-control-center.refresh', error);
        }
      }
    })();
    pccRefreshInFlight = operation;
    try { await operation; }
    finally {
      clearTimeout(timeout);
      if (pccRefreshAbort === controller) pccRefreshAbort = null;
      if (pccRefreshInFlight === operation) pccRefreshInFlight = null;
    }
  }

  function snapshotActivity(): readonly ObservableAgentEvent[] {
    return events.map((event) => structuredClone(event));
  }

  function buildStatus(): OperationsEvidenceBridgeStatus {
    const currentSources = sourceStatuses();
    const configuredSources = currentSources.filter((source) => source.configured);
    const sourceFailing = configuredSources.some((source) => source.state === 'FAILING');
    const sourceNotCurrent = configuredSources.some((source) => source.state !== 'HEALTHY');
    const pccAvailable = running && pccSnapshot !== null;
    const pccTooOld = pccLastSuccessfulRefreshAt !== null
      && now() - pccLastSuccessfulRefreshAt > pccRefreshIntervalMs * 2;
    const pccCurrent = pccState === 'HEALTHY' && pccAvailable && !pccTooOld;
    const availability: OperationsEvidenceAvailability = !running
      ? 'UNAVAILABLE'
      : pccCurrent && !sourceNotCurrent ? 'AVAILABLE' : 'INCOMPLETE';
    const freshness: OperationsEvidenceFreshness = !running || !pccSnapshot
      ? 'UNKNOWN'
      : pccState === 'FAILING' || pccTooOld || sourceFailing ? 'STALE'
        : pccCurrent && !sourceNotCurrent ? 'FRESH' : 'UNKNOWN';
    const lastUpdates = [
      pccLastSuccessfulRefreshAt,
      ...configuredSources.map((source) => source.lastSuccessfulPollAt),
    ].filter((value): value is number => value !== null && Number.isFinite(value));
    return Object.freeze({
      running,
      startedAt,
      stoppedAt,
      sourceCount: sources.length,
      recentEventCount: events.length,
      projectControlCenterAvailable: pccAvailable,
      sourceFailures: bridgeFailures + currentSources.reduce((total, source) => total + source.failureCount, 0),
      sources: currentSources,
      projectControlCenter: Object.freeze({
        configured: projectControlCenter !== null,
        state: pccState,
        lastSuccessfulRefreshAt: pccLastSuccessfulRefreshAt,
        lastFailureAt: pccLastFailureAt,
        lastError: pccLastError,
      }),
      availability,
      freshness,
      lastUpdatedAt: lastUpdates.length > 0 ? Math.max(...lastUpdates) : null,
    });
  }

  const read: OperationsEvidenceReadView = Object.freeze({
    projectControlCenter(): ProjectControlCenterSnapshot | null {
      if (!running || !pccSnapshot) return null;
      return structuredClone(pccSnapshot);
    },
    activity: snapshotActivity,
    status: buildStatus,
  });

  async function start(): Promise<void> {
    if (lifecycle === 'STOPPED') throw new Error('Operations Evidence Read Bridge is terminal after stop');
    if (startPromise) return startPromise;
    lifecycle = 'STARTING';
    lifecycleGeneration += 1;
    startPromise = (async () => {
      await refreshProjectControlCenter();
      if (isStopped()) return;
      try {
        await monitor.start();
        if (isStopped()) {
          await monitor.stop();
          options.sourceHealth?.stop();
          return;
        }
        running = true;
        lifecycle = 'RUNNING';
        startedAt = now();
        if (projectControlCenter) {
          pccRefreshTimer = setInterval(() => {
            if (lifecycle === 'RUNNING') void refreshProjectControlCenter();
          }, pccRefreshIntervalMs);
          pccRefreshTimer.unref();
        }
      } catch {
        running = false;
        lifecycle = 'STOPPED';
        stoppedAt = now();
        pccState = projectControlCenter ? 'STOPPED' : 'UNCONFIGURED';
        options.sourceHealth?.stop();
      }
    })();
    return startPromise;
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      lifecycle = 'STOPPED';
      lifecycleGeneration += 1;
      running = false;
      stoppedAt = now();
      if (pccRefreshTimer) clearInterval(pccRefreshTimer);
      pccRefreshTimer = undefined;
      pccRefreshAbort?.abort(new Error('Project Control Center refresh stopped'));
      await pccRefreshInFlight;
      try { await monitor.stop(); } catch { /* monitor already reported the evidence failure */ }
      options.sourceHealth?.stop();
      pccState = projectControlCenter ? 'STOPPED' : 'UNCONFIGURED';
    })();
    return stopPromise;
  }

  return Object.freeze({ start, stop, read });
}
