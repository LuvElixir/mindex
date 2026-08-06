import { z } from 'zod'
import type { LlmProvider } from '../llm/provider.js'
import { groundQuote } from '../core/grounding.js'
import { EXTRACT_SYSTEM, REVIEW_THEMES_SYSTEM, COMPETITOR_THEMES_SYSTEM, extractPrompt, reviewThemesPrompt, competitorThemesPrompt } from './prompts.js'

/**
 * Two extraction paths, both grounded:
 *  - LLM extraction (anthropic / claude-cli): quotes are verified verbatim against the
 *    document; claims whose quotes fail verification are DROPPED and counted, never kept.
 *  - Heuristic extraction: parses the structured metadata lines our own connectors emit
 *    (reliable because we authored the format) and tags review aspects by keyword.
 */

export interface ExtractedClaim {
  text: string
  claimType: 'official_fact' | 'system_inference'
  topic: string
  predicate: string | null
  value: { value: number | string; unit?: string } | null
  quotes: string[]
  entities: { name: string; type: string }[]
  confidenceSelf: number
}

const llmClaimSchema = z.object({
  text: z.string().min(6),
  claim_type: z.enum(['official_fact', 'system_inference']).catch('official_fact'),
  topic: z.string().default('other'),
  predicate: z.string().nullish(),
  value: z.object({ value: z.union([z.number(), z.string()]), unit: z.string().optional() }).nullish(),
  quotes: z.array(z.string().min(4)).min(1),
  entities: z.array(z.object({ name: z.string(), type: z.string() })).default([]),
  confidence_self: z.number().min(0).max(1).default(0.7),
})
const llmExtractSchema = z.object({ claims: z.array(llmClaimSchema).default([]) })

export interface LlmExtractResult {
  claims: ExtractedClaim[]
  droppedUngrounded: number
}

export async function llmExtract(
  provider: LlmProvider,
  project: { name: string; aliases: string[] },
  source: { name: string; sourceType: string },
  doc: { title: string },
  text: string,
): Promise<LlmExtractResult> {
  const clipped = text.slice(0, 12_000)
  const raw = await provider.completeJson({
    system: EXTRACT_SYSTEM,
    prompt: extractPrompt(project, source, doc, clipped),
    maxTokens: 4096,
  })
  const parsed = llmExtractSchema.safeParse(raw)
  if (!parsed.success) return { claims: [], droppedUngrounded: 0 }

  const claims: ExtractedClaim[] = []
  let dropped = 0
  for (const c of parsed.data.claims) {
    const groundedQuotes = c.quotes.filter((q) => groundQuote(text, q).ok)
    if (groundedQuotes.length === 0) {
      dropped++
      continue
    }
    claims.push({
      text: c.text.trim(),
      claimType: c.claim_type,
      topic: normalizeTopic(c.topic),
      predicate: c.predicate ?? null,
      value: c.value ?? null,
      quotes: groundedQuotes.slice(0, 3),
      entities: c.entities.slice(0, 6),
      confidenceSelf: c.confidence_self,
    })
  }
  return { claims, droppedUngrounded: dropped }
}

const TOPICS = ['product', 'gameplay', 'monetization', 'audience', 'market', 'brand', 'creative', 'performance', 'other']
function normalizeTopic(t: string): string {
  return TOPICS.includes(t) ? t : 'other'
}

/**
 * Heuristic extraction from connector-authored metadata text (lines like "开发商/发行商: X").
 * Only applied to api_record docs whose format we control — every value line becomes an
 * official_fact claim quoting that exact line.
 */
