# DSbot Research Governance Architecture Baseline

> Status: DESIGN / GUIDANCE BASELINE  
> Recorded: 2026-08-23  
> Applies to: future Research Data Plane / Backtest / AI Research / Experiment Governance work  
> Does not authorize: Production trading, Testnet/Live activation, Phase 8 runtime changes, or strategy promotion.

## 1. Purpose

This document records the agreed research-governance direction for DSbot after reviewing the current repository and two mature open-source references:

- `shy3130/tick-stock-panel` — research/data/backtest workflow reference.
- `Fincept-Corporation/FinceptTerminal` — financial terminal, DataHub, bounded-context and AI-tooling architecture reference.

The target research chain is:

```text
Trusted Data
  -> Canonical Data Contract
  -> Fixed / Versioned ResearchBacktestKernel
  -> AI Research Sandbox
  -> Pre-Registered Experiment Protocol
  -> TRAIN / VALIDATION
  -> Candidate Freeze
  -> LOCKED TEST
  -> Forward Paper
  -> Promotion Gate
  -> Human Authorization
  -> existing DSbot Trading Safety Boundary
```

The research system must improve scientific validity without weakening DSbot's existing production invariants:

- ONE RUNTIME
- ONE TRUTH
- READ-ONLY PRESENTATION
- FAIL-CLOSED
- NO AUTHORITY BYPASS
- Research data is never automatically trading truth.
- A successful backtest never authorizes production.

---

## 2. Current Repository Baseline

DSbot already has useful pieces, but does **not yet** have the complete governed research structure described in this document.

Current partial assets include:

- `src/trading/backtest.ts`
- bundled backtest skill/docs
- Python quant engine and indicator modules
- precision tests / proof assets
- Hermes / multi-agent / Slow Plane foundations
- Research Workbench surfaces
- external feed adapters

Current gaps:

| Capability | Current baseline |
|---|---|
| Central Data Dictionary | MISSING |
| Dataset lifecycle / eligibility states | MISSING |
| Point-in-time contract across all research data | PARTIAL / NOT CENTRALIZED |
| Fixed authoritative ResearchBacktestKernel | MISSING |
| AI write boundary vs read-only kernel | MISSING |
| Pre-registered immutable experiment protocol | MISSING |
| TRAIN / VALIDATION / LOCKED TEST governance | MISSING |
| Locked-test consumption semantics | MISSING |
| Validation exposure accounting | MISSING |
| Candidate registry + evidence promotion gate | MISSING |
| Research capability ACL | MISSING |
| Persistent governed research job model | PARTIAL / NOT UNIFIED |

### 2.1 Existing backtest must not be frozen as authoritative yet

`src/trading/backtest.ts` is useful legacy infrastructure, but is **NON-AUTHORITATIVE for the future research kernel until audited/rebuilt**.

Known design risks include:

1. Historical valuation can use the last bar in the full data slice when computing position value, creating lookahead/future leakage risk.
2. A signal can be evaluated from the current point/bar and executed at the same point price without an explicit information-availability/execution-timing contract.
3. Existing documentation describes stronger walk-forward/OOS behavior than the concrete engine API currently guarantees.

Therefore future Phase 10 must not simply mark the existing file read-only. A validated `ResearchBacktestKernel` must first be established.

---

## 3. Target Layer A — Research Data Foundation

### 3.1 Provider -> Mapping -> Canonical Contract

Adopt the useful pattern from tick-stock-panel:

```text
External API / File / Feed
  -> Provider Adapter
  -> field_map / transforms
  -> internal canonical fields
  -> shared storage / research consumers
```

DSbot must extend that pattern with explicit semantic metadata.

Every dataset must have a versioned manifest such as:

```yaml
dataset_id: cn_equity_daily_v1
version: 1.0.0
market: CN_A
frequency: 1d
provider: TickFlow
timezone: Asia/Shanghai
calendar: SSE_SZSE
point_in_time_safe: true
status: BACKTEST_ELIGIBLE
```

Every field must be explainable and machine-readable, not just named.

Minimum field metadata:

```yaml
field: close
dtype: float64
unit: CNY
meaning: official daily close
source_field: close
price_basis: RAW
event_time_definition: exchange session close
available_time_definition: after official publication
timezone: Asia/Shanghai
nullable: false
point_in_time_safe: true
allowed_use:
  - factor_calculation
  - valuation
  - historical_backtest
forbidden_use:
  - same_bar_preclose_execution
deprecated: false
```

### 3.2 Required time dimensions

Research data must distinguish at least:

- `event_time`
- `available_at`
- `ingested_at`
- `revision_id` / equivalent revision lineage where applicable

Core anti-future rule:

```text
available_at <= decision_time
```

If false, the datum must be invisible to that historical decision.

This applies to more than OHLC:

- financial statements
- macro releases
- news
- analyst data
- index membership
- sector classification
- corporate actions
- revised economic data

### 3.3 Dataset lifecycle / eligibility

Datasets should move through explicit states:

```text
RAW
  -> NORMALIZED
  -> CANONICAL_RESEARCH
  -> BACKTEST_ELIGIBLE
  -> PRODUCTION_ELIGIBLE (only where separately authorized)
```

Exceptional states:

```text
DEPRECATED
QUARANTINED
INVALID
```

Important semantic rules:

- RAW is not automatically backtest-safe.
- NORMALIZED is not automatically point-in-time safe.
- Missing != zero.
- Stale != fresh.
- Research-eligible != trading-authoritative.

### 3.4 Storage / analytical stack

Preferred Research Plane pattern, inspired by tick-stock-panel:

```text
Parquet -> durable analytical history
DuckDB  -> ad-hoc / cross-dataset analytical query
Polars  -> vectorized factor and cross-sectional computation
```

Suggested separation:

```text
research_data/
  raw/
  canonical/
  features/
  artifacts/
```

This storage never replaces DSbot's authoritative `MarketDataRuntime`, `MarketStateStore`, OMS, accounting or reconciliation truth.

---

## 4. Target Layer B — ResearchDataHub

Adopt the architectural idea from FinceptTerminal's DataHub, but keep a stronger DSbot safety boundary.

```text
Providers
  -> Normalizer
  -> Canonical Dataset
  -> ResearchDataHub
       -> Factor Engine
       -> Screener
       -> Backtest
       -> AI Research
       -> Terminal observation
```

### 4.1 One fetch, many subscribers

The same canonical research datum should not be independently fetched/reinterpreted by every module.

### 4.2 DatasetUsagePolicy

Extend the `TopicPolicy` idea into a machine-enforced research policy:

```yaml
dataset: cn_equity_daily_v1
freshness:
  research: 24h
  terminal: 24h
  trading: prohibited
allowed_consumers:
  - screener
  - factor_engine
  - backtest
  - ai_research
forbidden_consumers:
  - trading_kernel
  - live_ready_gate
stale_behavior:
  research: WARN
  backtest: FAIL
```

### 4.3 Hard boundary

```text
ResearchDataHub != MarketDataRuntime
```

ResearchDataHub data may not directly grant or establish:

- TradingKernel market freshness
- LIVE_READY
- reconciliation truth
- position valuation authority
- OMS state
- execution authorization

---

## 5. Target Layer C — Fixed / Versioned ResearchBacktestKernel

AI may research strategies and factors, but may not redefine market reality to improve results.

The authoritative research kernel must own at least:

### Universe Engine

- universe construction
- historical constituent membership
- listing age
- delisting
- ST/special-treatment rules where applicable
- survivorship-bias prevention

### Market Mechanics

- trading calendar
- suspension handling
- limit-up / limit-down rules
- T+1 / venue settlement mechanics where applicable
- lot size

### Price / Corporate Action Engine

- raw vs adjusted prices
- adjustment method
- corporate actions
- split/dividend treatment

### Execution Model

- signal timestamp
- information cutoff
- order timestamp
- fill price
- next-open / VWAP / other explicit model
- partial fill where modeled
- volume/liquidity constraint

### Cost Engine

- commission
- taxes / stamp duty
- transfer fees
- spread
- slippage
- market impact where modeled

### Portfolio Engine

- rebalance schedule
- holding-period definition
- cash handling
- position sizing
- exposure limits used for research comparability

### Metrics Engine

At minimum, versioned implementations for:

- total / annualized return
- CAGR
- Sharpe
- Sortino
- Calmar
- max drawdown
- turnover
- win rate
- profit factor
- benchmark-relative metrics where applicable
- IC / Rank IC / IR for factor research

### 5.1 AI write restriction

AI may modify:

- hypothesis
- factor logic
- factor combinations
- feature transformations
- signal logic
- research parameters permitted by protocol
- research-only strategy candidates
- research tests for its own module

AI may not modify during ordinary research:

- universe rules
- adjustment rules
- suspension rules
- price-limit rules
- trading calendar
- transaction-cost model
- slippage model
- execution-price semantics
- signal/order timing semantics
- rebalance semantics
- holding-period definition
- performance-metric implementations
- PIT/access-timing rules
- train/validation/test boundaries
- locked-test rules

