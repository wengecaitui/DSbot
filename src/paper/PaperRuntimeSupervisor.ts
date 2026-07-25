// Stage 4A3-R1: Supervisor — typed transitions, async-safe events, failed recovery, metrics.
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import { PaperRuntimeRegistry, type PaperRuntimeBinding } from './PaperRuntimeRegistry';
import type { PaperCoordinatorResult } from './PaperFastPathCoordinator';
import type { Clock, PaperRuntimeEventSink, PaperRuntimeLifecycleMetricsSnapshot } from './PaperObservability';
import { systemClock, NullPaperRuntimeEventSink, makeEventId, emitSafe } from './PaperObservability';
import {
  type PaperRuntimeLifecycleState, type PaperRuntimeLifecycleSnapshot,
  type PaperRuntimeBatchResult, type PaperRuntimeLifecycleAdapter,
  type ActiveTransition, type LifecycleOperation,
  PaperRuntimeLifecycleError, NoopPaperRuntimeLifecycleAdapter,
} from './PaperLifecycle';

interface LifecycleRecord {
  accountId: string; exchange: ExchangeId;
  state: PaperRuntimeLifecycleState;
  generation: number;
  registeredAtMs: number; lastTransitionAtMs: number;
  startedAtMs?: number; stoppedAtMs?: number;
  lastFailureAtMs?: number; lastErrorCode?: string; lastErrorMessage?: string;
  inFlightRuns: number;
  adapter: PaperRuntimeLifecycleAdapter;
  activeTransition: ActiveTransition | null;
  drainResolve: (() => void) | null;
  metrics: {
    startTotal: number; startFailed: number; stopTotal: number; stopFailed: number;
    restartTotal: number; restartFailed: number; runRejected: number; inFlightMax: number;
  };
}

function snapshot(r: LifecycleRecord): PaperRuntimeLifecycleSnapshot {
  return Object.freeze({
    accountId: r.accountId, exchange: r.exchange, state: r.state,
    acceptingRuns: r.state === 'running', inFlightRuns: r.inFlightRuns, generation: r.generation,
    registeredAtMs: r.registeredAtMs, lastTransitionAtMs: r.lastTransitionAtMs,
    startedAtMs: r.startedAtMs, stoppedAtMs: r.stoppedAtMs,
    lastFailureAtMs: r.lastFailureAtMs, lastErrorCode: r.lastErrorCode, lastErrorMessage: r.lastErrorMessage,
  });
}

export class PaperRuntimeSupervisor {
  private records = new Map<string, LifecycleRecord>();
  private registry: PaperRuntimeRegistry;
  private sink: PaperRuntimeEventSink;
  private clock: Clock;

  constructor(opts: { registry: PaperRuntimeRegistry; eventSink?: PaperRuntimeEventSink; clock?: Clock }) {
    this.registry = opts.registry; this.sink = opts.eventSink ?? new NullPaperRuntimeEventSink(); this.clock = opts.clock ?? systemClock;
  }

  private key(aid: string, ex: ExchangeId): string { return `${aid}:${ex}`; }
  private validate(aid: string, ex: ExchangeId): void {
    if (typeof aid !== 'string' || aid !== aid.trim() || aid.length === 0) throw new PaperRuntimeLifecycleError('LIFECYCLE_INVALID_ACCOUNT', 'invalid', aid, ex);
    if (!isExchangeId(ex)) throw new PaperRuntimeLifecycleError('LIFECYCLE_INVALID_EXCHANGE', 'invalid', aid, ex);
  }
  private get(aid: string, ex: ExchangeId): LifecycleRecord {
    this.validate(aid, ex); const r = this.records.get(this.key(aid, ex));
    if (!r) throw new PaperRuntimeLifecycleError('RUNTIME_NOT_REGISTERED', `no lifecycle for ${aid}:${ex}`, aid, ex);
    return r;
  }

