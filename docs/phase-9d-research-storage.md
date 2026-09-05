# Phase 9D — Raw + Analytical Research Storage

## Authority

The only durable Phase 9D truth is one immutable research storage bundle:

```text
<sha256-bundle-id>/
  raw_records.parquet
  canonical_records.parquet
  canonical_fields.parquet
  canonical_schema.json
  bundle.manifest.json
  COMMITTED
```

The bundle ID is the SHA-256 digest of a canonical inert, logical-type-aware identity projection. Canonical
`FLOAT64 VALUE` numbers are normalized to one deterministic floating-point representation, so whole-number inputs
such as `10` and `10.0` have the same semantic storage identity without changing INT64, raw tagged numbers, counts,
orders, decimal strings, or other integer metadata. Provider IDs, adapter IDs,
dataset references, record IDs, and revision IDs never become path fragments. DuckDB uses an in-memory
connection and Polars uses a lazy local Parquet scan only after bundle validation. Neither is durable authority.

Every root is caller-supplied, existing, absolute, local, canonical, and free of symlink, junction, or reparse
components. All artifact names are library constants. Readers reject missing or extra files, uncommitted bundles,
wrong byte lengths, SHA-256 mismatches, malformed or unsupported schemas, invalid receipts, and content identities
that do not match the directory bundle ID.

## Commit protocol

The writer validates the complete interchange before touching storage, creates an internal staging directory under
the approved root, writes and flushes the three Parquet artifacts and canonical schema, hashes those artifacts,
writes the manifest, validates the staged artifacts, and writes `COMMITTED` last. It performs a full semantic reload
and content-identity validation in staging, hardens artifact permissions there, validates the staged bundle again,
and then publishes with one same-filesystem atomic directory rename. No fallible semantic validation or permission
mutation occurs after publication. There is no copy fallback, append, overwrite, delete, compaction, retention,
revision-winner selection, or mutable catalog. An existing identical bundle is returned only after complete
validation and semantic equality; a collision or corruption fails closed.

## Raw archive

`Research Inert Payload Codec v1` represents raw `unknown` payloads with explicit tags for null, undefined,
boolean, string, finite number, negative zero, NaN, positive and negative infinity, bigint, arrays, and plain
objects. Object entries are sorted by key for deterministic encoding and decoded into null-prototype objects.
Descriptor-only validation runs before property reads and rejects accessors without executing them. Functions,
symbols, cycles, array holes/custom properties, and non-plain objects are rejected.

The Phase 9A `payloadHash` is retained unchanged as provider evidence. File SHA-256 values are separate storage
integrity facts and do not replace or reinterpret it.

## Analytical representation

`canonical_records.parquet` preserves record order, the three distinct clocks, availability authority, raw payload
hash, manifest/request/provenance evidence, and source revision. `canonical_fields.parquet` is long-form with explicit
record and field order. `presence_state` keeps `MISSING`, `NULL`, and `VALUE` separate; typed columns retain boolean,
JS-safe INT64, finite FLOAT64, string, DATE, UTC timestamp, and fixed-scale DECIMAL values without coercion.

Event and availability evidence retain `KNOWN`, `UNKNOWN`, `DOCUMENTED_RULE_UNMATERIALIZED`, and `NOT_APPLICABLE`.
Storage never substitutes ingestion, event, revision, file, or current time for missing availability. The restored
dataset is evaluated by the unchanged Phase 9C runtime functions, so storage cannot create PIT visibility or
decision eligibility. The existing P2 remains: the current `INT64` vocabulary is represented only within the
Phase 9C JavaScript safe-integer domain.

## Dependencies and security

- DuckDB `1.5.5`: fixed library-controlled query over validated local Parquet through an in-memory connection.
- Polars `1.44.1`: fixed selected projection over validated local Parquet; no remote URI or mutation.
- pip-audit `2.10.1`: CI vulnerability audit of the complete Python requirements graph.

These are stable releases with CPython 3.12 wheels. Runtime storage performs no network I/O. Dependency installation
and vulnerability lookup occur only in the build/validation environment.

## Stop boundary

Phase 9D adds no ResearchDataHub, DatasetUsagePolicy service, lineage/version/deprecation registry, provider,
automatic ingestion, background worker, backtest kernel, strategy promotion, production market-data truth,
Paper/Testnet/Live authority, or coupling to the trading runtime. Every storage contract and manifest carries
`productionAuthority=false`; no PIT or backtest eligibility result is persisted.
