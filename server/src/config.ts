import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..', '..')
export const DATA_DIR = process.env.MINDEX_DATA_DIR || path.join(ROOT_DIR, 'data')
export const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots')

mkdirSync(SNAPSHOT_DIR, { recursive: true })

function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '')
    }
  }
}
loadDotEnv()

/** Admin token guards the management UI/API plane. Auto-generated on first run. */
function resolveAdminToken(): string {
  if (process.env.MINDEX_ADMIN_TOKEN) return process.env.MINDEX_ADMIN_TOKEN
  const tokenFile = path.join(DATA_DIR, '.admin_token')
  if (existsSync(tokenFile)) return readFileSync(tokenFile, 'utf8').trim()
  const token = 'mdxadm_' + randomBytes(18).toString('base64url')
  writeFileSync(tokenFile, token, { mode: 0o600 })
  return token
}

export const config = {
  host: process.env.MINDEX_HOST || '127.0.0.1',
  port: Number(process.env.MINDEX_PORT || 8787),
  dbPath: process.env.MINDEX_DB_PATH || path.join(DATA_DIR, 'mindex.db'),
  adminToken: resolveAdminToken(),
  /**
   * LLM provider for the research agent:
   *  - anthropic : Anthropic API (needs ANTHROPIC_API_KEY) — best quality
   *  - openai    : OpenAI or any OpenAI-compatible endpoint (DeepSeek/MiniMax/Qwen/本地/网关)
   *  - claude-cli: shells out to a logged-in local `claude` CLI — zero extra credentials
   *  - none      : heuristic extraction only (honest degraded mode)
   *  - auto      : anthropic key → openai key → claude-cli → none
   */
  llmProvider: (process.env.MINDEX_LLM_PROVIDER || 'auto') as 'anthropic' | 'openai' | 'claude-cli' | 'none' | 'auto',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.MINDEX_ANTHROPIC_MODEL || 'claude-sonnet-5',
  claudeCliModel: process.env.MINDEX_CLAUDE_CLI_MODEL || 'haiku',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
  openaiModel: process.env.MINDEX_OPENAI_MODEL || 'gpt-4o-mini',
  /** 'strict' = skip robots-disallowed URLs; 'log' = fetch but record; 'off' */
  robotsPolicy: (process.env.MINDEX_ROBOTS_POLICY || 'log') as 'strict' | 'log' | 'off',
  fetchUserAgent: process.env.MINDEX_USER_AGENT
    || 'MindexResearchBot/0.1 (+https://mindex.local; knowledge indexing; contact admin)',
  /** requests per minute per host for outbound fetching */
  fetchRpmPerHost: Number(process.env.MINDEX_FETCH_RPM || 30),
  /**
   * Outbound proxy (快代理隧道等) for hosts that block the server's own IP (IDC 段封锁，
   * 如 TapTap 对数据中心 IP 返回 405、部分站点地域封锁)。仅 proxy:true 的 fetch 才走它，
   * 常规抓取仍直连以省流量。凭证放 .env（不进 git）。格式：http://user:pass@host:port
   */
  proxyUrl: process.env.MINDEX_PROXY_URL || '',
  /**
   * Baobaomi (抱抱米) reuse — a companion server that already collects Douyin/Bilibili/
   * TapTap content. Mindex consumes its Agent API as a raw-content Connector and adds
   * its own provenance/confidence/context-pack layer on top. Needs the agent key to
   * activate; without it the connector reports 'needs_key' and is skipped honestly.
   */
  baobaomi: {
    baseUrl: process.env.BAOBAOMI_BASE_URL || 'https://baobaomi.fun',
    agentKey: process.env.BAOBAOMI_AGENT_KEY || '',
  },
  /**
   * Bilibili connector via the `bili` CLI (public-clis/bilibili-cli). Search + video
   * details + top comments work without login. Set BILI_CLI_PATH if `bili` isn't on
   * the server PATH. Connector auto-detects availability and degrades if missing.
   */
  biliCliPath: process.env.BILI_CLI_PATH || '',
  biliMaxVideos: Number(process.env.BILI_MAX_VIDEOS || 10),
  /**
   * TikHub (https://tikhub.io) — paid multi-platform API aggregator. Powers the
   * Xiaohongshu connector (and could back Weibo/Zhihu/Kuaishou later). Key via settings
   * page or TIKHUB_API_KEY. Connector auto-degrades to needs_key when unset.
   */
  tikhub: {
    baseUrl: process.env.TIKHUB_BASE_URL || 'https://api.tikhub.io',
    apiKey: process.env.TIKHUB_API_KEY || '',
  },
  xhsMaxNotes: Number(process.env.XHS_MAX_NOTES || 8),
  douyinMaxVideos: Number(process.env.DOUYIN_MAX_VIDEOS || 8),
  kuaishouMaxVideos: Number(process.env.KUAISHOU_MAX_VIDEOS || 6),
  weiboMaxPosts: Number(process.env.WEIBO_MAX_POSTS || 6),
}
