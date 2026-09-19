/**
 * Bitget V2 request signer (L0).
 *
 * Preimage contract (Bitget V2, GET only in L0):
 *   timestamp + METHOD.toUpperCase() + requestPath + optional("?" + canonicalQuery) + body
 * GET carries an empty body. Signature = BASE64(HMAC-SHA256(secretKey, preimage)).
 *
 * The signer only accepts an explicitly injected credential and an explicitly injected timestamp.
 * It never discovers the environment, never reads a clock and never performs I/O.
 */
import { createHmac } from 'node:crypto';
import {
  BITGET_READ_TIMESTAMP_PATTERN,
  BitgetReadContractError,
} from './BitgetReadContracts';

export const BITGET_V2_SIGNATURE_ALGORITHM = 'HMAC-SHA256' as const;
export const BITGET_V2_SIGNATURE_ENCODING = 'base64' as const;
export const BITGET_V2_L0_SIGNED_METHOD = 'GET' as const;

export interface BitgetV2SignatureInput {
  /** Explicitly injected credential material; never discovered from the environment. */
  readonly secretKey: string;
  readonly timestamp: string;
  readonly method: string;
  readonly requestPath: string;
  readonly canonicalQuery: string;
  /** GET requests always sign an empty body. */
  readonly body: string;
}

export interface BitgetV2Signature {
  readonly timestamp: string;
  readonly preimage: string;
  readonly signature: string;
}

function fail(code: string): never {
  throw new BitgetReadContractError(code);
}

/** Pure conversion helper: callers own the clock, L0 never reads it. */
export function bitgetTimestampFromMillis(millis: number): string {
  if (typeof millis !== 'number' || !Number.isSafeInteger(millis) || millis < 0) {
    fail('BITGET_READ_TIMESTAMP_INVALID');
  }
  return String(millis);
}

export function bitgetV2Preimage(
  method: string,
  requestPath: string,
  canonicalQuery: string,
  body: string,
): string {
  if (typeof method !== 'string' || method.toUpperCase() !== BITGET_V2_L0_SIGNED_METHOD) {
    fail('BITGET_READ_METHOD_NOT_SIGNED');
  }
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/api/v2/')) {
    fail('BITGET_READ_PATH_INVALID');
  }
  if (typeof body !== 'string' || body.length !== 0) fail('BITGET_READ_BODY_INVALID');
  const query = typeof canonicalQuery === 'string' ? canonicalQuery : fail('BITGET_READ_QUERY_INVALID');
  if (query.length === 0) return requestPath;
  return `${requestPath}?${query}`;
}

export function signBitgetV2Request(input: BitgetV2SignatureInput): BitgetV2Signature {
  if (typeof input !== 'object' || input === null) fail('BITGET_READ_SIGNATURE_INPUT_INVALID');
  const { secretKey, timestamp, method, requestPath, canonicalQuery, body } = input;
  if (typeof secretKey !== 'string' || secretKey.length === 0) fail('BITGET_READ_SECRET_MISSING');
  if (typeof timestamp !== 'string' || !BITGET_READ_TIMESTAMP_PATTERN.test(timestamp)) {
    fail('BITGET_READ_TIMESTAMP_INVALID');
  }
  const path = bitgetV2Preimage(method, requestPath, canonicalQuery, body);
  const preimage = `${timestamp}${BITGET_V2_L0_SIGNED_METHOD}${path}`;
  const signature = createHmac('sha256', secretKey).update(preimage, 'utf8').digest('base64');
  if (signature.length === 0) fail('BITGET_READ_SIGNATURE_INVALID');
  return Object.freeze({
    timestamp,
    preimage,
    signature,
  });
}
