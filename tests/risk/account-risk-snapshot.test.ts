import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accountRiskMetricPolicyDigest,
  createGateIoDurableAccountRiskMetricProjector,
  gateIoAccountObservationDigest,
} from '../../src/accounting/gateio-account-risk-metrics';
import {
  ACCOUNT_RISK_METRIC_POLICY_ACTIVATED,
  ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION,
  CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1,
  GATEIO_ACCOUNT_FACT_OBSERVED,
  GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION,
  type AccountRiskMetricPolicy,
  type GateIoAccountRiskIdentity,
  type GateIoDurableAccountObservation,
  type GateIoDurableAccountRiskMetricsSnapshot,
} from '../../src/accounting/gateio-account-risk-metrics-types';
import {
  createGateIoEconomicLedger,
  gateIoEconomicFactDigest,
} from '../../src/accounting/gateio-economic-ledger';
import { GATEIO_ECONOMIC_EVENT_RECORDED } from '../../src/accounting/gateio-economic-ledger-types';
import { projectGateIoEconomicState } from '../../src/accounting/gateio-economic-projection';
import {
  GATEIO_TRACKED_EXECUTION_EVIDENCE_SCHEMA_VERSION,
  type TrackedExecutionEconomicEvidence,
} from '../../src/accounting/gateio-economic-projection-types';
import { normalizeGateIoAccountBookPage } from '../../src/accounting/gateio-economic-truth';
import type { GateIoCanonicalEconomicEvent } from '../../src/accounting/gateio-economic-truth-types';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import type { KernelEventEnvelope } from '../../src/kernel/KernelEventEnvelope';
import { buildAccountRiskSnapshot } from '../../src/risk/account-risk-snapshot';
import { ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION } from '../../src/risk/account-risk-snapshot-types';

const DAY_BOUNDARY = Date.UTC(2027, 0, 15, 0, 0, 0);
const IDENTITY: GateIoAccountRiskIdentity = Object.freeze({
  exchange: 'gateio', settle: 'USDT', accountId: 'gate-account-r2c',
});

function observation(
  observedAt: number,
  totalExact: string,
  overrides: Partial<GateIoDurableAccountObservation> = {},
): GateIoDurableAccountObservation {
  const marginMode = overrides.marginMode === undefined ? 0 : overrides.marginMode;
  return Object.freeze({
    schemaVersion: GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION,
    ...IDENTITY,
    currency: 'USDT',
    marginMode,
    accountModeQualification: marginMode === 0
      ? 'SUPPORTED_CLASSIC' : marginMode === null
        ? 'UNKNOWN_ACCOUNT_MODE' : 'UNSUPPORTED_ACCOUNT_MODE',
    totalExact,
    availableExact: '80.000000000000000009',
    unrealisedPnlExact: '0',
    observedAt,
    serverTime: observedAt - 10,
    source: 'gateio-usdt-futures-read',
    sourceSchemaVersion: 'gateio-l1a-v1',
    captureProvenance: Object.freeze({
      kind: 'GATEIO_AUTHENTICATED_ACCOUNT_READ',
      endpoint: '/api/v4/futures/usdt/accounts',
      foundationFreshness: 'FRESH',
    }),
    ...overrides,
  });
}

function policy(overrides: Partial<AccountRiskMetricPolicy> = {}): AccountRiskMetricPolicy {
  return Object.freeze({
    schemaVersion: ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION,
    ...IDENTITY,
    policyId: 'gate-r2c-account-value',
    policyVersion: 1,
    effectiveAt: DAY_BOUNDARY - 86_400_000,
    accountValueFormula: CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1,
    accountObservationMaxAgeMs: 30_000,
    dayBoundary: Object.freeze({ timezone: 'UTC', localBoundaryTime: '00:00:00' }),
    ...overrides,
  });
}

function economicFact(input: {
  id?: string;
  type?: string;
  tradeId?: string;
  change?: string;
} = {}): GateIoCanonicalEconomicEvent {
  const raw: Record<string, unknown> = {
    id: input.id ?? 'r2c-fee-1',
    time: DAY_BOUNDARY / 1_000,
    type: input.type ?? 'fee',
    change: input.change ?? '-0.01',
    balance: '100',
  };
  if (input.tradeId !== undefined) raw.trade_id = input.tradeId;
  const result = normalizeGateIoAccountBookPage([raw], {
    observedAt: DAY_BOUNDARY,
    pageRequest: { limit: 100, offset: 0 },
  })[0];
  assert.ok(result);
  return result;
}

