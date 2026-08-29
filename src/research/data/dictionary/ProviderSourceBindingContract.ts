import {
  assertProviderManifest,
  assertProviderManifestSnapshotStructure,
  type ProviderManifest,
} from '../ProviderManifestContract';
import {
  assertCanonicalFieldDictionary,
  assertCanonicalLogicalType,
  assertCanonicalObservationSemantics,
  assertCanonicalPriceSemantics,
  assertCanonicalUnit,
  type CanonicalFieldDictionary,
  type CanonicalLogicalType,
  type CanonicalObservationSemantics,
  type CanonicalPriceSemantics,
  type CanonicalUnit,
} from './CanonicalFieldDictionaryContract';
import {
  assertPlainInertData,
  booleanValue,
  boundedProse,
  denseArray,
  dictionaryViolation,
  exactKeys,
  identifier,
  plainRecord,
  safeIntegerAtLeast,
  structurallyEqual,
  version,
} from './ResearchDictionaryValidation';

export type SourcePathSegment = string | number;
export type SourcePath = readonly SourcePathSegment[];

export type SourceTimeBinding =
  | 'RECORD_ENVELOPE'
  | { readonly kind: 'SOURCE_PAYLOAD_PATH'; readonly path: SourcePath }
  | { readonly kind: 'DOCUMENTED_RULE'; readonly rule: string }
  | 'UNKNOWN';

export interface ProviderSourceFieldBinding {
  readonly canonicalFieldId: string;
  readonly sourcePath: SourcePath;
  readonly mappingKind: 'DIRECT';
  readonly sourceLogicalType: CanonicalLogicalType;
  readonly sourceUnit: CanonicalUnit;
  readonly sourcePriceSemantics: CanonicalPriceSemantics;
  readonly sourceObservationSemantics: CanonicalObservationSemantics;
  readonly sourcePresence: 'REQUIRED' | 'OPTIONAL';
  readonly sourceNullable: boolean;
  readonly eventTimeBinding: SourceTimeBinding;
  readonly availableAtBinding: SourceTimeBinding;
}

export interface ProviderSourceBindingSet {
  readonly schemaVersion: string;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly providerId: string;
  readonly adapterId: string;
  readonly sourceDatasetRef: string;
  readonly dictionaryId: string;
  readonly dictionaryVersion: string;
  readonly bindings: readonly ProviderSourceFieldBinding[];
  readonly productionAuthority: false;
}

function assertSourcePath(value: unknown, name: string): void {
  const path = denseArray(value, name);
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (typeof segment === 'string') {
      boundedProse(segment, `${name}_${index}`);
      continue;
    }
    if (typeof segment === 'number') {
      safeIntegerAtLeast(segment, 0, `${name}_${index}`);
      continue;
    }
    dictionaryViolation(`${name}_${index}`);
  }
}

function assertSourceTimeBinding(value: unknown, name: string): void {
  if (value === 'RECORD_ENVELOPE' || value === 'UNKNOWN') return;
  const binding = plainRecord(value, name);
  if (binding.kind === 'SOURCE_PAYLOAD_PATH') {
    exactKeys(binding, ['kind', 'path'], name);
    assertSourcePath(binding.path, `${name}_PATH`);
    return;
  }
  if (binding.kind === 'DOCUMENTED_RULE') {
    exactKeys(binding, ['kind', 'rule'], name);
    boundedProse(binding.rule, `${name}_RULE`);
    return;
  }
  dictionaryViolation(`${name}_KIND`);
}

