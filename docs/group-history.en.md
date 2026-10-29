# Group message history and shared files

[简体中文](group-history.md) · [Back to README](../README.en.md)

DSH-IM automatically saves group messages and attachments it receives. Mention a bot in the group later to search messages, summarize discussions, or read files. This feature covers **WhatsApp, Feishu, Telegram, Discord, Slack, and QQ**.

Recording is enabled by default, with no initial mention or per-group switch required. Saving a message does not call the model or create an AI Session. Existing mention rules, reply modes, and access settings still determine when the bot answers.

## Quick start

1. Use a DSH-IM build that includes group history, connect your bot to DSH, and add it to the target group or channel.
2. Complete the platform settings below so the bot can receive messages without mentions.
3. Keep DSH and the bot online. New messages and attachments received by the plugin are saved automatically.
4. Mention the bot in the same group, for example:

   ```text
   @bot Summarize today's discussion in this group, including decisions and action items.
   @bot Find messages mentioning "budget" from the last 7 days.
   @bot List the files received in this group yesterday.
   @bot Read yesterday's "meeting-notes.txt" and tell me the agreed delivery date.
   ```

There is no special history command to memorize. The model queries local group records on demand and obtains a Session copy when reading a file. Asking about a group from Web/CLI or a direct message does not grant access to that group's archive.

## Platform settings

| Platform | Receiving messages without mentions | Group files |
| --- | --- | --- |
| WhatsApp | Link a device by QR code; the account must be in the group and connected. No additional OAuth scope | A downloadable image or file must be present in the message |
| Feishu | Add the bot to the group; subscribe to `im.message.receive_v1`; grant `im:message.group_msg` | `im:message:readonly` for downloading message attachments |
| Telegram | Add the bot; disable Privacy Mode and re-add it, or make it a group admin | Bot API downloads; the cloud API limits downloads to 20 MB |
| Discord | Channel access and an enabled, approved **Message Content Intent**, where review is required | Content access also covers attachments; download URLs must remain usable |
| Slack | Channel membership, `message.channels` / `message.groups` subscriptions, and matching history scopes | Bot Token with `files:read` and access to the file |
| QQ | App support for messages without mentions and group-owner authorization to view all group conversations; verify actual delivery | Delivered events must contain downloadable attachments |

### WhatsApp

1. Under **IM Bots → WhatsApp**, scan the QR code with your phone to link the account.
2. Ensure that account belongs to the target group and remains connected.
3. Have a group member send an ordinary message, then mention the linked account to query it.

This integration uses Baileys linked devices. Recording does not require switching to an open response mode; queries still follow the bot's access settings. WhatsApp defaults to self-chat responses, so allow the relevant members in access settings if they should be able to query from the group. Linking a device does not import the phone's entire history. View-once media is excluded from the archive.

### Feishu

**New bots created by QR code:** the plugin requests `im:message.group_msg` and `im:message:readonly` by default. Complete any publication or approval required by Feishu, then add the bot to the group.

**Existing or manually connected bots:**

1. Find the bot under **IM Bots → Feishu** and click **Complete permissions**, or send `/repair` to the bot in a direct chat.
2. Scan the QR code to add missing permissions, finish publication/approval, and wait for the bot to reconnect.
3. Confirm group membership and test with a new ordinary message.

For apps configured manually, check these settings in the developer console:

| Setting | Purpose |
| --- | --- |
| Bot capability and persistent-connection event delivery | Receive events as an app bot |
| `im.message.receive_v1` event | Receive messages |
| Tenant scope `im:message.group_msg` | Receive group messages without a mention |
| Tenant scope `im:message:readonly` | Download images and files from user messages |

`im:resource` supports bot uploads and does not replace message-read permission for user attachments. Mention-only permission is insufficient for ordinary group messages. See [message events](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) and [message resource downloads](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get).

Recording does not require the “respond to all group messages” mode. New bots default to mention-only replies, and permission repair preserves the existing reply mode. The bot settings also offer a separate group-message authorization action; downloading attachments still requires message-read access.

### Telegram

1. Connect a BotFather-created bot under **IM Bots → Telegram**, then add it to the group.
2. Message **@BotFather** with `/setprivacy`, select the bot, and choose **Disable**. Alternatively use `/mybots → Bot Settings → Group Privacy → Turn off`.
3. **Remove the bot from existing groups and add it again** for the change to take effect.
4. Ask another member to send new text without mentioning or replying to the bot, then mention the bot to query it.

