# Matrix/飞书 公共会话语义层计划（v2，Store 缓行）

范围决定（相对 v1 的两处改道）：

1. **合并语义，不合并 transport/presentation**——按 `CONTEXT.md` 的自我定义（语义消息 L7 / 会话路由 L23 / 渠道原生动作 L82 / 标杆渠道 L98 / 等价接管 L114）把 Matrix 接入公共 Conversation 语义层；飞书已验证的 Topic/Reply/Root/Session 语义**上提复用**而非复制。
2. **本轮不做 Store**——不建 SQLite/事件表，不建持久检索。持久事件层（Event Store、edit/redaction 有效视图、语义检索、Warm 摘要）全部进 Deferred，接口留缝。

本计划以 `.pr-scratch/dsh-im` 现状代码为基线，行号均为实况引用：

- 概念契约 `CONTEXT.md`（L7/L23/L82/L98/L114）
- 飞书参考实现 `src/channels/feishu/bridge.mjs`：会话键 842-855（`` `group:${chatId}:thread:${threadId}` ``）、`topicRootFor` 847、`#rememberTopicRoot/#forgetTopicRoot` 895-909、`#registerTopicThreadId` 927-933、**首文去重锚** `#topicAnchors` 4919-4942、`reply-reference` 导入 20（`<dsh_im_reply_to>` 载体在 `src/channels/shared/semantic/reply-reference.mjs`）
- 首文去重行为规格 `CHANGELOG.md` 4.24.1（2026-09-22）："话题首文在同一 AI 会话成功使用后不再重复注入；命令、拒绝消息及读取或请求失败不提前消耗首文；`/new`、会话切换或失效重建后重新附带"
- Matrix 现状 `src/channels/matrix/`：normalize 296-298（`$$` 线程键，回复分叉根因）、mention gate 287、群聊背景拼接 runtime 635-646/696-719、环库 `matrix-room-history.mjs`（cap 20/2000/50000，`append/consumePending/search`）、`matrix-api.mjs`（CS API v3 前缀 L9，**无**按 id 单取 `getEvent`）
- 共享桥 `src/channels/shared/text-harness-bridge.mjs`（key=319、askInWorkspaceSession 820-879）与 `workspace-session.mjs`（120-127）
- Harness 事实（deepseek-harness 已核实）：`inject()=send(msg,'next-step',false)` 不唤醒；inject 可错过 pre-step 已认领 batch（`runtime-types.ts` JSDoc）；`user/message` 三类来源靠 `source` 区分、content verbatim（`session/types.ts:290-297`）；framing 归生产方、投影层禁加包装（`session/surface.ts:129-136`）

## 核心原则（定稿）

```text
                     原始事件
                        │
          ┌─────────────┴─────────────┐
     飞书适配器                   Matrix适配器
   （传输/归一化/原生呈现/E2EE） （传输/归一化/原生呈现/olm）
          └─────────────┬─────────────┘
                        ▼
             语义消息（shared/conversation）
                        ▼
               会话路由 → 会话绑定（键不变迁）
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
   显式上下文         根上下文          环境上下文
  reply/thread      root 一次        环库 burst/recent
        └───────────────┼───────────────┘
                        ▼
          上下文构建器 → 暂存 + followup + pre-step 同批
                        ▼
                    Harness Session
```

> **关系能确定的 → 直接走关系；关系不能确定的 → 才去环库找（Ambient）。**
> 显式半边复用飞书已验证逻辑；Ambient 半边是本轮真正新增，且落在既有 JSON 环库上，不新建数据库。

## 目录（跟随仓库现状：shared 层内落位，ESM `.mjs` + JSDoc typedef，非 TS）

