import { afterAll, beforeAll, describe, expect, it } from 'vitest'

process.env.MINDEX_ADMIN_TOKEN = 'test-admin-token'
process.env.MINDEX_LLM_PROVIDER = 'none'

const { memoryDb } = await import('../src/db/index.js')
const { Store } = await import('../src/core/store.js')
const { buildServer } = await import('../src/api/server.js')
const { createApiKey } = await import('../src/api/auth.js')

import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
let store: InstanceType<typeof Store>
let projectA: string
let projectB: string
let claimA: string
let claimB: string
let uncertainClaimA: string
let tokenA: string
let tokenContext: string

function seedClaim(projectId: string, text: string, band: 'verified' | 'uncertain', quote: string): string {
  const src = store.upsertSource({
    projectId,
    connector: 'web',
    sourceType: 'official',
    name: `官网-${projectId}`,
    url: `https://example-${projectId}.com/news`,
    ownerKey: `example-${projectId}.com`,
    authorityPrior: 0.9,
  })
  const doc = store.upsertDocument({ sourceId: src.id, projectId, canonicalUrl: `https://example-${projectId}.com/news/${text.length}` })
  const snap = store.insertSnapshot({ documentId: doc.id, projectId, text: `公告全文：${quote}，详情见官网。` })
  const ev = store.insertEvidence({ projectId, snapshotId: snap.id, sourceId: src.id, quote })
  const claimId = store.createClaim({
    projectId,
    claimType: 'official_fact',
    text,
    extractionProvider: 'heuristic',
    evidence: [{ evidenceId: ev }],
  })
  store.updateClaimScore(
    claimId,
    band === 'verified' ? 0.9 : 0.4,
    band,
    { factors: [] },
    band === 'verified' ? 'auto_accepted' : 'pending',
  )
  return claimId
}

beforeAll(async () => {
  store = new Store(memoryDb())
  app = await buildServer(store, { logger: false })

  projectA = store.createProject({ name: '游戏Alpha', kind: 'game' }).id
  projectB = store.createProject({ name: '游戏Beta', kind: 'game' }).id
  claimA = seedClaim(projectA, '《游戏Alpha》将于2026年10月上线新版本', 'verified', '《游戏Alpha》将于2026年10月上线新版本')
  claimB = seedClaim(projectB, '《游戏Beta》的开发商是Beta工作室', 'verified', '《游戏Beta》的开发商是Beta工作室')
  uncertainClaimA = seedClaim(projectA, '《游戏Alpha》月流水可能超过一亿', 'uncertain', '有传闻称月流水破亿')

  tokenA = createApiKey(store.db, { name: 'agent-a', scopes: ['knowledge:read'], projectIds: [projectA] }).token
  tokenContext = createApiKey(store.db, { name: 'agent-ctx', scopes: ['knowledge:read', 'context:read'], projectIds: ['*'] }).token
})

afterAll(async () => {
  await app.close()
})

describe('agent plane — authentication', () => {
  it('rejects requests without an API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=测试' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects garbage tokens', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=测试', headers: { authorization: 'Bearer mdx_live_fake' } })
    expect(res.statusCode).toBe(401)
  })

  it('accepts a valid key and reports its access via /meta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta', headers: { authorization: `Bearer ${tokenA}` } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.key_name).toBe('agent-a')
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual([projectA])
  })
})

