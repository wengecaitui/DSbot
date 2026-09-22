/**
 * Pure Gate API v4 GET signer. All inputs are explicit; this module performs no I/O and discovers
 * no credential or clock state.
 */
import { createHmac } from 'node:crypto';
import {
  GATEIO_API_PREFIX,
  GateIoReadContractError,
  gateIoTimestampValid,
} from './GateIoReadContracts';

export const GATEIO_V4_SIGNATURE_ALGORITHM = 'HMAC-SHA512' as const;
export const GATEIO_V4_SIGNATURE_ENCODING = 'hex' as const;
export const GATEIO_V4_L0_SIGNED_METHOD = 'GET' as const;
export const GATEIO_V4_TIMESTAMP_UNIT = 'UNIX_SECONDS' as const;
export const GATEIO_EMPTY_BODY_SHA512 =
  'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce'
  + '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';

export interface GateIoV4SignatureInput {
  readonly secretKey: string;
  readonly timestamp: string;
  readonly method: string;
  readonly requestUrl: string;
  readonly canonicalQuery: string;
  readonly body: string;
}

export interface GateIoV4Signature {
  readonly timestamp: string;
  readonly signatureString: string;
  readonly signature: string;
}

function fail(code: string): never {
  throw new GateIoReadContractError(code);
}

export function gateIoV4SignatureString(input: Omit<GateIoV4SignatureInput, 'secretKey'>): string {
  if (typeof input !== 'object' || input === null) fail('GATEIO_READ_SIGNATURE_INPUT_INVALID');
  const { timestamp, method, requestUrl, canonicalQuery, body } = input;
  if (method !== GATEIO_V4_L0_SIGNED_METHOD) fail('GATEIO_READ_METHOD_NOT_SIGNED');
  if (typeof requestUrl !== 'string' || !requestUrl.startsWith(`${GATEIO_API_PREFIX}/`)
      || requestUrl.includes('?') || requestUrl.includes('://')) {
    fail('GATEIO_READ_PATH_INVALID');
  }
  if (typeof canonicalQuery !== 'string') fail('GATEIO_READ_QUERY_INVALID');
  if (body !== '') fail('GATEIO_READ_BODY_INVALID');
  if (!gateIoTimestampValid(timestamp)) fail('GATEIO_READ_TIMESTAMP_INVALID');
  return [method, requestUrl, canonicalQuery, GATEIO_EMPTY_BODY_SHA512, timestamp].join('\n');
}

export function signGateIoV4Request(input: GateIoV4SignatureInput): GateIoV4Signature {
  if (typeof input !== 'object' || input === null) fail('GATEIO_READ_SIGNATURE_INPUT_INVALID');
  if (typeof input.secretKey !== 'string' || input.secretKey.length === 0) {
    fail('GATEIO_READ_SECRET_MISSING');
  }
  const signatureString = gateIoV4SignatureString(input);
  const signature = createHmac('sha512', input.secretKey)
    .update(signatureString, 'utf8')
    .digest('hex');
  return Object.freeze({ timestamp: input.timestamp, signatureString, signature });
}
