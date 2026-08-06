import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, fmtDate, seqNum } from '../api'
import { BandTag, ConfBar, Empty, OpinionMeter, SectionHead, TypeTag } from '../ui'

interface Hit {
  id: string
  seq: number
  claim_type: string
  topic: string
  text: string
  confidence: number | null
  confidence_band: string
  review_state: string
  opinion_stats: { n_holding?: number; sample_size?: number; ci_low?: number } | null
  project_id: string
  project_name: string
  updated_at: string
  score: number
  matched_via: string[]
}

export default function GlobalSearch() {
  const [sp, setSp] = useSearchParams()
  const q = sp.get('q') ?? ''
  const [input, setInput] = useState(q)
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [trustedOnly, setTrustedOnly] = useState(false)

  useEffect(() => {
    setInput(q)
    if (!q.trim()) {
      setHits(null)
      return
    }
    api
      .get<Hit[]>(`/app/search?q=${encodeURIComponent(q)}&include_untrusted=${!trustedOnly}&limit=50`)
      .then(setHits)
      .catch(() => setHits([]))
  }, [q, trustedOnly])

  return (
    <div className="content">
      <div className="page-head">
        <div style={{ flex: 1 }}>
          <h1>全局搜索</h1>
          <div className="sub">关键词 + 证据命中混合检索，按置信度与时效重排</div>
        </div>
      </div>

      <form
        className="flex mb16"
        onSubmit={(e) => {
          e.preventDefault()
          setSp(input.trim() ? { q: input.trim() } : {})
        }}
      >
        <input
          className="input"
          style={{ maxWidth: 520, fontSize: 15 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="搜索知识结论、证据原文…"
          autoFocus
        />
        <button className="btn primary">搜索</button>
        <label className="flex small dim" style={{ cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={trustedOnly} onChange={(e) => setTrustedOnly(e.target.checked)} />
          只看可信知识
        </label>
      </form>

      {hits !== null && (
        <>
          <SectionHead label="搜索结果" count={hits.length} />
          {hits.length === 0 ? (
            <Empty mark="无匹配">没有找到匹配的知识。试试换个关键词，或先对项目启动主动研究。</Empty>
          ) : (
            <div className="index-list">
              {hits.map((h) => (
                <Link key={h.id} to={`/claims/${h.id}`} className="row">
                  <span className="idx">{seqNum(h.seq)}</span>
                  <TypeTag type={h.claim_type} />
                  <div className="grow">
                    <div className="title wrap">{h.text}</div>
                    <div className="meta" style={{ marginTop: 3 }}>
                      {h.project_name} / 命中: {h.matched_via.join('+')} / {fmtDate(h.updated_at)}
                      {h.review_state === 'pending' && ' / 待审核'}
                      {h.review_state === 'quarantined' && ' / 已隔离'}
                    </div>
                  </div>
                  {h.claim_type === 'player_opinion' ? (
                    <OpinionMeter stats={h.opinion_stats} />
                  ) : (
                    <ConfBar value={h.confidence} band={h.confidence_band} />
                  )}
                  <BandTag band={h.confidence_band} />
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