### 5.2 Read-only means governance, not only filesystem flags

Once validated, a kernel release must be protected by:

- version
- content/hash identity
- protected paths / CODEOWNERS or equivalent review boundary
- CI rejection for unauthorized research-agent modifications
- immutable experiment reference to kernel version/hash

Human maintainers may release a new kernel version when reality/modeling assumptions require correction. That creates a new experiment regime; results across materially different kernel versions must not be silently compared as one continuous series.

---

## 6. Target Layer D — AI Research Sandbox

AI research work belongs in an explicit write-scoped area.

Suggested logical structure:

```text
research_sandbox/
  hypotheses/
  factors/
  transforms/
  strategies/
  parameters/
  experiments/
  tests/
  risk_audits/
  notebooks/
  reports/
  artifacts/
```

Protected research infrastructure should remain outside the sandbox:

```text
research_core/
  data_contract/
  backtest_kernel/
  experiment_protocol_engine/
  locked_test_gate/
  anti_leakage/
  audit_rules/
  tests/
```

### 6.1 Two test layers

AI-writable tests may validate its own factor/strategy modules.

AI must not control the authoritative tests for:

- future leakage
- T+1
- suspension
- limit-up / limit-down
- adjustment
- fees
- slippage
- point-in-time visibility
- locked-test access
- protocol immutability

### 6.2 Capability ACL instead of broad filesystem authority

Adopt the useful Fincept MCP/tool-registry idea, but apply DSbot's stronger safety discipline.

Preferred AI surface:

```text
factor.read
factor.create
factor.modify
hypothesis.create
experiment.register
experiment.run
result.read
candidate.propose
```

Forbidden capabilities:

```text
kernel.write
protocol.modify_after_freeze
locked_test.raw_read
data_dictionary.write
production.write
oms.submit
live_ready.grant
```

AI capability must be enforced by code/tool permissions, not only prompt wording.

### 6.3 Worker and secret isolation

Research workers should have:

- bounded concurrency
- CPU / memory / wall-time budgets
- experiment/trial budget
- cancellable durable jobs
- research-only credentials

They must not automatically receive live exchange/order credentials.

---

## 7. Target Layer E — Pre-Registered Experiment Protocol

The rules of an experiment must be frozen **before** viewing its governed results.

Required flow:

```text
Hypothesis
  -> Experiment Protocol
  -> FREEZE
  -> Protocol Hash
  -> Run
  -> Evidence
  -> PASS / FAIL / INVALID
```

A protocol should record at least:

```yaml
experiment_id: EXP-000001
hypothesis: ...
factor_version: ...
kernel_version: ...
kernel_hash: ...
dataset_version: ...
train_window: ...
validation_window: ...
locked_test_id: ...
mutable_variables: [...]
max_variables_changed_per_experiment: 2
max_trials: 20
primary_metric: ...
secondary_metrics: [...]
pass_rule: ...
failure_rule: ...
stop_rule: ...
cost_model: FROM_KERNEL
random_seed: ...
```

### 7.1 Variable-change discipline

Default target:

- ordinary experiment: max 2 changed variables
- ablation: max 1 changed variable
- architecture-level strategy redesign: new experiment family required

### 7.2 Stop rules

Examples that must be declared before optimization:

- max trials
- no meaningful primary-metric improvement for N trials
- validation exposure limit
- minimum effect-size requirement

Do not optimize indefinitely until a visually attractive result appears.

---

## 8. TRAIN / VALIDATION / LOCKED TEST / FORWARD PAPER

### TRAIN

May be used for exploration, fitting, factor direction, parameter tuning and model development.

### VALIDATION

May be inspected, but every inspection leaks information into researcher behavior. Track:

```text
validation_exposure_count
```

Validation must not become an unlimited tuning oracle.

### LOCKED TEST

Must be inaccessible to AI/research code before candidate freeze.

Preferred properties:

- opaque dataset/test ID
- no raw read access
- no hidden-period disclosure where practical
- one governed evaluation after candidate code/parameters/kernel/data/protocol hashes are frozen

After use:

```text
LOCKED_TEST_01 -> CONSUMED
```

It must no longer be described as untouched blind data for later optimization.

### FORWARD PAPER

A historically successful candidate must still survive future-arriving data in Paper mode before promotion consideration.

---

## 9. Statistical Validation Pattern from tick-stock-panel

The following patterns are approved as strong references for future DSbot implementation:

