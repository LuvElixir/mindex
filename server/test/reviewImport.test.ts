import { describe, expect, it } from 'vitest'
import { normalizeReviews, parseReviewMarkdown } from '../src/agent/reviewImport.js'

describe('structured review import — JSON contract', () => {
  it('normalizes reviews with common field aliases', () => {
    const out = normalizeReviews([
      { content: '这游戏优化太差了，一直闪退', rating: 2, user: '张三', up_count: 45, date: '2026-06-01' },
      { text: '画面很棒，剧情也不错', score: 5, author: '李四', likes: 12, review_id: 'r99' },
      { content: '太' }, // too short → dropped
    ])
    expect(out.length).toBe(2)
    expect(out[0]).toMatchObject({ score: 2, author: '张三', upVotes: 45 })
    expect(out[0]!.publishedAt).toContain('2026-06-01')
    expect(out[1]).toMatchObject({ score: 5, author: '李四', upVotes: 12, reviewId: 'r99' })
  })
})

describe('structured review import — Markdown best-effort parser', () => {
  it('splits reviews on horizontal rules and extracts rating/author/date/upvotes', () => {
    const md = `# TapTap 评价导出

★★☆☆☆ 作者：玩家A 2026-06-10
优化太差，手机发烫严重，进游戏经常闪退，希望官方修复。
👍 128

---

★★★★★ 作者：玩家B 2026-06-12
画面精美，玩法有深度，剧情也很吸引人，强烈推荐！
赞：34`
    const reviews = parseReviewMarkdown(md)
    expect(reviews.length).toBe(2)
    expect(reviews[0]).toMatchObject({ score: 2, author: '玩家A', upVotes: 128 })
    expect(reviews[0]!.content).toContain('优化太差')
    expect(reviews[0]!.content).not.toContain('作者')
    expect(reviews[1]).toMatchObject({ score: 5, author: '玩家B', upVotes: 34 })
  })

  it('handles numbered-list style exports', () => {
    const md = `1. 评分：4  很好玩，但后期有点肝。
2. 评分：1  差评，服务器天天崩。`
    const reviews = parseReviewMarkdown(md)
    expect(reviews.length).toBe(2)
    expect(reviews[0]!.score).toBe(4)
    expect(reviews[1]!.score).toBe(1)
    expect(reviews[1]!.content).toContain('服务器')
  })

  it('falls back to blank-line blocks and drops empties', () => {
    const md = `这游戏画风我很喜欢，值得一玩。\n\n客服态度差，退款困难。\n\n\n`
    const reviews = parseReviewMarkdown(md)
    expect(reviews.length).toBe(2)
  })
})
