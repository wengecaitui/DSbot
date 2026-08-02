# Paper-Inspired Risk Controls

> **Classification:** Research Design Document
> **Branch:** `agent/p0-paper-inspired-risk-hardening`
> **Date:** 2026-08-01

## Important Attribution

All three features below are **project-specific engineering adaptations inspired by academic papers**, NOT exact reproductions of the paper algorithms.

| Feature | Paper | Paper Finding | Our Implementation |
|---|---|---|---|
| Price-Level Adaptive Initial Stop | arXiv 2602.11708 (AdaptiveTrend) | Dynamic trailing stop calibrated to intra-day volatility regimes improves risk-adjusted returns | **Binary-price uncertainty proxy**: entry-price distance from 0.50 is used as a heuristic uncertainty measure, NOT measured ATR. |
| Realized Cost-Drag Circuit Breaker | arXiv 2607.19453 (Predictive Extrema, Unprofitable Policies) | High predictive accuracy does not guarantee tradable profitability — fees and turnover can erase gross edge | **FEES_ONLY cost model**: only entry+exit fees counted; spread/slippage/impact/funding are NOT available. Rolling-window amount-weighted aggregation with probe recovery. |
| SUSA-Inspired Four-State Regime Gate | arXiv 2607.22491 (SUSA) | Features carry different meaning across market phases; regime-conditioned interpretation improves volatility forecasting | **Deterministic 4-phase rule-based classifier**: calm/onset/recovery/persistent_stress + UNKNOWN fail-closed. NOT a reservoir architecture. |

## Feature Details

### 1. Price-Level Adaptive Initial Stop

**Shared implementation:** `src/strategies/shared/adaptive-stop.ts`

- Distance from 0.50 partitions entry prices into three zones:
  - `|dist| <= 0.15` → ATM (k=3.0, widest stop)
  - `0.15 < |dist| <= 0.25` → MID (k=2.0, baseline)
  - `|dist| > 0.25` → EDGE (k=1.5, tightest)
- `effectiveStopPct = min(basePct × (k / normalK), basePct × 1.5)`
- **Frozen at entry**: `OpenPosition` stores `effectiveStopLossPct`, `adaptiveStopPolicyVersion`, `adaptiveStopEntryPrice`, `adaptiveStopEnabledAtEntry`. `checkExits()` only reads the frozen value.
- `updateConfig()` never moves an enabled adaptive stop after entry; when the feature is disabled, the legacy fixed stop continues to follow live `stopLossPct` updates.
- Both `crypto-hft` and `hft-divergence` call the SAME `computeAdaptiveStop()` function.
- Default: `adaptiveStoplossEnabled=false` → uses fixed `stopLossPct` exactly as before.

### 2. Realized Cost-Drag Circuit Breaker

**Shared implementation:** `src/strategies/shared/cost-drag.ts`

- Structured `TradeCostSample` replaces three parallel arrays.
- Amount-weighted aggregation: `bps = sum(pnl) / sum(notional) × 10000`, never simple averages.
- Gross <= 0: `costToGrossRatio = null`, status = `NO_POSITIVE_GROSS`.
- Warming-up gate: `costHurdleMinCompletedTrades` (default 20).
- Ratio boundary: `> 0.50` blocks, `== 0.50` allows (strict).
- **Probe recovery (no permanent deadlock):**
  1. Block → cooldown (`costHurdleBlockCooldownSec`, default 300s).
  2. Cooldown expires → one probe entry allowed.
  3. Probe closes → recompute ratio. Still over → re-block. Under → clear.
- Hourly trade count: records successful **OPEN** timestamps, not closes.
- Injectable clock (`nowMs` option on `createPositionManager`).
- `resetDaily()` only clears daily PnL/cooldowns; cost samples and probe state survive.
- `STATE_PERSISTENCE=MEMORY_ONLY` — restart resets window.
- Default: `costHurdleGateEnabled=false` → no blocking.

### 3. SUSA-Inspired Four-State Regime Gate

**Shared implementation:** `src/strategies/shared/regime-gate.ts` (TS) + `quant_engine/indicators/regime_gate.py` (Python)

- **Classifier** (5 features → RegimeSnapshot) is separated from **EntryPolicy** (snapshot → ALLOW/BLOCK).
- Four valid regimes: `calm`, `onset`, `recovery`, `persistent_stress`.
- `UNKNOWN`: insufficient data, NaN, Infinity, timestamp gaps (>5min), non-monotonic timestamps, unfinished bars, invalid config.
- UNKNOWN is **fail-closed**: when gate enabled, blocks new entries.
- **The gate only blocks new entries.** It never blocks exits, stops, or position management.
- **Causal boundary:** `observationEndMs <= decisionTimeMs`, final bar must be closed.
- **Deterministic priority:** INVALID/UNKNOWN → persistent_stress → onset → calm → recovery.
- **Dual implementation:**
  - TS: hot-path, zero daemon latency, `applyRegimeGate()` in `evaluateAll()`.
  - Python: daemon/SlowPipeline path via `calculate()` in `INDICATOR_DISPATCH`.
  - Golden vectors in `tests/fixtures/regime-gate-golden-vectors.json` guarantee parity.
- Default: `regimeGateEnabled=false` → evaluateAll never calls the classifier.

## Config Defaults

```
adaptiveStoplossEnabled: false
costHurdleGateEnabled: false
regimeGateEnabled: false
```

All three are **disabled by default**. Enabling any (via `updateConfig` or preset) activates the corresponding protection. Disabling restores original behavior exactly.

## State Persistence

- Cost samples, entry timestamps, probe state, and cost-hurdle cooldown: **MEMORY_ONLY**.
  `PROCESS_RESTART_RESETS_WINDOW=true`. This is documented, not hidden.
- Daily PnL and exit cooldowns reset via `resetDaily()`.

## Files

```
src/strategies/shared/
  adaptive-stop.ts         — single authoritative adaptive stop
  cost-drag.ts             — cost aggregation + sample validation
  regime-gate.ts           — regime classifier + entry policy (TS)
  risk-config-validation.ts — config fail-closed validation

quant_engine/indicators/
  regime_gate.py           — regime classifier (Python, same contract)

tests/
  unit/adaptive-stop.test.ts    — zone classification, validation, disabled equivalence
  unit/cost-drag.test.ts        — weighted agg, gross<=0, 50% boundary, probe, sample validation
  unit/regime-gate.test.ts      — golden vectors, 4 states, UNKNOWN, entry policy
  fixtures/regime-gate-golden-vectors.json — 8 cross-language parity vectors

quant_engine/tests/
  test_regime_gate.py           — Python parity + local validation tests

docs/research/
  paper-inspired-risk-controls.md — this document
```

## Verification

```bash
npm run typecheck    # 0 new errors
npm run build        # exit 0
npm run test         # 2490+ pass
npm audit --audit-level=high
python -m unittest discover -s quant_engine/tests -p "test_regime_gate*.py"
```
