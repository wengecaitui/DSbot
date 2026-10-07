import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createProductionSpine, recoverAndStart, reconcileRecoveredState, activateLiveReadiness } from '../../src/position/ProductionSpine';
import type { ProductionEvidencePublisher, RiskMandateOperatorAuthority } from '../../src/position/ProductionAuthorityPorts';
import type { TradingEventPayloadMap } from '../../src/events/TradingEvent';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { riskMandateRevocationDigest } from '../../src/risk/risk-mandate';
import { seedGateIoAccountRiskAuthority } from '../helpers/gateio-account-risk-authority-fixture';

const NOW = 1_800_000_000_000;
const ACCOUNT = 'r3f1-offline';

function authorityFacts() {
  const kernel = createTradingKernel({ exchange: 'gateio', clock: { now: () => NOW } });
  const { mandate } = seedGateIoAccountRiskAuthority(kernel, { accountId: ACCOUNT, now: NOW });
  const revocation = {
    schemaVersion: 'risk-mandate-revocation-v1' as const,
    exchange: 'gateio' as const, settle: 'USDT' as const, accountId: ACCOUNT,
    mandateId: mandate.mandateId, mandateVersion: mandate.mandateVersion,
    mandateDigest: kernel.journal().readFromLogicalSequence(1, 100)
      .find(event => event.type === 'RISK_MANDATE_ACTIVATED')!.payload.mandateDigest,
    revokedAt: NOW, reason: 'explicit operator revocation', provenance: mandate.provenance,
  };
  return { events: kernel.journal().readFromLogicalSequence(1, 100),
    activation: kernel.journal().readFromLogicalSequence(1, 100)
      .find(event => event.type === 'RISK_MANDATE_ACTIVATED')!.payload as TradingEventPayloadMap['RISK_MANDATE_ACTIVATED'],
    revocation: { revocation, revocationDigest: riskMandateRevocationDigest(revocation) },
  };
}

async function harness(bindOperator = false) {
  const path = join(mkdtempSync(join(tmpdir(), 'r3f1-authority-')), 'events.jsonl');
  const journal = createFileEventJournal(path);
  let evidence!: ProductionEvidencePublisher;
  let operator: RiskMandateOperatorAuthority | undefined;
  const spine = await createProductionSpine({ exchange: 'gateio', accountId: ACCOUNT,
    journal, clock: { now: () => NOW },
    bindEvidencePublisher: value => { evidence = value; },
    ...(bindOperator ? { bindOperatorAuthority: (value: RiskMandateOperatorAuthority) => { operator = value; } } : {}),
    hardRisk: () => ({ exchange: 'gateio', accountId: ACCOUNT, locked: false, enabled: true,
      totalCapitalUsd: 1000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1000 }),
    riskAuthorization: { mode: 'GATEIO_ACCOUNT_BOUND', settle: 'USDT' },
    execution: { mode: 'limited-live', adapter: { submit: async () => { throw new Error('NO_NETWORK_NO_MUTATION'); } },
      truthPort: { acquireTruth: async () => ({ identity: { exchange: 'gateio', accountId: ACCOUNT },
        orders: [], fills: [], positions: [], capturedAt: NOW, source: 'offline-r3f1', complete: true }) } },
  });
  return { spine, path, journal, evidence, operator };
}

