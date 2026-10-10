import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accountRiskSnapshotDigest } from '../../src/risk/account-risk-snapshot';
import {
  buildAccountRiskAuthorizationContext,
} from '../../src/risk/account-risk-authorization-context';
import {
  ACCOUNT_RISK_AUTHORIZATION_CONTEXT_SCHEMA_VERSION,
  type AccountRiskAuthorizationFailureStatus,
} from '../../src/risk/account-risk-authorization-context-types';
import type { AccountRiskSnapshotV1 } from '../../src/risk/account-risk-snapshot-types';
import { riskMandateDigest } from '../../src/risk/risk-mandate';
import {
  RISK_MANDATE_SCHEMA_VERSION,
  type RiskMandateResolution,
  type RiskMandateV1,
} from '../../src/risk/risk-mandate-types';

const EVALUATION_TIME = 1_800_000_010_000;
const POLICY_DIGEST = 'a'.repeat(64);

function snapshot(
  mutate?: (value: Omit<AccountRiskSnapshotV1, 'snapshotDigest'>) => void,
): AccountRiskSnapshotV1 {
  const value: Omit<AccountRiskSnapshotV1, 'snapshotDigest'> = {
    schemaVersion: 'account-risk-snapshot-v1',
    identity: {
      exchange: 'gateio', settle: 'USDT', accountId: 'gate-risk-account',
      accountMode: 0, accountModeQualification: 'SUPPORTED_CLASSIC',
    },
    evaluation: {
      evaluatedAt: EVALUATION_TIME,
      accountObservationId: 'account-observation-1',
      accountObservedAt: EVALUATION_TIME - 1_000,
      observationAgeMs: 1_000,
      observationFreshness: 'FRESH',
    },
    policy: {
      policyId: 'gate-account-risk-policy',
      policyVersion: 7,
      policyEffectiveAt: EVALUATION_TIME - 100_000,
      accountValueFormula: 'CLASSIC_TOTAL_PLUS_UNREALISED_PNL_V1',
      accountingDayId: '["gateio","USDT","gate-risk-account","gate-account-risk-policy",7]',
    },
    account: {
      derivedAccountValue: { availability: 'AVAILABLE', valueExact: '100.000000000000000001', reasons: [] },
      available: { availability: 'AVAILABLE', valueExact: '80', reasons: [] },
      unrealisedPnl: { availability: 'AVAILABLE', valueExact: '0', reasons: [] },
    },
    daily: {
      baselineStatus: 'AVAILABLE',
      baseline: { availability: 'AVAILABLE', valueExact: '110', reasons: [] },
      dailyEquityLoss: { availability: 'AVAILABLE', valueExact: '9.999999999999999999', reasons: [] },
    },
    drawdown: {
      epochId: 'epoch-7',
      highWater: { availability: 'AVAILABLE', valueExact: '125', reasons: [] },
      absolute: { availability: 'AVAILABLE', valueExact: '24.999999999999999999', reasons: [] },
      fraction: { availability: 'AVAILABLE', valueExact: '0.199999999999999999', reasons: [] },
      fractionScale: 18,
      fractionRounding: 'ROUND_HALF_UP',
    },
    economicHealth: {
      projectionStatus: 'USABLE_OBSERVED_SCOPE',
      projectionUsableForObservedAccounting: true,
      identityConflictCount: 0,
      unclassifiedEventCount: 0,
      untrackedObservedActivityCount: 0,
      notExplainedByTrackedEvidenceCount: 0,
      trackedExecutionAttributionStatus: 'COMPLETE',
      accountActivityReconciled: 'UNAVAILABLE',
    },
    provenance: {
      accountObservationDigest: 'b'.repeat(64),
      metricPolicyDigest: POLICY_DIGEST,
      riskMetricsDigest: 'c'.repeat(64),
      economicProjectionDigest: 'd'.repeat(64),
      riskMetricsSchemaVersion: 'gateio-durable-account-risk-metrics-v1',
      economicProjectionSchemaVersion: 'gateio-economic-projection-v1',
      economicLedgerSchemaVersion: 'gateio-economic-ledger-v1',
      economicHistoryScope: 'OBSERVED_PAGES_ONLY',
      lastKernelLogicalSequence: 41,
    },
    status: 'QUALIFIED',
    reasons: [],
  };
  mutate?.(value);
  return { ...value, snapshotDigest: accountRiskSnapshotDigest(value) };
}

