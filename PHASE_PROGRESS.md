# DSbot / CloddsBot 项目进度（v3 — Repository Truth Roadmap）

> **更新时间**: 2026-08-23
> **Repository**: `wengecaitui/DSbot`
> **Integration branch**: `feature/orangeai-split`
> **Verified integration HEAD**: `3f6918e317e608580dfcd565138432be9bebcd21`
> **路线定义**: 当前文件以 repository primary data 为准；旧 2026-07-06 的 10-Phase 规划仅保留为历史，不再用于判断当前完成度。

---

# 1. 当前产品定位

DSbot 当前目标是：

> **Research / Market Data Plane + AI / Hermes Slow Plane + Deterministic Trading Safety Core + Professional Quant Terminal**

核心权威链保持：

```text
External Research / Market Data
        ↓
Provider → Normalizer → Canonical Research Dataset
        ↓
Features / Screener / Backtest / Evidence
        ↓
Optional AI / Hermes interpretation
        ↓
Validated Policy / Signal Evidence
        ↓
────────────────────────────────────
       TRADING SAFETY BOUNDARY
────────────────────────────────────
        ↓
ONE application-owned ProductionSpine
        ↓
TradingKernel
        ↓
PreTradeRiskGateway
        ↓
OMS
        ↓
Execution
        ↓
Position / Protection
        ↓
Recovery → Reconciliation → LIVE_READY
        ↓
RuntimeAccounting / TradeLifecycle
        ↓
Paper → Testnet → Controlled Live

Quant Terminal = read-only projection of the same runtime.
```

长期不可破坏的规则：

- **ONE RUNTIME / ONE TRUTH**。
- Dashboard / AI / Research 不能创建第二套 Market / Position / OMS / Accounting / Recovery / Reconciliation truth。
- `missing != flat`，`unknown != healthy`，`unavailable != zero`，`stale != fresh`。
- `SUBMISSION_UNKNOWN != SAFE_TO_RETRY`。
- Recovery / Reconciliation / LIVE_READY authority 不允许 UI toggle、public setter、fake report 或公开 bus write 授予。
- AI 只能解释 deterministic evidence，不能直接成为 authoritative market/position fact，也不能绕过 Risk / OMS。

---

# 2. 已完成并关闭的主要里程碑

## Foundation / Fast-Slow / Market Runtime ✅

已有并保留：Provider abstraction、Claude/OpenAI bridge、Fast/Slow Pipeline、PythonBridgeDaemon、IndicatorService、MarketDataRuntime、TradingEventBus、Market/Candle state、deterministic tests 等。

旧 Phase 0–4 的编号不再单独决定产品进度；其有效代码已经被后续 Trading Core 吸收。

## Phase 4C — Production Spine ✅ MERGED

已形成统一 kernel-backed Paper trading spine：

- `TradingKernel`
- `PreTradeRiskGateway`
- `OmsCore`
- `KernelMarketStateStore`
- `KernelPositionStateStore`
- `KernelPolicyStore`
- `PositionManagerRuntime`
- `PositionPlanStore`
- `PaperExecutionService`

## Phase 5A — Durable Recovery + LIVE_READY Authority ✅ MERGED

- durable journal / replay / recovery verification；
- fresh market provenance 只能来自合法 `MarketDataRuntime` collector ingestion；
- Recovery 与 LIVE_READY 分离；
- public helper / UI / bus write 不得伪造 readiness。

## Phase 5B1 — Reconciliation Contract ✅ MERGED

合法 outcome：

- `MATCH`
- `POSITION_MISMATCH`
- `UNKNOWN_ORDER`
- `MISSING_FILL`
- `ORPHAN_ORDER`
- `MISSING_PROTECTION`
- `UNTRUSTED_STATE`

只有 genuine current `MATCH` 才授予 reconciliation verification。

## Phase 5B2 — Reconciliation Production Wiring ✅ MERGED

- reconciliation 使用真实 OMS / Position / Plan / Paper truth；
- `SUBMISSION_UNKNOWN` 不自动 resend；
- stale reconciliation 不得复用为 LIVE_READY；
- restart / persistence / correlation 已纳入生产链。

## Phase 6A — Runtime Accounting ✅ MERGED

