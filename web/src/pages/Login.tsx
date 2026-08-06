import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setToken, verifyToken } from '../api'
import { SiteFooter } from '../footer'

export default function Login() {
  const [token, setTokenInput] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  return (
    <div className="login-wrap">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setErr('')
          const ok = await verifyToken(token.trim()).catch(() => false)
          setBusy(false)
          if (ok) {
            setToken(token.trim())
            navigate('/')
          } else {
            setErr('Token 无效。请查看服务器启动日志中打印的管理员 Token。')
          }
        }}
      >
        <img src="/brand/wordmark.png" alt="Mindex" style={{ height: 26, display: 'block', marginBottom: 6 }} />
        <div className="dim small" style={{ marginBottom: 26 }}>
          Index everything. Find insight.
        </div>
        <div className="field">
          <label>管理员 Token</label>
          <input
            className="input mono"
            type="password"
            placeholder="mdxadm_..."
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            autoFocus
          />
          <div className="hint">服务器首次启动时自动生成并打印在控制台（也存于 data/.admin_token）</div>
        </div>
        {err && (
          <div className="small" style={{ color: 'var(--danger)', marginBottom: 12 }}>
            {err}
          </div>
        )}
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !token.trim()}>
          {busy ? '验证中…' : '进入工作台'}
        </button>
        <SiteFooter variant="login" />
      </form>
    </div>
  )
}
