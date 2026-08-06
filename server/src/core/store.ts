import type { DB } from '../db/index.js'
import { j, newId, now, pj, sha256 } from '../lib/util.js'
import { matchNormalize, normalizeText, simhash64 } from '../lib/text.js'
import { toFtsDoc } from '../search/tokenize.js'
import { contextAround, groundQuote } from './grounding.js'
import type { Band } from './confidence.js'

export class GroundingError extends Error {
  constructor(quote: string) {
    super(`证据引文无法在来源快照中找到，拒绝入库（防伪造引用）: "${quote.slice(0, 80)}..."`)
    this.name = 'GroundingError'
  }
}

export interface ProjectRow {
  id: string
  name: string
  kind: string
  description: string
  aliases: string[]
  competitors: string[]
  official_urls: string[]
  platform_hints: Record<string, unknown>
  current_version: string | null
  demo: number
  created_at: string
  updated_at: string
}

export interface SourceInput {
  projectId: string
  connector: string
  sourceType: string
  name: string
  url?: string | null
  platform?: string
  ownerKey?: string
  authorityPrior?: number
  robotsStatus?: string
  licenseNote?: string
  meta?: Record<string, unknown>
}

export interface EvidenceInput {
  projectId: string
  snapshotId: string
  sourceId: string
  runId?: string | null
  quote: string
  kind?: string
  lang?: string
  rating?: number | null
  helpfulVotes?: number | null
  publishedAt?: string | null
  authorHandle?: string | null
  suspectedPromo?: boolean
}

export interface ClaimInput {
  projectId: string
  claimType: 'official_fact' | 'player_opinion' | 'system_inference' | 'creative_insight'
  topic?: string
  text: string
  subjectEntityId?: string | null
  predicate?: string | null
  valueJson?: { value: number | string; unit?: string } | null
  qualifiers?: Record<string, unknown>
  validFrom?: string | null
  versionMin?: string | null
  versionMax?: string | null
  opinionStats?: Record<string, unknown> | null
  derivedFrom?: string[]
  extractionProvider: string
  runId?: string | null
  evidence: { evidenceId: string; stance?: string; directness?: string; extractorConfidence?: number | null }[]
}

export class Store {
  constructor(public db: DB) {}

  // ---------- projects ----------

