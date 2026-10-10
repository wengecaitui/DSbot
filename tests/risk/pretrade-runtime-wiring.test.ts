import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createProductionSpine, recoverAndStart } from '../../src/position/ProductionSpine';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import {
  createPreTradeRiskDecisionReceipt,
  createPreTradeRiskDecisionReceiptStore,
  preTradeRiskDecisionReceiptDigest,
  validatePreTradeRiskDecisionRecordedPayload,
} from '../../src/risk/pretrade-decision-receipt';
import { PRETRADE_RISK_DECISION_RECORDED } from '../../src/risk/pretrade-decision-receipt-types';
import { createTradeIntent } from '../../src/types/trade-intent';
import { seedGateIoAccountRiskAuthority } from '../helpers/gateio-account-risk-authority-fixture';
import { riskMandateDigest, riskMandateRevocationDigest } from '../../src/risk/risk-mandate';
import {
  RISK_MANDATE_REVOKED,
  RISK_MANDATE_REVOCATION_SCHEMA_VERSION,
} from '../../src/risk/risk-mandate-types';

const NOW = 1_800_000_000_000;

function truth(accountId: string) {
  return {
    async acquireTruth() {
      return Object.freeze({
        identity: Object.freeze({ exchange: 'gateio' as const, accountId }),
        orders: Object.freeze([]), fills: Object.freeze([]), positions: Object.freeze([]),
        capturedAt: NOW, source: 'offline-r3b4-fixture', complete: true,
      });
    },
  };
}

function seedJournal(path: string, accountId: string, includeAuthority: boolean) {
  const journal = createFileEventJournal(path);
  const kernel = createTradingKernel({ exchange: 'gateio', journal, clock: { now: () => NOW } });
  kernel.publish('position.baseline.confirmed', { baseline: {
    exchange: 'gateio', symbol: 'ETH/USDT', side: 'flat',
    signedQuantity: 0, averageEntryPrice: 0,
  } });
  const authority = includeAuthority
    ? seedGateIoAccountRiskAuthority(kernel, { accountId, now: NOW }) : null;
  journal.close();
  return authority;
}

async function recoveredSpine(path: string, accountId: string) {
  const journal = createFileEventJournal(path);
  const spine = await createProductionSpine({
    exchange: 'gateio', accountId, journal, clock: { now: () => NOW },
    hardRisk: () => ({ exchange: 'gateio', accountId, enabled: true, locked: false,
      totalCapitalUsd: 1_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1_000 }),
    execution: { mode: 'limited-live', truthPort: truth(accountId),
      adapter: { submit: async () => { throw new Error('MUTATION_FORBIDDEN'); } } },
    riskAuthorization: { mode: 'GATEIO_ACCOUNT_BOUND', settle: 'USDT' },
  });
  const recovery = await recoverAndStart(spine, journal);
  return { spine, recovery, journal };
}

