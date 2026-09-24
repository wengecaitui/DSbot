/**
 * Gate.io G2 execution-client binding.
 *
 * Every capability is explicit and injected: environment, credential, timestamp strategy,
 * canonical L1A instrument facts, and the fetch-shaped wire port. Construction performs no I/O.
 */
import type {
  GateIoFuturesExecutionClient as GateIoFuturesExecutionClientPort,
  GateIoFuturesMarketOrderRequest,
  GateIoFuturesMarketOrderResult,
} from '../../exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import {
  GATEIO_L0_INITIAL_CONTRACT,
  GATEIO_SAFE_LABEL_PATTERN,
  gateIoTimestampValid,
  type GateIoReadCredential,
} from './GateIoReadContracts';
import type {
  GateIoAuthenticatedReadFoundation,
  GateIoCanonicalInstrumentFacts,
} from './GateIoAuthenticatedReadFoundation';
import {
  MAX_GATEIO_CREDENTIAL_CHARACTERS,
  MAX_GATEIO_RESPONSE_BYTES,
  type GateIoReadResponse,
} from './GateIoReadTransport';
import { signGateIoV4ExecutionRequest } from './GateIoV4Signer';

export type GateIoEnvironment = 'testnet' | 'live';

export const GATEIO_EXECUTION_ORIGINS: Readonly<Record<GateIoEnvironment, string>> = Object.freeze({
  testnet: 'https://api-testnet.gateapi.io',
  live: 'https://api.gateio.ws',
});

export const GATEIO_EXECUTION_ORDER_PATH = '/api/v4/futures/usdt/orders' as const;
export const GATEIO_EXECUTION_POST_RETRY_COUNT = 0 as const;

export type GateIoFuturesExecutionFetch = (
  input: string,
  init: RequestInit,
) => Promise<GateIoReadResponse>;

export interface GateIoFuturesExecutionClientOptions {
  readonly environment: GateIoEnvironment;
  readonly credential: GateIoReadCredential;
  /** Must derive a fresh Unix-seconds timestamp from an injected clock/server-time strategy. */
  readonly signedTimestamp: () => string;
  /** Required injection: this client never falls back to an ambient fetch implementation. */
  readonly fetchImpl: GateIoFuturesExecutionFetch;
  /** Existing L1A canonical truth authority; G2 does not normalize a second instrument model. */
  readonly readFoundation: Pick<GateIoAuthenticatedReadFoundation, 'instrumentFacts'>;
}

export type GateIoFuturesExecutionClientErrorCode =
  | 'GATEIO_EXECUTION_CONFIGURATION_INVALID'
  | 'GATEIO_EXECUTION_REQUEST_INVALID'
  | 'GATEIO_EXECUTION_SUBMISSION_UNKNOWN';

/** Safe code only: no request, response, raw body, headers, credential, signature, or cause. */
export class GateIoFuturesExecutionClientError extends Error {
  constructor(readonly code: GateIoFuturesExecutionClientErrorCode) {
    super(code);
    this.name = 'GateIoFuturesExecutionClientError';
  }
}

interface WireResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly parsed: unknown;
  /** Transient and function-local. Used only for exact int64 recovery. */
  readonly rawText: string;
}

