/**
 * 获客卖点合成层 —— 把可信知识投影成"能用的广告角度"。
 *
 * 设计灵魂:landmine(地雷)和 selling angle(卖点)共用同一套"维度"。
 * 某维度若有 landmine,该维度的正向卖点一律不合成 —— 否则一边警告别写、
 * 一边又建议写,自相矛盾。维度闸门是这套系统的核心约束。
 *
 * 五种套路(覆盖买量主力):
 *   ① 痛点反转  — ammo 类竞品/行业痛点 → 反转成卖点角度
 *   ② 卖点放大  — official_fact 正面事实 → 包装成钩子(不超出证据)
 *   ③ 口碑背书  — player_opinion 正面口碑 → "玩家都说 X"
 *   ④ 竞品卡位  — (依赖竞品 subject 数据,现阶段从 ammo 文本提取,弱化版)
 *   ⑤ 节点钩子  — 版本/活动/上线日期事实 → 时效钩子
 *
 * 合成的卖点继承到源 claim 的证据链(derived_from),可追溯、可重算。
 * 这是投影层,不存新事实 —— 知识的唯一事实源仍是 claims 表。
 */

import { landmineAvoidList } from './adRole.js'

/** 获客维度 —— landmine 禁区与 selling angle 卖点共用这套 key。 */
export type Dimension = 'monetization' | 'grind' | 'performance' | 'content' | 'fairness' | 'art' | 'story' | 'music' | 'brand' | 'timeliness'

/** claim.topic → 维度的映射(对齐两套逻辑)。 */
const TOPIC_TO_DIM: Record<string, Dimension> = {
  monetization: 'monetization',
  gameplay: 'content', // gameplay 口碑多谈内容/玩法量
  performance: 'performance',
  creative: 'art',
  product: 'brand',
}

/** 从 claim 文本反推维度(landmine 和卖点都用这个对齐)。 */
export function dimensionOf(topic: string, text: string): Dimension {
  if (TOPIC_TO_DIM[topic]) return TOPIC_TO_DIM[topic]
  // 文本兜底:按 landmine 同款词表判维度,保证两边对齐
  if (/氪|付费|逼氪|抽卡|价格|白嫖|福利/.test(text)) return 'monetization'
  if (/肝|日常|体力|重复/.test(text)) return 'grind'
  if (/优化|卡顿|掉帧|发烫|闪退|服务器|流畅/.test(text)) return 'performance'
  if (/内容|玩法|无聊|丰富|可玩/.test(text)) return 'content'
  if (/内部号|托|公平|外挂/.test(text)) return 'fairness'
  if (/画面|美术|画风|立绘|建模|场景|视觉/.test(text)) return 'art'
  if (/剧情|故事|文案/.test(text)) return 'story'
  if (/音乐|配乐|bgm|音效/.test(text)) return 'music'
  if (/版本|上线|更新|活动|发行|首发|日期/.test(text)) return 'timeliness'
  if (/开发商|发行商|公司|大厂|IP/.test(text)) return 'brand'
  return 'brand'
}

// ============ landmine 闸门:从 landmine claim 集合推出"被封锁的维度" ============

/**
 * 收集一个项目所有 landmine claim,返回它们封锁的维度集合。
 * selling angle 合成时会跳过这些维度 —— 这是闸门。
 */
export function blockedDimensions(landmineTexts: string[]): Set<Dimension> {
  const blocked = new Set<Dimension>()
  for (const text of landmineTexts) {
    // 复用 adRole 的 landmine 词表判禁区维度(保证对齐)
    if (/氪|付费|逼氪/.test(text)) blocked.add('monetization')
    if (/肝|日常|体力/.test(text)) blocked.add('grind')
    if (/优化|卡顿|掉帧|发烫|闪退|服务器/.test(text)) blocked.add('performance')
    if (/内容|玩法|无聊/.test(text)) blocked.add('content')
    if (/内部号|托|公平|外挂/.test(text)) blocked.add('fairness')
    if (/画面|美术|画风|立绘/.test(text)) blocked.add('art')
    if (/剧情|文案/.test(text)) blocked.add('story')
  }
  return blocked
}

