import { config } from './config.js'
import { getDb } from './db/index.js'
import { Store } from './core/store.js'
import { buildServer } from './api/server.js'

const store = new Store(getDb())
const app = await buildServer(store)

await app.listen({ host: config.host, port: config.port })

// eslint-disable-next-line no-console
console.log(`
  ┌──────────────────────────────────────────────────────────┐
  │  Mindex — Index everything. Find insight.                │
  ├──────────────────────────────────────────────────────────┤
  │  管理界面   http://${config.host}:${config.port}/
  │  API 文档   http://${config.host}:${config.port}/api/v1/docs
  │  OpenAPI    http://${config.host}:${config.port}/api/v1/openapi.json
  │
  │  管理员 Token（登录管理界面用）:
  │  ${config.adminToken}
  └──────────────────────────────────────────────────────────┘
`)