function trackedEvidence(tradeIds: readonly string[]): TrackedExecutionEconomicEvidence {
  return Object.freeze({
    schemaVersion: GATEIO_TRACKED_EXECUTION_EVIDENCE_SCHEMA_VERSION,
    trackedTradeIds: Object.freeze([...tradeIds]),
    evidenceCapturedAt: DAY_BOUNDARY + 5_000,
    provenance: Object.freeze({ source: 'r2c-focused-test' }),
    captureScope: 'SUFFICIENT_FOR_TRACKED_TRADES',
  });
}

interface ScenarioOptions {
  readonly partialDay?: boolean;
  readonly noEconomicFacts?: boolean;
  readonly economicType?: string;
  readonly tradeId?: string;
  readonly currentObservation?: GateIoDurableAccountObservation;
  readonly configuredPolicy?: AccountRiskMetricPolicy;
}

function scenario(options: ScenarioOptions = {}) {
  const projector = createGateIoDurableAccountRiskMetricProjector();
  const ledger = createGateIoEconomicLedger();
  const envelopes: KernelEventEnvelope[] = [];
  let tick = 0;
  const kernel = createTradingKernel({
    exchange: 'gateio', clock: { now: () => DAY_BOUNDARY + (++tick) },
  });
  const configured = options.configuredPolicy ?? policy();
  const publish = (type: Parameters<typeof kernel.publish>[0], payload: unknown) => {
    const envelope = kernel.publish(type, payload).envelope;
    projector.apply(envelope);
    envelopes.push(envelope);
    return envelope;
  };
  if (!options.noEconomicFacts) {
    const fact = economicFact({ type: options.economicType, tradeId: options.tradeId });
    const envelope = publish(GATEIO_ECONOMIC_EVENT_RECORDED, {
      fact, factDigest: gateIoEconomicFactDigest(fact),
    });
    ledger.apply(envelope);
  }
  publish(ACCOUNT_RISK_METRIC_POLICY_ACTIVATED, {
    policy: configured,
    policyDigest: accountRiskMetricPolicyDigest(configured),
  });
  if (!options.partialDay) {
    const before = observation(DAY_BOUNDARY - 1_000, '100');
    publish(GATEIO_ACCOUNT_FACT_OBSERVED, {
      observation: before, observationDigest: gateIoAccountObservationDigest(before),
    });
    const after = observation(DAY_BOUNDARY + 1_000, '100');
    publish(GATEIO_ACCOUNT_FACT_OBSERVED, {
      observation: after, observationDigest: gateIoAccountObservationDigest(after),
    });
    const high = observation(DAY_BOUNDARY + 2_000, '125');
    publish(GATEIO_ACCOUNT_FACT_OBSERVED, {
      observation: high, observationDigest: gateIoAccountObservationDigest(high),
    });
  }
  const current = options.currentObservation ?? observation(
    options.partialDay ? DAY_BOUNDARY + 12 * 60 * 60_000 : DAY_BOUNDARY + 3_000,
    '100',
  );
  publish(GATEIO_ACCOUNT_FACT_OBSERVED, {
    observation: current, observationDigest: gateIoAccountObservationDigest(current),
  });
  return { projector, ledger, envelopes, current, configured, kernel };
}

function snapshotInput(
  state: ReturnType<typeof scenario>,
  evaluationTime = state.current.observedAt,
  evidence?: TrackedExecutionEconomicEvidence,
) {
  return {
    expectedIdentity: IDENTITY,
    accountObservation: state.current,
    metricPolicy: state.configured,
    riskMetrics: state.projector.snapshot(IDENTITY, evaluationTime),
    economicProjection: projectGateIoEconomicState(state.ledger.snapshot(), evidence),
    evaluationTime,
  } as const;
}

function withMetrics(
  base: ReturnType<typeof snapshotInput>,
  metrics: GateIoDurableAccountRiskMetricsSnapshot,
) {
  return { ...base, riskMetrics: metrics };
}

