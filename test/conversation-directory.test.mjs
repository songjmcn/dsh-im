import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONVERSATION_DIRECTORY_PREFIX,
  DEFAULT_CONVERSATION_DIRECTORY_SETTINGS,
  conversationDirectoryFailureReason,
  conversationDirectoryName,
  isConversationDirectoryPath,
  normalizeConversationDirectorySettings,
  validateConversationDirectorySettings,
} from '../src/channels/shared/conversation-directory.mjs';
import { ensureConversationDirectory } from '../src/channels/shared/conversation-directory-ensure.mjs';
import { resetConversationSession } from '../src/channels/shared/new-command.mjs';
import { BotWorkspaceStore, createBotWorkspaceScope } from '../src/channels/shared/bot-workspace-store.mjs';
import { workspacePathSnapshot } from '../src/channels/shared/workspace-command.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-convdir-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { root, workspace, path: join(root, 'workspaces.json') };
}

/**
 * A bot workspace scope stub: enough of the scope surface for the preparation
 * and the `/new` body, without a Harness or a Cordis context.
 */
function scopeStub({ workspace, settings = DEFAULT_CONVERSATION_DIRECTORY_SETTINGS }) {
  const state = {
    settings,
    overrides: new Map(),
    records: new Map(),
    switches: [],
  };
  const harness = {
    conversationDirectorySettings: () => ({ ...state.settings }),
    sessionDirectory: (key) => {
      const record = state.records.get(key);
      return record ? { ...record } : null;
    },
    currentConversationWorkspace: (key) => state.overrides.get(key) ?? workspace,
    async switchConversationSessionDirectory(key, value) {
      state.switches.push({ key, ...value });
      // Mirrors the store: the override and the record commit together.
      state.overrides.set(key, value.directory);
      state.records.set(key, { ...value, createdAt: 1 });
      return value.directory;
    },
  };
  return { harness, state };
}

function sessionStore() {
  const sessions = new Map();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, sessionId) { sessions.set(key, sessionId); },
    async clearSession(key) { sessions.delete(key); },
    size: () => sessions.size,
  };
}

// ── Naming ───────────────────────────────────────────────────────────────────