```text
src/channels/shared/conversation/
├── semantic-message.mjs      语义消息构造 + 校验（JSDoc typedef）
├── route.mjs                 会话路由：encodeConversationRouteKey（唯一生成口，键值兼容现状）
├── trigger-policy.mjs        shouldTrigger(message, policy) 规则表化
├── session-binding.mjs       对 askInWorkspaceSession 的通道无关包装（键→会话语义不变）
├── reply-context.mjs         resolveReplyChain(route, startRef, deps{fetch,depth,loopguard})
├── root-context.mjs          RootContextRegistry（一次消费语义，飞书 4.24.1 规格上提）
├── ambient/
│   ├─ provider.mjs           AmbientProvider 接口 + 查询参数
│   └─ room-history-provider.mjs  v1 实现：包 MatrixRoomHistoryStore（burst/recent）
└── context-builder.mjs       有序装配 → 上下文条目数组（每条目带 collector/score）
src/channels/matrix/           （瘦身为：传输 + 归一化 + 原生呈现 + crypto + E2EE）
src/channels/feishu/           （P5 等价接管迁移，能力位逐项，携回退钩）
```

## 数据模型（JSDoc typedef 定型；.mjs 不引 TS）

```js
/**
 * @typedef {Object} SemanticMessage
 * @property id                 渠道事件 id（matrix event_id / 飞书 message_id）
 * @property channel            'matrix' | 'feishu' | …
 * @property botId
 * @property chatId             matrix room_id / 飞书 chat_id
 * @property {string|undefined} threadId   matrix thread root event_id / 飞书 thread_id
 * @property sender             { id, name? }
 * @property timestamp
 * @property content            模型可见正文（verbatim 约定，framing 生产方自制）
 * @property {MessageRef|undefined} replyTo
 * @property trigger            { mentionedBot, repliedToBot, commandLike }
 */

/**
 * @typedef {Object} ConversationRoute
 * @property channel @property botId @property chatId
 * @property {string|undefined} threadId
 * @property {'dm'|'group'|'thread'} scope
 */
```

**键纪律**：`encodeConversationRouteKey(route)` 是 `state.sessions` 键值的唯一生成口。键值按渠道保持现状编码不迁移（matrix `group:room:<roomId>[<$$root>]`、`direct:dm:<user>`；飞书 `group:<chatId>[:thread:<threadId>]`），收敛的是**生成路径**（消灭 normalize:296-298 与 feishu bridge:842-855 两处手写），golden 测试钉死既有键值零漂移。

## 能力位清单（对齐用户方案表，附证据与归属）

| 飞书已有能力 | Matrix 对偶 | 归属 | 证据 |
|---|---|---|---|
| `chat_id` 会话 | `room_id` | 公共层 | feishu 842-855 |
| `thread_id` Topic | thread root event | 公共层 | feishu 845；matrix normalize 222-229 |
| Topic 会话隔离（context/batch/pending/reply） | Thread 会话隔离 | 公共层 | TextHarnessBridge 319 键族 |
| 首文注入 + 一次去重 | Thread root 注入一次 | 公共层（上提） | 4919-4942 + CHANGELOG 4.24.1 |
| 引用消息 `<dsh_im_reply_to>` | `m.in_reply_to` | 公共层（已有） | shared/semantic/reply-reference.mjs |
| 会话绑定 | 同 | 公共层 | workspace-session 120-127 |
| Context Enhancement | 同 | 公共层 | text-harness-bridge 787 |
| 卡片 | Matrix HTML/edit | 各渠道原生呈现 | feishu-cards / matrix-rich-text |
| WS 长连 | `/sync` | 各渠道传输 | feishu-runtime / matrix-runtime |
| OpenAPI | CS API | 各渠道传输 | feishu-app / matrix-api |
| Topic 创建（服务端实体） | thread relation（桥侧自决） | 各渠道 | feishu 927-933 vs normalize 222-229 |
| 权限体系 | power levels/allowlist | 各渠道 | group-message-permission-manager vs accessPolicies |
| — | E2EE（olm） | Matrix 独立 | matrix-crypto* |

## 阶段

### P0 · 公共层骨架 + 路由/绑定（修复"回复开新会话"）

- 建 `shared/conversation/` 骨架：semantic-message、route（键收敛 + golden）、trigger-policy、session-binding 薄包装。
- Matrix 接入：normalize 只留识别；触发/路由走公共层。**回复分叉修复**——带 `m.in_reply_to` 的事件先查 `bot_event_bindings`（P4 建表，此处留位）与目标所属会话，仅"入站即开新 thread 的根事件"分叉；`threads.mode: inherit|isolate|auto`（默认 inherit）。
- 验收：两截图场景复现（主时间线回复/​@ → 原会话延续）；键 golden 零漂移；`node --test test/channels/shared/conversation/*.test.mjs`。

