/**
 * Pure Gate API v4 GET signer. All inputs are explicit; this module performs no I/O and discovers
 * no credential or clock state.
 */
import { createHash, createHmac } from 'node:crypto';
import {
  GATEIO_API_PREFIX,
  GateIoReadContractError,
  gateIoTimestampValid,
} from './GateIoReadContracts';

export const GATEIO_V4_SIGNATURE_ALGORITHM = 'HMAC-SHA512' as const;
export const GATEIO_V4_SIGNATURE_ENCODING = 'hex' as const;
export const GATEIO_V4_L0_SIGNED_METHOD = 'GET' as const;
export const GATEIO_V4_EXECUTION_SIGNED_METHODS = Object.freeze(['GET', 'POST'] as const);
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

export interface GateIoV4ExecutionSignatureInput {
  readonly secretKey: string;
  readonly timestamp: string;
  readonly method: 'GET' | 'POST';
  readonly requestUrl: string;
  readonly body: string;
}

function fail(code: string): never {
  throw new GateIoReadContractError(code);
}

function validateCommon(input: {
  readonly timestamp: string;
  readonly requestUrl: string;
}): void {
  if (typeof input.requestUrl !== 'string' || !input.requestUrl.startsWith(`${GATEIO_API_PREFIX}/`)
      || input.requestUrl.includes('?') || input.requestUrl.includes('://')) {
    fail('GATEIO_READ_PATH_INVALID');
  }
  if (!gateIoTimestampValid(input.timestamp)) fail('GATEIO_READ_TIMESTAMP_INVALID');
}

function hmacSignature(secretKey: string, signatureString: string): string {
  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    fail('GATEIO_READ_SECRET_MISSING');
  }
  return createHmac('sha512', secretKey)
    .update(signatureString, 'utf8')
    .digest('hex');
}

export function gateIoV4SignatureString(input: Omit<GateIoV4SignatureInput, 'secretKey'>): string {
  if (typeof input !== 'object' || input === null) fail('GATEIO_READ_SIGNATURE_INPUT_INVALID');
  const { timestamp, method, requestUrl, canonicalQuery, body } = input;
  if (method !== GATEIO_V4_L0_SIGNED_METHOD) fail('GATEIO_READ_METHOD_NOT_SIGNED');
  validateCommon({ timestamp, requestUrl });
  if (typeof canonicalQuery !== 'string') fail('GATEIO_READ_QUERY_INVALID');
  if (body !== '') fail('GATEIO_READ_BODY_INVALID');
  return [method, requestUrl, canonicalQuery, GATEIO_EMPTY_BODY_SHA512, timestamp].join('\n');
}

export function signGateIoV4Request(input: GateIoV4SignatureInput): GateIoV4Signature {
  if (typeof input !== 'object' || input === null) fail('GATEIO_READ_SIGNATURE_INPUT_INVALID');
  const signatureString = gateIoV4SignatureString(input);
  const signature = hmacSignature(input.secretKey, signatureString);
  return Object.freeze({ timestamp: input.timestamp, signatureString, signature });
}

/**
 * Closed execution signer used by G2. It shares the same HMAC implementation as the L0 GET signer,
 * but hashes the explicitly supplied POST body and never accepts a query string.
 */
export function gateIoV4ExecutionSignatureString(
  input: Omit<GateIoV4ExecutionSignatureInput, 'secretKey'>,
): string {
  if (typeof input !== 'object' || input === null) fail('GATEIO_READ_SIGNATURE_INPUT_INVALID');
  const { timestamp, method, requestUrl, body } = input;
  validateCommon({ timestamp, requestUrl });
  if (!(GATEIO_V4_EXECUTION_SIGNED_METHODS as readonly string[]).includes(method)) {
    fail('GATEIO_READ_METHOD_NOT_SIGNED');
  }
  if (typeof body !== 'string' || (method === 'GET' && body !== '')) {
    fail('GATEIO_READ_BODY_INVALID');
  }
  const bodyHash = createHash('sha512').update(body, 'utf8').digest('hex');
  return [method, requestUrl, '', bodyHash, timestamp].join('\n');
}

export function signGateIoV4ExecutionRequest(
  input: GateIoV4ExecutionSignatureInput,
): GateIoV4Signature {
  if (typeof input !== 'object' || input === null) fail('GATEIO_READ_SIGNATURE_INPUT_INVALID');
  const signatureString = gateIoV4ExecutionSignatureString(input);
  const signature = hmacSignature(input.secretKey, signatureString);
  return Object.freeze({ timestamp: input.timestamp, signatureString, signature });
}
