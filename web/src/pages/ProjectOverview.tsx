import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, fmtDateTime } from '../api'
import { Empty, Loading, SectionHead, Star, useToast } from '../ui'

interface ProjectFull {
  id: string
  name: string
  kind: string
  description: string
  aliases: string[]
  official_urls: string[]
  platform_hints: Record<string, unknown>
  demo: number
  running: boolean
  created_at: string
  stats: Record<string, number>
}

interface Run {
  id: string
  goal: string
  status: string
  llm_provider: string
  model_id: string
  started_at: string
  finished_at: string | null
}

interface ConnectorInfo {
  id: string
  label: string
  status: string
  description: string
  compliance: string
}

export default function ProjectOverview() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [p, setP] = useState<ProjectFull | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([])
  const [toast, showToast] = useToast()

  const load = useCallback(() => {
    api.get<ProjectFull>(`/app/projects/${id}`).then(setP).catch(() => {})
    api.get<Run[]>(`/app/projects/${id}/runs`).then(setRuns).catch(() => {})
  }, [id])

  useEffect(() => {
    load()
    api.get<ConnectorInfo[]>('/app/connectors').then(setConnectors).catch(() => {})
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [load])

  if (!p) return (<div className="content"><Loading /></div>)

  const startResearch = async (force = false) => {
    try {
      const r = await api.post<{ run_id: string }>(`/app/projects/${id}/research`, force ? { force: true } : {})
      navigate(`/projects/${id}/runs/${r.run_id}`)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'duplicate_recent') {
        if (window.confirm('30 分钟内已完成同目标研究，确认再来一次？')) void startResearch(true)
        return
      }
      showToast(String((e as Error).message))
    }
  }

  const deleteRun = async (runId: string) => {
    if (!window.confirm('删除这条研究记录？知识结论不受影响。')) return
    try {
      await api.del(`/app/runs/${runId}`)
      load()
    } catch (e) {
      showToast(String((e as Error).message))
    }
  }

  const bandStats: [string, string][] = [
    ['verified', '已验证'],
    ['likely', '较可信'],
    ['uncertain', '不确定'],
    ['disputed', '存在冲突'],
    ['insufficient', '证据不足'],
  ]

  return (
    <div className="content">
      {toast}
      <div className="page-head">
        <div>
          <h1>
            {p.name} {p.running && <Star working />}
            {p.demo === 1 && <span className="tag t-dim" style={{ marginLeft: 10, verticalAlign: 'middle' }}>示例数据</span>}
          </h1>
          <div className="sub">
            {p.description || '（无描述）'}
            {p.aliases.length > 0 && <span className="dim2"> · 别名: {p.aliases.join('、')}</span>}
          </div>
        </div>
        <div className="actions">
          <Link to={`/projects/${id}/import`} className="btn ghost">
            导入资料
          </Link>
          <button className="btn blue" onClick={() => startResearch()} disabled={p.running}>
            <Star working={p.running} /> {p.running ? '研究进行中…' : '开始主动研究'}
          </button>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 10 }}>
        <div className="stat">
          <div className="v">{p.stats.claims ?? 0}</div>
          <div className="k meta">结论</div>
        </div>
        <div className="stat">
          <div className="v">{p.stats.evidence ?? 0}</div>
          <div className="k meta">证据</div>
        </div>
        <div className="stat">
          <div className="v">{p.stats.sources ?? 0}</div>
          <div className="k meta">来源</div>
        </div>
        <div className="stat">
          <div className="v">{p.stats.documents ?? 0}</div>
          <div className="k meta">文档</div>
        </div>
        <div className="stat">
          <div className="v">{p.stats.pending_review ?? 0}</div>
          <div className="k meta">待审核</div>
        </div>
        <div className="stat">
          <div className="v">{p.stats.open_conflicts ?? 0}</div>
          <div className="k meta">冲突</div>
        </div>
      </div>

      <div className="meta" style={{ marginBottom: 30 }}>
        {bandStats.map(([k, label]) => (
          <span key={k} style={{ marginRight: 16 }}>
            {label} <b style={{ color: k === 'verified' ? 'var(--blue)' : 'var(--graphite)' }}>{p.stats[k] ?? 0}</b>
          </span>
        ))}
        <Link to={`/projects/${id}/knowledge`} style={{ color: 'var(--blue)' }}>
          查看知识索引 →
        </Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 32 }}>
        <div className="section">
          <SectionHead label="研究任务" count={runs.length} />
          {runs.length === 0 ? (
            <Empty mark="空闲">
              还没有研究任务。点击「开始主动研究」，Agent 将自主规划检索、发现并验证知识。
            </Empty>
          ) : (
            <div className="index-list">
              {runs.map((r) => (
                <Link key={r.id} to={`/projects/${id}/runs/${r.id}`} className="row">
                  <span className={`tag ${r.status === 'running' ? 't-blue' : r.status === 'failed' ? 't-warn' : ''}`}>
                    {r.status.toUpperCase()}
                  </span>
                  <div className="grow">
                    <div className="title small">{r.goal}</div>
                    <div className="meta" style={{ marginTop: 2 }}>
                      {(r.llm_provider || 'none').toUpperCase()}
                      {r.model_id ? ` (${r.model_id})` : ''} / {fmtDateTime(r.started_at)}
                    </div>
                  </div>
                  {r.status !== 'running' && (
                    <button
                      className="btn ghost"
                      style={{ padding: '2px 8px', fontSize: 12 }}
                      onClick={(e) => {
                        e.preventDefault()
                        void deleteRun(r.id)
                      }}
                    >
                      删除
                    </button>
                  )}
                  <span className="meta">→</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="section">
          <SectionHead label="数据来源连接器" />
          <div className="index-list">
            {connectors.map((c) => (
              <div key={c.id} className="row" title={c.compliance}>
                <span className={`tag ${c.status === 'verified' ? 't-blue' : c.status === 'needs_key' ? 't-ink' : 't-dim'}`}>
                  {c.status === 'verified' ? '已接通' : c.status === 'needs_key' ? '待配置' : '未接通'}
                </span>
                <div className="grow">
                  <div className="title small">{c.label}</div>
                  <div className="meta wrap-any" style={{ whiteSpace: 'normal', marginTop: 2 }}>
                    {c.status === 'verified'
                      ? c.description
                      : c.status === 'needs_key'
                        ? `${c.description} → 配置后启用（API Key / CLI）`
                        : `${c.description} → 通过「手动导入」接入`}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {Object.keys(p.platform_hints).length > 0 && (
            <div className="panel soft mt16">
              <div className="sect-label" style={{ marginBottom: 8 }}>
                已定位的平台标识
              </div>
              <div className="meta wrap-any" style={{ whiteSpace: 'normal', lineHeight: 2 }}>
                {Object.entries(p.platform_hints)
                  .filter(([k]) => k.endsWith('_id'))
                  .map(([k, v]) => `${k.toUpperCase()}=${String(v)}`)
                  .join('  ·  ')}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
