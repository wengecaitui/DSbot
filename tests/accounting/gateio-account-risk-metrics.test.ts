import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  accountRiskMetricPolicyDigest,
  activateAccountRiskMetricPolicy,
  createGateIoAccountMetricFoundation,
  createGateIoDurableAccountRiskMetricProjector,
  gateIoAccountObservationDigest,
  gateIoDurableAccountObservationFromTruth,
  projectQualifiedAccountValue,
  recordGateIoAccountObservation,
  validateAccountRiskMetricPolicy,
  validateGateIoAccountFactObservedPayload,
} from '../../src/accounting/gateio-account-risk-metrics';
import { gateIoEconomicFactDigest } from '../../src/accounting/gateio-economic-ledger';
import { GATEIO_ECONOMIC_EVENT_RECORDED } from '../../src/accounting/gateio-economic-ledger-types';
import { normalizeGateIoAccountBookPage } from '../../src/accounting/gateio-economic-truth';
import type { GateIoCanonicalEconomicEvent } from '../../src/accounting/gateio-economic-truth-types';
import {
  ACCOUNT_RISK_METRIC_POLICY_ACTIVATED,
  ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION,
  CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1,
  GATEIO_ACCOUNT_FACT_OBSERVED,
  GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION,
  type AccountRiskMetricPolicy,
  type GateIoAccountRiskIdentity,
  type GateIoDurableAccountObservation,
} from '../../src/accounting/gateio-account-risk-metrics-types';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import type { TradingKernel } from '../../src/kernel/TradingKernel';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { replayJournal, type ProjectorMap } from '../../src/recovery/ReplayCoordinator';
import {
  normalizeGateIoAccount,
  type GateIoCanonicalAccountTruth,
} from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import { gateIoExactDecimalSource, parseGateIoExactInt64Json } from '../../src/runtime/gateio/GateIoExactInt64Recovery';

const BASE_MS = 1_800_000_000_000;
const IDENTITY: GateIoAccountRiskIdentity = Object.freeze({
  exchange: 'gateio', settle: 'USDT', accountId: 'gate-account-r2',
});