  createProject(input: {
    name: string
    kind: string
    description?: string
    aliases?: string[]
    competitors?: string[]
    officialUrls?: string[]
    platformHints?: Record<string, unknown>
    currentVersion?: string | null
    demo?: boolean
  }): ProjectRow {
    const id = newId('prj')
    const t = now()
    this.db
      .prepare(
        `INSERT INTO projects (id, name, kind, description, aliases, competitors, official_urls, platform_hints, current_version, demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.kind,
        input.description ?? '',
        j(input.aliases ?? []),
        j(input.competitors ?? []),
        j(input.officialUrls ?? []),
        j(input.platformHints ?? {}),
        input.currentVersion ?? null,
        input.demo ? 1 : 0,
        t,
        t,
      )
    return this.getProject(id)!
  }

  getProject(id: string): ProjectRow | null {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? this.hydrateProject(row) : null
  }

  listProjects(): ProjectRow[] {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as Record<string, unknown>[]
    return rows.map((r) => this.hydrateProject(r))
  }

  updateProject(id: string, patch: Partial<{ description: string; aliases: string[]; competitors: string[]; platformHints: Record<string, unknown>; currentVersion: string }>): void {
    const p = this.getProject(id)
    if (!p) throw new Error(`project not found: ${id}`)
    this.db
      .prepare(`UPDATE projects SET description = ?, aliases = ?, competitors = ?, platform_hints = ?, current_version = ?, updated_at = ? WHERE id = ?`)
      .run(
        patch.description ?? p.description,
        j(patch.aliases ?? p.aliases),
        j(patch.competitors ?? p.competitors),
        j(patch.platformHints ?? p.platform_hints),
        patch.currentVersion ?? p.current_version,
        now(),
        id,
      )
  }

  private hydrateProject(row: Record<string, unknown>): ProjectRow {
    return {
      ...(row as object),
      aliases: pj(row.aliases as string, []),
      competitors: pj(row.competitors as string, []),
      official_urls: pj(row.official_urls as string, []),
      platform_hints: pj(row.platform_hints as string, {}),
    } as unknown as ProjectRow
  }

  // ---------- sources / documents / snapshots ----------

  upsertSource(input: SourceInput): { id: string; created: boolean } {
    const existing = this.db
      .prepare(`SELECT id FROM sources WHERE project_id = ? AND connector = ? AND COALESCE(url,'') = COALESCE(?, '')`)
      .get(input.projectId, input.connector, input.url ?? '') as { id: string } | undefined
    if (existing) return { id: existing.id, created: false }
    const id = newId('src')
    this.db
      .prepare(
        `INSERT INTO sources (id, project_id, connector, source_type, name, url, platform, owner_key, authority_prior, robots_status, license_note, first_seen_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.connector,
        input.sourceType,
        input.name,
        input.url ?? null,
        input.platform ?? '',
        input.ownerKey ?? '',
        input.authorityPrior ?? 0.5,
        input.robotsStatus ?? 'n/a',
        input.licenseNote ?? '',
        now(),
        j(input.meta ?? {}),
      )
    return { id, created: true }
  }

  setSourceFetch(sourceId: string, status: 'ok' | 'error' | 'skipped', error?: string): void {
    this.db
      .prepare(`UPDATE sources SET fetch_status = ?, fetch_error = ?, last_fetched_at = ? WHERE id = ?`)
      .run(status, error ?? null, now(), sourceId)
  }

  upsertDocument(input: {
    sourceId: string
    projectId: string
    url?: string
    canonicalUrl: string
    docType?: string
    title?: string
    authorHandle?: string | null
    authorMeta?: Record<string, unknown>
    publishedAt?: string | null
    versionTag?: string | null
  }): { id: string; created: boolean } {
    const existing = this.db
      .prepare(`SELECT id FROM documents WHERE project_id = ? AND canonical_url = ?`)
      .get(input.projectId, input.canonicalUrl) as { id: string } | undefined
    if (existing) return { id: existing.id, created: false }
    const id = newId('doc')
    this.db
      .prepare(
        `INSERT INTO documents (id, source_id, project_id, url, canonical_url, doc_type, title, author_handle, author_meta, published_at, version_tag, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceId,
        input.projectId,
        input.url ?? input.canonicalUrl,
        input.canonicalUrl,
        input.docType ?? 'page',
        input.title ?? '',
        input.authorHandle ?? null,
        j(input.authorMeta ?? {}),
        input.publishedAt ?? null,
        input.versionTag ?? null,
        now(),
      )
    return { id, created: true }
  }

  /** Insert a snapshot unless the latest snapshot for this document has identical content. */
  insertSnapshot(input: {
    documentId: string
    projectId: string
    runId?: string | null
    text: string
    httpStatus?: number | null
    rawPath?: string | null
    lang?: string
    meta?: Record<string, unknown>
  }): { id: string; unchanged: boolean } {
    const text = normalizeText(input.text)
    const hash = sha256(text)
    const latest = this.db
      .prepare(`SELECT id, content_hash FROM snapshots WHERE document_id = ? ORDER BY fetched_at DESC LIMIT 1`)
      .get(input.documentId) as { id: string; content_hash: string } | undefined
    if (latest && latest.content_hash === hash) return { id: latest.id, unchanged: true }
    const id = newId('snap')
    this.db
      .prepare(
        `INSERT INTO snapshots (id, document_id, project_id, run_id, fetched_at, http_status, content_hash, simhash64, text, raw_path, lang, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.documentId,
        input.projectId,
        input.runId ?? null,
        now(),
        input.httpStatus ?? null,
        hash,
        simhash64(text),
        text,
        input.rawPath ?? null,
        input.lang ?? 'zh',
        j(input.meta ?? {}),
      )
    return { id, unchanged: false }
  }

  setSnapshotDupCluster(snapshotId: string, cluster: string): void {
    this.db.prepare(`UPDATE snapshots SET dup_cluster = ? WHERE id = ?`).run(cluster, snapshotId)
  }

  // ---------- evidence (grounding enforced) ----------

  insertEvidence(input: EvidenceInput): string {
    const snap = this.db.prepare(`SELECT text FROM snapshots WHERE id = ?`).get(input.snapshotId) as
      | { text: string }
      | undefined
    if (!snap) throw new Error(`snapshot not found: ${input.snapshotId}`)
    // strip surrounding whitespace/punctuation so ...30元 and ...30元。 dedupe together
    const quote = input.quote.replace(/^[\s。.，,！!？?：:；;、"“”'‘’]+|[\s。.，,！!？?：:；;、"“”'‘’]+$/g, '')
    const grounding = groundQuote(snap.text, quote)
    if (!grounding.ok) throw new GroundingError(input.quote)

    // dedupe: identical quote within same snapshot
    const qHash = sha256(matchNormalize(quote))
    const dup = this.db
      .prepare(`SELECT id FROM evidence WHERE snapshot_id = ? AND quote_hash = ?`)
      .get(input.snapshotId, qHash) as { id: string } | undefined
    if (dup) return dup.id

    const id = newId('ev')
    const ctx =
      grounding.start !== null && grounding.end !== null
        ? contextAround(snap.text, grounding.start, grounding.end)
        : { before: '', after: '' }
    this.db
      .prepare(
        `INSERT INTO evidence (id, project_id, snapshot_id, source_id, run_id, quote, quote_hash, char_start, char_end, context_before, context_after, kind, lang, rating, helpful_votes, published_at, author_handle, suspected_promo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.snapshotId,
        input.sourceId,
        input.runId ?? null,
        quote,
        qHash,
        grounding.start,
        grounding.end,
        ctx.before,
        ctx.after,
        input.kind ?? 'statement',
        input.lang ?? 'zh',
        input.rating ?? null,
        input.helpfulVotes ?? null,
        input.publishedAt ?? null,
        input.authorHandle ?? null,
        input.suspectedPromo ? 1 : 0,
        now(),
      )
    const rowid = (this.db.prepare(`SELECT rowid FROM evidence WHERE id = ?`).get(id) as { rowid: number }).rowid
    this.db.prepare(`INSERT INTO evidence_fts(rowid, seg) VALUES (?, ?)`).run(rowid, toFtsDoc(quote))
    return id
  }

  markEvidencePromo(evidenceId: string, suspected: boolean): void {
    this.db.prepare(`UPDATE evidence SET suspected_promo = ? WHERE id = ?`).run(suspected ? 1 : 0, evidenceId)
  }

  // ---------- claims ----------

  createClaim(input: ClaimInput): string {
    const id = newId('clm')
    const t = now()
    const seqRow = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM claims WHERE project_id = ?`)
      .get(input.projectId) as { seq: number }
    this.db
      .prepare(
        `INSERT INTO claims (id, project_id, seq, claim_type, topic, text, text_hash, subject_entity_id, predicate, value_json, qualifiers, observed_at, valid_from, version_min, version_max, opinion_stats, derived_from, extraction_provider, run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        seqRow.seq,
        input.claimType,
        input.topic ?? 'other',
        input.text,
        sha256(matchNormalize(input.text)),
        input.subjectEntityId ?? null,
        input.predicate ?? null,
        input.valueJson ? j(input.valueJson) : null,
        j(input.qualifiers ?? {}),
        t,
        input.validFrom ?? null,
        input.versionMin ?? null,
        input.versionMax ?? null,
        input.opinionStats ? j(input.opinionStats) : null,
        j(input.derivedFrom ?? []),
        input.extractionProvider,
        input.runId ?? null,
        t,
        t,
      )
    const link = this.db.prepare(
      `INSERT OR IGNORE INTO claim_evidence (claim_id, evidence_id, stance, directness, extractor_confidence) VALUES (?, ?, ?, ?, ?)`,
    )
    for (const ev of input.evidence) {
      link.run(id, ev.evidenceId, ev.stance ?? 'supports', ev.directness ?? 'direct', ev.extractorConfidence ?? null)
    }
    const rowid = (this.db.prepare(`SELECT rowid FROM claims WHERE id = ?`).get(id) as { rowid: number }).rowid
    this.db.prepare(`INSERT INTO claims_fts(rowid, seg) VALUES (?, ?)`).run(rowid, toFtsDoc(input.text))
    this.addRevision(id, 'system:extractor', 'create', null, { text: input.text, claimType: input.claimType }, '')
    return id
  }

  findClaimByTextHash(projectId: string, text: string): string | null {
    const row = this.db
      .prepare(`SELECT id FROM claims WHERE project_id = ? AND text_hash = ? AND merged_into IS NULL`)
      .get(projectId, sha256(matchNormalize(text))) as { id: string } | undefined
    return row?.id ?? null
  }

  linkEvidence(claimId: string, evidenceId: string, stance = 'supports', directness = 'direct', extractorConfidence: number | null = null): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO claim_evidence (claim_id, evidence_id, stance, directness, extractor_confidence) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(claimId, evidenceId, stance, directness, extractorConfidence)
  }

  updateClaimScore(claimId: string, confidence: number | null, band: Band, breakdown: unknown, reviewState: string): void {
    const before = this.db.prepare(`SELECT confidence, confidence_band, review_state FROM claims WHERE id = ?`).get(claimId)
    this.db
      .prepare(`UPDATE claims SET confidence = ?, confidence_band = ?, confidence_breakdown = ?, review_state = ?, updated_at = ? WHERE id = ?`)
      .run(confidence, band, j(breakdown), reviewState, now(), claimId)
    this.addRevision(claimId, 'system:scorer', 'rescore', before, { confidence, band, reviewState }, '')
  }

  setReviewState(claimId: string, state: string, actor: string, reason = ''): void {
    const before = this.db.prepare(`SELECT review_state FROM claims WHERE id = ?`).get(claimId)
    this.db.prepare(`UPDATE claims SET review_state = ?, updated_at = ? WHERE id = ?`).run(state, now(), claimId)
    this.addRevision(claimId, actor, state === 'approved' ? 'approve' : state === 'rejected' ? 'reject' : 'edit', before, { review_state: state }, reason)
  }

  supersede(oldClaimId: string, newClaimId: string, actor: string, reason: string): void {
    const t = now()
    this.db
      .prepare(`UPDATE claims SET valid_until = ?, rank = 'deprecated', deprecated_reason = ?, superseded_by = ?, updated_at = ? WHERE id = ?`)
      .run(t, reason, newClaimId, t, oldClaimId)
    this.db.prepare(`UPDATE claims SET rank = 'preferred', updated_at = ? WHERE id = ?`).run(t, newClaimId)
    this.addRevision(oldClaimId, actor, 'supersede', null, { superseded_by: newClaimId }, reason)
  }

  mergeClaim(dupClaimId: string, canonicalId: string, actor: string): void {
    // migrate evidence links to canonical, then mark merged
    const links = this.db.prepare(`SELECT evidence_id, stance, directness, extractor_confidence FROM claim_evidence WHERE claim_id = ?`).all(dupClaimId) as {
      evidence_id: string
      stance: string
      directness: string
      extractor_confidence: number | null
    }[]
    for (const l of links) this.linkEvidence(canonicalId, l.evidence_id, l.stance, l.directness, l.extractor_confidence)
    this.db
      .prepare(`UPDATE claims SET review_state = 'merged', merged_into = ?, updated_at = ? WHERE id = ?`)
      .run(canonicalId, now(), dupClaimId)
    // remove merged duplicate from the search index
    const rowid = (this.db.prepare(`SELECT rowid FROM claims WHERE id = ?`).get(dupClaimId) as { rowid: number }).rowid
    this.db.prepare(`DELETE FROM claims_fts WHERE rowid = ?`).run(rowid)
    this.addRevision(dupClaimId, actor, 'merge', null, { merged_into: canonicalId }, '')
  }

  addRevision(claimId: string, actor: string, action: string, before: unknown, after: unknown, reason: string): void {
    this.db
      .prepare(`INSERT INTO revisions (claim_id, actor, action, before_json, after_json, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(claimId, actor, action, before ? j(before) : null, after ? j(after) : null, reason, now())
  }

  // ---------- conflicts / review queue ----------

  openConflict(input: {
    projectId: string
    claimA: string
    claimB: string
    conflictType: string
    detectedBy: string
    note?: string
  }): string | null {
    const [a, b] = [input.claimA, input.claimB].sort()
    const existing = this.db
      .prepare(`SELECT id FROM conflicts WHERE claim_a = ? AND claim_b = ? AND status = 'open'`)
      .get(a, b) as { id: string } | undefined
    if (existing) return null
    const id = newId('cfl')
    this.db
      .prepare(
        `INSERT INTO conflicts (id, project_id, claim_a, claim_b, conflict_type, detected_by, detector_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, a, b, input.conflictType, input.detectedBy, input.note ?? '', now())
    return id
  }

  resolveConflict(conflictId: string, status: string, note: string, actor: string): void {
    this.db
      .prepare(`UPDATE conflicts SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`)
      .run(status, note, actor, now(), conflictId)
  }

  hasOpenConflict(claimId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM conflicts WHERE (claim_a = ? OR claim_b = ?) AND status = 'open' LIMIT 1`)
      .get(claimId, claimId)
    return Boolean(row)
  }

  enqueueReview(projectId: string, itemType: string, itemId: string, reason: string, priority = 3): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO review_queue (id, project_id, item_type, item_id, reason, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId('rvw'), projectId, itemType, itemId, reason, priority, now())
  }

  decideReview(reviewId: string, decision: string): void {
    this.db
      .prepare(`UPDATE review_queue SET state = 'done', decision = ?, decided_at = ? WHERE id = ?`)
      .run(decision, now(), reviewId)
  }
}
