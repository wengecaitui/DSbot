import type { TradingKernel } from '../kernel/TradingKernel';
import type { Projector } from '../recovery/ReplayCoordinator';
import {
  createGateIoAccountMetricFoundation,
  createGateIoDurableAccountRiskMetricProjector,
} from '../accounting/gateio-account-risk-metrics';
import type { GateIoAccountRiskIdentity } from '../accounting/gateio-account-risk-metrics-types';
import { createGateIoEconomicLedger } from '../accounting/gateio-economic-ledger';
import { projectGateIoEconomicState } from '../accounting/gateio-economic-projection';
import { buildAccountRiskSnapshot } from './account-risk-snapshot';
import { buildAccountRiskAuthorizationContext } from './account-risk-authorization-context';
import type { AccountRiskAuthorizationContext } from './account-risk-authorization-context-types';
import { createRiskMandateProjector } from './risk-mandate';
import type { RiskMandateAccountIdentity } from './risk-mandate-types';
import { createPreTradeRiskDecisionReceiptStore } from './pretrade-decision-receipt';
import type { PreTradeRiskDecisionReceiptStore } from './pretrade-decision-receipt-types';

export interface GateIoAccountRiskRuntime {
  readonly identity: GateIoAccountRiskIdentity;
  readonly economicLedger: ReturnType<typeof createGateIoEconomicLedger>;
  readonly metricFoundation: ReturnType<typeof createGateIoAccountMetricFoundation>;
  readonly metricProjector: ReturnType<typeof createGateIoDurableAccountRiskMetricProjector>;
  readonly mandateProjector: ReturnType<typeof createRiskMandateProjector>;
  readonly decisionReceipts: PreTradeRiskDecisionReceiptStore;
  compose(evaluationTime: number): AccountRiskAuthorizationContext;
  projectorBindings(): ReadonlyMap<string, readonly Projector[]>;
  digests(): Readonly<Record<string, string>>;
}

function cloneFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  function freeze(entry: unknown): void {
    if (entry === null || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
    Object.freeze(entry);
  }
  freeze(cloned);
  return cloned;
}

/**
 * Runtime composition over existing durable R1/R2/R3 projectors. The journal
 * remains the authority; this object only rebuilds deterministic views.
 */
export function createGateIoAccountRiskRuntime(input: Readonly<{
  accountId: string;
  kernel: TradingKernel;
}>): GateIoAccountRiskRuntime {
  const identity = cloneFreeze<GateIoAccountRiskIdentity>({
    exchange: 'gateio', settle: 'USDT', accountId: input.accountId,
  });
  const economicLedger = createGateIoEconomicLedger();
  const metricFoundation = createGateIoAccountMetricFoundation();
  const metricProjector = createGateIoDurableAccountRiskMetricProjector();
  const mandateProjector = createRiskMandateProjector(identity as RiskMandateAccountIdentity);
  const decisionReceipts = createPreTradeRiskDecisionReceiptStore();

  input.kernel.subscribe('GATEIO_ECONOMIC_EVENT_RECORDED', (event) => {
    economicLedger.apply(event);
    metricProjector.apply(event);
  });
  input.kernel.subscribe('GATEIO_ACCOUNT_FACT_OBSERVED', (event) => {
    metricFoundation.apply(event);
    metricProjector.apply(event);
  });
  input.kernel.subscribe('ACCOUNT_RISK_METRIC_POLICY_ACTIVATED', (event) => {
    metricFoundation.apply(event);
    metricProjector.apply(event);
  });
  input.kernel.subscribe('RISK_MANDATE_ACTIVATED', (event) => { mandateProjector.apply(event); });
  input.kernel.subscribe('RISK_MANDATE_REVOKED', (event) => { mandateProjector.apply(event); });
  input.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', (event) => {
    decisionReceipts.apply(event);
  });

  function compose(evaluationTime: number): AccountRiskAuthorizationContext {
    const observation = metricFoundation.latestObservationAt(identity, evaluationTime);
    const policy = metricFoundation.activePolicyAt(identity, evaluationTime);
    const metrics = metricProjector.snapshot(identity, evaluationTime);
    const economicProjection = projectGateIoEconomicState(economicLedger.snapshot());
    const snapshot = buildAccountRiskSnapshot({
      expectedIdentity: identity,
      accountObservation: observation,
      metricPolicy: policy,
      riskMetrics: metrics,
      economicProjection,
      evaluationTime,
    });
    return buildAccountRiskAuthorizationContext({
      snapshot,
      mandateResolution: mandateProjector.resolve(evaluationTime),
      evaluationTime,
    });
  }

  function projectorBindings(): ReadonlyMap<string, readonly Projector[]> {
    return new Map<string, readonly Projector[]>([
      ['GATEIO_ECONOMIC_EVENT_RECORDED', [economicLedger, metricProjector]],
      ['GATEIO_ACCOUNT_FACT_OBSERVED', [metricFoundation, metricProjector]],
      ['ACCOUNT_RISK_METRIC_POLICY_ACTIVATED', [metricFoundation, metricProjector]],
      ['RISK_MANDATE_ACTIVATED', [mandateProjector]],
      ['RISK_MANDATE_REVOKED', [mandateProjector]],
      ['PRETRADE_RISK_DECISION_RECORDED', [decisionReceipts]],
    ]);
  }

  function digests(): Readonly<Record<string, string>> {
    return Object.freeze({
      gateIoEconomicLedger: economicLedger.digest(),
      gateIoAccountMetricFoundation: metricFoundation.digest(),
      gateIoAccountRiskMetrics: metricProjector.digest(),
      riskMandate: mandateProjector.digest(),
      pretradeDecisionReceipts: decisionReceipts.digest(),
    });
  }

  return Object.freeze({
    identity, economicLedger, metricFoundation, metricProjector, mandateProjector,
    decisionReceipts, compose, projectorBindings, digests,
  });
}
