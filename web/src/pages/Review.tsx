import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, fmtDate, seqNum } from '../api'
import { BandTag, Empty, SectionHead, TypeTag, useToast } from '../ui'

interface QueueItem {
  id: string
  item_type: string
  item_id: string
  reason: string
  priority: number
  created_at: string
  payload: {
    id?: string
    seq?: number
    text?: string
    claim_type?: string
    confidence?: number | null
    confidence_band?: string
    evidence?: { quote: string; source_name: string }[]
    name?: string
    connector?: string
  } | null
}

const REASON_ZH: Record<string, string> = {
  low_confidence: '置信度不足',
  insufficient_evidence: '证据不足',
  conflict_open: '存在未解决冲突',
  astroturf_suspect: '疑似批量/失真内容',
  patch_invalidation: '版本更新可能使其过期',
  citation_check_failed: '引用校验失败',
  manual: '人工标记',
}

export default function Review() {
  const { id } = useParams()
  const [items, setItems] = useState<QueueItem[]>([])
  const [toast, showToast] = useToast()

  const load = useCallback(() => {
    api.get<QueueItem[]>(`/app/projects/${id}/review-queue`).then(setItems).catch(() => {})
  }, [id])

  useEffect(load, [load])

  const act = async (item: QueueItem, action: 'approve' | 'reject') => {
    if (item.item_type === 'claim') {
      await api.post(`/app/claims/${item.item_id}/review`, { action, reason: '审核队列处理' })
    }
    showToast(action === 'approve' ? '已通过' : '已否决')
    load()
  }

  return (
    <div className="content">
      {toast}
      <div className="page-head">
        <div>
          <h1>审核队列</h1>
          <div className="sub">低置信、冲突或疑似失真的内容在这里等待人工判定——不会静默进入可信知识库</div>
        </div>
      </div>

      <SectionHead label="待审核" count={items.length} />
      {items.length === 0 ? (
        <Empty mark="已清空">队列为空。所有知识要么已可信，要么已处理。</Empty>
      ) : (
        <div className="index-list">
          {items.map((item) => (
            <div key={item.id} className="row" style={{ alignItems: 'flex-start', padding: '14px 6px' }}>
              <span className="idx" style={{ paddingTop: 2 }}>
                P{item.priority}
              </span>
              <div className="grow">
                {item.item_type === 'claim' && item.payload ? (
                  <>
                    <div className="flex mb8" style={{ flexWrap: 'wrap' }}>
                      <TypeTag type={item.payload.claim_type ?? ''} />
                      <BandTag band={item.payload.confidence_band ?? ''} />
                      <span className="tag t-ink">{REASON_ZH[item.reason] ?? item.reason}</span>
                    </div>
                    <Link to={`/claims/${item.item_id}`} className="title wrap" style={{ fontSize: 14, display: 'block' }}>
                      {seqNum(item.payload.seq)} · {item.payload.text}
                    </Link>
                    {item.payload.evidence && item.payload.evidence.length > 0 && (
                      <div className="small dim mt8" style={{ borderLeft: '2px solid var(--line)', paddingLeft: 10 }}>
                        “{item.payload.evidence[0].quote.slice(0, 140)}
                        {item.payload.evidence[0].quote.length > 140 ? '…' : ''}” — {item.payload.evidence[0].source_name}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex mb8">
                      <span className="tag">{item.item_type.toUpperCase()}</span>
                      <span className="tag t-ink">{REASON_ZH[item.reason] ?? item.reason}</span>
                    </div>
                    <div className="title small">
                      {item.payload?.name ?? item.item_id}
                      {item.payload?.connector ? ` (${item.payload.connector})` : ''}
                    </div>
                  </>
                )}
                <div className="meta mt8">入队 {fmtDate(item.created_at)}</div>
              </div>
              {item.item_type === 'claim' && (
                <div className="flex" style={{ flexShrink: 0 }}>
                  <button className="btn sm blue" onClick={() => act(item, 'approve')}>
                    通过
                  </button>
                  <button className="btn sm danger" onClick={() => act(item, 'reject')}>
                    否决
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