function mandate(overrides: Partial<RiskMandateV1> = {}): RiskMandateV1 {
  return {
    schemaVersion: RISK_MANDATE_SCHEMA_VERSION,
    exchange: 'gateio', settle: 'USDT', accountId: 'gate-risk-account',
    mandateId: 'operator-risk-mandate',
    mandateVersion: 3,
    effectiveAt: EVALUATION_TIME - 10_000,
    expiresAt: EVALUATION_TIME + 10_000,
    enabled: true,
    allowedSymbols: ['BTC/USDT', 'ETH/USDT'],
    allowedActionEffects: ['OPEN', 'INCREASE', 'REDUCE', 'CLOSE', 'EMERGENCY_CLOSE'],
    limits: {
      maxSinglePositionFractionExact: '0.1',
      maxSinglePositionNotionalExact: '500',
      maxDailyEquityLossExact: '5',
      maxDrawdownFractionExact: '0.1',
    },
    metricPolicyBinding: {
      accountRiskSnapshotSchemaVersion: 'account-risk-snapshot-v1',
      metricPolicySchemaVersion: 'account-risk-metric-policy-v1',
      metricPolicyId: 'gate-account-risk-policy',
      metricPolicyVersion: 7,
      metricPolicyDigest: POLICY_DIGEST,
    },
    provenance: {
      authorityType: 'HUMAN_OPERATOR',
      actorId: 'operator-001',
      approvalReference: 'change-ticket-3',
      approvedAt: EVALUATION_TIME - 20_000,
      source: 'operator-control-plane',
    },
    ...overrides,
  };
}

function resolution(
  value: RiskMandateV1 | null = mandate(),
  overrides: Partial<RiskMandateResolution> = {},
): RiskMandateResolution {
  return {
    status: value === null ? 'MISSING' : 'ACTIVE',
    evaluationTime: EVALUATION_TIME,
    mandate: value,
    mandateDigest: value === null ? null : riskMandateDigest(value),
    reasons: value === null ? ['MANDATE_MISSING'] : [],
    authorityOnly: true,
    tradingAuthorized: false,
    ...overrides,
  };
}

function compose(
  accountSnapshot = snapshot(),
  mandateResolution = resolution(),
  evaluationTime = EVALUATION_TIME,
) {
  return buildAccountRiskAuthorizationContext({
    snapshot: accountSnapshot, mandateResolution, evaluationTime,
  });
}

function failureStatuses(value: ReturnType<typeof compose>): AccountRiskAuthorizationFailureStatus[] {
  return value.failures.map((failure) => failure.status);
}

