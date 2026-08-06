# Mindex 转向 Phase 0+1 实施计划（数据洁癖 + 国内化收缩）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地设计文档 §6/§7/§9：删除 run 能力 + 防重复研究；物理删除 Steam/Wikipedia/App Store US+评论；研究流程按买量十类信息需求重构；部署上线并清理线上重复 run。

**Architecture:** 服务端为主（Fastify + better-sqlite3 + vitest），前端为 React 19 + vite。溯源链与置信度引擎不动结构，只调整输入面（连接器、先验、提示词）。Phase 2（图谱首页/chatbot/动画）与 Phase 3（资讯导入）另出计划。

**Tech Stack:** Node 22, TypeScript, Fastify, better-sqlite3, zod, vitest, React 19。

## Global Constraints

- 每个任务完成时 `npm test` 必须全绿（起点 82 个测试，删除连接器会减少数量——如实反映）。
- 无 mock 数据：测试 fixtures 必须是真实录制数据（现有 Steam fixtures 替换为真实录制的 App Store CN 数据）。
- 溯源硬约束不动：`store.insertEvidence` 逐字校验、claim 类型语义、置信度上限规则（除计划内的 'wiki' 调整）。
- 前端遵守 `docs/设计规范.md`（本计划前端改动极小：按钮/确认，走既有样式类）。
- 提交信息末尾带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- git 无 remote，只本地提交；部署走 HANDOFF §2 tar+scp 流程。

---

### Task 1: DELETE /app/runs/:id 端点

**Files:**
- Modify: `server/src/api/appRoutes.ts`（`GET /runs/:id/events` 路由之后，~line 330）
- Test: `server/test/api.test.ts`（文件末尾追加 describe）

**Interfaces:**
- Produces: `DELETE /app/runs/:id` → `{ ok: true }` | 404 `{error:'not_found'}` | 409 `{error:'run_active'}`。仅 status ∈ done/failed/cancelled 可删；显式先删 run_events 再删 run（不依赖 FK pragma）；claims/evidence/snapshots 的 run_id 保留为历史标记。

- [x] **Step 1: 写失败测试**（api.test.ts 末尾追加；admin 平面需 `authorization: Bearer test-admin-token`）

```ts
describe('admin: delete research run', () => {
  it('删除已结束 run 及其事件，claims 不受影响', async () => {
    const runId = 'run_test_del_1'
    store.db.prepare(`INSERT INTO research_runs (id, project_id, goal, status, started_at, finished_at) VALUES (?, ?, '测试', 'done', ?, ?)`)
      .run(runId, projectA, new Date().toISOString(), new Date().toISOString())
    store.db.prepare(`INSERT INTO run_events (run_id, phase, level, message, detail, at) VALUES (?, 'plan', 'info', 'x', '{}', ?)`)
      .run(runId, new Date().toISOString())
    const res = await app.inject({ method: 'DELETE', url: `/app/runs/${runId}`, headers: { authorization: 'Bearer test-admin-token' } })
    expect(res.statusCode).toBe(200)
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM research_runs WHERE id = ?`).get(runId)).toEqual({ n: 0 })
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`).get(runId)).toEqual({ n: 0 })
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE project_id = ?`).get(projectA) as { n: number }).n).toBeGreaterThan(0)
  })
  it('运行中的 run 拒绝删除；未知 id 404；无 token 401', async () => {
    const runId = 'run_test_del_2'
    store.db.prepare(`INSERT INTO research_runs (id, project_id, goal, status, started_at) VALUES (?, ?, '测试', 'running', ?)`)
      .run(runId, projectA, new Date().toISOString())
    const active = await app.inject({ method: 'DELETE', url: `/app/runs/${runId}`, headers: { authorization: 'Bearer test-admin-token' } })
    expect(active.statusCode).toBe(409)
    const missing = await app.inject({ method: 'DELETE', url: '/app/runs/run_nope', headers: { authorization: 'Bearer test-admin-token' } })
    expect(missing.statusCode).toBe(404)
    const noauth = await app.inject({ method: 'DELETE', url: `/app/runs/${runId}` })
    expect(noauth.statusCode).toBe(401)
  })
})
```

- [x] **Step 2: 跑测试确认失败** — `npm test -- api` → 新增用例 FAIL（404 路由不存在）
- [x] **Step 3: 实现端点**（appRoutes.ts，插在 `/runs/:id/events` 路由后）

```ts
  server.route({
    method: 'DELETE',
    url: '/runs/:id',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req, reply) => {
      const run = db.prepare(`SELECT id, status FROM research_runs WHERE id = ?`).get(req.params.id) as { id: string; status: string } | undefined
      if (!run) return reply.code(404).send({ error: 'not_found' })
      if (run.status === 'running' || run.status === 'queued') {
        return reply.code(409).send({ error: 'run_active', message: '进行中的研究不能删除' })
      }
      // 只删研究记录与事件；claims/evidence/snapshots 的 run_id 保留为历史标记（知识层已去重，不随 run 删除）
      db.prepare(`DELETE FROM run_events WHERE run_id = ?`).run(run.id)
      db.prepare(`DELETE FROM research_runs WHERE id = ?`).run(run.id)
      return { ok: true }
    },
  })
