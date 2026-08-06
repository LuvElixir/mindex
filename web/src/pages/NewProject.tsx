import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

export default function NewProject() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [aliases, setAliases] = useState('')
  const [competitors, setCompetitors] = useState('')
  const [urls, setUrls] = useState('')
  const [autoResearch, setAutoResearch] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>创建项目</h1>
          <div className="sub">提供产品基础资料，研究 Agent 将自主规划检索并发现知识</div>
        </div>
      </div>

      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setErr('')
          try {
            const p = await api.post<{ id: string }>('/app/projects', {
              name: name.trim(),
              kind: 'game',
              description: description.trim(),
              aliases: aliases.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean),
              competitors: competitors.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean),
              official_urls: urls.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean),
            })
            if (autoResearch) {
              await api.post(`/app/projects/${p.id}/research`, {}).catch(() => {})
            }
            navigate(`/projects/${p.id}`)
          } catch (error) {
            setErr(String((error as Error).message))
            setBusy(false)
          }
        }}
      >
        <div className="field">
          <label>产品名称 *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：原神" autoFocus required />
        </div>
        <div className="field">
          <label>别名 / 英文名</label>
          <input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="逗号分隔，例：Genshin Impact" />
          <div className="hint">帮助 Agent 在 App Store CN、TapTap、B站 等平台准确定位产品</div>
        </div>
        <div className="field">
          <label>主要竞品</label>
          <input className="input" value={competitors} onChange={(e) => setCompetitors(e.target.value)} placeholder="逗号分隔，例：原神，鸣潮" />
          <div className="hint">研究时会额外采集竞品的负面口碑，自动转化为卡位卖点（ammo）——买量最核心的弹药</div>
        </div>
        <div className="field">
          <label>官方链接</label>
          <input className="input" value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://... 空格或逗号分隔" />
        </div>
        <div className="field">
          <label>产品描述</label>
          <textarea
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一句话说明产品是什么、目标用户是谁——这会成为研究规划的输入"
          />
        </div>
        <label className="flex small" style={{ marginBottom: 22, cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={autoResearch} onChange={(e) => setAutoResearch(e.target.checked)} />
          创建后立即启动主动研究 <span className="star">✦</span>
        </label>
        {err && (
          <div className="small" style={{ color: 'var(--danger)', marginBottom: 14 }}>
            {err}
          </div>
        )}
        <div className="flex">
          <button className="btn primary" disabled={busy || !name.trim()}>
            {busy ? '创建中…' : '创建项目'}
          </button>
          <button type="button" className="btn ghost" onClick={() => navigate(-1)}>
            取消
          </button>
        </div>
      </form>
    </div>
  )
}
