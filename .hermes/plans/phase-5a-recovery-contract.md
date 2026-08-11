# Phase 5A — Production Recovery Spine Contract Gate

**Branch**: `agent/phase-5a-recovery-contract`
**Base SHA**: `93c3239e6571c5fa3ca559f3e989726b766b7e93`
**Parent PR**: #107 (Phase 4C Kernel Production Execution Spine)
**Status**: CONTRACT_PROPOSED

---

## 1. ABSTRACT

The existing ProductionSpine (Phase 4C) operates on a volatile in-memory journal. On process restart, every kernel event, position state, OMS order, policy snapshot, and active plan is lost. This contract defines the minimum recovery mechanism that preserves factual state across restarts without changing any existing Phase 1–4C contract semantics.

---

## 2. EXISTING INFRASTRUCTURE (WHAT IS KEPT)

### 2.1 TradingKernel journal — exists, not durable

```text
src/kernel/
├── TradingKernel.ts          publish → validate → clone → freeze → journal.append → dispatch
├── EventJournalPort.ts        append(envelope) / getByEventId / readFromLogicalSequence
├── InMemoryEventJournal.ts    Map-backed, contiguous-sequence enforcement, deep-clone
└── KernelEventEnvelope.ts     kernelEventId + kernelLogicalSequence + kernelTimestamp
```

`createTradingKernel({ journal?, clock? })` accepts an optional journal. Default is `createInMemoryEventJournal()`.

### 2.2 Stores — event-driven apply, no snapshot export

| Store | Events consumed | Apply shape | Snapshot export? |
|---|---|---|---|
| KernelPositionStateStore | execution.fill.confirmed, position.baseline.confirmed | apply(e) → pos | No |
| KernelMarketStateStore | market.ticker.updated | apply(e) → snapshot | No (getSnapshot is runtime only) |
| KernelPolicyStore | policy.snapshot.published | apply(e) → resolution | No |
| OmsOrderStore | order.*, execution.fill.confirmed | apply(e) → snapshot | No |
| PositionPlanStore | position.plan.* | apply(e) → plan | No |

### 2.3 RuntimeMode — natural LIVE_READY gate

```typescript
type RuntimeMode = 'replay' | 'live';   // src/position/PositionManagerRuntime.ts:13
```

- Default: `'replay'`
- `onMarketEvent` / `onFillEvent` handlers check `mode !== 'live'` → return early
- TradingRuntime sets `mode = 'live'` at LIVE_READY boundary (after market data starts)
- `stop()` sets `mode = 'replay'`

### 2.4 ProductionSpine — one authoritative universe

```typescript
createProductionSpine(config) → {
  kernel,          // TradingKernel (one shared)
  positionStore,   // KernelPositionStateStore
  marketStore,     // KernelMarketStateStore
  oms,             // OmsCore (wrapped in dynamicPriceOms)
  planStore,       // PositionPlanStore
  protection,      // PositionManagerRuntime
  adapter,         // PaperExecutionAdapter
  service,         // PaperExecutionService
}
```

---

## 3. INVARIANT-TO-INFRASTRUCTURE GAP ANALYSIS

### 3.1 Invariant 1 — Durable event survival (P0)

**Current**: `InMemoryEventJournal` — all events lost on restart. No file/disk journal exists.

**Required**: `FileEventJournal` implementing `EventJournalPort` with append-only durability. Events must survive restart with preserved `kernelEventId`, `kernelLogicalSequence`, `kernelTimestamp`, and ordering.

### 3.2 Invariant 2 — Original event identity preserved (PASSES)

KernelEventEnvelope has `kernelEventId`, `kernelLogicalSequence`, `kernelTimestamp`. `InMemoryEventJournal` enforces contiguous sequence and deep-clones. This invariant is already structurally satisfied. The durability layer must preserve it — no new identity fields needed.

### 3.3 Invariant 3 — Startup reconstruction from factual history (P0)

**Current**: No replay mechanism. Stores have `apply()` but no initialization path other than subscribing to live kernel events.

