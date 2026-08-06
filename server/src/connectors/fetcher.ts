import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { config } from '../config.js'

/**
 * Polite outbound HTTP: identifies itself, rate-limits per host, honors Retry-After.
 * Optional per-fetch `proxy` routes through config.proxyUrl (快代理隧道) for hosts that
 * block the server's own IDC IP — kept opt-in so normal traffic stays direct.
 */

let proxyAgent: ProxyAgent | null | undefined
function getProxyAgent(): ProxyAgent | null {
  if (proxyAgent !== undefined) return proxyAgent
  proxyAgent = config.proxyUrl ? new ProxyAgent(config.proxyUrl) : null
  return proxyAgent
}

export interface FetchResult {
  ok: boolean
  status: number
  text: string
  json: unknown | null
  finalUrl: string
  error?: string
}

interface RobotsRules {
  disallow: string[]
  allow: string[]
}

/** Hosts with stricter published/observed limits than our default. */
const HOST_RPM_OVERRIDES: Record<string, number> = {
  'itunes.apple.com': 10, // Apple documents ~20/min per IP; stay well under
}

export class Fetcher {
  private lastHit = new Map<string, number>()
  private robotsCache = new Map<string, RobotsRules | null>()
  private minIntervalMs: number

  constructor(rpmPerHost = config.fetchRpmPerHost) {
    this.minIntervalMs = Math.ceil(60_000 / Math.max(1, rpmPerHost))
  }

  async fetch(url: string, init?: { headers?: Record<string, string>; timeoutMs?: number; proxy?: boolean }): Promise<FetchResult> {
    const host = new URL(url).host
    await this.throttle(host)
    const dispatcher = init?.proxy ? getProxyAgent() : null
    // 隧道代理经大陆出口 + 目标页可能很大（TapTap ~240KB），给足超时
    const timeout = init?.timeoutMs ?? (dispatcher ? 45_000 : 20_000)
    // 关键：走代理时必须用 undici 自己的 fetch，否则 dispatcher 与 Node 内置 undici 版本不符会报 invalid onRequestStart
    const doFetch = (dispatcher ? undiciFetch : fetch) as (u: string, o: Record<string, unknown>) => Promise<Response>
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await doFetch(url, {
          headers: { 'user-agent': config.fetchUserAgent, ...init?.headers },
          signal: AbortSignal.timeout(timeout),
          redirect: 'follow',
          ...(dispatcher ? { dispatcher } : {}),
        })
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          const retryAfter = Number(res.headers.get('retry-after')) || 3
          await sleep(Math.min(retryAfter, 15) * 1000)
          continue
        }
        const text = await res.text()
        let json: unknown | null = null
        const ct = res.headers.get('content-type') || ''
        const trimmed = text.trimStart()
        // iTunes serves JSON as text/javascript with leading blank lines — sniff the body, not just the header
        if (ct.includes('json') || ct.includes('javascript') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            json = JSON.parse(trimmed)
          } catch {
            json = null
          }
        }
        return { ok: res.ok, status: res.status, text, json, finalUrl: res.url || url }
      } catch (err) {
        if (attempt === 0) {
          await sleep(2000)
          continue
        }
        return { ok: false, status: 0, text: '', json: null, finalUrl: url, error: String(err) }
      }
    }
    return { ok: false, status: 0, text: '', json: null, finalUrl: url, error: 'unreachable' }
  }

  /**
   * robots.txt verdict for a URL. Policy:
   *  strict — callers must skip disallowed URLs
   *  log    — fetch anyway but record the status (operator's choice)
   *  off    — no check
   */
  async robotsVerdict(url: string): Promise<'allowed' | 'disallowed' | 'unknown'> {
    if (config.robotsPolicy === 'off') return 'unknown'
    const u = new URL(url)
    let rules = this.robotsCache.get(u.host)
    if (rules === undefined) {
      rules = await this.loadRobots(u.origin)
      this.robotsCache.set(u.host, rules)
    }
    if (!rules) return 'unknown'
    const path = u.pathname + u.search
    const matchLen = (patterns: string[]) => {
      let best = -1
      for (const p of patterns) {
        if (p === '') continue
        if (pathMatches(path, p)) best = Math.max(best, p.length)
      }
      return best
    }
    const dis = matchLen(rules.disallow)
    const allow = matchLen(rules.allow)
    if (dis === -1) return 'allowed'
    return allow >= dis ? 'allowed' : 'disallowed'
  }

  shouldSkip(verdict: 'allowed' | 'disallowed' | 'unknown'): boolean {
    return config.robotsPolicy === 'strict' && verdict === 'disallowed'
  }

  private async loadRobots(origin: string): Promise<RobotsRules | null> {
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { 'user-agent': config.fetchUserAgent },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return null
      const text = await res.text()
      return parseRobots(text)
    } catch {
      return null
    }
  }

  private async throttle(host: string): Promise<void> {
    const rpm = HOST_RPM_OVERRIDES[host]
    const interval = rpm ? Math.ceil(60_000 / rpm) : this.minIntervalMs
    const last = this.lastHit.get(host) ?? 0
    const wait = last + interval - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastHit.set(host, Date.now())
  }
}

/** Extract rules from the `User-agent: *` group (we do not masquerade as another bot). */
export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [] }
  let applies = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!.trim()
    if (key === 'user-agent') {
      applies = value === '*' || config.fetchUserAgent.toLowerCase().includes(value.toLowerCase())
    } else if (applies && key === 'disallow' && value) {
      rules.disallow.push(value)
    } else if (applies && key === 'allow' && value) {
      rules.allow.push(value)
    }
  }
  return rules
}

function pathMatches(path: string, pattern: string): boolean {
  // robots patterns support * wildcard and $ end anchor
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const anchored = esc.endsWith('\\$') ? `^${esc.slice(0, -2)}$` : `^${esc}`
  return new RegExp(anchored).test(path)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Minimal HTML → readable text (no heavy readability dependency). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

export function extractHtmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? htmlToText(m[1]!).slice(0, 200) : ''
}