A bot that is already a group admin can also receive ordinary member messages. If it cannot join groups, check `/setjoingroups` in BotFather. These are Telegram delivery settings; no new Bot Token is needed. See [Privacy Mode and bot management](https://core.telegram.org/bots/features#privacy-mode).

Groups and supergroups are supported. Forum Topics share their group's archive, with Topic IDs retained on messages. This feature does not enable bot-to-bot communication or guarantee capture of other bots' messages.

Images and documents are downloaded through `getFile`. The cloud Bot API currently limits downloads to **20 MB**; increasing retention does not raise that limit. See [getFile](https://core.telegram.org/bots/api#getfile).

### Discord

1. Open your app in the [Developer Portal](https://discord.com/developers/applications). Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** and complete any required review.
2. Invite the bot to the server. Give it **View Channel** in the target channel and access to any private thread it should use.
3. Connect its Bot Token in DSH or reconnect the existing bot. The plugin already requests the required message Intents.
4. For replies, retain the integration's channel/thread permissions: **Send Messages**, **Create Public Threads**, and **Send Messages in Threads**. Fetching referenced messages also requires **Read Message History**.

Without Message Content Intent, ordinary messages may have empty text and attachment fields, or the Gateway may reject the connection. A successful mentioned reply alone does not establish access to ordinary messages. See [Discord's Gateway requirements](https://docs.discord.com/developers/events/gateway#message-content-intent).

**Threads have separate archives from their parent channels.** An initial mention in the parent channel can query that channel; requests inside a thread query the thread. Return to the parent channel to query its records.

### Slack

**New apps:** create the app using the plugin's current App Manifest. Enable Socket Mode, create an App Token (`xapp-`) with `connections:write`, install the app in your Slack workspace, and enter both the Bot Token (`xoxb-`) and App Token in DSH.

**Existing apps:** upgrading the plugin does not update Slack's configuration automatically. Check:

| Console location | Required configuration |
| --- | --- |
| Event Subscriptions → Subscribe to bot events | `message.channels` for public channels and `message.groups` for private channels; retain `app_mention` and `message.im` |
| OAuth & Permissions → Bot Token Scopes | `channels:history`, `groups:history`, and `files:read`; retain existing reply scopes |
| Socket Mode / App-Level Tokens | Socket Mode enabled; App Token with `connections:write` |

After adding scopes, **Reinstall to Workspace** to authorize them, update tokens in DSH if necessary, and reconnect. If scopes are already present, adding the missing event subscriptions is sufficient. Invite the bot to each target channel with `/invite @bot` or the channel's app controls, including private channels.

Public and private channels are supported; threads share their channel's archive. Multiparty direct messages are outside this feature's scope. An `app_mention` subscription alone cannot capture ordinary channel messages. See [public-channel events](https://docs.slack.dev/reference/events/message.channels/) and [private-channel events](https://docs.slack.dev/reference/events/message.groups/).

Downloads use the authorized Bot Token. External cloud files and inaccessible links are not guaranteed to be downloadable. See [Slack file access](https://docs.slack.dev/reference/objects/file-object/).

### QQ

1. Connect the bot by QR code or AppID + AppSecret and add it to the group.
2. Have the group owner use QQ's authorization flow, where offered for that bot, to allow viewing all group conversations. Availability depends on the app's capabilities and QQ client; group membership alone does not establish this permission.
3. Confirm the authorization result, such as a group notice saying the owner has authorized the bot to view all conversations. Test with an ordinary member's message without a mention, then mention the bot to retrieve it.
4. Test attachments separately with a small text file and a request to read its contents. Successful text delivery does not establish support for every file type.

**QQ has passed live verification.** On 2026-10-18, winBot in the authorized “梁子来了” group saved ordinary text and text-file attachments without mentions and retrieved them when mentioned. This does not establish default access for other apps. If QQ does not deliver ordinary group messages to your app, no local DSH-IM setting can supply those missing events.

The current SDK handles both ordinary and mentioned group messages, subject to platform delivery and authorization; see [Tencent's official SDK](https://github.com/tencent-connect/qqbot-nodejs). **QQ archives are currently isolated by app: different QQ apps do not automatically share records for the same physical group.**

## Retention and storage

Open **DSH Settings → IM Bots → gear icon, General settings → General → Group chat retention (days)**. This is the plugin's global settings page, separate from the General tab on an individual bot card.

- The default is **14 days**. Any supported positive whole-day value applies to all supported groups immediately after saving, without a restart.
- Retention is a rolling `N × 24` hours based on message send time, rather than a message count or calendar-day boundary. `0` does not mean unlimited retention or recording disabled.
- Queries immediately exclude expired records. Cleanup runs at startup, hourly, and after saving retention. Shortening it removes expired messages and original files; extending it cannot restore deleted data.
- The **Attachments** tab controls Session attachment copies, not group-file originals.

Data is stored on the machine running DSH:

```text
<DSH_HOME>/integrations/dsh-im/
  general-settings.json    # Retention; created when settings are first saved
  group-history.sqlite    # Groups, messages, and attachment metadata
  group-files/            # Downloaded original group files
```

Without a custom data directory, `DSH_HOME` defaults to `~/.dsh`. Each message has its own database row, including group identity, platform message ID, sender, timestamp, text, and attachment references. File contents live in `group-files/`, outside SQLite.

Records belong to the group independently of bots, AI Sessions, and workspaces. Bots using the same group identity and DSH data directory can read the same records. Changing Sessions/workspaces or deleting one bot does not delete the group archive. QQ app isolation and Discord thread isolation still apply; there is no automatic synchronization between machines.

Files are copied into the current Session workspace only when needed for reading. Original files remain owned by the group archive. Text already included in an AI Session, generated summaries, and file copies retain their own lifecycles; changing group retention does not erase them all.

## Query and file limits

The model uses `dsh_im_group_history` to query messages or file lists by time and keyword, with at most 100 entries per page and a bounded response size. It uses `dsh_im_group_file` to obtain a Session copy of a downloaded file, then reads its contents. Keyword search matches message text or filenames; it does not search inside attachments.

Growing archives are not automatically loaded into the model's context. Large discussions should be queried in time ranges. Unread pages or truncated results must not be presented as a complete summary.

Only messages and attachments actually received and recognized by the plugin can be saved:

- No complete history backfill, guaranteed recovery of offline periods, or crawling of the platform's group-file library.
- No complete synchronization of edits, deletions, or bot-to-bot messages; Slack capture currently filters bot messages.
- Attachments download asynchronously. The archive limit is **100 MiB per file**, with lower platform or channel-downloader limits still applying.
- Pending, failed, interrupted, or expired downloads may expose metadata without readable contents. After resolving permission or connection issues, resend the file to test again.
- Saving a file does not parse it. Image understanding, PDF reading, and spreadsheet processing depend on the model and available tools.

## Verify saving and retrieval

1. While the bot is online, have an ordinary member send a unique message such as “Archive test: code Pine-8426, budget 315.” **Do not mention or reply to the bot.**
2. In the same group, mention the bot: “Read the group archive and tell me the code and budget from the earlier archive test.” Do not repeat the answers in the query.
3. Check that `dsh_im_group_history` runs and the answer matches the original. An ordinary bot reply alone does not prove archive retrieval.
4. For files, send a small `.txt` containing a different unique value. Ask the bot to read its contents. It should query the archive, obtain a copy with `dsh_im_group_file`, and read the file rather than only report its name.

As of 2026-10-18, live group tests passed for ordinary text and text-file saving/retrieval on WhatsApp, Feishu, and QQ. Telegram passed text capture without mentions and retrieval when mentioned; its files remain untested. Discord and Slack capture paths are implemented, with live group verification pending. See the [implementation and verification record](方案/Issue-295-群记录实施与WhatsApp实测记录.md) (Chinese).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Only mentioned messages appear | Check ordinary-message permissions, Privacy Mode, or event subscriptions. Send new messages after the change takes effect |
| Records are saved, but mentions get no reply | Check bot access settings, mention syntax, platform send permissions, and connection status |
| Feishu text is available but attachments are unreadable | Add `im:message:readonly`, complete publication/approval, and resend the file |
| Telegram still misses messages after disabling privacy | Remove and re-add the bot, then test a new ordinary member message |
| Discord cannot find parent-channel records | Check whether the request is inside a thread; mention the bot in the parent channel |
| Slack only responds to mentions | Check ordinary-message subscriptions, channel membership, and reinstallation after adding scopes |
| Older messages are missing | Check connection start time, retention, and whether the bot was online. Full history is not backfilled |
| Group settings cannot be read | Save a valid retention value under General settings → General. Invalid settings pause recording, queries, and automatic cleanup |
