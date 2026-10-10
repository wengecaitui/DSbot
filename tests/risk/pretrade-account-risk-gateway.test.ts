import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { MarketSnapshot } from '../../src/data/MarketSnapshot';
import {
  evaluateAccountBoundPreTradeRisk,
  evaluatePreTradeRisk,
} from '../../src/risk/PreTradeRiskGateway';
import { accountRiskSnapshotDigest } from '../../src/risk/account-risk-snapshot';
import { buildAccountRiskAuthorizationContext } from '../../src/risk/account-risk-authorization-context';
import type { AccountRiskAuthorizationContext } from '../../src/risk/account-risk-authorization-context-types';
import type { AccountRiskSnapshotV1 } from '../../src/risk/account-risk-snapshot-types';
import type {
  AccountBoundGatewayInput,
  AccountBoundHardRiskSnapshot,
  HardRiskSnapshot,
} from '../../src/risk/pretrade-risk-types';
import { riskMandateDigest } from '../../src/risk/risk-mandate';
import {
  RISK_MANDATE_SCHEMA_VERSION,
  type RiskMandateResolution,
  type RiskMandateV1,
} from '../../src/risk/risk-mandate-types';
import type { PolicyResolution } from '../../src/types/policy-snapshot';
import type { PositionResolution, VersionedPositionSnapshot } from '../../src/types/position-state';
import type { TradeIntent } from '../../src/types/trade-intent';

const EVALUATION_TIME = 1_800_000_010_000;
const POLICY_DIGEST = 'a'.repeat(64);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort()
      .map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function recomputeContextDigest(
  value: Omit<AccountRiskAuthorizationContext, 'contextDigest'>,
): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

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
      accountObservationId: 'observation-1',
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
      derivedAccountValue: { availability: 'AVAILABLE', valueExact: '1000', reasons: [] },
      available: { availability: 'AVAILABLE', valueExact: '800', reasons: [] },
      unrealisedPnl: { availability: 'AVAILABLE', valueExact: '0', reasons: [] },
    },
    daily: {
      baselineStatus: 'AVAILABLE',
      baseline: { availability: 'AVAILABLE', valueExact: '1000', reasons: [] },
      dailyEquityLoss: { availability: 'AVAILABLE', valueExact: '1', reasons: [] },
    },
    drawdown: {
      epochId: 'epoch-7',
      highWater: { availability: 'AVAILABLE', valueExact: '1050', reasons: [] },
      absolute: { availability: 'AVAILABLE', valueExact: '50', reasons: [] },
      fraction: { availability: 'AVAILABLE', valueExact: '0.05', reasons: [] },
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
      maxSinglePositionFractionExact: '0.2',
      maxSinglePositionNotionalExact: '200',
      maxDailyEquityLossExact: '10',
      maxDrawdownFractionExact: '0.2',
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

function context(
  accountSnapshot = snapshot(),
  authority = mandate(),
): AccountRiskAuthorizationContext {
  const resolved: RiskMandateResolution = {
    status: 'ACTIVE', evaluationTime: EVALUATION_TIME,
    mandate: authority, mandateDigest: riskMandateDigest(authority),
    reasons: [], authorityOnly: true, tradingAuthorized: false,
  };
  return buildAccountRiskAuthorizationContext({
    snapshot: accountSnapshot, mandateResolution: resolved,
    evaluationTime: EVALUATION_TIME,
  });
}

function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    intentId: 'intent-account-bound-001',
    exchange: 'gateio', symbol: 'BTC/USDT', direction: 'long',
    orderType: 'market', positionUsd: 40, source: 'focused-test',
    createdAt: EVALUATION_TIME, reason: 'account-bound test',
    biasUpdatedAt: EVALUATION_TIME - 1_000,
    ...overrides,
  };
}

function market(last = 50_000): MarketSnapshot {
  return {
    exchange: 'gateio', symbol: 'BTC/USDT', isStale: false,
    ticker: { ticker: { last } } as MarketSnapshot['ticker'],
    klines: {}, snapshotVersion: 1, generatedAt: EVALUATION_TIME,
    lastUpdatedAt: EVALUATION_TIME, ageMs: 0,
  } as MarketSnapshot;
}

