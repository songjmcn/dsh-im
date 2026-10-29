# Issue 349 模型目录共享缓存优化方案

本次只实施第一步：在现有模型列表查询中加入按宿主共享的短期缓存和并发去重，保存机器人模型设置时继续实时校验。缓存放在 `HarnessClient.listModels()`，复用现有宿主连接、RPC、超时、取消、目录校验和生命周期。

日期：2026-10-12。状态：已实施，自动化检查和企业微信实测通过。源码基线：`0ac02c9`，包版本 `4.38.1`。需求来源：[Issue 349](https://github.com/xmanrui/dsh-im/issues/349)。

## 目标和范围

同一个本地 DSH 宿主的多个 IM 渠道查询模型清单时，共用一份结果。成功获取后缓存 30 秒；缓存失效或尚未加载时，同时到达的普通查询只触发一次宿主目录构建。

状态响应继续包含 `modelCatalog`，现有页面、模型选择器和连接巡检的调用方式保持兼容。模型配置在普通列表中的变化，允许等缓存到期后的下一次查询再体现；保存具体模型及思考强度时必须实时读取并校验。

本次优化覆盖通过本地 `apiProxy` 调用的 `listModels()`。显式配置 `harnessBaseUrl` 的 HTTP 连接沿用实时请求，避免引入远端连接身份和缓存隔离规则。会话模型查询 `getSessionModels()` 也沿用实时请求，保留当前选择、默认模型及可路由状态的现有语义。

状态与目录分离属于后续步骤。本次保留目录字段，也保留原有巡检频率；因此后台目录构建频率会降低，但不会归零。

## 已确认的调用链

普通状态查询和巡检的相关链路为：

```text
controller.status() / initialize()
  → decorateResult()
  → resolveModelCatalog()
  → 各渠道的 modelCatalog()
  → listModelCatalog(harness)
  → HarnessClient.listModels()
  → llm.models
  → ModernHarnessApi
  → session.modelCatalog
```

`modernHarnessApi()` 已经通过 `WeakMap` 按 `ctx.root` 复用实例。同一宿主的不同渠道和机器人客户端拿到同一个 `apiProxy` 对象，不同宿主的对象不同。可以直接用这个对象作为缓存标识。

`HarnessClient.rpc()` 已经提供 30 秒请求超时、调用取消、错误转换和诊断信息；同文件中的 `callWithSignal()` 可以让调用方停止等待。`validateModelCatalog()` 已经检查目录结构，`listModelCatalog()` 已经转发 `options` 并处理页面所需的降级结果。

把缓存放在 `listModels()`，可以直接复用上述机制，无需给宿主 API 增加字段，也无需把校验和取消逻辑搬到适配器中。

Issue 中约每秒一次构建是报告者的采样结果。单个 supervisor 的 15 秒巡检不能单独解释这个频率；验收时统计同一宿主全部渠道产生的调用，区分普通列表、会话查询和主动保存。

## 缓存规则

在 `src/channels/shared/harness-client.mjs` 中增加一个模块内 `WeakMap`，以 `apiProxy` 为键。每个条目只保存目录结果、失效时间、当前共享请求和一个用于宿主清理的 `AbortController`。

有效期使用内部常量 `30_000`，从成功响应并通过校验时开始计算。通过 `Date.now()` 按需判断过期，不增加后台刷新或清理定时器。

| 场景 | 行为 |
| --- | --- |
| 普通查询，缓存有效 | 返回缓存内容，不请求 `llm.models` |
| 普通查询，没有有效缓存，已有共享请求 | 等待该请求，不重复构建 |
| 普通查询，没有有效缓存，也没有共享请求 | 使用原来的 `rpc('llm.models', {}, 30_000, options)` 发起一次查询 |
| 查询成功且目录结构合法 | 保存结果并设置过期时间 |
| 查询抛错、超时或响应结构不合法 | 不缓存，清除当前共享请求；下一次查询可以重试 |
| 合法的空目录或包含 provider failures 的目录 | 保留原返回语义，可以缓存 30 秒；`failures` 不被抹掉 |
| 缓存过期 | 下次查询等待一次新读取，不返回过期结果 |

共享请求完成时，只有它仍是当前条目的 `pending`，且条目仍属于当前 `apiProxy`，才允许回填缓存或清除 `pending`。用对象和 Promise 身份判断即可，避免已失效的慢请求覆盖新结果，不引入版本计数器。

缓存保存经过现有校验的模型目录；给各调用方返回独立的数据副本，可使用一次 `structuredClone()`，避免一个调用方修改列表后污染其他渠道。复制对象只包含模型目录，不读取或复制宿主全量设置。

`ensureRunning(options)` 继续走原有逻辑。缓存减少的是 `llm.models` 和宿主目录构建次数，不改变宿主可用性检查。

## 保存时保持实时校验

给已有的 `listModels(options)` 增加一个内部选项 `fresh: true`，表示这次按原路径实时读取。

```text
updateModel(botId, model)
  → resolveModelCatalog(modelCatalog, { fresh: true })
  → modelCatalog({ fresh: true })
  → listModelCatalog(harness, { fresh: true })
  → harness.listModels({ fresh: true })
  → 原有 RPC 和目录校验
```

`fresh` 只在本地客户端消费，不写入 `llm.models` 的 RPC payload，也不传给 DSH。HTTP 请求仍然发送原来的空 payload。

具体修改：

1. `resolveModelCatalog(catalog, options)` 在目录来源是函数时转发 `options`；静态目录对象保持原来的处理方式。
2. `updateModel()` 为具体模型和思考强度校验传入 `{ fresh: true }`，继续复用原有可用性检查和 `workspaces.setModel()`。
3. 各 production 文件的目录回调从 `() => listModelCatalog(harness)` 改为 `(options) => listModelCatalog(harness, options)`。现有 `listModelCatalog()` 本身已经支持这一参数，不需要增加另一套获取函数。
4. 保存响应复用刚读取的目录，沿用现有 `catalog ?? modelCatalog` 处理，不再额外读取一次。

强制读取跳过已完成缓存，也不加入早于本次保存启动的后台共享请求。它沿用原 RPC 的调用方取消和超时。读取结束时，无论成功或失败，都使普通缓存和当前 `pending` 失效，防止旧后台结果之后重新回填。

为控制实现复杂度，强制读取的结果只用于本次校验和响应，不回填共享缓存。下一次普通查询允许重新构建一次。这样无需协调“后台查询与多次保存谁的结果更新”，代价是主动保存附近可能多一次目录读取。已有普通调用方可以收到其正在等待的结果，但这些旧请求不能再更新缓存。

清除指定模型、恢复默认时，继续沿用现有的无具体模型校验逻辑。目录查询失败仍走已有错误和降级路径，保存不能因为缓存里仍有旧模型就成功。

## 取消和生命周期

普通查询的共享 RPC 使用缓存条目的独立 signal，保留原有 30 秒超时。每个调用方通过已有 `callWithSignal()` 等待共享 Promise：有调用方 signal 时使用它，没有时使用条目的 signal。进入缓存分支前检查调用方是否已经取消。

这样，一个页面关闭或一个机器人任务取消，只停止自己的等待，不会取消其他调用方正在使用的查询。所有调用方都取消时，已经发出的只读请求可以完成并填充缓存，也会受到原 RPC 超时限制；本次无需增加等待者计数。

在 `harness-client.mjs` 导出一个窄用途的缓存清理函数，由 `ModernHarnessApi.dispose()` 调用：中止该条目关联的共享请求，清空缓存并移除 WeakMap 条目。已经失效但尚未完成的共享请求仍使用同一条目的 signal，所以也能被统一中止；完成后的旧请求无法重新填充缓存。

单个渠道断开连接不清理整个宿主的缓存。宿主适配器销毁后，新适配器对象自然对应新缓存。普通 provider 配置变化由短 TTL 处理，主动保存用 `fresh` 保证实时读取。

## 改动文件

| 文件 | 修改内容 |
| --- | --- |
| `src/channels/shared/harness-client.mjs` | 共享缓存、普通请求去重、`fresh` 分支和宿主缓存清理；复用文件内的 RPC、取消和目录校验函数 |
| `plugin-src/host/modern-harness-api.mjs` | 在现有 `dispose()` 中调用缓存清理函数 |
| `src/channels/shared/bot-workspace-store.mjs` | 目录来源转发 options，保存具体模型时请求最新目录 |
| `plugin-src/host/channels/{shared,feishu,weixin,dingtalk,wecom,wecom-app,qq,slack,whatsapp,matrix}/production.mjs` | 10 处目录回调透传 options；共享生产工厂覆盖其余相关渠道 |

核心逻辑集中在前 3 个文件，其余是同一种参数透传。沿用已有 `listModelCatalog()`、状态包装和前端消费逻辑。

保持实现为局部优化：固定 TTL、一个 WeakMap、一条现有实时读取路径。无需新增缓存服务、LRU、持久化字段、用户设置、provider revision 查询或第三方依赖；不读取 `settings.describe()` 判断缓存是否过期。

## 自动化验证

使用现有 `node:test`、fake gateway、`fakeContext()` 和模拟时间。在已有测试文件中补充行为测试，不搭建新测试框架。

| 验证项 | 关键断言 |
| --- | --- |
| 同一宿主的多个客户端 | 同一 TTL 内只调用一次 `session.modelCatalog`，不同宿主分别查询 |
| 并发请求 | 阻塞第一次目录响应后发起多个普通查询，仍只有一个宿主构建请求 |
| TTL | 到期前复用；从成功返回开始计时；到期后多个查询合并为一次；无人查询时不自动刷新 |
| 强制读取 | 已有缓存或后台请求时，`fresh` 仍发起新的实时请求；结束后旧请求不能回填 |
| 保存正确性 | 先缓存旧目录，再移除模型或思考强度；保存被拒绝，已有机器人配置不变；新增模型可立即保存 |
| 错误恢复 | 抛错、超时和不合法目录不成为缓存命中；下一次正常查询可以成功 |
| 取消隔离 | 一个调用方取消后，另一个仍能收到共享结果；预先取消的调用不启动目录请求 |
| 生命周期 | dispose 中止共享读取、清空条目，迟到响应不能回填；新宿主适配器重新查询 |
| 返回值隔离 | 修改一次返回的目录，不影响其他调用方或下一次缓存命中 |
| 兼容性 | 状态仍包含原目录字段；模型保存收到 `fresh`；HTTP payload、会话模型查询和当前选择保持原行为 |

优先扩展以下现有测试：

- `test/host-modern-harness-api.test.mjs`：通过真实 `HarnessClient` 和模拟 gateway 验证共享次数、TTL、并发、失败、取消及生命周期。
- `test/model-setting.test.mjs`：验证 `fresh` 透传、目录变化后的保存校验和原状态返回格式。
- `test/host-harness-connection.test.mjs`：利用已有各渠道装配 fixture 检查 production 回调的参数透传。
- `test/channels/shared/harness-control.test.mjs`：保留 HTTP 模型查询、会话模型查询及工作区作用域校验的回归覆盖。

受控负载验收：模拟时间下，同一宿主的两个客户端分别每秒发起一次普通列表查询，持续 60 秒，共 120 次调用。目录请求立即成功且没有主动保存，期望构建 2 次，而非 120 次。只统计 `session.modelCatalog`，避免将正常健康检查混入目录计数。

先运行以上定向测试；完成实现后运行仓库既有 `npm run check` 和 `git diff --check`。CPU 降幅需要在实际插件组合中测量，目录调用次数的改善不能直接换算为 CPU 降幅。

## 实施顺序与完成标准

1. 在现有测试中补充共享请求、过期重查和目录变化后保存的关键用例。
2. 完成 `listModels()` 缓存、独立等待和清理逻辑，保持原 RPC 实现。
3. 接通 `fresh` 参数和各 production 回调透传。
4. 补齐失败、取消、生命周期和兼容性验证，运行定向测试及仓库检查。

完成标准是：普通本地列表查询在 30 秒内跨渠道复用一次成功结果；并发读取合并；保存具体模型实时校验；失败和取消不污染缓存；状态页面及现有 HTTP、会话行为兼容。第一步到此结束。

## 实施与验收记录

2026-10-12 完成上述 3 个核心文件和 10 处 production 回调修改，并重新生成 `lib/index.js`。没有增加依赖、配置开关或持久化字段。普通列表共享缓存；保存具体模型和思考强度使用 `fresh: true`；宿主适配器销毁时清理缓存和共享读取。

自动化结果：

- 同一宿主两个客户端在模拟的 60 秒内读取 120 次，实际触发 `session.modelCatalog` 2 次；8 个并发请求合并为 1 次。这个结果是受控调用次数验证，不代表实际 CPU 降幅。
- 已覆盖 TTL 从成功返回开始计算、不同宿主隔离、返回对象独立、强制读取与旧请求竞争、失败和超时恢复、单独取消与全部调用方取消、宿主销毁和重建。
- 已覆盖缓存后移除模型或思考强度时拒绝保存、新增模型可立即保存、保存响应复用最新目录，以及 13 个渠道装配入口的 `fresh` 透传。既有 HTTP 与会话模型查询回归用例通过。
- 最终全量检查：构建成功，4048 项测试全部通过，0 失败、0 跳过，发布包校验通过。运行命令为 `npm run build && node --test --test-concurrency=4 test/*.test.mjs test/channels/*/*.test.mjs && node scripts/verify-package.mjs`，包含原 `npm run check` 的全部检查，仅限制测试文件并发数。
- 首次默认并发检查出现 3 项时限相关失败（飞书 2 项、Slack 1 项）；当时机器负载较高，相关文件随后单独复跑 27 项全部通过，降低并发后的全量检查也全部通过。没有修改这些测试或放宽其断言。

企业微信实测：

- 用户停止其他 DSH 任务后，重启桌面宿主。新 Host 进程 PID 为 `82415`，启动时间为 `2026-10-12 18:40:51 +08:00`；desktop profile 的 `@xmanrui/dsh-im` 本地链接指向本仓库，新进程加载重新构建的插件。
- 在机器人“今天是梁子”会话发送 `/status`，收到“企业微信机器人与 DeepSeek Harness 连接正常。”。
- 发送 `/models`，成功返回 15 个模型，当前模型为 `deepseek-official/deepseek-flash`。这是已有会话的模型查询，用于验证实时查询兼容性；缓存合并效果由上面的自动化测试验证。
- 发送带唯一标记的计算题 `46+39`，企业微信实际收到 `ISSUE349_WECOM_A7F3=85`。对应 DSH 会话第 7 轮正常完成，没有调用工具，回复与企业微信收到的内容一致。

本地验收证据位于 `output/issue-349-fixed-20261012/`：`live-wecom.json` 保存本轮会话结果、界面观察和构建哈希，`validation.json` 保存全量检查与调用次数结果；`check.log`、`network-recheck.log` 保留首次失败及相关文件复跑记录。原始日志和会话证据仅保留在本地，本次不涉及版本发布。

## 飞书与 Telegram 补充实测

2026-10-13 00:24–00:25（Asia/Taipei），按用户要求通过本机客户端测试飞书“今天是牢梁”和 Telegram“今天是梁子”。Host 仍为此前重启后的 PID `82415`，本地插件链接和构建 SHA-256 均与企业微信验收时一致，无需再次重启。

| 验证项 | 飞书“今天是牢梁” | Telegram“今天是梁子” |
| --- | --- | --- |
| `/status` | 返回“连接正常”及工作区、预设 | 返回机器人与 DeepSeek Harness 连接正常 |
| `/models` | 返回 15 个模型，当前为 `deepseek-official/deepseek-flash` | 返回同样的 15 个模型和当前模型 |
| 实际对话 | `57+28`，客户端收到 `ISSUE349-FEISHU-C82D=85`，卡片显示已完成 | `68+27`，客户端收到 `ISSUE349-TELEGRAM-D91A=95` |
| 本机记录复核 | 对应会话第 13 轮正常完成，0 次工具调用，回复完全一致 | 对应会话第 8 轮正常完成，0 次工具调用，回复完全一致 |

两条链路均通过，没有出现需要修复的产品问题，本轮未修改业务代码。已有会话的 `/models` 验证实时查询兼容性，缓存合并次数仍以上述受控测试为依据。证据保存于 `output/issue-349-cross-channel-20261013/live-feishu-telegram.json`，包含机器人标识、会话结果、客户端观察和构建哈希。
