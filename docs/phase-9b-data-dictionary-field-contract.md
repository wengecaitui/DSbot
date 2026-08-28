# Phase 9B — Data Dictionary + Source Binding Contract

## 1. Status and stop boundary

Phase 9B freezes the semantic gate between a Phase 9A `RawResearchRecord.payload`
and any future canonical research representation:

```text
RawResearchRecord.payload
  -> ProviderSourceBindingSet
  -> current-pair compatibility validation
  -> CanonicalFieldDictionary
  -> STOP
```

This is a contract-only delivery. It adds no provider instance, I/O, mapping
execution, normalization, canonical row or dataset, storage, historical visibility
evaluation, lineage registry, dataset eligibility, research hub, or backtest kernel.
Both roots require `productionAuthority: false`; neither can authorize trading or
change Paper/Testnet/Live state.

## 2. Two-layer authority split

`CanonicalFieldDictionary` is provider-neutral. It owns canonical identity and
meaning only: logical type, unit, null meaning, price basis, observation/calendar
attribution, time requirements, historical-decision policy, and a total research-use
policy.

`ProviderSourceBindingSet` is provider-bound. It identifies a Phase 9A
`{providerId, adapterId}`, a source dataset reference, and structural payload paths.
It may only assert that provider source semantics exactly match the canonical field.
It cannot override canonical semantics or supply executable conversion logic.

## 3. Canonical dictionary contract

The root has exactly:

```text
schemaVersion, dictionaryId, dictionaryVersion, dataDomain, fields,
productionAuthority
```

Each field has exactly:

```text
fieldId, logicalType, unit, meaning, semanticRole, nullSemantics,
priceSemantics, observationSemantics, calendarSemantics,
eventTimeRequirement, availabilityRequirement, historicalDecisionPolicy,
researchUsePolicy
```

Field IDs are unique within the dictionary. Provider/adapter identity, source paths,
dataset lifecycle, eligibility, live-readiness, and deprecation state are not Layer 1
properties.

### 3.1 Logical types

The finite vocabulary is `BOOLEAN`, `INT64`, `FLOAT64`, `STRING`, `DATE`,
`TIMESTAMP_UTC`, or `{ kind: 'DECIMAL', precision, scale }`.
DECIMAL precision is a safe integer at least 1; scale is a nonnegative safe integer
not greater than precision. Physical/storage types are not represented.

### 3.2 Units and currency relation

The finite unit vocabulary is `UNITLESS`, `SHARES`, `COUNT`, `RATIO`, `PERCENT`,
`BASIS_POINTS`, `{ kind: 'CURRENCY', currencyFieldId }`, and
`{ kind: 'OTHER', description }`.

- `RATIO`: `1.0 == 100%`
- `PERCENT`: `100 == 100%`
- `BASIS_POINTS`: `10000 == 100%`

A currency relation must reference another field in the same dictionary. The target
must have logical type `STRING` and must not itself use `CURRENCY`. Phase 9B performs
no currency or numeric-scale conversion.

### 3.3 Null, missing, and zero

Null semantics are exactly `{ nullable: false }` or
`{ nullable: true, meaning: non-empty bounded prose }`.
Provider source presence is a Layer 2 concern. The contract freezes
`MISSING != NULL`, `NULL != ZERO`, and `MISSING != ZERO`; it has no default, fill,
sentinel, or missing-to-null implementation.

### 3.4 Price semantics

Non-price fields use exactly `{ kind: 'NOT_PRICE' }`. Price fields use
`{ kind: 'PRICE', basis, documentedAdjustmentRule }`, where basis is `RAW`,
`SPLIT_ADJUSTED`, `DIVIDEND_ADJUSTED`, `TOTAL_RETURN_ADJUSTED`,
`PROVIDER_DEFINED`, or `UNKNOWN`.

An `UNKNOWN` price basis denies every decision-input use. A price field that allows
`RESEARCH_EXECUTION_MODEL_INPUT` or `RESEARCH_VALUATION` must use `RAW`. No corporate
action adjustment is implemented.

### 3.5 Observation and calendar attribution

Observation semantics are `INSTANT` or a `PERIOD` with a finite period and
`PERIOD_START`/`PERIOD_END` anchor. Calendar semantics are `NOT_APPLICABLE` or a
named timezone/calendar pair. `PERIOD` observations and `DATE` logical types require
a named calendar. Phase 9B validates attribution strings only; it loads no timezone
or calendar database and calculates no event time.

### 3.6 Time and historical-decision requirements

Event-time requirements are `RECORD_EVENT_TIME_SUFFICIENT`, `FIELD_LEVEL_REQUIRED`,
or `NOT_APPLICABLE`. Availability requirements are
`RECORD_AVAILABLE_AT_SUFFICIENT`, `FIELD_LEVEL_REQUIRED`, or `UNKNOWN`.
Historical-decision policy is `REQUIRES_PROVABLE_AVAILABILITY` or
`FORBIDDEN_AS_DECISION_INPUT`.

