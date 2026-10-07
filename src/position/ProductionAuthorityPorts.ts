import type { TradingEventPayloadMap, TradingEventType } from '../events/TradingEvent';
import type { EventJournalPort } from '../kernel/EventJournalPort';
import type { PublishResult, TradingKernel } from '../kernel/TradingKernel';

/** Explicit composition ingress, not a general event publisher. */
export const PRODUCTION_EVIDENCE_EVENTS = Object.freeze([
  'position.baseline.confirmed', 'market.ticker.updated', 'research.bias.updated',
  'policy.snapshot.published', 'GATEIO_ECONOMIC_EVENT_RECORDED',
  'GATEIO_ACCOUNT_FACT_OBSERVED', 'ACCOUNT_RISK_METRIC_POLICY_ACTIVATED',
  'order.created', 'order.submitted', 'order.submission.unknown',
] as const satisfies readonly TradingEventType[]);
export type ProductionEvidenceEvent = typeof PRODUCTION_EVIDENCE_EVENTS[number];
export interface ProductionEvidencePublisher {
  publish<T extends ProductionEvidenceEvent>(type: T, payload: TradingEventPayloadMap[T], eventId?: string): PublishResult<T>;
}
export interface RiskMandateOperatorAuthority {
  activate(payload: TradingEventPayloadMap['RISK_MANDATE_ACTIVATED']): PublishResult<'RISK_MANDATE_ACTIVATED'>;
  revoke(payload: TradingEventPayloadMap['RISK_MANDATE_REVOKED']): PublishResult<'RISK_MANDATE_REVOKED'>;
}
export interface ProductionKernelReadView {
  subscribe: TradingKernel['subscribe'];
  journal(): Pick<EventJournalPort, 'getByEventId' | 'readFromLogicalSequence'> & { readonly lastSequence: number };
}

/** Constructed only with the private kernel; there is no spine-to-capability lookup. */
export function createProductionAuthorityPorts(kernel: TradingKernel, identity: Readonly<{ exchange: string; accountId: string }>) {
  const evidence: ProductionEvidencePublisher = Object.freeze({
    publish<T extends ProductionEvidenceEvent>(type: T, payload: TradingEventPayloadMap[T], eventId?: string) {
      if (!(PRODUCTION_EVIDENCE_EVENTS as readonly string[]).includes(type))
        throw new Error('PRODUCTION_EVIDENCE_EVENT_NOT_PERMITTED');
      return kernel.publish(type, payload, eventId);
    },
  });
  function checkIdentity(value: { exchange: string; settle: string; accountId: string }) {
    if (identity.exchange !== 'gateio' || value.exchange !== identity.exchange
        || value.settle !== 'USDT' || value.accountId !== identity.accountId)
      throw new Error('OPERATOR_AUTHORITY_IDENTITY_MISMATCH');
  }
  const operator: RiskMandateOperatorAuthority = Object.freeze({
    activate(payload: TradingEventPayloadMap['RISK_MANDATE_ACTIVATED']) {
      checkIdentity(payload.mandate);
      return kernel.publish('RISK_MANDATE_ACTIVATED', payload);
    },
    revoke(payload: TradingEventPayloadMap['RISK_MANDATE_REVOKED']) {
      checkIdentity(payload.revocation);
      return kernel.publish('RISK_MANDATE_REVOKED', payload);
    },
  });
  // Detached journal observations must never permit mutation of the replay cache.
  const readJournal = Object.freeze({
    getByEventId(id: string) { return structuredClone(kernel.journal().getByEventId(id)); },
    readFromLogicalSequence(sequence: number, limit?: number) {
      return structuredClone(kernel.journal().readFromLogicalSequence(sequence, limit));
    },
    get lastSequence() { return (kernel.journal() as { lastSequence?: number }).lastSequence ?? 0; },
  });
  const read: ProductionKernelReadView = Object.freeze({
    subscribe: kernel.subscribe,
    journal: () => readJournal,
  });
  return Object.freeze({ evidence, operator, read });
}