function policy(overrides: Partial<PolicyResolution> = {}): PolicyResolution {
  return {
    status: 'active', policy: null, allowNewEntries: true,
    maxPositionMultiplier: 1, directionBias: 'neutral', riskLevel: 'medium',
    allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [],
    ...overrides,
  } as PolicyResolution;
}

function positionSnapshot(
  side: VersionedPositionSnapshot['side'],
  signedQuantity: number,
  averageEntryPrice: number,
): VersionedPositionSnapshot {
  return {
    exchange: 'gateio', symbol: 'BTC/USDT', side, signedQuantity, averageEntryPrice,
    positionVersion: 10, sourceKernelEventId: 'e'.repeat(64),
  };
}

function flatPosition(): PositionResolution {
  const source = positionSnapshot('flat', 0, 0);
  return { status: 'flat', snapshot: source, side: 'flat', signedQuantity: 0, averageEntryPrice: 0 };
}

function longPosition(quantity = 0.001, averageEntryPrice = 49_000): PositionResolution {
  const source = positionSnapshot('long', quantity, averageEntryPrice);
  return {
    status: 'open', snapshot: source, side: 'long',
    signedQuantity: quantity, averageEntryPrice,
  };
}

function hardRisk(overrides: Partial<AccountBoundHardRiskSnapshot> = {}): AccountBoundHardRiskSnapshot {
  return {
    exchange: 'gateio', accountId: 'gate-risk-account',
    locked: false, enabled: true, totalCapitalUsd: 10_000,
    maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 10_000,
    ...overrides,
  };
}

function input(overrides: Partial<AccountBoundGatewayInput> = {}): AccountBoundGatewayInput {
  return {
    mode: 'ACCOUNT_BOUND', action: 'open', intent: intent(),
    marketSnapshot: market(), policyResolution: policy(),
    positionResolution: flatPosition(), hardRisk: hardRisk(),
    authorizationContext: context(),
    ...overrides,
  };
}

