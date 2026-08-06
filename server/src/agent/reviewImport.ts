/**
 * Structured review import — turns an exported batch of platform reviews (e.g. TapTap,
 * scraped by an external agent and handed over as JSON or Markdown) into individual
 * review records. Each becomes its own review-type doc so the normal opinion pipeline
 * produces player_opinion claims with per-review provenance, exactly like the App
 * Store / Bilibili / Xiaohongshu connectors.
 *
 * JSON is the reliable contract; the Markdown parser is best-effort and tuned to the
 * shapes review exports usually take (star rating, author, date, up-votes + body).
 */

export interface ImportedReview {
  content: string
  score?: number | null // 1-5 stars if known
  author?: string | null
  upVotes?: number | null
  publishedAt?: string | null // ISO or raw; normalized best-effort
  reviewId?: string | null
}

// ---- score / meta extractors ----

function parseScore(block: string): number | null {
  const stars = (block.match(/[★⭐]/g) || []).length
  if (stars >= 1 && stars <= 5) return stars
  const m =
    block.match(/评分[:：]?\s*([1-5])(?:\s*[\/／]\s*5)?/) ||
    block.match(/\b([1-5])\s*(?:星|分)\b/) ||
    block.match(/\b([1-5])\s*[\/／]\s*5\b/) ||
    block.match(/rating[:：]?\s*([1-5])/i)
  return m ? Number(m[1]) : null
}

function parseAuthor(block: string): string | null {
  const m =
    block.match(/(?:作者|用户|玩家|昵称)[:：]\s*([^\n,，\s]{1,24})/) ||
    block.match(/^\s*(?:[-*]\s*)?(?:\*\*|【)?\s*@([^\n:：|｜\s]{1,24})/m)
  return m ? m[1]!.trim() : null
}

function parseDate(block: string): string | null {
  const iso = block.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`
  const cn = block.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (cn) return `${cn[1]}-${String(cn[2]).padStart(2, '0')}-${String(cn[3]).padStart(2, '0')}T00:00:00Z`
  return null
}

function parseUpVotes(block: string): number | null {
  const m =
    block.match(/(?:赞|点赞|👍|有用)[:：]?\s*(\d+)/) || block.match(/(\d+)\s*人(?:觉得有用|点赞|赞)/) || block.match(/up[_\s]?count[:：]?\s*(\d+)/i)
  return m ? Number(m[1]) : null
}

/** Strip meta lines (rating/author/date/upvotes/headers) to leave the review body. */
function extractBody(block: string): string {
  return block
    .split('\n')
    .filter((line) => {
      const l = line.trim()
      if (!l) return false
      if (/^#{1,6}\s/.test(l)) return false // markdown headers
      if (/^[-=*_]{3,}$/.test(l)) return false // rules
      if (/^\s*(?:评分|作者|用户|玩家|昵称|日期|时间|发表于|点赞|赞|up[_\s]?count|rating|date|author)[:：]/i.test(l)) return false
      if (/^\s*[★⭐]/.test(l)) return false // rating header line (may also carry author/date)
      if (/^\s*(?:👍|赞[:：]?)\s*\d+\s*$/.test(l)) return false // standalone upvote line
      return true
    })
    .join('\n')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*/g, '')
    .trim()
}

/**
 * Best-effort Markdown → reviews. Splits on horizontal rules or repeated review
 * headers; falls back to blank-line-separated blocks. Each block that yields ≥6 chars
 * of body becomes a review. Refine the split heuristics once the real export shape is known.
 */
export function parseReviewMarkdown(md: string): ImportedReview[] {
  const text = md.replace(/\r\n?/g, '\n').trim()
  if (!text) return []

  let blocks: string[]
  if (/\n\s*[-=*_]{3,}\s*\n/.test(text)) {
    blocks = text.split(/\n\s*[-=*_]{3,}\s*\n/)
  } else if (/\n#{2,6}\s/.test(text)) {
    blocks = text.split(/\n(?=#{2,6}\s)/)
  } else if (/\n\s*\d+[.)、]\s/.test(text)) {
    blocks = text.split(/\n(?=\s*\d+[.)、]\s)/)
  } else {
    blocks = text.split(/\n{2,}/)
  }

  const reviews: ImportedReview[] = []
  for (const block of blocks) {
    const body = extractBody(block)
    if (body.length < 6) continue
    reviews.push({
      content: body,
      score: parseScore(block),
      author: parseAuthor(block),
      publishedAt: parseDate(block),
      upVotes: parseUpVotes(block),
    })
  }
  return reviews
}

/** Normalize a JSON-provided review batch, tolerating common field aliases. */
export function normalizeReviews(raw: unknown[]): ImportedReview[] {
  const out: ImportedReview[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const content = String(o.content ?? o.text ?? o.review ?? o.body ?? '').trim()
    if (content.length < 6) continue
    const scoreRaw = o.score ?? o.rating ?? o.star ?? o.stars
    const upRaw = o.upVotes ?? o.up_count ?? o.likes ?? o.like_count ?? o.up
    out.push({
      content,
      score: scoreRaw !== undefined && scoreRaw !== null ? Number(scoreRaw) : null,
      author: o.author != null ? String(o.author) : o.user != null ? String(o.user) : o.nickname != null ? String(o.nickname) : null,
      upVotes: upRaw !== undefined && upRaw !== null ? Number(upRaw) : null,
      publishedAt: o.publishedAt != null ? String(o.publishedAt) : o.published_at != null ? String(o.published_at) : o.date != null ? String(o.date) : null,
      reviewId: o.reviewId != null ? String(o.reviewId) : o.review_id != null ? String(o.review_id) : o.id != null ? String(o.id) : null,
    })
  }
  return out
}
