# CloddsBot 改造进度（v2 — 10-Phase 流程）

> **流程升级时间**: 2026-07-06
> **基线**: 旧 4-Phase 改造（Phase 0-1 基础 / Phase 2 桥接 / Phase 3 Multi-Agent / Phase 4 Python 桥接 / Phase 5 数据层）
> 已完成代码全部保留，按新流程重新定位。

---

## 总览

| Phase | 主题 | 优先级 | 状态 | 完成度 |
|-------|------|--------|------|--------|
| 0 | 延迟基准测试 | P0 | ✅已完成 | 100% |
| 1 | 资产化与 Provider 改造 | P1 | ✅已完成 | 100% |
| 2 | Claude → OpenAI 桥接层 | P1 | ✅已完成 | 100% |
| 3 | 快慢分道架构 | P0 | ⏳框架就绪 | 30% |
| 4 | Python 桥接层 | P1 | ⏳框架就绪 | 90% |
| 5 | Freqtrade 数据层整合 | P1 | 🔲待开始 | 0% |
| 6 | 多 Agent 分析层 | P1 | ⏳框架就绪 | 40% |
| 7 | Hermes 握手 + Quant Terminal（7A/7B/7C 已合并） | P1 | ✅完成 | 100% |
| 8 | 权威生产运行时组合 + 功能模块接入 | P1 | ⏳契约门进行中 | 30% |
| 9 | 系统集成 | P2 | 🔲待开始 | 0% |
| 10 | 审核与验证 | P2 | 🔲待开始 | 0% |

---

## Phase 0 — 延迟基准测试 ✅ 完成 (P0)

**目的**: 量化当前 LLM 调用链路端到端延迟，决定是否必须上快慢分道。

### 实测数据 (2026-07-06, glm-5.2 via orangeai.cc)

| 阶段 | P50 延迟 | 说明 |
|------|----------|------|
| 4 Analyst 并发 | 14.62s | Bull/Bear/Sentiment/Macro 4路并发 |
| 1 轮 Debate | 13.05s | Bull ↔ Bear 辩论文本生成 |
| Research Manager | 12.38s | 综合报告输出 |
| **总耗时** | **40.05s** | P99 >> 5s |

### 阈值判断
- ✅ 总耗时 **40.05s** >> **5s 阈值** → 必须上快慢分道
- 慢路径（Cron）：接受 40s+ 延迟，宏观/基本面/情绪分析
- 快路径（Python 指标）：目标 < 2s，纯技术面硬决策

### 文件
- `docs/phase0_latency_benchmark.json` — 压力测试报告
- 完整 50 次采样待环境变量稳定后补跑

---

## Phase 1 — 资产化与 Provider 改造 ✅

### 1.1 Clone CloddsBot ✅
- Repo: `github.com/wengecaitui/cloddsbot`
- 分支: `feature/orangeai-split`
- 本地: `E:/Workplace/CloddsBot`

### 1.2 全量扫描依赖树 ✅
- TypeScript 项目 + Python quant_engine 双语言
- 主要依赖: CCXT / LangGraph / Pandas / NumPy

### 1.3 Claude 代码热力图 ✅
- 原作者核心: Multi-Agent 分析层 + Bitget-Trader 集成

### 1.4 Provider 层改造（加 BASE_URL 支持）✅
- `src/providers/index.ts` 增加 ProviderManager + BASE_URL 注入
- 支持 OpenAI 兼容协议（GLM-5.2 / orangeai / siliconflow）

### 1.5 Fallback Chain + Circuit Breaker ✅
- 实现: `src/router/ExecutionRouter.ts`
- 熔断: `src/router/KillSwitch.ts`
- 已支持 3 个 provider 自切换

---

## Phase 2 — Claude → OpenAI 桥接层 ✅

### 2.1 扫描 119 个 skill 的 tool call 格式 ✅
- 已映射 Anthropic `tool_use` ↔ OpenAI `tool_calls`

### 2.2 写桥接层 ✅
- `src/providers/ClaudeToOpenAIBridge.ts`
- content[] / tool_use_id 等字段映射
- 已通过单元验证

### 2.3 单元测试验证桥接层 ✅
- 已实现逻辑层测试，TS 编译有 8 个历史债务错误（与桥接层无关，是其他模块）

---

## Phase 3 — 快慢分道架构 ⏳ 框架就绪 30%

**前置依赖**: Phase 0 延迟基准决策（>5 秒则必须实施）

