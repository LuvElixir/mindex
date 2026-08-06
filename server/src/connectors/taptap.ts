import { Fetcher } from './fetcher.js'
import type { Connector, ConnectorContext, FetchedDoc } from './types.js'

/**
 * TapTap connector — aggregate rating only.
 *
 * TapTap has no clean third-party API (verified 2026-07): paid aggregators don't cover
 * it, official APIs are dev-only, and per-review data needs a reverse-engineered X-UA
 * signature or a headless browser. The ONE clean, auth-free, robots-allowed path is the
 * server-rendered game page `www.taptap.cn/app/{id}`, whose JSON-LD carries the
 * aggregate rating + rating count + genre. This connector ingests that as official facts.
 *
 * Per-review player voice is NOT scraped here (would require signature/browser). Those
 * come via the review-import path (POST /app/projects/:id/import-reviews) — the user's
 * external agent scrapes them and hands over a Markdown/JSON batch.
 *
 * Needs a TapTap app URL/id on the project (official_urls or platform_hints.taptap_app_id);
 * name→id search needs X-UA so it can't be auto-resolved.
 */

function findTaptapAppId(project: { official_urls: string[]; platform_hints: Record<string, unknown> }): string | null {
  const hinted = project.platform_hints.taptap_app_id ?? project.platform_hints.taptap_id
  if (hinted) return String(hinted)
  for (const u of project.official_urls) {
    const m = u.match(/taptap\.(?:cn|io)\/app\/(\d+)/)
    if (m) return m[1]!
  }
  return null
}

interface JsonLd {
  name?: string
  genre?: string | string[]
  operatingSystem?: string
  aggregateRating?: { ratingValue?: number | string; bestRating?: number | string; ratingCount?: number | string }
}

/** Recursively find the first object carrying aggregateRating (handles @graph / nested wrappers). */
function findAggregate(node: unknown): JsonLd | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const f = findAggregate(item)
      if (f) return f
    }
    return null
  }
  const obj = node as Record<string, unknown>
  if (obj.aggregateRating && typeof obj.aggregateRating === 'object') return obj as JsonLd
  for (const v of Object.values(obj)) {
    const f = findAggregate(v)
    if (f) return f
  }
  return null
}

function parseJsonLd(html: string): JsonLd | null {
  // a TapTap page carries several ld+json blocks (BreadcrumbList, VideoGame, @graph, …) —
  // scan all, return the first object anywhere inside carrying aggregateRating
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const hit = findAggregate(JSON.parse(m[1]!))
      if (hit) return hit
    } catch {
      /* try next block */
    }
  }
  return null
}

export const taptapConnector: Connector = {
  id: 'taptap',
  label: 'TapTap 评分',
  status: 'verified',
  description: '抓取 TapTap 游戏页的聚合评分与品类（JSON-LD）。逐条评论走「评论批量导入」。',
  compliance:
    '抓取 www.taptap.cn/app/{id} 服务端渲染页的 JSON-LD 聚合数据；经快代理（大陆出口）绕过 taptap 对 IDC IP 的 405 封锁；需在项目里配置 TapTap 链接或 app id。逐条评论走外部采集后导入。',

  async discover(ctx: ConnectorContext): Promise<FetchedDoc[]> {
    const appId = findTaptapAppId(ctx.project)
    if (!appId) {
      ctx.log('未配置 TapTap 链接（在项目官方链接里加 taptap.cn/app/{id} 即可抓聚合评分），已跳过', {})
      return []
    }
    const fetcher = new Fetcher()
    const url = `https://www.taptap.cn/app/${appId}`
    const res = await fetcher.fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' },
      proxy: true, // taptap.cn 对 IDC IP 返回 405；走快代理（大陆出口）绕过
    })
    if (!res.ok) {
      ctx.log(`TapTap 页面抓取失败 (HTTP ${res.status}): ${url}`, {})
      return []
    }
    const ld = parseJsonLd(res.text)
    if (!ld?.aggregateRating?.ratingValue) {
      ctx.log('TapTap 页面未解析出聚合评分（页面结构可能变化）', {})
      return []
    }
    const ar = ld.aggregateRating
    const genre = Array.isArray(ld.genre) ? ld.genre.join('、') : ld.genre ?? ''
    const text = [
      `游戏名称: ${ld.name ?? ctx.project.name}`,
      `TapTap评分: ${ar.ratingValue}/${ar.bestRating ?? 10}（${ar.ratingCount ?? 0}个评分）`,
      genre ? `类型: ${genre}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    ctx.log(`TapTap 聚合评分：${ar.ratingValue}/${ar.bestRating ?? 10}（${ar.ratingCount ?? 0} 个评分）`, {})
    return [
      {
        source: {
          connector: 'taptap',
          sourceType: 'store_metadata',
          name: 'TapTap 游戏页',
          url,
          platform: 'taptap',
          ownerKey: 'taptap:aggregate',
          authorityPrior: 0.75,
          licenseNote: 'TapTap 页面公开聚合数据（JSON-LD）',
        },
        doc: {
          canonicalUrl: `taptap://app/${appId}`,
          url,
          docType: 'api_record',
          title: `${ld.name ?? ctx.project.name} — TapTap 聚合评分`,
        },
        text,
        lang: 'zh',
        raw: ld,
      },
    ]
  },
}