function assertSourceFieldBinding(value: unknown, index: number): ProviderSourceFieldBinding {
  const name = `BINDING_${index}`;
  const binding = plainRecord(value, name);
  exactKeys(binding, [
    'canonicalFieldId',
    'sourcePath',
    'mappingKind',
    'sourceLogicalType',
    'sourceUnit',
    'sourcePriceSemantics',
    'sourceObservationSemantics',
    'sourcePresence',
    'sourceNullable',
    'eventTimeBinding',
    'availableAtBinding',
  ], name);
  identifier(binding.canonicalFieldId, `${name}_CANONICAL_FIELD_ID`);
  assertSourcePath(binding.sourcePath, `${name}_SOURCE_PATH`);
  if (binding.mappingKind !== 'DIRECT') dictionaryViolation(`${name}_MAPPING_KIND`);
  assertCanonicalLogicalType(binding.sourceLogicalType, `${name}_SOURCE_LOGICAL_TYPE`);
  assertCanonicalUnit(binding.sourceUnit, `${name}_SOURCE_UNIT`);
  assertCanonicalPriceSemantics(binding.sourcePriceSemantics, `${name}_SOURCE_PRICE_SEMANTICS`);
  assertCanonicalObservationSemantics(
    binding.sourceObservationSemantics,
    `${name}_SOURCE_OBSERVATION_SEMANTICS`,
  );
  if (binding.sourcePresence !== 'REQUIRED' && binding.sourcePresence !== 'OPTIONAL') {
    dictionaryViolation(`${name}_SOURCE_PRESENCE`);
  }
  booleanValue(binding.sourceNullable, `${name}_SOURCE_NULLABLE`);
  assertSourceTimeBinding(binding.eventTimeBinding, `${name}_EVENT_TIME_BINDING`);
  assertSourceTimeBinding(binding.availableAtBinding, `${name}_AVAILABLE_AT_BINDING`);
  return binding as unknown as ProviderSourceFieldBinding;
}

/** Validate provider-bound source assertions without performing any mapping. */
export function assertProviderSourceBindingSet(value: unknown): asserts value is ProviderSourceBindingSet {
  assertPlainInertData(value, '$');
  const set = plainRecord(value, 'ROOT');
  exactKeys(set, [
    'schemaVersion',
    'bindingId',
    'bindingVersion',
    'providerId',
    'adapterId',
    'sourceDatasetRef',
    'dictionaryId',
    'dictionaryVersion',
    'bindings',
    'productionAuthority',
  ], 'ROOT');
  version(set.schemaVersion, 'SCHEMA_VERSION');
  identifier(set.bindingId, 'BINDING_ID');
  version(set.bindingVersion, 'BINDING_VERSION');
  identifier(set.providerId, 'PROVIDER_ID');
  identifier(set.adapterId, 'ADAPTER_ID');
  identifier(set.sourceDatasetRef, 'SOURCE_DATASET_REF');
  identifier(set.dictionaryId, 'DICTIONARY_ID');
  version(set.dictionaryVersion, 'DICTIONARY_VERSION');
  if (set.productionAuthority !== false) dictionaryViolation('PRODUCTION_AUTHORITY_MUST_BE_FALSE');

  const bindings = denseArray(set.bindings, 'BINDINGS', true).map(assertSourceFieldBinding);
  const fieldIds = bindings.map((binding) => binding.canonicalFieldId);
  if (new Set(fieldIds).size !== fieldIds.length) dictionaryViolation('DUPLICATE_CANONICAL_BINDING');
}

function isEnvelopeOrUnknown(binding: SourceTimeBinding): boolean {
  return binding === 'RECORD_ENVELOPE' || binding === 'UNKNOWN';
}

/**
 * Assert current-pair compatibility only. This does not prove historical
 * content identity, version lineage, normalization, visibility, or eligibility.
 */
