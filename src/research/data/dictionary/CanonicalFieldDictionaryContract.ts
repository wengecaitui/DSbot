import {
  assertPlainInertData,
  booleanValue,
  boundedProse,
  denseArray,
  dictionaryViolation,
  enumValue,
  exactKeys,
  identifier,
  plainRecord,
  safeIntegerAtLeast,
  version,
} from './ResearchDictionaryValidation';

export const SCALAR_LOGICAL_TYPES = Object.freeze([
  'BOOLEAN', 'INT64', 'FLOAT64', 'STRING', 'DATE', 'TIMESTAMP_UTC',
] as const);
export type ScalarLogicalType = (typeof SCALAR_LOGICAL_TYPES)[number];
export interface DecimalLogicalType {
  readonly kind: 'DECIMAL';
  readonly precision: number;
  readonly scale: number;
}
export type CanonicalLogicalType = ScalarLogicalType | DecimalLogicalType;

export const SIMPLE_UNITS = Object.freeze([
  'UNITLESS', 'SHARES', 'COUNT', 'RATIO', 'PERCENT', 'BASIS_POINTS',
] as const);
export type SimpleUnit = (typeof SIMPLE_UNITS)[number];
export interface CurrencyUnit {
  readonly kind: 'CURRENCY';
  readonly currencyFieldId: string;
}
export interface OtherUnit {
  readonly kind: 'OTHER';
  readonly description: string;
}
export type CanonicalUnit = SimpleUnit | CurrencyUnit | OtherUnit;

export const SEMANTIC_ROLES = Object.freeze([
  'MEASURE', 'IDENTIFIER', 'TIMESTAMP', 'LABEL', 'METADATA',
] as const);
export type SemanticRole = (typeof SEMANTIC_ROLES)[number];

export type CanonicalNullSemantics =
  | { readonly nullable: false }
  | { readonly nullable: true; readonly meaning: string };

export const PRICE_BASES = Object.freeze([
  'RAW',
  'SPLIT_ADJUSTED',
  'DIVIDEND_ADJUSTED',
  'TOTAL_RETURN_ADJUSTED',
  'PROVIDER_DEFINED',
  'UNKNOWN',
] as const);
export type PriceBasis = (typeof PRICE_BASES)[number];
export type CanonicalPriceSemantics =
  | { readonly kind: 'NOT_PRICE' }
  | {
    readonly kind: 'PRICE';
    readonly basis: PriceBasis;
    readonly documentedAdjustmentRule: string | null;
  };

export const OBSERVATION_PERIODS = Object.freeze([
  'SESSION', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'PROVIDER_DEFINED',
] as const);
export type ObservationPeriod = (typeof OBSERVATION_PERIODS)[number];
export const STANDARD_OBSERVATION_PERIODS = Object.freeze([
  'SESSION', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR',
] as const);
export type StandardObservationPeriod = (typeof STANDARD_OBSERVATION_PERIODS)[number];
export const EVENT_TIME_ANCHORS = Object.freeze(['PERIOD_START', 'PERIOD_END'] as const);
export type EventTimeAnchor = (typeof EVENT_TIME_ANCHORS)[number];
export type CanonicalObservationSemantics =
  | { readonly kind: 'INSTANT' }
  | {
    readonly kind: 'PERIOD';
    readonly period: StandardObservationPeriod;
    readonly eventTimeAnchor: EventTimeAnchor;
  }
  | {
    readonly kind: 'PERIOD';
    readonly period: 'PROVIDER_DEFINED';
    readonly eventTimeAnchor: EventTimeAnchor;
    readonly documentedPeriodDefinition: string;
  };

export type CanonicalCalendarSemantics =
  | { readonly kind: 'NOT_APPLICABLE' }
  | { readonly kind: 'NAMED'; readonly timezoneId: string; readonly calendarId: string };

export const EVENT_TIME_REQUIREMENTS = Object.freeze([
  'RECORD_EVENT_TIME_SUFFICIENT', 'FIELD_LEVEL_REQUIRED', 'NOT_APPLICABLE',
] as const);
export type EventTimeRequirement = (typeof EVENT_TIME_REQUIREMENTS)[number];
export const AVAILABILITY_REQUIREMENTS = Object.freeze([
  'RECORD_AVAILABLE_AT_SUFFICIENT', 'FIELD_LEVEL_REQUIRED', 'UNKNOWN',
] as const);
export type AvailabilityRequirement = (typeof AVAILABILITY_REQUIREMENTS)[number];
export const HISTORICAL_DECISION_POLICIES = Object.freeze([
  'REQUIRES_PROVABLE_AVAILABILITY', 'FORBIDDEN_AS_DECISION_INPUT',
] as const);
export type HistoricalDecisionPolicy = (typeof HISTORICAL_DECISION_POLICIES)[number];

