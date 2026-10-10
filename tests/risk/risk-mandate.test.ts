import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TradingEventPayloadMap } from '../../src/events/TradingEvent';
import { validateTradingEventPayload } from '../../src/events/validateTradingEventPayload';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createFileEventJournal, type FileEventJournal } from '../../src/recovery/FileEventJournal';
import { replayJournal, type ProjectorMap } from '../../src/recovery/ReplayCoordinator';
import {
  createRiskMandateProjector,
  riskMandateDigest,
  riskMandateIdentity,
  riskMandateRevocationDigest,
  validateRiskMandate,
} from '../../src/risk/risk-mandate';
import {
  RISK_MANDATE_ACTIVATED,
  RISK_MANDATE_REVOKED,
  RISK_MANDATE_REVOCATION_SCHEMA_VERSION,
  RISK_MANDATE_SCHEMA_VERSION,
  type RiskMandateAccountIdentity,
  type RiskMandateRevocationV1,
  type RiskMandateV1,
} from '../../src/risk/risk-mandate-types';

const BASE_MS = 1_800_000_000_000;
const IDENTITY: RiskMandateAccountIdentity = Object.freeze({
  exchange: 'gateio', settle: 'USDT', accountId: 'gate-risk-account',
});

function mandate(
  version = 1,
  overrides: Partial<RiskMandateV1> = {},
): RiskMandateV1 {
  return {
    schemaVersion: RISK_MANDATE_SCHEMA_VERSION,
    ...IDENTITY,
    mandateId: 'operator-risk-mandate',
    mandateVersion: version,
    effectiveAt: BASE_MS + version * 1_000,
    expiresAt: BASE_MS + 100_000 + version * 1_000,
    enabled: true,
    allowedSymbols: Object.freeze(['BTC/USDT', 'ETH/USDT']),
    allowedActionEffects: Object.freeze([
      'OPEN', 'INCREASE', 'REDUCE', 'CLOSE', 'EMERGENCY_CLOSE',
    ]),
    limits: Object.freeze({
      maxSinglePositionFractionExact: '0.100000000000000001',
      maxSinglePositionNotionalExact: '999999999999999999.000000000000000001',
      maxDailyEquityLossExact: '12345.000000000000000001',
      maxDrawdownFractionExact: '0.200000000000000001',
    }),
    metricPolicyBinding: Object.freeze({
      accountRiskSnapshotSchemaVersion: 'account-risk-snapshot-v1',
      metricPolicySchemaVersion: 'account-risk-metric-policy-v1',
      metricPolicyId: 'gate-account-risk-policy',
      metricPolicyVersion: 7,
      metricPolicyDigest: 'a'.repeat(64),
    }),
    provenance: Object.freeze({
      authorityType: 'HUMAN_OPERATOR',
      actorId: 'operator-001',
      approvalReference: `change-ticket-${version}`,
      approvedAt: BASE_MS - 1_000,
      source: 'operator-control-plane',
    }),
    ...overrides,
  };
}

function revocation(
  target: RiskMandateV1,
  overrides: Partial<RiskMandateRevocationV1> = {},
): RiskMandateRevocationV1 {
  return {
    schemaVersion: RISK_MANDATE_REVOCATION_SCHEMA_VERSION,
    exchange: target.exchange,
    settle: target.settle,
    accountId: target.accountId,
    mandateId: target.mandateId,
    mandateVersion: target.mandateVersion,
    mandateDigest: riskMandateDigest(target),
    revokedAt: target.effectiveAt + 100,
    reason: 'operator revoked authority',
    provenance: Object.freeze({
      authorityType: 'HUMAN_OPERATOR',
      actorId: 'operator-002',
      approvalReference: `revoke-${target.mandateVersion}`,
      approvedAt: target.effectiveAt + 50,
      source: 'operator-control-plane',
    }),
    ...overrides,
  };
}

function kernel(journal: FileEventJournal) {
  return createTradingKernel({
    exchange: 'gateio', journal, initialSequence: journal.lastSequence,
    clock: { now: () => BASE_MS + journal.lastSequence + 1 },
  });
}

function activate(
  writer: ReturnType<typeof kernel>,
  projector: ReturnType<typeof createRiskMandateProjector>,
  value: RiskMandateV1,
) {
  const mandateDigest = riskMandateDigest(value);
  const published = writer.publish(RISK_MANDATE_ACTIVATED, { mandate: value, mandateDigest });
  return projector.apply(published.envelope);
}

function revoke(
  writer: ReturnType<typeof kernel>,
  projector: ReturnType<typeof createRiskMandateProjector>,
  value: RiskMandateRevocationV1,
) {
  const revocationDigest = riskMandateRevocationDigest(value);
  const published = writer.publish(RISK_MANDATE_REVOKED, {
    revocation: value, revocationDigest,
  });
  return projector.apply(published.envelope);
}

