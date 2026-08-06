import { extractHtmlTitle, htmlToText } from './fetcher.js'
import type { Connector, FetchedDoc } from './types.js'

/**
 * Generic official-site fetcher: pulls the user-provided official URLs (and simple
 * same-site news/RSS links discovered on them). robots.txt is checked and recorded;
 * MINDEX_ROBOTS_POLICY=strict makes disallowed pages skip.
 */
export const webConnector: Connector = {
  id: 'web',
  label: '官网 / 公开网页',
  status: 'verified',
  description: '抓取项目配置的官网链接与页面上发现的同站新闻/公告页。',
  compliance: '礼貌抓取：标识 UA、限速、记录 robots 状态；策略可配置（strict/log/off）。不绕过登录或验证码。',

  async discover(ctx) {
    const docs: FetchedDoc[] = []
    const seen = new Set<string>()
    const queue: { url: string; depth: number }[] = ctx.project.official_urls
      .filter((u) => /^https?:\/\//.test(u))
      .map((url) => ({ url, depth: 0 }))

    while (queue.length > 0 && docs.length < 12) {
      const { url, depth } = queue.shift()!
      const canonical = url.replace(/[#?].*$/, '').replace(/\/$/, '')
      if (seen.has(canonical)) continue
      seen.add(canonical)

      const verdict = await ctx.fetcher.robotsVerdict(url)
      if (ctx.fetcher.shouldSkip(verdict)) {
        ctx.log(`robots.txt 禁止，已跳过 (strict 策略): ${url}`)
        continue
      }
      const res = await ctx.fetcher.fetch(url)
      if (!res.ok) {
        ctx.log(`网页抓取失败 (${res.status}): ${url}`, { error: res.error })
        continue
      }
      // JS-rendered shells carry little visible text — salvage meta/og description honestly
      const metaDesc = [
        ...res.text.matchAll(/<meta[^>]+(?:name="description"|property="og:(?:description|title)")[^>]+content="([^"]+)"/gi),
      ]
        .map((m) => m[1])
        .join('\n')
      let text = htmlToText(res.text)
      if (text.length < 120 && metaDesc) text = `${metaDesc}\n${text}`
      if (text.length < 120) {
        ctx.log(`页面可提取文本过少（疑似 JS 渲染页），已跳过: ${url}`, { textLength: text.length }, )
        continue
      }
      const title = extractHtmlTitle(res.text) || url
      const host = new URL(url).host
      docs.push({
        source: {
          connector: 'web',
          sourceType: 'official',
          name: `官网 ${host}`,
          url,
          platform: 'web',
          ownerKey: host.replace(/^www\./, ''),
          authorityPrior: 0.9,
          robotsStatus: verdict,
          licenseNote: '官方公开页面',
        },
        doc: {
          canonicalUrl: canonical,
          url,
          docType: depth === 0 ? 'page' : 'page',
          title,
        },
        text: text.slice(0, 20_000),
        lang: /[一-鿿]/.test(text.slice(0, 500)) ? 'zh' : 'en',
        raw: null,
      })
      ctx.log(`已抓取官网页面: ${title}`, { url })

      // discover same-site news/announcement links (one hop only)
      if (depth === 0) {
        const links = [...res.text.matchAll(/href=["']([^"']+)["']/g)]
          .map((m) => m[1]!)
          .filter((href) => /news|notice|announce|公告|新闻|资讯|update|版本/i.test(href))
          .slice(0, 6)
        for (const href of links) {
          try {
            const abs = new URL(href, url)
            if (abs.host === host && !seen.has(abs.href.replace(/[#?].*$/, '').replace(/\/$/, ''))) {
              queue.push({ url: abs.href, depth: 1 })
            }
          } catch {
            /* invalid URL — skip */
          }
        }
      }
    }
    return docs
  },
}
