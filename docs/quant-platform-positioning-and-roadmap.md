# DSbot Quant Platform Positioning and Benchmark Roadmap

> Strategic design reference. External projects evolve; re-verify their current APIs and licenses before adopting or integrating implementation details.

## 1. Product position

DSbot should not be optimized as a generic "crypto trading bot".

The target is a governed Quant Operating System / Quant Terminal that combines:

```text
Trusted Research Data
+ reproducible research / experiment governance
+ AI-assisted research
+ deterministic promotion boundaries
+ production trading runtime
+ fail-closed risk / OMS / recovery
+ human authorization
+ durable evidence
```

The architectural distinction is not the number of indicators, models, exchanges, or UI pages. The distinction is whether research conclusions can cross into production authority without passing deterministic evidence and authorization gates.

## 2. Reference-project map

The following projects represent different mature quant-system design families. DSbot should borrow specific strengths rather than copy an entire stack.

| Reference | Primary design family | What DSbot should learn | What DSbot should not give up |
|---|---|---|---|
| NautilusTrader | production-grade event-driven trading engine | backtest/live component parity, domain modeling, reconciliation/recovery discipline, multi-venue engine structure | AI slow-plane isolation, explicit authority transitions, durable evidence governance |
| LEAN / QuantConnect | full research-backtest-live quant engine | market models, data normalization, corporate actions, brokerage abstractions, broad asset support | DSbot's separate research-data authority and explicit human promotion gate |
| Qlib | AI / ML quant research platform | feature/model research workflow, dataset abstraction, model experimentation, portfolio research | production OMS/risk/recovery authority must remain outside research/ML authority |
| Jesse | research + optimization + crypto trading UX | strategy research ergonomics, optimization / Monte Carlo / significance tooling, AI research interaction | AI tooling must not become execution authority |
| Hummingbot | crypto execution / market-making platform | connector ecosystem, CEX/DEX abstractions, executor/controller patterns, multi-bot operations | ONE TRUTH and production authority must remain centralized and fail-closed |
| Freqtrade | strategy-first crypto bot | fast strategy iteration, dry-run workflow, hyperparameter search, lookahead diagnostics | avoid strategy-first architecture becoming system truth; preserve strict promotion and PIT evidence |
| vn.py | China-market trading gateway framework | CTP/QMT/broker gateway abstraction, domestic market connectivity | DSbot owns higher-level authority, research, risk and promotion semantics |
| vectorbt | vectorized research / parameter exploration | fast parameter sweeps, factor experimentation, research ergonomics | large search spaces must never substitute for locked out-of-sample evidence |
| RQAlpha | modular research/backtest/trading framework | DataSource/EventSource/Broker modularity, China-market strategy workflow | production authority and AI governance remain stricter in DSbot |
| Backtrader | classic Python strategy/backtest framework | simple strategy API, low-friction experimentation | do not regress DSbot into a strategy-centric monolith |

## 3. Relative position today

DSbot is currently stronger in production governance than in research maturity.

### DSbot relative strengths

- explicit `ONE RUNTIME / ONE TRUTH` ownership.
- production trading authority separated from presentation and AI.
- fail-closed risk / OMS / recovery / reconciliation design.
- raw research data separated from production market-data authority.
- `event_time / available_at / ingested_at` separation.
- historical authority subjects persisted as byte-exact durable evidence.
- human authorization remains separate from research or evidence success.

### DSbot current gaps relative to mature platforms

- no final Canonical PIT Dataset yet.
- no completed analytical/raw Research Data storage layer.
- no final ResearchDataHub / usage policy authority.
- no completed lineage/version/deprecation system.
- no first fully-qualified TickFlow/QMT/TDX research provider.
- no final fixed/versioned ResearchBacktestKernel.
- no complete train/validation/locked-test experiment lifecycle.
- less connector breadth and production track record than mature trading frameworks.
- lower strategy/research UX maturity than dedicated research-first tools.

## 4. The key strategic differentiation

The target chain is:

```text
External Provider
  -> Provider Manifest
  -> bounded ResearchProviderAdapter
  -> RawResearchRecord
  -> Provider Source Binding
  -> Canonical Field Dictionary
  -> Canonical PIT Dataset
  -> ResearchDataHub
  -> ResearchBacktestKernel
  -> AI Research Sandbox
  -> TRAIN / VALIDATION
  -> Candidate Freeze
  -> LOCKED TEST
  -> Forward Paper
  -> Promotion Gate
  -> Human Authorization
  -> existing ProductionSpine
```

No single research or AI component may skip layers and become a trading authority.

## 5. Borrow / do-not-rebuild strategy

### 5.1 From NautilusTrader

Borrow concepts:

- consistent event/domain model between simulation and live operation.
- deterministic execution simulation and venue semantics.
- reconciliation and recovery as first-class production requirements.
- explicit instrument/order/fill state machines.

Do not import as authority:

- DSbot should not replace its existing ProductionSpine merely to imitate another engine.
- evaluate algorithms and semantics; reuse/adapt only where they fit the frozen authority model.

### 5.2 From LEAN

Borrow concepts:

- normalized market data and corporate-action semantics.
- brokerage / fee / fill / slippage models.
- universe and instrument modeling.
- research-to-live parity where possible.

DSbot extension:

- canonical data must also carry point-in-time availability evidence.
- a successful backtest is not sufficient for promotion.

### 5.3 From Qlib

Borrow concepts:

- dataset/feature abstractions.
- experiment organization.
- ML model research workflows.
- feature/label separation.

DSbot extension:

- `LABEL != DECISION_INPUT` must remain machine-enforced.
- dataset use must be fail-closed and PIT-aware.
- ML model output remains research evidence until promotion.