已有 canonical `RuntimeAccountingSnapshot`：

- cash / realized / unrealized PnL；
- equity；
- gross / net exposure；
- fees；
- observed slippage；
- positions；
- `COMPLETE / INCOMPLETE` valuation。

缺市场估值时保持 `null`，不得伪造为 0。

## Phase 6B — Trade Lifecycle ✅ MERGED

已有 canonical：

- `TradeLifecycle`
- `TradeIncarnation`
- `AttributedLeg`
- partial close / scale-in / reversal；
- gross/net PnL 与 fee attribution；
- profit factor。

前端不得重算 canonical economics。

## Phase 7A — Hermes Lifecycle / Handshake Core ✅ MERGED

- PR #118
- merge: `dfa04607b65195aa208868b7cc5570d9365ea772`
- `HandshakeCoordinator`
- `LifecycleHookRegistry`
- `FlushNotifier`
- `HandshakeCircuitBreaker`

## Phase 7B — Hermes ↔ Authoritative Gateway Wiring ✅ MERGED

- PR #119
- merge: `c4dc26910e84677ec7ca7cb261d2ccf44772297c`
- Hermes lifecycle 绑定唯一 application lifecycle；
- dedicated bridge auth；
- 不创建第二个 Gateway truth。

## Phase 7C — Read-Only Quant Terminal V1 ✅ MERGED

- PR #120: Contract Gate
- PR #121: Quant Terminal V1 implementation
- integration merge: `3f6918e317e608580dfcd565138432be9bebcd21`

已实现：

- React + TypeScript + Vite + TanStack Query；
- Overview / Market / Trading / Research / Policy / Safety / Operations / Data / Settings；
- `/api/workbench/v1` GET-only API；
- Positions / Orders / Accounting；
- Risk / Recovery / Reconciliation；
- Hermes / Events / Project Control Center presentation surface；
- persistent terminal status；
- explicit `UNKNOWN / UNAVAILABLE / INCOMPLETE / STALE / SUBMISSION_UNKNOWN` semantics。

PR #121 验证证据：

- Phase 7C focused: 10/10；
- Control Center: 26/26；
- Typecheck: pass；
- Build: pass；
- Node full: 3158 pass / 3 skipped / 0 failed；
- Python canonical suite: 956 pass；
- CI / Security / Stage proof workflows: remote success on approved head。

---

# 3. 当前真实 P0 缺口

## AUTHORITATIVE_PRODUCTION_SPINE_OWNER = NONE_IN_PRODUCTION

`createProductionSpine()` 已存在且安全链完整，但正式 application composition root 当前没有长期持有唯一 ProductionSpine。

当前 `createGateway()` 的 Workbench adapter 只注入：

- application lifecycle health；
- Hermes snapshot。

它没有注入 production spine，因此正式 Gateway 下：

- Market；
- Position；
- OMS；
- Accounting；
- Recovery；
- Reconciliation；
- Policy；

仍会正确显示 `UNAVAILABLE / UNKNOWN / INCOMPLETE`。

这不是 Quant Terminal UI bug，而是上游 runtime composition 未完成。

同时，Gateway 中还存在历史 `ExecutionService / TradingOrchestrator / PositionManager / legacy trading routes`。Phase 8 必须明确这些旧执行路径与 authoritative ProductionSpine 的关系，避免形成第二套交易执行权威或安全旁路。

---

# 4. 距离最终完工还差多少 Phase

## 定义

- **Controlled Live V1**：安全地完成 Paper → Testnet → very-small controlled Live，研究面可用。
- **Commercializable V1**：在 Controlled Live V1 之后，再完成 deployment / secrets / RBAC / licensing / observability / release hardening。

因此：

- **距离 Controlled Live V1：还差 7 个宏观 Phase（Phase 8–14）**。
- **距离当前长期目标“可商业化成品”：还差 8 个宏观 Phase（Phase 8–15）**。

以下以最终商业化 V1 为“完工”定义。

---

# 5. Remaining Roadmap — Phase 8 到 Phase 15

## Phase 8 — Authoritative Runtime Composition + Operations Read Bridge

**状态**: NEXT / P0

### Phase 8A — Authoritative Production Runtime Composition

