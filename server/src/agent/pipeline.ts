import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { SNAPSHOT_DIR } from '../config.js'
import type { Store, ProjectRow } from '../core/store.js'
import { GroundingError } from '../core/store.js'
import { clusterDuplicates, isNearDuplicateClaim, scanAstroturf } from '../core/dedupe.js'
import { scoreClaim, type ScoringEvidence } from '../core/confidence.js'
import { classifyAdRole } from '../core/adRole.js'
import { synthesizeAngles, blockedDimensions, type ClaimForAngle } from '../core/sellingAngle.js'
import { Fetcher, extractHtmlTitle, htmlToText } from '../connectors/fetcher.js'
import { connectors, getConnector, liveConnectors } from '../connectors/registry.js'
import type { ConnectorContext, FetchedDoc } from '../connectors/types.js'
import { resolveProvider, type LlmProvider } from '../llm/provider.js'
import { j, newId, now, pj, wilsonLower } from '../lib/util.js'
import {
  aggregateReviewAspects,
  creativeInsightFromRef,
  heuristicMetadataExtract,
  llmExtract,
  llmReviewThemes,
  type ExtractedClaim,
  type ReviewDocLite,
} from './extract.js'
import { COVERAGE_SYSTEM, CONFLICT_JUDGE_SYSTEM, PLANNER_SYSTEM, PROMPT_VERSION, plannerPrompt } from './prompts.js'

const runningProjects = new Set<string>()

const planSchema = z.object({
  research_questions: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  connector_ids: z.array(z.string()).default([]),
  notes: z.string().default(''),
})

export const coverageSchema = z.object({
  sufficient: z.boolean().default(true),
  dimensions: z
    .array(
      z.object({
        key: z.string(),
        status: z.enum(['covered', 'partial', 'missing']).catch('partial'),
        note: z.string().default(''),
      }),
    )
    .default([]),
  gaps: z.array(z.string()).default([]),
  extra_keywords: z.array(z.string()).default([]),
  summary: z.string().default(''),
})

const conflictVerdictSchema = z.object({
  verdict: z.enum(['conflict', 'scoped', 'compatible']).catch('compatible'),
  reason: z.string().default(''),
})

export interface RunOptions {
  goal?: string
  connectorIds?: string[]
  maxRounds?: number
}

export function isProjectRunning(projectId: string): boolean {
  return runningProjects.has(projectId)
}