```

- [x] **Step 4: 跑测试确认通过** — `npm test -- api` → PASS
- [x] **Step 5: Commit** — `git add -A && git commit -m "feat: DELETE /app/runs/:id — 删除已结束研究记录"`

---

### Task 2: 重复研究确认门（后端）

**Files:**
- Modify: `server/src/api/appRoutes.ts`（`POST /projects/:id/research` handler，~line 165）
- Test: `server/test/api.test.ts`

**Interfaces:**
- Produces: body 增加 `force?: boolean`；30 分钟内存在同 goal 已完成 run 且未 force 时返回 409 `{error:'duplicate_recent', message}`。goal 默认值与 pipeline 一致（`'全面了解产品、受众与玩家口碑'`）。

- [x] **Step 1: 写失败测试**

```ts
describe('admin: duplicate research guard', () => {
  it('30 分钟内同目标已完成 → 409 duplicate_recent；force 放行', async () => {
    const auth = { authorization: 'Bearer test-admin-token' }
    store.db.prepare(`INSERT INTO research_runs (id, project_id, goal, status, started_at, finished_at) VALUES ('run_dup_g', ?, '全面了解产品、受众与玩家口碑', 'done', ?, ?)`)
      .run(projectB, new Date().toISOString(), new Date().toISOString())
    const dup = await app.inject({ method: 'POST', url: `/app/projects/${projectB}/research`, headers: auth, payload: {} })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error).toBe('duplicate_recent')
    // force 放行：会真正启动研究（provider=none，几秒内异步结束，不影响断言 run_id 返回）
    const forced = await app.inject({ method: 'POST', url: `/app/projects/${projectB}/research`, headers: auth, payload: { force: true } })
    expect(forced.statusCode).toBe(200)
    expect(forced.json().run_id).toMatch(/^run_/)
  })
})
```

- [x] **Step 2: 确认失败** — `npm test -- api` → dup 请求返回 200 而非 409
- [x] **Step 3: 实现**（research handler 内、try 之前）

```ts
      const goal = req.body.goal ?? '全面了解产品、受众与玩家口碑'
      if (!req.body.force) {
        const recent = db.prepare(
          `SELECT id FROM research_runs WHERE project_id = ? AND goal = ? AND status = 'done'
             AND finished_at >= datetime('now', '-30 minutes') LIMIT 1`,
        ).get(req.params.id, goal)
        if (recent) {
          return reply.code(409).send({ error: 'duplicate_recent', message: '30 分钟内已完成同目标研究，如需重复请确认（force）' })
        }
      }
