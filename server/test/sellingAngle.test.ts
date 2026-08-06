import { describe, it, expect } from 'vitest'
import { synthesizeAngles, blockedDimensions, dimensionOf, type ClaimForAngle } from '../src/core/sellingAngle.js'

/**
 * sellingAngle 测试 —— 核心是闸门逻辑:landmine 封锁的维度,卖点绝不能合成。
 * 这是"一边警告别写、一边又建议写"自相矛盾的防线。
 */
const mk = (over: Partial<ClaimForAngle>): ClaimForAngle => ({
  id: 'c1',
  claimType: 'player_opinion',
  topic: 'gameplay',
  text: '',
  band: 'likely',
  confidence: 0.7,
  ...over,
})

describe('blockedDimensions', () => {
  it('氪金类 landmine → 封锁 monetization 维度', () => {
    expect(blockedDimensions(['玩家认为氪金压力大'])).toContain('monetization')
  })
  it('优化类 landmine → 封锁 performance 维度', () => {
    expect(blockedDimensions(['卡顿掉帧发烫'])).toContain('performance')
  })
  it('多条 landmine → 封锁多个维度', () => {
    const blocked = blockedDimensions(['太氪了', '优化差卡顿', '太肝日常繁琐'])
    expect(blocked.has('monetization')).toBe(true)
    expect(blocked.has('performance')).toBe(true)
    expect(blocked.has('grind')).toBe(true)
  })
  it('无 landmine → 空封锁集(所有维度可用)', () => {
    expect(blockedDimensions([]).size).toBe(0)
  })
})

describe('synthesizeAngles 闸门', () => {
  it('landmine 封锁的维度,正向口碑卖点不合成', () => {
    // monetization 被 landmine 封锁 → 即使有"付费友好"正面口碑,也不合成付费卖点
    const claims = [mk({ claimType: 'player_opinion', topic: 'monetization', text: '玩家认为付费设计友好', sentiment: 'positive', id: 'c1' })]
    const blocked = new Set(['monetization' as const])
    const angles = synthesizeAngles(claims, blocked)
    expect(angles.find((a) => a.dimension === 'monetization')).toBeUndefined()
  })

  it('未被封锁的维度,正向口碑正常合成 opinion_endorse', () => {
    const claims = [mk({ claimType: 'player_opinion', topic: 'creative', text: '玩家称赞美术画面精美', sentiment: 'positive' })]
    const angles = synthesizeAngles(claims, new Set())
    expect(angles.find((a) => a.tactic === 'opinion_endorse' && a.dimension === 'art')).toBeTruthy()
  })

  it('ammo 类竞品痛点 → 合成 competitor_position(高强度)', () => {
    const claims = [mk({ claimType: 'player_opinion', topic: 'gameplay', text: '玩家认为竞品太肝', sentiment: 'negative', adRole: 'ammo' })]
    const angles = synthesizeAngles(claims, new Set())
    const a = angles.find((x) => x.tactic === 'competitor_position')
    expect(a).toBeTruthy()
    expect(a!.strength).toBe('high')
  })

  it('但若该维度被自己的 landmine 封锁,ammo 也不合成(闸门优先)', () => {
    // 竞品"太肝"是 ammo,但本项目自己也被骂"太肝"(grind 被封锁) → 不能写"护肝"
    const claims = [mk({ topic: 'gameplay', text: '玩家认为竞品太肝', sentiment: 'negative', adRole: 'ammo' })]
    const blocked = new Set(['grind' as const])
    const angles = synthesizeAngles(claims, blocked)
    expect(angles.find((a) => a.dimension === 'grind')).toBeUndefined()
  })

  it('ammo 不卡 band(获客价值独立于代表性置信度),但低 band 降为 medium', () => {
    // 低 band 的竞品口碑依然合成 ammo 角度,只是 strength 降级
    const lowBand = mk({ topic: 'gameplay', text: '玩家认为竞品太肝', sentiment: 'negative', adRole: 'ammo', band: 'uncertain' })
    const angles = synthesizeAngles([lowBand], new Set())
    const a = angles.find((x) => x.tactic === 'competitor_position')
    expect(a).toBeTruthy() // uncertain band 不阻断 ammo
    expect(a!.strength).toBe('medium') // 但降级
  })
})

describe('synthesizeAngles 卖点放大②', () => {
  it('上线日期事实 → timely_hook(高强度)', () => {
    const claims = [mk({ claimType: 'official_fact', topic: 'product', text: '《X》的发行/上架日期为 2026-09-30', valueJson: { value: '2026-09-30' } })]
    const angles = synthesizeAngles(claims, new Set())
    const a = angles.find((x) => x.tactic === 'timely_hook')
    expect(a).toBeTruthy()
    expect(a!.strength).toBe('high')
    expect(a!.hooks).toContain('即将上线')
  })

  it('免费游玩事实 → monetization 卖点(但被封锁则不合成)', () => {
    const claims = [mk({ claimType: 'official_fact', topic: 'monetization', text: '《X》的价格为 免费游玩' })]
    // 未封锁 → 合成
    expect(synthesizeAngles(claims, new Set()).find((a) => a.dimension === 'monetization')).toBeTruthy()
    // 被 landmine 封锁 → 不合成(闸门)
    expect(synthesizeAngles(claims, new Set(['monetization' as const])).find((a) => a.dimension === 'monetization')).toBeUndefined()
  })
})

describe('synthesizeAngles 去重', () => {
  it('同维度同套路只留 strength 最高的(避免一个维度刷屏)', () => {
    const claims = [
      mk({ claimType: 'player_opinion', topic: 'creative', text: '玩家称赞美术', sentiment: 'positive', band: 'likely', id: 'c1' }),
      mk({ claimType: 'player_opinion', topic: 'creative', text: '玩家称赞画面精美', sentiment: 'positive', band: 'verified', id: 'c2' }),
    ]
    const angles = synthesizeAngles(claims, new Set())
    const endorse = angles.filter((a) => a.tactic === 'opinion_endorse' && a.dimension === 'art')
    expect(endorse.length).toBe(1)
    expect(endorse[0]!.strength).toBe('high') // verified → high
  })
})

describe('dimensionOf 对齐', () => {
  it('landmine 词表与卖点维度共用同一套 key', () => {
    // 同一段"太氪"文本,无论从 landmine 侧还是卖点侧判,都应得到 monetization
    expect(dimensionOf('monetization', '')).toBe('monetization')
    expect(dimensionOf('other', '太氪了逼氪严重')).toBe('monetization')
    expect(dimensionOf('other', '卡顿掉帧优化差')).toBe('performance')
    expect(dimensionOf('other', '太肝日常繁琐')).toBe('grind')
  })
})
