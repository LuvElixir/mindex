import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, matchPath, useLocation, useNavigate } from 'react-router-dom'
import { api, getToken } from './api'
import { Icon, Star, icons } from './ui'
import { SiteFooter } from './footer'

interface ProjectLite {
  id: string
  name: string
  demo?: number
  running?: boolean
}

export default function Shell() {
  const location = useLocation()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [project, setProject] = useState<ProjectLite | null>(null)
  const [projects, setProjects] = useState<ProjectLite[]>([])
  const [sideOpen, setSideOpen] = useState(false)

  const m =
    matchPath('/projects/:id/*', location.pathname) ?? matchPath('/projects/:id', location.pathname)
  const projectId = m?.params.id

  useEffect(() => {
    if (!getToken()) {
      navigate('/login')
      return
    }
  }, [navigate])

  useEffect(() => {
    let alive = true
    api
      .get<{ projects: ProjectLite[] }>('/app/overview')
      .then((o) => alive && setProjects(o.projects))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [location.pathname])

  useEffect(() => {
    let alive = true
    if (projectId) {
      api
        .get<ProjectLite>(`/app/projects/${projectId}`)
        .then((p) => alive && setProject(p))
        .catch(() => alive && setProject(null))
    } else {
      setProject(null)
    }
    return () => {
      alive = false
    }
  }, [projectId, location.pathname])

  // close mobile drawer on navigation
  useEffect(() => setSideOpen(false), [location.pathname])

  const nav = (to: string, icon: string, label: string, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
      <Icon d={icon} />
      {label}
    </NavLink>
  )

  return (
    <div className="shell">
      <aside className={`sidebar${sideOpen ? ' open' : ''}`}>
        <Link to="/" className="logo" aria-label="Mindex">
          <img src="/brand/wordmark.png" alt="Mindex" />
        </Link>
        <nav className="side-nav">
          <div className="side-sect sect-label">工作台</div>
          {nav('/', icons.graph, '问答', true)}
          {nav('/activity', icons.activity, '动态')}
          {nav('/search', icons.search, '全局搜索')}
          {nav('/keys', icons.key, 'Agent 接入')}
          {nav('/settings', icons.settings, '设置')}

          <div className="side-sect sect-label">项目</div>
          {projects.map((p) => (
            <NavLink
              key={p.id}
              to={`/projects/${p.id}`}
              className={() => (projectId === p.id ? 'active' : '')}
              title={p.name}
            >
              <span className="p-dot" aria-hidden />
              <span className="p-name">{p.name}</span>
              {p.running && <Star working />}
              {p.demo === 1 && <span className="tag t-dim" style={{ fontSize: 8, padding: '0 4px' }}>示例</span>}
            </NavLink>
          ))}
          <Link to="/new" className="side-new">
            + 创建项目
          </Link>

          {project && (
            <>
              <div className="side-sect sect-label" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name}</span>
                {project.running && <Star working />}
              </div>
              {nav(`/projects/${project.id}`, icons.run, '项目总览', true)}
              {nav(`/projects/${project.id}/knowledge`, icons.knowledge, '知识索引')}
              {nav(`/projects/${project.id}/sources`, icons.source, '来源')}
              {nav(`/projects/${project.id}/review`, icons.review, '审核队列')}
              {nav(`/projects/${project.id}/conflicts`, icons.conflict, '冲突')}
              {nav(`/projects/${project.id}/import`, icons.import, '手动导入')}
            </>
          )}
        </nav>
        <div className="side-foot">
          <div className="meta">MINDEX / 0.1.0</div>
          <div className="meta" style={{ marginTop: 2 }}>
            <a href="/api/v1/docs" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
              API 文档 ↗
            </a>
          </div>
        </div>
      </aside>
      {sideOpen && <div className="side-scrim" onClick={() => setSideOpen(false)} />}

      <div className="main">
        <div className="topbar">
          <button className="menu-btn" aria-label="菜单" onClick={() => setSideOpen(!sideOpen)}>
            <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" fill="none">
              <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
            </svg>
          </button>
          <div className="crumbs">
            <Link to="/">Mindex</Link>
            {project && (
              <>
                <span className="sep">/</span>
                <Link to={`/projects/${project.id}`} className="here">
                  {project.name}
                </Link>
              </>
            )}
          </div>
          <form
            className="gsearch"
            onSubmit={(e) => {
              e.preventDefault()
              if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`)
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm7 2-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input placeholder="搜索知识、来源、结论…" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="kbd">⏎</span>
          </form>
        </div>
        <Outlet />
        <SiteFooter variant="app" />
      </div>
    </div>
  )
}
