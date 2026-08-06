import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { effectiveLlm } from '../core/settings.js'

const execFileP = promisify(execFile)

/**
 * Pluggable LLM providers for the research agent:
 *  - anthropic  : official Anthropic SDK, best quality (API key via settings page or env)
 *  - openai     : official OpenAI SDK against any OpenAI-compatible endpoint
 *                 (openai.com, DeepSeek, MiniMax, Qwen, local Ollama/LM Studio, gateways —
 *                  set the base URL). Uses chat.completions + JSON mode.
 *  - claude-cli : shells out to a logged-in local `claude` CLI — zero extra credentials
 *  - none       : pipeline falls back to honest heuristic extraction
 * Configuration precedence: settings page (DB) > .env > defaults — resolved fresh on
 * every research run, so UI changes apply without restart. Every claim records which
 * provider extracted it (claims.extraction_provider).
 */

export interface LlmProvider {
  name: string
  model: string
  completeJson(opts: { system: string; prompt: string; maxTokens?: number }): Promise<unknown | null>
  /** 流式纯文本输出（可选实现；onDelta 每段增量回调）。不支持流式的 provider 缺省即可。 */
  completeText?(opts: { system: string; prompt: string; maxTokens?: number; onDelta?: (text: string) => void }): Promise<string | null>
}

export function extractJson(text: string): unknown | null {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1]!.trim()
  const start = Math.min(...['{', '['].map((c) => (t.indexOf(c) === -1 ? Infinity : t.indexOf(c))))
  if (!Number.isFinite(start)) return null
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

class AnthropicProvider implements LlmProvider {
  name = 'anthropic'
  model: string
  private client: Anthropic

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.model = model
    this.client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })
  }

  async completeJson(opts: { system: string; prompt: string; maxTokens?: number }): Promise<unknown | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: opts.maxTokens ?? 4096,
        // the long extraction system prompt repeats across documents — cache it
        cache_control: { type: 'ephemeral' },
        system: opts.system,
        messages: [
          {
            role: 'user',
            content: attempt === 0 ? opts.prompt : `${opts.prompt}\n\n(上次输出无法解析为 JSON，请严格只输出合法 JSON，不要任何其他文字)`,
          },
        ],
      })
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const json = extractJson(text)
      if (json !== null) return json
    }
    return null
  }
}

class OpenAiProvider implements LlmProvider {
  name = 'openai'
  model: string
  private client: OpenAI

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.model = model
    this.client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })
  }

  async completeJson(opts: { system: string; prompt: string; maxTokens?: number }): Promise<unknown | null> {
    // json_object mode isn't universal across OpenAI-compatible endpoints — try it, then retry without
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: opts.maxTokens ?? 4096,
          ...(attempt === 0 ? { response_format: { type: 'json_object' as const } } : {}),
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.prompt },
          ],
        })
        const text = res.choices[0]?.message?.content ?? ''
        const json = extractJson(text)
        if (json !== null) return json
      } catch (err) {
        // attempt 0 may fail if the endpoint rejects response_format; attempt 1 retries plain
        if (attempt === 1) {
          // eslint-disable-next-line no-console
          console.error('[llm:openai] failed:', (err as Error).message?.slice(0, 300))
          return null
        }
      }
    }
    return null
  }

  async completeText(opts: { system: string; prompt: string; maxTokens?: number; onDelta?: (text: string) => void }): Promise<string | null> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: opts.maxTokens ?? 2048,
        stream: true,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.prompt },
        ],
      })
      let full = ''
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? ''
        if (delta) {
          full += delta
          opts.onDelta?.(delta)
        }
      }
      return full || null
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[llm:openai] stream failed:', (err as Error).message?.slice(0, 300))
      return null
    }
  }
}

class ClaudeCliProvider implements LlmProvider {
  name = 'claude-cli'
  model: string

  constructor(model: string) {
    this.model = model
  }

