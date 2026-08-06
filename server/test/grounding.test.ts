import { describe, expect, it } from 'vitest'
import { groundQuote } from '../src/core/grounding.js'

const snapshot = `《原神》是米哈游自研的开放世界冒险游戏。
游戏发生在名为"提瓦特"的幻想世界。 玩家将扮演旅行者，
在自由的旅行中邂逅性格各异的同伴。本次 5.0 版本更新新增了纳塔地区。`

describe('grounding — citation integrity', () => {
  it('finds exact quotes with offsets', () => {
    const r = groundQuote(snapshot, '米哈游自研的开放世界冒险游戏')
    expect(r.ok).toBe(true)
    expect(r.method).toBe('exact')
    expect(snapshot.slice(r.start!, r.end!)).toBe('米哈游自研的开放世界冒险游戏')
  })

  it('tolerates whitespace and punctuation-width differences', () => {
    const r = groundQuote(snapshot, '玩家将扮演旅行者，在自由的旅行中邂逅性格各异的同伴')
    expect(r.ok).toBe(true)
    expect(r.method).toBe('normalized')
  })

  it('REJECTS quotes that do not exist in the snapshot (anti-hallucination)', () => {
    const r = groundQuote(snapshot, '该游戏月流水超过十亿美元')
    expect(r.ok).toBe(false)
  })

  it('rejects empty and too-short unmatched quotes', () => {
    expect(groundQuote(snapshot, '').ok).toBe(false)
    expect(groundQuote(snapshot, '  ').ok).toBe(false)
  })
})
