# Phase 9C — Canonical Point-in-Time Dataset

## Status and boundary

Phase 9C implements the bounded research-only path:

```text
validated RawResearchRecord[]
  -> validated Phase 9B dictionary and DIRECT bindings
  -> one defensive record/payload snapshot
  -> immutable CanonicalPointInTimeDataset
  -> explicit decisionTime visibility and field eligibility
  -> STOP
```

The dataset root always has `productionAuthority: false`. It contains no static
PIT-safe, backtest-eligible, paper-ready, testnet-ready, or production-ready flag.
No provider, network call, process, storage, filesystem persistence, data hub,
lineage registry, revision arbitration, backtest engine, or trading authority is
part of this phase.

## Defensive extraction

Each raw record first passes the existing descriptor-only plain/inert-data gate.
Accessors, symbols, functions, cycles, sparse arrays, custom array properties, and
non-plain objects fail before cloning. The record is then cloned once; value,
event-time, and availability paths all resolve against that same snapshot.

Source paths preserve segment types. A string segment can address only an own
property of a plain object. A numeric segment can address only an own dense array
index. Consequently `['bars', 0, 'close']` and `['bars', '0', 'close']` cannot
collapse through JavaScript property-key coercion, and prototype properties are
never traversed.

DIRECT extraction performs no conversion. BOOLEAN, safe INT64, finite FLOAT64,
STRING, strict DATE, canonical ISO UTC TIMESTAMP, and fixed-scale canonical DECIMAL
strings are checked in their source representation. DECIMAL rejects exponent
notation, plus prefixes, excess precision, wrong scale, negative zero, rounding,
and JavaScript-number input.

## Presence and source evidence

Every extracted field preserves one of three distinct states:

```text
MISSING
NULL
VALUE(value)
```

An unresolved REQUIRED path fails construction. An unresolved OPTIONAL path is
MISSING. Explicit null is NULL only when both the provider binding and canonical
definition permit it. Zero, false, and the empty string remain VALUE states.

Canonical records retain the original payload hash and raw record provenance,
including source record ID, adapter and manifest versions, request and provenance
references, the three raw timestamps, availability authority, and optional source
revision. Records preserve caller order. Duplicate source record IDs fail instead
of selecting a revision winner.

## Time evidence

Event-time and availability evidence remain separate. Record-level requirements use
only the matching raw envelope timestamp. Field-level source paths must resolve to
canonical ISO UTC timestamps. A documented rule remains
`DOCUMENTED_RULE_UNMATERIALIZED`; prose is never executed. UNKNOWN remains
unprovable. `NOT_APPLICABLE` is explicit for event time.

For record-level availability, a concrete `availableAt` is evidence only with
`PROVIDER_FIELD` or `DOCUMENTED_RULE` authority. UNKNOWN authority never proves
visibility. Field-level documented rules are likewise unmaterialized. A canonical
`availabilityRequirement: UNKNOWN` cannot be upgraded by a provider timestamp.
Neither event time nor ingestion time substitutes for availability.

## Visibility and decision-input eligibility

`evaluatePointInTimeVisibility(field, decisionTime)` requires a caller-supplied,
canonical UTC decision timestamp. It performs the runtime comparison:

```text
known availableAt <= decisionTime  -> VISIBLE
known availableAt > decisionTime   -> NOT_YET_AVAILABLE
unprovable availability            -> UNPROVABLE
missing field                       -> FIELD_MISSING
```

Equality is visible. The evaluator has no current-clock authority.

`evaluateDecisionInputEligibility(record, fieldId, researchUse, decisionTime)` is
computed for one record and field. It requires a decision-input use, ALLOW policy,
provable-availability historical policy, nonmissing presence, resolved required
event-time evidence, and VISIBLE availability. LABEL, DISPLAY, QUALITY_CONTROL,
DENY policy, forbidden historical policy, unknown evidence, and future availability
remain ineligible with deterministic reasons. A legitimate nullable NULL can still
be visible and eligible; Phase 9C does not fill it.

For a CURRENCY-valued field, the referenced currency field must also exist in the
same record, contain a VALUE, permit historical decision use, have resolved required
event-time evidence, and be historically visible. Missing, null, forbidden, future,
or unprovable currency context denies the value field. No default currency exists.

## Deferred work

Phase 9D storage, Phase 9E ResearchDataHub and usage policy, Phase 9F historical
lineage/version/deprecation, Phase 9G provider qualification, and all backtest or
production consumers remain separate future gates.