```

body schema 增加 `force: z.boolean().default(false)`；`startResearchRun` 调用改传 `goal`。注意 `finished_at` 是 ISO 字符串，`datetime('now','-30 minutes')` 与 ISO 字符串比较需统一：用 `finished_at >= ?` 传 `new Date(Date.now() - 30 * 60_000).toISOString()`。

- [x] **Step 4: 确认通过** — `npm test -- api` → PASS
- [x] **Step 5: Commit** — `feat: 重复研究确认门（duplicate_recent 409 + force）`

---

### Task 3: 前端：删除 run 按钮 + 重复研究确认

**Files:**
- Modify: `web/src/pages/ProjectOverview.tsx`（runs 列表行 + startResearch）

**Interfaces:**
- Consumes: Task 1 的 DELETE、Task 2 的 409 duplicate_recent。

- [x] **Step 1: 实现**（无组件测试基建，走构建验证 + 生产验证）
  - runs 列表每行（非 running）加删除按钮：`<button className="btn ghost" onClick={(e) => { e.preventDefault(); deleteRun(r.id) }}>删除</button>`，`deleteRun` 用 `window.confirm('删除这条研究记录？知识结论不受影响。')` 确认后 `api.del(`/app/runs/${r.id}`)` 并 `load()`。检查 `web/src/api.ts` 是否有 `del` 方法，没有则补（照 `post` 实现，method DELETE）。
  - `startResearch` catch 里识别 `duplicate_recent`：`window.confirm('30 分钟内已完成同目标研究，确认再来一次？')` 后带 `{ force: true }` 重发。api.post 错误对象需能携带 error code——检查 `web/src/api.ts` 错误抛出格式，必要时在 message 前缀带 code 判断。
- [x] **Step 2: 构建验证** — `npm run build` → 成功
- [x] **Step 3: Commit** — `feat: 项目页删除研究记录 + 重复研究确认`

---

### Task 4: 录制 App Store CN 真实 fixtures（为 Task 5 铺路）

**Files:**
- Create: `server/test/fixtures/appstore_cn_lookup_1517783697.json`（原神 CN lookup 真实响应）
- Create: `server/test/fixtures/appstore_cn_reviews_1517783697_p1.json`（原神 CN 评论 RSS JSON 第 1 页真实响应）

**Interfaces:**
- Produces: 供 pipeline.test.ts 使用的真实录制数据（替代 Steam fixtures）。

- [x] **Step 1: 录制**（本地走代理需 `NODE_USE_ENV_PROXY=1`；iTunes ~10rpm 限流，两个请求间隔 ≥6s）

```bash
curl -s "https://itunes.apple.com/lookup?id=1517783697&country=cn" > server/test/fixtures/appstore_cn_lookup_1517783697.json
sleep 8
curl -s "https://itunes.apple.com/cn/rss/customerreviews/page=1/id=1517783697/sortby=mostrecent/json" > server/test/fixtures/appstore_cn_reviews_1517783697_p1.json
```

校验：两个文件均为合法 JSON 且 lookup `resultCount >= 1`、reviews `feed.entry` 数组非空。若原神 id 失效，用 iTunes search API 现查一个头部手游替代并同步改 Task 5 中的 id。

- [x] **Step 2: Commit** — `test: 录制 App Store CN 真实 fixtures（原神）`

---

### Task 5: 物理删除 Steam / Wikipedia / App Store US+评论 / google_play 适配器

**Files:**
- Delete: `server/src/connectors/steam.ts`、`server/src/connectors/wikipedia.ts`
- Modify: `server/src/connectors/registry.ts`（去 import 与注册；删 `appstoreReviewsConnector` 注册）
- Modify: `server/src/connectors/itunes.ts`（`['cn','us']` → `['cn']`；整体删除 `appstoreReviewsConnector` 及 RSS 解析函数；连接器 label/description 去掉 US 表述）
- Modify: `server/src/connectors/adapters.ts`（删 google_play 适配器；查看后如还有其他非国内适配器一并删）
- Modify: `server/src/agent/extract.ts`（删 `steam_positive_rate`/`steam_review_desc` 两个启发式模式；`persistFactClaim` 无关不动；检查 `['price','appstore_rating','steam_positive_rate']` 数值列表同步删）
- Modify: `server/src/agent/pipeline.ts`（storefront 后缀逻辑保留但只会出现 CN；`['price','current_version','appstore_rating']` 不动）
- Modify: `web/src/pages/ProjectOverview.tsx:195`（`k === 'steam_appid'` 过滤分支删除）
- Modify: `web/src/pages/ClaimDetail.tsx:325`（steam 评分显示分支删除，统一 `★`）
- Modify: `server/src/db/schema.sql`（19/55/60 行注释更新为国内平台示例）
- Modify: `server/test/confidence.test.ts:57`（wikipedia wiki 源示例改为行业媒体 press 源：`ownerKey: 'youxiputao.com', sourceType: 'press', authorityPrior: 0.7`——注意该用例若依赖 wiki 类型触发 no_official_source_cap 行为，需同步调整断言，见 Task 7）
- Rewrite: `server/test/pipeline.test.ts`（Steam fixtures → Task 4 的 App Store CN fixtures；sources/documents 相应改为 `connector: 'itunes_app'` / `'manual'` 评论导入形态；断言按新数据实际抽取结果调整——先跑一遍看真实产出再写断言，禁止编造期望值）
- Delete: `server/test/fixtures/steam_*.json`
- Delete: `server/src/scripts/seed-demo.ts`；Modify: `server/package.json` 与根 `package.json` 删 `seed` script；README 删 seed 说明

**Interfaces:**
- Produces: registry 只含 itunes_app(CN)、web、baobaomi、bilibili、xiaohongshu、taptap、剩余国内 adapters。

- [x] **Step 1: 删除与改写**（上述文件逐一处理；`grep -rn "steam\|wikipedia" server/src web/src` 清零，`grep -rni "appstore_reviews" server/src` 清零）
- [x] **Step 2: 重写 pipeline.test.ts** — 用真实 fixtures 构造 api_record（lookup→`appMetadataText` 等价文本：直接调用连接器导出的文本组装函数；若函数未导出则导出）与 review docs（RSS entries → store 直插 review 快照），跑 extract→consolidate→score 全链路。断言：产出 claims>0、评论聚合产出 player_opinion、无 GroundingError 逃逸、band 分布合法。
- [x] **Step 3: 全量测试** — `npm test` → 全绿（数量会少于 82，如实记录新数字）
- [x] **Step 4: 构建** — `npm run build` → 成功
- [x] **Step 5: Commit** — `refactor!: 移除 Steam/Wikipedia/AppStore US+评论/google_play——全面转向国内信源`

---

### Task 6: 项目 kind 收缩为 game

**Files:**
- Modify: `server/src/api/appRoutes.ts`（POST /projects body：`kind: z.enum(['game']).default('game')`）
- Modify: `server/src/db/schema.sql`（projects.kind 注释与 CHECK 收缩为 `CHECK (kind IN ('game'))`——只影响新建库；存量库不做表重建迁移，写入面已被 API 约束，原因记录在 schema 注释）
- Modify: `web/src/pages/NewProject.tsx`（删 kind `<select>`，固定 game；界面文案「新建游戏项目」）
- Test: `server/test/api.test.ts`（POST /app/projects 传 `kind:'brand'` → 400）

- [x] **Step 1: 写失败测试**

```ts
  it('项目类型只接受 game', async () => {
    const res = await app.inject({ method: 'POST', url: '/app/projects', headers: { authorization: 'Bearer test-admin-token' }, payload: { name: '非游测试', kind: 'brand' } })
    expect(res.statusCode).toBe(400)
  })
