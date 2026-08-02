/**
 * Realized Cost-Drag Circuit Breaker — focused tests
 *
 * Paper-inspired: arXiv 2607.19453 — predictive accuracy != tradable profitability.
 * FEES_ONLY cost model. Project-specific adaptation, not an exact reproduction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCostSamples,
  computeCostAuditMetrics,
  validateCostSample,
  type TradeCostSample,
} from '../../src/strategies/shared/cost-drag.js';

function makeSample(overrides: Partial<TradeCostSample> & { override_id?: string }): TradeCostSample {
  return {
    tradeId: overrides.override_id ?? `test-${Math.random().toString(36).slice(2, 6)}`,
    openedAtMs: 1000,
    closedAtMs: 2000,
    referenceNotionalUsd: 1000,
    grossPnlUsd: 100,
    feeCostUsd: 30,
    netPnlUsd: 70, // 100 - 30 = 70
    ...overrides,
  };
}

describe('Cost-Drag — weighted aggregation', () => {
  it('empty window → all zeros, no crash', () => {
    const agg = aggregateCostSamples([]);
    assert.equal(agg.sampleCount, 0);
    assert.equal(agg.aggregateGrossPnlUsd, 0);
    assert.equal(agg.aggregateNotionalUsd, 0);
  });

  it('netBps ≈ grossBps - costBps (amount-weighted)', () => {
    const metrics = computeCostAuditMetrics(
      [makeSample({ override_id: 'a' })],
      { gateEnabled: true, minCompletedTrades: 1, probeInFlight: false, blocked: false },
    );
    // grossBps = 100/1000 * 10000 = 1000; costBps = 30/1000 * 10000 = 300; netBps = 700
    assert.equal(metrics.grossBps, 1000);
    assert.equal(metrics.costBps, 300);
    assert.ok(Math.abs(metrics.netBps - 700) < 1e-6,
      `netBps ${metrics.netBps} should be ~700`);
    assert.ok(Math.abs(metrics.netBps - (metrics.grossBps - metrics.costBps)) < 1e-6,
      `netBps ${metrics.netBps} should ≈ grossBps ${metrics.grossBps} - costBps ${metrics.costBps}`);
  });

  it('different notionals: weighted, not simple average', () => {
    const big = makeSample({ override_id: 'big', referenceNotionalUsd: 10000, grossPnlUsd: 1000, feeCostUsd: 200, netPnlUsd: 800 });
    const small = makeSample({ override_id: 'small', referenceNotionalUsd: 100, grossPnlUsd: 10, feeCostUsd: 5, netPnlUsd: 5 });
    const metrics = computeCostAuditMetrics(
      [big, small],
      { gateEnabled: true, minCompletedTrades: 1, probeInFlight: false, blocked: false },
    );
    // Total notional: 10100; total gross: 1010; total fee: 205; total net: 805
    // grossBps = 1010/10100 * 10000 = 1000; costBps = 205/10100 * 10000 ≈ 202.97
    assert.ok(Math.abs(metrics.grossBps - 1000) < 5, `grossBps=${metrics.grossBps}`);
    assert.ok(Math.abs(metrics.netBps - (metrics.grossBps - metrics.costBps)) < 1e-6);
  });
});

describe('Cost-Drag — gross <= 0 contract', () => {
  it('positive gross → costToGrossRatio is finite number', () => {
    const m = computeCostAuditMetrics(
      [makeSample({ override_id: 'a' })],
      { gateEnabled: true, minCompletedTrades: 1, probeInFlight: false, blocked: false },
    );
    assert.equal(typeof m.costToGrossRatio, 'number');
    assert.ok(m.costToGrossRatio! > 0);
    assert.equal(m.grossBps, 1000);
  });

  it('zero gross → costToGrossRatio is null, status NO_POSITIVE_GROSS', () => {
    const s = makeSample({ override_id: 'a', grossPnlUsd: 0, feeCostUsd: 10, netPnlUsd: -10 });
    const m = computeCostAuditMetrics(
      [s],
      { gateEnabled: true, minCompletedTrades: 1, probeInFlight: false, blocked: false },
    );
    assert.equal(m.costToGrossRatio, null);
    assert.equal(m.costHurdleStatus, 'NO_POSITIVE_GROSS');
  });

  it('negative gross → costToGrossRatio is null, status NO_POSITIVE_GROSS', () => {
    const s = makeSample({ override_id: 'a', grossPnlUsd: -50, feeCostUsd: 10, netPnlUsd: -60 });
    const m = computeCostAuditMetrics(
      [s],
      { gateEnabled: true, minCompletedTrades: 1, probeInFlight: false, blocked: false },
    );
    assert.equal(m.costToGrossRatio, null);
    assert.equal(m.costHurdleStatus, 'NO_POSITIVE_GROSS');
    // costBps can be computed (fees / notional) even when gross <= 0
    assert.ok(m.costBps > 0);
  });
});

describe('Cost-Drag — warming-up gate', () => {
  it('below minCompletedTrades → WARMING_UP', () => {
    const s = makeSample({ override_id: 'a' });
    const m = computeCostAuditMetrics(
      [s],
      { gateEnabled: true, minCompletedTrades: 10, probeInFlight: false, blocked: false },
    );
    assert.equal(m.costHurdleStatus, 'WARMING_UP');
  });

  it('at or above min → not WARMING_UP', () => {
    const samples = Array.from({ length: 10 }, (_, i) => makeSample({ override_id: String(i) }));
    const m = computeCostAuditMetrics(
      samples,
      { gateEnabled: true, minCompletedTrades: 10, probeInFlight: false, blocked: false },
    );
    assert.notEqual(m.costHurdleStatus, 'WARMING_UP');
  });
});

describe('Cost-Drag — 50% boundary', () => {
  it('ratio 0.50 → not blocked by ratio, status OK', () => {
    // gross=100, fee=50 → ratio=0.50
    const s = makeSample({ override_id: 'a', grossPnlUsd: 100, feeCostUsd: 50, netPnlUsd: 50 });
    const m = computeCostAuditMetrics(
      [s],
      { gateEnabled: true, minCompletedTrades: 1, probeInFlight: false, blocked: false },
    );
    assert.ok(m.costToGrossRatio! <= 0.51 && m.costToGrossRatio! >= 0.49);
    assert.equal(m.costHurdleStatus, 'OK');
  });

  it('ratio 0.51 → BLOCKED if blocked flag set', () => {
    const s = makeSample({ override_id: 'a', grossPnlUsd: 100, feeCostUsd: 51, netPnlUsd: 49 });
    const m = computeCostAuditMetrics(
      [s],
      { gateEnabled: true, minCompletedTrades: 1, probeInFlight: false, blocked: true },
    );
    assert.equal(m.costHurdleStatus, 'BLOCKED');
    assert.ok(m.costToGrossRatio! > 0.50);
  });
});

describe('Cost-Drag — probe state', () => {
  it('probe in flight → PROBE_IN_FLIGHT status', () => {
    const m = computeCostAuditMetrics(
      [makeSample({ override_id: 'a' })],
      { gateEnabled: true, minCompletedTrades: 1, probeInFlight: true, blocked: false },
    );
    assert.equal(m.costHurdleStatus, 'PROBE_IN_FLIGHT');
  });

  it('disabled → DISABLED status regardless', () => {
    const m = computeCostAuditMetrics(
      [makeSample({ override_id: 'a' })],
      { gateEnabled: false, minCompletedTrades: 0, probeInFlight: false, blocked: false },
    );
    assert.equal(m.costHurdleStatus, 'DISABLED');
  });
});

describe('Cost-Drag — sample validation', () => {
  it('valid sample → null', () => {
    assert.equal(validateCostSample(makeSample({ override_id: 'ok' })), null);
  });

  it('missing tradeId → error', () => {
    assert.ok(validateCostSample(makeSample({ override_id: '', tradeId: '' }))?.includes('tradeId'));
  });

  it('closed before opened → error', () => {
    assert.ok(validateCostSample(makeSample({ override_id: 'x', openedAtMs: 3000, closedAtMs: 2000 }))?.includes('closedAtMs'));
  });

  it('non-positive notional → error', () => {
    assert.ok(validateCostSample(makeSample({ override_id: 'x', referenceNotionalUsd: 0 }))?.includes('referenceNotional'));
  });

  it('net != gross - fee → error', () => {
    assert.ok(validateCostSample(makeSample({ override_id: 'x', netPnlUsd: 999 }))?.includes('netPnlUsd'));
  });
});
