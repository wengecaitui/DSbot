import {
  gateIoEconomicFactDigest,
  gateIoEconomicIdentity,
  validateGateIoCanonicalEconomicEvent,
} from './gateio-economic-ledger';
import type {
  GateIoEconomicCaptureRecord,
  GateIoEconomicIdentityConflict,
  GateIoEconomicLedgerFactRecord,
  GateIoEconomicLedgerState,
} from './gateio-economic-ledger-types';
import {
  GATEIO_ACCOUNT_BOOK_ENDPOINT,
  GATEIO_ACCOUNT_BOOK_SOURCE,
  type GateIoCanonicalEconomicEvent,
  type GateIoEconomicCategory,
} from './gateio-economic-truth-types';
import {
  GATEIO_ECONOMIC_PROJECTION_SCHEMA_VERSION,
  GATEIO_TRACKED_EXECUTION_EVIDENCE_SCHEMA_VERSION,
  type GateIoBalanceObservationStatus,
  type GateIoCategoryChangeTotals,
  type GateIoCategoryCounts,
  type GateIoEconomicProjection,
  type GateIoObservedActivityClassification,
  type GateIoObservedActivityCounts,
  type GateIoObservedEconomicActivity,
  type GateIoProjectedEconomicFact,
  type GateIoProjectionCompletenessStatus,
  type GateIoTrackedExecutionAttribution,
  type TrackedExecutionEconomicEvidence,
} from './gateio-economic-projection-types';

const SHA256 = /^[0-9a-f]{64}$/;

const CATEGORIES: readonly GateIoEconomicCategory[] = Object.freeze([
  'TRANSFER',
  'POSITION_PNL',
  'TRADING_FEE',
  'REFERRAL_REBATE',
  'FUNDING',
  'POINT_TRANSFER',
  'POINT_FEE',
  'POINT_REBATE',
  'BONUS_OFFSET',
  'UNCLASSIFIED',
]);

const CLASSIFICATIONS: readonly GateIoObservedActivityClassification[] = Object.freeze([
  'TRACKED_TRADE_LINKED',
  'UNTRACKED_TRADE_LINKED',
  'NON_TRADE_ACCOUNT_ACTIVITY',
  'UNLINKED_TRADE_ECONOMIC_ACTIVITY',
  'UNCLASSIFIED_ACTIVITY',
  'IDENTITY_CONFLICT',
]);

const TRADE_CORRELATION_CATEGORIES = new Set<GateIoEconomicCategory>([
  'POSITION_PNL',
  'TRADING_FEE',
  'POINT_FEE',
  'BONUS_OFFSET',
]);

export type GateIoEconomicProjectionErrorCode =
  | 'GATEIO_ECONOMIC_PROJECTION_STATE_INVALID'
  | 'GATEIO_ECONOMIC_PROJECTION_EVIDENCE_INVALID';

export class GateIoEconomicProjectionError extends Error {
  constructor(readonly code: GateIoEconomicProjectionErrorCode) {
    super(code);
    this.name = 'GateIoEconomicProjectionError';
  }
}

function fail(code: GateIoEconomicProjectionErrorCode): never {
  throw new GateIoEconomicProjectionError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  code: GateIoEconomicProjectionErrorCode,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
      || Object.keys(value).some((key) => !allowed.has(key))) {
    fail(code);
  }
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
      sorted[key] = canonicalValue(value[key]);
    }
    return sorted;
  }
  fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function cloneFreeze<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    Object.freeze(entry);
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
  };
  freeze(clone);
  return clone;
}