**Required**: `ReplayCoordinator` that:
1. Opens durable journal
2. Reads all events in `kernelLogicalSequence` order
3. Calls `store.apply(env)` on each store for each event
4. Does NOT publish new kernel events (adapter-free)

Stores must also expose a snapshot/import pair for recovery verification (see 3.6).

### 3.4 Invariant 4 — Replay must not execute (P0)

**Current**: No replay guard exists. OmsCore constructor subscribes store to kernel events. If replay publishes events through kernel, the adapter would be invoked.

**Required**: `ReplayCoordinator` must call `store.apply()` directly, bypassing kernel.publish(). No execution adapter may be invoked during replay. No fills created. No orders submitted. No protective execution triggered.

### 3.5 Invariant 5 — Entry blocking before verification (P0)

**Current**: `RuntimeMode` starts as `'replay'` — protection is blocked. But kernel.publish() is still available. New entries can be published before recovery completes.

**Required**: Before recovery verification, the spine must reject new trading entries. Options:
1. Spine-level gate that blocks kernel.publish for trading events during recovery
2. RuntimeMode extended to spine scope (not just protection)

### 3.6 Invariant 6 — Verified recovery (P0)

**Current**: No recovery verification exists. No snapshot/recovery-report comparison mechanism.

**Required**: After replay:
1. Take pre-shutdown snapshot of every store (position, OMS, plan, policy)
2. After restart + replay, compute post-replay snapshot
3. Compare: factual Position / OMS / active Plan / Policy state must match
4. On mismatch → fail-closed (no LIVE_READY)

### 3.7 Invariant 7 — submission_unknown preserved (PASSES)

OMS state machine: `SUBMITTED → SUBMISSION_UNKNOWN` transition is permitted. After reaching SUBMISSION_UNKNOWN, status is terminal. The `.then()` handler in PositionManagerRuntime explicitly leaves submitted state for submission_unknown — no auto-retry.

This invariant is already satisfied. The durability layer must preserve the SUBMISSION_UNKNOWN status across restart.

### 3.8 Invariant 8 — Corrupt history fail-closed (P0)

**Current**: `InMemoryEventJournal` throws on duplicate eventId and non-contiguous sequence. `FileEventJournal` must add: checksum verification, integrity header, EOF detection, gap detection. Any of these → fail-closed.

### 3.9 Invariant 9 — Real policy consumption (P0)

**Current**: `executeThroughGateway()` in ProductionSpine.ts fabricates policy:

```typescript
policyResolution: { status: 'active', policy: null, allowNewEntries: true, ... }
```

`KernelPolicyStore` exists and is functional (consumes `policy.snapshot.published` events), but is never wired into the gateway path.

**Required**: ProductionSpine must create `KernelPolicyStore`, subscribe it to kernel, and pass resolved policy into Gateway. The fabricated allow-all must be removed.

### 3.10 Invariant 10 — One authoritative spine (PASSES)

ProductionSpine creates one shared kernel, one OMS, one set of state stores. No disconnected universe. This invariant is already satisfied.

---

## 4. CONTRADICTIONS WITH PHASE 1–4C

### 4.1 P0 — No durable journal (Invariant 1)

**Evidence**: `src/kernel/InMemoryEventJournal.ts` — only implementation. `TradingKernel` accepts `journal?: EventJournalPort` but ProductionSpine never passes a durable one.

**Impact**: All kernel state lost on restart.

**Resolution**: Implement `FileEventJournal` that writes append-only JSON lines to rotating files. Optional: SQLite-backed journal for transactional integrity.

### 4.2 P0 — No snapshot export on stores (Invariant 6)

**Evidence**: All five stores have `apply()` but no `snapshot()` or `import()`.

```typescript
// KernelPositionStateStore — no snapshot export
// KernelMarketStateStore — no snapshot export (getSnapshot is runtime only, depends on clock)
// KernelPolicyStore — no snapshot export
// OmsOrderStore — no snapshot export
// PositionPlanStore — no snapshot export
```

**Impact**: Cannot compare pre/post restart state. Recovery verification impossible.

**Resolution**: Add `snapshot(): StoreSnapshot` and `import(snapshot: StoreSnapshot): void` to each store. Ref: `StoreSnapshot` is a serializable representation of internal state.

