# Mindex — 交接文档 (Handoff)

> 最后更新：2026-07-22（晚，转向后）· 维护者交接用 · 生产已上线
> 一句话：Mindex 是面向**国内手游买量团队**的知识图谱知识库——研究 Agent + 人工导入两条通路积累知识，抽取带逐字证据的原子知识、算可解释置信度，经「星空即检索」首页（知识星图横带 + 编辑式带引用问答）服务人类编导，经 API / Context Pack / MCP 服务下游创意 Agent（如 AdMuse）。**每一句话都能追溯到出处，绝不伪造引用。**

---

## 0. 30 秒快速定位

| 我要… | 去哪 |
|---|---|
| 访问线上站点 | https://mindex.luckyloading.com （admin token `LL20260226`） |
| 本地跑起来 | `npm install && npm run build && npm start` → http://127.0.0.1:8787 |
| 改前端设置 | 管理界面「设置」页（Provider / 密钥 / 抱抱米 / TikHub / 合规信息），保存即生效免重启 |
| 改代码从哪读起 | `server/src/agent/pipeline.ts`（研究主管线）+ `server/src/core/confidence.ts`（信任逻辑）+ `web/src/pages/Home.tsx` + `web/src/sky.ts`（星空即检索首页，SSE 流式问答） |
| 部署新版本 | 见 §2「发新版」；进程由 openframe-sg 上的 pm2 托管 |
| 理解设计原则 | 本文档 §4 + `docs/architecture.md` + `docs/compliance.md` |

---

## 1. 当前状态

- **生产已上线且验证通过**：https://mindex.luckyloading.com（有效 TLS、HTTP→301→HTTPS、合规页脚齐全）。
- **测试**：102 passed（`npm test`，12 个测试文件，vitest）。
- **真实数据跑通**：以《原神》为例，跨 App Store CN、官网、B站、小红书、抱抱米产出数十条带引用结论（2026-07 起信源全面国内化），DeepSeek 负责规划与抽取。**无 mock 数据**——降级路径都如实标注。
- **git**：`main` 分支干净，最新提交 `196abc1`。**注意：目前没有配置 git remote**，代码只在本地 Mac 和服务器上各有一份（部署靠 tar+scp，见 §2）。建议尽快加一个私有 remote。

---

## 2. 生产环境

### 访问
- **公网**：https://mindex.luckyloading.com
- **备用**：WireGuard 内网 http://10.66.68.1:8787（需已配置 WG）
- **登录**：管理员 Token = `LL20260226`（用户明确选择不轮换、可公开）。
- 8787 端口**不对公网开放**，nginx 是唯一入口。

### 服务器
- **openframe-sg**（新加坡腾讯云 Lighthouse）
  - SSH 别名：`openframe-pub`（公网 43.134.71.232，传文件走这个更快）/ `openframe-sg`（WG 10.66.68.1）
  - 代码位置：`~/mindex`（ubuntu 用户）
  - 运行时：Node 22（NodeSource）、pm2 7、bili CLI（pipx，`~/.local/bin/bili`）
  - nginx vhost → `127.0.0.1:8787`，`client_max_body_size 20m`
  - TLS：Let's Encrypt certbot，证书到期 **2026-10-20 自动续期**

> **为什么是新加坡**：三台服务器（baobaomi 广州 / luckyloading / openframe-sg 新加坡）里只有新加坡能**零代理**同时够到国内平台（B站/TapTap/App Store）和境外 API（TikHub/Anthropic/OpenAI/DeepSeek）。境内机被墙 OpenAI/Anthropic，只能用国产 LLM。**选服务器看网络位置，不是算力**（Mindex 空闲 ~70MB 内存）。

### 进程管理
```bash
pm2 status mindex            # 查看
pm2 logs mindex              # 日志
pm2 restart mindex           # 重启
# 已 pm2 save + systemd 开机自启（pm2-ubuntu enabled）
```

### 发新版（部署流程）
```bash
# 本地：打个精简 tar（排除大目录，产物 ~400K）
tar czf /tmp/mindex.tgz \
  --exclude node_modules --exclude data --exclude .git \
  --exclude .env --exclude 品牌 --exclude docs/brand .
# 传到服务器（走公网别名 openframe-pub 更快）
scp /tmp/mindex.tgz openframe-pub:~/mindex-new.tgz
# 服务器上：解包 → 装依赖（服务器直连 npm，快）→ 构建 → 重启
ssh openframe-pub 'cd ~/mindex && tar xzf ~/mindex-new.tgz && npm install && npm run build && pm2 restart mindex'
```
> **传代码的坑**：本地 Mac→服务器的 SSH/scp 极慢（Clash TUN 拦截 SSH 走慢节点），**rsync 会截断留下残缺目录**。务必用单流 tar+scp，`npm install` 放服务器端跑。历史上一次被 kill 的后台传输曾把 `~/mindex` 删到只剩 src——发版时先确认目标完整再动。

