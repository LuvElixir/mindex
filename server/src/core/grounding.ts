import { matchNormalize } from '../lib/text.js'

/**
 * Citation integrity (eval L1): every evidence quote MUST be re-findable inside its
 * snapshot text. This is enforced at write time — an extractor (LLM or heuristic)
 * cannot insert a quote that does not exist in the fetched content. Fabricated
 * citations are structurally impossible, not just discouraged.
 */

export interface GroundingResult {
  ok: boolean
  method: 'exact' | 'normalized' | 'none'
  start: number | null
  end: number | null
}

export function groundQuote(snapshotText: string, quote: string): GroundingResult {
  const q = quote.trim()
  if (!q) return { ok: false, method: 'none', start: null, end: null }

  const exact = snapshotText.indexOf(q)
  if (exact >= 0) return { ok: true, method: 'exact', start: exact, end: exact + q.length }

  // whitespace/punctuation-tolerant match: build a normalized index map
  const normQuote = matchNormalize(q)
  if (normQuote.length < 4) return { ok: false, method: 'none', start: null, end: null }

  const { normText, map } = buildNormalizedIndex(snapshotText)
  const idx = normText.indexOf(normQuote)
  if (idx >= 0) {
    const start = map[idx] ?? null
    const endIdx = idx + normQuote.length - 1
    const end = map[endIdx] !== undefined ? map[endIdx]! + 1 : null
    return { ok: true, method: 'normalized', start, end }
  }
  return { ok: false, method: 'none', start: null, end: null }
}

function buildNormalizedIndex(text: string): { normText: string; map: number[] } {
  const parts: string[] = []
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const norm = matchNormalize(ch)
    for (let k = 0; k < norm.length; k++) {
      parts.push(norm[k]!)
      map.push(i)
    }
  }
  return { normText: parts.join(''), map }
}

export function contextAround(text: string, start: number, end: number, radius = 160): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, start - radius), start),
    after: text.slice(end, end + radius),
  }
}
