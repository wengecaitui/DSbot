# Phase 7C Contract — Read-Only Trading & Research Workbench V1

Status: contract gate; UI implementation is not authorized.

## 1. Purpose and verified baseline

Phase 7C V1 is a browser presentation layer for answering “what is happening now?” from DSbot's existing factual runtime. It is not a trading console, a replacement runtime, or a new source of financial truth.

This contract was derived from the following inspected revisions:

- DSbot integration baseline `feature/orangeai-split` at `c4dc26910e84677ec7ca7cb261d2ccf44772297c`.
- `tickflow-stock-panel` at `9b9538a70fa64d01314030b8823a508087f28c9d`.
- `FinceptTerminal` at `ffe24dd6076e73e05170b8cca24bbc6096ad4bc4`.

The DSbot baseline contains the merged Phase 6A Runtime Accounting projection, Phase 6B Trade Lifecycle projection, Phase 7A Hermes lifecycle core, and Phase 7B gateway wiring. PR #119 is represented by merge commit `c4dc26910e84677ec7ca7cb261d2ccf44772297c`.

## 2. Non-negotiable truth-source boundary

The workbench reads, projects, caches for presentation, and renders. It never owns or grants authoritative state.

| Fact | Existing authority | Workbench responsibility |
| --- | --- | --- |
| Market | `KernelMarketStateStore` | Display snapshots, version, update time, age, and stale state. |
| Position | `KernelPositionStateStore` | Display `PositionResolution`; preserve `missing != flat`. |
| Order | `OmsOrderStore` | Display the exact `OmsOrderStatus`, including `SUBMISSION_UNKNOWN`. |
| Protection | `PositionPlanStore` / position runtime | Display factual plan state; do not create or modify plans. |
| Accounting | `RuntimeAccounting` | Pass through valuation, PnL, exposure, fees, and slippage completeness. |
| Trade lifecycle | `TradeLifecycle` | Pass through lifecycle and aggregates without recomputation. |
| Recovery | `RecoveryManager` / production spine | Display the current recovery result only. |
| Reconciliation | `ReconciliationReport` / production spine | Display the current report; unavailable is not `MATCH`. |
| LIVE_READY | Existing ProductionSpine safety gate | Display derived readiness and blockers; never expose a setter or toggle. |
| Kill switch / risk | Existing runtime safety sources | Display an authoritative read when available; otherwise `UNKNOWN`. |
| Hermes | `HandshakeCoordinator` | Display the coordinator snapshot; do not infer health in the browser. |
| Engineering delivery | `ProjectControlCenterSnapshot` | Keep under Operations; do not mix into trading truth. |

The projection path is fixed:

```text
canonical factual runtime
  -> deterministic server-side read projection
  -> immutable/defensive snapshot
  -> authenticated read transport
  -> shared frontend server-state layer
  -> page/widget rendering
```

Forbidden reverse edges include UI/DataHub/widget/workflow/MCP to TradingKernel state, OMS state, Recovery, Reconciliation, LIVE_READY, accounting, or risk admission.

## 3. Read-model contract

`src/observability/workbench-contract.ts` freezes the executable responsibility boundary. It intentionally does not implement HTTP handlers.

The smallest domain snapshots are:

- `RuntimeOverviewSnapshot`: runtime health, environment/mode, and the canonical Hermes snapshot.
- `MarketOverviewSnapshot`: factual tracked market snapshots plus deterministic regime evidence when such evidence exists.
- `TradingOverviewSnapshot`: identified position resolutions, OMS orders, and protective plans.
- `AccountOverviewSnapshot`: canonical Runtime Accounting and Trade Lifecycle projections.
- `SafetyOverviewSnapshot`: recovery, reconciliation, derived LIVE_READY display, kill state, and blockers.
- `ResearchOverviewSnapshot`: provider capability/status, derived evidence, read-only job status, and reserved backtest roles.
- `OperationsOverviewSnapshot`: Hermes/event/Project Control Center evidence kept outside the trading overview.
- `WorkbenchOverviewSnapshot`: a small composition of the headline domain snapshots required by the overview; it does not absorb Project Control Center.

Every top-level domain is wrapped by `ReadOnlySnapshot<T>` with explicit:

- availability: `AVAILABLE`, `INCOMPLETE`, `UNAVAILABLE`, or `UNKNOWN`;
- freshness: `FRESH`, `STALE`, or `UNKNOWN`;
- backend provenance: capture time, source identity, source sequence/version, and last update time where known;
- data or an explicit absence reason.

The server boundary supplies capture time. A pure projection must not call `Date.now()`, read storage/network state, or generate random IDs. `INCOMPLETE` may retain partial canonical evidence (for example realized PnL while market valuation fields remain `null`). `UNKNOWN` and `UNAVAILABLE` carry `data: null`; they cannot be converted to numeric zero or healthy states.

The contract projector may only validate explicit provenance and absence semantics, defensively clone/deep-freeze output, and apply documented stable presentation ordering. It must not calculate equity, PnL, exposure, fees, slippage, profit factor, position state, order state, reconciliation, recovery, readiness, or Hermes health.

