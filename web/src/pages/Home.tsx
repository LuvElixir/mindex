import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, BAND_LABEL, TYPE_LABEL, getToken } from '../api'
import { mountSky, type SkyHandle, type SkyProject } from '../sky'
import { Star } from '../ui'

/**
 * 首页 = 星空即检索：上为知识星图横带（每个星座一个真实项目），下为编辑式带引用问答。
 * 流式（SSE /app/chat/stream）：检索一命中，星座即点亮、光尘入答（真实事件），
 * 回答逐字平静流出，尾随一枚不闪烁的细蓝竖标；完成时引用与来源列表按原号对齐（无跳变）。
 * 未命中 → 扫描线掠过 + 诚实说不知道。
 */

interface Citation {
  n?: number
  claim_id: string
  seq: number
  text: string
  band: string
  claim_type: string
  project_name: string
  project_id: string
}

interface Turn {
  q: string
  working?: boolean
  stream?: string
  answer?: string
  citations?: Citation[]
  insufficient?: boolean
  hits?: number
  error?: string
}

interface GraphNode {
  id: string
  type: string
  label: string
  claims: number
  trusted: number
  projectId: string
}

interface OverviewLite {
  projects: { id: string; name: string; demo?: number; stats: { claims: number; trusted: number; sources: number } }[]
}

interface ChatResult {
  answer: string
  citations: Citation[]
  insufficient: boolean
  stats?: { hits: number }
}

/** 解析 SSE 帧流，按事件回调 */
async function consumeSse(res: Response, on: (event: string, data: Record<string, unknown>) => void): Promise<void> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let ev = 'message'
      let data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7).trim()
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (data) {
        try {
          on(ev, JSON.parse(data))
        } catch {
          /* 忽略残帧 */
        }
      }
    }
  }
}

