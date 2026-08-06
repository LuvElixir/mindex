/**
 * Groundedness & trust-boundary evaluation (L1 layer — deterministic, zero LLM cost).
 *
 * Sweeps the ENTIRE live database and asserts:
 *  E1 citation integrity — every evidence quote is re-findable in its snapshot text
 *     (fabricated citations must be structurally impossible; requirement: 100%)
 *  E2 no unsupported trusted claims — every trusted claim has ≥1 supporting evidence
 *  E3 confidence honesty — insufficient ⇒ confidence IS NULL; verified ⇒ ≥2 independent groups
 *  E4 trust boundary — no uncertain/disputed/insufficient claim sits in auto_accepted
 *  E5 conflict integrity — open conflicts ⇒ both claims are disputed/quarantined or deprecated
 *
 * Run: npx tsx src/scripts/eval.ts   (exit code 1 on any failure)
 */
import { getDb } from '../db/index.js'
import { groundQuote } from '../core/grounding.js'
import { groupIndependent, type ScoringEvidence } from '../core/confidence.js'

const db = getDb()
const failures: string[] = []
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(`${name}: ${detail}`)
}

// E1 citation integrity
const links = db
  .prepare(
    `SELECT ce.claim_id, e.id AS evidence_id, e.quote, sn.text AS snapshot_text
     FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id JOIN snapshots sn ON sn.id = e.snapshot_id`,
  )
  .all() as { claim_id: string; evidence_id: string; quote: string; snapshot_text: string }[]
const broken = links.filter((l) => !groundQuote(l.snapshot_text, l.quote).ok)
check(
  `E1 citation integrity (${links.length} 条引用全量校验)`,
  broken.length === 0,
  `${broken.length} 条引文无法在快照中复现: ${broken.slice(0, 3).map((b) => b.evidence_id).join(', ')}`,
)

// E2 unsupported trusted claims
const unsupported = db
  .prepare(
    `SELECT c.id FROM claims c WHERE c.review_state IN ('auto_accepted','approved') AND c.merged_into IS NULL
     AND NOT EXISTS (SELECT 1 FROM claim_evidence ce WHERE ce.claim_id = c.id AND ce.stance = 'supports')`,
  )
  .all() as { id: string }[]
check('E2 可信知识零无证据结论', unsupported.length === 0, `${unsupported.length} 条可信结论没有任何支持证据: ${unsupported.slice(0, 3).map((u) => u.id).join(', ')}`)

// E3 confidence honesty
const dishonestNull = db
  .prepare(`SELECT id FROM claims WHERE confidence_band = 'insufficient' AND confidence IS NOT NULL`)
  .all() as { id: string }[]
check('E3a insufficient ⇒ confidence=NULL', dishonestNull.length === 0, `${dishonestNull.length} 条违例`)

const verifiedClaims = db
  .prepare(`SELECT id, claim_type FROM claims WHERE confidence_band = 'verified' AND merged_into IS NULL AND claim_type != 'player_opinion'`)
  .all() as { id: string }[]
let verifiedSingleSource = 0
for (const c of verifiedClaims) {
  const ev = db
    .prepare(
      `SELECT e.id AS evidenceId, ce.stance, ce.directness, ce.extractor_confidence AS extractorConfidence, e.quote,
              s.id AS sourceId, s.source_type AS sourceType, s.owner_key AS ownerKey, s.authority_prior AS authorityPrior,
              sn.dup_cluster AS dupCluster, e.suspected_promo AS suspectedPromo, e.published_at AS publishedAt
       FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id
       JOIN sources s ON s.id = e.source_id JOIN snapshots sn ON sn.id = e.snapshot_id
       WHERE ce.claim_id = ? AND ce.stance = 'supports'`,
    )
    .all(c.id) as unknown as ScoringEvidence[]
  const groups = groupIndependent(ev.map((e) => ({ ...e, versionTag: null, suspectedPromo: Boolean(e.suspectedPromo) })))
  if (groups.length < 2) verifiedSingleSource++
}
check(`E3b verified ⇒ ≥2 独立来源 (${verifiedClaims.length} 条抽查)`, verifiedSingleSource === 0, `${verifiedSingleSource} 条 verified 事实只有单一独立来源`)

// E4 trust boundary
const leaked = db
  .prepare(
    `SELECT id FROM claims WHERE review_state = 'auto_accepted' AND confidence_band IN ('uncertain','disputed','insufficient')`,
  )
  .all() as { id: string }[]
check('E4 低置信/冲突结论不得静默进入可信库', leaked.length === 0, `${leaked.length} 条越界`)

// E5 conflict integrity
const openConflicts = db
  .prepare(
    `SELECT c.id, ca.confidence_band AS band_a, ca.review_state AS state_a, ca.rank AS rank_a,
            cb.confidence_band AS band_b, cb.review_state AS state_b, cb.rank AS rank_b
     FROM conflicts c JOIN claims ca ON ca.id = c.claim_a JOIN claims cb ON cb.id = c.claim_b
     WHERE c.status = 'open'`,
  )
  .all() as Record<string, string>[]
const badConflicts = openConflicts.filter((c) => {
  const okA = c.band_a === 'disputed' || c.state_a === 'quarantined' || c.rank_a === 'deprecated' || c.state_a === 'rejected'
  const okB = c.band_b === 'disputed' || c.state_b === 'quarantined' || c.rank_b === 'deprecated' || c.state_b === 'rejected'
  return !(okA && okB)
})
check(`E5 未决冲突双方必须处于争议态 (${openConflicts.length} 组)`, badConflicts.length === 0, `${badConflicts.length} 组冲突中有一方仍被标记可信`)

// summary stats (informational)
const stats = db
  .prepare(
    `SELECT confidence_band, COUNT(*) AS n FROM claims WHERE merged_into IS NULL GROUP BY confidence_band ORDER BY n DESC`,
  )
  .all() as { confidence_band: string; n: number }[]
console.log('\n知识库分布:', stats.map((s) => `${s.confidence_band}=${s.n}`).join(' '))

if (failures.length > 0) {
  console.error(`\n✗ 评测失败 ${failures.length} 项`)
  process.exit(1)
}
console.log('\n✓ 全部评测通过')