## 4. V1 information architecture

Use one stable shell and nine small top-level business routes. Closely related views remain local tabs.

| Route domain | Local tabs / responsibility |
| --- | --- |
| Overview | Current system, market, account, trading, safety, and activity headlines. |
| Market | State; regime. |
| Trading | Positions; orders; accounting. |
| Research | Signals; strategies; backtest; regime. Future concepts/industries remain an extension, not empty V1 pages. |
| AI / Policy | Policy; research interpretation. This domain cannot grant runtime policy authority. |
| Safety | Risk; recovery; reconciliation. |
| Operations | Hermes; events; Project Control Center. |
| Data | Data sources, provenance/freshness, and future Research Data Plane status. |
| Settings | Presentation/application configuration that does not mutate trading authority. |

V1 uses a fixed responsive layout made of modular read-only widgets. It does not implement a dock manager. Future movable panels, saved workspaces, and multi-window layouts remain client preference features.

## 5. Overview and persistent terminal status

The Overview must expose, without visiting engineering pages:

- System: runtime health, environment/mode, Hermes, market freshness, recovery, reconciliation, and LIVE_READY.
- Market: tracked instruments, factual current state, deterministic regime evidence when available, and provenance.
- Account: equity only when valuation is complete; realized/unrealized PnL with existing nullability; exposure; fees; slippage completeness.
- Trading: open/flat/missing semantics where queried, active/recent orders, visible `SUBMISSION_UNKNOWN`, and factual protection.
- Safety: risk blockers/rejections, recovery, reconciliation, and authoritative kill state or `UNKNOWN`.
- Activity: recent factual runtime events.

The shell keeps a compact, display-only status surface visible across Market, Trading, Research, Safety, Operations, and Data. Its facts are environment, market freshness, recovery, reconciliation, LIVE_READY, kill/risk, and Hermes. The contract freezes the evidence, not wording, color, pixels, or iconography.

## 6. Widget, server-state, and update boundaries

A widget consumes a read-only snapshot and renders. It cannot import `TradingKernel`, `OmsCore`, runtime state stores, `RecoveryManager`, reconciliation internals, or accounting ledgers. Candidate widgets are market/regime, account, positions, orders, risk, recovery, reconciliation, Hermes, and event stream.

The frontend has one shared server-state path:

```text
typed API client -> centralized resource/query keys -> shared cache -> routes/widgets
```

If React is selected during implementation, TanStack Query is preferred. No page or widget gets its own duplicate fetch, cache, or WebSocket for the same resource.

V1 does not need a backend DataHub. Simple snapshot resources plus the existing event mechanisms are smaller and avoid creating another runtime. A future read hub is permitted only as a fan-out/cache layer downstream of canonical projections and must expose topic provenance, TTL, last publish, age, last error, in-flight status, producer, and subscriber count. It can never publish back into trading authority.

Update classification is frozen by responsibility, not by exact URL:

| Resource | V1 update class | Rationale |
| --- | --- | --- |
| Overview/account/trading/research | Request-response snapshots | Correctness matters more than tick-level latency. |
| Runtime/market/safety/shell status | Bounded periodic refresh initially | Simple and sufficient for V1 factual status. |
| Recent runtime events | SSE is appropriate | Ordered server events with reconnect; no browser commands. |
| Research job status | Read-only job snapshot; SSE/NDJSON may be added with the future job runtime | V1 reserves job ID, progress, update time, terminal/unknown states, and no cancel capability. |
| Future high-frequency quotes | WebSocket only if an implementation requirement proves polling/SSE insufficient | “Financial data” alone is not a reason to add WS. |

## 7. Frontend, serving, build, and deployment boundary

The future presentation source belongs in a separate `web/` package using React, TypeScript, Vite, a shared query layer, and chart libraries only when justified. No dependency is added by this gate.

The existing DSbot process remains the only runtime lifecycle. A future web build produces static assets that the existing authenticated gateway can serve. Read projections are mounted through a dedicated versioned read-only router in that gateway; the exact URL is an implementation decision. The browser never imports runtime classes.

The root build may later orchestrate the web build and copy static assets into the existing distribution. Deployment remains one DSbot unit unless later evidence justifies a separate presentation deployment. A separate frontend package is a source/build boundary, not a second server lifecycle or safety authority.

Project Control Center retains its existing loopback/read-only engineering evidence semantics: `readOnlyDashboard = true`, `dashboardGrantsApproval = false`, and `tradingEnvironmentActivated = false`. It appears under Operations and is never inflated into the workbench mega-model.

## 8. Research Data Plane and external providers

The future research path is:

```text
external provider
  -> provider adapter
  -> normalizer
  -> canonical research dataset
  -> research repository/storage/compute
  -> features/screener/backtest
  -> derived evidence
  -> explicit validation/promotion/policy/risk boundary
  -> existing DSbot execution path
```