export const RESEARCH_USES = Object.freeze([
  'FACTOR_INPUT',
  'LABEL',
  'RESEARCH_VALUATION',
  'UNIVERSE_FILTER',
  'RESEARCH_EXECUTION_MODEL_INPUT',
  'JOIN_KEY',
  'DISPLAY',
  'QUALITY_CONTROL',
] as const);
export type ResearchUse = (typeof RESEARCH_USES)[number];
export const DECISION_INPUT_USES = Object.freeze([
  'FACTOR_INPUT',
  'RESEARCH_VALUATION',
  'UNIVERSE_FILTER',
  'RESEARCH_EXECUTION_MODEL_INPUT',
  'JOIN_KEY',
] as const satisfies readonly ResearchUse[]);
export const NON_DECISION_INPUT_USES = Object.freeze([
  'LABEL', 'DISPLAY', 'QUALITY_CONTROL',
] as const satisfies readonly ResearchUse[]);
export type ResearchUseDecision = 'ALLOW' | 'DENY';
export type ResearchUsePolicy = Readonly<Record<ResearchUse, ResearchUseDecision>>;

export interface CanonicalFieldDefinition {
  readonly fieldId: string;
  readonly logicalType: CanonicalLogicalType;
  readonly unit: CanonicalUnit;
  readonly meaning: string;
  readonly semanticRole: SemanticRole;
  readonly nullSemantics: CanonicalNullSemantics;
  readonly priceSemantics: CanonicalPriceSemantics;
  readonly observationSemantics: CanonicalObservationSemantics;
  readonly calendarSemantics: CanonicalCalendarSemantics;
  readonly eventTimeRequirement: EventTimeRequirement;
  readonly availabilityRequirement: AvailabilityRequirement;
  readonly historicalDecisionPolicy: HistoricalDecisionPolicy;
  readonly researchUsePolicy: ResearchUsePolicy;
}

export interface CanonicalFieldDictionary {
  readonly schemaVersion: string;
  readonly dictionaryId: string;
  readonly dictionaryVersion: string;
  readonly dataDomain: string;
  readonly fields: readonly CanonicalFieldDefinition[];
  readonly productionAuthority: false;
}

export function assertCanonicalLogicalType(value: unknown, name = 'LOGICAL_TYPE'): void {
  assertPlainInertData(value, name);
  if (typeof value === 'string') {
    enumValue(value, SCALAR_LOGICAL_TYPES, name);
    return;
  }
  const decimal = plainRecord(value, name);
  exactKeys(decimal, ['kind', 'precision', 'scale'], name);
  if (decimal.kind !== 'DECIMAL') dictionaryViolation(`${name}_KIND`);
  const precision = safeIntegerAtLeast(decimal.precision, 1, `${name}_PRECISION`);
  const scale = safeIntegerAtLeast(decimal.scale, 0, `${name}_SCALE`);
  if (scale > precision) dictionaryViolation(`${name}_SCALE_EXCEEDS_PRECISION`);
}

export function assertCanonicalUnit(value: unknown, name = 'UNIT'): void {
  assertPlainInertData(value, name);
  if (typeof value === 'string') {
    enumValue(value, SIMPLE_UNITS, name);
    return;
  }
  const unit = plainRecord(value, name);
  if (unit.kind === 'CURRENCY') {
    exactKeys(unit, ['kind', 'currencyFieldId'], name);
    identifier(unit.currencyFieldId, `${name}_CURRENCY_FIELD_ID`);
    return;
  }
  if (unit.kind === 'OTHER') {
    exactKeys(unit, ['kind', 'description'], name);
    boundedProse(unit.description, `${name}_DESCRIPTION`);
    return;
  }
  dictionaryViolation(`${name}_KIND`);
}

function assertNullSemantics(value: unknown, name: string): void {
  const semantics = plainRecord(value, name);
  const nullable = booleanValue(semantics.nullable, `${name}_NULLABLE`);
  if (nullable) {
    exactKeys(semantics, ['nullable', 'meaning'], name);
    boundedProse(semantics.meaning, `${name}_MEANING`);
  } else {
    exactKeys(semantics, ['nullable'], name);
  }
}

export function assertCanonicalPriceSemantics(value: unknown, name = 'PRICE_SEMANTICS'): void {
  assertPlainInertData(value, name);
  const semantics = plainRecord(value, name);
  if (semantics.kind === 'NOT_PRICE') {
    exactKeys(semantics, ['kind'], name);
    return;
  }
  if (semantics.kind !== 'PRICE') dictionaryViolation(`${name}_KIND`);
  exactKeys(semantics, ['kind', 'basis', 'documentedAdjustmentRule'], name);
  const basis = enumValue(semantics.basis, PRICE_BASES, `${name}_BASIS`);
  if (basis === 'PROVIDER_DEFINED' && semantics.documentedAdjustmentRule === null) {
    dictionaryViolation(`${name}_PROVIDER_DEFINED_RULE_REQUIRED`);
  }
  if (semantics.documentedAdjustmentRule !== null) {
    boundedProse(semantics.documentedAdjustmentRule, `${name}_ADJUSTMENT_RULE`);
  }
}

