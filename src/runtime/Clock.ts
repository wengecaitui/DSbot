/**
 * Stage 4B4.1: Clock abstractions — domain wall-clock and monotonic elapsed time.
 *
 * DomainClock: wall-clock time (typically Date.now). NOT assumed monotonic —
 * NTP adjustments, VM suspend, or user clock changes can make it decrease.
 *
 * ElapsedClock: elapsed / high-resolution time (typically performance.now).
 * Monotonic and non-decreasing within a process lifetime.
 *
 * Both are used by FastPipeline for deterministic timestamp injection.
 */
import { performance } from 'node:perf_hooks';

export interface Clock {
  now(): number;
}

/** Domain wall-clock — may decrease (NTP, suspend). */
export type DomainClock = Clock;

/** Monotonic elapsed clock — non-decreasing. */
export interface ElapsedClock {
  now(): number;
}

/** Default domain clock backed by Date.now. */
export const systemDomainClock: DomainClock = {
  now: () => Date.now(),
};

/** Default elapsed clock backed by Node monotonic performance.now (node:perf_hooks). */
export const systemElapsedClock: ElapsedClock = {
  now: () => performance.now(),
};