describe('R3B4 runtime risk recovery and durable decision receipts', () => {
  it('replays R1/R2/RiskMandate facts into a compatible context without granting live readiness', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'r3b4-compatible-')), 'events.jsonl');
    const accountId = 'r3b4-compatible';
    seedJournal(path, accountId, true);
    const { spine, recovery, journal } = await recoveredSpine(path, accountId);
    assert.equal(recovery.recoveryVerified, true);
    assert.equal(spine.recoveryVerified, true);
    assert.equal(spine.protection.getMode(), 'replay', 'recovered process is not trading ready');
    const context = spine.accountRiskAuthorizationContext(NOW)!;
    assert.equal(context.status, 'COMPATIBLE');
    assert.equal(context.compatible, true);
    assert.equal(context.tradingAuthorized, false);
    assert.match(context.contextDigest, /^[a-f0-9]{64}$/);
    journal.close();
  });

  it('keeps missing account facts and human mandate explicit and fail-closed after recovery', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'r3b4-missing-')), 'events.jsonl');
    const accountId = 'r3b4-missing';
    seedJournal(path, accountId, false);
    const { spine, recovery, journal } = await recoveredSpine(path, accountId);
    assert.equal(recovery.recoveryVerified, true, 'process recovery may succeed without authority');
    const context = spine.accountRiskAuthorizationContext(NOW)!;
    assert.equal(context.compatible, false);
    assert.ok(context.failures.some((failure) => failure.status === 'MANDATE_MISSING'));
    assert.ok(context.failures.some((failure) =>
      failure.status === 'SNAPSHOT_ECONOMIC_PROJECTION_UNUSABLE'));
    assert.equal(context.requiredMetrics.accountValue.valueExact, null);
    assert.equal(context.tradingAuthorized, false);
    journal.close();
  });

  it('replays durable revocation and cannot resurrect the recovered mandate', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'r3b4-revoked-')), 'events.jsonl');
    const accountId = 'r3b4-revoked';
    const authority = seedJournal(path, accountId, true)!;
    const journal = createFileEventJournal(path);
    const writer = createTradingKernel({ exchange: 'gateio', journal,
      initialSequence: journal.lastSequence, clock: { now: () => NOW } });
    const revocation = Object.freeze({
      schemaVersion: RISK_MANDATE_REVOCATION_SCHEMA_VERSION,
      exchange: 'gateio' as const, settle: 'USDT' as const, accountId,
      mandateId: authority.mandate.mandateId,
      mandateVersion: authority.mandate.mandateVersion,
      mandateDigest: riskMandateDigest(authority.mandate),
      revokedAt: NOW - 1, reason: 'test operator revocation',
      provenance: Object.freeze({ authorityType: 'HUMAN_OPERATOR' as const,
        actorId: 'test-human-operator', approvalReference: 'test-revoke',
        approvedAt: NOW - 2, source: 'test-operator-control-plane' }),
    });
    writer.publish(RISK_MANDATE_REVOKED, {
      revocation, revocationDigest: riskMandateRevocationDigest(revocation),
    });
    journal.close();
    const recovered = await recoveredSpine(path, accountId);
    const context = recovered.spine.accountRiskAuthorizationContext(NOW)!;
    assert.equal(context.compatible, false);
    assert.ok(context.failures.some((failure) => failure.status === 'MANDATE_REVOKED'));
    assert.equal(context.tradingAuthorized, false);
    recovered.journal.close();
  });

  it('requires the explicit account-bound mode for Gate limited-live composition', async () => {
    const accountId = 'r3b4-no-fallback';
    await assert.rejects(() => createProductionSpine({
      exchange: 'gateio', accountId,
      hardRisk: () => ({ exchange: 'gateio', accountId, enabled: true, locked: false,
        totalCapitalUsd: 1_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1_000 }),
      execution: { mode: 'limited-live', truthPort: truth(accountId),
        adapter: { submit: async () => { throw new Error('MUTATION_FORBIDDEN'); } } },
    }), /RISK_AUTHORIZATION_MODE_REQUIRED/);
  });

  it('requires an explicit legacy mode for paper and non-Gate composition', async () => {
    const hardRisk = () => ({ exchange: 'bitget' as const, enabled: true, locked: false,
      totalCapitalUsd: 1_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1_000 });
    await assert.rejects(() => createProductionSpine({
      exchange: 'bitget', accountId: 'r3b4-paper-no-fallback', hardRisk,
    } as any), /RISK_AUTHORIZATION_MODE_REQUIRED/);
    const explicit = await createProductionSpine({
      exchange: 'bitget', accountId: 'r3b4-paper-explicit', hardRisk,
      riskAuthorization: { mode: 'LEGACY_PAPER_OR_NON_GATE' },
    });
    assert.equal(explicit.riskAuthorizationMode, 'LEGACY_PAPER_OR_NON_GATE');
    assert.equal(explicit.accountRiskAuthorizationContext(NOW), null);
  });

  it('journals and deterministically replays a provenance-bearing rejected decision', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'r3b4-receipt-')), 'events.jsonl');
    const journal = createFileEventJournal(path);
    const kernel = createTradingKernel({ exchange: 'gateio', journal, clock: { now: () => NOW } });
    const store = createPreTradeRiskDecisionReceiptStore();
    kernel.subscribe(PRETRADE_RISK_DECISION_RECORDED, (event) => { store.apply(event); });
    const intent = createTradeIntent({ exchange: 'gateio', symbol: 'ETH/USDT', direction: 'long',
      positionUsd: 10, source: 'r3b4-test', reason: 'receipt', createdAt: NOW, biasUpdatedAt: NOW });
    const payload = createPreTradeRiskDecisionReceipt({
      gatewayMode: 'GATEIO_ACCOUNT_BOUND', accountId: 'r3b4-receipt', intent,
      action: 'open', evaluationTime: NOW,
      result: { decision: 'REJECTED', reasonCode: 'ACCOUNT_RISK_CONTEXT_INCOMPATIBLE',
        provenance: {
          mode: 'ACCOUNT_BOUND', riskEffect: 'OPEN', exchange: 'gateio', settle: 'USDT',
          accountId: 'r3b4-receipt', symbol: 'ETH/USDT', intentId: intent.intentId,
          positionVersion: 1, positionSourceKernelEventId: 'a'.repeat(64),
          contextDigest: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64),
          mandateDigest: null, evaluationTime: NOW, accountingDayId: null,
          mandateId: null, mandateVersion: null, comparisons: [],
        } },
    });
    validatePreTradeRiskDecisionRecordedPayload(payload);
    assert.equal(payload.receiptDigest, preTradeRiskDecisionReceiptDigest(payload.receipt));
    const event = kernel.publish(PRETRADE_RISK_DECISION_RECORDED, payload);
    assert.equal(event.failures, 0);
    const firstDigest = store.digest();
    const replayed = createPreTradeRiskDecisionReceiptStore();
    for (const envelope of journal.readFromLogicalSequence(1)) replayed.apply(envelope);
    assert.equal(replayed.digest(), firstDigest);
    assert.deepEqual(replayed.snapshot(), store.snapshot());
    assert.equal(replayed.snapshot().records[0]!.receipt.contextDigest, 'b'.repeat(64));
    journal.close();
  });

  it('rejects malformed durable receipt payloads before journal append', () => {
    const intent = createTradeIntent({ exchange: 'bitget', symbol: 'BTC/USDT', direction: 'long',
      positionUsd: 1, source: 'r3b4-test', reason: 'malformed', createdAt: NOW, biasUpdatedAt: NOW });
    const payload = createPreTradeRiskDecisionReceipt({
      gatewayMode: 'LEGACY_PAPER_OR_NON_GATE', accountId: 'paper', intent,
      action: 'open', evaluationTime: NOW,
      result: { decision: 'REJECTED', reasonCode: 'POSITION_UNKNOWN' },
    });
    assert.throws(() => validatePreTradeRiskDecisionRecordedPayload({
      ...payload, receipt: { ...payload.receipt, requestedPositionUsdExact: 'NaN' },
    }), /PRETRADE_RECEIPT_INVALID/);
  });
});
