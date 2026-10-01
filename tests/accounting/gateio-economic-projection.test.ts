import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createGateIoEconomicLedger,
  recordGateIoEconomicFact,
} from '../../src/accounting/gateio-economic-ledger';
import type { GateIoEconomicLedgerState } from '../../src/accounting/gateio-economic-ledger-types';
import {
  GateIoEconomicProjectionError,
  projectGateIoEconomicState,
} from '../../src/accounting/gateio-economic-projection';
import {
  GATEIO_TRACKED_EXECUTION_EVIDENCE_SCHEMA_VERSION,
  type TrackedExecutionEconomicEvidence,
} from '../../src/accounting/gateio-economic-projection-types';
import { normalizeGateIoAccountBookPage } from '../../src/accounting/gateio-economic-truth';
import type { GateIoCanonicalEconomicEvent } from '../../src/accounting/gateio-economic-truth-types';
import { createTradingKernel, type TradingKernel } from '../../src/kernel/TradingKernel';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { replayJournal, type ProjectorMap } from '../../src/recovery/ReplayCoordinator';

const BASE_TIME = 1_900_000_000_000;

interface FactInput {
  id: string;
  type?: string;
  change?: string;
  balance?: string;
  time?: number;
  tradeId?: string | null;
  contract?: string | null;
  observedAt?: number;
  offset?: number;
}

function fact(input: FactInput): GateIoCanonicalEconomicEvent {
  const raw: Record<string, unknown> = {
    id: input.id,
    type: input.type ?? 'fee',
    change: input.change ?? '-1',
    balance: input.balance ?? '100',
    time: input.time ?? BASE_TIME,
  };
  if (input.tradeId !== null && input.tradeId !== undefined) raw.trade_id = input.tradeId;
  if (input.contract !== null) raw.contract = input.contract ?? 'ETH_USDT';
  const normalized = normalizeGateIoAccountBookPage([raw], {
    observedAt: input.observedAt ?? BASE_TIME + 10_000,
    pageRequest: { limit: 100, offset: input.offset ?? 0 },
  })[0];
  assert.ok(normalized);
  return normalized;
}

function createWriter(): {
  ledger: ReturnType<typeof createGateIoEconomicLedger>;
  kernel: TradingKernel;
} {
  const ledger = createGateIoEconomicLedger();
  let now = BASE_TIME + 20_000;
  const kernel = createTradingKernel({
    exchange: 'gateio',
    clock: { now: () => now++ },
  });
  return { ledger, kernel };
}

function stateFromFacts(facts: readonly GateIoCanonicalEconomicEvent[]): GateIoEconomicLedgerState {
  const writer = createWriter();
  for (const entry of facts) recordGateIoEconomicFact(writer.kernel, writer.ledger, entry);
  return writer.ledger.snapshot();
}

function evidence(
  trackedTradeIds: readonly string[],
  captureScope: TrackedExecutionEconomicEvidence['captureScope'] =
    'SUFFICIENT_FOR_TRACKED_TRADES',
): TrackedExecutionEconomicEvidence {
  return Object.freeze({
    schemaVersion: GATEIO_TRACKED_EXECUTION_EVIDENCE_SCHEMA_VERSION,
    trackedTradeIds: Object.freeze([...trackedTradeIds]),
    evidenceCapturedAt: BASE_TIME + 30_000,
    provenance: Object.freeze({ source: 'focused-test-tracked-executions' }),
    captureScope,
  });
}

function activityFor(
  projection: ReturnType<typeof projectGateIoEconomicState>,
  sourceId: string,
) {
  return projection.observedActivities.find((entry) =>
    entry.identity.endsWith(`\"${sourceId}\"]`));
}

