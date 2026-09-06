# Phase 9F — Research Dataset Lineage Governance

## Scope and identity

The current implementation base is
`feature/orangeai-split@58076b6b813ec84cf7757cd72016727ee9f2c585`: Phase 9E and the TOML dependency
remediation are merged and complete, Phase 9F is current, and Phase 9G remains deferred.

Phase 9F is an immutable, in-memory metadata catalog for research dataset lineage, exact artifact versions,
supersession, and deprecation. An exact version reference contains only a bounded `datasetId` and the lowercase
64-character Phase 9D `storageBundleId`. The catalog has no mutable alias, current-version pointer, or automatic
version selection; consumers must pin an exact reference.

Phase 9D remains the sole authority for durable bundle integrity and content identity. Phase 9F validates bundle-ID
syntax, requires every embedded `ResearchStorageInterchange` to pass the Phase 9D boundary, and calls Phase 9D's
shared exact-identity capability to bind the claimed ID to that interchange. It does not open a bundle or claim to
verify its bytes. The catalog and its outputs declare `storageIntegrityAuthority=false` and
`productionAuthority=false`; Python durable commit remains the storage-integrity authority.

## Derived canonical lineage

The catalog derives canonical lineage from each validated interchange. Callers cannot submit parallel copies of the
dictionary, binding, provider, adapter, or source identity. Published metadata contains only the dataset and bundle
reference, publication time, optional predecessor, and bounded canonical lineage:

- dictionary ID and version;
- binding ID and version;
- provider ID, adapter ID, and source dataset reference;
- unique, sorted adapter and manifest versions found in canonical records.

It does not expose records, field values, raw payloads, row-level provenance, request IDs, hashes, or PIT clocks.
Versions under one `datasetId` must retain the same provider ID, adapter ID, and source dataset reference. Dictionary,
binding, adapter, and manifest versions may evolve.

## Supersession and deprecation invariants

An optional `supersedes` reference forms an explicit linear predecessor chain within one dataset series. The
predecessor must exist, must be a different exact version in the same dataset, and must have an earlier publication
time. Every non-empty dataset series has exactly one root, and every later version must connect to it through explicit
predecessors. Cycles, disconnected roots, and multiple successors for one predecessor fail closed. The audit capability
can return the deterministic oldest-to-requested trace.

One immutable deprecation declaration may target an exact version. Its declaration cannot predate publication; its
effective time cannot predate its declaration; and its reason is non-empty and bounded. An optional replacement must
be a later, already-published descendant of the target in the explicit supersession chain. Deprecated versions remain
available to the audit capability for reproducibility. Phase 9F provides no deletion, reactivation, or correction of
invalid fixtures.

## Temporal visibility

Every governance request supplies a strict canonical UTC `governanceTime`. This clock describes metadata visibility
and lifecycle only; it is separate from decision time, event time, availability time, and ingestion time. No implicit
current clock is used.

Lifecycle is evaluated dynamically as `NOT_YET_PUBLISHED`, `ACTIVE`, `DEPRECATION_SCHEDULED`, or `DEPRECATED`.
Published-version listing excludes versions published after the requested time, sorts visible versions by publication
time and bundle ID, and assigns dense indices only to visible versions. Listing an unknown `datasetId` returns an empty
list. Before `declaredAt`, a governance result omits the entire future deprecation declaration, including its reason,
replacement, and timestamps.

After a deprecation is declared, its replacement reference remains omitted until the replacement's own `publishedAt`
is at or before `governanceTime`. The audit capability may retain the complete declaration for governance review.

## Capability boundary

The frozen governance port exposes only as-of lifecycle and published-version metadata. The frozen audit port exposes
full exact-version metadata and predecessor history and marks results `usageMode=RESEARCH_GOVERNANCE_AUDIT` and
`researchGovernanceOnly=true`. Neither capability returns a `ResearchStorageInterchange`, canonical records, raw
records, or a `ResearchDataHub`.

Phase 9F does not evaluate PIT eligibility, select a dataset for a strategy, create a Hub, access storage, perform
network or process I/O, ingest providers, run backtests, or change production authority. Phase 9C eligibility and the
Phase 9E one-Hub/one-loaded-dataset boundary remain unchanged.