当前 Contract Gate 已获授权；Implementation 尚未授权。

目标：

1. 找到唯一 application composition root；
2. application lifetime 内只创建并持有 **ONE ProductionSpine**；
3. 冻结 MarketDataRuntime / Journal / Paper persistence / hardRisk / Recovery / Reconciliation ownership；
4. Workbench 读取 **SAME spine reference**；
5. 定义 startup / shutdown / partial failure / restart；
6. 启动时保持 `ORDER_SUBMISSIONS=0`、`LIVE_READY=false`，直到现有 safety chain 合法建立 authority；
7. 明确 legacy `ExecutionService / TradingOrchestrator / PositionManager` 是迁移、适配、隔离还是退役，禁止双权威；
8. 保持 Paper / Testnet / Live authorization 分离。

绝对禁止：

```text
Workbench -> createProductionSpine()
HTTP request -> createProductionSpine()
Hermes -> createProductionSpine()
Monitor -> createProductionSpine()
Dashboard-specific OMS / ledger / accounting / runtime
```

### Phase 8B — Operations Evidence Read Bridge

目标：

- 将 Project Control Center / Hermes monitor activity / runtime evidence 以只读、可溯源方式桥接给 Gateway；
- 不把 operations evidence 变成 trading truth；
- cross-process evidence 缺失时继续显示 `UNAVAILABLE / INCOMPLETE`，不伪造状态。

**Phase 8 完成标志**：正式 Quant Terminal 能读取同一个 authoritative runtime 的 Market / Position / OMS / Accounting / Safety；Operations evidence 有明确 read bridge；没有第二套 runtime。

---

## Phase 9 — Research Data Plane + Multi-Market Provider Layer

**目标**: 建立与 Trading Core 完全分离的 canonical research data plane。

目标架构：

```text
External Provider
  -> Provider Adapter
  -> Normalizer
  -> Canonical Research Dataset
  -> Repository / Storage
  -> Feature / Screener / Backtest
  -> Evidence
```

重点：

- A 股优先：TickFlow / stock-sdk / AkShare / custom licensed provider；
- 后续扩展 US / HK / Crypto / Macro / News；
- provider capability detection / rate limit / retry / freshness / provenance；
- Parquet 作为 durable historical dataset；
- DuckDB 用于 cold/ad-hoc analytical query；
- Polars 用于 vectorized research compute；
- provider 数据不能直接写 TradingKernel / OMS；
- research provider 不得成为 Recovery / Reconciliation / LIVE_READY truth。

**完成标志**：至少一个 A-share canonical provider + 一个 global/macro provider 可稳定写入统一 research schema，并可由 Data 页面显示 freshness/provenance。

---

## Phase 10 — Research Workbench + Screener + Backtest + Anti-Overfit

参考 `tick-stock-panel` 的 generic patterns，但独立实现。

目标：

- Screener；
- factor backtest；
- strategy backtest；
- optimizer（受控）；
- walk-forward；
- concept / industry / regime research；
- persistent research jobs + progress + reconnect；
- fees / spread / slippage / T+1 或对应市场交易约束；
- candidate registry；
- explicit promotion，永不自动上线。

防过拟合合同：

```text
TRAIN
  - 允许参数拟合 / 选择
VALIDATION
  - 只评估，不参与调参
LOCKED_TEST
  - 在最终评估前对开发流程不可见
```

并加入：

- walk-forward；
- purge / embargo；
- point-in-time fundamentals；
- no future leakage；
- benchmark comparison；
- minimum OOS folds / trades / drawdown / Sharpe evidence；
- LOCKED_TEST 结果不能反向影响策略设计。

**完成标志**：研究策略能在 canonical dataset 上完成可重复、成本感知、无未来函数的 OOS 评估，并生成明确证据，而不是直接进入 execution。

---

## Phase 11 — AI / Hermes Research & Policy Plane

**目标**: 让 AI 增强研究，而不是接管事实和执行。

方向：

```text
Deterministic facts
  -> structured evidence
  -> Hermes / AI interpretation
  -> validated Policy Snapshot
  -> PolicyStore
  -> Fast deterministic decision
  -> PreTradeRiskGateway
  -> OMS
```

