import { clamp, logit, sigmoid, wilsonLower } from '../lib/util.js'

/**
 * Explainable confidence engine.
 *
 * - official_fact / system_inference: "how likely is this TRUE" — log-odds factor sum + cap rules.
 * - player_opinion: "how REPRESENTATIVE is this view" — Wilson lower bound on prevalence.
 *   Truth and representativeness are deliberately separate axes.
 * - creative_insight: never above 'likely'; heuristic usefulness signal only.
 *
 * Honesty rules: with no admissible evidence the engine returns band='insufficient' and
 * confidence=null (NOT 0.5 — "don't know" must be distinguishable from "coin flip").
 * Engagement metrics (likes/votes/rank) are never truth inputs.
 */

export type Stance = 'supports' | 'refutes' | 'mentions'
export type Directness = 'direct' | 'indirect' | 'interpretive'
export type Band = 'verified' | 'likely' | 'uncertain' | 'disputed' | 'insufficient'

export interface ScoringEvidence {
  evidenceId: string
  stance: Stance
  directness: Directness
  extractorConfidence: number | null
  quote: string
  sourceId: string
  sourceType: string
  /** normalized publisher identity; same owner ⇒ not independent */
  ownerKey: string
  authorityPrior: number
  /** near-duplicate / syndication cluster; same cluster ⇒ not independent */
  dupCluster: string | null
  suspectedPromo: boolean
  publishedAt: string | null
  versionTag: string | null
}

export interface ClaimForScoring {
  claimType: 'official_fact' | 'player_opinion' | 'system_inference' | 'creative_insight'
  valueJson: { value: number | string; unit?: string } | null
  versionMin: string | null
  versionMax: string | null
  hasOpenConflict: boolean
  /** confidences of premise claims for inference/insight types */
  premiseConfidences: number[]
  /** for player_opinion: counts AFTER dedupe */
  opinionSample?: { holding: number; total: number; independentPlatforms: number }
}

export interface Factor {
  factor: string
  input: string
  logodds: number
}

export interface ConfidenceResult {
  confidence: number | null
  band: Band
  breakdown: {
    factors: Factor[]
    caps: { rule: string; cap: number }[]
    raw: number | null
    note: string
    scorerVersion: string
  }
}

const SCORER_VERSION = 'conf-v1'

interface Group {
  ownerKey: string
  cluster: string | null
  items: ScoringEvidence[]
  authority: number
  bestDirectness: Directness
  anyPromo: boolean
  newestPublishedAt: string | null
}

/** Collapse evidence into independent source groups: same owner or same dup-cluster = one group. */
export function groupIndependent(evidence: ScoringEvidence[]): Group[] {
  const groups = new Map<string, ScoringEvidence[]>()
  for (const e of evidence) {
    const key = e.dupCluster ? `cluster:${e.dupCluster}` : `owner:${e.ownerKey || e.sourceId}`
    const arr = groups.get(key) || []
    arr.push(e)
    groups.set(key, arr)
  }
  const rank: Record<Directness, number> = { direct: 2, indirect: 1, interpretive: 0 }
  return [...groups.values()].map((items) => {
    const best = items.reduce((a, b) => (rank[a.directness] >= rank[b.directness] ? a : b))
    return {
      ownerKey: items[0]!.ownerKey,
      cluster: items[0]!.dupCluster,
      items,
      authority: Math.max(...items.map((i) => i.authorityPrior)),
      bestDirectness: best.directness,
      anyPromo: items.some((i) => i.suspectedPromo),
      newestPublishedAt: items.map((i) => i.publishedAt).filter(Boolean).sort().at(-1) ?? null,
    }
  })
}

function directnessBonus(d: Directness): number {
  return d === 'direct' ? 0.8 : d === 'indirect' ? 0.3 : 0
}

function insufficient(note: string): ConfidenceResult {
  return {
    confidence: null,
    band: 'insufficient',
    breakdown: {
      factors: [{ factor: 'no_admissible_evidence', input: note, logodds: 0 }],
      caps: [],
      raw: null,
      note,
      scorerVersion: SCORER_VERSION,
    },
  }
}

