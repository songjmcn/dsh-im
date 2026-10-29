import test, { after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deepStrictEqual, equal, ok } from 'node:assert';

import {
  formatRoomContextBlock,
  MatrixRoomHistoryStore,
  roomContextDayStartTs,
} from '../../../src/channels/matrix/matrix-room-history.mjs';

const tempDirectories = new Set();
async function tempDir() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-room-history-'));
  tempDirectories.add(directory);
  return directory;
}
after(async () => {
  for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

async function newStore(options) {
  const directory = await tempDir();
  return await new MatrixRoomHistoryStore(join(directory, 'history.json'), options).load();
}

const DAY = 86_400_000;
const NOW = Date.now();
let counter = 0;
const ev = (over = {}) => ({
  roomId: '!room:example.org',
  eventId: `$e${counter += 1}:example.org`,
  sender: '@alice:example.org',
  text: '话',
  ts: NOW,
  ...over,
});

test('appends retain chronological order, dedupe by event id, and ignore empty human text', async () => {
  const store = await newStore();
  const first = store.append(ev({ text: '第一条' }));
  ok(first && first.kind === 'human' && first.injected === false, 'an unaddressed human entry is pending by default');
  ok(store.append(ev({ eventId: first.eventId, text: '重复' })) === null, 'a replayed event id is ignored');
  ok(store.append(ev({ text: '   ' })) === null, 'a human entry with no text is rejected');
  const second = store.append(ev({ text: '第二条', ts: NOW + 1_000 }));
  const pending = store.pending({ roomId: '!room:example.org' });
  deepStrictEqual(pending.map((entry) => entry.text), ['第一条', '第二条'], 'pending is chronological and excludes the injected current turn');
  ok(second.injected === false);
});

test('trims each room to the bounded number of most recent entries', async () => {
  const store = await newStore({ limit: 20 });
  for (let index = 1; index <= 25; index += 1) store.append(ev({ text: `第${index}条`, ts: NOW + index }));
  const pending = store.pending({ roomId: '!room:example.org' });
  equal(pending.length, 20, 'only the bounded number of freshest entries survive');
  equal(pending[0].text, '第6条', 'the oldest entries are dropped first');
  equal(pending.at(-1).text, '第25条', 'the newest entry is always retained');
});

test('pending excludes injected and non-human kinds, and respects the count cap', async () => {
  const store = await newStore();
  store.append(ev({ text: '甲' }));
  store.append(ev({ text: '乙', kind: 'command' }));
  store.append(ev({ text: '丙', kind: 'bot' }));
  store.append(ev({ text: '丁' }));
  deepStrictEqual(store.pending({ roomId: '!room:example.org', limit: 1 }).map((entry) => entry.text), ['丁'],
    'only human, un-injected chatter is eligible and the newest wins under the cap');
});

test('consumePending injects only the current civil day, at most once, and keeps the freshest under the char budget', async () => {
  const yesterday = NOW - 2 * DAY;
  const store = await newStore();
  store.append(ev({ text: '昨天的旧事', ts: yesterday }));
  store.append(ev({ text: '甲今天的话', ts: NOW }));
  const first = store.consumePending({ roomId: '!room:example.org', limit: 10, maxChars: 8_000, now: NOW });
  deepStrictEqual(first.map((entry) => entry.text), ['甲今天的话'],
    'older-than-today entries are never auto-injected');
  deepStrictEqual(store.consumePending({ roomId: '!room:example.org', limit: 10, maxChars: 8_000, now: NOW }), [],
    'consumed entries are not offered again');
  const wide = await newStore();
  wide.append(ev({ text: 'x'.repeat(300), ts: NOW }));
  wide.append(ev({ text: 'y'.repeat(300), ts: NOW + 1 }));
  const budgeted = wide.consumePending({ roomId: '!room:example.org', limit: 10, maxChars: 400, now: NOW });
  deepStrictEqual(budgeted.map((entry) => entry.text[0]), ['y'], 'the char budget keeps the freshest entry when it binds');
});

test('roomContextDayStartTs snaps to the civil day at the configured offset', () => {
  const ts = roomContextDayStartTs(NOW, 480);
  const shifted = new Date(ts + 480 * 60_000);
  equal(shifted.getUTCHours(), 0);
  equal(shifted.getUTCMinutes(), 0);
  ok(ts <= NOW && NOW - ts < DAY, 'the day start is at or before now and within the same day');
});

test('search matches text and speaker case-insensitively, filters time bounds, and returns most recent first', async () => {
  const store = await newStore();
  store.append(ev({ sender: '@alice:example.org', text: '部署流水线失败', ts: NOW - 3 }));
  store.append(ev({ sender: '@bob:example.org', text: 'Alice 说部署还好', ts: NOW - 2 }));
  store.append(ev({ sender: '@carol:example.org', text: '无关话题', ts: NOW - 1 }));
  const deploy = store.search({ roomId: '!room:example.org', query: '部署' });
  deepStrictEqual(deploy.map((entry) => entry.text), ['Alice 说部署还好', '部署流水线失败'], 'recency-first text match across any speaker');
  const bySender = store.search({ roomId: '!room:example.org', sender: 'bob' });
  deepStrictEqual(bySender.map((entry) => entry.sender), ['@bob:example.org'], 'speaker filter matches the mxid local part');
  const ranged = store.search({ roomId: '!room:example.org', from: NOW - 2, to: NOW - 2 });
  deepStrictEqual(ranged.map((entry) => entry.text), ['Alice 说部署还好'], 'inclusive time bounds narrow the window');
  deepStrictEqual(store.search({ roomId: '!other:example.org', query: '部署' }), [], 'an unknown room yields nothing');
});

test('clear drops a room record and is idempotent', async () => {
  const store = await newStore();
  store.append(ev());
  ok(store.clear('!room:example.org') === true);
  ok(store.clear('!room:example.org') === false);
  deepStrictEqual(store.pending({ roomId: '!room:example.org' }), []);
});

test('the record survives a reload, preserving entries and consumed markers', async () => {
  const directory = await tempDir();
  const path = join(directory, 'history.json');
  const store = await new MatrixRoomHistoryStore(path).load();
  store.append(ev({ text: '待注入', ts: NOW }));
  store.append(ev({ text: '已消费', kind: 'command', ts: NOW + 1 }));
  store.consumePending({ roomId: '!room:example.org', limit: 10, maxChars: 8_000, now: NOW + 1 });
  await store.flush();
  const reloaded = await new MatrixRoomHistoryStore(path).load();
  const found = reloaded.search({ roomId: '!room:example.org', query: '待注入' });
  equal(found.length, 1, 'entries persist across a reload');
  deepStrictEqual(reloaded.pending({ roomId: '!room:example.org', sinceTs: NOW - 1 }), [],
    'consumed markers persist so nothing is re-injected after a restart');
});

test('formatRoomContextBlock fences and stamps third-party background lines', async () => {
  const store = await newStore();
  const morning = Date.UTC(2026, 0, 2, 9, 12, 0);
  store.append(ev({ sender: '@alice:example.org', text: '第一句', ts: morning }));
  store.append(ev({ sender: '@bob:example.org', text: '第二句', ts: morning + 60_000 }));
  const selected = store.pending({ roomId: '!room:example.org' });
  const block = formatRoomContextBlock(selected, {
    header: 'HEADER', instruction: 'RULE', begin: 'BEGIN', end: 'END', tzOffsetMinutes: 0,
  });
  equal(block, ['HEADER', 'RULE', 'BEGIN', '[09:12] [alice] 第一句', '[09:13] [bob] 第二句', 'END'].join('\n'),
    'the label, the instruction and the fences wrap clock stamped bracketed speakers in chronological order');
  equal(formatRoomContextBlock([], { header: 'HEADER' }), '', 'no entries render an empty block');
  const bare = formatRoomContextBlock(selected, {});
  equal(bare.split('\n')[0], '[09:12] [alice] 第一句', 'without labels the run still reads as stamped transcript lines');
});

test('recent windows stay inside the message list they name', async () => {
  const store = await newStore();
  store.append(ev({ text: '主线句', threadId: null, ts: NOW - 30_000 }));
  store.append(ev({ sender: '@bot:example.org', text: '话题答', kind: 'bot', threadId: '$t1:example.org', ts: NOW - 20_000 }));
  store.append(ev({ text: '话题问', threadId: '$t1:example.org', ts: NOW - 10_000 }));
  deepStrictEqual(store.recent({ roomId: '!room:example.org', threadId: null, limit: 10 }).map((entry) => entry.text),
    ['主线句'], 'the mainline window excludes thread entries');
  deepStrictEqual(store.recent({ roomId: '!room:example.org', threadId: '$t1:example.org', limit: 10 }).map((entry) => entry.text),
    ['话题答', '话题问'], 'the thread window keeps the list of the thread itself in chronological order, bot answer included');
  deepStrictEqual(store.recent({ roomId: '!room:example.org', limit: 10 }).map((entry) => entry.text),
    ['主线句'], 'a window without an explicit thread reads the mainline');
});

test('a thread window holds its root bubble even when the root was sent on the mainline', async () => {
  const store = await newStore();
  // An answer sent as a reply that opened a thread is stored where it was sent
  // — the mainline — yet the thread panel shows that bubble as its root message.
  store.append(ev({ eventId: '$root1:example.org', sender: '@bot:example.org', text: '根回答', kind: 'bot', threadId: null, ts: NOW - 40_000 }));
  store.append(ev({ eventId: '$other1:example.org', text: '别的话题的消息', threadId: '$other:example.org', ts: NOW - 30_000 }));
  deepStrictEqual(store.recent({ roomId: '!room:example.org', threadId: '$root1:example.org', limit: 10 }).map((entry) => entry.text),
    ['根回答'], 'the thread window includes the root bubble stored on the mainline');
  deepStrictEqual(store.recent({ roomId: '!room:example.org', threadId: null, limit: 10 }).map((entry) => entry.text),
    ['根回答'], 'the mainline window keeps the root on the list it was sent to');
  // The panel heads with the root however long the thread has been running: an
  // aged root still leads a fresh window while stale in-panel posts stay out.
  store.append(ev({ text: '陈旧线内消息', threadId: '$root1:example.org', ts: NOW - 20_000 }));
  store.append(ev({ text: '新鲜线内消息', threadId: '$root1:example.org', ts: NOW - 1_000 }));
  deepStrictEqual(store.recent({ roomId: '!room:example.org', threadId: '$root1:example.org', limit: 10, sinceTs: NOW - 10_000 }).map((entry) => entry.text),
    ['根回答', '新鲜线内消息'],
    'the root bubble is exempt from the freshness floor as the panel head, while stale in-panel posts remain outside the window');
});

test('revise brings a stored entry to its latest edit frame and records the last frame when nothing is stored', async () => {
  const store = await newStore();
  equal(store.revise({ roomId: '!room:example.org', eventId: '$s1:example.org', sender: '@bot:example.org', text: '首帧', ts: NOW - 5_000, threadId: '$t9:example.org' }), true,
    'revising an entry that is not stored yet records it');
  store.revise({ roomId: '!room:example.org', eventId: '$s1:example.org', sender: '@bot:example.org', text: '终帧正文', ts: NOW });
  const entries = store.recent({ roomId: '!room:example.org', threadId: '$t9:example.org', limit: 10 });
  deepStrictEqual(entries.map((entry) => [entry.text, entry.kind, entry.ts]), [['终帧正文', 'bot', NOW]],
    'the last frame owns the entry and earlier frames do not linger as siblings');
});

test('the context ledger is durable: injections and session generations survive a reload', async () => {
  const directory = await tempDir();
  const file = join(directory, 'history.json');
  const conv = 'group:room:!room:example.org';
  const store = await new MatrixRoomHistoryStore(file).load();
  equal(store.contextEpoch({ conversationKey: conv }), 0, 'an unknown conversation sits on generation zero');
  equal(store.contextInjected({ conversationKey: conv, eventId: '$g:x.org' }), false);
  equal(store.markContextInjected({ conversationKey: conv, eventIds: ['$g:x.org', '$g:x.org', '', 7] }), true,
    'first-time ids are recorded, duplicates and non-strings are dropped');
  equal(store.contextInjected({ conversationKey: conv, eventId: '$g:x.org' }), true);
  equal(store.markContextInjected({ conversationKey: conv, eventIds: ['$g:x.org'] }), false,
    're-marking an already-marked event changes nothing');
  equal(store.bumpContextEpoch({ conversationKey: conv }), 1);
  await store.flush();
  const reloaded = await new MatrixRoomHistoryStore(file).load();
  equal(reloaded.contextInjected({ conversationKey: conv, eventId: '$g:x.org' }), true,
    'the read-once retirement survives a restart, so a reboot re-offers no collected entry');
  equal(reloaded.contextEpoch({ conversationKey: conv }), 1,
    'the session generation survives too, so retired answers stay retired for their own conversation');
  equal(reloaded.clearContextInjected({ conversationKey: conv }), true,
    'a cleared conversation releases its records so the successor reads each bubble back once');
  equal(reloaded.contextInjected({ conversationKey: conv, eventId: '$g:x.org' }), false);
  equal(reloaded.contextEpoch({ conversationKey: conv }), 1, 'clearing the records keeps the generation counter');
  equal(reloaded.clearContextInjected({ conversationKey: conv }), false, 'an empty record clears to nothing');
  equal(reloaded.contextEpoch({}), 0);
  equal(reloaded.contextInjected({}), false);
  equal(reloaded.markContextInjected({ conversationKey: conv, eventIds: 'nope' }), false);
});

test('loading stamps provenance on unprovenanced bot bubbles from their own room and thread route', async () => {
  const directory = await tempDir();
  const file = join(directory, 'history.json');
  const roomId = '!room:example.org';
  const bot = '@bot:example.org';
  const rows = [
    { eventId: '$g:x.org', sender: bot, name: 'bot', text: '群聊开场白', ts: NOW, threadId: null, kind: 'bot', injected: true },
    { eventId: '$t:x.org', sender: bot, name: 'bot', text: '列头回答', ts: NOW, threadId: '$h:x.org', kind: 'bot', injected: true },
    { eventId: '$r:x.org', sender: bot, name: 'bot', text: '', ts: NOW, threadId: null, kind: 'bot', injected: true },
    { eventId: '$s:x.org', sender: bot, name: 'bot', text: '已钉者', ts: NOW, threadId: null, kind: 'bot', injected: true, turnKey: 'custom:key', turnEpoch: 4 },
    { eventId: '$u:x.org', sender: '@alice:example.org', name: 'alice', text: '人的话', ts: NOW, threadId: null, kind: 'human' },
  ];
  await writeFile(file, `${JSON.stringify({ rooms: { [roomId]: { entries: rows, injected: [] } } })}\n`, 'utf8');
  const store = await new MatrixRoomHistoryStore(file).load();
  const byId = new Map(store.search({ roomId, limit: 50 }).map((entry) => [entry.eventId, entry]));
  equal(byId.get('$g:x.org').turnKey, `group:room:${roomId}`, 'a mainline bubble names the room conversation that delivered it');
  equal(byId.get('$g:x.org').turnEpoch, 0);
  equal(byId.get('$t:x.org').turnKey, `group:room:${roomId}$$h:x.org`, 'a threaded bubble names its panel conversation');
  equal(byId.get('$r:x.org').turnKey, null, 'a content-free receipt keeps no claim');
  equal(byId.get('$s:x.org').turnKey, 'custom:key');
  equal(byId.get('$s:x.org').turnEpoch, 4, 'an entry that already names its delivery keeps its stamp');
  equal(byId.get('$u:x.org').turnKey, null, 'human entries gain no bot provenance');
});
