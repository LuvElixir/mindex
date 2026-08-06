import type { Connector, ConnectorContext, FetchedDoc } from './types.js'

/**
 * Apple iTunes Search API (public, keyless) — CN storefront metadata only.
 * 定位：国内手游买量场景下，App Store CN 元数据（版本/开发商/分类/更新说明）是
 * 有效的 official_fact 来源；US 商店与 App Store 用户评论按业务判断无参考价值，
 * 已于 2026-07 移除（评论口碑走 TapTap 导入 / B站 / 小红书等国内 UGC 通路）。
 */

interface ItunesApp {
  trackId: number
  trackName: string
  sellerName: string
  description: string
  releaseNotes?: string
  version?: string
  currentVersionReleaseDate?: string
  releaseDate?: string
  primaryGenreName?: string
  genres?: string[]
  averageUserRating?: number
  userRatingCount?: number
  formattedPrice?: string
  contentAdvisoryRating?: string
  minimumOsVersion?: string
  fileSizeBytes?: string
  languageCodesISO2A?: string[]
  trackViewUrl?: string
}

async function searchApp(ctx: ConnectorContext, term: string): Promise<ItunesApp | null> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=cn&entity=software&limit=5`
  const res = await ctx.fetcher.fetch(url)
  if (!res.ok || !res.json) return null
  const results = (res.json as { results?: ItunesApp[] }).results ?? []
  if (results.length === 0) return null
  // prefer exact-ish name match, else first result
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')
  return results.find((r) => norm(r.trackName).includes(norm(term)) || norm(term).includes(norm(r.trackName))) ?? results[0]!
}

export function appMetadataText(app: ItunesApp): string {
  const lines = [
    `应用名称: ${app.trackName}`,
    `开发商/发行商: ${app.sellerName}`,
    app.primaryGenreName ? `主分类: ${app.primaryGenreName}` : '',
    app.genres?.length ? `分类: ${app.genres.join('、')}` : '',
    app.version ? `当前版本: ${app.version}` : '',
    app.currentVersionReleaseDate ? `当前版本发布时间: ${app.currentVersionReleaseDate}` : '',
    app.releaseDate ? `首次上架时间: ${app.releaseDate}` : '',
    typeof app.averageUserRating === 'number'
      ? `App Store(CN) 平均评分: ${app.averageUserRating.toFixed(2)} (${app.userRatingCount ?? 0} 个评分)`
      : '',
    app.formattedPrice ? `价格: ${app.formattedPrice}` : '',
    app.contentAdvisoryRating ? `年龄分级: ${app.contentAdvisoryRating}` : '',
    app.minimumOsVersion ? `最低系统要求: iOS ${app.minimumOsVersion}` : '',
    app.languageCodesISO2A?.length ? `支持语言: ${app.languageCodesISO2A.join(', ')}` : '',
    '',
    '=== 应用描述 ===',
    app.description ?? '',
    '',
    app.releaseNotes ? `=== 最新版本更新说明 ===\n${app.releaseNotes}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

export const itunesConnector: Connector = {
  id: 'itunes_app',
  label: 'App Store (CN) 应用信息',
  status: 'verified',
  description: '通过 Apple 公开的 iTunes Search API 获取国区应用元数据、描述、版本更新说明与评分。',
  compliance: '官方公开 API，无需密钥；约 20 次/分钟限速，本连接器全局限速并缓存快照。',

  async resolve(ctx) {
    const hints: Record<string, unknown> = {}
    const terms = [ctx.project.name, ...ctx.project.aliases]
    if (ctx.project.platform_hints.itunes_cn_id) {
      hints.itunes_cn_id = ctx.project.platform_hints.itunes_cn_id
      return hints
    }
    for (const term of terms) {
      const app = await searchApp(ctx, term)
      if (app) {
        hints.itunes_cn_id = app.trackId
        hints.itunes_cn_name = app.trackName
        ctx.log(`App Store(CN) 定位到应用: ${app.trackName} (id=${app.trackId})`, { term })
        break
      }
    }
    if (!hints.itunes_cn_id) ctx.log('App Store(CN) 未找到匹配应用', { terms })
    return hints
  },

  async discover(ctx) {
    const docs: FetchedDoc[] = []
    const id = ctx.project.platform_hints.itunes_cn_id
    if (!id) return docs
    const res = await ctx.fetcher.fetch(`https://itunes.apple.com/lookup?id=${id}&country=cn`)
    const app = ((res.json as { results?: ItunesApp[] })?.results ?? [])[0]
    if (!app) {
      ctx.log('App Store(CN) lookup 失败', { id, status: res.status })
      return docs
    }
    docs.push({
      source: {
        connector: 'itunes_app',
        sourceType: 'store_metadata',
        name: 'App Store (CN) 商店页',
        url: app.trackViewUrl ?? `https://apps.apple.com/cn/app/id${id}`,
        platform: 'appstore',
        ownerKey: `appstore:${app.sellerName}`,
        authorityPrior: 0.85,
        licenseNote: 'Apple iTunes Search API 公开数据',
      },
      doc: {
        canonicalUrl: `itunes://cn/app/${id}`,
        url: app.trackViewUrl,
        docType: 'api_record',
        title: `${app.trackName} — App Store CN 元数据`,
        publishedAt: app.currentVersionReleaseDate ?? null,
        versionTag: app.version ?? null,
      },
      text: appMetadataText(app),
      lang: 'zh',
      raw: app,
      meta: { country: 'cn', rating: app.averageUserRating, ratingCount: app.userRatingCount },
    })
    return docs
  },
}
