import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { promisify } from 'node:util'
import { config } from '../config.js'
import type { Connector, ConnectorContext, FetchedDoc } from './types.js'

const execFileP = promisify(execFile)

/**
 * Bilibili connector — shells out to the `bili` CLI (public-clis/bilibili-cli).
 * Search + video details + top comments work WITHOUT login.
 *
 * Mapping into Mindex: a game's Bilibili top-video COMMENTS are real player voice.
 * They are ingested as review-type docs → the existing opinion-aggregation path turns
 * recurring sentiment into player_opinion claims, each cited back to the specific
 * Bilibili video. Comment like-counts are recorded for display but NEVER fed into
 * confidence (consistent with Mindex's "engagement ≠ truth" rule). Video titles/plays
 * are used only to SELECT high-traffic videos, not asserted as facts.
 *
 * The CLI hits api.bilibili.com through bilibili-api-python; the operator has accepted
 * this access path for their deployment. If `bili` is not installed the connector
 * reports needs_key and is skipped honestly.
 */

let _biliBin: string | null | undefined

function candidatePaths(): string[] {
  const home = os.homedir()
  return [config.biliCliPath, 'bili', path.join(home, '.local/bin/bili'), '/usr/local/bin/bili', '/opt/homebrew/bin/bili'].filter(
    Boolean,
  ) as string[]
}

async function resolveBili(): Promise<string | null> {
  if (_biliBin !== undefined) return _biliBin
  for (const cand of candidatePaths()) {
    try {
      // absolute paths: check existence first to avoid spawning noise
      if (cand.includes('/') && !existsSync(cand)) continue
      await execFileP(cand, ['--help'], { timeout: 8000 })
      _biliBin = cand
      return cand
    } catch {
      /* try next */
    }
  }
  _biliBin = null
  return null
}

interface BiliEnvelope<T> {
  ok?: boolean
  data?: T
}

async function runBili<T>(bin: string, args: string[], timeoutMs = 45_000): Promise<T | null> {
  try {
    const { stdout } = await execFileP(bin, [...args, '--json'], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env, // inherits http_proxy/https_proxy from the server process
    })
    const parsed = JSON.parse(stdout) as BiliEnvelope<T>
    if (parsed.ok === false) return null
    return (parsed.data ?? null) as T | null
  } catch {
    return null
  }
}

interface SearchVideo {
  bvid?: string
  id?: string
  title?: string
  author?: string
  play?: number
  duration?: string
}

interface VideoDetail {
  video?: {
    bvid?: string
    title?: string
    description?: string
    url?: string
    owner?: { id?: string; name?: string }
    stats?: { view?: number; like?: number }
  }
  comments?: { id?: string; author?: string | { id?: string; name?: string }; message?: string; like?: number; reply_count?: number }[]
}

