import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { createProductionSpine, recoverAndStart, reconcileRecoveredState, activateLiveReadiness, executeThroughGateway } from '../../src/position/ProductionSpine';
import type { ProductionEvidencePublisher, RiskMandateOperatorAuthority,
  ProductionProtectionLifecycleAuthority } from '../../src/position/ProductionAuthorityPorts';
import { createMarketDataRuntime } from '../../src/runtime/market/MarketDataRuntime';
import { createRiskIncreaseAdmission } from '../../src/risk/risk-increase-admission';
import { evaluateAccountBoundPreTradeRisk } from '../../src/risk/PreTradeRiskGateway';
import { createPreTradeRiskDecisionReceipt, createPreTradeRiskDecisionReceiptStore, preTradeRiskDecisionReceiptDigest, riskIncreaseIntentDigest } from '../../src/risk/pretrade-decision-receipt';
import { riskMandateRevocationDigest } from '../../src/risk/risk-mandate';
import { generateOrderId } from '../../src/oms/order-id';
import type { OmsOrder } from '../../src/oms/oms-types';
import type { PositionResolution } from '../../src/types/position-state';
import { createTradeIntent } from '../../src/types/trade-intent';
import { seedGateIoAccountRiskAuthority } from '../helpers/gateio-account-risk-authority-fixture';

const NOW = 1_800_000_000_000;
const ACCOUNT = 'r3f2-offline-account';