### 3.1 慢路径（Hermes cron 定期触发）
- 🔲 宏观 + 基本面 + 情绪 + 深度辩论
- 🔲 输出"市场偏向报告"存入内存（JSON 文件 / Redis）
- ⏳ 部分基础已在旧 Phase 3 草稿中

### 3.2 快路径（Spread-Scanner 信号触发）
- 🔲 技术分析（Brale 逻辑移植）
- 🔲 读内存偏向报告
- 🔲 Risk Team 快速过一遍
- 🔲 直接出决策（目标 < 2 秒）

### 3.3 路由层：信号来源 → 自动选择快/慢路径
- ⏳ `src/router/ExecutionRouter.ts` 已有路由骨架
- 🔲 缺信号源接入 + 自动选择逻辑

**待 Phase 0 决策后启动**

---

## Phase 4 — Python 桥接层 ⏳ 90%（精度待 TV 数据）

### 4.1 评估 TA 里哪些是纯 LLM、哪些是 Python 指标计算 ✅
- 14 个 TV 指标已分类（详见旧 Phase 4.1 审计）
- P0/P1/P2/P3 批次划分完成

### 4.2 通过 child_process 调用 TA 的 Python 核心模块 ✅
- `quant_engine/daemon.py` — Python 常驻进程
- `src/services/PythonBridgeDaemon.ts` — TS 桥接
- JSON 协议 + correlationId 异步匹配 + 2s 硬熔断

### 4.3 JSON 桥接格式定义 ✅
- JSON Schema 已定义（`docs/schemas/`）
- jsonschema 校验通过

### 4.4 验证精度一致性 ⏳
- 框架: `quant_engine/precision_tests/`（base.py + run_all.py）
- Python 端 11 个指标已计算（`docs/python_values/*.csv`）
- 报告模板: `docs/precision_reports/*.json`
- **⏳ 待 TradingView 端导出数据对齐**

### 4.5 指标实现进度
- ✅ P0: Hull Suite / Chandelier Exit / UT Bot Alerts
- ✅ P1: STC / Stochastic Overlay / Mean Reversion / Trend Impulse
- ✅ P2: Elliott Wave / Fibonacci Entry Bands / SR Range / DeltaFlow
- ✅ P1: Volume Profile（Phase 5.2 Tick 精确版回归）
- 🔲 P3: Comprehensive Trading Toolkit / TradeIQ Scalping
- **总计**: 12/14 完成 (85.7%)

---

## Phase 5 — Freqtrade 数据层整合 🆕

### 5.1 CloddsBot 实时行情 → 同步写入 Freqtrade 数据库 🔲
- ⏳ Bitget WS 采集器已就位（`src/data/collector.ts`）
- 🔲 Freqtrade DB schema 调研 + 适配器
- 🔲 写入 Freqtrade `trades` / `ohlcv` 表

### 5.2 交易日志双向同步 🔲
- 🔲 CloddsBot 决策 → 写入 Freqtrade `trades` 表
- 🔲 Freqtrade 持仓 → CloddsBot 内存镜像
- 🔲 双向 state machine 防漂移

### 5.3 回测时直接读 Freqtrade 已有数据 🔲
- 🔲 Freqtrade 已有数据复用（避免重拉）
- 🔲 `freqtrade-data-reader` 工具

**前置**: 已有 `E:/Workplace/bitget-trader/` 项目可复用签名逻辑

---

## Phase 6 — 多 Agent 分析层 ⏳ 40%

### 6.1 LangGraph 工作流（4 Analyst → Debate → Manager → Trader → Risk → PM）⏳
- ⏳ 4 Analyst 骨架已定（Bull/Bear/Sentiment/Macro）
- ⏳ Debate 流程已有草稿
- 🔲 Manager / Trader / Risk / PM 节点待实施

### 6.2 接入你的 API ⏳
- ✅ Provider 已支持 GLM-5.2 / orangeai / siliconflow（Phase 1.4 完成）
- 🔲 Agent 节点级配置 + 多模型混搭
- 🔲 失败降级链

### 6.3 State + Memory Log + Checkpoint 🔲
- 🔲 LangGraph state schema 定义
- 🔲 Memory log 持久化
- 🔲 Checkpoint 恢复机制

### 6.4 硬限制节点（仓位上限 / 日亏损上限代码层校验）🔲
- 🔲 仓位上限校验
- 🔲 日亏损上限校验
- 🔲 KillSwitch 联动（已有 KillSwitch.ts 骨架）