### 4.3 P0 — Fabricated policy in gateway (Invariant 9)

**Evidence**: `src/position/ProductionSpine.ts:165-170`

```typescript
policyResolution: {
  status: 'active', policy: null, allowNewEntries: true,
  maxPositionMultiplier: 1, directionBias: 'neutral', riskLevel: 'low',
  allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: []
} as any,
```

`KernelPolicyStore` exists at `src/kernel/KernelPolicyStore.ts` with `resolve(exchange, symbol) → PolicyResolution`. It is never passed into ProductionSpine or executeThroughGateway.

**Impact**: Every trade intent routes through Gateway with an always-admitted policy. Real policy snapshots (which could block entries) are ignored.

**Resolution**: Add `policyStore: KernelPolicyStore` to `ProductionSpine`. Subscribe it to kernel. Pass `policyStore.resolve(exchange, symbol)` into `gatewayInput.policyResolution` in `executeThroughGateway`.

### 4.4 P0 — No ReplayCoordinator (Invariants 3, 4)

**Evidence**: No file `src/recovery/ReplayCoordinator.ts` or equivalent exists.

**Impact**: Cannot reconstruct state from durable history. Cannot guarantee adapter-free replay.

**Resolution**: Implement `ReplayCoordinator` that:
- Takes journal + list of stores
- Reads events in sequence order
- Calls `store.apply(event)` on each store
- Does not call kernel.publish or any adapter

### 4.5 P0 — No entry blocking during recovery (Invariant 5)

**Evidence**: `RuntimeMode` exists only on `PositionManagerRuntime`, not at spine level. `TradingKernel.publish()` has no recovery gate. `OmsCore.submitRequest()` has no recovery gate.

**Impact**: New entries can arrive and execute before recovery verifies old state is correct.

**Resolution**: Add spine-level `isRecoveryVerified` flag. Block kernel.publish for trading events until verified. Block OMS submissions until verified.

---

## 5. IMPLEMENTATION BOUNDARY

The minimum repository-consistent implementation boundary:

### 5.1 New files

```
src/recovery/
├── FileEventJournal.ts         # append-only durability (JSON Lines, rotating)
├── ReplayCoordinator.ts        # journal → stores replay, adapter-free
├── RecoveryManager.ts          # snapshot → replay → verify → LIVE_READY
├── RecoveryReport.ts           # pre/post snapshot comparison result
└── recovery-contracts.ts       # type definitions: RecoveryMode, RecoveryReport, etc.
```

### 5.2 Files expected to change

```
src/position/ProductionSpine.ts       # +KernelPolicyStore, +FileEventJournal, +RecoveryManager
src/kernel/TradingKernel.ts           # journal capacity enforcement (no op change)
tests/recovery/production-recovery.test.ts  # E2E recovery scenario
```

### 5.3 No changes to

```
src/kernel/KernelPositionStateStore.ts  # add snapshot() only — no logic change
src/kernel/KernelMarketStateStore.ts    # add snapshot() only — no logic change
src/kernel/KernelPolicyStore.ts         # add snapshot() only — no logic change
src/oms/OmsOrderStore.ts               # add snapshot() only — no logic change
src/position/PositionPlanStore.ts       # add snapshot() only — no logic change
src/risk/PreTradeRiskGateway.ts         # unchanged
src/oms/OmsCore.ts                      # unchanged (entry blocking via spine, not OmsCore)
src/position/PositionManagerRuntime.ts  # unchanged (protects via RuntimeMode)
```

---

## 6. CONTRACT SIGNATURES

### 6.1 FileEventJournal contract

```typescript
interface FileEventJournal extends EventJournalPort {
  // Inherits: append, getByEventId, readFromLogicalSequence
  readonly filePath: string;
  close(): void;
  readonly eventCount: number;
  readonly lastSequence: number;
}
```

**Failure modes**: disk full → throw on append. Corrupt line → fail-closed on read.

### 6.2 ReplayCoordinator contract

```typescript
interface ReplayCoordinator {
  replay(journal: EventJournalPort, stores: KernelStore[]): Promise<ReplayReport>;
}

interface ReplayReport {
  eventsReplayed: number;
  lastSequence: number;
  errors: ReplayError[];
  success: boolean;
}
```

