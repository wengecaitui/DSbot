# Stage 4A4-R8 Closure — Causal-Per-Fold Selection & Final Holdout

**Contract version**: 4A4-R8

## Selection Modes

| Mode | Behavior | Default |
|------|---------|---------|
| `'causal-per-fold'` | Each fold independently evaluates its own candidates on its own train+validation, freezes the selection, then runs its test with that fold's own parameters. Later folds cannot alter earlier fold selections. | ✓ (R8 only mode) |

Invalid `selectionMode` values throw `INVALID_SELECTION_MODE` (fail-closed). The `selectionMode` field appears in the `ValidationReport` as `'causal-per-fold'` and is also accepted as an optional config field on `WalkForwardConfig`.

## Inclusive-Index Timeline Model

All bar indices in the ChronologicalSplit use an **inclusive-index timeline** — `start` and `end` (both inclusive) define a contiguous range of `count = end - start + 1` bars. Bar numbering starts at 0 and increases with time.

### Segment Definitions

| Term | Role | Constraint |
|------|------|-----------|
| **train** | Parameter estimation region | Rolling: fixed width `trainBars`. Expanding: fixed start at `featureLookbackBars`, grows backward-compatibly. Training windows MAY reuse older history (prior test data is permitted during training). |
| **validation** | Out-of-sample selection region | Separated from train by `max(purgeBars, labelHorizonBars)` gap. Used for candidate ranking. Must start after previous fold's `test.end + max(embargoBars, labelHorizonBars)`. |
| **test** | Per-fold holdout region | Separated from validation by `max(purgeBars, labelHorizonBars)` gap. Each fold's test is evaluated exactly once, after parameter selection is finalized for that fold. |
| **Final Holdout** | Trailing out-of-time evaluation | Allocated independently at the end of the dataset. Separated from the last development fold by `gap = max(purgeBars, embargoBars, labelHorizonBars)`. Evaluated exactly once after all development folds are decided. |
| **purgeBars** | Configured inter-phase gap | Effective gap is `Math.max(purgeBars, labelHorizonBars)`. |
| **embargoBars** | Configured inter-fold gap | Effective gap is `Math.max(embargoBars, labelHorizonBars)`. |
| **featureLookbackBars** | Minimum history before train | Training cannot start before this bar. |
| **labelHorizonBars** | Forward observation window | A label at bar `t` observes through bar `t + labelHorizonBars`. All gaps are bounded below by `labelHorizonBars` via `Math.max()`. |

## Causal-Per-Fold Selection

In `causal-per-fold` mode, each fold in oldest-to-newest order:

1. **Evaluates** all parameter-grid candidates on its own `train` + `validation` (and only its own).
2. **Freezes** `selectedCandidateId` and `selectedParameters` — no later fold can modify them.
3. **Tests** with its own selected parameters (if any candidate passed acceptance).
4. **Records** `candidateResults` (all candidates evaluated) and `usedForDeployment` on the last valid fold.

The fold that supplies `deploymentParameters` is the **last** development fold whose selection was valid (accepted). Earlier folds' selections are preserved for comparison but do not drive deployment.

### Per-Fold Fields

| Field | Type | Description |
|-------|------|------------|
| `selectedParameters` | `Record<string,string\|number>?` | Parameters selected by this fold (causal mode only). |
| `selectedCandidateId` | `string?` | Candidate ID selected by this fold. |
| `candidateResults` | `CandidateResult[]?` | All candidates evaluated by this fold. |
| `usedForDeployment` | `boolean` | True when this fold's selection became `deploymentParameters`. |
| `selected` | `boolean` | **Deprecated** — aliases `usedForDeployment`. Maintained for backward compatibility. |

## Final Holdout

### Allocation

The effective holdout bar count is computed as:

```
effectiveRatio = finalHoldoutRatio ?? 0.15
effectiveMin   = finalHoldoutMinBars ?? (3 × testBars)
bars           = max(ceil(totalBars × effectiveRatio), ceil(effectiveMin))
```

Four cases depending on which fields are provided:

| finalHoldoutRatio | finalHoldoutMinBars | Effective ratio | Effective min | bars |
|---|---|---|---|---|
| omitted | omitted | 0.15 | 3 × testBars | max(ceil(total×0.15), ceil(3×testBars)) |
| explicit | omitted | explicit | 3 × testBars | max(ceil(total×explicit), ceil(3×testBars)) |
| omitted | explicit | 0.15 | explicit | max(ceil(total×0.15), ceil(explicit)) |
| explicit | explicit | explicit | explicit | max(ceil(total×explicit), ceil(explicit)) |

All `bars` values must be positive integers strictly less than `totalBars`. Ratio must satisfy `0 < ratio < 1` (finite). MinBars must be `≥ 0` (finite; fractional accepted, rounded up via `Math.ceil` before `Math.max`). At least one valid development fold must be producible after holdout allocation.

The minimum development footprint for one fold is: `featureLookback + train + validation + test + 2 × max(purge, labelHorizon)`. Inter-fold `outOfSampleGap`/embargo is NOT added — `finalHoldoutGap` already isolates development from holdout.

The gap between development and holdout: `gap = max(purgeBars, embargoBars, labelHorizonBars)`.

```
developmentEndExclusive = finalHoldoutStart − gap
finalHoldoutStart = totalBars − finalHoldoutBars
finalHoldoutEnd = totalBars − 1 (inclusive)
```

### Evaluation

- The Final Holdout is evaluated **exactly once**, after all development fold decisions are frozen.
- Ledger phase: `'final-holdout'`, fold = `−1`, no `candidateId`.
- With no `paramGrid`: `deploymentParameters` undefined, `finalHoldoutEvaluationCount = 0`, `finalHoldoutMetrics` undefined.
- With a `paramGrid`: holdout evaluated with `deploymentParameters`, and `finalHoldoutEvaluationCount = 1`.
- The holdout range is **never** present in candidate evaluation calls.
- Holdout failure **throws** (fail-closed) — no retry, no reselection.
- Top-level fields in `ValidationReport`: `finalHoldoutRange?: FinalHoldoutRange` (always present when holdout configured), `finalHoldoutMetrics?: PerformanceMetrics` (present when evaluated), `finalHoldoutEvaluationCount: number` (0 or 1).

### Scalability Note

Increasing the holdout ratio or minBars **reduces** the development region. Fewer development folds will be produced. The allocator throws `HOLDOUT_INSUFFICIENT_DEVELOPMENT` if no valid fold can be generated after reserve.

## Deployment Contract

```typescript
interface ValidationReport {
  contractVersion: '4A4-R8';
  selectionMode: 'causal-per-fold';
  deploymentParameters?: StrategyParameters;   // from last valid fold
  deploymentCandidateId?: string;
  selectedParameters?: StrategyParameters;      // DEPRECATED — deep-equals deploymentParameters
  selectedFold?: number;                        // DEPRECATED — identifier of deployment fold
  finalHoldoutRange?: FinalHoldoutRange;        // always present when holdout configured
  finalHoldoutMetrics?: PerformanceMetrics;     // present when holdout evaluated
  finalHoldoutEvaluationCount: number;          // 0 or 1
}
```

- `deploymentParameters` and `deploymentCandidateId` come from the **last valid development fold** whose selection passed acceptance.
- `selectedParameters` is a deprecated alias that **must deep-equal** `deploymentParameters`.
- `selectedFold` is a deprecated alias for the identifier of the deployment fold.
- Report identity (`reportId`) includes: contract version, normalized holdout config (start/end/count), deployment params, dataset hash, sim version, config, and cost config. Fail-closed: structural errors throw; performance issues emit warnings only.

## Parameter Ownership & Isolation

Strategy parameters use flat `string | number` values (no nested objects). The type `StrategyParameters = Readonly<Record<string, string | number>>` is the canonical form for all stored parameter contracts.

### Snapshot/Copy Discipline

| Operation | Function | Returns | Frozen? | Used for |
|---|---|---|---|---|
| Canonical snapshot | `canonicalParamsSnapshot(params)` | `StrategyParameters` | ✓ | candidates, folds, deployment, reports |
| Simulator copy | `paramsMutableCopy(snapshot)` | `Record<string, string \| number>` | ✗ | every simulator invocation |