  // ── Register / Unregister ───────────────────────────────────
  register(binding: PaperRuntimeBinding, adapter?: PaperRuntimeLifecycleAdapter): void {
    this.registry.register(binding);
    const now = this.clock.now();
    const r: LifecycleRecord = {
      accountId: binding.accountId, exchange: binding.exchange, state: 'stopped', generation: 0,
      registeredAtMs: now, lastTransitionAtMs: now, inFlightRuns: 0,
      adapter: adapter ?? new NoopPaperRuntimeLifecycleAdapter(),
      activeTransition: null, drainResolve: null,
      metrics: { startTotal:0,startFailed:0,stopTotal:0,stopFailed:0,restartTotal:0,restartFailed:0,runRejected:0,inFlightMax:0 },
    };
    this.records.set(this.key(binding.accountId, binding.exchange), r);
  }

  unregister(aid: string, ex: ExchangeId): boolean {
    const r = this.get(aid, ex);
    if (r.state !== 'stopped') throw new PaperRuntimeLifecycleError('RUNTIME_NOT_STOPPED', `unregister in ${r.state}`, aid, ex);
    if (r.inFlightRuns !== 0) throw new PaperRuntimeLifecycleError('RUNTIME_NOT_STOPPED', 'in-flight pending', aid, ex);
    if (r.activeTransition) throw new PaperRuntimeLifecycleError('LIFECYCLE_TRANSITION_IN_PROGRESS', 'transition in progress', aid, ex);
    this.records.delete(this.key(aid, ex));
    return this.registry.unregister(aid, ex);
  }

  // ── Queries ─────────────────────────────────────────────────
  lifecycle(aid: string, ex: ExchangeId): PaperRuntimeLifecycleSnapshot { return snapshot(this.get(aid, ex)); }
  lifecycleAll(): readonly PaperRuntimeLifecycleSnapshot[] {
    return [...this.records.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>snapshot(r));
  }
  metrics(aid: string, ex: ExchangeId): PaperRuntimeLifecycleMetricsSnapshot {
    const r = this.get(aid, ex); const m = r.metrics;
    return Object.freeze({ accountId: aid, exchange: ex, lifecycleStartTotal: m.startTotal, lifecycleStartFailedTotal: m.startFailed, lifecycleStopTotal: m.stopTotal, lifecycleStopFailedTotal: m.stopFailed, lifecycleRestartTotal: m.restartTotal, lifecycleRestartFailedTotal: m.restartFailed, lifecycleRunRejectedTotal: m.runRejected, lifecycleInFlightCurrent: r.inFlightRuns, lifecycleInFlightMax: m.inFlightMax });
  }
  metricsAll(): readonly PaperRuntimeLifecycleMetricsSnapshot[] {
    return [...this.records.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>this.metrics(r.accountId, r.exchange));
  }

  // ── Conflict check ──────────────────────────────────────────
  private checkConflict(r: LifecycleRecord, op: LifecycleOperation, aid: string, ex: ExchangeId): void {
    if (!r.activeTransition) return;
    if (r.activeTransition.operation !== op) throw new PaperRuntimeLifecycleError('LIFECYCLE_TRANSITION_IN_PROGRESS', `${op} rejected: ${r.activeTransition.operation} in progress`, aid, ex);
  }

  // ── Start ───────────────────────────────────────────────────
  async start(aid: string, ex: ExchangeId): Promise<PaperRuntimeLifecycleSnapshot> {
    const r = this.get(aid, ex);
    // Transition precedence: check activeTransition BEFORE state idempotency
    if (r.activeTransition) {
      if (r.activeTransition.operation === 'start') { await r.activeTransition.promise; return snapshot(r); }
      await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.lifecycle_rejected', accountId: aid, exchange: ex, occurredAtMs: this.clock.now(), errorCode: 'LIFECYCLE_TRANSITION_IN_PROGRESS', metadata: { attemptedOperation: 'start', activeOperation: r.activeTransition.operation, lifecycleState: r.state, generation: r.generation, inFlightRuns: r.inFlightRuns } });
      throw new PaperRuntimeLifecycleError('LIFECYCLE_TRANSITION_IN_PROGRESS', `start rejected: ${r.activeTransition.operation} in progress`, aid, ex);
    }
    if (r.state === 'running') return snapshot(r);
    if (r.state === 'failed') throw new PaperRuntimeLifecycleError('LIFECYCLE_INVALID_STATE', 'cannot start from failed', aid, ex);
    const gate = this._doStart(r);
    r.activeTransition = { operation: 'start', promise: gate };
    try { await gate; return snapshot(r); } finally { r.activeTransition = null; }
  }