const METADATA_PATTERNS: { re: RegExp; predicate: string; topic: string; template: (name: string, v: string) => string }[] = [
  { re: /^(?:开发商\/发行商|开发商): *(.+)$/m, predicate: 'developer', topic: 'product', template: (n, v) => `《${n}》的开发商/发行商是 ${v}` },
  { re: /^发行商: *(.+)$/m, predicate: 'publisher', topic: 'product', template: (n, v) => `《${n}》的发行商是 ${v}` },
  { re: /^(?:主分类|类型): *(.+)$/m, predicate: 'genre', topic: 'product', template: (n, v) => `《${n}》的品类为 ${v}` },
  { re: /^当前版本: *(.+)$/m, predicate: 'current_version', topic: 'product', template: (n, v) => `《${n}》当前版本为 ${v}` },
  { re: /^(?:发行日期|首次上架时间): *(.+)$/m, predicate: 'release_date', topic: 'product', template: (n, v) => `《${n}》的发行/上架日期为 ${v}` },
  { re: /^价格: *(.+)$/m, predicate: 'price', topic: 'monetization', template: (n, v) => `《${n}》的价格为 ${v}` },
  { re: /^年龄分级: *(.+)$/m, predicate: 'age_rating', topic: 'product', template: (n, v) => `《${n}》的年龄分级为 ${v}` },
  { re: /^支持语言: *(.+)$/m, predicate: 'languages', topic: 'product', template: (n, v) => `《${n}》支持语言：${v}` },
  { re: /^App Store\((\w+)\) 平均评分: *(.+)$/m, predicate: 'appstore_rating', topic: 'performance', template: () => '' },
  { re: /^TapTap评分: *([\d.]+\/\d+（\d+个评分）)$/m, predicate: 'taptap_rating', topic: 'performance', template: (n, v) => `《${n}》TapTap 聚合评分为 ${v}` },
]

export function heuristicMetadataExtract(projectName: string, text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = []
  for (const p of METADATA_PATTERNS) {
    const m = text.match(p.re)
    if (!m) continue
    const line = m[0].trim()
    const value = (m[2] ?? m[1] ?? '').trim()
    if (!value) continue
    let claimText: string
    if (p.predicate === 'appstore_rating') {
      claimText = `《${projectName}》App Store(${m[1]}) 平均评分为 ${m[2]!.trim()}`
    } else {
      claimText = p.template(projectName, value)
    }
    if (!claimText) continue
    const numMatch = value.match(/^([\d.]+)/)
    // 元数据也产实体：开发商→company、品类→term——图谱的基础节点不该只依赖 LLM 叙述抽取
    const entities: { name: string; type: string }[] = []
    if (['developer', 'publisher'].includes(p.predicate)) entities.push({ name: value, type: 'company' })
    if (p.predicate === 'genre') {
      for (const g of value.split(/[、,，/]/).map((s) => s.trim()).filter(Boolean).slice(0, 4)) {
        entities.push({ name: g, type: 'term' })
      }
    }
    claims.push({
      text: claimText,
      claimType: 'official_fact',
      topic: p.topic,
      predicate: p.predicate,
      value: numMatch && ['price', 'appstore_rating'].includes(p.predicate)
        ? { value: Number(numMatch[1]) }
        : { value },
      quotes: [line],
      entities,
      confidenceSelf: 0.95,
    })
  }
  return claims
}

// ---------- review aspect analysis ----------

export interface ReviewDocLite {
  snapshotId: string
  sourceId: string
  documentId: string
  text: string
  rating: number | null
  publishedAt: string | null
  authorHandle: string | null
}

export interface AspectBucket {
  aspect: string
  sentiment: 'positive' | 'negative'
  text: (projectName: string) => string
  keywords: RegExp
  negative?: boolean
}

