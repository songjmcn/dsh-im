import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { harnessConnection } from '../plugin-src/host/harness-connection.mjs';
import { HarnessClient as FeishuClient } from '../src/channels/feishu/harness-client.mjs';
import { WecomHarnessClient } from '../src/channels/wecom/harness-client.mjs';

function fixture(t, Client, { blank = false, archived = false, ungrouped = false, cwd = '/workspace' } = {}) {
  const calls = [], effects = [];
  const peer = { signal: new AbortController().signal, dispose() {} };
  const header = { id: 'existing', cwd, agentPreset: 'saved-preset' };
  const workspace = { workspaceId: 'workspace', path: cwd, sessionIds: ['existing'] };
  let snapshotError;
  const ctx = {
    root: {},
    connection: { createPeer: () => peer },
    effect: setup => effects.push(setup()),
    typertGateway: {
      async invoke(request) {
        assert.equal(request.peer, peer);
        calls.push(request);
        if (request.method === 'list') return { items: [{
          sessionId: 'existing', cwd, blank,
          projections: { values: { title: 'Saved conversation' } },
        }] };
        // DSH 0.2.1-rc.2 creates a different Session for an existing conversation.
        if (request.method === 'create') return { sessionId: 'unexpected-new-session' };
        assert.fail(`Unexpected mutation: ${request.namespace}/${request.method}`);
      },
      async *stream(request) {
        assert.equal(request.peer, peer);
        assert.ok(request.signal instanceof AbortSignal);
        calls.push(request);
        if (request.namespace === 'workspace') {
          yield { type: 'baseline', value: {
            items: ungrouped ? [] : [workspace], archivedSessionIds: archived ? ['existing'] : [],
          } };
          return;
        }
        assert.deepEqual(request.args.request.address, { kind: 'session', sessionId: 'existing' });
        if (snapshotError) throw snapshotError;
        yield { type: 'snapshot', header, cursor: 42, records: [], hasMore: false };
      },
    },
  };
  t.after(async () => { for (const dispose of effects) await dispose(); });
  const client = new Client({ ...harnessConnection(ctx), workspace: cwd, agentPreset: 'bot-preset',
    ungroupedWorkspace: ungrouped ? cwd : undefined });
  return { client, calls, header, workspace, ctx, failSnapshot(error) { snapshotError = error; } };
}

for (const [channel, Client] of [['feishu', FeishuClient], ['wecom', WecomHarnessClient]]) {
  for (const config of [{ blank: false }, { blank: true }, { archived: true }]) {
    test(`${channel} binds ${JSON.stringify(config)} without creating or reconfiguring a Session`, async t => {
      const f = fixture(t, Client, config);
      assert.deepEqual(await f.client.adoptWorkspaceSession('existing'), {
        sessionId: 'existing', workspace: '/workspace', title: 'Saved conversation', archived: config.archived === true,
      });
      assert.ok(f.calls.some(call => call.namespace === 'session' && call.method === 'follow'));
      assert.ok(f.calls.every(call => ['follow', 'list'].includes(call.method)));
    });
  }
}

test('creating a new Session still uses the Host creation endpoint', async t => {
  const f = fixture(t, FeishuClient);
  assert.equal(await f.client.createSession(), 'unexpected-new-session');
  assert.deepEqual(f.calls.find(call => call.method === 'create').args, {
    request: { workspaceId: 'workspace', agentPreset: 'bot-preset' },
  });
});

test('ungrouped Session adoption preserves its directory without creating a Session or workspace', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-im-adopt-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const f = fixture(t, FeishuClient, { ungrouped: true, cwd });
  assert.equal((await f.client.adoptWorkspaceSession('existing')).workspace, cwd);
  assert.ok(f.calls.every(call => ['follow', 'list'].includes(call.method)));
});

for (const [patch, code] of [
  [{ id: 'other' }, 'internal'],
  [{ cwd: undefined }, 'internal'],
  [{ cwd: '/other' }, 'session-workspace-ambiguous'],
  [{ origin: 'subagent' }, 'session-subagent-unsupported'],
]) {
  test(`adoption rejects a conflicting snapshot ${JSON.stringify(patch)} without creating a replacement`, async t => {
    const f = fixture(t, FeishuClient);
    Object.assign(f.header, patch);
    await assert.rejects(f.client.adoptWorkspaceSession('existing'), { code });
    assert.ok(f.calls.every(call => ['follow', 'list'].includes(call.method)));
  });
}

test('adoption rechecks workspace membership after the initial list', async t => {
  const f = fixture(t, FeishuClient);
  const stream = f.ctx.typertGateway.stream;
  f.ctx.typertGateway.stream = request => {
    if (request.namespace === 'session') f.workspace.sessionIds = [];
    return stream(request);
  };
  await assert.rejects(f.client.adoptWorkspaceSession('existing'), { code: 'session-workspace-ambiguous' });
  assert.ok(f.calls.every(call => ['follow', 'list'].includes(call.method)));
});

for (const error of [
  Object.assign(new Error('Session disappeared'), { isDSHRemoteError: true, code: 'session/not-found' }),
  new DOMException('Cancelled', 'AbortError'),
]) {
  test(`adoption propagates ${error.name} without falling back to creation`, async t => {
    const f = fixture(t, WecomHarnessClient);
    f.failSnapshot(error);
    await assert.rejects(f.client.adoptWorkspaceSession('existing'), {
      code: error.name === 'AbortError' ? 'cancelled' : 'session/not-found',
    });
    assert.ok(f.calls.every(call => ['follow', 'list'].includes(call.method)));
  });
}
