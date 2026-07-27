# Stage 4A13 — Failure Attribution and Fresh Evidence Window Readiness

## Boundary

Stage 4A13 is the final Stage 4A functional stage. It does not create a
profitable-strategy claim and it does not open another Final Holdout.

The deterministic attribution report uses only Stage 4A12 train, validation,
test, high-cost test, trade-frequency, drawdown, and parameter-perturbation
evidence. Final Holdout returns are excluded from attribution, strategy design,
parameter changes, market selection, timeframe selection, and candidate
ranking.

No Paper, Testnet, or Live permission is granted.

## Deterministic findings

All four candidate families selected non-positive median train results in all
three folds. Development validation and test generalization were weak across
most folds, cost stress reduced returns, and the two higher-frequency families
showed development drawdowns above the promotion limit. These are observed
signals, not causal claims about the indicators.

Every candidate, market, timeframe, and fold is retained in the report. There
is no winner-only filtering.

The Stage 4A12 gate audit found four future-facing gaps:

1. Cost and cross-market pre-Holdout decisions used only the last development
   fold.
2. Selection counts were bound per strategy, not across the full candidate
   family.
3. Candidates already rejected before Holdout still consumed Holdout evidence.
4. Relative train ranking could advance the least-negative parameter set even
   when every train candidate was non-positive.

These findings may change future gate contracts, but they do not authorize
retuning the four candidates against consumed evidence.

## Contamination and lineage contract

Changing `strategyId`, `specId`, or `version` does not reset evidence state.
Executable semantics are hashed after identity and lineage labels are removed.
The append-only evaluation identity is:

```text
sha256(semanticFingerprint + evidenceFingerprint)
```

A derived candidate must preserve:

```text
strategyId
specId
parentStrategyId
parentSpecId
researchEvidenceCutoff
designEvidenceWindowIds
consumedHoldoutWindowIds
designInputs
freezeCommit
freezeTimestamp
freshEvidenceWindowId
semanticFingerprint
lineageRootId
lineageId
```

Parent consumed-window history is monotonic: descendants may add evidence but
may not omit it or reset the lineage root. Identical executable semantics have
the same fingerprint even after rename, copy, or version change. The exact
OHLCV slice has an independent `evidenceFingerprint`, so relabelling consumed
data as a new window also fails closed.

## Consumed evidence

The private Stage 4A12 ledger was verified against the private Final Holdout
report and converted into a source-free public seed:

- ten unique market/time evidence windows;
- forty unique strategy-family/window evaluations;
- every evaluation count equals one;
- every state is `CONSUMED`;
- no return, trade list, private path, or strategy source is included.

Reservation is consumption. A crashed or incomplete evaluation cannot be
retried against the same semantic-family/window pair. Every pre-frozen family
allowed to see a fresh window must be reserved in one atomic batch before the
first evaluation; once that batch is written, the evidence slice is closed to
additional families.

## Fresh evidence readiness

Strategy semantics, parameters, costs, symbols, and timeframes must be frozen
at a commit and UTC timestamp strictly before a fresh window opens. A usable
window must be sealed, chronologically later than inherited consumed evidence,
audited for gaps, and unused by research or selection. One-hour data requires
`explicit-no-cross-gap`; gap filling remains prohibited.

There is currently no sufficiently mature fresh evidence window. Therefore:

```text
nextGenerationFrozenSpecCount = 0
freshEvidenceWindowAvailable = false
freshPromotionProofAllowed = false
paperApproved = false
testnetApproved = false
liveApproved = false
```

This is readiness, not a Promotion Proof. The next transition is the Stage 4A
closure audit, followed by Stage 4B1 Strategy Activation Contract. Stage 4A14
must not be created unless this contract has a correctness defect.
