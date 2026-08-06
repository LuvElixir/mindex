/**
 * 连接器直测：用真实项目名跑各连接器的 discover()，打印抓取条数与样例。
 * 用法：tsx src/scripts/probe-connectors.ts 原神 [connectorId...]
 * 不写库，只验证抓取通路（TikHub / 代理）是否真的活着。
 */
import { Fetcher } from '../connectors/fetcher.js'
import { getConnector, connectors } from '../connectors/registry.js'
import type { ConnectorContext } from '../connectors/types.js'
import type { ProjectRow } from '../core/store.js'

const name = process.argv[2] || '原神'
const only = process.argv.slice(3)

const project = {
  id: 'probe',
  name,
  aliases: [],
  official_urls: name === '原神' ? ['https://www.taptap.cn/app/168332'] : [],
  platform_hints: {},
  kind: 'game',
  description: '',
  current_version: null,
  demo: 0,
  created_at: '',
  updated_at: '',
} as unknown as ProjectRow

const ctx: ConnectorContext = {
  project,
  keywords: [name],
  fetcher: new Fetcher(),
  log: (m) => console.log('   ·', m),
}

const targets = only.length ? only.map((id) => getConnector(id)!).filter(Boolean) : connectors.filter((c) => c.discover)

for (const c of targets) {
  if (!c.discover) continue
  console.log(`\n=== ${c.id} (${c.label}) status=${c.status} ===`)
  if (c.status !== 'verified') {
    console.log('   跳过（非 verified）')
    continue
  }
  try {
    if (c.resolve) {
      const hints = await c.resolve(ctx)
      Object.assign(project.platform_hints, hints)
    }
    const t0 = Date.now()
    const docs = await c.discover(ctx)
    console.log(`   → ${docs.length} 个文档 (${Date.now() - t0}ms)`)
    for (const d of docs.slice(0, 3)) console.log(`     [${d.doc.docType}] ${(d.text || '').slice(0, 60).replace(/\n/g, ' ')}`)
  } catch (err) {
    console.log('   ✗ 异常:', String(err).slice(0, 200))
  }
}
process.exit(0)
