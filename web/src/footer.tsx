import { useEffect, useState } from 'react'

interface SiteInfo {
  company: string
  icp: string
  icpUrl: string
  police: string
  policeUrl: string
  footerNote: string
}

/**
 * Public compliance footer (悬挂信息) — copyright + ICP备案 + 公安备案, fetched from the
 * unauthenticated /app/site-info endpoint so it renders on the login page too. Renders
 * nothing until configured (values live in the settings page, filled with real legal
 * info — never fabricated).
 */
export function SiteFooter({ variant = 'app' }: { variant?: 'app' | 'login' }) {
  const [info, setInfo] = useState<SiteInfo | null>(null)

  useEffect(() => {
    fetch('/app/site-info')
      .then((r) => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => {})
  }, [])

  if (!info) return null
  const year = new Date().getFullYear()
  const hasAny = info.company || info.icp || info.police || info.footerNote
  if (!hasAny) return null

  return (
    <footer className={`site-footer ${variant}`}>
      <div className="sf-line">
        {info.company && <span>© {year} {info.company}</span>}
        {info.icp && (
          <>
            <span className="sf-sep">·</span>
            <a href={info.icpUrl || 'https://beian.miit.gov.cn/'} target="_blank" rel="noreferrer">
              {info.icp}
            </a>
          </>
        )}
        {info.police && (
          <>
            <span className="sf-sep">·</span>
            <a href={info.policeUrl || 'https://beian.mps.gov.cn/'} target="_blank" rel="noreferrer" className="sf-police">
              {info.police}
            </a>
          </>
        )}
      </div>
      {info.footerNote && <div className="sf-note">{info.footerNote}</div>}
    </footer>
  )
}