内容：

- News / Macro / Regime research agents；
- Hermes tools / MCP / workflow 仅开放受控 research/read capabilities；
- policy schema / TTL / provenance / confidence；
- AI failure / timeout / hallucination fail-closed；
- AI 与无 AI baseline 对照；
- AI 不得直接 submit order / set position / grant LIVE_READY / retry UNKNOWN order。

**完成标志**：AI 输出只能生成经过 schema + policy validation 的 evidence/policy，任何真实交易仍经过 deterministic risk + OMS。

---

## Phase 12 — Paper Operational Maturity

**目标**: 将已有 Paper core 从“测试充分的库”升级为“长期稳定运行的 application runtime”。

内容：

- authoritative application-owned Paper runtime；
- 真实行情持续运行；
- partial fills / rejection / timeout / disconnect / restart injection；
- durable journal / persistence / replay / recovery / reconciliation soak；
- accounting / lifecycle / fees / slippage attribution；
- stale market / missing state / corrupted persistence fail-closed；
- alerts / telemetry / SLO；
- 48h → 7d soak tests；
- zero duplicate order / zero unprotected position / zero silent mismatch gate。

**完成标志**：Paper 环境可连续运行并通过故障注入与 restart/reconcile tests，不依赖人工修状态。

---

## Phase 13 — Testnet / Demo Broker Qualification

**目标**: 用真实交易 API 的网络和订单语义验证 SAME kernel/risk/OMS path，但不使用真实资金。

优先：

1. Bitget Demo Trading；
2. Bybit Testnet 作为第二 adapter / cross-check；
3. 其他 broker/exchange 后续按需求加入。

验证：

- auth / nonce / timestamp / signature；
- REST + WS；
- order ack / fill / cancel / reject；
- `SUBMISSION_UNKNOWN`；
- idempotency / duplicate prevention；
- reconnect / rate limit / exchange outage；
- external truth reconciliation；
- protective order semantics；
- same accounting / lifecycle projection。

**完成标志**：Testnet/Demo 与 Paper 共用同一 Trading Safety Core，只替换 adapter；网络异常不会造成重复订单或错误 retry。

---

## Phase 14 — Live Readiness Gate + Controlled Live

**目标**: 在独立安全 Gate 后才允许极小资金 Live。

必须满足：

- Paper / Testnet evidence 达标；
- Recovery + current Reconciliation + fresh authoritative market → LIVE_READY；
- dedicated trading sub-account；
- API key 无 withdrawal 权限；
- IP whitelist；
- strict max order / position / daily loss / drawdown；
- emergency kill / cancel-all / flatten procedure；
- tiny canary capital；
- audit logs；
- operator runbook / rollback；
- independent security review；
- live enablement 必须 explicit authorization，不得自动切换。

**完成标志**：系统可以在严格限制下执行真实小额交易，同时任何 authority/evidence 缺失都会 fail-closed。

---

## Phase 15 — Commercial / Release Hardening

**目标**: 从“可控实盘系统”升级为可长期维护、可部署、可商业化的产品。

内容：

- secrets / credential lifecycle；
- auth / RBAC / audit；
- deployment / backup / migration / disaster recovery；
- metrics / logs / alerts / health diagnostics；
- data-provider licensing / redistribution rights；
- dependency / supply-chain security；
- API quota / cost governance；
- workspace preferences / terminal ergonomics / optional docking；
- documentation / onboarding / release process；
- multi-market provider capability matrix；
- commercial legal review。

**完成标志**：不仅“能交易”，还具备可维护、可审计、可部署和合法商业使用的产品能力。

---

# 6. 当前产品完成度（Roadmap Estimate，不是代码行统计）