describe('R2B2 durable daily loss, epoch high-water and drawdown', () => {
  it('establishes a day-open baseline only from fully bracketed boundary coverage', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '99.5'));
    const result = projector.snapshot(IDENTITY, DAY_BOUNDARY + 1_000);
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.baseline?.coverage, 'FULL_BOUNDARY_COVERAGE');
    assert.equal(result.baseline?.valueExact, '99.5');
    assert.equal(result.baseline?.qualifiedAt, DAY_BOUNDARY + 1_000);
    assert.equal(result.accountingDayId?.includes('2027-01-15'), true);
    assert.equal(result.dailyEquityLossExact, '0');
  });

  it('fails closed for a mid-day bootstrap and never invents a first-observation baseline', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 12 * 60 * 60_000, '90'));
    const result = projector.snapshot(IDENTITY, DAY_BOUNDARY + 12 * 60 * 60_000);
    assert.equal(result.status, 'PARTIAL_DAY');
    assert.equal(result.baseline?.coverage, 'PARTIAL_DAY_BOOTSTRAP');
    assert.equal(result.baseline?.valueExact, null);
    assert.equal(result.dailyEquityLossExact, null);
    assert.ok(result.reasons.includes('DAY_OPEN_VALUE_NOT_PROVEN'));

    const gapped = durableHarness();
    applyObservation(gapped.kernel, gapped.projector,
      valueObservation(DAY_BOUNDARY - 20_000, '100'));
    applyObservation(gapped.kernel, gapped.projector,
      valueObservation(DAY_BOUNDARY + 20_000, '100'));
    const gapResult = gapped.projector.snapshot(IDENTITY, DAY_BOUNDARY + 20_000);
    assert.equal(gapResult.status, 'PARTIAL_DAY');
    assert.ok(gapResult.reasons.includes('BOUNDARY_OBSERVATION_GAP_EXCEEDS_POLICY_FRESHNESS'));
  });

  it('computes exact same-day equity loss while gains clamp to exact zero', () => {
    const decline = durableHarness();
    applyObservation(decline.kernel, decline.projector,
      valueObservation(DAY_BOUNDARY - 1_000, '100.000000000000000001'));
    applyObservation(decline.kernel, decline.projector,
      valueObservation(DAY_BOUNDARY + 1_000, '100.000000000000000001'));
    applyObservation(decline.kernel, decline.projector,
      valueObservation(DAY_BOUNDARY + 2_000, '99.0000000000000000001'));
    assert.equal(decline.projector.snapshot(IDENTITY, DAY_BOUNDARY + 2_000)
      .dailyEquityLossExact, '1.0000000000000000009');

    const gain = durableHarness();
    applyObservation(gain.kernel, gain.projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(gain.kernel, gain.projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    applyObservation(gain.kernel, gain.projector, valueObservation(DAY_BOUNDARY + 2_000, '101'));
    assert.equal(gain.projector.snapshot(IDENTITY, DAY_BOUNDARY + 2_000)
      .dailyEquityLossExact, '0');
  });

  it('tracks epoch high-water monotonically and computes deterministic drawdown', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    assert.equal(projector.snapshot(IDENTITY, DAY_BOUNDARY + 1_000).epochHighWaterExact, '100');
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 2_000, '125'));
    assert.equal(projector.snapshot(IDENTITY, DAY_BOUNDARY + 2_000).epochHighWaterExact, '125');
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 3_000, '100'));
    const result = projector.snapshot(IDENTITY, DAY_BOUNDARY + 3_000);
    assert.equal(result.epochHighWaterExact, '125');
    assert.equal(result.drawdownAbsoluteExact, '25');
    assert.equal(result.drawdownFractionExact, '0.2');
    assert.equal(result.drawdownFractionScale, 18);
    assert.equal(result.drawdownFractionRounding, 'ROUND_HALF_UP');
  });

  it('does not advance high-water from unsupported observations and reports stale current data', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 2_000, '999', {
      marginMode: 1, accountModeQualification: 'UNSUPPORTED_ACCOUNT_MODE',
    }));
    const invalid = projector.snapshot(IDENTITY, DAY_BOUNDARY + 2_000);
    assert.equal(invalid.status, 'UNSUPPORTED_ACCOUNT_MODE');
    assert.equal(invalid.epochHighWaterExact, '100');
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 3_000, '99'));
    const stale = projector.snapshot(IDENTITY, DAY_BOUNDARY + 33_001);
    assert.equal(stale.status, 'STALE');
    assert.equal(stale.dailyEquityLossExact, null);
    assert.equal(stale.drawdownAbsoluteExact, null);
    assert.equal(stale.epochHighWaterExact, '100');
    assert.equal(stale.historicalStateRetained, true);

    const provenanceStale = durableHarness();
    applyObservation(provenanceStale.kernel, provenanceStale.projector,
      valueObservation(DAY_BOUNDARY + 1_000, '500', {
        captureProvenance: {
          kind: 'GATEIO_AUTHENTICATED_ACCOUNT_READ',
          endpoint: '/api/v4/futures/usdt/accounts',
          foundationFreshness: 'STALE',
        },
      }));
    const rejected = provenanceStale.projector.snapshot(IDENTITY, DAY_BOUNDARY + 1_000);
    assert.equal(rejected.status, 'STALE');
    assert.equal(rejected.epochHighWaterExact, null);
  });

  it('blocks current authority on R1 conflict while retaining historical metric facts', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    applyEconomic(kernel, projector, economicFact({ change: '-0.02' }));
    const result = projector.snapshot(IDENTITY, DAY_BOUNDARY + 1_000);
    assert.equal(result.status, 'ECONOMIC_CONFLICT');
    assert.equal(result.currentQualifiedAccountValueExact, null);
    assert.equal(result.dailyEquityLossExact, null);
    assert.equal(result.drawdownAbsoluteExact, null);
    assert.equal(result.epochHighWaterExact, '100');
    assert.equal(result.baseline?.valueExact, '100');
    assert.equal(result.historicalStateRetained, true);
  });

  it('blocks UNCLASSIFIED economic activity and refuses later high-water updates', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    applyEconomic(kernel, projector, economicFact({ id: 'unknown-risk-event', type: 'future_type' }));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 2_000, '200'));
    const result = projector.snapshot(IDENTITY, DAY_BOUNDARY + 2_000);
    assert.equal(result.status, 'UNCLASSIFIED_ECONOMIC_ACTIVITY');
    assert.equal(result.epochHighWaterExact, '100');
    assert.equal(result.acceptedMetricPoints.length, 2);
  });

  it('blocks an R1 ambiguous terminal balance and retains the earlier high-water', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    applyEconomic(kernel, projector, economicFact({ id: 'same-terminal-time', type: 'fund' }));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 2_000, '200'));
    const result = projector.snapshot(IDENTITY, DAY_BOUNDARY + 2_000);
    assert.equal(result.status, 'CURRENT_VALUE_UNAVAILABLE');
    assert.ok(result.reasons.includes('ECONOMIC_TERMINAL_BALANCE_AMBIGUOUS'));
    assert.equal(result.epochHighWaterExact, '100');
    assert.equal(result.currentQualifiedAccountValueExact, null);
  });

  it('keeps projection unusable without R1 economic facts and never accepts a metric point', () => {
    const projector = createGateIoDurableAccountRiskMetricProjector();
    let clockTick = 0;
    const kernel = createTradingKernel({ exchange: 'gateio',
      clock: { now: () => DAY_BOUNDARY + (++clockTick) } });
    applyPolicy(kernel, projector, policy({ effectiveAt: DAY_BOUNDARY - 86_400_000 }));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    const result = projector.snapshot(IDENTITY, DAY_BOUNDARY + 1_000);
    assert.equal(result.status, 'CURRENT_VALUE_UNAVAILABLE');
    assert.ok(result.reasons.includes('ECONOMIC_PROJECTION_UNUSABLE'));
    assert.equal(result.acceptedMetricPoints.length, 0);
    assert.equal(result.epochHighWaterExact, null);
  });

  it('makes malformed economic state sticky instead of exposing prior metrics as available', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    const nextFact = economicFact({ id: 'malformed-on-replay', type: 'fund' });
    const validEnvelope = kernel.publish(GATEIO_ECONOMIC_EVENT_RECORDED, {
      fact: nextFact, factDigest: gateIoEconomicFactDigest(nextFact),
    }).envelope;
    const malformed = JSON.parse(JSON.stringify(validEnvelope)) as {
      payload: { fact: { change: string } };
    };
    malformed.payload.fact.change = 'NaN';
    assert.throws(() => projector.apply(malformed), /GATEIO_ECONOMIC_DURABLE_PAYLOAD_INVALID/);
    const result = projector.snapshot(IDENTITY, DAY_BOUNDARY + 1_000);
    assert.equal(result.status, 'CURRENT_VALUE_UNAVAILABLE');
    assert.ok(result.reasons.includes('ECONOMIC_STATE_MALFORMED'));
    assert.equal(result.epochHighWaterExact, '100');
    assert.equal(result.currentQualifiedAccountValueExact, null);
  });

  it('makes an account observation identity conflict sticky across later clean observations', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    assert.throws(() => applyObservation(kernel, projector,
      valueObservation(DAY_BOUNDARY + 1_000, '101')),
    /GATEIO_ACCOUNT_OBSERVATION_IDENTITY_CONFLICT/);
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 2_000, '200'));
    const result = projector.snapshot(IDENTITY, DAY_BOUNDARY + 2_000);
    assert.equal(result.status, 'IDENTITY_INVALID');
    assert.ok(result.reasons.includes('GATEIO_ACCOUNT_OBSERVATION_IDENTITY_CONFLICT'));
    assert.equal(result.epochHighWaterExact, '100');
    assert.equal(result.currentQualifiedAccountValueExact, null);
  });

  it('fails closed on account identity mismatch and non-positive high-water fraction', () => {
    const mismatch = durableHarness();
    const wrongIdentity = { ...IDENTITY, accountId: 'other-account' } as const;
    assert.equal(mismatch.projector.snapshot(wrongIdentity, DAY_BOUNDARY + 1_000).status,
      'IDENTITY_INVALID');

    const zero = durableHarness();
    applyObservation(zero.kernel, zero.projector, valueObservation(DAY_BOUNDARY - 1_000, '0'));
    applyObservation(zero.kernel, zero.projector, valueObservation(DAY_BOUNDARY + 1_000, '0'));
    const result = zero.projector.snapshot(IDENTITY, DAY_BOUNDARY + 1_000);
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.epochHighWaterExact, '0');
    assert.equal(result.drawdownAbsoluteExact, '0');
    assert.equal(result.drawdownFractionExact, null);
    assert.ok(result.reasons.includes('DRAWDOWN_FRACTION_UNAVAILABLE_NON_POSITIVE_HIGH_WATER'));
  });

  it('rolls daily baseline independently while carrying epoch high-water across days', () => {
    const { kernel, projector } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 23 * 60 * 60_000, '110'));
    const nextBoundary = DAY_BOUNDARY + 86_400_000;
    applyObservation(kernel, projector, valueObservation(nextBoundary - 1_000, '105'));
    applyObservation(kernel, projector, valueObservation(nextBoundary + 1_000, '104'));
    const dayB = projector.snapshot(IDENTITY, nextBoundary + 1_000);
    assert.equal(dayB.status, 'AVAILABLE');
    assert.equal(dayB.baseline?.valueExact, '104');
    assert.equal(dayB.dailyEquityLossExact, '0');
    assert.equal(dayB.epochHighWaterExact, '110');

    const missing = durableHarness();
    applyObservation(missing.kernel, missing.projector,
      valueObservation(nextBoundary + 12 * 60 * 60_000, '90'));
    assert.equal(missing.projector.snapshot(IDENTITY, nextBoundary + 12 * 60 * 60_000)
      .status, 'PARTIAL_DAY');
  });

  it('starts a new marked metric epoch for every versioned policy activation', () => {
    const { kernel, projector, configured } = durableHarness();
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 1_000, '120'));
    const v1 = projector.snapshot(IDENTITY, DAY_BOUNDARY + 1_000);
    const v2 = policy({
      policyVersion: 2,
      effectiveAt: DAY_BOUNDARY + 2_000,
      accountObservationMaxAgeMs: configured.accountObservationMaxAgeMs,
      dayBoundary: { timezone: 'UTC', localBoundaryTime: '06:00:00' },
    });
    applyPolicy(kernel, projector, v2);
    applyObservation(kernel, projector, valueObservation(DAY_BOUNDARY + 3_000, '80'));
    const rolled = projector.snapshot(IDENTITY, DAY_BOUNDARY + 3_000);
    assert.equal(rolled.activePolicyVersion, 2);
    assert.notEqual(rolled.metricEpochId, v1.metricEpochId);
    assert.equal(rolled.epochHighWaterExact, '80');
    assert.equal(rolled.status, 'PARTIAL_DAY');
    assert.ok(rolled.baseline?.reasons.includes('POLICY_EPOCH_STARTED_AFTER_BOUNDARY'));
  });

  it('uses explicit IANA-zone accounting days deterministically across DST', () => {
    const boundary = Date.UTC(2027, 10, 7, 5, 0, 0);
    const configured = policy({
      effectiveAt: boundary - 86_400_000,
      accountObservationMaxAgeMs: 10_000,
      dayBoundary: { timezone: 'America/New_York', localBoundaryTime: '01:00:00' },
    });
    const { kernel, projector } = durableHarness(configured);
    applyObservation(kernel, projector, valueObservation(boundary - 1_000, '100'));
    applyObservation(kernel, projector, valueObservation(boundary + 1_000, '100'));
    const first = projector.snapshot(IDENTITY, boundary + 1_000);
    const second = projector.snapshot(IDENTITY, boundary + 1_000);
    assert.deepEqual(second, first);
    assert.equal(first.baseline?.boundaryAt, boundary);
    assert.equal(first.baseline?.coverage, 'FULL_BOUNDARY_COVERAGE');
  });

  it('replays restart, partial-day state, and R1 conflict identically without checkpoint state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-r2b2-'));
    const path = join(dir, 'journal.jsonl');
    try {
      const journal = createFileEventJournal(path);
      const kernel = createTradingKernel({ exchange: 'gateio', journal,
        initialSequence: journal.lastSequence, clock: { now: () => DAY_BOUNDARY + journal.lastSequence + 1 } });
      const live = createGateIoDurableAccountRiskMetricProjector();
      applyEconomic(kernel, live, economicFact());
      applyPolicy(kernel, live, policy({ effectiveAt: DAY_BOUNDARY - 86_400_000 }));
      applyObservation(kernel, live, valueObservation(DAY_BOUNDARY + 12 * 60 * 60_000, '100'));
      const partial = live.snapshot(IDENTITY, DAY_BOUNDARY + 12 * 60 * 60_000);
      assert.equal(partial.status, 'PARTIAL_DAY');
      applyEconomic(kernel, live, economicFact({ change: '-0.02' }));
      const conflicted = live.snapshot(IDENTITY, DAY_BOUNDARY + 12 * 60 * 60_000);
      assert.equal(conflicted.status, 'ECONOMIC_CONFLICT');

      const recovered = createGateIoDurableAccountRiskMetricProjector();
      const report = replayJournal(createFileEventJournal(path), durableProjectorMap(recovered));
      assert.deepEqual(report.errors, []);
      assert.deepEqual(recovered.snapshot(IDENTITY, DAY_BOUNDARY + 12 * 60 * 60_000), conflicted);
      assert.equal(recovered.digest(), live.digest());
      const second = createGateIoDurableAccountRiskMetricProjector();
      assert.deepEqual(replayJournal(createFileEventJournal(path), durableProjectorMap(second)).errors, []);
      assert.equal(second.digest(), recovered.digest());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function truth(overrides: {
  totalExact?: string | null;
  availableExact?: string | null;
  unrealisedPnlExact?: string | null;
  marginMode?: 0 | 1 | 2 | 3 | null;
  observedAt?: number;
  accountId?: string;
} = {}): GateIoCanonicalAccountTruth {
  const totalExact = overrides.totalExact === undefined ? '100.125000000000000001' : overrides.totalExact;
  const availableExact = overrides.availableExact === undefined ? '80.000000000000000009' : overrides.availableExact;
  const unrealisedPnlExact = overrides.unrealisedPnlExact === undefined
    ? '2.000000000000000009' : overrides.unrealisedPnlExact;
  return Object.freeze({
    identity: Object.freeze({ ...IDENTITY, accountId: overrides.accountId ?? IDENTITY.accountId }),
    account: Object.freeze({
      currency: 'USDT' as const,
      total: totalExact === null ? 100 : Number(totalExact),
      totalExact,
      available: availableExact === null ? 80 : Number(availableExact),
      availableExact,
      unrealizedPnl: unrealisedPnlExact === null ? null : Number(unrealisedPnlExact),
      unrealizedPnlExact: unrealisedPnlExact,
      orderMargin: null,
      inDualMode: false,
      positionMode: 'single',
      marginMode: overrides.marginMode === undefined ? 0 : overrides.marginMode,
    }),
    positions: Object.freeze([]),
    openOrders: Object.freeze([]),
    recentTrades: Object.freeze([]),
    serverTimeMs: BASE_MS - 10,
    observedAtMs: overrides.observedAt ?? BASE_MS,
    freshness: 'FRESH' as const,
    source: 'gateio-usdt-futures-read' as const,
    schemaVersion: 'gateio-l1a-v1' as const,
    accountState: 'FLAT' as const,
    accountStateBasis: 'FACTUAL_POSITIONS_RESPONSE' as const,
  });
}

function observation(overrides: Partial<GateIoDurableAccountObservation> = {}): GateIoDurableAccountObservation {
  const base = gateIoDurableAccountObservationFromTruth(truth());
  const marginMode = overrides.marginMode === undefined ? base.marginMode : overrides.marginMode;
  const accountModeQualification = overrides.accountModeQualification
    ?? (marginMode === 0 ? 'SUPPORTED_CLASSIC'
      : marginMode === null ? 'UNKNOWN_ACCOUNT_MODE' : 'UNSUPPORTED_ACCOUNT_MODE');
  return Object.freeze({ ...base, ...overrides, marginMode, accountModeQualification });
}

function policy(overrides: Partial<AccountRiskMetricPolicy> = {}): AccountRiskMetricPolicy {
  return Object.freeze({
    schemaVersion: ACCOUNT_RISK_METRIC_POLICY_SCHEMA_VERSION,
    ...IDENTITY,
    policyId: 'gate-r2-account-value',
    policyVersion: 1,
    effectiveAt: BASE_MS - 1_000,
    accountValueFormula: CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1,
    accountObservationMaxAgeMs: 30_000,
    dayBoundary: Object.freeze({ timezone: 'UTC', localBoundaryTime: '00:00:00' }),
    ...overrides,
  });
}

function project(
  observed: GateIoDurableAccountObservation | null,
  configured: AccountRiskMetricPolicy | null,
  evaluationTime = BASE_MS + 1_000,
  expectedIdentity = IDENTITY,
) {
  return projectQualifiedAccountValue({
    observation: observed, policy: configured, evaluationTime, expectedIdentity,
  });
}

function projectorMap(foundation: ReturnType<typeof createGateIoAccountMetricFoundation>): ProjectorMap {
  return new Map([
    [GATEIO_ACCOUNT_FACT_OBSERVED, [foundation]],
    [ACCOUNT_RISK_METRIC_POLICY_ACTIVATED, [foundation]],
  ]) as ProjectorMap;
}

const DAY_BOUNDARY = Date.UTC(2027, 0, 15, 0, 0, 0);

function economicFact(overrides: {
  id?: string;
  type?: string;
  change?: string;
  balance?: string;
} = {}): GateIoCanonicalEconomicEvent {
  const event = normalizeGateIoAccountBookPage([{
    id: overrides.id ?? 'risk-health-1',
    time: DAY_BOUNDARY / 1_000,
    type: overrides.type ?? 'fee',
    change: overrides.change ?? '-0.01',
    balance: overrides.balance ?? '100',
  }], { observedAt: DAY_BOUNDARY, pageRequest: { limit: 100, offset: 0 } })[0];
  assert.ok(event);
  return event;
}

function applyPolicy(
  kernel: TradingKernel,
  projector: ReturnType<typeof createGateIoDurableAccountRiskMetricProjector>,
  configured: AccountRiskMetricPolicy,
): void {
  projector.apply(kernel.publish(ACCOUNT_RISK_METRIC_POLICY_ACTIVATED, {
    policy: configured,
    policyDigest: accountRiskMetricPolicyDigest(configured),
  }).envelope);
}

function applyObservation(
  kernel: TradingKernel,
  projector: ReturnType<typeof createGateIoDurableAccountRiskMetricProjector>,
  observed: GateIoDurableAccountObservation,
): void {
  projector.apply(kernel.publish(GATEIO_ACCOUNT_FACT_OBSERVED, {
    observation: observed,
    observationDigest: gateIoAccountObservationDigest(observed),
  }).envelope);
}

function applyEconomic(
  kernel: TradingKernel,
  projector: ReturnType<typeof createGateIoDurableAccountRiskMetricProjector>,
  fact: GateIoCanonicalEconomicEvent,
): void {
  projector.apply(kernel.publish(GATEIO_ECONOMIC_EVENT_RECORDED, {
    fact,
    factDigest: gateIoEconomicFactDigest(fact),
  }).envelope);
}

function durableHarness(configured: AccountRiskMetricPolicy = policy({
  effectiveAt: DAY_BOUNDARY - 86_400_000,
  accountObservationMaxAgeMs: 30_000,
})) {
  const projector = createGateIoDurableAccountRiskMetricProjector();
  let clockTick = 0;
  const kernel = createTradingKernel({
    exchange: 'gateio',
    clock: { now: () => DAY_BOUNDARY + (++clockTick) },
  });
  applyEconomic(kernel, projector, economicFact());
  applyPolicy(kernel, projector, configured);
  return { kernel, projector, configured };
}

function valueObservation(
  observedAt: number,
  value: string,
  overrides: Partial<GateIoDurableAccountObservation> = {},
): GateIoDurableAccountObservation {
  return observation({
    observedAt,
    totalExact: value,
    unrealisedPnlExact: '0',
    ...overrides,
  });
}

function durableProjectorMap(
  projector: ReturnType<typeof createGateIoDurableAccountRiskMetricProjector>,
): ProjectorMap {
  return new Map([
    [GATEIO_ECONOMIC_EVENT_RECORDED, [projector]],
    [GATEIO_ACCOUNT_FACT_OBSERVED, [projector]],
    [ACCOUNT_RISK_METRIC_POLICY_ACTIVATED, [projector]],
  ]) as ProjectorMap;
}

describe('R2B1 exact account observation and metric policy', () => {
  it('preserves exact Gate monetary source tokens without reconstructing them from binary floats', () => {
    const raw = '{"currency":"USDT","total":9007199254740993.123456789012345678,'
      + '"available":8007199254740993.000000000000000009,'
      + '"unrealised_pnl":-0.000000000000000001,"margin_mode":0}';
    const parsed = parseGateIoExactInt64Json(raw, {
      shape: 'object', fields: [],
      decimalFields: ['total', 'available', 'unrealised_pnl'], required: false,
    }) as Record<string, unknown>;
    assert.equal(gateIoExactDecimalSource(parsed, 'total'), '9007199254740993.123456789012345678');
    const account = normalizeGateIoAccount(parsed);
    assert.equal(account.totalExact, '9007199254740993.123456789012345678');
    assert.equal(account.availableExact, '8007199254740993.000000000000000009');
    assert.equal(account.unrealizedPnlExact, '-0.000000000000000001');

    const legacyNumeric = normalizeGateIoAccount({
      currency: 'USDT', total: 100.25, available: 80.25, unrealised_pnl: 1.5, margin_mode: 0,
    });
    assert.equal(legacyNumeric.totalExact, null);
    assert.equal(legacyNumeric.availableExact, null);
    assert.equal(legacyNumeric.unrealizedPnlExact, null);
    assert.throws(() => gateIoDurableAccountObservationFromTruth({
      ...truth(), account: { ...truth().account, ...legacyNumeric },
    }), /GATEIO_ACCOUNT_OBSERVATION_INVALID/);
  });

  it('creates a durable observation with exact facts, explicit identity/provenance and no equity claim', () => {
    const durable = gateIoDurableAccountObservationFromTruth(truth());
    assert.equal(durable.schemaVersion, GATEIO_ACCOUNT_OBSERVATION_SCHEMA_VERSION);
    assert.equal(durable.accountId, IDENTITY.accountId);
    assert.equal(durable.totalExact, '100.125000000000000001');
    assert.equal(durable.availableExact, '80.000000000000000009');
    assert.equal(durable.unrealisedPnlExact, '2.000000000000000009');
    assert.equal(durable.accountModeQualification, 'SUPPORTED_CLASSIC');
    assert.equal(durable.captureProvenance.endpoint, '/api/v4/futures/usdt/accounts');
    assert.equal('equity' in durable, false);
    assert.equal('exchangeEquity' in durable, false);
  });

  it('derives the internal classic account value with exact positive and negative addition', () => {
    const positive = project(observation(), policy());
    assert.equal(positive.status, 'AVAILABLE');
    assert.equal(positive.valueKind, 'INTERNAL_DERIVED_ACCOUNT_VALUE');
    assert.equal(positive.formula, CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1);
    assert.equal(positive.derivedAccountValueExact, '102.12500000000000001');
    assert.equal('equity' in positive, false);

    const negative = project(observation({
      totalExact: '9007199254740993.123456789012345678',
      unrealisedPnlExact: '-0.123456789012345679',
    }), policy());
    assert.equal(negative.status, 'AVAILABLE');
    assert.equal(negative.derivedAccountValueExact, '9007199254740992.999999999999999999');
  });

  it('qualifies only classic mode and fails closed for unsupported, unknown and malformed facts', () => {
    assert.equal(project(observation({ marginMode: 1 }), policy()).status,
      'ACCOUNT_MODE_UNSUPPORTED');
    assert.equal(project(observation({ marginMode: 2 }), policy()).status,
      'ACCOUNT_MODE_UNSUPPORTED');
    assert.equal(project(observation({ marginMode: null }), policy()).status,
      'ACCOUNT_MODE_UNKNOWN');
    assert.equal(project({ ...observation(), totalExact: '' } as GateIoDurableAccountObservation,
      policy()).status, 'MALFORMED');
    assert.equal(project(({
      ...observation(), unrealisedPnlExact: 'NaN',
    }) as GateIoDurableAccountObservation, policy()).status, 'MALFORMED');
    assert.throws(() => gateIoDurableAccountObservationFromTruth(truth({ totalExact: null })),
      /GATEIO_ACCOUNT_OBSERVATION_INVALID/);
    assert.throws(() => gateIoDurableAccountObservationFromTruth(truth({ unrealisedPnlExact: null })),
      /GATEIO_ACCOUNT_OBSERVATION_INVALID/);
  });

  it('binds account identity and policy-driven freshness to explicit evaluation time', () => {
    assert.equal(project(observation(), policy(), BASE_MS + 30_000).status, 'AVAILABLE');
    const stale = project(observation(), policy(), BASE_MS + 30_001);
    assert.equal(stale.status, 'STALE');
    assert.equal(stale.derivedAccountValueExact, null);
    assert.equal(stale.ageMs, 30_001);
    assert.equal(project(observation(), policy(), BASE_MS - 1).status, 'MALFORMED');
    assert.equal(project(observation({ accountId: 'other-account' }), policy()).status,
      'ACCOUNT_IDENTITY_INVALID');
    assert.equal(project(observation(), policy({ accountId: 'other-account' })).status,
      'ACCOUNT_IDENTITY_INVALID');
    assert.equal(project(null, policy()).status, 'SOURCE_UNAVAILABLE');
    assert.equal(project(observation(), null).status, 'POLICY_UNAVAILABLE');
    assert.equal(project(observation(), policy({ effectiveAt: BASE_MS + 2_000 })).status,
      'POLICY_UNAVAILABLE');
    assert.deepEqual(project(observation(), policy(), BASE_MS + 1_000),
      project(observation(), policy(), BASE_MS + 1_000));
  });

  it('requires explicit valid timezone and boundary time with no production default', () => {
    assert.doesNotThrow(() => validateAccountRiskMetricPolicy(policy()));
    assert.throws(() => validateAccountRiskMetricPolicy({
      ...policy(), dayBoundary: { timezone: '', localBoundaryTime: '00:00:00' },
    }), /ACCOUNT_RISK_METRIC_POLICY_INVALID/);
    assert.throws(() => validateAccountRiskMetricPolicy({
      ...policy(), dayBoundary: { timezone: 'Not\/A_Timezone', localBoundaryTime: '00:00:00' },
    }), /ACCOUNT_RISK_METRIC_POLICY_INVALID/);
    assert.throws(() => validateAccountRiskMetricPolicy({
      ...policy(), dayBoundary: { timezone: 'UTC', localBoundaryTime: '24:00:00' },
    }), /ACCOUNT_RISK_METRIC_POLICY_INVALID/);
    const withoutBoundary = { ...policy() } as Record<string, unknown>;
    delete withoutBoundary.dayBoundary;
    assert.throws(() => validateAccountRiskMetricPolicy(withoutBoundary),
      /ACCOUNT_RISK_METRIC_POLICY_INVALID/);
  });

  it('validates durable payload digests before journal append', () => {
    const observed = observation();
    assert.doesNotThrow(() => validateGateIoAccountFactObservedPayload({
      observation: observed, observationDigest: gateIoAccountObservationDigest(observed),
    }));
    assert.throws(() => validateGateIoAccountFactObservedPayload({
      observation: observed, observationDigest: '0'.repeat(64),
    }), /GATEIO_ACCOUNT_OBSERVATION_DIGEST_MISMATCH/);
    assert.equal(accountRiskMetricPolicyDigest(policy()).length, 64);
  });

  it('replays observations and versioned policy activation deterministically across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-r2b1-'));
    const path = join(dir, 'journal.jsonl');
    try {
      const journal = createFileEventJournal(path);
      const live = createGateIoAccountMetricFoundation();
      const kernel = createTradingKernel({
        exchange: 'gateio', journal, initialSequence: journal.lastSequence,
        clock: { now: () => BASE_MS + journal.lastSequence + 1 },
      });
      const v1 = policy();
      const v2 = policy({ policyVersion: 2, effectiveAt: BASE_MS + 500,
        accountObservationMaxAgeMs: 60_000 });
      assert.equal(activateAccountRiskMetricPolicy(kernel, live, v1), 'RECORDED');
      assert.equal(recordGateIoAccountObservation(kernel, live, observation()), 'RECORDED');
      assert.equal(activateAccountRiskMetricPolicy(kernel, live, v2), 'RECORDED');
      assert.equal(journal.eventCount, 3);
      assert.equal(live.activePolicyAt(IDENTITY, BASE_MS)?.policyVersion, 1);
      assert.equal(live.activePolicyAt(IDENTITY, BASE_MS + 500)?.policyVersion, 2);

      const restarted = createGateIoAccountMetricFoundation();
      const reopened = createFileEventJournal(path);
      const report = replayJournal(reopened, projectorMap(restarted));
      assert.deepEqual(report.errors, []);
      assert.equal(report.eventsReplayed, 3);
      assert.deepEqual(restarted.snapshot(), live.snapshot());
      assert.equal(restarted.digest(), live.digest());
      const evaluationTime = BASE_MS + 1_000;
      const recovered = projectQualifiedAccountValue({
        observation: restarted.latestObservationAt(IDENTITY, evaluationTime),
        policy: restarted.activePolicyAt(IDENTITY, evaluationTime),
        evaluationTime,
        expectedIdentity: IDENTITY,
      });
      assert.equal(recovered.status, 'AVAILABLE');
      assert.equal(recovered.policyVersion, 2);
      assert.equal(recovered.derivedAccountValueExact, '102.12500000000000001');

      const second = createGateIoAccountMetricFoundation();
      assert.deepEqual(replayJournal(reopened, projectorMap(second)).errors, []);
      assert.equal(second.digest(), restarted.digest());
      assert.deepEqual(projectQualifiedAccountValue({
        observation: second.latestObservationAt(IDENTITY, evaluationTime),
        policy: second.activePolicyAt(IDENTITY, evaluationTime),
        evaluationTime,
        expectedIdentity: IDENTITY,
      }), recovered);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
