import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  accountRiskMetricPolicyDigest,
  activateAccountRiskMetricPolicy,
  createGateIoAccountMetricFoundation,
  gateIoAccountObservationDigest,
  gateIoDurableAccountObservationFromTruth,
  projectQualifiedAccountValue,
  recordGateIoAccountObservation,
  validateAccountRiskMetricPolicy,
  validateGateIoAccountFactObservedPayload,
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
} from '../../src/accounting/gateio-account-risk-metrics-types';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
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