describe('R2C AccountRiskSnapshot foundation', () => {
  it('builds a fully qualified account-state snapshot', () => {
    const result = buildAccountRiskSnapshot(snapshotInput(scenario()));
    assert.equal(result.schemaVersion, ACCOUNT_RISK_SNAPSHOT_SCHEMA_VERSION);
    assert.equal(result.status, 'QUALIFIED');
    assert.equal(result.account.derivedAccountValue.valueExact, '100');
    assert.equal(result.daily.dailyEquityLoss.valueExact, '0');
    assert.equal(result.drawdown.absolute.valueExact, '25');
  });

  it('preserves exact monetary strings without binary-float conversion', () => {
    const current = observation(DAY_BOUNDARY + 3_000, '100.000000000000000001', {
      availableExact: '80.000000000000000009',
      unrealisedPnlExact: '-0.000000000000000001',
    });
    const result = buildAccountRiskSnapshot(snapshotInput(scenario({ currentObservation: current })));
    assert.equal(result.account.derivedAccountValue.valueExact, '100');
    assert.equal(result.account.available.valueExact, '80.000000000000000009');
    assert.equal(result.account.unrealisedPnl.valueExact, '-0.000000000000000001');
  });

  it('produces a deterministic digest from canonical semantic fields', () => {
    const input = snapshotInput(scenario());
    const first = buildAccountRiskSnapshot(input);
    const second = buildAccountRiskSnapshot(input);
    assert.equal(first.snapshotDigest, second.snapshotDigest);
    assert.deepEqual(first, second);
    assert.match(first.snapshotDigest, /^[0-9a-f]{64}$/);
  });

  it('same inputs and same explicit evaluation time always produce the same digest', () => {
    const state = scenario();
    const input = snapshotInput(state, DAY_BOUNDARY + 3_000);
    assert.equal(
      buildAccountRiskSnapshot(input).snapshotDigest,
      buildAccountRiskSnapshot({ ...input }).snapshotDigest,
    );
  });

  it('crossing the freshness boundary produces a stale snapshot and a different digest', () => {
    const state = scenario();
    const fresh = buildAccountRiskSnapshot(snapshotInput(state));
    const stale = buildAccountRiskSnapshot(snapshotInput(
      state, state.current.observedAt + state.configured.accountObservationMaxAgeMs + 1,
    ));
    assert.equal(stale.status, 'STALE');
    assert.notEqual(stale.snapshotDigest, fresh.snapshotDigest);
  });

  it('has no wall-clock dependency inside snapshot construction', () => {
    const original = Date.now;
    Date.now = () => { throw new Error('Date.now must not be called'); };
    try {
      assert.equal(buildAccountRiskSnapshot(snapshotInput(scenario())).status, 'QUALIFIED');
    } finally {
      Date.now = original;
    }
  });

  it('fails closed on account identity mismatch', () => {
    const input = snapshotInput(scenario());
    const result = buildAccountRiskSnapshot({
      ...input,
      expectedIdentity: { ...IDENTITY, accountId: 'other-account' },
    });
    assert.equal(result.status, 'ACCOUNT_IDENTITY_INVALID');
    assert.equal(result.account.derivedAccountValue.valueExact, null);
  });

  it('fails closed on unsupported account mode', () => {
    const state = scenario({
      currentObservation: observation(DAY_BOUNDARY + 3_000, '100', { marginMode: 1 }),
    });
    const result = buildAccountRiskSnapshot(snapshotInput(state));
    assert.equal(result.status, 'ACCOUNT_MODE_UNSUPPORTED');
    assert.equal(result.account.available.availability, 'UNAVAILABLE');
  });

  it('preserves partial-day state while retaining a qualified current account value', () => {
    const result = buildAccountRiskSnapshot(snapshotInput(scenario({ partialDay: true })));
    assert.equal(result.status, 'PARTIAL_DAY');
    assert.equal(result.account.derivedAccountValue.valueExact, '100');
    assert.equal(result.daily.baselineStatus, 'PARTIAL_DAY');
  });

  it('never promotes an unavailable daily baseline to zero', () => {
    const result = buildAccountRiskSnapshot(snapshotInput(scenario({ partialDay: true })));
    assert.equal(result.daily.baseline.valueExact, null);
    assert.equal(result.daily.baseline.availability, 'UNAVAILABLE');
  });

  it('includes R2B2 daily equity loss without recomputation', () => {
    const state = scenario({
      currentObservation: observation(DAY_BOUNDARY + 3_000, '90.000000000000000001'),
    });
    const result = buildAccountRiskSnapshot(snapshotInput(state));
    assert.equal(result.daily.dailyEquityLoss.valueExact, '9.999999999999999999');
    assert.equal(result.daily.dailyEquityLoss.availability, 'AVAILABLE');
  });

  it('includes R2B2 epoch high-water and drawdown fields', () => {
    const result = buildAccountRiskSnapshot(snapshotInput(scenario()));
    assert.equal(result.drawdown.highWater.valueExact, '125');
    assert.equal(result.drawdown.absolute.valueExact, '25');
    assert.equal(result.drawdown.fraction.valueExact, '0.2');
    assert.equal(result.drawdown.fractionScale, 18);
  });

  it('stale current observation invalidates all current account values', () => {
    const state = scenario();
    const result = buildAccountRiskSnapshot(snapshotInput(
      state, state.current.observedAt + 30_001,
    ));
    assert.equal(result.status, 'STALE');
    assert.equal(result.account.derivedAccountValue.valueExact, null);
    assert.equal(result.account.available.valueExact, null);
    assert.equal(result.account.unrealisedPnl.valueExact, null);
  });

  it('treats explicitly stale Gate capture provenance as STALE', () => {
    const staleCapture = observation(DAY_BOUNDARY + 3_000, '100', {
      captureProvenance: Object.freeze({
        kind: 'GATEIO_AUTHENTICATED_ACCOUNT_READ',
        endpoint: '/api/v4/futures/usdt/accounts',
        foundationFreshness: 'STALE',
      }),
    });
    const result = buildAccountRiskSnapshot(snapshotInput(scenario({
      currentObservation: staleCapture,
    })));
    assert.equal(result.status, 'STALE');
    assert.equal(result.account.derivedAccountValue.valueExact, null);
  });

  it('an R2B1 observation identity conflict remains fail-closed', () => {
    const state = scenario();
    const conflicting = observation(state.current.observedAt, '101');
    const envelope = state.kernel.publish(GATEIO_ACCOUNT_FACT_OBSERVED, {
      observation: conflicting,
      observationDigest: gateIoAccountObservationDigest(conflicting),
    }).envelope;
    assert.throws(() => state.projector.apply(envelope), /GATEIO_ACCOUNT_OBSERVATION_IDENTITY_CONFLICT/);
    const result = buildAccountRiskSnapshot(snapshotInput(state));
    assert.equal(result.status, 'ACCOUNT_IDENTITY_INVALID');
    assert.equal(result.drawdown.highWater.availability, 'HISTORICAL_ONLY');
  });

  it('UNCLASSIFIED economic activity fails closed', () => {
    const result = buildAccountRiskSnapshot(snapshotInput(scenario({ economicType: 'mystery' })));
    assert.equal(result.status, 'UNCLASSIFIED_ECONOMIC_ACTIVITY');
    assert.equal(result.economicHealth.unclassifiedEventCount, 1);
  });

  it('R1 economic identity conflict fails closed independently of account identity', () => {
    const state = scenario();
    const conflicting = economicFact({ id: 'r2c-fee-1', change: '-9.99' });
    const envelope = state.kernel.publish(GATEIO_ECONOMIC_EVENT_RECORDED, {
      fact: conflicting, factDigest: gateIoEconomicFactDigest(conflicting),
    }).envelope;
    state.projector.apply(envelope);
    assert.throws(() => state.ledger.apply(envelope), /GATEIO_ECONOMIC_IDENTITY_CONFLICT/);
    const result = buildAccountRiskSnapshot(snapshotInput(state));
    assert.equal(result.status, 'ECONOMIC_CONFLICT');
    assert.equal(result.economicHealth.identityConflictCount, 1);
    assert.equal(result.drawdown.highWater.availability, 'HISTORICAL_ONLY');
  });

  it('an unusable economic projection fails closed', () => {
    const result = buildAccountRiskSnapshot(snapshotInput(scenario({ noEconomicFacts: true })));
    assert.equal(result.status, 'ECONOMIC_PROJECTION_UNUSABLE');
    assert.equal(result.account.derivedAccountValue.valueExact, null);
  });

  it('tracked attribution COMPLETE never upgrades accountActivityReconciled', () => {
    const state = scenario({ tradeId: 'tracked-r2c' });
    const result = buildAccountRiskSnapshot(snapshotInput(
      state, state.current.observedAt, trackedEvidence(['tracked-r2c']),
    ));
    assert.equal(result.economicHealth.trackedExecutionAttributionStatus, 'COMPLETE');
    assert.equal(result.economicHealth.accountActivityReconciled, 'UNAVAILABLE');
  });

  it('zero observed untracked activity still never proves account-wide reconciliation', () => {
    const state = scenario({ tradeId: 'tracked-zero-untracked' });
    const result = buildAccountRiskSnapshot(snapshotInput(
      state, state.current.observedAt, trackedEvidence(['tracked-zero-untracked']),
    ));
    assert.equal(result.economicHealth.untrackedObservedActivityCount, 0);
    assert.equal(result.economicHealth.accountActivityReconciled, 'UNAVAILABLE');
  });

  it('rejects mixed policy versions instead of selecting the newest object', () => {
    const input = snapshotInput(scenario());
    const result = buildAccountRiskSnapshot({
      ...input,
      metricPolicy: policy({ policyVersion: 2, effectiveAt: DAY_BOUNDARY - 1_000 }),
    });
    assert.equal(result.status, 'MIXED_VERSION_STATE');
    assert.ok(result.reasons.includes('MIXED_POLICY_VERSION'));
  });

  it('rejects mixed account IDs across observation, policy and expected identity', () => {
    const input = snapshotInput(scenario());
    const result = buildAccountRiskSnapshot({
      ...input,
      accountObservation: { ...input.accountObservation!, accountId: 'other-account' },
    });
    assert.equal(result.status, 'ACCOUNT_IDENTITY_INVALID');
  });

  it('rejects mixed accounting-day context', () => {
    const input = snapshotInput(scenario());
    assert.ok(input.riskMetrics.baseline);
    const metrics = {
      ...input.riskMetrics,
      baseline: { ...input.riskMetrics.baseline, accountingDayId: 'different-day' },
    } as GateIoDurableAccountRiskMetricsSnapshot;
    const result = buildAccountRiskSnapshot(withMetrics(input, metrics));
    assert.equal(result.status, 'MIXED_VERSION_STATE');
    assert.ok(result.reasons.includes('MIXED_ACCOUNTING_DAY_CONTEXT'));
  });

  it('journal-order replay produces an identical snapshot', () => {
    const state = scenario();
    const expected = buildAccountRiskSnapshot(snapshotInput(state));
    const replayedProjector = createGateIoDurableAccountRiskMetricProjector();
    const replayedLedger = createGateIoEconomicLedger();
    for (const envelope of state.envelopes) {
      replayedProjector.apply(envelope);
      if (envelope.type === GATEIO_ECONOMIC_EVENT_RECORDED) replayedLedger.apply(envelope);
    }
    const actual = buildAccountRiskSnapshot({
      ...snapshotInput(state),
      riskMetrics: replayedProjector.snapshot(IDENTITY, state.current.observedAt),
      economicProjection: projectGateIoEconomicState(replayedLedger.snapshot()),
    });
    assert.deepEqual(actual, expected);
  });

  it('restart from the same durable facts preserves the snapshot digest', () => {
    const state = scenario();
    const restarted = createGateIoDurableAccountRiskMetricProjector();
    for (const envelope of state.envelopes) restarted.apply(envelope);
    const expected = buildAccountRiskSnapshot(snapshotInput(state));
    const actual = buildAccountRiskSnapshot({
      ...snapshotInput(state),
      riskMetrics: restarted.snapshot(IDENTITY, state.current.observedAt),
    });
    assert.equal(actual.snapshotDigest, expected.snapshotDigest);
  });

  it('retains historical high-water without presenting it as current authority', () => {
    const state = scenario();
    const result = buildAccountRiskSnapshot(snapshotInput(state, state.current.observedAt + 30_001));
    assert.equal(result.status, 'STALE');
    assert.equal(result.drawdown.highWater.valueExact, '125');
    assert.equal(result.drawdown.highWater.availability, 'HISTORICAL_ONLY');
    assert.equal(result.drawdown.absolute.valueExact, null);
  });

  it('a QUALIFIED snapshot contains no trading authorization or mandate', () => {
    const result = buildAccountRiskSnapshot(snapshotInput(scenario()));
    assert.equal(result.status, 'QUALIFIED');
    assert.equal('authorized' in result, false);
    assert.equal('riskMandate' in result, false);
    assert.equal('tradeIntent' in result, false);
  });

  it('binds source IDs, digests, versions and observed-scope economic provenance', () => {
    const result = buildAccountRiskSnapshot(snapshotInput(scenario()));
    assert.match(result.evaluation.accountObservationId!, /^[0-9a-f]{64}$/);
    assert.match(result.provenance.accountObservationDigest!, /^[0-9a-f]{64}$/);
    assert.match(result.provenance.metricPolicyDigest!, /^[0-9a-f]{64}$/);
    assert.match(result.provenance.riskMetricsDigest, /^[0-9a-f]{64}$/);
    assert.match(result.provenance.economicProjectionDigest, /^[0-9a-f]{64}$/);
    assert.equal(result.provenance.economicHistoryScope, 'OBSERVED_PAGES_ONLY');
    assert.equal(Object.isFrozen(result), true);
  });
});
