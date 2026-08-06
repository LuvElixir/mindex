import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { config } from '../config.js'
import type { Store } from '../core/store.js'
import { connectors } from '../connectors/registry.js'
import { fetchUrlForImport, isProjectRunning, startImportRun, startResearchRun, startReviewImportRun } from '../agent/pipeline.js'
import { CHAT_STREAM_SYSTEM, CHAT_SYSTEM } from '../agent/prompts.js'
import { normalizeReviews, parseReviewMarkdown } from '../agent/reviewImport.js'
import { getClaimDetail, searchClaims } from '../search/index.js'
import { pj } from '../lib/util.js'
import { SETTING_KEYS, effectiveBaobaomi, effectiveLlm, effectiveSite, effectiveTikhub, maskSecret, setSetting, type SettingKey } from '../core/settings.js'
import { describeProvider, resolveProvider } from '../llm/provider.js'
import { SCOPES, checkAdminToken, createApiKey, listApiKeys, revokeApiKey, rotateApiKey, type Scope } from './auth.js'

/**
 * Management plane: /app/* — guarded by the admin token (auto-generated on first
 * boot, printed to console / MINDEX_ADMIN_TOKEN). Hidden from public OpenAPI docs.
 */
export async function appRoutes(app: FastifyInstance, opts: { store: Store }): Promise<void> {
  const { store } = opts
  const db = store.db
  const server = app.withTypeProvider<ZodTypeProvider>()

  // public compliance/site info — served WITHOUT auth (login page + footer need it)
  server.route({
    method: 'GET',
    url: '/site-info',
    schema: { hide: true },
    handler: async () => effectiveSite(),
  })

  server.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url ?? ''
    if (url.endsWith('/verify') || url.endsWith('/site-info')) return // public endpoints
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (!checkAdminToken(token, config.adminToken)) {
      return reply.code(401).send({ error: 'unauthorized', message: '需要管理员 Token' })
    }
  })

  server.route({
    method: 'POST',
    url: '/verify',
    schema: { hide: true, body: z.object({ token: z.string() }) },
    handler: async (req) => ({ ok: checkAdminToken(req.body.token, config.adminToken) }),
  })

  // ---------- overview ----------
  server.route({
    method: 'GET',
    url: '/overview',
    schema: { hide: true },
    handler: async () => {
      const projects = store.listProjects().map((p) => {
        const s = db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL) AS claims,
              (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL AND review_state IN ('auto_accepted','approved') AND confidence_band IN ('verified','likely')) AS trusted,
              (SELECT COUNT(*) FROM sources WHERE project_id = :id) AS sources,
              (SELECT COUNT(*) FROM review_queue WHERE project_id = :id AND state = 'todo') AS pending_review,
              (SELECT COUNT(*) FROM conflicts WHERE project_id = :id AND status = 'open') AS open_conflicts`,
          )
          .get({ id: p.id }) as Record<string, number>
        return { ...p, stats: s, running: isProjectRunning(p.id) }
      })
      const recentRuns = db
        .prepare(
          `SELECT r.*, p.name AS project_name FROM research_runs r JOIN projects p ON p.id = r.project_id ORDER BY r.started_at DESC LIMIT 8`,
        )
        .all()
      const recentApiCalls = db
        .prepare(
          `SELECT l.*, k.name AS key_name FROM api_logs l LEFT JOIN api_keys k ON k.id = l.key_id ORDER BY l.id DESC LIMIT 10`,
        )
        .all()
      const recentClaims = db
        .prepare(
          `SELECT c.id, c.seq, c.text, c.claim_type, c.confidence_band, c.updated_at, p.name AS project_name, c.project_id
           FROM claims c JOIN projects p ON p.id = c.project_id WHERE c.merged_into IS NULL ORDER BY c.updated_at DESC LIMIT 10`,
        )
        .all()
      return { projects, recentRuns, recentApiCalls, recentClaims }
    },
  })

  // ---------- projects ----------
  server.route({
    method: 'POST',
    url: '/projects',
    schema: {
      hide: true,
      body: z.object({
        name: z.string().min(1).max(120),
        kind: z.enum(['game']).default('game'),
        description: z.string().max(4000).default(''),
        aliases: z.array(z.string()).default([]),
        competitors: z.array(z.string()).default([]),
        official_urls: z.array(z.string()).default([]),
      }),
    },
    handler: async (req) => {
      const p = store.createProject({
        name: req.body.name,
        kind: req.body.kind,
        description: req.body.description,
        aliases: req.body.aliases,
        competitors: req.body.competitors,
        officialUrls: req.body.official_urls.filter((u) => /^https?:\/\//.test(u)),
      })
      return p
    },
  })

  server.route({
    method: 'GET',
    url: '/projects/:id',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req, reply) => {
      const p = store.getProject(req.params.id)
      if (!p) return reply.code(404).send({ error: 'not_found' })
      const stats = db
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL) AS claims,
            (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL AND confidence_band = 'verified') AS verified,
            (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL AND confidence_band = 'likely') AS likely,
            (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL AND confidence_band = 'uncertain') AS uncertain,
            (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL AND confidence_band = 'disputed') AS disputed,
            (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL AND confidence_band = 'insufficient') AS insufficient,
            (SELECT COUNT(*) FROM evidence WHERE project_id = :id) AS evidence,
            (SELECT COUNT(*) FROM sources WHERE project_id = :id) AS sources,
            (SELECT COUNT(*) FROM documents WHERE project_id = :id) AS documents,
            (SELECT COUNT(*) FROM review_queue WHERE project_id = :id AND state = 'todo') AS pending_review,
            (SELECT COUNT(*) FROM conflicts WHERE project_id = :id AND status = 'open') AS open_conflicts`,
        )
        .get({ id: p.id }) as Record<string, number>
      return { ...p, stats, running: isProjectRunning(p.id) }
    },
  })

  server.route({
    method: 'PATCH',
    url: '/projects/:id',
    schema: {
      hide: true,
      params: z.object({ id: z.string() }),
      body: z.object({
        description: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        competitors: z.array(z.string()).optional(),
        current_version: z.string().optional(),
      }),
    },
    handler: async (req) => {
      store.updateProject(req.params.id, {
        description: req.body.description,
        aliases: req.body.aliases,
        competitors: req.body.competitors,
        currentVersion: req.body.current_version,
      })
      return store.getProject(req.params.id)
    },
  })

  // ---------- research runs ----------
  server.route({
    method: 'POST',
    url: '/projects/:id/research',
    schema: {
      hide: true,
      params: z.object({ id: z.string() }),
      body: z.object({
        goal: z.string().max(500).optional(),
        connector_ids: z.array(z.string()).optional(),
        max_rounds: z.number().int().min(1).max(3).optional(),
        force: z.boolean().default(false),
      }),
    },
    handler: async (req, reply) => {
      const goal = req.body.goal ?? '全面了解产品、受众与玩家口碑'
      if (!req.body.force) {
        const recent = db
          .prepare(`SELECT id FROM research_runs WHERE project_id = ? AND goal = ? AND status = 'done' AND finished_at >= ? LIMIT 1`)
          .get(req.params.id, goal, new Date(Date.now() - 30 * 60_000).toISOString())
        if (recent) {
          return reply.code(409).send({ error: 'duplicate_recent', message: '30 分钟内已完成同目标研究，如需重复请确认（force）' })
        }
      }
      try {
        const runId = startResearchRun(store, req.params.id, {
          goal,
          connectorIds: req.body.connector_ids,
          maxRounds: req.body.max_rounds,
        })
        return { run_id: runId }
      } catch (err) {
        return reply.code(409).send({ error: 'run_conflict', message: String((err as Error).message) })
      }
    },
  })

  server.route({
    method: 'POST',
    url: '/projects/:id/import',
    schema: {
      hide: true,
      params: z.object({ id: z.string() }),
      body: z.object({
        title: z.string().min(1).max(300),
        text: z.string().min(20).max(500_000),
        url: z.string().optional(),
        platform: z.string().default('internal'),
        source_type: z.enum(['official', 'internal_doc', 'press', 'community', 'user_note']).default('user_note'),
        published_at: z.string().optional(),
        author_handle: z.string().optional(),
      }),
    },
    handler: async (req, reply) => {
      const p = store.getProject(req.params.id)
      if (!p) return reply.code(404).send({ error: 'not_found' })
      const runId = startImportRun(store, req.params.id, {
        title: req.body.title,
        text: req.body.text,
        url: req.body.url || null,
        platform: req.body.platform,
        sourceType: req.body.source_type,
        publishedAt: req.body.published_at || null,
        authorHandle: req.body.author_handle || null,
      })
      return { run_id: runId }
    },
  })

  // URL 抓取导入：粘贴文章链接（行业媒体/官网公告等）→ 服务端抓取正文 → 走标准导入管线
  server.route({
    method: 'POST',
    url: '/projects/:id/import-url',
    schema: {
      hide: true,
      params: z.object({ id: z.string() }),
      body: z.object({
        url: z.string().url().max(1000),
        platform: z.string().default('web'),
        source_type: z.enum(['official', 'internal_doc', 'press', 'community', 'user_note']).default('press'),
      }),
    },
    handler: async (req, reply) => {
      const p = store.getProject(req.params.id)
      if (!p) return reply.code(404).send({ error: 'not_found' })
      const fetched = await fetchUrlForImport(req.body.url)
      if (!fetched.ok) return reply.code(422).send({ error: fetched.code, message: fetched.message })
      const runId = startImportRun(store, p.id, {
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
    schema: {
      hide: true,
      params: z.object({ id: z.string() }),
      body: z.object({
        platform: z.string().default('taptap'),
        app_name: z.string().optional(),
        source_url: z.string().optional(),
        format: z.enum(['json', 'markdown']).default('markdown'),
        markdown: z.string().max(2_000_000).optional(),
        reviews: z
          .array(
            z.object({
              content: z.string(),
              score: z.number().nullable().optional(),
              author: z.string().nullable().optional(),
              up_count: z.number().nullable().optional(),
              published_at: z.string().nullable().optional(),
              review_id: z.string().nullable().optional(),
            }),
          )
          .optional(),
      }),
    },
    handler: async (req, reply) => {
      const p = store.getProject(req.params.id)
      if (!p) return reply.code(404).send({ error: 'not_found' })
      const b = req.body
      const reviews =
        b.format === 'json' && b.reviews
          ? normalizeReviews(b.reviews)
          : b.markdown
            ? parseReviewMarkdown(b.markdown)
            : []
      if (reviews.length === 0) {
        return reply.code(400).send({ error: 'no_reviews', message: '未能从输入中解析出评论（检查格式）' })
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

  // dry-run parse preview (no ingestion) — lets the UI show how many reviews were parsed
  server.route({
    method: 'POST',
    url: '/parse-reviews',
    schema: {
      hide: true,
      body: z.object({ markdown: z.string().max(2_000_000) }),
    },
    handler: async (req) => {
      const reviews = parseReviewMarkdown(req.body.markdown)
      return {
        count: reviews.length,
        with_score: reviews.filter((r) => r.score != null).length,
        with_author: reviews.filter((r) => r.author != null).length,
        sample: reviews.slice(0, 3).map((r) => ({ ...r, content: r.content.slice(0, 100) })),
      }
    },
  })

  server.route({
    method: 'GET',
    url: '/projects/:id/runs',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req) =>
      db.prepare(`SELECT * FROM research_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 30`).all(req.params.id),
  })

  server.route({
    method: 'GET',
    url: '/runs/:id',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req, reply) => {
      const run = db.prepare(`SELECT * FROM research_runs WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined
      if (!run) return reply.code(404).send({ error: 'not_found' })
      return { ...run, plan: pj(run.plan as string, {}), stats: pj(run.stats as string, {}) }
    },
  })

  server.route({
    method: 'GET',
    url: '/runs/:id/events',
    schema: {
      hide: true,
      params: z.object({ id: z.string() }),
      querystring: z.object({ after: z.coerce.number().int().default(0) }),
    },
    handler: async (req) => {
      const events = db
        .prepare(`SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT 200`)
        .all(req.params.id, req.query.after) as Record<string, unknown>[]
      const run = db.prepare(`SELECT status FROM research_runs WHERE id = ?`).get(req.params.id) as { status: string } | undefined
      return {
        status: run?.status ?? 'unknown',
        events: events.map((e) => ({ ...e, detail: pj(e.detail as string, {}) })),
      }
    },
  })

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

  // ---------- claims ----------
  server.route({
    method: 'GET',
    url: '/projects/:id/claims',
    schema: {
      hide: true,
      params: z.object({ id: z.string() }),
      querystring: z.object({
        type: z.string().optional(),
        band: z.string().optional(),
        topic: z.string().optional(),
        state: z.string().optional(),
        q: z.string().optional(),
        entity_id: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    handler: async (req) => {
      const f = req.query
      const where: string[] = ['project_id = ?', 'merged_into IS NULL']
      const params: unknown[] = [req.params.id]
      if (f.entity_id) {
        where.push('id IN (SELECT claim_id FROM claim_entities WHERE entity_id = ?)')
        params.push(f.entity_id)
      }
      if (f.type) {
        where.push('claim_type = ?')
        params.push(f.type)
      }
      if (f.band) {
        where.push('confidence_band = ?')
        params.push(f.band)
      }
      if (f.topic) {
        where.push('topic = ?')
        params.push(f.topic)
      }
      if (f.state) {
        where.push('review_state = ?')
        params.push(f.state)
      }
      if (f.q) {
        where.push('text LIKE ?')
        params.push(`%${f.q}%`)
      }
      const rows = db
        .prepare(
          `SELECT id, seq, claim_type, topic, text, confidence, confidence_band, review_state, rank, extraction_provider,
                  version_min, valid_until, opinion_stats, updated_at,
                  (SELECT COUNT(*) FROM claim_evidence WHERE claim_id = claims.id) AS evidence_count
           FROM claims WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, f.limit, f.offset) as Record<string, unknown>[]
      const total = db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE ${where.join(' AND ')}`).get(...params) as { n: number }
      return {
        total: total.n,
        claims: rows.map((r) => ({ ...r, opinion_stats: r.opinion_stats ? pj(r.opinion_stats as string, null) : null })),
      }
    },
  })

  server.route({
    method: 'GET',
    url: '/claims/:id',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req, reply) => {
      const detail = getClaimDetail(db, req.params.id)
      if (!detail) return reply.code(404).send({ error: 'not_found' })
      return detail
    },
  })

  server.route({
    method: 'POST',
    url: '/claims/:id/review',
    schema: {
      hide: true,
      params: z.object({ id: z.string() }),
      body: z.object({ action: z.enum(['approve', 'reject', 'quarantine']), reason: z.string().default('') }),
    },
    handler: async (req, reply) => {
      const claim = db.prepare(`SELECT id, project_id FROM claims WHERE id = ?`).get(req.params.id) as { id: string; project_id: string } | undefined
      if (!claim) return reply.code(404).send({ error: 'not_found' })
      const state = req.body.action === 'approve' ? 'approved' : req.body.action === 'reject' ? 'rejected' : 'quarantined'
      store.setReviewState(claim.id, state, 'human:admin', req.body.reason)
      db.prepare(`UPDATE review_queue SET state = 'done', decision = ?, decided_at = datetime('now') WHERE item_type = 'claim' AND item_id = ? AND state = 'todo'`).run(
        req.body.action,
        claim.id,
      )
      return { ok: true, review_state: state }
    },
  })

  // ---------- review queue / conflicts ----------
  server.route({
    method: 'GET',
    url: '/projects/:id/review-queue',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req) => {
      const items = db
        .prepare(`SELECT * FROM review_queue WHERE project_id = ? AND state = 'todo' ORDER BY priority, created_at LIMIT 100`)
        .all(req.params.id) as Record<string, unknown>[]
      return items.map((item) => {
        let payload: unknown = null
        if (item.item_type === 'claim') payload = getClaimDetail(db, item.item_id as string)
        else if (item.item_type === 'source') payload = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(item.item_id as string)
        else if (item.item_type === 'conflict') payload = db.prepare(`SELECT * FROM conflicts WHERE id = ?`).get(item.item_id as string)
        return { ...item, payload }
      })
    },
  })

  server.route({
    method: 'GET',
    url: '/projects/:id/conflicts',
    schema: { hide: true, params: z.object({ id: z.string() }), querystring: z.object({ status: z.string().optional() }) },
    handler: async (req) => {
      const status = req.query.status
      return db
        .prepare(
          `SELECT c.*, ca.text AS claim_a_text, ca.confidence_band AS claim_a_band, cb.text AS claim_b_text, cb.confidence_band AS claim_b_band
           FROM conflicts c JOIN claims ca ON ca.id = c.claim_a JOIN claims cb ON cb.id = c.claim_b
           WHERE c.project_id = ? ${status ? 'AND c.status = ?' : ''} ORDER BY c.created_at DESC LIMIT 100`,
        )
        .all(...([req.params.id, ...(status ? [status] : [])] as string[]))
    },
  })

  server.route({
    method: 'POST',
    url: '/conflicts/:id/resolve',
    schema: {
      hide: true,
      params: z.object({ id: z.string() }),
      body: z.object({
        status: z.enum(['resolved_a', 'resolved_b', 'both_valid_scoped', 'dismissed']),
        note: z.string().default(''),
      }),
    },
    handler: async (req, reply) => {
      const conflict = db.prepare(`SELECT * FROM conflicts WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined
      if (!conflict) return reply.code(404).send({ error: 'not_found' })
      store.resolveConflict(req.params.id, req.body.status, req.body.note, 'human:admin')
      // resolved_a means claim A wins → deprecate B (and vice versa)
      if (req.body.status === 'resolved_a' || req.body.status === 'resolved_b') {
        const loser = req.body.status === 'resolved_a' ? (conflict.claim_b as string) : (conflict.claim_a as string)
        const winner = req.body.status === 'resolved_a' ? (conflict.claim_a as string) : (conflict.claim_b as string)
        store.supersede(loser, winner, 'human:admin', `冲突裁决: ${req.body.note || '人工确认'}`)
      }
      const { scorePhase } = await import('../agent/pipeline.js')
      scorePhase(store, conflict.project_id as string)
      return { ok: true }
    },
  })

  // ---------- sources / documents ----------
  server.route({
    method: 'GET',
    url: '/projects/:id/sources',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req) =>
      db
        .prepare(
          `SELECT s.*,
             (SELECT COUNT(*) FROM documents WHERE source_id = s.id) AS document_count,
             (SELECT COUNT(*) FROM evidence WHERE source_id = s.id) AS evidence_count
           FROM sources s WHERE s.project_id = ? ORDER BY s.authority_prior DESC, evidence_count DESC`,
        )
        .all(req.params.id),
  })

  server.route({
    method: 'GET',
    url: '/sources/:id/documents',
    schema: { hide: true, params: z.object({ id: z.string() }), querystring: z.object({ limit: z.coerce.number().default(50) }) },
    handler: async (req) =>
      db
        .prepare(
          `SELECT d.*, (SELECT COUNT(*) FROM snapshots WHERE document_id = d.id) AS snapshot_count,
             (SELECT id FROM snapshots WHERE document_id = d.id ORDER BY fetched_at DESC LIMIT 1) AS latest_snapshot_id
           FROM documents d WHERE d.source_id = ? ORDER BY d.first_seen_at DESC LIMIT ?`,
        )
        .all(req.params.id, req.query.limit),
  })

  server.route({
    method: 'GET',
    url: '/snapshots/:id',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req, reply) => {
      const snap = db
        .prepare(
          `SELECT sn.*, d.title, d.url AS document_url, d.doc_type, s.name AS source_name FROM snapshots sn
           JOIN documents d ON d.id = sn.document_id JOIN sources s ON s.id = d.source_id WHERE sn.id = ?`,
        )
        .get(req.params.id) as Record<string, unknown> | undefined
      if (!snap) return reply.code(404).send({ error: 'not_found' })
      return { ...snap, meta: pj(snap.meta as string, {}) }
    },
  })

  // ---------- search ----------
  server.route({
    method: 'GET',
    url: '/search',
    schema: {
      hide: true,
      querystring: z.object({
        q: z.string().min(1),
        project_id: z.string().optional(),
        include_untrusted: z.coerce.boolean().default(true),
        limit: z.coerce.number().int().max(50).default(20),
      }),
    },
    handler: async (req) => {
      const hits = searchClaims(db, {
        projectId: req.query.project_id,
        query: req.query.q,
        reviewStates: req.query.include_untrusted
          ? ['auto_accepted', 'approved', 'pending', 'quarantined']
          : undefined,
        limit: req.query.limit,
      })
      return hits.map((h) => {
        const claim = db
          .prepare(
            `SELECT c.id, c.seq, c.claim_type, c.topic, c.text, c.confidence, c.confidence_band, c.review_state, c.opinion_stats, c.project_id, c.updated_at, p.name AS project_name
             FROM claims c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
          )
          .get(h.claimId) as Record<string, unknown>
        return {
          ...claim,
          opinion_stats: claim.opinion_stats ? pj(claim.opinion_stats as string, null) : null,
          score: h.score,
          matched_via: h.matchedVia,
        }
      })
    },
  })

  // ---------- connectors ----------
  server.route({
    method: 'GET',
    url: '/connectors',
    schema: { hide: true },
    handler: async () =>
      connectors.map((c) => ({
        id: c.id,
        label: c.label,
        status: c.status,
        description: c.description,
        compliance: c.compliance,
      })),
  })

  // ---------- api keys ----------
  server.route({
    method: 'GET',
    url: '/keys',
    schema: { hide: true },
    handler: async () => listApiKeys(db),
  })

  server.route({
    method: 'POST',
    url: '/keys',
    schema: {
      hide: true,
      body: z.object({
        name: z.string().min(1).max(80),
        scopes: z.array(z.enum(SCOPES)).min(1),
        project_ids: z.array(z.string()).min(1).describe('["*"] 表示全部项目'),
        rate_limit_rpm: z.number().int().min(10).max(6000).default(120),
        expires_at: z.string().nullable().optional(),
      }),
    },
    handler: async (req) => {
      const { key, token } = createApiKey(db, {
        name: req.body.name,
        scopes: req.body.scopes as Scope[],
        projectIds: req.body.project_ids,
        rateLimitRpm: req.body.rate_limit_rpm,
        expiresAt: req.body.expires_at ?? null,
      })
      return { key, token, warning: '明文 Token 仅此一次展示，请立即保存' }
    },
  })

  server.route({
    method: 'POST',
    url: '/keys/:id/revoke',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req, reply) => {
      const ok = revokeApiKey(db, req.params.id)
      return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' })
    },
  })

  server.route({
    method: 'POST',
    url: '/keys/:id/rotate',
    schema: { hide: true, params: z.object({ id: z.string() }), body: z.object({ grace_hours: z.number().int().min(0).max(720).default(24) }) },
    handler: async (req, reply) => {
      const result = rotateApiKey(db, req.params.id, req.body.grace_hours)
      if (!result) return reply.code(404).send({ error: 'not_found', message: 'Key 不存在或已撤销' })
      return { ...result, warning: `新 Token 仅此一次展示；旧 Key 将在 ${req.body.grace_hours} 小时后失效` }
    },
  })

  server.route({
    method: 'GET',
    url: '/keys/:id/logs',
    schema: { hide: true, params: z.object({ id: z.string() }), querystring: z.object({ limit: z.coerce.number().default(50) }) },
    handler: async (req) =>
      db.prepare(`SELECT * FROM api_logs WHERE key_id = ? ORDER BY id DESC LIMIT ?`).all(req.params.id, req.query.limit),
  })

  server.route({
    method: 'GET',
    url: '/logs',
    schema: { hide: true, querystring: z.object({ limit: z.coerce.number().default(100) }) },
    handler: async (req) =>
      db
        .prepare(`SELECT l.*, k.name AS key_name FROM api_logs l LEFT JOIN api_keys k ON k.id = l.key_id ORDER BY l.id DESC LIMIT ?`)
        .all(req.query.limit),
  })

  // ---------- settings (模型接入 / 集成) ----------
  server.route({
    method: 'GET',
    url: '/settings',
    schema: { hide: true },
    handler: async () => {
      const llm = effectiveLlm()
      const bbm = effectiveBaobaomi()
      const active = await describeProvider()
      return {
        llm: {
          provider: llm.provider,
          anthropic_api_key: maskSecret(llm.anthropicApiKey),
          anthropic_base_url: llm.anthropicBaseUrl,
          anthropic_model: llm.anthropicModel,
          openai_api_key: maskSecret(llm.openaiApiKey),
          openai_base_url: llm.openaiBaseUrl,
          openai_model: llm.openaiModel,
          claude_cli_model: llm.claudeCliModel,
          source: llm.source,
          active,
        },
        baobaomi: {
          base_url: bbm.baseUrl,
          agent_key: maskSecret(bbm.agentKey),
          source: bbm.source,
        },
        tikhub: (() => {
          const t = effectiveTikhub()
          return { base_url: t.baseUrl, api_key: maskSecret(t.apiKey), source: t.source }
        })(),
        site: effectiveSite(),
        note: '优先级：此处设置 > .env > 默认值。密钥只存本机 SQLite，接口永不返回完整值。',
      }
    },
  })

  server.route({
    method: 'PUT',
    url: '/settings',
    schema: {
      hide: true,
      body: z.object({
        // null = 清除该项（回退到 .env/默认）；不传 = 不变
        llm_provider: z.enum(['auto', 'anthropic', 'openai', 'claude-cli', 'none']).nullish(),
        anthropic_api_key: z.string().max(300).nullish(),
        anthropic_base_url: z.string().max(300).nullish(),
        anthropic_model: z.string().max(120).nullish(),
        openai_api_key: z.string().max(300).nullish(),
        openai_base_url: z.string().max(300).nullish(),
        openai_model: z.string().max(120).nullish(),
        claude_cli_model: z.string().max(120).nullish(),
        baobaomi_base_url: z.string().max(300).nullish(),
        baobaomi_agent_key: z.string().max(300).nullish(),
        tikhub_base_url: z.string().max(300).nullish(),
        tikhub_api_key: z.string().max(300).nullish(),
        site_company: z.string().max(200).nullish(),
        site_icp: z.string().max(100).nullish(),
        site_icp_url: z.string().max(300).nullish(),
        site_police: z.string().max(100).nullish(),
        site_police_url: z.string().max(300).nullish(),
        site_footer_note: z.string().max(500).nullish(),
      }),
    },
    handler: async (req) => {
      for (const key of SETTING_KEYS) {
        const value = (req.body as Record<string, string | null | undefined>)[key]
        if (value === undefined) continue
        setSetting(key as SettingKey, value)
      }
      const active = await describeProvider()
      return { ok: true, active }
    },
  })

  server.route({
    method: 'POST',
    url: '/settings/test-llm',
    schema: { hide: true },
    handler: async () => {
      const t0 = Date.now()
      try {
        const provider = await resolveProvider()
        if (!provider) {
          return { ok: false, provider: 'none', detail: '当前配置下没有可用 LLM（将以启发式降级运行，功能可用但抽取能力受限）' }
        }
        const result = await provider.completeJson({
          system: '你是连通性测试器。只输出合法 JSON。',
          prompt: '输出 {"pong": true}',
          maxTokens: 100,
        })
        const pong = (result as { pong?: boolean } | null)?.pong === true
        return {
          ok: pong,
          provider: provider.name,
          model: provider.model,
          latency_ms: Date.now() - t0,
          detail: pong ? '连通正常，JSON 输出可解析' : `模型有响应但输出不符合预期: ${JSON.stringify(result).slice(0, 120)}`,
        }
      } catch (err) {
        return { ok: false, provider: 'error', latency_ms: Date.now() - t0, detail: String((err as Error).message).slice(0, 300) }
      }
    },
  })

  server.route({
    method: 'POST',
    url: '/settings/test-tikhub',
    schema: { hide: true },
    handler: async () => {
      const t = effectiveTikhub()
      if (!t.apiKey) return { ok: false, detail: '未配置 TikHub API Key' }
      const t0 = Date.now()
      try {
        const res = await fetch(`${t.baseUrl}/api/v1/tikhub/user/get_user_info`, {
          headers: { authorization: `Bearer ${t.apiKey}`, accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        })
        if (res.status === 401 || res.status === 403) return { ok: false, latency_ms: Date.now() - t0, detail: `鉴权失败 (HTTP ${res.status})：Key 无效` }
        if (!res.ok) return { ok: false, latency_ms: Date.now() - t0, detail: `HTTP ${res.status}` }
        const body = (await res.json()) as { api_key_data?: { api_key_scopes?: string[]; expires_at?: string } }
        const scopes = body.api_key_data?.api_key_scopes ?? []
        const hasXhs = scopes.some((s) => s.includes('xiaohongshu'))
        return {
          ok: true,
          latency_ms: Date.now() - t0,
          detail: `已连通 · ${scopes.length} 个平台权限${hasXhs ? '（含小红书）' : '（无小红书权限）'}${body.api_key_data?.expires_at ? ` · 到期 ${body.api_key_data.expires_at.slice(0, 10)}` : ''}`,
        }
      } catch (err) {
        return { ok: false, latency_ms: Date.now() - t0, detail: String((err as Error).message).slice(0, 200) }
      }
    },
  })

  server.route({
    method: 'POST',
    url: '/settings/test-baobaomi',
    schema: { hide: true },
    handler: async () => {
      const bbm = effectiveBaobaomi()
      if (!bbm.agentKey) return { ok: false, detail: '未配置 Agent Key' }
      const t0 = Date.now()
      try {
        const res = await fetch(`${bbm.baseUrl}/api/agent/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${bbm.agentKey}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mindex-settings-test', version: '0' } },
          }),
          signal: AbortSignal.timeout(15_000),
        })
        if (res.status === 401 || res.status === 403) return { ok: false, latency_ms: Date.now() - t0, detail: `鉴权失败 (HTTP ${res.status})：Agent Key 无效` }
        if (!res.ok) return { ok: false, latency_ms: Date.now() - t0, detail: `HTTP ${res.status}` }
        return { ok: true, latency_ms: Date.now() - t0, detail: `已连通 ${bbm.baseUrl}（MCP initialize 成功）` }
      } catch (err) {
        return { ok: false, latency_ms: Date.now() - t0, detail: String((err as Error).message).slice(0, 200) }
      }
    },
  })

  // ---------- chat 共享检索准备（/chat 与 /chat/stream 复用） ----------
  interface ChatRow {
    id: string
    seq: number
    text: string
    claim_type: string
    confidence_band: string
    project_name: string
    project_id: string
  }
  const chatCitation = (r: ChatRow) => ({
    claim_id: r.id,
    seq: r.seq,
    text: r.text,
    band: r.confidence_band,
    claim_type: r.claim_type,
    project_name: r.project_name,
    project_id: r.project_id,
  })
  function chatRetrieve(question: string, projectId?: string): ChatRow[] {
    const hits = searchClaims(db, { query: question, projectId, limit: 12 })
    if (hits.length === 0) return []
    const ph = hits.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT c.id, c.seq, c.text, c.claim_type, c.confidence_band, p.name AS project_name, p.id AS project_id
         FROM claims c JOIN projects p ON p.id = c.project_id WHERE c.id IN (${ph})`,
      )
      .all(...hits.map((h) => h.claimId)) as ChatRow[]
    return hits.map((h) => rows.find((r) => r.id === h.claimId)).filter((r): r is ChatRow => Boolean(r))
  }
  const chatBody = z.object({
    question: z.string().min(1).max(500),
    project_id: z.string().optional(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) }))
      .max(8)
      .default([]),
  })
  const chatPrompt = (ordered: ChatRow[], history: { role: string; content: string }[], question: string) => {
    const historyText = history.map((h) => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`).join('\n')
    return `知识结论（均带溯源，按相关度排序）:\n${ordered
      .map((r, i) => `[C${i + 1}] (${r.claim_type}/${r.confidence_band}/${r.project_name}) ${r.text}`)
      .join('\n')}\n${historyText ? `\n对话历史:\n${historyText}\n` : ''}\n用户问题: ${question}`
  }
  const NO_HIT_ANSWER = '知识库中没有找到与这个问题相关的可信知识。可以先对相关游戏发起研究或手动导入资料。'

  // ---------- chat (对话式检索：结论+引用+置信度，非自由闲聊) ----------
  server.route({
    method: 'POST',
    url: '/chat',
    schema: { hide: true, body: chatBody },
    handler: async (req) => {
      const ordered = chatRetrieve(req.body.question, req.body.project_id)
      if (ordered.length === 0) {
        return { answer: NO_HIT_ANSWER, citations: [], insufficient: true, stats: { hits: 0 } }
      }
      const stats = { hits: ordered.length } // 可信结论命中数（searchClaims 默认仅可信态），供前端如实展示检索轨迹
      const toCitation = chatCitation

      const provider = await resolveProvider()
      if (!provider) {
        // 诚实降级：无 LLM 时直接给出命中的可信结论列表，不生成叙述
        return {
          answer: `（无 LLM，返回检索命中的可信结论）\n${ordered.map((r, i) => `[C${i + 1}] ${r.text}`).join('\n')}`,
          citations: ordered.map(toCitation),
          insufficient: false,
          stats,
        }
      }
      const raw = await provider.completeJson({
        system: CHAT_SYSTEM,
        prompt: chatPrompt(ordered, req.body.history, req.body.question),
        maxTokens: 900,
      })
      const parsed = z
        .object({ answer: z.string().default(''), cited: z.array(z.number().int()).default([]) })
        .safeParse(raw)
      if (!parsed.success || !parsed.data.answer) {
        return {
          answer: `（LLM 输出无法解析，返回检索命中的可信结论）\n${ordered.map((r, i) => `[C${i + 1}] ${r.text}`).join('\n')}`,
          citations: ordered.map(toCitation),
          insufficient: false,
          stats,
        }
      }
      const cited = [...new Set(parsed.data.cited)].filter((n) => n >= 1 && n <= ordered.length)
      // 回答文本中的 [Cn] 按原始检索序号引用；citations 数组是被引子集——重编号使两者对齐
      const renumber = new Map(cited.map((n, i) => [n, i + 1]))
      const answer = parsed.data.answer.replace(/\[C(\d+)\]/g, (m, d) => {
        const nn = renumber.get(Number(d))
        return nn ? `[C${nn}]` : m
      })
      return {
        answer,
        citations: cited.map((n) => toCitation(ordered[n - 1]!)),
        insufficient: cited.length === 0,
        stats,
      }
    },
  })

  // ---------- chat 流式（SSE）：检索命中即点亮星座，回答逐字流出 ----------
  server.route({
    method: 'POST',
    url: '/chat/stream',
    schema: { hide: true, body: chatBody },
    handler: async (req, reply) => {
      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        // nginx 默认缓冲会吞掉 SSE 增量——按响应关闭
        'x-accel-buffering': 'no',
      })
      raw.flushHeaders?.()
      const send = (event: string, data: unknown) => {
        try { raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* client gone */ }
      }
      const finish = () => { try { raw.end() } catch { /* already closed */ } }
      try {
        const ordered = chatRetrieve(req.body.question, req.body.project_id)
        if (ordered.length === 0) {
          send('done', { answer: NO_HIT_ANSWER, citations: [], insufficient: true, stats: { hits: 0 } })
          return finish()
        }
        const stats = { hits: ordered.length }
        // 检索命中先行：前端据此点亮命中项目的星座——真实事件，不是演出
        send('stage', { ...stats, project_ids: [...new Set(ordered.map((r) => r.project_id))] })

        // 从最终文本按原号提取引用（不重编号——流式过程已展示原号，改号会造成可见跳变；
        // 来源列表按原号 Cn 对齐展示）
        const finalize = (text: string) => {
          const seen: number[] = []
          for (const m of text.matchAll(/\[C(\d+)\]/g)) {
            const n = Number(m[1])
            if (n >= 1 && n <= ordered.length && !seen.includes(n)) seen.push(n)
          }
          return {
            answer: text,
            citations: seen.map((n) => ({ n, ...chatCitation(ordered[n - 1]!) })),
            insufficient: seen.length === 0,
            stats,
          }
        }

        const provider = await resolveProvider()
        const prompt = chatPrompt(ordered, req.body.history, req.body.question)

        if (provider?.completeText) {
          const text = await provider.completeText({
            system: CHAT_STREAM_SYSTEM,
            prompt,
            maxTokens: 900,
            onDelta: (t) => send('delta', { text: t }),
          })
          if (text) {
            send('done', finalize(text))
            return finish()
          }
        } else if (provider) {
          // provider 无流式能力（claude-cli 等）：走 JSON 路径一次性生成，仍以 done 收尾
          const rawJson = await provider.completeJson({ system: CHAT_SYSTEM, prompt, maxTokens: 900 })
          const parsed = z.object({ answer: z.string().default('') }).safeParse(rawJson)
          if (parsed.success && parsed.data.answer) {
            send('done', finalize(parsed.data.answer))
            return finish()
          }
        }
        // 无 LLM / 输出失败：诚实回退——命中列表整段返回
        send('done', finalize(`（无法生成叙述回答，返回检索命中的可信结论）\n${ordered.map((r, i) => `[C${i + 1}] ${r.text}`).join('\n')}`))
        return finish()
      } catch (err) {
        send('error', { message: String((err as Error).message ?? err).slice(0, 300) })
        return finish()
      }
    },
  })

  // ---------- knowledge graph ----------
  server.route({
    method: 'GET',
    url: '/graph',
    schema: { hide: true },
    handler: async () => {
      const nodes: { id: string; type: string; label: string; claims: number; trusted: number; projectId: string }[] = []
      const edges: { source: string; target: string; weight: number; kind: 'membership' | 'cooccurrence' }[] = []
      const projects = store.listProjects()
      for (const p of projects) {
        const stats = db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL) AS claims,
              (SELECT COUNT(*) FROM claims WHERE project_id = :id AND merged_into IS NULL AND review_state IN ('auto_accepted','approved') AND confidence_band IN ('verified','likely')) AS trusted`,
          )
          .get({ id: p.id }) as { claims: number; trusted: number }
        nodes.push({ id: p.id, type: 'project', label: p.name, claims: stats.claims, trusted: stats.trusted, projectId: p.id })

        // top entities by claim count (claim 关联数即节点权重)
        const ents = db
          .prepare(
            `SELECT e.id, e.entity_type, e.canonical_name,
                    COUNT(ce.claim_id) AS claims,
                    SUM(CASE WHEN c.review_state IN ('auto_accepted','approved') AND c.confidence_band IN ('verified','likely') THEN 1 ELSE 0 END) AS trusted
             FROM entities e
             JOIN claim_entities ce ON ce.entity_id = e.id
             JOIN claims c ON c.id = ce.claim_id AND c.merged_into IS NULL
             WHERE e.project_id = ?
             GROUP BY e.id ORDER BY claims DESC LIMIT 24`,
          )
          .all(p.id) as { id: string; entity_type: string; canonical_name: string; claims: number; trusted: number }[]
        for (const e of ents) {
          nodes.push({ id: e.id, type: e.entity_type, label: e.canonical_name, claims: e.claims, trusted: e.trusted, projectId: p.id })
          edges.push({ source: p.id, target: e.id, weight: e.claims, kind: 'membership' })
        }
        // co-occurrence edges: same-project entity pairs sharing ≥2 claims
        const entIds = ents.map((e) => e.id)
        if (entIds.length >= 2) {
          const ph = entIds.map(() => '?').join(',')
          const pairs = db
            .prepare(
              `SELECT a.entity_id AS ea, b.entity_id AS eb, COUNT(*) AS shared
               FROM claim_entities a JOIN claim_entities b ON a.claim_id = b.claim_id AND a.entity_id < b.entity_id
               WHERE a.entity_id IN (${ph}) AND b.entity_id IN (${ph})
               GROUP BY a.entity_id, b.entity_id HAVING shared >= 2`,
            )
            .all(...entIds, ...entIds) as { ea: string; eb: string; shared: number }[]
          for (const pr of pairs) edges.push({ source: pr.ea, target: pr.eb, weight: pr.shared, kind: 'cooccurrence' })
        }
      }
      return { nodes, edges }
    },
  })

  // ---------- entities ----------
  server.route({
    method: 'GET',
    url: '/projects/:id/entities',
    schema: { hide: true, params: z.object({ id: z.string() }) },
    handler: async (req) =>
      db
        .prepare(
          `SELECT e.*, (SELECT COUNT(*) FROM claim_entities WHERE entity_id = e.id) AS claim_count
           FROM entities e WHERE e.project_id = ? ORDER BY claim_count DESC LIMIT 100`,
        )
        .all(req.params.id),
  })
}