/** Aspect lexicon for zh game/app reviews (heuristic path). */
const ASPECTS: { aspect: string; topic: string; pos: RegExp | null; neg: RegExp | null; posText: string; negText: string }[] = [
  {
    aspect: 'monetization', topic: 'monetization',
    pos: /(不氪|良心|白嫖|福利(很)?(好|多)|不逼氪|零氪也)/,
    neg: /(太氪|氪金|逼氪|抽卡.{0,6}(贵|坑)|保底.{0,6}(贵|坑)|价格.{0,4}(高|贵)|割韭菜|付费墙|太贵)/,
    posText: '玩家认为付费设计友好/福利较好', negText: '玩家认为氪金压力大或付费设计激进',
  },
  {
    aspect: 'grind', topic: 'gameplay',
    pos: null,
    neg: /(太肝|很肝|肝度|重复度(高|太高)|日常.{0,4}(繁琐|太多)|体力(不够|恢复慢))/,
    posText: '', negText: '玩家认为游戏肝度高/日常负担重',
  },
  {
    aspect: 'performance', topic: 'performance',
    pos: /(优化(很|挺)?(好|不错)|流畅|不卡)/,
    neg: /(优化(差|烂|不行)|卡顿|掉帧|发烫|闪退|崩溃|加载(慢|久)|服务器.{0,4}(炸|卡|崩))/,
    posText: '玩家认为运行流畅、优化良好', negText: '玩家反馈存在优化/性能问题（卡顿、发热、闪退等）',
  },
  {
    aspect: 'art', topic: 'creative',
    pos: /(画面(很|超|真)?(美|好|棒|精致)|美术|画风.{0,4}(好|喜欢|棒)|立绘.{0,4}(好|美|棒)|建模.{0,4}(好|精)|场景(很|超)?美)/,
    neg: /(画面(差|糊|拉胯)|画风.{0,4}(丑|不喜欢)|立绘.{0,4}(差|丑))/,
    posText: '玩家称赞美术/画面表现', negText: '玩家对美术/画面不满',
  },
  {
    aspect: 'story', topic: 'creative',
    pos: /(剧情(很|超|真)?(好|棒|感人|精彩|上头)|故事.{0,4}(好|动人)|文案.{0,4}(好|棒))/,
    neg: /(剧情(差|烂|拖沓|无聊)|文案.{0,4}(差|烂)|故事.{0,4}(无聊|老套))/,
    posText: '玩家称赞剧情/文案质量', negText: '玩家认为剧情/文案薄弱',
  },
  {
    aspect: 'music', topic: 'creative',
    pos: /(音乐(很|超)?(好|棒|好听)|配乐.{0,4}(好|棒|神)|bgm.{0,4}(好|棒|神))/i,
    neg: null,
    posText: '玩家称赞音乐/配乐', negText: '',
  },
  {
    aspect: 'gameplay', topic: 'gameplay',
    pos: /(玩法.{0,4}(好|有趣|丰富|新颖)|好玩|上头|内容(丰富|很多)|可玩性(高|强))/,
    neg: /(玩法.{0,4}(单一|无聊|重复)|内容(少|匮乏|太少)|无聊|玩不下去)/,
    posText: '玩家认为玩法有趣、内容丰富', negText: '玩家认为玩法单调或内容不足',
  },
]

export interface OpinionAggregate {
  aspect: string
  topic: string
  sentiment: 'positive' | 'negative'
  text: string
  holding: { review: ReviewDocLite; matchedQuote: string }[]
  totalScanned: number
}

/**
 * Keyword-based aspect aggregation. Prevalence semantics = UNPROMPTED MENTION RATE
 * over the whole scanned sample (consistent with the LLM theme path; recorded in
 * sampling_note). Mention rates understate true opinion prevalence — thresholds in
 * the confidence engine are calibrated for this scale.
 */
export function aggregateReviewAspects(projectName: string, reviews: ReviewDocLite[]): OpinionAggregate[] {
  const out: OpinionAggregate[] = []
  for (const a of ASPECTS) {
    const posHits: { review: ReviewDocLite; matchedQuote: string }[] = []
    const negHits: { review: ReviewDocLite; matchedQuote: string }[] = []
    for (const r of reviews) {
      if (a.pos) {
        const m = r.text.match(a.pos)
        if (m) posHits.push({ review: r, matchedQuote: sentenceAround(r.text, m.index ?? 0) })
      }
      if (a.neg) {
        const m = r.text.match(a.neg)
        if (m) negHits.push({ review: r, matchedQuote: sentenceAround(r.text, m.index ?? 0) })
      }
    }
    for (const [sentiment, hits, text] of [
      ['positive', posHits, a.posText],
      ['negative', negHits, a.negText],
    ] as const) {
      if (hits.length >= 3 && text) {
        out.push({
          aspect: a.aspect,
          topic: a.topic,
          sentiment,
          text: `${text}（《${projectName}》）`,
          holding: hits,
          totalScanned: reviews.length,
        })
      }
    }
  }
  return out.sort((x, y) => y.holding.length - x.holding.length)
}

/** Extract the sentence containing the matched position (used as the evidence quote). */
function sentenceAround(text: string, index: number): string {
  const boundary = /[。！？!?\n.;；]/
  let start = index
  while (start > 0 && !boundary.test(text[start - 1]!)) start--
  let end = index
  while (end < text.length && !boundary.test(text[end]!)) end++
  return text.slice(start, Math.min(end + 1, start + 200)).trim()
}

// ---------- creative reference (baobaomi ad materials) → creative_insight ----------

/**
 * Turn an analyzed ad creative into a decontextualized creative_insight claim.
 * The claim is an OBSERVATION about a reusable ad angle; its evidence is a verbatim
 * quote from the breakdown/narration (grounded), citing the original Douyin video.
 * This is deliberately NOT player_opinion — the material is marketer copy, not player voice.
 */
