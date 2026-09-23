/**
 * Deterministic Gate.io L1A clock model.
 *
 * Local time is always injected. A public server-time observation is bounded by round-trip time,
 * observation age and a conservative offset limit before it can produce a Unix-seconds signature.
 * There is no timer, periodic synchronization or ambient system-clock lookup.
 */

export const MAX_GATEIO_SERVER_TIME_OBSERVATION_AGE_MS = 30_000 as const;
export const MAX_GATEIO_SERVER_TIME_RTT_MS = 10_000 as const;
export const MAX_GATEIO_SERVER_TIME_OFFSET_MS = 86_400_000 as const;
export const GATEIO_SERVER_TIME_UNIT = 'MILLISECONDS' as const;
export const GATEIO_SIGNED_TIMESTAMP_UNIT = 'UNIX_SECONDS' as const;

export type GateIoReadClockFailureReason =
  | 'GATEIO_SERVER_TIME_INVALID'
  | 'GATEIO_SERVER_TIME_RTT_INVALID'
  | 'GATEIO_SERVER_TIME_OFFSET_INVALID'
  | 'GATEIO_SERVER_TIME_OBSERVATION_STALE'
  | 'OBSERVATION_TIME_INVALID';

export interface GateIoReadClock {
  now(): number;
}

export interface GateIoServerTimeObservation {
  readonly requestStartedMs: number;
  readonly serverTimeMs: number;
  readonly responseReceivedMs: number;
  readonly midpointMs: number;
  readonly offsetMs: number;
  readonly roundTripMs: number;
}

export class GateIoReadClockError extends Error {
  constructor(readonly reason: GateIoReadClockFailureReason) {
    super(reason);
    this.name = 'GateIoReadClockError';
  }
}

function fail(reason: GateIoReadClockFailureReason): never {
  throw new GateIoReadClockError(reason);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function createGateIoReadClock(now: () => number): GateIoReadClock {
  if (typeof now !== 'function') fail('OBSERVATION_TIME_INVALID');
  return Object.freeze({
    now(): number {
      const value = now();
      if (!nonNegativeSafeInteger(value)) fail('OBSERVATION_TIME_INVALID');
      return value;
    },
  });
}

/** Request-midpoint offset calculation, with all factual input retained in the immutable result. */
export function observeGateIoServerTime(input: {
  readonly requestStartedMs: unknown;
  readonly serverTimeMs: unknown;
  readonly responseReceivedMs: unknown;
}): GateIoServerTimeObservation {
  const { requestStartedMs, serverTimeMs, responseReceivedMs } = input;
  if (!nonNegativeSafeInteger(serverTimeMs) || serverTimeMs === 0) {
    fail('GATEIO_SERVER_TIME_INVALID');
  }
  if (!nonNegativeSafeInteger(requestStartedMs)
      || !nonNegativeSafeInteger(responseReceivedMs)) {
    fail('OBSERVATION_TIME_INVALID');
  }
  const roundTripMs = responseReceivedMs - requestStartedMs;
  if (!Number.isSafeInteger(roundTripMs) || roundTripMs < 0
      || roundTripMs > MAX_GATEIO_SERVER_TIME_RTT_MS) {
    fail('GATEIO_SERVER_TIME_RTT_INVALID');
  }
  const midpointMs = requestStartedMs + (roundTripMs / 2);
  const offsetMs = serverTimeMs - midpointMs;
  if (!Number.isFinite(midpointMs) || !Number.isFinite(offsetMs)
      || Math.abs(offsetMs) > MAX_GATEIO_SERVER_TIME_OFFSET_MS) {
    fail('GATEIO_SERVER_TIME_OFFSET_INVALID');
  }
  return Object.freeze({
    requestStartedMs,
    serverTimeMs,
    responseReceivedMs,
    midpointMs,
    offsetMs,
    roundTripMs,
  });
}

export function gateIoObservationAgeMs(
  nowMs: unknown,
  observation: GateIoServerTimeObservation,
): number {
  if (!nonNegativeSafeInteger(nowMs)
      || typeof observation !== 'object' || observation === null
      || !nonNegativeSafeInteger(observation.responseReceivedMs)) {
    fail('OBSERVATION_TIME_INVALID');
  }
  const ageMs = nowMs - observation.responseReceivedMs;
  if (!Number.isSafeInteger(ageMs) || ageMs < 0) fail('OBSERVATION_TIME_INVALID');
  return ageMs;
}

export function assertFreshGateIoServerTimeObservation(
  clock: GateIoReadClock,
  observation: GateIoServerTimeObservation | null,
): GateIoServerTimeObservation {
  if (observation === null) fail('GATEIO_SERVER_TIME_INVALID');
  if (!Number.isFinite(observation.offsetMs)
      || Math.abs(observation.offsetMs) > MAX_GATEIO_SERVER_TIME_OFFSET_MS) {
    fail('GATEIO_SERVER_TIME_OFFSET_INVALID');
  }
  if (!Number.isSafeInteger(observation.roundTripMs) || observation.roundTripMs < 0
      || observation.roundTripMs > MAX_GATEIO_SERVER_TIME_RTT_MS) {
    fail('GATEIO_SERVER_TIME_RTT_INVALID');
  }
  if (gateIoObservationAgeMs(clock.now(), observation)
      > MAX_GATEIO_SERVER_TIME_OBSERVATION_AGE_MS) {
    fail('GATEIO_SERVER_TIME_OBSERVATION_STALE');
  }
  return observation;
}

/** One explicit Unix-seconds timestamp derived from the current injected clock and fresh offset. */
export function signedGateIoTimestamp(
  clock: GateIoReadClock,
  observation: GateIoServerTimeObservation | null,
): string {
  const current = clock.now();
  const fresh = assertFreshGateIoServerTimeObservation(
    Object.freeze({ now: () => current }), observation,
  );
  const adjustedMs = current + fresh.offsetMs;
  if (!Number.isFinite(adjustedMs) || adjustedMs <= 0
      || adjustedMs > Number.MAX_SAFE_INTEGER) {
    fail('OBSERVATION_TIME_INVALID');
  }
  const seconds = Math.floor(adjustedMs / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 9_999_999_999) {
    fail('OBSERVATION_TIME_INVALID');
  }
  return String(seconds);
}

export type GateIoReadFreshness = 'FRESH' | 'STALE' | 'UNKNOWN';

export function gateIoFreshnessFromObservation(
  nowMs: unknown,
  observation: GateIoServerTimeObservation | null,
): GateIoReadFreshness {
  if (observation === null) return 'UNKNOWN';
  try {
    const age = gateIoObservationAgeMs(nowMs, observation);
    return age <= MAX_GATEIO_SERVER_TIME_OBSERVATION_AGE_MS ? 'FRESH' : 'STALE';
  } catch {
    return 'UNKNOWN';
  }
}
