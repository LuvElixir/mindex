import { describe, expect, it } from 'vitest'
import { xiaohongshuConnector } from '../src/connectors/xiaohongshu.js'
import { connectors } from '../src/connectors/registry.js'
import { findArray } from '../src/connectors/tikhub.js'

describe('xiaohongshu connector (via TikHub)', () => {
  it('replaces the old adapter — one real connector, not adapter_only', () => {
    const xhs = connectors.filter((c) => c.id === 'xiaohongshu')
    expect(xhs.length).toBe(1)
    expect(xhs[0]!.status).not.toBe('adapter_only')
  })

  it('declares UGC/engagement honesty in its compliance note', () => {
    expect(xiaohongshuConnector.compliance).toContain('点赞收藏数仅展示不计入置信度')
    expect(xiaohongshuConnector.compliance).toContain('TikHub')
  })
})

describe('tikhub findArray — locates nested item arrays defensively', () => {
  it('finds a deeply nested array whose items carry the target key', () => {
    const payload = { data: { data: { items: [{ note: { id: '1' } }, { note: { id: '2' } }] } } }
    const found = findArray(payload, 'note')
    expect(found?.length).toBe(2)
  })
  it('finds comment arrays by the content key', () => {
    const payload = { data: { comments: { list: [{ content: 'hi', like_count: 3 }] } } }
    const found = findArray(payload, 'content')
    expect(found?.[0]!.content).toBe('hi')
  })
  it('returns null when nothing matches', () => {
    expect(findArray({ a: 1, b: [1, 2, 3] }, 'note')).toBeNull()
  })
})
