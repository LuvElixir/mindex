import { config } from '../config.js'
import { collectByKey, tikhubConfigured, tikhubGet, tikhubPost } from './tikhub.js'
import type { Connector, ConnectorContext, FetchedDoc } from './types.js'

/**
 * Douyin (抖音) connector via the TikHub API — the single most important UA platform.
 *
 * 手游买量素材就活在抖音：搜关键词视频 → 取评论数最高的若干条 → 拉评论 = 真·玩家发言，
 * 视频文案(desc)本身是投放侧/创作者内容(creative_ref 不合适——搜索命中的多是自然内容与二创，
 * 归 community UGC)。映射：视频 desc → community doc；评论 → review doc → player_opinion，
 * 逐条回指抖音视频。点赞/评论数仅展示，绝不进置信度。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface AwemeInfo {
  aweme_id?: string
  desc?: string
  statistics?: { comment_count?: number; digg_count?: number }
  author?: { nickname?: string }
  create_time?: number
}

interface DyComment {
  text?: string
  digg_count?: number
  cid?: string
  user?: { nickname?: string }
  create_time?: number
}

function videoUrl(id: string): string {
  return `https://www.douyin.com/video/${id}`
}

export const douyinConnector: Connector = {
  id: 'douyin',
  label: '抖音口碑与素材',
  get status() {
    return tikhubConfigured() ? ('verified' as const) : ('needs_key' as const)
  },
  description: '通过 TikHub API 搜索抖音相关视频与评论，抽取玩家口碑（买量最核心的平台）。',
  compliance:
    '经 TikHub（付费聚合 API）访问抖音公开内容；视频文案与评论为 UGC，Context Pack 中默认转述不逐字引用；点赞/评论数仅展示不计入置信度。未配置 TIKHUB_API_KEY 时不激活（needs_key）。',

  async discover(ctx: ConnectorContext): Promise<FetchedDoc[]> {
    if (!tikhubConfigured()) {
      ctx.log('抖音连接器未配置 TikHub API Key（设置页或 TIKHUB_API_KEY），已跳过（needs_key）', {})
      return []
    }
    const terms = [ctx.project.name, ...ctx.project.aliases.filter((a) => a.length >= 2)].slice(0, 2)

    // 1) 搜视频，按评论数排序取头部（评论多 = 玩家讨论足）
    const byId = new Map<string, AwemeInfo>()
    for (const term of terms) {
      // 命中项形如 {aweme_info: {...}}；抖音搜索 POST 偶发返回空（TikHub 瞬时），空则重试一次
      let items: Record<string, unknown>[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await tikhubPost('/api/v1/douyin/search/fetch_video_search_v1', {
          keyword: term,
          cursor: 0,
          sort_type: '0',
          publish_time: '0',
        })
        if (!res.ok) {
          ctx.log(`抖音搜索「${term}」失败 (HTTP ${res.status}): ${res.error ?? ''}`, {})
          break
        }
        items = collectByKey(res.json, 'aweme_info')
        if (items.length > 0) break
        await sleep(800)
      }
      for (const it of items) {
        const aw = (it.aweme_info ?? it) as AwemeInfo
        if (!aw.aweme_id || !aw.desc) continue
        if (!byId.has(aw.aweme_id)) byId.set(aw.aweme_id, aw)
      }
      await sleep(400)
    }
    const topVideos = [...byId.values()]
      .sort((a, b) => (b.statistics?.comment_count ?? 0) - (a.statistics?.comment_count ?? 0))
      .slice(0, config.douyinMaxVideos)
    ctx.log(`抖音搜索：${terms.length} 个词命中 ${byId.size} 条视频，取评论最多 ${topVideos.length} 条`, {})

    const docs: FetchedDoc[] = []
    let commentCount = 0
    for (const v of topVideos) {
      const url = videoUrl(v.aweme_id!)
      const author = v.author?.nickname ?? ''
      const desc = (v.desc ?? '').trim()
      const publishedAt = v.create_time ? new Date(v.create_time * 1000).toISOString() : null

      // 视频文案 → community 内容
      if (desc.length >= 10) {
        docs.push({
          source: {
            connector: 'douyin',
            sourceType: 'community',
            name: `抖音视频 · ${author || '创作者'}`,
            url,
            platform: 'douyin',
            ownerKey: `douyin_user:${author || v.aweme_id}`,
            authorityPrior: 0.4,
            licenseNote: '抖音视频文案（UGC），Context Pack 中默认转述不逐字引用',
          },
          doc: {
            canonicalUrl: `douyin://video/${v.aweme_id}`,
            url,
            docType: 'review',
            title: desc.slice(0, 50),
            authorHandle: author || null,
            publishedAt,
          },
          text: desc,
          lang: 'zh',
          raw: v,
          review: { helpfulVotes: v.statistics?.digg_count ?? null },
          meta: { commentCount: v.statistics?.comment_count ?? 0 },
        })
      }

      // 评论 → 玩家发言
      const cres = await tikhubGet('/api/v1/douyin/app/v3/fetch_video_comments', { aweme_id: v.aweme_id!, cursor: 0, count: 30 })
      await sleep(400)
      const comments = collectByKey(cres.json, 'text').filter((c) => 'cid' in c || 'digg_count' in c) as unknown as DyComment[]
      for (const c of comments) {
        const msg = (c.text ?? '').trim()
        if (msg.length < 6) continue // 过滤「。」「哈哈」这类无信息评论
        const chandle = c.user?.nickname ?? null
        docs.push({
          source: {
            connector: 'douyin',
            sourceType: 'community',
            name: `抖音评论 · ${author || '视频'}`,
            url,
            platform: 'douyin',
            ownerKey: `douyin_user:${chandle ?? 'anonymous'}`,
            authorityPrior: 0.38,
            licenseNote: '抖音用户评论（UGC），Context Pack 中默认转述不逐字引用',
          },
          doc: {
            canonicalUrl: `douyin://video/${v.aweme_id}/comment/${c.cid ?? commentCount}`,
            url,
            docType: 'review',
            title: `评论 · ${desc.slice(0, 40)}`,
            authorHandle: chandle,
            publishedAt: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
          },
          text: msg,
          lang: 'zh',
          raw: { comment: c, aweme_id: v.aweme_id },
          review: { helpfulVotes: c.digg_count ?? null },
        })
        commentCount++
      }
    }
    ctx.log(`抖音抓取：${topVideos.length} 条视频 + ${commentCount} 条评论`, {})

    // ---- 竞品负面口碑搜索(买量弹药:竞品被骂的痛点 → ammo 卖点)----
    if (ctx.competitorTerms?.length) {
      const ammoDocs = await fetchCompetitorPain(ctx)
      docs.push(...ammoDocs)
    }
    return docs
  },
}

/** 负面搜索词模板:竞品名 + 痛点词,提高 ammo 命中率(避免抓竞品全部口碑污染库)。 */
const PAIN_TERMS = ['太氪', '太肝', '优化差', '卡顿', '闪退', '逼氪', '无聊', '内容少', '退游', '坑钱']

