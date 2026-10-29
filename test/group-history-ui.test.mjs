import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { GlobalSettingsPanel } from '../plugin-src/client/global-settings.js';

test('General tab configures sidebar and retention and retains Attachments navigation', async () => {
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'settings.sidebar-entry.get') return { ok: true, value: { mode: 'auto', visible: true } };
    if (endpoint === 'settings.group-history.get') return { ok: true, value: { groupHistoryRetentionDays: 14 } };
    if (endpoint === 'settings.group-history.set') return { ok: true, value: payload };
    if (endpoint === 'settings.inbound-ttl.get') return { ok: true, value: { ttlHours: 24 } };
    return { ok: false, error: { message: 'unexpected endpoint' } };
  };
  let renderer;
  await act(async () => { renderer = create(React.createElement(GlobalSettingsPanel, { rpcCall })); });
  const input = () => renderer.root.findByProps({ type: 'number' });
  assert.equal(input().props.value, '14');
  assert.equal(renderer.root.findAllByProps({ role: 'switch' }).length, 0);
  assert.equal(renderer.root.findAllByProps({ className: 'dim-groupHistoryList' }).length, 0);
  assert.deepEqual(calls.map((call) => call.endpoint), ['settings.sidebar-entry.get', 'settings.group-history.get']);
  assert.equal(renderer.root.findAllByProps({ type: 'submit' }).length, 1,
    'only retention settings need a Save button');
  assert.equal(renderer.root.findByProps({ 'aria-label': '侧边栏入口' }).findAllByType('form').length, 0);
  const form = () => renderer.root.findByProps({ 'aria-label': '群聊天记录' }).findByType('form');
  await act(async () => { input().props.onChange({ target: { value: '0' } }); });
  await act(async () => { await form().props.onSubmit({ preventDefault() {} }); });
  assert.equal(calls.filter((call) => call.endpoint.endsWith('.set')).length, 0);
  await act(async () => { input().props.onChange({ target: { value: '30' } }); });
  await act(async () => { await form().props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(calls.at(-1), { endpoint: 'settings.group-history.set', payload: { groupHistoryRetentionDays: 30 } });
  await act(async () => { renderer.root.findByProps({ id: 'dim-general-settings-tab-attachments' }).props.onClick(); });
  assert.equal(renderer.root.findByProps({ id: 'dim-globalTtlInput' }).props.value, '24');
  act(() => renderer.unmount());
});
