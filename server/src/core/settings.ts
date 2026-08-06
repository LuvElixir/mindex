import type { DB } from '../db/index.js'
import { config } from '../config.js'

/**
 * Runtime settings, editable from the admin UI (模型接入/集成设置页).
 * Stored in the `meta` table (setting: prefix). Precedence: DB value > env (.env) > default.
 * Secrets are never returned whole by the API — only configured/last4.
 */

let _db: DB | null = null

export function initSettings(db: DB): void {
  _db = db
}

export const SETTING_KEYS = [
  'llm_provider', // auto | anthropic | openai | claude-cli | none
  'anthropic_api_key',
  'anthropic_base_url',
  'anthropic_model',
  'openai_api_key',
  'openai_base_url',
  'openai_model',
  'claude_cli_model',
  'baobaomi_base_url',
  'baobaomi_agent_key',
  'tikhub_base_url',
  'tikhub_api_key',
  // public site / compliance footer (悬挂信息)
  'site_company',
  'site_icp',
  'site_icp_url',
  'site_police',
  'site_police_url',
  'site_footer_note',
] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

export function getSetting(key: SettingKey): string | null {
  if (!_db) return null
  const row = _db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`setting:${key}`) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: SettingKey, value: string | null): void {
  if (!_db) throw new Error('settings not initialized')
  if (value === null || value === '') {
    _db.prepare(`DELETE FROM meta WHERE key = ?`).run(`setting:${key}`)
  } else {
    _db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
      `setting:${key}`,
      value,
    )
  }
}

/** Effective LLM config after DB > env precedence. */
export function effectiveLlm(): {
  provider: 'auto' | 'anthropic' | 'openai' | 'claude-cli' | 'none'
  anthropicApiKey: string
  anthropicBaseUrl: string
  anthropicModel: string
  openaiApiKey: string
  openaiBaseUrl: string
  openaiModel: string
  claudeCliModel: string
  source: Record<string, 'db' | 'env' | 'default'>
} {
  const pick = (key: SettingKey, envValue: string, fallback: string): [string, 'db' | 'env' | 'default'] => {
    const dbVal = getSetting(key)
    if (dbVal) return [dbVal, 'db']
    if (envValue) return [envValue, 'env']
    return [fallback, 'default']
  }
  const [provider, pSrc] = pick('llm_provider', process.env.MINDEX_LLM_PROVIDER ?? '', 'auto')
  const [anthropicApiKey, kSrc] = pick('anthropic_api_key', config.anthropicApiKey, '')
  const [anthropicBaseUrl, bSrc] = pick('anthropic_base_url', process.env.ANTHROPIC_BASE_URL ?? '', '')
  const [anthropicModel, mSrc] = pick('anthropic_model', process.env.MINDEX_ANTHROPIC_MODEL ?? '', 'claude-sonnet-5')
  const [openaiApiKey, oKSrc] = pick('openai_api_key', config.openaiApiKey, '')
  const [openaiBaseUrl, oBSrc] = pick('openai_base_url', config.openaiBaseUrl, '')
  const [openaiModel, oMSrc] = pick('openai_model', config.openaiModel === 'gpt-4o-mini' ? '' : config.openaiModel, 'gpt-4o-mini')
  const [claudeCliModel, cSrc] = pick('claude_cli_model', process.env.MINDEX_CLAUDE_CLI_MODEL ?? '', 'haiku')
  return {
    provider: (['auto', 'anthropic', 'openai', 'claude-cli', 'none'].includes(provider) ? provider : 'auto') as 'auto',
    anthropicApiKey,
    anthropicBaseUrl,
    anthropicModel,
    openaiApiKey,
    openaiBaseUrl,
    openaiModel,
    claudeCliModel,
    source: {
      provider: pSrc,
      anthropic_api_key: kSrc,
      anthropic_base_url: bSrc,
      anthropic_model: mSrc,
      openai_api_key: oKSrc,
      openai_base_url: oBSrc,
      openai_model: oMSrc,
      claude_cli_model: cSrc,
    },
  }
}

/** Public site / compliance footer info (悬挂信息). All non-secret; safe to serve unauthenticated. */
export function effectiveSite(): {
  company: string
  icp: string
  icpUrl: string
  police: string
  policeUrl: string
  footerNote: string
} {
  return {
    company: getSetting('site_company') ?? '',
    icp: getSetting('site_icp') ?? '',
    icpUrl: getSetting('site_icp_url') ?? 'https://beian.miit.gov.cn/',
    police: getSetting('site_police') ?? '',
    policeUrl: getSetting('site_police_url') ?? 'https://beian.mps.gov.cn/',
    footerNote: getSetting('site_footer_note') ?? '',
  }
}

/** Effective TikHub config after DB > env precedence. */
export function effectiveTikhub(): { baseUrl: string; apiKey: string; source: Record<string, 'db' | 'env' | 'default'> } {
  const dbUrl = getSetting('tikhub_base_url')
  const dbKey = getSetting('tikhub_api_key')
  return {
    baseUrl: dbUrl || config.tikhub.baseUrl,
    apiKey: dbKey || config.tikhub.apiKey,
    source: {
      base_url: dbUrl ? 'db' : process.env.TIKHUB_BASE_URL ? 'env' : 'default',
      api_key: dbKey ? 'db' : config.tikhub.apiKey ? 'env' : 'default',
    },
  }
}

/** Effective baobaomi config after DB > env precedence. */
export function effectiveBaobaomi(): { baseUrl: string; agentKey: string; source: Record<string, 'db' | 'env' | 'default'> } {
  const dbUrl = getSetting('baobaomi_base_url')
  const dbKey = getSetting('baobaomi_agent_key')
  return {
    baseUrl: dbUrl || config.baobaomi.baseUrl,
    agentKey: dbKey || config.baobaomi.agentKey,
    source: {
      base_url: dbUrl ? 'db' : process.env.BAOBAOMI_BASE_URL ? 'env' : 'default',
      agent_key: dbKey ? 'db' : config.baobaomi.agentKey ? 'env' : 'default',
    },
  }
}

export function maskSecret(value: string): { configured: boolean; last4: string | null } {
  if (!value) return { configured: false, last4: null }
  return { configured: true, last4: value.slice(-4) }
}