---

## Phase 7 — Hermes 握手协议 + Quant Terminal ✅（7A/7B/7C 已合并）

> Phase 7 拆分为三个明确子阶段：**7A**（握手契约与生命周期核心，已合并）、
> **7B**（绑定握手核心到权威网关传输，已合并）、**7C**（只读 Trading & Research
> Workbench V1，已通过 PR #121 合并）。

### Phase 7A — Hermes 握手契约与生命周期核心 ✅ 已合并

- **PR**: #118（`feat(hermes): Phase 7A handshake contract and lifecycle core`）
- **批准 head**: `ccacd2015abb8c04352131c991d08fb1e6df6470`
- **合并提交**: `dfa04607b65195aa208868b7cc5570d9365ea772`
- **落地组件**（`src/hermes/`）:
  - `createHandshakeCoordinator` — 健康优先的拉取授权状态机（单次收据 / TTL / generation / 容量 / 超时 / 熔断）
  - `createLifecycleHookRegistry` — 绑定现有网关生命周期的类型化钩子注册器
  - `createFlushNotifier` — 严格单调的配置 flush 通知契约（可注入 sink，默认 fail-closed）
  - `createHandshakeCircuitBreaker` — 健康确认专用 fail-closed 熔断器
- **测试**: 63 个 Phase 7A Hermes 测试全部通过

### Phase 7B — 绑定 Hermes 握手核心到权威网关传输 ✅ 已合并

- **PR**: #119（`Phase 7B — Hermes Gateway Production Wiring`）
- **批准 head**: `f8219b8a78bb753dbf51fc7acc498853dee73587`
- **合并提交**: `c4dc26910e84677ec7ca7cb261d2ccf44772297c`

- 将 Phase 7A 的 `LifecycleHookRegistry` / `HandshakeCoordinator` 绑定到唯一的应用生命周期
  事实（`createGateway()` 及其返回的 `AppGateway` start/stop），不引入第二个生命周期真相。
- 在现有 Express 网关（`src/gateway/server.ts`）上新增窄而专用的 Hermes HTTP 传输
  （`/api/hermes`），仅提供三个端点：
  - 认证健康确认 / 收据签发
  - 认证单次收据指令拉取
  - 认证无收据状态 / 诊断快照（仅计数与状态）
- 独立于开发友好型 `requireAuth` 的专用凭证（`HERMES_BRIDGE_TOKEN`），
  仅 Authorization Bearer header，常数时间比较，绝不记录 token / 收据 / 指令。
- 生产指令供给保持 fail-closed（本阶段不接任何真实交易指令源，不运行 Paper/Testnet/Live）。
- 配置热重载成功后触发一次严格单调 flush 通知；失败重载不 flush。
  （Hermes 0.20.0 无专用 config-flush 监听端点，不误用 chat/responses//v1/runs。）

### Phase 7C — DSbot Quant Terminal（只读 Trading & Research Workbench）✅ 已合并

- **PR**: #121（`Phase 7C — DSbot Quant Terminal V1 Implementation`）
- **实现 head**: `6a0a62ff59f6070b6026462abf987c4ce7606a0f`
- **合并提交**: `3f6918e317e608580dfcd565138432be9bebcd21`
- **当前状态**: React/TypeScript/Vite/TanStack Query 展示层、共享类型化查询层和
  GET-only API 已合并；未挂载的权威运行时来源仍按契约显示 `UNAVAILABLE` / `UNKNOWN`。
- **V1 信息架构**: Overview / Market / Trading / Research / AI-Policy / Safety /
  Operations / Data / Settings；相关子域使用页内 tab，Project Control Center 保持
  Operations / Engineering Evidence。
- **真相边界**: 复用 Market / Position / OMS / RuntimeAccounting / TradeLifecycle /
  Recovery / Reconciliation / LIVE_READY / Hermes 的现有权威读面；浏览器只渲染
  确定性只读投影，不创建第二套交易真相。
- **研究边界**: 预留 Provider → Normalizer → Canonical Research Dataset → Research
  Storage/Compute → Evidence 的扩展点；A 股/抓取/AI 数据不得直达 OMS，也不得成为
  Recovery、Reconciliation 或 LIVE_READY 证据。