| Area | 当前估计 | 说明 |
|---|---:|---|
| Deterministic Trading / Safety Core | 80–85% | Kernel / Risk / OMS / Position / Recovery / Reconciliation / Accounting / Lifecycle 已成熟；production ownership 未完成 |
| Quant Terminal V1 | 75–80% | UI/API 已 merge；canonical runtime 尚未正式挂载；Research/Operations 数据仍不完整 |
| Research Data Plane | 10–15% | contract/extension point 已有，canonical provider/storage 尚未实现 |
| Screener / Backtest / Anti-overfit | 10–20% | 仓库有旧 backtest/strategy 资产，但新 canonical research plane 尚未形成闭环 |
| AI / Hermes Integration | 45–55% | handshake/gateway 已完成；research evidence → policy → trading boundary 尚未形成完整产品闭环 |
| Paper Operational Readiness | 55–65% | Paper core 很强；缺 application-owned runtime 与长期 soak/failure injection |
| Testnet Readiness | 10–15% | exchange/legacy adapters 有资产，但尚未通过 authoritative runtime qualification |
| Controlled Live Readiness | <10% | 故意未授权；不能因旧 execution routes 存在就视为 Live Ready |
| Commercial Hardening | 10–20% | 有 security/CI/monitoring 基础，但商业部署、数据许可、RBAC 等尚未完成 |

**整体长期产品估计：约 55%–60%。**

这不是“还有一半代码没写”的意思，而是后半程主要集中在 integration、数据、研究验证、外部交易环境和 production operations，单个 Phase 风险高于早期功能开发。

---

# 7. API 准备时间表

原则：**不要现在一次性申请全部 API**。先完成 Phase 8 内部 authority，再按 provider phase 逐步准备。

任何 key / secret：

- 不写进 Git；
- 不写进 Prompt / test fixture；
- 只通过 secret store / environment 注入；
- Live 与 Testnet 必须分开；
- Live key 尽量 dedicated sub-account + IP whitelist + no-withdrawal。

## 现在（Phase 8）

### 外部 API：无需新增

Phase 8 是内部 runtime composition，不应该被外部 provider 阻塞。

需要准备的只有工程配置：

- durable journal path；
- Paper persistence path；
- internal `HERMES_BRIDGE_TOKEN` / credential storage；
- hardRisk config source；
- runtime startup/shutdown ownership。

不要为了让 Dashboard 有数据提前接第三方 market API。

## Phase 9 开始前 — Research Data APIs

### P0：TickFlow API Key（如果 A 股作为第一研究市场）

- `TickFlow.free()`：无需 key，可取历史日 K，适合 provider contract / smoke test；
- 完整 API Key：A 股 / 美股 / 港股实时行情、分钟 K 等完整能力；
- 在 Phase 9 provider implementation 前申请即可。

推荐环境变量：

```text
TICKFLOW_API_KEY
```

### P0：FRED API Key（Macro）

用途：利率、CPI、就业、流动性、宏观 release / series。

```text
FRED_API_KEY
```

### P1：MarketAux API Token（Financial News / entity sentiment）

适合：

- ticker/entity-tagged financial news；
- global markets；
- basic entity sentiment；
- Slow Plane research evidence。

免费档当前可用于开发 smoke test；生产商业使用前必须重新核 license/plan。

```text
MARKETAUX_API_TOKEN
```

### P1：US Market Provider — 先二选一，不要同时购买

#### Option A — Alpaca Market Data

适合 US equities/ETFs，HTTP + WebSocket；Basic 可做开发和 research prototype。

```text
ALPACA_API_KEY_ID
ALPACA_API_SECRET_KEY
```

#### Option B — Twelve Data

适合 unified stock / forex / crypto research provider；Basic 免费档适合 contract test，小规模开发后再决定升级。

```text
TWELVEDATA_API_KEY
```

**选择建议**：

- 如果未来 US trading 可能走 Alpaca：优先 Alpaca；
- 如果希望一个 research API 覆盖 stock/forex/crypto：优先 Twelve Data；
- 不要在 Phase 9 初期同时付费两家。

### P1：无需 API Key 的免费研究源

#### SEC EDGAR Data API

- US filings / submissions / XBRL；
- public data API 不需要 key；
- 必须声明 User-Agent，并遵守 SEC fair-access rate policy。

#### World Bank Indicators API

- global macro / country indicators；
- V2 API；
- 不需要 API key。

### P2：CoinGecko Demo API Key

适合 crypto metadata / market-cap / broad market reference。

注意：`public-apis` 当前列表仍把 CoinGecko 标为 `No auth`，但 CoinGecko 2026 官方文档已经要求 Demo/Pro API key。因此不能机械相信 public-apis 的 Auth 列。

