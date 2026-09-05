import { isDeepStrictEqual } from 'node:util';
import {
  assertRawResearchRecord,
  type RawResearchRecord,
} from '../ResearchProviderAdapterContract';
import {
  type CanonicalPointInTimeDataset,
  type CanonicalPointInTimeField,
  type CanonicalPointInTimeRecord,
} from '../pit/CanonicalPointInTimeDataset';
import { assertPlainInertData } from '../dictionary/ResearchDictionaryValidation';
import {
  AVAILABILITY_REQUIREMENTS,
  EVENT_TIME_REQUIREMENTS,
  HISTORICAL_DECISION_POLICIES,
  RESEARCH_USES,
  SEMANTIC_ROLES,
  assertCanonicalLogicalType,
  assertCanonicalUnit,
} from '../dictionary/CanonicalFieldDictionaryContract';
import { decodeInertPayload, encodeInertPayload, type InertPayloadNode } from './InertPayloadCodec';

export const RESEARCH_STORAGE_INTERCHANGE_VERSION = 'DSBOT_RESEARCH_STORAGE_INTERCHANGE_V1' as const;
export const RESEARCH_STORAGE_SCHEMA_VERSION = 'DSBOT_RESEARCH_STORAGE_BUNDLE_V1' as const;

export type StoredRawResearchRecord = Omit<RawResearchRecord, 'payload'> & {
  readonly payload: InertPayloadNode;
};

export interface ResearchStorageInterchange {
  readonly storageInterchangeVersion: typeof RESEARCH_STORAGE_INTERCHANGE_VERSION;
  readonly productionAuthority: false;
  readonly rawRecords: readonly StoredRawResearchRecord[];
  readonly canonicalDataset: CanonicalPointInTimeDataset;
}

function storageViolation(reason: string): never {
  throw new Error(`PHASE_9D_RESEARCH_STORAGE_INVALID:${reason}`);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  reason = 'FIELDS',
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    storageViolation(reason);
  }
}

function assertSourceRevision(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) storageViolation('SOURCE_REVISION');
  const revision = value as Record<string, unknown>;
  exactKeys(revision, ['revisionId'], ['observedAt'], 'SOURCE_REVISION_FIELDS');
  if (typeof revision.revisionId !== 'string') storageViolation('SOURCE_REVISION_ID');
  if (Object.hasOwn(revision, 'observedAt') && !isCanonicalTimestamp(revision.observedAt)) {
    storageViolation('SOURCE_REVISION_OBSERVED_AT');
  }
}

function assertCanonicalValue(value: unknown, logicalType: unknown): void {
  const logicalName = typeof logicalType === 'string' ? logicalType : 'DECIMAL';
  if (logicalName === 'BOOLEAN' && typeof value === 'boolean') return;
  if (logicalName === 'INT64' && Number.isSafeInteger(value)) return;
  if (logicalName === 'FLOAT64' && typeof value === 'number' && Number.isFinite(value)) return;
  if (logicalName === 'STRING' && typeof value === 'string') return;
  if (logicalName === 'DATE' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value) return;
  }
  if (logicalName === 'TIMESTAMP_UTC' && isCanonicalTimestamp(value)) return;
  if (logicalName === 'DECIMAL' && typeof value === 'string' && /^-?(0|[1-9]\d*)\.\d+$/.test(value)) {
    const decimal = logicalType as { precision: number; scale: number };
    const unsigned = value.startsWith('-') ? value.slice(1) : value;
    const [integer, fraction] = unsigned.split('.');
    if (fraction.length === decimal.scale && `${integer}${fraction}`.length <= decimal.precision) return;
  }
  storageViolation('CANONICAL_VALUE_REPRESENTATION');
}

