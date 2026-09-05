import {
  assertProviderManifest,
  assertProviderManifestSnapshotStructure,
  type ProviderManifest,
} from '../ProviderManifestContract';
import {
  assertRawResearchRecord,
  type RawResearchRecord,
  type SourceRevisionMetadata,
} from '../ResearchProviderAdapterContract';
import {
  type AvailabilityRequirement,
  type CanonicalFieldDefinition,
  type CanonicalLogicalType,
  type CanonicalUnit,
  type EventTimeRequirement,
  type HistoricalDecisionPolicy,
  type ResearchUsePolicy,
  assertCanonicalFieldDictionary,
  type CanonicalFieldDictionary,
} from '../dictionary/CanonicalFieldDictionaryContract';
import {
  assertBindingSetMatchesDictionary,
  assertBindingSetMatchesManifest,
  assertProviderSourceBindingSet,
  type ProviderSourceBindingSet,
  type ProviderSourceFieldBinding,
  type SourcePath,
  type SourceTimeBinding,
} from '../dictionary/ProviderSourceBindingContract';
import { assertPlainInertData } from '../dictionary/ResearchDictionaryValidation';

export type CanonicalFieldPresence =
  | { readonly state: 'MISSING' }
  | { readonly state: 'NULL' }
  | { readonly state: 'VALUE'; readonly value: boolean | number | string };

export type CanonicalTimeEvidence =
  | { readonly state: 'KNOWN'; readonly value: string; readonly source: 'RECORD_ENVELOPE' | 'SOURCE_PAYLOAD_PATH' }
  | { readonly state: 'DOCUMENTED_RULE_UNMATERIALIZED'; readonly rule: string }
  | { readonly state: 'UNKNOWN' }
  | { readonly state: 'NOT_APPLICABLE' };

export interface CanonicalPointInTimeField {
  readonly fieldId: string;
  readonly logicalType: CanonicalLogicalType;
  readonly unit: CanonicalUnit;
  readonly semanticRole: CanonicalFieldDefinition['semanticRole'];
  readonly eventTimeRequirement: EventTimeRequirement;
  readonly availabilityRequirement: AvailabilityRequirement;
  readonly historicalDecisionPolicy: HistoricalDecisionPolicy;
  readonly researchUsePolicy: ResearchUsePolicy;
  readonly presence: CanonicalFieldPresence;
  readonly eventTimeEvidence: CanonicalTimeEvidence;
  readonly availabilityEvidence: CanonicalTimeEvidence;
}

export interface CanonicalPointInTimeRecord {
  readonly sourceRecordId: string;
  readonly adapterVersion: string;
  readonly eventTime: string;
  readonly availableAt: string | null;
  readonly availableAtAuthority: RawResearchRecord['availableAtAuthority'];
  readonly ingestedAt: string;
  readonly payloadHash: string;
  readonly manifestVersion: string;
  readonly manifestReference: string;
  readonly requestId: string;
  readonly sourceProvenanceRef: string;
  readonly sourceRevision?: SourceRevisionMetadata;
  readonly fields: readonly CanonicalPointInTimeField[];
}

export interface CanonicalPointInTimeDataset {
  readonly schemaVersion: '1.0.0';
  readonly dictionaryId: string;
  readonly dictionaryVersion: string;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly providerId: string;
  readonly adapterId: string;
  readonly sourceDatasetRef: string;
  readonly records: readonly CanonicalPointInTimeRecord[];
  readonly productionAuthority: false;
}

export interface CreateCanonicalPointInTimeDatasetInput {
  readonly records: readonly RawResearchRecord[];
  readonly dictionary: CanonicalFieldDictionary;
  readonly bindingSet: ProviderSourceBindingSet;
  readonly manifest: ProviderManifest;
}

interface PathResolution {
  readonly resolved: boolean;
  readonly value?: unknown;
}

function pitViolation(reason: string): never {
  throw new Error(`PHASE_9C_CANONICAL_PIT_INVALID:${reason}`);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function strictTimestamp(value: unknown, reason: string): string {
  if (typeof value !== 'string') pitViolation(reason);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) pitViolation(reason);
  return value;
}

function strictDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function canonicalDecimal(value: unknown, precision: number, scale: number): boolean {
  if (typeof value !== 'string') return false;
  const pattern = scale === 0
    ? /^-?(?:0|[1-9]\d*)$/
    : new RegExp(`^-?(?:0|[1-9]\\d*)\\.\\d{${scale}}$`);
  if (!pattern.test(value)) return false;
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  if (value.startsWith('-') && /^0(?:\.0+)?$/.test(unsigned)) return false;
  const integerDigits = integer === '0' ? 0 : integer.length;
  return integerDigits + fraction.length <= precision;
}