describe('R3B2 AccountRiskAuthorizationContext composer', () => {
  it('composes one compatible immutable context without authorizing trading', () => {
    const actual = compose();
    assert.equal(actual.schemaVersion, ACCOUNT_RISK_AUTHORIZATION_CONTEXT_SCHEMA_VERSION);
    assert.equal(actual.status, 'COMPATIBLE');
    assert.equal(actual.compatible, true);
    assert.deepEqual(actual.failures, []);
    assert.equal(actual.requiredMetrics.allAvailable, true);
    assert.equal(actual.requiredMetrics.accountValue.valueExact, '100.000000000000000001');
    assert.equal(actual.requiredMetrics.dailyEquityLoss.valueExact, '9.999999999999999999');
    assert.equal(actual.requiredMetrics.drawdownFraction.valueExact, '0.199999999999999999');
    assert.equal(actual.policyBinding.matched, true);
    assert.equal(actual.qualifiedContextOnly, true);
    assert.equal(actual.tradingAuthorized, false);
    assert.match(actual.contextDigest, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(actual), true);
    assert.equal(Object.isFrozen(actual.mandateResolution.mandate), true);
    (actual.requiredMetrics as { allAvailable: boolean }).allAvailable = false;
    assert.equal(actual.requiredMetrics.allAvailable, true);
  });

  it('is deterministic, preserves exact strings and has no wall-clock dependency', () => {
    const original = Date.now;
    Date.now = () => { throw new Error('Date.now must not be used'); };
    try {
      const first = compose();
      const second = compose();
      assert.deepEqual(second, first);
      assert.equal(second.contextDigest, first.contextDigest);
    } finally {
      Date.now = original;
    }
  });

  it('does not compare mandate limits or turn qualification into authorization', () => {
    const accountSnapshot = snapshot((value) => {
      value.daily.dailyEquityLoss = {
        availability: 'AVAILABLE', valueExact: '999999999999999999.999', reasons: [],
      };
      value.drawdown.fraction = {
        availability: 'AVAILABLE', valueExact: '0.999999999999999999', reasons: [],
      };
    });
    const actual = compose(accountSnapshot);
    assert.equal(actual.status, 'COMPATIBLE');
    assert.equal(actual.compatible, true);
    assert.equal(actual.tradingAuthorized, false);
  });

  it('maps every non-qualified snapshot state to an explicit fail-closed status', () => {
    const cases = [
      ['POLICY_UNAVAILABLE', 'SNAPSHOT_POLICY_UNAVAILABLE'],
      ['CURRENT_ACCOUNT_VALUE_UNAVAILABLE', 'SNAPSHOT_ACCOUNT_VALUE_UNAVAILABLE'],
      ['PARTIAL_DAY', 'SNAPSHOT_PARTIAL_DAY'],
      ['STALE', 'SNAPSHOT_STALE'],
      ['ACCOUNT_IDENTITY_INVALID', 'SNAPSHOT_IDENTITY_INVALID'],
      ['ACCOUNT_MODE_UNSUPPORTED', 'SNAPSHOT_ACCOUNT_MODE_UNSUPPORTED'],
      ['ECONOMIC_CONFLICT', 'SNAPSHOT_ECONOMIC_CONFLICT'],
      ['UNCLASSIFIED_ECONOMIC_ACTIVITY', 'SNAPSHOT_UNCLASSIFIED_ACTIVITY'],
      ['ECONOMIC_PROJECTION_UNUSABLE', 'SNAPSHOT_ECONOMIC_PROJECTION_UNUSABLE'],
      ['MIXED_VERSION_STATE', 'SNAPSHOT_MIXED_VERSION'],
    ] as const;
    for (const [snapshotStatus, expected] of cases) {
      const actual = compose(snapshot((value) => {
        value.status = snapshotStatus;
        value.reasons = [`SOURCE_${snapshotStatus}`];
      }));
      assert.equal(actual.status, expected, snapshotStatus);
      assert.equal(actual.compatible, false);
      assert.ok(actual.reasons.includes(`SOURCE_${snapshotStatus}`));
    }
  });

  it('maps missing and every inactive mandate state explicitly', () => {
    const missing = compose(snapshot(), resolution(null));
    assert.equal(missing.status, 'MANDATE_MISSING');
    const cases = [
      ['NOT_YET_EFFECTIVE', 'MANDATE_NOT_YET_EFFECTIVE'],
      ['DISABLED', 'MANDATE_DISABLED'],
      ['EXPIRED', 'MANDATE_EXPIRED'],
      ['REVOKED', 'MANDATE_REVOKED'],
      ['CONFLICTED', 'MANDATE_CONFLICTED'],
    ] as const;
    for (const [mandateStatus, expected] of cases) {
      const actual = compose(snapshot(), resolution(mandate(), {
        status: mandateStatus, reasons: [`SOURCE_${mandateStatus}`],
      }));
      assert.equal(actual.status, expected, mandateStatus);
      assert.equal(actual.compatible, false);
    }
  });

  it('revalidates active mandate lifecycle rather than trusting the resolution label', () => {
    const disabled = mandate({ enabled: false });
    assert.ok(failureStatuses(compose(snapshot(), resolution(disabled)))
      .includes('MANDATE_LIFECYCLE_INVALID'));
    const expired = mandate({
      effectiveAt: EVALUATION_TIME - 20_000,
      expiresAt: EVALUATION_TIME,
    });
    assert.ok(failureStatuses(compose(snapshot(), resolution(expired)))
      .includes('MANDATE_LIFECYCLE_INVALID'));
  });

  it('binds snapshot and mandate evaluation to the explicit composition time', () => {
    const snapshotMismatch = compose(snapshot((value) => {
      value.evaluation.evaluatedAt = EVALUATION_TIME - 1;
    }));
    assert.equal(snapshotMismatch.status, 'SNAPSHOT_EVALUATION_TIME_MISMATCH');
    const mandateMismatch = compose(snapshot(), resolution(mandate(), {
      evaluationTime: EVALUATION_TIME - 1,
    }));
    assert.ok(failureStatuses(mandateMismatch).includes('MANDATE_RESOLUTION_TIME_MISMATCH'));
    const invalid = compose(snapshot(), resolution(), 0);
    assert.equal(invalid.status, 'EVALUATION_TIME_INVALID');
  });

  it('binds exact account identity across snapshot and mandate', () => {
    const other = mandate({ accountId: 'other-account' });
    const actual = compose(snapshot(), resolution(other));
    assert.ok(failureStatuses(actual).includes('ACCOUNT_IDENTITY_MISMATCH'));
    assert.equal(actual.compatible, false);
  });

  it('binds metric policy schema, id, version and digest independently', () => {
    const invalidSchemaMandate = {
      ...mandate(),
      metricPolicyBinding: {
        ...mandate().metricPolicyBinding,
        metricPolicySchemaVersion: 'wrong',
      },
    } as unknown as RiskMandateV1;
    const invalidSchemaResolution = {
      ...resolution(),
      mandate: invalidSchemaMandate,
      mandateDigest: 'f'.repeat(64),
    } as RiskMandateResolution;
    const invalidSchema = compose(snapshot(), invalidSchemaResolution);
    assert.ok(failureStatuses(invalidSchema).includes('MANDATE_SCHEMA_INVALID'));
    assert.ok(failureStatuses(invalidSchema).includes('METRIC_POLICY_SCHEMA_MISMATCH'));

    const cases: readonly [Partial<RiskMandateV1['metricPolicyBinding']>, AccountRiskAuthorizationFailureStatus][] = [
      [{ metricPolicyId: 'other-policy' }, 'METRIC_POLICY_ID_MISMATCH'],
      [{ metricPolicyVersion: 8 }, 'METRIC_POLICY_VERSION_MISMATCH'],
      [{ metricPolicyDigest: 'f'.repeat(64) }, 'METRIC_POLICY_DIGEST_MISMATCH'],
    ];
    for (const [bindingOverride, expected] of cases) {
      const value = mandate({
        metricPolicyBinding: { ...mandate().metricPolicyBinding, ...bindingOverride },
      });
      const actual = compose(snapshot(), resolution(value));
      assert.ok(failureStatuses(actual).includes(expected), expected);
      assert.equal(actual.policyBinding.matched, false);
    }
  });

  it('requires a factual accounting day and fresh observation', () => {
    const noDay = compose(snapshot((value) => { value.policy.accountingDayId = null; }));
    assert.ok(failureStatuses(noDay).includes('ACCOUNTING_DAY_UNAVAILABLE'));
    const stale = compose(snapshot((value) => {
      value.evaluation.observationFreshness = 'STALE';
    }));
    assert.ok(failureStatuses(stale).includes('SNAPSHOT_FRESHNESS_NOT_FRESH'));
  });

  it('requires account value, daily loss and drawdown availability independently', () => {
    const cases: readonly [
      (value: Omit<AccountRiskSnapshotV1, 'snapshotDigest'>) => void,
      AccountRiskAuthorizationFailureStatus,
    ][] = [
      [(value) => { value.account.derivedAccountValue = {
        availability: 'UNAVAILABLE', valueExact: '0', reasons: ['UNAVAILABLE_NOT_ZERO'],
      }; }, 'ACCOUNT_VALUE_UNAVAILABLE'],
      [(value) => { value.daily.dailyEquityLoss = {
        availability: 'UNAVAILABLE', valueExact: '0', reasons: ['UNAVAILABLE_NOT_ZERO'],
      }; }, 'DAILY_EQUITY_LOSS_UNAVAILABLE'],
      [(value) => { value.drawdown.fraction = {
        availability: 'UNAVAILABLE', valueExact: '0', reasons: ['UNAVAILABLE_NOT_ZERO'],
      }; }, 'DRAWDOWN_UNAVAILABLE'],
    ];
    for (const [mutate, expected] of cases) {
      const actual = compose(snapshot(mutate));
      assert.ok(failureStatuses(actual).includes(expected));
      assert.equal(actual.requiredMetrics.allAvailable, false);
    }
    assert.equal(compose(snapshot((value) => {
      value.daily.dailyEquityLoss = { availability: 'AVAILABLE', valueExact: '0', reasons: [] };
      value.drawdown.fraction = { availability: 'AVAILABLE', valueExact: '0', reasons: [] };
    })).status, 'COMPATIBLE');
  });

  it('fails closed on snapshot or mandate schema and digest tampering', () => {
    const badSnapshotDigest = { ...snapshot(), snapshotDigest: 'f'.repeat(64) };
    assert.equal(compose(badSnapshotDigest).status, 'SNAPSHOT_DIGEST_INVALID');

    const wrongSchema = snapshot((value) => {
      value.schemaVersion = 'wrong' as never;
    });
    assert.equal(compose(wrongSchema).status, 'SNAPSHOT_SCHEMA_INVALID');

    const badMandateDigest = resolution(mandate(), { mandateDigest: 'f'.repeat(64) });
    assert.ok(failureStatuses(compose(snapshot(), badMandateDigest))
      .includes('MANDATE_DIGEST_INVALID'));

    const malformed = { ...mandate(), schemaVersion: 'wrong' } as unknown as RiskMandateV1;
    const malformedResolution = {
      ...resolution(), mandate: malformed, mandateDigest: 'f'.repeat(64),
    } as RiskMandateResolution;
    assert.ok(failureStatuses(compose(snapshot(), malformedResolution))
      .includes('MANDATE_SCHEMA_INVALID'));
  });

  it('rejects a forged resolution that claims trade authorization', () => {
    const forged = {
      ...resolution(), tradingAuthorized: true,
    } as unknown as RiskMandateResolution;
    const actual = compose(snapshot(), forged);
    assert.ok(failureStatuses(actual).includes('MANDATE_RESOLUTION_INVALID'));
    assert.equal(actual.tradingAuthorized, false);
  });
});