function authorName(author: string | { id?: string; name?: string } | undefined): string | null {
  if (!author) return null
  return typeof author === 'string' ? author : (author.name ?? author.id ?? null)
}
function authorId(author: string | { id?: string; name?: string } | undefined): string {
  if (!author) return 'anonymous'
  return typeof author === 'string' ? author : (author.id ?? author.name ?? 'anonymous')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const bilibiliConnector: Connector = {
  id: 'bilibili',
  label: 'Bilibili 玩家反馈',
  get status() {
    return _biliBin ? ('verified' as const) : ('needs_key' as const)
  },
  description: '通过 bili CLI 检索游戏相关高播放视频，抽取热评作为玩家反馈（免登录）。',
  compliance:
    '经 bili CLI（bilibili-cli）访问 api.bilibili.com，搜索/详情/热评免登录。评论点赞数仅作展示，不参与置信度。运营方已确认采用此访问路径；未安装 bili 时连接器不激活。',

  async discover(ctx: ConnectorContext): Promise<FetchedDoc[]> {
    const bin = await resolveBili()
    if (!bin) {
      ctx.log('未找到 bili CLI（pip install bilibili-cli 或设置 BILI_CLI_PATH），已跳过', {})
      return []
    }

    const name = ctx.project.name
    const queries = [...new Set([name, ...ctx.project.aliases.filter((a) => a.length >= 2), `${name} 评测`, `${name} 口碑`])].slice(0, 4)

    // 1) gather candidate videos across query variants, dedup by bvid, rank by play
    const byBvid = new Map<string, SearchVideo>()
    for (const q of queries) {
      const results = (await runBili<SearchVideo[]>(bin, ['search', q, '--type', 'video', '--max', '10'])) ?? []
      for (const v of results) {
        const bvid = v.bvid || v.id
        if (!bvid) continue
        if (!byBvid.has(bvid) || (v.play ?? 0) > (byBvid.get(bvid)!.play ?? 0)) byBvid.set(bvid, { ...v, bvid })
      }
      await sleep(400)
    }
    const topVideos = [...byBvid.values()].sort((a, b) => (b.play ?? 0) - (a.play ?? 0)).slice(0, config.biliMaxVideos)
    ctx.log(`Bilibili 搜索：${queries.length} 个查询命中 ${byBvid.size} 个视频，取播放最高 ${topVideos.length} 个`, {})

    // 2) pull comments per video → review docs (player voice)
    const docs: FetchedDoc[] = []
    let commentCount = 0
    for (const v of topVideos) {
      const detail = await runBili<VideoDetail>(bin, ['video', v.bvid!, '--comments'])
      await sleep(500)
      if (!detail?.video) continue
      const videoUrl = detail.video.url || `https://www.bilibili.com/video/${v.bvid}`
      const comments = (detail.comments ?? []).filter((c) => (c.message ?? '').trim().length >= 6)
      for (const c of comments) {
        const handle = authorName(c.author)
        docs.push({
          source: {
            connector: 'bilibili',
            sourceType: 'community',
            name: `Bilibili 热评 · ${detail.video.owner?.name ?? 'UP主'}`,
            url: videoUrl,
            platform: 'bilibili',
            ownerKey: `bilibili_user:${authorId(c.author)}`,
            authorityPrior: 0.4,
            licenseNote: 'B站用户评论（UGC），Context Pack 中默认转述不逐字引用',
          },
          doc: {
            canonicalUrl: `bilibili://video/${v.bvid}/comment/${c.id ?? commentCount}`,
            url: videoUrl,
            docType: 'review',
            title: `评论 · ${v.title?.slice(0, 40) ?? ''}`,
            authorHandle: handle,
          },
          text: c.message!.trim(),
          lang: 'zh',
          raw: { comment: c, video_bvid: v.bvid, video_title: v.title },
          review: { helpfulVotes: typeof c.like === 'number' ? c.like : null },
          meta: { videoTitle: v.title, videoPlay: v.play },
        })
        commentCount++
      }
    }
    ctx.log(`Bilibili 热评抓取：${commentCount} 条（来自 ${topVideos.length} 个视频）`, {})

    // ---- 竞品负面口碑搜索(竞品名+痛点词 → 视频 → 热评 → ammo)----
    if (ctx.competitorTerms?.length) {
      const ammoDocs = await fetchBiliCompetitorPain(ctx, bin!)
      docs.push(...ammoDocs)
    }
    return docs
  },
}

/** 负面搜索词:与其他连接器共用同款词表(维度对齐)。 */
const PAIN_TERMS = ['太氪', '太肝', '优化差', '卡顿', '闪退', '逼氪', '无聊', '内容少', '退游', '坑钱']

async function fetchBiliCompetitorPain(ctx: ConnectorContext, bin: string): Promise<FetchedDoc[]> {
  const docs: FetchedDoc[] = []
  for (const comp of ctx.competitorTerms!) {
    if (!comp || comp.length < 2) continue
    for (const pain of PAIN_TERMS.slice(0, 2)) {
      const term = `${comp} ${pain}`
      const results = (await runBili<SearchVideo[]>(bin, ['search', term, '--type', 'video', '--max', '5'])) ?? []
      await sleep(400)
      for (const v of results.slice(0, 2)) {
        const bvid = v.bvid || v.id
        if (!bvid) continue
        const detail = await runBili<VideoDetail>(bin, ['video', bvid, '--comments'])
        await sleep(500)
        if (!detail?.video) continue
        const videoUrl = detail.video.url || `https://www.bilibili.com/video/${bvid}`
        const comments = (detail.comments ?? []).filter((c) => (c.message ?? '').trim().length >= 8)
        for (const c of comments) {
          docs.push({
            source: {
              connector: 'bilibili', sourceType: 'community',
              name: `B站·竞品${comp}口碑`, url: videoUrl, platform: 'bilibili',
              ownerKey: `bilibili_user:${authorId(c.author)}`, authorityPrior: 0.35,
              licenseNote: `竞品《${comp}》的B站用户评论(UGC),用于卡位卖点;Context Pack 中转述`,
            },
            doc: {
              canonicalUrl: `bilibili://competitor/${comp}/${bvid}/comment/${c.id ?? docs.length}`,
              url: videoUrl, docType: 'review', title: `竞品${comp}评论`,
              authorHandle: authorName(c.author),
            },
            text: c.message!.trim(), lang: 'zh',
            raw: { comment: c, competitor: comp, video_bvid: bvid },
            review: { helpfulVotes: typeof c.like === 'number' ? c.like : null },
            competitorFor: comp,
          })
        }
      }
    }
    ctx.log(`B站竞品口碑:《${comp}》命中 ${docs.filter((d) => d.competitorFor === comp).length} 条评论`, {})
  }
  return docs
}

/** test/introspection hook */
export async function biliAvailable(): Promise<boolean> {
  return (await resolveBili()) !== null
}

// resolve availability eagerly so connector status reflects reality shortly after boot
void resolveBili()
