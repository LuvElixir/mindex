const TOKEN_KEY = 'mindex_admin_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = '') {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      // content-type only when there is a body — fastify 400s on empty JSON bodies
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${getToken() ?? ''}`,
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 401) {
    clearToken()
    if (!location.pathname.startsWith('/login')) location.href = '/login'
    throw new ApiError(401, 'unauthorized')
  }
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = { error: text }
  }
  if (!res.ok) {
    const b = body as { message?: string; error?: string }
    throw new ApiError(res.status, b.message ?? b.error ?? `HTTP ${res.status}`, b.error ?? '')
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export async function verifyToken(token: string): Promise<boolean> {
  const res = await fetch('/app/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) return false
  const body = (await res.json()) as { ok: boolean }
  return body.ok
}

// ---------- shared formatting ----------

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${fmtDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function seqNum(n: number | undefined | null): string {
  return String(n ?? 0).padStart(3, '0')
}

export const TYPE_LABEL: Record<string, string> = {
  official_fact: '官方事实',
  player_opinion: '玩家观点',
  system_inference: '系统推断',
  creative_insight: '创意洞察',
}

export const TYPE_ZH = TYPE_LABEL

export const BAND_LABEL: Record<string, string> = {
  verified: '已验证',
  likely: '较可信',
  uncertain: '不确定',
  disputed: '存在冲突',
  insufficient: '证据不足',
}

export const BAND_ZH = BAND_LABEL

export const STATE_ZH: Record<string, string> = {
  auto_accepted: '自动通过',
  pending: '待审核',
  approved: '人工通过',
  rejected: '已否决',
  merged: '已合并',
  expired: '已过期',
  quarantined: '已隔离',
}

export const TOPIC_ZH: Record<string, string> = {
  product: '产品',
  gameplay: '玩法',
  monetization: '付费',
  audience: '受众',
  market: '市场',
  brand: '品牌',
  creative: '创意',
  performance: '表现',
  other: '其他',
}