async function harness(options: { dropReceiptDisk?: boolean; replaceDiskReceipt?: boolean; marketStaleAfterMs?: number } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'r3f2-receipt-')), 'journal.jsonl');
  const file = createFileEventJournal(path);
  const intercepted = new Map<string, any>();
  const journal = { ...file,
    get lastSequence() { return file.lastSequence; },
    get eventCount() { return file.eventCount; },
    getByEventId(id: string) { return intercepted.get(id) ?? file.getByEventId(id); },
    append(event: any) {
      if (event.type === 'PRETRADE_RISK_DECISION_RECORDED' && options.dropReceiptDisk) {
        intercepted.set(event.kernelEventId, event); return;
      }
      if (event.type === 'PRETRADE_RISK_DECISION_RECORDED' && options.replaceDiskReceipt) {
        const receipt = { ...event.payload.receipt, accountId: 'wrong-account' };
        file.append({ ...event, payload: { receipt, receiptDigest: preTradeRiskDecisionReceiptDigest(receipt) } });
        return;
      }
      file.append(event);
    },
  };
  let time = NOW;
  let tickerHandler: (ticker: any) => void = () => {};
  const market = createMarketDataRuntime({ clock: { now: () => time }, collectorFactory: () => ({
    async start() {}, stop() {}, onTicker(handler) { tickerHandler = handler; }, onKline() {},
  }) });
  let evidence!: ProductionEvidencePublisher;
  let operator!: RiskMandateOperatorAuthority;
  let lifecycle!: ProductionProtectionLifecycleAuthority;
  const submitted: OmsOrder[] = [];
  const hardRisk = () => ({ exchange: 'gateio' as const, accountId: ACCOUNT, enabled: true, locked: false,
    totalCapitalUsd: 1000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1000 });
  const spine = await createProductionSpine({ exchange: 'gateio', accountId: ACCOUNT, journal,
    clock: { now: () => time }, marketRuntime: market, hardRisk,
    marketStaleAfterMs: options.marketStaleAfterMs,
    bindEvidencePublisher(value) { evidence = value; }, bindOperatorAuthority(value) { operator = value; },
    bindProtectionLifecycle(value) { lifecycle = value; },
    riskAuthorization: { mode: 'GATEIO_ACCOUNT_BOUND', settle: 'USDT' },
    execution: { mode: 'limited-live',
      adapter: { async submit(order, prepared) {
        // Fake adapter only; the actual receipt must already exist before any mutation consumer.
        const events = createFileEventJournal(path).readFromLogicalSequence(1, 1000);
        assert.ok(events.find(e => e.type === 'PRETRADE_RISK_DECISION_RECORDED'));
        prepared?.({ requestedQuantity: order.approvedNotionalUsd / 2000,
          venueQuantity: order.approvedNotionalUsd / 2, quantityMultiplier: 0.001,
          clientOrderId: 'offline-' + order.orderId.slice(0, 8), reduceOnly: false });
        submitted.push(order);
        return { status: 'rejected', reason: 'OFFLINE_NO_REAL_MUTATION' };
      } },
      truthPort: { async acquireTruth() {
        return { identity: { exchange: 'gateio' as const, accountId: ACCOUNT }, orders: [], fills: [], positions: [],
          capturedAt: time, complete: true, source: 'r3f2-offline-truth' };
      } },
    },
  });
  const recovered = await recoverAndStart(spine, path);
  assert.equal(recovered.recoveryVerified, true, JSON.stringify(recovered.errors));
  evidence.publish('position.baseline.confirmed', { baseline: { exchange: 'gateio', symbol: 'ETH/USDT',
    side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } });
  const seed = createTradingKernel({ exchange: 'gateio', clock: { now: () => NOW } });
  const authority = seedGateIoAccountRiskAuthority(seed, { accountId: ACCOUNT, now: NOW });
  for (const event of seed.journal().readFromLogicalSequence(1, 100)) {
    if (event.type === 'RISK_MANDATE_ACTIVATED') operator.activate(event.payload as any);
    else (evidence.publish as any)(event.type, event.payload);
  }
  evidence.publish('policy.snapshot.published', { policy: { exchange: 'gateio',
    sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1, compilerVersion: 'offline',
    compiledAt: NOW, effectiveAt: NOW, expiresAt: NOW + 3_600_000,
    allowNewEntries: true, allowedSymbols: [], blockedSymbols: [], allowedStrategyIds: [], blockedStrategyIds: [],
    maxPositionMultiplier: 1, riskLevel: 'low', directionBias: 'neutral', symbolRules: {}, reasonCodes: [] } });
  await reconcileRecoveredState(spine);
  lifecycle.start(); await market.start();
  tickerHandler({ exchange: 'gateio', instId: 'ETH/USDT', symbol: 'ETH/USDT', channel: 'ticker',
    last: 2000, bestBid: 1999, bestAsk: 2001, volume24h: 100, high24h: 2100, low24h: 1900, ts: time });
  await activateLiveReadiness(spine);
  const intent = createTradeIntent({ exchange: 'gateio', symbol: 'ETH/USDT', direction: 'long',
    positionUsd: 100, source: 'offline-r3f2', reason: 'receipt-binding', createdAt: NOW, biasUpdatedAt: NOW });
  return { spine, journal, path, intent, hardRisk, evidence, operator, authority, submitted,
    emitTicker() {
      tickerHandler({ exchange: 'gateio', instId: 'ETH/USDT', symbol: 'ETH/USDT', channel: 'ticker',
        last: 2000, bestBid: 1999, bestAsk: 2001, volume24h: 100, high24h: 2100, low24h: 1900, ts: time });
    },
    advance(ms: number) { time += ms; },
    stop() { lifecycle.stop(); market.stop(); },
  };
}

