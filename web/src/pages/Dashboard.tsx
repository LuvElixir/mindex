import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmtDateTime, seqNum } from '../api'
import { BandTag, Empty, Loading, SectionHead, Star, TypeTag } from '../ui'

interface Overview {
  projects: {
    id: string
    name: string
    kind: string
    description: string
    demo: number
    running: boolean
    stats: { claims: number; trusted: number; sources: number; pending_review: number; open_conflicts: number }
  }[]
  recentRuns: { id: string; project_id: string; project_name: string; goal: string; status: string; llm_provider: string; started_at: string }[]
  recentApiCalls: { id: number; key_name: string | null; method: string; route: string; status: number; at: string }[]
  recentClaims: { id: string; seq: number; text: string; claim_type: string; confidence_band: string; project_name: string; project_id: string; updated_at: string }[]
}

export default function Dashboard() {
  const [data, setData] = useState<Overview | null>(null)

  useEffect(() => {
    const load = () => api.get<Overview>('/app/overview').then(setData).catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  if (!data) return (<div className="content"><Loading /></div>)

  const totals = data.projects.reduce(
    (a, p) => ({
      claims: a.claims + p.stats.claims,
      trusted: a.trusted + p.stats.trusted,
      review: a.review + p.stats.pending_review,
      conflicts: a.conflicts + p.stats.open_conflicts,
    }),
    { claims: 0, trusted: 0, review: 0, conflicts: 0 },
  )

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>知识总览</h1>
          <div className="sub">
            {data.projects.length} 个项目 · {totals.claims} 条结论 · {totals.trusted} 条可信知识
          </div>
        </div>
        <div className="actions">
          <Link to="/new" className="btn primary">
            + 创建项目
          </Link>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 32 }}>
        <div className="stat">
          <div className="v">{totals.claims}</div>
          <div className="k meta">已索引结论</div>
        </div>
        <div className="stat">
          <div className="v">
            <Star /> {totals.trusted}
          </div>
          <div className="k meta">可供调用</div>
        </div>
        <div className="stat">
          <div className="v">{totals.review}</div>
          <div className="k meta">待审核</div>
        </div>
        <div className="stat">
          <div className="v">{totals.conflicts}</div>
          <div className="k meta">未解决冲突</div>
        </div>
      </div>

      <div className="section">
        <SectionHead label="项目" count={data.projects.length} />
        {data.projects.length === 0 ? (
          <Empty mark="暂无项目">还没有项目。创建一个项目，让研究 Agent 开始主动发现知识。</Empty>
        ) : (
          <div className="index-list">
            {data.projects.map((p, i) => (
              <Link key={p.id} to={`/projects/${p.id}`} className="row">
                <span className="idx">{seqNum(i + 1)}</span>
                <span className="tag">{p.kind.toUpperCase()}</span>
                <div className="grow">
                  <div className="title" style={{ fontWeight: 600, fontSize: 14.5 }}>
                    {p.name} {p.running && <Star working />}
                    {p.demo === 1 && <span className="tag t-dim" style={{ marginLeft: 8 }}>示例数据</span>}
                  </div>
                  <div className="meta" style={{ marginTop: 2 }}>
                    {p.stats.claims} 条结论 / {p.stats.trusted} 条可信 / {p.stats.sources} 个来源
                    {p.stats.pending_review > 0 && ` / ${p.stats.pending_review} 项待审核`}
                    {p.stats.open_conflicts > 0 && ` / ${p.stats.open_conflicts} 项冲突`}
                  </div>
                </div>
                <span className="meta">→</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 32 }}>
        <div className="section">
          <SectionHead label="最近更新的知识" />
          {data.recentClaims.length === 0 ? (
            <Empty>暂无知识条目</Empty>
          ) : (
            <div className="index-list">
              {data.recentClaims.map((c) => (
                <Link key={c.id} to={`/claims/${c.id}`} className="row">
                  <span className="idx">{seqNum(c.seq)}</span>
                  <div className="grow">
                    <div className="title">{c.text}</div>
                    <div className="meta" style={{ marginTop: 2 }}>
                      {c.project_name} / {fmtDateTime(c.updated_at)}
                    </div>
                  </div>
                  <TypeTag type={c.claim_type} />
                  <BandTag band={c.confidence_band} />
                </Link>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="section">
            <SectionHead label="研究任务" />
            {data.recentRuns.length === 0 ? (
              <Empty>还没有研究任务</Empty>
            ) : (
              <div className="index-list">
                {data.recentRuns.map((r) => (
                  <Link key={r.id} to={`/projects/${r.project_id}/runs/${r.id}`} className="row">
                    <span className={`tag ${r.status === 'running' ? 't-blue' : r.status === 'failed' ? 't-warn' : ''}`}>
                      {r.status.toUpperCase()}
                    </span>
                    <div className="grow">
                      <div className="title small">
                        {r.project_name} · {r.goal}
                      </div>
                      <div className="meta" style={{ marginTop: 2 }}>
                        {r.llm_provider.toUpperCase()} / {fmtDateTime(r.started_at)}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="section">
            <SectionHead label="最近被 Agent 调用" />
            {data.recentApiCalls.length === 0 ? (
              <Empty mark="无记录">
                还没有 Agent 调用。在「Agent 接入」页创建 API Key 后，外部 Agent 即可检索知识。
              </Empty>
            ) : (
              <div className="index-list">
                {data.recentApiCalls.map((l) => (
                  <div key={l.id} className="row">
                    <span className="meta">{l.status}</span>
                    <div className="grow meta" style={{ color: 'var(--graphite)' }}>
                      {l.method} {l.route}
                    </div>
                    <span className="meta">
                      {l.key_name ?? '未知'} / {fmtDateTime(l.at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