async function fetchCompetitorPain(ctx: ConnectorContext): Promise<FetchedDoc[]> {
  const docs: FetchedDoc[] = []
  for (const comp of ctx.competitorTerms!) {
    if (!comp || comp.length < 2) continue
    // 每个竞品取 2 个痛点词组合搜(控制抓取量)
    for (const pain of PAIN_TERMS.slice(0, 2)) {
      const term = `${comp} ${pain}`
      let items: Record<string, unknown>[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await tikhubPost('/api/v1/douyin/search/fetch_video_search_v1', {
          keyword: term, cursor: 0, sort_type: '0', publish_time: '0',
        })
        if (!res.ok) break
        items = collectByKey(res.json, 'aweme_info')
        if (items.length > 0) break
        await sleep(600)
      }
      // 只取评论里含痛点词的视频评论(精准 ammo,不抓竞品正面噪音)
      for (const it of items.slice(0, 3)) {
        const aw = (it.aweme_info ?? it) as AwemeInfo
        if (!aw.aweme_id) continue
        const cres = await tikhubGet('/api/v1/douyin/app/v3/fetch_video_comments', { aweme_id: aw.aweme_id, cursor: 0, count: 20 })
        await sleep(300)
        const comments = collectByKey(cres.json, 'text').filter((c) => 'cid' in c || 'digg_count' in c) as unknown as DyComment[]
        for (const c of comments) {
          const msg = (c.text ?? '').trim()
          // 搜索词已是"竞品+痛点词",此处视频语境即负面口碑;只滤过短/无信息评论,
          // 不再二次字面卡痛点词(评论常用"贵/坑/不值"等同义表达,字面过滤会漏掉)
          if (msg.length < 8) continue
          docs.push({
            source: {
              connector: 'douyin', sourceType: 'community',
              name: `抖音·竞品${comp}口碑`, url: videoUrl(aw.aweme_id), platform: 'douyin',
              ownerKey: `douyin_user:${c.user?.nickname ?? 'anonymous'}`,
              authorityPrior: 0.35,
              licenseNote: `竞品《${comp}》的抖音用户评论(UGC),用于卡位卖点分析;Context Pack 中转述`,
            },
            doc: {
              canonicalUrl: `douyin://competitor/${comp}/${aw.aweme_id}/comment/${c.cid ?? docs.length}`,
              url: videoUrl(aw.aweme_id), docType: 'review',
              title: `竞品${comp}评论`, authorHandle: c.user?.nickname ?? null,
            },
            text: msg, lang: 'zh', raw: { comment: c, competitor: comp, aweme_id: aw.aweme_id },
            review: { helpfulVotes: c.digg_count ?? null },
            competitorFor: comp, // 关键标记 → pipeline 标 competitor_review → ammo
          })
        }
      }
      await sleep(400)
    }
    ctx.log(`抖音竞品口碑:《${comp}》命中 ${docs.filter((d) => d.competitorFor === comp).length} 条负面评论`, {})
  }
  return docs
}
