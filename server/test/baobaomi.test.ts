import { describe, expect, it } from 'vitest'
import { baobaomiConnector } from '../src/connectors/baobaomi.js'
import { creativeInsightFromRef } from '../src/agent/extract.js'
import { groundQuote } from '../src/core/grounding.js'

/**
 * The live baobaomi Agent API needs a secret key (operator-supplied), so CI can't call
 * it. These tests lock the connector's honest-degradation contract and the pure helpers
 * that decide what gets ingested. Live wiring is verified manually once the key is set.
 */

describe('baobaomi connector — honest degradation', () => {
  it('reports needs_key and ingests nothing when no key is configured', async () => {
    // default env has no BAOBAOMI_AGENT_KEY in test
    expect(['needs_key', 'verified']).toContain(baobaomiConnector.status)
    if (baobaomiConnector.status === 'needs_key') {
      const logs: string[] = []
      const docs = await baobaomiConnector.discover!({
        project: { id: 'p', name: '原神', aliases: [], competitors: [], kind: 'game', description: '', official_urls: [], platform_hints: {}, current_version: null, demo: 0, created_at: '', updated_at: '' },
        keywords: ['原神'],
        fetcher: {} as never,
        log: (m: string) => logs.push(m),
      })
      expect(docs).toEqual([])
      expect(logs.join(' ')).toContain('needs_key')
    }
  })

  it('declares itself as a reuse connector with a compliance note', () => {
    expect(baobaomiConnector.id).toBe('baobaomi')
    expect(baobaomiConnector.compliance).toContain('Agent API')
  })
})

describe('baobaomi creative material → creative_insight (not player_opinion)', () => {
  const material = `钩子类型：悬念
情绪曲线：先压抑后爆发
视觉风格：东方武侠CG冷调悲情

=== 创意拆解 ===
## 钩子
> "谁能想到，两张假面竟将一对兄弟推向了完全相反的结局。"
用反问加结果前置制造悬念。`

  it('produces a grounded creative_insight whose quote is verbatim in the material', () => {
    const ci = creativeInsightFromRef('燕云十六声', material, { hookType: '悬念', emotionArc: '先压抑后爆发', visualStyle: '东方武侠CG冷调悲情' })
    expect(ci).not.toBeNull()
    expect(ci!.text).toContain('创意角度')
    expect(ci!.text).toContain('燕云十六声')
    // the claim must NOT frame ad copy as player opinion
    expect(ci!.text).not.toContain('玩家认为')
    expect(groundQuote(material, ci!.quote).ok).toBe(true)
  })

  it('returns null when no groundable quote can be found', () => {
    expect(creativeInsightFromRef('X', '钩子类型：悬念', {})).toBeNull()
  })
})
