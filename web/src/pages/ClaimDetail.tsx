import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, BAND_ZH, fmtDate, fmtDateTime, seqNum, TOPIC_ZH, TYPE_ZH } from '../api'
import { BandTag, ConfBar, Empty, Loading, SectionHead, StateTag, useToast } from '../ui'

interface EvidenceRow {
  id: string
  quote: string
  context_before: string
  context_after: string
  stance: string
  directness: string
  kind: string
  rating: number | null
  published_at: string | null
  author_handle: string | null
  suspected_promo: number
  source_name: string
  source_url: string | null
  platform: string
  source_type: string
  connector: string
  authority_prior: number
  fetched_at: string
  document_url: string | null
  document_title: string
  snapshot_id: string
}

interface Detail {
  id: string
  project_id: string
  seq: number
  claim_type: string
  topic: string
  text: string
  confidence: number | null
  confidence_band: string
  confidence_breakdown: {
    factors?: { factor: string; input: string; logodds: number }[]
    caps?: { rule: string; cap: number }[]
    raw?: number | null
    note?: string
    scorerVersion?: string
  }
  review_state: string
  rank: string
  deprecated_reason: string | null
  superseded_by: string | null
  observed_at: string
  valid_from: string | null
  valid_until: string | null
  version_min: string | null
  version_max: string | null
  opinion_stats: {
    prevalence?: number
    ci_low?: number
    n_holding?: number
    n_discussing?: number
    sample_size?: number
    sentiment?: string
    sampling_note?: string
  } | null
  extraction_provider: string
  run_id: string | null
  created_at: string
  updated_at: string
  evidence: EvidenceRow[]
  conflicts: { id: string; claim_a: string; claim_b: string; claim_a_text: string; claim_b_text: string; conflict_type: string; status: string; detector_note: string }[]
  revisions: { id: number; actor: string; action: string; reason: string; at: string }[]
}