  async completeJson(opts: { system: string; prompt: string }): Promise<unknown | null> {
    // claude-cli JSON output is occasionally unparseable — retry once with a stricter nudge
    for (let attempt = 0; attempt < 2; attempt++) {
      const suffix = attempt === 0 ? '' : '\n\n（上次输出无法解析为 JSON，请严格只输出合法 JSON，不要任何解释或代码块外文字）'
      const fullPrompt = `${opts.system}\n\n---\n\n${opts.prompt}${suffix}`
      try {
        const { stdout } = await execFileP(
          'claude',
          ['-p', fullPrompt, '--model', this.model, '--output-format', 'text', '--max-turns', '1'],
          { timeout: 180_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'mindex' } },
        )
        const json = extractJson(stdout)
        if (json !== null) return json
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[llm:claude-cli] failed:', (err as Error).message?.slice(0, 300))
        if (attempt === 1) return null
      }
    }
    return null
  }
}

// claude CLI availability probe is slow-ish; cache it briefly
let cliProbe: { at: number; ok: boolean } | null = null
async function claudeCliAvailable(): Promise<boolean> {
  if (cliProbe && Date.now() - cliProbe.at < 300_000) return cliProbe.ok
  try {
    await execFileP('claude', ['--version'], { timeout: 10_000 })
    cliProbe = { at: Date.now(), ok: true }
  } catch {
    cliProbe = { at: Date.now(), ok: false }
  }
  return cliProbe.ok
}

/** Resolve the effective provider from current settings (DB > env). Fresh per call. */
export async function resolveProvider(): Promise<LlmProvider | null> {
  const s = effectiveLlm()
  if (s.provider === 'none') return null
  if (s.provider === 'anthropic' || (s.provider === 'auto' && s.anthropicApiKey)) {
    if (!s.anthropicApiKey) throw new Error('LLM provider 设为 anthropic 但未配置 API Key（设置页或 ANTHROPIC_API_KEY）')
    return new AnthropicProvider(s.anthropicApiKey, s.anthropicModel, s.anthropicBaseUrl || undefined)
  }
  if (s.provider === 'openai' || (s.provider === 'auto' && s.openaiApiKey)) {
    if (!s.openaiApiKey) throw new Error('LLM provider 设为 openai 但未配置 API Key（设置页或 OPENAI_API_KEY）')
    return new OpenAiProvider(s.openaiApiKey, s.openaiModel, s.openaiBaseUrl || undefined)
  }
  if (s.provider === 'claude-cli' || s.provider === 'auto') {
    if (await claudeCliAvailable()) return new ClaudeCliProvider(s.claudeCliModel)
    if (s.provider === 'claude-cli') throw new Error('LLM provider 设为 claude-cli 但本机没有可用的 claude CLI')
    return null
  }
  return null
}

/** Which provider WOULD be used right now (for the settings page status display). */
export async function describeProvider(): Promise<{ provider: string; model: string; detail: string }> {
  const s = effectiveLlm()
  try {
    const p = await resolveProvider()
    if (!p) {
      return {
        provider: 'none',
        model: '',
        detail:
          s.provider === 'none'
            ? '已显式关闭 LLM——研究管线将以启发式降级运行'
            : '未找到可用 LLM（无 API Key 且本机无 claude CLI）——研究管线将以启发式降级运行',
      }
    }
    const detail =
      p.name === 'anthropic'
        ? `Anthropic 兼容接口${s.anthropicBaseUrl ? `（${s.anthropicBaseUrl}）` : '（官方端点）'}`
        : p.name === 'openai'
          ? `OpenAI 兼容接口${s.openaiBaseUrl ? `（${s.openaiBaseUrl}）` : '（官方端点）'}`
          : '本机 claude CLI（零凭证，速度较慢）'
    return { provider: p.name, model: p.model, detail }
  } catch (err) {
    return { provider: 'error', model: '', detail: String((err as Error).message) }
  }
}