- nested walk-forward validation
- inner training / candidate selection separated from outer OOS evaluation
- purge between train/test
- embargo
- factor correlation pruning
- benchmark/control-track evaluation
- explicit missing/skipped reasons instead of fake zero metrics
- point-in-time financial availability
- T-1 environment usage rather than same-day unavailable state

DSbot should extend this with:

- true `LOCKED_TEST`
- validation exposure accounting
- locked-test consumption semantics
- immutable experiment protocol
- kernel/data/protocol hashes

---

## 10. Candidate Registry and Promotion

Adopt the useful research-candidate separation from tick-stock-panel.

Suggested state model:

```text
DRAFT
  -> TRAIN_PASSED
  -> VALIDATION_PASSED
  -> FROZEN
  -> LOCKED_TEST_PASSED
  -> FORWARD_PAPER
  -> PROMOTION_ELIGIBLE
  -> APPROVED
```

Failure / invalidation states may include:

```text
REJECTED
EXPIRED
CONTAMINATED
INVALIDATED
```

Critical rule:

```text
PROMOTION_ELIGIBLE != PRODUCTION_ACTIVE
```

Research automation may generate/save pending candidates. It must not autonomously activate a strategy in production.

Published/promoted candidates must derive from server-side registered evidence/artifacts, not client-supplied replacement weights/formulas at publish time.

---

## 11. Benchmark / Control Track

Every material candidate should be evaluated against fixed controls, not only absolute performance.

Examples:

```text
Candidate strategy
vs
same strategy without AI policy
vs
simple market / equal-weight benchmark
```

AI value must be measured as incremental OOS improvement, not merely a positive standalone Sharpe/return.

---

## 12. Persistent Research Jobs

Long-running research should not be coupled to browser/request lifetime.

Preferred model:

```text
Experiment Protocol
  -> durable ResearchRun ID
  -> worker
  -> event stream
  -> artifacts
  -> resumable/reconnectable status
  -> audit record
```

Useful ideas adopted from tick-stock-panel:

- durable run IDs
- persistent artifacts
- reconnect after refresh
- explicit cancellation states
- bounded heavy-job capacity
- automatic research may create pending candidates only

---

## 13. Bounded Contexts / Terminal Architecture from FinceptTerminal

DSbot should retain a modular-monolith style with explicit dependency direction instead of scattering research logic across unrelated historical folders.

Long-term contexts may include:

```text
trading/
risk/
accounting/
data/
research/
ai/
operations/
workbench/
```

Within research:

```text
research/
  core/
  sandbox/
  factors/
  backtest/
  experiments/
  candidates/
  audit/
```

Cross-context sharing should use typed contracts/events/read models instead of direct hidden coupling.

Fincept ideas are architectural references only. DSbot should not be rewritten to C++/Qt and should not copy AGPL implementation code/trade dress.

---

## 14. Target Combined Architecture

```text
EXTERNAL DATA
  -> Provider Adapters
  -> Field Mapping / Provider Manifest
  -> Data Dictionary + PIT + Lineage + Eligibility
  -> Canonical Research Dataset
       [Parquet / DuckDB / Polars]
  -> ResearchDataHub + DatasetUsagePolicy
       -> Screener
       -> Factor Engine
       -> AI Research Sandbox
       -> Terminal observation
  -> Pre-Registered Experiment Protocol
  -> READ-ONLY ResearchBacktestKernel
  -> Nested Walk-Forward + Purge / Embargo
  -> TRAIN / VALIDATION
  -> Candidate Registry
  -> Candidate Freeze
  -> LOCKED TEST
  -> Forward Paper
  -> Promotion Gate
  -> Human Authorization
--------------------------------------------------
            DSbot TRADING SAFETY BOUNDARY
--------------------------------------------------
  -> TradingKernel
  -> PreTradeRiskGateway
  -> OMS
  -> Execution
  -> Position / Protection
  -> Recovery / Reconciliation / Accounting
```

---

## 15. Phase 9 / Phase 10 Reference Roadmap

This document is a planning baseline, not automatic implementation authorization.

### Phase 9 — Research Data Foundation

```text
9A Provider Manifest & Adapter Contract
9B Data Dictionary & Field Contract
9C Canonical Point-in-Time Dataset
9D Parquet / DuckDB / Polars storage path
9E ResearchDataHub + DatasetUsagePolicy
9F Data Lineage / Version / Deprecation
```

Phase 9 acceptance direction:

- every backtest-eligible dataset is versioned and explainable
- every required field has an explicit semantic contract
- provider-specific names do not leak into research modules
- PIT visibility is enforceable
- deprecated/quarantined data cannot silently enter governed backtests
- ResearchDataHub cannot become trading authority

