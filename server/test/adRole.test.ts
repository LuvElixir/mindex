import { describe, it, expect } from 'vitest'
import { classifyAdRole, landmineAvoidList } from '../src/core/adRole.js'

/**
 * classifyAdRole 是这次改动的核心非平凡逻辑:把负面口碑分成 ammo/landmine。
 * 保守原则:拿不准归 landmine(误判 ammo 会诱导踩雷文案,代价更大)。
 * 这里覆盖真实数据里出现过的口碑文本形态。
 */
describe('classifyAdRole', () => {
  const proj = '伊莫'

  it('非负面口碑不投影(返回 null)', () => {
    expect(classifyAdRole('玩家认为玩法有趣', proj, 'positive')).toBeNull()
    expect(classifyAdRole('开发商是腾讯', proj, '')).toBeNull()
  })

  it('本产品自身的付费短板 → landmine(最常见情况)', () => {
    const text = '玩家认为氪金压力大或付费设计激进（《伊莫》）'
    expect(classifyAdRole(text, proj, 'negative')).toBe('landmine')
  })

  it('本产品自身的优化短板 → landmine', () => {
    const text = '玩家反馈存在优化/性能问题（卡顿、发热、闪退等）（《遗忘之海》）'
    expect(classifyAdRole(text, '遗忘之海', 'negative')).toBe('landmine')
  })

  it('公平性问题(内部号/托) → landmine', () => {
    const text = '部分玩家反馈游戏内存在大量内部号或托，疑似破坏游戏公平环境'
    expect(classifyAdRole(text, '灵妖劫', 'negative')).toBe('landmine')
  })

  it('指向竞品的痛点 → ammo(卡位机会)', () => {
    const text = '玩家认为竞品太肝，相比之下本作日常负担较轻'
    expect(classifyAdRole(text, proj, 'negative')).toBe('ammo')
  })

  it('"其他游戏/隔壁"等第三方信号 → ammo', () => {
    expect(classifyAdRole('玩家吐槽别的游戏逼氪严重', proj, 'negative')).toBe('ammo')
    expect(classifyAdRole('隔壁同类作品优化烂', proj, 'negative')).toBe('ammo')
  })

  it('自贬型(项目名+不如竞品)仍是 landmine——不能据此写"超越竞品"', () => {
    const text = '《伊莫》不如竞品,玩家普遍觉得画质落后'
    expect(classifyAdRole(text, proj, 'negative')).toBe('landmine')
  })

  it('竞品口碑(文本以"竞品《X》"开头)绝不归 landmine——它描述竞品,不是本项目短板', () => {
    // 真实场景:搜"竞品+痛点词"抓回的评论很多是中性/无关,不该误判成本项目地雷
    expect(classifyAdRole('竞品《原神》玩家反馈：这个声音也是爱了', proj, 'negative')).toBeNull()
    expect(classifyAdRole('竞品《原神》玩家反馈：[赞][赞][赞]', proj, 'negative')).toBeNull()
    expect(classifyAdRole('竞品《原神》存在玩家负面反馈', proj, 'negative')).toBeNull()
  })

  it('竞品口碑含明确痛点词 → ammo(骂竞品)', () => {
    expect(classifyAdRole('竞品《原神》玩家反馈：太氪了抽卡又贵', proj, 'negative')).toBe('ammo')
    expect(classifyAdRole('竞品《原神》玩家反馈：优化太差一直卡顿', proj, 'negative')).toBe('ammo')
  })
})

describe('landmineAvoidList', () => {
  it('付费类短板 → 禁止零氪/不氪承诺', () => {
    const avoid = landmineAvoidList('玩家认为氪金压力大、逼氪严重')
    expect(avoid).toEqual(expect.arrayContaining([expect.stringContaining('零氪')]))
  })

  it('优化类短板 → 禁止丝滑/流畅承诺', () => {
    const avoid = landmineAvoidList('玩家反馈卡顿、掉帧、发烫')
    expect(avoid).toEqual(expect.arrayContaining([expect.stringContaining('丝滑')]))
  })

  it('肝度类短板 → 禁止护肝承诺', () => {
    const avoid = landmineAvoidList('玩家觉得太肝,日常繁琐')
    expect(avoid.some((a) => a.includes('护肝'))).toBe(true)
  })

  it('无匹配短板时返回空数组(不误报)', () => {
    expect(landmineAvoidList('一些无关紧要的文字')).toEqual([])
  })

  it('一条口碑可命中多个禁区(如既氪又肝)', () => {
    const avoid = landmineAvoidList('又氪又肝,日常繁琐还卡顿')
    expect(avoid.length).toBeGreaterThanOrEqual(2)
  })
})