`UNKNOWN` availability and `FORBIDDEN_AS_DECISION_INPUT` both deny all decision-input
uses. Phase 9B does not assert a point-in-time-safe boolean. The future visibility
rule remains `available_at <= decision_time`, outside this contract.

### 3.7 Research-use total mapping

Every field supplies exactly one `ALLOW`/`DENY` value for every vocabulary term:

```text
FACTOR_INPUT, LABEL, RESEARCH_VALUATION, UNIVERSE_FILTER,
RESEARCH_EXECUTION_MODEL_INPUT, JOIN_KEY, DISPLAY, QUALITY_CONTROL
```

Decision-input uses are `FACTOR_INPUT`, `RESEARCH_VALUATION`, `UNIVERSE_FILTER`,
`RESEARCH_EXECUTION_MODEL_INPUT`, and `JOIN_KEY`. Non-decision uses are `LABEL`,
`DISPLAY`, and `QUALITY_CONTROL`. The contract asserts that these sets are disjoint
and their union is the full vocabulary. A semantic `LABEL` must forbid historical
decision input and deny every decision-input use. Field-level grants never grant
dataset-level backtest eligibility.

## 4. Provider source binding contract

The binding-set root has exactly:

```text
schemaVersion, bindingId, bindingVersion, providerId, adapterId,
sourceDatasetRef, dictionaryId, dictionaryVersion, bindings,
productionAuthority
```

Each field binding has exactly:

```text
canonicalFieldId, sourcePath, mappingKind, sourceLogicalType, sourceUnit,
sourcePriceSemantics, sourceObservationSemantics, sourcePresence,
sourceNullable, eventTimeBinding, availableAtBinding
```

Only `mappingKind: 'DIRECT'` exists. There are no callbacks, expressions, scale or
currency conversions, string-to-number conversions, or price adjustments.

### 4.1 Structural source paths

A path is a non-empty, dense `readonly (string | nonnegative safe integer)[]`.
`['bars', 0, 'close']` remains distinct from `['bars', '0', 'close']`. Holes,
accessor indices, symbol/custom properties, nested arrays, functions, negative or
fractional numbers, unsafe integers, and `NaN` fail closed.

### 4.2 Source time bindings

Event-time and available-at bindings are exactly one of:

```text
'RECORD_ENVELOPE'
{ kind: 'SOURCE_PAYLOAD_PATH', path }
{ kind: 'DOCUMENTED_RULE', rule }
'UNKNOWN'
```

A canonical `FIELD_LEVEL_REQUIRED` event time cannot bind to `RECORD_ENVELOPE` or
`UNKNOWN`. The same rule applies to field-level available-at requirements. No
timestamp computation occurs.

### 4.3 DIRECT compatibility

For every claimed canonical field, source logical type, unit, price semantics, and
observation semantics must be structurally equal to the canonical values.
`OPTIONAL` presence or `sourceNullable: true` cannot satisfy a nonnullable canonical
field. A field may be claimed at most once in a binding set.

## 5. Validators and evidence limits

- `assertCanonicalFieldDictionary()` validates Layer 1 and in-dictionary currency
  relations.
- `assertProviderSourceBindingSet()` validates Layer 2 syntax and unique claims.
- `assertBindingSetMatchesDictionary()` validates dictionary identity/version,
  known canonical fields, DIRECT semantic equality, null/presence, and time binding
  compatibility.
- `assertBindingSetMatchesManifest()` first invokes the existing Phase 9A manifest
  validator, then matches provider and adapter identity. Phase 9A manifests do not
  enumerate `sourceDatasetRef`, so this validator makes no invented equality claim.

These validators prove compatibility of the objects supplied now. They do not prove
that either object was historically unchanged without a version bump. Historical
content identity, fingerprints, version lineage, and deprecation belong to Phase 9F.

## 6. Plain inert data gate

Before semantic reads, the shared descriptor-only traversal rejects accessors,
symbol properties/values, functions, cycles, sparse arrays, custom array properties,
and non-plain objects. Caller-owned accessors are never executed during validation.
This is deliberately a small contract gate, not a canonical JSON implementation.

## 7. Production and future-phase boundary

No Phase 9B object expresses dataset eligibility, production eligibility,
live-readiness, trading authority, or dataset lifecycle. The implementation imports
no production market-data, kernel, OMS, risk, spine, position, accounting, recovery,
or reconciliation authority. It performs no network, process, storage, or filesystem
dataset operation. Phase 9C and later work remains deferred and requires separate
authorization.