export function assertBindingSetMatchesDictionary(
  dictionary: unknown,
  bindingSet: unknown,
): asserts dictionary is CanonicalFieldDictionary {
  assertCanonicalFieldDictionary(dictionary);
  assertProviderSourceBindingSet(bindingSet);
  if (bindingSet.dictionaryId !== dictionary.dictionaryId) {
    dictionaryViolation('DICTIONARY_ID_MISMATCH');
  }
  if (bindingSet.dictionaryVersion !== dictionary.dictionaryVersion) {
    dictionaryViolation('DICTIONARY_VERSION_MISMATCH');
  }

  const fields = new Map(dictionary.fields.map((field) => [field.fieldId, field]));
  const claimed = new Set<string>();
  for (const binding of bindingSet.bindings) {
    if (claimed.has(binding.canonicalFieldId)) dictionaryViolation('DUPLICATE_CANONICAL_BINDING');
    claimed.add(binding.canonicalFieldId);
    const field = fields.get(binding.canonicalFieldId);
    if (field === undefined) dictionaryViolation(`UNKNOWN_CANONICAL_FIELD:${binding.canonicalFieldId}`);
    if (!structurallyEqual(binding.sourceLogicalType, field.logicalType)) {
      dictionaryViolation(`DIRECT_LOGICAL_TYPE_MISMATCH:${field.fieldId}`);
    }
    if (!structurallyEqual(binding.sourceUnit, field.unit)) {
      dictionaryViolation(`DIRECT_UNIT_MISMATCH:${field.fieldId}`);
    }
    if (!structurallyEqual(binding.sourcePriceSemantics, field.priceSemantics)) {
      dictionaryViolation(`DIRECT_PRICE_MISMATCH:${field.fieldId}`);
    }
    if (!structurallyEqual(binding.sourceObservationSemantics, field.observationSemantics)) {
      dictionaryViolation(`DIRECT_OBSERVATION_MISMATCH:${field.fieldId}`);
    }
    if (field.nullSemantics.nullable === false) {
      if (binding.sourcePresence === 'OPTIONAL') {
        dictionaryViolation(`OPTIONAL_SOURCE_FOR_NON_NULLABLE:${field.fieldId}`);
      }
      if (binding.sourceNullable) {
        dictionaryViolation(`NULLABLE_SOURCE_FOR_NON_NULLABLE:${field.fieldId}`);
      }
    }
    if (
      field.eventTimeRequirement === 'FIELD_LEVEL_REQUIRED'
      && isEnvelopeOrUnknown(binding.eventTimeBinding)
    ) {
      dictionaryViolation(`FIELD_EVENT_TIME_BINDING_REQUIRED:${field.fieldId}`);
    }
    if (
      field.availabilityRequirement === 'FIELD_LEVEL_REQUIRED'
      && isEnvelopeOrUnknown(binding.availableAtBinding)
    ) {
      dictionaryViolation(`FIELD_AVAILABLE_AT_BINDING_REQUIRED:${field.fieldId}`);
    }
  }
  for (const binding of bindingSet.bindings) {
    const field = fields.get(binding.canonicalFieldId);
    if (
      field !== undefined
      && typeof field.unit === 'object'
      && field.unit.kind === 'CURRENCY'
      && !claimed.has(field.unit.currencyFieldId)
    ) {
      dictionaryViolation(`CURRENCY_BINDING_DEPENDENCY_MISSING:${field.fieldId}`);
    }
  }
}

/** Match only identities currently owned by the Phase 9A manifest authority. */
export function assertBindingSetMatchesManifest(
  bindingSet: unknown,
  manifest: unknown,
): asserts manifest is ProviderManifest {
  assertProviderSourceBindingSet(bindingSet);
  assertProviderManifestSnapshotStructure(manifest);
  const snapshot = structuredClone(manifest);
  assertProviderManifest(snapshot);
  if (bindingSet.providerId !== snapshot.providerId) dictionaryViolation('MANIFEST_PROVIDER_ID_MISMATCH');
  if (bindingSet.adapterId !== snapshot.adapterId) dictionaryViolation('MANIFEST_ADAPTER_ID_MISMATCH');
}

export const PHASE_9B_PROVIDER_BINDING_BOUNDARY = Object.freeze({
  phase: '9B',
  layer: 'PROVIDER_SOURCE_BINDING',
  mappingKind: 'DIRECT',
  transformCallbacksAllowed: false,
  semanticOverrideAllowed: false,
  sourceDatasetManifestEqualityClaimed: false,
  currentPairValidationOnly: true,
  normalizationImplemented: false,
  productionAuthority: false,
} as const);
