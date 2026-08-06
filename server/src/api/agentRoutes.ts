import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import type { Store } from '../core/store.js'
import { buildContextPack } from '../core/contextPack.js'
import { getClaimDetail, searchClaims } from '../search/index.js'
import { pj } from '../lib/util.js'
import { authenticateToken, keyAllowsProject, logApiRequest, touchKey, type AuthedKey } from './auth.js'
import { fetchUrlForImport, startImportRun, startResearchRun, startReviewImportRun } from '../agent/pipeline.js'
import { normalizeReviews, parseReviewMarkdown } from '../agent/reviewImport.js'

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: AuthedKey
  }
  interface FastifyContextConfig {
    scope?: string
  }
}

const claimSummarySchema = z.object({
  id: z.string(),
  seq: z.number(),
  claim_type: z.string(),
  topic: z.string(),
  text: z.string(),
  confidence: z.number().nullable(),
  confidence_band: z.string(),
  review_state: z.string(),
  rank: z.string(),
  project_id: z.string(),
  version_min: z.string().nullable(),
  valid_until: z.string().nullable(),
  opinion_stats: z.record(z.string(), z.unknown()).nullable(),
  updated_at: z.string(),
})

const citationSchema = z.object({
  evidence_id: z.string(),
  source: z.string(),
  url: z.string().nullable(),
  quote: z.string(),
  published_at: z.string().nullable(),
  quotable: z.boolean(),
})

/**
 * Agent plane: /api/v1/* — Bearer API key auth, scoped, project-isolated,
 * rate-limited per key, fully logged, documented via OpenAPI.
 */