function assertTimeEvidence(value: unknown, name: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) storageViolation(`${name}_OBJECT`);
  const evidence = value as Record<string, unknown>;
  if (evidence.state === 'KNOWN') {
    exactKeys(evidence, ['state', 'value', 'source'], [], `${name}_FIELDS`);
    if (!isCanonicalTimestamp(evidence.value) || !['RECORD_ENVELOPE', 'SOURCE_PAYLOAD_PATH'].includes(String(evidence.source))) {
      storageViolation(`${name}_KNOWN`);
    }
    return;
  }
  if (evidence.state === 'DOCUMENTED_RULE_UNMATERIALIZED') {
    exactKeys(evidence, ['state', 'rule'], [], `${name}_FIELDS`);
    if (typeof evidence.rule !== 'string' || evidence.rule.length === 0) storageViolation(`${name}_RULE`);
    return;
  }
  if (evidence.state === 'UNKNOWN' || evidence.state === 'NOT_APPLICABLE') {
    exactKeys(evidence, ['state'], [], `${name}_FIELDS`);
    return;
  }
  storageViolation(`${name}_STATE`);
}

function assertField(field: unknown, recordIndex: number, fieldIndex: number): asserts field is CanonicalPointInTimeField {
  if (field === null || typeof field !== 'object' || Array.isArray(field)) storageViolation('FIELD_OBJECT');
  const value = field as Record<string, unknown>;
  exactKeys(value, [
    'fieldId', 'logicalType', 'unit', 'semanticRole', 'eventTimeRequirement',
    'availabilityRequirement', 'historicalDecisionPolicy', 'researchUsePolicy',
    'presence', 'eventTimeEvidence', 'availabilityEvidence',
  ], [], 'FIELD_FIELDS');
  if (typeof value.fieldId !== 'string' || value.fieldId.length === 0) storageViolation('FIELD_ID');
  assertCanonicalLogicalType(value.logicalType, 'STORED_LOGICAL_TYPE');
  assertCanonicalUnit(value.unit, 'STORED_UNIT');
  if (!SEMANTIC_ROLES.includes(value.semanticRole as (typeof SEMANTIC_ROLES)[number])) storageViolation('SEMANTIC_ROLE');
  if (!EVENT_TIME_REQUIREMENTS.includes(value.eventTimeRequirement as (typeof EVENT_TIME_REQUIREMENTS)[number])) storageViolation('EVENT_TIME_REQUIREMENT');
  if (!AVAILABILITY_REQUIREMENTS.includes(value.availabilityRequirement as (typeof AVAILABILITY_REQUIREMENTS)[number])) storageViolation('AVAILABILITY_REQUIREMENT');
  if (!HISTORICAL_DECISION_POLICIES.includes(value.historicalDecisionPolicy as (typeof HISTORICAL_DECISION_POLICIES)[number])) {
    storageViolation('HISTORICAL_DECISION_POLICY');
  }
  if (value.researchUsePolicy === null || typeof value.researchUsePolicy !== 'object' || Array.isArray(value.researchUsePolicy)) {
    storageViolation('RESEARCH_USE_POLICY');
  }
  const researchUsePolicy = value.researchUsePolicy as Record<string, unknown>;
  exactKeys(researchUsePolicy, RESEARCH_USES, [], 'RESEARCH_USE_POLICY_FIELDS');
  for (const use of RESEARCH_USES) {
    if (researchUsePolicy[use] !== 'ALLOW' && researchUsePolicy[use] !== 'DENY') storageViolation('RESEARCH_USE_POLICY_VALUE');
  }
  const presence = value.presence as Record<string, unknown>;
  if (presence === null || typeof presence !== 'object') storageViolation('PRESENCE');
  if (!['MISSING', 'NULL', 'VALUE'].includes(String(presence.state))) storageViolation('PRESENCE_STATE');
  if (presence.state === 'VALUE') {
    exactKeys(presence, ['state', 'value'], [], 'PRESENCE_FIELDS');
    assertCanonicalValue(presence.value, value.logicalType);
  } else {
    exactKeys(presence, ['state'], [], 'PRESENCE_FIELDS');
  }
  assertTimeEvidence(value.eventTimeEvidence, 'EVENT_TIME_EVIDENCE');
  assertTimeEvidence(value.availabilityEvidence, 'AVAILABILITY_EVIDENCE');
  if (recordIndex < 0 || fieldIndex < 0) storageViolation('ORDER');
}