  private async _doStart(r: LifecycleRecord): Promise<PaperRuntimeLifecycleSnapshot> {
    const now = this.clock.now();
    r.metrics.startTotal++;
    r.state = 'starting'; r.lastTransitionAtMs = now;
    await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.starting', accountId: r.accountId, exchange: r.exchange, occurredAtMs: now, metadata: { lifecycleState: 'starting', generation: r.generation, inFlightRuns: r.inFlightRuns } });
    try {
      await r.adapter.start();
      r.state = 'running'; r.generation++; r.lastTransitionAtMs = this.clock.now(); r.startedAtMs = this.clock.now();
      await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.started', accountId: r.accountId, exchange: r.exchange, occurredAtMs: this.clock.now(), metadata: { lifecycleState: 'running', generation: r.generation } });
      return snapshot(r);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      r.state = 'failed'; r.lastFailureAtMs = this.clock.now(); r.lastErrorCode = 'LIFECYCLE_START_FAILED'; r.lastErrorMessage = msg;
      r.metrics.startFailed++;
      await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.lifecycle_error', accountId: r.accountId, exchange: r.exchange, occurredAtMs: this.clock.now(), errorCode: r.lastErrorCode, errorMessage: r.lastErrorMessage, metadata: { lifecycleState: 'failed', generation: r.generation } });
      throw new PaperRuntimeLifecycleError('LIFECYCLE_START_FAILED', msg, r.accountId, r.exchange);
    }
  }

  // ── Stop ────────────────────────────────────────────────────
  async stop(aid: string, ex: ExchangeId): Promise<PaperRuntimeLifecycleSnapshot> {
    const r = this.get(aid, ex);
    if (r.activeTransition) {
      if (r.activeTransition.operation === 'stop') { await r.activeTransition.promise; return snapshot(r); }
      await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.lifecycle_rejected', accountId: aid, exchange: ex, occurredAtMs: this.clock.now(), errorCode: 'LIFECYCLE_TRANSITION_IN_PROGRESS', metadata: { attemptedOperation: 'stop', activeOperation: r.activeTransition.operation, lifecycleState: r.state, generation: r.generation, inFlightRuns: r.inFlightRuns } });
      throw new PaperRuntimeLifecycleError('LIFECYCLE_TRANSITION_IN_PROGRESS', `stop rejected: ${r.activeTransition.operation} in progress`, aid, ex);
    }
    if (r.state === 'stopped') return snapshot(r);
    if (r.state === 'failed') {
      r.metrics.stopTotal++;
      const gate = this._recoveryStop(r);
      r.activeTransition = { operation: 'stop', promise: gate };
      try { await gate; return snapshot(r); } finally { r.activeTransition = null; }
    }
    r.metrics.stopTotal++;
    const gate = this._doStop(r);
    r.activeTransition = { operation: 'stop', promise: gate };
    try { await gate; return snapshot(r); } finally { r.activeTransition = null; }
  }

  private async _recoveryStop(r: LifecycleRecord): Promise<PaperRuntimeLifecycleSnapshot> {
    const now = this.clock.now();
    r.state = 'stopping'; r.lastTransitionAtMs = now;
    try {
      await r.adapter.stop();
      r.state = 'stopped'; r.lastTransitionAtMs = this.clock.now(); r.stoppedAtMs = this.clock.now();
      return snapshot(r);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      r.state = 'failed'; r.lastFailureAtMs = this.clock.now(); r.lastErrorCode = 'LIFECYCLE_STOP_FAILED'; r.lastErrorMessage = msg;
      throw new PaperRuntimeLifecycleError('LIFECYCLE_STOP_FAILED', msg, r.accountId, r.exchange);
    }
  }

