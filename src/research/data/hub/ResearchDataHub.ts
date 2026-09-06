import { isDeepStrictEqual } from 'node:util';
import type {
  CanonicalFieldPresence,
  CanonicalPointInTimeDataset,
  CanonicalPointInTimeField,
} from '../pit/CanonicalPointInTimeDataset';
import { evaluateDecisionInputEligibility } from '../pit/PointInTimeEligibility';
import {
  assertResearchStorageInterchange,
  restoreCanonicalPointInTimeDataset,
  type ResearchStorageInterchange,
} from '../storage/ResearchStorageContract';
import {
  validateDecisionInputViewRequest,
  validateNonDecisionResearchViewRequest,
  type DatasetUsageFieldSchema,
  type DecisionInputResearchUse,
  type DecisionInputViewRequest,
  type NonDecisionResearchUse,
  type NonDecisionResearchViewRequest,
} from './DatasetUsagePolicy';

type ProjectedField = Pick<CanonicalPointInTimeField, 'fieldId' | 'logicalType' | 'unit' | 'presence'>;

export interface DecisionInputView {
  readonly usageMode: 'DECISION_INPUT';
  readonly researchUse: DecisionInputResearchUse;
  readonly decisionTime: string;
  readonly fieldIds: readonly string[];
  readonly rows: readonly {
    readonly viewIndex: number;
    readonly sourceRecordId: string;
    readonly fields: readonly ProjectedField[];
  }[];
  readonly productionAuthority: false;
}

export interface NonDecisionResearchView {
  readonly usageMode: 'NON_DECISION_RESEARCH';
  readonly researchUse: NonDecisionResearchUse;
  readonly fieldIds: readonly string[];
  readonly rows: readonly {
    readonly viewIndex: number;
    readonly sourceRecordId: string;
    readonly fields: readonly ProjectedField[];
  }[];
  readonly productionAuthority: false;
}

export interface ResearchDecisionDataPort {
  readonly createDecisionView: (request: DecisionInputViewRequest) => DecisionInputView;
}

export interface ResearchAnalysisDataPort {
  readonly createAnalysisView: (request: NonDecisionResearchViewRequest) => NonDecisionResearchView;
}

export interface ResearchDataHub {
  readonly decisionPort: ResearchDecisionDataPort;
  readonly analysisPort: ResearchAnalysisDataPort;
  readonly productionAuthority: false;
}

function hubViolation(reason: string): never {
  throw new Error(`PHASE_9E_RESEARCH_DATA_HUB_INVALID:${reason}`);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function fieldSchema(field: CanonicalPointInTimeField): DatasetUsageFieldSchema {
  return {
    fieldId: field.fieldId,
    logicalType: field.logicalType,
    unit: field.unit,
    semanticRole: field.semanticRole,
    eventTimeRequirement: field.eventTimeRequirement,
    availabilityRequirement: field.availabilityRequirement,
    historicalDecisionPolicy: field.historicalDecisionPolicy,
    researchUsePolicy: field.researchUsePolicy,
  };
}

function consistentSchema(dataset: CanonicalPointInTimeDataset): readonly DatasetUsageFieldSchema[] {
  if (dataset.records.length === 0) return Object.freeze([]);
  const schema = dataset.records[0].fields.map(fieldSchema);
  const ids = schema.map((field) => field.fieldId);
  if (new Set(ids).size !== ids.length) hubViolation('DUPLICATE_FIELD_SCHEMA');
  for (let index = 1; index < dataset.records.length; index += 1) {
    const candidate = dataset.records[index].fields.map(fieldSchema);
    if (!isDeepStrictEqual(candidate, schema)) hubViolation(`FIELD_SCHEMA_DRIFT:${index}`);
  }
  return deepFreeze(schema);
}

function projectField(field: CanonicalPointInTimeField): ProjectedField {
  const presence: CanonicalFieldPresence = field.presence.state === 'VALUE'
    ? { state: 'VALUE', value: field.presence.value }
    : { state: field.presence.state };
  return { fieldId: field.fieldId, logicalType: field.logicalType, unit: field.unit, presence };
}

function selectedFields(
  fields: readonly CanonicalPointInTimeField[],
  fieldIds: readonly string[],
): readonly CanonicalPointInTimeField[] {
  const byId = new Map(fields.map((field) => [field.fieldId, field] as const));
  return fieldIds.map((fieldId) => {
    const field = byId.get(fieldId);
    if (field === undefined) hubViolation(`FIELD_NOT_FOUND_AFTER_SCHEMA_VALIDATION:${fieldId}`);
    return field;
  });
}

export function createResearchDataHub(interchange: ResearchStorageInterchange): ResearchDataHub {
  assertResearchStorageInterchange(interchange);
  const dataset = restoreCanonicalPointInTimeDataset(interchange);
  const schema = consistentSchema(dataset);

  const decisionPort: ResearchDecisionDataPort = Object.freeze({
    createDecisionView(callerRequest: DecisionInputViewRequest): DecisionInputView {
      const request = validateDecisionInputViewRequest(callerRequest, schema);
      const rows: Array<DecisionInputView['rows'][number]> = [];
      for (const record of dataset.records) {
        const eligible = request.fieldIds.every((fieldId) => (
          evaluateDecisionInputEligibility(record, fieldId, request.researchUse, request.decisionTime).eligible
        ));
        if (!eligible) continue;
        rows.push({
          viewIndex: rows.length,
          sourceRecordId: record.sourceRecordId,
          fields: selectedFields(record.fields, request.fieldIds).map(projectField),
        });
      }
      return deepFreeze({
        usageMode: 'DECISION_INPUT',
        researchUse: request.researchUse,
        decisionTime: request.decisionTime,
        fieldIds: [...request.fieldIds],
        rows,
        productionAuthority: false,
      });
    },
  });

  const analysisPort: ResearchAnalysisDataPort = Object.freeze({
    createAnalysisView(callerRequest: NonDecisionResearchViewRequest): NonDecisionResearchView {
      const request = validateNonDecisionResearchViewRequest(callerRequest, schema);
      const rows = dataset.records.map((record, viewIndex) => ({
        viewIndex,
        sourceRecordId: record.sourceRecordId,
        fields: selectedFields(record.fields, request.fieldIds).map(projectField),
      }));
      return deepFreeze({
        usageMode: 'NON_DECISION_RESEARCH',
        researchUse: request.researchUse,
        fieldIds: [...request.fieldIds],
        rows,
        productionAuthority: false,
      });
    },
  });

  return Object.freeze({ decisionPort, analysisPort, productionAuthority: false });
}

export const PHASE_9E_RESEARCH_DATA_HUB_BOUNDARY = Object.freeze({
  phase: '9E',
  oneHubOneDataset: true,
  decisionEligibilityAuthority: 'PHASE_9C',
  explicitDecisionTimeRequired: true,
  decisionPortExposesRejectedRows: false,
  decisionPortExposesRawPayload: false,
  decisionPortExposesProvenance: false,
  analysisPortDecisionAuthority: false,
  mutableRegistryImplemented: false,
  cacheImplemented: false,
  lineageRegistryImplemented: false,
  providerIngestionImplemented: false,
  backtestKernelImplemented: false,
  storageIntegrityAuthority: false,
  productionAuthority: false,
} as const);