function assertRecord(record: unknown, index: number): asserts record is CanonicalPointInTimeRecord {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) storageViolation('RECORD_OBJECT');
  const value = record as Record<string, unknown>;
  exactKeys(value, [
    'sourceRecordId', 'adapterVersion', 'eventTime', 'availableAt', 'availableAtAuthority',
    'ingestedAt', 'payloadHash', 'manifestVersion', 'manifestReference', 'requestId',
    'sourceProvenanceRef', 'fields',
  ], ['sourceRevision'], 'RECORD_FIELDS');
  for (const key of ['sourceRecordId', 'adapterVersion', 'payloadHash', 'manifestVersion', 'manifestReference', 'requestId', 'sourceProvenanceRef']) {
    if (typeof value[key] !== 'string') storageViolation(`RECORD_${key}`);
  }
  for (const key of ['eventTime', 'ingestedAt'] as const) {
    if (!isCanonicalTimestamp(value[key])) storageViolation(`RECORD_${key}`);
  }
  if (value.availableAt !== null && !isCanonicalTimestamp(value.availableAt)) storageViolation('RECORD_AVAILABLE_AT');
  if (Object.hasOwn(value, 'sourceRevision')) assertSourceRevision(value.sourceRevision);
  if (!Array.isArray(value.fields)) storageViolation('RECORD_FIELDS');
  const ids = new Set<string>();
  value.fields.forEach((field, fieldIndex) => {
    assertField(field, index, fieldIndex);
    if (ids.has(field.fieldId)) storageViolation('DUPLICATE_FIELD_ID');
    ids.add(field.fieldId);
  });
}

export function assertResearchStorageInterchange(value: unknown): asserts value is ResearchStorageInterchange {
  assertPlainInertData(value, 'RESEARCH_STORAGE_INTERCHANGE');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) storageViolation('ROOT');
  const root = value as Record<string, unknown>;
  exactKeys(root, ['storageInterchangeVersion', 'productionAuthority', 'rawRecords', 'canonicalDataset'], [], 'ROOT_FIELDS');
  if (root.storageInterchangeVersion !== RESEARCH_STORAGE_INTERCHANGE_VERSION) storageViolation('INTERCHANGE_VERSION');
  if (root.productionAuthority !== false) storageViolation('PRODUCTION_AUTHORITY');
  if (!Array.isArray(root.rawRecords)) storageViolation('RAW_RECORDS');
  if (root.canonicalDataset === null || typeof root.canonicalDataset !== 'object') storageViolation('CANONICAL_DATASET');
  const dataset = root.canonicalDataset as Record<string, unknown>;
  exactKeys(dataset, [
    'schemaVersion', 'dictionaryId', 'dictionaryVersion', 'bindingId', 'bindingVersion',
    'providerId', 'adapterId', 'sourceDatasetRef', 'records', 'productionAuthority',
  ], [], 'CANONICAL_DATASET_FIELDS');
  if (dataset.schemaVersion !== '1.0.0' || dataset.productionAuthority !== false || !Array.isArray(dataset.records)) {
    storageViolation('CANONICAL_DATASET_HEADER');
  }
  const canonicalRecords = dataset.records as unknown[];
  for (const key of ['dictionaryId', 'dictionaryVersion', 'bindingId', 'bindingVersion', 'providerId', 'adapterId', 'sourceDatasetRef']) {
    if (typeof dataset[key] !== 'string') storageViolation(`CANONICAL_DATASET_${key}`);
  }
  if (root.rawRecords.length !== canonicalRecords.length) storageViolation('RECORD_COUNT_MISMATCH');
  const sourceIds = new Set<string>();
  root.rawRecords.forEach((stored, index) => {
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) storageViolation('RAW_RECORD');
    const raw = stored as Record<string, unknown>;
    exactKeys(raw, [
      'providerId', 'adapterId', 'adapterVersion', 'sourceDatasetRef', 'sourceRecordId',
      'eventTime', 'availableAt', 'availableAtAuthority', 'ingestedAt', 'payload', 'payloadHash',
      'manifestVersion', 'manifestReference', 'requestId', 'sourceProvenanceRef',
    ], ['sourceRevision'], 'RAW_RECORD_FIELDS');
    const payload = decodeInertPayload(raw.payload);
    const decoded = { ...raw, payload };
    assertRawResearchRecord(decoded);
    const canonical = canonicalRecords[index];
    assertRecord(canonical, index);
    if (decoded.sourceRecordId !== canonical.sourceRecordId) storageViolation('RECORD_ORDER_MISMATCH');
    if (
      decoded.providerId !== dataset.providerId || decoded.adapterId !== dataset.adapterId
      || decoded.sourceDatasetRef !== dataset.sourceDatasetRef
      || decoded.adapterVersion !== canonical.adapterVersion || decoded.eventTime !== canonical.eventTime
      || decoded.availableAt !== canonical.availableAt || decoded.availableAtAuthority !== canonical.availableAtAuthority
      || decoded.ingestedAt !== canonical.ingestedAt || decoded.payloadHash !== canonical.payloadHash
      || decoded.manifestVersion !== canonical.manifestVersion || decoded.manifestReference !== canonical.manifestReference
      || decoded.requestId !== canonical.requestId || decoded.sourceProvenanceRef !== canonical.sourceProvenanceRef
      || !isDeepStrictEqual(decoded.sourceRevision, canonical.sourceRevision)
    ) storageViolation('RAW_CANONICAL_PROVENANCE_MISMATCH');
    if (sourceIds.has(decoded.sourceRecordId)) storageViolation('DUPLICATE_SOURCE_RECORD_ID');
    sourceIds.add(decoded.sourceRecordId);
  });
}