describe('R3F1 public authority capabilities are closed', () => {
  it('has no enumerable or reflected recovery/readiness token, publisher or protection kernel', async () => {
    const { spine } = await harness();
    assert.deepEqual(Object.getOwnPropertySymbols(spine), []);
    for (const name of Reflect.ownKeys(spine)) assert.doesNotMatch(String(name), /token|verifyRecovery|operatorAuthority|evidencePublisher/);
    assert.equal((spine.kernel as any).publish, undefined);
    assert.equal((spine.protection as any).kernel, undefined);
    assert.equal((spine.protection as any)._setLive, undefined);
    assert.equal((spine.kernel.journal() as any).append, undefined);
    assert.equal(Object.isFrozen(spine.kernel), true);
  });

  it('generic callers cannot set recoveryVerified or inject a fake recovery token', async () => {
    const { spine } = await harness();
    assert.throws(() => Object.defineProperty(spine, 'recoveryVerified', { value: true }), TypeError);
    assert.throws(() => Object.defineProperty(spine, Symbol('verifyToken'), { value: () => true }), TypeError);
    assert.equal(Reflect.set(spine, 'recoveryVerified', true), false);
    await assert.rejects(spine.start({ exchange: 'gateio' }), /START_AUTHORITY/);
    await assert.rejects(reconcileRecoveredState(spine), /RECONCILIATION_REQUIRES_RECOVERY/);
    await assert.rejects(activateLiveReadiness(spine), /LIVE_READY_REQUIRES_RECOVERY/);
    assert.equal(spine.recoveryVerified, false);
  });

  it('public kernel cannot be replaced with an authority or fabricated receipt publisher', async () => {
    const { spine } = await harness();
    assert.equal(Reflect.set(spine.kernel, 'publish', () => ({ failures: 0 })), false);
    assert.equal(Reflect.set(spine, 'kernel', createTradingKernel({ exchange: 'gateio' })), false);
    assert.equal((spine.kernel as any).publish, undefined);
  });

  for (const role of ['generic spine caller', 'strategy', 'agent']) {
    it(`${role} cannot publish activation or revocation despite HUMAN_OPERATOR provenance`, async () => {
      const h = await harness();
      const facts = authorityFacts();
      assert.equal(facts.activation.mandate.provenance.authorityType, 'HUMAN_OPERATOR');
      // Exercise the narrowed port at runtime too: TypeScript exclusion alone is not a boundary.
      for (const [type, payload] of [['RISK_MANDATE_ACTIVATED', facts.activation], ['RISK_MANDATE_REVOKED', facts.revocation]] as const) {
        assert.throws(() => (h.evidence.publish as any)(type, payload), /PRODUCTION_EVIDENCE_EVENT_NOT_PERMITTED/);
        assert.throws(() => (h.spine.kernel as any).publish(type, payload), TypeError);
      }
      assert.equal(h.operator, undefined);
      assert.equal(h.journal.lastSequence, 0);
      assert.ok(h.spine.accountRiskAuthorizationContext(NOW)!.failures.some(f => f.status === 'MANDATE_MISSING'));
    });
  }

  it('operator capability is immutable, scoped, durable and replayable with R1/R2 facts', async () => {
    const h = await harness(true);
    const facts = authorityFacts();
    assert.equal(Object.isFrozen(h.operator), true);
    assert.deepEqual(Object.keys(h.operator!), ['activate', 'revoke']);
    for (const event of facts.events) {
      if (event.type === 'RISK_MANDATE_ACTIVATED') h.operator!.activate(facts.activation);
      else (h.evidence.publish as any)(event.type, event.payload);
    }
    assert.equal(h.spine.accountRiskAuthorizationContext(NOW)!.status, 'COMPATIBLE');
    assert.equal(h.spine.recoveryVerified, false, 'mandate events never grant recovery permission');
    const persisted = createFileEventJournal(h.path);
    assert.equal(persisted.readFromLogicalSequence(1, 100).filter(e => e.type === 'RISK_MANDATE_ACTIVATED').length, 1);
    const restored = await createProductionSpine({ exchange: 'gateio', accountId: ACCOUNT,
      journalPath: h.path, clock: { now: () => NOW }, hardRisk: h.spine.privateConfig.hardRisk,
      riskAuthorization: { mode: 'GATEIO_ACCOUNT_BOUND', settle: 'USDT' },
      execution: { mode: 'limited-live', adapter: { submit: async () => { throw new Error('NO_MUTATION'); } },
        truthPort: { acquireTruth: async () => { throw new Error('NO_ACQUISITION'); } } },
    });
    const replay = await recoverAndStart(restored, h.path);
    assert.equal(replay.recoveryVerified, true);
    assert.equal(restored.recoveryVerified, true);
    assert.equal(restored.protection.getMode(), 'replay');
    assert.equal(restored.accountRiskAuthorizationContext(NOW)!.contextDigest, h.spine.accountRiskAuthorizationContext(NOW)!.contextDigest);
    h.operator!.revoke(facts.revocation);
    assert.ok(h.spine.accountRiskAuthorizationContext(NOW)!.failures.some(f => f.status === 'MANDATE_REVOKED'));
    assert.equal(createFileEventJournal(h.path).readFromLogicalSequence(1, 100).at(-1)!.type, 'RISK_MANDATE_REVOKED');
  });

  it('operator capability rejects another account, venue or settlement without appending', async () => {
    const h = await harness(true);
    const facts = authorityFacts();
    for (const patch of [{ accountId: 'other' }, { exchange: 'binance' }, { settle: 'BTC' }]) {
      assert.throws(() => h.operator!.activate({ ...facts.activation,
        mandate: { ...facts.activation.mandate, ...patch } } as any), /OPERATOR_AUTHORITY_IDENTITY_MISMATCH/);
      assert.throws(() => h.operator!.revoke({ ...facts.revocation,
        revocation: { ...facts.revocation.revocation, ...patch } } as any), /OPERATOR_AUTHORITY_IDENTITY_MISMATCH/);
    }
    assert.equal(h.journal.lastSequence, 0);
  });

  it('generic caller cannot substitute a different empty journal to bypass legitimate replay', async () => {
    const h = await harness();
    const other = createFileEventJournal(join(mkdtempSync(join(tmpdir(), 'r3f1-other-')), 'other.jsonl'));
    await assert.rejects(recoverAndStart(h.spine, other), /RECOVERY_JOURNAL_BINDING_MISMATCH/);
    await assert.rejects(recoverAndStart(h.spine, other.filePath), /RECOVERY_JOURNAL_BINDING_MISMATCH/);
    assert.equal(h.spine.recoveryVerified, false);
    assert.equal((await recoverAndStart(h.spine, h.path)).recoveryVerified, true);
    assert.equal(h.spine.protection.getMode(), 'replay');
  });

  it('ignores caller-forged journal methods and verifies composition-owned bytes before granting recovery', async () => {
    const h = await harness();
    h.evidence.publish('position.baseline.confirmed', { baseline: { exchange: 'gateio', symbol: 'ETH/USDT',
      side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } });
    const original = readFileSync(h.path, 'utf8');
    const forged = { filePath: h.path, lastSequence: 0, readFromLogicalSequence: () => [] };
    writeFileSync(h.path, original.replace(/"checksum":"[a-f0-9]+"/, '"checksum":"invalid"'));
    await assert.rejects(recoverAndStart(h.spine, forged as any), /JOURNAL_CHECKSUM_MISMATCH/);
    assert.equal(h.spine.recoveryVerified, false);
  });

  it('journal read views are detached and cannot alter durable authority or replay cache', async () => {
    const h = await harness(true);
    h.operator!.activate(authorityFacts().activation);
    const observed = h.spine.kernel.journal().readFromLogicalSequence(1, 100);
    const originalId = observed[0]!.kernelEventId;
    (observed[0]!.payload as any).mandate.accountId = 'forged';
    observed[0]!.kernelEventId = 'forged';
    const second = h.spine.kernel.journal().getByEventId(originalId)!;
    assert.equal((second.payload as any).mandate.accountId, ACCOUNT);
    assert.equal(second.kernelEventId, originalId);
    assert.equal(createFileEventJournal(h.path).getByEventId(originalId)!.kernelEventId, originalId);
  });
});
