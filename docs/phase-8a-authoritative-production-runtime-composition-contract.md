# Phase 8A Contract — Authoritative Production Runtime Composition

Status: contract gate only. Production composition is not implemented or activated by this change.

Baseline: `feature/orangeai-split` at `3f6918e317e608580dfcd565138432be9bebcd21`.

## 1. Repository truth and decision

The running application currently has no `ProductionSpine` owner. `createProductionSpine`,
`recoverAndStart`, `reconcileRecoveredState`, and `activateLiveReadiness` are called only by
tests. `createGateway()` mounts `WorkbenchReadAdapter` with application lifecycle and Hermes
providers, but no spine or retained recovery result.

The smallest repository-consistent future composition root is `createGateway(config)`. It
already constructs the application services returned as `AppGateway`, and `src/index.ts`
delegates process startup and shutdown to `AppGateway.start()` and `AppGateway.stop()`.

Phase 8A freezes this ownership:

```text
src/index.ts process lifecycle
  -> createGateway(config)
    -> one Application Production Runtime Owner per {exchange, accountId}
      -> one ProductionSpine
      -> one owner MarketDataRuntime
      -> one owner account KillSwitch / hard-risk provider
      -> one durable FileEventJournal
      -> one durable PaperLedgerStore
      -> retained RecoveryResult and ReconciliationReport
      -> exact-reference read provider
        -> WorkbenchReadAdapter.productionSpine
```

`AppGateway` is the lifecycle owner. Workbench, Hermes, Project Control Center, HTTP requests,
and monitor processes are never runtime owners.

## 2. Identity and single-authority scope

The singleton key is the explicit `{exchange, accountId}` trading-runtime identity. There may
be at most one application-owned `ProductionSpine` for that key in a process. An initial
implementation may support one configured key; it must not silently select an account.

The owner creates the spine once during application composition, retains the exact reference,
and supplies that reference to recovery, reconciliation, and the Workbench provider. Repeated
reads return the same reference or `null`. Replacing, cloning, replaying, or reconstructing a
spine for presentation is P0.

`src/runtime/production/ProductionRuntimeCompositionContract.ts` is the executable contract.
Its read binding creates no runtime, owns no trading state, and exposes no recovery,
reconciliation, execution, or activation method to Workbench.

## 3. Configuration and durability

Authoritative runtime ownership is opt-in and fail-closed. Missing runtime configuration leaves
the runtime `NOT_CONFIGURED`/`DISABLED` and Workbench returns unavailable canonical domains.

Before a spine may be created, the owner must have explicit, validated values for:

- exchange identity and account identity;
- durable journal location and an opened `FileEventJournal`/`EventJournalPort`;
- durable paper-ledger location and an account-bound `PaperLedgerStore` supplied as
  `PaperBrokerPersistence`;
- `PaperAccountConfig`, including account/exchange identity;
- legitimate collector/universe configuration for the owned `MarketDataRuntime`;
- an account/exchange-bound canonical hard-risk source.

The production owner must pass explicit `journal` and `persistence` dependencies to
`createProductionSpine`. It may not use the factory's current test/legacy in-memory persistence
fallback or create a disposable journal. Journal open/corruption, ledger load/corruption, or
identity mismatch fails startup closed and publishes no spine to Workbench.

Legacy and test factories outside this application composition boundary retain their current
behavior.

## 4. Market and hard-risk ownership

The Application Production Runtime Owner creates and stops the one legitimate
`MarketDataRuntime` for its runtime key and passes that exact instance as
`ProductionSpineConfig.marketRuntime`. Only collector ingestion on that instance may establish
freshness. Startup, Gateway, Workbench, Hermes, and tests cannot publish a synthetic ticker to
grant readiness.

The owner must also own or receive the one account-bound canonical `KillSwitch` used by the
runtime safety path. `ProductionSpineConfig.hardRisk` reads that authority; it cannot return a
hard-coded CLEAR snapshot or silently substitute zero exposure/positions. Repository production
composition does not currently own this instance, so implementation must close that dependency
boundary before creating a spine. Missing or incomplete hard-risk facts leave the runtime
disabled/unavailable; the dashboard cannot supply them.

## 5. Startup and authority separation

The orchestration/read states are:

`DISABLED`, `NOT_CONFIGURED`, `STARTING`, `RECOVERING`, `RECOVERY_FAILED`,
`RECOVERY_VERIFIED`, `RECONCILING`, `RECONCILIATION_FAILED`, `MARKET_FAILED`,
`READY_FOR_MARKET`, `LIVE_READY`, `STOPPING`, and `STOPPED`.

They describe orchestration and availability only. They are not a second safety lifecycle and
cannot grant authority held by `ProductionSpine`.

Configured startup order is frozen as:

1. validate identity, durability, market, and hard-risk dependencies;
2. open durable journal and paper ledger;
3. create exactly one spine and retain its identity without publishing it as available;
4. call `recoverAndStart()` on that spine and retain its `RecoveryResult`;
5. call `reconcileRecoveredState()` on the same spine and retain/read its canonical report;
6. start the owner `MarketDataRuntime`; collector-start failure remains fail-closed;
7. make the same spine available to read surfaces as `READY_FOR_MARKET` when factual reads are
   safe, without activating trading.