test('a conversation key becomes one filesystem-safe directory name', () => {
  const name = conversationDirectoryName('p2p:ou_abc');
  assert.ok(name.startsWith(CONVERSATION_DIRECTORY_PREFIX));
  assert.ok(!name.includes(':'));
  assert.doesNotMatch(name, /[<>:"/\\|?*]/);
});

test('name generation is deterministic for the same key and strategy', () => {
  assert.equal(
    conversationDirectoryName('group:oc_1:thread:ot_2'),
    conversationDirectoryName('group:oc_1:thread:ot_2'),
  );
});

test('keys that sanitize to the same stem still get distinct names', () => {
  // `:` sanitizes to `-`, so without the digest these two would collide.
  assert.notEqual(
    conversationDirectoryName('p2p:a:b'),
    conversationDirectoryName('p2p:a-b'),
  );
});

test('a very long conversation key stays inside the filename budget', () => {
  const name = conversationDirectoryName(`p2p:${'x'.repeat(600)}`);
  assert.ok(name.length <= 100, `expected <= 100, got ${name.length}`);
});

test('a key that is a windows device name stays usable behind the prefix', () => {
  const name = conversationDirectoryName('nul');
  assert.notEqual(name.toUpperCase(), 'NUL');
  assert.ok(name.startsWith(CONVERSATION_DIRECTORY_PREFIX));
});

test('per-session names carry a timestamp so two sessions never share one', () => {
  const first = conversationDirectoryName('p2p:ou_abc', { strategy: 'per-session', now: 1_000 });
  const second = conversationDirectoryName('p2p:ou_abc', { strategy: 'per-session', now: 2_000 });
  assert.notEqual(first, second);
  assert.equal(first, conversationDirectoryName('p2p:ou_abc', { strategy: 'per-session', now: 1_000 }));
});

test('conversationDirectoryName rejects a missing key', () => {
  assert.throws(() => conversationDirectoryName(''), TypeError);
});

// ── Path predicate ───────────────────────────────────────────────────────────

test('isConversationDirectoryPath matches the last segment on either separator', () => {
  assert.equal(isConversationDirectoryPath('/base/conv-p2p-x-1a2b3c4d'), true);
  assert.equal(isConversationDirectoryPath('C:\\base\\conv-p2p-x-1a2b3c4d'), true);
  assert.equal(isConversationDirectoryPath('/base/other'), false);
  assert.equal(isConversationDirectoryPath(''), false);
  assert.equal(isConversationDirectoryPath(null), false);
});

// ── Settings ─────────────────────────────────────────────────────────────────

test('settings default to disabled and are validated on save', () => {
  assert.equal(DEFAULT_CONVERSATION_DIRECTORY_SETTINGS.enabled, false);
  assert.deepEqual(validateConversationDirectorySettings({ enabled: true }), {
    enabled: true,
    strategy: 'per-conversation',
    prefix: CONVERSATION_DIRECTORY_PREFIX,
  });
});

test('settings reject an unknown strategy, a bad prefix and extra keys', () => {
  assert.throws(() => validateConversationDirectorySettings({ enabled: true, strategy: 'per-day' }), TypeError);
  assert.throws(() => validateConversationDirectorySettings({ enabled: true, prefix: 'a/b' }), TypeError);
  assert.throws(() => validateConversationDirectorySettings({ enabled: true, extra: 1 }), TypeError);
  assert.throws(() => validateConversationDirectorySettings({ enabled: 'yes' }), TypeError);
});

test('normalizing damaged settings falls back to the disabled defaults', () => {
  assert.deepEqual(normalizeConversationDirectorySettings({ enabled: 'nope' }),
    DEFAULT_CONVERSATION_DIRECTORY_SETTINGS);
});

test('every degradation reason has a user-facing sentence', () => {
  for (const reason of ['base-unavailable', 'create-failed', 'switch-failed',
    'unsupported-harness', 'invalid-key']) {
    assert.notEqual(conversationDirectoryFailureReason(reason), '未知原因。');
  }
  assert.equal(conversationDirectoryFailureReason('who-knows'), '未知原因。');
});

// ── Preparation ──────────────────────────────────────────────────────────────

test('preparation is a no-op while isolation is disabled', async (t) => {
  const { workspace } = await fixture(t);
  const { harness, state } = scopeStub({ workspace });
  const prepared = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc' });
  assert.equal(prepared.enabled, false);
  assert.equal(prepared.prepared, false);
  assert.equal(state.switches.length, 0);
});

test('preparation creates the directory below the base and switches to it', async (t) => {
  const { workspace } = await fixture(t);
  const { harness, state } = scopeStub({ workspace, settings: { ...DEFAULT_CONVERSATION_DIRECTORY_SETTINGS, enabled: true } });
  const prepared = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc' });
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.created, true);
  assert.equal(prepared.base, workspace);
  assert.equal(prepared.directory, state.overrides.get('p2p:ou_abc'));
  assert.ok(prepared.directory.startsWith(join(workspace, CONVERSATION_DIRECTORY_PREFIX)));
  // The directory itself must exist on disk before the switch is applied.
  assert.equal(await realpath(prepared.directory).then(() => true, () => false), true);
});

test('preparation is idempotent for the default per-conversation strategy', async (t) => {
  const { workspace } = await fixture(t);
  const { harness, state } = scopeStub({ workspace, settings: { ...DEFAULT_CONVERSATION_DIRECTORY_SETTINGS, enabled: true } });
  const first = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc' });
  const second = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc', fresh: true });
  assert.equal(first.directory, second.directory);
  assert.equal(second.reused, true);
  assert.equal(state.switches.length, 1, 'a reused directory must not switch again');
});

test('per-session mints a second directory only for an explicit /new', async (t) => {
  const { workspace } = await fixture(t);
  const settings = { ...DEFAULT_CONVERSATION_DIRECTORY_SETTINGS, enabled: true, strategy: 'per-session' };
  const { harness } = scopeStub({ workspace, settings });
  const first = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc' });
  // A plain message reuses; only `/new` mints.
  const reused = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc' });
  assert.equal(reused.directory, first.directory);
  const fresh = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc', fresh: true });
  assert.notEqual(fresh.directory, first.directory);
  assert.equal(fresh.base, workspace, 'the new directory stays below the recorded base');
});

test('a recorded base is reused so /new never nests a directory in its predecessor', async (t) => {
  const { workspace } = await fixture(t);
  const { harness, state } = scopeStub({ workspace, settings: { ...DEFAULT_CONVERSATION_DIRECTORY_SETTINGS, enabled: true } });
  const first = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc' });
  // The scope now reports the directory as the conversation workspace, exactly
  // as the real store does after the switch.
  assert.equal(state.overrides.get('p2p:ou_abc'), first.directory);
  const again = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc', fresh: true });
  assert.equal(again.directory, first.directory);
  assert.ok(!again.directory.startsWith(`${first.directory}/`));
});

test('preparation degrades instead of throwing when the directory cannot be created', async (t) => {
  const { workspace, root } = await fixture(t);
  const { harness } = scopeStub({ workspace, settings: { ...DEFAULT_CONVERSATION_DIRECTORY_SETTINGS, enabled: true } });
  // A file where the base directory should be: mkdir below it must fail.
  const blocked = join(root, 'blocked');
  await writeFile(blocked, 'not a directory');
  harness.currentConversationWorkspace = () => blocked;
  const prepared = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc' });
  assert.equal(prepared.prepared, false);
  assert.equal(prepared.degraded, true);
  assert.equal(prepared.reason, 'create-failed');
});

test('preparation degrades when the harness does not expose the scope surface', async (t) => {
  const { workspace } = await fixture(t);
  const harness = { conversationDirectorySettings: () => ({ enabled: true }) };
  const prepared = await ensureConversationDirectory({ harness, key: 'p2p:ou_abc' });
  assert.equal(prepared.degraded, true);
  assert.equal(prepared.reason, 'unsupported-harness');
  assert.ok(workspace);
});

test('preparation degrades on a missing conversation key', async (t) => {
  const { workspace } = await fixture(t);
  const { harness } = scopeStub({ workspace, settings: { ...DEFAULT_CONVERSATION_DIRECTORY_SETTINGS, enabled: true } });
  const prepared = await ensureConversationDirectory({ harness, key: '' });
  assert.equal(prepared.reason, 'invalid-key');
});

// ── /new ─────────────────────────────────────────────────────────────────────

test('/new clears the session binding and reports the directory', async (t) => {
  const { workspace } = await fixture(t);
  const { harness, state } = scopeStub({ workspace, settings: { ...DEFAULT_CONVERSATION_DIRECTORY_SETTINGS, enabled: true } });
  const store = sessionStore();
  await store.setSession('p2p:ou_abc', 'session-1');
  const reset = await resetConversationSession({
    harness, state: store, key: 'p2p:ou_abc', message: '已开启全新 Harness 会话。',
  });
  assert.equal(store.size(), 0);
  assert.equal(reset.prepared.prepared, true);
  assert.ok(reset.message.startsWith('已开启全新 Harness 会话。'));
  assert.ok(reset.message.includes(state.overrides.get('p2p:ou_abc')));
});

test('/new keeps its original confirmation while isolation is disabled', async (t) => {
  const { workspace } = await fixture(t);
  const { harness } = scopeStub({ workspace });
  const store = sessionStore();
  await store.setSession('p2p:ou_abc', 'session-1');
  const reset = await resetConversationSession({
    harness, state: store, key: 'p2p:ou_abc', message: '已开启新会话。请发送你的问题。',
  });
  assert.equal(store.size(), 0);
  assert.equal(reset.message, '已开启新会话。请发送你的问题。');
});

test('/new explains a degraded directory instead of failing silently', async (t) => {
  const { workspace } = await fixture(t);
  const { harness } = scopeStub({ workspace, settings: { ...DEFAULT_CONVERSATION_DIRECTORY_SETTINGS, enabled: true } });
  harness.switchConversationSessionDirectory = async () => {
    throw new Error('nope');
  };
  const reset = await resetConversationSession({
    harness, state: sessionStore(), key: 'p2p:ou_abc', message: '已开启全新 Harness 会话。',
  });
  assert.equal(reset.prepared.degraded, true);
  assert.ok(reset.message.includes('无法把本对话切换到新目录。'));
});

// ── Store integration ────────────────────────────────────────────────────────

test('store settings default to disabled and survive a reload', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  await store.ensure('bot_one', { workspace });
  assert.equal(store.conversationDirectorySettingsFor('bot_one').enabled, false);
  await store.setConversationDirectorySettings('bot_one', { enabled: true, strategy: 'per-session' });
  const reloaded = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  assert.deepEqual(reloaded.conversationDirectorySettingsFor('bot_one'), {
    enabled: true,
    strategy: 'per-session',
    prefix: CONVERSATION_DIRECTORY_PREFIX,
  });
});