  private async _doStop(r: LifecycleRecord): Promise<PaperRuntimeLifecycleSnapshot> {
    const now = this.clock.now();
    r.state = 'stopping'; r.lastTransitionAtMs = now;
    await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.stopping', accountId: r.accountId, exchange: r.exchange, occurredAtMs: now, metadata: { lifecycleState: 'stopping', inFlightRuns: r.inFlightRuns } });
    // Graceful drain
    if (r.inFlightRuns > 0) {
      await new Promise<void>(res => { r.drainResolve = res; });
    }
    try {
      await r.adapter.stop();
      r.state = 'stopped'; r.lastTransitionAtMs = this.clock.now(); r.stoppedAtMs = this.clock.now();
      await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.stopped', accountId: r.accountId, exchange: r.exchange, occurredAtMs: this.clock.now(), metadata: { lifecycleState: 'stopped' } });
      return snapshot(r);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      r.state = 'failed'; r.lastFailureAtMs = this.clock.now(); r.lastErrorCode = 'LIFECYCLE_STOP_FAILED'; r.lastErrorMessage = msg;
      r.metrics.stopFailed++;
      await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.lifecycle_error', accountId: r.accountId, exchange: r.exchange, occurredAtMs: this.clock.now(), errorCode: r.lastErrorCode, errorMessage: r.lastErrorMessage });
      throw new PaperRuntimeLifecycleError('LIFECYCLE_STOP_FAILED', msg, r.accountId, r.exchange);
    }
  }

  // ── Restart ─────────────────────────────────────────────────
  async restart(aid: string, ex: ExchangeId): Promise<PaperRuntimeLifecycleSnapshot> {
    const r = this.get(aid, ex);
    if (r.activeTransition) {
      if (r.activeTransition.operation === 'restart') { await r.activeTransition.promise; return snapshot(r); }
      await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.lifecycle_rejected', accountId: aid, exchange: ex, occurredAtMs: this.clock.now(), errorCode: 'LIFECYCLE_TRANSITION_IN_PROGRESS', metadata: { attemptedOperation: 'restart', activeOperation: r.activeTransition.operation, lifecycleState: r.state, generation: r.generation, inFlightRuns: r.inFlightRuns } });
      throw new PaperRuntimeLifecycleError('LIFECYCLE_TRANSITION_IN_PROGRESS', `restart rejected: ${r.activeTransition.operation} in progress`, aid, ex);
    }
    r.metrics.restartTotal++;
    const gate = this._doRestart(r);
    r.activeTransition = { operation: 'restart', promise: gate };
    try { return await gate; } finally { r.activeTransition = null; }
  }