### Phase 10 — Research & Backtest Governance

```text
10A Authoritative ResearchBacktestKernel
10B Market Mechanics + Anti-Future-Leakage
10C AI Research Sandbox
10D Research Tool Gateway / Capability ACL
10E Pre-Registered Experiment Protocol
10F TRAIN / VALIDATION / LOCKED TEST
10G Nested Walk-Forward + Purge / Embargo
10H Candidate Registry
10I Promotion Gate
10J Forward Paper Validation
```

Phase 10 acceptance direction:

- AI cannot modify authoritative kernel paths through normal research tools
- current/legacy backtest is not treated as authoritative until validated
- future information cannot be observed before `available_at`
- same-bar execution semantics are explicit and testable
- experiment rules are immutable after freeze
- locked test cannot be read/tuned against by AI
- validation exposure is tracked
- candidate promotion is evidence-gated and never automatic production activation

---

## 16. Seven Frozen Research Principles

These principles should guide future contracts and reviews:

1. **DATA MUST BE EXPLAINABLE.**
2. **BACKTEST KERNEL IS NOT AI-WRITABLE.**
3. **AI MAY MODIFY RESEARCH, NOT MARKET REALITY.**
4. **EXPERIMENT RULES ARE FROZEN BEFORE RESULTS.**
5. **LOCKED TEST IS NEVER USED FOR OPTIMIZATION.**
6. **DATA AVAILABLE IN THE FUTURE CANNOT EXIST IN THE PAST.**
7. **A SUCCESSFUL BACKTEST DOES NOT AUTHORIZE PRODUCTION.**

---

## 17. Future Review Reference Values

Use this matrix when judging progress against the 2026-08-23 baseline:

| Governance capability | Baseline 2026-08-23 | Target |
|---|---|---|
| Data Dictionary | absent | versioned + machine-readable |
| Dataset eligibility lifecycle | absent | enforced states |
| Global PIT visibility rule | absent/partial | enforced by access layer |
| ResearchDataHub | absent | one-fetch-many + typed policy |
| Authoritative Backtest Kernel | absent | fixed/versioned/audited |
| Anti-lookahead gates | incomplete | authoritative tests |
| AI write isolation | prompt/convention only | capability ACL |
| Experiment preregistration | absent | immutable protocol + hash |
| Validation exposure tracking | absent | enforced |
| Locked Test | absent | opaque + one-use/consumed |
| Nested OOS / purge / embargo | not authoritative | governed implementation |
| Candidate Registry | absent | durable evidence-backed state machine |
| Forward Paper gate | not research-governed | required before promotion |
| Production auto-promotion | must remain forbidden | forbidden |

This table is the reference baseline for future Phase 9/10 progress reporting.

---

## 18. What Not To Copy from Reference Projects

Do not blindly import:

- tick-stock-panel's complete backtest implementation as DSbot authority
- any research source directly into OMS/TradingKernel truth
- Fincept's C++/Qt technology stack
- Fincept AGPL implementation code into DSbot without explicit license analysis
- broad AI filesystem access
- automatic research-to-production strategy deployment

Use patterns, contracts and scientific discipline; preserve DSbot's deterministic production core.

---

## 19. Relation to Current Project Phase

As of this baseline, Phase 8A runtime composition remains logically prior to Phase 9/10 implementation.

This document should guide future design and contract work, but must not be used to justify skipping the current production-runtime dependency chain.

Order remains:

```text
Phase 8A Authoritative Production Runtime Composition
  -> Phase 8B Operations Evidence Read Bridge
  -> Phase 9 Research Data Foundation
  -> Phase 10 Research Governance
  -> Phase 11 stronger AI/Hermes autonomous research
  -> Paper operational maturity
  -> Testnet
  -> independently gated Controlled Live
```

---

## 20. Reference Summary

The intended synthesis is:

```text
tick-stock-panel
  -> research discipline, PIT data, Parquet/DuckDB/Polars,
     nested OOS, purge/embargo, candidate registry, persistent research jobs

FinceptTerminal
  -> DataHub, bounded contexts, topic/data policy ideas,
     tool registry/capability surface, worker/secret isolation,
     professional research workspace concepts

DSbot
  -> deterministic Trading Safety Core,
     PreTradeRiskGateway, OMS, recovery, reconciliation,
     accounting, fail-closed authority boundaries
```

The result should be a governed research platform attached to — but never able to silently redefine or bypass — the authoritative trading system.
