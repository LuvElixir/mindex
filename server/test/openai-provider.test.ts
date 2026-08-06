import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Proves the OpenAI provider actually works against an OpenAI-COMPATIBLE endpoint
 * (the whole point of adding it — DeepSeek/MiniMax/Qwen/local all speak this shape).
 * A tiny mock server stands in for the real API, so no key/network is needed in CI.
 */

process.env.MINDEX_LLM_PROVIDER = 'none'

const { memoryDb } = await import('../src/db/index.js')
const { initSettings, setSetting } = await import('../src/core/settings.js')
const { resolveProvider } = await import('../src/llm/provider.js')

let mock: Server
let baseUrl = ''
const received: { model?: string; hasJsonFormat?: boolean; auth?: string } = {}

beforeAll(async () => {
  initSettings(memoryDb())
  mock = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      received.model = payload.model
      received.hasJsonFormat = payload.response_format?.type === 'json_object'
      received.auth = req.headers.authorization
      // emulate an OpenAI chat.completions response
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"claims":[{"text":"x","quotes":["y"]}]}' }, finish_reason: 'stop' }],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const addr = mock.address()
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}/v1`
})

afterAll(() => {
  mock.close()
})

describe('OpenAI provider against an OpenAI-compatible endpoint', () => {
  it('resolves to the openai provider from settings and calls chat.completions with JSON mode', async () => {
    setSetting('llm_provider', 'openai')
    setSetting('openai_api_key', 'sk-test-key')
    setSetting('openai_base_url', baseUrl)
    setSetting('openai_model', 'deepseek-chat')

    const provider = await resolveProvider()
    expect(provider).not.toBeNull()
    expect(provider!.name).toBe('openai')
    expect(provider!.model).toBe('deepseek-chat')

    const out = await provider!.completeJson({ system: 'only json', prompt: 'give json', maxTokens: 200 })
    expect(out).toEqual({ claims: [{ text: 'x', quotes: ['y'] }] })
    expect(received.model).toBe('deepseek-chat')
    expect(received.hasJsonFormat).toBe(true)
    expect(received.auth).toBe('Bearer sk-test-key')
  })

  it('errors clearly when provider=openai but no key is set', async () => {
    setSetting('openai_api_key', null)
    await expect(resolveProvider()).rejects.toThrow(/openai/i)
    // cleanup
    setSetting('llm_provider', null)
    setSetting('openai_base_url', null)
    setSetting('openai_model', null)
  })
})
