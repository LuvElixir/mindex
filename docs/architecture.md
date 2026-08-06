# Mindex 架构决策

日期：2026-07-21。所有选型都经过当日联网调研 + 本机实测验证（四个研究方向：平台连接器合规、claim–evidence 建模、本地混合检索、API/MCP 层）。

## 总览

单进程 Node 服务（Fastify 5）+ SQLite（better-sqlite3, WAL）+ React/Vite 前端，由同一进程静态服务。local-first：全部状态在 `data/` 目录；部署到服务器 = 换个 host 跑同一进程。

```
项目 → 研究运行(run) → 连接器发现 → documents(URL身份) → snapshots(不可变内容快照)
                                                    ↓
        claims(原子结论) ←——— claim_evidence ——— evidence(逐字引文+偏移)
          ↓ 置信度/分档/审核路由        ↓ stance: supports/refutes/mentions
        conflicts / revisions / review_queue
          ↓
        search / context-pack / MCP  →  下游创意 Agent（API Key 鉴权）
```

## 关键决策与理由

### 1. SQLite + better-sqlite3（弃 node:sqlite / 外部数据库）

- 单机单文件、零运维，匹配 local-first 与单服务器部署；WAL 模式下读写并发够用（知识库量级：单项目千级 claim）。
- better-sqlite3 v13 起 N-API 预编译随包分发，Node 24 安装免编译；同步 API 让存储层保持简单事务语义。
- Node 24 内置 `node:sqlite` 实测同样支持 FTS5，但仍处 RC 期；生产选生态成熟的 better-sqlite3，接口相近，未来可低成本切换。

### 2. 溯源链是结构，不是约定

`source →  document → snapshot → evidence → claim` 五层：

- **document** 是 URL 身份，**snapshot** 是某次抓取的不可变内容（sha256 + 原始 payload 落盘 `data/snapshots/`）。同 URL 内容不变时不产生新快照。
- **evidence.quote 在写入时强制校验必须是 snapshot.text 的（宽容空白/标点宽度差异的）子串**，校验失败抛 `GroundingError` 拒绝入库。这使“幻觉引用”在结构上不可能存在，而不是靠 prompt 约束。抽取器（无论 LLM 还是启发式）给出的引文对不上原文时，整条 claim 被丢弃并记录到运行事件（防幻觉计数）。
- claim 的每次状态变化写 `revisions`（actor/action/before/after），冲突、合并、版本更替全程可审计。

### 3. Claim 类型学：真实性与代表性分轴

借鉴 Wikidata（rank/qualifier/reference 分离）与 FEVER（三态 stance）：

| 类型 | 置信度含义 | 计算 |
|---|---|---|
| official_fact / system_inference | 为真的概率 | log-odds 因子叠加 + 上限规则 |
| player_opinion | 观点在人群中的**代表性** | Wilson 95% 下界（aspect 条件化的 prevalence）|
| creative_insight | 启发强度 | 封顶 likely，永不 verified |

置信度因子（每个都落库、UI 可见）：来源权威先验、证据直接性、独立支持源数（对数收益+封顶）、跨源数值一致性、时效、原创性（疑似营销扣分）、反驳证据、抽取自评。上限规则：单一独立来源封顶 0.70；官方事实无官方级来源封顶 0.75；推断 ≤ 0.85×最弱前提。**证据不足输出 `insufficient` 且 confidence=NULL**（不是 0.5——“不知道”必须与“五五开”可区分）。点赞/热度/搜索排名不进入任何真实性因子。

### 4. 独立性先于计数

交叉验证前先做两层折叠：同 `owner_key`（同一主体的官网+官微算一个）与同近重复簇（simhash 汉明≤3 / 短文本 jaccard≥0.82）。“一篇通稿发 20 个平台”只算 1 个独立源，防止假三角验证。评论批次跑 astroturf 启发式（批内近重复率 + 24h 时间爆发），命中即打折并入审核队列——只用公开可得信号，不虚构账号图谱能力。

### 5. 时效：supersession 优先于冲突

同槽位（predicate + 版本区间）的新旧数值差异按**版本更替**处理：旧 claim 关闭有效期（`valid_until`）、降 rank、指向 `superseded_by`——不删除（支持“当时我们知道什么”的审计查询）。无法用版本解释的数值/语义矛盾才开 conflict，并强制双方 disputed + 隔离，直到人工裁决（A 胜 / B 胜 / 语境不同并存 / 误报）。

