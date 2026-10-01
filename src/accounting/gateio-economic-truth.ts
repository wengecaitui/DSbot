import { createHash } from 'node:crypto';
import {
  normalizeGateIoAccountBookPageRequest,
  type GateIoAccountBookPageRequest,
} from '../runtime/gateio/GateIoReadContracts';
import {
  GATEIO_ACCOUNT_BOOK_ENDPOINT,
  GATEIO_ACCOUNT_BOOK_SOURCE,
  GATEIO_ECONOMIC_TRUTH_SCHEMA_VERSION,
  type GateIoAccountBookCaptureInput,
  type GateIoCanonicalEconomicEvent,
  type GateIoEconomicCategory,
  type GateIoEconomicEventCapture,
} from './gateio-economic-truth-types';

const EXACT_DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;

const DOCUMENTED_CATEGORIES: Readonly<Record<string, GateIoEconomicCategory>> = Object.freeze({
  dnw: 'TRANSFER',
  pnl: 'POSITION_PNL',
  fee: 'TRADING_FEE',
  refr: 'REFERRAL_REBATE',
  fund: 'FUNDING',
  point_dnw: 'POINT_TRANSFER',
  point_fee: 'POINT_FEE',
  point_refr: 'POINT_REBATE',
  bonus_offset: 'BONUS_OFFSET',
});

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(code);
  return value;
}

function optionalText(raw: Record<string, unknown>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
  const value = raw[key];
  if (typeof value !== 'string') fail('GATEIO_ACCOUNT_BOOK_ROW_MALFORMED');
  return value;
}

function exactDecimal(value: unknown): string {
  if (typeof value !== 'string' || !EXACT_DECIMAL.test(value)) {
    fail('GATEIO_ACCOUNT_BOOK_DECIMAL_MALFORMED');
  }
  return value;
}

function occurredAt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('GATEIO_ACCOUNT_BOOK_TIME_MALFORMED');
  }
  return value;
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('GATEIO_ACCOUNT_BOOK_PAYLOAD_MALFORMED');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail('GATEIO_ACCOUNT_BOOK_PAYLOAD_MALFORMED');
      sorted[key] = canonicalJsonValue(value[key]);
    }
    return sorted;
  }
  fail('GATEIO_ACCOUNT_BOOK_PAYLOAD_MALFORMED');
}

function payloadDigest(rawPage: readonly unknown[]): string {
  const encoded = JSON.stringify(canonicalJsonValue(rawPage));
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

function normalizedPageRequest(
  request: GateIoAccountBookPageRequest,
): Readonly<GateIoAccountBookPageRequest> {
  return normalizeGateIoAccountBookPageRequest(request);
}

function captureForPage(
  input: GateIoAccountBookCaptureInput,
  rawPage: readonly unknown[],
): GateIoEconomicEventCapture {
  if (typeof input !== 'object' || input === null
      || typeof input.observedAt !== 'number' || !Number.isFinite(input.observedAt)
      || input.observedAt <= 0) {
    fail('GATEIO_ACCOUNT_BOOK_CAPTURE_MALFORMED');
  }
  return Object.freeze({
    endpoint: GATEIO_ACCOUNT_BOOK_ENDPOINT,
    observedAt: input.observedAt,
    pageRequest: normalizedPageRequest(input.pageRequest),
    rawPayloadDigest: payloadDigest(rawPage),
  });
}

function normalizeRow(
  raw: unknown,
  capture: GateIoEconomicEventCapture,
): GateIoCanonicalEconomicEvent {
  if (!isRecord(raw)) fail('GATEIO_ACCOUNT_BOOK_ROW_MALFORMED');
  const rawType = requiredText(raw.type, 'GATEIO_ACCOUNT_BOOK_TYPE_MALFORMED');
  const contract = optionalText(raw, 'contract');
  const tradeId = optionalText(raw, 'trade_id');
  const text = optionalText(raw, 'text');
  const event: GateIoCanonicalEconomicEvent = {
    schemaVersion: GATEIO_ECONOMIC_TRUTH_SCHEMA_VERSION,
    exchange: 'gateio',
    settle: 'usdt',
    source: GATEIO_ACCOUNT_BOOK_SOURCE,
    sourceId: requiredText(raw.id, 'GATEIO_ACCOUNT_BOOK_ID_MALFORMED'),
    occurredAt: occurredAt(raw.time),
    category: DOCUMENTED_CATEGORIES[rawType] ?? 'UNCLASSIFIED',
    rawType,
    change: exactDecimal(raw.change),
    balance: exactDecimal(raw.balance),
    ...(contract === undefined ? {} : { contract }),
    ...(tradeId === undefined ? {} : { tradeId }),
    ...(text === undefined ? {} : { text }),
    capture,
  };
  return Object.freeze(event);
}

function validateRowBeforeDigest(raw: unknown): void {
  if (!isRecord(raw)) fail('GATEIO_ACCOUNT_BOOK_ROW_MALFORMED');
  requiredText(raw.id, 'GATEIO_ACCOUNT_BOOK_ID_MALFORMED');
  occurredAt(raw.time);
  exactDecimal(raw.change);
  exactDecimal(raw.balance);
  requiredText(raw.type, 'GATEIO_ACCOUNT_BOOK_TYPE_MALFORMED');
  optionalText(raw, 'contract');
  optionalText(raw, 'trade_id');
  optionalText(raw, 'text');
}

/** Normalize exactly one response page. An empty page remains only an empty page. */
export function normalizeGateIoAccountBookPage(
  raw: unknown,
  input: GateIoAccountBookCaptureInput,
): readonly GateIoCanonicalEconomicEvent[] {
  if (!Array.isArray(raw)) fail('GATEIO_ACCOUNT_BOOK_PAGE_MALFORMED');
  for (const row of raw) validateRowBeforeDigest(row);
  const capture = captureForPage(input, raw);
  return Object.freeze(raw.map((row) => normalizeRow(row, capture)));
}