async function controllerFixture(patch: Record<string, any> = {}, increase = false) {
  const h = await harness();
  const ctx = h.spine.accountRiskAuthorizationContext(NOW)!;
  let position = h.spine.positionStore.resolve('gateio', 'ETH/USDT');
  if (increase) position = { status: 'open', side: 'long', signedQuantity: 0.01, averageEntryPrice: 2000,
    snapshot: { ...position.snapshot!, side: 'long', signedQuantity: 0.01, averageEntryPrice: 2000 } } as PositionResolution;
  let state = 'test-private-risk-state';
  let time = NOW;
  const result = evaluateAccountBoundPreTradeRisk({ mode: 'ACCOUNT_BOUND', action: 'open', intent: h.intent,
    hardRisk: h.hardRisk(), marketSnapshot: h.spine.marketStore.getSnapshot('gateio', 'ETH/USDT'),
    policyResolution: h.spine.policyStore.resolve('gateio', 'ETH/USDT'), positionResolution: position,
    authorizationContext: ctx });
  assert.equal(result.decision, 'ADMITTED');
  const original = createPreTradeRiskDecisionReceipt({ gatewayMode: 'GATEIO_ACCOUNT_BOUND', accountId: ACCOUNT,
    intent: h.intent, action: 'open', evaluationTime: NOW, result, bindRiskIncreaseIntent: true });
  const receipt = { ...original.receipt, ...patch };
  if (patch.intentId || patch.approvedPositionUsdExact) receipt.riskIncreaseProof = { ...receipt.riskIncreaseProof!,
    orderId: generateOrderId({ ...h.intent, intentId: receipt.intentId, action: 'open',
      approvedPositionUsd: Number(receipt.approvedPositionUsdExact) }) };
  const payload = { receipt, receiptDigest: preTradeRiskDecisionReceiptDigest(receipt) };
  const priorJournalSequence = h.journal.lastSequence;
  const writer = createTradingKernel({ exchange: 'gateio', journal: h.journal,
    initialSequence: priorJournalSequence, clock: { now: () => NOW } });
  const receipts = createPreTradeRiskDecisionReceiptStore();
  writer.subscribe('PRETRADE_RISK_DECISION_RECORDED', e => { receipts.apply(e); });
  const publication = writer.publish('PRETRADE_RISK_DECISION_RECORDED', payload);
  const controller = createRiskIncreaseAdmission({ journalPath: h.path, accountId: ACCOUNT, receipts,
    now: () => time, context: value => h.spine.accountRiskAuthorizationContext(value)!,
    riskStateDigest: () => state, position: () => position });
  const binding = { intent: h.intent, approvedUsd: 100, expectedReceipt: payload, priorJournalSequence,
    riskStateDigest: state };
  const order: OmsOrder = { orderId: original.receipt.riskIncreaseProof!.orderId, intentId: h.intent.intentId,
    exchange: 'gateio', symbol: 'ETH/USDT', action: 'open', side: 'buy', orderType: 'market', approvedNotionalUsd: 100 };
  return { h, controller, binding, publication, order, receipts,
    advance() { time += 60_000; }, changeState() { state = 'changed'; },
    changePosition() { position = { ...position, snapshot: { ...position.snapshot!, positionVersion: 999 } }; },
  };
}

