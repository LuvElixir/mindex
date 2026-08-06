import { config } from '../config.js'
import { htmlToText } from './fetcher.js'
import { collectByKey, tikhubConfigured, tikhubGet } from './tikhub.js'
import type { Connector, ConnectorContext, FetchedDoc } from './types.js'

/**
 * Weibo (微博) connector via the TikHub API. 官微公告 + 超话/搜索帖的评论是核心舆情。
 * 搜索帖 → 帖文(mblog)本身多为营销/资讯(community) → 帖子评论 = 玩家/用户声音(player_opinion)。
 * 帖文 text 含 HTML，抽取前 htmlToText 清洗。转发/点赞数仅展示不计入置信度。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Mblog {
  id?: string | number
  mid?: string | number
  text?: string
  text_raw?: string
  reposts_count?: number
  comments_count?: number
  attitudes_count?: number
  created_at?: string
  user?: { screen_name?: string }
}

interface WbComment {
  text?: string
  text_raw?: string
  like_count?: number
  id?: string | number
  user?: { screen_name?: string }
  created_at?: string
}

export const weiboConnector: Connector = {
  id: 'weibo',
  label: '微博舆情',
  get status() {
    return tikhubConfigured() ? ('verified' as const) : ('needs_key' as const)
  },
  description: '通过 TikHub API 搜索微博相关帖文与评论，抽取用户舆情与官微资讯。',
  compliance:
    '经 TikHub（付费聚合 API）访问微博公开内容；帖文与评论为 UGC，Context Pack 中默认转述不逐字引用；转发/点赞数仅展示不计入置信度。未配置 TIKHUB_API_KEY 时不激活（needs_key）。',

  async discover(ctx: ConnectorContext): Promise<FetchedDoc[]> {
    if (!tikhubConfigured()) {
      ctx.log('微博连接器未配置 TikHub API Key，已跳过（needs_key）', {})
      return []
    }
    const terms = [ctx.project.name, ...ctx.project.aliases.filter((a) => a.length >= 2)].slice(0, 2)

    const byId = new Map<string, Mblog>()
    for (const term of terms) {
      const res = await tikhubGet('/api/v1/weibo/web/fetch_search', { keyword: term, page: 1 })
      if (!res.ok) {
        ctx.log(`微博搜索「${term}」失败 (HTTP ${res.status}): ${res.error ?? ''}`, {})
        continue
      }
      // mblog 散在 data.cards[].mblog（部分卡片是话题头/分隔，无 mblog）；递归收集所有含 mblog 的卡
      const cards = collectByKey(res.json, 'mblog')
      for (const it of cards) {
        const mb = it.mblog as Mblog
        const id = mb?.id != null ? String(mb.id) : ''
        if (!id || (!mb.text && !mb.text_raw)) continue
        if (!byId.has(id)) byId.set(id, mb)
      }
      await sleep(400)
    }
    const top = [...byId.values()].sort((a, b) => (b.comments_count ?? 0) - (a.comments_count ?? 0)).slice(0, config.weiboMaxPosts)
    ctx.log(`微博搜索：命中 ${byId.size} 条帖文，取评论最多 ${top.length} 条`, {})

    const docs: FetchedDoc[] = []
    let commentCount = 0
    for (const m of top) {
      const id = String(m.id)
      const mid = m.mid != null ? String(m.mid) : id
      const url = `https://m.weibo.cn/detail/${id}`
      const author = m.user?.screen_name ?? ''
      const postText = htmlToText(m.text_raw ?? m.text ?? '').trim()
      const publishedAt = m.created_at ? isoOrNull(m.created_at) : null

      if (postText.length >= 12) {
        docs.push({
          source: {
            connector: 'weibo',
            sourceType: 'community',
            name: `微博 · ${author || '用户'}`,
            url,
            platform: 'weibo',
            ownerKey: `weibo_user:${author || id}`,
            authorityPrior: 0.42,
            licenseNote: '微博帖文（UGC/官微），Context Pack 中默认转述不逐字引用',
          },
          doc: { canonicalUrl: `weibo://post/${id}`, url, docType: 'review', title: postText.slice(0, 50), authorHandle: author || null, publishedAt },
          text: postText,
          lang: 'zh',
          raw: m,
          review: { helpfulVotes: m.attitudes_count ?? null },
          meta: { commentsCount: m.comments_count ?? 0 },
        })
      }

      const cres = await tikhubGet('/api/v1/weibo/web/fetch_post_comments', { post_id: id, mid })
      await sleep(400)
      // 评论对象带 text(HTML)；评论响应里没有 mblog，故 text 对象即评论
      const comments = collectByKey(cres.json, 'text').filter((c) => typeof c.text === 'string' && !('mblog' in c)) as unknown as WbComment[]
      for (const c of comments) {
        const msg = htmlToText(c.text_raw ?? c.text ?? '').trim()
        if (msg.length < 6) continue
        const chandle = c.user?.screen_name ?? null
        docs.push({
          source: {
            connector: 'weibo',
            sourceType: 'community',
            name: `微博评论 · ${author || '帖文'}`,
            url,
            platform: 'weibo',
            ownerKey: `weibo_user:${chandle ?? 'anonymous'}`,
            authorityPrior: 0.38,
            licenseNote: '微博用户评论（UGC），Context Pack 中默认转述不逐字引用',
          },
          doc: {
            canonicalUrl: `weibo://post/${id}/comment/${c.id ?? commentCount}`,
            url,
            docType: 'review',
            title: `评论 · ${postText.slice(0, 40)}`,
            authorHandle: chandle,
            publishedAt: c.created_at ? isoOrNull(c.created_at) : null,
          },
          text: msg,
          lang: 'zh',
          raw: { comment: c, post_id: id },
          review: { helpfulVotes: c.like_count ?? null },
        })
        commentCount++
      }
    }
    ctx.log(`微博抓取：${top.length} 条帖文 + ${commentCount} 条评论`, {})
    return docs
  },
}

/** 微博时间格式多样（"Wed Oct 08 ..." 或 ISO）；解析失败返回 null 而非乱猜 */
function isoOrNull(s: string): string | null {
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}