describe('Gate.io deterministic economic projection', () => {
  it('projects one documented category without inventing totals for missing categories', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'fee-1', change: '-0.25' }),
    ]));
    assert.equal(projection.economicEventCount, 1);
    assert.equal(projection.categoryCounts.TRADING_FEE, 1);
    assert.equal(projection.categoryChangeTotals.TRADING_FEE, '-0.25');
    assert.equal(projection.categoryCounts.FUNDING, 0);
    assert.equal(projection.categoryChangeTotals.FUNDING, null);
    assert.equal('netAccountPnl' in projection, false);
  });

  it('aggregates multiple categories independently', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'fee-a', type: 'fee', change: '-0.2' }),
      fact({ id: 'fee-b', type: 'fee', change: '-0.3' }),
      fact({ id: 'fund-a', type: 'fund', change: '0.75' }),
      fact({ id: 'point-a', type: 'point_fee', change: '-4' }),
    ]));
    assert.equal(projection.categoryChangeTotals.TRADING_FEE, '-0.5');
    assert.equal(projection.categoryChangeTotals.FUNDING, '0.75');
    assert.equal(projection.categoryChangeTotals.POINT_FEE, '-4');
    assert.equal(projection.documentedCategoryFacts.length, 4);
  });

  it('uses exact arbitrary-precision decimal aggregation', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'precision-a', change: '999999999999999999.000000000000000001' }),
      fact({ id: 'precision-b', change: '0.000000000000000009' }),
    ]));
    assert.equal(
      projection.categoryChangeTotals.TRADING_FEE,
      '999999999999999999.00000000000000001',
    );
  });

  it('preserves positive and negative signs and distinguishes a factual zero sum', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'sign-a', change: '10.000' }),
      fact({ id: 'sign-b', change: '-12.5' }),
      fact({ id: 'zero-a', type: 'fund', change: '2.5' }),
      fact({ id: 'zero-b', type: 'fund', change: '-2.5' }),
    ]));
    assert.equal(projection.categoryChangeTotals.TRADING_FEE, '-2.5');
    assert.equal(projection.categoryChangeTotals.FUNDING, '0');
    assert.notEqual(projection.categoryChangeTotals.FUNDING, null);
  });

  it('does not aggregate a duplicate durable fact twice', () => {
    const writer = createWriter();
    const duplicate = fact({ id: 'duplicate', change: '-0.125' });
    assert.equal(recordGateIoEconomicFact(writer.kernel, writer.ledger, duplicate).status,
      'RECORDED_NEW_FACT');
    assert.equal(recordGateIoEconomicFact(writer.kernel, writer.ledger, duplicate).status,
      'DUPLICATE_SAME_FACT');
    const projection = projectGateIoEconomicState(writer.ledger.snapshot());
    assert.equal(projection.economicEventCount, 1);
    assert.equal(projection.categoryChangeTotals.TRADING_FEE, '-0.125');
  });

  it('retains identity conflict evidence but excludes the identity from trusted totals', () => {
    const writer = createWriter();
    recordGateIoEconomicFact(writer.kernel, writer.ledger,
      fact({ id: 'conflict', change: '-100', balance: '900' }));
    assert.equal(recordGateIoEconomicFact(writer.kernel, writer.ledger,
      fact({ id: 'conflict', change: '500', balance: '1500', observedAt: BASE_TIME + 40_000 })).status,
    'IDENTITY_CONFLICT');
    recordGateIoEconomicFact(writer.kernel, writer.ledger,
      fact({ id: 'trusted', change: '-2', balance: '898', time: BASE_TIME + 1 }));
    const projection = projectGateIoEconomicState(writer.ledger.snapshot());
    assert.equal(projection.identityConflictCount, 1);
    assert.equal(projection.trustedEconomicEventCount, 1);
    assert.equal(projection.categoryChangeTotals.TRADING_FEE, '-2');
    assert.equal(projection.observedActivityCounts.IDENTITY_CONFLICT, 1);
    assert.equal(projection.completenessStatus, 'CONFLICTED');
    assert.equal(projection.projectionUsableForObservedAccounting, false);
    assert.equal(projection.balanceStatus, 'IDENTITY_CONFLICT');
    assert.equal(projection.terminalObservedBalance, null);
    assert.equal(projection.identityConflicts[0]?.conflictingFact.change, '500');
  });

  it('preserves and counts UNCLASSIFIED activity while degrading projection usability', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'future', type: 'future_gate_type', change: '7.5' }),
    ]));
    assert.equal(projection.unclassifiedEventCount, 1);
    assert.equal(projection.categoryCounts.UNCLASSIFIED, 1);
    assert.equal(projection.categoryChangeTotals.UNCLASSIFIED, '7.5');
    assert.equal(projection.documentedCategoryFacts.length, 0);
    assert.equal(projection.unclassifiedFacts.length, 1);
    assert.equal(projection.completenessStatus, 'UNCLASSIFIED_PRESENT');
    assert.equal(projection.projectionUsableForObservedAccounting, false);
  });

  it('emits terminalObservedBalance only for a unique maximum occurredAt candidate', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'old', time: BASE_TIME, balance: '10' }),
      fact({ id: 'new', time: BASE_TIME + 1, balance: '11' }),
    ]));
    assert.equal(projection.balanceStatus, 'TERMINAL_OBSERVED');
    assert.equal(projection.terminalObservedBalance, '11');
    assert.equal('currentAccountBalance' in projection, false);
  });

  it('fails closed when multiple events share the maximum occurredAt', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'tie-a', time: BASE_TIME + 5, balance: '11' }),
      fact({ id: 'tie-b', time: BASE_TIME + 5, balance: '12' }),
      fact({ id: 'old', time: BASE_TIME, balance: '10' }),
    ]));
    assert.equal(projection.balanceStatus, 'AMBIGUOUS_TERMINAL_ORDER');
    assert.equal(projection.terminalObservedBalance, null);
  });

  it('keeps order-independent totals and classification stable if state fact order changes', () => {
    const state = stateFromFacts([
      fact({ id: 'order-a', type: 'fee', change: '-0.1', tradeId: 'trade-a' }),
      fact({ id: 'order-b', type: 'fund', change: '0.2' }),
    ]);
    const reordered = JSON.parse(JSON.stringify(state)) as GateIoEconomicLedgerState;
    (reordered.facts as GateIoEconomicLedgerState['facts'][number][]).reverse();
    const first = projectGateIoEconomicState(state, evidence(['trade-a']));
    const second = projectGateIoEconomicState(reordered, evidence(['trade-a']));
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});

