# Stage 4A4 Closure — Fold Isolation & Module Runtime

## Inclusive-Index Timeline Model

All bar indices in the ChronologicalSplit use an **inclusive-index timeline** — `start` and `end` (both inclusive) define a contiguous range of `count = end - start + 1` bars. Bar numbering starts at 0 and increases with time.

### Segment Definitions

| Term | Role | Constraint |
|------|------|-----------|
| **train** | Parameter estimation region | Must start at or after `featureLookbackBars` (for lookback window). Expanding mode extends backward from a fixed start; rolling mode has fixed width. |
| **validation** | Out-of-sample selection region | Separated from train by `purgeBars` + `labelHorizonBars` gap. Used for candidate ranking. |
| **test** | Pure holdout region | Separated from validation by the same gap. Each fold's test is evaluated exactly once, and only after parameter selection is finalized. Test is absent from candidate evaluation. |
| **purgeBars** | Minimum inter-phase gap | Prevents train information from leaking into validation, and validation from leaking into test. Bounded below by `labelHorizonBars` — the effective gap is `Math.max(purgeBars, labelHorizonBars)`. |
| **embargoBars** | Minimum inter-fold OOS gap | Prevents the previous fold's test labels from entering the next fold's eligible regions. Bounded below by `labelHorizonBars` — the effective gap is `Math.max(embargoBars, labelHorizonBars)`. |
| **featureLookbackBars** | Minimum history before train | Training cannot start before this bar, ensuring features have sufficient lookback. |
| **labelHorizonBars** | Forward observation window | A label at bar `t` observes through bar `t + labelHorizonBars`. Every inter-phase and inter-fold gap must account for this horizon to prevent forward-looking bias. |

### Rolling vs. Expanding

**Rolling**: Each fold's training window has fixed width `trainBars`. Consecutive training windows slide forward as more recent data is dropped.

**Expanding**: Training window starts at a fixed origin (`featureLookbackBars`) and grows with each fold. Consecutive training windows accumulate all historical data, so `train.count` strictly increases.

### Historical Data Reuse

The model **permits** reuse of historical training data across folds. Specifically:

- `previous.test.end < next.train.start` is **NOT** required. Adjacent folds may share training data.
- The only hard boundaries are: (a) `test + embargoBars` must not cross into the next fold's test region; (b) `test + labelHorizonBars` must not cross into the next fold's test region; (c) intra-fold phase gaps must satisfy both `purgeBars` and `labelHorizonBars`.
- This is verified by Test 76: "next training window may reuse prior history" — valid rolling and expanding folds return `[]` from `validateFoldIsolation(f[i], f[i+1])`.

### Fold Timeline (Illustrative)

```
Bar 0 ──────────────────────────────────────────────────────────→ totalBars-1

Fold 0:  [──train──][gap][val][gap][test]──[embargo]──
Fold 1:                [──train──][gap][val][gap][test]──[embargo]──
Fold 2:                           [──train──][gap][val][gap][test]

gap = max(purgeBars, labelHorizonBars)
embargo gap = max(embargoBars, labelHorizonBars)
```

In expanding mode, train windows extend leftward to the fixed origin as the fold index increases.

## Isolation Validation

`validateFoldIsolation(fold, nextFold?)` returns `string[]`. On valid folds (rolling or expanding), it returns exactly `[]`. It detects six leakage classes:

1. **train+purge crosses validation start** — `fold.train.end + fold.purgeBars >= fold.validation.start`
2. **val+purge crosses test start** — `fold.validation.end + fold.purgeBars >= fold.test.start`
3. **train label horizon crosses validation start** — `fold.train.end + fold.labelHorizonBars >= fold.validation.start`
4. **validation label horizon crosses test start** — `fold.validation.end + fold.labelHorizonBars >= fold.test.start`
5. **test+embargo crosses next test** — `fold.test.end + fold.embargoBars >= nextFold.test.start` (only when nextFold exists)
6. **test label horizon crosses next test** — `fold.test.end + fold.labelHorizonBars >= nextFold.test.start` (only when nextFold exists)
7. **feature lookback before bar 0** — `fold.train.start < fold.featureLookbackBars`

## Holdout Proof

The walk-forward engine enforces strict test isolation:

- **Test absent from candidate selection**: Phase ledger records no `test` phase calls until after parameter selection is finalized (`selectedParams` is set).
- **Each fold tested exactly once**: After selection, the engine iterates every fold and calls the simulator on each fold's test region exactly once.
- **testCalls.length === folds.length**: Test 47 uses `assert.equal(testCalls.length, r.folds.length)` — no `||` escape that weakens the assertion.
- **No weak null-ish assertions**: Test 50 uses `assert.notEqual(..., undefined)` instead of `assert.equal(... !== null, true)`, which would have passed on `undefined`.
- **Changing only test simulation results must not change selectedParameters**: Parameter selection is performed using only train and validation data; test data is never observed during selection.

## Module Runtime Contract

The project's ES2022/Bundler module resolution failed direct Node.js `require()` of the built `dist/` output. The fix:

- `tsconfig.json`: `module` changed from `ES2022` → `CommonJS`, `moduleResolution` changed from `Bundler` → `Node`
- This produces `.js` files in `dist/` that Node.js can `require()` directly
- All existing test infrastructure (`tsx` loader) continues to work with the source `.ts` files
- Full typecheck, build, and dist smoke pass