export function createResearchStorageInterchange(
  rawRecords: readonly RawResearchRecord[],
  canonicalDataset: CanonicalPointInTimeDataset,
): ResearchStorageInterchange {
  assertPlainInertData(rawRecords, 'RAW_RECORDS');
  assertPlainInertData(canonicalDataset, 'CANONICAL_DATASET');
  const rawSnapshot = structuredClone(rawRecords);
  const datasetSnapshot = structuredClone(canonicalDataset);
  rawSnapshot.forEach(assertRawResearchRecord);
  const stored = rawSnapshot.map((record): StoredRawResearchRecord => ({
    ...record,
    payload: encodeInertPayload(record.payload),
  }));
  const interchange = {
    storageInterchangeVersion: RESEARCH_STORAGE_INTERCHANGE_VERSION,
    productionAuthority: false,
    rawRecords: stored,
    canonicalDataset: datasetSnapshot,
  } as const;
  assertResearchStorageInterchange(interchange);
  return deepFreeze(interchange);
}

export function restoreCanonicalPointInTimeDataset(value: unknown): CanonicalPointInTimeDataset {
  assertResearchStorageInterchange(value);
  const snapshot = structuredClone(value.canonicalDataset);
  assertResearchStorageInterchange({
    storageInterchangeVersion: RESEARCH_STORAGE_INTERCHANGE_VERSION,
    productionAuthority: false,
    rawRecords: value.rawRecords,
    canonicalDataset: snapshot,
  });
  return deepFreeze(snapshot);
}

export function restoreRawResearchRecords(value: unknown): readonly RawResearchRecord[] {
  assertResearchStorageInterchange(value);
  const records = value.rawRecords.map((record) => {
    const { payload, ...envelope } = record;
    return { ...envelope, payload: decodeInertPayload(payload) };
  });
  records.forEach(assertRawResearchRecord);
  return deepFreeze(records);
}

export function researchStorageInterchangesEqual(left: unknown, right: unknown): boolean {
  assertResearchStorageInterchange(left);
  assertResearchStorageInterchange(right);
  return isDeepStrictEqual(left, right);
}

export const PHASE_9D_RESEARCH_STORAGE_BOUNDARY = Object.freeze({
  storageSchemaVersion: RESEARCH_STORAGE_SCHEMA_VERSION,
  durableAuthority: 'IMMUTABLE_PARQUET_BUNDLE',
  duckdbRole: 'READ_ONLY_DERIVED_VIEW',
  polarsRole: 'READ_ONLY_DERIVED_VIEW',
  staticPointInTimeEligibility: false,
  lineageRegistryImplemented: false,
  researchDataHubImplemented: false,
  networkRuntimeAdded: false,
  mutableDatabaseAuthorityAdded: false,
  productionAuthority: false,
} as const);
