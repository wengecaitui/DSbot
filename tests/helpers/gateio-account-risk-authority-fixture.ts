import type { TradingKernel } from '../../src/kernel/TradingKernel';
import {
  accountRiskMetricPolicyDigest,
  gateIoAccountObservationDigest,
} from '../../src/accounting/gateio-account-risk-metrics';
import {
  ACCOUNT_RISK_METRIC_POLICY_ACTIVATED,
  ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION,
  CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1,
  GATEIO_ACCOUNT_FACT_OBSERVED,
  GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION,
  type AccountRiskMetricPolicy,
  type GateIoDurableAccountObservation,
} from '../../src/accounting/gateio-account-risk-metrics-types';
import { gateIoEconomicFactDigest } from '../../src/accounting/gateio-economic-ledger';
import { GATEIO_ECONOMIC_EVENT_RECORDED } from '../../src/accounting/gateio-economic-ledger-types';
import { normalizeGateIoAccountBookPage } from '../../src/accounting/gateio-economic-truth';
import { riskMandateDigest } from '../../src/risk/risk-mandate';
import {
  RISK_ACTION_EFFECTS,
  RISK_MANDATE_ACTIVATED,
  RISK_MANDATE_SCHEMA_VERSION,
  type RiskMandateV1,
} from '../../src/risk/risk-mandate-types';

function observation(accountId: string, observedAt: number): GateIoDurableAccountObservation {
  return Object.freeze({
    schemaVersion: GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION,
    exchange: 'gateio', settle: 'USDT', accountId, currency: 'USDT',
    marginMode: 0, accountModeQualification: 'SUPPORTED_CLASSIC',
    totalExact: '1000', availableExact: '900', unrealisedPnlExact: '0',
    observedAt, serverTime: observedAt,
    source: 'gateio-usdt-futures-read', sourceSchemaVersion: 'gateio-l1a-v1',
    captureProvenance: Object.freeze({
      kind: 'GATEIO_AUTHENTICATED_ACCOUNT_READ',
      endpoint: '/api/v4/futures/usdt/accounts', foundationFreshness: 'FRESH',
    }),
  });
}

/** Test-only durable facts. No production code obtains human authority from this helper. */
export function seedGateIoAccountRiskAuthority(
  kernel: TradingKernel,
  input: Readonly<{ accountId: string; now: number }>,
): Readonly<{ policy: AccountRiskMetricPolicy; mandate: RiskMandateV1 }> {
  const boundary = Math.floor(input.now / 86_400_000) * 86_400_000;
  const policy: AccountRiskMetricPolicy = Object.freeze({
    schemaVersion: ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION,
    exchange: 'gateio', settle: 'USDT', accountId: input.accountId,
    policyId: `test-risk-policy-${input.accountId}`, policyVersion: 1,
    effectiveAt: boundary - 60_000,
    accountValueFormula: CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1,
    accountObservationMaxAgeMs: 30_000,
    dayBoundary: Object.freeze({ timezone: 'UTC', localBoundaryTime: '00:00:00' }),
  });
  const policyDigest = accountRiskMetricPolicyDigest(policy);
  const fact = normalizeGateIoAccountBookPage([{
    id: `test-economic-${input.accountId}`, time: boundary / 1_000,
    type: 'fee', change: '-0.01', balance: '1000',
  }], { observedAt: input.now, pageRequest: { limit: 100, offset: 0 } })[0]!;
  kernel.publish(GATEIO_ECONOMIC_EVENT_RECORDED, {
    fact, factDigest: gateIoEconomicFactDigest(fact),
  });
  kernel.publish(ACCOUNT_RISK_METRIC_POLICY_ACTIVATED, { policy, policyDigest });
  for (const observedAt of [boundary - 1_000, boundary + 1_000, input.now]) {
    const value = observation(input.accountId, observedAt);
    kernel.publish(GATEIO_ACCOUNT_FACT_OBSERVED, {
      observation: value, observationDigest: gateIoAccountObservationDigest(value),
    });
  }
  const mandate: RiskMandateV1 = Object.freeze({
    schemaVersion: RISK_MANDATE_SCHEMA_VERSION,
    exchange: 'gateio', settle: 'USDT', accountId: input.accountId,
    mandateId: `test-human-mandate-${input.accountId}`, mandateVersion: 1,
    effectiveAt: boundary - 30_000, expiresAt: input.now + 3_600_000,
    enabled: true,
    allowedSymbols: Object.freeze(['ETH/USDT']),
    allowedActionEffects: RISK_ACTION_EFFECTS,
    limits: Object.freeze({
      maxSinglePositionFractionExact: '1',
      maxSinglePositionNotionalExact: '1000000',
      maxDailyEquityLossExact: '1000000',
      maxDrawdownFractionExact: '1',
    }),
    metricPolicyBinding: Object.freeze({
      accountRiskSnapshotSchemaVersion: 'account-risk-snapshot-v1',
      metricPolicySchemaVersion: ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION,
      metricPolicyId: policy.policyId, metricPolicyVersion: policy.policyVersion,
      metricPolicyDigest: policyDigest,
    }),
    provenance: Object.freeze({
      authorityType: 'HUMAN_OPERATOR', actorId: 'test-human-operator',
      approvalReference: `test-change-${input.accountId}`,
      approvedAt: boundary - 40_000, source: 'test-operator-control-plane',
    }),
  });
  kernel.publish(RISK_MANDATE_ACTIVATED, {
    mandate, mandateDigest: riskMandateDigest(mandate),
  });
  return Object.freeze({ policy, mandate });
}
