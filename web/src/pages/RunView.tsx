import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, fmtDateTime } from '../api'
import { Loading, SectionHead, Star } from '../ui'

interface RunDetail {
  id: string
  goal: string
  status: string
  llm_provider: string
  model_id: string
  started_at: string
  finished_at: string | null
  plan: { questions?: string[]; keywords?: string[]; connectors?: string[] }
  stats: Record<string, unknown>
  error?: string | null
}

interface RunEvent {
  id: number
  phase: string
  level: string
  message: string
  at: string
}

const DIMENSION_ZH: Record<string, string> = {
  selling_points: '核心卖点',
  theme_world: '题材世界观',
  character_ip: '角色IP',
  gameplay_loop: '玩法循环',
  player_hooks: '玩家爽点痛点',
  monetization_rep: '付费与商业化口碑',
  version_events: '版本活动节点',
  competitors: '竞品对比',
  audience: '人群画像',
  creative_patterns: '素材套路',
}

const PHASES = [
  ['plan', '研究规划'],
  ['discover', '主动发现'],
  ['extract', '知识抽取'],
  ['consolidate', '去重整合'],
  ['score', '置信评分'],
  ['done', '完成'],
] as const

export default function RunView() {
  const { id: projectId, runId } = useParams()
  const [run, setRun] = useState<RunDetail | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const lastId = useRef(0)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let stop = false
    lastId.current = 0
    setEvents([])
    const poll = async () => {
      if (stop) return
      try {
        const r = await api.get<RunDetail>(`/app/runs/${runId}`)
        setRun(r)
        const e = await api.get<{ status: string; events: RunEvent[] }>(`/app/runs/${runId}/events?after=${lastId.current}`)
        if (e.events.length > 0) {
          lastId.current = e.events[e.events.length - 1].id
          setEvents((prev) => [...prev, ...e.events])
        }
        if (r.status === 'running') setTimeout(poll, 1500)
      } catch {
        if (!stop) setTimeout(poll, 4000)
      }
    }
    poll()
    return () => {
      stop = true
    }
  }, [runId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [events.length])

  if (!run) return (<div className="content"><Loading /></div>)

  const activePhase = events.length > 0 ? events[events.length - 1].phase : 'plan'
  const phaseIdx = PHASES.findIndex(([k]) => k === activePhase)
  const running = run.status === 'running'

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>
            研究过程 {running && <Star working />}
          </h1>
          <div className="sub">
            {run.goal} · <span className="mono">{(run.llm_provider || 'none').toUpperCase()}{run.model_id ? ` / ${run.model_id}` : ''}</span>
          </div>
        </div>
        <div className="actions">
          <span className={`tag ${running ? 't-blue' : run.status === 'failed' ? 't-warn' : 't-ink'}`}>{run.status.toUpperCase()}</span>
          <Link to={`/projects/${projectId}/knowledge`} className="btn ghost">
            查看知识索引 →
          </Link>
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="section">
            <SectionHead label="研究日志" count={events.length} />
            <div
              ref={logRef}
              className="run-log"
              style={{ maxHeight: 520, overflowY: 'auto', padding: '10px 2px', background: 'var(--bg-soft)', borderRadius: 8 }}
            >
              {events.length === 0 && <div className="dim2" style={{ padding: 12 }}>等待事件…</div>}
              {events.map((e) => (
                <div key={e.id} className={`ev new ${e.level !== 'info' ? 'warn' : ''}`}>
                  <span className="ph">{e.phase}</span>
                  <span className="msg">{e.message}</span>
                </div>
              ))}
              {running && (
                <div className="ev">
                  <span className="ph" />
                  <span className="msg dim2">
                    <span className="spin" style={{ verticalAlign: -1, marginRight: 8 }} />
                    进行中…
                  </span>
                </div>
              )}
            </div>
          </div>

          {run.plan.questions && run.plan.questions.length > 0 && (
            <div className="section">
              <SectionHead label="研究问题（Agent 自主规划）" />
              <div className="index-list">
                {run.plan.questions.map((q, i) => (
                  <div key={i} className="row">
                    <span className="idx">{String(i + 1).padStart(2, '0')}</span>
                    <div className="grow title small">{q}</div>
                  </div>
                ))}
              </div>
              {run.plan.keywords && (
                <div className="meta wrap-any mt8" style={{ whiteSpace: 'normal', lineHeight: 2 }}>
                  关键词：{run.plan.keywords.join(' · ')}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="meta-panel">
          <div className="sect-label" style={{ marginBottom: 8 }}>
            研究管线
          </div>
          <div className="phase-steps" style={{ marginBottom: 20 }}>
            {PHASES.map(([key, label], i) => (
              <div
                key={key}
                className={`phase-step ${key === activePhase && running ? 'active' : i <= phaseIdx || !running ? 'done' : ''}`}
              >
                <span className="pnum">{String(i + 1).padStart(2, '0')}</span>
                <span>{label}</span>
                {key === activePhase && running && <Star working />}
              </div>
            ))}
          </div>
          <div className="mp-row">
            <span className="k">开始</span>
            <span className="v mono small">{fmtDateTime(run.started_at)}</span>
          </div>
          <div className="mp-row">
            <span className="k">结束</span>
            <span className="v mono small">{fmtDateTime(run.finished_at)}</span>
          </div>
          {Object.entries(run.stats)
            .filter(([, v]) => typeof v === 'number')
            .map(([k, v]) => (
              <div key={k} className="mp-row">
                <span className="k mono" style={{ fontSize: 10.5 }}>
                  {k.replace(/_/g, ' ')}
                </span>
                <span className="v mono small">{String(v)}</span>
              </div>
            ))}
          {Array.isArray(run.stats.dimensions) && (run.stats.dimensions as { key: string; status: string; note: string }[]).length > 0 && (
            <div className="panel soft mt16">
              <div className="sect-label mb8">买量信息覆盖度（十维）</div>
              {(run.stats.dimensions as { key: string; status: string; note: string }[]).map((d, i) => (
                <div key={d.key} className="mp-row" title={d.note}>
                  <span className="k mono" style={{ fontSize: 10.5 }}>
                    {String(i + 1).padStart(2, '0')} {DIMENSION_ZH[d.key] ?? d.key}
                  </span>
                  <span className={`tag ${d.status === 'covered' ? 't-blue' : d.status === 'missing' ? 't-warn' : 't-dim'}`}>
                    {d.status.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          )}
          {Array.isArray(run.stats.gaps) && (run.stats.gaps as string[]).length > 0 && (
            <div className="panel soft mt16">
              <div className="sect-label mb8">覆盖缺口（Agent 评估）</div>
              {(run.stats.gaps as string[]).map((g, i) => (
                <div key={i} className="small dim" style={{ padding: '2px 0' }}>
                  · {g}
                </div>
              ))}
            </div>
          )}
          {run.error && (
            <div className="panel mt16" style={{ borderColor: 'var(--danger)' }}>
              <div className="sect-label mb8" style={{ color: 'var(--danger)' }}>
                错误
              </div>
              <div className="small mono wrap-any">{run.error.slice(0, 400)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
