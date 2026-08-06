import { effectiveBaobaomi } from '../core/settings.js'
import type { Connector, ConnectorContext, FetchedDoc } from './types.js'

/**
 * Baobaomi (抱抱米) connector.
 *
 * Baobaomi is a companion production service that already harvests Douyin (via TikHub),
 * Bilibili (official public API) and TapTap content, and exposes an Agent API
 * (MCP-over-HTTP) at BAOBAOMI_BASE_URL. Mindex reuses it as a RAW-CONTENT source and
 * adds the layer baobaomi's feed lacks: atomic claims, verbatim citations back to the
 * original Douyin video, cross-source confidence, dedup, conflict detection.
 *
 * IMPORTANT semantics: baobaomi's creative materials are ANALYZED ADVERTISING content
 * (marketer copy + AI breakdown), NOT player reviews. Mindex ingests them as
 * creative_insight (reusable ad angles), never as player_opinion — mislabeling ad copy
 * as player voice would make the context worse, not better.
 *
 * Primary tool: `search_creative_library` — server-side filtered by game name, fast
 * (~100ms), rich (hook/emotion-arc/CTA/analysis/transcript). `get_trending_topics` and
 * `get_hot_creatives` are best-effort extras (the baobaomi server is slow for large
 * windows, so they use small limits, short timeouts, and per-tool isolation).
 *
 * Auth: Bearer BAOBAOMI_AGENT_KEY. Without it the connector is 'needs_key' and skipped.
 */

interface McpToolResult {
  content?: { type: string; text?: string }[]
}

/** Minimal MCP-over-HTTP (Streamable HTTP) client: initialize once, then tools/call. */
class BaobaomiMcp {
  private sessionId: string | null = null
  private id = 0

  constructor(
    private baseUrl: string,
    private key: string,
  ) {}

  private async rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.key}`,
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const res = await fetch(`${this.baseUrl}/api/agent/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    const text = await res.text()
    if (!res.ok) throw new Error(`mcp ${method} → HTTP ${res.status}: ${text.slice(0, 160)}`)
    let payload = text.trim()
    if (payload.startsWith('event:') || payload.startsWith('data:')) {
      payload = payload
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
    }
    const json = JSON.parse(payload) as { result?: unknown; error?: { message?: string } }
    if (json.error) throw new Error(`mcp ${method} error: ${json.error.message}`)
    return json.result
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mindex', version: '0.1.0' } }, 20_000)
    try {
      await this.rpc('notifications/initialized', {}, 8_000)
    } catch {
      /* stateless servers may ignore */
    }
  }

  async listTools(): Promise<string[]> {
    const r = (await this.rpc('tools/list', {}, 15_000)) as { tools?: { name: string }[] }
    return (r.tools ?? []).map((t) => t.name)
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 25_000): Promise<unknown> {
    const r = (await this.rpc('tools/call', { name, arguments: args }, timeoutMs)) as McpToolResult
    const textPart = r.content?.find((c) => c.type === 'text')?.text
    if (!textPart) return null
    try {
      return JSON.parse(textPart)
    } catch {
      return textPart
    }
  }
}

function mentionsProject(text: string, terms: string[]): boolean {
  const t = text.toLowerCase()
  return terms.some((term) => term.length >= 2 && t.includes(term.toLowerCase()))
}

function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[]
  if (v && typeof v === 'object') {
    for (const key of ['items', 'materials', 'topics', 'creatives', 'data', 'results']) {
      const inner = (v as Record<string, unknown>)[key]
      if (Array.isArray(inner)) return inner as Record<string, unknown>[]
    }
  }
  return []
}