export function scoreClaim(claim: ClaimForScoring, evidence: ScoringEvidence[]): ConfidenceResult {
  if (claim.claimType === 'player_opinion') return scoreOpinion(claim, evidence)

  const admissible = evidence.filter((e) => e.stance !== 'mentions')
  const supportGroups = groupIndependent(admissible.filter((e) => e.stance === 'supports'))
  const refuteGroups = groupIndependent(admissible.filter((e) => e.stance === 'refutes'))

  if (supportGroups.length === 0 && refuteGroups.length === 0) {
    return insufficient('该结论没有任何支持或反驳证据（mentions 不计入）')
  }

  const factors: Factor[] = []

  // F1 source authority: best supporting group's prior
  const authority = supportGroups.length ? Math.max(...supportGroups.map((g) => g.authority)) : 0.2
  factors.push({
    factor: 'authority_prior',
    input: `最高来源权威先验 ${authority.toFixed(2)}`,
    logodds: round(logit(authority) * 0.9),
  })

  // F2 evidence directness
  const bestDirect = supportGroups.length
    ? supportGroups.map((g) => g.bestDirectness).sort((a, b) => directnessBonus(b) - directnessBonus(a))[0]!
    : 'interpretive'
  factors.push({
    factor: 'directness',
    input: `最佳证据直接性 ${bestDirect}`,
    logodds: directnessBonus(bestDirect),
  })

  // F3 independent supporting sources: log gain, capped (anti-flooding)
  factors.push({
    factor: 'independent_sources',
    input: `${supportGroups.length} 个独立支持源（同主体/转载簇已折叠，共 ${admissible.filter((e) => e.stance === 'supports').length} 条证据）`,
    logodds: round(Math.min(1.5, 0.7 * Math.log2(1 + supportGroups.length))),
  })

  // F4 cross-source value consistency (numeric claims only)
  if (claim.valueJson && supportGroups.length >= 2) {
    const needle = String(claim.valueJson.value)
    const agree = supportGroups.filter((g) => g.items.some((e) => e.quote.includes(needle))).length
    const ratio = agree / supportGroups.length
    factors.push({
      factor: 'consistency',
      input: `${agree}/${supportGroups.length} 个独立源的证据包含数值 ${needle}`,
      logodds: round(-0.8 + 1.4 * ratio),
    })
  }

  // F5 freshness: age of newest supporting evidence
  const newest = supportGroups.map((g) => g.newestPublishedAt).filter(Boolean).sort().at(-1)
  if (newest) {
    const ageDays = (Date.now() - new Date(newest as string).getTime()) / 86_400_000
    const penalty = ageDays > 365 ? -0.6 : ageDays > 180 ? -0.3 : 0
    factors.push({
      factor: 'freshness',
      input: `最新支持证据距今 ${Math.round(ageDays)} 天`,
      logodds: penalty,
    })
  } else {
    factors.push({ factor: 'freshness', input: '证据无发布时间，按未知处理', logodds: -0.2 })
  }

  // F6 originality / marketing suspicion
  const promoGroups = supportGroups.filter((g) => g.anyPromo).length
  if (supportGroups.length > 0) {
    const promoRatio = promoGroups / supportGroups.length
    factors.push({
      factor: 'originality',
      input: promoRatio > 0 ? `${promoGroups}/${supportGroups.length} 个支持源疑似营销/批量内容` : '无疑似营销信号',
      logodds: round(-1.2 * promoRatio),
    })
  }

  // F7 refutation
  if (refuteGroups.length > 0) {
    const maxRefAuthority = Math.max(...refuteGroups.map((g) => g.authority))
    factors.push({
      factor: 'refutation',
      input: `${refuteGroups.length} 个独立反驳源（最高权威 ${maxRefAuthority.toFixed(2)}）`,
      logodds: round(-1.0 * refuteGroups.length - 0.5 * maxRefAuthority),
    })
  }

  // F8 extractor self-confidence
  const exConfs = admissible.map((e) => e.extractorConfidence).filter((x): x is number => x !== null)
  if (exConfs.length) {
    const mean = exConfs.reduce((a, b) => a + b, 0) / exConfs.length
    if (mean < 0.6) {
      factors.push({ factor: 'extraction_quality', input: `抽取自评均值 ${mean.toFixed(2)} < 0.6`, logodds: -0.4 })
    }
  }

  const raw = sigmoid(factors.reduce((a, f) => a + f.logodds, 0))

  // cap rules — each one names itself for explainability
  const caps: { rule: string; cap: number }[] = []
  if (supportGroups.length === 1) caps.push({ rule: 'single_source_cap', cap: 0.7 })
  // 2026-07 起 wiki 类百科不再视作官方级来源（国内买量场景无权威百科输入面）
  if (
    claim.claimType === 'official_fact' &&
    !supportGroups.some((g) => ['official', 'store_metadata'].includes(g.items[0]!.sourceType))
  ) {
    caps.push({ rule: 'no_official_source_cap', cap: 0.75 })
  }
  if (claim.claimType === 'system_inference') {
    const minPremise = claim.premiseConfidences.length ? Math.min(...claim.premiseConfidences) : 0.5
    caps.push({ rule: 'inference_cap', cap: round(Math.min(0.85, 0.85 * minPremise) + 0.15 * 0) })
  }
  if (claim.claimType === 'creative_insight') caps.push({ rule: 'insight_cap', cap: 0.75 })

  const score = round(Math.min(raw, ...caps.map((c) => c.cap)))

  let band: Band
  if (claim.hasOpenConflict) band = 'disputed'
  else if (score >= 0.85 && supportGroups.length >= 2) band = 'verified'
  else if (score >= 0.65) band = 'likely'
  else band = 'uncertain'

  return {
    confidence: score,
    band,
    breakdown: {
      factors,
      caps,
      raw: round(raw),
      note: claim.hasOpenConflict ? '存在未解决冲突，强制标记为 disputed' : '',
      scorerVersion: SCORER_VERSION,
    },
  }
}