  private async _doRestart(r: LifecycleRecord): Promise<PaperRuntimeLifecycleSnapshot> {
    const aid = r.accountId; const ex = r.exchange;
    await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.restarting', accountId: aid, exchange: ex, occurredAtMs: this.clock.now() });
    // Running → stop first
    if (r.state === 'running') {
      try { await this._doStop(r); } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e); r.state = 'failed'; r.lastErrorCode = 'LIFECYCLE_RESTART_FAILED'; r.lastErrorMessage = msg; r.metrics.restartFailed++; throw new PaperRuntimeLifecycleError('LIFECYCLE_RESTART_FAILED', msg, aid, ex);
      }
    }
    // Failed recovery stop
    if (r.state === 'failed') {
      try { r.state = 'stopping'; await r.adapter.stop(); r.state = 'stopped'; r.lastTransitionAtMs = this.clock.now(); r.stoppedAtMs = this.clock.now(); }
      catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); r.state = 'failed'; r.lastErrorCode = 'LIFECYCLE_RESTART_FAILED'; r.lastErrorMessage = msg; r.metrics.restartFailed++; throw new PaperRuntimeLifecycleError('LIFECYCLE_RESTART_FAILED', msg, aid, ex); }
    }
    // Now start
    try { await this._doStart(r); } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e); r.state = 'failed'; r.lastErrorCode = 'LIFECYCLE_RESTART_FAILED'; r.lastErrorMessage = msg; r.metrics.restartFailed++; throw new PaperRuntimeLifecycleError('LIFECYCLE_RESTART_FAILED', msg, aid, ex);
    }
    await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.restarted', accountId: aid, exchange: ex, occurredAtMs: this.clock.now(), metadata: { lifecycleState: 'running', generation: r.generation } });
    return snapshot(r);
  }

  // ── Run ─────────────────────────────────────────────────────
  async run(aid: string, signal: { exchange: ExchangeId; symbol: string; source: string }, params: { feeBps: number; slippageBps: number }): Promise<PaperCoordinatorResult> {
    const r = this.get(aid, signal.exchange);
    if (r.state !== 'running') { r.metrics.runRejected++; await emitSafe(this.sink, { eventId: makeEventId(), eventType: 'runtime.lifecycle_rejected', accountId: aid, exchange: signal.exchange, occurredAtMs: this.clock.now(), errorCode: 'RUNTIME_NOT_RUNNING', metadata: { lifecycleState: r.state, generation: r.generation, inFlightRuns: r.inFlightRuns } }); throw new PaperRuntimeLifecycleError('RUNTIME_NOT_RUNNING', `state=${r.state}`, aid, signal.exchange); }
    r.inFlightRuns++; if (r.inFlightRuns > r.metrics.inFlightMax) r.metrics.inFlightMax = r.inFlightRuns;
    try { return await this.registry.run(aid, signal, params); }
    finally { r.inFlightRuns--; if (r.inFlightRuns === 0 && r.drainResolve) { const res = r.drainResolve; r.drainResolve = null; res(); } }
  }

  // ── Batch ───────────────────────────────────────────────────
  async startAll(): Promise<readonly PaperRuntimeBatchResult[]> {
    const results: PaperRuntimeBatchResult[] = [];
    for (const r of [...this.records.values()].sort((a,b)=>this.key(a.accountId,a.exchange).localeCompare(this.key(b.accountId,b.exchange)))) {
      try { await this.start(r.accountId, r.exchange); results.push(Object.freeze({ accountId: r.accountId, exchange: r.exchange, operation: 'start' as const, success: true, state: r.state })); }
      catch (err: unknown) { const e = err instanceof Error ? err : new Error(String(err)); const code = e instanceof PaperRuntimeLifecycleError ? e.code : undefined; results.push(Object.freeze({ accountId: r.accountId, exchange: r.exchange, operation: 'start' as const, success: false, state: r.state, errorCode: code, errorMessage: e.message })); }
    }
    return results;
  }
  async stopAll(): Promise<readonly PaperRuntimeBatchResult[]> {
    const results: PaperRuntimeBatchResult[] = [];
    for (const r of [...this.records.values()].sort((a,b)=>this.key(a.accountId,a.exchange).localeCompare(this.key(b.accountId,b.exchange)))) {
      try { await this.stop(r.accountId, r.exchange); const s = snapshot(r); results.push(Object.freeze({ accountId: r.accountId, exchange: r.exchange, operation: 'stop' as const, success: s.state === 'stopped', state: s.state })); }
      catch (err: unknown) { const e = err instanceof Error ? err : new Error(String(err)); const code = e instanceof PaperRuntimeLifecycleError ? e.code : undefined; results.push(Object.freeze({ accountId: r.accountId, exchange: r.exchange, operation: 'stop' as const, success: false, state: r.state, errorCode: code, errorMessage: e.message })); }
    }
    return results;
  }
}