/** Build the ingestible text for an analyzed creative material (ad breakdown + narration). */
function creativeText(m: Record<string, unknown>): string {
  return [
    m.hookType ? `钩子类型：${m.hookType}` : '',
    m.emotionArc ? `情绪曲线：${m.emotionArc}` : '',
    m.pacing ? `节奏：${m.pacing}` : '',
    m.ctaType ? `CTA：${m.ctaType}` : '',
    m.visualStyle ? `视觉风格：${m.visualStyle}` : '',
    m.metric ? `表现：${typeof m.metric === 'string' ? m.metric : JSON.stringify(m.metric)}` : '',
    m.analysis ? `\n=== 创意拆解 ===\n${m.analysis}` : '',
    m.transcript ? `\n=== 素材旁白（营销文案，非玩家评论）===\n${m.transcript}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export const baobaomiConnector: Connector = {
  id: 'baobaomi',
  label: '抱抱米情报（复用）',
  // dynamic: settings page can activate/deactivate without restart
  get status() {
    return effectiveBaobaomi().agentKey ? ('verified' as const) : ('needs_key' as const)
  },
  description:
    '复用抱抱米已采集的抖音爆量素材（AI 拆解的买量创意角度），经 Mindex 溯源与置信度管线转化为可引用的 creative_insight 知识。',
  compliance:
    '通过抱抱米官方 Agent API（Bearer key）服务端到服务端调用；抖音素材为广告创意（非玩家评论），记录回原视频链接与抓取时间，标为创意参考。未配置 BAOBAOMI_AGENT_KEY 时不激活（needs_key）。',

  async discover(ctx: ConnectorContext): Promise<FetchedDoc[]> {
    const bbm = effectiveBaobaomi()
    if (!bbm.agentKey) {
      ctx.log('抱抱米连接器未配置 Agent Key（设置页或 BAOBAOMI_AGENT_KEY），已跳过（needs_key）', {})
      return []
    }
    const terms = [ctx.project.name, ...ctx.project.aliases].filter((t) => t.length >= 2)
    const mcp = new BaobaomiMcp(bbm.baseUrl, bbm.agentKey)
    const docs: FetchedDoc[] = []
    const seen = new Set<string>()

    let tools: string[]
    try {
      await mcp.initialize()
      tools = await mcp.listTools()
      ctx.log(`抱抱米 Agent API 已连接，可用工具: ${tools.join(', ')}`, {})
    } catch (err) {
      ctx.log(`抱抱米连接失败: ${String((err as Error).message).slice(0, 200)}`, {})
      return []
    }

    // ---- PRIMARY: search_creative_library (fast, project-filtered, rich) → creative_insight
    if (tools.includes('search_creative_library')) {
      let kept = 0
      for (const term of terms.slice(0, 3)) {
        let mats: Record<string, unknown>[] = []
        try {
          mats = asArray(await mcp.call('search_creative_library', { query: term, limit: 15 }, 30_000))
        } catch (err) {
          ctx.log(`抱抱米创意库查询「${term}」失败: ${String((err as Error).message).slice(0, 120)}`, {})
          continue
        }
        for (const m of mats) {
          const link = String(m.link ?? m.douyinLink ?? '')
          const key = String(m.id ?? link)
          if (!key || seen.has(key)) continue
          if (!m.analysis && !m.transcript) continue
          seen.add(key)
          docs.push({
            source: {
              connector: 'baobaomi',
              sourceType: 'community',
              name: `抱抱米创意库 · 抖音爆量素材`,
              url: link || null,
              platform: 'baobaomi:douyin',
              ownerKey: `douyin:material:${key}`,
              authorityPrior: 0.4,
              licenseNote: '抖音广告创意（经抱抱米AI拆解），创意参考；来源回指原视频',
            },
            doc: {
              canonicalUrl: link || `baobaomi://material/${key}`,
              url: link || undefined,
              docType: 'creative_ref',
              title: `买量创意：${String(m.hookType ?? '')}${m.gameType ? ` · ${m.gameType}` : ''}`.trim(),
            },
            text: creativeText(m),
            lang: 'zh',
            raw: m,
            meta: {
              creative: {
                hookType: m.hookType ?? '',
                emotionArc: m.emotionArc ?? '',
                pacing: m.pacing ?? '',
                ctaType: m.ctaType ?? '',
                visualStyle: m.visualStyle ?? '',
              },
            },
          })
          kept++
        }
      }
      ctx.log(`抱抱米创意库：命中并入库 ${kept} 条爆量素材（→ 创意洞察）`, {})
    }

    // ---- EXTRA (best-effort): hot creatives, filtered to project. Small limit; skip on slow.
    if (tools.includes('get_hot_creatives')) {
      try {
        const creatives = asArray(await mcp.call('get_hot_creatives', { hours: 168, limit: 20 }, 22_000))
        let kept = 0
        for (const c of creatives) {
          const desc = String(c.desc ?? c.description ?? '').trim()
          const products = Array.isArray(c.products) ? (c.products as string[]).join(' ') : String(c.products ?? '')
          if (!desc || !mentionsProject(`${desc} ${products}`, terms)) continue
          const link = String(c.link ?? c.video_url ?? '')
          const key = String(c.awemeId ?? c.aweme_id ?? link)
          if (seen.has(key)) continue
          seen.add(key)
          docs.push({
            source: {
              connector: 'baobaomi',
              sourceType: 'community',
              name: `抱抱米爆量榜 · ${String(c.creator ?? '抖音达人')}`,
              url: link || null,
              platform: 'baobaomi:douyin',
              ownerKey: `douyin:${String(c.creator ?? 'unknown')}`,
              authorityPrior: 0.4,
              licenseNote: '抖音广告创意（经抱抱米采集），创意参考；来源回指原视频',
            },
            doc: {
              canonicalUrl: link || `baobaomi://creative/${key}`,
              url: link || undefined,
              docType: 'creative_ref',
              title: desc.slice(0, 60) || '抖音爆量素材',
              authorHandle: String(c.creator ?? ''),
              publishedAt: c.scoredAt ? String(c.scoredAt) : null,
            },
            text: [
              `素材文案：${desc}`,
              c.adScore !== undefined ? `投放强度评分：${c.adScore}` : '',
              c.digg !== undefined ? `点赞：${c.digg}` : '',
              c.velocity !== undefined ? `增速：${c.velocity}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            lang: 'zh',
            raw: c,
          })
          kept++
        }
        if (kept > 0) ctx.log(`抱抱米爆量榜：命中项目 ${kept} 条`, {})
      } catch (err) {
        ctx.log(`抱抱米爆量榜跳过（服务端较慢）: ${String((err as Error).message).slice(0, 100)}`, {})
      }
    }

    // ---- EXTRA (best-effort): trending topics mentioning the project → market context
    if (tools.includes('get_trending_topics')) {
      try {
        const topics = asArray(await mcp.call('get_trending_topics', { limit: 15 }, 22_000))
        let kept = 0
        for (const t of topics) {
          const title = String(t.title ?? t.topic ?? t.name ?? '').trim()
          const summary = String(t.summary ?? t.desc ?? '').trim()
          if (!title || !mentionsProject(`${title} ${summary}`, terms)) continue
          const url = String(t.url ?? t.link ?? '')
          docs.push({
            source: {
              connector: 'baobaomi',
              sourceType: 'market',
              name: `抱抱米热点 · ${String(t.source ?? '全网')}`,
              url: url || null,
              platform: `baobaomi:trend`,
              ownerKey: `baobaomi:trend`,
              authorityPrior: 0.45,
              licenseNote: '经抱抱米聚合的公开热点（二手来源）',
            },
            doc: { canonicalUrl: url || `baobaomi://trend/${encodeURIComponent(title)}`, url: url || undefined, docType: 'page', title: `热点：${title}` },
            text: [title, summary, t.heat ? `热度：${t.heat}` : ''].filter(Boolean).join('\n'),
            lang: 'zh',
            raw: t,
          })
          kept++
        }
        if (kept > 0) ctx.log(`抱抱米热点：命中项目 ${kept} 条`, {})
      } catch (err) {
        ctx.log(`抱抱米热点跳过（服务端较慢）: ${String((err as Error).message).slice(0, 100)}`, {})
      }
    }

    ctx.log(`抱抱米共产出 ${docs.length} 个文档`, {})
    return docs
  },
}
