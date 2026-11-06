# AI 陪伴双模型实验对话控制台

一个 AI 陪伴产品的静态数据验证实验台：**Director** 模型先理解用户、分析记忆、（视模式）制定交流策略，输出结构化的 Dynamic Conversation Brief；**Generator** 模型再据此生成自然回复。网页控制台用于人工体验回复质量并观察中间产物。全部用户数据来自本地静态 JSON（画像、记忆、情绪、关系），不接数据库。模型为 qwen3.7-flash（阿里云百炼，OpenAI 兼容模式）。

## 架构

```
用户（浏览器）
   │  POST /api/chat (SSE)
   ▼
┌──────────────────────────────────────────────┐
│ Orchestrator（编排）                          │
│  ├─ A/B：单模型，直接组装全量/精选数据 ─────────┐   │
│  └─ C/D：Director → JSON提取 → Ajv校验 ────┐  │   │
│              → 记忆白名单 → (失败:修复重试→降级) │  │   │
│                                              ▼  ▼   │
│                                     Generator（流式） │
│                                            │        │
└────────────────────────────────────────────┼────────┘
                                             ▼
                                    JSONL 实验日志（results/）
```

## 准备

1. Node.js 24 / 26 LTS
2. 安装依赖：`npm install`
3. 复制 `.env.example` 为 `.env`，填入 `DASHSCOPE_API_KEY=` 你的百炼 API Key（在百炼控制台 https://bailian.console.aliyun.com 的「API-KEY 管理」中创建；需先开通百炼模型服务）

## 启动

```bash
npm start
```

服务监听 `127.0.0.1:3000`（端口可用环境变量 `PORT` 修改），浏览器打开 http://127.0.0.1:3000 。

启动时若缺少 `DASHSCOPE_API_KEY` 会直接报错退出，请先完成上面的 `.env` 配置。

## 控制台调试日志

`npm start` 的那个终端会打印**每次调用大模型的完整输入与输出**，用于人工调试观察（无需打开浏览器 DevTools）：

- **请求**：`▶ Director 请求 / ▶ Generator 请求`，含 `model / temperature / thinking: on|off / stream: true|false / format: json_schema|json_object|none`，以及 `messages` 的逐条完整内容（system 与 user 全文，多行不缩进，便于复制）。首轮请求标题不带任何次数；两类「第二次」用不同措辞区分：
  - `▶ Director 请求 · 修复重试` —— Director 输出校验失败后的**修复重试**（模型调用第 2 次）；
  - `▶ Generator 请求（format 已回退至第 2 级：json_object）` —— `response_format` 被供应商拒后的**格式降级**（不是重试 N 次）。
- **响应**：`◀ Director 响应 / ◀ Generator 响应`，含整体耗时（`7.3s (7300 ms)`）、`in / out` token、`firstToken`（「请求发出 → 首个 token」的真实延迟；未测到时不显示该字段）；先打印 `── reasoning ──`（思考全文，开启思考时可达数千字），再打印 `── content ──`（正文全文）。
- **错误**：`✖ … 调用失败`（红色），含错误类型、HTTP 状态、当时所处的 `format:` 档位与响应体片段。
- **轮次汇总**：`■ 轮次完成 | 模式 C | 总耗时 … ms | Director … ms | 成本 ¥… | 降级 否`，随后一行 `Brief 摘要：情绪 [疲惫 0.90, 虚无 0.80] | 策略 … | 记忆 M003, M026, M001`。A/B 为单模型路径，既不显示 `Director … ms` 也不显示 `降级 …`（无 Director、无降级概念）；C/D 缺 Brief 时区分「Director 校验失败已降级」与「无 Brief」。

不同模式的日志组数：

| 模式 | 日志组 |
|---|---|
| A / B（单模型） | 只有 1 组 Generator 请求/响应 |
| C / D（双模型） | Director 一组 + Generator 一组（另有轮次汇总） |

补充说明：

- Director 校验失败触发修复重试时，会出现**第二组** `▶ Director 请求 · 修复重试` 日志（可对比两次输入的差异）。
- `response_format` 被供应商拒绝时会逐级回退（`json_schema → json_object → none`），每次回退尝试都会打一组请求日志，标题带 `（format 已回退至第 N 级：…)`——这是预期行为，可据该后缀与 `format:` 字段观察降级过程。
- 客户端断开（关闭页面）导致的 `AbortError` 也会打印一组错误日志。

