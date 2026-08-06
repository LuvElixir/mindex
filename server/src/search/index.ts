import type { DB } from '../db/index.js'
import { pj } from '../lib/util.js'
import { toFtsQuery } from './tokenize.js'

/**
 * Hybrid retrieval over claims:
 *   1. keyword path — jieba-segmented FTS5 (bm25) over claim text
 *   2. evidence path — FTS over evidence quotes, mapped up to their claims
 *   3. LIKE fallback — substring scan when FTS recall is poor (rare terms, single chars)
 * Lists are fused with Reciprocal Rank Fusion (k=60), then re-ranked with explainable
 * multiplicative adjustments: confidence band, freshness, rank (deprecated sinks).
 * Engagement/popularity is never a ranking input.
 */

export interface SearchOptions {
  projectId?: string
  query: string
  claimTypes?: string[]
  bands?: string[]
  topics?: string[]
  /** default: trusted states only (auto_accepted, approved) */
  reviewStates?: string[]
  includeDeprecated?: boolean
  limit?: number
}

export interface SearchHit {
  claimId: string
  score: number
  matchedVia: string[]
  rerank: { base: number; confidenceFactor: number; freshnessFactor: number; rankFactor: number }
}

const RRF_K = 60

export function searchClaims(db: DB, opts: SearchOptions): SearchHit[] {
  const limit = opts.limit ?? 20
  const ftsQuery = toFtsQuery(opts.query)
  const lists: { name: string; ids: string[] }[] = []

  if (ftsQuery) {
    // bm25 aux function is only valid directly against the FTS table — rank in a subquery, then join
    const kw = db
      .prepare(
        `SELECT c.id FROM (SELECT rowid FROM claims_fts WHERE claims_fts MATCH ? ORDER BY rank LIMIT 50) f
         JOIN claims c ON c.rowid = f.rowid`,
      )
      .all(ftsQuery) as { id: string }[]
    lists.push({ name: 'keyword', ids: kw.map((r) => r.id) })

    const ev = db
      .prepare(
        `SELECT ce.claim_id AS id, MIN(f.r) AS s
         FROM (SELECT rowid, rank AS r FROM evidence_fts WHERE evidence_fts MATCH ? ORDER BY rank LIMIT 200) f
         JOIN evidence e ON e.rowid = f.rowid
         JOIN claim_evidence ce ON ce.evidence_id = e.id
         GROUP BY ce.claim_id ORDER BY s LIMIT 50`,
      )
      .all(ftsQuery) as { id: string }[]
    lists.push({ name: 'evidence', ids: ev.map((r) => r.id) })
  }

  // LIKE fallback for short/rare terms the segmenter or index may miss
  const kwCount = lists[0]?.ids.length ?? 0
  if (kwCount < 5 && opts.query.trim().length >= 2) {
    const like = db
      .prepare(`SELECT id FROM claims WHERE text LIKE ? ORDER BY updated_at DESC LIMIT 30`)
      .all(`%${opts.query.trim()}%`) as { id: string }[]
    lists.push({ name: 'substring', ids: like.map((r) => r.id) })
  }

  // RRF fusion
  const fused = new Map<string, { score: number; via: Set<string> }>()
  for (const list of lists) {
    list.ids.forEach((id, rank) => {
      const cur = fused.get(id) ?? { score: 0, via: new Set<string>() }
      cur.score += 1 / (RRF_K + rank + 1)
      cur.via.add(list.name)
      fused.set(id, cur)
    })
  }
  if (fused.size === 0) return []

  // fetch rows + filter + rerank
  const ids = [...fused.keys()]
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, claim_type, topic, confidence, confidence_band, review_state, rank, updated_at, merged_into FROM claims WHERE id IN (${placeholders})`)
    .all(...ids) as {
    id: string
    claim_type: string
    topic: string
    confidence: number | null
    confidence_band: string
    review_state: string
    rank: string
    updated_at: string
    merged_into: string | null
  }[]

  const reviewStates = opts.reviewStates ?? ['auto_accepted', 'approved']
  const hits: SearchHit[] = []
  for (const row of rows) {
    if (row.merged_into) continue
    if (!reviewStates.includes(row.review_state)) continue
    if (opts.claimTypes?.length && !opts.claimTypes.includes(row.claim_type)) continue
    if (opts.bands?.length && !opts.bands.includes(row.confidence_band)) continue
    if (opts.topics?.length && !opts.topics.includes(row.topic)) continue
    if (!opts.includeDeprecated && row.rank === 'deprecated') continue

    const base = fused.get(row.id)!.score
    const confidenceFactor = 0.6 + 0.4 * (row.confidence ?? 0.3)
    const ageDays = (Date.now() - new Date(row.updated_at).getTime()) / 86_400_000
    const freshnessFactor = 0.8 + 0.2 * Math.exp(-ageDays / 90)
    const rankFactor = row.rank === 'preferred' ? 1.05 : 1
    hits.push({
      claimId: row.id,
      score: base * confidenceFactor * freshnessFactor * rankFactor,
      matchedVia: [...fused.get(row.id)!.via],
      rerank: { base, confidenceFactor, freshnessFactor, rankFactor },
    })
  }

  // project filter applied last so callers without projectId still work
  let filtered = hits
  if (opts.projectId) {
    const projectIds = new Set(
      (db.prepare(`SELECT id FROM claims WHERE project_id = ?`).all(opts.projectId) as { id: string }[]).map((r) => r.id),
    )
    filtered = hits.filter((h) => projectIds.has(h.claimId))
  }

  return filtered.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Full claim detail with provenance chain — used by API + context packs. */
export function getClaimDetail(db: DB, claimId: string): Record<string, unknown> | null {
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(claimId) as Record<string, unknown> | undefined
  if (!claim) return null
  const evidence = db
    .prepare(
      `SELECT e.*, ce.stance, ce.directness, ce.extractor_confidence,
              s.name AS source_name, s.url AS source_url, s.platform, s.source_type, s.authority_prior, s.connector,
              sn.fetched_at, sn.content_hash, d.url AS document_url, d.title AS document_title
       FROM claim_evidence ce
       JOIN evidence e ON e.id = ce.evidence_id
       JOIN sources s ON s.id = e.source_id
       JOIN snapshots sn ON sn.id = e.snapshot_id
       JOIN documents d ON d.id = sn.document_id
       WHERE ce.claim_id = ?
       ORDER BY ce.stance, e.published_at DESC`,
    )
    .all(claimId) as Record<string, unknown>[]
  const conflicts = db
    .prepare(
      `SELECT c.*, ca.text AS claim_a_text, cb.text AS claim_b_text FROM conflicts c
       JOIN claims ca ON ca.id = c.claim_a JOIN claims cb ON cb.id = c.claim_b
       WHERE c.claim_a = ? OR c.claim_b = ?`,
    )
    .all(claimId, claimId) as Record<string, unknown>[]
  const revisions = db.prepare(`SELECT * FROM revisions WHERE claim_id = ? ORDER BY id DESC`).all(claimId)
  return {
    ...claim,
    qualifiers: pj(claim.qualifiers as string, {}),
    confidence_breakdown: pj(claim.confidence_breakdown as string, {}),
    opinion_stats: claim.opinion_stats ? pj(claim.opinion_stats as string, null) : null,
    value_json: claim.value_json ? pj(claim.value_json as string, null) : null,
    derived_from: pj(claim.derived_from as string, []),
    evidence,
    conflicts,
    revisions,
  }
}