export function creativeInsightFromRef(
  projectName: string,
  docText: string,
  attrs: { hookType?: string; emotionArc?: string; pacing?: string; ctaType?: string; visualStyle?: string },
): { text: string; quote: string } | null {
  // pick a verbatim quote: prefer the hook line `> "..."`, else first substantial sentence
  let quote = ''
  const hookLine = docText.match(/>\s*[“"]([^”"\n]{8,120})[”"]/)
  if (hookLine) {
    quote = hookLine[1]!.trim()
  } else {
    const analysisPart = docText.split('=== 创意拆解 ===')[1] ?? docText
    for (const raw of analysisPart.split(/[。！？!?\n]/)) {
      const s = raw.replace(/[#>*`]/g, '').trim()
      if (s.length >= 12 && s.length <= 140 && !s.startsWith('钩子类型') && !s.includes('===')) {
        quote = s
        break
      }
    }
  }
  if (!quote) return null

  const parts = [
    attrs.hookType ? `「${attrs.hookType}」钩子` : '',
    attrs.emotionArc ? `「${attrs.emotionArc}」情绪曲线` : '',
    attrs.visualStyle ? `${attrs.visualStyle}风格` : '',
  ].filter(Boolean)
  const angle = parts.length ? parts.join(' + ') : '该素材的创意手法'
  return {
    text: `《${projectName}》可复用的买量创意角度：${angle}（源自高表现抖音素材，供创意 Agent 参考）`,
    quote,
  }
}

// ---------- LLM review themes ----------

const themeSchema = z.object({
  themes: z
    .array(
      z.object({
        text: z.string().min(6),
        aspect: z.string().default('other'),
        sentiment: z.enum(['positive', 'negative', 'mixed']).catch('mixed'),
        review_ids: z.array(z.number()).default([]),
        quote_examples: z.array(z.object({ review_id: z.number(), quote: z.string().min(4) })).default([]),
      }),
    )
    .default([]),
})

export interface LlmTheme {
  text: string
  aspect: string
  sentiment: 'positive' | 'negative' | 'mixed'
  matches: { review: ReviewDocLite; quote: string }[]
  sampleSize: number
}

export async function llmReviewThemes(
  provider: LlmProvider,
  projectName: string,
  reviews: ReviewDocLite[],
  sampleSize = 60,
  /** 若提供,按竞品口碑归纳(用竞品 prompt,语境是该竞品的评论) */
  competitorName?: string,
): Promise<{ themes: LlmTheme[]; droppedUngrounded: number }> {
  // sample: mix of recent + longest reviews for signal density
  const byLength = [...reviews].sort((a, b) => b.text.length - a.text.length).slice(0, Math.floor(sampleSize / 2))
  const byRecent = [...reviews]
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    .slice(0, sampleSize)
  const sample = [...new Set([...byLength, ...byRecent])].slice(0, sampleSize)
  // 竞品评论门槛降低(搜词已预筛,数量天然少):本项目要≥8条,竞品≥4条
  const minSample = competitorName ? 4 : 8
  if (sample.length < minSample) return { themes: [], droppedUngrounded: 0 }

  const indexed = sample.map((r, i) => ({ idx: i + 1, rating: r.rating, text: r.text }))
  const raw = await provider.completeJson({
    system: competitorName ? COMPETITOR_THEMES_SYSTEM : REVIEW_THEMES_SYSTEM,
    prompt: competitorName ? competitorThemesPrompt(competitorName, indexed) : reviewThemesPrompt(projectName, indexed),
    maxTokens: 4096,
  })
  const parsed = themeSchema.safeParse(raw)
  if (!parsed.success) return { themes: [], droppedUngrounded: 0 }

  const themes: LlmTheme[] = []
  let dropped = 0
  for (const t of parsed.data.themes) {
    const matches: { review: ReviewDocLite; quote: string }[] = []
    for (const ex of t.quote_examples) {
      const review = sample[ex.review_id - 1]
      if (!review) continue
      if (groundQuote(review.text, ex.quote).ok) {
        matches.push({ review, quote: ex.quote })
      } else {
        dropped++
      }
    }
    // review_ids without explicit quotes: use their full text as evidence (still grounded — it IS the doc)
    for (const id of t.review_ids) {
      const review = sample[id - 1]
      if (review && !matches.some((m) => m.review === review)) {
        matches.push({ review, quote: review.text.slice(0, 200) })
      }
    }
    if (matches.length >= 2) {
      themes.push({ text: t.text, aspect: t.aspect, sentiment: t.sentiment, matches, sampleSize: sample.length })
    }
  }
  return { themes, droppedUngrounded: dropped }
}