describe('R3B3 account-bound PreTradeRiskGateway', () => {
  it('derives OPEN from a canonical flat position and continues all legacy checks', () => {
    const admitted = evaluateAccountBoundPreTradeRisk(input());
    assert.equal(admitted.decision, 'ADMITTED');
    assert.equal(admitted.provenance.riskEffect, 'OPEN');
    assert.equal(admitted.provenance.comparisons.length, 4);
    assert.ok(admitted.provenance.comparisons.every((item) => item.outcome === 'PASS'));
    assert.equal(admitted.provenance.contextDigest, input().authorizationContext.contextDigest);

    const locked = evaluateAccountBoundPreTradeRisk(input({ hardRisk: hardRisk({ locked: true }) }));
    assert.deepEqual(
      { decision: locked.decision, reasonCode: locked.decision === 'REJECTED' ? locked.reasonCode : null },
      { decision: 'REJECTED', reasonCode: 'KILLSWITCH_LOCKED' },
    );
    const policyBlocked = evaluateAccountBoundPreTradeRisk(input({
      policyResolution: policy({ allowNewEntries: false }),
    }));
    assert.equal(policyBlocked.decision, 'REJECTED');
    if (policyBlocked.decision === 'REJECTED') {
      assert.equal(policyBlocked.reasonCode, 'POLICY_ENTRIES_BLOCKED');
    }
  });

  it('derives INCREASE only from a canonical same-side open position', () => {
    const actual = evaluateAccountBoundPreTradeRisk(input({
      positionResolution: longPosition(),
    }));
    assert.equal(actual.decision, 'ADMITTED');
    assert.equal(actual.provenance.riskEffect, 'INCREASE');

    const opposite = evaluateAccountBoundPreTradeRisk(input({
      intent: intent({ direction: 'short' }), positionResolution: longPosition(),
    }));
    assert.equal(opposite.decision, 'REJECTED');
    if (opposite.decision === 'REJECTED') {
      assert.equal(opposite.reasonCode, 'ACCOUNT_RISK_EFFECT_UNRESOLVED');
    }
  });

  it('fails closed when canonical position provenance is absent or inconsistent', () => {
    const absent = evaluateAccountBoundPreTradeRisk(input({
      positionResolution: { ...flatPosition(), snapshot: null },
    }));
    assert.equal(absent.decision, 'REJECTED');
    if (absent.decision === 'REJECTED') {
      assert.equal(absent.reasonCode, 'ACCOUNT_RISK_EFFECT_UNRESOLVED');
    }
    const source = positionSnapshot('long', 0.001, 49_000);
    const inconsistent = evaluateAccountBoundPreTradeRisk(input({
      positionResolution: {
        status: 'open', snapshot: source, side: 'long',
        signedQuantity: 0.002, averageEntryPrice: 49_000,
      },
    }));
    assert.equal(inconsistent.decision, 'REJECTED');
    if (inconsistent.decision === 'REJECTED') {
      assert.equal(inconsistent.reasonCode, 'ACCOUNT_RISK_EFFECT_UNRESOLVED');
    }
  });

  it('has no missing-context, invalid-mode, or incompatible-context fallback', () => {
    const missing = evaluateAccountBoundPreTradeRisk({
      ...input(), authorizationContext: undefined,
    } as unknown as AccountBoundGatewayInput);
    assert.equal(missing.decision, 'REJECTED');
    if (missing.decision === 'REJECTED') {
      assert.equal(missing.reasonCode, 'ACCOUNT_RISK_CONTEXT_REQUIRED');
    }
    const wrongMode = evaluateAccountBoundPreTradeRisk({
      ...input(), mode: 'LEGACY_PAPER',
    } as unknown as AccountBoundGatewayInput);
    assert.equal(wrongMode.decision, 'REJECTED');
    if (wrongMode.decision === 'REJECTED') {
      assert.equal(wrongMode.reasonCode, 'ACCOUNT_RISK_MODE_INVALID');
    }
    const wrongEntrypoint = evaluatePreTradeRisk(
      input() as unknown as Parameters<typeof evaluatePreTradeRisk>[0],
    );
    assert.equal(wrongEntrypoint.decision, 'REJECTED');
    if (wrongEntrypoint.decision === 'REJECTED') {
      assert.equal(wrongEntrypoint.reasonCode, 'ACCOUNT_RISK_MODE_INVALID');
    }
    const partial = context(snapshot((value) => {
      value.status = 'PARTIAL_DAY';
      value.reasons = ['PARTIAL_DAY_BOOTSTRAP'];
      value.daily.dailyEquityLoss = {
        availability: 'UNAVAILABLE', valueExact: null, reasons: ['PARTIAL_DAY_BOOTSTRAP'],
      };
    }));
    const incompatible = evaluateAccountBoundPreTradeRisk(input({ authorizationContext: partial }));
    assert.equal(incompatible.decision, 'REJECTED');
    if (incompatible.decision === 'REJECTED') {
      assert.equal(incompatible.reasonCode, 'ACCOUNT_RISK_CONTEXT_INCOMPATIBLE');
    }
  });

  it('rejects provenance tampering even when COMPATIBLE flags remain true', () => {
    const valid = context();
    const forged = {
      ...valid,
      requiredMetrics: {
        ...valid.requiredMetrics,
        dailyEquityLoss: { availability: 'AVAILABLE', valueExact: '0' },
      },
    } as AccountRiskAuthorizationContext;
    const actual = evaluateAccountBoundPreTradeRisk(input({ authorizationContext: forged }));
    assert.equal(actual.decision, 'REJECTED');
    if (actual.decision === 'REJECTED') {
      assert.equal(actual.reasonCode, 'ACCOUNT_RISK_CONTEXT_PROVENANCE_INVALID');
    }

    const disabledMandate = { ...valid.mandateResolution.mandate!, enabled: false };
    const disabledDigest = riskMandateDigest(disabledMandate);
    const { contextDigest: _oldDigest, ...withoutDigest } = valid;
    const selfConsistentWithoutDigest = {
      ...withoutDigest,
      mandateResolution: {
        ...valid.mandateResolution,
        mandate: disabledMandate,
        mandateDigest: disabledDigest,
      },
      provenance: { ...valid.provenance, mandateDigest: disabledDigest },
    };
    const selfConsistentForgery = {
      ...selfConsistentWithoutDigest,
      contextDigest: recomputeContextDigest(selfConsistentWithoutDigest),
    } as AccountRiskAuthorizationContext;
    const forgedLifecycle = evaluateAccountBoundPreTradeRisk(input({
      authorizationContext: selfConsistentForgery,
    }));
    assert.equal(forgedLifecycle.decision, 'REJECTED');
    if (forgedLifecycle.decision === 'REJECTED') {
      assert.equal(forgedLifecycle.reasonCode, 'ACCOUNT_RISK_CONTEXT_PROVENANCE_INVALID');
    }
  });

  it('binds exchange and account identity', () => {
    const wrongAccount = evaluateAccountBoundPreTradeRisk(input({
      hardRisk: hardRisk({ accountId: 'other-account' }),
    }));
    assert.equal(wrongAccount.decision, 'REJECTED');
    if (wrongAccount.decision === 'REJECTED') {
      assert.equal(wrongAccount.reasonCode, 'ACCOUNT_RISK_IDENTITY_MISMATCH');
    }
  });

  it('enforces mandate symbol and derived action effect', () => {
    const symbolContext = context(snapshot(), mandate({ allowedSymbols: ['ETH/USDT'] }));
    const symbol = evaluateAccountBoundPreTradeRisk(input({ authorizationContext: symbolContext }));
    assert.equal(symbol.decision, 'REJECTED');
    if (symbol.decision === 'REJECTED') {
      assert.equal(symbol.reasonCode, 'ACCOUNT_RISK_SYMBOL_NOT_ALLOWED');
    }

    const openOnly = context(snapshot(), mandate({ allowedActionEffects: ['OPEN'] }));
    const increase = evaluateAccountBoundPreTradeRisk(input({
      authorizationContext: openOnly, positionResolution: longPosition(),
    }));
    assert.equal(increase.decision, 'REJECTED');
    if (increase.decision === 'REJECTED') {
      assert.equal(increase.reasonCode, 'ACCOUNT_RISK_EFFECT_NOT_ALLOWED');
    }
  });

  it('rejects daily equity loss at or above the exact limit', () => {
    const atLimit = context(snapshot((value) => {
      value.daily.dailyEquityLoss.valueExact = '10.000000000000000001';
    }), mandate({
      limits: { ...mandate().limits, maxDailyEquityLossExact: '10.000000000000000001' },
    }));
    const rejected = evaluateAccountBoundPreTradeRisk(input({ authorizationContext: atLimit }));
    assert.equal(rejected.decision, 'REJECTED');
    if (rejected.decision === 'REJECTED') {
      assert.equal(rejected.reasonCode, 'ACCOUNT_RISK_DAILY_LOSS_LIMIT_REACHED');
      assert.equal(rejected.provenance.comparisons[0]?.outcome, 'REJECT');
    }

    const below = context(snapshot((value) => {
      value.daily.dailyEquityLoss.valueExact = '10';
    }), mandate({
      limits: { ...mandate().limits, maxDailyEquityLossExact: '10.000000000000000001' },
    }));
    assert.equal(evaluateAccountBoundPreTradeRisk(input({ authorizationContext: below })).decision,
      'ADMITTED');
  });

  it('rejects drawdown at or above the exact limit', () => {
    const atLimit = context(snapshot((value) => {
      value.drawdown.fraction.valueExact = '0.100000000000000001';
    }), mandate({
      limits: { ...mandate().limits, maxDrawdownFractionExact: '0.100000000000000001' },
    }));
    const rejected = evaluateAccountBoundPreTradeRisk(input({ authorizationContext: atLimit }));
    assert.equal(rejected.decision, 'REJECTED');
    if (rejected.decision === 'REJECTED') {
      assert.equal(rejected.reasonCode, 'ACCOUNT_RISK_DRAWDOWN_LIMIT_REACHED');
    }
  });

  it('rejects requested OPEN notional above the exact absolute limit and permits equality', () => {
    const authority = mandate({
      limits: { ...mandate().limits, maxSinglePositionNotionalExact: '40' },
    });
    assert.equal(evaluateAccountBoundPreTradeRisk(input({
      authorizationContext: context(snapshot(), authority), intent: intent({ positionUsd: 40 }),
    })).decision, 'ADMITTED');
    const rejected = evaluateAccountBoundPreTradeRisk(input({
      authorizationContext: context(snapshot(), authority), intent: intent({ positionUsd: 40.01 }),
    }));
    assert.equal(rejected.decision, 'REJECTED');
    if (rejected.decision === 'REJECTED') {
      assert.equal(rejected.reasonCode, 'ACCOUNT_RISK_POSITION_NOTIONAL_LIMIT_EXCEEDED');
    }
  });

  it('rejects proposed notional above account-value fraction', () => {
    const authority = mandate({
      limits: {
        ...mandate().limits,
        maxSinglePositionNotionalExact: '1000',
        maxSinglePositionFractionExact: '0.05',
      },
    });
    const rejected = evaluateAccountBoundPreTradeRisk(input({
      authorizationContext: context(snapshot(), authority), intent: intent({ positionUsd: 50.01 }),
    }));
    assert.equal(rejected.decision, 'REJECTED');
    if (rejected.decision === 'REJECTED') {
      assert.equal(rejected.reasonCode, 'ACCOUNT_RISK_POSITION_FRACTION_LIMIT_EXCEEDED');
    }
  });

  it('uses exact multiplication and addition for INCREASE rather than binary float products', () => {
    const tinySnapshot = snapshot((value) => {
      value.account.derivedAccountValue.valueExact = '1';
      value.daily.dailyEquityLoss.valueExact = '0';
      value.drawdown.fraction.valueExact = '0';
    });
    const authority = mandate({
      limits: {
        ...mandate().limits,
        maxSinglePositionNotionalExact: '0.5',
        maxSinglePositionFractionExact: '1',
      },
    });
    const actual = evaluateAccountBoundPreTradeRisk(input({
      authorizationContext: context(tinySnapshot, authority),
      intent: intent({ positionUsd: 0.2 }),
      marketSnapshot: market(3),
      positionResolution: longPosition(0.1, 2),
    }));
    assert.equal(actual.decision, 'ADMITTED');
    const comparison = actual.provenance.comparisons.find(
      (entry) => entry.metric === 'POSITION_NOTIONAL',
    );
    assert.equal(comparison?.actualExact, '0.5');
  });

  it('does not implement account-bound exit bypass and leaves legacy exits unchanged', () => {
    const accountExit = evaluateAccountBoundPreTradeRisk({
      ...input(), action: 'close', intent: intent({ direction: 'short' }),
      positionResolution: longPosition(),
    } as unknown as AccountBoundGatewayInput);
    assert.equal(accountExit.decision, 'REJECTED');
    if (accountExit.decision === 'REJECTED') {
      assert.equal(accountExit.reasonCode, 'ACCOUNT_RISK_EFFECT_UNRESOLVED');
    }

    const legacyHardRisk: HardRiskSnapshot = {
      exchange: 'gateio', locked: false, enabled: false,
      totalCapitalUsd: 0, maxSinglePositionPct: 0.15,
      maxSinglePositionAbsUsd: 100_000,
    };
    const legacyExit = evaluatePreTradeRisk({
      intent: intent({ direction: 'short' }), action: 'close',
      marketSnapshot: market(), policyResolution: policy({ status: 'missing' }),
      positionResolution: longPosition(), hardRisk: legacyHardRisk,
    });
    assert.equal(legacyExit.decision, 'ADMITTED');
  });

  it('returns deterministic provenance-rich immutable decisions', () => {
    const value = input();
    const first = evaluateAccountBoundPreTradeRisk(value);
    const second = evaluateAccountBoundPreTradeRisk({ ...value });
    assert.deepEqual(second, first);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.provenance), true);
    assert.equal(Object.isFrozen(first.provenance.comparisons), true);
    assert.match(first.provenance.contextDigest ?? '', /^[a-f0-9]{64}$/);
    assert.equal(first.provenance.snapshotDigest, value.authorizationContext.provenance.snapshotDigest);
    assert.equal(first.provenance.mandateDigest, value.authorizationContext.provenance.mandateDigest);
    assert.equal(first.provenance.exchange, 'gateio');
    assert.equal(first.provenance.settle, 'USDT');
    assert.equal(first.provenance.accountId, 'gate-risk-account');
    assert.equal(first.provenance.symbol, 'BTC/USDT');
    assert.equal(first.provenance.intentId, 'intent-account-bound-001');
    assert.equal(first.provenance.positionVersion, 10);
    assert.equal(first.provenance.positionSourceKernelEventId, 'e'.repeat(64));
  });
});
