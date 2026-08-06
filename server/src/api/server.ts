import Fastify, { type FastifyInstance } from 'fastify'
import fastifySwagger from '@fastify/swagger'
import scalarReference from '@scalar/fastify-api-reference'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { ROOT_DIR } from '../config.js'
import type { Store } from '../core/store.js'
import { initSettings } from '../core/settings.js'
import { agentRoutes } from './agentRoutes.js'
import { appRoutes } from './appRoutes.js'

export async function buildServer(store: Store, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  initSettings(store.db)
  const app = Fastify({
    logger: opts.logger === false ? false : { transport: undefined, level: 'info' },
    trustProxy: true,
  })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(cors, { origin: true })

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Mindex Agent API',
        version: '0.1.0',
        description: [
          'Mindex 是 local-first 的广告知识中枢。本 API 面向下游创意 Agent（如 AdMuse）：',
          '搜索可信知识、读取证据与溯源链、生成带引用的 Context Pack。',
          '',
          '认证：`Authorization: Bearer mdx_live_...`（在管理界面「Agent 接入」页创建 Key）。',
          '所有结论均可追溯：claim → evidence（逐字引文）→ snapshot（抓取快照）→ source（来源）。',
          '置信度分档：verified / likely / uncertain / disputed / insufficient；观点类的分数表示“代表性”而非事实为真。',
        ].join('\n'),
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API Key (mdx_live_...)' },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'knowledge', description: '知识检索与溯源' },
        { name: 'context', description: 'Context Pack 生成' },
        { name: 'meta', description: 'Key 自检' },
      ],
    },
    transform: jsonSchemaTransform,
  })

  await app.register(agentRoutes, { prefix: '/api/v1', store })
  await app.register(appRoutes, { prefix: '/app', store })

  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger())
  await app.register(scalarReference, {
    routePrefix: '/api/v1/docs',
    configuration: { url: '/api/v1/openapi.json' },
  })

  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true, service: 'mindex' }))

  // serve built web UI (production/local single-process mode)
  const webDist = path.join(ROOT_DIR, 'web', 'dist')
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/app/')) {
        return reply.code(404).send({ error: 'not_found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}
