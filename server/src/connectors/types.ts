import type { ProjectRow } from '../core/store.js'
import type { Fetcher } from './fetcher.js'

/**
 * Connector architecture. Each external platform is a Connector.
 * status is honest: 'verified' connectors have a live tested fetch path;
 * 'adapter_only' platforms (robots/ToS/anti-bot walls) expose config + a manual
 * import path instead of pretending to be integrated.
 */

export interface FetchedDoc {
  source: {
    connector: string
    sourceType: string
    name: string
    url?: string | null
    platform?: string
    ownerKey?: string
    authorityPrior?: number
    robotsStatus?: string
    licenseNote?: string
  }
  doc: {
    canonicalUrl: string
    url?: string
    docType?: string
    title?: string
    authorHandle?: string | null
    publishedAt?: string | null
    versionTag?: string | null
  }
  text: string
  lang?: string
  /** raw payload archived to disk for auditability */
  raw?: unknown
  /** review-specific structured fields */
  review?: { rating?: number | null; helpfulVotes?: number | null }
  /** 若此 doc 是某竞品的口碑(用竞品词搜回),填竞品名。pipeline 据此标 docType=competitor_review + 抽取为 ammo */
  competitorFor?: string
  meta?: Record<string, unknown>
}

export interface ConnectorContext {
  project: ProjectRow
  /** search terms chosen by the research planner for this round */
  keywords: string[]
  /** 竞品名(用户登记)——连接器可选地用它们搜竞品负面口碑,产出的 doc 带 competitorFor */
  competitorTerms?: string[]
  fetcher: Fetcher
  log: (message: string, detail?: Record<string, unknown>) => void
}

export interface Connector {
  id: string
  label: string
  status: 'verified' | 'adapter_only' | 'needs_key'
  description: string
  /** honest note about legal/robots/ToS position and what the adapter does instead */
  compliance: string
  /** resolve platform ids (e.g. app store track id); merged into project.platform_hints */
  resolve?(ctx: ConnectorContext): Promise<Record<string, unknown>>
  /** fetch fresh documents for this round */
  discover?(ctx: ConnectorContext): Promise<FetchedDoc[]>
}
