# 来源数据获取策略

> **2026-07-22 更新**：产品负责人已明确移除自设的抓取合规红线（业务风险由 owner 承担）。原「不绕过登录/签名/访问控制」的自我约束不再适用。仍保留的工程实践——UA 标识、按主机限速、缓存快照、尊重 Retry-After——纯为**省流量与防封**（隧道代理按量计费、猛抓会被目标端与代理端双双拉黑），不是合规考量。

**当前获取能力**：
- UGC 口碑（抖音/快手/微博/小红书）经 **TikHub 付费聚合 API**，一把 key 覆盖多平台公开内容与评论；
- **快代理隧道**（`MINDEX_PROXY_URL`，大陆出口）用于穿透 IP 封锁：TapTap 对 IDC IP 返回 405、部分站点地域封锁，走代理绕过；连接器按 host 选择性启用代理（`fetch(url, {proxy:true})`），常规抓取仍直连省流量；
- 官网/行业媒体经 URL 抓取导入与 web 连接器。

robots.txt 策略仍可配置（`MINDEX_ROBOTS_POLICY`：`strict`/`log`（默认）/`off`），来源记录保留判定结果供审计——但默认 `log` 不阻断。

以下为各源实测接入状态（2026-07-22）：

## 已实测接通（自动抓取）

| 来源 | 端点 | 状态 | 约束与处理 |
|---|---|---|---|
| Apple iTunes Search/Lookup | `itunes.apple.com/search` `/lookup` | ✅ 官方公开 API，无需密钥 | 文档限速 ~20/min/IP → 内置 10/min 覆盖；仅 CN 商店（2026-07 起：产品聚焦国内手游买量，US 端点与 App Store 用户评论已按业务判断移除——评论口碑走 TapTap 导入 / B站 / 小红书）|
| 官网/公开网页 | 用户提供的 URL + 同站公告页 | ✅ 礼貌抓取 | robots 判定入库；JS 渲染壳页只取 meta 描述并如实记录 |
| Bilibili | `bili` CLI（bilibili-cli）| ✅ 免登录（搜索/详情/热评）| 经 bilibili-api-python 访问 api.bilibili.com；取高播放视频热评作玩家反馈；评论点赞数仅展示不计入置信度。运营方已确认采用此访问路径；需安装 `bili`（pip install bilibili-cli 或 BILI_CLI_PATH）|
| 小红书 | TikHub `/xiaohongshu/app_v2/*` | ✅ 需 TIKHUB_API_KEY | 搜笔记→取评论作玩家口碑；点赞收藏数仅展示不计入置信度；溯源回原笔记 URL |
| 抖音 | TikHub `/douyin/search/fetch_video_search_v1` + `/douyin/app/v3/fetch_video_comments` | ✅ 需 TIKHUB_API_KEY | 买量最核心平台：搜视频→取评论最多的头部→评论作玩家发言，视频文案作 UGC；实测单项目 100+ 评论 |
| 快手 | TikHub `/kuaishou/app/search_video_v2` + `/kuaishou/app/fetch_video_comment` | ✅ 需 TIKHUB_API_KEY | 下沉市场渠道；同抖音结构；photo_id 为 19 位裸整数，解析保大整数精度否则评论查询 400 |
| 微博 | TikHub `/weibo/web/fetch_search` + `/weibo/web/fetch_post_comments` | ✅ 需 TIKHUB_API_KEY | 官微资讯 + 帖子评论舆情；帖文/评论 text 含 HTML 抽取前清洗 |
| TapTap（聚合评分）| `www.taptap.cn/app/{id}` JSON-LD | ✅ 经快代理 | 抓服务端渲染页 JSON-LD 聚合评分/评分数/品类；**taptap.cn 对 IDC IP 返回 405 → 走快代理（大陆出口）绕过**；需项目配置 TapTap 链接 |

## 逐条评论与人工导入

- **TapTap 逐条评论**：无干净第三方 API（webapiv2 需逆向 X-UA 签名）；走「评论批量导入」（POST /app/projects/:id/import-reviews，Hermes 等外部采集后 Markdown/JSON 导入），逐条拆为 review 进玩家口碑管线，回指 TapTap URL。
- **行业媒体**：游戏陀螺经 URL 抓取导入（POST /app/projects/:id/import-url）；GameLook / 手游那点事屏蔽快代理 IP 段（517 隧道失败），需住宅代理或大陆自建节点。
- **贴吧 / NGA / 七麦**：反爬 403 或签名墙，待接住宅代理 + cookie 注入后接入（后续）。

> 已移除（2026-07，产品聚焦国内手游买量）：Steam、Wikipedia、App Store US、App Store 评论、Google Play 适配器。信源评估见 `docs/信息源评估报告-2026-07.md`。

## 抱抱米（baobaomi）复用连接器

抱抱米是配套的生产服务，已在采集抖音（经 TikHub）、B站（官方公开 API）、TapTap（自建爬虫）内容，并暴露官方 Agent API（MCP over HTTP + REST，Bearer key）。Mindex 通过 **服务端到服务端调用其 Agent API**（`BAOBAOMI_AGENT_KEY`）复用这些已采集内容——热点趋势、品类爆量素材——作为原始来源接入。

- **定位**：抱抱米出原始内容，Mindex 在其上叠加溯源、原子化 claim、置信度、冲突检测与 Context Pack。这正是"抱抱米给模型的 context 不够优质"的补齐层——下游拿到的不是原始视频列表，而是带引用、经交叉验证、标注置信度的知识。
- **合规**：原始内容的采集合规由抱抱米侧负责；Mindex 侧只做二次消费，记录来源链接（回指抖音视频/话题 URL）与抓取时间，authority_prior 按二手来源保守取值（0.4–0.45）。抖音 UGC 在 Context Pack 中标记只可转述。
- **降级**：未配置 key 时连接器状态为 `needs_key`，UI 显示「未接通」，主动研究时跳过，不影响其他来源。
- **未覆盖**：抱抱米无小红书实现，故 Mindex 经此复用也无小红书数据。

## 用户导入内容

- 上传/粘贴的内容由用户确认其使用权，来源记录 `license_note` 注明「用户导入内容」。
- 权威先验按内容性质评估（官方内容 0.9 / 内部文档 0.8 / 媒体 0.7 / 用户笔记 0.6 / 社区内容 0.4），不因“是用户传的”而自动可信。

## UGC 引用边界

商店评论等用户生成内容在 Context Pack 中标记 `quotable: false`——下游 Agent 只可转述，不可逐字用于公开投放物料；完整引文仅用于内部溯源与审核。

## 说明

2026-07-22 起，产品负责人移除自设抓取红线（见文首）。robots 默认 `log`（记录不阻断），可切 `strict` 恢复硬约束。快代理凭证在 `.env`（`MINDEX_PROXY_URL`，不进 git）。TikHub 为付费 API，超量会计费，连接器均有条数上限（`DOUYIN_MAX_VIDEOS`/`KUAISHOU_MAX_VIDEOS`/`WEIBO_MAX_POSTS`/`XHS_MAX_NOTES`）。