TickFlow, stock-sdk, AkShare, and licensed/custom APIs are candidates only. This gate selects and implements none. Scraped or unofficial data may be research input, but it is not execution truth, reconciliation evidence, recovery evidence, or LIVE_READY evidence.

Future storage may use Parquet for durable historical datasets, DuckDB for cold/ad-hoc analytics, and Polars for vectorized research compute. Those components live under a future Research Data Plane, not TradingKernel, Recovery, Reconciliation, OMS, or execution state.

Research evidence records whether it was produced deterministically or by AI. The allowed direction is deterministic facts -> derived evidence -> optional AI interpretation. AI interpretation is never an authoritative market/position fact and cannot submit an order. A backtest result also cannot auto-promote or activate a strategy.

## 9. Backtest, tool, and workflow reservation

The Research Backtest tab reserves factor, strategy, optimizer, and walk-forward modes. Dataset roles are explicit:

- `TRAIN` may tune parameters.
- `VALIDATION` evaluates but must not optimize parameters.
- `LOCKED_TEST` remains unavailable to strategy development until final evaluation.

Walk-forward may coexist with these roles; no optimizer or split executor is implemented here.

A future capability/tool layer may expose DSbot research/read services to Hermes, AI chat, or workflows. It remains downstream of service contracts and cannot bypass PreTradeRiskGateway/OMS or grant LIVE_READY, recovery, reconciliation, retry, or risk override authority. A future node workflow belongs to the slow research path, never the deterministic fast trading path.

## 10. Workspace state categories

Three state categories remain visibly separate:

- Server fact: market, positions, orders, accounting, recovery, reconciliation, Hermes.
- Derived server read model: overview and domain summaries with provenance.
- Client preference: layout, panel size, collapsed state, tab, sort, filter, chart range, theme, saved workspace.

Client preferences can be stored locally or through a non-trading preference service later. They never alter server facts or authority.

## 11. Reference and license boundary

From `tickflow-stock-panel`, this contract adopts only generic patterns: domain routes with local tabs, lazy presentation loading, a provider/normalizer/repository chain, shared query keys/cache, separated backtest workspaces, deterministic preprocessing before AI, and bounded job progress/reconnect behavior.

From FinceptTerminal, this contract adopts only generic architectural ideas: modular-monolith bounded contexts, one-fetch/many-subscriber read distribution, visible freshness, snapshot-consuming widgets, fixed shell status, lazy screens, client workspace preferences, and separation of services/tools/workflows.

FinceptTerminal's checked-in license states AGPL-3.0 plus additional commercial, trademark, and trade-dress terms. No Fincept C++, Qt, DataHub, DockManager, MCP, screen/widget, workflow, visual design, naming vocabulary unique to its trade dress, or other substantial source implementation is copied. DSbot uses independently written TypeScript contracts and repository-native patterns.

## 12. V1 exclusions

V1 excludes React implementation, dependency installation, docking/multi-window UI, backend DataHub, provider ingestion, A-share scraping, research storage migration, optimizer/walk-forward execution, node editor, MCP expansion, trading controls, Paper/Testnet/Live activation, and changes to TradingKernel, risk, OMS, positions, protection, recovery, reconciliation, accounting, trade lifecycle, Hermes receipts, or security policy.

## 13. Implementation acceptance criteria

Implementation may start only after explicit authorization. Its review must prove:

1. Every server resource is read-only and mutation methods/command aliases are absent.
2. Snapshots are deterministic from explicit factual inputs, defensively immutable, stably ordered, and provenance-aware.
3. Unknown, unavailable, incomplete, and stale remain visible; no convenient zero/healthy default is introduced.
4. `missing != flat`, `SUBMISSION_UNKNOWN` is unchanged, and LIVE_READY/recovery/reconciliation are display-only.
5. Accounting and trade lifecycle values are passed from canonical projections without browser economic recomputation.
6. Project Control Center remains Operations evidence with existing boundaries.
7. Shared resource keys/cache prevent duplicate page/widget inference and transport connections.
8. Research/provider/AI/workflow paths cannot reach OMS except through future explicit validation, policy, risk, and existing execution boundaries.
9. No Fincept implementation or protected visual/trade-dress material is copied.
10. Focused contract tests, typecheck, build, relevant regressions, full Node convention, and diff checks pass before review.

## 14. Known non-blocking implementation debt

- `PHASE_PROGRESS.md` was stale for Phase 7B and is corrected by this contract delivery.
- `src/risk/dashboard.ts` substitutes several missing risk inputs with numeric defaults. It is not an acceptable Phase 7C truth source; implementation must use an authoritative nullable/unknown-aware adapter instead of silently reusing it.
- DSbot currently has multiple HTTP surfaces, including mutation routes. The future workbench router must be separately enumerable and proven read-only; merely placing UI code in the existing gateway is insufficient evidence.
- No canonical consolidated runtime/shell-status projection exists yet. Phase 7C implementation may add a narrow adapter over existing authorities, but must not add setters or a second lifecycle.
