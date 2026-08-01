/**
 * SUSA-Inspired Regime Gate — focused tests (TypeScript)
 * Paper-inspired: arXiv 2607.22491. Project-specific deterministic heuristic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyRegime,
  evaluateRegimeEntryPolicy,
  REGIME_SCHEMA_VERSION,
  REGIME_POLICY_VERSION,
  type RegimeObservation,
} from '../../src/strategies/shared/regime-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, '..', 'fixtures', 'regime-gate-golden-vectors.json');

interface GoldenVector {
  id: string; description: string;
  obs: { prices: number[]; closeTimesMs: number[]; decisionTimeMs: number };
  expectedRegime: string; expectedValid: boolean; expectedAllow: boolean;
}

const VECTORS: GoldenVector[] = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'));

describe('Regime Gate — golden vectors (TS)', () => {
  for (const vec of VECTORS) {
    it(`${vec.id}: ${vec.description}`, () => {
      const snapshot = classifyRegime(vec.obs as RegimeObservation);
      assert.equal(snapshot.regime, vec.expectedRegime);
      assert.equal(snapshot.valid, vec.expectedValid);
      const d = evaluateRegimeEntryPolicy(snapshot);
      assert.equal(d.allow, vec.expectedAllow);
    });
  }
});

describe('Regime Gate — UNKNOWN fail-closed', () => {
  it('insufficient data (5 prices) → UNKNOWN → BLOCK', () => {
    const s = classifyRegime({ prices: [100,101,102,103,104], closeTimesMs: [0,1000,2000,3000,4000], decisionTimeMs: 4000 });
    assert.equal(s.regime, 'UNKNOWN');
    assert.equal(evaluateRegimeEntryPolicy(s).allow, false);
  });

  it('NaN in prices → UNKNOWN', () => {
    const p = Array(30).fill(100); p[15] = NaN;
    const s = classifyRegime({ prices: p, closeTimesMs: p.map((_,i)=>i*1000), decisionTimeMs: 29000 });
    assert.equal(s.regime, 'UNKNOWN');
  });

  it('timestamp gap >5min → UNKNOWN', () => {
    const prices = Array(30).fill(100);
    const times = prices.map((_,i) => i * 1000);
    times[20] = times[19] + 400_000;
    for (let j=21;j<times.length;j++) times[j]=times[j-1]+1000;
    const s = classifyRegime({ prices, closeTimesMs: times, decisionTimeMs: times[29] });
    assert.equal(s.regime, 'UNKNOWN');
    assert.equal(s.reasonCode, 'timestamp_gap');
  });
});

describe('Regime Gate — entry policy', () => {
  it('calm/onset/recovery → ALLOW', () => {
    for (const r of ['calm','onset','recovery']) {
      assert.equal(evaluateRegimeEntryPolicy({valid:true,regime:r} as any).allow, true);
    }
  });
  it('persistent_stress/UNKNOWN → BLOCK', () => {
    assert.equal(evaluateRegimeEntryPolicy({valid:true,regime:'persistent_stress'} as any).allow, false);
    assert.equal(evaluateRegimeEntryPolicy({valid:false,regime:'UNKNOWN'} as any).allow, false);
  });
});

describe('Regime Gate — disabled equivalence', () => {
  it('classifier is pure; same input → same output', () => {
    const prices=Array(30).fill(100); const times=prices.map((_,i)=>i*1000);
    const a=classifyRegime({prices:[...prices],closeTimesMs:[...times],decisionTimeMs:29000});
    const b=classifyRegime({prices:[...prices],closeTimesMs:[...times],decisionTimeMs:29000});
    assert.deepEqual(a.regime, b.regime);
  });
});
