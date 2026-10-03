> Historical reference preserved on 2026-10-03 before the bilingual README redesign. Setup and release claims below retain their original dates and may be outdated. Start with [the current overview](README.md).

# Mindex ✦

**Index everything. Find insight.**

Mindex 是面向**国内手游买量团队**的知识图谱知识库。为手游创建项目后，通过研究 Agent 自动发现 + 人工导入两条通路积累知识：从真实国内信源抽取原子化知识（claim）并绑定逐字证据（evidence）、去重交叉验证、计算**可解释置信度**，可信知识经过（或跳过）人工审核后，通过带引用的搜索 API、Context Pack 和 MCP 提供给下游创意 Agent（如 AdMuse），也通过知识图谱与对话式检索服务人类编导/策划。

Mindex 不写广告——它让写广告的 Agent 真正理解产品与用户，并且**每句话都能追溯到出处**。

---

## 快速开始

要求：Node.js ≥ 22（推荐 24），npm。

```bash
npm install          # 安装依赖（含 better-sqlite3 预编译二进制、jieba 分词）
npm run build        # 构建前端到 web/dist
npm start            # 启动服务器（API + 管理界面，默认 127.0.0.1:8787）
```

启动后控制台会打印**管理员 Token**（也保存在 `data/.admin_token`）。打开 http://127.0.0.1:8787 用它登录。

```bash
npm test             # 55 个单元 + 集成测试
npm run eval         # 全库 groundedness / 信任边界评测（见 docs/evaluation.md）
```

开发模式（前端热更新，Vite 代理到 8787）：

```bash
npm run dev          # server (tsx watch) + web (vite) 并行
# 打开 http://127.0.0.1:5173
```

### LLM 配置（决定研究 Agent 的能力档位）

| 档位 | 条件 | 能力 |
|---|---|---|
| `anthropic` | `.env` 里配置 `ANTHROPIC_API_KEY` | 最佳：LLM 规划、叙述文本抽取、评论主题归纳、语义冲突判定 |
| `claude-cli` | 本机安装并登录了 Claude Code CLI | 同上，走本地 CLI，零额外凭证（较慢） |
| `none` | 都没有 | 诚实降级：仅结构化元数据抽取 + 关键词口碑聚合，UI/数据中如实标注 |

默认 `MINDEX_LLM_PROVIDER=auto` 自动按上述顺序探测。

**推荐用管理界面「设置」页配置**（模型 Provider / Anthropic API Key / 抱抱米集成）：保存立即生效、无需重启，带「测试连接」实测按钮；密钥只存本机 SQLite，接口只返回尾 4 位。优先级：设置页 > `.env` > 默认值。`.env` 仍然可用（适合部署时注入），见 [.env.example](.env.example)。

---

## 端到端流程（真实可运行）

1. **创建项目**：名称 +别名 + 官网链接 + 描述（管理界面「创建项目」）。
2. **主动研究**：Agent 按买量十类信息需求规划研究问题与关键词 → 在 App Store CN、TapTap、B站、小红书定位产品 → 抓取元数据 / 版本说明 / 玩家评论 / 官网页面 → 全部落为不可变快照。
3. **知识抽取**：每条 claim 必须携带**逐字存在于快照中的引文**——写入时强制校验，对不上的直接丢弃并记录（幻觉引用在结构上不可能入库）。
4. **整合与置信**：同源/转载折叠后统计独立来源 → log-odds 因子叠加 + 上限规则 → 输出 0-1 分数 + 分档（verified/likely/uncertain/disputed/insufficient）+ 逐因子解释。证据不足时诚实输出 `insufficient` 且置信度为 NULL。
5. **审核**：verified/likely 自动进入可信库；uncertain/disputed/insufficient 一律进入审核队列或隔离区，**不会静默变成可信知识**。
6. **覆盖度迭代**：LLM 评估证据缺口 → 扩展关键词 → 自动进入下一轮抓取（最多可配置轮数）。
7. **Agent 消费**：创建 API Key（scope + 项目隔离 + 限流）→ `/api/v1/search`（带引用检索）→ `/api/v1/context-pack`（结构化知识包）→ 或通过 MCP 接入 Claude Code / Claude Desktop。

## Agent 接入

