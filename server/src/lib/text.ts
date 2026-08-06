/** Text normalization + tokenization + simhash. No native deps. */

/** Normalize text for hashing/grounding: unify whitespace, strip zero-width chars. */
export function normalizeText(text: string): string {
  return text
    .replace(/[​-‏﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Loose normalization used when matching quotes against snapshots (ignores all whitespace + common punct width). */
export function matchNormalize(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[，,]/g, ',')
    .replace(/[。.]/g, '.')
    .replace(/[！!]/g, '!')
    .replace(/[？?]/g, '?')
    .replace(/[：:]/g, ':')
    .replace(/[；;]/g, ';')
    .replace(/["“”'‘’]/g, '')
    .toLowerCase()
}

/** Tokens for simhash: CJK bigrams + latin words. Language-agnostic, no dictionary. */
export function shingleTokens(text: string): string[] {
  const norm = matchNormalize(text)
  const tokens: string[] = []
  const latin = norm.match(/[a-z0-9]+/g)
  if (latin) tokens.push(...latin)
  const cjk = norm.replace(/[^一-鿿㐀-䶿]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2))
  if (cjk.length === 1) tokens.push(cjk)
  return tokens
}

function fnv1a64(str: string): bigint {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h
}

/** 64-bit simhash over shingle tokens. Returns 16-char hex. */
export function simhash64(text: string): string {
  const tokens = shingleTokens(text)
  if (tokens.length === 0) return '0'.repeat(16)
  const counts: Record<string, number> = {}
  for (const t of tokens) counts[t] = (counts[t] || 0) + 1
  const v = new Array<number>(64).fill(0)
  for (const [token, weight] of Object.entries(counts)) {
    const h = fnv1a64(token)
    for (let bit = 0; bit < 64; bit++) {
      if ((h >> BigInt(bit)) & 1n) v[bit]! += weight
      else v[bit]! -= weight
    }
  }
  let out = 0n
  for (let bit = 0; bit < 64; bit++) if (v[bit]! > 0) out |= 1n << BigInt(bit)
  return out.toString(16).padStart(16, '0')
}

export function hammingDistance(hexA: string, hexB: string): number {
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB)
  let count = 0
  while (x) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

/** Jaccard similarity over shingle tokens — robust for short texts where simhash is weak. */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = new Set(shingleTokens(a))
  const sb = new Set(shingleTokens(b))
  if (sa.size === 0 && sb.size === 0) return 1
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

/** Rough token estimate for budget control: CJK ≈ 1 token/char, latin ≈ 1 token/4 chars. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}
