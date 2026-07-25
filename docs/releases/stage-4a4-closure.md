# Stage 4A4 Closure — Fold Isolation & Module Runtime

## Inclusive-Index Timeline Model

All bar indices in the ChronologicalSplit use an **inclusive-index timeline** — `start` and `end` (both inclusive) define a contiguous range of `count = end - start + 1` bars. Bar numbering starts at 0 and increases with time.

### Segment Definitions

| Term | Role | Constraint |
|------|------|-----------|
| **train** | Parameter estimation region | Rolling: fixed width `trainBars` starting after previous fold's test+embargo boundary (but permitted to reuse older history — train may overlap with past test data). Expanding: fixed start at `featureLookbackBars`, grows backward-compatibly. |
| **validation** | Out-of-sample selection region | Separated from train by `max(purgeBars, labelHorizonBars)` gap. Used for candidate ranking. Must start after previous fold's `test.end + max(embargoBars, labelHorizonBars)`. |
| **test** | Pure holdout region | Separated from validation by `max(purgeBars, labelHorizonBars)` gap. Each fold's test is evaluated exactly once, and only after parameter selection is finalized. |
| **purgeBars** | Configured inter-phase gap | Nominal value. The effective gap is `Math.max(purgeBars, labelHorizonBars)`. |
| **embargoBars** | Configured inter-fold gap | Nominal value. The effective gap is `Math.max(embargoBars, labelHorizonBars)`. |
| **featureLookbackBars** | Minimum history before train | Training cannot start before this bar. |
| **labelHorizonBars** | Forward observation window | A label at bar `t` observes through bar `t + labelHorizonBars`. Every inter-phase and inter-fold gap is bounded below by `labelHorizonBars` via `Math.max()`. |

### Cross-Fold Eligible-Region Isolation

The fundamental constraint is that a fold's **eligible region** (train + validation, where parameter selection occurs) must not observe data from the previous fold's test window plus its embargo and label horizon. Specifically:

- `fold[i].test.end + max(embargoBars, labelHorizonBars) < fold[i+1].validation.start`
- `fold[i].test.end + max(embargoBars, labelHorizonBars) < fold[i+1].test.start`

Training windows MAY reuse older history (prior test data is permitted during training for both rolling and expanding modes). This means `fold[i+1].train.start` may be ≤ `fold[i].test.end` — no check prevents this.

### Fold Timeline — Numeric Example

Config: `totalBars=15000, trainBars=800, validationBars=300, testBars=300, purgeBars=20, embargoBars=10, labelHorizonBars=0`.

Effective gaps: `phaseGapBars=max(20,0)=20`, `outOfSampleGapBars=max(10,0)=10`, `foldStepBars=300+20+300+10=630`.

**Rolling mode** (oldest→newest, after reversal):

| Fold | train | validation | test |
|------|-------|------------|------|
| 0 | [12010, 12809] (800 bars) | [12830, 13129] (300 bars) | [13150, 13449] (300 bars) |
| 1 | [12640, 13439] (800 bars) | [13460, 13759] (300 bars) | [13780, 14079] (300 bars) |

Fold 0 test end = 13449. Embargo + label = 10. Next eligible region starts at fold 1 validation start = 13460. 13449 + 10 = 13459 < 13460 ✓. Fold 1 train start = 12640, which is < 13449 (previous test end) — permitted historical data reuse.

**Expanding mode** (same config):

| Fold | train | validation | test |
|------|-------|------------|------|
| 0 | [0, 12809] (12810 bars) | [12830, 13129] (300 bars) | [13150, 13449] (300 bars) |
| 1 | [0, 13439] (13440 bars) | [13460, 13759] (300 bars) | [13780, 14079] (300 bars) |

Train starts from fixed origin (0). Fold 0 test end = 13449, fold 1 validation start = 13460. 13449 + 10 = 13459 < 13460 ✓. Train grows to include all past data, naturally incorporating prior test data.

### ASCII Schematic

```
Bar 0 ──────────────────────────────────────────────────────────→ totalBars-1

Rolling:
Fold 0:  [──train──][gap][val][gap][test]
Fold 1:            [──train──][gap][val][gap][test]

Expanding:
Fold 0:  [─────────────train─────────────][gap][val][gap][test]
Fold 1:  [──────────────────train──────────────────][gap][val][gap][test]

gap = max(purgeBars, labelHorizonBars)
inter-fold gap = max(embargoBars, labelHorizonBars)
```

## Isolation Validation

`validateFoldIsolation(fold, nextFold?)` returns `string[]`. On valid folds (rolling or expanding), it returns exactly `[]`. It detects **eight** leakage classes:

1. **train+purge crosses validation start** — `fold.train.end + fold.purgeBars >= fold.validation.start`
2. **val+purge crosses test start** — `fold.validation.end + fold.purgeBars >= fold.test.start`
3. **train label horizon crosses validation start** — `fold.train.end + fold.labelHorizonBars >= fold.validation.start`
4. **validation label horizon crosses test start** — `fold.validation.end + fold.labelHorizonBars >= fold.test.start`
5. **test+embargo crosses next test** — `fold.test.end + fold.embargoBars >= nextFold.test.start`
6. **test label horizon crosses next test** — `fold.test.end + fold.labelHorizonBars >= nextFold.test.start`
7. **test+embargo crosses next validation** — `fold.test.end + fold.embargoBars >= nextFold.validation.start` (cross-fold eligible-region)
8. **test label horizon crosses next validation** — `fold.test.end + fold.labelHorizonBars >= nextFold.validation.start` (cross-fold eligible-region)
9. **feature lookback before bar 0** — `fold.train.start < fold.featureLookbackBars`

## Holdout Proof

The walk-forward engine enforces strict test isolation:

- **Test absent from candidate selection**: Phase ledger records no `test` phase calls until after parameter selection is finalized.
- **Each fold tested exactly once**: After selection, the engine iterates every fold and calls the simulator on each fold's test region exactly once.
- **testCalls.length === folds.length**: Test 47 verifies strict equality.
- **No weak null-ish assertions**: Test 50 uses `assert.notEqual(..., undefined)`.
- **Holdout experiment (Test 78)**: Two runs with identical train+validation outputs but deliberately different test outputs produce the same `selectedParameters` — proving the holdout wall is real. Test metrics differ between runs, confirming the simulator exercised different test paths without affecting selection.

## Module Runtime Contract

`tsconfig.json` uses `module: "CommonJS"` with `moduleResolution: "Node"`. This is acceptable under the locked whole-repo toolchain because:

1. **TypeScript 5.9.3** still resolves `"Node"` (aliased to `"node10"`) without emitting deprecation errors or warnings at build time.
2. The project uses CommonJS (`module: "CommonJS"`) throughout — `"Node"` is the correct resolution strategy for CJS and produces extensionless `require()`-compatible output in `dist/`.
3. Switching to `"node16"` or `"nodenext"` would require `.js` extensions in all ~200+ source file imports (or setting `"type": "module"` in package.json), which would break the entire codebase.
4. The whole-repo toolchain (`tsx` for dev, `tsc` for build, `node` for runtime) all function correctly with `moduleResolution: "Node"`.
5. `npm run typecheck` (tsc --noEmit) passes cleanly; `npm run build` produces valid `dist/`; `node -e "require('./dist/validation/ChronologicalSplit')"` succeeds.