function validateCaptureRecord(
  value: unknown,
  fact: GateIoCanonicalEconomicEvent,
  expectedDigest: string,
): asserts value is GateIoEconomicCaptureRecord {
  if (!isRecord(value)) fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  exactKeys(
    value,
    ['kernelEventId', 'kernelLogicalSequence', 'kernelTimestamp', 'factDigest', 'capture'],
    [],
    'GATEIO_ECONOMIC_PROJECTION_STATE_INVALID',
  );
  if (typeof value.kernelEventId !== 'string' || !SHA256.test(value.kernelEventId)
      || typeof value.kernelLogicalSequence !== 'number'
      || !Number.isSafeInteger(value.kernelLogicalSequence) || value.kernelLogicalSequence <= 0
      || typeof value.kernelTimestamp !== 'number' || !Number.isFinite(value.kernelTimestamp)
      || value.kernelTimestamp <= 0 || value.factDigest !== expectedDigest) {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
  try {
    validateGateIoCanonicalEconomicEvent({ ...fact, capture: value.capture });
  } catch {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
}

function validateFactRecord(value: unknown): asserts value is GateIoEconomicLedgerFactRecord {
  if (!isRecord(value)) fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  exactKeys(
    value,
    ['identity', 'factDigest', 'fact', 'captures'],
    [],
    'GATEIO_ECONOMIC_PROJECTION_STATE_INVALID',
  );
  try {
    validateGateIoCanonicalEconomicEvent(value.fact);
  } catch {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
  const fact = value.fact as GateIoCanonicalEconomicEvent;
  if (typeof value.identity !== 'string' || value.identity !== gateIoEconomicIdentity(fact)
      || typeof value.factDigest !== 'string' || value.factDigest !== gateIoEconomicFactDigest(fact)
      || !Array.isArray(value.captures) || value.captures.length === 0) {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
  for (const capture of value.captures) validateCaptureRecord(capture, fact, value.factDigest);
  if (!value.captures.some((capture) =>
    canonicalJSON((capture as GateIoEconomicCaptureRecord).capture) === canonicalJSON(fact.capture))) {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
}

function validateConflict(
  value: unknown,
  factsByIdentity: ReadonlyMap<string, GateIoEconomicLedgerFactRecord>,
): asserts value is GateIoEconomicIdentityConflict {
  if (!isRecord(value)) fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  exactKeys(
    value,
    ['identity', 'acceptedDigest', 'conflictingDigest', 'conflictingFact', 'capture'],
    [],
    'GATEIO_ECONOMIC_PROJECTION_STATE_INVALID',
  );
  try {
    validateGateIoCanonicalEconomicEvent(value.conflictingFact);
  } catch {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
  const conflictingFact = value.conflictingFact as GateIoCanonicalEconomicEvent;
  const accepted = typeof value.identity === 'string' ? factsByIdentity.get(value.identity) : undefined;
  if (!accepted || value.acceptedDigest !== accepted.factDigest
      || value.identity !== gateIoEconomicIdentity(conflictingFact)
      || typeof value.conflictingDigest !== 'string'
      || value.conflictingDigest !== gateIoEconomicFactDigest(conflictingFact)
      || value.conflictingDigest === value.acceptedDigest) {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
  validateCaptureRecord(value.capture, conflictingFact, value.conflictingDigest);
  if (canonicalJSON((value.capture as GateIoEconomicCaptureRecord).capture)
      !== canonicalJSON(conflictingFact.capture)) {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
}

export function validateGateIoEconomicLedgerState(
  value: unknown,
): asserts value is GateIoEconomicLedgerState {
  if (!isRecord(value)) fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  exactKeys(
    value,
    ['schemaVersion', 'uniqueIdentityCount', 'facts', 'conflicts', 'hasIdentityConflict',
      'captureBoundary'],
    [],
    'GATEIO_ECONOMIC_PROJECTION_STATE_INVALID',
  );
  if (value.schemaVersion !== 'gateio-economic-ledger-v1'
      || typeof value.uniqueIdentityCount !== 'number'
      || !Number.isSafeInteger(value.uniqueIdentityCount) || value.uniqueIdentityCount < 0
      || !Array.isArray(value.facts) || !Array.isArray(value.conflicts)
      || typeof value.hasIdentityConflict !== 'boolean') {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
  const factsByIdentity = new Map<string, GateIoEconomicLedgerFactRecord>();
  const eventIds = new Set<string>();
  const sequences = new Map<number, string>();
  for (const candidate of value.facts) {
    validateFactRecord(candidate);
    if (factsByIdentity.has(candidate.identity)) fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
    factsByIdentity.set(candidate.identity, candidate);
    for (const capture of candidate.captures) {
      if (eventIds.has(capture.kernelEventId) || sequences.has(capture.kernelLogicalSequence)) {
        fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
      }
      eventIds.add(capture.kernelEventId);
      sequences.set(capture.kernelLogicalSequence, capture.kernelEventId);
    }
  }
  if (value.uniqueIdentityCount !== factsByIdentity.size) {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
  for (const candidate of value.conflicts) {
    validateConflict(candidate, factsByIdentity);
    if (eventIds.has(candidate.capture.kernelEventId)
        || sequences.has(candidate.capture.kernelLogicalSequence)) {
      fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
    }
    eventIds.add(candidate.capture.kernelEventId);
    sequences.set(candidate.capture.kernelLogicalSequence, candidate.capture.kernelEventId);
  }
  if (value.hasIdentityConflict !== (value.conflicts.length > 0)) {
    fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  }
  let maxSequence: number | null = null;
  for (const sequence of sequences.keys()) {
    if (maxSequence === null || sequence > maxSequence) maxSequence = sequence;
  }
  if (maxSequence === null) {
    if (value.captureBoundary !== null) fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
  } else {
    if (!isRecord(value.captureBoundary)) fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
    exactKeys(
      value.captureBoundary,
      ['kind', 'lastKernelLogicalSequence', 'lastKernelEventId'],
      [],
      'GATEIO_ECONOMIC_PROJECTION_STATE_INVALID',
    );
    if (value.captureBoundary.kind !== 'LOCAL_JOURNAL_SEQUENCE_ONLY'
        || value.captureBoundary.lastKernelLogicalSequence !== maxSequence
        || value.captureBoundary.lastKernelEventId !== sequences.get(maxSequence)) {
      fail('GATEIO_ECONOMIC_PROJECTION_STATE_INVALID');
    }
  }
}

function validateEvidence(
  value: unknown,
): asserts value is TrackedExecutionEconomicEvidence {
  if (!isRecord(value)) fail('GATEIO_ECONOMIC_PROJECTION_EVIDENCE_INVALID');
  exactKeys(
    value,
    ['schemaVersion', 'trackedTradeIds', 'evidenceCapturedAt', 'provenance'],
    ['captureScope'],
    'GATEIO_ECONOMIC_PROJECTION_EVIDENCE_INVALID',
  );
  if (value.schemaVersion !== GATEIO_TRACKED_EXECUTION_EVIDENCE_SCHEMA_VERSION
      || !Array.isArray(value.trackedTradeIds)
      || typeof value.evidenceCapturedAt !== 'number'
      || !Number.isFinite(value.evidenceCapturedAt) || value.evidenceCapturedAt <= 0
      || !isRecord(value.provenance)) {
    fail('GATEIO_ECONOMIC_PROJECTION_EVIDENCE_INVALID');
  }
  exactKeys(
    value.provenance,
    ['source'],
    [],
    'GATEIO_ECONOMIC_PROJECTION_EVIDENCE_INVALID',
  );
  if (typeof value.provenance.source !== 'string' || value.provenance.source.trim().length === 0
      || (value.captureScope !== undefined
        && value.captureScope !== 'SUFFICIENT_FOR_TRACKED_TRADES'
        && value.captureScope !== 'NOT_PROVEN')) {
    fail('GATEIO_ECONOMIC_PROJECTION_EVIDENCE_INVALID');
  }
  const seen = new Set<string>();
  for (const tradeId of value.trackedTradeIds) {
    if (typeof tradeId !== 'string' || tradeId.trim().length === 0 || seen.has(tradeId)) {
      fail('GATEIO_ECONOMIC_PROJECTION_EVIDENCE_INVALID');
    }
    seen.add(tradeId);
  }
}

interface ExactDecimalParts {
  coefficient: bigint;
  scale: number;
}

function decimalParts(value: string): ExactDecimalParts {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${whole}${fraction}` || '0') * (negative ? -1n : 1n);
  return { coefficient, scale: fraction.length };
}

function formatDecimal(coefficient: bigint, scale: number): string {
  if (coefficient === 0n) return '0';
  const sign = coefficient < 0n ? '-' : '';
  const absolute = (coefficient < 0n ? -coefficient : coefficient).toString();
  if (scale === 0) return `${sign}${absolute}`;
  const padded = absolute.padStart(scale + 1, '0');
  const integer = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, '');
  return fraction.length === 0 ? `${sign}${integer}` : `${sign}${integer}.${fraction}`;
}

function sumExactDecimals(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const parsed = values.map(decimalParts);
  let scale = 0;
  for (const entry of parsed) {
    if (entry.scale > scale) scale = entry.scale;
  }
  const coefficient = parsed.reduce((total, entry) =>
    total + entry.coefficient * (10n ** BigInt(scale - entry.scale)), 0n);
  return formatDecimal(coefficient, scale);
}

function emptyCategoryCounts(): Record<GateIoEconomicCategory, number> {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as
    Record<GateIoEconomicCategory, number>;
}

function emptyActivityCounts(): Record<GateIoObservedActivityClassification, number> {
  return Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification, 0])) as
    Record<GateIoObservedActivityClassification, number>;
}

function hasUsableTradeId(fact: GateIoCanonicalEconomicEvent): fact is
  GateIoCanonicalEconomicEvent & { readonly tradeId: string } {
  return typeof fact.tradeId === 'string' && fact.tradeId.length > 0;
}

function classifyFact(
  fact: GateIoCanonicalEconomicEvent,
  trackedTradeIds: ReadonlySet<string>,
): GateIoObservedActivityClassification {
  if (fact.category === 'UNCLASSIFIED') return 'UNCLASSIFIED_ACTIVITY';
  if (hasUsableTradeId(fact)) {
    return trackedTradeIds.has(fact.tradeId)
      ? 'TRACKED_TRADE_LINKED'
      : 'UNTRACKED_TRADE_LINKED';
  }
  return TRADE_CORRELATION_CATEGORIES.has(fact.category)
    ? 'UNLINKED_TRADE_ECONOMIC_ACTIVITY'
    : 'NON_TRADE_ACCOUNT_ACTIVITY';
}

function attribution(
  evidence: TrackedExecutionEconomicEvidence | undefined,
  trustedFacts: readonly GateIoEconomicLedgerFactRecord[],
  conflicts: readonly GateIoEconomicIdentityConflict[],
): GateIoTrackedExecutionAttribution {
  if (evidence === undefined) {
    return {
      status: 'UNAVAILABLE',
      expectedTrackedTradeIds: [],
      matchedTrackedTradeIds: [],
      missingTrackedTradeIds: [],
      reasons: ['TRACKED_EXECUTION_EVIDENCE_NOT_PROVIDED', 'CAPTURE_SCOPE_NOT_PROVEN'],
      evidenceCapturedAt: null,
      evidenceSource: null,
      captureScope: 'UNAVAILABLE',
    };
  }
  const expected = [...evidence.trackedTradeIds].sort();
  const expectedSet = new Set(expected);
  const matchedSet = new Set<string>();
  const unclassifiedTrackedIds = new Set<string>();
  for (const record of trustedFacts) {
    if (!hasUsableTradeId(record.fact) || !expectedSet.has(record.fact.tradeId)) continue;
    if (record.fact.category === 'UNCLASSIFIED') unclassifiedTrackedIds.add(record.fact.tradeId);
    else matchedSet.add(record.fact.tradeId);
  }
  const matched = [...matchedSet].sort();
  const missing = expected.filter((tradeId) => !matchedSet.has(tradeId));
  const captureScope = evidence.captureScope ?? 'NOT_PROVEN';
  const reasons: string[] = [];
  let status: GateIoTrackedExecutionAttribution['status'];
  if (captureScope !== 'SUFFICIENT_FOR_TRACKED_TRADES') {
    status = 'UNAVAILABLE';
    reasons.push('CAPTURE_SCOPE_NOT_PROVEN');
  } else if (expected.length === 0) {
    status = 'UNAVAILABLE';
    reasons.push('TRACKED_TRADE_SET_EMPTY');
  } else {
    if (missing.length > 0) reasons.push('EXPECTED_TRACKED_TRADE_MISSING');
    if (conflicts.length > 0) reasons.push('IDENTITY_CONFLICT_PRESENT');
    if (unclassifiedTrackedIds.size > 0) reasons.push('TRACKED_UNCLASSIFIED_AMBIGUITY');
    status = reasons.length === 0 ? 'COMPLETE' : 'INCOMPLETE';
  }
  return {
    status,
    expectedTrackedTradeIds: expected,
    matchedTrackedTradeIds: matched,
    missingTrackedTradeIds: missing,
    reasons,
    evidenceCapturedAt: evidence.evidenceCapturedAt,
    evidenceSource: evidence.provenance.source,
    captureScope,
  };
}

export function projectGateIoEconomicState(
  state: GateIoEconomicLedgerState,
  evidence?: TrackedExecutionEconomicEvidence,
): GateIoEconomicProjection {
  validateGateIoEconomicLedgerState(state);
  if (evidence !== undefined) validateEvidence(evidence);

  const conflictedIdentities = new Set(state.conflicts.map((entry) => entry.identity));
  const trustedFacts = state.facts.filter((entry) => !conflictedIdentities.has(entry.identity));
  const categoryCounts = emptyCategoryCounts();
  const changes = Object.fromEntries(CATEGORIES.map((category) => [category, [] as string[]])) as unknown as
    Record<GateIoEconomicCategory, string[]>;
  for (const record of trustedFacts) {
    categoryCounts[record.fact.category] += 1;
    changes[record.fact.category].push(record.fact.change);
  }
  const categoryChangeTotals = Object.fromEntries(CATEGORIES.map((category) =>
    [category, sumExactDecimals(changes[category])])) as GateIoCategoryChangeTotals;

  const documentedCategoryFacts: GateIoProjectedEconomicFact[] = trustedFacts
    .filter((entry) => entry.fact.category !== 'UNCLASSIFIED')
    .map((entry) => ({ identity: entry.identity, factDigest: entry.factDigest, fact: entry.fact }))
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const unclassifiedFacts: GateIoProjectedEconomicFact[] = trustedFacts
    .filter((entry) => entry.fact.category === 'UNCLASSIFIED')
    .map((entry) => ({ identity: entry.identity, factDigest: entry.factDigest, fact: entry.fact }))
    .sort((left, right) => left.identity.localeCompare(right.identity));

  const allObservedFacts = [
    ...state.facts.map((entry) => entry.fact),
    ...state.conflicts.map((entry) => entry.conflictingFact),
  ];
  let observedFrom: number | null = null;
  let observedTo: number | null = null;
  for (const fact of allObservedFacts) {
    if (observedFrom === null || fact.occurredAt < observedFrom) observedFrom = fact.occurredAt;
    if (observedTo === null || fact.occurredAt > observedTo) observedTo = fact.occurredAt;
  }
  const unclassifiedEventCount = allObservedFacts
    .filter((fact) => fact.category === 'UNCLASSIFIED').length;

  let balanceStatus: GateIoBalanceObservationStatus;
  let terminalObservedBalance: string | null = null;
  if (state.conflicts.length > 0) {
    balanceStatus = 'IDENTITY_CONFLICT';
  } else if (state.facts.length === 0) {
    balanceStatus = 'UNAVAILABLE';
  } else {
    let maximum = state.facts[0]!.fact.occurredAt;
    for (const entry of state.facts) {
      if (entry.fact.occurredAt > maximum) maximum = entry.fact.occurredAt;
    }
    const candidates = state.facts.filter((entry) => entry.fact.occurredAt === maximum);
    if (candidates.length === 1) {
      balanceStatus = 'TERMINAL_OBSERVED';
      terminalObservedBalance = candidates[0]!.fact.balance;
    } else {
      balanceStatus = 'AMBIGUOUS_TERMINAL_ORDER';
    }
  }

  let completenessStatus: GateIoProjectionCompletenessStatus = 'OBSERVED_ONLY';
  const completenessReasons = ['COMPLETE_ACCOUNT_HISTORY_UNPROVEN'];
  if (state.conflicts.length > 0) {
    completenessStatus = 'CONFLICTED';
    completenessReasons.push('IDENTITY_CONFLICT_PRESENT');
  } else if (unclassifiedEventCount > 0) {
    completenessStatus = 'UNCLASSIFIED_PRESENT';
    completenessReasons.push('UNCLASSIFIED_ACTIVITY_PRESENT');
  }
  if (state.facts.length === 0) completenessReasons.push('NO_DURABLE_ECONOMIC_FACTS');

  const trackedTradeIds = new Set(evidence?.trackedTradeIds ?? []);
  const observedActivities: GateIoObservedEconomicActivity[] = state.facts
    .map((entry): GateIoObservedEconomicActivity => {
      if (conflictedIdentities.has(entry.identity)) {
        return {
          identity: entry.identity,
          classification: 'IDENTITY_CONFLICT',
          category: null,
          tradeId: null,
          factDigest: null,
        };
      }
      return {
        identity: entry.identity,
        classification: classifyFact(entry.fact, trackedTradeIds),
        category: entry.fact.category,
        tradeId: hasUsableTradeId(entry.fact) ? entry.fact.tradeId : null,
        factDigest: entry.factDigest,
      };
    })
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const observedActivityCounts = emptyActivityCounts();
  for (const activity of observedActivities) observedActivityCounts[activity.classification] += 1;
  const untrackedObservedActivityCount =
    observedActivityCounts.UNTRACKED_TRADE_LINKED;
  const notExplainedByTrackedEvidenceCount =
    observedActivityCounts.UNTRACKED_TRADE_LINKED
    + observedActivityCounts.UNLINKED_TRADE_ECONOMIC_ACTIVITY
    + observedActivityCounts.UNCLASSIFIED_ACTIVITY
    + observedActivityCounts.IDENTITY_CONFLICT;

  const captures = [
    ...state.facts.flatMap((entry) => entry.captures),
    ...state.conflicts.map((entry) => entry.capture),
  ];
  const projection: GateIoEconomicProjection = {
    schemaVersion: GATEIO_ECONOMIC_PROJECTION_SCHEMA_VERSION,
    economicEventCount: state.facts.length,
    trustedEconomicEventCount: trustedFacts.length,
    identityConflictCount: state.conflicts.length,
    conflictedIdentityCount: conflictedIdentities.size,
    unclassifiedEventCount,
    observedFrom,
    observedTo,
    categoryCounts,
    categoryChangeTotals,
    documentedCategoryFacts,
    unclassifiedFacts,
    identityConflicts: state.conflicts,
    terminalObservedBalance,
    balanceStatus,
    completenessStatus,
    completenessReasons,
    projectionUsableForObservedAccounting:
      completenessStatus === 'OBSERVED_ONLY' && state.facts.length > 0,
    provenance: {
      exchange: 'gateio',
      settle: 'usdt',
      source: GATEIO_ACCOUNT_BOOK_SOURCE,
      endpoint: GATEIO_ACCOUNT_BOOK_ENDPOINT,
      ledgerSchemaVersion: state.schemaVersion,
      localCaptureBoundary: state.captureBoundary,
      observedCaptureCount: captures.length,
      distinctRawPayloadDigests: [...new Set(captures.map((entry) =>
        entry.capture.rawPayloadDigest))].sort(),
      historyScope: 'OBSERVED_PAGES_ONLY',
      authoritativeExchangeCursor: false,
      completeAccountHistory: false,
    },
    observedActivities,
    observedActivityCounts,
    untrackedObservedActivityCount,
    notExplainedByTrackedEvidenceCount,
    trackedExecutionAttribution: attribution(evidence, trustedFacts, state.conflicts),
    accountActivityReconciled: 'UNAVAILABLE',
    accountActivityReconciliationReasons: [
      'ACCOUNT_BOOK_HISTORICAL_COMPLETENESS_UNPROVEN',
      'PAGINATION_STABILITY_UNPROVEN',
      'PRE_BOOTSTRAP_HISTORY_UNPROVEN',
      'ACCOUNT_WIDE_COMPLETENESS_UNPROVEN',
    ],
  };
  return cloneFreeze(projection);
}
