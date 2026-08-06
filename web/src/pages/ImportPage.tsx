import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'

interface ConnectorInfo {
  id: string
  label: string
  status: string
  compliance: string
}

interface ParsePreview {
  count: number
  with_score: number
  with_author: number
  sample: { content: string; score: number | null; author: string | null; upVotes: number | null }[]
}

export default function ImportPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [adapters, setAdapters] = useState<ConnectorInfo[]>([])
  const [mode, setMode] = useState<'doc' | 'reviews'>('doc')

  // doc import
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [fetchUrl, setFetchUrl] = useState('')
  const [platform, setPlatform] = useState('internal')
  const [sourceType, setSourceType] = useState('user_note')

  // review batch import
  const [rvPlatform, setRvPlatform] = useState('taptap')
  const [rvAppName, setRvAppName] = useState('')
  const [rvUrl, setRvUrl] = useState('')
  const [rvMd, setRvMd] = useState('')
  const [preview, setPreview] = useState<ParsePreview | null>(null)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.get<ConnectorInfo[]>('/app/connectors').then((cs) => setAdapters(cs.filter((c) => c.status !== 'verified'))).catch(() => {})
  }, [])

  const doPreview = async () => {
    setErr('')
    setPreview(null)
    try {
      const r = await api.post<ParsePreview>('/app/parse-reviews', { markdown: rvMd })
      setPreview(r)
    } catch (e) {
      setErr(String((e as Error).message))
    }
  }

  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>手动导入</h1>
          <div className="sub">上传文档，或批量导入外部采集的平台评论（如 TapTap，由你的 Agent 抓取后导入）</div>
        </div>
      </div>

      <div className="filters" style={{ marginBottom: 20 }}>
        <button className={`fchip ${mode === 'doc' ? 'on' : ''}`} onClick={() => setMode('doc')}>
          文档导入
        </button>
        <button className={`fchip ${mode === 'reviews' ? 'on' : ''}`} onClick={() => setMode('reviews')}>
          评论批量导入（TapTap 等）
        </button>
      </div>

      {mode === 'doc' && (
        <>
          <div className="panel soft mb16">
            <div className="sect-label mb8">为什么有些平台需要手动导入？</div>
            {adapters.map((a) => (
              <div key={a.id} className="small dim" style={{ padding: '3px 0' }}>
                <b style={{ color: 'var(--graphite)' }}>{a.label}</b> — {a.compliance}
              </div>
            ))}
          </div>

          <div className="panel soft mb16">
            <div className="sect-label mb8">URL 抓取导入</div>
            <div className="small dim" style={{ marginBottom: 8 }}>
              粘贴文章链接（行业媒体 / 官网公告等），服务端抓取正文后走同一条溯源管线。JS 渲染或反爬页面会如实报错，请改用下方复制粘贴。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={fetchUrl}
                onChange={(e) => setFetchUrl(e.target.value)}
                placeholder="https://youxiputao.com/article/..."
              />
              <button
                type="button"
                className="btn"
                disabled={busy || !/^https?:\/\//.test(fetchUrl.trim())}
                onClick={async () => {
                  setBusy(true)
                  setErr('')
                  try {
                    const r = await api.post<{ run_id: string }>(`/app/projects/${id}/import-url`, {
                      url: fetchUrl.trim(),
                      platform,
                      source_type: sourceType,
                    })
                    navigate(`/projects/${id}/runs/${r.run_id}`)
                  } catch (error) {
                    setErr(String((error as Error).message))
                    setBusy(false)
                  }
                }}
              >
                抓取导入
              </button>
            </div>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              setErr('')
              try {
                const r = await api.post<{ run_id: string }>(`/app/projects/${id}/import`, {
                  title: title.trim(),
                  text: text.trim(),
                  url: url.trim() || undefined,
                  platform,
                  source_type: sourceType,
                })
                navigate(`/projects/${id}/runs/${r.run_id}`)
              } catch (error) {
                setErr(String((error as Error).message))
                setBusy(false)
              }
            }}
          >
            <div className="field">
              <label>标题 *</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：官方公告 / 内部调研摘要" required />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="field">
                <label>来源平台</label>
                <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                  <option value="internal">内部资料</option>
                  <option value="taptap">TapTap</option>
                  <option value="haoyoukuaibao">好游快爆</option>
                  <option value="weibo">微博</option>
                  <option value="tieba">百度贴吧</option>
                  <option value="other">其他</option>
                </select>
              </div>
              <div className="field">
                <label>内容性质</label>
                <select className="input" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                  <option value="user_note">用户笔记/整理</option>
                  <option value="official">官方内容</option>
                  <option value="internal_doc">内部文档</option>
                  <option value="press">媒体报道</option>
                  <option value="community">社区内容（玩家评论等）</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>原始链接（可选）</label>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://... 用于溯源" />
            </div>
            <div className="field">
              <label>内容全文 *</label>
              <textarea
                className="input"
                style={{ minHeight: 220 }}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="粘贴文本内容（公告、字幕、文档等）。导入后作为可追溯的来源快照并触发知识抽取。"
                required
              />
              <div className="hint">{text.length} 字符 · 完整存档为快照，抽取的每条结论都带引用回到原文</div>
            </div>
            {err && <div className="small" style={{ color: 'var(--danger)', marginBottom: 14 }}>{err}</div>}
            <button className="btn primary" disabled={busy || !title.trim() || text.trim().length < 20}>
              {busy ? '导入中…' : '导入并抽取知识'}
            </button>
          </form>
        </>
      )}

      {mode === 'reviews' && (
        <>
          <div className="panel soft mb16">
            <div className="sect-label mb8">评论批量导入</div>
            <div className="small dim">
              把外部 Agent（如 Hermes）抓取的 TapTap 评论粘进来。系统会**逐条**拆成独立评论 → 走玩家口碑管线 → 产出带引用的
              player_opinion，与 B站 / 小红书评论同等对待。点赞数仅展示，不计入置信度。
              <br />
              支持 Markdown（自动识别评分 ★/评分：N、作者、日期、点赞）；不确定就先「预览解析」看拆出多少条。
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div className="field">
              <label>平台</label>
              <select className="input" value={rvPlatform} onChange={(e) => setRvPlatform(e.target.value)}>
                <option value="taptap">TapTap</option>
                <option value="haoyoukuaibao">好游快爆</option>
                <option value="xiaohongshu">小红书</option>
                <option value="tieba">百度贴吧</option>
                <option value="other">其他</option>
              </select>
            </div>
            <div className="field">
              <label>产品名（可选）</label>
              <input className="input" value={rvAppName} onChange={(e) => setRvAppName(e.target.value)} placeholder="例：燕云十六声" />
            </div>
            <div className="field">
              <label>来源链接（可选）</label>
              <input className="input mono" value={rvUrl} onChange={(e) => setRvUrl(e.target.value)} placeholder="https://www.taptap.cn/app/..." />
            </div>
          </div>

          <div className="field">
            <label>评论 Markdown *</label>
            <textarea
              className="input"
              style={{ minHeight: 260, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
              value={rvMd}
              onChange={(e) => {
                setRvMd(e.target.value)
                setPreview(null)
              }}
              placeholder={'粘贴 Hermes 抓取的 TapTap 评论。每条评论之间用 --- 分隔，或用 ### / 数字编号；\n每条可含 ★评分、作者、日期、点赞数 + 评论正文。'}
            />
            <div className="hint">{rvMd.length} 字符</div>
          </div>

          {preview && (
            <div className="panel mb16" style={{ borderColor: 'var(--blue)' }}>
              <div className="small">
                解析出 <b style={{ color: 'var(--blue)' }}>{preview.count}</b> 条评论 · {preview.with_score} 条含评分 · {preview.with_author} 条含作者
              </div>
              {preview.sample.map((s, i) => (
                <div key={i} className="small dim mt8" style={{ borderLeft: '2px solid var(--line)', paddingLeft: 10 }}>
                  {s.score != null && <span className="tag t-blue" style={{ marginRight: 6 }}>{'★'.repeat(s.score)}</span>}
                  {s.author && <span className="meta" style={{ marginRight: 6 }}>@{s.author}</span>}
                  {s.content}…
                </div>
              ))}
              {preview.count === 0 && <div className="small mt8" style={{ color: 'var(--danger)' }}>没解析出评论——检查分隔格式，或粘一小段样本发我调整解析器。</div>}
            </div>
          )}

          {err && <div className="small" style={{ color: 'var(--danger)', marginBottom: 14 }}>{err}</div>}

          <div className="flex">
            <button className="btn ghost" onClick={doPreview} disabled={rvMd.trim().length < 10}>
              预览解析
            </button>
            <button
              className="btn primary"
              disabled={busy || rvMd.trim().length < 10}
              onClick={async () => {
                setBusy(true)
                setErr('')
                try {
                  const r = await api.post<{ run_id: string; parsed_reviews: number }>(`/app/projects/${id}/import-reviews`, {
                    platform: rvPlatform,
                    app_name: rvAppName.trim() || undefined,
                    source_url: rvUrl.trim() || undefined,
                    format: 'markdown',
                    markdown: rvMd,
                  })
                  navigate(`/projects/${id}/runs/${r.run_id}`)
                } catch (error) {
                  setErr(String((error as Error).message))
                  setBusy(false)
                }
              }}
            >
              {busy ? '导入中…' : '导入并抽取口碑'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
