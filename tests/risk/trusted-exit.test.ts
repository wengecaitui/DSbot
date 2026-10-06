import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveTrustedExit, compareExitProduct } from '../../src/risk/trusted-exit';
import { createPreTradeRiskDecisionReceipt, validatePreTradeRiskDecisionRecordedPayload,
  createPreTradeRiskDecisionReceiptStore } from '../../src/risk/pretrade-decision-receipt';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TradeAction } from '../../src/risk/pretrade-risk-types';

function input(action: TradeAction = 'close') {
  return { requestedAction: action, intent: { intentId: 'test-exit', exchange: 'gateio' as const,
    symbol: 'ETH/USDT', direction: 'short' as 'short' | 'long', orderType: 'market' as const,
    positionUsd: 0.6, source: 'test', reason: 'test', createdAt: 100, biasUpdatedAt: 100 },
    position: { status: 'open' as const, side: 'long' as const, signedQuantity: 0.0003, averageEntryPrice: 2000,
      snapshot: { exchange: 'gateio' as const, symbol: 'ETH/USDT', side: 'long' as const,
        signedQuantity: 0.0003, averageEntryPrice: 2000, positionVersion: 2, sourceKernelEventId: 'a'.repeat(64) } },
    accountId: 'account', hardRisk: { exchange: 'gateio' as const, accountId: 'account',
      locked: true, enabled: true, totalCapitalUsd: 1, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 1 },
    valuationPrice: 2000, truthCapturedAt: 100, truthSource: 'authenticated-position-read' };
}
describe('R3D2 trusted exit derivation and durable proof', () => {
  for (const action of ['reduce', 'close', 'emergency_exit'] as const) {
    it(action + ' label cannot hide a same-direction increase', () => {
      const i = input(action); i.intent.direction = 'long';
      assert.equal(deriveTrustedExit(i).result.decision, 'REJECTED');
    });
    it(action + ' cannot exceed factual exposure', () => {
      const i = input(action); i.intent.positionUsd = 0.6000000000000001;
      assert.deepEqual(deriveTrustedExit(i).result, { decision: 'REJECTED', reasonCode: 'EXIT_QUANTITY_EXCEEDS_EXPOSURE' });
    });
  }
  it('derives REDUCE from a close label and partial quantity, and CLOSE from a reduce label and full quantity', () => {
    const i = input(); i.intent.positionUsd = 0.2;
    assert.equal(deriveTrustedExit(i).proof?.effect, 'REDUCE');
    assert.equal(deriveTrustedExit(i).action, 'reduce');
    assert.equal(deriveTrustedExit(input('reduce')).proof?.effect, 'CLOSE');
    assert.equal(deriveTrustedExit(input('emergency_exit')).proof?.effect, 'EMERGENCY_CLOSE');
  });
  it('missing, flat, foreign position and foreign hard-risk identity are rejected', () => {
    for (const position of [ { status: 'missing', snapshot: null }, { status: 'flat', snapshot: null },
      { ...input().position, snapshot: { ...input().position.snapshot, symbol: 'BTC/USDT' } } ]) {
      assert.equal(deriveTrustedExit({ ...input(), position: position as any }).result.decision, 'REJECTED');
    }
    assert.equal(deriveTrustedExit({ ...input(), accountId: 'other' }).result.decision, 'REJECTED');
  });
  it('risk-increase halt permits proof; explicit ALL_MUTATIONS stops it', () => {
    const i = input(); assert.equal(deriveTrustedExit(i).result.decision, 'ADMITTED');
    assert.equal(deriveTrustedExit({ ...i, hardRisk: { ...i.hardRisk, mutationHalt: 'RISK_INCREASE' } }).result.decision, 'ADMITTED');
    assert.deepEqual(deriveTrustedExit({ ...i, hardRisk: { ...i.hardRisk, mutationHalt: 'ALL_MUTATIONS' } }).result,
      { decision: 'REJECTED', reasonCode: 'ALL_MUTATIONS_HALTED' });
  });
  it('compares decimal products exactly, with no epsilon uplift', () => {
    assert.equal(compareExitProduct('0.0003', '2000', '0.6'), 0);
    assert.equal(compareExitProduct('0.0003', '2000', '0.6000000000000001'), -1);
    assert.equal(compareExitProduct('1e-7', '1e7', '1'), 0);
  });
  it('receipt pins position, account, effect, reduceOnly and deterministic OMS order; replays identically', t => {
    const i = input(), derived = deriveTrustedExit(i);
    const payload = createPreTradeRiskDecisionReceipt({ gatewayMode: 'GATEIO_TRUSTED_EXIT_ONLY',
      accountId: i.accountId, intent: i.intent, action: derived.action, evaluationTime: 100,
      result: derived.result, exitProof: derived.proof });
    validatePreTradeRiskDecisionRecordedPayload(payload);
    assert.ok(Object.isFrozen(payload.receipt.exitProof));
    assert.equal(payload.receipt.riskEffect, 'CLOSE');
    assert.equal(payload.receipt.positionSourceKernelEventId, 'a'.repeat(64));
    for (const field of ['reduceOnly', 'orderId', 'accountId', 'effect']) {
      const bad = structuredClone(payload); (bad.receipt.exitProof as any)[field] = 'forged';
      assert.throws(() => validatePreTradeRiskDecisionRecordedPayload(bad));
    }
    const path = join(mkdtempSync(join(tmpdir(), 'r3d2-receipt-')), 'journal.jsonl');
    const journal = createFileEventJournal(path); t.after(() => journal.close());
    const kernel = createTradingKernel({ exchange: 'gateio', journal, clock: { now: () => 100 } });
    const live = createPreTradeRiskDecisionReceiptStore();
    kernel.subscribe('PRETRADE_RISK_DECISION_RECORDED', e => { live.apply(e); });
    kernel.publish('PRETRADE_RISK_DECISION_RECORDED', payload);
    const reopened = createFileEventJournal(path); t.after(() => reopened.close());
    const replay = createPreTradeRiskDecisionReceiptStore();
    reopened.readFromLogicalSequence(1).forEach(e => replay.apply(e));
    assert.equal(replay.digest(), live.digest());
    assert.deepEqual(replay.snapshot(), live.snapshot());
  });
});
