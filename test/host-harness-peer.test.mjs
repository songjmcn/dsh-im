import assert from 'node:assert/strict';
import test from 'node:test';

import { harnessConnection } from '../plugin-src/host/harness-connection.mjs';
import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';
import { createHarnessCommandExecutor } from '../plugin-src/host/harness-command-executor.mjs';
import { runClearCommand } from '../src/channels/shared/clear-command.mjs';

const clients = [
  ['weixin', 'HarnessClient'], ['qq', 'QqHarnessClient'], ['feishu', 'HarnessClient'],
  ['dingtalk', 'HarnessClient'], ['wecom', 'WecomHarnessClient'], ['wecom-app', 'WecomAppHarnessClient'],
  ['telegram', 'TelegramHarnessClient'], ['discord', 'DiscordHarnessClient'], ['slack', 'SlackHarnessClient'],
  ['whatsapp', 'WhatsappHarnessClient'], ['imessage', 'IMessageHarnessClient'], ['email', 'EmailHarnessClient'],
  ['matrix', 'MatrixHarnessClient'], ['office', 'HarnessClient'],
];

function fixture() {
  const lifetime = new AbortController();
  const calls = [], created = [], effects = [];
  let disposals = 0;
  const peer = {
    principal: { kind: 'owner' }, signal: lifetime.signal,
    async dispose() { disposals += 1; lifetime.abort(); },
  };
  function accept(request) {
    assert.equal(request.peer, peer, 'both unary and streaming requests must carry the Host-created peer');
    assert.equal(request.peer.signal.aborted, false);
    assert.ok(request.signal instanceof AbortSignal);
    calls.push(request);
  }
  const ctx = {
    root: {},
    connection: { createPeer(options) { created.push(options); return peer; } },
    typertGateway: {
      async invoke(request) {
        accept(request);
        switch (`${request.namespace}/${request.method}`) {
          case 'session/create': return { sessionId: 'session' };
          case 'session/modelCatalog': return { groups: [], failures: [] };
          case 'commands/execute': return { result: { kind: 'success' } };
          default: throw new Error(`Unexpected endpoint ${request.namespace}/${request.method}`);
        }
      },
      async *stream(request) {
        accept(request);
        if (request.namespace === 'workspace' && request.method === 'follow') {
          yield { type: 'baseline', value: {
            items: [{ path: '/workspace', workspaceId: 'workspace' }], archivedSessionIds: [],
          } };
        } else if (request.namespace === 'session' && request.method === 'follow') {
          yield { type: 'snapshot', cursor: -1, records: [], hasMore: false };
        } else {
          throw new Error(`Unexpected stream ${request.namespace}/${request.method}`);
        }
      },
    },
    on() { return () => {}; },
    effect(setup) { effects.push(setup()); },
  };
  return { ctx, peer, calls, created, effects,
    dispose: () => Promise.all(effects.map(dispose => dispose())),
    get disposals() { return disposals; } };
}

for (const [channel, exportName] of clients) {
  test(`${channel} sends a live Host peer when preparing new and existing sessions and reading models`, async () => {
    const f = fixture();
    const directory = channel === 'office' ? 'shared' : channel;
    const file = channel === 'matrix' ? 'matrix-harness-client' : 'harness-client';
    const { [exportName]: Client } = await import(`../src/channels/${directory}/${file}.mjs`);
    const client = new Client({ ...harnessConnection(f.ctx), workspace: '/workspace',
      commandExecutor: createHarnessCommandExecutor(f.ctx) });
    try {
      assert.equal(await client.createSession(), 'session');
      assert.equal(await client.sessionExists('session'), true);
      assert.deepEqual(await client.listModels(), { groups: [], failures: [] });
      for (const line of ['/compact', '/clear', '/permission workspace-write']) {
        assert.deepEqual(await client.executeCommand('session', line, { signal: new AbortController().signal }),
          { result: { kind: 'success' } });
      }
      assert.equal(f.calls.filter(request => request.namespace === 'commands').length, 3);
      assert.deepEqual(f.created, [{ principal: { kind: 'owner' }, interactions: 'none' }]);
      assert.ok(f.calls.some(request => request.namespace === 'session' && request.method === 'create'));
      assert.ok(f.calls.some(request => request.namespace === 'workspace' && request.method === 'follow'));
      assert.equal(f.peer.signal.aborted, false, 'closing a baseline stream must not dispose the shared peer');
    } finally {
      for (const dispose of f.effects) await dispose();
    }
    assert.equal(f.disposals, 1);
    assert.equal(f.peer.signal.aborted, true);
  });
}

