/**
 * 获客视角投影:把负面口碑分成两类(广告用途)。
 *
 *   landmine(地雷) — 本产品当前的真实短板,广告里绝对不能反向承诺。
 *     例:你被骂"太氪" → 不能写"零氪爽玩";被骂"优化差" → 不能写"丝滑流畅"。
 *   ammo(弹药)  — 行业通病或指向竞品的痛点,反转后可成卖点角度。
 *     例:骂竞品"肝" → "告别爆肝"。
 *
 * 关键保守原则:拿不准就归 landmine。误判 ammo 会诱导下游写出踩雷文案,
 * 代价远大于误判 landmine(只是少用一个角度)。NULL = 非负面/未触发判据,不投影。
 *
 * 启发式边界(ponytail):纯文本判定,看不懂反讽/双关,有漏判。靠人工审核兜底——
 * landmine 进 review_queue 由人确认;这是"先保守挡住,再由人放行"的闸门,不是终判。
 */

export type AdRole = 'ammo' | 'landmine'

/** 第三方主语 + 贬述:竞品/其他游戏/隔壁 等后跟贬义词(骂的对象是第三方,而非本产品)。 */
const COMPETITOR_DEFECT =
  /(竞品|其他游戏?|别的游戏?|隔壁|友商|同类作品|同类型游戏)[^。]{0,12}(太|很|过于|比较)?(肝|氪|贵|烂|差|卡|坑|丑|无聊|繁琐|逼氪|抽卡|掉帧|卡顿|优化差)|比起.{0,8}不如|相比之下.{0,8}(不如|更好)/

/**
 * 判定一条负面口碑的获客角色。
 * @param text        claim 文本(脱语境陈述)
 * @param projectName 项目名(用于排除"项目自身被点名"的情况)
 * @returns ammo | landmine | null(null=非负面或判据未触发,不投影)
 *
 * 判据优先级:
 *  1) 自贬型(本项目 + 不如/比不上/落后)→ landmine(你确实弱,不能据此写"超越")
 *  2) 以第三方为主语的贬述(竞品 + 贬义描述)→ ammo(卡位机会)
 *  3) 其余负面 → 默认 landmine(保守:误判 ammo 诱导踩雷,代价更大)
 */
export function classifyAdRole(text: string, projectName: string, sentiment: string): AdRole | null {
  if (sentiment !== 'negative') return null

  // 0) 竞品口碑(文本以"竞品《X》"标记)在逻辑上不可能是本产品的地雷——
  // 它描述的是竞品,要么是 ammo(骂竞品),要么不投影(中性竞品评论)。
  // 必须在 landmine 兜底之前拦截,否则中性竞品评论会被误判成本项目短板。
  if (/^竞品《.+》/.test(text)) {
    return COMPETITOR_DEFECT.test(text) ? 'ammo' : null
  }

  // 1) 自贬优先:本项目被点名为劣势 → 即使句中出现"竞品"也是 landmine
  if (projectName && new RegExp(`《?${escapeRe(projectName)}》?\\s*(不如|比不上|落后|差于|弱于)`).test(text)) {
    return 'landmine'
  }

  // 2) 以第三方为主语描述其缺点 → ammo
  if (COMPETITOR_DEFECT.test(text)) {
    return 'ammo'
  }

  // 3) 其余负面 = 本产品短板 → 默认 landmine
  return 'landmine'
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 给 landmine 配一个"反向承诺警示":下游 Agent 看到这个就知道别写什么。
 * 与 SellingAngles 不同,这里只列"禁区",不生成话术——避免诱导。
 */
const LANDMINE_REVERSE: { match: RegExp; avoid: string }[] = [
  { match: /氪|付费(设计)?(激进|重|压力大)|逼氪|抽卡.*(贵|坑)|割韭菜/, avoid: '零氪/不氪/良心付费/白嫖 类承诺' },
  { match: /肝|重复度|日常.*(繁琐|太多)|体力.*(不够|恢复慢)/, avoid: '轻松/护肝/不肝 类承诺' },
  { match: /优化.*(差|烂)|卡顿|掉帧|发烫|闪退|崩溃|服务器.*(炸|卡|崩)/, avoid: '丝滑/流畅/不卡 类承诺' },
  { match: /内容(少|匮乏|太少)|玩法.*(单一|重复)|无聊/, avoid: '内容丰富/玩法多样 类承诺' },
  { match: /内部号|托|刷|外挂|破坏公平/, avoid: '公平竞技/绿色环境 类承诺' },
  { match: /剧情.*(差|烂|拖沓)|文案.*(差|烂)/, avoid: '剧情精彩/文案优秀 类承诺' },
  { match: /画面.*(差|糊)|画风.*(丑|不喜欢)/, avoid: '画面精美/视觉震撼 类承诺' },
]

export function landmineAvoidList(text: string): string[] {
  const out: string[] = []
  for (const r of LANDMINE_REVERSE) if (r.match.test(text)) out.push(r.avoid)
  return out
}