test('applying a session directory writes the override and the record together', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  await store.ensure('bot_one', { workspace });
  const directory = join(workspace, 'conv-p2p-ou_abc');
  await mkdir(directory);
  const applied = await store.applyConversationSessionDirectory('bot_one', 'p2p:ou_abc', {
    base: workspace,
    directory,
    strategy: 'per-conversation',
  }, { token: store.publishConversationWorkspaceSwitch('bot_one', 'p2p:ou_abc') });
  assert.equal(applied, directory);
  assert.equal(store.conversationWorkspaceFor('bot_one', 'p2p:ou_abc'), directory);
  assert.equal(store.sessionDirectoryFor('bot_one', 'p2p:ou_abc').base, workspace);
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.sessionDirectories.bot_one['p2p:ou_abc'].directory, directory);
});

test('an explicit /conv switch drops the recorded directory so the next Session re-derives one', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  await store.ensure('bot_one', { workspace });
  const directory = join(workspace, 'conv-p2p-ou_abc');
  await mkdir(directory);
  await store.applyConversationSessionDirectory('bot_one', 'p2p:ou_abc', {
    base: workspace,
    directory,
    strategy: 'per-conversation',
  }, { token: store.publishConversationWorkspaceSwitch('bot_one', 'p2p:ou_abc') });
  await store.setConversationWorkspace('bot_one', 'p2p:ou_abc', workspace);
  assert.equal(store.sessionDirectoryFor('bot_one', 'p2p:ou_abc'), null);
  assert.equal(store.conversationWorkspaceFor('bot_one', 'p2p:ou_abc'), workspace);
});

