import {
  DECISION_INPUT_USES,
  NON_DECISION_INPUT_USES,
  type CanonicalFieldDefinition,
} from '../dictionary/CanonicalFieldDictionaryContract';
import {
  assertPlainInertData,
  denseArray,
  enumValue,
  exactKeys,
  identifier,
  plainRecord,
} from '../dictionary/ResearchDictionaryValidation';

export type DecisionInputResearchUse = (typeof DECISION_INPUT_USES)[number];
export type NonDecisionResearchUse = (typeof NON_DECISION_INPUT_USES)[number];

export interface DecisionInputViewRequest {
  readonly researchUse: DecisionInputResearchUse;
  readonly decisionTime: string;
  readonly fieldIds: readonly string[];
}

export interface NonDecisionResearchViewRequest {
  readonly researchUse: NonDecisionResearchUse;
  readonly fieldIds: readonly string[];
}

export type DatasetUsageFieldSchema = Pick<CanonicalFieldDefinition,
  | 'fieldId'
  | 'logicalType'
  | 'unit'
  | 'semanticRole'
  | 'eventTimeRequirement'
  | 'availabilityRequirement'
  | 'historicalDecisionPolicy'
  | 'researchUsePolicy'
>;

function usageViolation(reason: string): never {
  throw new Error(`PHASE_9E_DATASET_USAGE_INVALID:${reason}`);
}

function canonicalDecisionTime(value: unknown): string {
  if (typeof value !== 'string') usageViolation('DECISION_TIME');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    usageViolation('DECISION_TIME');
  }
  return value;
}

function fieldIds(value: unknown): readonly string[] {
  const values = denseArray(value, 'PHASE_9E_FIELD_IDS');
  const validated = values.map((fieldId) => identifier(fieldId, 'PHASE_9E_FIELD_ID'));
  if (new Set(validated).size !== validated.length) usageViolation('DUPLICATE_FIELD_ID');
  return validated;
}

function schemaById(
  schema: readonly DatasetUsageFieldSchema[],
  requestedFieldIds: readonly string[],
): readonly DatasetUsageFieldSchema[] {
  if (schema.length === 0) usageViolation('EMPTY_DATASET_FIELD_SCHEMA_UNAVAILABLE');
  const definitions = new Map(schema.map((field) => [field.fieldId, field] as const));
  return requestedFieldIds.map((fieldId) => {
    const definition = definitions.get(fieldId);
    if (definition === undefined) usageViolation(`FIELD_NOT_FOUND:${fieldId}`);
    return definition;
  });
}

export function validateDecisionInputViewRequest(
  callerRequest: unknown,
  schema: readonly DatasetUsageFieldSchema[],
): DecisionInputViewRequest {
  assertPlainInertData(callerRequest, 'PHASE_9E_DECISION_REQUEST');
  const snapshot: unknown = structuredClone(callerRequest);
  const request = plainRecord(snapshot, 'PHASE_9E_DECISION_REQUEST');
  exactKeys(request, ['researchUse', 'decisionTime', 'fieldIds'], 'PHASE_9E_DECISION_REQUEST');
  const researchUse = enumValue(request.researchUse, DECISION_INPUT_USES, 'PHASE_9E_DECISION_RESEARCH_USE');
  const decisionTime = canonicalDecisionTime(request.decisionTime);
  const requestedFieldIds = fieldIds(request.fieldIds);
  for (const definition of schemaById(schema, requestedFieldIds)) {
    if (definition.semanticRole === 'LABEL') usageViolation(`LABEL_DECISION_INPUT:${definition.fieldId}`);
    if (definition.historicalDecisionPolicy !== 'REQUIRES_PROVABLE_AVAILABILITY') {
      usageViolation(`HISTORICAL_DECISION_FORBIDDEN:${definition.fieldId}`);
    }
    if (definition.researchUsePolicy[researchUse] !== 'ALLOW') {
      usageViolation(`RESEARCH_USE_DENIED:${definition.fieldId}`);
    }
  }
  return Object.freeze({ researchUse, decisionTime, fieldIds: Object.freeze([...requestedFieldIds]) });
}

export function validateNonDecisionResearchViewRequest(
  callerRequest: unknown,
  schema: readonly DatasetUsageFieldSchema[],
): NonDecisionResearchViewRequest {
  assertPlainInertData(callerRequest, 'PHASE_9E_ANALYSIS_REQUEST');
  const snapshot: unknown = structuredClone(callerRequest);
  const request = plainRecord(snapshot, 'PHASE_9E_ANALYSIS_REQUEST');
  exactKeys(request, ['researchUse', 'fieldIds'], 'PHASE_9E_ANALYSIS_REQUEST');
  const researchUse = enumValue(request.researchUse, NON_DECISION_INPUT_USES, 'PHASE_9E_ANALYSIS_RESEARCH_USE');
  const requestedFieldIds = fieldIds(request.fieldIds);
  for (const definition of schemaById(schema, requestedFieldIds)) {
    if (definition.researchUsePolicy[researchUse] !== 'ALLOW') {
      usageViolation(`RESEARCH_USE_DENIED:${definition.fieldId}`);
    }
  }
  return Object.freeze({ researchUse, fieldIds: Object.freeze([...requestedFieldIds]) });
}
