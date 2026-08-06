import { useCallback, useEffect, useState } from 'react'
import { api, fmtDate, fmtDateTime } from '../api'
import { CopyBlock, Empty, SectionHead, useToast } from '../ui'

interface KeyRow {
  id: string
  name: string
  last4: string
  scopes: string[]
  project_ids: string[]
  rate_limit_rpm: number
  created_at: string
  expires_at: string | null
  revoked_at: string | null
  rotated_from: string | null
  last_used_at: string | null
}

interface ProjectLite {
  id: string
  name: string
}

interface LogRow {
  id: number
  method: string
  route: string
  status: number
  duration_ms: number
  at: string
  key_name?: string | null
}

export default function Keys() {
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [projects, setProjects] = useState<ProjectLite[]>([])
  const [logs, setLogs] = useState<LogRow[]>([])
  const [newToken, setNewToken] = useState<{ token: string; name: string } | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['knowledge:read', 'context:read'])
  const [projectIds, setProjectIds] = useState<string[]>(['*'])
  const [rpm, setRpm] = useState(120)
  const [toast, showToast] = useToast()

  const load = useCallback(() => {
    api.get<KeyRow[]>('/app/keys').then(setKeys).catch(() => {})
    api.get<{ projects: ProjectLite[] }>('/app/overview').then((o) => setProjects(o.projects)).catch(() => {})
    api.get<LogRow[]>('/app/logs?limit=30').then(setLogs).catch(() => {})
  }, [])

  useEffect(load, [load])

  const create = async () => {
    const r = await api.post<{ key: KeyRow; token: string }>('/app/keys', {
      name: name.trim(),
      scopes,
      project_ids: projectIds,
      rate_limit_rpm: rpm,
    })
    setNewToken({ token: r.token, name: r.key.name })
    setShowCreate(false)
    setName('')
    load()
  }

  const origin = location.origin.replace(':5173', ':8787')

  return (
    <div className="content">
      {toast}
      <div className="page-head">
        <div>
          <h1>Agent 接入</h1>
          <div className="sub">API Key 管理 · 下游创意 Agent（如 AdMuse）通过这里的凭证检索知识与 Context Pack</div>
        </div>
        <div className="actions">
          <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="btn ghost">
            OpenAPI 文档 ↗
          </a>
          <button className="btn primary" onClick={() => setShowCreate(!showCreate)}>
            + 创建 API Key
          </button>
        </div>
      </div>

      {newToken && (
        <div className="panel" style={{ borderColor: 'var(--blue)', marginBottom: 22 }}>
          <div className="sect-label mb8" style={{ color: 'var(--blue)' }}>
            「{newToken.name}」的 Token — 仅此一次展示，请立即保存
          </div>
          <CopyBlock text={newToken.token} />
          <button className="btn sm ghost mt8" onClick={() => setNewToken(null)}>
            我已保存，关闭
          </button>
        </div>
      )}

      {showCreate && (
        <div className="panel" style={{ marginBottom: 22 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="field">
              <label>名称 *</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：admuse-prod" />
            </div>
            <div className="field">
              <label>限流（次/分钟）</label>
              <input className="input" type="number" value={rpm} onChange={(e) => setRpm(Number(e.target.value))} min={10} max={6000} />
            </div>
          </div>
          <div className="field">
            <label>权限范围</label>
            <div className="flex">
              {(['knowledge:read', 'context:read', 'knowledge:write'] as const).map((s) => (
                <label key={s} className="flex small" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))}
                  />
                  <span className="mono small">{s}</span>
                  <span className="dim2 small">
                    {s === 'knowledge:read'
                      ? '（搜索/读取知识与证据）'
                      : s === 'context:read'
                        ? '（生成 Context Pack）'
                        : '（建项目/发研究/导入评论与资料——审核裁决不开放）'}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label>项目权限（隔离边界）</label>
            <div className="flex" style={{ flexWrap: 'wrap' }}>
              <button className={`fchip ${projectIds.includes('*') ? 'on' : ''}`} onClick={() => setProjectIds(['*'])}>
                全部项目
              </button>
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={`fchip ${projectIds.includes(p.id) ? 'on' : ''}`}
                  onClick={() => {
                    const without = projectIds.filter((x) => x !== '*' && x !== p.id)
                    setProjectIds(projectIds.includes(p.id) ? (without.length ? without : ['*']) : [...without, p.id])
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <div className="hint">Key 只能访问被授权项目的知识——跨项目请求会被 403 拒绝</div>
          </div>
          <button className="btn primary" disabled={!name.trim() || scopes.length === 0} onClick={create}>
            创建
          </button>
        </div>
      )}

      <div className="section">
        <SectionHead label="API 密钥" count={keys.length} />
        {keys.length === 0 ? (
          <Empty mark="无密钥">还没有 API Key。创建一个，让外部 Agent 接入知识库。</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>名称</th>
                <th>令牌</th>
                <th>权限</th>
                <th>项目</th>
                <th>限流</th>
                <th>最近使用</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const dead = Boolean(k.revoked_at) || Boolean(k.expires_at && k.expires_at <= new Date().toISOString())
                return (
                  <tr key={k.id} style={dead ? { opacity: 0.45 } : {}}>
                    <td style={{ fontWeight: 500 }}>{k.name}</td>
                    <td className="mono small">mdx_live_…{k.last4}</td>
                    <td className="mono" style={{ fontSize: 10.5 }}>{k.scopes.join(' ')}</td>
                    <td className="small">
                      {k.project_ids.includes('*') ? '全部' : k.project_ids.map((pid) => projects.find((p) => p.id === pid)?.name ?? pid.slice(0, 10)).join('、')}
                    </td>
                    <td className="mono small">{k.rate_limit_rpm}/min</td>
                    <td className="mono small">{k.last_used_at ? fmtDateTime(k.last_used_at) : '未使用'}</td>
                    <td>
                      {k.revoked_at ? (
                        <span className="tag t-warn">已吊销</span>
                      ) : k.expires_at ? (
                        <span className="tag t-dim">将于 {fmtDate(k.expires_at)} 到期</span>
                      ) : (
                        <span className="tag t-blue">生效中</span>
                      )}
                    </td>
                    <td>
                      {!dead && (
                        <span className="flex">
                          <button
                            className="btn sm ghost"
                            onClick={async () => {
                              const r = await api.post<{ token: string; key: { name: string } }>(`/app/keys/${k.id}/rotate`, { grace_hours: 24 })
                              setNewToken({ token: r.token, name: `${k.name}（轮换）` })
                              showToast('已轮换：旧 Key 24 小时后失效')
                              load()
                            }}
                          >
                            轮换
                          </button>
                          <button
                            className="btn sm danger"
                            onClick={async () => {
                              await api.post(`/app/keys/${k.id}/revoke`)
                              showToast('已撤销')
                              load()
                            }}
                          >
                            撤销
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="section">
        <SectionHead label="调用日志" count={logs.length} />
        {logs.length === 0 ? (
          <Empty mark="无记录">暂无 Agent 调用记录</Empty>
        ) : (
          <div className="index-list">
            {logs.map((l) => (
              <div key={l.id} className="row" style={{ padding: '6px' }}>
                <span className="meta" style={{ color: l.status < 400 ? 'var(--graphite)' : 'var(--danger)', minWidth: 30 }}>
                  {l.status}
                </span>
                <div className="grow meta" style={{ color: 'var(--graphite)' }}>
                  {l.method} {l.route}
                </div>
                <span className="meta">{l.key_name ?? '—'}</span>
                <span className="meta">{l.duration_ms.toFixed(1)}ms</span>
                <span className="meta">{fmtDateTime(l.at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <SectionHead label="接入方式" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 20 }}>
          <div>
            <div className="small mb8" style={{ fontWeight: 600 }}>
              REST API
            </div>
            <CopyBlock
              text={`# 搜索知识（带引用与置信度）
curl "${origin}/api/v1/search?q=付费&limit=5" \\
  -H "Authorization: Bearer mdx_live_..."

# 生成 Context Pack（写广告前调用）
curl -X POST "${origin}/api/v1/context-pack" \\
  -H "Authorization: Bearer mdx_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"project_id":"prj_...","task":"为新版本写买量素材","budget_tokens":6000}'`}
            />
          </div>
          <div>
            <div className="small mb8" style={{ fontWeight: 600 }}>
              MCP（Claude Code / Claude Desktop）
            </div>
            <CopyBlock
              text={`claude mcp add mindex \\
  --env MINDEX_API_KEY=mdx_live_... \\
  --env MINDEX_API_URL=${origin} \\
  -- npm run mcp --prefix <mindex目录>

# 工具: search_knowledge / get_claim / get_evidence
#       get_context_pack / list_projects`}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