describe('R3H3 private canonical market authority', () => {
  it('public market methods, snapshots and nested ticker values cannot be replaced or mutated', async t => {
    const h = await harness(); t.after(() => h.stop());
    const view = h.spine.marketStore;
    const market = view.getSnapshot('gateio', 'ETH/USDT')!;
    const digest = view.digest(), seq = h.journal.lastSequence;
    assert.equal(Object.isFrozen(view), true);
    assert.equal((view as any).apply, undefined);
    assert.equal(Reflect.set(h.spine, 'marketStore', {}), false);
    for (const key of Reflect.ownKeys(view)) assert.equal(Reflect.set(view, key, () => ({})), false);
    assert.throws(() => Object.setPrototypeOf(view, { apply() {} }), TypeError);
    assert.throws(() => Object.defineProperty(view, 'getSnapshot', { value: () => ({}) }), TypeError);
    for (const item of [market, market.ticker!, market.ticker!.ticker, view.getAllSnapshots(), market.klines])
      assert.equal(Object.isFrozen(item), true);
    assert.notEqual(market, view.getSnapshot('gateio', 'ETH/USDT'));
    assert.equal(Reflect.set(market, 'snapshotVersion', 999999), false);
    assert.equal(Reflect.set(market.ticker!.ticker, 'last', 1), false);
    assert.equal(Reflect.set(market, 'toJSON', () => ({ isStale: false })), false);
    assert.equal(view.digest(), digest); assert.equal(h.journal.lastSequence, seq);
  });
  it('non-durable fresh ticker and read replacement cannot bypass MARKET_STALE; collector facts can', async t => {
    const h = await harness({ marketStaleAfterMs: 1 }); t.after(() => h.stop()); h.advance(2);
    const s = h.spine, view = s.marketStore;
    const original = view.getSnapshot('gateio', 'ETH/USDT')!;
    const forged = { ...original, isStale: false, ageMs: 0, snapshotVersion: 999999,
      ticker: { ...original.ticker!, receivedAt: NOW + 2,
        ticker: { ...original.ticker!.ticker, ts: NOW + 2, last: 1 } } };
    const eventId = 'f'.repeat(64), seq = h.journal.lastSequence;
    const event = { type: 'market.ticker.updated', kernelEventId: eventId, kernelLogicalSequence: seq + 100,
      kernelTimestamp: NOW + 2, payload: { ticker: forged.ticker.ticker, receivedAt: NOW + 2 } };
    assert.equal((await executeThroughGateway(s, h.intent, 'open', 100)).riskCode, 'MARKET_STALE');
    assert.throws(() => (view as any).apply(event), TypeError);
    assert.equal(Reflect.set(view, 'apply', () => ({ status: 'applied' })), false);
    assert.equal(Reflect.set(view, 'getSnapshot', () => forged), false);
    assert.equal((await executeThroughGateway(s, h.intent, 'open', 100)).riskCode, 'MARKET_STALE');
    assert.equal(h.submitted.length, 0); assert.equal(s.oms.getStore().list().length, 0);
    assert.equal(s.pretradeDecisionReceipts.snapshot().records.length, 0);
    assert.equal(h.journal.lastSequence, seq); assert.equal(s.kernel.journal().getByEventId(eventId), null);
    // Same account/mandate remains compatible: only legitimate durable collector ingress re-arms freshness.
    assert.equal(s.accountRiskAuthorizationContext(NOW + 2)!.status, 'COMPATIBLE');
    h.emitTicker();
    const fresh = view.getSnapshot('gateio', 'ETH/USDT')!;
    assert.equal(fresh.isStale, false);
    assert.equal(fresh.ticker!.ticker.last, 2000);
    assert.ok(s.kernel.journal().readFromLogicalSequence(1).some(e =>
      e.type === 'market.ticker.updated' && e.kernelLogicalSequence === fresh.snapshotVersion));
    assert.equal((await executeThroughGateway(s, h.intent, 'open', 100)).admitted, true);
    assert.equal(h.submitted.length, 1);
  });
  it('fictional price/version/toJSON view on a counterfeit spine is not mutation authority', async t => {
    const h = await harness(); t.after(() => h.stop());
    const s = h.spine, real = s.marketStore.getSnapshot('gateio', 'ETH/USDT')!;
    let serializationCalls = 0;
    const forged = { ...real, snapshotVersion: 999999,
      ticker: { ...real.ticker!, ticker: { ...real.ticker!.ticker, last: 1 } },
      toJSON() { serializationCalls++; return real; } };
    assert.equal(Reflect.set(s.marketStore, 'getSnapshot', () => forged), false);
    const counterfeit = Object.create(s);
    Object.defineProperty(counterfeit, 'marketStore', { value: { getSnapshot: () => forged } });
    await assert.rejects(executeThroughGateway(counterfeit, h.intent, 'open', 100), /MUTATION_AUTHORITY_INVALID/);
    assert.equal(h.submitted.length, 0);
    assert.equal((await executeThroughGateway(s, h.intent, 'open', 100)).admitted, true);
    assert.equal(h.submitted.length, 1); assert.equal(serializationCalls, 0);
    assert.equal(s.marketStore.getSnapshot('gateio', 'ETH/USDT')!.ticker!.ticker.last, 2000);
  });
});

