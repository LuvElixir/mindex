import { effectiveTikhub } from '../core/settings.js'

/**
 * Minimal TikHub (https://tikhub.io) API client. TikHub is a paid multi-platform
 * aggregator (Xiaohongshu, Weibo, Zhihu, Douyin, Kuaishou, …). Bearer auth.
 * Used by the Xiaohongshu connector; kept generic so other platforms can reuse it.
 */

export interface TikHubResult<T = unknown> {
  ok: boolean
  status: number
  json: T | null
  error?: string
}

export function tikhubConfigured(): boolean {
  return Boolean(effectiveTikhub().apiKey)
}

/**
 * Parse a TikHub response. With bigIntSafe, 16+ 位裸整数先加引号再解析——快手把 photo_id 这类
 * 19 位雪花 ID 当裸 JSON number 下发，JSON.parse 会丢精度（尾数变 000），用它查评论就 400。
 * 该正则对结构复杂的响应（如抖音）可能误伤，故默认关闭，仅需要保 ID 精度的平台按需开启。
 */
export function parseTikhubJson<T = unknown>(text: string, bigIntSafe = false): T | null {
  try {
    return JSON.parse(bigIntSafe ? text.replace(/(:\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"') : text) as T
  } catch {
    return null
  }
}

export async function tikhubGet<T = unknown>(
  pathname: string,
  params: Record<string, string | number | undefined>,
  timeoutMs = 30_000,
  bigIntSafe = false,
): Promise<TikHubResult<T>> {
  const { baseUrl, apiKey } = effectiveTikhub()
  if (!apiKey) return { ok: false, status: 0, json: null, error: 'no_api_key' }
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
  const url = `${baseUrl}${pathname}?${qs}`
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, json: parseTikhubJson<T>(text, bigIntSafe), error: res.ok ? undefined : text.slice(0, 160) }
  } catch (err) {
    return { ok: false, status: 0, json: null, error: String(err).slice(0, 160) }
  }
}

export async function tikhubPost<T = unknown>(
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<TikHubResult<T>> {
  const { baseUrl, apiKey } = effectiveTikhub()
  if (!apiKey) return { ok: false, status: 0, json: null, error: 'no_api_key' }
  try {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, json: parseTikhubJson<T>(text), error: res.ok ? undefined : text.slice(0, 160) }
  } catch (err) {
    return { ok: false, status: 0, json: null, error: String(err).slice(0, 160) }
  }
}

/**
 * Recursively collect EVERY object that contains `key` (deduped, capped). More robust than
 * findArray for TikHub's nested card/feed/comment-map structures where the target objects are
 * scattered across branches rather than sitting in one clean array.
 */
export function collectByKey(root: unknown, key: string, limit = 300): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const seen = new Set<unknown>()
  function walk(o: unknown): void {
    if (out.length >= limit || !o || typeof o !== 'object' || seen.has(o)) return
    seen.add(o)
    if (Array.isArray(o)) {
      for (const v of o) walk(v)
      return
    }
    const rec = o as Record<string, unknown>
    if (key in rec) out.push(rec)
    for (const v of Object.values(rec)) walk(v)
  }
  walk(root)
  return out
}

/** Deep-find the first array of objects whose items look like the target (by key presence). */
export function findArray(root: unknown, hasKey: string): Record<string, unknown>[] | null {
  const seen = new Set<unknown>()
  function walk(o: unknown): Record<string, unknown>[] | null {
    if (!o || typeof o !== 'object' || seen.has(o)) return null
    seen.add(o)
    if (Array.isArray(o)) {
      if (o.length > 0 && o[0] && typeof o[0] === 'object' && hasKey in (o[0] as object)) return o as Record<string, unknown>[]
      for (const item of o) {
        const f = walk(item)
        if (f) return f
      }
      return null
    }
    for (const v of Object.values(o as Record<string, unknown>)) {
      const f = walk(v)
      if (f) return f
    }
    return null
  }
  return walk(root)
}
