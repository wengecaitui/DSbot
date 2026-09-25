/**
 * Gate.io G2 execution-client binding.
 *
 * Every capability is explicit and injected: environment, credential, timestamp strategy,
 * canonical L1A instrument facts, and the fetch-shaped wire port. Construction performs no I/O.
 */
import {
  GATEIO_ETH_DECIMAL_CONTRACT_SCALE,
  gateIoEthContractSizeValid,
  type GateIoFuturesExecutionClient as GateIoFuturesExecutionClientPort,
  type GateIoFuturesMarketOrderRequest,
  type GateIoFuturesMarketOrderResult,
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
import { GateIoG3BudgetDenial, GateIoG3RunBudget, type GateIoG3DenialReason } from './GateIoG3RunBudget';
import { parseGateIoExactInt64Json } from './GateIoExactInt64Recovery';

export type GateIoEnvironment = 'testnet' | 'live';

export const GATEIO_EXECUTION_ORIGINS: Readonly<Record<GateIoEnvironment, string>> = Object.freeze({
  testnet: 'https://api-testnet.gateapi.io',
  live: 'https://api.gateio.ws',
});

export const GATEIO_EXECUTION_ORDER_PATH = '/api/v4/futures/usdt/orders' as const;
export const GATEIO_EXECUTION_POST_RETRY_COUNT = 0 as const;
export const GATEIO_G3_PROOF_MUTATION_HARD_CAP = 2 as const;
export const GATEIO_G3_EMERGENCY_CLEANUP_RESERVE = 1 as const;
export const GATEIO_G3_TOTAL_MUTATION_HARD_CAP = 3 as const;

export type GateIoMutationPurpose = 'PROOF' | 'EMERGENCY_CLEANUP';

/** Explicitly shared across clients in one G3 run; it owns no trading state. */
export class GateIoG3MutationBudget {
  private proofMutations = 0;
  private cleanupMutations = 0;

  private constructor() {}

  static create(): GateIoG3MutationBudget { return new GateIoG3MutationBudget(); }

  consume(purpose: GateIoMutationPurpose, reduceOnly: boolean): void {
    if ((purpose !== 'PROOF' && purpose !== 'EMERGENCY_CLEANUP')
        || this.proofMutations + this.cleanupMutations >= GATEIO_G3_TOTAL_MUTATION_HARD_CAP
        || (purpose === 'PROOF' && this.proofMutations >= GATEIO_G3_PROOF_MUTATION_HARD_CAP)
        || (purpose === 'EMERGENCY_CLEANUP'
          && (!reduceOnly || this.cleanupMutations >= GATEIO_G3_EMERGENCY_CLEANUP_RESERVE))) {
      fail('GATEIO_EXECUTION_MUTATION_CAP_EXCEEDED');
    }
    if (purpose === 'PROOF') this.proofMutations += 1;
    else this.cleanupMutations += 1;
  }

  snapshot(): Readonly<{ proof: number; cleanup: number; total: number }> {
    return Object.freeze({
      proof: this.proofMutations,
      cleanup: this.cleanupMutations,
      total: this.proofMutations + this.cleanupMutations,
    });
  }
}

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
  /** Mandatory for TestNet G3; optional for separately governed Live wiring. */
  readonly mutationBudget?: GateIoG3MutationBudget;
  /** G3 verification owns read, mutation and total-request limits in one run object. */
  readonly runBudget?: GateIoG3RunBudget;
}

export type GateIoFuturesExecutionClientErrorCode =
  | 'GATEIO_EXECUTION_CONFIGURATION_INVALID'
  | 'GATEIO_EXECUTION_REQUEST_INVALID'
  | 'GATEIO_EXECUTION_MUTATION_CAP_EXCEEDED'
  | 'GATEIO_EXECUTION_SUBMISSION_UNKNOWN';

/** Safe code only: no request, response, raw body, headers, credential, signature, or cause. */
export class GateIoFuturesExecutionClientError extends Error {
  readonly decision: 'DENIED' | null;
  readonly reasonCode: string;

  constructor(readonly code: GateIoFuturesExecutionClientErrorCode,
    budgetReason: GateIoG3DenialReason | null = null) {
    super(code);
    this.name = 'GateIoFuturesExecutionClientError';
    this.decision = code === 'GATEIO_EXECUTION_SUBMISSION_UNKNOWN' ? null : 'DENIED';
    this.reasonCode = budgetReason ?? (code === 'GATEIO_EXECUTION_MUTATION_CAP_EXCEEDED'
      ? 'MUTATION_CAP_EXCEEDED' : code);
  }
}

interface WireResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly parsed: unknown;
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
    && gateIoEthContractSizeValid(value.size)
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

function strictContractSize(value: unknown): number | null {
  const parsed = strictNumber(value);
  if (parsed === 0) return 0;
  return parsed !== null && gateIoEthContractSizeValid(parsed)
    ? Math.round(parsed * GATEIO_ETH_DECIMAL_CONTRACT_SCALE)
      / GATEIO_ETH_DECIMAL_CONTRACT_SCALE
    : null;
}

function contractUnits(value: number): number {
  return Math.round(value * GATEIO_ETH_DECIMAL_CONTRACT_SCALE);
}

function safeLabel(value: unknown): string | null {
  return typeof value === 'string' && GATEIO_SAFE_LABEL_PATTERN.test(value) ? value : null;
}

function safeGateLabel(parsed: unknown): string | null {
  return isRecord(parsed) ? safeLabel(parsed.label) : null;
}