### 6.3 RecoveryManager contract

```typescript
interface RecoveryManager {
  recover(journal: EventJournalPort, spine: ProductionSpine): Promise<RecoveryResult>;
}

interface RecoveryResult {
  mode: 'verified' | 'failed' | 'no_history';
  report: RecoveryReport;
  verifiedAt: number;
}

interface RecoveryReport {
  preShutdownSnapshot: SnapshotBundle | null;
  postReplaySnapshot: SnapshotBundle;
  matches: boolean;
  discrepancies: string[];
}
```

### 6.4 KernelPolicyStore snapshot contract

```typescript
interface KernelPolicyStore {
  // ... existing apply/resolve
  snapshot(): StoreSnapshot<PolicySnapshot>;      // new
  import(snapshot: StoreSnapshot<PolicySnapshot>): void;  // new — for recovery replay
}
```

---

## 7. TEST CONTRACT

```text
tests/recovery/production-recovery.test.ts

[REC-01] File journal survives restart with exact event identity, sequence, and ordering
[REC-02] ReplayCoordinator replays events → stores without calling any adapter
[REC-03] RecoveryManager prevents new entries during recovery
[REC-04] RecoveryManager activates LIVE_READY after verified recovery
[REC-05] Verified recovery → position/OMS/plan/policy match pre-restart state
[REC-06] Corrupt journal → fail-closed (no LIVE_READY)
[REC-07] Policy recovery resolves from real KernelPolicyStore, not fabricated allow-all
[REC-08] submission_unknown preserved across restart (no auto-retry)
[REC-09] Phase 4C protective stop → Gateway → OMS → paper fill path unchanged
[REC-10] Phase 1-4 regression suite passes
```

---

## 8. NON-CONTRADICTIONS (EXISTING CONTRACTS PRESERVED)

- TradingKernel synchronous subscriber semantics: Replay calls `apply()` directly — no publish, no subscriber dispatch
- RuntimeMode 'replay' / 'live': Respected — protection blocked during recovery
- submission_unknown no-auto-retry: Unchanged — terminal status preserved
- Missing ≠ flat: Unchanged — trustBaseline still required
- Gateway approved sizing: Unchanged — dynamicPriceOms wrapper preserved
- One shared kernel / OMS / state stores: Unchanged — same ProductionSpine

---

## 9. STATUS

```
BASE_SHA = 93c3239e6571c5fa3ca559f3e989726b766b7e93

CURRENT_RECOVERY_GAPS = 5 P0 (durable journal, snapshot export, policy consumption,
  replay coordinator, entry blocking)

DURABLE_JOURNAL_CONTRACT = FileEventJournal implementing EventJournalPort
REPLAY_ORDERING_CONTRACT = kernelLogicalSequence ordering preserved
STATE_RECONSTRUCTION_CONTRACT = ReplayCoordinator.apply() on all 5 stores
POLICY_RECOVERY_CONTRACT = KernelPolicyStore.resolve consumed by Gateway
OMS_RECOVERY_CONTRACT = OmsOrderStore snapshot/import added
POSITION_RECOVERY_CONTRACT = KernelPositionStateStore snapshot/import added
PLAN_RECOVERY_CONTRACT = PositionPlanStore snapshot/import added
SUBMISSION_UNKNOWN_CONTRACT = terminal state preserved across restart (already satisfied)
LIVE_READY_CONTRACT = RuntimeMode replay→live only after verified recovery
FAIL_CLOSED_CONTRACT = corrupt/incomplete/duplicate journal → no LIVE_READY

IMPLEMENTATION_BOUNDARY = 5 new files + 2 modified files
FILES_EXPECTED_TO_CHANGE = ProductionSpine.ts, TradingKernel.ts (capacity), 5 stores (snapshot only)

P0_CONTRADICTIONS = 5 (above)
P1_CONTRADICTIONS = 1 (InMemoryEventJournal no capacity limit — OOM risk, addressed by FileEventJournal)

STATUS = CONTRACT_READY_FOR_REVIEW
```
