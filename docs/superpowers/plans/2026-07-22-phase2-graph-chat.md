# Mindex Phase 2 实施计划（图谱首页 + 对话式检索 + 动画）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（本session inline 执行）。

**Goal:** 落地设计文档 §2/§3/§4/§5：`/` 改为全局知识图谱 + 底部问答输入框 + ✦新研究按钮；`POST /app/chat` 带引用问答；十字星工作态改缓旋；原 Dashboard 移至「动态」。

**Architecture:** 图谱数据端点聚合 projects+entities+claim_entities；前端 d3-force 布局 + 自绘 SVG（遵守修订后设计规范：细线/几何/黑白灰+蓝高亮，无粒子流光3D）。chat 走 searchClaims→top claims+证据→completeJson 严格提示→结构化引用（v1 非流式——provider 抽象无流式接口，UI 用工作态指示补偿；此为对 spec「流式」的有意简化，记录在案）。

**Tech Stack:** d3-force + @types/d3-force（web 新依赖，仅布局模块）；其余零新依赖。

## Global Constraints

- `npm test` 全绿；`npm run build` 通过；遵守 `docs/设计规范.md`（2026-07 修订版）。
- chat 回答只允许来自库内 claims；证据不足必须明说；引用可点击回溯。
- 图谱克制：黑白灰主体，蓝色仅 verified/likely 占比高的节点。

---

### Task 1: GET /app/graph 端点

**Files:** Modify `server/src/api/appRoutes.ts`；Test `server/test/api.test.ts`

**Produces:** `GET /app/graph` → `{ nodes: [{id, type: 'project'|entity_type, label, claims, trusted, projectId}], edges: [{source, target, weight}] }`。项目全量；每项目取 claim_count 前 24 个实体；边=项目→实体（weight=claim 关联数）+ 同项目实体对共享 ≥2 条 claim 的共现边。

- [x] 失败测试：seed 两实体共享 2 claims → graph 返回 project 节点、实体节点、共现边；无 token 401
- [x] 实现 → 测试通过 → commit `feat: GET /app/graph 全局知识图谱数据`

### Task 2: POST /app/chat 端点

**Files:** Modify `server/src/api/appRoutes.ts`、`server/src/agent/prompts.ts`（CHAT_SYSTEM）；Test `server/test/api.test.ts`

**Produces:** `POST /app/chat` body `{question: string(1-500), project_id?, history?: [{role:'user'|'assistant', content}] (≤8)}` → `{answer, citations: [{claim_id, seq, text, band, claim_type}], insufficient: boolean}`。流程：searchClaims(query=question, limit 12, 全项目或指定项目) → 无命中→ `{answer:'知识库中没有找到相关内容…', insufficient:true, citations:[]}`（不调 LLM）→ 有命中→ completeJson(CHAT_SYSTEM, claims 编号列表+历史+问题) 输出 `{"answer":"…带[C1]标注","cited": [1,2]}` → cited 映射回 claim → 无 provider 时诚实降级：返回 top claims 列表拼接 + insufficient:false + note。

CHAT_SYSTEM 要点：只依据给定结论回答；每个论断标注[Cn]；结论不足以回答时 answer 明说「知识库证据不足」且 cited=[]；不臆测、不引入外部知识；观点类结论表述为「玩家反馈/口碑」而非事实。

- [x] 失败测试：库内有「开发商是Beta工作室」claim（api.test.ts 已 seed）→ provider=none 时 chat 返回包含该 claim 的 citations 且 answer 非空；无关问题→ insufficient:true
- [x] 实现 → 通过 → commit `feat: POST /app/chat 带引用对话式检索`

### Task 3: 十字星动画（缓旋）

**Files:** Modify `web/src/styles.css`

- [x] `star-pulse` 闪烁 → `star-rot`：`@keyframes star-rot { to { transform: rotate(360deg) } }`；`.star.working { animation: star-rot 2.4s linear infinite; display: inline-block; }` → build → commit `feat: 十字星工作态改缓慢匀速旋转`

### Task 4: 图谱首页 Home + chat UI

**Files:** Create `web/src/pages/Home.tsx`、`web/src/graph.ts`（d3-force 布局封装）；Modify `web/src/main.tsx`（`/`→Home，`/activity`→Dashboard）、`web/src/shell.tsx`（导航加「动态」）、`web/src/styles.css`（graph/chat 样式）；`npm install d3-force @types/d3-force -w web`

**布局:** 全屏图谱区（SVG，force 布局：项目节点=大几何方点+等宽标签，实体节点=细边圆点按类型形状区分，claim 数→半径，trusted 占比≥0.5→Lucky Blue 描边/填充，否则灰阶；边=细线 1px LightGrey，共现边虚线）。交互：hover 高亮邻接；点击项目节点→右侧面板（名称/stats/进入项目）；点击实体节点→右侧面板列关联 claims（复用 /app/projects/:id/claims?entity_id= 新查询参数——Task 4 顺带在 claims 路由加 entity_id 过滤）；拖拽平移 + 滚轮缩放（viewBox 变换，不用库）。底部：chat 输入框（Enter 发送）+「✦ 新研究」按钮（→/new）。chat 面板：输入后消息列表浮层出现在输入框上方，回答带引用 chip（band 着色，点击→/claims/:id），历史存 sessionStorage（≤8 轮传后端）。

- [x] d3-force 安装；claims 路由加 entity_id 过滤（含测试）
- [x] Home.tsx + graph.ts 实现；路由/导航调整；样式（遵守规范：无阴影卡片墙、细线、等宽 metadata）
- [x] build 通过 → 本地冒烟（graph 渲染、chat 往返、节点点击）→ commit `feat: 知识图谱首页 + 对话式检索 UI`

### Task 5: 部署验证

- [x] `npm test` 全绿 + build → tar+scp 部署 → 线上验证 /（图谱）、chat 往返（DeepSeek）、动画 → commit（如有修订）