### P1 · Trigger 规则表化（Matrix 侧先行）

- `shouldTrigger` 规则表：DM/@Bot/回复Bot/线程内回复/`!cmd` → true；普通群聊、回复人类、edit、reaction、redaction → false（只记事实）。normalize 287/270 与 runtime 624-646 的散落门策迁入。
- 飞书侧 P5 再迁，避免同步动大件单。

### P2 · Root 上下文一次消费（飞书语义上提）

- `RootContextRegistry`：`observeRoot` → `anchor({routeKey, sessionId, rootId})` → `shouldInject`；消费规则逐字对齐 CHANGELOG 4.24.1——**成功 turn 后**才置记；命令、拒绝消息、读取/请求失败**不消耗**；`/new`、会话切换、失效重建重置。
- 参考实现直接对照 feishu `#topicAnchors`（4919-4942）提取；持久化走 `state.json` 小键值表 `rootAnchors`（键值状态，非 Store）。
- Matrix 钩子：thread 根事件由 `threadIdOf`（222-229）提供；`resolveConversationRoot(route)` 由渠道喂给"该线程/话题的 root 消息是谁"，其余全公共。
- 验收：三连回归——首文注入一次；命令/拒绝/失败不消耗；/new 后重现附带。飞书侧行为不回（回归其既有测试）。

### P3 · Reply 上下文（无 Store 的取物方式）

- `resolveReplyChain(route, startRef, { fetch, depth=5, visited })`；fetch 由渠道注入：
  - Matrix：**`matrix-api.mjs` 新增 `getEvent(roomId, eventId)`**（`GET /rooms/{id}/event/{id}`，复用 CS API 前缀 L9 与 429 同款 retry/限流骨架）+ 进程内 LRU（≤256 条，非持久）；
  - 飞书：既有 OpenAPI 单取。
- 折叠产物统一走 `shared/semantic/reply-reference.mjs` 的 `<dsh_im_reply_to>` 框（framing 生产方自制，符合 surface 禁令）。
- 无 Store 的边界：目标已被 redact/编辑则取当下文本；跨小时重启靠 getEvent 重现（LRU 丢失可接受）。

### P4 · Ambient 最小实现 + 装配 + pre-step 同批 + 绑定闭环

- `AmbientProvider` 接口（`record/query({route, sameSender, sinceTs, withinMs, limit})`）；v1 实现包 `MatrixRoomHistoryStore` 既有环库：burst（同 sender、gap < `burstGapMs` 缺省 90s）+ recent（`recentWindowMs` 3min ∪ `recentCount` 20）。**不建 DB、不做语义检索**。飞书 v1 关（权限面差异），接口留位。
- `context-builder`：装配序 root → reply → thread → burst → recent；硬过滤（bot 自身、notice、已消费 root、环内自声回声行剔除——保留 runtime 707-711 语义）；产出条目 `{collector, score, content}`。
- 装配序废弃文本框 `【群聊背景】`（runtime 642-644）。
- Harness 注入（沿用 v1 结论）：`stage(triggerKey, entries)` → **`followup` 唯一唤醒** → `agent/pre-step` 同批认领；每条目独立 UserMessage，`source={kind:'plugin', plugin:'dsh-im/conversation:<collector>'}`；无 pre-step 能力则逐条独立消息批入（不复活大块文本）；再降级旧路径 flag。
- 响应端：发送后写 `bot_event_bindings`（`state.json` 键值表：matrix_event_id → {session, route, turn}）；入站回复命中绑定直达；被 redact → 置 inactive。
- 验收：golden——「Qwen FP8/下午吃什么/天气挺好」只取 ancestor 链、「中秋/国庆五连 burst → @bot 你说我想问什么」取全组；快照断言首请求 messages = N 条 `[matrix-context …]` + 1 提问，无群聊背景文本框。

### P5 · 飞书等价接管（Parity Cutover，按 CONTEXT.md L98/L114）

- Matrix 为 Reference Channel 验证过后，飞书能力位逐项迁移公共层（trigger/root/reply/ambient 关），每项带回归测试与 flag 回退；卡片/传输/权限原地不动。

## Deferred（本轮不做，缝已留）