### 凭证清单（敏感——不写明文）
| 凭证 | 位置 |
|---|---|
| Admin Token | `LL20260226`（可公开，登录用） |
| DeepSeek / TikHub / 抱抱米 key | 服务器 `~/mindex/.env`（gitignored，chmod 600） |
| 数据库 + 原始快照 | 服务器 `~/mindex/data/`（备份=拷贝该目录） |

---

## 3. 本地开发

要求 Node.js ≥ 22（推荐 24）。

```bash
npm install          # better-sqlite3 预编译二进制 + jieba 分词
npm run build        # 构建前端到 web/dist
npm start            # 服务器（API+管理界面），默认 127.0.0.1:8787
npm test             # 82 个单元+集成测试（vitest）
npm run eval         # 全库 groundedness / 信任边界评测
npm run dev          # 热更新：server(tsx watch)+web(vite)，开 http://127.0.0.1:5173
```

启动时控制台打印管理员 Token（也存 `data/.admin_token`）。

> **环境约束**：本地走 Clash 代理时需 `NODE_USE_ENV_PROXY=1`（server 的 npm scripts 已内置）。iTunes API 限流 ~10 rpm。本地无 Anthropic key 时可用 `claude` CLI 当 LLM（较慢、偶发 JSON 解析抖动，已加重试）。**本地 Mac 直连 10.66.68.1:8787 或线上域名可能 502/连接失败——是本机 Clash TUN 污染，不是服务挂了**，从干净客户端（如 baobaomi 服务器）验证即正常。

---

## 4. 架构与核心原则（务必先读）

Mindex 的价值全在**信任逻辑**，不是 CRUD。改任何东西前先理解这几条非谈判项：

1. **溯源链写入即校验**：`source → document → snapshot → evidence → claim`。每条 claim 必须携带**逐字存在于快照中的引文**，`store.insertEvidence` 强制校验，对不上直接抛 `GroundingError` 丢弃。**幻觉引用在结构上不可能入库。**
2. **区分 claim 类型**：`official_fact` / `player_opinion` / `system_inference` / `creative_insight`。广告文案是 marketer 内容 → `creative_insight`，**绝不能当 player_opinion**（这是关键诚实性区分）。
3. **「是否为真」与「是否有代表性」是两根独立的轴**：
   - 事实走**真值**：log-odds 因子叠加（权威先验/直接性/独立来源/一致性/新鲜度/原创性反刷/反驳/抽取质量）+ 上限规则（单源 ≤0.70、无官方源 ≤0.75、推断上限、insight ≤0.75）。
   - 观点走**代表性**：Wilson 下界，按「未被提示的自发提及率」标定。
   - **点赞/排名/单平台热度永远不是真值输入。**
4. **低置信/冲突不静默可信**：verified/likely 自动进可信库；uncertain/disputed/insufficient 一律进审核队列或隔离区。证据不足诚实输出 `insufficient` 且置信度为 NULL。
5. **独立性折叠**：同 owner_key / dup_cluster 算一个源；simhash+jaccard 近重；astroturf 启发式；版本用「supersession」而非「冲突」。
6. **Context Pack 诚实约束**：只含可信知识、每条带 citation、UGC 标 `quotable:false`（只可转述）、观点带 Wilson 代表性、未收录的低置信在 `excluded` 中声明数量。

---

## 5. 目录导览