test('a removed bot takes its conversation directory records with it', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  await store.ensure('bot_one', { workspace });
  const directory = join(workspace, 'conv-p2p-ou_abc');
  await mkdir(directory);
  await store.applyConversationSessionDirectory('bot_one', 'p2p:ou_abc', {
    base: workspace,
    directory,
    strategy: 'per-conversation',
  }, { token: store.publishConversationWorkspaceSwitch('bot_one', 'p2p:ou_abc') });
  await store.remove('bot_one');
  assert.equal(store.sessionDirectoryFor('bot_one', 'p2p:ou_abc'), null);
  await assert.rejects(readFile(path, 'utf8'));
});

test('a damaged sessionDirectories section is dropped without failing the document', async (t) => {
  const { workspace, path } = await fixture(t);
  await writeFile(path, `${JSON.stringify({
    version: 3,
    workspaces: { bot_one: workspace },
    sessionDirectories: {
      bot_one: {
        'p2p:ok': { base: workspace, directory: join(workspace, 'conv-a'), strategy: 'per-conversation' },
        'p2p:relative': { base: 'relative', directory: 'relative', strategy: 'per-conversation' },
        'p2p:unknown': { base: workspace, directory: join(workspace, 'conv-b'), strategy: 'per-day' },
      },
    },
  }, null, 2)}\n`);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  assert.ok(store.sessionDirectoryFor('bot_one', 'p2p:ok'));
  assert.equal(store.sessionDirectoryFor('bot_one', 'p2p:relative'), null);
  assert.equal(store.sessionDirectoryFor('bot_one', 'p2p:unknown'), null);
});

// ── Channel-wide switch ──────────────────────────────────────────────────────

test('a channel-wide switch applies to every bot without naming one', async (t) => {
  const { workspace, path } = await fixture(t);
  await writeFile(path, `${JSON.stringify({
    version: 3,
    workspaces: { bot_one: workspace, bot_two: workspace },
    conversationDirectory: { enabled: true },
  }, null, 2)}\n`);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  for (const botId of ['bot_one', 'bot_two']) {
    assert.deepEqual(store.conversationDirectorySettingsFor(botId), {
      enabled: true,
      strategy: 'per-conversation',
      prefix: CONVERSATION_DIRECTORY_PREFIX,
    });
  }
});

test('a per-bot value still overrides the channel-wide switch', async (t) => {
  const { workspace, path } = await fixture(t);
  await writeFile(path, `${JSON.stringify({
    version: 3,
    workspaces: { bot_one: workspace, bot_two: workspace },
    conversationDirectory: { enabled: true },
    conversationDirectories: { bot_two: { enabled: false } },
  }, null, 2)}\n`);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  assert.equal(store.conversationDirectorySettingsFor('bot_one').enabled, true);
  assert.equal(store.conversationDirectorySettingsFor('bot_two').enabled, false);
});

test('the channel-wide switch survives a reload and can be cleared', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  await store.ensure('bot_one', { workspace });
  assert.equal(store.defaultConversationDirectorySettings(), null);
  await store.setDefaultConversationDirectorySettings({ enabled: true, strategy: 'per-session' });

  const reloaded = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  assert.deepEqual(reloaded.defaultConversationDirectorySettings(), {
    enabled: true,
    strategy: 'per-session',
    prefix: CONVERSATION_DIRECTORY_PREFIX,
  });
  assert.equal(reloaded.conversationDirectorySettingsFor('bot_one').strategy, 'per-session');

  await reloaded.setDefaultConversationDirectorySettings(null);
  const cleared = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  assert.equal(cleared.defaultConversationDirectorySettings(), null);
  assert.equal(cleared.conversationDirectorySettingsFor('bot_one').enabled, false);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).conversationDirectory, undefined);
});