test('one peer is shared by a Host adapter, released on unload, and replaced on reload', async () => {
  const f = fixture();
  const api = modernHarnessApi(f.ctx);
  assert.equal(modernHarnessApi({ ...f.ctx }), api);
  assert.equal(f.created.length, 1);
  let finish;
  f.peer.dispose = () => {
    finish = Promise.withResolvers();
    return finish.promise;
  };
  const pending = f.dispose();
  assert.ok(pending instanceof Promise, 'the Host must await peer disposal');
  finish.resolve();
  await pending;
  const reloaded = fixture();
  reloaded.ctx.root = f.ctx.root;
  assert.notEqual(modernHarnessApi(reloaded.ctx), api);
  assert.equal(reloaded.created.length, 1);
  assert.notEqual(reloaded.peer, f.peer);
  assert.equal(reloaded.peer.signal.aborted, false);
  await reloaded.dispose();
  const other = fixture();
  assert.notEqual(modernHarnessApi(other.ctx), api);
  assert.equal(other.created.length, 1);
  await other.dispose();
});

test('older Hosts without createPeer retain their existing request format', async () => {
  const f = fixture();
  f.ctx.connection = {};
  f.ctx.typertGateway.invoke = async request => {
    assert.equal(Object.hasOwn(request, 'peer'), false);
    return { items: [] };
  };
  const api = modernHarnessApi(f.ctx);
  await createHarnessCommandExecutor(f.ctx)('session', '/compact');
  assert.deepEqual(await api.sessions.list({ rpcId: 'legacy', payload: {} }), {
    rpcId: 'legacy', result: { ok: true, value: { items: [] } },
  });
  await f.dispose();
  assert.equal(f.created.length, 0);
});

test('commands initialized first share one peer with other channels and the session adapter', async () => {
  const f = fixture();
  const first = createHarnessCommandExecutor(f.ctx);
  const second = createHarnessCommandExecutor({ ...f.ctx });
  modernHarnessApi(f.ctx);
  const signal = new AbortController().signal;
  await first('one', '/compact', { signal });
  await second('two', '/clear', { signal });
  assert.equal(f.created.length, 1);
  await f.dispose();
  assert.equal(f.disposals, 1);
});

for (const field of [null, 'submittedAttachments']) {
  test(`command argument adaptation to ${field ?? 'no attachments'} preserves its peer and executes once`, async () => {
    const f = fixture();
    let attempts = 0, executions = 0;
    const signal = new AbortController().signal;
    f.ctx.typertGateway.invoke = async request => {
      attempts++;
      assert.equal(request.peer, f.peer);
      assert.equal(request.peer.signal.aborted, false);
      assert.equal(request.signal, signal);
      if (Object.hasOwn(request.args, 'images')) {
        throw Object.assign(new Error('typert gateway: commands/execute: args fields do not match the descriptor: '
          + (field ? 'missing "submittedAttachments"; ' : '') + 'unexpected "images"'), {
          name: 'TypertGatewayError', code: 'gateway/arguments-invalid', endpoint: 'commands/execute',
        });
      }
      assert.deepEqual(request.args, { agentId: 'session', line: '/compact', ...(field ? { [field]: [] } : {}) });
      executions++;
      return { result: { kind: 'success' } };
    };
    await createHarnessCommandExecutor(f.ctx)('session', '/compact', { signal });
    assert.equal(attempts, 2);
    assert.equal(executions, 1);
    await f.dispose();
    assert.equal(f.disposals, 1);
  });
}

test('a command-only peer is released on unload and recreated on reload', async () => {
  const f = fixture();
  createHarnessCommandExecutor(f.ctx);
  await f.dispose();
  assert.equal(f.disposals, 1);
  const next = fixture();
  next.ctx.root = f.ctx.root;
  await createHarnessCommandExecutor(next.ctx)('session', '/clear', { signal: new AbortController().signal });
  assert.equal(next.created.length, 1);
  await next.dispose();
});

test('an explicit command executor does not allocate a Host peer', () => {
  const f = fixture();
  const provided = async () => {};
  assert.equal(createHarnessCommandExecutor(f.ctx, provided), provided);
  assert.equal(f.created.length, 0);
});

test('an unregistered /clear reaches the Host with its peer and reports unsupported without rebinding', async () => {
  const f = fixture();
  let calls = 0;
  const signal = new AbortController().signal;
  f.ctx.typertGateway.invoke = async request => {
    calls++;
    assert.equal(request.peer, f.peer);
    assert.equal(request.peer.signal.aborted, false);
    assert.equal(request.signal, signal);
    assert.deepEqual(request.args, { agentId: 'session', line: '/clear', images: [] });
    return undefined; // DSH 0.2.1-rc.2 does not register /clear.
  };
  try {
    const result = await runClearCommand('/clear', {
      executeCommand: createHarnessCommandExecutor(f.ctx),
      createSession: () => assert.fail('/clear must not fall back to /new'),
    }, {
      sessionFor: () => 'session',
      bindSession: () => assert.fail('unsupported /clear must preserve the Session binding'),
    }, 'direct:test', { signal });
    assert.match(result.message, /当前 Host 不支持 \/clear，当前会话未修改/);
    assert.equal(calls, 1);
  } finally {
    await f.dispose();
  }
});
