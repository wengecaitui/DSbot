/**
 * Price-Level Adaptive Stop — focused tests
 *
 * AdaptiveTrend-inspired binary-market heuristic (arXiv 2602.11708).
 * Project-specific: NOT an exact reproduction of AdaptiveTrend.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAdaptiveStop,
  ADAPTIVE_STOP_POLICY_VERSION,
  type AdaptiveStopInput,
} from '../../src/strategies/shared/adaptive-stop.js';

const BASE: AdaptiveStopInput = {
  entryPrice: 0.50,
  baseStopLossPct: 12,
  highK: 3.0,
  normalK: 2.0,
  lowK: 1.5,
  maxMultiplier: 1.5,
};

function result(input: Partial<AdaptiveStopInput> & { entryPrice: number }) {
  return computeAdaptiveStop({ ...BASE, ...input });
}

describe('Adaptive Stop — zone classification', () => {
  it('entry 0.50 (exact centre) → ATM k=3.0', () => {
    const r = result({ entryPrice: 0.50 });
    assert.equal(r.regime, 'ATM');
    assert.equal(r.multiplierK, 3.0);
    assert.equal(r.policyVersion, ADAPTIVE_STOP_POLICY_VERSION);
  });

  it('entry 0.35 (ATM boundary) → ATM', () => {
    assert.equal(result({ entryPrice: 0.35 }).regime, 'ATM');
    assert.equal(result({ entryPrice: 0.65 }).regime, 'ATM');
  });

  it('entry 0.25 (MID boundary) → MID', () => {
    assert.equal(result({ entryPrice: 0.25 }).regime, 'MID');
    assert.equal(result({ entryPrice: 0.75 }).regime, 'MID');
    assert.equal(result({ entryPrice: 0.25 }).multiplierK, 2.0);
  });

  it('entry 0.24 (just outside MID) → EDGE', () => {
    assert.equal(result({ entryPrice: 0.24 }).regime, 'EDGE');
    assert.equal(result({ entryPrice: 0.76 }).regime, 'EDGE');
  });

  it('symmetry: 0.49 and 0.51 give same regime', () => {
    const a = result({ entryPrice: 0.49 });
    const b = result({ entryPrice: 0.51 });
    assert.equal(a.regime, b.regime);
  });

  it('monotonic: closer to edge = lower or equal multiplierK', () => {
    const mid = result({ entryPrice: 0.30 }).multiplierK;
    const edge = result({ entryPrice: 0.20 }).multiplierK;
    assert.ok(edge <= mid, `edge(${edge}) should be <= mid(${mid})`);
  });
});

describe('Adaptive Stop — effective stop computation', () => {
  it('ATM: effectiveSl = baseSl × (highK / normalK)', () => {
    const r = result({ entryPrice: 0.50 }); // ATM, k=3.0
    const expected = 12 * (3.0 / 2.0); // = 18
    assert.equal(r.effectiveStopLossPct, expected);
  });

  it('MID: effectiveSl = baseSl × (normalK / normalK) = baseSl', () => {
    const r = result({ entryPrice: 0.30 }); // MID, k=2.0
    assert.equal(r.effectiveStopLossPct, 12);
  });

  it('EDGE: effectiveSl = baseSl × (lowK / normalK) = strict', () => {
    const r = result({ entryPrice: 0.10 }); // EDGE, k=1.5
    const expected = 12 * (1.5 / 2.0); // = 9
    assert.equal(r.effectiveStopLossPct, expected);
  });

  it('cap by maxMultiplier: very large base should not exceed 1.5x', () => {
    const r = computeAdaptiveStop({ ...BASE, entryPrice: 0.50, baseStopLossPct: 100 });
    assert.ok(r.effectiveStopLossPct <= 150); // capped at 100 * 1.5 = 150
    assert.equal(r.effectiveStopLossPct, 150);
  });
});

describe('Adaptive Stop — input validation', () => {
  it('throws on NaN entryPrice', () => {
    assert.throws(() => computeAdaptiveStop({ ...BASE, entryPrice: NaN }), /entryPrice/);
  });
  it('throws on Infinity entryPrice', () => {
    assert.throws(() => computeAdaptiveStop({ ...BASE, entryPrice: Infinity }), /entryPrice/);
  });
  it('throws on negative entryPrice', () => {
    assert.throws(() => computeAdaptiveStop({ ...BASE, entryPrice: -0.1 }), /entryPrice/);
  });
  it('throws on entryPrice > 1', () => {
    assert.throws(() => computeAdaptiveStop({ ...BASE, entryPrice: 1.1 }), /entryPrice/);
  });
  it('throws on baseStopLossPct <= 0', () => {
    assert.throws(() => computeAdaptiveStop({ ...BASE, baseStopLossPct: 0 }), /baseStopLossPct/);
  });
  it('throws on normalK <= 0', () => {
    assert.throws(() => computeAdaptiveStop({ ...BASE, normalK: 0 }), /normalK/);
  });
  it('throws on maxMultiplier <= 0', () => {
    assert.throws(() => computeAdaptiveStop({ ...BASE, maxMultiplier: 0 }), /maxMultiplier/);
  });
  it('does NOT throw for valid input', () => {
    assert.doesNotThrow(() => computeAdaptiveStop(BASE));
  });
});

describe('Adaptive Stop — disabled equivalence', () => {
  it('same output shape even when disabled (caller decides usage)', () => {
    // The shared function always computes; the POSITION MANAGER decides
    // whether to use it. This test confirms the function itself is pure
    // and produces deterministic, identical output for identical inputs.
    const a = result({ entryPrice: 0.50 });
    const b = result({ entryPrice: 0.50 });
    assert.deepEqual(a, b);
  });

  it('policyVersion is constant', () => {
    assert.equal(result({ entryPrice: 0.50 }).policyVersion, ADAPTIVE_STOP_POLICY_VERSION);
    assert.equal(result({ entryPrice: 0.10 }).policyVersion, ADAPTIVE_STOP_POLICY_VERSION);
  });
});