```text
COINGECKO_API_KEY
```

CoinGecko 只能是 research/reference source，不能替代交易所 collector 成为 LIVE_READY market authority。

### P2：可选 Finance provider backups

来自 `public-apis` Finance catalog，可在具体需求出现时评估：

- Finnhub；
- Alpha Vantage；
- Financial Modeling Prep；
- Polygon；
- Marketstack；
- StockData.org。

不要为了“API 越多越好”同时接入。Provider 必须通过 capability / freshness / history / licensing / rate-limit / cost 评估后才进入 canonical research plane。

## Phase 11 前 — AI / Hermes

当前项目已有 OrangeAI / SiliconFlow / OpenAI-compatible provider 资产。

如果这些 provider 仍可用：**无需新增 AI API**。

仅在 benchmark / reliability / cost 证明需要时，再增加 OpenAI / Anthropic / Gemini 等 provider。

AI key 不能进入 Fast deterministic execution path。

## Phase 13 前 — Testnet / Demo Trading API

### Primary：Bitget Demo API Key

Phase 13 前再创建，不需要现在创建。

官方 Demo API 要求独立 Demo API Key；请求需使用 demo trading 规则。当前官方文档显示 Demo Trading 需要完成 KYC。

推荐：

```text
BITGET_DEMO_API_KEY
BITGET_DEMO_API_SECRET
BITGET_DEMO_API_PASSPHRASE
```

### Secondary：Bybit Testnet API Key

用于第二 exchange adapter qualification / cross-check。

```text
BYBIT_TESTNET_API_KEY
BYBIT_TESTNET_API_SECRET
```

新账户可能存在 API key 创建等待期，因此在 Phase 13 即将开始前提前几天准备即可。

## Phase 14 Gate 通过后 — Live Trading API

**在此之前不要创建或注入 Live write key。**

推荐首个 Live venue 仍选已经在 Paper/Testnet 证明过的同一家交易所。

要求：

- dedicated sub-account；
- read + trade only；
- withdrawal disabled；
- IP whitelist；
- 独立 secret；
- tiny capital；
- 明确 rotation/revoke runbook。

## 可选扩展（Phase 15 或之后）

- Polymarket API；
- Kalshi API；
- Etherscan / Bitquery on-chain research；
- additional brokers；
- paid institutional market/news feeds。

这些扩展必须走新的 adapter/capability contract，不能复活 legacy bypass execution path。

---

# 8. `public-apis/public-apis` 研究结论

`public-apis` 是 **API discovery catalog**，不是一个可直接当数据源调用的统一金融 API。

当前列表中对 DSbot 有价值的类别：

## Finance

- Marketstack
- Alpaca
- Alpha Vantage
- Financial Modeling Prep
- Finnhub
- FRED
- Polygon
- SEC EDGAR Data
- StockData.org
- Twelve Data

## Cryptocurrency

- CoinGecko
- CoinCap
- Coinbase
- CoinMarketCap
- 0x / 1inch 等 DEX APIs

## Blockchain

- Bitquery
- Etherscan
- Covalent
- Blockscout

## News

- MarketAux
- GNews
- NewsAPI
- Mediastack
- Currents

## Open / Government Data

- World Bank
- US Treasury / FRED 等。

### 使用规则

1. `public-apis` 只作为 discovery source；
2. 每个 provider 必须再检查官方文档；
3. Auth / rate limit / plan / CORS / licensing 可能已变化；
4. commercial redistribution rights 必须单独确认；
5. public/free API 只能进入 Research Data Plane，除非该 provider 本身就是被批准的 authoritative execution venue feed；
6. 不允许用多个低质量 API 的“投票”伪造 market truth。

已验证的一个 stale example：CoinGecko 在 `public-apis` 中仍显示无需认证，但 2026 官方 Demo API 已要求 API key。

---

# 9. 两个参考项目的采用边界

> 用户输入中两次写了同一个 `shy3130/tick-stock-panel` URL。项目历史已经冻结第二个 architecture reference 为 `Fincept-Corporation/FinceptTerminal`，因此本 roadmap 继续使用这两个已建立参考：`tick-stock-panel` + `FinceptTerminal`。