export function assertCanonicalObservationSemantics(value: unknown, name = 'OBSERVATION_SEMANTICS'): void {
  assertPlainInertData(value, name);
  const semantics = plainRecord(value, name);
  if (semantics.kind === 'INSTANT') {
    exactKeys(semantics, ['kind'], name);
    return;
  }
  if (semantics.kind !== 'PERIOD') dictionaryViolation(`${name}_KIND`);
  if (semantics.period === 'PROVIDER_DEFINED') {
    exactKeys(semantics, ['kind', 'period', 'eventTimeAnchor', 'documentedPeriodDefinition'], name);
    boundedProse(semantics.documentedPeriodDefinition, `${name}_PERIOD_DEFINITION`);
  } else {
    exactKeys(semantics, ['kind', 'period', 'eventTimeAnchor'], name);
    enumValue(semantics.period, STANDARD_OBSERVATION_PERIODS, `${name}_PERIOD`);
  }
  enumValue(semantics.eventTimeAnchor, EVENT_TIME_ANCHORS, `${name}_ANCHOR`);
}

function assertCalendarSemantics(value: unknown, name: string): void {
  const semantics = plainRecord(value, name);
  if (semantics.kind === 'NOT_APPLICABLE') {
    exactKeys(semantics, ['kind'], name);
    return;
  }
  if (semantics.kind !== 'NAMED') dictionaryViolation(`${name}_KIND`);
  exactKeys(semantics, ['kind', 'timezoneId', 'calendarId'], name);
  boundedProse(semantics.timezoneId, `${name}_TIMEZONE_ID`);
  identifier(semantics.calendarId, `${name}_CALENDAR_ID`);
}

function assertResearchUseVocabularyPartition(): void {
  const decision = new Set<string>(DECISION_INPUT_USES);
  const nonDecision = new Set<string>(NON_DECISION_INPUT_USES);
  if ([...decision].some((use) => nonDecision.has(use))) {
    dictionaryViolation('RESEARCH_USE_PARTITION_INTERSECTION');
  }
  const union = new Set([...decision, ...nonDecision]);
  if (union.size !== RESEARCH_USES.length || RESEARCH_USES.some((use) => !union.has(use))) {
    dictionaryViolation('RESEARCH_USE_PARTITION_UNION');
  }
}

function assertResearchUsePolicy(value: unknown, name: string): ResearchUsePolicy {
  const policy = plainRecord(value, name);
  exactKeys(policy, RESEARCH_USES, name);
  for (const use of RESEARCH_USES) {
    enumValue(policy[use], ['ALLOW', 'DENY'] as const, `${name}_${use}`);
  }
  return policy as ResearchUsePolicy;
}

function decisionUsesDenied(policy: ResearchUsePolicy): boolean {
  return DECISION_INPUT_USES.every((use) => policy[use] === 'DENY');
}

