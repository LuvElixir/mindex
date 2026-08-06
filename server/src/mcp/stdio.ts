import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/**
 * Thin MCP layer (stdio): proxies tool calls to the local Mindex REST API.
 * The API key travels via env — auth, rate limiting and audit logging all happen
 * in the REST layer, so MCP traffic is fully accounted per key.
 *
 * Claude Code:
 *   claude mcp add mindex --env MINDEX_API_KEY=mdx_live_xxx -- npm run mcp --workspace=@mindex/server
 */

const API = process.env.MINDEX_API_URL ?? 'http://127.0.0.1:8787'
const KEY = process.env.MINDEX_API_KEY
if (!KEY) {
  console.error('MINDEX_API_KEY is required (create one in the Mindex admin UI → Agent 接入)')
  process.exit(1)
}

async function rest(pathname: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`Mindex API ${res.status}: ${body.slice(0, 500)}`)
  return JSON.parse(body)
}

const asText = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] })

const server = new McpServer({ name: 'mindex', version: '0.1.0' })

server.registerTool(
  'list_projects',
  {
    title: 'List Mindex projects',
    description: '列出当前 API Key 可访问的 Mindex 项目及其知识规模。',
    inputSchema: {},
  },
  async () => asText(await rest('/api/v1/projects')),
)

server.registerTool(
  'search_knowledge',
  {
    title: 'Search knowledge',
    description:
      '在 Mindex 知识库中混合检索可信知识结论。返回带引用（evidence id + 原文引文 + 来源）与置信度分档的结果。观点类结论的置信度表示玩家观点的代表性，不是事实真伪。',
    inputSchema: {
      query: z.string().describe('查询词，中英文均可'),
      project_id: z.string().optional().describe('限定项目 id（可先用 list_projects 查看）'),
      types: z.string().optional().describe('逗号分隔的类型过滤: official_fact,player_opinion,system_inference,creative_insight'),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, project_id, types, limit }) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    if (project_id) params.set('project_id', project_id)
    if (types) params.set('types', types)
    return asText(await rest(`/api/v1/search?${params}`))
  },
)

server.registerTool(
  'get_claim',
  {
    title: 'Get claim detail',
    description: '读取一条知识结论的完整详情：全部证据引文、来源溯源链、置信度分解、冲突与版本历史。',
    inputSchema: { claim_id: z.string() },
  },
  async ({ claim_id }) => asText(await rest(`/api/v1/claims/${encodeURIComponent(claim_id)}`)),
)

server.registerTool(
  'get_evidence',
  {
    title: 'Get evidence detail',
    description: '读取一条证据的原文引文、上下文、来源与抓取快照信息。',
    inputSchema: { evidence_id: z.string() },
  },
  async ({ evidence_id }) => asText(await rest(`/api/v1/evidence/${encodeURIComponent(evidence_id)}`)),
)

server.registerTool(
  'get_context_pack',
  {
    title: 'Get context pack',
    description:
      '为指定项目生成结构化 Context Pack（产品事实/受众观点/洞察，逐条带引用与置信度，未收录知识在 excluded 中声明）。写广告或做创意前先调用这个。',
    inputSchema: {
      project_id: z.string(),
      task: z.string().optional().describe('本次创意任务的描述，用于相关性排序'),
      focus: z.array(z.string()).optional().describe('聚焦主题，如 ["monetization","audience"]'),
      budget_tokens: z.number().int().min(800).max(32000).default(6000),
    },
  },
  async ({ project_id, task, focus, budget_tokens }) =>
    asText(
      await rest('/api/v1/context-pack', {
        method: 'POST',
        body: JSON.stringify({ project_id, task, focus, budget_tokens }),
      }),
    ),
)

server.registerTool(
  'import_reviews',
  {
    title: 'Import platform reviews',
    description:
      '批量导入外部采集的玩家评论（TapTap 等）。每条评论成为独立带溯源的文档，走口碑管线产出 player_opinion。只提交真实抓到的评论原文——系统逐字校验引文，改写过的内容会被丢弃。需要 knowledge:write 权限的 Key。',
    inputSchema: {
      project_id: z.string().describe('目标项目 id（可先用 list_projects 查看）'),
      platform: z.string().default('taptap').describe('评论来源平台：taptap / haoyoukuaibao / tieba / …'),
      app_name: z.string().optional().describe('游戏名（可选）'),
      source_url: z.string().optional().describe('评论页 URL（可选，用于溯源回指）'),
      reviews: z
        .array(
          z.object({
            content: z.string().describe('评论原文，必填，≥6 字符'),
            score: z.number().nullable().optional().describe('1-5 星'),
            author: z.string().nullable().optional(),
            up_count: z.number().nullable().optional().describe('点赞数（仅展示，不进置信度）'),
            published_at: z.string().nullable().optional().describe('ISO 日期'),
            review_id: z.string().nullable().optional().describe('平台评论 id，用于去重'),
          }),
        )
        .describe('评论数组（JSON 契约）'),
    },
  },
  async ({ project_id, platform, app_name, source_url, reviews }) =>
    asText(
      await rest(`/api/v1/projects/${encodeURIComponent(project_id)}/import-reviews`, {
        method: 'POST',
        body: JSON.stringify({ platform, app_name, source_url, format: 'json', reviews }),
      }),
    ),
)

server.registerTool(
  'import_document',
  {
    title: 'Import document',
    description:
      '导入一段资料原文（公告/行业文章/内部调研）。内容作为不可变快照入库，走抽取与逐字引文校验。只提交真实原文，不要改写或概括。需要 knowledge:write 权限的 Key。',
    inputSchema: {
      project_id: z.string(),
      title: z.string().describe('资料标题'),
      text: z.string().describe('资料原文（≥20 字符）'),
      url: z.string().optional().describe('原文链接（可选，用于溯源）'),
      platform: z.string().default('internal'),
      source_type: z.enum(['official', 'internal_doc', 'press', 'community', 'user_note']).default('user_note'),
    },
  },
  async ({ project_id, title, text, url, platform, source_type }) =>
    asText(
      await rest(`/api/v1/projects/${encodeURIComponent(project_id)}/import`, {
        method: 'POST',
        body: JSON.stringify({ title, text, url, platform, source_type }),
      }),
    ),
)

server.registerTool(
  'start_research',
  {
    title: 'Start research run',
    description:
      '对项目发起主动研究：跨国内平台采集并验证知识，异步执行。30 分钟内同目标已完成会返回 duplicate_recent，确需重复带 force=true。需要 knowledge:write 权限的 Key。',
    inputSchema: {
      project_id: z.string(),
      goal: z.string().optional().describe('研究目标（缺省=全面了解产品、受众与玩家口碑）'),
      force: z.boolean().default(false),
    },
  },
  async ({ project_id, goal, force }) =>
    asText(
      await rest(`/api/v1/projects/${encodeURIComponent(project_id)}/research`, {
        method: 'POST',
        body: JSON.stringify({ goal, force }),
      }),
    ),
)

await server.connect(new StdioServerTransport())
console.error('[mindex-mcp] connected via stdio →', API)