// ============ 五套路合成器 ============

export type AngleTactic = 'pain_reverse' | 'fact_amplify' | 'opinion_endorse' | 'competitor_position' | 'timely_hook'

export interface SellingAngle {
  dimension: Dimension
  tactic: AngleTactic
  angle: string // 卖点角度描述(给创意 Agent 的方向)
  hooks: string[] // 候选 punchline(自由修辞,平台不管)
  strength: 'high' | 'medium' | 'low' // 获客价值强度(#5 轻量揉进来)
  derived_from: string[] // 源 claim id(可追溯)
  rationale: string // 为什么合成这个角度
}

export interface ClaimForAngle {
  id: string
  claimType: string
  topic: string
  text: string
  band: string
  confidence: number | null
  sentiment?: string // opinion_stats.sentiment
  adRole?: string | null
  valueJson?: { value: number | string; unit?: string } | null
}

/**
 * 主合成入口:给定一组 claim + landmine 封锁集,产出所有未被闸门挡住的卖点角度。
 * ponytail: 启发式合成,覆盖套路主干;边界 case(反讽/双关)靠人工审核兜底。
 */
export function synthesizeAngles(claims: ClaimForAngle[], blocked: Set<Dimension>): SellingAngle[] {
  const angles: SellingAngle[] = []

  for (const c of claims) {
    // 可信知识才合成(与 Context Pack 同口径)。但 ammo 例外:竞品痛点的获客价值
    // 独立于代表性置信度——一条"竞品太氪"哪怕样本少,作为卡位角度依然有效
    // (与 landmine 不看 band 同理)。ammo 的 band 只影响 strength,不阻断合成。
    const trusted = ['auto_accepted', 'approved'].includes(c.band) || ['verified', 'likely'].includes(c.band)
    if (!trusted && c.adRole !== 'ammo') continue

    // ① 痛点反转 + ④ 竞品卡位:ammo 类负面口碑
    if (c.adRole === 'ammo') {
      const dim = dimensionOf(c.topic, c.text)
      if (blocked.has(dim)) continue // 闸门:该维度已被自己的 landmine 封锁,不能用
      const isCompetitor = /竞品|其他游戏|隔壁|友商/.test(c.text)
      // 反转型是买量最强钩子,但样本少(band 低)时降为 medium——角度有效,只是证据薄
      const ammoStrength: SellingAngle['strength'] = ['verified', 'likely'].includes(c.band) ? 'high' : 'medium'
      angles.push({
        dimension: dim,
        tactic: isCompetitor ? 'competitor_position' : 'pain_reverse',
        angle: isCompetitor ? '竞品卡位:利用竞品在该维度的劣势' : '行业痛点反转:把通病变成你的优势',
        hooks: reverseHooks(dim),
        strength: ammoStrength,
        derived_from: [c.id],
        rationale: `源自口碑「${c.text.slice(0, 30)}…」`,
      })
    }

    // ② 卖点放大:official_fact 正面事实
    if (c.claimType === 'official_fact') {
      const factAngle = amplifyFact(c)
      if (factAngle && !blocked.has(factAngle.dimension)) {
        angles.push(factAngle)
      }
    }

    // ③ 口碑背书:player_opinion 正面口碑
    if (c.claimType === 'player_opinion' && c.sentiment === 'positive') {
      const dim = dimensionOf(c.topic, c.text)
      if (blocked.has(dim)) continue
      angles.push({
        dimension: dim,
        tactic: 'opinion_endorse',
        angle: '口碑背书:用真实玩家好评做信任钩子',
        hooks: endorseHooks(dim, c.text),
        strength: c.band === 'verified' ? 'high' : 'medium',
        derived_from: [c.id],
        rationale: `源自口碑「${c.text.slice(0, 30)}…」(${c.band})`,
      })
    }
  }

  // 去重:同维度同套路只留 strength 最高的(避免一个维度刷屏)
  const best = new Map<string, SellingAngle>()
  const rank: Record<string, number> = { high: 3, medium: 2, low: 1 }
  for (const a of angles) {
    const key = `${a.dimension}:${a.tactic}`
    const prev = best.get(key)
    if (!prev || (rank[a.strength] ?? 0) > (rank[prev.strength] ?? 0)) best.set(key, a)
  }
  return [...best.values()].sort((a, b) => (rank[b.strength] ?? 0) - (rank[a.strength] ?? 0))
}

