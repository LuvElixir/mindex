import type { DB } from '../db/index.js'
import { estimateTokens } from '../lib/text.js'
import { pj } from '../lib/util.js'
import { searchClaims } from '../search/index.js'
import { landmineAvoidList } from './adRole.js'

/**
 * Context Pack: structured, cited, budget-controlled knowledge for downstream
 * creative agents (e.g. AdMuse). Honesty rules:
 *  - only trusted claims (auto_accepted / approved; verified / likely) are included
 *  - excluded disputed/uncertain/insufficient claims are DECLARED in `excluded`
 *  - every item carries citations with evidence ids; UGC quotes are marked paraphrase-only
 *  - opinion items expose representativeness stats, never presented as facts
 */

export interface ContextPackRequest {
  projectId: string
  task?: string
  focus?: string[]
  budgetTokens?: number
  minBand?: 'verified' | 'likely'
}

interface PackCitation {
  evidence_id: string
  source: string
  url: string | null
  quote: string
  fetched_at: string
  published_at: string | null
  quotable: boolean
}

interface PackItem {
  id: string
  seq: number
  type: string
  topic: string
  text: string
  confidence: { score: number | null; band: string }
  valid: { from: string | null; until: string | null; version_min: string | null; version_max: string | null }
  opinion?: Record<string, unknown>
  citations: PackCitation[]
  ad_role?: string | null
  _rank?: number
}

