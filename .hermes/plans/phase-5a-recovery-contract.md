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

### 2.2 Stores — event-driven apply

| Store | Events consumed | Apply shape |
|---|---|---|
| KernelPositionStateStore | execution.fill.confirmed, position.baseline.confirmed | apply(e) → pos |
| KernelMarketStateStore | market.ticker.updated | apply(e) → snapshot |
| KernelPolicyStore | policy.snapshot.published | apply(e) → resolution |
| OmsOrderStore | order.*, execution.fill.confirmed | apply(e) → snapshot |
| PositionPlanStore | position.plan.* | apply(e) → plan |

### 2.3 RuntimeMode — natural LIVE_READY gate

```typescript
type RuntimeMode = 'replay' | 'live';   // src/position/PositionManagerRuntime.ts:13
```

- Default: `'replay'` — handlers return early, protection blocked
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

## 3. INVARIANTS

### 3.1 Kernel sequence resumes where journal ends

**Contract**:

```
journal terminal sequence = N
→ recovered kernel initialises at N
→ first new event = N+1

kernelLogicalSequence is never reset to 1 after a non-empty recovery.
kernelLogicalSequence 1 means genuine cold start (no history).
```

**Current gap (P0)**: `InMemoryEventJournal` is volatile. On restart, sequence starts at 1 regardless of prior history. Need `FileEventJournal` that persists `lastSequence` and feeds it to TradingKernel initialisation so the sequence chain never breaks across restarts.

**Implementation**: `FileEventJournal` exposes `readonly lastSequence: number`. `TradingKernel` accepts `initialSequence?: number` in config (defaults to 1). After recovery, TradingKernel is created with `initialSequence: journal.lastSequence + 1`.

### 3.2 Durable journal is the sole factual authority

**Contract**:

```
The durable factual journal is authoritative.

Recovery does not require a graceful pre-shutdown snapshot.
Crash recovery works from journal alone.

Store digests may verify reconstructed state,
but there is no second factual state authority.

Snapshot import is NOT a recovery mechanism —
it is a verification aid, not a state source.
```

**Current gap (P0)**: No durable journal exists. `InMemoryEventJournal` loses all data on restart.

**Implementation**: `FileEventJournal` implementing `EventJournalPort` — append-only JSON Lines to a single file. Each line is one `KernelEventEnvelope` serialized as JSON. No rotation needed for MVP. Journal is the sole authoritative record.

### 3.3 Original event identity preserved (PASSES)

KernelEventEnvelope already has `kernelEventId`, `kernelLogicalSequence`, `kernelTimestamp`. `InMemoryEventJournal` enforces contiguous sequence and deep-clones. The durability layer must preserve these fields exactly — no new identity fields needed.

### 3.4 Replay routes events to applicable projectors only

**Contract**:

```
Replay must not broadcast every event to every store.

Each event type has an authoritative set of projectors:

  market.ticker.updated        → KernelMarketStateStore
  execution.fill.confirmed     → KernelPositionStateStore, OmsOrderStore
  position.baseline.confirmed  → KernelPositionStateStore
  policy.snapshot.published    → KernelPolicyStore
  order.created                → OmsOrderStore
  order.submitted              → OmsOrderStore
  order.rejected               → OmsOrderStore
  order.submission.unknown     → OmsOrderStore
  position.plan.created        → PositionPlanStore
  position.plan.closed         → PositionPlanStore
  position.plan.updated        → PositionPlanStore
  position.plan.archived       → PositionPlanStore

Replay calls store.apply(envelope) only on the target projectors for that event type.
```

**Current gap (P0)**: No replay mechanism exists. Need `ReplayCoordinator` that reads journal events and routes them by type → projector.

**Implementation**: `ReplayCoordinator.replay(journal, projectors)` where `projectors` is a `Map<TradingEventType, KernelStore[]>` mapping each event type to its authoritative stores.

### 3.5 Replay must never execute

**Contract**:

```
During replay:
  ✗ No execution adapter invocation
  ✗ No new orders submitted
  ✗ No synthetic fills created
  ✗ No new trading intents created
  ✗ No protective execution triggered

Replay calls store.apply() directly — never through kernel.publish().
```

**Current gap (P0)**: No replay guard exists. OmsCore subscribes its store to kernel events — if replay published through kernel, the adapter would fire.

**Implementation**: `ReplayCoordinator` calls `store.apply(envelope)` directly. No kernel.publish path.

### 3.6 Startup ordering is frozen

**Contract**:

```
One frozen startup sequence — no caller may deviate:

  1. Open durable journal
  2. Replay all events → all applicable projectors
  3. Verify reconstructed state (digest comparison)
  4. RECOVERY_VERIFIED gate
  5. Production market data start
  6. Fresh market snapshots override replay-era market state
  7. LIVE_READY → entries and protection enabled

No caller may activate LIVE_READY before step 4.
No caller may inject market data before step 5.
No caller may submit entries before step 7.
```

**Current gap (P0)**: `RuntimeMode` only blocks protection, not entries. No `RECOVERY_VERIFIED` gate. No frozen ordering at spine level.

**Implementation**: `RecoveryManager` owns steps 1–4. `ProductionSpine.start(options)` owns steps 5–7, gated by a `recoveryVerified: boolean` flag at the spine level.

### 3.7 Verified recovery (PASSES — modified)

**Contract**:

```
After replay, store digests may be compared against a pre-shutdown digest
if one was saved. This is verification, not recovery.

On digest mismatch → RECOVERY_VERIFIED is NOT granted.

A missing pre-shutdown digest (crash without graceful shutdown)
does NOT block RECOVERY_VERIFIED. The journal alone is authoritative.

Store digest is a content-hash of all internal state records,
not a snapshot import path.
```

**Current gap (P0)**: No verification mechanism. Stores have no digest export.

**Implementation**: Each store exposes `digest(): string` (deterministic hash of internal state). `RecoveryManager` computes post-replay digest. If a pre-shutdown `recovery-digest.json` exists, compares. Mismatch → fail. Missing file → pass (journal is authoritative).

### 3.8 submission_unknown preserved (PASSES)

OMS state machine: `SUBMITTED → SUBMISSION_UNKNOWN` is permitted. Terminal status. PositionManagerRuntime explicitly leaves submitted state for submission_unknown — no auto-retry. Durability layer must preserve SUBMISSION_UNKNOWN status across restart.

### 3.9 Corrupt history fail-closed

**Contract**:

```
Any of these conditions → RECOVERY_VERIFIED is NOT granted:

  ✗ Duplicate kernelEventId in journal
  ✗ Non-contiguous kernelLogicalSequence
  ✗ Malformed JSON line
  ✗ Missing required fields on envelope
  ✗ Event type validation failure

FileEventJournal validates on read; ReplayCoordinator validates on apply.
```

**Current gap (P0)**: InMemoryEventJournal validates on append and read. FileEventJournal must add: line-level JSON parse validation, field presence checks, sequence continuity on read-all path.

### 3.10 Policy path — real consumption, no fabrication

**Contract**:

```
ProductionSpine must:

  1. Accept validated policy.snapshot.published kernel events
  2. Project them into KernelPolicyStore via apply()
  3. In executeThroughGateway, consume policyStore.resolve(exchange, symbol)
     for the gatewayInput.policyResolution field

The fabricated { status: 'active', allowNewEntries: true, ... } is removed.
```

**Current gap (P0)**: `executeThroughGateway()` fabricates policy. `KernelPolicyStore` exists but is never wired into ProductionSpine or the gateway path.

**Implementation**: `KernelPolicyStore` is added to `ProductionSpine` and subscribed to kernel. `executeThroughGateway` passes `spine.policyStore.resolve(exchange, symbol)` into `gatewayInput.policyResolution`.