- **已实现路由域**: Overview / Market / Trading / Research / Policy / Safety /
  Operations / Data / Settings；相关子域使用页内 tab，Project Control Center 保持在
  Operations / Engineering Evidence。
- **只读传输**: `/api/workbench/v1` 仅注册 GET 资源；POST / PUT / PATCH / DELETE
  返回 405，且不能触发读提供者或任何执行路径。
- **明确排除（V1）**: 无 start / stop / order / close / retry / risk-limit /
  reconcile / live-ready 等控制能力；不实现 DataHub、Docking、A 股 Provider、
  优化器、工作流编辑器或 MCP 扩展。
- **运行时约束**: 当前应用网关并不持有 `ProductionSpine`，因此网关适配器不创建第二个
  spine；未挂载的 Market / Position / OMS / Accounting / Safety 权威来源在 UI 中明确
  显示 `UNAVAILABLE` / `UNKNOWN`，绝不伪造健康、空仓或 `LIVE_READY`。
- **契约文档**: `docs/phase-7c-read-only-workbench-contract.md`。
- **权限边界**: 合并未改变 Paper / Testnet / Live 权限；Quant Terminal 仍为只读展示层。

---

## Phase 8 — 权威生产运行时组合 + 功能模块接入 ⏳ 30%

### Phase 8A — 权威生产运行时组合契约门 ⏳ Draft

- **基线**: `feature/orangeai-split@3f6918e317e608580dfcd565138432be9bebcd21`。
- **当前事实**: 生产应用仍未拥有 `ProductionSpine`；`createGateway()` 的 Workbench
  只挂载应用生命周期和 Hermes，不能读取 Market / Position / OMS / Accounting / Safety
  的权威运行时事实。
- **冻结方向**: `createGateway()` / `AppGateway` 作为最小应用组合与生命周期边界，
  按显式 `{exchange, accountId}` 只拥有一个 Production Runtime / `ProductionSpine`；
  Recovery、Reconciliation 与 Workbench 必须使用同一实例。
- **安全与持久化**: 生产所有者必须显式提供 durable `FileEventJournal`、
  `PaperLedgerStore`、合法 collector `MarketDataRuntime` 与同账户 canonical KillSwitch
  hard-risk 来源；缺失时 fail closed，不使用内存/假 CLEAR 兜底。
- **启动边界**: 应用启动不提交订单、不授予 LIVE_READY、不启用 Testnet/Live。
- **交付物**: `docs/phase-8a-authoritative-production-runtime-composition-contract.md`、
  `src/runtime/production/ProductionRuntimeCompositionContract.ts` 与聚焦契约测试。
- **未完成**: 本阶段仅为 Contract Gate，尚未实现生产组合、运行时创建或 Workbench
  权威绑定，不得宣称 Phase 8A implementation complete。
- **Phase 8B 延后**: Project Control Center / Hermes activity 跨进程只读桥接、通用
  observability IPC 与事件聚合延后到 Operations Evidence Read Bridge。

### 8.1 行情数据层（CCXT + Freqtrade 数据源双写）⏳
- ✅ `src/data/collector.ts` — Bitget WS 采集器就位
- ✅ `src/data/volume-engine.ts` — 量能引擎就位
- ✅ `src/data/volume-api.ts` — MCP 工具接口就位
- 🔲 CCXT 现货 + 期货对接
- 🔲 Freqtrade 数据写入

### 8.2 CEX 期货执行 ⏳
- ⏳ `E:/Workplace/bitget-trader/` 已有签名逻辑可复用
- 🔲 Bitget / Bybit 期货下单通道
- 🔲 滑点保护 + 失败重试

### 8.3 预测市场（Polymarket / Kalshi，可选）🔲
- 🔲 Polymarket API 接入
- 🔲 Kalshi API 接入（可选）

### 8.4 Solana / EVM ⏳
- ✅ Solana 模块已有（`src/agents/handlers/solana.ts`）
- ⏳ 暂保持现状，不拆分

### 8.5 风控引擎 ⏳
- ⏳ VaR/CVaR 计算框架已部分就位
- 🔲 熔断机制深化
- 🔲 硬限制节点联动

---

## Phase 9 — 系统集成 🔲

### 9.1 Hermes cron 调度 CloddsBot 多 Agent skill 🔲
- 🔲 Cron 配置绑定
- 🔲 Skill 触发链

### 9.2 Spread-Scanner 信号 → CloddsBot 快路径 🔲
- 🔲 Spread-Scanner 输出格式对接
- 🔲 信号 → 快路径自动触发