```

- [x] **Step 2: 确认失败 → 实现 → 通过** — `npm test -- api`
- [x] **Step 3: Commit** — `feat!: 项目类型收缩为 game`

---

### Task 7: 置信度输入面国内化

**Files:**
- Modify: `server/src/core/confidence.ts`（`no_official_source_cap` 的类型列表 `['official','store_metadata','wiki']` → `['official','store_metadata']`——维基级百科不再视作官方级）
- Modify: `server/src/agent/pipeline.ts`（`startImportRun` 的 `authorityByType`：press 0.7 保持；新增注释说明国内先验语义：官网 0.9 / 商店元数据 0.85 / 行业媒体 0.7 / UGC 0.35–0.4）
- Test: `server/test/confidence.test.ts`（受 cap 变化影响的用例调整：wiki 源不再豁免 no_official_source_cap——先跑测试看哪些断言变化，逐一核对新值是否符合规则语义后更新）

- [x] **Step 1: 改 cap 列表 → 跑 `npm test -- confidence` 看失败面 → 核对每个失败是否为预期语义变化 → 更新断言**
- [x] **Step 2: 全量 `npm test` 绿**
- [x] **Step 3: Commit** — `feat: 置信度官方源判定收紧（wiki 不再视作官方级）`

---

### Task 8: 研究流程重构——买量十类信息需求

**Files:**
- Modify: `server/src/agent/prompts.ts`（核心改动，见下）
- Modify: `server/src/agent/pipeline.ts`（默认 questions 与 coverageSchema）
- Modify: `web/src/pages/RunView.tsx`（coverage 十类状态展示：读 run.stats.dimensions 渲染索引式列表——照 设计规范 §11.3 的编号完成态样式）
- Test: `server/test/pipeline.test.ts`（coverage schema 解析用例）

**Interfaces:**
- Produces: `UA_DIMENSIONS: {key,label}[]`（prompts.ts 导出，10 项：selling_points 核心卖点 / theme_world 题材世界观 / character_ip 角色IP / gameplay_loop 玩法循环 / player_hooks 玩家爽点痛点 / monetization_rep 付费与商业化口碑 / version_events 版本活动节点 / competitors 竞品对比 / audience 人群画像 / creative_patterns 素材套路）；coverage JSON 增加 `dimensions: [{key,status:'covered'|'partial'|'missing',note}]`。

- [x] **Step 1: prompts.ts 重写三处**
  - `PROMPT_VERSION = 'v2-ua-cn'`
  - `PLANNER_SYSTEM`：定位改为「国内手游买量知识库的研究规划器」，要求 research_questions 覆盖十类维度（列出 key+label），关键词以中文为主、面向国内平台搜索习惯
  - `COVERAGE_SYSTEM`：按十类维度逐维评估，输出上述 dimensions 结构
  - `EXTRACT_SYSTEM` 补一行：「优先抽取对买量素材创作有用的信息：卖点、题材、角色、玩家情绪、付费口碑、版本节点」
- [x] **Step 2: pipeline.ts** — 默认 `questions` 换为十类各一问（每问内嵌维度 label）；`coverageSchema` 增加 `dimensions: z.array(z.object({ key: z.string(), status: z.enum(['covered','partial','missing']).catch('partial'), note: z.string().default('') })).default([])`；`stats.dimensions = coverage.dimensions` 存档
- [x] **Step 3: RunView 展示** — stats.dimensions 存在时渲染十行索引列表（`01 核心卖点 COVERED` 风格，missing 用 t-warn tag）
- [x] **Step 4: 测试** — pipeline.test.ts 增加 coverageSchema 解析用例（dimensions 缺省/非法 status catch）；`npm test` 全绿；`npm run build` 成功
- [x] **Step 5: Commit** — `feat: 研究流程重构——买量十类信息需求驱动规划与覆盖度`

---

### Task 9: 文档对齐

**Files:**
- Modify: `docs/设计规范.md`（§14 图谱首页条目改为「允许克制的索引式图谱首页」定义；§10.5 补对话式检索例外；§11.2/11.3 十字星旋转规范）
- Modify: `docs/compliance.md`、`docs/architecture.md`（连接器现状表、信源策略）
- Modify: `HANDOFF.md`（§6 连接器表、测试数、§9 待办）
- Modify: `README.md`（定位一句话、快速开始去 seed）

- [x] **Step 1: 逐文件更新 → Commit** — `docs: 国内手游买量转向对齐（规范修订 + 连接器现状）`

---

### Task 10: 部署 + 线上清理

- [x] **Step 1: 本地全量验证** — `npm test` 全绿 + `npm run build` 成功 + 本地 `npm start` 冒烟（创建项目→发起研究→中途取消不需要，确认 plan 阶段事件出现十类问题）
- [x] **Step 2: 打包部署**（HANDOFF §2 原样流程）

```bash
tar czf /tmp/mindex.tgz --exclude node_modules --exclude data --exclude .git --exclude .env --exclude 品牌 --exclude docs/brand .
scp /tmp/mindex.tgz openframe-pub:~/mindex-new.tgz
ssh openframe-pub 'cd ~/mindex && tar xzf ~/mindex-new.tgz && npm install && npm run build && pm2 restart mindex'
```

- [x] **Step 3: 线上验证** — `curl https://mindex.luckyloading.com/app/site-info` 200；overview 正常
- [x] **Step 4: 删除重复 run（用户明确要求；保留 06:40 原始 run）**

```bash
curl -X DELETE "https://mindex.luckyloading.com/app/runs/run_tkmf96qc1vwnrf2r" -H "Authorization: Bearer LL20260226"
```

验证 overview 只剩一条 run；伊莫 claims 数不变（14）。

- [x] **Step 5: Commit**（若有部署产生的修订）

---

## Phase 2/3 预告（不在本计划）

- Phase 2：图谱首页（d3-force+SVG、`GET /app/graph`）、chatbot（`POST /app/chat` RAG）、十字星旋转动画、Dashboard→动态页。待本计划完成后出 `2026-07-22-phase2-graph-chat.md`。
- Phase 3：资讯/文章导入强化。待信息源调研报告确认后合并规划。