/** Opinion claims: confidence = representativeness (Wilson lower bound), NOT truth. */
function scoreOpinion(claim: ClaimForScoring, evidence: ScoringEvidence[]): ConfidenceResult {
  const supports = evidence.filter((e) => e.stance === 'supports')
  const sample = claim.opinionSample
  if (!sample || sample.total === 0 || supports.length === 0) {
    return insufficient('观点类结论缺少样本统计（去重后有效发言数为 0）')
  }
  const { holding, total, independentPlatforms } = sample
  const ciLow = wilsonLower(holding, total)
  const promoRatio = supports.filter((e) => e.suspectedPromo).length / supports.length
  const adjusted = clamp(ciLow * (1 - 0.5 * promoRatio), 0, 1)

  const factors: Factor[] = [
    { factor: 'prevalence', input: `${holding}/${total} 条相关发言持此观点（点赞数不参与计算）`, logodds: 0 },
    { factor: 'wilson_ci_low', input: `95% Wilson 下界 ${ciLow.toFixed(2)}`, logodds: 0 },
    { factor: 'platform_spread', input: `${independentPlatforms} 个独立平台`, logodds: 0 },
    ...(promoRatio > 0
      ? [{ factor: 'promo_discount', input: `${(promoRatio * 100).toFixed(0)}% 支持证据疑似营销，代表性打折`, logodds: 0 }]
      : []),
  ]

  let band: Band
  if (claim.hasOpenConflict) band = 'disputed'
  else if (total < 8) band = 'uncertain'
  else if (adjusted >= 0.2 && total >= 80 && independentPlatforms >= 2) band = 'verified'
  // prevalence semantics = unprompted mention rate over the sampled reviews
  // (understates true opinion share); 6+ independent unprompted mentions with a
  // ≥6% lower bound is a recurring theme by qualitative-saturation standards
  else if ((adjusted >= 0.2 && total >= 20) || (holding >= 6 && adjusted >= 0.06 && total >= 40)) band = 'likely'
  else band = 'uncertain'

  return {
    confidence: round(adjusted),
    band,
    breakdown: {
      factors,
      caps: [],
      raw: round(ciLow),
      note: '此分数表示"观点在玩家中的代表性"，不表示观点内容为事实',
      scorerVersion: SCORER_VERSION,
    },
  }
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}