### 6. 中文检索：jieba 预分词 + FTS5（实测淘汰 trigram）

实测结论：FTS5 默认 unicode61 把连续汉字当一个 token（等于没有中文分词）；trigram 无法命中两字词（“保底”“优化”这类最高频查询单元）。方案：写入时 `@node-rs/jieba cutForSearch`（粗细双粒度）预分词存入 contentless FTS 表，查询同法切分 OR 连接；FTS 召回不足时 LIKE 子串兜底。三路（claim 文本 / 证据命中 / 子串）RRF(k=60) 融合后做可解释乘法重排（置信度 × 时效 × rank），排序因子随结果返回。语义向量检索留作可选增强（transformers.js 433MB 安装体积，对千级规模收益不值默认引入——这是刻意的不过度设计）。

### 7. LLM 三档 provider，能力如实入库

`anthropic`（官方 SDK + prompt caching）→ `claude-cli`（shell 出本机已登录的 Claude Code，零凭证）→ `none`（纯启发式）。每条 claim 记录 `extraction_provider`；降级路径在运行事件里显式说明，绝不假装有 LLM 能力。启发式路径依然可靠：商店元数据是我们自己生成的结构化格式（逐行解析成官方事实），评论口碑走 aspect 词典聚合。

### 8. 双平面 API

- **管理平面 `/app/*`**：admin token（启动时生成/env 注入），服务 Web UI，OpenAPI 中隐藏。
- **Agent 平面 `/api/v1/*`**：API Key（`mdx_live_` 前缀 + 只存 sha256 + last4 展示 + 一次性明文）、资源级 scope（`knowledge:read` / `context:read`）、**项目级硬隔离**（越权 403）、按 Key 限流（内存 store）、全量调用日志。轮换保留 24h 宽限期。OpenAPI 3.1 由 zod schema 生成（fastify-type-provider-zod v7），Scalar 渲染文档。
- **MCP**：stdio 薄层代理 REST，Key 走 env——鉴权/限流/审计天然复用 REST 层，不重复造安全面。

### 9. 研究 Agent = 确定性管线 + LLM 决策点

管线骨架是确定性代码（可测试、可断点续查），LLM 只在四个决策点介入：研究规划（问题/关键词/选源）、叙述文本抽取、评论主题归纳、覆盖度评估（不足 → 扩展关键词进入下一轮）与语义冲突判定。LLM 输出全部过 zod 校验 + 引文 grounding 校验，解析失败回退启发式并记录。

## 抱抱米（baobaomi）复用

抱抱米是配套生产服务，已在采集抖音/B站/TapTap 并暴露 Agent API（MCP over HTTP）。Mindex 把它做成一个 **原始内容 Connector**：通过 MCP `tools/call` 拉取 `get_hot_creatives`（品类爆量素材，带真实抖音链接、投放强度、点赞、增速、AI 拆解）、`get_trending_topics`（热点）、`search_creative_library`（更细的钩子/旁白拆解），按项目名/别名过滤后灌入 Mindex 的 snapshot→抽取→评分管线。

设计要点回应"抱抱米给模型的 context 不够优质"：抱抱米直接给创意 Agent 的是原始爆款列表；Mindex 则把每条内容抽成原子 claim、grounding 回具体抖音视频 URL、跨条目交叉验证、算可解释置信度、去重、标注冲突，最后打包成带引用的 Context Pack。下游拿到的是"这个卖点在 N 个独立爆款中出现（附链接）+ 置信度"，而非视频堆。抖音 UGC 的 authority_prior 保守（0.4–0.45），Context Pack 中标记只可转述。key 未配置时连接器 needs_key、跳过。

## 已知边界（诚实清单）

- 语义向量检索未默认启用（见 §6）；接口留在 search 层，可后装。
- 评论覆盖上限受平台限制（App Store RSS 数百条级），UI/来源页如实展示抓取范围。
- LLM 语义冲突判定每轮限量（成本控制），规则层（数值/版本）全量跑。
- 单进程内存限流/运行锁——多实例部署需要外部化（超出 MVP 范围）。