```
server/src/
  agent/
    pipeline.ts      ★研究主管线：plan→resolve→discover→extract→consolidate→score→conflicts→coverage
                      也含 startImportRun / startReviewImportRun
    extract.ts       元数据启发式抽取 + 评论主题归纳 + creative_insight
    reviewImport.ts  评论 Markdown/JSON 解析（Hermes 导出等手动导入路径）
    prompts.ts       LLM 提示词
  connectors/        数据源连接器（详见 §6）
    fetcher.ts       代理感知抓取（trimStart + content-type 嗅探）
    registry.ts      连接器注册表
    types.ts         连接器接口
  core/
    store.ts         ★Store 类：写入即校验溯源、createClaim/supersede/mergeClaim/openConflict/enqueueReview
    confidence.ts    ★scoreClaim / scoreOpinion(Wilson) / groupIndependent
    dedupe.ts        simhash + jaccard 近重、独立性折叠
    grounding.ts     逐字引文校验
    contextPack.ts   Context Pack 组装（预算/配额/excluded 声明）
    settings.ts      DB 支持的运行时设置（DB>env>default），effectiveLlm/Tikhub/Baobaomi/Site
  search/            jieba 分词 FTS5 + 证据命中 + RRF(k=60) 融合 + 可解释重排
  api/
    server.ts        Fastify 启动
    agentRoutes.ts   Agent 平面 /api/v1/*（OpenAPI/Key/限流/日志）
    appRoutes.ts     管理平面 /app/*（admin token 保护；公开 GET /app/site-info）
    auth.ts          鉴权
  llm/provider.ts    anthropic / openai(兼容) / claude-cli / none 四档 + resolveProvider
  mcp/stdio.ts       MCP stdio 薄层（薄代理，鉴权/限流全在 REST 层）
  db/                SQLite schema（溯源链）
  scripts/           eval（全库评测）
web/src/
  pages/             14 个页面（Dashboard/Knowledge/Review/Conflicts/Settings/ImportPage…）
  shell.tsx          布局 + 侧边导航 + SiteFooter
  footer.tsx         合规页脚（读 /app/site-info）
docs/                architecture / compliance / evaluation / 设计规范.md
```

---

## 6. 连接器现状（诚实标注）

| 连接器 | 状态 | 说明 |
|---|---|---|
| iTunes / App Store CN 元数据 | ✅ 接通 | JSON，限流 ~10rpm；US 与评论已移除（信源国内化）|
| 官网 / web | ✅ 接通 | 代理感知抓取 |
| 抱抱米 (baobaomi) | ✅ 接通 | 走 MCP Agent API（159.75.55.213）；creative 产出正确归为 **creative_insight** |
| B站 (bilibili) | ✅ 接通 | shell 到 `bili` CLI，热评→player_opinion。需 `pip install bilibili-cli`。**注意评论 author 是对象 {id,name} 不是字符串** |
| 小红书 (xiaohongshu) | ✅ 接通 | TikHub → player_opinion |
| 抖音 (douyin) | ✅ 接通 | TikHub 搜视频→评论；买量最核心，实测单项目 100+ 评论 |
| 快手 (kuaishou) | ✅ 接通 | TikHub 同抖音结构；**photo_id 19 位裸整数，靠 `parseTikhubJson` 保大整数精度否则评论 400** |
| 微博 (weibo) | ✅ 接通 | TikHub 官微资讯+评论舆情；text 含 HTML 抽取前清洗 |
| TapTap 聚合评分 | ✅ 接通 | JSON-LD；**走快代理绕过 taptap 对 IDC IP 的 405**（`fetch(url,{proxy:true})`）。逐条评论仍走 Hermes 导入 |
| 评论批量导入 / URL 抓取 | ✅ 通路 | `reviewImport.ts` + `POST /app/projects/:id/import-url`（粘贴链接抓正文）|

**快代理**：`MINDEX_PROXY_URL`（.env，不进 git）。Fetcher 按 host 选择性走代理（`{proxy:true}`）——TapTap 等被 IDC 封的站用，常规抓取直连省流量。**代理路径必须用 undici 自带 fetch**（`src/connectors/fetcher.ts`），否则 dispatcher 版本不符报 invalid onRequestStart。

**LLM Provider 四档**（`server/src/llm/provider.ts`，DB 设置 > .env > 默认，每次运行现取）：
- `anthropic`（Anthropic 兼容，可配 baseURL）
- `openai`（OpenAI 兼容，配 baseURL 接 DeepSeek/MiniMax/Qwen）← **生产用 DeepSeek**
- `claude-cli`（本机 Claude Code CLI，零凭证但慢）
- `none`（诚实降级：仅结构化元数据抽取 + 关键词口碑聚合，如实标注）
- 默认 `auto` 按上述顺序探测。

---

## 7. Agent 接入（下游怎么用）

**写入平面（2026-07-22 起）**：scope `knowledge:write` 开放建项目/发研究/导入文档、URL、评论（`POST /api/v1/projects[...]`，五个端点全部 OpenAPI 自描述——import-reviews 的描述内置完整格式契约，采集 Agent 读 `/api/v1/openapi.json` 即可自懂格式）。**审核裁决与删除不对 Agent 开放**（采集 Agent 不能给自己交来的内容背书）。MCP 也有 `import_reviews`/`import_document`/`start_research` 工具。生产已建 `Hermes` key（全 scope、全项目、120rpm）。

