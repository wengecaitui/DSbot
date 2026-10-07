import { closeSync, fsyncSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import type { PublishResult } from '../kernel/TradingKernel';
import type { OmsOrder } from '../oms/oms-types';
import { generateOrderId } from '../oms/order-id';
import { createFileEventJournal } from '../recovery/FileEventJournal';
import type { TradeIntent } from '../types/trade-intent';
import type { AccountRiskAuthorizationContext } from './account-risk-authorization-context-types';
import { preTradeRiskDecisionReceiptDigest, preTradeReceiptExactNumber, riskIncreaseIntentDigest,
  validatePreTradeRiskDecisionRecordedPayload } from './pretrade-decision-receipt';
import type { PreTradeRiskDecisionRecordedPayload, PreTradeRiskDecisionReceiptStore } from './pretrade-decision-receipt-types';

export interface RiskIncreaseAdmissionBinding {
  readonly intent: TradeIntent;
  readonly approvedUsd: number;
  readonly expectedReceipt: PreTradeRiskDecisionRecordedPayload;
  readonly priorJournalSequence: number;
  readonly riskStateDigest: string;
}

type Stage = 'ISSUED' | 'OMS' | 'ADAPTER' | 'CLOSED';
interface Permit {
  binding: RiskIncreaseAdmissionBinding;
  envelope: KernelEventEnvelope<'PRETRADE_RISK_DECISION_RECORDED'>;
  stage: Stage;
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Possession-scoped controller. Production never exports this instance or its opaque permits. */
export function createRiskIncreaseAdmission(input: Readonly<{
  journalPath: string | undefined;
  accountId: string;
  receipts: PreTradeRiskDecisionReceiptStore;
  now(): number;
  context(evaluationTime: number): AccountRiskAuthorizationContext;
  riskStateDigest(): string;
  position(symbol: string): { status: string; side: string; snapshot: {
    positionVersion: number; sourceKernelEventId: string;
  } | null };
}>) {
  const permits = new WeakMap<object, Permit>();
  const spent = new Set<string>();
  const issued = new Set<string>();

  function deny(): never { throw new Error('RISK_INCREASE_ADMISSION_INVALID'); }
  function verify(p: Permit) {
    const { binding: b, envelope: e } = p;
    const r = b.expectedReceipt.receipt;
    validatePreTradeRiskDecisionRecordedPayload(b.expectedReceipt);
    const now = input.now();
    const context = input.context(r.evaluationTime);
    const fresh = input.context(now);
    const position = input.position(r.symbol);
    if (r.gatewayMode !== 'GATEIO_ACCOUNT_BOUND' || r.decision !== 'ADMITTED' || r.action !== 'open'
        || r.exchange !== 'gateio' || r.settle !== 'USDT' || r.accountId !== input.accountId
        || r.intentId !== b.intent.intentId || r.symbol !== b.intent.symbol
        || r.requestedPositionUsdExact !== preTradeReceiptExactNumber(b.intent.positionUsd)
        || b.intent.exchange !== r.exchange || r.riskIncreaseProof?.intentDigest !== riskIncreaseIntentDigest(b.intent)
        || r.riskIncreaseProof.direction !== b.intent.direction
        || r.riskIncreaseProof.orderId !== generateOrderId({ ...b.intent, action: 'open', approvedPositionUsd: b.approvedUsd })
        || r.approvedPositionUsdExact !== preTradeReceiptExactNumber(b.approvedUsd) || b.approvedUsd <= 0
        || !Number.isSafeInteger(now) || now < r.evaluationTime
        || context.status !== 'COMPATIBLE' || fresh.status !== 'COMPATIBLE'
        || !context.compatible || !fresh.compatible || context.evaluationTime !== r.evaluationTime
        || context.identity.exchange !== r.exchange || context.identity.settle !== r.settle
        || fresh.identity.exchange !== r.exchange || fresh.identity.settle !== r.settle
        || context.identity.accountId !== r.accountId || fresh.identity.accountId !== r.accountId
        || context.contextDigest !== r.contextDigest || context.provenance.snapshotDigest !== r.snapshotDigest
        || context.provenance.mandateDigest !== r.mandateDigest
        || context.snapshot.accountingDayId !== r.accountingDayId
        || input.riskStateDigest() !== b.riskStateDigest
        || position.snapshot === null || position.snapshot.positionVersion !== r.positionVersion
        || position.snapshot.sourceKernelEventId !== r.positionSourceKernelEventId
        || (r.riskEffect === 'OPEN' ? position.status !== 'flat'
          : r.riskEffect !== 'INCREASE' || position.status !== 'open' || position.side !== b.intent.direction)
        || e.type !== 'PRETRADE_RISK_DECISION_RECORDED' || e.kernelLogicalSequence <= b.priorJournalSequence
        || e.kernelTimestamp < r.evaluationTime || e.kernelTimestamp > now
        || !same(e.payload, b.expectedReceipt)) deny();
    const record = input.receipts.snapshot().records.find(v => v.receiptDigest === b.expectedReceipt.receiptDigest);
    if (!record || record.kernelEventId !== e.kernelEventId || record.kernelLogicalSequence !== e.kernelLogicalSequence
        || record.kernelTimestamp !== e.kernelTimestamp
        || preTradeRiskDecisionReceiptDigest(record.receipt) !== b.expectedReceipt.receiptDigest) deny();
    // Neither publish status, the journal cache nor a projection proves disk persistence.
    if (typeof input.journalPath !== 'string' || !isAbsolute(input.journalPath)) deny();
    // Windows FlushFileBuffers requires a writable handle; opening r+ never truncates/appends.
    const fd = openSync(input.journalPath, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const reopened = createFileEventJournal(input.journalPath);
    const durable = reopened.getByEventId(e.kernelEventId);
    if (!durable || !same(durable, e)) deny();
  }
  function requirePermit(token: unknown): Permit {
    if (token === null || typeof token !== 'object') deny();
    const permit = permits.get(token);
    if (!permit || permit.stage === 'CLOSED') deny();
    return permit;
  }
  function checkOrder(p: Permit, order: OmsOrder) {
    const b = p.binding;
    if (order.action !== 'open' || order.orderType !== 'market'
        || order.orderId !== b.expectedReceipt.receipt.riskIncreaseProof!.orderId
        || order.intentId !== b.intent.intentId || order.exchange !== b.intent.exchange
        || order.symbol !== b.intent.symbol || order.side !== (b.intent.direction === 'long' ? 'buy' : 'sell')
        || order.approvedNotionalUsd !== b.approvedUsd) deny();
  }
  return Object.freeze({
    issue(binding: RiskIncreaseAdmissionBinding, publication: PublishResult<'PRETRADE_RISK_DECISION_RECORDED'>): object {
      if (publication.status !== 'accepted' || publication.failures !== 0
          || issued.has(binding.expectedReceipt.receiptDigest)) deny();
      const cloned = structuredClone({ binding, envelope: publication.envelope });
      const permit: Permit = { ...cloned, stage: 'ISSUED' };
      verify(permit);
      const token = Object.freeze(Object.create(null));
      permits.set(token, permit);
      issued.add(binding.expectedReceipt.receiptDigest);
      return token;
    },
    enterOms(token: unknown, intent: TradeIntent, approvedUsd: number) {
      const p = requirePermit(token);
      if (p.stage !== 'ISSUED' || spent.has(p.binding.expectedReceipt.receiptDigest)
          || riskIncreaseIntentDigest(intent) !== riskIncreaseIntentDigest(p.binding.intent)
          || approvedUsd !== p.binding.approvedUsd) deny();
      verify(p);
      spent.add(p.binding.expectedReceipt.receiptDigest);
      p.stage = 'OMS'; // consumed even if later sizing/transport fails; never reusable
    },
    enterAdapter(token: unknown, order: OmsOrder) {
      const p = requirePermit(token);
      if (p.stage !== 'OMS') deny();
      checkOrder(p, order); verify(p); p.stage = 'ADAPTER';
    },
    checkAdapter(token: unknown, order: OmsOrder) {
      const p = requirePermit(token);
      if (p.stage !== 'ADAPTER') deny();
      checkOrder(p, order); verify(p);
    },
    close(token: unknown) {
      if (token && typeof token === 'object') {
        const p = permits.get(token);
        if (p) p.stage = 'CLOSED';
      }
    },
  });
}