const CLIENT_TEXT = /^t-dsb-[a-f0-9]{22}$/;
const EXACT_POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const STRICT_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function fail(code: GateIoFuturesExecutionClientErrorCode): never {
  throw new GateIoFuturesExecutionClientError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCredential(value: unknown): value is GateIoReadCredential {
  if (!isRecord(value)) return false;
  return ['apiKey', 'secretKey'].every((field) => {
    const candidate = value[field];
    return typeof candidate === 'string' && candidate.length > 0
      && candidate.length <= MAX_GATEIO_CREDENTIAL_CHARACTERS;
  });
}

function requestValid(value: unknown): value is GateIoFuturesMarketOrderRequest {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  const expected = ['contract', 'price', 'reduceOnly', 'size', 'text', 'tif'];
  if (keys.some(key => typeof key !== 'string')
      || (keys as string[]).sort().join(',') !== expected.join(',')) return false;
  return value.contract === GATEIO_L0_INITIAL_CONTRACT
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size !== 0
    && value.price === '0'
    && value.tif === 'ioc'
    && typeof value.reduceOnly === 'boolean'
    && typeof value.text === 'string' && CLIENT_TEXT.test(value.text);
}

function strictNumber(value: unknown): number | null {
  const token = typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : '';
  if (!STRICT_NUMBER.test(token)) return null;
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed : null;
}

function strictInteger(value: unknown): number | null {
  const parsed = strictNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function safeLabel(value: unknown): string | null {
  return typeof value === 'string' && GATEIO_SAFE_LABEL_PATTERN.test(value) ? value : null;
}

function safeGateLabel(parsed: unknown): string | null {
  return isRecord(parsed) ? safeLabel(parsed.label) : null;
}

function exactOrderId(parsedValue: unknown, rawText: string): string | null {
  if (typeof parsedValue === 'string' && EXACT_POSITIVE_INTEGER.test(parsedValue)) {
    return parsedValue;
  }
  if (typeof parsedValue === 'number' && Number.isSafeInteger(parsedValue) && parsedValue > 0) {
    return String(parsedValue);
  }
  if (typeof parsedValue !== 'number' || Number.isSafeInteger(parsedValue)) return null;
  const match = /"id"\s*:\s*([1-9][0-9]*)(?=\s*[,}])/.exec(rawText);
  return match?.[1] && EXACT_POSITIVE_INTEGER.test(match[1]) ? match[1] : null;
}

function normalizedOrder(
  parsed: unknown,
  rawText: string,
  request: GateIoFuturesMarketOrderRequest,
): GateIoFuturesMarketOrderResult | null {
  if (!isRecord(parsed)
      || parsed.contract !== request.contract
      || parsed.text !== request.text) return null;
  const size = strictInteger(parsed.size);
  const left = strictInteger(parsed.left);
  if (size === null || left === null || size !== request.size
      || Math.abs(left) > Math.abs(size)
      || (left !== 0 && Math.sign(left) !== Math.sign(size))) return null;
  const exchangeOrderId = exactOrderId(parsed.id, rawText);
  if (exchangeOrderId === null) return null;

  const signedFilledSize = size - left;
  if (!Number.isSafeInteger(signedFilledSize)
      || (signedFilledSize !== 0 && Math.sign(signedFilledSize) !== Math.sign(size))) return null;
  const wireStatus = typeof parsed.status === 'string' ? parsed.status : null;
  const finishAs = typeof parsed.finish_as === 'string' ? parsed.finish_as : null;
  let status: GateIoFuturesMarketOrderResult['status'];
  if (wireStatus === 'open') {
    status = signedFilledSize === 0 ? 'OPEN' : 'PARTIALLY_FILLED';
  } else if (wireStatus === 'finished') {
    if (Math.abs(signedFilledSize) === Math.abs(size) && left === 0 && finishAs === 'filled') {
      status = 'FINISHED';
    } else if (signedFilledSize !== 0) {
      status = 'PARTIALLY_FILLED';
    } else if (finishAs !== null && finishAs.length > 0) {
      status = 'REJECTED';
    } else {
      return null;
    }
  } else {
    return null;
  }

  const averagePrice = signedFilledSize === 0 ? null : strictNumber(parsed.fill_price);
  if (signedFilledSize !== 0 && (averagePrice === null || averagePrice <= 0)) return null;
  const executionTimeCandidate = parsed.finish_time ?? parsed.update_time ?? parsed.create_time;
  const executedAt = signedFilledSize === 0 ? null : strictNumber(executionTimeCandidate);
  if (signedFilledSize !== 0 && (executedAt === null || executedAt <= 0)) return null;
  const rejectionReason = status === 'REJECTED'
    ? safeLabel(finishAs?.toUpperCase()) ?? 'GATEIO_EXECUTION_REJECTED'
    : undefined;

  return Object.freeze({
    status,
    clientText: request.text,
    contract: request.contract,
    signedFilledSize,
    averagePrice,
    executedAt,
    // Gate's order object is the factual aggregate execution identity for a fully filled IOC order.
    tradeId: signedFilledSize === 0 ? null : exchangeOrderId,
    exchangeOrderId,
    ...(rejectionReason === undefined ? {} : { rejectionReason }),
  });
}

function rejectedResult(
  request: GateIoFuturesMarketOrderRequest,
  reason: string,
): GateIoFuturesMarketOrderResult {
  return Object.freeze({
    status: 'REJECTED' as const,
    clientText: request.text,
    contract: request.contract,
    signedFilledSize: 0,
    averagePrice: null,
    executedAt: null,
    tradeId: null,
    exchangeOrderId: null,
    rejectionReason: reason,
  });
}

function instrumentFactsUsable(value: GateIoCanonicalInstrumentFacts | null): boolean {
  return value !== null
    && value.contract === GATEIO_L0_INITIAL_CONTRACT
    && value.freshness === 'FRESH'
    && value.contractOpenable === true
    && value.inDelisting === false;
}

export function createGateIoFuturesExecutionClient(
  options: GateIoFuturesExecutionClientOptions,
): GateIoFuturesExecutionClientPort {
  if (!isRecord(options)
      || (options.environment !== 'testnet' && options.environment !== 'live')
      || !validCredential(options.credential)
      || typeof options.signedTimestamp !== 'function'
      || typeof options.fetchImpl !== 'function'
      || !isRecord(options.readFoundation)
      || typeof options.readFoundation.instrumentFacts !== 'function') {
    fail('GATEIO_EXECUTION_CONFIGURATION_INVALID');
  }
  const origin = GATEIO_EXECUTION_ORIGINS[options.environment];
  const credential = options.credential;

  async function wire(
    method: 'GET' | 'POST',
    path: string,
    body: string,
  ): Promise<WireResponse | null> {
    let timestamp: string;
    try {
      timestamp = options.signedTimestamp();
    } catch {
      fail('GATEIO_EXECUTION_REQUEST_INVALID');
    }
    if (!gateIoTimestampValid(timestamp)) fail('GATEIO_EXECUTION_REQUEST_INVALID');
    const { signature } = signGateIoV4ExecutionRequest({
      secretKey: credential.secretKey,
      timestamp,
      method,
      requestUrl: path,
      body,
    });
    let response: GateIoReadResponse;
    try {
      response = await options.fetchImpl(origin + path, Object.freeze({
        method,
        headers: Object.freeze({
          Accept: 'application/json',
          'Content-Type': 'application/json',
          KEY: credential.apiKey,
          Timestamp: timestamp,
          SIGN: signature,
        }),
        ...(method === 'POST' ? { body } : {}),
        redirect: 'error',
      }));
    } catch {
      return null;
    }
    if (!response || typeof response.text !== 'function'
        || !Number.isSafeInteger(response.status)
        || response.status < 100 || response.status > 599) return null;
    let rawText: string;
    try {
      rawText = await response.text();
    } catch {
      return null;
    }
    if (typeof rawText !== 'string'
        || Buffer.byteLength(rawText, 'utf8') > MAX_GATEIO_RESPONSE_BYTES) return null;
    let parsed: unknown = null;
    try {
      parsed = rawText.length === 0 ? null : JSON.parse(rawText);
    } catch {
      parsed = null;
    }
    return { ok: response.ok, status: response.status, parsed, rawText };
  }

  async function reconcile(
    request: GateIoFuturesMarketOrderRequest,
  ): Promise<GateIoFuturesMarketOrderResult> {
    const path = GATEIO_EXECUTION_ORDER_PATH + '/' + request.text;
    const response = await wire('GET', path, '');
    if (response === null || !response.ok || response.parsed === null) {
      fail('GATEIO_EXECUTION_SUBMISSION_UNKNOWN');
    }
    const normalized = normalizedOrder(response.parsed, response.rawText, request);
    if (normalized === null) fail('GATEIO_EXECUTION_SUBMISSION_UNKNOWN');
    return normalized;
  }

  return Object.freeze({
    async getInstrumentFacts(symbol: string): Promise<GateIoCanonicalInstrumentFacts | null> {
      if (symbol !== 'ETH/USDT') return null;
      try {
        const result = await options.readFoundation.instrumentFacts();
        if (result.availability !== 'AVAILABLE' || !instrumentFactsUsable(result.value)) return null;
        return result.value;
      } catch {
        return null;
      }
    },

    async submitMarketOrder(
      request: GateIoFuturesMarketOrderRequest,
    ): Promise<GateIoFuturesMarketOrderResult> {
      if (!requestValid(request)) fail('GATEIO_EXECUTION_REQUEST_INVALID');
      const body = JSON.stringify({
        contract: request.contract,
        size: request.size,
        price: request.price,
        tif: request.tif,
        reduce_only: request.reduceOnly,
        text: request.text,
      });
      const response = await wire('POST', GATEIO_EXECUTION_ORDER_PATH, body);
      if (response === null) return reconcile(request);
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          return rejectedResult(
            request,
            safeGateLabel(response.parsed) ?? 'GATEIO_EXECUTION_HTTP_REJECTED',
          );
        }
        return reconcile(request);
      }
      if (safeGateLabel(response.parsed) !== null
          && (!isRecord(response.parsed) || response.parsed.contract === undefined)) {
        return rejectedResult(request, safeGateLabel(response.parsed) ?? 'GATEIO_EXECUTION_REJECTED');
      }
      const normalized = normalizedOrder(response.parsed, response.rawText, request);
      return normalized ?? reconcile(request);
    },
  });
}