describe('agent plane — project isolation', () => {
  it('search with a project-A key never returns project-B claims', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=开发商', headers: { authorization: `Bearer ${tokenA}` } })
    expect(res.statusCode).toBe(200)
    const ids = res.json().hits.map((h: { claim: { id: string } }) => h.claim.id)
    expect(ids).not.toContain(claimB)
  })

  it('explicitly querying project B with a project-A key is forbidden', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/search?q=开发商&project_id=${projectB}`,
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('reading a project-B claim with a project-A key is forbidden', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/claims/${claimB}`, headers: { authorization: `Bearer ${tokenA}` } })
    expect(res.statusCode).toBe(403)
  })

  it('reading an own-project claim returns the full provenance chain', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/claims/${claimA}`, headers: { authorization: `Bearer ${tokenA}` } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.evidence.length).toBeGreaterThan(0)
    expect(body.evidence[0].quote).toContain('游戏Alpha')
    expect(body.evidence[0].source_name).toBeTruthy()
    expect(body.evidence[0].fetched_at).toBeTruthy()
  })
})

describe('agent plane — scopes', () => {
  it('a knowledge:read key cannot request context packs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/context-pack',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { project_id: projectA },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('insufficient_scope')
  })
})

describe('agent plane — trusted knowledge only', () => {
  it('search excludes pending/uncertain claims by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=月流水', headers: { authorization: `Bearer ${tokenA}` } })
    const ids = res.json().hits.map((h: { claim: { id: string } }) => h.claim.id)
    expect(ids).not.toContain(uncertainClaimA)
  })

  it('context packs only include trusted claims and DECLARE exclusions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/context-pack',
      headers: { authorization: `Bearer ${tokenContext}` },
      payload: { project_id: projectA },
    })
    expect(res.statusCode).toBe(200)
    const pack = res.json()
    const packIds = pack.product_facts.map((i: { id: string }) => i.id)
    expect(packIds).toContain(claimA)
    expect(packIds).not.toContain(uncertainClaimA)
    expect(pack.excluded.by_band.uncertain).toBeGreaterThanOrEqual(1)
    // every citation must reference REAL evidence in the DB
    for (const item of pack.product_facts) {
      for (const c of item.citations) {
        const row = store.db.prepare(`SELECT id FROM evidence WHERE id = ?`).get(c.evidence_id)
        expect(row).toBeTruthy()
      }
    }
  })
})

describe('agent plane — key lifecycle', () => {
  it('revoked keys stop working immediately', async () => {
    const { key, token } = createApiKey(store.db, { name: 'to-revoke', scopes: ['knowledge:read'], projectIds: ['*'] })
    const ok = await app.inject({ method: 'GET', url: '/api/v1/meta', headers: { authorization: `Bearer ${token}` } })
    expect(ok.statusCode).toBe(200)
    const { revokeApiKey } = await import('../src/api/auth.js')
    revokeApiKey(store.db, key.id)
    const denied = await app.inject({ method: 'GET', url: '/api/v1/meta', headers: { authorization: `Bearer ${token}` } })
    expect(denied.statusCode).toBe(401)
  })

  it('rotation issues a new token and keeps the old one alive during grace', async () => {
    const { key, token: oldToken } = createApiKey(store.db, { name: 'to-rotate', scopes: ['knowledge:read'], projectIds: ['*'] })
    const { rotateApiKey } = await import('../src/api/auth.js')
    const rotated = rotateApiKey(store.db, key.id, 24)!
    expect(rotated.token).not.toBe(oldToken)
    const oldOk = await app.inject({ method: 'GET', url: '/api/v1/meta', headers: { authorization: `Bearer ${oldToken}` } })
    expect(oldOk.statusCode).toBe(200)
    const newOk = await app.inject({ method: 'GET', url: '/api/v1/meta', headers: { authorization: `Bearer ${rotated.token}` } })
    expect(newOk.statusCode).toBe(200)
    // zero-grace rotation kills the old key at once
    const { key: k2, token: t2 } = createApiKey(store.db, { name: 'rotate-now', scopes: ['knowledge:read'], projectIds: ['*'] })
    rotateApiKey(store.db, k2.id, 0)
    const dead = await app.inject({ method: 'GET', url: '/api/v1/meta', headers: { authorization: `Bearer ${t2}` } })
    expect(dead.statusCode).toBe(401)
  })

  it('expired keys are rejected', async () => {
    const { token } = createApiKey(store.db, {
      name: 'expired',
      scopes: ['knowledge:read'],
      projectIds: ['*'],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(401)
  })
})

describe('agent plane — rate limiting & audit logs', () => {
  it('enforces per-key RPM limits', async () => {
    const { token } = createApiKey(store.db, { name: 'tiny-limit', scopes: ['knowledge:read'], projectIds: ['*'], rateLimitRpm: 10 })
    let last = 0
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/meta', headers: { authorization: `Bearer ${token}` } })
      last = res.statusCode
    }
    expect(last).toBe(429)
  })

  it('records api call logs with key id, route, status and latency', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/search?q=版本', headers: { authorization: `Bearer ${tokenA}` } })
    const log = store.db
      .prepare(`SELECT l.* FROM api_logs l JOIN api_keys k ON k.id = l.key_id WHERE k.name = 'agent-a' ORDER BY l.id DESC LIMIT 1`)
      .get() as Record<string, unknown>
    expect(log).toBeTruthy()
    expect(log.route).toBe('/api/v1/search')
    expect(log.status).toBe(200)
    expect(log.duration_ms).toBeGreaterThanOrEqual(0)
  })
})

describe('management plane', () => {
  it('rejects wrong admin tokens', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/overview', headers: { authorization: 'Bearer wrong-token' } })
    expect(res.statusCode).toBe(401)
  })

  it('accepts the admin token and creates projects', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/app/projects',
      headers: { authorization: 'Bearer test-admin-token' },
      payload: { name: '新项目', kind: 'game' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('新项目')
  })

  it('api keys listing never exposes token hashes or plaintext', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/keys', headers: { authorization: 'Bearer test-admin-token' } })
    const body = JSON.stringify(res.json())
    expect(body).not.toContain('mdx_live_')
    expect(body).not.toContain('token_hash')
  })
})

describe('admin: delete research run', () => {
  it('删除已结束 run 及其事件，claims 不受影响', async () => {
    const runId = 'run_test_del_1'
    store.db.prepare(`INSERT INTO research_runs (id, project_id, goal, status, started_at, finished_at) VALUES (?, ?, '测试', 'done', ?, ?)`)
      .run(runId, projectA, new Date().toISOString(), new Date().toISOString())
    store.db.prepare(`INSERT INTO run_events (run_id, phase, level, message, detail, at) VALUES (?, 'plan', 'info', 'x', '{}', ?)`)
      .run(runId, new Date().toISOString())
    const res = await app.inject({ method: 'DELETE', url: `/app/runs/${runId}`, headers: { authorization: 'Bearer test-admin-token' } })
    expect(res.statusCode).toBe(200)
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM research_runs WHERE id = ?`).get(runId) as { n: number }).n).toBe(0)
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`).get(runId) as { n: number }).n).toBe(0)
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE project_id = ?`).get(projectA) as { n: number }).n).toBeGreaterThan(0)
  })
  it('运行中的 run 拒绝删除；未知 id 404；无 token 401', async () => {
    const runId = 'run_test_del_2'
    store.db.prepare(`INSERT INTO research_runs (id, project_id, goal, status, started_at) VALUES (?, ?, '测试', 'running', ?)`)
      .run(runId, projectA, new Date().toISOString())
    const active = await app.inject({ method: 'DELETE', url: `/app/runs/${runId}`, headers: { authorization: 'Bearer test-admin-token' } })
    expect(active.statusCode).toBe(409)
    const missing = await app.inject({ method: 'DELETE', url: '/app/runs/run_nope', headers: { authorization: 'Bearer test-admin-token' } })
    expect(missing.statusCode).toBe(404)
    const noauth = await app.inject({ method: 'DELETE', url: `/app/runs/${runId}` })
    expect(noauth.statusCode).toBe(401)
  })
})