function assertField(value: unknown, index: number): CanonicalFieldDefinition {
  const name = `FIELD_${index}`;
  const field = plainRecord(value, name);
  exactKeys(field, [
    'fieldId',
    'logicalType',
    'unit',
    'meaning',
    'semanticRole',
    'nullSemantics',
    'priceSemantics',
    'observationSemantics',
    'calendarSemantics',
    'eventTimeRequirement',
    'availabilityRequirement',
    'historicalDecisionPolicy',
    'researchUsePolicy',
  ], name);

  identifier(field.fieldId, `${name}_ID`);
  assertCanonicalLogicalType(field.logicalType, `${name}_LOGICAL_TYPE`);
  assertCanonicalUnit(field.unit, `${name}_UNIT`);
  boundedProse(field.meaning, `${name}_MEANING`);
  const semanticRole = enumValue(field.semanticRole, SEMANTIC_ROLES, `${name}_SEMANTIC_ROLE`);
  assertNullSemantics(field.nullSemantics, `${name}_NULL_SEMANTICS`);
  assertCanonicalPriceSemantics(field.priceSemantics, `${name}_PRICE_SEMANTICS`);
  assertCanonicalObservationSemantics(field.observationSemantics, `${name}_OBSERVATION_SEMANTICS`);
  assertCalendarSemantics(field.calendarSemantics, `${name}_CALENDAR_SEMANTICS`);
  enumValue(field.eventTimeRequirement, EVENT_TIME_REQUIREMENTS, `${name}_EVENT_TIME_REQUIREMENT`);
  const availability = enumValue(
    field.availabilityRequirement,
    AVAILABILITY_REQUIREMENTS,
    `${name}_AVAILABILITY_REQUIREMENT`,
  );
  const historical = enumValue(
    field.historicalDecisionPolicy,
    HISTORICAL_DECISION_POLICIES,
    `${name}_HISTORICAL_DECISION_POLICY`,
  );
  const policy = assertResearchUsePolicy(field.researchUsePolicy, `${name}_RESEARCH_USE_POLICY`);

  const observation = field.observationSemantics as CanonicalObservationSemantics;
  const calendar = field.calendarSemantics as CanonicalCalendarSemantics;
  if (observation.kind === 'PERIOD' && calendar.kind === 'NOT_APPLICABLE') {
    dictionaryViolation(`${name}_PERIOD_REQUIRES_CALENDAR`);
  }
  if (field.logicalType === 'DATE' && calendar.kind === 'NOT_APPLICABLE') {
    dictionaryViolation(`${name}_DATE_REQUIRES_CALENDAR`);
  }
  if (semanticRole === 'LABEL' && historical !== 'FORBIDDEN_AS_DECISION_INPUT') {
    dictionaryViolation(`${name}_LABEL_HISTORICAL_POLICY`);
  }
  if (
    semanticRole === 'LABEL'
    || availability === 'UNKNOWN'
    || historical === 'FORBIDDEN_AS_DECISION_INPUT'
  ) {
    if (!decisionUsesDenied(policy)) dictionaryViolation(`${name}_DECISION_INPUT_MUST_DENY`);
  }

  const price = field.priceSemantics as CanonicalPriceSemantics;
  if (price.kind === 'PRICE') {
    if (price.basis === 'UNKNOWN' && !decisionUsesDenied(policy)) {
      dictionaryViolation(`${name}_UNKNOWN_PRICE_DECISION_INPUT`);
    }
    if (
      (policy.RESEARCH_EXECUTION_MODEL_INPUT === 'ALLOW' || policy.RESEARCH_VALUATION === 'ALLOW')
      && price.basis !== 'RAW'
    ) {
      dictionaryViolation(`${name}_DECISION_PRICE_MUST_BE_RAW`);
    }
  }

  return field as unknown as CanonicalFieldDefinition;
}

/** Validate the current provider-neutral dictionary object, without lineage claims. */
export function assertCanonicalFieldDictionary(value: unknown): asserts value is CanonicalFieldDictionary {
  assertPlainInertData(value, '$');
  assertResearchUseVocabularyPartition();
  const dictionary = plainRecord(value, 'ROOT');
  exactKeys(dictionary, [
    'schemaVersion',
    'dictionaryId',
    'dictionaryVersion',
    'dataDomain',
    'fields',
    'productionAuthority',
  ], 'ROOT');
  version(dictionary.schemaVersion, 'SCHEMA_VERSION');
  identifier(dictionary.dictionaryId, 'DICTIONARY_ID');
  version(dictionary.dictionaryVersion, 'DICTIONARY_VERSION');
  identifier(dictionary.dataDomain, 'DATA_DOMAIN');
  if (dictionary.productionAuthority !== false) {
    dictionaryViolation('PRODUCTION_AUTHORITY_MUST_BE_FALSE');
  }

  const fieldValues = denseArray(dictionary.fields, 'FIELDS');
  const fields = fieldValues.map(assertField);
  const fieldIds = fields.map((field) => field.fieldId);
  if (new Set(fieldIds).size !== fieldIds.length) dictionaryViolation('DUPLICATE_FIELD_ID');
  const fieldsById = new Map(fields.map((field) => [field.fieldId, field]));
  for (const field of fields) {
    if (typeof field.unit === 'object' && field.unit.kind === 'CURRENCY') {
      const currencyField = fieldsById.get(field.unit.currencyFieldId);
      if (currencyField === undefined) dictionaryViolation(`CURRENCY_FIELD_NOT_FOUND:${field.fieldId}`);
      if (currencyField.logicalType !== 'STRING') {
        dictionaryViolation(`CURRENCY_FIELD_NOT_STRING:${field.fieldId}`);
      }
      if (typeof currencyField.unit === 'object' && currencyField.unit.kind === 'CURRENCY') {
        dictionaryViolation(`CURRENCY_FIELD_IS_CURRENCY:${field.fieldId}`);
      }
    }
  }
}

export const PHASE_9B_CANONICAL_DICTIONARY_BOUNDARY = Object.freeze({
  phase: '9B',
  layer: 'CANONICAL_FIELD_DICTIONARY',
  providerNeutral: true,
  currentPairValidationOnly: true,
  historicalVersionIdentityImplemented: false,
  normalizationImplemented: false,
  datasetEligibilityImplemented: false,
  productionAuthority: false,
} as const);
