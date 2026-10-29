import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WhatsappStateStore } from '../../../src/channels/whatsapp/state-store.mjs';
import { normalizeWhatsappMessage, WhatsappBotClient } from '../../../src/channels/whatsapp/whatsapp-runtime.mjs';

const account = '16505550123@s.whatsapp.net';
const group = '120363000000000001@g.us';

test('WhatsApp bot reply identity survives reload and stays scoped to its group', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wa-bot-replies-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const state = await new WhatsappStateStore(path).load();
  let id = 0;
  const client = new WhatsappBotClient({
    sendPresenceUpdate: async () => {},
    sendMessage: async () => ({ key: { id: `bot-${++id}` } }),
  }, { remember() {} }, {
    rememberBotMessage: (jid, messageId) => state.rememberBotMessage(jid, messageId),
  });
  t.after(() => client.close());
  await client.sendText({ jid: group }, 'bot response');
  await client.sendFile({ jid: group }, { bytes: Buffer.from('test'), fileName: 'test.txt' });
  await client.sendImage({ jid: group }, { bytes: Buffer.from('test'), fileName: 'test.png' });
  await client.sendText({ jid: account, selfChat: true }, 'self-chat response');
  await state.markSeen(`${group}:manual-owner-message`);
  await state.setSession(`group:${group}`, 'session-existing');

  const reloaded = await new WhatsappStateStore(path).load();
  assert.equal(reloaded.sessionFor(`group:${group}`), 'session-existing');
  for (const botId of ['bot-1', 'bot-2', 'bot-3']) {
    for (const fromMe of [true, false]) {
      const normalize = (jid, stanzaId, participant = account) => normalizeWhatsappMessage({
        key: { remoteJid: jid, id: 'follow-up', fromMe, participant: '16505550999@s.whatsapp.net' },
        message: { extendedTextMessage: {
          text: 'follow-up', contextInfo: { participant, stanzaId },
        } },
      }, account, { isBotMessage: (chat, messageId) => reloaded.isBotMessage(chat, messageId) });
      assert.equal(normalize(group, botId).addressed, true);
      assert.equal(normalize('120363000000000002@g.us', botId).addressed, false);
      assert.equal(normalize(group, 'manual-owner-message').addressed, false);
      assert.equal(normalize(group, undefined).addressed, false);
      assert.equal(normalize(group, botId, '16505550888@s.whatsapp.net').addressed, false);
    }
  }
  assert.equal(reloaded.isBotMessage(account, 'bot-4'), false, 'direct replies need no group identity record');
  assert.equal(normalizeWhatsappMessage({
    key: { remoteJid: account, id: 'self-follow-up', fromMe: true },
    message: { conversation: 'hello' },
  }, account).addressed, true);
});

test('WhatsApp bot message records accept legacy state and stay bounded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wa-bot-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ version: 1, sessions: {}, seenMessageIds: [] }));
  const state = await new WhatsappStateStore(path).load();
  assert.equal(state.isBotMessage(group, 'old-unknown'), false);
  await state.rememberBotMessage(group, undefined);
  await state.rememberBotMessage(account, 'direct');
  assert.equal(state.snapshot().whatsappBotMessageIds, undefined);

  const ids = Array.from({ length: 2_001 }, (_, index) => `${group}:bot-${index}`);
  await writeFile(path, JSON.stringify({ ...state.snapshot(), whatsappBotMessageIds: [null, ...ids] }));
  await state.load();
  assert.equal(state.isBotMessage(group, 'bot-0'), false);
  assert.equal(state.isBotMessage(group, 'bot-1'), true);
  await state.rememberBotMessage(group, 'new');
  await state.rememberBotMessage(group, 'new');
  const stored = JSON.parse(await readFile(path, 'utf8')).whatsappBotMessageIds;
  assert.equal(stored.length, 2_000);
  assert.equal(state.isBotMessage(group, 'bot-1'), false);
  assert.equal(state.isBotMessage(group, 'new'), true);
  await state.remove();
  assert.equal(state.isBotMessage(group, 'new'), false);
});