function projectorMap(projector: ReturnType<typeof createRiskMandateProjector>): ProjectorMap {
  return new Map([
    [RISK_MANDATE_ACTIVATED, [projector]],
    [RISK_MANDATE_REVOKED, [projector]],
  ]) as ProjectorMap;
}

function withJournal(
  run: (journal: FileEventJournal, path: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'risk-mandate-'));
  const path = join(dir, 'journal.jsonl');
  try {
    run(createFileEventJournal(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('RiskMandateV1 durable foundation', () => {
  it('strictly validates human authority, finite lifecycle and canonical exact decimals', () => {
    const valid = mandate();
    assert.doesNotThrow(() => validateRiskMandate(valid));
    assert.throws(() => validateRiskMandate({ ...valid, extra: true }), /RISK_MANDATE_INVALID/);
    assert.throws(() => validateRiskMandate({ ...valid, expiresAt: valid.effectiveAt }),
      /RISK_MANDATE_INVALID/);
    assert.throws(() => validateRiskMandate({ ...valid,
      provenance: { ...valid.provenance, authorityType: 'AGENT' } }), /RISK_MANDATE_INVALID/);
    assert.throws(() => validateRiskMandate({ ...valid,
      limits: { ...valid.limits, maxSinglePositionNotionalExact: 100 } }),
    /RISK_MANDATE_INVALID/);
    assert.throws(() => validateRiskMandate({ ...valid,
      limits: { ...valid.limits, maxSinglePositionFractionExact: '0.10' } }),
    /RISK_MANDATE_INVALID/);
    assert.throws(() => validateRiskMandate({ ...valid,
      limits: { ...valid.limits, maxDrawdownFractionExact: '1.000000000000000001' } }),
    /RISK_MANDATE_INVALID/);
    assert.throws(() => validateRiskMandate({ ...valid,
      allowedSymbols: ['ETH/USDT', 'BTC/USDT'] }), /RISK_MANDATE_INVALID/);
  });

  it('produces deterministic canonical digests independent of object key insertion order', () => {
    const first = mandate();
    const reordered = {
      provenance: { source: first.provenance.source, approvedAt: first.provenance.approvedAt,
        approvalReference: first.provenance.approvalReference, actorId: first.provenance.actorId,
        authorityType: first.provenance.authorityType },
      metricPolicyBinding: { metricPolicyDigest: first.metricPolicyBinding.metricPolicyDigest,
        metricPolicyVersion: first.metricPolicyBinding.metricPolicyVersion,
        metricPolicyId: first.metricPolicyBinding.metricPolicyId,
        metricPolicySchemaVersion: first.metricPolicyBinding.metricPolicySchemaVersion,
        accountRiskSnapshotSchemaVersion:
          first.metricPolicyBinding.accountRiskSnapshotSchemaVersion },
      limits: { maxDrawdownFractionExact: first.limits.maxDrawdownFractionExact,
        maxDailyEquityLossExact: first.limits.maxDailyEquityLossExact,
        maxSinglePositionNotionalExact: first.limits.maxSinglePositionNotionalExact,
        maxSinglePositionFractionExact: first.limits.maxSinglePositionFractionExact },
      allowedActionEffects: first.allowedActionEffects,
      allowedSymbols: first.allowedSymbols,
      enabled: first.enabled,
      expiresAt: first.expiresAt,
      effectiveAt: first.effectiveAt,
      mandateVersion: first.mandateVersion,
      mandateId: first.mandateId,
      accountId: first.accountId,
      settle: first.settle,
      exchange: first.exchange,
      schemaVersion: first.schemaVersion,
    } as RiskMandateV1;
    assert.equal(riskMandateDigest(first), riskMandateDigest(reordered));
    assert.match(riskMandateDigest(first), /^[a-f0-9]{64}$/);
    assert.equal(riskMandateIdentity(first),
      '["gateio","USDT","gate-risk-account","operator-risk-mandate",1]');
  });

  it('preserves arbitrary exact-decimal precision and recursively freezes replayed authority', () => {
    withJournal((journal) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const value = mandate();
      assert.equal(activate(kernel(journal), projector, value).status, 'ACTIVATED');
      const stored = projector.snapshot().versions[0]!.mandate;
      assert.equal(stored.limits.maxSinglePositionNotionalExact,
        '999999999999999999.000000000000000001');
      assert.equal(stored.limits.maxDailyEquityLossExact, '12345.000000000000000001');
      assert.equal(Object.isFrozen(stored), true);
      assert.equal(Object.isFrozen(stored.limits), true);
      assert.equal(Object.isFrozen(projector.snapshot()), true);
      assert.equal(projector.resolve(value.effectiveAt).tradingAuthorized, false);
      assert.equal(projector.resolve(value.effectiveAt).authorityOnly, true);
    });
  });

  it('supersedes by effective version and never falls back from a disabled newer version', () => {
    withJournal((journal) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const writer = kernel(journal);
      const first = mandate(1);
      const second = mandate(2, { enabled: false });
      activate(writer, projector, first);
      activate(writer, projector, second);
      assert.equal(projector.resolve(first.effectiveAt).status, 'ACTIVE');
      const latest = projector.resolve(second.effectiveAt);
      assert.equal(latest.status, 'DISABLED');
      assert.equal(latest.mandate?.mandateVersion, 2);
      assert.equal(latest.tradingAuthorized, false);
    });
  });

  it('uses explicit evaluationTime for not-yet-effective, active and expired states', () => {
    withJournal((journal) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const value = mandate();
      activate(kernel(journal), projector, value);
      const original = Date.now;
      Date.now = () => { throw new Error('Date.now must not be used'); };
      try {
        assert.equal(projector.resolve(value.effectiveAt - 1).status, 'NOT_YET_EFFECTIVE');
        assert.equal(projector.resolve(value.effectiveAt).status, 'ACTIVE');
        assert.equal(projector.resolve(value.expiresAt).status, 'EXPIRED');
      } finally {
        Date.now = original;
      }
      assert.throws(() => projector.resolve(Number.NaN),
        /RISK_MANDATE_EVALUATION_TIME_INVALID/);
    });
  });

  it('fails closed on same-version different-digest conflict without last-write-wins', () => {
    withJournal((journal, path) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const writer = kernel(journal);
      const accepted = mandate(1);
      const conflicting = mandate(1, {
        limits: { ...accepted.limits, maxSinglePositionNotionalExact: '1' },
      });
      activate(writer, projector, accepted);
      assert.throws(() => activate(writer, projector, conflicting),
        /RISK_MANDATE_VERSION_CONFLICT/);
      assert.equal(projector.snapshot().versions[0]?.mandateDigest,
        riskMandateDigest(accepted));
      assert.equal(projector.snapshot().hasConflict, true);
      assert.equal(projector.resolve(accepted.effectiveAt).status, 'CONFLICTED');

      const recovered = createRiskMandateProjector(IDENTITY);
      const report = replayJournal(createFileEventJournal(path), projectorMap(recovered));
      assert.equal(report.errors.length, 1);
      assert.match(report.errors[0]?.message ?? '', /RISK_MANDATE_VERSION_CONFLICT/);
      assert.equal(recovered.snapshot().hasConflict, true);
      assert.equal(recovered.snapshot().versions[0]?.mandateDigest,
        riskMandateDigest(accepted));
    });
  });

  it('rejects non-monotonic effective times across mandate versions', () => {
    withJournal((journal) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const writer = kernel(journal);
      const first = mandate(1);
      activate(writer, projector, first);
      assert.throws(() => activate(writer, projector, mandate(2, {
        effectiveAt: first.effectiveAt - 1,
        expiresAt: first.expiresAt + 1,
      })), /RISK_MANDATE_VERSION_ORDER_CONFLICT/);
      assert.equal(projector.resolve(first.effectiveAt).status, 'CONFLICTED');
    });
  });

  it('durably revokes a version and an old activation cannot resurrect it', () => {
    withJournal((journal) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const writer = kernel(journal);
      const value = mandate();
      activate(writer, projector, value);
      const revoked = revocation(value);
      assert.equal(revoke(writer, projector, revoked).status, 'REVOKED');
      assert.equal(projector.resolve(revoked.revokedAt).status, 'REVOKED');
      assert.equal(activate(writer, projector, value).status, 'DUPLICATE_SAME_FACT');
      assert.equal(journal.eventCount, 2);
      assert.equal(projector.resolve(revoked.revokedAt + 1).status, 'REVOKED');
    });
  });

  it('retains a revocation received before activation and binds it to the mandate digest', () => {
    withJournal((journal) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const writer = kernel(journal);
      const value = mandate();
      const revoked = revocation(value);
      revoke(writer, projector, revoked);
      assert.equal(projector.resolve(revoked.revokedAt).status, 'MISSING');
      activate(writer, projector, value);
      assert.equal(projector.snapshot().pendingRevocations.length, 0);
      assert.equal(projector.resolve(revoked.revokedAt).status, 'REVOKED');
    });
  });

  it('fails closed when revocation targets a different mandate digest', () => {
    withJournal((journal) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const writer = kernel(journal);
      const value = mandate();
      activate(writer, projector, value);
      assert.throws(() => revoke(writer, projector, revocation(value, {
        mandateDigest: 'f'.repeat(64),
      })), /RISK_MANDATE_REVOCATION_TARGET_DIGEST_MISMATCH/);
      assert.equal(projector.snapshot().hasConflict, true);
      assert.equal(projector.resolve(value.effectiveAt).status, 'CONFLICTED');
    });
  });

  it('rejects account identity mismatch without importing foreign authority', () => {
    withJournal((journal) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const writer = kernel(journal);
      const foreign = mandate(1, { accountId: 'other-account' });
      const mandateDigest = riskMandateDigest(foreign);
      const published = writer.publish(RISK_MANDATE_ACTIVATED, {
        mandate: foreign, mandateDigest,
      });
      assert.throws(() => projector.apply(published.envelope),
        /RISK_MANDATE_ACCOUNT_IDENTITY_MISMATCH/);
      assert.throws(() => projector.apply(published.envelope),
        /RISK_MANDATE_ACCOUNT_IDENTITY_MISMATCH/);
      assert.deepEqual(projector.snapshot(), {
        schemaVersion: 'risk-mandate-store-v1',
        expectedIdentity: IDENTITY,
        mandateId: null,
        versions: [],
        pendingRevocations: [],
        conflicts: [],
        hasConflict: false,
        replayBoundary: null,
      });
      assert.equal(projector.resolve(BASE_MS).status, 'MISSING');
    });
  });

  it('replays and restarts deterministically, including revocation and dedup state', () => {
    withJournal((journal, path) => {
      const live = createRiskMandateProjector(IDENTITY);
      const writer = kernel(journal);
      const first = mandate(1);
      const second = mandate(2);
      activate(writer, live, first);
      activate(writer, live, second);
      revoke(writer, live, revocation(second));
      const expectedSnapshot = live.snapshot();
      const expectedDigest = live.digest();

      const restart = () => {
        const recovered = createRiskMandateProjector(IDENTITY);
        const reopened = createFileEventJournal(path);
        const report = replayJournal(reopened, projectorMap(recovered));
        assert.deepEqual(report.errors, []);
        return { recovered, reopened };
      };
      const a = restart();
      const b = restart();
      assert.deepEqual(a.recovered.snapshot(), expectedSnapshot);
      assert.equal(a.recovered.digest(), expectedDigest);
      assert.equal(b.recovered.digest(), expectedDigest);
      const before = a.reopened.eventCount;
      assert.equal(activate(kernel(a.reopened), a.recovered, second).status,
        'DUPLICATE_SAME_FACT');
      assert.equal(a.reopened.eventCount, before);
      assert.equal(a.recovered.resolve(second.effectiveAt + 100).status, 'REVOKED');
    });
  });

  it('validates both durable event payloads before journal append', () => {
    withJournal((journal) => {
      const writer = kernel(journal);
      const value = mandate();
      const badActivation: TradingEventPayloadMap['RISK_MANDATE_ACTIVATED'] = {
        mandate: value,
        mandateDigest: '0'.repeat(64),
      };
      assert.throws(() => writer.publish(RISK_MANDATE_ACTIVATED, badActivation),
        /RISK_MANDATE_DIGEST_MISMATCH/);
      const revoked = revocation(value);
      const badRevocation: TradingEventPayloadMap['RISK_MANDATE_REVOKED'] = {
        revocation: revoked,
        revocationDigest: '0'.repeat(64),
      };
      assert.throws(() => writer.publish(RISK_MANDATE_REVOKED, badRevocation),
        /RISK_MANDATE_REVOCATION_DIGEST_MISMATCH/);
      assert.equal(journal.eventCount, 0);
      assert.doesNotThrow(() => validateTradingEventPayload(RISK_MANDATE_ACTIVATED, {
        mandate: value, mandateDigest: riskMandateDigest(value),
      }));
    });
  });

  it('inherits journal checksum and monotonic sequence protection', () => {
    withJournal((journal, path) => {
      const projector = createRiskMandateProjector(IDENTITY);
      const writer = kernel(journal);
      activate(writer, projector, mandate(1));
      activate(writer, projector, mandate(2));
      assert.deepEqual(journal.readFromLogicalSequence(1)
        .map((event) => event.kernelLogicalSequence), [1, 2]);
      const raw = readFileSync(path, 'utf8');
      assert.match(raw, /maxDailyEquityLossExact/);
      writeFileSync(path, raw.replace('12345.000000000000000001', '9'), 'utf8');
      assert.throws(() => createFileEventJournal(path), /JOURNAL_CHECKSUM_MISMATCH/);
    });
  });
});