function assertDirectValue(value: unknown, logicalType: CanonicalLogicalType, fieldId: string): void {
  let valid = false;
  if (logicalType === 'BOOLEAN') valid = typeof value === 'boolean';
  else if (logicalType === 'INT64') valid = Number.isSafeInteger(value);
  else if (logicalType === 'FLOAT64') valid = typeof value === 'number' && Number.isFinite(value);
  else if (logicalType === 'STRING') valid = typeof value === 'string';
  else if (logicalType === 'DATE') valid = strictDate(value);
  else if (logicalType === 'TIMESTAMP_UTC') {
    valid = typeof value === 'string'
      && Number.isFinite(Date.parse(value))
      && new Date(Date.parse(value)).toISOString() === value;
  } else {
    valid = canonicalDecimal(value, logicalType.precision, logicalType.scale);
  }
  if (!valid) pitViolation(`DIRECT_VALUE_REPRESENTATION:${fieldId}`);
}

/** Resolve without JavaScript's numeric/string property-key coercion. */
export function resolveTypedOwnSourcePath(root: unknown, path: SourcePath): PathResolution {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (typeof segment !== 'number' || !Number.isSafeInteger(segment) || segment < 0) {
        return { resolved: false };
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, String(segment));
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return { resolved: false };
      }
      current = descriptor.value;
      continue;
    }
    if (current !== null && typeof current === 'object') {
      if (typeof segment !== 'string') return { resolved: false };
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return { resolved: false };
      const descriptor = Object.getOwnPropertyDescriptor(current, segment);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return { resolved: false };
      }
      current = descriptor.value;
      continue;
    }
    return { resolved: false };
  }
  return { resolved: true, value: current };
}

function materializePresence(
  payload: unknown,
  field: CanonicalFieldDefinition,
  binding: ProviderSourceFieldBinding,
): CanonicalFieldPresence {
  const resolved = resolveTypedOwnSourcePath(payload, binding.sourcePath);
  if (!resolved.resolved) {
    if (binding.sourcePresence === 'REQUIRED') pitViolation(`REQUIRED_SOURCE_MISSING:${field.fieldId}`);
    return { state: 'MISSING' };
  }
  if (resolved.value === null) {
    if (!binding.sourceNullable || !field.nullSemantics.nullable) {
      pitViolation(`NULL_NOT_PERMITTED:${field.fieldId}`);
    }
    return { state: 'NULL' };
  }
  assertDirectValue(resolved.value, field.logicalType, field.fieldId);
  return { state: 'VALUE', value: resolved.value as boolean | number | string };
}

function fieldTimeEvidence(
  payload: unknown,
  binding: SourceTimeBinding,
  fieldId: string,
  kind: 'EVENT_TIME' | 'AVAILABLE_AT',
): CanonicalTimeEvidence {
  if (binding === 'UNKNOWN' || binding === 'RECORD_ENVELOPE') return { state: 'UNKNOWN' };
  if (binding.kind === 'DOCUMENTED_RULE') {
    return { state: 'DOCUMENTED_RULE_UNMATERIALIZED', rule: binding.rule };
  }
  const resolved = resolveTypedOwnSourcePath(payload, binding.path);
  if (!resolved.resolved) return { state: 'UNKNOWN' };
  return {
    state: 'KNOWN',
    value: strictTimestamp(resolved.value, `${kind}_REPRESENTATION:${fieldId}`),
    source: 'SOURCE_PAYLOAD_PATH',
  };
}

function eventTimeEvidence(
  record: RawResearchRecord,
  payload: unknown,
  field: CanonicalFieldDefinition,
  binding: ProviderSourceFieldBinding,
): CanonicalTimeEvidence {
  if (field.eventTimeRequirement === 'NOT_APPLICABLE') return { state: 'NOT_APPLICABLE' };
  if (field.eventTimeRequirement === 'RECORD_EVENT_TIME_SUFFICIENT') {
    return { state: 'KNOWN', value: record.eventTime, source: 'RECORD_ENVELOPE' };
  }
  return fieldTimeEvidence(payload, binding.eventTimeBinding, field.fieldId, 'EVENT_TIME');
}

function availabilityEvidence(
  record: RawResearchRecord,
  payload: unknown,
  field: CanonicalFieldDefinition,
  binding: ProviderSourceFieldBinding,
): CanonicalTimeEvidence {
  if (field.availabilityRequirement === 'UNKNOWN') return { state: 'UNKNOWN' };
  if (field.availabilityRequirement === 'RECORD_AVAILABLE_AT_SUFFICIENT') {
    if (record.availableAt === null || record.availableAtAuthority === 'UNKNOWN') return { state: 'UNKNOWN' };
    return { state: 'KNOWN', value: record.availableAt, source: 'RECORD_ENVELOPE' };
  }
  return fieldTimeEvidence(payload, binding.availableAtBinding, field.fieldId, 'AVAILABLE_AT');
}