环境变量（写入 `.env`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOG_MODEL_IO` | `on` | 设为 `off` / `0` / `false`（不区分大小写）时关闭本模块的全部控制台输出（请求/响应/错误块/轮次摘要），不影响 `results/` 下的 JSONL 实验日志；`response_format` 被拒时的 `console.warn` 降级告警属于运行告警，不受此开关控制 |
| `LOG_MAX_CHARS` | `0` | 单段文本（一条 message / content / reasoning）打印上限；`0` 为不截断，正整数时超长部分截断并标注 `…（已截断，共 N 字符）` |
| `NO_COLOR` | 未设置 | 设置任意非空值即禁用 ANSI 颜色（默认仅在 TTY 终端下着色：请求=青、响应=绿、错误=红、分隔线与摘要=灰） |

日志全部走 `console.log`（stdout），可直接用 `npm start > run.log 2>&1` 重定向留档。

## 实验模式（A/B/C/D/E 五组对照 + R 智能路由）

| 模式 | 架构 | 上下文 | 验证目的 |
|---|---|---|---|
| A | 单模型 | 注入**全部**静态数据（persona + 画像 + 全部记忆 + 情绪 + 关系 + 历史） | 基线：不加筛选、不做理解时，个性化与聚焦度如何 |
| B | 单模型 | 同 A，但记忆只注入 `curated: true` 的精选子集 | 「人工理想筛选」能带来多大提升（记忆质量的对照组） |
| C | 双模型 | Director 输出完整 Brief（含 conversationStrategy）→ 校验 → Generator | 引入理解与策略规划后的回复质量上限 |
| D | 双模型 | Director 只做理解与记忆分析（**不输出策略**）→ Generator | 拆分变量：策略本身贡献了多少（C - D 即策略的净效应） |
| E | 双模型 | **C + Character Agency**：额外注入角色自身认知（`character_core` 稳定层 / `character_state` 动态层），Director 额外输出 `characterContribution`（本轮角色自己的观点/兴趣/待续话题 + 主动方式 + 观点强度） | 拆分「角色主体性」的净增量：E - C 即「角色有自己的观点和兴趣」带来的收益 |
| R | 智能路由 | Router 判定：简单对话（问候/闲聊/应答）→ **Fast Path**（Generator 直答，轻量上下文无记忆）；复杂消息（情绪/记忆/画像/推荐/长文）→ **Cognitive Path**（完整 C 链路）；安全信号强制 Cognitive | 验证「避免不必要的认知计算」：简单消息的延迟收益 vs 复杂消息的质量保障 |

A/B/C/D/E 使用同一套静态数据与人格，仅注入方式与流程不同，便于横向对比；R 为工程化模式（对应 PM 性能方案第二节的三种处理路径）。

### 角色主体性（Character Agency，E 模式）

核心思想：**用户认知与角色认知是两套独立数据**——用户喜欢 RPG 不代表角色也喜欢。

| 数据 | 文件 | 性质 |
|---|---|---|
| 用户认知 | `user_profile.json` / `memories.json` / `emotion.json` / `relationship.json` | 关于**用户**的画像、经历、情绪、关系 |
| 角色认知·稳定层 | `character_core.json` | 角色是谁、价值观、偏好、**观点强度策略**（strong/lean/uncertain 何时用哪种） |
| 角色认知·动态层 | `character_state.json` | 角色当前关注（currentInterests）、观点（currentOpinions，带 stance/reason/confidence）、待续话题（openTopics）、近期贡献、主动度默认值 |
| 表达层 | `persona.json` | 怎么说话（语气/风格/边界）——与「怎么想」分工 |

Director 在 E 模式额外输出 `characterContribution`：`hasContribution` / `topic` / `stance` / `basis` / `strength`（strong/lean/uncertain/none）/ `initiative`（low/moderate/high）/ `initiativeMove`（none/share_opinion/continue_topic/explore/share_interest）。Generator 把它当**候选而非任务**，不合适就不说；同时硬约束禁止「每句话都塞我觉得」这种新的模板化。

**验收用例**：`data/test_cases.json`（六类场景：稳定偏好 / 观点分歧 / 无明确问题 / 建议型无聊 / 多轮一致性 / 信念修正）。三个量化指标：**角色自主表达率**（适合表达观点的场景里是否真的贡献了想法）、**观点一致性**（不同问法下立场是否连续）、**自然交流度**（主动表达是否自然，而非为展示人格刻意堆内容）。每轮 `metrics.*` 记录 `characterHasContribution / characterInitiative / characterMove / characterStrength / characterTopic`，可直接从 `results/*.jsonl` 统计。

**已知边界**：`character_state` 第一阶段为静态种子 + 手动维护，未做自动写入——自动更新（post-turn worker 提取观点变更）需限制单轮变更幅度并记 changelog，否则会观点漂移（参考 Shikigami Persona Evolution 的 0-2 处变更 + 可回滚模式）。

### R 模式的路由引擎（双实现，自动选择）

- **规则引擎**（默认，零成本）：安全词表（强制认知路径）→ 情绪词表 → 记忆/个性化词表 → 问候/应答模式 → 长度判断 → 不确定时保守走认知路径。每条路由结果带理由与置信度，前端「路由决策」卡片可见。
- **百炼决策模型**（可选）：`.env` 配置 `DECISION_WORKSPACE_ID` 后启用 `decision-model-preview`（TypeSafe System One 协议，~50ms）——一次前向同时返回路径 choice 与安全信号 noul 的概率分布与置信度；决策模型不可用时自动降级规则引擎。开通方式：百炼控制台开通业务空间并获取 WorkspaceId。

## 目录结构

```
experiment/
├── public/            # 前端（单页，原生 JS/CSS，离线可用）
├── data/              # 静态数据：persona / user_profile / memories / emotion / relationship
│                      #   + character_core（角色稳定认知）/ character_state（角色动态认知）/ test_cases（主体性用例）
│   ├── character/     # 学习系统数据：core / interest_seeds / state / knowledge / beliefs / queue / history
│   └── research/fixtures/  # 本地研究资料（模拟网页，含低质量与提示注入样本）
├── scripts/           # demo-learning.js（自主学习闭环演示）
├── src/learning/      # curiosity-engine / research-pipeline / reflection-engine / evolution-evaluator / commit-evolution / rules / store
├── schemas/           # director-brief.schema.json（Ajv draft-07，C/D/E 由代码派生变体）
├── prompts/           # director.system.md / generator.system.md
├── src/
│   ├── server.js        # 原生 node:http：静态文件 + API（/api/chat SSE、/api/data）
│   ├── orchestrator.js  # 编排：上下文组装、调度、校验、降级、指标、日志
│   ├── director.js      # Director 调用、JSON 提取、修复重试；D 模式裁剪策略段
│   ├── generator.js     # Generator 消息组装（A/B 与 C/D 两套）与流式生成
│   ├── model-client.js  # qwen3.7-flash 客户端（原生 fetch，超时/重试/思考模式关闭）
│   ├── validators.js    # Ajv 校验、记忆白名单校验、JSON 提取
│   ├── console-logger.js # 控制台模型 IO 调试日志（完整上下文/返回/耗时）
│   └── logger.js        # JSONL 实验日志（results/session-*.jsonl）
├── results/           # 运行时写入的实验日志
└── .env.example       # 环境变量样例
```

## API

- `POST /api/chat`：`{message, mode: "A"|"B"|"C"|"D"|"E"|"R", history: [{role, content}], includeThinking?: boolean, enableSearch?: boolean}`，响应为 SSE 流，事件序列：`stage(director)` → `reasoning`(多次，仅开启思考时) → `brief` → `stage(generator)` → `reasoning`(多次，仅开启思考时) → `delta`(多次) → `done`；出错发 `error`。A/B 模式跳过 director/brief 两步。后端无状态，历史由前端传入。
  - `includeThinking`（默认 false）：开启 qwen3.7 思考模式（`enable_thinking: true`），Director 与 Generator 的思考过程通过 `reasoning` 事件实时流出（`{text, source: "director"|"generator"}`），前端展示在回复气泡上方的「思考过程」折叠区。注意：思考会显著增加耗时与 token 消耗，默认关闭。
- `enableSearch`（默认 false）：开启**联网搜索工具模式**（对齐 Yodada 的 function calling 设计）——Generator 挂载 `web_search` 工具（阿里云 IQS 统一搜索，需配置 `IQS_API_KEY`），模型按工具描述中的调用原则**自主决定是否搜索**；搜索结果以「标题/来源/链接/摘要」Markdown 回填（前 5 条，带来源）。适用场景：实时资讯、新闻、特定实体查询、用户明确要求搜索；闲聊与情绪陪伴不会触发搜索。工具调用过程经 `tool_call` / `tool_result` 事件实时可见（前端显示「🔧 正在联网搜索…」状态条）。
- **时间工具**（始终挂载，零成本）：`getLocalTime` function calling 工具（模型按需查询当前本地时间，含星期与时区）；与每轮的运行时时间注入（见下）构成双保险——同 Yodada 的 TimeSituationInjector + TimeFunctionProvider 设计。
- **运行时时间注入**（始终开启，无需参数）：每轮对话的 Director 与 Generator 输入中自动注入「当前时间（系统运行时时钟，UTC+8）」——涉及时间判断（今天星期几/现在几点）一律以此时钟为准，模型不会用训练数据或静态记忆充当当前时间。
- **CompanionMem 长记忆**（配置 `CM_API_URL` / `CM_API_KEY` 后启用，优先级最高）：C/D/E/R 模式的 Director 候选记忆从 Yodada 生产同款 CompanionMem 服务实时召回——记忆带 **L0 原始对话 / L1 蒸馏摘要分层**、归属人、事件时间、置信度元信息；recall 响应的 **context 分区**（state：心情/身体/压力；relation_state：态度/信任/亲密/冲突/边界）有值时会覆盖 Director 输入中的静态情绪/关系数据（无值时保持 `data/emotion.json` / `data/relationship.json` 兜底）。
  - **默认测试设备**：`CM_AGENT_ID` 未配置时自动使用写死的测试设备 `c8:47:8c:de:ad:01`（与生产记忆完全隔离），并**默认开启写入闭环**——实验台的每轮对话会异步写入并触发服务端蒸馏（L0→L1），后续轮次即可召回，形成「对话→记忆→召回」的自演化测试体。
  - 接 Yodada 生产设备时显式配置 `CM_AGENT_ID`（此时写入必须显式 `MEMORY_WRITE=on`，防止污染生产记忆库）。
- **Mem0 长记忆**（配置 `MEM0_API_URL` / `MEM0_API_KEY` / `MEM0_AGENT_ID` 且 CM_* 未配置时启用）：Director 候选记忆从 Mem0 实时检索（Yodada 上一代记忆方案，扁平记忆无分层，top 8 / threshold 0.3）。未配置任何记忆服务时使用静态 `data/memories.json`（A/B 对照组始终用静态数据，保证实验可比性）。当前轮实际使用的记忆源会显示在启动横幅与 JSONL 日志的 `memorySource` 字段（`companionmem` / `mem0` / `static`）。
- `GET /api/data`：返回全部静态数据 JSON（前端「数据」面板用）。
- `POST /api/reset`：后端无会话状态，重置在前端本地完成，此接口仅返回确认。
- `POST /api/memory/reset`：**清空默认测试设备（c8:47:8c:de:ad:01）在 CompanionMem 的全部记忆**——测试前重置用（前端「清空测试记忆」按钮）。安全限制：当前配置了非默认 `CM_AGENT_ID`（如 Yodada 生产设备）时返回 403 拒绝，清生产记忆请走 Yodada 侧管理。

每轮会写入 `results/session-YYYYMMDD-HHmmss-SSS.jsonl`（时间戳到毫秒，同一秒内的多个请求不会合并到同一文件；测试运行时写入系统临时目录，不污染 `results/`）：`{timestamp, mode, message, brief, validation, reply, metrics, directorRawOutput, directorReasoning, generatorReasoning}`。metrics 包含 directorLatencyMs、generatorFirstTokenMs、totalLatencyMs、directorTokens / generatorTokens、estimatedCostCNY、degraded、retries；开启思考时 directorReasoning / generatorReasoning 记录思考全文，便于事后分析。

## 角色自主学习与人格演化（Phase 0）

角色不再只靠手写状态：它可以「研究 → 反思 → 演化」，但**核心人格不可被学习流程改写**。

### 闭环

```
对话事件 → Curiosity Engine（候选 + 5 维评分）
        → Research Pipeline（本地 fixture 模拟网页；注入检测）
        → Reflection Engine（候选知识 / 兴趣证据 / 观点更新建议）
        → Evolution Evaluator（approve / hold / reject，六项检查）
        → Commit（版本 + diff + 快照，可回滚）
        → 对话视图（E 模式读取已提交状态）
```

### 命令

```bash
npm run demo:learning           # 完整闭环演示（仅内存，不写盘）
npm run demo:learning:persist   # 同上，且把演化结果写入 data/character/
npm run reset:character         # 从最早快照回滚到 version 0（追加 rollback 记录，不删历史）
npm run test:learning           # 好奇心/研究/兴趣形成/观点修正/人格边界/数据隔离
npm run test:evolution          # 演化提交与回滚
```

### 数据布局（学习系统）

| 路径 | 内容 | 是否可自动演化 |
|---|---|---|
| `data/character/character_core.json` | 身份、气质、价值观、边界、learning_policy、**locked_fields** | ❌ 锁定（reject） |
| `data/character/interest_seeds.json` | 兴趣种子（只是「愿意探索」的方向） | ❌ 由产品配置 |
| `data/character/character_state.json` | 兴趣（seed/emerging/established）、当前关注、待续话题 | ✅ 有门槛 |
| `data/character/character_beliefs.json` | 观点（审美/价值/解释），带证据链与修订历史 | ✅ 有门槛（价值判断须人工审核） |
| `data/character/character_knowledge.json` | 知识条目（必须可追溯到 source_ids） | ✅ |
| `data/character/curiosity_queue.json` | 研究候选队列 | ✅（生成） |
| `data/character/evolution_history.json` | 每次演化的 diff、证据、前后快照 | 只增不改 |
| `data/research/fixtures/*.json` | 本地研究资料（模拟网页，含低质量与注入样本） | ❌ 只读 |

### 关键门槛（`src/learning/rules.js` 可调）

- **兴趣形成**：`seed → emerging` 需 ≥3 次独立研究且跨度 ≥2 天；`emerging → established` 需 ≥5 次且跨度 ≥3 天。**单次曝光永不升级**（同一 taskId 不重复计数）。
- **观点修正**：仅 `high` 可靠性来源可触发；`interpretation` 类可自动登记证据（不自动改写措辞），`value_judgment` / `aesthetic_opinion` 一律 `hold`（需人工审核）。
- **知识入库**：必须带 `source_ids`；低质量来源只入 `uncertain`，且不参与兴趣/观点判定。
- **注入防护**：命中注入模式（中英文指令、HTML 注释、改写 core 等）→ 整篇丢弃，内容**不进入 claims**，只留审计记录。
- **核心身份**：`character_core.locked_fields` 内任何变更一律 `reject`；非锁定字段 `hold`。
- **预算与去重**：近 7 天研究过的子主题跳过；单次研究最多 3 个来源、单来源最多 5 条 claim。

### 与对话的集成

`.env` 配置 `CHARACTER_STATE_SOURCE=learning`（当前已配置）后，E 模式的角色状态来自学习系统的**已提交**状态（经 `toConversationView` 映射，不含候选研究结果）；设为 `static` 则用 `data/character_state.json` 手写基线。启动横幅会显示当前来源与演化版本。

> 实测：跑完 5 轮研究后，E 模式会带着「科幻文学已 established + 时间设定多为炫技（带证据链）」参与对话；C 模式（无角色状态）对同一问题只会泛泛谈阅读感受——这正是主体性净增量的可观察差异。

## 已知边界

- 静态数据不演化：记忆、情绪、关系、角色状态（character_state）不会随对话自动更新（beliefUpdateRequired 仅记录在 Brief 中）；E 模式的 currentOpinions / openTopics 为静态种子，需手动维护或后续接入 post-turn 写入（见「角色主体性」章节的已知边界）。
- Director 校验两次（含一次带错误回传的修复重试）仍失败时，保守降级为 A 组单模型方式生成，绝不让 Director 的 JSON 直接面向用户；前端会出现黄色降级提示条。
- 成本估算为近似值：流式响应若供应商未返回 usage 则记 0 并标注 unknown。
- 后端无会话状态：一次 /api/chat 请求即生成一个 session 日志文件。
- 记忆候选集中刻意包含过期（expired）、相互冲突（disputed）与推断（inferred）记忆，用于观察 Director 的甄别能力。

## 常见问题

- **启动报 401 / 调用返回 401**：API Key 错误或未开通百炼服务，检查 `.env` 中的 `DASHSCOPE_API_KEY`，并确认已在百炼控制台开通服务。
- **思考模式**：qwen3.5/3.6/3.7 系列默认开启思考模式，本项目默认在每次请求 body 顶层显式传 `enable_thinking: false`（避免混入思考内容与额外耗时）；勾选顶栏「显示模型思考」后切换为 `true`，思考过程实时展示在回复气泡上方的折叠区（分 Director / Generator 两段）。
- **思考是英文的**：qwen3.7-flash 的思考语言由模型自选（实测分析类任务多为英文），prompt 指令无法稳定控制（已实测验证），这是模型固有行为而非 bug；思考的判断过程（意图/情绪/记忆取舍）不受语言影响。
- **开启思考后明显变慢且更贵**：正常现象——模型先思考再输出，思考 token 也计费（实测 C 模式一轮约 40-60 秒、成本约为不思考的 4 倍）。观察过程用，日常对照实验建议关闭。
- **响应变慢**：Director 校验失败会触发一次修复重试，指标面板的「Director 修复重试」次数可见；连续失败会降级。