```bash
# 1. 管理界面「Agent 接入」页创建 API Key（明文只显示一次）
# 2. 检索知识（每条带引用、置信度、类型）
curl "http://127.0.0.1:8787/api/v1/search?q=付费&limit=5" \
  -H "Authorization: Bearer mdx_live_..."

# 3. 写广告前拿 Context Pack
curl -X POST "http://127.0.0.1:8787/api/v1/context-pack" \
  -H "Authorization: Bearer mdx_live_..." -H "Content-Type: application/json" \
  -d '{"project_id":"prj_...","task":"为新版本写买量素材","budget_tokens":6000}'
```

- **OpenAPI 3.1 文档**：http://127.0.0.1:8787/api/v1/docs （Scalar UI；`/api/v1/openapi.json` 供机器消费）
- **MCP（stdio）**：`claude mcp add mindex --env MINDEX_API_KEY=mdx_live_... -- npm run mcp --prefix <本目录>`
  工具：`search_knowledge` / `get_claim` / `get_evidence` / `get_context_pack` / `list_projects`。MCP 只是薄代理——鉴权、限流、调用日志全部发生在 REST 层。

Context Pack 的诚实性约束：只含可信知识；每条带 citation（evidence id + 引文 + 来源 + 抓取时间）；UGC 引文标记 `quotable:false`（只可转述）；观点条目带代表性统计（Wilson 下界），与事实分开；未收录的低置信/冲突知识在 `excluded` 中声明数量。

## 部署到服务器

```bash
# 传代码（rsync/tar/git 均可，排除 node_modules/data/.env）→ 服务器上：
npm install && npm run build
# .env（见 .env.example）：MINDEX_HOST=0.0.0.0、admin token、LLM/连接器密钥
pm2 start npm --name mindex --cwd <repo>/server -- run start
pm2 save && pm2 startup    # 开机自启
```

单进程 + SQLite（WAL），前端由同一进程静态服务。管理平面（`/app/*`）由 admin token 保护，Agent 平面（`/api/v1/*`)由 API Key 保护。数据全部在 `data/`（数据库 + 原始快照），备份即拷贝该目录。

**选服务器看网络位置，不是算力**（Mindex 空闲 ~70MB 内存）：要同时够到国内平台（B站/TapTap）和境外 API（TikHub/Anthropic/OpenAI）。**境内机被墙 OpenAI/Anthropic**（只能用 DeepSeek/MiniMax 等国产 LLM，走 OpenAI 兼容 provider）；**新加坡等境外机全部直连**、LLM 随意。B站连接器需 `pip install bilibili-cli`（或 pipx）。对外暴露：绑 0.0.0.0 走内网/WireGuard 访问，或加 nginx vhost + TLS + 开安全组端口。

> 当前生产部署：**https://mindex.luckyloading.com**（openframe-sg 新加坡，nginx+Let's Encrypt，pm2 托管，LLM=DeepSeek）。合规悬挂信息（主体/ICP/公安备案）在「设置 → 网站信息」配置，登录页与页脚显示。

## 项目结构

```
server/src/
  agent/        研究管线：规划 → 发现 → 抽取 → 整合 → 评分 → 冲突 → 覆盖度迭代
  connectors/   数据源连接器（iTunes CN/TapTap/B站/小红书/抱抱米/官网）
  core/         领域核心：store（写入即校验溯源）、confidence、dedupe、grounding、contextPack
  search/       jieba 分词 FTS5 + 证据命中 + RRF 融合 + 可解释重排
  api/          Fastify：Agent 平面（OpenAPI/Key/限流/日志）+ 管理平面
  llm/          anthropic / claude-cli / none 三档 provider
  mcp/          MCP stdio 薄层
  db/           SQLite schema（claim–evidence–snapshot–source 溯源链）
  scripts/      eval（全库评测）
server/fixtures/  录制的真实 API 响应（来源与时间见 fixtures/README.md）
web/              React + Vite 管理界面（设计规范见 docs/设计规范.md）
docs/             架构决策 / 来源合规策略 / 评测方法
```

## 文档

- [docs/architecture.md](docs/architecture.md) — 架构决策与数据模型
- [docs/compliance.md](docs/compliance.md) — 来源合规策略（哪些平台实测接通、哪些只做适配器、为什么）
- [docs/evaluation.md](docs/evaluation.md) — 评测方法（引用完整性、信任边界、观点代表性）
- [docs/设计规范.md](docs/设计规范.md) — 前端视觉与交互设计规范

## 诚实性声明

- 连接器状态如实标注：TapTap 逐条评论因签名墙走「评论批量导入」通路（Hermes 等外部采集），不用 mock 冒充接通。
- 无 LLM 时系统照常运行，但抽取能力降级，事件日志与 `claims.extraction_provider` 字段如实记录。