describe('admin: project kind restricted to game', () => {
  it('项目类型只接受 game', async () => {
    const res = await app.inject({ method: 'POST', url: '/app/projects', headers: { authorization: 'Bearer test-admin-token' }, payload: { name: '非游测试', kind: 'brand' } })
    expect(res.statusCode).toBe(400)
  })
})

describe('admin: duplicate research guard', () => {
  it('30 分钟内同目标已完成 → 409 duplicate_recent；force 放行', async () => {
    const auth = { authorization: 'Bearer test-admin-token' }
    store.db.prepare(`INSERT INTO research_runs (id, project_id, goal, status, started_at, finished_at) VALUES ('run_dup_g', ?, '全面了解产品、受众与玩家口碑', 'done', ?, ?)`)
      .run(projectB, new Date().toISOString(), new Date().toISOString())
    const dup = await app.inject({ method: 'POST', url: `/app/projects/${projectB}/research`, headers: auth, payload: {} })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error).toBe('duplicate_recent')
    const forced = await app.inject({ method: 'POST', url: `/app/projects/${projectB}/research`, headers: auth, payload: { force: true } })
    expect(forced.statusCode).toBe(200)
    expect(forced.json().run_id).toMatch(/^run_/)
  })
})

describe('admin: knowledge graph data', () => {
  it('返回项目节点、实体节点与共现边；无 token 401', async () => {
    // seed: projectA 两个实体共享 2 条 claims → 应产生共现边
    const entA = 'ent_graph_a'
    const entB = 'ent_graph_b'
    store.db.prepare(`INSERT INTO entities (id, project_id, entity_type, canonical_name) VALUES (?, ?, 'character', '钟离')`).run(entA, projectA)
    store.db.prepare(`INSERT INTO entities (id, project_id, entity_type, canonical_name) VALUES (?, ?, 'feature', '抽卡')`).run(entB, projectA)
    const c1 = seedClaim(projectA, '《游戏Alpha》角色钟离与抽卡系统相关结论一', 'verified', '《游戏Alpha》角色钟离与抽卡系统相关结论一')
    const c2 = seedClaim(projectA, '《游戏Alpha》角色钟离与抽卡系统相关结论二', 'verified', '《游戏Alpha》角色钟离与抽卡系统相关结论二')
    for (const c of [c1, c2]) for (const e of [entA, entB]) {
      store.db.prepare(`INSERT OR IGNORE INTO claim_entities (claim_id, entity_id, role) VALUES (?, ?, 'mentions')`).run(c, e)
    }
    const res = await app.inject({ method: 'GET', url: '/app/graph', headers: { authorization: 'Bearer test-admin-token' } })
    expect(res.statusCode).toBe(200)
    const g = res.json() as { nodes: { id: string; type: string; label: string }[]; edges: { source: string; target: string }[] }
    expect(g.nodes.some((n) => n.type === 'project' && n.label === '游戏Alpha')).toBe(true)
    expect(g.nodes.some((n) => n.type === 'character' && n.label === '钟离')).toBe(true)
    // 项目→实体边
    expect(g.edges.some((e) => e.source === projectA && e.target === entA)).toBe(true)
    // 实体共现边（共享 2 条 claims）
    expect(g.edges.some((e) => (e.source === entA && e.target === entB) || (e.source === entB && e.target === entA))).toBe(true)
    const noauth = await app.inject({ method: 'GET', url: '/app/graph' })
    expect(noauth.statusCode).toBe(401)
  })
  it('claims 列表支持 entity_id 过滤', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/app/projects/${projectA}/claims?entity_id=ent_graph_a`,
      headers: { authorization: 'Bearer test-admin-token' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { total: number; claims: { text: string }[] }
    expect(body.total).toBe(2)
    expect(body.claims.every((c) => c.text.includes('钟离'))).toBe(true)
  })
})

describe('admin: chat (对话式检索)', () => {
  const auth = { authorization: 'Bearer test-admin-token' }
  it('库内有相关知识 → 返回非空回答与引用（provider=none 诚实降级）', async () => {
    const res = await app.inject({ method: 'POST', url: '/app/chat', headers: auth, payload: { question: '游戏Beta的开发商是谁' } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { answer: string; citations: { claim_id: string; text: string }[]; insufficient: boolean }
    expect(body.answer.length).toBeGreaterThan(0)
    expect(body.citations.some((c) => c.text.includes('Beta工作室'))).toBe(true)
  })
  it('库内无相关知识 → insufficient 且不编造', async () => {
    const res = await app.inject({ method: 'POST', url: '/app/chat', headers: auth, payload: { question: '量子引力波烹饪技巧' } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { answer: string; citations: unknown[]; insufficient: boolean }
    expect(body.insufficient).toBe(true)
    expect(body.citations).toEqual([])
  })
  it('无 token 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/app/chat', payload: { question: 'x' } })
    expect(res.statusCode).toBe(401)
  })
})

describe('admin: chat stream (SSE)', () => {
  const auth = { authorization: 'Bearer test-admin-token' }
  it('有命中：stage 事件带 hits+project_ids，done 事件带引用', async () => {
    const res = await app.inject({ method: 'POST', url: '/app/chat/stream', headers: auth, payload: { question: '游戏Beta的开发商是谁' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const body = res.payload
    expect(body).toContain('event: stage')
    expect(body).toContain('event: done')
    const stage = JSON.parse(body.split('event: stage')[1]!.split('data: ')[1]!.split('\n')[0]!)
    expect(stage.hits).toBeGreaterThan(0)
    expect(Array.isArray(stage.project_ids)).toBe(true)
    const done = JSON.parse(body.split('event: done')[1]!.split('data: ')[1]!.split('\n')[0]!)
    expect(done.answer.length).toBeGreaterThan(0)
    expect(done.citations.length).toBeGreaterThan(0)
    expect(done.citations[0].n).toBeGreaterThanOrEqual(1)
  })
  it('无命中：直接 done + insufficient', async () => {
    const res = await app.inject({ method: 'POST', url: '/app/chat/stream', headers: auth, payload: { question: '量子引力波烹饪技巧' } })
    const done = JSON.parse(res.payload.split('event: done')[1]!.split('data: ')[1]!.split('\n')[0]!)
    expect(done.insufficient).toBe(true)
    expect(done.citations).toEqual([])
  })
})

describe('admin: import-url validation', () => {
  const auth = { authorization: 'Bearer test-admin-token' }
  it('非法 URL → 400；未知项目 → 404', async () => {
    const bad = await app.inject({ method: 'POST', url: `/app/projects/${projectA}/import-url`, headers: auth, payload: { url: 'not-a-url' } })
    expect(bad.statusCode).toBe(400)
    const missing = await app.inject({ method: 'POST', url: '/app/projects/prj_nope/import-url', headers: auth, payload: { url: 'https://example.com/a' } })
    expect(missing.statusCode).toBe(404)
  })
})

describe('OpenAPI surface', () => {
  it('documents agent endpoints but hides the management plane', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)
    const spec = res.json()
    const paths = Object.keys(spec.paths)
    expect(paths).toContain('/api/v1/search')
    expect(paths).toContain('/api/v1/context-pack')
    expect(paths.some((p) => p.startsWith('/app'))).toBe(false)
  })
  it('写入端点自描述：import-reviews 的 OpenAPI 描述携带完整格式契约', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    const spec = res.json()
    const paths = Object.keys(spec.paths)
    for (const p of ['/api/v1/projects', '/api/v1/projects/{id}/research', '/api/v1/projects/{id}/import', '/api/v1/projects/{id}/import-url', '/api/v1/projects/{id}/import-reviews']) {
      expect(paths).toContain(p)
    }
    const desc = spec.paths['/api/v1/projects/{id}/import-reviews'].post.description as string
    expect(desc).toContain('Markdown 格式')
    expect(desc).toContain('JSON 格式')
    expect(desc).toContain('不要改写')
  })
})

describe('agent plane: knowledge:write（管理员级 Agent 接入）', () => {
  const auth = () => ({ authorization: `Bearer ${tokenWrite}` })
  let tokenWrite: string
  let tokenWriteScoped: string

  beforeAll(() => {
    tokenWrite = createApiKey(store.db, { name: 'hermes-admin', scopes: ['knowledge:read', 'context:read', 'knowledge:write'], projectIds: ['*'] }).token
    tokenWriteScoped = createApiKey(store.db, { name: 'hermes-scoped', scopes: ['knowledge:write'], projectIds: [projectA] }).token
  })

  it('只读 Key 调写入端点 → 403 insufficient_scope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectA}/import-reviews`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { format: 'json', reviews: [{ content: '后期太肝了，每天大量日常任务' }] },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('insufficient_scope')
  })

  it('write Key 导入评论 → run_id + parsed_reviews；点赞不进置信度语义由管线保证', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectA}/import-reviews`,
      headers: auth(),
      payload: {
        platform: 'taptap',
        format: 'json',
        reviews: [
          { content: '后期太肝了，每天大量日常任务，体力恢复也慢，玩得很累。', score: 2, up_count: 23 },
          { content: '美术和音乐都在线，就是抽卡概率有点感人。', score: 4 },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().run_id).toMatch(/^run_/)
    expect(res.json().parsed_reviews).toBe(2)
  })

  it('项目隔离：绑定 projectA 的 Key 不能写 projectB；受限 Key 不能建项目', async () => {
    const cross = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectB}/import-reviews`,
      headers: { authorization: `Bearer ${tokenWriteScoped}` },
      payload: { format: 'json', reviews: [{ content: '这条不应该进入 projectB 的库' }] },
    })
    expect(cross.statusCode).toBe(403)
    expect(cross.json().error).toBe('project_forbidden')
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${tokenWriteScoped}` },
      payload: { name: '越权项目' },
    })
    expect(create.statusCode).toBe(403)
  })

  it('全项目 write Key 可建项目', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth(), payload: { name: 'Agent建的项目' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toMatch(/^prj_/)
  })
})

describe('login verification endpoint', () => {
  it('is reachable without auth and validates tokens', async () => {
    const ok = await app.inject({ method: 'POST', url: '/app/verify', payload: { token: 'test-admin-token' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().ok).toBe(true)
    const bad = await app.inject({ method: 'POST', url: '/app/verify', payload: { token: 'nope' } })
    expect(bad.json().ok).toBe(false)
  })
})