## A. `shy3130/tick-stock-panel`

把它作为 **Research / A-share Workbench reference**。

值得采用的 generic ideas：

- plugin data source；
- provider capability detection；
- daily/minute/realtime/financial dataset separation；
- enriched Parquet；
- DuckDB analytical integration；
- Polars vectorized screener；
- factor + strategy backtest；
- persistent jobs + SSE reconnect；
- T+1 / fee / slippage；
- point-in-time fundamentals；
- nested out-of-sample / walk-forward；
- candidate store；
- explicit promotion；
- auto research 不 auto publish。

特别值得 DSbot 采用：

```text
research candidate != production strategy
backtest winner != authority to trade
```

DSbot 在此基础上继续坚持更严格的：

```text
TRAIN / VALIDATION / LOCKED_TEST
```

## B. `Fincept-Corporation/FinceptTerminal`

把它作为 **Financial Terminal Architecture / UX reference**。

值得采用的 generic ideas：

- modular monolith；
- bounded contexts；
- one-fetch / many-subscribers read distribution；
- provider/service separation；
- visible freshness / cache status；
- stable terminal shell / persistent status；
- broker adapter abstraction；
- MCP/tool capability layer；
- workflow/node editor concepts；
- workspace / docking as client preference；
- secure credential storage。

不采用：

- C++20 / Qt6 技术栈重写；
- Fincept source implementation；
- Fincept unique visual trade dress；
- 任何会把 DataHub 变成 Trading authority 的设计。

Fincept open repo 为 AGPL-3.0；DSbot 只借 generic architecture ideas，不复制其实现。

---

# 10. 推荐依赖顺序

```text
NOW
Phase 8A Contract Gate
  ↓
Phase 8A Implementation
  ↓
Phase 8B Operations Read Bridge
  ↓
ONE authoritative runtime visible in Quant Terminal
  ↓
Phase 9 Research Data Plane
  ↓
Phase 10 Screener / Backtest / Anti-overfit
  ↓
Phase 11 AI / Hermes Research + Policy
  ↓
Phase 12 Paper Operational Maturity
  ↓
Phase 13 Testnet / Demo Qualification
  ↓
Phase 14 Controlled Live Gate
  ↓
Phase 15 Commercial / Release Hardening
```

不要因为 UI 已经可用就跳过 Phase 8，也不要因为某个 public API 免费就提前接入 execution path。

---

# 11. 当前下一步

**唯一最高优先级：Phase 8A Contract Gate。**

它必须先回答：

```text
WHO OWNS THE ONE PRODUCTION SPINE?
WHO OWNS MARKET RUNTIME / JOURNAL / PERSISTENCE / HARD RISK?
HOW DOES RECOVERY + RECONCILIATION START?
HOW DOES WORKBENCH RECEIVE THE SAME INSTANCE?
WHAT HAPPENS TO LEGACY EXECUTION PATHS?
HOW DO START / STOP / FAILURE / RESTART WORK?
```

在 Phase 8A 合同 merge 之前：

- 不开始 Research provider implementation；
- 不为 UI fake data；
- 不创建 Dashboard runtime；
- 不接 Live write API；
- 不激活 Paper/Testnet/Live trading authority。

---

# 12. Merge / Review Discipline

- Contract Gate 可详细冻结 WHAT / BOUNDARY / ACCEPTANCE；
- Implementation Prompt 必须短，优先引用 merged contract；
- Codex 报告不能代替独立 review；
- exact `PRE_HEAD..HEAD` review；
- Green tests never override architecture/safety bypass；
- P0 = authority / truth / safety correctness；
- 未经用户明确授权：

```text
MERGE=AWAITING_EXPLICIT_USER_AUTHORIZATION
```

---

# Historical note

2026-07-06 的旧 10-Phase 规划中存在 Freqtrade 双向同步、旧 Multi-Agent、旧 Phase 8–10 等路线。它们不再作为当前主路线：

- 任何可能创建第二套 position/order truth 的 Freqtrade 双向 state machine 不采用；
- 有价值的旧代码继续作为 adapter/research asset；
- 当前 roadmap 以已经 merge 的 Trading Safety Core、Hermes、Quant Terminal 和真实 dependency 为准。