### 3.11 One authoritative spine (PASSES)

ProductionSpine creates one shared kernel, one OMS, one set of state stores. No disconnected universe.

---

## 4. P0 CONTRADICTIONS (EXISTING CODE EVIDENCE)

### 4.1 P0 — No durable journal (Invariants 3.1, 3.2)

**Evidence**: `src/kernel/InMemoryEventJournal.ts` — only implementation.

**Resolution**: `FileEventJournal` — append-only JSON Lines, single file, no rotation.

### 4.2 P0 — No replay routing (Invariants 3.4, 3.5)

**Evidence**: No `ReplayCoordinator` exists.

**Resolution**: `ReplayCoordinator` with type→projector routing map. Direct `store.apply()` calls.

### 4.3 P0 — No frozen startup ordering (Invariant 3.6)

**Evidence**: No `RecoveryManager`. `RuntimeMode` is position-only. No spine-level gate.

**Resolution**: `RecoveryManager` owns steps 1–4. `ProductionSpine.start()` owns steps 5–7, gated by `recoveryVerified`.

### 4.4 P0 — Fabricated policy (Invariant 3.10)

**Evidence**: `src/position/ProductionSpine.ts` fabricates `{ status: 'active', allowNewEntries: true, ... }`.

**Resolution**: Wire `KernelPolicyStore` into ProductionSpine and `executeThroughGateway`.

### 4.5 P0 — No recovery verification (Invariant 3.7)

**Evidence**: No digest mechanism on stores. No recovery-digest.json.

**Resolution**: `digest(): string` on each store. `RecoveryManager` compares post-replay digest against optional pre-shutdown digest.

---

## 5. IMPLEMENTATION BOUNDARY

### 5.1 New files

```
src/recovery/
├── FileEventJournal.ts         # append-only JSON Lines to single file
├── ReplayCoordinator.ts        # type→projector routing, adapter-free
├── RecoveryManager.ts          # open → replay → verify → RECOVERY_VERIFIED
└── recovery-contracts.ts       # types: RecoveryMode, RecoveryReport, etc.
```

### 5.2 Files expected to change

```
src/position/ProductionSpine.ts         # +KernelPolicyStore, +FileEventJournal, +RecoveryManager
src/kernel/TradingKernel.ts             # +initialSequence config, resume from journal+N
src/kernel/KernelPositionStateStore.ts  # +digest() only
src/kernel/KernelMarketStateStore.ts    # +digest() only  
src/kernel/KernelPolicyStore.ts         # +digest() only
src/oms/OmsOrderStore.ts               # +digest() only
src/position/PositionPlanStore.ts       # +digest() only
tests/recovery/production-recovery.test.ts
```

### 5.3 No changes to

```
src/risk/PreTradeRiskGateway.ts         # unchanged
src/oms/OmsCore.ts                      # unchanged
src/paper/PaperExecutionService.ts      # unchanged
src/position/PositionManagerRuntime.ts  # unchanged (mode blocking works)
src/position/PositionManager.ts         # unchanged
```

---

## 6. CONTRACT SIGNATURES

### 6.1 FileEventJournal

```typescript
interface FileEventJournal extends EventJournalPort {
  readonly filePath: string;
  readonly lastSequence: number;     // terminal sequence, 0 if empty
  readonly eventCount: number;
  close(): void;
}
```

### 6.2 ReplayCoordinator

```typescript
type ProjectorMap = Map<TradingEventType, KernelStore[]>;

interface ReplayCoordinator {
  replay(journal: EventJournalPort, projectors: ProjectorMap): ReplayReport;
}

interface ReplayReport {
  eventsReplayed: number;
  lastSequence: number;
  errors: ReplayError[];
}
```

### 6.3 RecoveryManager

```typescript
type RecoveryMode = 'verified' | 'failed' | 'no_history';

interface RecoveryManager {
  recover(journal: EventJournalPort, projectors: ProjectorMap): RecoveryResult;
}

interface RecoveryResult {
  mode: RecoveryMode;
  digestVerified: boolean;
  preShutdownDigestAvailable: boolean;
}
```