### 9.3 TradingAgents 报告作为 CloddsBot 的 Analyst Team 输入 🔲
- 🔲 TradingAgents 输出格式适配

### 9.4 Brale 退役，代码归档到 E:/Workplace/archive/ 🔲
- 🔲 Brale 项目归档
- 🔲 相关文档归档

---

## Phase 10 — 审核与验证 🔲

### 10.1 代码审核（tsc + lint）🔲
- ⏳ 当前 TS 编译有 8 个历史债务错误（不在新代码中）
- 🔲 全量 lint cleanup

### 10.2 API 连通性测试（所有 key 逐一验证）🔲
- 🔲 Bitget API
- 🔲 Bybit API
- 🔲 Polymarket API
- 🔲 GLM-5.2 / orangeai / siliconflow

### 10.3 端到端测试（Mock 交易跑 48 小时）🔲
- 🔲 48 小时连续运行
- 🔲 关键指标收集

### 10.4 延迟测试 🔲
- 🔲 快路径 < 2 秒
- 🔲 慢路径 < 60 秒

### 10.5 输出
- 审核报告（`docs/audit_report.md`）
- 通过 / 不通过清单

---

# APPENDIX A — 旧 Phase 进度档案（归档参考）

> 以下是 2026-07-06 之前的 4-Phase 流程归档，已被上面 10-Phase 替代，仅作历史参考。

## 旧 Phase 0-1: 基础合并 + Provider 改造 ✅
- 2026-06-30: CloddsBot 项目合并 + Provider 改造启动
- 2026-07-01: Provider BASE_URL 注入 + Fallback Chain 完成

## 旧 Phase 2: Claude → OpenAI 桥接层 ✅
- 桥接层完成 / 单元验证通过

## 旧 Phase 3: Multi-Agent 分析层骨架 ✅
- 4 Analyst 骨架草稿完成

## 旧 Phase 4: Python 桥接层 ✅
- 4.1 14 个 TV 指标分类完成
- 4.2 daemon.py + PythonBridgeDaemon.ts
- 4.3 JSON Schema 标准化
- 4.4 Bridge Benchmark 骨架
- 4.5 P2 批次 4 指标完成
- 4.6 精度基准测试框架就绪 (待 TV 数据)

## 旧 Phase 5: 统一数据层 ✅
- 5.1 src/data/ 四件套完成
- 5.2 Volume Profile Tick 精确版回归
- 12 个指标 INDICATOR_DISPATCH 全通过 (11/12 OK, 1 数据不足边界)

---

# 已落地资产清单

## TypeScript 代码（src/）
- `src/data/` 统一数据层四件套 (types/collector/volume-engine/volume-api)
- `src/providers/` Provider 抽象 + Fallback Chain
- `src/router/` 路由 + KillSwitch
- `src/services/PythonBridgeDaemon.ts` Python 桥接常驻守护
- `src/pipeline/FastPipeline.ts` + `SlowPipeline.ts` 快慢分道骨架
- `src/agents/handlers/solana.ts` Solana 模块

## Python 代码（quant_engine/）
- `quant_engine/daemon.py` — 指标计算常驻进程 (12 指标注册)
- `quant_engine/indicators/` — 12 个指标实现 (VP 走双模式)
- `quant_engine/precision_tests/` — 精度基准测试框架
- `quant_engine/bridge_protocol.py` — JSON 桥接协议

## 文档（docs/）
- `docs/python_values/*.csv` — 11 个指标 Python 端计算结果
- `docs/precision_reports/*.json` — 精度报告模板（待 TV）
- `docs/schemas/` — JSON Schema
- `docs/all_indicators_pine_v2.txt` — 14 个 Pine 指标源
- `docs/CHANGELOG.md` + `docs/PHASE_PROGRESS.md`

---

# 接下来优先级

## 立卷新工（按优先级）
1. **Phase 0**: 延迟基准测试（1 天，决定 Phase 3 是否必须）
2. **Phase 9.4**: Brale 退役归档（清理工作区前置条件）
3. **Phase 5.1**: Freqtrade 数据层调研（数据冗余消除前置）

## 等待外部依赖
- **Phase 4.4**: 等待 TradingView 端导出数据完成精度验证

## 长期阻塞
- **Phase 3**: 等 Phase 0 决策
- **Phase 7-10**: 等 Multi-Agent 主流程跑通后启动