/** Start a research run in the background; returns the run id immediately. */
export function startResearchRun(store: Store, projectId: string, opts: RunOptions = {}): string {
  const project = store.getProject(projectId)
  if (!project) throw new Error('project not found')
  if (runningProjects.has(projectId)) throw new Error('该项目已有正在进行的研究任务')
  runningProjects.add(projectId)

  const runId = newId('run')
  store.db
    .prepare(
      `INSERT INTO research_runs (id, project_id, goal, status, llm_provider, model_id, prompt_version, started_at)
       VALUES (?, ?, ?, 'running', 'pending', '', ?, ?)`,
    )
    .run(runId, projectId, opts.goal ?? '全面了解产品、受众与玩家口碑', PROMPT_VERSION, now())

  executeRun(store, project, runId, opts)
    .catch((err) => {
      store.db
        .prepare(`UPDATE research_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(String(err?.stack ?? err), now(), runId)
      emit(store, runId, 'done', `研究任务失败: ${String(err).slice(0, 300)}`, {}, 'error')
    })
    .finally(() => runningProjects.delete(projectId))

  return runId
}

function emit(store: Store, runId: string, phase: string, message: string, detail: Record<string, unknown> = {}, level = 'info'): void {
  store.db
    .prepare(`INSERT INTO run_events (run_id, phase, level, message, detail, at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(runId, phase, level, message, j(detail), now())
}

async function executeRun(store: Store, project: ProjectRow, runId: string, opts: RunOptions): Promise<void> {
  const fetcher = new Fetcher()
  const provider = await resolveProvider()
  store.db
    .prepare(`UPDATE research_runs SET llm_provider = ?, model_id = ? WHERE id = ?`)
    .run(provider?.name ?? 'none', provider?.model ?? '', runId)

  const stats: Record<string, unknown> = {}

  // ============ PLAN ============
  emit(store, runId, 'plan', provider ? `使用 ${provider.name} (${provider.model}) 规划研究` : '无可用 LLM，使用内置研究模板（诚实降级：仅结构化元数据与关键词启发式）')
  let keywords = [project.name, ...project.aliases]
  // 默认研究问题 = 买量写作十类信息需求各一问（LLM 规划成功时会被更针对性的问题覆盖）
  let questions: string[] = [
    '游戏对外主打的核心卖点是什么（核心卖点）',
    '游戏的题材、世界观与美术风格是什么（题材世界观）',
    '游戏有哪些主要角色/IP要素，玩家讨论谁最多（角色IP）',
    '核心玩法循环与上手门槛是什么（玩法循环）',
    '玩家的爽点和吐槽点集中在哪里（玩家爽点痛点）',
    '付费模式是什么，玩家对付费的真实口碑如何（付费与商业化口碑）',
    '近期与将来的版本更新、活动节点有哪些（版本活动节点）',
    '玩家常拿哪些竞品来对比，差异在哪（竞品对比）',
    '目标玩家是谁，人群画像有什么特征（人群画像）',
    '同品类爆量素材常用什么套路与钩子（素材套路）',
  ]
  let chosenConnectors = (opts.connectorIds?.length
    ? opts.connectorIds.map((id) => getConnector(id)).filter((c) => c && c.status === 'verified')
    : liveConnectors()) as NonNullable<ReturnType<typeof getConnector>>[]

  if (provider) {
    const raw = await provider.completeJson({
      system: PLANNER_SYSTEM,
      prompt: plannerPrompt(project, liveConnectors().map((c) => ({ id: c.id, label: c.label, description: c.description }))),
    })
    const plan = planSchema.safeParse(raw)
    if (plan.success && plan.data.keywords.length > 0) {
      questions = plan.data.research_questions.length ? plan.data.research_questions : questions
      keywords = [...new Set([...keywords, ...plan.data.keywords])]
      if (!opts.connectorIds?.length && plan.data.connector_ids.length) {
        const picked = plan.data.connector_ids
          .map((id) => getConnector(id))
          .filter((c): c is NonNullable<typeof c> => Boolean(c && c.status === 'verified'))
        if (picked.length) chosenConnectors = picked
      }
      emit(store, runId, 'plan', `研究计划就绪：${questions.length} 个研究问题，${keywords.length} 个关键词`, {
        questions,
        keywords,
        connectors: chosenConnectors.map((c) => c.id),
        notes: plan.data.notes,
      })
    } else {
      emit(store, runId, 'plan', 'LLM 规划输出无法解析，回退到内置模板', {}, 'warn')
    }
  }
  store.db
    .prepare(`UPDATE research_runs SET plan = ? WHERE id = ?`)
    .run(j({ questions, keywords, connectors: chosenConnectors.map((c) => c.id) }), runId)

  const maxRounds = opts.maxRounds ?? 2
  let totalNewDocs = 0

  for (let round = 1; round <= maxRounds; round++) {
    const ctx: ConnectorContext = {
      project: store.getProject(project.id)!,
      keywords,
      competitorTerms: project.competitors.filter((c) => c.trim().length >= 2),
      fetcher,
      log: (message, detail) => emit(store, runId, 'discover', message, detail ?? {}),
    }

    // ============ RESOLVE ============
    for (const connector of chosenConnectors) {
      if (!connector.resolve) continue
      try {
        const hints = await connector.resolve(ctx)
        if (Object.keys(hints).length > 0) {
          const current = store.getProject(project.id)!
          store.updateProject(project.id, { platformHints: { ...current.platform_hints, ...hints } })
          ctx.project = store.getProject(project.id)!
        }
      } catch (err) {
        emit(store, runId, 'discover', `${connector.label} 平台定位失败: ${String(err).slice(0, 200)}`, {}, 'warn')
      }
    }

    // ============ DISCOVER ============
    const newSnapshotIds: string[] = []
    for (const connector of chosenConnectors) {
      if (!connector.discover) continue
      emit(store, runId, 'discover', `[第${round}轮] ${connector.label} 开始抓取…`)
      let docs: FetchedDoc[] = []
      try {
        docs = await connector.discover(ctx)
      } catch (err) {
        emit(store, runId, 'discover', `${connector.label} 抓取异常: ${String(err).slice(0, 200)}`, {}, 'error')
        continue
      }
      let fresh = 0
      for (const fd of docs) {
        const src = store.upsertSource({ projectId: project.id, ...fd.source })
        // 竞品口碑:覆盖 docType 为 competitor_review,竞品名存入 doc meta 供抽取层识别
        if (fd.competitorFor) {
          fd.doc.docType = 'competitor_review'
          fd.doc.title = `竞品《${fd.competitorFor}》口碑`
        }
        const doc = store.upsertDocument({ sourceId: src.id, projectId: project.id, ...fd.doc })
        const snap = store.insertSnapshot({
          documentId: doc.id,
          projectId: project.id,
          runId,
          text: fd.text,
          lang: fd.lang,
          meta: { ...fd.meta, review: fd.review, competitorFor: fd.competitorFor ?? null },
        })
        if (!snap.unchanged) {
          fresh++
          newSnapshotIds.push(snap.id)
          if (fd.raw !== null && fd.raw !== undefined) {
            const dir = path.join(SNAPSHOT_DIR, project.id)
            mkdirSync(dir, { recursive: true })
            const rawPath = path.join(dir, `${snap.id}.json`)
            writeFileSync(rawPath, JSON.stringify(fd.raw, null, 2))
            store.db.prepare(`UPDATE snapshots SET raw_path = ? WHERE id = ?`).run(rawPath, snap.id)
          }
        }
        store.setSourceFetch(src.id, 'ok')
      }
      emit(store, runId, 'discover', `${connector.label}: ${docs.length} 个文档（${fresh} 个新快照）`)
    }
    totalNewDocs += newSnapshotIds.length
    if (newSnapshotIds.length === 0 && round > 1) {
      emit(store, runId, 'discover', '本轮没有新内容，结束迭代')
      break
    }

    // ============ EXTRACT ============
    emit(store, runId, 'extract', `开始知识抽取（${newSnapshotIds.length} 个新快照）`)
    await extractPhase(store, project, runId, newSnapshotIds, provider)

    // ============ CONSOLIDATE ============
    emit(store, runId, 'consolidate', '去重与交叉整合…')
    consolidatePhase(store, project.id, runId)

    // ============ SCORE ============
    emit(store, runId, 'score', '计算可解释置信度并路由审核…')
    const scored = scorePhase(store, project.id)
    emit(store, runId, 'score', `已评分 ${scored.total} 条结论：verified ${scored.verified} · likely ${scored.likely} · uncertain ${scored.uncertain} · disputed ${scored.disputed} · insufficient ${scored.insufficient}`)

    // ============ CONFLICTS ============
    const conflictsFound = await conflictPhase(store, project.id, runId, provider)
    if (conflictsFound > 0) {
      emit(store, runId, 'consolidate', `发现 ${conflictsFound} 组冲突，已进入审核队列`, {}, 'warn')
      scorePhase(store, project.id) // re-score: open conflicts force disputed
    }

    // ============ COVERAGE (iterate?) ============
    if (round >= maxRounds || !provider) break
    const coverage = await assessCoverage(store, project.id, provider, questions)
    if (coverage) {
      emit(store, runId, 'plan', `覆盖度评估: ${coverage.summary || (coverage.sufficient ? '证据充分' : '存在缺口')}`, {
        gaps: coverage.gaps,
        dimensions: coverage.dimensions,
      })
      stats.gaps = coverage.gaps
      if (coverage.dimensions.length) stats.dimensions = coverage.dimensions
      if (coverage.sufficient || coverage.extra_keywords.length === 0) break
      keywords = [...new Set([...keywords, ...coverage.extra_keywords])]
      emit(store, runId, 'plan', `补充关键词进入第 ${round + 1} 轮: ${coverage.extra_keywords.join('、')}`)
    } else {
      break
    }
  }

  // ============ FINISH ============
  const counts = store.db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM claims WHERE project_id = ? AND merged_into IS NULL) AS claims,
        (SELECT COUNT(*) FROM evidence WHERE project_id = ?) AS evidence,
        (SELECT COUNT(*) FROM sources WHERE project_id = ?) AS sources,
        (SELECT COUNT(*) FROM review_queue WHERE project_id = ? AND state = 'todo') AS pending_review,
        (SELECT COUNT(*) FROM conflicts WHERE project_id = ? AND status = 'open') AS open_conflicts`,
    )
    .get(project.id, project.id, project.id, project.id, project.id) as Record<string, number>
  store.db
    .prepare(`UPDATE research_runs SET status = 'done', stats = ?, finished_at = ? WHERE id = ?`)
    .run(j({ ...counts, newSnapshots: totalNewDocs, ...stats }), now(), runId)
  emit(store, runId, 'done', `研究完成：${counts.claims} 条结论 / ${counts.evidence} 条证据 / ${counts.sources} 个来源；${counts.pending_review} 项待审核`, counts)
}

/**
 * Manual import (uploads / adapter-only platforms like TapTap, Bilibili, XHS):
 * creates source→document→snapshot, then runs the same extract→score pipeline.
 */
export function startImportRun(
  store: Store,
  projectId: string,
  payload: {
    title: string
    text: string
    url?: string | null
    platform?: string
    sourceType?: string
    publishedAt?: string | null
    authorHandle?: string | null
  },
): string {
  const project = store.getProject(projectId)
  if (!project) throw new Error('project not found')
  const runId = newId('run')
  store.db
    .prepare(
      `INSERT INTO research_runs (id, project_id, goal, status, llm_provider, model_id, prompt_version, started_at)
       VALUES (?, ?, ?, 'running', 'pending', '', ?, ?)`,
    )
    .run(runId, projectId, `手动导入: ${payload.title.slice(0, 60)}`, PROMPT_VERSION, now())

  // 国内源权威先验标定：官网 0.9 > 商店元数据 0.85（连接器内设）> 行业媒体 0.7 > UGC 0.35–0.4
  const authorityByType: Record<string, number> = {
    official: 0.9,
    internal_doc: 0.8,
    press: 0.7,
    community: 0.4,
    user_note: 0.6,
  }
  const sourceType = payload.sourceType ?? 'user_note'
  const platform = payload.platform ?? 'internal'
  const src = store.upsertSource({
    projectId,
    connector: 'manual',
    sourceType,
    name: `手动导入 · ${platform}`,
    url: payload.url ?? null,
    platform,
    ownerKey: payload.url ? new URL(payload.url).host : `manual:${platform}`,
    authorityPrior: authorityByType[sourceType] ?? 0.5,
    licenseNote: '用户导入内容，由用户确认其使用权',
  })
  const doc = store.upsertDocument({
    sourceId: src.id,
    projectId,
    canonicalUrl: payload.url ?? `manual://${projectId}/${runId}`,
    docType: 'upload',
    title: payload.title,
    authorHandle: payload.authorHandle ?? null,
    publishedAt: payload.publishedAt ?? null,
  })
  const snap = store.insertSnapshot({ documentId: doc.id, projectId, runId, text: payload.text })
  store.setSourceFetch(src.id, 'ok')
  emit(store, runId, 'discover', `已导入文档「${payload.title}」(${payload.text.length} 字符)`)

  ;(async () => {
    const provider = await resolveProvider()
    store.db.prepare(`UPDATE research_runs SET llm_provider = ?, model_id = ? WHERE id = ?`).run(provider?.name ?? 'none', provider?.model ?? '', runId)
    if (!snap.unchanged) {
      await extractPhase(store, project, runId, [snap.id], provider)
    } else {
      emit(store, runId, 'extract', '内容与已有快照一致，跳过重复抽取')
    }
    const scored = scorePhase(store, projectId)
    emit(store, runId, 'done', `导入完成：项目现有 ${scored.total} 条结论`)
    store.db.prepare(`UPDATE research_runs SET status = 'done', stats = ?, finished_at = ? WHERE id = ?`).run(j(scored), now(), runId)
  })().catch((err) => {
    store.db.prepare(`UPDATE research_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(String(err), now(), runId)
    emit(store, runId, 'done', `导入处理失败: ${String(err).slice(0, 200)}`, {}, 'error')
  })

  return runId
}

/** URL 抓取导入的共享前置：抓正文并做诚实校验（管理平面与 Agent 平面共用）。 */
export async function fetchUrlForImport(
  url: string,
): Promise<{ ok: true; title: string; text: string } | { ok: false; code: 'fetch_failed' | 'content_too_thin'; message: string }> {
  const fetcher = new Fetcher()
  const res = await fetcher.fetch(url)
  if (!res.ok) {
    return { ok: false, code: 'fetch_failed', message: `抓取失败 (HTTP ${res.status ?? '—'})${res.error ? `: ${res.error}` : ''}` }
  }
  const text = res.json ? JSON.stringify(res.json, null, 2) : htmlToText(res.text)
  if (text.length < 200) {
    return { ok: false, code: 'content_too_thin', message: '抓到的正文过短（可能是 JS 渲染壳页或反爬），请改用复制粘贴导入' }
  }
  return { ok: true, title: extractHtmlTitle(res.text) || new URL(url).hostname, text: text.slice(0, 200_000) }
}

/**
 * Structured review import (e.g. TapTap reviews scraped by an external agent, handed
 * over as JSON or Markdown). Each review becomes its own review-type doc → the normal
 * opinion pipeline → player_opinion with per-review provenance back to the app URL.
 */
export function startReviewImportRun(
  store: Store,
  projectId: string,
  payload: {
    platform: string // 'taptap' | ...
    appName?: string
    sourceUrl?: string | null
    reviews: { content: string; score?: number | null; author?: string | null; upVotes?: number | null; publishedAt?: string | null; reviewId?: string | null }[]
  },
): string {
  const project = store.getProject(projectId)
  if (!project) throw new Error('project not found')
  if (payload.reviews.length === 0) throw new Error('没有可导入的评论')
  const runId = newId('run')
  store.db
    .prepare(
      `INSERT INTO research_runs (id, project_id, goal, status, llm_provider, model_id, prompt_version, started_at)
       VALUES (?, ?, ?, 'running', 'pending', '', ?, ?)`,
    )
    .run(runId, projectId, `导入 ${payload.platform} 评论 × ${payload.reviews.length}`, PROMPT_VERSION, now())

  const src = store.upsertSource({
    projectId,
    connector: 'manual',
    sourceType: 'store_review',
    name: `${payload.platform} 用户评价${payload.appName ? ` · ${payload.appName}` : ''}（导入）`,
    url: payload.sourceUrl ?? null,
    platform: payload.platform,
    ownerKey: `${payload.platform}_reviews_import`,
    authorityPrior: 0.4,
    licenseNote: `${payload.platform} 用户评论（外部采集后导入），Context Pack 中默认转述不逐字引用；点赞数仅展示不计入置信度`,
  })

  const snapIds: string[] = []
  payload.reviews.forEach((rv, i) => {
    const doc = store.upsertDocument({
      sourceId: src.id,
      projectId,
      canonicalUrl: `${payload.platform}://import/${runId}/review/${rv.reviewId ?? i}`,
      url: payload.sourceUrl ?? undefined,
      docType: 'review',
      title: `${payload.platform} 评价`,
      authorHandle: rv.author ?? null,
      publishedAt: rv.publishedAt ?? null,
    })
    const snap = store.insertSnapshot({
      documentId: doc.id,
      projectId,
      runId,
      text: rv.content,
      meta: { review: { rating: rv.score ?? null }, upVotes: rv.upVotes ?? null },
    })
    if (!snap.unchanged) snapIds.push(snap.id)
  })
  store.setSourceFetch(src.id, 'ok')
  emit(store, runId, 'discover', `已导入 ${payload.platform} 评论 ${payload.reviews.length} 条（${snapIds.length} 条新快照）`)

  ;(async () => {
    const provider = await resolveProvider()
    store.db.prepare(`UPDATE research_runs SET llm_provider = ?, model_id = ? WHERE id = ?`).run(provider?.name ?? 'none', provider?.model ?? '', runId)
    if (snapIds.length > 0) await extractPhase(store, project, runId, snapIds, provider)
    else emit(store, runId, 'extract', '导入内容与已有快照一致，跳过重复抽取')
    const scored = scorePhase(store, projectId)
    emit(store, runId, 'done', `导入完成：项目现有 ${scored.total} 条结论`)
    store.db.prepare(`UPDATE research_runs SET status = 'done', stats = ?, finished_at = ? WHERE id = ?`).run(j(scored), now(), runId)
  })().catch((err) => {
    store.db.prepare(`UPDATE research_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(String(err), now(), runId)
    emit(store, runId, 'done', `导入处理失败: ${String(err).slice(0, 200)}`, {}, 'error')
  })

  return runId
}

// ---------------------------------------------------------------- extract

export async function extractPhase(store: Store, project: ProjectRow, runId: string, snapshotIds: string[], provider: LlmProvider | null): Promise<void> {
  if (snapshotIds.length === 0) return
  const placeholders = snapshotIds.map(() => '?').join(',')
  const snaps = store.db
    .prepare(
      `SELECT sn.id AS snapshot_id, sn.text, sn.meta, sn.document_id, d.doc_type, d.title, d.author_handle, d.published_at, d.version_tag,
              s.id AS source_id, s.name AS source_name, s.source_type, s.connector
       FROM snapshots sn JOIN documents d ON d.id = sn.document_id JOIN sources s ON s.id = d.source_id
       WHERE sn.id IN (${placeholders})`,
    )
    .all(...snapshotIds) as {
    snapshot_id: string
    text: string
    meta: string
    document_id: string
    doc_type: string
    title: string
    author_handle: string | null
    published_at: string | null
    version_tag: string | null
    source_id: string
    source_name: string
    source_type: string
    connector: string
  }[]

  const reviewDocs: (ReviewDocLite & { versionTag: string | null })[] = []
  let claimsCreated = 0
  let creativeCreated = 0
  let droppedUngrounded = 0

  // 竞品口碑按竞品分组,稍后走 LLM 主题归纳(只取 negative 主题 → ammo)
  const competitorReviews = new Map<string, (ReviewDocLite & { versionTag: string | null })[]>()

  for (const snap of snaps) {
    // 竞品口碑:收集分组,不走单条直接打标(避免噪声评论污染)。LLM 归纳后只取 negative 主题。
    if (snap.doc_type === 'competitor_review') {
      const competitorName = pj<{ competitorFor?: string }>(snap.meta, {}).competitorFor ?? '竞品'
      const arr = competitorReviews.get(competitorName) ?? []
      arr.push({
        snapshotId: snap.snapshot_id, sourceId: snap.source_id, documentId: snap.document_id,
        text: snap.text, rating: null, publishedAt: snap.published_at,
        authorHandle: snap.author_handle, versionTag: snap.version_tag,
      })
      competitorReviews.set(competitorName, arr)
      continue
    }

    if (snap.doc_type === 'review') {
      const meta = pj<{ review?: { rating?: number | null } }>(snap.meta, {})
      reviewDocs.push({
        snapshotId: snap.snapshot_id,
        sourceId: snap.source_id,
        documentId: snap.document_id,
        text: snap.text,
        rating: meta.review?.rating ?? null,
        publishedAt: snap.published_at,
        authorHandle: snap.author_handle,
        versionTag: snap.version_tag,
      })
      continue
    }

    // creative reference (baobaomi ad materials) → creative_insight (NOT player_opinion)
    if (snap.doc_type === 'creative_ref') {
      const attrs = pj<{ creative?: Record<string, string> }>(snap.meta, {}).creative ?? {}
      const ci = creativeInsightFromRef(project.name, snap.text, attrs)
      if (ci) creativeCreated += persistCreativeInsight(store, project.id, runId, snap, ci, provider?.name ?? 'heuristic')
      continue
    }

    // structured metadata heuristics (always run — reliable, we authored the format)
    let extracted: ExtractedClaim[] = []
    if (snap.doc_type === 'api_record') {
      extracted = heuristicMetadataExtract(project.name, snap.text)
      // storefront qualifier keeps CN/US price/version claims as separate scoped slots
      const storefront = (pj<{ country?: string }>(snap.meta, {}).country ?? '').toUpperCase()
      if (storefront) {
        for (const c of extracted) {
          if (['price', 'current_version', 'appstore_rating'].includes(c.predicate ?? '')) {
            c.text = c.text.includes(storefront) ? c.text : `${c.text}（${storefront} 区）`
          }
        }
      }
    }
    // LLM extraction for narrative docs
    if (provider && ['page', 'wiki_page', 'patch_note', 'upload', 'rss_item'].includes(snap.doc_type)) {
      const result = await llmExtract(
        provider,
        project,
        { name: snap.source_name, sourceType: snap.source_type },
        { title: snap.title },
        snap.text,
      )
      extracted.push(...result.claims)
      droppedUngrounded += result.droppedUngrounded
      if (result.droppedUngrounded > 0) {
        emit(store, runId, 'extract', `${snap.title}: ${result.droppedUngrounded} 条抽取因引文校验失败被丢弃（防幻觉）`, {}, 'warn')
      }
    } else if (!provider && ['page', 'wiki_page', 'upload'].includes(snap.doc_type)) {
      emit(store, runId, 'extract', `${snap.title}: 无 LLM，跳过叙述性文本的深度抽取（仅保留原文供检索）`, {}, 'warn')
    }

    for (const c of extracted) {
      claimsCreated += persistFactClaim(store, project.id, runId, snap, c, provider?.name ?? 'heuristic')
    }
  }

  if (claimsCreated > 0) emit(store, runId, 'extract', `事实类抽取完成：新增/合并 ${claimsCreated} 条结论`)
  if (creativeCreated > 0) emit(store, runId, 'extract', `创意参考抽取完成：新增/合并 ${creativeCreated} 条创意洞察（来自抱抱米爆量素材）`)

  // ---------- reviews ----------
  if (reviewDocs.length > 0) {
    emit(store, runId, 'extract', `分析 ${reviewDocs.length} 条用户评论/评测…`)
    // heuristic aspect aggregation (always)
    const aggregates = aggregateReviewAspects(project.name, reviewDocs)
    for (const agg of aggregates) {
      persistOpinionClaim(store, project.id, runId, {
        text: agg.text,
        topic: agg.topic,
        sentiment: agg.sentiment,
        matches: agg.holding.map((h) => ({ review: h.review, quote: h.matchedQuote })),
        holding: agg.holding.length,
        totalDiscussing: agg.totalScanned,
        totalScanned: agg.totalScanned,
        samplingNote: `关键词启发式；无提示提及率口径：${agg.totalScanned} 条评论中 ${agg.holding.length} 条明确提及`,
        provider: 'heuristic',
      })
    }
    if (aggregates.length > 0) emit(store, runId, 'extract', `启发式口碑聚合：${aggregates.length} 个观点主题`)

    // LLM theme extraction (better nuance)
    if (provider) {
      const { themes, droppedUngrounded: dropped } = await llmReviewThemes(provider, project.name, reviewDocs)
      droppedUngrounded += dropped
      for (const t of themes) {
        if (t.sentiment === 'mixed') continue
        persistOpinionClaim(store, project.id, runId, {
          text: t.text,
          topic: t.aspect === 'monetization' ? 'monetization' : ['story', 'art', 'audio'].includes(t.aspect) ? 'creative' : 'gameplay',
          sentiment: t.sentiment,
          matches: t.matches,
          holding: t.matches.length,
          totalDiscussing: t.sampleSize,
          totalScanned: t.sampleSize,
          samplingNote: `LLM 主题归纳；样本=${t.sampleSize} 条抽样评论`,
          provider: provider.name,
        })
      }
      if (themes.length > 0) emit(store, runId, 'extract', `LLM 口碑主题归纳：${themes.length} 个主题`)
      else emit(store, runId, 'extract', 'LLM 口碑主题归纳未产出结果（输出无法解析或样本不足），仅保留启发式聚合', {}, 'warn')
      if (dropped > 0) emit(store, runId, 'extract', `${dropped} 条评论引文校验失败被丢弃（防幻觉）`, {}, 'warn')
    }
  }

  // ---------- 竞品口碑:按竞品分组 → LLM 归纳 → 只取 negative 主题 → ammo ----------
  if (competitorReviews.size > 0) {
    for (const [competitorName, reviews] of competitorReviews) {
      emit(store, runId, 'extract', `分析竞品《${competitorName}》口碑 ${reviews.length} 条…`)
      let ammoThemes: { text: string; aspect: string; matches: { review: ReviewDocLite; quote: string }[]; sampleSize: number }[] = []

      if (provider) {
        // LLM 归纳:识别真正表达负面看法的主题(过滤掉噪声评论)
        const { themes, droppedUngrounded: dropped } = await llmReviewThemes(provider, project.name, reviews, 60, competitorName)
        droppedUngrounded += dropped
        ammoThemes = themes.filter((t) => t.sentiment === 'negative').map((t) => ({ text: t.text, aspect: t.aspect, matches: t.matches, sampleSize: t.sampleSize }))
        if (dropped > 0) emit(store, runId, 'extract', `竞品《${competitorName}》${dropped} 条引文校验失败被丢弃`, {}, 'warn')
      } else {
        // 无 LLM 降级:启发式负面词过滤(只留含痛点词的评论,聚合成维度主题)
        ammoThemes = heuristicCompetitorPain(competitorName, reviews)
      }

      for (const t of ammoThemes) {
        // 竞品负面主题 → ammo claim(文本明示 subject=竞品,sentiment=negative)
        persistCompetitorAmmoTheme(store, project.id, runId, competitorName, t, provider?.name ?? 'heuristic')
      }
      if (ammoThemes.length > 0) emit(store, runId, 'extract', `竞品《${competitorName}》识别 ${ammoThemes.length} 个负面痛点主题 → ammo 卖点弹药`)
      else emit(store, runId, 'extract', `竞品《${competitorName}》未识别出明确负面主题(评论噪声或样本不足)`, {}, 'warn')
    }
  }
}

function persistFactClaim(
  store: Store,
  projectId: string,
  runId: string,
  snap: { snapshot_id: string; source_id: string; published_at: string | null; version_tag: string | null; doc_type: string },
  c: ExtractedClaim,
  providerName: string,
): number {
  // insert evidence first (grounding enforced; skip claim if all quotes fail)
  const evidenceIds: string[] = []
  for (const quote of c.quotes) {
    try {
      evidenceIds.push(
        store.insertEvidence({
          projectId,
          snapshotId: snap.snapshot_id,
          sourceId: snap.source_id,
          runId,
          quote,
          kind: snap.doc_type === 'api_record' ? 'metric' : 'statement',
          publishedAt: snap.published_at,
        }),
      )
    } catch (err) {
      if (!(err instanceof GroundingError)) throw err
    }
  }
  if (evidenceIds.length === 0) return 0

  // exact dedupe
  const existing = store.findClaimByTextHash(projectId, c.text)
  if (existing) {
    for (const evId of evidenceIds) store.linkEvidence(existing, evId, 'supports', 'direct', c.confidenceSelf)
    return 1
  }
  // near-dup vs active claims of same type
  const candidates = store.db
    .prepare(`SELECT id, text FROM claims WHERE project_id = ? AND claim_type = ? AND merged_into IS NULL`)
    .all(projectId, c.claimType) as { id: string; text: string }[]
  for (const cand of candidates) {
    if (isNearDuplicateClaim(cand.text, c.text)) {
      for (const evId of evidenceIds) store.linkEvidence(cand.id, evId, 'supports', 'direct', c.confidenceSelf)
      return 1
    }
  }

  const claimId = store.createClaim({
    projectId,
    claimType: c.claimType,
    topic: c.topic,
    text: c.text,
    predicate: c.predicate,
    valueJson: c.value,
    versionMin: snap.version_tag,
    extractionProvider: providerName,
    runId,
    evidence: evidenceIds.map((evidenceId) => ({ evidenceId, stance: 'supports', directness: 'direct', extractorConfidence: c.confidenceSelf })),
  })
  // entities
  for (const ent of c.entities) {
    const entId = upsertEntity(store, projectId, ent.name, ent.type)
    store.db.prepare(`INSERT OR IGNORE INTO claim_entities (claim_id, entity_id, role) VALUES (?, ?, 'mentions')`).run(claimId, entId)
  }
  return 1
}

/** Persist a creative_insight from a baobaomi ad-material ref. Interpretive, single-source ⇒ honest low band. */
function persistCreativeInsight(
  store: Store,
  projectId: string,
  runId: string,
  snap: { snapshot_id: string; source_id: string; published_at: string | null },
  ci: { text: string; quote: string },
  providerName: string,
): number {
  let evId: string
  try {
    evId = store.insertEvidence({
      projectId,
      snapshotId: snap.snapshot_id,
      sourceId: snap.source_id,
      runId,
      quote: ci.quote,
      kind: 'statement',
      publishedAt: snap.published_at,
    })
  } catch (err) {
    if (err instanceof GroundingError) return 0
    throw err
  }
  const existing = store.findClaimByTextHash(projectId, ci.text)
  if (existing) {
    store.linkEvidence(existing, evId, 'supports', 'interpretive', 0.6)
    return 0
  }
  const candidates = store.db
    .prepare(`SELECT id, text FROM claims WHERE project_id = ? AND claim_type = 'creative_insight' AND merged_into IS NULL`)
    .all(projectId) as { id: string; text: string }[]
  for (const cand of candidates) {
    if (isNearDuplicateClaim(cand.text, ci.text)) {
      store.linkEvidence(cand.id, evId, 'supports', 'interpretive', 0.6)
      return 0
    }
  }
  store.createClaim({
    projectId,
    claimType: 'creative_insight',
    topic: 'creative',
    text: ci.text,
    extractionProvider: providerName,
    runId,
    evidence: [{ evidenceId: evId, stance: 'supports', directness: 'interpretive', extractorConfidence: 0.6 }],
  })
  return 1
}

function upsertEntity(store: Store, projectId: string, name: string, type: string): string {
  const existing = store.db
    .prepare(`SELECT id FROM entities WHERE project_id = ? AND entity_type = ? AND canonical_name = ?`)
    .get(projectId, type, name) as { id: string } | undefined
  if (existing) return existing.id
  const id = newId('ent')
  store.db
    .prepare(`INSERT INTO entities (id, project_id, entity_type, canonical_name) VALUES (?, ?, ?, ?)`)
    .run(id, projectId, type, name)
  return id
}

/**
 * 竞品负面主题 → ammo claim(聚合版,带样本统计)。
 * 一个主题 = 多条评论的支持,opinion_stats 记录代表性;n_holding=命中评论数。
 * 文本明示 subject=竞品,classifyAdRole 会因"竞品《"开头判为 ammo(不归 landmine)。
 */
function persistCompetitorAmmoTheme(
  store: Store,
  projectId: string,
  runId: string,
  competitorName: string,
  theme: { text: string; aspect: string; matches: { review: ReviewDocLite; quote: string }[]; sampleSize: number },
  providerName: string,
): void {
  // 入证据(每条评论的引文,grounded)
  const evidence: { evidenceId: string }[] = []
  for (const m of theme.matches.slice(0, 25)) {
    try {
      evidence.push({
        evidenceId: store.insertEvidence({
          projectId, snapshotId: m.review.snapshotId, sourceId: m.review.sourceId, runId,
          quote: m.quote, kind: 'review', publishedAt: m.review.publishedAt, authorHandle: m.review.authorHandle,
        }),
      })
    } catch (err) {
      if (!(err instanceof GroundingError)) throw err
    }
  }
  if (evidence.length < 1) return

  // claim 文本明示竞品 subject + 维度痛点
  const claimText = `竞品《${competitorName}》${theme.text}`
  const topic = theme.aspect === 'monetization' ? 'monetization' : ['story', 'art', 'audio'].includes(theme.aspect) ? 'creative' : 'gameplay'

  // near-dup 合并:同竞品同主题已有 claim → 追加证据
  const existing = store.findClaimByTextHash(projectId, claimText)
  const opinionStats = {
    prevalence: theme.sampleSize > 0 ? round3(theme.matches.length / theme.sampleSize) : 0,
    ci_low: round3(wilsonLower(theme.matches.length, Math.max(theme.sampleSize, theme.matches.length))),
    n_holding: theme.matches.length,
    n_discussing: theme.sampleSize,
    sample_size: theme.sampleSize,
    sentiment: 'negative',
    sampling_note: `${providerName === 'heuristic' ? '启发式' : 'LLM'} 竞品口碑归纳;样本=${theme.sampleSize} 条竞品评论中 ${theme.matches.length} 条表达此痛点`,
    window_end: now(),
  }
  if (existing) {
    for (const ev of evidence) store.linkEvidence(existing, ev.evidenceId, 'supports', 'direct', null)
    store.db.prepare(`UPDATE claims SET opinion_stats = ?, updated_at = ? WHERE id = ?`).run(j(opinionStats), now(), existing)
    return
  }

  store.createClaim({
    projectId,
    claimType: 'player_opinion',
    topic,
    text: claimText,
    opinionStats,
    extractionProvider: providerName,
    runId,
    evidence: evidence.map((e) => ({ ...e, stance: 'supports', directness: 'direct' })),
  })
}

/** 无 LLM 降级:用负面词表过滤竞品评论,聚合成维度主题(复用 ASPECTS 词表的负面部分)。 */
function heuristicCompetitorPain(competitorName: string, reviews: ReviewDocLite[]): { text: string; aspect: string; matches: { review: ReviewDocLite; quote: string }[]; sampleSize: number }[] {
  const painByAspect: Record<string, { re: RegExp; text: string }> = {
    monetization: { re: /(太氪|氪金|逼氪|抽卡.*(贵|坑)|割韭菜|坑钱|贵)/, text: '付费设计激进、抽卡成本高' },
    grind: { re: /(太肝|很肝|肝度|日常.*繁琐|体力.*不够)/, text: '肝度高、日常负担重' },
    performance: { re: /(优化.*(差|烂)|卡顿|掉帧|发烫|闪退|崩溃)/, text: '优化差、存在性能问题' },
    content: { re: /(内容.*(少|匮乏)|玩法.*(单一|重复)|无聊|没意思)/, text: '内容不足、玩法重复' },
  }
  const out: { text: string; aspect: string; matches: { review: ReviewDocLite; quote: string }[]; sampleSize: number }[] = []
  for (const [aspect, def] of Object.entries(painByAspect)) {
    const matches: { review: ReviewDocLite; quote: string }[] = []
    for (const r of reviews) {
      const m = r.text.match(def.re)
      if (m) matches.push({ review: r, quote: r.text.slice(0, 200) })
    }
    // ponytail: 启发式门槛≥2条(比 LLM 宽松,因已用"竞品+痛点词"预筛)
    if (matches.length >= 2) {
      out.push({ text: `玩家反馈该竞品${def.text}`, aspect, matches, sampleSize: reviews.length })
    }
  }
  return out
}

function persistOpinionClaim(
  store: Store,
  projectId: string,
  runId: string,
  input: {
    text: string
    topic: string
    sentiment: string
    matches: { review: ReviewDocLite; quote: string }[]
    holding: number
    totalDiscussing: number
    totalScanned: number
    samplingNote: string
    provider: string
  },
): void {
  const evidence: { evidenceId: string }[] = []
  for (const m of input.matches.slice(0, 25)) {
    try {
      const evId = store.insertEvidence({
        projectId,
        snapshotId: m.review.snapshotId,
        sourceId: m.review.sourceId,
        runId,
        quote: m.quote,
        kind: 'review',
        rating: m.review.rating,
        publishedAt: m.review.publishedAt,
        authorHandle: m.review.authorHandle,
      })
      evidence.push({ evidenceId: evId })
    } catch (err) {
      if (!(err instanceof GroundingError)) throw err
    }
  }
  if (evidence.length < 2) return

  const opinionStats = {
    prevalence: input.totalDiscussing > 0 ? round3(input.holding / input.totalDiscussing) : 0,
    ci_low: round3(wilsonLower(input.holding, Math.max(input.totalDiscussing, input.holding))),
    n_holding: input.holding,
    n_discussing: input.totalDiscussing,
    sample_size: input.totalScanned,
    sentiment: input.sentiment,
    sampling_note: input.samplingNote,
    window_end: now(),
  }

  const existing = store.findClaimByTextHash(projectId, input.text)
  if (existing) {
    for (const ev of evidence) store.linkEvidence(existing, ev.evidenceId, 'supports', 'direct', null)
    store.db.prepare(`UPDATE claims SET opinion_stats = ?, updated_at = ? WHERE id = ?`).run(j(opinionStats), now(), existing)
    return
  }
  const claimId = store.createClaim({
    projectId,
    claimType: 'player_opinion',
    topic: input.topic,
    text: input.text,
    opinionStats,
    extractionProvider: input.provider,
    runId,
    evidence: evidence.map((e) => ({ ...e, stance: 'supports', directness: 'direct' })),
  })
  // 口碑主题挂到 term 实体：玩法/付费/内容表现成为图谱枢纽节点
  const topicLabel = OPINION_TOPIC_ENTITY[input.topic]
  if (topicLabel) {
    const entId = upsertEntity(store, projectId, topicLabel, 'term')
    store.db.prepare(`INSERT OR IGNORE INTO claim_entities (claim_id, entity_id, role) VALUES (?, ?, 'mentions')`).run(claimId, entId)
  }
}

const OPINION_TOPIC_ENTITY: Record<string, string> = {
  gameplay: '玩法口碑',
  monetization: '付费口碑',
  creative: '内容表现口碑',
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

// ---------------------------------------------------------------- consolidate

export function consolidatePhase(store: Store, projectId: string, runId: string): void {
  // 1. syndication clustering across narrative snapshots (independence collapsing)
  const snaps = store.db
    .prepare(
      `SELECT sn.id, sn.text FROM snapshots sn JOIN documents d ON d.id = sn.document_id
       WHERE sn.project_id = ? AND d.doc_type IN ('page','wiki_page','rss_item','upload') AND sn.dup_cluster IS NULL`,
    )
    .all(projectId) as { id: string; text: string }[]
  if (snaps.length > 1) {
    const result = clusterDuplicates(snaps.map((s) => ({ id: s.id, text: s.text.slice(0, 4000) })))
    for (const [id, cluster] of result.clusterOf) {
      if (result.clusters.get(cluster)!.length > 1) store.setSnapshotDupCluster(id, cluster)
    }
  }

  // 2. astroturf scan per review source batch
  const reviewBatches = store.db
    .prepare(
      `SELECT s.id AS source_id, s.name FROM sources s WHERE s.project_id = ? AND s.source_type = 'store_review'`,
    )
    .all(projectId) as { source_id: string; name: string }[]
  for (const batch of reviewBatches) {
    const evidence = store.db
      .prepare(`SELECT id, quote, published_at, author_handle FROM evidence WHERE project_id = ? AND source_id = ?`)
      .all(projectId, batch.source_id) as { id: string; quote: string; published_at: string | null; author_handle: string | null }[]
    if (evidence.length < 5) continue
    const scan = scanAstroturf(evidence.map((e) => ({ id: e.id, text: e.quote, publishedAt: e.published_at, authorHandle: e.author_handle })))
    if (scan.batchScore > 0) {
      for (const id of scan.suspects) store.markEvidencePromo(id, true)
      if (scan.batchScore > 0.5) {
        store.enqueueReview(projectId, 'source', batch.source_id, 'astroturf_suspect', 2)
        emit(store, runId, 'consolidate', `${batch.name} 疑似批量/失真内容 (score=${scan.batchScore})：${scan.notes.join('；')}`, {}, 'warn')
      }
    }
  }
}

// ---------------------------------------------------------------- score

export function scorePhase(store: Store, projectId: string): Record<string, number> {
  const projectName = (store.db.prepare(`SELECT name FROM projects WHERE id = ?`).get(projectId) as { name: string } | undefined)?.name ?? ''
  const claims = store.db
    .prepare(
      `SELECT id, claim_type, text, value_json, version_min, version_max, opinion_stats, derived_from, review_state
       FROM claims WHERE project_id = ? AND merged_into IS NULL AND review_state NOT IN ('rejected','expired')`,
    )
    .all(projectId) as {
    id: string
    claim_type: string
    text: string
    value_json: string | null
    version_min: string | null
    version_max: string | null
    opinion_stats: string | null
    derived_from: string
    review_state: string
  }[]

  const tally: Record<string, number> = { total: 0, verified: 0, likely: 0, uncertain: 0, disputed: 0, insufficient: 0 }

  for (const claim of claims) {
    const evidence = store.db
      .prepare(
        `SELECT e.id, e.quote, e.published_at, e.suspected_promo, ce.stance, ce.directness, ce.extractor_confidence,
                s.id AS source_id, s.source_type, s.owner_key, s.authority_prior, sn.dup_cluster
         FROM claim_evidence ce
         JOIN evidence e ON e.id = ce.evidence_id
         JOIN sources s ON s.id = e.source_id
         JOIN snapshots sn ON sn.id = e.snapshot_id
         WHERE ce.claim_id = ?`,
      )
      .all(claim.id) as Record<string, unknown>[]

    const scoring: ScoringEvidence[] = evidence.map((e) => ({
      evidenceId: e.id as string,
      stance: e.stance as ScoringEvidence['stance'],
      directness: e.directness as ScoringEvidence['directness'],
      extractorConfidence: e.extractor_confidence as number | null,
      quote: e.quote as string,
      sourceId: e.source_id as string,
      sourceType: e.source_type as string,
      ownerKey: e.owner_key as string,
      authorityPrior: e.authority_prior as number,
      dupCluster: e.dup_cluster as string | null,
      suspectedPromo: Boolean(e.suspected_promo),
      publishedAt: e.published_at as string | null,
      versionTag: null,
    }))

    const opinion = claim.opinion_stats ? pj<{ n_holding: number; n_discussing: number }>(claim.opinion_stats, { n_holding: 0, n_discussing: 0 }) : null
    const premises = pj<string[]>(claim.derived_from, [])
    const premiseConfidences = premises
      .map((pid) => (store.db.prepare(`SELECT confidence FROM claims WHERE id = ?`).get(pid) as { confidence: number | null } | undefined)?.confidence)
      .filter((x): x is number => typeof x === 'number')

    const platforms = new Set(evidence.map((e) => (e.owner_key as string).split(':')[0] ?? '')).size

    const result = scoreClaim(
      {
        claimType: claim.claim_type as 'official_fact',
        valueJson: claim.value_json ? pj(claim.value_json, null) : null,
        versionMin: claim.version_min,
        versionMax: claim.version_max,
        hasOpenConflict: store.hasOpenConflict(claim.id),
        premiseConfidences,
        opinionSample: opinion
          ? { holding: opinion.n_holding, total: opinion.n_discussing, independentPlatforms: platforms }
          : undefined,
      },
      scoring,
    )

    // routing: trusted bands auto-accept; everything else needs human eyes — never silently trusted
    let reviewState: string
    if (claim.review_state === 'approved') reviewState = 'approved'
    else if (result.band === 'verified' || result.band === 'likely') reviewState = 'auto_accepted'
    else if (result.band === 'disputed') reviewState = 'quarantined'
    else reviewState = 'pending'

    store.updateClaimScore(claim.id, result.confidence, result.band, result.breakdown, reviewState)

    // 获客视角投影:只给 player_opinion 的负面口碑打 ad_role(ammo/landmine)
    if (claim.claim_type === 'player_opinion' && claim.opinion_stats) {
      const sent = pj<{ sentiment?: string }>(claim.opinion_stats, {}).sentiment
      const role = classifyAdRole(claim.text, projectName, sent ?? '')
      // 写 NULL 也算一次明确分类(把旧值清掉),保证 ad_role 永远反映最新口碑
      store.db.prepare(`UPDATE claims SET ad_role = ? WHERE id = ?`).run(role, claim.id)
    }

    if (reviewState === 'pending') {
      store.enqueueReview(projectId, 'claim', claim.id, result.band === 'insufficient' ? 'insufficient_evidence' : 'low_confidence', 3)
    } else if (reviewState === 'quarantined') {
      store.enqueueReview(projectId, 'claim', claim.id, 'conflict_open', 1)
    }

    tally.total!++
    tally[result.band] = (tally[result.band] ?? 0) + 1
  }

  // ============ 获客卖点合成(投影层)============
  // 闸门:先从 landmine 口碑算出封锁维度,合成时跳过这些维度
  synthesizeSellingAngles(store, projectId)

  return tally
}

/** 收集 claim → 算封锁维度 → 合成卖点 → 写 selling_angles(先清该项目旧行,可重算)。 */
function synthesizeSellingAngles(store: Store, projectId: string): void {
  const rows = store.db
    .prepare(
      `SELECT id, claim_type, topic, text, confidence, confidence_band, review_state, ad_role, opinion_stats, value_json
       FROM claims WHERE project_id = ? AND merged_into IS NULL`,
    )
    .all(projectId) as {
    id: string
    claim_type: string
    topic: string
    text: string
    confidence: number | null
    confidence_band: string
    review_state: string
    ad_role: string | null
    opinion_stats: string | null
    value_json: string | null
  }[]

  const claims: ClaimForAngle[] = rows.map((r) => ({
    id: r.id,
    claimType: r.claim_type,
    topic: r.topic,
    text: r.text,
    band: r.confidence_band,
    confidence: r.confidence,
    sentiment: r.opinion_stats ? pj<{ sentiment?: string }>(r.opinion_stats, {}).sentiment : undefined,
    adRole: r.ad_role,
    valueJson: r.value_json ? pj(r.value_json, null) : null,
  }))

  // 闸门:landmine 文本 → 封锁维度
  const landmineTexts = rows.filter((r) => r.ad_role === 'landmine').map((r) => r.text)
  const blocked = blockedDimensions(landmineTexts)

  const angles = synthesizeAngles(claims, blocked)

  // 重算:先删该项目所有旧卖点,再写新的(投影层不存历史,随时从 claim 重建)
  store.db.prepare(`DELETE FROM selling_angles WHERE project_id = ?`).run(projectId)
  const insert = store.db.prepare(
    `INSERT INTO selling_angles (id, project_id, dimension, tactic, angle, hooks, strength, derived_from, rationale, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const a of angles) {
    insert.run(newId('ang'), projectId, a.dimension, a.tactic, a.angle, j(a.hooks), a.strength, j(a.derived_from), a.rationale, now())
  }
}

// ---------------------------------------------------------------- conflicts

export async function conflictPhase(store: Store, projectId: string, runId: string, provider: LlmProvider | null): Promise<number> {
  let found = 0

  // rule: same predicate, both numeric, different values, overlapping validity
  const facts = store.db
    .prepare(
      `SELECT id, text, predicate, value_json, qualifiers, version_min FROM claims
       WHERE project_id = ? AND claim_type = 'official_fact' AND merged_into IS NULL
         AND rank != 'deprecated' AND predicate IS NOT NULL AND value_json IS NOT NULL`,
    )
    .all(projectId) as { id: string; text: string; predicate: string; value_json: string; qualifiers: string; version_min: string | null }[]

  const byPredicate = new Map<string, typeof facts>()
  for (const f of facts) {
    const arr = byPredicate.get(f.predicate) ?? []
    arr.push(f)
    byPredicate.set(f.predicate, arr)
  }
  for (const [predicate, group] of byPredicate) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let k = i + 1; k < group.length; k++) {
        const a = group[i]!
        const b = group[k]!
        const va = pj<{ value?: unknown }>(a.value_json, {}).value
        const vb = pj<{ value?: unknown }>(b.value_json, {}).value
        if (va === undefined || vb === undefined || String(va) === String(vb)) continue
        // scoped storefront/version differences are qualifiers, not conflicts
        if (a.text.match(/（\w+ 区）|\((CN|US)\)/) || b.text.match(/（\w+ 区）|\((CN|US)\)/)) continue
        if (a.version_min && b.version_min && a.version_min !== b.version_min) {
          // supersession: newer version wins
          const [older, newer] = a.version_min < b.version_min ? [a, b] : [b, a]
          store.supersede(older.id, newer.id, 'system:supersession', `版本演进 ${older.version_min} → ${newer.version_min} (${predicate})`)
          emit(store, runId, 'consolidate', `版本更替：「${older.text}」已被「${newer.text}」取代`)
          continue
        }
        const id = store.openConflict({
          projectId,
          claimA: a.id,
          claimB: b.id,
          conflictType: 'numeric',
          detectedBy: 'rule:numeric_mismatch',
          note: `${predicate}: ${String(va)} vs ${String(vb)}`,
        })
        if (id) found++
      }
    }
  }

  // LLM semantic pass on related-but-not-duplicate active fact claims
  if (provider) {
    const active = store.db
      .prepare(
        `SELECT id, text, topic FROM claims WHERE project_id = ? AND claim_type IN ('official_fact','system_inference')
         AND merged_into IS NULL AND rank != 'deprecated' ORDER BY updated_at DESC LIMIT 60`,
      )
      .all(projectId) as { id: string; text: string; topic: string }[]
    const pairs: [typeof active[0], typeof active[0]][] = []
    for (let i = 0; i < active.length && pairs.length < 8; i++) {
      for (let k = i + 1; k < active.length && pairs.length < 8; k++) {
        const a = active[i]!
        const b = active[k]!
        if (a.topic !== b.topic) continue
        const { jaccardSimilarity } = await import('../lib/text.js')
        const sim = jaccardSimilarity(a.text, b.text)
        if (sim >= 0.35 && sim < 0.7) pairs.push([a, b])
      }
    }
    for (const [a, b] of pairs) {
      const raw = await provider.completeJson({
        system: CONFLICT_JUDGE_SYSTEM,
        prompt: `结论A: ${a.text}\n结论B: ${b.text}`,
        maxTokens: 300,
      })
      const verdict = conflictVerdictSchema.safeParse(raw)
      if (verdict.success && verdict.data.verdict === 'conflict') {
        const id = store.openConflict({
          projectId,
          claimA: a.id,
          claimB: b.id,
          conflictType: 'semantic',
          detectedBy: `llm:${provider.name}`,
          note: verdict.data.reason,
        })
        if (id) found++
      }
    }
  }
  return found
}

// ---------------------------------------------------------------- coverage

async function assessCoverage(store: Store, projectId: string, provider: LlmProvider, questions: string[]) {
  const byTopic = store.db
    .prepare(
      `SELECT topic, claim_type, confidence_band, COUNT(*) AS n FROM claims
       WHERE project_id = ? AND merged_into IS NULL GROUP BY topic, claim_type, confidence_band`,
    )
    .all(projectId) as { topic: string; claim_type: string; confidence_band: string; n: number }[]
  const raw = await provider.completeJson({
    system: COVERAGE_SYSTEM,
    prompt: `研究问题:\n${questions.map((q) => `- ${q}`).join('\n')}\n\n当前知识库统计 (topic / type / band / count):\n${byTopic
      .map((r) => `${r.topic} / ${r.claim_type} / ${r.confidence_band} / ${r.n}`)
      .join('\n')}`,
    maxTokens: 800,
  })
  const parsed = coverageSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export { connectors }