export function buildContextPack(db: DB, req: ContextPackRequest) {
  const budget = Math.min(Math.max(req.budgetTokens ?? 6000, 800), 32_000)
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.projectId) as Record<string, unknown> | undefined
  if (!project) return null

  const bands = req.minBand === 'verified' ? ['verified'] : ['verified', 'likely']
  const rows = db
    .prepare(
      `SELECT id, seq, claim_type, topic, text, confidence, confidence_band, valid_from, valid_until,
              version_min, version_max, opinion_stats, ad_role, updated_at, rank
       FROM claims
       WHERE project_id = ? AND merged_into IS NULL AND rank != 'deprecated'
         AND review_state IN ('auto_accepted','approved')
         AND confidence_band IN (${bands.map(() => '?').join(',')})
       ORDER BY confidence DESC`,
    )
    .all(req.projectId, ...bands) as Record<string, unknown>[]

  // task relevance via hybrid search when a task is given
  const relevance = new Map<string, number>()
  if (req.task) {
    const hits = searchClaims(db, { projectId: req.projectId, query: req.task, limit: 100 })
    hits.forEach((h, i) => relevance.set(h.claimId, 1 - i / Math.max(hits.length, 1)))
  }

  const citationStmt = db.prepare(
    `SELECT e.id, e.quote, e.published_at, s.name AS source_name, s.url, s.source_type, sn.fetched_at
     FROM claim_evidence ce
     JOIN evidence e ON e.id = ce.evidence_id
     JOIN sources s ON s.id = e.source_id
     JOIN snapshots sn ON sn.id = e.snapshot_id
     WHERE ce.claim_id = ? AND ce.stance = 'supports'
     ORDER BY s.authority_prior DESC LIMIT 3`,
  )

  const items: PackItem[] = rows.map((r) => {
    const citations = (citationStmt.all(r.id) as Record<string, unknown>[]).map((c) => ({
      evidence_id: c.id as string,
      source: c.source_name as string,
      url: (c.url as string) || null,
      quote: (c.quote as string).slice(0, 200),
      fetched_at: c.fetched_at as string,
      published_at: (c.published_at as string) || null,
      quotable: c.source_type !== 'store_review' && c.source_type !== 'community',
    }))
    const bandWeight = r.confidence_band === 'verified' ? 1 : 0.7
    const rel = req.task ? 0.3 + 0.7 * (relevance.get(r.id as string) ?? 0) : 1
    const ageDays = (Date.now() - new Date(r.updated_at as string).getTime()) / 86_400_000
    const freshness = 0.7 + 0.3 * Math.exp(-ageDays / 180)
    const focusBoost = req.focus?.length ? (req.focus.includes(r.topic as string) ? 1.3 : 0.8) : 1
    return {
      id: r.id as string,
      seq: r.seq as number,
      type: r.claim_type as string,
      topic: r.topic as string,
      text: r.text as string,
      confidence: { score: r.confidence as number | null, band: r.confidence_band as string },
      valid: {
        from: (r.valid_from as string) || null,
        until: (r.valid_until as string) || null,
        version_min: (r.version_min as string) || null,
        version_max: (r.version_max as string) || null,
      },
      ...(r.opinion_stats ? { opinion: pj(r.opinion_stats as string, {}) } : {}),
      citations,
      ad_role: (r.ad_role as string | null) ?? null,
      _rank: bandWeight * rel * freshness * focusBoost,
    }
  })

  items.sort((a, b) => b._rank! - a._rank!)

  // budget trim with per-section quotas: a creative agent needs player voice, not
  // just facts — opinions get a reserved share instead of being crowded out
  const sectionOf = (i: PackItem) => (i.type === 'official_fact' ? 'facts' : i.type === 'player_opinion' ? 'opinions' : 'insights')
  const quota: Record<string, number> = { facts: budget * 0.5, opinions: budget * 0.35, insights: budget * 0.15 }
  const spent: Record<string, number> = { facts: 0, opinions: 0, insights: 0 }
  const included: PackItem[] = []
  const skipped: PackItem[] = []
  let used = estimateTokens(JSON.stringify({ meta: true }))
  for (const item of items) {
    const cost = estimateTokens(JSON.stringify(item))
    const s = sectionOf(item)
    if (used + cost > budget || spent[s]! + cost > quota[s]!) {
      skipped.push(item)
      continue
    }
    included.push(item)
    spent[s]! += cost
    used += cost
  }
  // second pass: leftover budget goes to best remaining items regardless of section
  for (const item of skipped) {
    const cost = estimateTokens(JSON.stringify(item))
    if (used + cost > budget) continue
    included.push(item)
    used += cost
  }

  const excludedCounts = db
    .prepare(
      `SELECT confidence_band, COUNT(*) AS n FROM claims
       WHERE project_id = ? AND merged_into IS NULL
         AND (confidence_band IN ('uncertain','disputed','insufficient') OR review_state NOT IN ('auto_accepted','approved'))
       GROUP BY confidence_band`,
    )
    .all(req.projectId) as { confidence_band: string; n: number }[]

  const sections = {
    product_facts: included.filter((i) => i.type === 'official_fact'),
    // landmine 类负面口碑移出 opinions,单独进 landmines 区(否则会与地雷警示重复)
    audience_opinions: included.filter((i) => i.type === 'player_opinion' && i.ad_role !== 'landmine'),
    insights: included.filter((i) => i.type === 'system_inference' || i.type === 'creative_insight'),
  }
  for (const arr of Object.values(sections)) arr.forEach((i) => delete i._rank)

  // ---- landmines:获客地雷区(独立于 band 过滤)----
  // 负面口碑作为"别写什么"的警示,价值与置信度无关:一条哪怕 uncertain 的
  // "玩家反馈优化差",作为"别承诺丝滑"的约束依然有效。所以这里不看 band,只看 ad_role。
  const landmineRows = db
    .prepare(
      `SELECT id, text, topic, confidence, confidence_band, opinion_stats
       FROM claims
       WHERE project_id = ? AND merged_into IS NULL AND claim_type = 'player_opinion' AND ad_role = 'landmine'
       ORDER BY confidence DESC LIMIT 10`,
    )
    .all(req.projectId) as { id: string; text: string; topic: string; confidence: number | null; confidence_band: string; opinion_stats: string | null }[]
  const landmines = landmineRows.map((r) => ({
    claim_id: r.id,
    issue: r.text,
    band: r.confidence_band,
    confidence: r.confidence,
    avoid_promising: landmineAvoidList(r.text), // 告诉下游"这些反向承诺别写"
  }))

  const trimmed = items.length - included.length

  // ---- selling_angles:获客卖点角度(投影层,由 scorePhase 合成)----
  // 已过 landmine 闸门:被封锁维度的卖点不会出现在这里。按 strength 排序。
  const angleRows = db
    .prepare(
      `SELECT id, dimension, tactic, angle, hooks, strength, derived_from, rationale
       FROM selling_angles WHERE project_id = ? ORDER BY CASE strength WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`,
    )
    .all(req.projectId) as { id: string; dimension: string; tactic: string; angle: string; hooks: string; strength: string; derived_from: string; rationale: string }[]
  const selling_angles = angleRows.map((r) => ({
    id: r.id,
    dimension: r.dimension,
    tactic: r.tactic,
    angle: r.angle,
    hooks: pj<string[]>(r.hooks, []),
    strength: r.strength,
    derived_from: pj<string[]>(r.derived_from, []),
    rationale: r.rationale,
  }))

  return {
    meta: {
      project_id: req.projectId,
      project_name: project.name,
      demo_data: Boolean(project.demo),
      task: req.task ?? null,
      focus: req.focus ?? [],
      generated_at: new Date().toISOString(),
      token_budget: budget,
      tokens_used_estimate: used,
      confidence_legend:
        'verified: ≥0.85 且 ≥2 独立来源；likely: ≥0.65。观点类的 confidence 表示代表性（Wilson 下界），不表示事实为真。',
      usage_rules: [
        '引用知识时必须保留 claim id 以便追溯',
        'quotable=false 的引文（用户评论等 UGC）只可转述，不可逐字用于公开物料',
        '观点条目描述玩家看法的普遍程度，禁止当作产品事实使用',
        'landmines 区列的是本产品已知口碑短板——其 avoid_promising 字段标明对应的反向承诺禁止出现在广告中（踩雷风险）',
        'selling_angles 是已过 landmine 闸门的获客角度——hooks 是自由修辞(平台不管),但排名/荣誉/最/第一等资质类词仍受广告法约束,需客户在媒体后台上传资质才能用',
        'excluded 中声明的未收录知识不代表不存在——按需请求更大预算或人工审核',
      ],
    },
    ...sections,
    selling_angles: {
      note: '获客卖点角度(知识→广告的投影)。已过 landmine 闸门:被口碑短板封锁的维度不会出现在此。每条继承到源 claim 可追溯,strength 表示获客价值强度。',
      items: selling_angles,
    },
    landmines: {
      note: '本产品当前的口碑短板(获客地雷区)。广告文案禁止做这些短板的反向承诺;每条的 avoid_promising 给出具体禁区。',
      items: landmines,
    },
    excluded: {
      note: '以下知识因置信度不足/存在冲突/待审核未收录（诚实声明，不静默丢弃）',
      by_band: Object.fromEntries(excludedCounts.map((r) => [r.confidence_band, r.n])),
      trimmed_by_budget: trimmed,
    },
  }
}
