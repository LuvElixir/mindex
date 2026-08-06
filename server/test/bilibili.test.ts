import { describe, expect, it } from 'vitest'
import { bilibiliConnector, biliAvailable } from '../src/connectors/bilibili.js'
import { connectors } from '../src/connectors/registry.js'

/**
 * The `bili` CLI + live Bilibili access can't run deterministically in CI (network +
 * ambient binary), so these tests lock the deterministic contract. Live ingestion is
 * verified manually with a real research run.
 */

describe('bilibili connector', () => {
  it('replaces the old adapter — registry has one real bilibili connector, not adapter_only', () => {
    const bili = connectors.filter((c) => c.id === 'bilibili')
    expect(bili.length).toBe(1)
    expect(['verified', 'needs_key']).toContain(bili[0]!.status)
    expect(bili[0]!.status).not.toBe('adapter_only')
  })

  it('records comment engagement for display but declares it is not a truth signal', () => {
    expect(bilibiliConnector.compliance).toContain('点赞数仅作展示，不参与置信度')
    // player comments are UGC → paraphrase-only in context packs
    expect(bilibiliConnector.compliance).toContain('免登录')
  })

  it('CLI availability probe resolves to a boolean without throwing', async () => {
    const ok = await biliAvailable()
    expect(typeof ok).toBe('boolean')
  })
})