### 6.4 ProductionSpine.start()

```typescript
interface ProductionSpine {
  // ... existing members
  start(options: {
    recoveryVerified: boolean;      // must be true — set by RecoveryManager
    exchange: string;
  }): Promise<void>;               // throws if !recoveryVerified
  readonly recoveryVerified: boolean;
}
```

### 6.5 Store digest contract

```typescript
interface KernelStore {
  apply(envelope: KernelEventEnvelope): unknown;
  digest(): string;                // deterministic hash of all internal state records
}
```

### 6.6 Policy path contract

```typescript
interface ProductionSpineConfig {
  // ... existing
  policyStore?: KernelPolicyStore;  // if provided, must be subscribed to kernel
}

interface ProductionSpine {
  // ... existing
  policyStore: KernelPolicyStore;
}

// In executeThroughGateway:
gatewayInput.policyResolution = spine.policyStore.resolve(
  intent.exchange, intent.symbol,
);
```

---

## 7. TEST CONTRACT

```text
tests/recovery/production-recovery.test.ts

[REC-01] File journal survives restart — exact event identity, sequence, ordering
[REC-02] ReplayCoordinator routes events to applicable projectors only
[REC-03] ReplayCoordinator does not call any adapter
[REC-04] RecoveryManager blocks LIVE_READY before verification
[REC-05] Kernel sequence resumes at journal.terminalSequence + 1 after recovery
[REC-06] Corrupt journal → fail-closed (no RECOVERY_VERIFIED)
[REC-07] Missing pre-shutdown digest → RECOVERY_VERIFIED granted (journal authoritative)
[REC-08] Digest mismatch → RECOVERY_VERIFIED denied
[REC-09] Policy resolves from KernelPolicyStore, not fabricated allow-all
[REC-10] submission_unknown preserved across restart (no auto-retry)
[REC-11] Phase 4C protective stop → Gateway → OMS path unchanged
[REC-12] Phase 1–4 regression suite passes
```

---

## 8. NON-CONTRADICTIONS

- TradingKernel synchronous subscriber semantics: Replay calls apply() directly — no publish, no dispatch
- RuntimeMode 'replay' / 'live': Respected — protection blocked during recovery
- submission_unknown no-auto-retry: Unchanged — terminal status preserved
- Missing ≠ flat: Unchanged — trustBaseline still required
- Gateway approved sizing: Unchanged — dynamicPriceOms wrapper preserved
- One shared kernel / OMS / state stores: Unchanged — same ProductionSpine
- InMemoryEventJournal capacity: Not a Phase 5A blocker — addressed by FileEventJournal at implementation time

---

## 9. STATUS

```text
PRE_HEAD = cbe832da691092b86f374fa57092ce5f1a6ef7f5

KERNEL_SEQUENCE_RESUME = journal.lastSequence+1 → first new event; never reset to 1 after recovery
RECOVERY_AUTHORITY = durable journal is sole factual authority; no snapshot import as second authority
SNAPSHOT_IMPORT = NOT required for recovery; digest-only verification; missing pre-shutdown digest OK
REPLAY_ROUTING = type→projector map; events route only to applicable stores
STARTUP_OWNER = RecoveryManager → replay+verify → ProductionSpine.start → market → LIVE_READY
LIVE_READY_ORDER = frozen: cannot activate before RECOVERY_VERIFIED
POLICY_PUBLICATION = policy.snapshot.published → KernelPolicyStore.apply
POLICY_GATEWAY_PATH = policyStore.resolve(exchange, symbol) → Gateway; no fabricated allow-all

P0_CONTRACT_ISSUES_REMAINING = 0
P1_CONTRACT_ISSUES_REMAINING = 0

STATUS = CONTRACT_REPAIRED_AWAITING_REVIEW
```
