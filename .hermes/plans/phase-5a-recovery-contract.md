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
initialSequence = last committed Kernel logical sequence

Cold start (empty journal):
  journal.lastSequence = 0
  TradingKernel initialSequence = 0
  first new event = 1

Recovery (non-empty journal):
  journal.lastSequence = N
  TradingKernel initialSequence = N
  first new event = N+1

kernelLogicalSequence is never reset.
Sequence 1 after recovery means genuine cold start (no history survived).
Sequence 1 after a non-empty journal → journal corruption; fail closed.
```

**Current gap (P0)**: `InMemoryEventJournal` is volatile. On restart, sequence starts at 1 regardless of prior history. Need `FileEventJournal` that persists `lastSequence` and feeds it to TradingKernel initialisation.

**Implementation**: `FileEventJournal` exposes `readonly lastSequence: number` (0 if empty). `TradingKernel` accepts `initialSequence: number` in config. Cold: 0. Recovery: pass `journal.lastSequence`.

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

### 3.6 Startup ordering is frozen — RECOVERY_VERIFIED is internal

**Contract**:

```
One frozen startup sequence — no caller may deviate:

  1. Open durable journal
  2. Replay all events → all applicable projectors
  3. Verify reconstructed state (digest / checkpoint comparison)
  4. RECOVERY_VERIFIED — set internally by RecoveryManager
  5. Production market data start
  6. Fresh market snapshots override replay-era market state
  7. LIVE_READY → entries and protection enabled

RECOVERY_VERIFIED is granted only by the recovery/bootstrap owner (RecoveryManager).
It is NOT a caller-supplied flag or forgeable boolean.
No external caller may set or claim RECOVERY_VERIFIED.

No caller may activate LIVE_READY before step 4.
No caller may inject market data before step 5.
No caller may submit entries before step 7.
```

**Current gap (P0)**: `RuntimeMode` only blocks protection, not entries. No `RECOVERY_VERIFIED` gate. No frozen ordering at spine level.

**Implementation**: `RecoveryManager` owns steps 1–4 and sets an internal `recoveryVerified` flag on `ProductionSpine` (read-only to callers). `ProductionSpine.start(options)` owns steps 5–7 and throws if `recoveryVerified` is not internally set. No caller-supplied `recoveryVerified` parameter exists.

### 3.7 Recovery checkpoint anchored to journal sequence

**Contract**:

```
An optional store digest/checkpoint must be anchored to the durable journal
terminal sequence.

  checkpoint.sequence === journal.lastSequence
    → digest comparison is valid
    → on match: RECOVERY_VERIFIED
    → on mismatch: RECOVERY_VERIFIED denied

  checkpoint.sequence < journal.lastSequence
    → stale checkpoint (graceful shutdown from earlier point)
    → journal remains authoritative — RECOVERY_VERIFIED still granted

  checkpoint.sequence > journal.lastSequence
    → inconsistent / corrupt — fail closed; no RECOVERY_VERIFIED

Crash recovery without any checkpoint:
  → RECOVERY_VERIFIED granted from journal alone

A stale checkpoint must NOT fail recovery.
```

**Current gap (P0)**: No checkpoint mechanism. Stores have no digest export.

**Implementation**: Each store exposes `digest(): string` (deterministic hash of internal state). `RecoveryManager` saves `recovery-digest.json` with `sequence: journal.lastSequence` on graceful shutdown. On restart, compares checkpoint.sequence vs journal.lastSequence; only compares digests when sequences match exactly.

### 3.8 submission_unknown preserved (PASSES)

OMS state machine: `SUBMITTED → SUBMISSION_UNKNOWN` is permitted. Terminal status. PositionManagerRuntime explicitly leaves submitted state for submission_unknown — no auto-retry. Durability layer must preserve SUBMISSION_UNKNOWN status across restart.

### 3.9 Journal record integrity and corrupt history fail-closed

**Contract**:

```
Each journal record carries a deterministic integrity checksum/digest
computed over the serialised envelope content (excluding the checksum field).

On read:
  ✗ Checksum mismatch → corrupt record → fail closed
  ✗ Missing checksum field → malformed record → fail closed

