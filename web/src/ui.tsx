import { useEffect, useState, type ReactNode } from 'react'
import { BAND_LABEL, TYPE_LABEL, STATE_ZH } from './api'

/** ✦ 十字星 — 仅用于 AI 处理/验证/洞察，不作装饰 */
export function Star({ working = false }: { working?: boolean }) {
  return <i className={`star${working ? ' working' : ''}`}>✦</i>
}

export function TypeTag({ type }: { type: string }) {
  return <span className="tag">{TYPE_LABEL[type] ?? type}</span>
}

export function BandTag({ band }: { band: string }) {
  const label = BAND_LABEL[band] ?? band
  if (band === 'verified')
    return (
      <span className="tag t-blue">
        <Star /> {label}
      </span>
    )
  if (band === 'disputed') return <span className="tag t-warn">{label}</span>
  if (band === 'insufficient') return <span className="tag t-dim">{label}</span>
  return <span className="tag">{label}</span>
}

export function StateTag({ state }: { state: string }) {
  const label = STATE_ZH[state] ?? state
  if (state === 'quarantined' || state === 'rejected') return <span className="tag t-warn">{label}</span>
  if (state === 'pending') return <span className="tag t-ink">{label}</span>
  if (state === 'approved' || state === 'auto_accepted') return <span className="tag t-blue">{label}</span>
  return <span className="tag">{label}</span>
}

/** Opinions show mention counts + representativeness — never a truth-style score bar. */
export function OpinionMeter({ stats }: { stats: { n_holding?: number; sample_size?: number; ci_low?: number } | null }) {
  if (!stats || stats.n_holding === undefined) return <span className="conf-num">—</span>
  return (
    <span className="opmeter" title={`代表性（Wilson 95% 下界）: ${((stats.ci_low ?? 0) * 100).toFixed(0)}%`}>
      <span className="om-n">
        {stats.n_holding}/{stats.sample_size}
      </span>
      <span className="om-label">提及</span>
    </span>
  )
}

export function Loading({ label = '加载中' }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spin" />
      <span className="meta">{label}</span>
    </div>
  )
}

export function ConfBar({ value, band }: { value: number | null; band?: string }) {
  if (value === null || value === undefined)
    return (
      <span className="conf">
        <span className="conf-num">—</span>
        <span className="meta">证据不足</span>
      </span>
    )
  return (
    <span className="conf" title={`置信度 ${value}`}>
      <span className="conf-track">
        <span className={`conf-fill${band === 'verified' ? ' blue' : ''}`} style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="conf-num">{value.toFixed(2)}</span>
    </span>
  )
}

export function SectionHead({ label, count, more, children }: { label: string; count?: number | string; more?: ReactNode; children?: ReactNode }) {
  return (
    <div className="section-head">
      <span className="sect-label">{label}</span>
      {count !== undefined && <span className="count">/ {count}</span>}
      {children}
      {more && <span className="more">{more}</span>}
    </div>
  )
}

export function Empty({ mark = '无数据', children }: { mark?: string; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="e-mark">— {mark} —</div>
      <p>{children}</p>
    </div>
  )
}

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-wrap">
      <pre className="code">{text}</pre>
      <button
        className="copy-btn"
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }}
      >
        {copied ? '已复制 ✓' : (label ?? '复制')}
      </button>
    </div>
  )
}

export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600)
    return () => clearTimeout(t)
  }, [onDone])
  return <div className="toast">{message}</div>
}

export function useToast(): [ReactNode, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null)
  const node = msg ? <Toast message={msg} onDone={() => setMsg(null)} /> : null
  return [node, setMsg]
}

/** 极简几何线性图标 */
export function Icon({ d }: { d: string }) {
  return (
    <svg className="n-icon" viewBox="0 0 16 16">
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export const icons = {
  home: 'M2 8.5 8 3l6 5.5M3.5 7.5V13h9V7.5',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm7 2-3.5-3.5',
  knowledge: 'M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3',
  source: 'M8 2v12M2 5l6-3 6 3M3.5 13h9',
  review: 'M2.5 8.5 6 12l7.5-8',
  conflict: 'M8 2v7M8 12v1.5M2.5 13.5 8 2l5.5 11.5z',
  key: 'M9.5 6.5a3.5 3.5 0 1 0-3.4 3.5L8 8.1l1.5 1.5 1-1L12 10l1.5-1.5-4-4z',
  settings: 'M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4',
  run: 'M4 2.5v11l9-5.5z',
  graph: 'M8 3.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM3 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM13 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM8 3.5v5M8 8.5 3.8 11.6M8 8.5l4.2 3.1',
  activity: 'M1.5 8h3l2-4.5 3 9 2-4.5h3',
  import: 'M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13.5h10',
  doc: 'M4 1.5h5.5L13 5v9.5H4zM9 1.5V5h4',
}
