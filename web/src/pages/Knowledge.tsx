import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, BAND_ZH, fmtDate, seqNum, STATE_ZH, TOPIC_ZH, TYPE_ZH } from '../api'
import { BandTag, ConfBar, Empty, Loading, OpinionMeter, SectionHead, TypeTag } from '../ui'

interface ClaimRow {
  id: string
  seq: number
  claim_type: string
  topic: string
  text: string
  confidence: number | null
  confidence_band: string
  review_state: string
  rank: string
  extraction_provider: string
  evidence_count: number
  opinion_stats: { n_holding?: number; n_discussing?: number; sentiment?: string } | null
  updated_at: string
}

export default function Knowledge() {
  const { id } = useParams()
  const [sp, setSp] = useSearchParams()
  const [data, setData] = useState<{ total: number; claims: ClaimRow[] } | null>(null)

  const type = sp.get('type') ?? ''
  const band = sp.get('band') ?? ''
  const topic = sp.get('topic') ?? ''
  const state = sp.get('state') ?? ''
  const q = sp.get('q') ?? ''
  const [qInput, setQInput] = useState(q)

  useEffect(() => {
    const params = new URLSearchParams()
    if (type) params.set('type', type)
    if (band) params.set('band', band)
    if (topic) params.set('topic', topic)
    if (state) params.set('state', state)
    if (q) params.set('q', q)
    params.set('limit', '200')
    api.get<{ total: number; claims: ClaimRow[] }>(`/app/projects/${id}/claims?${params}`).then(setData).catch(() => {})
  }, [id, type, band, topic, state, q])

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(sp)
    if (value) next.set(key, value)
    else next.delete(key)
    setSp(next, { replace: true })
  }

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>知识索引</h1>
          <div className="sub">{data ? `${data.total} 条结论` : ''}</div>
        </div>
      </div>

      <div className="filters">
        {['', 'official_fact', 'player_opinion', 'system_inference', 'creative_insight'].map((t) => (
          <button key={t} className={`fchip ${type === t ? 'on' : ''}`} onClick={() => setFilter('type', t)}>
            {t === '' ? '全部' : TYPE_ZH[t]}
          </button>
        ))}
        <span style={{ width: 12 }} />
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setFilter('q', qInput.trim())
          }}
        >
          <input
            className="input"
            style={{ width: 200, padding: '4px 10px', fontSize: 12.5 }}
            placeholder="在结论中筛选…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onBlur={() => setFilter('q', qInput.trim())}
          />
        </form>
        <select value={band} onChange={(e) => setFilter('band', e.target.value)}>
          <option value="">全部置信档</option>
          {Object.entries(BAND_ZH).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={topic} onChange={(e) => setFilter('topic', e.target.value)}>
          <option value="">全部主题</option>
          {Object.entries(TOPIC_ZH).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={state} onChange={(e) => setFilter('state', e.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(STATE_ZH).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>

      <SectionHead label="知识结论" count={data?.total ?? '…'} />
      {!data ? (
        <Loading label="索引中" />
      ) : data.claims.length === 0 ? (
        <Empty mark="暂无知识">
          没有符合条件的知识条目。<Link to={`/projects/${id}`} style={{ color: 'var(--blue)' }}>启动主动研究 →</Link>
        </Empty>
      ) : (
        <div className="index-list">
          {data.claims.map((c) => (
            <Link key={c.id} to={`/claims/${c.id}`} className="row">
              <span className="idx">{seqNum(c.seq)}</span>
              <TypeTag type={c.claim_type} />
              <div className="grow">
                <div className="title wrap" style={c.rank === 'deprecated' ? { textDecoration: 'line-through', color: 'var(--grey-2)' } : {}}>
                  {c.text}
                </div>
                <div className="meta" style={{ marginTop: 3 }}>
                  {TOPIC_ZH[c.topic] ?? c.topic} / {c.evidence_count} 条证据 / {fmtDate(c.updated_at)}
                  {c.review_state === 'pending' && ' / 待审核'}
                  {c.review_state === 'quarantined' && ' / 已隔离'}
                </div>
              </div>
              {c.claim_type === 'player_opinion' ? (
                <OpinionMeter stats={c.opinion_stats as { n_holding?: number; sample_size?: number; ci_low?: number } | null} />
              ) : (
                <ConfBar value={c.confidence} band={c.confidence_band} />
              )}
              <BandTag band={c.confidence_band} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
