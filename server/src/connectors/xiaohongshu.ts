import { config } from '../config.js'
import { findArray, tikhubConfigured, tikhubGet } from './tikhub.js'
import type { Connector, ConnectorContext, FetchedDoc } from './types.js'

/**
 * Xiaohongshu (小红书) connector via the TikHub API.
 *
 * Closes the XHS gap with a proper API (vs login-state browser automation). For a game,
 * XHS notes are player/creator posts; the real player VOICE is in the note comments.
 * Mapping: search notes → for each top note pull comments → ingest note desc + comments
 * as review-type docs → existing opinion aggregation → player_opinion, each cited back
 * to the specific XHS note. Like/collect counts are recorded for display but NEVER fed
 * into confidence (engagement ≠ truth). Notes from the official brand account are still
 * UGC-shaped but promotional; they self-filter (marketing text rarely matches player
 * complaint/opinion aspects), same as the Bilibili path.
 */

interface XhsNote {
  id?: string
  title?: string
  desc?: string
  type?: string
  liked_count?: number | string
  comments_count?: number | string
  collected_count?: number | string
  user?: { nickname?: string; name?: string }
  xsec_token?: string
  timestamp?: number
}

interface XhsComment {
  id?: string
  content?: string
  like_count?: number | string
  user?: { nickname?: string; name?: string }
  ip_location?: string
  time?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function noteUrl(id: string, token?: string): string {
  return `https://www.xiaohongshu.com/explore/${id}${token ? `?xsec_token=${token}` : ''}`
}

export const xiaohongshuConnector: Connector = {
  id: 'xiaohongshu',
  label: '小红书口碑',
  get status() {
    return tikhubConfigured() ? ('verified' as const) : ('needs_key' as const)
  },
  description: '通过 TikHub API 检索小红书相关笔记与评论，抽取用户口碑作为玩家反馈。',
  compliance:
    '经 TikHub（付费聚合 API）访问小红书公开内容；笔记/评论为 UGC，Context Pack 中默认转述不逐字引用；点赞收藏数仅展示不计入置信度。未配置 TIKHUB_API_KEY 时不激活（needs_key）。',

  async discover(ctx: ConnectorContext): Promise<FetchedDoc[]> {
    if (!tikhubConfigured()) {
      ctx.log('小红书连接器未配置 TikHub API Key（设置页或 TIKHUB_API_KEY），已跳过（needs_key）', {})
      return []
    }
    const terms = [ctx.project.name, ...ctx.project.aliases.filter((a) => a.length >= 2)].slice(0, 2)

    // 1) search notes across terms, dedup by id, rank by likes
    const byId = new Map<string, XhsNote>()
    for (const term of terms) {
      const res = await tikhubGet(`/api/v1/xiaohongshu/app_v2/search_notes`, { keyword: term, page: 1, sort_type: 'general' })
      if (!res.ok) {
        ctx.log(`小红书搜索「${term}」失败 (HTTP ${res.status}): ${res.error ?? ''}`, {})
        continue
      }
      const items = findArray(res.json, 'note') ?? []
      for (const it of items) {
        const n = (it.note ?? it) as XhsNote
        if (!n.id || (!n.desc && !n.title)) continue
        const likes = Number(n.liked_count) || 0
        if (!byId.has(n.id) || likes > (Number(byId.get(n.id)!.liked_count) || 0)) byId.set(n.id, n)
      }
      await sleep(400)
    }
    const topNotes = [...byId.values()].sort((a, b) => (Number(b.liked_count) || 0) - (Number(a.liked_count) || 0)).slice(0, config.xhsMaxNotes)
    ctx.log(`小红书搜索：${terms.length} 个词命中 ${byId.size} 篇笔记，取点赞最高 ${topNotes.length} 篇`, {})

    const docs: FetchedDoc[] = []
    let commentCount = 0
    for (const n of topNotes) {
      const url = noteUrl(n.id!, n.xsec_token)
      const authorName = n.user?.nickname ?? n.user?.name ?? ''
      const noteText = [n.title, n.desc].filter(Boolean).join('\n').trim()

      // note body itself → community content doc (UGC about the game)
      if (noteText.length >= 12) {
        docs.push({
          source: {
            connector: 'xiaohongshu',
            sourceType: 'community',
            name: `小红书笔记 · ${authorName || '用户'}`,
            url,
            platform: 'xiaohongshu',
            ownerKey: `xhs_user:${authorName || n.id}`,
            authorityPrior: 0.4,
            licenseNote: '小红书用户笔记（UGC），Context Pack 中默认转述不逐字引用',
          },
          doc: {
            canonicalUrl: `xiaohongshu://note/${n.id}`,
            url,
            docType: 'review',
            title: (n.title || n.desc || '').slice(0, 50),
            authorHandle: authorName || null,
          },
          text: noteText,
          lang: 'zh',
          raw: n,
          review: { helpfulVotes: Number(n.liked_count) || null },
          meta: { commentsCount: Number(n.comments_count) || 0 },
        })
      }

      // note comments → player voice
      const cres = await tikhubGet(`/api/v1/xiaohongshu/app_v2/get_note_comments`, { note_id: n.id!, xsec_token: n.xsec_token })
      await sleep(400)
      const comments = (findArray(cres.json, 'content') ?? []) as unknown as XhsComment[]
      for (const c of comments) {
        const msg = (c.content ?? '').trim()
        if (msg.length < 6) continue
        const chandle = c.user?.nickname ?? c.user?.name ?? null
        docs.push({
          source: {
            connector: 'xiaohongshu',
            sourceType: 'community',
            name: `小红书评论 · ${authorName || '笔记'}`,
            url,
            platform: 'xiaohongshu',
            ownerKey: `xhs_user:${chandle ?? 'anonymous'}`,
            authorityPrior: 0.38,
            licenseNote: '小红书用户评论（UGC），Context Pack 中默认转述不逐字引用',
          },
          doc: {
            canonicalUrl: `xiaohongshu://note/${n.id}/comment/${c.id ?? commentCount}`,
            url,
            docType: 'review',
            title: `评论 · ${(n.title || '').slice(0, 40)}`,
            authorHandle: chandle,
          },
          text: msg,
          lang: 'zh',
          raw: { comment: c, note_id: n.id },
          review: { helpfulVotes: Number(c.like_count) || null },
          meta: { ipLocation: c.ip_location },
        })
        commentCount++
      }
    }
    ctx.log(`小红书抓取：${topNotes.length} 篇笔记 + ${commentCount} 条评论`, {})

    // ---- 竞品负面口碑搜索(与抖音同构:竞品名+痛点词 → 笔记评论 → ammo)----
    if (ctx.competitorTerms?.length) {
      const ammoDocs = await fetchXhsCompetitorPain(ctx)
      docs.push(...ammoDocs)
    }
    return docs
  },
}

/** 负面搜索词:与抖音共用同款词表(保证维度对齐)。 */
const PAIN_TERMS = ['太氪', '太肝', '优化差', '卡顿', '闪退', '逼氪', '无聊', '内容少', '退游', '坑钱']

async function fetchXhsCompetitorPain(ctx: ConnectorContext): Promise<FetchedDoc[]> {
  const docs: FetchedDoc[] = []
  for (const comp of ctx.competitorTerms!) {
    if (!comp || comp.length < 2) continue
    for (const pain of PAIN_TERMS.slice(0, 2)) {
      const term = `${comp} ${pain}`
      const res = await tikhubGet(`/api/v1/xiaohongshu/app_v2/search_notes`, { keyword: term, page: 1, sort_type: 'general' })
      await sleep(400)
      if (!res.ok) continue
      const items = findArray(res.json, 'note') ?? []
      // 每个命中的笔记拉评论,评论默认属竞品口碑语境(搜索词已预筛)
      for (const it of items.slice(0, 3)) {
        const n = (it.note ?? it) as XhsNote
        if (!n.id) continue
        const cres = await tikhubGet(`/api/v1/xiaohongshu/app_v2/get_note_comments`, { note_id: n.id, xsec_token: n.xsec_token })
        await sleep(400)
        const comments = (findArray(cres.json, 'content') ?? []) as unknown as XhsComment[]
        for (const c of comments) {
          const msg = (c.content ?? '').trim()
          if (msg.length < 8) continue
          docs.push({
            source: {
              connector: 'xiaohongshu', sourceType: 'community',
              name: `小红书·竞品${comp}口碑`, url: noteUrl(n.id, n.xsec_token), platform: 'xiaohongshu',
              ownerKey: `xhs_user:${c.user?.nickname ?? 'anonymous'}`, authorityPrior: 0.35,
              licenseNote: `竞品《${comp}》的小红书用户评论(UGC),用于卡位卖点;Context Pack 中转述`,
            },
            doc: {
              canonicalUrl: `xiaohongshu://competitor/${comp}/${n.id}/comment/${c.id ?? docs.length}`,
              url: noteUrl(n.id, n.xsec_token), docType: 'review',
              title: `竞品${comp}评论`, authorHandle: c.user?.nickname ?? null,
            },
            text: msg, lang: 'zh', raw: { comment: c, competitor: comp, note_id: n.id },
            review: { helpfulVotes: Number(c.like_count) || null },
            competitorFor: comp,
          })
        }
      }
    }
    ctx.log(`小红书竞品口碑:《${comp}》命中 ${docs.filter((d) => d.competitorFor === comp).length} 条评论`, {})
  }
  return docs
}
