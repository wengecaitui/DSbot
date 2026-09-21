/**
 * Bitget read clock model (L1A).
 *
 * There is deliberately no hidden clock authority: callers inject `now()`, server time comes from a
 * factual public observation, and the offset between them is bounded and explicit. The timestamp used
 * for signing is produced once and handed to the transport, which signs exactly that value.
 */
import type { BitgetReadFailureReason } from './BitgetReadContracts';

/** Signed-request freshness window. Bitget rejects requests whose timestamp is outside its window. */
export const BITGET_SIGNED_TIMESTAMP_WINDOW_MS = 30_000 as const;

/** Ceiling on the tolerated local/server offset and round trip. */
export const MAX_BITGET_SERVER_TIME_SKEW_MS = 30_000 as const;
export const MAX_BITGET_SERVER_TIME_ROUND_TRIP_MS = 10_000 as const;

export interface BitgetReadClock {
  now(): number;
}

export interface BitgetServerTimeObservation {
  readonly serverTimeMs: number;
  readonly observedAtMs: number;
  readonly roundTripMs: number;
  readonly offsetMs: number;
}

export class BitgetReadClockError extends Error {
  constructor(readonly reason: BitgetReadFailureReason) {
    super(reason);
    this.name = 'BitgetReadClockError';
  }
}

function fail(reason: BitgetReadFailureReason): never {
  throw new BitgetReadClockError(reason);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Explicit clock injection. This module never calls `Date.now()` itself. */
export function createBitgetReadClock(now: () => number): BitgetReadClock {
  if (typeof now !== 'function') fail('OBSERVATION_TIME_INVALID');
  return Object.freeze({
    now(): number {
      const value = now();
      if (!nonNegativeSafeInteger(value)) fail('OBSERVATION_TIME_INVALID');
      return value;
    },
  });
}

/**
 * Derive the local/server offset from a factual server-time response. Invalid server time, a future
 * exchange timestamp or an absurd offset all fail closed rather than pretending the clock is fine.
 */
export function observeBitgetServerTime(input: {
  readonly serverTimeMs: unknown;
  readonly requestStartedMs: number;
  readonly responseReceivedMs: number;
}): BitgetServerTimeObservation {
  const { serverTimeMs, requestStartedMs, responseReceivedMs } = input;
  if (!nonNegativeSafeInteger(serverTimeMs)) fail('BITGET_SERVER_TIME_INVALID');
  if (!nonNegativeSafeInteger(requestStartedMs) || !nonNegativeSafeInteger(responseReceivedMs)) {
    fail('OBSERVATION_TIME_INVALID');
  }
  const roundTripMs = responseReceivedMs - requestStartedMs;
  if (roundTripMs < 0 || roundTripMs > MAX_BITGET_SERVER_TIME_ROUND_TRIP_MS) {
    fail('BITGET_SERVER_TIME_INVALID');
  }
  const offsetMs = serverTimeMs - responseReceivedMs;
  if (Math.abs(offsetMs) > MAX_BITGET_SERVER_TIME_SKEW_MS) fail('BITGET_CLOCK_SKEW_INVALID');
  return Object.freeze({
    serverTimeMs,
    observedAtMs: responseReceivedMs,
    roundTripMs,
    offsetMs,
  });
}

/**
 * One signed millisecond timestamp. The same string is used for the signature preimage and the
 * ACCESS-TIMESTAMP header because the transport signs the request it was given.
 */
export function signedBitgetTimestamp(clock: BitgetReadClock, offsetMs: number): string {
  if (typeof offsetMs !== 'number' || !Number.isSafeInteger(offsetMs)
      || Math.abs(offsetMs) > MAX_BITGET_SERVER_TIME_SKEW_MS) {
    fail('BITGET_CLOCK_SKEW_INVALID');
  }
  const timestamp = clock.now() + offsetMs;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) fail('OBSERVATION_TIME_INVALID');
  return String(timestamp);
}

export function isUnsignedBitgetTimestampFresh(
  timestampMs: unknown,
  observation: BitgetServerTimeObservation | null,
): boolean {
  if (observation === null) return false;
  if (!nonNegativeSafeInteger(timestampMs)) return false;
  return Math.abs(observation.serverTimeMs - timestampMs) <= BITGET_SIGNED_TIMESTAMP_WINDOW_MS;
}
