import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

process.env.MINDEX_LLM_PROVIDER = 'none'

const { memoryDb } = await import('../src/db/index.js')
const { Store } = await import('../src/core/store.js')
const { extractPhase, consolidatePhase, scorePhase, conflictPhase } = await import('../src/agent/pipeline.js')
const { buildContextPack } = await import('../src/core/contextPack.js')
const { groundQuote } = await import('../src/core/grounding.js')
const { appMetadataText } = await import('../src/connectors/itunes.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, '..', 'fixtures')

/**
 * End-to-end pipeline test on RECORDED REAL DATA (国内信源：App Store CN 元数据 +
 * TapTap 真实玩家评论，原神，2026-07 录制)。
 * No network, no LLM — exercises the heuristic path: ingest → grounded evidence →
 * claims → dedupe → confidence → conflicts → context pack.
 */

let store: InstanceType<typeof Store>
let projectId: string
const runId = 'run_testfixture00000'

beforeAll(async () => {
  store = new Store(memoryDb())
  const project = store.createProject({ name: '原神', kind: 'game', demo: true })
  projectId = project.id
  store.db
    .prepare(
      `INSERT INTO research_runs (id, project_id, goal, status, llm_provider, started_at) VALUES (?, ?, 'test', 'running', 'none', datetime('now'))`,
    )
    .run(runId, projectId)

  const lookup = JSON.parse(readFileSync(path.join(FIXTURES, 'appstore_cn_lookup_1467190251.json'), 'utf8'))
  const app = lookup.results[0]
  const reviews = JSON.parse(readFileSync(path.join(FIXTURES, 'taptap_reviews_genshin.json'), 'utf8')) as {
    content: string
    rating: number | null
    author: string | null
    publishedAt: string | null
  }[]

  const metaSrc = store.upsertSource({
    projectId,
    connector: 'itunes_app',
    sourceType: 'store_metadata',
    name: 'App Store (CN) 商店页',
    url: `https://apps.apple.com/cn/app/id${app.trackId}`,
    ownerKey: `appstore:${app.sellerName}`,
    authorityPrior: 0.85,
  })
  const metaDoc = store.upsertDocument({ sourceId: metaSrc.id, projectId, canonicalUrl: `itunes://cn/app/${app.trackId}`, docType: 'api_record', title: 'App Store CN 元数据' })
  const metaSnap = store.insertSnapshot({ documentId: metaDoc.id, projectId, runId, text: appMetadataText(app), meta: { country: 'cn' } })

  const rvSrc = store.upsertSource({
    projectId,
    connector: 'manual',
    sourceType: 'store_review',
    name: 'taptap 用户评价（导入）',
    url: 'https://www.taptap.cn/app/168332',
    platform: 'taptap',
    ownerKey: 'taptap_reviews_import',
    authorityPrior: 0.4,
  })
  const snapIds = [metaSnap.id]
  reviews.forEach((rv, i) => {
    if (!rv.content?.trim() || rv.content.trim().length < 6) return
    const doc = store.upsertDocument({
      sourceId: rvSrc.id,
      projectId,
      canonicalUrl: `taptap://import/test/review/${i}`,
      docType: 'review',
      authorHandle: rv.author,
      publishedAt: rv.publishedAt,
    })
    const snap = store.insertSnapshot({ documentId: doc.id, projectId, runId, text: rv.content.trim(), meta: { review: { rating: rv.rating } } })
    if (!snap.unchanged) snapIds.push(snap.id)
  })

  await extractPhase(store, store.getProject(projectId)!, runId, snapIds, null)
  consolidatePhase(store, projectId, runId)
  scorePhase(store, projectId)
})

describe('pipeline on recorded real data (no LLM, heuristic path)', () => {
  it('extracts official facts from store metadata with grounded evidence', () => {
    const facts = store.db
      .prepare(`SELECT * FROM claims WHERE project_id = ? AND claim_type = 'official_fact' AND merged_into IS NULL`)
      .all(projectId) as { id: string; text: string; predicate: string }[]
    expect(facts.length).toBeGreaterThanOrEqual(3)
    expect(facts.some((f) => f.predicate === 'developer' && f.text.includes('miHoYo'))).toBe(true)
  })

  it('metadata and opinion claims produce graph entities (公司/品类/口碑枢纽)', () => {
    const ents = store.db
      .prepare(
        `SELECT e.entity_type, e.canonical_name, COUNT(ce.claim_id) AS n
         FROM entities e JOIN claim_entities ce ON ce.entity_id = e.id
         WHERE e.project_id = ? GROUP BY e.id`,
      )
      .all(projectId) as { entity_type: string; canonical_name: string; n: number }[]
    expect(ents.some((e) => e.entity_type === 'company' && e.canonical_name.includes('miHoYo'))).toBe(true)
    expect(ents.some((e) => e.entity_type === 'term' && e.canonical_name.endsWith('口碑'))).toBe(true)
  })

  it('aggregates player opinions from real reviews with representativeness stats', () => {
    const opinions = store.db
      .prepare(`SELECT * FROM claims WHERE project_id = ? AND claim_type = 'player_opinion'`)
      .all(projectId) as { opinion_stats: string }[]
    expect(opinions.length).toBeGreaterThanOrEqual(1)
    for (const o of opinions) {
      const stats = JSON.parse(o.opinion_stats)
      expect(stats.n_holding).toBeGreaterThanOrEqual(3)
      expect(stats.n_discussing).toBeGreaterThanOrEqual(stats.n_holding)
      expect(stats.ci_low).toBeLessThanOrEqual(stats.prevalence + 1e-9)
      expect(stats.sampling_note).toBeTruthy()
    }
  })

  it('EVAL L1: every citation in the DB re-grounds against its snapshot', () => {
    const links = store.db
      .prepare(
        `SELECT e.quote, sn.text FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id JOIN snapshots sn ON sn.id = e.snapshot_id`,
      )
      .all() as { quote: string; text: string }[]
    expect(links.length).toBeGreaterThan(0)
    const broken = links.filter((l) => !groundQuote(l.text, l.quote).ok)
    expect(broken).toEqual([])
  })

  it('EVAL: no trusted claim exists without supporting evidence', () => {
    const unsupported = store.db
      .prepare(
        `SELECT c.id FROM claims c WHERE c.review_state IN ('auto_accepted','approved')
         AND NOT EXISTS (SELECT 1 FROM claim_evidence ce WHERE ce.claim_id = c.id AND ce.stance = 'supports')`,
      )
      .all()
    expect(unsupported).toEqual([])
  })

  it('EVAL: trust boundary — low-confidence claims never auto-accepted', () => {
    const leaked = store.db
      .prepare(`SELECT id FROM claims WHERE review_state = 'auto_accepted' AND confidence_band IN ('uncertain','disputed','insufficient')`)
      .all()
    expect(leaked).toEqual([])
  })
})

describe('conflicts & supersession on top of real data', () => {
  it('detects numeric conflicts and quarantines both claims', async () => {
    const src = store.db.prepare(`SELECT id FROM sources WHERE project_id = ? LIMIT 1`).get(projectId) as { id: string }
    const doc = store.upsertDocument({ sourceId: src.id, projectId, canonicalUrl: 'test://conflict-doc', docType: 'page', title: 'x' })
    const snap = store.insertSnapshot({ documentId: doc.id, projectId, text: '来源甲说定价是268元。来源乙说定价是328元。' })
    const ev1 = store.insertEvidence({ projectId, snapshotId: snap.id, sourceId: src.id, quote: '来源甲说定价是268元' })
    const ev2 = store.insertEvidence({ projectId, snapshotId: snap.id, sourceId: src.id, quote: '来源乙说定价是328元' })
    const c1 = store.createClaim({
      projectId, claimType: 'official_fact', text: '游戏标准版定价为268元', predicate: 'test_price',
      valueJson: { value: 268, unit: '元' }, extractionProvider: 'heuristic', evidence: [{ evidenceId: ev1 }],
    })
    const c2 = store.createClaim({
      projectId, claimType: 'official_fact', text: '游戏标准版定价为328元', predicate: 'test_price',
      valueJson: { value: 328, unit: '元' }, extractionProvider: 'heuristic', evidence: [{ evidenceId: ev2 }],
    })
    const found = await conflictPhase(store, projectId, runId, null)
    expect(found).toBeGreaterThanOrEqual(1)
    scorePhase(store, projectId)
    for (const id of [c1, c2]) {
      const row = store.db.prepare(`SELECT confidence_band, review_state FROM claims WHERE id = ?`).get(id) as Record<string, string>
      expect(row.confidence_band).toBe('disputed')
      expect(row.review_state).toBe('quarantined')
    }
    const queue = store.db
      .prepare(`SELECT * FROM review_queue WHERE item_id IN (?, ?) AND reason = 'conflict_open'`)
      .all(c1, c2)
    expect(queue.length).toBe(2)
  })

  it('supersedes older versioned claims instead of flagging conflicts', async () => {
    const src = store.db.prepare(`SELECT id FROM sources WHERE project_id = ? LIMIT 1`).get(projectId) as { id: string }
    const doc = store.upsertDocument({ sourceId: src.id, projectId, canonicalUrl: 'test://version-doc', docType: 'page', title: 'x' })
    const snap = store.insertSnapshot({ documentId: doc.id, projectId, text: '1.0版本保底为90抽。1.2版本保底调整为80抽。' })
    const evOld = store.insertEvidence({ projectId, snapshotId: snap.id, sourceId: src.id, quote: '1.0版本保底为90抽' })
    const evNew = store.insertEvidence({ projectId, snapshotId: snap.id, sourceId: src.id, quote: '1.2版本保底调整为80抽' })
    const oldClaim = store.createClaim({
      projectId, claimType: 'official_fact', text: '1.0版本抽卡保底为90抽', predicate: 'test_pity',
      valueJson: { value: 90 }, versionMin: '1.0', extractionProvider: 'heuristic', evidence: [{ evidenceId: evOld }],
    })
    const newClaim = store.createClaim({
      projectId, claimType: 'official_fact', text: '1.2版本抽卡保底为80抽', predicate: 'test_pity',
      valueJson: { value: 80 }, versionMin: '1.2', extractionProvider: 'heuristic', evidence: [{ evidenceId: evNew }],
    })
    await conflictPhase(store, projectId, runId, null)
    const oldRow = store.db.prepare(`SELECT rank, superseded_by, valid_until FROM claims WHERE id = ?`).get(oldClaim) as Record<string, string>
    expect(oldRow.rank).toBe('deprecated')
    expect(oldRow.superseded_by).toBe(newClaim)
    expect(oldRow.valid_until).toBeTruthy()
    const newRow = store.db.prepare(`SELECT rank FROM claims WHERE id = ?`).get(newClaim) as Record<string, string>
    expect(newRow.rank).toBe('preferred')
  })
})

describe('coverage schema (买量十维)', () => {
  it('parses per-dimension coverage and catches invalid status', async () => {
    const { coverageSchema } = await import('../src/agent/pipeline.js')
    const parsed = coverageSchema.parse({
      sufficient: false,
      dimensions: [
        { key: 'selling_points', status: 'covered', note: 'ok' },
        { key: 'creative_patterns', status: 'bogus-value' },
      ],
      gaps: ['缺素材套路'],
    })
    expect(parsed.dimensions).toHaveLength(2)
    expect(parsed.dimensions[0]!.status).toBe('covered')
    expect(parsed.dimensions[1]!.status).toBe('partial') // invalid → catch fallback
    expect(parsed.extra_keywords).toEqual([])
  })

  it('UA_DIMENSIONS 是十维且 key 唯一', async () => {
    const { UA_DIMENSIONS } = await import('../src/agent/prompts.js')
    expect(UA_DIMENSIONS).toHaveLength(10)
    expect(new Set(UA_DIMENSIONS.map((d: { key: string }) => d.key)).size).toBe(10)
  })
})

describe('context pack from real data', () => {
  it('only includes trusted claims, with resolvable citations and declared exclusions', () => {
    const pack = buildContextPack(store.db, { projectId, budgetTokens: 6000 })!
    expect(pack).toBeTruthy()
    expect(pack.meta.demo_data).toBe(true)
    const all = [...pack.product_facts, ...pack.audience_opinions, ...pack.insights]
    expect(all.length).toBeGreaterThan(0)
    for (const item of all) {
      expect(['verified', 'likely']).toContain(item.confidence.band)
      expect(item.citations.length).toBeGreaterThan(0)
      for (const c of item.citations) {
        const ev = store.db.prepare(`SELECT id FROM evidence WHERE id = ?`).get(c.evidence_id)
        expect(ev).toBeTruthy()
      }
    }
    // deprecated / disputed claims must NOT appear
    const deprecated = store.db.prepare(`SELECT id FROM claims WHERE project_id = ? AND (rank = 'deprecated' OR confidence_band = 'disputed')`).all(projectId) as { id: string }[]
    const packIds = new Set(all.map((i) => i.id))
    for (const d of deprecated) expect(packIds.has(d.id)).toBe(false)
    // opinions carry representativeness, marked distinct from facts
    for (const o of pack.audience_opinions) {
      expect(o.opinion).toBeTruthy()
      expect(o.type).toBe('player_opinion')
    }
    // honest exclusion declaration
    expect(pack.excluded.note).toContain('诚实')
  })

  it('respects the token budget', () => {
    const small = buildContextPack(store.db, { projectId, budgetTokens: 900 })!
    expect(small.meta.tokens_used_estimate).toBeLessThanOrEqual(900)
  })
})
