![Mindex · 让每条结论都有出处](.readme-assets/hero.svg)

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>
<p align="center"><a href="#快速开始">快速开始</a> · <a href="docs/architecture.md">架构设计</a> · <a href="docs/evaluation.md">评测方法</a> · <a href="docs/compliance.md">来源策略</a></p>

# 给 Agent 一份有出处的上下文

Mindex 是面向手游广告研究的本地知识库。它把资料整理成独立结论，为结论关联原文证据，再通过检索、Context Pack 和 MCP 提供给研究人员与下游 Agent。

研究人员可以回到原文核对判断。Agent 也能拿到同一份证据，以及来源和审核状态。尚未解决的冲突，会继续留在流程里。

![收集资料、核对证据、审核判断、提供上下文](.readme-assets/workflow.zh-CN.svg)

## 从资料到可核对的知识

| 能力 | 帮你完成什么 |
| --- | --- |
| 来源快照 | 保存抽取时使用的那一版资料。 |
| 引文校验 | 检查证据引文能否在来源快照中找到。 |
| 置信与审核 | 展示判断依据，把不确定与冲突交给审核。 |
| Context Pack | 按任务与 Token 预算提供带引用的知识包。 |
| REST 与 MCP | 让人和下游 Agent 使用同一套知识服务。 |

## 一条结论怎样保留出处

```mermaid
flowchart LR
  A[来源] --> B[保存快照]
  B --> C[原文证据]
  C --> D[结论]
  D --> E{审核状态}
  E -->|已接受| F[检索与知识包]
  E -->|不确定或有争议| G[审核队列]
  G --> E
  F --> H[REST API 与 MCP]
```

引文匹配可以检查引用完整性。来源是否准确、引文是否支持结论、评论样本能否代表更多用户，仍需要分别判断。置信分数用于辅助评估，尚不能视为经过独立校准的概率。

## 快速开始

准备 **Node.js 22 或更新版本**与 npm。

```bash
git clone https://github.com/LuvElixir/MindexAI.git
cd MindexAI
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:8787>，使用服务启动时打印的管理员 Token 登录。在 **设置** 里配置模型和可用来源，然后创建项目，发起研究或导入资料。

数据保存在本地 `data/` 目录。该目录和真实凭据应保留在运行环境中。

## 让 Agent 读取知识

在「Agent 接入」页面创建限定项目范围的 API Key。服务提供带引用的检索与知识包接口，MCP 复用同一套 REST 鉴权。

| 入口 | 用途 |
| --- | --- |
| `/api/v1/search` | 检索知识与关联引用。 |
| `/api/v1/context-pack` | 按具体任务组装上下文。 |
| `/api/v1/docs` | 浏览本地 API 文档。 |
| `npm run mcp` | 使用已配置的 Key 启动 stdio MCP 适配器。 |

接入示例和部署细节保留在[技术参考](README.reference.md#agent-接入)中。

## 参与开发

```bash
npm run dev
npm test
npm run eval
```

开发界面使用 **5173** 端口。评测会检查配置中的知识库，断言及边界见[评测方法](docs/evaluation.md)。

| 目录 | 内容 |
| --- | --- |
| `server/src/agent/`、`server/src/connectors/` | 研究、抽取与资料来源。 |
| `server/src/core/`、SQLite | 证据与知识管理。 |
| `server/src/search/`、`api/`、`mcp/` | 检索与 Agent 接入。 |
| `web/` | React 与 Vite 研究界面。 |

## 当前范围

Mindex 主要服务国内手游研究。来源可用性取决于连接器、凭据、网络与平台限制，部分来源使用导入流程。没有 LLM 时，抽取能力会降级。使用连接器前请阅读[来源策略](docs/compliance.md)。

仓库目前没有独立的开源许可证文件。公开可见不代表已授予无限制的复用许可。

<p align="center"><a href="https://github.com/LuvElixir">LuvElixir</a> 制作 · <a href="https://luckyloading.com/">Luckyloading</a></p>
