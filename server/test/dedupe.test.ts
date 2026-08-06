import { describe, expect, it } from 'vitest'
import { clusterDuplicates, scanAstroturf } from '../src/core/dedupe.js'

describe('near-duplicate clustering', () => {
  it('clusters syndicated long-form copies (simhash)', () => {
    const base = '《星穹列车》今日宣布将于8月15日开启全平台公测，本作是一款回合制策略RPG，由知名团队历时四年开发，主打高自由度的车厢建造玩法与跨星系剧情，预约人数已突破五百万，官方同时公布了公测限定角色与十连抽奖励，玩家可以在官网参与预约活动获得专属称号。'
    const copy = base.replace('今日宣布', '正式宣布').replace('玩家可以', '大家可以')
    const other = '完全不同的一篇文章，讲的是另一款独立游戏的像素画风和玫瑰花园的经营玩法，与前述内容毫无关系，开发者是两个人的小团队，众筹金额刚刚达到目标。这款游戏预计明年春天发售，支持中文。'
    const r = clusterDuplicates([
      { id: 'a', text: base },
      { id: 'b', text: copy },
      { id: 'c', text: other },
    ])
    expect(r.clusterOf.get('a')).toBe(r.clusterOf.get('b'))
    expect(r.clusterOf.get('c')).not.toBe(r.clusterOf.get('a'))
  })

  it('clusters near-identical short reviews (jaccard fallback)', () => {
    const r = clusterDuplicates([
      { id: 'a', text: '画面很好，剧情感人，强烈推荐！' },
      { id: 'b', text: '画面很好剧情感人，强烈推荐' },
      { id: 'c', text: '优化太差了，手机发烫严重' },
    ])
    expect(r.clusterOf.get('a')).toBe(r.clusterOf.get('b'))
    expect(r.clusterOf.get('c')).not.toBe(r.clusterOf.get('a'))
  })
})

describe('astroturf heuristics', () => {
  it('flags template-copy bursts posted within one day', () => {
    const t = '2026-07-01T10:00:00Z'
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      text: i < 6 ? `超好玩的游戏，画质无敌，快来下载！第${i}名` : `第${i}条完全不同的真实评价，讲了各自的体验细节和问题`,
      publishedAt: i < 6 ? t : `2026-0${(i % 6) + 1}-15T10:00:00Z`,
      authorHandle: `user${i}`,
    }))
    const r = scanAstroturf(items)
    expect(r.batchScore).toBeGreaterThan(0)
    expect(r.suspects.size).toBeGreaterThanOrEqual(2)
  })

  it('refuses to judge tiny samples', () => {
    const r = scanAstroturf([{ id: 'a', text: 'x', publishedAt: null, authorHandle: null }])
    expect(r.batchScore).toBe(0)
    expect(r.notes[0]).toContain('样本过小')
  })
})
