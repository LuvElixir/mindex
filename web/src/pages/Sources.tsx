import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, fmtDate, fmtDateTime } from '../api'
import { Empty, SectionHead } from '../ui'

interface SourceRow {
  id: string
  connector: string
  source_type: string
  name: string
  url: string | null
  platform: string
  authority_prior: number
  robots_status: string
  license_note: string
  fetch_status: string
  last_fetched_at: string | null
  document_count: number
  evidence_count: number
}

interface DocRow {
  id: string
  title: string
  url: string
  doc_type: string
  published_at: string | null
  author_handle: string | null
  snapshot_count: number
  latest_snapshot_id: string | null
}

interface SnapshotDetail {
  id: string
  text: string
  fetched_at: string
  content_hash: string
  raw_path: string | null
  title: string
  source_name: string
  document_url: string
}

export default function Sources() {
  const { id } = useParams()
  const [sources, setSources] = useState<SourceRow[]>([])
  const [openSource, setOpenSource] = useState<string | null>(null)
  const [docs, setDocs] = useState<Record<string, DocRow[]>>({})
  const [snapshot, setSnapshot] = useState<SnapshotDetail | null>(null)

  useEffect(() => {
    api.get<SourceRow[]>(`/app/projects/${id}/sources`).then(setSources).catch(() => {})
  }, [id])

  const toggle = async (sid: string) => {
    if (openSource === sid) {
      setOpenSource(null)
      return
    }
    setOpenSource(sid)
    if (!docs[sid]) {
      const d = await api.get<DocRow[]>(`/app/sources/${sid}/documents`)
      setDocs((prev) => ({ ...prev, [sid]: d }))
    }
  }

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>来源浏览</h1>
          <div className="sub">每条知识都能追溯到这里的某个快照 · {sources.length} 个来源</div>
        </div>
      </div>

      <SectionHead label="知识来源" count={sources.length} />
      {sources.length === 0 ? (
        <Empty mark="无来源">还没有任何来源。启动主动研究或手动导入资料。</Empty>
      ) : (
        <div className="index-list">
          {sources.map((s) => (
            <div key={s.id}>
              <div className="row clickable" onClick={() => toggle(s.id)}>
                <span className="meta" style={{ minWidth: 20 }}>{openSource === s.id ? '−' : '+'}</span>
                <span className="tag">{s.source_type.replace('_', ' ').toUpperCase()}</span>
                <div className="grow">
                  <div className="title">{s.name}</div>
                  <div className="meta" style={{ marginTop: 2 }}>
                    {s.connector.toUpperCase()} / 权威先验 {s.authority_prior.toFixed(2)} / {s.document_count} 文档 / {s.evidence_count} 证据
                    {s.robots_status !== 'n/a' && ` / 爬取协议：${{ allowed: '允许', disallowed: '禁止', unknown: '未知' }[s.robots_status] ?? s.robots_status}`}
                  </div>
                </div>
                <span className={`tag ${s.fetch_status === 'ok' ? '' : s.fetch_status === 'error' ? 't-warn' : 't-dim'}`}>
                  {s.fetch_status.toUpperCase()}
                </span>
                <span className="meta">{fmtDate(s.last_fetched_at)}</span>
              </div>
              {openSource === s.id && (
                <div style={{ padding: '4px 0 14px 40px', borderBottom: '1px solid var(--line-soft)' }}>
                  {s.license_note && <div className="meta mb8">许可: {s.license_note}</div>}
                  {(docs[s.id] ?? []).map((doc) => (
                    <div key={doc.id} className="row" style={{ padding: '6px 0' }}>
                      <span className="tag t-dim">{doc.doc_type.toUpperCase()}</span>
                      <div className="grow">
                        <div className="title small">{doc.title || doc.url}</div>
                        <div className="meta">
                          {doc.author_handle ? `@${doc.author_handle.slice(0, 20)} / ` : ''}
                          发布 {fmtDate(doc.published_at)} / {doc.snapshot_count} 个快照
                        </div>
                      </div>
                      {doc.latest_snapshot_id && (
                        <button
                          className="meta"
                          style={{ color: 'var(--blue)', cursor: 'pointer' }}
                          onClick={() => api.get<SnapshotDetail>(`/app/snapshots/${doc.latest_snapshot_id}`).then(setSnapshot)}
                        >
                          查看快照
                        </button>
                      )}
                    </div>
                  ))}
                  {docs[s.id]?.length === 0 && <div className="meta">无文档</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {snapshot && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(11,11,13,0.35)', zIndex: 60,
            display: 'grid', placeItems: 'center', padding: 30,
          }}
          onClick={() => setSnapshot(null)}
        >
          <div
            style={{
              background: 'var(--bg)', borderRadius: 'var(--r-float)', maxWidth: 760, width: '100%',
              maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(11,11,13,0.25)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)' }}>
              <div className="flex" style={{ justifyContent: 'space-between' }}>
                <div style={{ fontWeight: 600 }}>{snapshot.title || '内容快照'}</div>
                <button className="btn sm ghost" onClick={() => setSnapshot(null)}>
                  关闭
                </button>
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                {snapshot.source_name} / 抓取 {fmtDateTime(snapshot.fetched_at)} / SHA256 {snapshot.content_hash.slice(0, 16)}…
              </div>
            </div>
            <div style={{ padding: '18px 22px', overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, color: 'var(--graphite)' }}>
              {snapshot.text.slice(0, 20000)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