export async function agentRoutes(app: FastifyInstance, opts: { store: Store }): Promise<void> {
  const { store } = opts
  const db = store.db
  const server = app.withTypeProvider<ZodTypeProvider>()

  await server.register(rateLimit, {
    hook: 'preHandler',
    timeWindow: '1 minute',
    keyGenerator: (req) => req.apiKey?.id ?? req.ip,
    max: (req) => req.apiKey?.rateLimitRpm ?? 20,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `超出限流：${ctx.max} 次/分钟`,
      retry_after_ms: ctx.ttl,
    }),
  })

  server.addHook('onRequest', async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const key = authenticateToken(db, token)
    if (!key) {
      return reply.code(401).send({ error: 'invalid_api_key', message: '缺少或无效的 API Key（Authorization: Bearer mdx_live_...）' })
    }
    req.apiKey = key
  })

  server.addHook('preHandler', async (req, reply) => {
    const scope = req.routeOptions.config?.scope
    if (scope && !req.apiKey!.scopes.includes(scope)) {
      return reply.code(403).send({ error: 'insufficient_scope', message: `该 Key 缺少 ${scope} 权限` })
    }
  })

  server.addHook('onResponse', async (req, reply) => {
    logApiRequest(db, {
      keyId: req.apiKey?.id ?? null,
      method: req.method,
      route: req.routeOptions.url ?? req.url,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
      ip: req.ip,
    })
    if (req.apiKey) touchKey(db, req.apiKey.id)
  })

  // ---------- meta ----------
  server.route({
    method: 'GET',
    url: '/meta',
    config: { scope: undefined },
    schema: {
      tags: ['meta'],
      summary: '当前 API Key 的访问信息',
      description: '返回 key 的权限范围与可访问项目，便于 Agent 自检。',
      response: {
        200: z.object({
          service: z.string(),
          version: z.string(),
          key_name: z.string(),
          scopes: z.array(z.string()),
          projects: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), demo: z.boolean() })),
          write: z
            .object({ endpoints: z.array(z.string()), note: z.string() })
            .optional()
            .describe('key 具备 knowledge:write 时列出写入端点——即使 Agent 持有旧版 OpenAPI 缓存也能自检发现写入面'),
        }),
      },
    },
    handler: async (req) => {
      const key = req.apiKey!
      const projects = store
        .listProjects()
        .filter((p) => keyAllowsProject(key, p.id))
        .map((p) => ({ id: p.id, name: p.name, kind: p.kind, demo: Boolean(p.demo) }))
      const write = key.scopes.includes('knowledge:write')
        ? {
            endpoints: [
              'POST /api/v1/projects',
              'POST /api/v1/projects/{id}/research',
              'POST /api/v1/projects/{id}/import',
              'POST /api/v1/projects/{id}/import-url',
              'POST /api/v1/projects/{id}/import-reviews',
            ],
            note: '写入=提交原始资料（评论/文档/URL），不能直接写 claims/evidence——结论由 Mindex 管线蒸馏并逐字校验。各端点格式契约见 GET /api/v1/openapi.json（重新拉取，勿用缓存）。',
          }
        : undefined
      return { service: 'mindex', version: '0.1.0', key_name: key.name, scopes: key.scopes, projects, write }
    },
  })

  // ---------- projects ----------
  server.route({
    method: 'GET',
    url: '/projects',
    config: { scope: 'knowledge:read' },
    schema: {
      tags: ['knowledge'],
      summary: '列出可访问的项目',
      response: {
        200: z.object({
          projects: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              kind: z.string(),
              description: z.string(),
              demo: z.boolean(),
              stats: z.object({ claims: z.number(), trusted_claims: z.number(), sources: z.number() }),
            }),
          ),
        }),
      },
    },
    handler: async (req) => {
      const key = req.apiKey!
      const projects = store
        .listProjects()
        .filter((p) => keyAllowsProject(key, p.id))
        .map((p) => {
          const stats = db
            .prepare(
              `SELECT
                (SELECT COUNT(*) FROM claims WHERE project_id = ? AND merged_into IS NULL) AS claims,
                (SELECT COUNT(*) FROM claims WHERE project_id = ? AND merged_into IS NULL AND review_state IN ('auto_accepted','approved') AND confidence_band IN ('verified','likely')) AS trusted_claims,
                (SELECT COUNT(*) FROM sources WHERE project_id = ?) AS sources`,
            )
            .get(p.id, p.id, p.id) as { claims: number; trusted_claims: number; sources: number }
          return { id: p.id, name: p.name, kind: p.kind, description: p.description, demo: Boolean(p.demo), stats }
        })
      return { projects }
    },
  })

  // ---------- search ----------
  server.route({
    method: 'GET',
    url: '/search',
    config: { scope: 'knowledge:read' },
    schema: {
      tags: ['knowledge'],
      summary: '混合检索知识结论',
      description:
        '关键词(jieba 分词 FTS) + 证据命中 + 子串兜底的混合检索，RRF 融合后按置信度/时效重排。默认只返回可信知识（auto_accepted/approved）。每条结果带引用。',
      querystring: z.object({
        q: z.string().min(1).describe('查询词（中英文均可）'),
        project_id: z.string().optional().describe('限定项目；不传则在 Key 可访问的全部项目中检索'),
        types: z.string().optional().describe('逗号分隔: official_fact,player_opinion,system_inference,creative_insight'),
        bands: z.string().optional().describe('逗号分隔: verified,likely,uncertain,disputed,insufficient'),
        topics: z.string().optional().describe('逗号分隔主题过滤'),
        include_untrusted: z.coerce.boolean().default(false).describe('是否包含待审核/隔离的结论（默认否）'),
        limit: z.coerce.number().int().min(1).max(50).default(10),
      }),
      response: {
        200: z.object({
          query: z.string(),
          total: z.number(),
          hits: z.array(
            z.object({
              score: z.number(),
              matched_via: z.array(z.string()),
              claim: claimSummarySchema,
              citations: z.array(citationSchema),
            }),
          ),
        }),
        403: z.object({ error: z.string(), message: z.string().optional() }),
      },
    },
    handler: async (req, reply) => {
      const key = req.apiKey!
      const q = req.query
      if (q.project_id && !keyAllowsProject(key, q.project_id)) {
        return reply.code(403).send({ error: 'project_forbidden', message: '该 Key 无权访问此项目' })
      }
      const allowed = new Set(store.listProjects().filter((p) => keyAllowsProject(key, p.id)).map((p) => p.id))
      const hits = searchClaims(db, {
        projectId: q.project_id,
        query: q.q,
        claimTypes: q.types?.split(',').filter(Boolean),
        bands: q.bands?.split(',').filter(Boolean),
        topics: q.topics?.split(',').filter(Boolean),
        reviewStates: q.include_untrusted ? ['auto_accepted', 'approved', 'pending', 'quarantined'] : undefined,
        limit: q.limit,
      })
      const rows = hits
        .map((h) => {
          const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(h.claimId) as Record<string, unknown>
          return { hit: h, claim }
        })
        .filter(({ claim }) => allowed.has(claim.project_id as string))
      return {
        query: q.q,
        total: rows.length,
        hits: rows.map(({ hit, claim }) => ({
          score: Math.round(hit.score * 10000) / 10000,
          matched_via: hit.matchedVia,
          claim: {
            id: claim.id as string,
            seq: claim.seq as number,
            claim_type: claim.claim_type as string,
            topic: claim.topic as string,
            text: claim.text as string,
            confidence: claim.confidence as number | null,
            confidence_band: claim.confidence_band as string,
            review_state: claim.review_state as string,
            rank: claim.rank as string,
            project_id: claim.project_id as string,
            version_min: claim.version_min as string | null,
            valid_until: claim.valid_until as string | null,
            opinion_stats: claim.opinion_stats ? pj(claim.opinion_stats as string, null) : null,
            updated_at: claim.updated_at as string,
          },
          citations: (
            db
              .prepare(
                `SELECT e.id, e.quote, e.published_at, s.name AS source_name, s.url, s.source_type
                 FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id JOIN sources s ON s.id = e.source_id
                 WHERE ce.claim_id = ? AND ce.stance = 'supports' ORDER BY s.authority_prior DESC LIMIT 2`,
              )
              .all(claim.id) as Record<string, unknown>[]
          ).map((c) => ({
            evidence_id: c.id as string,
            source: c.source_name as string,
            url: (c.url as string) || null,
            quote: (c.quote as string).slice(0, 160),
            published_at: (c.published_at as string) || null,
            quotable: c.source_type !== 'store_review' && c.source_type !== 'community',
          })),
        })),
      }
    },
  })

  // ---------- claim detail ----------
  server.route({
    method: 'GET',
    url: '/claims/:id',
    config: { scope: 'knowledge:read' },
    schema: {
      tags: ['knowledge'],
      summary: '知识结论完整详情（含全部证据与溯源链）',
      params: z.object({ id: z.string() }),
    },
    handler: async (req, reply) => {
      const detail = getClaimDetail(db, req.params.id)
      if (!detail) return reply.code(404).send({ error: 'not_found' })
      if (!keyAllowsProject(req.apiKey!, detail.project_id as string)) {
        return reply.code(403).send({ error: 'project_forbidden', message: '该 Key 无权访问此项目' })
      }
      return detail
    },
  })

  // ---------- evidence detail ----------
  server.route({
    method: 'GET',
    url: '/evidence/:id',
    config: { scope: 'knowledge:read' },
    schema: {
      tags: ['knowledge'],
      summary: '证据详情（原文引文、上下文、来源与抓取快照信息）',
      params: z.object({ id: z.string() }),
    },
    handler: async (req, reply) => {
      const row = db
        .prepare(
          `SELECT e.*, s.name AS source_name, s.url AS source_url, s.platform, s.source_type, s.connector, s.authority_prior, s.license_note,
                  sn.fetched_at, sn.content_hash, sn.lang AS snapshot_lang, d.url AS document_url, d.title AS document_title, d.doc_type
           FROM evidence e
           JOIN sources s ON s.id = e.source_id
           JOIN snapshots sn ON sn.id = e.snapshot_id
           JOIN documents d ON d.id = sn.document_id
           WHERE e.id = ?`,
        )
        .get(req.params.id) as Record<string, unknown> | undefined
      if (!row) return reply.code(404).send({ error: 'not_found' })
      if (!keyAllowsProject(req.apiKey!, row.project_id as string)) {
        return reply.code(403).send({ error: 'project_forbidden' })
      }
      const claims = db
        .prepare(
          `SELECT c.id, c.text, c.confidence_band, ce.stance FROM claim_evidence ce JOIN claims c ON c.id = ce.claim_id WHERE ce.evidence_id = ?`,
        )
        .all(req.params.id)
      return { ...row, used_by_claims: claims }
    },
  })

  // ---------- sources ----------
  server.route({
    method: 'GET',
    url: '/sources/:id',
    config: { scope: 'knowledge:read' },
    schema: {
      tags: ['knowledge'],
      summary: '来源详情',
      params: z.object({ id: z.string() }),
    },
    handler: async (req, reply) => {
      const row = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined
      if (!row) return reply.code(404).send({ error: 'not_found' })
      if (!keyAllowsProject(req.apiKey!, row.project_id as string)) return reply.code(403).send({ error: 'project_forbidden' })
      const docs = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE source_id = ?`).get(req.params.id) as { n: number }
      return { ...row, document_count: docs.n }
    },
  })

  // ---------- context pack ----------
  server.route({
    method: 'POST',
    url: '/context-pack',
    config: { scope: 'context:read' },
    schema: {
      tags: ['context'],
      summary: '生成带引用的 Context Pack',
      description:
        '为下游创意 Agent 生成结构化知识包：只含可信知识，逐条带引用、置信度与有效期；未收录的低置信/冲突知识在 excluded 中诚实声明。',
      body: z.object({
        project_id: z.string(),
        task: z.string().optional().describe('本次创意任务描述，用于相关性排序'),
        focus: z.array(z.string()).optional().describe('聚焦主题: product/gameplay/monetization/audience/market/brand/creative/performance'),
        budget_tokens: z.number().int().min(800).max(32000).default(6000),
        min_band: z.enum(['verified', 'likely']).default('likely'),
      }),
    },
    handler: async (req, reply) => {
      const { project_id, task, focus, budget_tokens, min_band } = req.body
      if (!keyAllowsProject(req.apiKey!, project_id)) {
        return reply.code(403).send({ error: 'project_forbidden', message: '该 Key 无权访问此项目' })
      }
      const pack = buildContextPack(db, { projectId: project_id, task, focus, budgetTokens: budget_tokens, minBand: min_band })
      if (!pack) return reply.code(404).send({ error: 'not_found', message: '项目不存在' })
      return pack
    },
  })

  // ============================================================
  // 写入平面（scope: knowledge:write）——「喂数据」开放给 Agent：
  // 建项目 / 发起研究 / 导入文档、URL、评论。
  // 审核裁决与删除刻意不开放：可信与否由置信引擎与人类审核决定，
  // 采集 Agent 不能给自己交来的内容背书——这是信任边界。
  // ============================================================

  server.route({
    method: 'POST',
    url: '/projects',
    config: { scope: 'knowledge:write' },
    schema: {
      tags: ['ingest'],
      summary: '创建游戏项目',
      description:
        '创建一个新的手游项目（知识容器）。需要 key 的项目权限为 *（全项目）——绑定了特定项目的 key 不能创建新项目。创建后可对其发起研究或导入资料。',
      body: z.object({
        name: z.string().min(1).max(120).describe('游戏名'),
        description: z.string().max(4000).default('').describe('一句话描述（可选）'),
        aliases: z.array(z.string()).default([]).describe('别名/英文名，帮助连接器定位（可选）'),
        official_urls: z.array(z.string()).default([]).describe('官网、TapTap 页等官方链接（可选；TapTap 链接能激活聚合评分抓取）'),
      }),
    },
    handler: async (req, reply) => {
      if (!req.apiKey!.projectIds.includes('*')) {
        return reply.code(403).send({ error: 'project_forbidden', message: '该 Key 绑定了特定项目，不能创建新项目（需要项目权限为 * 的 Key）' })
      }
      const p = store.createProject({
        name: req.body.name,
        kind: 'game',
        description: req.body.description,
        aliases: req.body.aliases,
        officialUrls: req.body.official_urls.filter((u) => /^https?:\/\//.test(u)),
      })
      return { id: p.id, name: p.name }
    },
  })

  server.route({
    method: 'POST',
    url: '/projects/:id/research',
    config: { scope: 'knowledge:write' },
    schema: {
      tags: ['ingest'],
      summary: '发起主动研究',
      description:
        '让 Mindex 研究 Agent 对该项目跨国内平台（App Store CN/TapTap/B站/小红书/抖音/快手/微博等）采集并验证知识。异步执行，返回 run_id。30 分钟内已完成同目标研究会返回 409 duplicate_recent（带 force=true 重试可强制）。',
      params: z.object({ id: z.string() }),
      body: z.object({
        goal: z.string().max(500).optional().describe('研究目标（缺省=全面了解产品、受众与玩家口碑）'),
        force: z.boolean().default(false).describe('跳过 30 分钟内重复研究确认'),
      }),
    },
    handler: async (req, reply) => {
      if (!keyAllowsProject(req.apiKey!, req.params.id)) {
        return reply.code(403).send({ error: 'project_forbidden', message: '该 Key 无此项目权限' })
      }
      if (!store.getProject(req.params.id)) return reply.code(404).send({ error: 'not_found' })
      const goal = req.body.goal ?? '全面了解产品、受众与玩家口碑'
      if (!req.body.force) {
        const recent = db
          .prepare(`SELECT id FROM research_runs WHERE project_id = ? AND goal = ? AND status = 'done' AND finished_at >= ? LIMIT 1`)
          .get(req.params.id, goal, new Date(Date.now() - 30 * 60_000).toISOString())
        if (recent) {
          return reply.code(409).send({ error: 'duplicate_recent', message: '30 分钟内已完成同目标研究，如需重复请带 force=true' })
        }
      }
      try {
        return { run_id: startResearchRun(store, req.params.id, { goal }) }
      } catch (err) {
        return reply.code(409).send({ error: 'run_conflict', message: String((err as Error).message) })
      }
    },
  })

  server.route({
    method: 'POST',
    url: '/projects/:id/import',
    config: { scope: 'knowledge:write' },
    schema: {
      tags: ['ingest'],
      summary: '导入文档/资料（纯文本）',
      description:
        '把一段资料原文导入知识库：公告、行业文章、内部调研等。内容会作为不可变快照入库，走抽取→逐字引文校验→置信度管线。只提交真实原文，不要改写或概括——引文逐字校验，对不上的抽取会被丢弃。',
      params: z.object({ id: z.string() }),
      body: z.object({
        title: z.string().min(1).max(300).describe('资料标题'),
        text: z.string().min(20).max(500_000).describe('资料原文（≥20 字符）'),
        url: z.string().optional().describe('原文链接（可选，用于溯源）'),
        platform: z.string().default('internal').describe('来源平台标识，如 weibo / tieba / haoyoukuaibao / internal'),
        source_type: z.enum(['official', 'internal_doc', 'press', 'community', 'user_note']).default('user_note').describe('内容性质——决定权威先验：official 0.9 / internal_doc 0.8 / press 0.7 / user_note 0.6 / community 0.4'),
      }),
    },
    handler: async (req, reply) => {
      if (!keyAllowsProject(req.apiKey!, req.params.id)) {
        return reply.code(403).send({ error: 'project_forbidden', message: '该 Key 无此项目权限' })
      }
      if (!store.getProject(req.params.id)) return reply.code(404).send({ error: 'not_found' })
      const runId = startImportRun(store, req.params.id, {
        title: req.body.title,
        text: req.body.text,
        url: req.body.url || null,
        platform: req.body.platform,
        sourceType: req.body.source_type,
      })
      return { run_id: runId }
    },
  })

  server.route({
    method: 'POST',
    url: '/projects/:id/import-url',
    config: { scope: 'knowledge:write' },
    schema: {
      tags: ['ingest'],
      summary: '按 URL 抓取并导入',
      description:
        '服务端抓取给定 URL 的正文并导入（适合行业媒体文章、官网公告）。JS 渲染壳页或反爬页面会返回 422（content_too_thin / fetch_failed），此时改用 /import 提交复制的正文。',
      params: z.object({ id: z.string() }),
      body: z.object({
        url: z.string().url().max(1000),
        platform: z.string().default('web'),
        source_type: z.enum(['official', 'internal_doc', 'press', 'community', 'user_note']).default('press'),
      }),
    },
    handler: async (req, reply) => {
      if (!keyAllowsProject(req.apiKey!, req.params.id)) {
        return reply.code(403).send({ error: 'project_forbidden', message: '该 Key 无此项目权限' })
      }
      if (!store.getProject(req.params.id)) return reply.code(404).send({ error: 'not_found' })
      const fetched = await fetchUrlForImport(req.body.url)
      if (!fetched.ok) return reply.code(422).send({ error: fetched.code, message: fetched.message })
      const runId = startImportRun(store, req.params.id, {
        title: fetched.title,
        text: fetched.text,
        url: req.body.url,
        platform: req.body.platform,
        sourceType: req.body.source_type,
      })
      return { run_id: runId, title: fetched.title, chars: fetched.text.length }
    },
  })

  server.route({
    method: 'POST',
    url: '/projects/:id/import-reviews',
    config: { scope: 'knowledge:write' },
    schema: {
      tags: ['ingest'],
      summary: '批量导入平台评论（TapTap 等）',
      description: `把外部采集的玩家评论批量导入。每条评论成为独立带溯源的文档，走口碑管线产出 player_opinion（点赞数仅展示，不进置信度）。

**只提交真实抓到的评论原文**——不要改写、补写或翻译：系统对引文做逐字校验，改写过的内容会被丢弃。

**JSON 格式（推荐，format="json"）**：reviews 数组，每条 { content(必填,≥6字符), score(1-5,可空), author, up_count, published_at(ISO), review_id }。

**Markdown 格式（format="markdown"，宽容解析）**：
- 评论分隔（按优先级识别）：单独一行的 "---" 分割线 > 每条一个 "##" 标题 > "1." 编号列表 > 空行分隔
- 每条内可选元信息：评分（★★★★ 或 评分：4 或 4/5）、作者（作者：xxx 或 @xxx）、日期（2026-07-01 或 2026年7月1日）、点赞（赞：12 或 👍12）
- 元信息行会被剥离，剩余文本为评论正文（≥6 字符，否则丢弃）

解析出 0 条会返回 400 no_reviews。响应中 parsed_reviews 为实际解析条数——提交后请核对是否与采集数一致。`,
      params: z.object({ id: z.string() }),
      body: z.object({
        platform: z.string().default('taptap').describe('评论来源平台：taptap / haoyoukuaibao / tieba / …'),
        app_name: z.string().optional().describe('游戏名（可选，用于来源命名）'),
        source_url: z.string().optional().describe('评论页 URL（可选，用于溯源回指）'),
        format: z.enum(['json', 'markdown']).default('json'),
        markdown: z.string().max(2_000_000).optional().describe('format=markdown 时的评论文本'),
        reviews: z
          .array(
            z.object({
              content: z.string().describe('评论原文，必填，≥6 字符'),
              score: z.number().nullable().optional().describe('1-5 星'),
              author: z.string().nullable().optional(),
              up_count: z.number().nullable().optional().describe('点赞数（仅展示，不进置信度）'),
              published_at: z.string().nullable().optional().describe('ISO 日期'),
              review_id: z.string().nullable().optional().describe('平台评论 id，用于去重溯源'),
            }),
          )
          .optional()
          .describe('format=json 时的评论数组'),
      }),
    },
    handler: async (req, reply) => {
      if (!keyAllowsProject(req.apiKey!, req.params.id)) {
        return reply.code(403).send({ error: 'project_forbidden', message: '该 Key 无此项目权限' })
      }
      if (!store.getProject(req.params.id)) return reply.code(404).send({ error: 'not_found' })
      const b = req.body
      const reviews = b.format === 'json' && b.reviews ? normalizeReviews(b.reviews) : b.markdown ? parseReviewMarkdown(b.markdown) : []
      if (reviews.length === 0) {
        return reply.code(400).send({ error: 'no_reviews', message: '未能从输入中解析出评论（检查格式，或核对 format 字段与实际提交内容一致）' })
      }
      const runId = startReviewImportRun(store, req.params.id, {
        platform: b.platform,
        appName: b.app_name,
        sourceUrl: b.source_url ?? null,
        reviews,
      })
      return { run_id: runId, parsed_reviews: reviews.length }
    },
  })
}