Additionally:
  ✗ Duplicate kernelEventId in journal
  ✗ Non-contiguous kernelLogicalSequence
  ✗ Malformed JSON line (unparseable)
  ✗ Missing required fields on envelope (kernelEventId, kernelLogicalSequence,
    kernelTimestamp, type, payload)
  ✗ Event type not in known TradingEventType set

Any of these → RECOVERY_VERIFIED is NOT granted.

Checksum algorithm must be deterministic and fast (SHA-256 of canonical JSON).
```

### 3.10 Policy path — real consumption with max lifetime, no fabrication

**Contract**:

```
ProductionSpine must:

  1. Accept a valid policyMaxLifetimeMs configuration
  2. Accept validated policy.snapshot.published kernel events
  3. Project them into KernelPolicyStore via apply()
  4. In executeThroughGateway, consume policyStore.resolve(exchange, symbol)
     for the gatewayInput.policyResolution field

The fabricated { status: 'active', allowNewEntries: true, ... } is removed.

policyMaxLifetimeMs gates: if the resolved policy snapshot exceeds
policyMaxLifetimeMs in age (current time - snapshot.generatedAt), the
policy is treated as stale → Gateway receives a stale/expired resolution.
```

**Current gap (P0)**: `executeThroughGateway()` fabricates policy. `KernelPolicyStore` exists but is never wired into ProductionSpine or the gateway path. No `policyMaxLifetimeMs` configuration.

**Implementation**: `KernelPolicyStore` is added to `ProductionSpine` and subscribed to kernel. `policyMaxLifetimeMs` is a `ProductionSpineConfig` field (default: 3600_000 = 1 hour). `executeThroughGateway` passes `spine.policyStore.resolve(exchange, symbol)` into `gatewayInput.policyResolution`. Stale resolution is a `PolicyStatus.STALE` gate in the Gateway.

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

// Each journal line: { checksum: string, envelope: KernelEventEnvelope }
// checksum = SHA-256(canonicalJSON(envelope))
// On read: verify checksum; mismatch → corrupt → throw
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
  recover(journal: EventJournalPort, checkpointPath?: string): RecoveryResult;
}

interface RecoveryResult {
  mode: RecoveryMode;
  checkpointComparison: 'match' | 'mismatch' | 'stale' | 'missing' | 'inconsistent';
}
```

### 6.4 ProductionSpine — no caller-supplied recoveryVerified

```typescript
interface ProductionSpine {
  // ... existing members
  readonly recoveryVerified: boolean;   // set internally by RecoveryManager; read-only

  start(options: {
    exchange: string;
  }): Promise<void>;                    // throws if !recoveryVerified
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
  policyStore?: KernelPolicyStore;
  policyMaxLifetimeMs?: number;    // default 3_600_000 (1 hour)
}

interface ProductionSpine {
  // ... existing
  policyStore: KernelPolicyStore;
}

// In executeThroughGateway:
gatewayInput.policyResolution = spine.policyStore.resolve(
  intent.exchange, intent.symbol, spine.config.policyMaxLifetimeMs,
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

```
PRE_HEAD = a7df9fbf302ee168f35e54f62fa58ce53ff83de1

SEQUENCE_SEMANTICS = initialSequence = last committed sequence; cold:0→1, recovery:N→N+1
RECOVERY_VERIFICATION_AUTHORITY = RecoveryManager internal; no caller-supplied forgeable flag
LIVE_READY_AUTHORITY = RecoveryManager grants RECOVERY_VERIFIED internally; ProductionSpine.start throws if not set
CHECKPOINT_SEQUENCE_ANCHOR = checkpoint.sequence == journal.lastSequence → valid comparison
STALE_CHECKPOINT_BEHAVIOR = checkpoint.sequence < journal.lastSequence → journal authoritative, RECOVERY_VERIFIED still granted
JOURNAL_RECORD_INTEGRITY = SHA-256 checksum per journal line; mismatch → corrupt → fail closed
POLICY_MAX_LIFETIME = ProductionSpineConfig.policyMaxLifetimeMs (default 1 hour)
POLICY_GATEWAY_PATH = policy.snapshot.published → KernelPolicyStore → policyStore.resolve → Gateway

P0_CONTRACT_ISSUES_REMAINING = 0
P1_CONTRACT_ISSUES_REMAINING = 0

STATUS = CONTRACT_READY_FOR_IMPLEMENTATION
```
