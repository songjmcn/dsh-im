# 群消息记录与群文件使用指南

[English](group-history.en.md) · [返回 README](../README.md)

DSH-IM 可以自动保存实际收到的群消息及附件，之后在群内 @ 机器人，即可查询聊天记录、总结讨论或读取文件。目前覆盖 **WhatsApp、飞书、Telegram、Discord、Slack、QQ**。

采集默认开启，无需先 @ 机器人，也没有逐群开关。保存消息本身不调用模型、不创建 AI 会话；机器人仍按原有的提及、回复方式和访问设置决定是否回答。

## 快速开始

1. 使用包含群记录功能的 DSH-IM，将机器人连接到 DSH，并加入目标群或频道。
2. 按下方对应渠道的说明，开通接收未 @ 消息所需的权限或设置。
3. 保持 DSH 和机器人在线，在群内正常聊天或发送附件，插件会自动保存收到的内容。
4. 在同一个群内 @ 机器人提问，例如：

   ```text
   @机器人 总结本群今天的讨论，列出结论和待办。
   @机器人 查一下最近 7 天提到“预算”的聊天记录。
   @机器人 列出本群昨天收到的文件。
   @机器人 读取昨天的“会议纪要.txt”，告诉我确定的交付日期。
   ```

不需要输入专门的历史记录命令。模型按需查询本地群记录，读取文件时获取会话副本。直接在 Web/CLI 或机器人私聊中询问某个群，不会获得该群记录的读取权限。

## 六个渠道需要哪些设置

| 渠道 | 接收未 @ 消息需要什么 | 群文件要求 |
| --- | --- | --- |
| WhatsApp | 手机扫码关联设备，登录账号在群内，连接有效；无需额外 OAuth 权限 | 消息中有可下载的图片或文件 |
| 飞书 | 机器人入群；订阅 `im.message.receive_v1`；开通 `im:message.group_msg` | 下载消息附件需要 `im:message:readonly` |
| Telegram | Bot 入群；关闭 Privacy Mode 后重新入群，或将 Bot 设为群管理员 | 通过 Bot API 下载消息附件，云端 API 下载上限为 20 MB |
| Discord | 机器人可访问频道；启用并按平台要求获批 **Message Content Intent** | 附件也依赖内容权限和有效下载地址 |
| Slack | Bot 加入频道；订阅 `message.channels` / `message.groups`，具有对应历史权限 | Bot Token 具有 `files:read`，且能访问文件 |
| QQ | 应用具备未 @ 群消息能力，群主已按 QQ 提示授权查看群内全部对话；需确认实际投递 | 实际消息事件中携带可下载附件 |

### WhatsApp

1. 在 DSH 的「IM机器人 → WhatsApp」扫码关联手机 WhatsApp。
2. 确认关联的 WhatsApp 账号已经加入目标群，并保持连接正常。
3. 让群内成员发送普通消息，再 @ 该账号查询记录。

本项目使用 Baileys 关联设备接入。群记录采集不需要把响应模式改成开放模式；查询仍需满足该机器人的访问设置。WhatsApp 默认仅响应账号自聊，若要让其他群成员查询，应在访问设置中允许对应成员。仅关联设备不会导入手机上已有的全部聊天记录；阅后即焚媒体不归档。

### 飞书

**扫码新建机器人**：使用插件的扫码新增流程，默认申请 `im:message.group_msg` 和 `im:message:readonly`。完成飞书要求的发布、审批后，把机器人加入目标群。

**已有或手动绑定的机器人**：

1. 在「IM机器人 → 飞书」找到机器人，点击「补全权限」；也可私聊机器人发送 `/repair`。
2. 扫码补充缺少的权限，完成飞书提示的发布、审批，等待机器人重连。
3. 确认机器人在目标群中，再发送新的普通消息测试。

如果自行维护飞书应用，应在开发者后台确认以下配置：

| 配置 | 用途 |
| --- | --- |
| 机器人能力、长连接接收事件 | 让应用机器人接收群事件 |
| `im.message.receive_v1` 事件 | 接收消息 |
| 租户权限 `im:message.group_msg` | 接收未 @ 当前机器人的群消息 |
| 租户权限 `im:message:readonly` | 下载用户消息中的图片和文件 |

`im:resource` 用于机器人上传图片或文件，不能代替下载用户消息附件所需的消息读取权限。仅有 @ 消息权限，也不能接收普通群消息。平台依据见[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)及[获取消息中的资源文件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get)。

采集无需开启“响应所有群消息”。扫码新建机器人默认仅 @ 时回复；补全权限保留已有回复方式。机器人设置中的「授权群消息权限」也可单独开通采集权限，但附件下载仍需消息读取权限。

### Telegram

1. 将 BotFather 创建的 Bot 接入「IM机器人 → Telegram」，并添加到目标群。
2. 打开 **@BotFather**，发送 `/setprivacy`，选择该 Bot，再选择 **Disable**。也可通过 `/mybots → Bot Settings → Group Privacy → Turn off` 操作。
3. **从已有群中移除该 Bot，再重新添加**，让隐私模式变更对该群生效。
4. 让其他群成员发送一条不带 @、不引用机器人消息的文字，再 @ Bot 查询。