export default function ClaimDetail() {
  const { claimId } = useParams()
  const [d, setD] = useState<Detail | null>(null)
  const [toast, showToast] = useToast()

  const load = useCallback(() => {
    api.get<Detail>(`/app/claims/${claimId}`).then(setD).catch(() => {})
  }, [claimId])

  useEffect(load, [load])

  if (!d) return (<div className="content"><Loading /></div>)

  const review = async (action: string) => {
    await api.post(`/app/claims/${claimId}/review`, { action, reason: '人工审核' })
    showToast(action === 'approve' ? '已通过并进入可信知识库' : action === 'reject' ? '已否决' : '已隔离')
    load()
  }

  const supports = d.evidence.filter((e) => e.stance === 'supports')
  const refutes = d.evidence.filter((e) => e.stance === 'refutes')

  return (
    <div className="content">
      {toast}
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="meta mb8">
            {seqNum(d.seq)} / {TYPE_ZH[d.claim_type] ?? d.claim_type} / {d.id}
          </div>
          <h1 style={{ fontSize: 19, lineHeight: 1.5, maxWidth: 760 }}>
            {d.text}
          </h1>
          {d.rank === 'deprecated' && (
            <div className="small mt8" style={{ color: 'var(--danger)' }}>
              已废弃{d.deprecated_reason ? `：${d.deprecated_reason}` : ''}
              {d.superseded_by && (
                <>
                  {' '}
                  → <Link to={`/claims/${d.superseded_by}`} style={{ textDecoration: 'underline' }}>查看替代结论</Link>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="detail-grid">
        <div>
          {d.claim_type === 'player_opinion' && d.opinion_stats && (
            <div className="panel soft" style={{ marginBottom: 26 }}>
              <div className="sect-label mb8">观点代表性（与事实真伪分开表达）</div>
              <div className="flex" style={{ gap: 28, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>
                    {d.opinion_stats.n_holding}<span className="dim2">/{d.opinion_stats.n_discussing}</span>
                  </div>
                  <div className="meta">持有该观点 / 讨论该话题</div>
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{((d.opinion_stats.ci_low ?? 0) * 100).toFixed(0)}%</div>
                  <div className="meta">WILSON 95% 下界</div>
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{d.opinion_stats.sample_size}</div>
                  <div className="meta">样本量（去重后）</div>
                </div>
              </div>
              <div className="small dim mt8">{d.opinion_stats.sampling_note}</div>
              <div className="small dim2 mt8">此分数表示观点在玩家中的普遍程度，不代表观点内容为事实。点赞数不参与计算。</div>
            </div>
          )}

          <div className="section">
            <SectionHead label="支持证据" count={supports.length} />
            {supports.length === 0 ? (
              <Empty mark="无证据">该结论没有支持证据——这正是它不可信的原因。</Empty>
            ) : (
              supports.map((e) => <EvidenceItem key={e.id} e={e} />)
            )}
          </div>

          {refutes.length > 0 && (
            <div className="section">
              <SectionHead label="反驳证据" count={refutes.length} />
              {refutes.map((e) => (
                <EvidenceItem key={e.id} e={e} />
              ))}
            </div>
          )}

          {d.confidence_breakdown.factors && d.confidence_breakdown.factors.length > 0 && (
            <div className="section">
              <SectionHead label="置信度分解（可解释）">
                <span className="meta">{d.confidence_breakdown.scorerVersion}</span>
              </SectionHead>
              {d.confidence_breakdown.factors.map((f, i) => (
                <div key={i} className="factor-row">
                  <span className="f-name">{f.factor}</span>
                  <span className="f-input">{f.input}</span>
                  <span className={`f-val ${f.logodds > 0 ? 'pos' : f.logodds < 0 ? 'neg' : ''}`}>
                    {f.logodds > 0 ? '+' : ''}
                    {f.logodds.toFixed(2)}
                  </span>
                </div>
              ))}
              {(d.confidence_breakdown.caps ?? []).map((c, i) => (
                <div key={i} className="factor-row">
                  <span className="f-name">上限：{c.rule}</span>
                  <span className="f-input">上限规则生效，置信度封顶</span>
                  <span className="f-val neg">≤ {c.cap.toFixed(2)}</span>
                </div>
              ))}
              <div className="factor-row" style={{ borderBottom: 'none' }}>
                <span className="f-name" style={{ fontWeight: 600 }}>最终</span>
                <span className="f-input">{d.confidence_breakdown.note || `原始 ${d.confidence_breakdown.raw ?? '—'} → 分档 ${BAND_ZH[d.confidence_band]}`}</span>
                <span className="f-val" style={{ fontWeight: 600 }}>{d.confidence ?? '—'}</span>
              </div>
            </div>
          )}

          {d.conflicts.length > 0 && (
            <div className="section">
              <SectionHead label="冲突" count={d.conflicts.length} />
              {d.conflicts.map((c) => {
                const otherId = c.claim_a === d.id ? c.claim_b : c.claim_a
                const otherText = c.claim_a === d.id ? c.claim_b_text : c.claim_a_text
                return (
                  <div key={c.id} className="row">
                    <span className={`tag ${c.status === 'open' ? 't-warn' : ''}`}>{c.status.toUpperCase()}</span>
                    <div className="grow">
                      <Link to={`/claims/${otherId}`} className="title small" style={{ display: 'block' }}>
                        与「{otherText}」{c.conflict_type === 'numeric' ? '数值冲突' : c.conflict_type === 'semantic' ? '语义冲突' : '冲突'}
                      </Link>
                      {c.detector_note && <div className="meta" style={{ marginTop: 2 }}>{c.detector_note}</div>}
                    </div>
                    <Link to={`/projects/${d.project_id}/conflicts`} className="meta" style={{ color: 'var(--blue)' }}>
                      去处理 →
                    </Link>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="meta-panel">
          {(d.review_state === 'pending' || d.review_state === 'quarantined') && (
            <div className="panel" style={{ marginBottom: 18, borderColor: 'var(--ink)' }}>
              <div className="sect-label mb8">人工审核</div>
              <div className="small dim mb8">该结论未达到自动可信标准，需要人工判定。</div>
              <div className="flex">
                <button className="btn sm blue solid" onClick={() => review('approve')}>
                  通过
                </button>
                <button className="btn sm danger" onClick={() => review('reject')}>
                  否决
                </button>
              </div>
            </div>
          )}

          <div className="mp-row">
            <span className="k">置信度</span>
            <span className="v">
              <ConfBar value={d.confidence} band={d.confidence_band} />
            </span>
          </div>
          <div className="mp-row">
            <span className="k">分档</span>
            <span className="v">
              <BandTag band={d.confidence_band} />
            </span>
          </div>
          <div className="mp-row">
            <span className="k">审核状态</span>
            <span className="v">
              <StateTag state={d.review_state} />
            </span>
          </div>
          <div className="mp-row">
            <span className="k">主题</span>
            <span className="v small">{TOPIC_ZH[d.topic] ?? d.topic}</span>
          </div>
          <div className="mp-row">
            <span className="k">抽取来源</span>
            <span className="v mono small">{d.extraction_provider.toUpperCase()}</span>
          </div>
          {d.version_min && (
            <div className="mp-row">
              <span className="k">版本</span>
              <span className="v mono small">
                {d.version_min}
                {d.version_max ? ` – ${d.version_max}` : ' +'}
              </span>
            </div>
          )}
          <div className="mp-row">
            <span className="k">首次观测</span>
            <span className="v mono small">{fmtDate(d.observed_at)}</span>
          </div>
          <div className="mp-row">
            <span className="k">有效期至</span>
            <span className="v mono small">{d.valid_until ? fmtDate(d.valid_until) : '当前有效'}</span>
          </div>
          <div className="mp-row">
            <span className="k">更新</span>
            <span className="v mono small">{fmtDateTime(d.updated_at)}</span>
          </div>
          {d.run_id && (
            <div className="mp-row">
              <span className="k">研究任务</span>
              <span className="v">
                <Link to={`/projects/${d.project_id}/runs/${d.run_id}`} className="mono small" style={{ color: 'var(--blue)' }}>
                  {d.run_id.slice(0, 12)}…
                </Link>
              </span>
            </div>
          )}

          <div className="sect-label" style={{ margin: '20px 0 4px' }}>
            版本记录
          </div>
          {d.revisions.slice(0, 8).map((r) => (
            <div key={r.id} className="mp-row">
              <span className="k mono" style={{ fontSize: 10.5 }}>
                {r.action.toUpperCase()}
              </span>
              <span className="v meta">
                {r.actor} / {fmtDateTime(r.at)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function EvidenceItem({ e }: { e: EvidenceRow }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="evidence-item">
      <div className="quote">
        {expanded && e.context_before && <span className="ctx">…{e.context_before}</span>}
        <span style={{ background: expanded ? 'var(--blue-soft)' : undefined }}>“{e.quote}”</span>
        {expanded && e.context_after && <span className="ctx">{e.context_after}…</span>}
      </div>
      <div className="ev-meta">
        <span className="meta" style={{ color: 'var(--graphite)' }}>
          {e.source_name}
        </span>
        {e.rating !== null && <span className="meta">评分 {e.rating}★</span>}
        {e.author_handle && <span className="meta">@{e.author_handle.slice(0, 16)}</span>}
        <span className="meta">发布 {fmtDate(e.published_at)}</span>
        <span className="meta">抓取 {fmtDate(e.fetched_at)}</span>
        <span className="meta">{e.directness.toUpperCase()}</span>
        {e.suspected_promo === 1 && <span className="tag t-warn">疑似营销</span>}
        <button className="meta" style={{ color: 'var(--blue)', cursor: 'pointer' }} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起上下文' : '展开上下文'}
        </button>
        {e.document_url && (
          <a className="meta" href={e.document_url} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)' }}>
            原文 ↗
          </a>
        )}
      </div>
    </div>
  )
}
