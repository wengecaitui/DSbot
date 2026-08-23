# Phase 8B Contract — Operations Evidence Read Bridge

Status: contract gate. Phase 8B implementation is NOT authorized by this change.

## 1. Purpose and verified baseline

Phase 8B connects already-existing engineering/runtime observability evidence into the existing
Workbench Operations domain. It is an **evidence plane**, never a control plane. It answers "what is
this system doing and what is its delivery state?" — it never answers "should the system trade" and
it never changes the answer to that question.

This contract was derived from the Phase 8A integration baseline
`feature/orangeai-split@ad3217b713bafe051610c7f2d3b5cd4cd48b2945` (PR #123 merged).

The current Workbench contract (`src/observability/workbench-contract.ts`) already defines
`OperationsOverviewSnapshot` as a separate domain carrying Hermes, recent events, and Project
Control Center. `WorkbenchReadAdapter` supports optional `projectControlCenter()` and `activity()`
providers, but `createGateway()` does not mount them today, so `operations()` is `INCOMPLETE`.
Phase 8B exists to close exactly this gap — no more.

## 2. Plane identity

Phase 8B is observational-only:

```text
OPERATIONS_EVIDENCE_CAN_OBSERVE=true
OPERATIONS_EVIDENCE_CAN_AUTHORIZE=false
OPERATIONS_EVIDENCE_CAN_EXECUTE=false
OPERATIONS_EVIDENCE_CAN_MUTATE_TRADING=false
OPERATIONS_BRIDGE_READ_ONLY=true
OPERATIONS_BRIDGE_TRADING_AUTHORITY=false
```

The bridge must never become part of: TradingKernel authority, MarketDataRuntime authority,
Position authority, Accounting authority, OMS authority, risk admission, recovery verification,
reconciliation verification, LIVE_READY, or kill-switch authority.

## 3. Authority map

The following classification is frozen. The last six facts plus LIVE_READY are trading authority;
the Operations Evidence Bridge must not change their assignment.

| Fact | Authority | Domain | Trading authority |
| --- | --- | --- | --- |
| Hermes handshake/coordinator state | `HandshakeCoordinator` | runtime/operations | No |
| External Hermes process/log/runtime evidence | `OBSERVED_SOURCE_ONLY` | operations | No |
| Git branch/head/worktree/PR/CI evidence | `ProjectControlCenter` / inspected repository state | operations-engineering-evidence | No |
| `ObservableAgentEvent` | observational event record | operations/activity | No |
| Market | `KernelMarketStateStore` | trading | Yes |
| Position | `KernelPositionStateStore` | trading | Yes |
| Order | `OmsOrderStore` | trading | Yes |
| Accounting | `RuntimeAccounting` | trading | Yes |
| Recovery | `RecoveryManager` / owner spine evidence | trading | Yes |
| Reconciliation | `ReconciliationReport` / owner spine | trading | Yes |
| LIVE_READY | `ProductionSpine safety gate` | trading | Yes |

## 4. Critical Hermes identity distinction

There are two different kinds of Hermes evidence and they must never be conflated:

- **A. HandshakeCoordinator** — the in-process authoritative source for `CoordinatorSnapshot`
  (lifecycle state, generation, health, circuit state, receipt counts). This authority already exists.
- **B. External Hermes runtime evidence** — external Hermes process existence, pid, gateway state
  file, listening port, health endpoint, logs, and observed tool/action events. These are
  observational engineering evidence only.

Required contract:

```text
EXTERNAL_HERMES_RUNTIME != HANDSHAKE_COORDINATOR
```

External Hermes runtime observations may appear in Operations. They cannot redefine
`RuntimeOverviewSnapshot.hermes`, LIVE_READY, ProductionRuntime health, or risk state. The contract
reserves a distinct `HermesRuntimeEvidence` type (`src/observability/OperationsEvidenceReadBridgeContract.ts`)
that is explicitly `authoritativeForHandshakeHealth: false`, `authoritativeForLiveReady: false`,
and `authoritativeForTrading: false`. `CoordinatorSnapshot` is not overloaded.

## 5. One-way bridge rule

The bridge is strictly one-way:

```text
external/read sources
  -> observability normalization + redaction
  -> projection
  -> Workbench
```

Forbidden reverse edge: `Workbench -> source control`.

Forbidden bridge capabilities (never exported, never exposed through the Workbench/Operations
surface): `startAgent`, `stopAgent`, `restartHermes`, `runCommand`, `writeFile`, `deleteFile`,
`gitCommit`, `gitPush`, `mergePR`, `submitOrder`, `retryOrder`, `cancelOrder`, `closePosition`,
`reconcile`, `activateLive`, `setLiveReady`, `grantApproval`, `mutateRisk`, `mutateRuntime`,
`startProcess`, `killProcess`. No generic command RPC is built.

## 6. Observable event contract

The repository-native `ObservableAgentEvent` remains the canonical activity envelope. Its fields are
preserved: `schemaVersion`, `eventId`, `runId`, `taskId`, `timestamp`, `actor`, `source`, `action`,
`target`, `cwd`, `riskClass`, `evidenceLevel`, `approvalId`, `commandDigest`, `before`, `after`,
`result`, `redactions`. No second incompatible event universe is introduced.

Required direction:

```text
Raw evidence
  -> EventNormalizer
  -> redacted ObservableAgentEvent
  -> optional audit ledger
  -> bounded recent-event projector
  -> Workbench
```

Raw credentials or unredacted command/environment content are never exposed.

## 7. Secret / redaction boundary

Phase 8B forbids exposing secrets through logs, environment variables, command text, filesystem
observations, process command lines, before/after payloads, or Project Control Center evidence.

```text
OBSERVABILITY_MAY_OBSERVE_EXISTENCE_OR_STATUS=true
OBSERVABILITY_MAY_NOT_PUBLISH_SECRET_VALUE=true
```

Examples that must never appear: exchange API secrets, private keys, `HERMES_BRIDGE_TOKEN`,
OpenAI/Anthropic API keys, database credentials, wallet secrets, authentication headers, cookies.
Existing repository redaction facilities (`src/observability/redaction.ts`) are reused.

## 8. Source failure semantics

Operations observability is not trading authority. A failed observability source must not grant
LIVE_READY, revoke a factual LIVE_READY by inventing trading evidence, mutate
`ProductionRuntimeOwner`, mutate positions/orders/accounting, start or stop trading, or trigger
OMS/recovery/reconciliation.

Instead: source failure degrades the affected operations evidence to
`UNAVAILABLE` / `INCOMPLETE` / `STALE` / `UNKNOWN` with provenance/reason preserved.

```text
source failure -> healthy default              NO
missing process evidence -> process healthy    NO
missing events -> zero-risk inference          NO
```

Evidence-only failures are isolated from trading authority. `UNKNOWN != HEALTHY`,
`UNAVAILABLE != EMPTY`, `MISSING != ZERO`.

## 9. Lifecycle contract

The future implementation owns exactly one Operations Evidence Bridge per AppGateway lifecycle:

```text
AppGateway
├── ApplicationProductionRuntimeOwner
├── HandshakeCoordinator
└── OperationsEvidenceBridge
      ├── source adapters
      ├── monitor/normalizer
      ├── ProjectControlCenter
      └── read projections
```

The bridge may observe, normalize, redact, aggregate, persist audit evidence, and expose immutable
snapshots. It may not own trading state and is not a second application runtime. Start/stop must be
idempotent, deterministic, bounded, with no orphan polling timers, no duplicate adapter
subscriptions, and no duplicate bridge instance per AppGateway. This lifecycle is not implemented in
the Contract Gate.

## 10. Project Control Center boundary

`ProjectControlCenterSnapshot` is reused unchanged. It preserves `readOnlyDashboard=true`,
`dashboardGrantsApproval=false`, `tradingEnvironmentActivated=false`, and fail-closed approvals.

Project Control Center may report repository, branch, head, changed files, PR, CI, local tests,
runtime smoke, blockers, event timeline, and next action. It must never mean "CI PASS => Live
authorized", "PR merged => strategy promoted", or "dashboard READY => ProductionSpine LIVE_READY".
Engineering delivery evidence and trading safety evidence remain separate truth domains.

## 11. Workbench boundary

`/api/workbench/v1` remains a read-only surface. Existing GET resources stay read-only; POST / PUT /
PATCH / DELETE continue to fail 405. Phase 8B does not add control endpoints. Any extension must
preserve `availability`, `freshness`, `provenance`, and an explicit absence reason, and must not
change existing canonical trading values.

## 12. Event aggregation rules

Frozen for future implementation: bounded recent-event retention, stable ordering, explicit event
identity, no duplicate publication from repeated polling where state did not change, source
provenance retained, no fabricated timestamps, no browser-side inference of event authority,
normalized risk/evidence level preserved, source errors visible, and reconnect/restart must not
silently convert old evidence into current evidence. Durable audit, if used, is evidence storage,
not trading truth.

## 13. Transport / IPC boundary

Phase 8B does not create a general-purpose IPC command bus. It needs only enough transport to READ
evidence. Permitted future read mechanisms are repository-existing patterns: file observation, log
tail/observation, process/port probe, loopback read-only HTTP health endpoint, bounded polling, and
existing event sink/source adapter contracts. Any future cross-process transport must be READ_ONLY,
LOOPBACK/EXPLICITLY_SCOPED where appropriate, AUTHENTICATED if sensitive, BOUNDED,
TIMEOUT-CONSTRAINED, and FAIL-CLOSED for its own evidence — with no generic remote command surface.

## 14. SSE / streaming

No WebSocket or DataHub is required for Phase 8B. Current GET snapshot routes are the minimum read
model. Read-only SSE for recent activity may be reserved later (server→client only, no browser
command channel, no trading control, no new runtime authority), but is not implemented here.

## 15. Out of scope

Phase 8B production wiring, frontend redesign, React work, DockManager, DataHub, Research Data
Plane, TickFlow integration, Parquet/DuckDB/Polars, AI Research Sandbox, Experiment Protocol, MCP
expansion, agent command/control bridge, remote shell, automatic remediation, automatic merge,
strategy promotion, Paper trading activation, Testnet, Live, exchange credentials, and new
execution adapters are all out of scope.

## 16. Implementation acceptance criteria

Implementation may start only after explicit authorization. Its review must prove:

1. Exactly one Operations Evidence Bridge owned by AppGateway; never a second runtime.
2. The bridge is observational-only: no trading authority, no order mutation.
3. External Hermes runtime evidence never overwrites HandshakeCoordinator authority.
4. Source failure degrades to UNKNOWN/UNAVAILABLE/INCOMPLETE, never healthy/zero.
5. Raw evidence passes through normalization/redaction before publication.
6. `ObservableAgentEvent` remains the canonical activity event envelope.
7. Workbench `/api/workbench/v1` stays GET-only; no mutation or control endpoints.
8. Project Control Center remains Operations engineering evidence with fail-closed approvals.
9. Focused contract tests, typecheck, build, relevant regressions, full Node convention, and diff
   checks pass before review.

The executable contract is `src/observability/OperationsEvidenceReadBridgeContract.ts`. Its
`assertOperationsEvidenceReadBridgeContract` fails closed if any frozen invariant is weakened.
