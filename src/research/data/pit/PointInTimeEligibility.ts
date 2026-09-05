import {
  DECISION_INPUT_USES,
  type ResearchUse,
} from '../dictionary/CanonicalFieldDictionaryContract';
import type {
  CanonicalPointInTimeField,
  CanonicalPointInTimeRecord,
} from './CanonicalPointInTimeDataset';

export type PointInTimeVisibility =
  | { readonly state: 'VISIBLE'; readonly availableAt: string; readonly decisionTime: string }
  | { readonly state: 'NOT_YET_AVAILABLE'; readonly availableAt: string; readonly decisionTime: string }
  | { readonly state: 'UNPROVABLE'; readonly decisionTime: string }
  | { readonly state: 'FIELD_MISSING'; readonly decisionTime: string };

export type DecisionInputIneligibilityReason =
  | 'USE_NOT_DECISION_INPUT'
  | 'RESEARCH_USE_DENIED'
  | 'HISTORICAL_DECISION_FORBIDDEN'
  | 'FIELD_MISSING'
  | 'EVENT_TIME_UNPROVABLE'
  | 'AVAILABLE_AT_UNPROVABLE'
  | 'NOT_YET_AVAILABLE'
  | 'CURRENCY_CONTEXT_NOT_FOUND'
  | 'CURRENCY_CONTEXT_MISSING'
  | 'CURRENCY_CONTEXT_NULL'
  | 'CURRENCY_CONTEXT_HISTORICAL_DECISION_FORBIDDEN'
  | 'CURRENCY_CONTEXT_EVENT_TIME_UNPROVABLE'
  | 'CURRENCY_CONTEXT_AVAILABLE_AT_UNPROVABLE'
  | 'CURRENCY_CONTEXT_NOT_YET_AVAILABLE';

export type DecisionInputEligibility =
  | { readonly eligible: true; readonly reason: 'ELIGIBLE'; readonly visibility: PointInTimeVisibility }
  | { readonly eligible: false; readonly reason: DecisionInputIneligibilityReason; readonly visibility: PointInTimeVisibility };

function eligibilityViolation(reason: string): never {
  throw new Error(`PHASE_9C_POINT_IN_TIME_INVALID:${reason}`);
}

function decisionTimestamp(value: unknown): string {
  if (typeof value !== 'string') eligibilityViolation('DECISION_TIME');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) eligibilityViolation('DECISION_TIME');
  return value;
}

export function evaluatePointInTimeVisibility(
  field: CanonicalPointInTimeField,
  decisionTime: string,
): PointInTimeVisibility {
  const decision = decisionTimestamp(decisionTime);
  if (field.presence.state === 'MISSING') return { state: 'FIELD_MISSING', decisionTime: decision };
  if (field.availabilityEvidence.state !== 'KNOWN') return { state: 'UNPROVABLE', decisionTime: decision };
  const availableAt = field.availabilityEvidence.value;
  return Date.parse(availableAt) <= Date.parse(decision)
    ? { state: 'VISIBLE', availableAt, decisionTime: decision }
    : { state: 'NOT_YET_AVAILABLE', availableAt, decisionTime: decision };
}

function eventTimeIsUsable(field: CanonicalPointInTimeField): boolean {
  return field.eventTimeRequirement === 'NOT_APPLICABLE' || field.eventTimeEvidence.state === 'KNOWN';
}

function currencyContextReason(
  record: CanonicalPointInTimeRecord,
  field: CanonicalPointInTimeField,
  decisionTime: string,
): DecisionInputIneligibilityReason | null {
  if (typeof field.unit !== 'object' || field.unit.kind !== 'CURRENCY') return null;
  const currencyFieldId = field.unit.currencyFieldId;
  const context = record.fields.find((candidate) => candidate.fieldId === currencyFieldId);
  if (context === undefined) return 'CURRENCY_CONTEXT_NOT_FOUND';
  if (context.presence.state === 'MISSING') return 'CURRENCY_CONTEXT_MISSING';
  if (context.presence.state === 'NULL') return 'CURRENCY_CONTEXT_NULL';
  if (context.historicalDecisionPolicy !== 'REQUIRES_PROVABLE_AVAILABILITY') {
    return 'CURRENCY_CONTEXT_HISTORICAL_DECISION_FORBIDDEN';
  }
  if (!eventTimeIsUsable(context)) return 'CURRENCY_CONTEXT_EVENT_TIME_UNPROVABLE';
  const visibility = evaluatePointInTimeVisibility(context, decisionTime);
  if (visibility.state === 'NOT_YET_AVAILABLE') return 'CURRENCY_CONTEXT_NOT_YET_AVAILABLE';
  if (visibility.state !== 'VISIBLE') return 'CURRENCY_CONTEXT_AVAILABLE_AT_UNPROVABLE';
  return null;
}

export function evaluateDecisionInputEligibility(
  record: CanonicalPointInTimeRecord,
  fieldId: string,
  researchUse: ResearchUse,
  decisionTime: string,
): DecisionInputEligibility {
  const field = record.fields.find((candidate) => candidate.fieldId === fieldId);
  if (field === undefined) eligibilityViolation(`FIELD_NOT_FOUND:${fieldId}`);
  const visibility = evaluatePointInTimeVisibility(field, decisionTime);
  if (!DECISION_INPUT_USES.includes(researchUse as (typeof DECISION_INPUT_USES)[number])) {
    return { eligible: false, reason: 'USE_NOT_DECISION_INPUT', visibility };
  }
  if (field.historicalDecisionPolicy !== 'REQUIRES_PROVABLE_AVAILABILITY') {
    return { eligible: false, reason: 'HISTORICAL_DECISION_FORBIDDEN', visibility };
  }
  if (field.researchUsePolicy[researchUse] !== 'ALLOW') {
    return { eligible: false, reason: 'RESEARCH_USE_DENIED', visibility };
  }
  if (field.presence.state === 'MISSING') {
    return { eligible: false, reason: 'FIELD_MISSING', visibility };
  }
  if (!eventTimeIsUsable(field)) {
    return { eligible: false, reason: 'EVENT_TIME_UNPROVABLE', visibility };
  }
  if (visibility.state === 'UNPROVABLE') {
    return { eligible: false, reason: 'AVAILABLE_AT_UNPROVABLE', visibility };
  }
  if (visibility.state === 'NOT_YET_AVAILABLE') {
    return { eligible: false, reason: 'NOT_YET_AVAILABLE', visibility };
  }
  if (visibility.state === 'FIELD_MISSING') {
    return { eligible: false, reason: 'FIELD_MISSING', visibility };
  }
  const contextReason = currencyContextReason(record, field, decisionTime);
  if (contextReason !== null) return { eligible: false, reason: contextReason, visibility };
  return { eligible: true, reason: 'ELIGIBLE', visibility };
}

export const PHASE_9C_POINT_IN_TIME_ELIGIBILITY_BOUNDARY = Object.freeze({
  explicitDecisionTimeRequired: true,
  visibilityRule: 'available_at <= decision_time',
  eventTimeIsAvailabilityAuthority: false,
  ingestedAtIsAvailabilityAuthority: false,
  staticDatasetEligibility: false,
  productionAuthority: false,
} as const);