describe('R3F2 receipt-bound private mutation admission', () => {
  it('OPEN without a private permit, forged token or copied opaque token is denied', async t => {
    const f = await controllerFixture(); t.after(() => f.h.stop());
    for (const fake of [null, undefined, {}, { receiptDigest: f.binding.expectedReceipt.receiptDigest }, f.publication])
      assert.throws(() => f.controller.enterOms(fake, f.h.intent, 100), /ADMISSION_INVALID/);
    const token = f.controller.issue(f.binding, f.publication);
    assert.deepEqual(Reflect.ownKeys(token), []);
    assert.throws(() => f.controller.enterOms({ ...token }, f.h.intent, 100), /ADMISSION_INVALID/);
  });

  for (const [name, patch] of [
    ['wrong intent', { intentId: 'forged-other-intent' }],
    ['wrong account', { accountId: 'another-account' }],
    ['wrong context', { contextDigest: 'a'.repeat(64) }],
    ['wrong snapshot', { snapshotDigest: 'b'.repeat(64) }],
    ['wrong mandate', { mandateDigest: 'c'.repeat(64) }],
    ['wrong position version', { positionVersion: 999 }],
    ['wrong position source', { positionSourceKernelEventId: 'd'.repeat(64) }],
    ['wrong approved size', { approvedPositionUsdExact: '101' }],
    ['wrong requested size', { requestedPositionUsdExact: '101' }],
    ['approved decimal alias', { approvedPositionUsdExact: '100.000000000000000001' }],
    ['requested decimal alias', { requestedPositionUsdExact: '100.000000000000000001' }],
    ['wrong accounting day', { accountingDayId: 'another-day' }],
    ['wrong derived effect', { riskEffect: 'INCREASE' }],
    ['stale evaluation time', { evaluationTime: NOW - 60_000 }],
  ] as const) {
    it(`${name} receipt, even durably recorded with a valid digest, cannot authorize this OPEN`, async t => {
      const f = await controllerFixture(patch); t.after(() => f.h.stop());
      assert.throws(() => f.controller.issue(f.binding, f.publication), /ADMISSION_INVALID/);
    });
  }

  it('a historical receipt without additive intent proof remains valid accounting, not mutation authority', async t => {
    const f = await controllerFixture(); t.after(() => f.h.stop());
    const receipt = { ...f.binding.expectedReceipt.receipt }; delete receipt.riskIncreaseProof;
    const historical = { receipt, receiptDigest: preTradeRiskDecisionReceiptDigest(receipt) };
    assert.throws(() => f.controller.issue({ ...f.binding, expectedReceipt: historical }, f.publication), /ADMISSION_INVALID/);
  });

  it('private permit is single-use at OMS and adapter and cannot be minted twice from the same receipt', async t => {
    const f = await controllerFixture(); t.after(() => f.h.stop());
    const token = f.controller.issue(f.binding, f.publication);
    assert.throws(() => f.controller.issue(f.binding, f.publication), /ADMISSION_INVALID/);
    assert.throws(() => f.controller.enterAdapter(token, f.order), /ADMISSION_INVALID/);
    f.controller.enterOms(token, f.h.intent, 100);
    assert.throws(() => f.controller.enterOms(token, f.h.intent, 100), /ADMISSION_INVALID/);
    f.controller.enterAdapter(token, f.order);
    assert.throws(() => f.controller.enterAdapter(token, f.order), /ADMISSION_INVALID/);
    f.controller.checkAdapter(token, f.order); f.controller.close(token);
    assert.throws(() => f.controller.checkAdapter(token, f.order), /ADMISSION_INVALID/);
  });

  it('canonical INCREASE uses the same durable single-use gate without enabling runtime scale-in', async t => {
    const f = await controllerFixture({}, true); t.after(() => f.h.stop());
    assert.equal(f.binding.expectedReceipt.receipt.riskEffect, 'INCREASE');
    assert.throws(() => f.controller.enterOms(null, f.h.intent, 100), /ADMISSION_INVALID/);
    const token = f.controller.issue(f.binding, f.publication);
    f.controller.enterOms(token, f.h.intent, 100);
    f.controller.enterAdapter(token, f.order);
    assert.throws(() => f.controller.enterOms(token, f.h.intent, 100), /ADMISSION_INVALID/);
  });

  it('duplicate publication or replayed record after restart cannot recreate a fresh admission', async t => {
    const f = await controllerFixture(); t.after(() => f.h.stop());
    const oldToken = f.controller.issue(f.binding, f.publication);
    f.controller.enterOms(oldToken, f.h.intent, 100);
    assert.throws(() => f.controller.issue(f.binding, { ...f.publication, status: 'duplicate' }), /ADMISSION_INVALID/);
    const journal = createFileEventJournal(f.h.path);
    const replayed = createPreTradeRiskDecisionReceiptStore();
    for (const event of journal.readFromLogicalSequence(1, 1000)) {
      if (event.type === 'PRETRADE_RISK_DECISION_RECORDED') replayed.apply(event);
    }
    assert.deepEqual(replayed.snapshot(), f.receipts.snapshot());
    const restarted = createRiskIncreaseAdmission({ journalPath: f.h.path, accountId: ACCOUNT, receipts: replayed,
      now: () => NOW, context: value => f.h.spine.accountRiskAuthorizationContext(value)!,
      riskStateDigest: () => f.binding.riskStateDigest,
      position: () => f.h.spine.positionStore.resolve('gateio', 'ETH/USDT') });
    assert.throws(() => restarted.enterOms(oldToken, f.h.intent, 100), /ADMISSION_INVALID/);
    assert.throws(() => restarted.issue({ ...f.binding, priorJournalSequence: journal.lastSequence }, f.publication), /ADMISSION_INVALID/);
  });

  it('receipt A cannot admit intent B, different direction, size or order into mutation', async t => {
    const f = await controllerFixture(); t.after(() => f.h.stop());
    const token = f.controller.issue(f.binding, f.publication);
    for (const patch of [{ intentId: 'another-intent' }, { direction: 'short' as const }, { reason: 'another-reason' }])
      assert.throws(() => f.controller.enterOms(token, { ...f.h.intent, ...patch }, 100), /ADMISSION_INVALID/);
    assert.throws(() => f.controller.enterOms(token, f.h.intent, 101), /ADMISSION_INVALID/);
    f.controller.enterOms(token, f.h.intent, 100);
    for (const patch of [{ orderId: 'a'.repeat(64) }, { side: 'sell' as const }, { approvedNotionalUsd: 101 }, { exchange: 'binance' as const }])
      assert.throws(() => f.controller.enterAdapter(token, { ...f.order, ...patch }), /ADMISSION_INVALID/);
    f.controller.enterAdapter(token, f.order);
  });

  for (const change of ['advance', 'changeState', 'changePosition'] as const) {
    it(`${change} invalidates an already issued permit before OMS`, async t => {
      const f = await controllerFixture(); t.after(() => f.h.stop());
      const token = f.controller.issue(f.binding, f.publication); f[change]();
      assert.throws(() => f.controller.enterOms(token, f.h.intent, 100), /ADMISSION_INVALID/);
    });
  }

  it('disk-only absence cannot be hidden by successful publish and receipt cache/projection', async t => {
    const h = await harness({ dropReceiptDisk: true }); t.after(() => h.stop());
    const result = await executeThroughGateway(h.spine, h.intent, 'open', 100);
    assert.equal(result.admitted, false); assert.equal(result.riskCode, 'RISK_INCREASE_ADMISSION_INVALID');
    assert.equal(h.spine.pretradeDecisionReceipts.snapshot().records.length, 1, 'projection alone is insufficient');
    assert.equal(h.spine.oms.getStore().list().length, 0); assert.equal(h.submitted.length, 0);
    assert.equal(createFileEventJournal(h.path).readFromLogicalSequence(1, 100).filter(e => e.type === 'PRETRADE_RISK_DECISION_RECORDED').length, 0);
  });

  it('a checksum-valid different disk receipt does not admit the internally evaluated decision', async t => {
    const h = await harness({ replaceDiskReceipt: true }); t.after(() => h.stop());
    const result = await executeThroughGateway(h.spine, h.intent, 'open', 100);
    assert.equal(result.admitted, false); assert.equal(h.submitted.length, 0);
    assert.equal(h.spine.oms.getStore().list().length, 0);
  });

  it('legitimate account-bound OPEN has durable receipt before order.created and before adapter', async t => {
    const h = await harness(); t.after(() => h.stop());
    let checked = false;
    h.spine.kernel.subscribe('order.created', event => {
      const events = createFileEventJournal(h.path).readFromLogicalSequence(1, 1000);
      const recorded = events.find(e => e.type === 'PRETRADE_RISK_DECISION_RECORDED')!;
      assert.ok(recorded.kernelLogicalSequence < event.kernelLogicalSequence);
      const payload = recorded.payload as any;
      assert.equal(payload.receipt.riskIncreaseProof.orderId, event.payload.order.orderId);
      assert.equal(payload.receipt.riskIncreaseProof.intentDigest, riskIncreaseIntentDigest(h.intent));
      checked = true;
    });
    const result = await executeThroughGateway(h.spine, h.intent, 'open', 100);
    assert.equal(result.admitted, true); assert.equal(checked, true); assert.equal(h.submitted.length, 1);
    assert.equal(result.omsResult!.status, 'rejected', 'injected adapter never performs a real order');
    const again = await executeThroughGateway(h.spine, h.intent, 'open', 100);
    assert.equal(again.admitted, false); assert.equal(h.submitted.length, 1, 'same recorded receipt is not a reusable mutation token');
  });

  it('authority revocation during receipt publication denies before OMS', async t => {
    const h = await harness(); t.after(() => h.stop());
    h.spine.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', event => {
      if (event.payload.receipt.decision !== 'ADMITTED') return;
      const revocation = { schemaVersion: 'risk-mandate-revocation-v1' as const, exchange: 'gateio' as const,
        settle: 'USDT' as const, accountId: ACCOUNT, mandateId: h.authority.mandate.mandateId,
        mandateVersion: 1, mandateDigest: event.payload.receipt.mandateDigest!, revokedAt: NOW,
        reason: 'offline operator', provenance: h.authority.mandate.provenance };
      h.operator.revoke({ revocation, revocationDigest: riskMandateRevocationDigest(revocation) });
    });
    const result = await executeThroughGateway(h.spine, h.intent, 'open', 100);
    assert.equal(result.admitted, false); assert.equal(h.spine.oms.getStore().list().length, 0);
    assert.equal(h.submitted.length, 0);
  });

  it('stale context after publication denies even though the receipt was durably recorded', async t => {
    const h = await harness(); t.after(() => h.stop());
    h.spine.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', () => h.advance(60_000));
    assert.equal((await executeThroughGateway(h.spine, h.intent, 'open', 100)).admitted, false);
    assert.equal(h.submitted.length, 0); assert.equal(h.spine.oms.getStore().list().length, 0);
  });

  for (const eventType of ['order.created', 'order.execution.prepared'] as const) {
    it(`authority becoming stale at ${eventType} cannot proceed to adapter mutation`, async t => {
      const h = await harness(); t.after(() => h.stop());
      h.spine.kernel.subscribe(eventType, () => h.advance(60_000));
      await executeThroughGateway(h.spine, h.intent, 'open', 100);
      assert.equal(h.submitted.length, 0);
      assert.equal(h.spine.oms.getStore().list().length, 1,
        'OMS intent is tracked; invalidated admission never performs exchange mutation');
    });
  }

  it('receipt disk corruption after OMS creation is rechecked before adapter entry', async t => {
    const h = await harness(); t.after(() => h.stop());
    h.spine.kernel.subscribe('order.created', () => {
      const lines = readFileSync(h.path, 'utf8').split('\n');
      const receiptIndex = lines.findIndex(line => line.includes('PRETRADE_RISK_DECISION_RECORDED'));
      lines[receiptIndex] = lines[receiptIndex]!.replace('r3f2-offline-account', 'r3f2-corrupted-account');
      writeFileSync(h.path, lines.join('\n'));
    });
    const result = await executeThroughGateway(h.spine, h.intent, 'open', 100);
    assert.equal(result.admitted, false);
    assert.equal(result.riskCode, 'RISK_INCREASE_ADMISSION_INVALID');
    assert.throws(() => createFileEventJournal(h.path), /JOURNAL_CHECKSUM_MISMATCH/);
    assert.equal(h.submitted.length, 0);
  });

  it('caller intent mutation cannot replace the internally cloned receipt/order binding', async t => {
    const h = await harness(); t.after(() => h.stop());
    const originalDigest = riskIncreaseIntentDigest(h.intent);
    h.spine.kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', () => { (h.intent as any).direction = 'short'; });
    const result = await executeThroughGateway(h.spine, h.intent, 'open', 100);
    assert.equal(result.admitted, true); assert.equal(h.submitted[0]!.side, 'buy');
    assert.equal(h.spine.pretradeDecisionReceipts.snapshot().records[0]!.receipt.riskIncreaseProof!.intentDigest, originalDigest);
  });

  it('public spine, OMS, kernel and receipt facts expose no mutation/admission capability', async t => {
    const h = await harness(); t.after(() => h.stop());
    await executeThroughGateway(h.spine, h.intent, 'open', 100);
    assert.equal((h.spine.oms as any).submitRequest, undefined);
    assert.equal((h.spine as any).adapter, undefined); assert.equal((h.spine.kernel as any).publish, undefined);
    assert.deepEqual(Object.getOwnPropertySymbols(h.spine), []);
    for (const key of Reflect.ownKeys(h.spine)) assert.doesNotMatch(String(key), /permit|Admission|submitRiskIncrease/);
    const facts = h.spine.pretradeDecisionReceipts.snapshot();
    assert.equal((facts.records[0] as any).permit, undefined);
    assert.equal((await (executeThroughGateway as any)(h.spine, h.intent, 'open', 100, facts)).admitted, false);
    assert.equal(h.submitted.length, 1);
  });
});
