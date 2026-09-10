# DSbot Project Status Snapshot — 2026-09-04

> Planning / coordination snapshot only. Git, GitHub exact-head state, merged contracts, and runtime evidence remain authoritative when this document becomes stale.

## 1. Current integration truth

- Integration branch: `feature/orangeai-split`
- Integration head: `aa4dee630de6550758e327dccef3056f95f307d4`
- Head meaning: PR #131 merged — Stage 4B / Stage 5 durable historical authority chain.
- Production safety state remains blocked:
  - `PAPER_APPROVED=false`
  - `TESTNET_APPROVED=false`
  - `LIVE_APPROVED=false`
  - `RUNTIME_STARTED=false`

## 2. Completed architecture foundations

### Phase 7 — Hermes + Quant Terminal

Completed and merged:

- Hermes handshake / lifecycle authority boundary.
- Gateway wiring without a second lifecycle truth.
- Read-only Quant Terminal / Workbench.
- Hermes is an external slow-plane / evidence source, not trading authority.

### Phase 8 — Production runtime ownership + operations evidence

Completed and merged:

- One application-owned production runtime composition.
- One authoritative trading truth.
- Risk / OMS / Position / Protection / Accounting / Recovery / Reconciliation boundaries.
- Operations evidence is read-only and cannot authorize or execute trading.

Frozen invariants:

```text
ONE RUNTIME
ONE TRUTH
READ-ONLY PRESENTATION
FAIL-CLOSED
NO AUTHORITY BYPASS
```

### Stage 4B / Stage 5 durable authority chain

PR #131 is merged at:

`aa4dee630de6550758e327dccef3056f95f307d4`

The historical proof chain no longer depends on finite-retention GitHub Actions artifacts as long-lived trust roots.

Current durable model:

```text
historical subject bytes
  -> canonical Git blob
  -> exact-path byte preservation
  -> raw SHA-256 + byte length + semantic identity
  -> offline fail-closed verifier
  -> existing independent semantic verifier / historical anchors
```

Key result:

- 14 durable historical subjects.
- zero migrated historical `gh run download` authority dependencies.
- existing historical IDs / hashes remain unchanged.
- evidence validity does not imply Paper/Testnet/Live authorization.

## 3. Research Data Plane status

### Phase 9A — COMPLETE

Provider Manifest + Adapter Contract and Internal Research Provider Ingress are merged.

Current stop boundary:

```text
Future Provider Adapter
  -> ResearchProviderIngress
  -> validated RawResearchRecord page
  -> STOP
```

Important guarantees:

- `src/research/data/**` is separated from production `src/data/**` authority.
- manifest snapshot validation is defensive and fail-closed.
- one real `describe()` / one raw `fetch()` per page.
- external-reference-only registration configuration boundary.
- no automatic retry / pagination / background lifecycle.
- raw `payload` remains opaque and is not treated as canonical research data.
- `event_time`, `available_at`, and `ingested_at` remain distinct.

### Phase 9B — CODE COMPLETE / NOT MERGED

Open Draft PR: #128

Current reviewed head:

`43018e661f22278217f10906125269e53a1acc35`

Current base:

`aa4dee630de6550758e327dccef3056f95f307d4`

The PR still contains exactly the intended seven Phase 9B files relative to current integration.

Phase 9B freezes:

```text
RawResearchRecord.payload
  -> ProviderSourceBindingSet
  -> current-pair compatibility gate
  -> CanonicalFieldDictionary
  -> STOP
```

Frozen design properties include:

- provider-neutral canonical semantics vs provider-bound source assertions.
- DIRECT mapping only.
- logical type / unit / currency dependency semantics.
- `MISSING != NULL != ZERO`.
- explicit price basis semantics.
- explicit observation / period / calendar attribution.
- separate event-time and available-at requirements.
- `UNKNOWN` availability cannot become decision input.
- semantic `LABEL` cannot become decision input.
- no `pointInTimeSafe` boolean.
- no dataset-level backtest eligibility authority.
- no normalization, storage, ResearchDataHub, real provider, network, or production authority.

Code-level review status:

```text
PHASE_9B_P0=0
PHASE_9B_P1=0
```

## 4. Current merge blocker — dependency security gate

PR #128 is not blocked by Phase 9B semantics.

A fresh npm advisory update appeared after PR #131 had already passed its exact-head security gate. Clean integration head `aa4dee...` reproduces the current production dependency audit failure.

Current known advisories include:

- `GHSA-528h-pc64-c93x` — `stream-json`.
- `GHSA-82x6-q7mm-w9cf` — `toml`.
- `GHSA-v5mp-jgw5-2x6j` — `toml`.

Current dependency analysis shows no bounded package-only remediation has yet been proven safe:

- `jayson@4.3.0` remains tied to the vulnerable `stream-json` major line; forcing `stream-json` 3.x breaks its CommonJS API expectations.
- `toml` safe versions require a major transition from the currently resolved 3.x line; compatibility across all Anchor / SDK consumers must not be assumed from `parse()` smoke tests alone.

Current governance state:

```text
INTEGRATION_SECURITY_P1=1
SECURITY_EXCEPTION_AUTHORIZED=false
RISK_ACCEPTANCE_AUTHORIZED=false
```

Next security step is a read-only production reachability / exploitability audit before any temporary advisory-specific exception is considered.

Do not modify PR #128 merely to silence the security gate.

## 5. Superseded infrastructure PRs

- PR #129 — closed, not merged, superseded by #131.
- PR #130 — closed, not merged, superseded by #131.

They must not be reintroduced into the current authority chain.

## 6. Next Research Data phases

The intended sequence remains:

```text
9B  Canonical Field Dictionary + Provider Source Binding
9C  Canonical Point-in-Time Dataset
9D  Analytical + Raw Storage
9E  ResearchDataHub + DatasetUsagePolicy
9F  Lineage / Version / Deprecation
9G  Research Ingestion + First Provider Qualification
```

Real TickFlow / QMT / TDX research-provider qualification belongs to 9G, not before canonical semantics and PIT rules exist.

## 7. Phase 10 target architecture

The legacy generic "audit / validation" Phase 10 wording in `PHASE_PROGRESS.md` is historical documentation debt and should not be treated as the current research architecture target.

The intended Phase 10 direction is:

```text
Trusted Data
  -> fixed / versioned ResearchBacktestKernel
  -> AI Research Sandbox
  -> pre-registered experiment protocol
  -> TRAIN / VALIDATION
  -> Candidate Freeze
  -> LOCKED TEST
  -> Forward Paper
  -> Promotion Gate
  -> Human Authorization
  -> existing DSbot production safety boundary
```

The purpose is not merely better backtesting; it is to stop AI / optimization search from silently turning repeated experimentation into false out-of-sample evidence.

## 8. Current architectural imbalance

Today DSbot's production-safety half is more mature than its research half.

Strong / already established:

- production authority boundaries.
- OMS / risk / position / protection / recovery / reconciliation foundations.
- read-only presentation and operations evidence.
- AI authority isolation.
- durable historical evidence chain.

Still incomplete:

- canonical PIT datasets.
- research storage and lineage.
- first qualified research-data provider.
- final authoritative research backtest kernel.
- train / validation / locked-test experiment governance.
- production-grade AI research sandbox.

The immediate product priority is therefore to complete the trusted research chain rather than expand strategy count, indicators, exchanges, or dashboard surface area.