describe('Gate.io observed activity classification and bounded reconciliation', () => {
  it('classifies a supplied tracked trade ID as TRACKED_TRADE_LINKED', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'tracked', type: 'fee', tradeId: 'trade-1' }),
    ]), evidence(['trade-1']));
    assert.equal(activityFor(projection, 'tracked')?.classification, 'TRACKED_TRADE_LINKED');
    assert.equal(projection.observedActivityCounts.TRACKED_TRADE_LINKED, 1);
  });

  it('classifies a trade-linked fact outside the supplied set as UNTRACKED_TRADE_LINKED', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'untracked', type: 'pnl', tradeId: 'external-trade' }),
    ]), evidence(['tracked-trade']));
    assert.equal(activityFor(projection, 'untracked')?.classification, 'UNTRACKED_TRADE_LINKED');
    assert.equal(projection.untrackedObservedActivityCount, 1);
  });

  it('classifies fee and pnl without tradeId as UNLINKED_TRADE_ECONOMIC_ACTIVITY', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'fee-unlinked', type: 'fee', tradeId: null }),
      fact({ id: 'pnl-unlinked', type: 'pnl', tradeId: null }),
    ]), evidence(['expected']));
    assert.equal(projection.observedActivityCounts.UNLINKED_TRADE_ECONOMIC_ACTIVITY, 2);
  });

  it('classifies documented funding and transfer as NON_TRADE_ACCOUNT_ACTIVITY', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'funding', type: 'fund', tradeId: null }),
      fact({ id: 'transfer', type: 'dnw', tradeId: null }),
    ]));
    assert.equal(projection.observedActivityCounts.NON_TRADE_ACCOUNT_ACTIVITY, 2);
    assert.equal(activityFor(projection, 'funding')?.classification,
      'NON_TRADE_ACCOUNT_ACTIVITY');
  });

  it('returns tracked attribution COMPLETE only under the strict bounded success conditions', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'trade-a-fee', type: 'fee', tradeId: 'trade-a' }),
      fact({ id: 'trade-b-pnl', type: 'pnl', tradeId: 'trade-b' }),
    ]), evidence(['trade-b', 'trade-a']));
    assert.equal(projection.trackedExecutionAttribution.status, 'COMPLETE');
    assert.deepEqual(projection.trackedExecutionAttribution.matchedTrackedTradeIds,
      ['trade-a', 'trade-b']);
    assert.deepEqual(projection.trackedExecutionAttribution.missingTrackedTradeIds, []);
    assert.equal(projection.accountActivityReconciled, 'UNAVAILABLE');
  });

  it('returns attribution UNAVAILABLE when capture scope is not proven', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'matched-but-unproven', tradeId: 'trade-a' }),
    ]), evidence(['trade-a'], 'NOT_PROVEN'));
    assert.equal(projection.trackedExecutionAttribution.status, 'UNAVAILABLE');
    assert.deepEqual(projection.trackedExecutionAttribution.reasons, ['CAPTURE_SCOPE_NOT_PROVEN']);
  });

  it('returns attribution INCOMPLETE when an expected tracked trade is missing', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'only-a', tradeId: 'trade-a' }),
    ]), evidence(['trade-a', 'trade-b']));
    assert.equal(projection.trackedExecutionAttribution.status, 'INCOMPLETE');
    assert.deepEqual(projection.trackedExecutionAttribution.missingTrackedTradeIds, ['trade-b']);
    assert.ok(projection.trackedExecutionAttribution.reasons.includes(
      'EXPECTED_TRACKED_TRADE_MISSING'));
  });

  it('never promotes zero observed untracked trades into account-wide reconciliation', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'only-tracked', tradeId: 'trade-a' }),
    ]), evidence(['trade-a']));
    assert.equal(projection.untrackedObservedActivityCount, 0);
    assert.equal(projection.trackedExecutionAttribution.status, 'COMPLETE');
    assert.equal(projection.accountActivityReconciled, 'UNAVAILABLE');
    assert.equal(projection.provenance.completeAccountHistory, false);
    assert.equal(projection.provenance.authoritativeExchangeCursor, false);
  });

  it('keeps tracked attribution unavailable when no evidence object is supplied', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'trade-without-evidence', tradeId: 'trade-a' }),
    ]));
    assert.equal(projection.trackedExecutionAttribution.status, 'UNAVAILABLE');
    assert.equal(activityFor(projection, 'trade-without-evidence')?.classification,
      'UNTRACKED_TRADE_LINKED');
  });

  it('blocks COMPLETE when a tracked trade is represented only by UNCLASSIFIED activity', () => {
    const projection = projectGateIoEconomicState(stateFromFacts([
      fact({ id: 'unknown-tracked', type: 'future_type', tradeId: 'trade-a' }),
    ]), evidence(['trade-a']));
    assert.equal(projection.trackedExecutionAttribution.status, 'INCOMPLETE');
    assert.ok(projection.trackedExecutionAttribution.reasons.includes(
      'TRACKED_UNCLASSIFIED_AMBIGUITY'));
    assert.equal(activityFor(projection, 'unknown-tracked')?.classification,
      'UNCLASSIFIED_ACTIVITY');
  });

  it('blocks COMPLETE whenever the durable ledger contains an identity conflict', () => {
    const writer = createWriter();
    recordGateIoEconomicFact(writer.kernel, writer.ledger,
      fact({ id: 'conflicted-tracked', tradeId: 'trade-a', change: '-1' }));
    recordGateIoEconomicFact(writer.kernel, writer.ledger,
      fact({
        id: 'conflicted-tracked', tradeId: 'trade-a', change: '-2',
        observedAt: BASE_TIME + 60_000,
      }));
    const projection = projectGateIoEconomicState(
      writer.ledger.snapshot(),
      evidence(['trade-a']),
    );
    assert.equal(projection.trackedExecutionAttribution.status, 'INCOMPLETE');
    assert.ok(projection.trackedExecutionAttribution.reasons.includes(
      'IDENTITY_CONFLICT_PRESENT'));
  });
});

