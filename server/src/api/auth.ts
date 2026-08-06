import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DB } from '../db/index.js'
import { j, newId, now, pj } from '../lib/util.js'

/**
 * API keys — Stripe/GitHub style:
 *  token = mdx_live_<32 bytes base64url>; only sha256(token) is stored;
 *  plaintext shown exactly once at creation/rotation; display = prefix + last4.
 *  Scopes: knowledge:read | context:read | knowledge:write（写入=喂数据：建项目/发研究/导入；
 *  审核裁决与删除不对 Agent 开放——信任边界留给人）。Keys bind to project ids (["*"] = all).
 *  Rotation keeps the old key alive until grace_expires (24h default).
 */

export interface ApiKeyRow {
  id: string
  name: string
  scopes: string[]
  project_ids: string[]
  rate_limit_rpm: number
  last4: string
  created_at: string
  expires_at: string | null
  revoked_at: string | null
  rotated_from: string | null
  last_used_at: string | null
}

export const SCOPES = ['knowledge:read', 'context:read', 'knowledge:write'] as const
export type Scope = (typeof SCOPES)[number]

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createApiKey(
  db: DB,
  input: { name: string; scopes: Scope[]; projectIds: string[]; rateLimitRpm?: number; expiresAt?: string | null; rotatedFrom?: string | null },
): { key: ApiKeyRow; token: string } {
  const token = `mdx_live_${randomBytes(32).toString('base64url')}`
  const id = newId('key')
  db.prepare(
    `INSERT INTO api_keys (id, name, token_hash, last4, scopes, project_ids, rate_limit_rpm, created_at, expires_at, rotated_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    hashToken(token),
    token.slice(-4),
    j(input.scopes),
    j(input.projectIds),
    input.rateLimitRpm ?? 120,
    now(),
    input.expiresAt ?? null,
    input.rotatedFrom ?? null,
  )
  return { key: getApiKey(db, id)!, token }
}

export function getApiKey(db: DB, id: string): ApiKeyRow | null {
  const row = db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? hydrate(row) : null
}

export function listApiKeys(db: DB): ApiKeyRow[] {
  return (db.prepare(`SELECT * FROM api_keys ORDER BY created_at DESC`).all() as Record<string, unknown>[]).map(hydrate)
}

function hydrate(row: Record<string, unknown>): ApiKeyRow {
  const { token_hash: _drop, ...rest } = row
  return {
    ...(rest as object),
    scopes: pj(row.scopes as string, []),
    project_ids: pj(row.project_ids as string, []),
  } as unknown as ApiKeyRow
}

export function revokeApiKey(db: DB, id: string): boolean {
  const res = db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), id)
  return res.changes > 0
}

/** Rotate: new token, same permissions; old key stays valid for graceHours then dies. */
export function rotateApiKey(db: DB, id: string, graceHours = 24): { key: ApiKeyRow; token: string } | null {
  const old = getApiKey(db, id)
  if (!old || old.revoked_at) return null
  const grace = new Date(Date.now() + graceHours * 3600_000).toISOString()
  db.prepare(`UPDATE api_keys SET expires_at = COALESCE(MIN(COALESCE(expires_at, ?), ?), ?) WHERE id = ?`).run(grace, grace, grace, id)
  return createApiKey(db, {
    name: old.name,
    scopes: old.scopes as Scope[],
    projectIds: old.project_ids,
    rateLimitRpm: old.rate_limit_rpm,
    rotatedFrom: old.id,
  })
}

export interface AuthedKey {
  id: string
  name: string
  scopes: string[]
  projectIds: string[]
  rateLimitRpm: number
}

export function authenticateToken(db: DB, token: string): AuthedKey | null {
  if (!token.startsWith('mdx_')) return null
  const row = db
    .prepare(`SELECT id, name, scopes, project_ids, rate_limit_rpm, expires_at, revoked_at FROM api_keys WHERE token_hash = ?`)
    .get(hashToken(token)) as Record<string, unknown> | undefined
  if (!row) return null
  if (row.revoked_at) return null
  if (row.expires_at && (row.expires_at as string) <= now()) return null
  return {
    id: row.id as string,
    name: row.name as string,
    scopes: pj(row.scopes as string, []),
    projectIds: pj(row.project_ids as string, []),
    rateLimitRpm: (row.rate_limit_rpm as number) ?? 120,
  }
}

export function keyAllowsProject(key: AuthedKey, projectId: string): boolean {
  return key.projectIds.includes('*') || key.projectIds.includes(projectId)
}

export function touchKey(db: DB, keyId: string): void {
  db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(now(), keyId)
}

export function logApiRequest(db: DB, entry: { keyId: string | null; method: string; route: string; status: number; durationMs: number; ip: string }): void {
  db.prepare(`INSERT INTO api_logs (key_id, method, route, status, duration_ms, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    entry.keyId,
    entry.method,
    entry.route,
    entry.status,
    Math.round(entry.durationMs * 10) / 10,
    entry.ip,
    now(),
  )
}

/** Constant-time admin token check for the management plane. */
export function checkAdminToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