群管理员 Bot 可以接收普通成员消息，因此已有管理员身份时也可使用。无法添加到群时，检查 BotFather 的 `/setjoingroups` 是否允许入群。这些是 Telegram 的接收设置，不需要更换 Bot Token。参见[官方 Privacy Mode 和 Bot 管理说明](https://core.telegram.org/bots/features#privacy-mode)。

普通群和超级群受支持；论坛 Topic 的记录归属于同一群，并保留 Topic 标识。群记录功能不自动开启机器人之间的通信能力，也不保证保存其他 Bot 的消息。

图片和文档随消息接收，通过 `getFile` 下载。Telegram 云端 Bot API 当前最多下载 **20 MB** 文件，超限不能因调大保留天数而解决。参见[getFile](https://core.telegram.org/bots/api#getfile)。

### Discord

1. 在 [Developer Portal](https://discord.com/developers/applications) 选择应用，进入 **Bot → Privileged Gateway Intents**，启用 **Message Content Intent**；若平台要求审核，先完成审核。
2. 邀请机器人进入服务器，确保它在目标频道具有 **View Channel** 权限，并能访问目标私有线程。
3. 在 DSH 接入 Bot Token，或重连已有机器人。插件已请求所需消息 Intents，无需修改代码。
4. 若需要在频道中 @ 后正常回答，保留该渠道原有的发言和线程权限，包括 **Send Messages**、**Create Public Threads**、**Send Messages in Threads**；读取引用消息还需要 **Read Message History**。

缺少 Message Content Intent 时，普通消息的正文和附件可能为空，或连接因 Intent 未授权而失败。只验证“@ 后能回复”不足以证明能接收普通消息。参见[Discord Gateway 权限说明](https://docs.discord.com/developers/events/gateway#message-content-intent)。

记录按频道保存；**线程有独立记录，不与父频道合并**。在父频道首次 @ 时查询父频道记录，进入线程后查询该线程记录。需要查询父频道时，请回父频道发起请求。

### Slack

**新建应用**：使用插件提供的最新 App Manifest 创建，启用 Socket Mode，生成具有 `connections:write` 的 App Token（`xapp-`），把应用安装到 Slack 工作区，再将 Bot Token（`xoxb-`）和 App Token 填入 DSH。

**已有应用**：升级插件不会自动更新 Slack 后台配置，应检查：

| 后台位置 | 所需配置 |
| --- | --- |
| Event Subscriptions → Subscribe to bot events | `message.channels`（公开频道）、`message.groups`（私有频道）；保留原有 `app_mention`、`message.im` |
| OAuth & Permissions → Bot Token Scopes | `channels:history`、`groups:history`、`files:read`；保留原有回复权限 |
| Socket Mode / App-Level Tokens | Socket Mode 开启，App Token 具有 `connections:write` |

新增 Scope 后需 **Reinstall to Workspace** 重新授权，并在必要时更新 DSH 中的 Token、重连。权限已齐全而只缺消息事件时，补齐订阅即可。最后在目标频道通过 `/invite @机器人` 或添加应用功能邀请 Bot；私有频道也需要单独加入。

普通公开、私有频道受支持，频道中的线程共享该频道记录。多人私信不包含在这项群记录支持范围内。仅订阅 `app_mention` 无法保存普通频道消息。事件和权限见[公开频道](https://docs.slack.dev/reference/events/message.channels/)与[私有频道](https://docs.slack.dev/reference/events/message.groups/)。

文件需要有权限的 Bot Token 下载；外部云文件或不可访问的文件链接不保证可保存。参见[Slack 文件访问说明](https://docs.slack.dev/reference/objects/file-object/)。

### QQ

1. 扫码新增或使用 AppID + AppSecret 接入 QQ 机器人，并将其加入目标群。
2. 由群主按 QQ 对该机器人提供的授权入口，允许其查看群内全部对话。入口是否提供取决于 QQ 应用能力和客户端，不能仅凭“机器人已入群”判断已授权。
3. 确认群内出现“群主已授权……查看群内全部对话”等授权结果，再用普通成员发送未 @ 文字、随后 @ 查询的方式确认投递。
4. 文件另行验证：发送一个普通文本附件，再让机器人读取其内容；文字接收成功不代表所有文件类型都可下载。

**QQ 已实测通过**：2026-10-18，在已获上述授权的「梁子来了」群中，winBot 成功保存未 @ 的普通文字和文本附件，并在 @ 后读取。不能据此保证其他应用默认具有同样权限。若 QQ 没有向当前应用开放普通群消息，DSH-IM 无法通过本地设置补齐平台未投递的数据。

当前 SDK 可处理普通群消息和 @ 群消息，实际是否投递仍以应用及群授权为准，参见[腾讯官方 SDK](https://github.com/tencent-connect/qqbot-nodejs)。**QQ 记录目前按应用来源隔离，不支持不同 QQ 应用之间自动共享同一实体群的记录**。

## 保留天数与存储位置

入口：**DSH 设置 → IM机器人 → 右上角齿轮「通用设置」→ 通用 → 群聊天记录保留天数**。这是插件的全局设置，不是机器人卡片内的「通用」页。

- 默认 **14 天**，可改为其他正整数，保存后对全部支持的群生效，无需重启。
- 按消息发送时间滚动保留最近 `N × 24` 小时，不按条数或自然日计算；不支持用 `0` 表示永久保留或关闭采集。
- 查询立即排除过期记录。启动时、每小时及保存天数后执行清理；缩短期限会清理过期消息和文件，延长期限不能恢复已删除内容。
- 「附件」Tab 中的附件保留时长管理会话附件副本，不控制群文件原件。

数据保存在运行 DSH 的机器上：

```text
<DSH_HOME>/integrations/dsh-im/
  general-settings.json    # 保留天数，首次保存设置后创建
  group-history.sqlite    # 群、消息和附件元数据
  group-files/            # 实际下载的群文件原件
```

未自定义数据目录时，`DSH_HOME` 默认为 `~/.dsh`。每条消息独立入库，包含群标识、平台消息 ID、发送者、时间、正文及附件信息；文件内容保存在 `group-files/`，不塞入数据库。

记录按群共享，独立于机器人、AI 会话和工作区。同一 DSH 数据目录内、同一群身份下的机器人可读取同一份记录；切换会话、工作区或删除某个机器人不删除群记录。QQ 的应用隔离以及 Discord 的线程隔离见上文，不同机器的数据不会自动同步。

读取文件时才复制到当前会话工作区，群文件原件仍归群所有。已进入 AI 会话的文字、总结及文件副本各自按原规则保留，修改群保留天数不会同步清除这些副本。

## 查询范围与文件限制

模型通过 `dsh_im_group_history` 按时间、关键词查询消息或文件列表，每页最多 100 条并限制返回体积；通过 `dsh_im_group_file` 获取已下载文件的会话副本，再读取正文。关键词查询针对消息正文或文件名，不会全文检索附件内容。

记录增加不会自动把全部历史塞进模型上下文。大量消息应按时间分段查询；查询结果未读完或有截断时，不能将部分结果当作完整总结。

本功能只保存插件实际收到且能识别的消息与附件：

- 不回填接入前的完整历史，不保证补齐离线期间消息，不遍历平台群文件库。
- 不完整同步编辑、撤回和机器人之间的消息；当前 Slack 采集会过滤机器人消息。
- 附件异步下载。群归档单文件上限为 **100 MiB**，同时受渠道下载器及平台更低限制约束。
- 文件未下载完成、下载失败、重启中断或已过期时，可能只能查到元数据，不能读取正文。可在权限与连接恢复后重新发送文件测试。
- 保存文件不等于解析文件；图片理解、PDF 或表格解析仍取决于当前模型和可用工具。

## 如何确认保存和读取正常

1. 保持机器人在线，让普通群成员发送一条带随机内容的消息，例如“记录验证：代号松林-8426，预算 315 元”，**不 @、不回复机器人**。
2. 随后在同一群 @ 机器人：“查一下刚才‘记录验证’的代号和预算，请读取群记录。”提问中不要重复答案。
3. 检查是否调用 `dsh_im_group_history`，以及回答是否匹配原消息。只看到机器人正常回复，不能证明它读取了群记录。
4. 文件测试可发送小型 `.txt` 文件，在正文放一个不同的随机内容；再 @ 机器人要求读取该文件正文。应先查询文件记录，再通过 `dsh_im_group_file` 获取副本并读取，而非只返回文件名。

截至 2026-10-18，WhatsApp、飞书、QQ 的普通文字及文本附件保存、读取已完成真实群验证；Telegram 未 @ 文字保存及 @ 后读取已通过，文件尚未实测；Discord、Slack 的采集路径已实现，真实群验收待完成。详细证据见[实施与实测记录](方案/Issue-295-群记录实施与WhatsApp实测记录.md)。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 只能查到 @ 消息 | 检查对应渠道的未 @ 接收权限、隐私模式或事件订阅；权限生效后发送新消息测试 |
| 能保存，但 @ 后不回答 | 检查机器人的访问设置、提及方式、平台发言权限及连接状态 |
| 飞书文字有记录，附件不可读 | 补齐 `im:message:readonly`，完成发布/审批后重新发送文件 |
| Telegram 关闭隐私模式后仍收不到 | 将 Bot 移出已有群再重新加入，使用普通成员的新消息测试 |
| Discord 查不到父频道内容 | 确认当前请求是否在线程中；回父频道重新 @ 查询 |
| Slack 只能响应提及 | 确认普通频道事件已订阅，Bot 已加入频道，新增 Scope 已重新安装授权 |
| 找不到很早的消息 | 检查接入时间、保留天数和当时的连接状态；不会自动回填完整历史 |
| 提示群记录设置无法读取 | 在「通用设置 → 通用」重新保存有效天数；设置损坏时采集、查询和自动清理会暂停 |