```bash
# 1. 管理界面「Agent 接入」页创建 API Key（明文只显示一次，scope+项目隔离+限流）
# 2. 带引用检索
curl "https://mindex.luckyloading.com/api/v1/search?q=付费&limit=5" \
  -H "Authorization: Bearer mdx_live_..."
# 3. 写广告前拿 Context Pack
curl -X POST "https://mindex.luckyloading.com/api/v1/context-pack" \
  -H "Authorization: Bearer mdx_live_..." -H "Content-Type: application/json" \
  -d '{"project_id":"prj_...","task":"为新版本写买量素材","budget_tokens":6000}'
```
- **OpenAPI 3.1**：`/api/v1/docs`（Scalar UI）· `/api/v1/openapi.json`（机器消费）
- **MCP (stdio)**：`claude mcp add mindex --env MINDEX_API_KEY=mdx_live_... -- npm run mcp --prefix <repo>`
  工具：`search_knowledge` / `get_claim` / `get_evidence` / `get_context_pack` / `list_projects`

---

## 8. 已知限制与坑

1. **TapTap 自动评分连接器在生产 405**（IDC IP 被封）——不是 bug，是 taptap 策略。评论走 Hermes 导入。
2. **本地 Mac 访问线上/WG 会假性失败**（502/连接失败）——本机 Clash TUN 污染，换干净客户端验证。
3. **没有 git remote**——代码分散在 Mac 和服务器，发版靠 tar+scp。**建议尽快加私有 remote**，降低丢代码风险（历史上被 kill 的后台传输删过 `~/mindex`）。
4. **rsync 到服务器会截断**——只用单流 tar+scp。
5. **iTunes 限流 ~10rpm**，大批量研究会变慢。
6. **claude-cli 用 haiku 偶发 JSON 解析抖动**——已加重试一次；生产用 DeepSeek 更稳，本地开发建议也配个真 key。
7. **Admin token 公开且不轮换**——用户明确选择；若安全策略变化需改 `MINDEX_ADMIN_TOKEN` 并更新 pm2 env。

---

## 9. 待办 / 下一步建议（无强制欠债）

**2026-07-22 转向已完成**（详见 `docs/superpowers/specs/2026-07-22-mindex-cn-ua-pivot-design.md`）：信源全面国内化（删 Steam/Wikipedia/AppStore US+评论）、买量十维研究流程（PROMPT v2-ua-cn）、知识图谱首页（/）+ 带引用对话式检索（POST /app/chat）+ GET /app/graph、删除 run 端点与防重复门、URL 抓取导入（POST /app/projects/:id/import-url）、十字星缓旋动画。

**待用户确认**：`docs/信息源评估报告-2026-07.md`——新信源连接器（TikHub 抖音/微博/快手/公众号、行业媒体 RSS/轮询）等确认 P0 清单后接入。注意实测：gamelook.com.cn 与 nadianshi.com 屏蔽非大陆 IP（新加坡服务器 000），游戏葡萄官网已退化为落地页（内容在公众号）——行业媒体自动化以游戏陀螺 + TikHub 公众号通路为主。

其他维护者建议：

- **[高] 配置 git remote**（私有仓库），把发版从 tar+scp 升级成 git pull，消除单点丢码风险。
- **[中] TapTap 评论常态化**：等有 Hermes MD 导出时走 `import-reviews`，或研究住宅代理绕过 IDC 封锁。
- **[中] 备份策略**：给服务器 `~/mindex/data/` 加定时快照（数据库+原始 snapshot）。
- **[低] 更多平台**：TikHub 覆盖 29 平台，可按需接抖音/快手等（复用 `tikhub.ts` 的 `tikhubGet`/`findArray`）。
- **[低] 证书续期监控**：certbot 已配自动续（到期 2026-10-20），但可加个到期告警兜底。

---

## 10. 关键参考文档

- `docs/architecture.md` — 架构决策与数据模型
- `docs/compliance.md` — 来源合规策略（哪些平台实测接通、哪些只做适配器、为什么）
- `docs/evaluation.md` — 评测方法（引用完整性、信任边界、观点代表性）
- `docs/设计规范.md` — 前端视觉与交互设计规范（**改前端必须遵守**）
- `README.md` — 面向新用户的快速开始
- `.env.example` — 环境变量清单
