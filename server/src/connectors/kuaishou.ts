import { config } from '../config.js'
import { collectByKey, tikhubConfigured, tikhubGet } from './tikhub.js'
import type { Connector, ConnectorContext, FetchedDoc } from './types.js'

/**
 * Kuaishou (快手) connector via the TikHub API — the second short-video UA channel,
 * strong in下沉市场. Same shape as Douyin: search videos → top videos' comments →
 * player_opinion, video caption → community. Engagement counts display-only.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface KsPhoto {
  photo_id?: string | number
  caption?: string
  comment_count?: number
  like_count?: number
  timestamp?: number
  user_name?: string
}

interface KsComment {
  content?: string
  likedCount?: number | string
  comment_id?: string | number
  author_name?: string
  timestamp?: number
}

export const kuaishouConnector: Connector = {
  id: 'kuaishou',
  label: '快手口碑',
  get status() {
    return tikhubConfigured() ? ('verified' as const) : ('needs_key' as const)
  },
  description: '通过 TikHub API 搜索快手相关视频与评论，抽取玩家口碑（下沉市场买量渠道）。',
  compliance:
    '经 TikHub（付费聚合 API）访问快手公开内容；视频文案与评论为 UGC，Context Pack 中默认转述不逐字引用；点赞/评论数仅展示不计入置信度。未配置 TIKHUB_API_KEY 时不激活（needs_key）。',

  async discover(ctx: ConnectorContext): Promise<FetchedDoc[]> {
    if (!tikhubConfigured()) {
      ctx.log('快手连接器未配置 TikHub API Key，已跳过（needs_key）', {})
      return []
    }
    const terms = [ctx.project.name, ...ctx.project.aliases.filter((a) => a.length >= 2)].slice(0, 2)

    const byId = new Map<string, KsPhoto>()
    for (const term of terms) {
      // bigIntSafe：快手 photo_id 是 19 位裸整数，保精度否则后续查评论 400
      const res = await tikhubGet('/api/v1/kuaishou/app/search_video_v2', { keyword: term }, 30_000, true)
      if (!res.ok) {
        ctx.log(`快手搜索「${term}」失败 (HTTP ${res.status}): ${res.error ?? ''}`, {})
        continue
      }
      // 搜索结果结构：data.mixFeeds[].feed.{photo_id,caption,comment_count}
      const items = collectByKey(res.json, 'photo_id')
      for (const ph of items as unknown as KsPhoto[]) {
        const pid = ph.photo_id != null ? String(ph.photo_id) : ''
        if (!pid || !ph.caption) continue
        if (!byId.has(pid)) byId.set(pid, ph)
      }
      await sleep(400)
    }
    const top = [...byId.values()].sort((a, b) => (b.comment_count ?? 0) - (a.comment_count ?? 0)).slice(0, config.kuaishouMaxVideos)
    ctx.log(`快手搜索：命中 ${byId.size} 条视频，取评论最多 ${top.length} 条`, {})

    const docs: FetchedDoc[] = []
    let commentCount = 0
    for (const v of top) {
      const pid = String(v.photo_id)
      const url = `https://www.kuaishou.com/short-video/${pid}`
      const author = v.user_name ?? ''
      const caption = (v.caption ?? '').trim()
      const publishedAt = v.timestamp ? new Date(v.timestamp).toISOString() : null

      if (caption.length >= 10) {
        docs.push({
          source: {
            connector: 'kuaishou',
            sourceType: 'community',
            name: `快手视频 · ${author || '创作者'}`,
            url,
            platform: 'kuaishou',
            ownerKey: `kuaishou_user:${author || pid}`,
            authorityPrior: 0.4,
            licenseNote: '快手视频文案（UGC），Context Pack 中默认转述不逐字引用',
          },
          doc: { canonicalUrl: `kuaishou://photo/${pid}`, url, docType: 'review', title: caption.slice(0, 50), authorHandle: author || null, publishedAt },
          text: caption,
          lang: 'zh',
          raw: v,
          review: { helpfulVotes: v.like_count ?? null },
          meta: { commentCount: v.comment_count ?? 0 },
        })
      }

      const cres = await tikhubGet('/api/v1/kuaishou/app/fetch_video_comment', { photo_id: pid }, 30_000, true)
      await sleep(400)
      if (!cres.ok) ctx.log(`快手评论抓取跳过 (HTTP ${cres.status}) photo_id=${pid}`, {}) // 部分视频禁评/非常规feed 会 400，容错继续
      // 评论散在 data.rootComments 与 subCommentsMap.*.subComments；按 comment_id 递归收集
      const comments = collectByKey(cres.json, 'comment_id') as unknown as KsComment[]
      for (const c of comments) {
        const msg = (c.content ?? '').trim()
        if (msg.length < 6) continue
        const chandle = c.author_name ?? null
        docs.push({
          source: {
            connector: 'kuaishou',
            sourceType: 'community',
            name: `快手评论 · ${author || '视频'}`,
            url,
            platform: 'kuaishou',
            ownerKey: `kuaishou_user:${chandle ?? 'anonymous'}`,
            authorityPrior: 0.38,
            licenseNote: '快手用户评论（UGC），Context Pack 中默认转述不逐字引用',
          },
          doc: {
            canonicalUrl: `kuaishou://photo/${pid}/comment/${c.comment_id ?? commentCount}`,
            url,
            docType: 'review',
            title: `评论 · ${caption.slice(0, 40)}`,
            authorHandle: chandle,
            publishedAt: c.timestamp ? new Date(c.timestamp).toISOString() : null,
          },
          text: msg,
          lang: 'zh',
          raw: { comment: c, photo_id: pid },
          review: { helpfulVotes: Number(c.likedCount) || null },
        })
        commentCount++
      }
    }
    ctx.log(`快手抓取：${top.length} 条视频 + ${commentCount} 条评论`, {})
    return docs
  },
}