| 项 | 缓行理由 | 接口缝 |
|---|---|---|
| Event Store（node:sqlite）、全量入库 | 关系可走 API 单取 + 环库够用 | `AmbientProvider`、reply `fetch` 注入点、`getEvent` 签名 |
| edit/redaction 有效视图 | 编辑罕见，取当下文本可容 | `effective(eventId)` 留名于 provider 扩展 |
| 语义检索（embedding） | 非首版价值线 | `retrieval` collector 槽位空 |
| Warm 滚动摘要 | 依赖 Store | context-builder 尾槽 |
| 飞书 ambient | 权限面未开 | provider 通道注册位 |

**无 Store 的代价直书**：环境上下文深度受环库 cap（20/2000/50000）与进程生命周期限；重启后 LRU 清空靠 getEvent 重现；edit 不折叠、redact 不屏蔽（目标取当下文本）。若后代价越界（群聊复盘、跨日检索成需求），按缝插 P5 后再上 Event Store，调用点零改动。

## 配置（缺省＝现状行为，逐旗灰度）

```text
trigger.policy            规则表覆写（缺省如上）
triggerOnReply            any|bot-only|never（matrix 缺省 never：群聊仅 @ 或命令开口，未 @ 回复只记事实）
threads.mode              inherit|isolate|auto（matrix 缺省 inherit）
rootContext.once.enabled  缺省 false 灰度（行为修正类可先行开）
replyContext.enabled / maxDepth / lruSize
ambient.enabled / burstGapMs / recentWindowMs / recentCount / maxContextChars
preStepContext.enabled
```

## 测试（node --test 随仓库）

- `test/channels/shared/conversation/`：route 键 golden（两渠道既有键值零漂移）、trigger 规则表全列、root 一次消费三连（成功/不消耗/重置）、reply 链（fetch 注/mock，loopguard、depth、redacted 目标）、ambient burst/recent（环库 fixture 手搭）、builder 装配序与硬过滤。
- `test/channels/matrix/`：getEvent（retry/429/404）、回复分叉修复两场景、pre-step 同批快照。
- 飞书侧回归集全测护既有 suites（P5 每项带迁移时同步进行）。

## PR 切分与人日（粗估）

| PR | 内容 | 人日 |
|----|------|------|
| 1 | P0（骨架+route 收敛+键 golden+threads.mode 修复回复分叉） | 3 |
| 2 | P1+P2（trigger 表化 + root 一次消费上提） | 3 |
| 3 | P3（getEvent + reply 链） | 1.5 |
| 4 | P4（ambient 最小 + builder + pre-step 同批 + 绑定闭环） | 3.5 |
| — | P5 飞书迁移（另计） | 后续 |

> 定稿：**把飞书已验证的 Topic/Reply/Root/Session 语义上提公共层、Matrix 接入之；本轮新增唯 Ambient Context（落既有环库）；Store 缓行，缝留接口，代价不匍。**

## 实施状态（P0–P4 本轮交付）