describe('Gate.io projection replay and validation boundary', () => {
  it('rebuilds an identical projection after durable journal restart and replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-economic-projection-'));
    const path = join(dir, 'journal.jsonl');
    try {
      const journal = createFileEventJournal(path);
      const liveLedger = createGateIoEconomicLedger();
      let now = BASE_TIME + 50_000;
      const kernel = createTradingKernel({
        exchange: 'gateio',
        journal,
        initialSequence: journal.lastSequence,
        clock: { now: () => now++ },
      });
      recordGateIoEconomicFact(kernel, liveLedger,
        fact({ id: 'restart-fee', type: 'fee', change: '-0.3', tradeId: 'trade-a' }));
      recordGateIoEconomicFact(kernel, liveLedger,
        fact({ id: 'restart-fund', type: 'fund', change: '0.1', time: BASE_TIME + 1 }));
      const expected = projectGateIoEconomicState(liveLedger.snapshot(), evidence(['trade-a']));

      const recovered = createGateIoEconomicLedger();
      const reopened = createFileEventJournal(path);
      const projectors = new Map([
        ['GATEIO_ECONOMIC_EVENT_RECORDED', [recovered]],
      ]) as ProjectorMap;
      assert.deepEqual(replayJournal(reopened, projectors).errors, []);
      const actual = projectGateIoEconomicState(recovered.snapshot(), evidence(['trade-a']));
      assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed ledger state instead of projecting partial or zero values', () => {
    const state = stateFromFacts([fact({ id: 'malformed-source', change: '-1' })]);
    const malformed = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    malformed.uniqueIdentityCount = 99;
    assert.throws(
      () => projectGateIoEconomicState(malformed as unknown as GateIoEconomicLedgerState),
      (error: unknown) => error instanceof GateIoEconomicProjectionError
        && error.code === 'GATEIO_ECONOMIC_PROJECTION_STATE_INVALID',
    );
  });

  it('rejects malformed tracked evidence rather than silently deduplicating it', () => {
    const state = stateFromFacts([fact({ id: 'evidence-source', tradeId: 'trade-a' })]);
    const malformed = {
      ...evidence(['trade-a']),
      trackedTradeIds: ['trade-a', 'trade-a'],
    } as TrackedExecutionEconomicEvidence;
    assert.throws(
      () => projectGateIoEconomicState(state, malformed),
      (error: unknown) => error instanceof GateIoEconomicProjectionError
        && error.code === 'GATEIO_ECONOMIC_PROJECTION_EVIDENCE_INVALID',
    );
  });

  it('returns immutable output without mutating the durable state or evidence inputs', () => {
    const state = stateFromFacts([fact({ id: 'immutable', tradeId: 'trade-a' })]);
    const trackedEvidence = evidence(['trade-a']);
    const beforeState = JSON.stringify(state);
    const beforeEvidence = JSON.stringify(trackedEvidence);
    const projection = projectGateIoEconomicState(state, trackedEvidence);
    assert.equal(Object.isFrozen(projection), true);
    assert.equal(Object.isFrozen(projection.categoryCounts), true);
    assert.equal(Object.isFrozen(projection.trackedExecutionAttribution), true);
    assert.equal(JSON.stringify(state), beforeState);
    assert.equal(JSON.stringify(trackedEvidence), beforeEvidence);
  });
});
