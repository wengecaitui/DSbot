# Phase 9A — Internal Research Provider Ingress

Status: **IMPLEMENTATION PR CURRENT / NOT MERGED**
Base: `feature/orangeai-split@4a4bfc54882c7ba90a1b81aceadd06b7aca01bf6`

## Scope

`ResearchProviderIngress` is an internal raw-ingestion boundary:

```text
Future Provider Adapter
  -> ResearchProviderIngress
  -> validated RawResearchRecord page
  -> STOP
```

It is not a public research-data service. No Backtest, AI, Screener, Workbench, Gateway or Trading module consumes it in Phase 9A. It implements no provider client, network transport, storage, normalization, canonical dataset, point-in-time eligibility, pagination coordinator or lifecycle.

## Construction and identity

The registry uses nested maps keyed structurally by `{providerId, adapterId}`. It never concatenates identifiers, so legal `:`, `/`, `.`, and `-` characters cannot collide. Duplicate logical identity fails closed with `RESEARCH_PROVIDER_DUPLICATE`; the registry has no mutation API after construction.

Every registration is processed in this order:

1. validate the exact adapter surface;
2. call the raw adapter `describe()` exactly once;
3. reject descriptor structures that `structuredClone` would erase (including sparse/accessor arrays), then immediately clone the adapter-owned manifest;
4. validate the full cloned manifest;
5. validate configuration through the merged external-reference-only contract;
6. reject duplicate structural identity;
7. deeply freeze that same validated clone and retain it as the pinned manifest;
8. privately retain the raw adapter, pinned manifest and exact-surface guarded facade;
9. discard the ingress reference to registration configuration.

The descriptor-only pre-clone gate is not manifest semantic validation. Semantic authority belongs exclusively to the defensive clone, and the exact clone that passes `assertProviderManifest` is the object later frozen, compared for drift, and supplied by the guarded facade.

The ingress never reads environment variables, resolves secret-manager values, logs configuration, or exposes credential references. This proves only `REGISTRATION_CONFIGURATION_EXTERNAL_REFERENCE_ONLY=true`; it does not claim that a future adapter's own private secret state is safe.

## Pinned manifest and guarded fetch

The complete manifest is pinned, including time semantics, pagination, licensing, revisions, ordering, duplicate/rate-limit semantics, transport and auth declaration. A neutral deep structural comparison detects any validated semantic drift, even when manifest and adapter version strings do not change.

Each `fetchPage()` performs exactly one real adapter `describe()` call. If the full current manifest differs from the pin, it fails before fetch with `RESEARCH_PROVIDER_MANIFEST_DRIFT`. Otherwise, the existing `fetchOneResearchPage()` contract helper receives a private facade whose `describe()` returns the pin and whose `fetch()` delegates exactly once to the raw adapter. The helper remains the sole authority for request bounds, page shape, provenance and abort-after-fetch checks.

There is no automatic pagination, retry, fallback, prefetch, fan-out, queue, lock, semaphore, timer or background work. `timeoutMs` remains a required bounded request fact; the ingress does not own a transport deadline and adds no `Promise.race`. A future concrete provider must prove owned I/O cancellation.

## Read and error boundaries

The public ingress object has exactly `list`, `describe`, and `fetchPage`. Public descriptors are frozen defensive snapshots and omit credential reference locators; they expose only auth mode and reference count. The raw adapter, configuration and registry never escape.

Fetched page and record envelopes are defensively copied and frozen. `payload` remains opaque `unknown`: the ingress does not normalize, redact, canonicalize, interpret or claim deep payload immutability.

Unknown identity fails with `RESEARCH_PROVIDER_NOT_FOUND`. Provider and abort errors propagate without generic wrapping, preserving object identity, code, retry metadata and cause where present.

## Deferred work

- 9B: Data Dictionary and field contracts.
- 9C: Canonical point-in-time datasets.
- 9D: analytical and raw storage.
- 9E: ResearchDataHub and DatasetUsagePolicy.
- 9F: lineage, versioning and deprecation.
- 9G: research ingestion and first concrete provider qualification, including owned transport timeout and concurrency evidence.

This implementation adds no Paper, Testnet, Live, production-market-data or trading authority.