### 5.4 From Jesse / Freqtrade / vectorbt

Borrow concepts:

- low-friction strategy research.
- fast parameter search.
- Monte Carlo / significance diagnostics.
- lookahead-bias detection.
- good researcher ergonomics.

DSbot extension:

```text
large search space
!=
out-of-sample evidence
```

Required governance:

```text
TRAIN
-> VALIDATION
-> candidate freeze
-> LOCKED TEST
```

The locked test must not be repeatedly queried during candidate development.

### 5.5 From Hummingbot

Borrow concepts:

- mature connector contracts.
- explicit execution/controller separation.
- CEX/DEX venue handling.
- operations visibility.

DSbot extension:

- connectors are adapters, never alternate runtime truth.
- no connector may bypass PreTradeRiskGateway / OMS / ProductionSpine authority.

### 5.6 From vn.py

For China-market expansion prefer adapter/gateway reuse over rebuilding broker protocols.

Potential future structure:

```text
DSbot authority / research layer
  -> bounded broker/gateway adapter
  -> QMT / vn.py / CTP / broker SDK
```

The external gateway owns connectivity semantics; DSbot retains risk, OMS, authorization, evidence, research and promotion authority.

## 6. Phase 9 priorities

Do not expand strategy count before trusted research data exists.

### 9B — Canonical semantics

Goal:

- freeze what each research field means.
- freeze how provider source values claim compatibility.
- do not execute normalization yet.

### 9C — Canonical PIT Dataset

Primary invariant:

```text
historically decision-visible
only if
available_at <= decision_time
```

Required design questions:

- canonical row identity.
- field-level vs record-level availability.
- missing vs explicit null.
- revision/restatement behavior.
- corporate-action and adjustment semantics.
- anti-lookahead query API.

### 9D — Storage

Storage is implementation, not semantic authority.

Evaluate Parquet / DuckDB / Polars or equivalent only after 9C semantics are frozen.

Required separation:

```text
raw evidence storage
!=
canonical PIT storage
!=
research cache
```

### 9E — ResearchDataHub + DatasetUsagePolicy

Target:

- one research-data access boundary.
- declared dataset/field usage.
- licensing/access restrictions.
- fail-closed undeclared use.
- no path to production market-data authority.

### 9F — Lineage / version / deprecation

Target:

- dataset identity.
- dictionary version.
- provider binding version.
- transformation version.
- content identity / lineage.
- deprecation and reproducibility.

### 9G — First real provider qualification

Only after 9B-9F boundaries exist.

Candidate providers may include TickFlow, QMT/TDX or another source selected for the target market.

Qualification must prove:

- owned timeout/cancellation.
- pagination/concurrency behavior.
- available-at semantics.
- data revision semantics.
- licensing constraints.
- deterministic raw provenance.
- no production authority bypass.

## 7. Phase 10 priorities — trusted experiments

Phase 10 should be treated as Research Experiment & Promotion Governance, not a generic cleanup phase.

### 10A — Fixed/versioned ResearchBacktestKernel

Freeze:

- execution model.
- fills/slippage/fees.
- corporate actions.
- latency assumptions.
- position/accounting semantics.
- deterministic configuration identity.

Backtest semantics must be versioned so results can be reproduced.

### 10B — Experiment protocol

Each experiment should record before evaluation:

- dataset version.
- feature set.
- label definition.
- parameter search space.
- objective metrics.
- constraints.
- train/validation/test windows.
- purge/embargo rules where applicable.

### 10C — Overfit controls

Target lifecycle:

```text
TRAIN
  -> VALIDATION
  -> Candidate Freeze
  -> LOCKED TEST
```

A locked-test result cannot be used to repeatedly tune the same candidate.

Recommended future controls:

- walk-forward validation.
- purge / embargo.
- realistic transaction costs.
- multiple-testing awareness.
- parameter stability tests.
- regime robustness.
- Monte Carlo / resampling where appropriate.

### 10D — Forward Paper

A candidate that passes historical gates must still prove forward behavior before production promotion.

### 10E — Promotion and human authorization

Research success produces a candidate, not trading authority.

```text
Candidate
-> Promotion Gate
-> Human Authorization
-> existing trading safety boundary
```

## 8. AI architecture rule

AI may:

- discover hypotheses.
- propose features.
- propose strategies.
- run bounded research tools.
- interpret experiment results.
- compare candidates.
- draft research reports.

AI may not directly:

- establish data truth.
- declare PIT eligibility.
- rewrite locked-test history.
- self-promote a strategy.
- bypass human authorization.
- bypass risk / OMS / execution authority.

Core rule:

```text
AI intelligence
!=
AI authority
```

## 9. What not to prioritize now

Until Phase 9-10 trusted-research closure is substantially complete, avoid making these primary roadmap goals:

- adding many more indicators.
- adding many more strategies.
- expanding dashboards for their own sake.
- adding exchanges without an adapter/authority need.
- aggressive model count expansion.
- unconstrained hyperparameter optimization.

Those capabilities are already common in mature quant projects and do not create DSbot's differentiation.

## 10. Success condition

DSbot reaches its intended differentiated position when this statement is true end to end:

```text
Trusted Data
-> Trusted Research
-> Trusted Candidate
-> Trusted Promotion
-> Trusted Execution
```

and every transition can answer:

1. What is the authority?
2. What exact evidence supports it?
3. What data was historically knowable at the decision time?
4. What version of the experiment/execution semantics produced the result?
5. Can AI or presentation code bypass the gate?
6. Can the result be reproduced from durable evidence?
7. Who explicitly authorized production activation?

If any answer is ambiguous, the system should fail closed.
