import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Loading, SectionHead, Star, useToast } from '../ui'

interface Masked {
  configured: boolean
  last4: string | null
}

interface SettingsData {
  llm: {
    provider: string
    anthropic_api_key: Masked
    anthropic_base_url: string
    anthropic_model: string
    openai_api_key: Masked
    openai_base_url: string
    openai_model: string
    claude_cli_model: string
    source: Record<string, string>
    active: { provider: string; model: string; detail: string }
  }
  baobaomi: {
    base_url: string
    agent_key: Masked
    source: Record<string, string>
  }
  tikhub: {
    base_url: string
    api_key: Masked
    source: Record<string, string>
  }
  site: {
    company: string
    icp: string
    icpUrl: string
    police: string
    policeUrl: string
    footerNote: string
  }
  note: string
}

interface TestResult {
  ok: boolean
  provider?: string
  model?: string
  latency_ms?: number
  detail: string
}

const SRC_LABEL: Record<string, string> = { db: '设置页', env: '.env', default: '默认' }

function SourceTag({ src }: { src: string }) {
  return <span className={`tag ${src === 'db' ? 't-blue' : 't-dim'}`}>{SRC_LABEL[src] ?? src}</span>
}

export default function Settings() {
  const [data, setData] = useState<SettingsData | null>(null)
  const [toast, showToast] = useToast()
  const [saving, setSaving] = useState(false)

  // form state（密钥留空 = 不修改）
  const [provider, setProvider] = useState('auto')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [anthropicModel, setAnthropicModel] = useState('')
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [openaiModel, setOpenaiModel] = useState('')
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('')
  const [cliModel, setCliModel] = useState('')
  const [bbmUrl, setBbmUrl] = useState('')
  const [bbmKey, setBbmKey] = useState('')
  const [tikhubUrl, setTikhubUrl] = useState('')
  const [tikhubKey, setTikhubKey] = useState('')
  const [llmTest, setLlmTest] = useState<TestResult | null>(null)
  const [bbmTest, setBbmTest] = useState<TestResult | null>(null)
  const [tikhubTest, setTikhubTest] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState<'' | 'llm' | 'bbm' | 'tikhub'>('')
  // site / compliance
  const [site, setSite] = useState({ company: '', icp: '', icpUrl: '', police: '', policeUrl: '', footerNote: '' })

  const load = useCallback(() => {
    api.get<SettingsData>('/app/settings').then((d) => {
      setData(d)
      setProvider(d.llm.provider)
      setAnthropicModel(d.llm.anthropic_model)
      setAnthropicBaseUrl(d.llm.anthropic_base_url)
      setOpenaiModel(d.llm.openai_model)
      setOpenaiBaseUrl(d.llm.openai_base_url)
      setCliModel(d.llm.claude_cli_model)
      setBbmUrl(d.baobaomi.base_url)
      setTikhubUrl(d.tikhub.base_url)
      setSite({
        company: d.site.company,
        icp: d.site.icp,
        icpUrl: d.site.icpUrl,
        police: d.site.police,
        policeUrl: d.site.policeUrl,
        footerNote: d.site.footerNote,
      })
    }).catch(() => {})
  }, [])

  useEffect(load, [load])

  if (!data) return (
    <div className="content"><Loading /></div>
  )

  const submit = async (section: 'llm' | 'bbm' | 'tikhub') => {
    setSaving(true)
    try {
      const body: Record<string, string | null> = {}
      if (section === 'llm') {
        body.llm_provider = provider
        body.anthropic_model = anthropicModel || null
        body.anthropic_base_url = anthropicBaseUrl || null
        body.openai_model = openaiModel || null
        body.openai_base_url = openaiBaseUrl || null
        body.claude_cli_model = cliModel || null
        if (anthropicKey.trim()) body.anthropic_api_key = anthropicKey.trim()
        if (openaiKey.trim()) body.openai_api_key = openaiKey.trim()
      } else if (section === 'bbm') {
        body.baobaomi_base_url = bbmUrl || null
        if (bbmKey.trim()) body.baobaomi_agent_key = bbmKey.trim()
      } else {
        body.tikhub_base_url = tikhubUrl || null
        if (tikhubKey.trim()) body.tikhub_api_key = tikhubKey.trim()
      }
      await api.put('/app/settings', body)
      setAnthropicKey('')
      setOpenaiKey('')
      setBbmKey('')
      setTikhubKey('')
      showToast('已保存，立即生效（无需重启）')
      load()
    } finally {
      setSaving(false)
    }
  }

  const clearSecret = async (key: string) => {
    await api.put('/app/settings', { [key]: null })
    showToast('已清除（回退到 .env / 默认值）')
    load()
  }

  const runTest = async (which: 'llm' | 'bbm' | 'tikhub') => {
    setTesting(which)
    const endpoint = which === 'llm' ? 'test-llm' : which === 'bbm' ? 'test-baobaomi' : 'test-tikhub'
    try {
      const r = await api.post<TestResult>(`/app/settings/${endpoint}`)
      if (which === 'llm') setLlmTest(r)
      else if (which === 'bbm') setBbmTest(r)
      else setTikhubTest(r)
    } finally {
      setTesting('')
    }
  }

  const TestLine = ({ r }: { r: TestResult | null }) =>
    r ? (
      <div className="small mt8" style={{ color: r.ok ? 'var(--blue)' : 'var(--danger)' }}>
        {r.ok ? '✓' : '✗'} {r.provider ? `${r.provider}${r.model ? ` (${r.model})` : ''} · ` : ''}
        {r.latency_ms !== undefined ? `${r.latency_ms}ms · ` : ''}
        {r.detail}
      </div>
    ) : null

  const active = data.llm.active

  return (
    <div className="content narrow">
      {toast}
      <div className="page-head">
        <div>
          <h1>设置</h1>
          <div className="sub">模型接入与外部集成 · 优先级：设置页 &gt; .env &gt; 默认值 · 密钥只存本机，接口不返回完整值</div>
        </div>
      </div>

      {/* ---------- 当前生效状态 ---------- */}
      <div className="panel soft" style={{ marginBottom: 28 }}>
        <div className="sect-label mb8">当前生效的 LLM</div>
        <div className="flex" style={{ gap: 10 }}>
          {active.provider !== 'none' && active.provider !== 'error' && <Star />}
          <span style={{ fontWeight: 600 }}>
            {active.provider === 'none' ? '无（启发式降级模式）' : active.provider === 'error' ? '配置错误' : `${active.provider}${active.model ? ` · ${active.model}` : ''}`}
          </span>
        </div>
        <div className="small dim mt8">{active.detail}</div>
        <div className="small dim2 mt8">
          LLM 用于：研究规划 / 叙述文本抽取 / 评论主题归纳 / 语义冲突判定 / 覆盖度评估。无 LLM 时系统仍可运行（启发式降级，能力受限并如实标注）。
        </div>
      </div>

      {/* ---------- LLM ---------- */}
      <div className="section">
        <SectionHead label="模型接入" />
        <div className="field mt16">
          <label>Provider 策略</label>
          <div className="flex" style={{ flexWrap: 'wrap' }}>
            {([
              ['auto', '自动（推荐）', 'Anthropic Key → OpenAI Key → 本机 claude CLI → 降级'],
              ['anthropic', 'Anthropic 兼容', 'Anthropic API 或兼容端点（官方 / 网关 / 代理）；需要 Key，Base URL 可选'],
              ['openai', 'OpenAI 兼容', 'OpenAI / DeepSeek / MiniMax / Qwen / 本地 / 网关；需要 Key + Base URL'],
              ['claude-cli', 'claude CLI', '本机已登录 Claude Code 即可，零凭证但较慢'],
              ['none', '关闭 LLM', '纯启发式运行'],
            ] as const).map(([v, label, hint]) => (
              <button key={v} className={`fchip ${provider === v ? 'on' : ''}`} title={hint} onClick={() => setProvider(v)}>
                {label}
              </button>
            ))}
            <SourceTag src={data.llm.source.provider ?? 'default'} />
          </div>
        </div>

        <div className="sect-label" style={{ margin: '8px 0 12px' }}>
          Anthropic 兼容接口（Anthropic 官方 / 兼容网关 / 代理）
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="field">
            <label className="flex">
              Anthropic API Key
              <SourceTag src={data.llm.source.anthropic_api_key ?? 'default'} />
              {data.llm.anthropic_api_key.configured && (
                <span className="meta">已配置 ····{data.llm.anthropic_api_key.last4}</span>
              )}
            </label>
            <input
              className="input mono"
              type="password"
              placeholder={data.llm.anthropic_api_key.configured ? '留空 = 保持不变' : 'sk-ant-... 或兼容平台 Key'}
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
            />
            {data.llm.source.anthropic_api_key === 'db' && (
              <button className="meta" style={{ color: 'var(--danger)', textAlign: 'left', cursor: 'pointer' }} onClick={() => clearSecret('anthropic_api_key')}>
                清除设置页中的 Key
              </button>
            )}
          </div>
          <div className="field">
            <label className="flex">
              模型 <SourceTag src={data.llm.source.anthropic_model ?? 'default'} />
            </label>
            <input className="input mono" value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)} placeholder="claude-sonnet-5" />
            <div className="hint">推荐 claude-sonnet-5（质量/成本均衡）或 claude-haiku-4-5（更快更省）</div>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label className="flex">
              Base URL <SourceTag src={data.llm.source.anthropic_base_url ?? 'default'} />
            </label>
            <input className="input mono" value={anthropicBaseUrl} onChange={(e) => setAnthropicBaseUrl(e.target.value)} placeholder="留空 = https://api.anthropic.com；兼容网关/代理填其地址" />
          </div>
        </div>

        <div className="sect-label" style={{ margin: '8px 0 12px' }}>
          OpenAI 兼容接口（OpenAI / DeepSeek / MiniMax / Qwen / 本地模型 / 网关）
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="field">
            <label className="flex">
              OpenAI API Key
              <SourceTag src={data.llm.source.openai_api_key ?? 'default'} />
              {data.llm.openai_api_key.configured && <span className="meta">已配置 ····{data.llm.openai_api_key.last4}</span>}
            </label>
            <input
              className="input mono"
              type="password"
              placeholder={data.llm.openai_api_key.configured ? '留空 = 保持不变' : 'sk-... 或兼容平台 Key'}
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
            />
            {data.llm.source.openai_api_key === 'db' && (
              <button className="meta" style={{ color: 'var(--danger)', textAlign: 'left', cursor: 'pointer' }} onClick={() => clearSecret('openai_api_key')}>
                清除设置页中的 Key
              </button>
            )}
          </div>
          <div className="field">
            <label className="flex">
              模型 <SourceTag src={data.llm.source.openai_model ?? 'default'} />
            </label>
            <input className="input mono" value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)} placeholder="gpt-4o-mini" />
            <div className="hint">按所选平台填写：gpt-4o-mini / deepseek-chat / MiniMax-Text-01 / qwen-plus …</div>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label className="flex">
              Base URL <SourceTag src={data.llm.source.openai_base_url ?? 'default'} />
            </label>
            <input className="input mono" value={openaiBaseUrl} onChange={(e) => setOpenaiBaseUrl(e.target.value)} placeholder="留空 = https://api.openai.com/v1；兼容平台填其地址，如 https://api.deepseek.com/v1" />
          </div>
        </div>

        <div className="sect-label" style={{ margin: '8px 0 12px' }}>
          claude CLI（本机已登录 Claude Code，零凭证）
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="field">
            <label className="flex">
              模型 <SourceTag src={data.llm.source.claude_cli_model ?? 'default'} />
            </label>
            <input className="input mono" value={cliModel} onChange={(e) => setCliModel(e.target.value)} placeholder="haiku" />
          </div>
        </div>

        <div className="flex">
          <button className="btn primary" disabled={saving} onClick={() => submit('llm')}>
            保存模型设置
          </button>
          <button className="btn blue" disabled={testing !== ''} onClick={() => runTest('llm')}>
            {testing === 'llm' ? '测试中…' : '✦ 测试连接'}
          </button>
        </div>
        <TestLine r={llmTest} />
      </div>

      {/* ---------- 抱抱米 ---------- */}
      <div className="section">
        <SectionHead label="抱抱米集成" />
        <div className="small dim mt8 mb16">
          复用抱抱米已采集的抖音爆量素材（→ 创意洞察）。原始内容合规由抱抱米侧负责，Mindex 侧记录溯源。
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="field">
            <label className="flex">
              服务地址 <SourceTag src={data.baobaomi.source.base_url ?? 'default'} />
            </label>
            <input className="input mono" value={bbmUrl} onChange={(e) => setBbmUrl(e.target.value)} placeholder="https://baobaomi.fun" />
          </div>
          <div className="field">
            <label className="flex">
              Agent Key
              <SourceTag src={data.baobaomi.source.agent_key ?? 'default'} />
              {data.baobaomi.agent_key.configured && <span className="meta">已配置 ····{data.baobaomi.agent_key.last4}</span>}
            </label>
            <input
              className="input mono"
              type="password"
              placeholder={data.baobaomi.agent_key.configured ? '留空 = 保持不变' : '抱抱米 config 表中的 agent_api_key'}
              value={bbmKey}
              onChange={(e) => setBbmKey(e.target.value)}
            />
            {data.baobaomi.source.agent_key === 'db' && (
              <button className="meta" style={{ color: 'var(--danger)', textAlign: 'left', cursor: 'pointer' }} onClick={() => clearSecret('baobaomi_agent_key')}>
                清除设置页中的 Key
              </button>
            )}
          </div>
        </div>
        <div className="flex">
          <button className="btn primary" disabled={saving} onClick={() => submit('bbm')}>
            保存抱抱米设置
          </button>
          <button className="btn blue" disabled={testing !== ''} onClick={() => runTest('bbm')}>
            {testing === 'bbm' ? '测试中…' : '✦ 测试连接'}
          </button>
        </div>
        <TestLine r={bbmTest} />
      </div>

      {/* ---------- TikHub ---------- */}
      <div className="section">
        <SectionHead label="TikHub 集成（小红书等平台）" />
        <div className="small dim mt8 mb16">
          付费多平台 API 聚合器，为「小红书口碑」连接器供数（可扩展微博/知乎等）。原始内容合规由 TikHub 侧负责，Mindex 记录溯源。
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="field">
            <label className="flex">
              API 地址 <SourceTag src={data.tikhub.source.base_url ?? 'default'} />
            </label>
            <input className="input mono" value={tikhubUrl} onChange={(e) => setTikhubUrl(e.target.value)} placeholder="https://api.tikhub.io" />
          </div>
          <div className="field">
            <label className="flex">
              API Key
              <SourceTag src={data.tikhub.source.api_key ?? 'default'} />
              {data.tikhub.api_key.configured && <span className="meta">已配置 ····{data.tikhub.api_key.last4}</span>}
            </label>
            <input
              className="input mono"
              type="password"
              placeholder={data.tikhub.api_key.configured ? '留空 = 保持不变' : 'TikHub API Key'}
              value={tikhubKey}
              onChange={(e) => setTikhubKey(e.target.value)}
            />
            {data.tikhub.source.api_key === 'db' && (
              <button className="meta" style={{ color: 'var(--danger)', textAlign: 'left', cursor: 'pointer' }} onClick={() => clearSecret('tikhub_api_key')}>
                清除设置页中的 Key
              </button>
            )}
          </div>
        </div>
        <div className="flex">
          <button className="btn primary" disabled={saving} onClick={() => submit('tikhub')}>
            保存 TikHub 设置
          </button>
          <button className="btn blue" disabled={testing !== ''} onClick={() => runTest('tikhub')}>
            {testing === 'tikhub' ? '测试中…' : '✦ 测试连接'}
          </button>
        </div>
        <TestLine r={tikhubTest} />
      </div>

      {/* ---------- 网站信息 / 合规悬挂 ---------- */}
      <div className="section">
        <SectionHead label="网站信息 / 合规悬挂" />
        <div className="small dim mt8 mb16">
          显示在登录页与页脚的备案与主体信息。请填真实值（备案号需与实际一致）；留空则不显示。
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="field">
            <label>主体 / 公司名称</label>
            <input className="input" value={site.company} onChange={(e) => setSite({ ...site, company: e.target.value })} placeholder="例：广州幸运加载科技有限公司" />
          </div>
          <div className="field">
            <label>ICP 备案号</label>
            <input className="input mono" value={site.icp} onChange={(e) => setSite({ ...site, icp: e.target.value })} placeholder="例：粤ICP备2024XXXXXX号" />
          </div>
          <div className="field">
            <label>ICP 链接（默认工信部）</label>
            <input className="input mono" value={site.icpUrl} onChange={(e) => setSite({ ...site, icpUrl: e.target.value })} placeholder="https://beian.miit.gov.cn/" />
          </div>
          <div className="field">
            <label>公安备案号（可选）</label>
            <input className="input mono" value={site.police} onChange={(e) => setSite({ ...site, police: e.target.value })} placeholder="例：粤公网安备 44XXXXXXXXXXXX号" />
          </div>
          <div className="field">
            <label>公安备案链接（默认公安部）</label>
            <input className="input mono" value={site.policeUrl} onChange={(e) => setSite({ ...site, policeUrl: e.target.value })} placeholder="https://beian.mps.gov.cn/" />
          </div>
          <div className="field">
            <label>页脚附注（可选）</label>
            <input className="input" value={site.footerNote} onChange={(e) => setSite({ ...site, footerNote: e.target.value })} placeholder="例：Mindex 为 Luckyloading 旗下产品" />
          </div>
        </div>
        <button
          className="btn primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true)
            try {
              await api.put('/app/settings', {
                site_company: site.company || null,
                site_icp: site.icp || null,
                site_icp_url: site.icpUrl || null,
                site_police: site.police || null,
                site_police_url: site.policeUrl || null,
                site_footer_note: site.footerNote || null,
              })
              showToast('已保存，登录页与页脚立即更新')
              load()
            } finally {
              setSaving(false)
            }
          }}
        >
          保存网站信息
        </button>
      </div>

      <div className="meta">{data.note}</div>
    </div>
  )
}