**Rules:**
1. Each `paramGrid` entry is snapshotted once before any fold evaluation. No caller object is modified or frozen.
2. Every simulator call (candidate train, candidate validation, fold test, final holdout) receives a **new mutable shallow copy** via `paramsMutableCopy`.
3. No simulator ever receives a reference to a stored snapshot or to the caller's original grid object.
4. Stored contracts (CandidateResult, FoldMetrics, deployment, ValidationReport) use only canonical snapshots.

**Limitation:** This is a shallow copy. The `string | number` value contract guarantees full isolation. If a caller stores nested objects as param values (unsupported), mutations to those nested objects would propagate across copies. Do not use nested param values.

## Cross-Fold Eligible-Region Isolation

- `fold[i].test.end + max(embargoBars, labelHorizonBars) < fold[i+1].validation.start`
- `fold[i].test.end + max(embargoBars, labelHorizonBars) < fold[i+1].test.start`

Training windows MAY reuse older history (prior test data is permitted during training for both rolling and expanding modes).

### Fold Timeline — Numeric Example

Config: `totalBars=15000, trainBars=800, validationBars=300, testBars=300, purgeBars=20, embargoBars=10, labelHorizonBars=0`.

**Rolling mode** (oldest→newest, after reversal):

| Fold | train | validation | test |
|------|-------|------------|------|
| 0 | [12010, 12809] (800 bars) | [12830, 13129] (300 bars) | [13150, 13449] (300 bars) |
| 1 | [12640, 13439] (800 bars) | [13460, 13759] (300 bars) | [13780, 14079] (300 bars) |

**Expanding mode** (same config):

| Fold | train | validation | test |
|------|-------|------------|------|
| 0 | [0, 12809] (12810 bars) | [12830, 13129] (300 bars) | [13150, 13449] (300 bars) |
| 1 | [0, 13439] (13440 bars) | [13460, 13759] (300 bars) | [13780, 14079] (300 bars) |

### Final Holdout Timeline — Numeric Example

Config: `totalBars=20000, testBars=300, finalHoldoutRatio=0.15, purgeBars=20, embargoBars=10`.

Holdout: `ceil(20000 × 0.15) = 3000` bars. Gap: `max(20, 10, 0) = 20`.
- `finalHoldoutStart = 20000 − 3000 = 17000`
- `finalHoldoutEnd = 19999`
- `developmentEndExclusive = 17000 − 20 = 16980`

Development folds are generated within [0, 16979]. Final Holdout occupies [17000, 19999].

## Isolation Validation

`validateFoldIsolation(fold, nextFold?)` returns `string[]`. On valid folds, returns exactly `[]`. Detects **nine** leakage classes:

1. train+purge crosses validation start
2. val+purge crosses test start
3. train label horizon crosses validation start
4. validation label horizon crosses test start
5. test+embargo crosses next test
6. test label horizon crosses next test
7. test+embargo crosses next validation
8. test label horizon crosses next validation
9. feature lookback before bar 0

## Limitations

- `causal-per-fold` mode with expanding windows may trigger `VALIDATION_DEGRADATION` warnings when train bar count vastly exceeds validation bar count (per-bar simulators produce netReturn that scales linearly with bar span). This is correct behavior: the degradation check compares absolute netReturns, not per-bar returns. Use a simulator that normalizes for bar count, or accept the warning.
- `selected` is deprecated — new code should use `usedForDeployment`.
- `selectedParameters` on `ValidationReport` is a deprecated alias — new code should use `deploymentParameters`.
- Final Holdout requires at least one valid development fold; insufficient data throws before any candidate evaluation begins.

## Module Runtime Contract

`tsconfig.json` uses `module: "CommonJS"` with `moduleResolution: "Node"`. This is acceptable under the locked whole-repo toolchain because:

1. TypeScript 5.9.3 resolves `"Node"` (aliased to `"node10"`) for CommonJS output.
2. Switching to `"node16"` or `"nodenext"` would require `.js` extensions in all ~200+ source imports, breaking the entire codebase.
3. `npm run typecheck`, `npm run build`, and direct `require()` all function correctly.