test('a channel-wide switch alone keeps the document on disk', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  await store.ensure('bot_one', { workspace });
  await store.setDefaultConversationDirectorySettings({ enabled: true });
  // Removing the only bot must not unlink a file that still holds the switch.
  await store.remove('bot_one');
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.conversationDirectory.enabled, true);
});

test('a damaged channel-wide switch is dropped rather than persisted as a guess', async (t) => {
  const { workspace, path } = await fixture(t);
  await writeFile(path, `${JSON.stringify({
    version: 3,
    workspaces: { bot_one: workspace },
    conversationDirectory: { enabled: 'yes' },
  }, null, 2)}\n`);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  assert.equal(store.defaultConversationDirectorySettings(), null);
  assert.equal(store.conversationDirectorySettingsFor('bot_one').enabled, false);
});

// ── End to end: enable in the persisted document, then send one message ─────

test('an enabled bot creates its Session inside the derived directory', async (t) => {
  const { workspace, path } = await fixture(t);
  // Enable isolation exactly where an operator or a settings client writes it.
  await writeFile(path, `${JSON.stringify({
    version: 3,
    workspaces: { bot_one: workspace },
    conversationDirectories: { bot_one: { enabled: true } },
  }, null, 2)}\n`);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  const created = [];
  const baseHarness = {
    async createSession(options) {
      created.push(options);
      return `session-${created.length}`;
    },
    async ask(sessionId) { return `answer-${sessionId}`; },
    async sessionExists() { return false; },
  };
  let bound = null;
  const state = {
    sessionFor: () => bound,
    async setSession(_key, sessionId) { bound = sessionId; },
    async clearSession() { bound = null; },
  };
  const scope = createBotWorkspaceScope(baseHarness, { botId: 'bot_one', workspaces, state });
  const result = await askInWorkspaceSession({
    harness: scope.harness, state: scope.state, key: 'p2p:ou_abc', text: 'hello',
  });
  assert.equal(result.answer, 'answer-session-1');
  const directory = workspaces.conversationWorkspaceFor('bot_one', 'p2p:ou_abc');
  assert.notEqual(directory, workspace);
  assert.ok(directory.startsWith(join(workspace, CONVERSATION_DIRECTORY_PREFIX)));
  // The directory really exists, and the Session was created inside it.
  assert.equal(await realpath(directory).then(() => true, () => false), true);
  assert.equal(created[0].workspace, directory);
  assert.equal(workspaces.sessionDirectoryFor('bot_one', 'p2p:ou_abc').base, workspace);
  assert.equal(bound, 'session-1');
});

test('a bot that never opted in keeps creating Sessions in its workspace', async (t) => {
  const { workspace, path } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace: workspace }).load();
  await workspaces.ensure('bot_one', { workspace });
  const created = [];
  const scope = createBotWorkspaceScope({
    async createSession(options) { created.push(options); return 'session-1'; },
    async ask() { return 'answer'; },
    async sessionExists() { return false; },
  }, {
    botId: 'bot_one',
    workspaces,
    state: { sessionFor: () => null, async setSession() {} },
  });
  await askInWorkspaceSession({
    harness: scope.harness, state: scope.state, key: 'p2p:ou_abc', text: 'hello',
  });
  assert.equal(created[0].workspace, workspace);
  assert.equal(workspaces.sessionDirectoryFor('bot_one', 'p2p:ou_abc'), null);
});

// ── /workspacelist filtering ─────────────────────────────────────────────────

test('the workspace list hides derived conversation directories unless asked', async (t) => {
  const { workspace, root } = await fixture(t);
  const other = join(root, 'other');
  const directory = join(workspace, `${CONVERSATION_DIRECTORY_PREFIX}p2p-ou_abc-1a2b3c4d`);
  await Promise.all([
    mkdir(other, { recursive: true }),
    mkdir(directory, { recursive: true }),
  ]);
  const harness = {
    async listWorkspaces() { return [workspace, other, directory]; },
    currentWorkspace: () => workspace,
    assertWorkspaceScope() {},
  };
  const hidden = await workspacePathSnapshot(harness);
  assert.ok(hidden.paths.includes(other), 'a normal workspace stays listed');
  assert.ok(!hidden.paths.includes(directory), 'a conversation directory is hidden');
  const shown = await workspacePathSnapshot(harness, { includeSessionDirectories: true });
  assert.ok(shown.paths.includes(directory), '/workspacelist all shows them again');
});
