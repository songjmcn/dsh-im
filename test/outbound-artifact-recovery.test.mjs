import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

async function fixture(t) {
  const workspace = await fs.mkdtemp(join(tmpdir(), 'dsh-im-recovery-test-'));
  const api = await import(`../src/channels/shared/semantic/artifact.mjs?${t.name}`);
  const registry = new api.OutboundArtifactRegistry();
  const session = {
    header: { id: 'recovery-session', cwd: workspace },
    events: [{ type: 'turn/start', data: { turn: 1 } }],
  };
  const close = registry.openConsumer(session.header.id, 'recovery-rpc');
  registry.observeClaimedMessage(session, { source: { rpcId: 'recovery-rpc' } }, 1);
  await fs.writeFile(join(workspace, 'result.txt'), 'recover without restarting');
  const directories = new Set();
  const mkdtemp = fs.mkdtemp;
  t.mock.method(fs, 'mkdtemp', async (...args) => {
    const directory = await mkdtemp(...args);
    directories.add(directory);
    return directory;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    close();
    registry.clear();
    await fs.rm(workspace, { recursive: true, force: true });
    for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directories,
    async send(signal) {
      const artifact = await registry.stage({ path: 'result.txt' }, { agent: { session }, signal });
      try {
        const file = await api.materializeOutboundArtifact(artifact);
        assert.equal(file.bytes.toString(), 'recover without restarting');
      } finally {
        registry.release(artifact);
      }
    },
  };
}

test('file snapshots recover after repeated directory cleanup, including concurrent sends', async (t) => {
  const fx = await fixture(t);
  await fx.send();
  for (let round = 0; round < 2; round += 1) {
    for (const directory of fx.directories) await fs.rm(directory, { recursive: true, force: true });
    await Promise.all(Array.from({ length: 4 }, () => fx.send()));
  }
});

test('file snapshots recover when the directory disappears just before copying', async (t) => {
  const fx = await fixture(t);
  const copyFile = fs.copyFile;
  let copies = 0;
  t.mock.method(fs, 'copyFile', async (...args) => {
    if (++copies === 1) await fs.rm(dirname(args[1]), { recursive: true });
    return copyFile(...args);
  });
  syncBuiltinESMExports();
  await fx.send();
  assert.equal(copies, 2);
});

test('a failed initial temporary directory creation can be retried', async (t) => {
  const fx = await fixture(t);
  const mkdtemp = fs.mkdtemp;
  let attempts = 0;
  t.mock.method(fs, 'mkdtemp', (...args) => {
    if (++attempts === 1) return Promise.reject(Object.assign(new Error('temporary failure'), { code: 'EACCES' }));
    return mkdtemp(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(fx.send(), { code: 'artifact-unavailable' });
  await fx.send();
  assert.equal(attempts, 2);
});

for (const [code, expectedCopies] of [['ENOENT', 2], ['EACCES', 1]]) {
  test(`snapshot ${code} failures do not retry indefinitely or lose their cause`, async (t) => {
    const fx = await fixture(t);
    const cause = Object.assign(new Error('copy failed'), { code });
    let copies = 0;
    t.mock.method(fs, 'copyFile', async () => { copies += 1; throw cause; });
    syncBuiltinESMExports();
    await assert.rejects(fx.send(), (error) => error.code === 'artifact-unavailable' && error.cause === cause);
    assert.equal(copies, expectedCopies);
  });
}

test('snapshot recovery respects cancellation before retrying', async (t) => {
  const fx = await fixture(t);
  const controller = new AbortController();
  let copies = 0;
  t.mock.method(fs, 'copyFile', async () => {
    copies += 1;
    controller.abort();
    throw Object.assign(new Error('directory gone'), { code: 'ENOENT' });
  });
  syncBuiltinESMExports();
  await assert.rejects(fx.send(controller.signal), { name: 'AbortError' });
  assert.equal(copies, 1);
});
