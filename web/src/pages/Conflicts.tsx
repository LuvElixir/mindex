import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, fmtDate, BAND_ZH } from '../api'
import { Empty, SectionHead, useToast } from '../ui'

interface ConflictRow {
  id: string
  claim_a: string
  claim_b: string
  claim_a_text: string
  claim_b_text: string
  claim_a_band: string
  claim_b_band: string
  conflict_type: string
  detected_by: string
  detector_note: string
  status: string
  resolution_note: string
  created_at: string
}

const TYPE_ZH_MAP: Record<string, string> = {
  numeric: '数值冲突',
  version_temporal: '版本时序',
  semantic: '语义矛盾',
  opinion_split: '观点分歧',
}

export default function Conflicts() {
  const { id } = useParams()
  const [rows, setRows] = useState<ConflictRow[]>([])
  const [toast, showToast] = useToast()

  const load = useCallback(() => {
    api.get<ConflictRow[]>(`/app/projects/${id}/conflicts`).then(setRows).catch(() => {})
  }, [id])

  useEffect(load, [load])

  const resolve = async (cid: string, status: string, note: string) => {
    await api.post(`/app/conflicts/${cid}/resolve`, { status, note })
    showToast('冲突已处理，相关结论已重新评分')
    load()
  }

  const open = rows.filter((r) => r.status === 'open')
  const closed = rows.filter((r) => r.status !== 'open')

  const ConflictCard = ({ c }: { c: ConflictRow }) => (
    <div className="panel" style={{ marginBottom: 14, borderColor: c.status === 'open' ? 'color-mix(in srgb, var(--danger) 40%, transparent)' : 'var(--line)' }}>
      <div className="flex mb8" style={{ flexWrap: 'wrap' }}>
        <span className={`tag ${c.status === 'open' ? 't-warn' : ''}`}>{TYPE_ZH_MAP[c.conflict_type] ?? c.conflict_type}</span>
        <span className="meta">{c.detected_by}</span>
        <span className="meta">{fmtDate(c.created_at)}</span>
        {c.status !== 'open' && <span className="tag">{c.status.toUpperCase()}</span>}
      </div>
      {c.detector_note && <div className="small dim mb8">{c.detector_note}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {([['A', c.claim_a, c.claim_a_text, c.claim_a_band], ['B', c.claim_b, c.claim_b_text, c.claim_b_band]] as const).map(
          ([side, cid2, text, band]) => (
            <div key={side} style={{ borderLeft: '2px solid var(--line)', paddingLeft: 12 }}>
              <div className="meta mb8">
                结论 {side} / {BAND_ZH[band] ?? band}
              </div>
              <Link to={`/claims/${cid2}`} className="small" style={{ display: 'block' }}>
                {text}
              </Link>
            </div>
          ),
        )}
      </div>
      {c.status === 'open' && (
        <div className="flex mt16" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => resolve(c.id, 'resolved_a', 'A 正确，B 废弃')}>
            A 正确
          </button>
          <button className="btn sm" onClick={() => resolve(c.id, 'resolved_b', 'B 正确，A 废弃')}>
            B 正确
          </button>
          <button className="btn sm ghost" onClick={() => resolve(c.id, 'both_valid_scoped', '限定语境不同，两者并存')}>
            语境不同，并存
          </button>
          <button className="btn sm ghost" onClick={() => resolve(c.id, 'dismissed', '误报')}>
            误报
          </button>
        </div>
      )}
      {c.resolution_note && <div className="meta mt8">处理: {c.resolution_note}</div>}
    </div>
  )

  return (
    <div className="content">
      {toast}
      <div className="page-head">
        <div>
          <h1>冲突</h1>
          <div className="sub">互相矛盾的结论会被强制标记为 DISPUTED，直到人工裁决或补充限定语境</div>
        </div>
      </div>

      <div className="section">
        <SectionHead label="未解决" count={open.length} />
        {open.length === 0 ? <Empty mark="无冲突">当前没有未解决的冲突。</Empty> : open.map((c) => <ConflictCard key={c.id} c={c} />)}
      </div>

      {closed.length > 0 && (
        <div className="section">
          <SectionHead label="已解决" count={closed.length} />
          {closed.map((c) => (
            <ConflictCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}
