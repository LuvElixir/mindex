import { hammingDistance, jaccardSimilarity, simhash64 } from '../lib/text.js'

/**
 * Near-duplicate / syndication clustering.
 * - Long texts: 64-bit simhash, hamming <= 3 ⇒ same cluster.
 * - Short texts (reviews): simhash is unreliable ⇒ jaccard over CJK-bigram/latin shingles >= threshold.
 * Same cluster = ONE independent source when counting cross-validation.
 */

export interface DupInput {
  id: string
  text: string
}

export interface DupResult {
  /** id -> cluster id (cluster id = id of first member) */
  clusterOf: Map<string, string>
  clusters: Map<string, string[]>
}

/** below this length simhash is unreliable (few shingles) — use jaccard instead */
const SHORT_TEXT = 400
const HAMMING_MAX = 3
const JACCARD_MIN = 0.82

export function clusterDuplicates(items: DupInput[]): DupResult {
  const clusterOf = new Map<string, string>()
  const clusters = new Map<string, string[]>()
  const reps: { id: string; text: string; hash: string; cluster: string }[] = []

  for (const item of items) {
    const hash = simhash64(item.text)
    const short = item.text.length < SHORT_TEXT
    let assigned: string | null = null
    for (const rep of reps) {
      const isDup = short || rep.text.length < SHORT_TEXT
        ? jaccardSimilarity(item.text, rep.text) >= JACCARD_MIN
        : hammingDistance(hash, rep.hash) <= HAMMING_MAX
      if (isDup) {
        assigned = rep.cluster
        break
      }
    }
    const cluster = assigned ?? item.id
    clusterOf.set(item.id, cluster)
    clusters.set(cluster, [...(clusters.get(cluster) || []), item.id])
    if (!assigned) reps.push({ id: item.id, text: item.text, hash, cluster })
  }
  return { clusterOf, clusters }
}

/** Claim-level semantic dedupe candidate check (before optional LLM confirm). */
export function isNearDuplicateClaim(a: string, b: string): boolean {
  return jaccardSimilarity(a, b) >= 0.7
}

/**
 * Astroturfing heuristics on a batch of review-like texts (public signals only):
 * time bursts + near-duplicate ratio. Returns per-id suspicion flags plus batch score.
 * Deliberately conservative; flags feed review queue, never silent deletion.
 */
export interface PromoScanItem {
  id: string
  text: string
  publishedAt: string | null
  authorHandle: string | null
}

export interface PromoScanResult {
  batchScore: number
  suspects: Set<string>
  notes: string[]
}

export function scanAstroturf(items: PromoScanItem[]): PromoScanResult {
  const notes: string[] = []
  const suspects = new Set<string>()
  if (items.length < 5) return { batchScore: 0, suspects, notes: ['样本过小，不做批量失真判定'] }

  // near-duplicate ratio inside the batch
  const { clusters } = clusterDuplicates(items.map((i) => ({ id: i.id, text: i.text })))
  let dupCount = 0
  for (const members of clusters.values()) {
    if (members.length > 1) {
      dupCount += members.length
      for (const id of members) suspects.add(id)
    }
  }
  const dupRatio = dupCount / items.length
  if (dupRatio > 0.15) notes.push(`批内近重复文本占比 ${(dupRatio * 100).toFixed(0)}%`)

  // time burst: > 40% of dated items within one 24h window
  const dated = items.filter((i) => i.publishedAt).map((i) => ({ id: i.id, t: new Date(i.publishedAt!).getTime() }))
  let burstRatio = 0
  if (dated.length >= 5) {
    const sorted = [...dated].sort((a, b) => a.t - b.t)
    for (let i = 0; i < sorted.length; i++) {
      let j = i
      while (j < sorted.length && sorted[j]!.t - sorted[i]!.t <= 86_400_000) j++
      burstRatio = Math.max(burstRatio, (j - i) / dated.length)
    }
    if (burstRatio > 0.4) notes.push(`${(burstRatio * 100).toFixed(0)}% 的内容集中在 24 小时窗口内发布`)
  }

  const batchScore = Math.min(1, (dupRatio > 0.15 ? dupRatio : 0) * 2 + (burstRatio > 0.4 ? burstRatio - 0.4 : 0))
  return { batchScore: Math.round(batchScore * 100) / 100, suspects, notes }
}
