import { itunesConnector } from './itunes.js'
import { webConnector } from './web.js'
import { baobaomiConnector } from './baobaomi.js'
import { bilibiliConnector } from './bilibili.js'
import { xiaohongshuConnector } from './xiaohongshu.js'
import { douyinConnector } from './douyin.js'
import { kuaishouConnector } from './kuaishou.js'
import { weiboConnector } from './weibo.js'
import { taptapConnector } from './taptap.js'
import type { Connector } from './types.js'

export const connectors: Connector[] = [
  itunesConnector,
  webConnector,
  baobaomiConnector,
  bilibiliConnector,
  xiaohongshuConnector,
  douyinConnector,
  kuaishouConnector,
  weiboConnector,
  taptapConnector,
]

export function getConnector(id: string): Connector | undefined {
  return connectors.find((c) => c.id === id)
}

export function liveConnectors(): Connector[] {
  return connectors.filter((c) => c.status === 'verified')
}