export default function Home() {
  const navigate = useNavigate()
  const cvRef = useRef<HTMLCanvasElement>(null)
  const sky = useRef<SkyHandle | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const [overview, setOverview] = useState<OverviewLite | null>(null)
  const [projectCount, setProjectCount] = useState(0)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [turns, setTurns] = useState<Turn[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('mindex_thread') ?? '[]') as Turn[]
    } catch {
      return []
    }
  })

  useEffect(() => {
    sessionStorage.setItem('mindex_thread', JSON.stringify(turns.filter((t) => !t.working).slice(-12)))
  }, [turns])

  // 星图：真实项目 + 实体 → 星座
  useEffect(() => {
    let alive = true
    Promise.all([api.get<{ nodes: GraphNode[] }>('/app/graph'), api.get<OverviewLite>('/app/overview')])
      .then(([g, o]) => {
        if (!alive || !cvRef.current) return
        setOverview(o)
        const projects: SkyProject[] = g.nodes
          .filter((n) => n.type === 'project')
          .map((p) => ({
            id: p.id,
            name: p.label,
            claims: p.claims,
            trusted: p.trusted,
            entities: g.nodes.filter((n) => n.type !== 'project' && n.projectId === p.id).slice(0, 5).map((n) => n.label),
          }))
        setProjectCount(projects.length)
        sky.current?.destroy()
        sky.current = mountSky(cvRef.current, projects, (id) => navigate(`/projects/${id}`))
      })
      .catch(() => {})
    return () => {
      alive = false
      sky.current?.destroy()
      sky.current = null
    }
  }, [navigate])

  const patchLast = useCallback((patch: Partial<Turn>) => {
    setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, ...patch } : t)))
  }, [])

  const settle = useCallback(
    (r: ChatResult) => {
      patchLast({ working: false, stream: undefined, answer: r.answer, citations: r.citations, insufficient: r.insufficient, hits: r.stats?.hits ?? r.citations.length })
      if (r.insufficient) {
        sky.current?.setFlare(null)
        sky.current?.sweep()
      } else {
        setTimeout(() => sky.current?.setFlare(null), 1600)
      }
    },
    [patchLast],
  )

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim()
      if (!q || busy) return
      setInput('')
      setBusy(true)
      const history = turns
        .filter((t) => t.answer)
        .flatMap((t) => [
          { role: 'user' as const, content: t.q },
          { role: 'assistant' as const, content: t.answer! },
        ])
        .slice(-8)
      setTurns((ts) => [...ts, { q, working: true }])
      try {
        const res = await fetch('/app/chat/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` },
          body: JSON.stringify({ question: q, history }),
        })
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`)
        let acc = ''
        let settled = false
        await consumeSse(res, (ev, data) => {
          if (ev === 'stage') {
            patchLast({ hits: data.hits as number })
            const pids = (data.project_ids as string[]) ?? []
            if (pids.length) {
              sky.current?.setFlare(pids[0]!)
              sky.current?.burst(pids)
            }
          } else if (ev === 'delta') {
            acc += data.text as string
            patchLast({ stream: acc })
          } else if (ev === 'done') {
            settled = true
            settle(data as unknown as ChatResult)
          } else if (ev === 'error') {
            settled = true
            patchLast({ working: false, error: String(data.message ?? '流式请求失败') })
            sky.current?.setFlare(null)
          }
        })
        if (!settled) throw new Error('流中断')
      } catch {
        // 流式不可用（代理缓冲/网络等）→ 回退非流式接口，结果一致只是无逐字过程
        try {
          const r = await api.post<ChatResult>('/app/chat', { question: q, history })
          settle(r)
          if (!r.insufficient) {
            const pids = [...new Set(r.citations.map((c) => c.project_id))]
            sky.current?.burst(pids)
          }
        } catch (e2) {
          patchLast({ working: false, error: String((e2 as Error).message) })
        }
      } finally {
        setBusy(false)
      }
    },
    [busy, turns, patchLast, settle],
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [turns.length, busy])

  const totals = overview?.projects.reduce(
    (acc, p) => ({ claims: acc.claims + p.stats.claims, trusted: acc.trusted + p.stats.trusted, sources: acc.sources + p.stats.sources }),
    { claims: 0, trusted: 0, sources: 0 },
  )
  const askable = (overview?.projects ?? []).filter((p) => p.stats.trusted > 0 && p.demo !== 1)
  const chipTemplates = [
    (n: string) => `${n} 的玩家口碑集中在哪些方面？`,
    (n: string) => `${n} 的开发商和基本信息是什么？`,
    (n: string) => `${n} 的核心卖点有哪些？`,
  ]

  // 视窗高度随项目数自适应：项目少时不留大片空黑
  const skyH = projectCount <= 2 ? 240 : projectCount <= 4 ? 300 : 380

  return (
    <div className="home2">
      <div className="sky2" style={{ height: skyH }}>
        <canvas ref={cvRef} />
        <span className="sky-cap">知识星图</span>
        {totals && (
          <div className="sky-kb">
            <span><b>{totals.claims}</b> 条结论</span>
            <span className="hl"><b>{totals.trusted}</b> 条可信</span>
            <span><b>{totals.sources}</b> 个来源</span>
            <span><b>{overview!.projects.length}</b> 个项目</span>
          </div>
        )}
      </div>

      <div className="ask-zone">
        <form
          className="ask"
          onSubmit={(e) => {
            e.preventDefault()
            void ask(input)
          }}
        >
          <Star working={busy} />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={turns.length ? '继续问…' : '向知识库提问——回答只来自可信结论，每句带引用'}
            maxLength={500}
          />
          <span className="kbd">⏎</span>
        </form>
        {turns.length === 0 && askable.length > 0 && (
          <div className="chips">
            {askable.slice(0, 3).map((p, i) => {
              const q = chipTemplates[i % chipTemplates.length]!(p.name)
              return (
                <button key={p.id} className="chip" onClick={() => void ask(q)}>
                  {q}
                </button>
              )
            })}
          </div>
        )}
        {turns.length === 0 && (
          <div className="honesty">证据不足时会直说不知道 · 不引入库外知识 · 引文逐字可回溯</div>
        )}
      </div>

      <div className="thread2">
        {turns.map((t, i) => (
          <div className="turn2" key={i}>
            <div className="q2">
              <span className="who">你</span>
              {t.q}
            </div>
            {t.working ? (
              <>
                <div className="trace">
                  <div className="st on">
                    <span className="ix">01</span>
                    <span>检索知识库</span>
                    <span className="r">{t.hits != null ? `命中 ${t.hits} 条可信结论` : <Star working />}</span>
                  </div>
                  {t.stream != null && (
                    <div className="st on">
                      <span className="ix">02</span>
                      <span>生成回答</span>
                      <span className="r"><Star working /></span>
                    </div>
                  )}
                </div>
                {t.stream != null && (
                  <div className="answer">
                    {renderStreaming(t.stream)}
                  </div>
                )}
              </>
            ) : t.error ? (
              <div className="insuff on">
                <div className="h">请求失败</div>
                <div className="b">{t.error}</div>
              </div>
            ) : (
              <>
                <div className="trace">
                  <div className="st reveal r1">
                    <span className="ix">01</span>
                    <span>检索知识库</span>
                    <span className="r">{t.insufficient ? `${t.hits ?? 0} 条可信结论` : `命中 ${t.hits} 条可信结论`}</span>
                  </div>
                  {!t.insufficient && (
                    <div className="st reveal r2">
                      <span className="ix">02</span>
                      <span>生成回答</span>
                      <span className="r">引用 {t.citations?.length ?? 0} 条 <Star /></span>
                    </div>
                  )}
                </div>
                {t.insufficient ? (
                  <div className="insuff reveal r2">
                    <div className="h">证据不足</div>
                    <div className="b">{t.answer}</div>
                    <div className="cta">
                      <button className="btn blue" onClick={() => navigate('/new')}>
                        <Star /> 新研究
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="answer reveal r3">{renderAnswer(t.answer ?? '', t.citations ?? [], sky, navigate)}</div>
                    {(t.citations?.length ?? 0) > 0 && (
                      <div className="sources2 reveal r4">
                        <div className="label">
                          Sources <span className="n">/ {String(t.citations!.length).padStart(2, '0')} · 点击回溯原文与置信度拆解 · 悬停时星空中对应的星座会亮</span>
                        </div>
                        {t.citations!.map((c, k) => (
                          <div
                            className="src"
                            key={c.claim_id + k}
                            onClick={() => navigate(`/claims/${c.claim_id}`)}
                            onMouseEnter={() => sky.current?.setFlare(c.project_id)}
                            onMouseLeave={() => sky.current?.setFlare(null)}
                          >
                            <span className="cn">C{c.n ?? k + 1}</span>
                            <span className="tag t-blue">
                              {BAND_LABEL[c.band] ?? c.band} · {TYPE_LABEL[c.claim_type] ?? c.claim_type}
                            </span>
                            <span className="txt">{c.text}</span>
                            <span className="from">{c.project_name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}

/** 流式中的回答：[Cn] 先以静态引用标呈现（完成后才可交互），尾随不闪烁细蓝竖标 */
function renderStreaming(text: string) {
  const paras = text.split(/\n+/)
  return paras.map((para, pi) => (
    <p key={pi}>
      {para.split(/(\[C\d+\])/).map((seg, si) =>
        /^\[C\d+\]$/.test(seg) ? (
          <span key={si} className="cite">{seg}</span>
        ) : (
          seg
        ),
      )}
      {pi === paras.length - 1 && <span className="caret" aria-hidden />}
    </p>
  ))
}

/** 完成态：[Cn] 按原号映射到引用，可点击回溯、悬停星空联动 */
function renderAnswer(
  text: string,
  citations: Citation[],
  sky: { current: SkyHandle | null },
  navigate: (to: string) => void,
) {
  const byN = new Map<number, Citation>(citations.map((c, i) => [c.n ?? i + 1, c]))
  return text.split(/\n+/).map((para, pi) => (
    <p key={pi}>
      {para.split(/(\[C\d+\])/).map((seg, si) => {
        const m = seg.match(/^\[C(\d+)\]$/)
        const c = m ? byN.get(Number(m[1])) : undefined
        if (!c) return seg
        return (
          <a
            key={si}
            className="cite"
            href={`/claims/${c.claim_id}`}
            onMouseEnter={() => sky.current?.setFlare(c.project_id)}
            onMouseLeave={() => sky.current?.setFlare(null)}
            onClick={(e) => {
              e.preventDefault()
              navigate(`/claims/${c.claim_id}`)
            }}
          >
            {seg}
          </a>
        )
      })}
    </p>
  ))
}
