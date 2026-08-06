import { afterAll, beforeAll, describe, expect, it } from 'vitest'

process.env.MINDEX_ADMIN_TOKEN = 'test-admin-token'
process.env.MINDEX_LLM_PROVIDER = 'none'
delete process.env.BAOBAOMI_AGENT_KEY

const { memoryDb } = await import('../src/db/index.js')
const { Store } = await import('../src/core/store.js')
const { buildServer } = await import('../src/api/server.js')
const { effectiveLlm, effectiveBaobaomi } = await import('../src/core/settings.js')
const { baobaomiConnector } = await import('../src/connectors/baobaomi.js')

import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
let store: InstanceType<typeof Store>
const auth = { authorization: 'Bearer test-admin-token' }

beforeAll(async () => {
  store = new Store(memoryDb())
  app = await buildServer(store, { logger: false })
})

afterAll(async () => {
  await app.close()
})

describe('settings API — 模型接入设置页', () => {
  it('requires admin auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/settings' })
    expect(res.statusCode).toBe(401)
  })

  it('returns masked secrets only, never full values', async () => {
    await app.inject({
      method: 'PUT',
      url: '/app/settings',
      headers: auth,
      payload: { anthropic_api_key: 'sk-ant-super-secret-value-12345678' },
    })
    const res = await app.inject({ method: 'GET', url: '/app/settings', headers: auth })
    expect(res.statusCode).toBe(200)
    const body = res.body
    expect(body).not.toContain('sk-ant-super-secret')
    const json = res.json()
    expect(json.llm.anthropic_api_key.configured).toBe(true)
    expect(json.llm.anthropic_api_key.last4).toBe('5678')
  })

  it('DB settings take precedence over env and apply without restart', async () => {
    // env says provider=none; settings page overrides to anthropic
    await app.inject({
      method: 'PUT',
      url: '/app/settings',
      headers: auth,
      payload: { llm_provider: 'anthropic', anthropic_model: 'claude-haiku-4-5' },
    })
    const s = effectiveLlm()
    expect(s.provider).toBe('anthropic')
    expect(s.anthropicModel).toBe('claude-haiku-4-5')
    expect(s.source.provider).toBe('db')
  })

  it('masks the OpenAI key and stores model + base url (OpenAI-compatible support)', async () => {
    await app.inject({
      method: 'PUT',
      url: '/app/settings',
      headers: auth,
      payload: { llm_provider: 'openai', openai_api_key: 'sk-openai-secret-abcd9999', openai_base_url: 'https://api.deepseek.com/v1', openai_model: 'deepseek-chat' },
    })
    const res = await app.inject({ method: 'GET', url: '/app/settings', headers: auth })
    const body = res.body
    expect(body).not.toContain('sk-openai-secret')
    const json = res.json()
    expect(json.llm.openai_api_key.configured).toBe(true)
    expect(json.llm.openai_api_key.last4).toBe('9999')
    expect(json.llm.openai_base_url).toBe('https://api.deepseek.com/v1')
    expect(json.llm.openai_model).toBe('deepseek-chat')
    const s = effectiveLlm()
    expect(s.provider).toBe('openai')
    expect(s.openaiModel).toBe('deepseek-chat')
    await app.inject({ method: 'PUT', url: '/app/settings', headers: auth, payload: { llm_provider: null, openai_api_key: null, openai_base_url: null, openai_model: null } })
  })

  it('clearing a setting (null) falls back to env/default', async () => {
    await app.inject({ method: 'PUT', url: '/app/settings', headers: auth, payload: { llm_provider: null, anthropic_api_key: null } })
    const s = effectiveLlm()
    expect(s.provider).toBe('none') // back to env value
    expect(s.anthropicApiKey).toBe('')
  })

  it('baobaomi settings: DB value wins, clearing falls back (status live-updates)', async () => {
    // dev machines may carry an env fallback key in .env — assert precedence, not absolute state
    await app.inject({ method: 'PUT', url: '/app/settings', headers: auth, payload: { baobaomi_agent_key: 'test-bbm-key-0000' } })
    expect(effectiveBaobaomi().agentKey).toBe('test-bbm-key-0000')
    expect(effectiveBaobaomi().source.agent_key).toBe('db')
    expect(baobaomiConnector.status).toBe('verified')
    await app.inject({ method: 'PUT', url: '/app/settings', headers: auth, payload: { baobaomi_agent_key: null } })
    expect(effectiveBaobaomi().source.agent_key).not.toBe('db')
    if (!effectiveBaobaomi().agentKey) expect(baobaomiConnector.status).toBe('needs_key')
  })

  it('test-llm reports honest degradation when no provider is available', async () => {
    await app.inject({ method: 'PUT', url: '/app/settings', headers: auth, payload: { llm_provider: 'none' } })
    const res = await app.inject({ method: 'POST', url: '/app/settings/test-llm', headers: auth })
    const json = res.json()
    expect(json.ok).toBe(false)
    expect(json.detail).toContain('降级')
    await app.inject({ method: 'PUT', url: '/app/settings', headers: auth, payload: { llm_provider: null } })
  })

  it('test-baobaomi fails honestly against an unreachable endpoint', async () => {
    await app.inject({
      method: 'PUT',
      url: '/app/settings',
      headers: auth,
      payload: { baobaomi_base_url: 'http://127.0.0.1:9', baobaomi_agent_key: 'test-unreachable' },
    })
    const res = await app.inject({ method: 'POST', url: '/app/settings/test-baobaomi', headers: auth })
    expect(res.json().ok).toBe(false)
    await app.inject({ method: 'PUT', url: '/app/settings', headers: auth, payload: { baobaomi_base_url: null, baobaomi_agent_key: null } })
  })
})
