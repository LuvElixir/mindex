# Phase 4：快代理接入 + 平台连接器扩容（合规红线移除后）

> executing-plans inline。用户明确授权：删除产品合规红线（业务风险由 owner 承担），接入快代理隧道穿透 IP 封锁。

**Goal:** Fetcher 支持按 host 走快代理；TapTap 借代理转真·可用；新增抖音/快手/微博三条 TikHub UGC 连接器；文档移除红线表述。

**工程底线（非合规，纯为省钱/防封）：** 保留 per-host 限速与快照缓存——隧道代理按量计费、猛抓会被目标与代理双端拉黑。

## 实测依据（2026-07-22，openframe-sg + 快代理隧道 x825.kdltps.com:15818）
- 代理出口=大陆 IP。TapTap 直连 405 → 代理 200 ✓；游戏陀螺/好游快爆/七麦代理 200 ✓
- gamelook/手游那点事：代理 517 隧道失败（目标端封快代理 IP 段，硬封）→ 本期不做
- 贴吧/NGA：代理 403（反爬需 cookie）→ 本期不做，列后续
- TikHub 抖音链路实测通：搜索 POST `/api/v1/douyin/search/fetch_video_search_v1` body`{keyword,cursor,sort_type:"0",publish_time:"0"}` → `data.data[].aweme_info.{aweme_id,desc,statistics.comment_count}`；评论 GET `/api/v1/douyin/app/v3/fetch_video_comments?aweme_id=&cursor=&count=` → `data.comments[].{text,digg_count}`
- 快手：搜索 GET `/api/v1/kuaishou/app/search_video_v2?keyword=&pcursor=`；评论 GET `/api/v1/kuaishou/app/fetch_video_comment?photo_id=&pcursor=`
- 微博：搜索 GET `/api/v1/weibo/web/fetch_search?keyword=&page=`；评论 GET `/api/v1/weibo/web/fetch_post_comments?post_id=&mid=`

## Tasks
- [x] 1. **config + 代理 Fetcher**：install undici；config.proxyUrl 读 `MINDEX_PROXY_URL`；Fetcher.fetch 增 `proxy?: boolean`，为真且配置存在时用 undici ProxyAgent 作 dispatcher（实例缓存）。测试：proxy 选项存在时不报错（无凭证优雅降级为直连）。
- [x] 2. **tikhub 加 POST**：`tikhubPost(pathname, body, timeout)`。
- [x] 3. **TapTap 走代理**：discover 的 fetch 加 `proxy:true`。（连接器已 verified，仅路由变化）
- [x] 4. **抖音连接器**（douyin.ts）：TikHub 搜索→取评论数高的前 N 视频→评论→player_opinion；视频 desc 作 community。needs_key 降级。
- [x] 5. **快手连接器**（kuaishou.ts）：同构。
- [x] 6. **微博连接器**（weibo.ts）：搜索取帖，帖子评论需 post_id+mid（实现时从搜索结果取）；官微/超话帖 desc + 评论。
- [x] 7. **注册 + 文档**：registry 注册三家；compliance.md/architecture.md/HANDOFF 移除「不做带登录态违 ToS 抓取」红线，改为「经授权：快代理穿透 IP 封锁，UGC 口碑经 TikHub」；.env 写 MINDEX_PROXY_URL（本地+服务器，不进 git）。
- [x] 8. **逐家 live 测 + 部署验证**：每连接器先本地/服务器真实跑通再入库；tar+scp 部署；线上对伊莫或新建项目验证。

## 后续（本期不做，honest defer）
- gamelook/手游那点事：需住宅代理或大陆自建节点（快代理 IP 段被目标封）
- 贴吧/NGA：反爬 403，需 cookie 注入或过验证；七麦/点点：签名反爬。价值有但脆，单开一期。
