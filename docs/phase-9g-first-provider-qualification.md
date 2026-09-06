# Phase 9G — TickFlow First Provider Qualification

## Verified provider contract

The provider contract was checked against TickFlow's official documentation and official SDK on 2026-09-07.
The free service origin is fixed to `https://free-api.tickflow.org`, requires no API key, and offers historical
daily-or-longer K-lines without real-time or minute data. This qualification uses only `GET /v1/klines` with a single
six-digit symbol carrying an `SH`, `SZ`, or `BJ` suffix, `period=1d`, explicit `adjust=none`, and `count<=10000`.

Official references:

- [TickFlow free-service quickstart](https://docs.tickflow.org/zh-Hans/quickstart)
- [TickFlow K-line REST reference](https://docs.tickflow.org/zh-hans/api-reference/k%E7%BA%BF%E6%95%B0%E6%8D%AE/%E6%9F%A5%E8%AF%A2-k%E7%BA%BF%E6%95%B0%E6%8D%AE)
- [Official TickFlow SDK](https://github.com/tickflow-org/tickflow)

The SDK license does not establish unrestricted redistribution rights for provider data. The manifest therefore keeps
`redistributionAllowed=false` and records that provider data terms still require review.

## Existing ingress path

The adapter implements exactly `describe()`, `validateConfiguration()`, and `fetch()`. It is registered through the
existing `ResearchProviderIngress`; Phase 9G adds no second registry, generic fetch pipeline, automatic pagination, or
retry. The configuration contains only the pinned exchange-qualified symbol. Callers cannot choose an origin, path,
period, adjustment, or credential.

The manifest scope `CN-SH-SZ-BJ-6digit-symbols` describes exactly this syntax. The same syntax can name several
instrument classes, so Phase 9G does not infer a class from code ranges and records `instrumentClassVerified=false` in
the qualification declaration. Unknown or nonexistent symbols remain provider-boundary failures.

The supported path is:

```text
TickFlow free historical response
→ TickFlowHistoricalKlineAdapter
→ ResearchProviderIngress
→ RawResearchRecord[]
→ STOP
```

Cursor and range requests are rejected in this first qualification. This avoids claiming provider range inclusivity
that has not been frozen as a DSbot invariant.

## Bounded transport and response validation

The adapter enforces the request timeout with an owned `AbortController`, propagates caller abort, performs no retry,
uses redirect mode `manual`, and rejects redirects or responses attributed to another origin. HTTP failures are reduced
to bounded local status errors without including remote response bodies.

Response bytes are bounded before JSON materialization. The compact response must contain dense, equal-length
`timestamp`, `open`, `high`, `low`, `close`, `volume`, and `amount` arrays. Optional documented arrays are accepted only
with the same length. Timestamp, numeric, OHLC relationship, duplicate timestamp, and requested count invariants are
validated for the complete page before any records are returned.

Each record uses `symbol + period + timestamp + adjust` for stable source identity. Its `payloadHash` is deterministic
SHA-256 over the exact bounded adapter payload. This is an adapter-observed content digest, not provider authenticity
proof. No request time, acquisition time, randomness, or response index enters that digest.

## Time and authority boundary

TickFlow's millisecond `timestamp` becomes canonical UTC `eventTime`. The official contract does not establish an exact
historical dissemination timestamp for each bar, so every record keeps:

```text
availableAt=null
availableAtAuthority=UNKNOWN
```

`ingestedAt` is injected acquisition evidence and is never substituted for market availability. Phase 9C remains the
sole PIT eligibility authority and will not treat these records as historically visible without later authoritative
availability evidence.

The immutable qualification scope is `RESEARCH_INGESTION_ONLY`. It grants no PIT, decision-input, storage, backtest,
Paper, Testnet, Live, or production authority. Network I/O exists only inside the TickFlow adapter.
