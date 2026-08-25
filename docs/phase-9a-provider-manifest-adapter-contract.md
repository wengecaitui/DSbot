# Phase 9A — Provider Manifest + Adapter Contract Gate

Status: **CURRENT / CONTRACT ONLY**
Base: `feature/orangeai-split@788671ebfb54ce886bc3c8e1315873b4ef1c7025`

## 1. Decision and scope

Phase 9A freezes one entry boundary:

```text
External Provider
  -> Provider Manifest
  -> bounded read-only ResearchProviderAdapter
  -> RawResearchRecord
  -> future Phase 9B/9C
```

The bounded context is `src/research/data/`. It is a Research Data Plane contract, not a provider implementation, data dictionary, canonical dataset, storage engine, research hub, backtest kernel, or trading integration.

The governing identity is:

```text
RESEARCH DATA != PRODUCTION MARKET DATA
```

Research data has `productionAuthority=false`. It cannot establish market freshness, position value, order state, accounting, Recovery, Reconciliation, `LIVE_READY`, or execution authorization.

## 2. Provider Manifest

A manifest explains how a provider can be read without pretending that provider fields are already canonical research data. It must declare:

- schema version, manifest version, provider ID, adapter ID and adapter version;
- generic data domains and market scopes;
- transport kind/protocol;
- authentication mode and external credential references only;
- bounded pagination capability and maximum records per page;
- ordering guarantee and keys;
- duplicate, rate-limit and revision semantics;
- redistribution permission, license and attribution metadata;
- event-time source plus availability-time source/rule and its authority;
- literal `productionAuthority=false`.

The vocabulary is intentionally provider-neutral. Phase 9A does not freeze one vendor's symbols, endpoints, asset classes or pagination conventions as repository-wide enums.

### 2.1 Authentication boundary

Secret values are forbidden in manifests and adapter configuration. Credential material must be represented only by an external locator:

```text
env:<identifier>
secret-manager:<identifier>
runtime:<identifier>
```

An API key, token, password, authorization header, cookie, private key, credential field or credential-bearing URI userinfo embedded as a value fails validation. Sensitive-key detection is semantic across camelCase, snake_case and kebab-case compound names. Symbol-keyed configuration is also rejected because it cannot bypass the string-key inspection. This contract stores no credential and introduces no provider account or network client.

## 3. Time and point-in-time rule

These timestamps remain different facts:

- `event_time`: when the source event economically or operationally occurred;
- `available_at`: when that fact became observable to a historical decision;
- `ingested_at`: when DSbot acquired the raw evidence.

The future visibility gate is:

```text
available_at <= decision_time
```

`availableAtAuthority` is exactly one of:

- `PROVIDER_FIELD`: a provider field supplies availability time;
- `DOCUMENTED_RULE`: a cited provider/publication rule determines it;
- `UNKNOWN`: Phase 9A cannot prove it.

`UNKNOWN` is permitted on raw evidence so uncertainty is retained. It never proves point-in-time safety and never implies backtest eligibility. Phase 9A defines no `BACKTEST_ELIGIBLE` transition; Phase 9C must enforce visibility when canonical point-in-time datasets exist.

## 4. ResearchProviderAdapter

The only public adapter operations are:

```ts
describe(): ProviderManifest
validateConfiguration(configuration: unknown): void
fetch(request: ResearchFetchRequest, signal: AbortSignal): Promise<ResearchFetchPage>
```

Each fetch request has an explicit record limit and required bounded `timeoutMs` input, plus an optional cursor and/or half-open range. One call returns one bounded page with `records`, `nextCursor | null`, and `complete`.

An adapter must reject cancellation and terminate the I/O it owns. Cancellation must not resolve as a successful partial page. The Phase 9A boundary checks cancellation before and after the adapter promise, but it does not create a timer, use `Promise.race`, or generically enforce a network deadline. Runtime transport deadline enforcement is deferred to each concrete provider implementation, which must prove that it owns and cancels the underlying I/O when its bounded timeout or abort signal fires. Phase 9A introduces neither a lifecycle (`start`/`stop`) nor continuous streaming.

The adapter object and every inspected prototype must have zero symbol-keyed public properties. This fail-closed rule prevents capabilities hidden from ordinary string-key surface inspection.

Forbidden capabilities include trading, order submission/cancellation, publication into `MarketDataRuntime`, `LIVE_READY` mutation, production writes, shell/process execution, filesystem mutation and Git mutation.

## 5. RawResearchRecord

The raw envelope retains only minimum provider provenance:

- provider, adapter and adapter-version identity;
- provider dataset reference and source record ID;
- separate event, availability and ingestion times;
- availability authority;
- opaque payload and supplied payload SHA-256;
- manifest version/reference, request ID and source provenance reference;
- optional source revision metadata.

Phase 9A validates a supplied digest but does not generate it. It reuses no duplicate canonical-JSON implementation. The envelope does not define canonical fields, canonical `datasetId`, cross-provider deduplication, revision lineage or eligibility.

## 6. Production authority boundary

`src/research/data/**` has no dependency on `src/data/**` and no import from TradingKernel, OMS, PreTradeRiskGateway, ProductionSpine, Position/Accounting, Recovery/Reconciliation, or any `LIVE_READY` authority. It exposes no order or production mutation method.

The existing `src/data/**` remains the production-oriented market-data boundary. `src/trading/backtest.ts` remains unchanged and is not declared authoritative by this contract.

## 7. Deferred work

Phase 9B/9C must separately define and review:

- data dictionary and canonical field semantics;
- canonical normalization and dataset identity;
- point-in-time dataset enforcement;
- cross-provider duplicate handling and revision lineage;
- dataset lifecycle and backtest eligibility.

Parquet, DuckDB, Polars, ResearchDataHub, ResearchBacktestKernel, AI sandbox, governed splits, candidate registry, promotion and Paper/Testnet/Live activation are also outside Phase 9A.

## 8. Acceptance gate

The executable contract must reject incomplete manifests, non-false production authority, inline secrets, ambiguous availability claims, unbounded fetch requests, widened adapter capabilities, invalid raw provenance and abort-to-success conversion. Static boundary tests must prove there is no production-authority import and no real provider/network implementation in this delivery.