function snapshotContractInputs(input: CreateCanonicalPointInTimeDatasetInput): {
  dictionary: CanonicalFieldDictionary;
  bindingSet: ProviderSourceBindingSet;
  manifest: ProviderManifest;
} {
  assertPlainInertData(input.dictionary, 'DICTIONARY');
  assertPlainInertData(input.bindingSet, 'BINDING_SET');
  assertProviderManifestSnapshotStructure(input.manifest);
  const dictionary = structuredClone(input.dictionary);
  const bindingSet = structuredClone(input.bindingSet);
  const manifest = structuredClone(input.manifest);
  assertCanonicalFieldDictionary(dictionary);
  assertProviderSourceBindingSet(bindingSet);
  assertProviderManifest(manifest);
  assertBindingSetMatchesDictionary(dictionary, bindingSet);
  assertBindingSetMatchesManifest(bindingSet, manifest);
  return { dictionary, bindingSet, manifest };
}

function snapshotRawRecords(values: readonly RawResearchRecord[]): readonly RawResearchRecord[] {
  // One descriptor-only traversal rejects array, envelope, and payload accessors
  // before the single clone that owns every payload snapshot in this batch.
  assertPlainInertData(values, 'RAW_RECORDS');
  const snapshots = structuredClone(values);
  snapshots.forEach(assertRawResearchRecord);
  return snapshots;
}

export function createCanonicalPointInTimeDataset(
  input: CreateCanonicalPointInTimeDatasetInput,
): CanonicalPointInTimeDataset {
  const { dictionary, bindingSet, manifest } = snapshotContractInputs(input);
  const fields = new Map(dictionary.fields.map((field) => [field.fieldId, field]));
  const records: CanonicalPointInTimeRecord[] = [];
  const sourceRecordIds = new Set<string>();
  const rawRecords = snapshotRawRecords(input.records);

  for (const record of rawRecords) {
    if (sourceRecordIds.has(record.sourceRecordId)) {
      pitViolation(`DUPLICATE_SOURCE_RECORD_ID:${record.sourceRecordId}`);
    }
    sourceRecordIds.add(record.sourceRecordId);
    if (
      record.providerId !== bindingSet.providerId
      || record.adapterId !== bindingSet.adapterId
      || record.adapterVersion !== manifest.adapterVersion
      || record.manifestVersion !== manifest.manifestVersion
      || record.sourceDatasetRef !== bindingSet.sourceDatasetRef
    ) {
      pitViolation(`RAW_RECORD_PROVENANCE_MISMATCH:${record.sourceRecordId}`);
    }

    // `record` is the sole defensive snapshot. Every path for this record reads this payload.
    const payload = record.payload;
    const canonicalFields = bindingSet.bindings.map((binding): CanonicalPointInTimeField => {
      const field = fields.get(binding.canonicalFieldId);
      if (field === undefined) pitViolation(`CANONICAL_FIELD_NOT_FOUND:${binding.canonicalFieldId}`);
      return {
        fieldId: field.fieldId,
        logicalType: field.logicalType,
        unit: field.unit,
        semanticRole: field.semanticRole,
        eventTimeRequirement: field.eventTimeRequirement,
        availabilityRequirement: field.availabilityRequirement,
        historicalDecisionPolicy: field.historicalDecisionPolicy,
        researchUsePolicy: field.researchUsePolicy,
        presence: materializePresence(payload, field, binding),
        eventTimeEvidence: eventTimeEvidence(record, payload, field, binding),
        availabilityEvidence: availabilityEvidence(record, payload, field, binding),
      };
    });

    records.push({
      sourceRecordId: record.sourceRecordId,
      adapterVersion: record.adapterVersion,
      eventTime: record.eventTime,
      availableAt: record.availableAt,
      availableAtAuthority: record.availableAtAuthority,
      ingestedAt: record.ingestedAt,
      payloadHash: record.payloadHash,
      manifestVersion: record.manifestVersion,
      manifestReference: record.manifestReference,
      requestId: record.requestId,
      sourceProvenanceRef: record.sourceProvenanceRef,
      ...(record.sourceRevision === undefined ? {} : { sourceRevision: record.sourceRevision }),
      fields: canonicalFields,
    });
  }

  return deepFreeze({
    schemaVersion: '1.0.0',
    dictionaryId: dictionary.dictionaryId,
    dictionaryVersion: dictionary.dictionaryVersion,
    bindingId: bindingSet.bindingId,
    bindingVersion: bindingSet.bindingVersion,
    providerId: bindingSet.providerId,
    adapterId: bindingSet.adapterId,
    sourceDatasetRef: bindingSet.sourceDatasetRef,
    records,
    productionAuthority: false,
  });
}

export const PHASE_9C_CANONICAL_PIT_BOUNDARY = Object.freeze({
  phase: '9C',
  mappingKind: 'DIRECT',
  staticPointInTimeEligibility: false,
  revisionArbitrationImplemented: false,
  storageImplemented: false,
  networkImplementationAdded: false,
  downstreamConsumerAdded: false,
  productionAuthority: false,
} as const);