- 公共层落地 `src/channels/shared/conversation/` 七模块：`route.mjs`（键唯一生成口，matrix dm/group/thread 与飞书 group 系模板 golden 锁死；飞书 dm 键在 P5 前仍走渠道自身生成口，codec 对越界组合直接抛错）、`semantic-message.mjs`（duck-type 契约 + 工厂）、`trigger-policy.mjs`（规则表：`any|bot-only|never` 三态回复门）、`root-context.mjs`（一次消费登记，锚点走 `ConversationStateStore` 扩展键 `rootAnchors` 持久化，无扩展状态回退进程内表）、`reply-context.mjs`（链走 + 深度/环路护栏 + LRU）、`ambient-provider.mjs`（burst 连续段 + recent 窗口，消费判与 `pending` 同源：以 `pending` 集合为未消费权威做交集）、`context-builder.mjs`（按共享注入协议 `<dsh_im_context>` 块产出，条目按 event 去重合并多角色，值内 `<>&` 转义防伪）。
- Matrix 接线：normalize 门策改由 `evaluateTrigger`，键改由 route codec（`matrixConversationKeyFromTarget` 同源化）；`threadsMode` 缺省 `inherit`（回复开新会话修复默认生效），`isolate` 保留旧分叉，`auto` 以绑定表路由回复目标所属会话；`matrix-api` 新增 `getEvent`（404/网络失败折 null，不抛），runtime `#fetchContextEvent` 附 E2EE 解密与 256 条 LRU；room-history 新增 `markInjected`。
- Bridge 缝：`TextHarnessBridge` 新增可选 `contextHooks`（`enabled/collect/render/onConsumed/onSessionCleared/onDelivered` 全可选）。采集发生于命令处理之后、纯文本触发消息（非图片/文件/batch）时；`onConsumed` 仅在 ask 成功后落环库消费与 root 锚点；`onDelivered` 以回执 providerMessageIds 记 `bot_event_bindings`（进程内 5000 条 LRU，持久化缓行）；`/new` 复位该会话 root 锚点。绑定表与 `/new` 复位在 `triggerOnReply:'bot-only'` 或 `threadsMode:'auto'` 时即接线，与三个采集开关解耦。回复采集与根采集受进程内 once 注入台账约束（同一会话内已注入的事件不再注入，`/new` 清该路台账，重启后首轮至多重现一条近期条目）；`m.in_reply_to.is_falling_back` 回退关系按规范视作线程成员声明，不入回复目标、链走与触发分类，仅供 `inherit` 分叉策略作“线程由回复开起”的证据。
- 配置实际键名（matrix-config-store fail-closed sanitiser 已注册，未知/非法即整条拒绝）：`threadsMode`、`triggerOnReply`、`rootContextOnceEnabled`、`replyContextEnabled`、`ambientContextEnabled`、`contextMaxChars`、`replyMaxDepth`、`ambientBurstGapMs`、`ambientRecentWindowMs`、`ambientRecentCount`；`triggerOnReply` 缺省 `never`（用户裁定的产品缺省：群聊消息列/thread 只有 @ 或命令才开口，未 @ 的回复只记为事实；`any`＝4.25 旧形态、`bot-only` 依赖绑定表显式选启），三上下文开关缺省全关＝现状行为。
- **pre-step 同批多消息（P4 原案）经既有共享注入协议交付，不再以单 prompt 拼接为终态**：context-builder 以共享注入协议标签语法（`context-enhancement.mjs` 的 `INJECTED_CONTEXT_TAGS` 增 `contextOpen/contextClose`）产出 `<dsh_im_context>` 块前缀；Host `installInjectedContext` 的 `agent/pre-step` 监听（`plugin-src/host/injected-context.mjs`）经 `rewriteInjectedContextMessages` 把每块拆回独立 `source={kind:'plugin',plugin:'dsh-im',form:'notice',summary:'上下文 · <collector>'}` 的 user 角色上下文消息，真人直接消息体保持原样，按消息身份配对不受 inbox 交错影响。非协议形态的 JSON 体外来文本按白名单判定留在用户消息中原样不动（与 source/reply 块同一信任模型）。仅当 Host 无 Agent 循环、pre-step 未派发时，块才内联随行（与 source/reply 块同一回退）。同 event 多角色条目在装配端去重合并为一块（如 `thread-root+reply`）。
- 测试：新增 `test/channels/shared/conversation-context.test.mjs`（10 用例）与 `test/channels/matrix/matrix-context-engine.test.mjs`（7 场景，含缺省仅提及门、线程成员回退与 once 注入台账），config-store 补 1 往返/ fail-closed 用例（含 `any` 显式往返与 `never` 缺省省略），injected-context 补 2 上下文块分片用例（含外来/畸形 JSON 体不认领、无 Host 标签回退），matrix-normalize 触发用例改钉显式 `any` 并补回退关系单元（成员不作回复、inherit 仍取该证据、真回复保留）；matrix+shared 全量除 i18n 词典基线项外全绿。全仓 3322 用例之 10 失败经与干净 HEAD worktree 对账全部为基线既有/环境项（飞书会话卡片 6、i18n CRLF 词典 1、image-input 权限时序 1、update-service 抖动 1–2），本次改动零回归。
- 已知边界：ambient 条目取 ts 序自排序（环库入站序在回放批时可乱）；`bot_event_bindings` 重启即失、由后续回合自愈；thread 级精确 ambient 查询待 Store 的 thread 轴（Deferred 表内）。