Application boot does not call `executeThroughGateway`, submit an OMS request, call
`activateLiveReadiness`, or grant any authorization. `ORDER_SUBMISSIONS=0` on boot.

The existing authority chain remains unchanged:

```text
journal replay -> RECOVERY_VERIFIED
  -> factual reconciliation -> RECONCILIATION_VERIFIED
  -> fresh collector market -> final current-fact reconciliation
  -> existing ProductionSpine LIVE_READY authority
```

Any future call to `activateLiveReadiness` must be owned by the Application Production Runtime
Owner, use the same spine, and follow a separately authorized existing workflow. A configuration
boolean, UI state, or application boot cannot invoke or replace this chain.

`SUBMISSION_UNKNOWN` remains terminal for automatic retry. Recovery, reconciliation, startup,
and shutdown must never resend it.

## 6. Workbench binding

The future binding is exactly:

```text
Application Production Runtime Owner.authoritativeSpine
  -> same-reference read provider
  -> WorkbenchReadAdapter.productionSpine
  -> GET-only Workbench router
```

The owner separately retains the `RecoveryResult` and supplies a read-only recovery provider.
Reconciliation, accounting, trade lifecycle, Market, Position, OMS, policy, and LIVE_READY are
read from the same spine and its existing stores. Missing, starting, failed, stopping, or stopped
runtime state returns `null`/`UNAVAILABLE`/`UNKNOWN`; a read cannot start or replace it.

Workbench cannot create, start, recover, reconcile, activate, execute, persist, or shut down the
runtime. Its router remains GET-only.

## 7. Failure and partial-start model

The default is fail closed:

| Failure | Required result |
| --- | --- |
| Missing/invalid config | `NOT_CONFIGURED` or `DISABLED`; no spine; Workbench unavailable. |
| Journal open/corruption | Startup fails; no read publication; no in-memory fallback. |
| Paper persistence load/save failure | Startup/operation fails closed; no disposable ledger. |
| Market collector start failure | `MARKET_FAILED`; no LIVE_READY; stop partial resources. |
| Recovery failure | `RECOVERY_FAILED`; retain evidence; no reconciliation/activation. |
| Reconciliation mismatch | `RECONCILIATION_FAILED`; retain report; no activation. |
| Truth acquisition failure | `RECONCILIATION_FAILED`; never substitute `MATCH`. |
| Missing/stale market | No LIVE_READY; no synthetic ticker or repair. |
| Partial startup | Withdraw read availability first, then unwind only owned resources. |
| Runtime shutdown | Workbench becomes unavailable/stale; no replacement is created. |

There is no automatic resend, synthetic repair, fake healthy state, or fallback authority.

## 8. Shutdown ownership

`AppGateway.stop()` owns runtime shutdown and calls it exactly once logically; repeated calls are
idempotent. The owner first withdraws Workbench availability and prevents new activation or
execution, then stops the market collector and position protection, drains/closes owned runtime
resources where supported, closes the journal, and finally seals the read binding. Existing
gateway resources continue their deterministic shutdown after the runtime owner is unavailable.

Shutdown cannot construct a replacement runtime. An HTTP read during shutdown returns
unavailable rather than restarting anything.

## 9. Paper, Testnet, and Live boundaries

- Paper: the first implementation is Paper-capable only, with explicit durable account identity
  and persistence. Owning the spine does not authorize order submission.
- Testnet: no authorization, credentials, adapter activation, or automatic escalation is added.
- Live: no real-money credentials, broker/exchange wiring, authorization, or activation is added.

`ProductionSpine` means the authoritative application runtime composition; it does not mean
real-money Live.

## 10. Phase 8B boundary

Project Control Center and factual activity remain owned by the separate Hermes monitor process.
Cross-process read transport, polling/cache, generic observability IPC, and event aggregation are
deferred to Phase 8B — Operations Evidence Read Bridge. Until then those Workbench domains may
remain `UNAVAILABLE`/`INCOMPLETE`. Phase 8A must not copy monitor state into trading authority.

## 11. Phase 8A implementation acceptance criteria

Implementation remains a later, separately authorized change and must prove:

1. `createGateway()` creates at most one authoritative spine per explicit runtime key.
2. Required durability, market, identity, and hard-risk dependencies fail closed when absent.
3. Recovery and reconciliation operate on the exact owner spine; retained evidence is readable.
4. Workbench receives the exact same reference and repeated reads create nothing.
5. Missing/stopped runtime is unavailable and no read can restart it.
6. App boot grants neither LIVE_READY nor order submission.
7. `SUBMISSION_UNKNOWN` never auto-retries.
8. Startup rollback and shutdown are deterministic and idempotent.
9. No second Kernel, OMS, stores, ledger, accounting, lifecycle, recovery, reconciliation, or
   LIVE_READY truth is created for integration or presentation.
10. Phase 8B operations bridges remain deferred.

This contract gate does not claim any of those implementation items complete.
