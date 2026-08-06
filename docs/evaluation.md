# 评测方法

Mindex 的评测围绕一个问题：**知识库里的每句话是否真的有出处、置信度是否诚实**。分三层，前两层零 LLM 成本、可在 CI 每次跑。

## L0 — 结构性防线（写入时，不是评测而是不变量）

- `Store.insertEvidence` 强制引文必须能在快照原文中找到（宽容空白/标点宽度），否则抛 `GroundingError` 拒绝写入。伪造引用在结构上不可能入库。
- 抽取管线对 LLM 输出逐条做 grounding 预检，未通过的 claim 直接丢弃并计入运行事件（`N 条抽取因引文校验失败被丢弃`）。

单测覆盖：`test/grounding.test.ts`、`test/store.test.ts`。

## L1 — 全库确定性评测（`npm run eval`，CI 必须 100% 通过）

对整个活库做五项断言：

| # | 断言 | 含义 |
|---|---|---|
| E1 | 每条 claim_evidence 的引文可在其快照中复现 | 引用完整性（防快照损坏/迁移错位）|
| E2 | 可信结论（auto_accepted/approved）都有 ≥1 条支持证据 | unsupported claim 检测 |
| E3a | `insufficient` ⇒ confidence IS NULL | “不知道”与“低分”不可混淆 |
| E3b | verified 事实 ⇒ ≥2 个独立来源组（重算折叠）| 防单源/转载假验证 |
| E4 | uncertain/disputed/insufficient 不出现在 auto_accepted | 信任边界（低置信不静默进入可信库）|
| E5 | 未决冲突双方必须处于争议态 | 冲突不允许一边继续装可信 |

## L2 — 管线级集成测试（`npm test`，55 项）

在**离线录制的真实数据**（App Store CN 原神元数据 + 31 条 TapTap 真实评论，`server/fixtures/`）上跑完整启发式管线，断言：

- 官方事实抽取正确且证据可复现（E1 全库扫描内嵌为测试）
- 观点聚合产出代表性统计（n_holding ≤ n_discussing、Wilson 下界 ≤ prevalence、采样说明非空）
- 数值冲突 → 双方 disputed + quarantined + 进审核队列（P1）
- 版本演进 → supersession（旧结论关闭有效期、deprecated、指向新结论），而非误报冲突
- Context Pack：只含 verified/likely、每条 citation 可解析回真实 evidence、deprecated/disputed 不出现、观点带代表性字段、excluded 声明存在、token 预算被遵守
- API 层：无 Key 401、越权项目 403、scope 不足 403、撤销即失效、轮换宽限期语义、限流 429、调用日志落库、Key 列表不泄露 hash/明文、OpenAPI 隐藏管理平面

置信度引擎单测覆盖诚实性规则：无证据 ⇒ insufficient+NULL；mentions 不算证据；单源封顶 0.7 不可 verified；转载簇折叠后仍按单源处理；开放冲突强制 disputed；反驳证据降分；疑似营销降分；洞察封顶；小样本观点 Wilson 收缩（5/5 同意仍是 uncertain）；点赞数不是任何因子。

## L3 — LLM 抽检（设计就绪，按需运行）

有 LLM 时可运行支持性抽检：用与抽取**不同**的模型对 approved claim 抽样判定 evidence 是否蕴含 claim（entail/neutral/contradict），与库中 stance 对比得 attribution precision（目标 ≥0.95）。运行事件中的 `droppedUngrounded` 计数是抽取器幻觉率的持续信号。

## 校准回路

人工审核决定（`review_queue.decision` / revisions）持续落库。积累足够样本后，可用「verified 档被人工推翻率 < 5%」做回归门槛，并以人审标注重拟合置信度因子权重（scorer_version 字段已为此预留版本化）。