/** ② 卖点放大:从 official_fact 文本提取可放大的事实角度。 */
function amplifyFact(c: ClaimForAngle): SellingAngle | null {
  const t = c.text
  const dim = dimensionOf(c.topic, t)

  // 节点钩子:版本/上线日期
  if (/发行|上架日期|上线/.test(t) && c.valueJson?.value) {
    return {
      dimension: 'timeliness',
      tactic: 'timely_hook',
      angle: '时效节点:用上线/版本时间制造稀缺与期待',
      hooks: ['即将上线', '新作首发', '版本更新'],
      strength: 'high',
      derived_from: [c.id],
      rationale: `源自事实「${t.slice(0, 30)}…」`,
    }
  }
  // 品类/IP → 题材钩子
  if (/品类|类型/.test(t)) {
    return {
      dimension: dim,
      tactic: 'fact_amplify',
      angle: '题材定位:用品类标签精准锚定人群',
      hooks: extractGenreHooks(t),
      strength: 'medium',
      derived_from: [c.id],
      rationale: `源自事实「${t.slice(0, 30)}…」`,
    }
  }
  // 开发商 → 品牌背书
  if (/开发商|发行商/.test(t)) {
    return {
      dimension: 'brand',
      tactic: 'fact_amplify',
      angle: '品牌背书:用制作方建立信任',
      hooks: ['知名厂商出品', '诚意之作'],
      strength: 'low',
      derived_from: [c.id],
      rationale: `源自事实「${t.slice(0, 30)}…」`,
    }
  }
  // 免费 → 门槛钩子(注意:若 monetization 被 landmine 封锁,闸门会挡掉)
  if (/免费|免费游玩/.test(t)) {
    return {
      dimension: 'monetization',
      tactic: 'fact_amplify',
      angle: '低门槛:免费游玩降低尝试成本',
      hooks: ['免费下载', '现在就玩'],
      strength: 'medium',
      derived_from: [c.id],
      rationale: '源自价格事实',
    }
  }
  return null
}

// ============ 维度 → 候选钩子词表(自由修辞,非资质类,平台不管) ============

function reverseHooks(dim: Dimension): string[] {
  const map: Record<Dimension, string[]> = {
    monetization: ['良心福利', '免费也能玩', '不逼氪'],
    grind: ['轻松护肝', '碎片时间', '不肝不累'],
    performance: ['丝滑流畅', '优化在线'],
    content: ['内容丰富', '玩法多样'],
    fairness: ['公平竞技', '绿色环境'],
    art: ['画面惊艳', '视觉震撼'],
    story: ['剧情上头', '故事动人'],
    music: ['配乐封神', '听觉享受'],
    brand: ['诚意之作'],
    timeliness: ['不容错过'],
  }
  return map[dim] ?? []
}

function endorseHooks(dim: Dimension, _text: string): string[] {
  // 口碑背书:直接用维度正向词,标注"玩家认可"
  const base = reverseHooks(dim)
  return base.length ? base.map((h) => `玩家都说${h}`) : ['玩家好评']
}

function extractGenreHooks(text: string): string[] {
  const m = text.match(/品类为\s*(.+)$/)
  if (!m) return ['热门题材']
  // 取前 2 个品类标签做钩子
  return m[1]!.split(/[、,，/\s]/).filter((s) => s.length >= 2).slice(0, 2)
}
