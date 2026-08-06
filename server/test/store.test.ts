import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '../src/db/index.js'
import { GroundingError, Store } from '../src/core/store.js'

let store: Store
let projectId: string
let snapshotId: string
let sourceId: string

const SNAP_TEXT = '官方公告：本作将于2026年9月1日在全球同步上线，支持中文、英文与日文。首发限定礼包定价30元。'

beforeEach(() => {
  store = new Store(memoryDb())
  projectId = store.createProject({ name: '测试游戏', kind: 'game' }).id
  sourceId = store.upsertSource({
    projectId,
    connector: 'web',
    sourceType: 'official',
    name: '官网公告',
    url: 'https://example.com/news/1',
    ownerKey: 'example.com',
    authorityPrior: 0.9,
  }).id
  const docId = store.upsertDocument({ sourceId, projectId, canonicalUrl: 'https://example.com/news/1', title: '上线公告' }).id
  snapshotId = store.insertSnapshot({ documentId: docId, projectId, text: SNAP_TEXT }).id
})

describe('store — provenance chain', () => {
  it('stores evidence whose quote exists in the snapshot', () => {
    const evId = store.insertEvidence({ projectId, snapshotId, sourceId, quote: '2026年9月1日在全球同步上线' })
    expect(evId).toMatch(/^ev_/)
  })

  it('REFUSES evidence with fabricated quotes', () => {
    expect(() =>
      store.insertEvidence({ projectId, snapshotId, sourceId, quote: '本作首月流水突破十亿' }),
    ).toThrow(GroundingError)
  })

  it('dedupes identical quotes within a snapshot', () => {
    const a = store.insertEvidence({ projectId, snapshotId, sourceId, quote: '首发限定礼包定价30元' })
    const b = store.insertEvidence({ projectId, snapshotId, sourceId, quote: '首发限定礼包定价30元。' })
    expect(a).toBe(b)
  })

  it('skips snapshot re-insert when content unchanged', () => {
    const docId = store.upsertDocument({ sourceId, projectId, canonicalUrl: 'https://example.com/news/1' }).id
    const again = store.insertSnapshot({ documentId: docId, projectId, text: SNAP_TEXT })
    expect(again.unchanged).toBe(true)
  })

  it('creates claims with revision history and evidence links', () => {
    const evId = store.insertEvidence({ projectId, snapshotId, sourceId, quote: '首发限定礼包定价30元' })
    const claimId = store.createClaim({
      projectId,
      claimType: 'official_fact',
      text: '该游戏首发限定礼包定价为30元',
      valueJson: { value: 30, unit: '元' },
      extractionProvider: 'heuristic',
      evidence: [{ evidenceId: evId }],
    })
    const revs = store.db.prepare(`SELECT * FROM revisions WHERE claim_id = ?`).all(claimId)
    expect(revs.length).toBe(1)
    const links = store.db.prepare(`SELECT * FROM claim_evidence WHERE claim_id = ?`).all(claimId)
    expect(links.length).toBe(1)
  })

  it('merge migrates evidence to canonical claim', () => {
    const ev1 = store.insertEvidence({ projectId, snapshotId, sourceId, quote: '支持中文、英文与日文' })
    const ev2 = store.insertEvidence({ projectId, snapshotId, sourceId, quote: '本作将于2026年9月1日在全球同步上线' })
    const canonical = store.createClaim({
      projectId, claimType: 'official_fact', text: '游戏支持中英日三种语言',
      extractionProvider: 'heuristic', evidence: [{ evidenceId: ev1 }],
    })
    const dup = store.createClaim({
      projectId, claimType: 'official_fact', text: '游戏支持中文英文日文',
      extractionProvider: 'heuristic', evidence: [{ evidenceId: ev2 }],
    })
    store.mergeClaim(dup, canonical, 'system:dedupe')
    const links = store.db.prepare(`SELECT * FROM claim_evidence WHERE claim_id = ?`).all(canonical)
    expect(links.length).toBe(2)
    const dupRow = store.db.prepare(`SELECT review_state, merged_into FROM claims WHERE id = ?`).get(dup) as { review_state: string; merged_into: string }
    expect(dupRow.review_state).toBe('merged')
    expect(dupRow.merged_into).toBe(canonical)
  })

  it('supersession closes the old claim and prefers the new one', () => {
    const ev1 = store.insertEvidence({ projectId, snapshotId, sourceId, quote: '首发限定礼包定价30元' })
    const oldClaim = store.createClaim({
      projectId, claimType: 'official_fact', text: '礼包定价30元',
      extractionProvider: 'heuristic', evidence: [{ evidenceId: ev1 }],
    })
    const newClaim = store.createClaim({
      projectId, claimType: 'official_fact', text: '礼包定价25元（新版调价）',
      extractionProvider: 'heuristic', evidence: [{ evidenceId: ev1 }],
    })
    store.supersede(oldClaim, newClaim, 'system:supersession', '新版本调价')
    const oldRow = store.db.prepare(`SELECT rank, valid_until, superseded_by FROM claims WHERE id = ?`).get(oldClaim) as Record<string, string>
    expect(oldRow.rank).toBe('deprecated')
    expect(oldRow.valid_until).toBeTruthy()
    expect(oldRow.superseded_by).toBe(newClaim)
  })
})
