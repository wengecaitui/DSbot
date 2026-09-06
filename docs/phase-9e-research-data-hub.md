# Phase 9E — Research Data Hub and Dataset Usage Policy

## Scope and authority

One `ResearchDataHub` represents one already loaded Phase 9D `ResearchStorageInterchange`. Construction calls the
existing Phase 9D validator and restoration path, takes an immutable canonical snapshot, verifies that every record
has the same ordered field schema, and only then exposes two frozen capability objects. The Hub is an in-memory usage
authority. Phase 9D's bundle reader remains the durable artifact integrity authority.

The Hub accepts only a Phase 9D interchange whose canonical requirement, evidence, historical-policy, and
research-use relationships have passed cross-semantic validation. Invalid canonical truth therefore fails before
either Hub capability can evaluate or expose it.

The public Hub has exactly `decisionPort`, `analysisPort`, and `productionAuthority=false`. It has no raw,
interchange, canonical-dataset, registry, refresh, cache, query, filter, join, or generic data access method. The
decision port exposes only `createDecisionView`; the analysis port exposes only `createAnalysisView`.

## Request boundary

Each request passes the shared descriptor-only plain/inert-data gate before semantic reads. The gate rejects
accessors without executing them and rejects executable, symbolic, cyclic, sparse, custom-array, and non-plain data.
The implementation then performs one defensive `structuredClone` and validates and uses only that clone. Requests
have exact keys and a non-empty, unique list of existing canonical field IDs.

Decision requests require an explicit canonical ISO UTC `decisionTime` and a `researchUse` imported from the current
`DECISION_INPUT_USES`. Analysis requests import `NON_DECISION_INPUT_USES`; the vocabulary is not duplicated locally.
An empty dataset can construct a Hub, but a field-bearing request fails with
`EMPTY_DATASET_FIELD_SCHEMA_UNAVAILABLE` because Phase 9E has no standalone schema artifact from which to infer
fields.

## Decision view

Static policy preflight rejects a requested field unless its policy allows the requested use and its historical
policy requires provable availability. A label semantic role is rejected again at this boundary. Static denial fails
the whole request rather than returning an apparently valid empty view.

For every source row, the Hub calls the unchanged Phase 9C `evaluateDecisionInputEligibility` for every requested
field. It exposes the row if and only if all results are eligible at the same caller-supplied decision time. It does
not reproduce the availability comparator, event-time rules, currency-context state machine, or JOIN_KEY
classification.

Rejected rows produce no output: no ID, value, clock, evidence, provenance, ordinal, count, or rejection reason.
Visible rows retain source order and receive dense `viewIndex` values. Their fields contain only `fieldId`,
`logicalType`, `unit`, and `presence`; visible row identity may include `sourceRecordId`. The projection preserves
NULL, zero, false, empty string, and canonical values exactly. No eligibility result is exposed because it may carry
future availability evidence.

## Analysis view

The analysis capability accepts only approved non-decision research uses and fails a request when any requested
field is statically denied. It preserves every source row in order and keeps MISSING, NULL, VALUE, zero, false, and
empty string distinct. Its result is explicitly marked `usageMode=NON_DECISION_RESEARCH` and
`productionAuthority=false`. Labels can appear only through this separate capability; no API returns decision
features and labels together.

## Stop boundary

Phase 9E adds no storage I/O, network I/O, process execution, provider ingestion, lineage/version/deprecation
resolution, mutable registration, decision-view cache, join engine, ResearchBacktestKernel, strategy promotion,
production market-data truth, Paper/Testnet/Live activation, or trading-runtime coupling. It creates no static PIT,
backtest, training, validation, test, or trading-readiness flag.