function normalizedOrder(
  parsed: unknown,
  request: GateIoFuturesMarketOrderRequest,
): GateIoFuturesMarketOrderResult | null {
  if (!isRecord(parsed)
      || parsed.contract !== request.contract
      || parsed.text !== request.text) return null;
  const size = strictContractSize(parsed.size);
  const left = strictContractSize(parsed.left);
  if (size === null || left === null) return null;
  const exchangeOrderId = typeof parsed.id === 'string' && EXACT_POSITIVE_INTEGER.test(parsed.id)
    ? parsed.id : null;
  if (exchangeOrderId === null) return null;

  const wireStatus = typeof parsed.status === 'string' ? parsed.status : null;
  const finishAs = typeof parsed.finish_as === 'string' ? parsed.finish_as : null;
  const sizeUnits = contractUnits(size);
  const leftUnits = contractUnits(left);
  const requestUnits = contractUnits(request.size);
  // F-09: Gate can return size=0,left=0 for a decimal full fill. Exact attribution plus
  // status=finished and finish_as=filled is the factual full-fill witness for the original request.
  const decimalFullFillWitness = wireStatus === 'finished' && finishAs === 'filled'
    && sizeUnits === 0 && leftUnits === 0;
  if (!decimalFullFillWitness && sizeUnits !== requestUnits) return null;
  if (Math.abs(leftUnits) > Math.abs(sizeUnits)
      || (leftUnits !== 0 && Math.sign(leftUnits) !== Math.sign(sizeUnits))) return null;
  const signedFilledUnits = decimalFullFillWitness ? requestUnits : sizeUnits - leftUnits;
  if (signedFilledUnits !== 0 && Math.sign(signedFilledUnits) !== Math.sign(requestUnits)) return null;
  const signedFilledSize = signedFilledUnits / GATEIO_ETH_DECIMAL_CONTRACT_SCALE;
  let status: GateIoFuturesMarketOrderResult['status'];
  if (wireStatus === 'open') {
    status = signedFilledSize === 0 ? 'OPEN' : 'PARTIALLY_FILLED';
  } else if (wireStatus === 'finished') {
    if (decimalFullFillWitness
        || (Math.abs(signedFilledUnits) === Math.abs(sizeUnits)
          && leftUnits === 0 && finishAs === 'filled')) {
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
      || typeof options.readFoundation.instrumentFacts !== 'function'
      || (options.environment === 'testnet'
        && !(options.mutationBudget instanceof GateIoG3MutationBudget)
        && !(options.runBudget instanceof GateIoG3RunBudget))
      || (options.mutationBudget !== undefined
        && !(options.mutationBudget instanceof GateIoG3MutationBudget))
      || (options.runBudget !== undefined
        && !(options.runBudget instanceof GateIoG3RunBudget))) {
    fail('GATEIO_EXECUTION_CONFIGURATION_INVALID');
  }
  const origin = GATEIO_EXECUTION_ORIGINS[options.environment];
  const credential = options.credential;

  async function wire(
    method: 'GET' | 'POST',
    path: string,
    body: string,
    mutation: { readonly purpose: GateIoMutationPurpose; readonly reduceOnly: boolean } | null = null,
  ): Promise<WireResponse | null> {
    if ((method === 'POST' && (path !== GATEIO_EXECUTION_ORDER_PATH || mutation === null))
        || (method === 'GET' && (mutation !== null
          || !new RegExp(`^${GATEIO_EXECUTION_ORDER_PATH}/t-dsb-[a-f0-9]{22}$`).test(path)))) {
      fail('GATEIO_EXECUTION_REQUEST_INVALID');
    }
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
    if (mutation !== null) {
      if (options.runBudget) options.runBudget.consumeMutationRequest(mutation.purpose, mutation.reduceOnly);
      else options.mutationBudget?.consume(mutation.purpose, mutation.reduceOnly);
    } else options.runBudget?.consumeReadRequest();
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
      parsed = rawText.length === 0 ? null
        : parseGateIoExactInt64Json(rawText, { shape: 'object', fields: ['id'], required: false });
    } catch {
      parsed = null;
    }
    return { ok: response.ok, status: response.status, parsed };
  }

  async function reconcile(
    request: GateIoFuturesMarketOrderRequest,
  ): Promise<GateIoFuturesMarketOrderResult> {
    try {
      options.runBudget?.beginAmbiguousReconciliation();
      const path = GATEIO_EXECUTION_ORDER_PATH + '/' + request.text;
      const response = await wire('GET', path, '');
      if (response === null || !response.ok || response.parsed === null) {
        fail('GATEIO_EXECUTION_SUBMISSION_UNKNOWN');
      }
      const normalized = normalizedOrder(response.parsed, request);
      if (normalized === null) fail('GATEIO_EXECUTION_SUBMISSION_UNKNOWN');
      return normalized;
    } catch (error) {
      if (error instanceof GateIoG3BudgetDenial) {
        throw new GateIoFuturesExecutionClientError('GATEIO_EXECUTION_SUBMISSION_UNKNOWN', error.reasonCode);
      }
      throw error;
    }
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
      purpose: GateIoMutationPurpose = 'PROOF',
    ): Promise<GateIoFuturesMarketOrderResult> {
      if (!requestValid(request)
          || (purpose !== 'PROOF' && purpose !== 'EMERGENCY_CLEANUP')) {
        fail('GATEIO_EXECUTION_REQUEST_INVALID');
      }
      const body = JSON.stringify({
        contract: request.contract,
        size: request.size,
        price: request.price,
        tif: request.tif,
        reduce_only: request.reduceOnly,
        text: request.text,
      });
      const response = await wire('POST', GATEIO_EXECUTION_ORDER_PATH, body, {
        purpose, reduceOnly: request.reduceOnly,
      });
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
      const normalized = normalizedOrder(response.parsed, request);
      return normalized ?? reconcile(request);
    },
  });
}
