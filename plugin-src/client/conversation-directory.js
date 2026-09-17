import * as React from 'react';

import {
  CONVERSATION_DIRECTORY_STRATEGIES,
  DEFAULT_CONVERSATION_DIRECTORY_SETTINGS,
  normalizeConversationDirectorySettings,
  validateConversationDirectorySettings,
} from '../../src/channels/shared/conversation-directory.mjs';
import { h } from './i18n.js';

const STRATEGY_LABELS = Object.freeze({
  'per-conversation': '每对话一个目录',
  'per-session': '每会话一个目录',
});

/**
 * Compact isolation switch: enabled / strategy / prefix. Saves as one atomic
 * config object so a damaged field never leaves a half-written toggle.
 */
export function ConversationDirectoryEditor({ config, disabled = false, onSave }) {
  const settings = normalizeConversationDirectorySettings(config);
  const [enabled, setEnabled] = React.useState(settings.enabled);
  const [strategy, setStrategy] = React.useState(settings.strategy);
  const [prefix, setPrefix] = React.useState(settings.prefix);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    setEnabled(settings.enabled);
    setStrategy(settings.strategy);
    setPrefix(settings.prefix);
  }, [settings.enabled, settings.strategy, settings.prefix]);

  const save = React.useCallback(async (next) => {
    const payload = {
      enabled: next.enabled,
      strategy: next.strategy,
      prefix: next.prefix || DEFAULT_CONVERSATION_DIRECTORY_SETTINGS.prefix,
    };
    try {
      validateConversationDirectorySettings(payload);
    } catch (cause) {
      setError(cause?.message ?? '会话目录设置无效。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave?.(payload);
    } catch (cause) {
      setError(cause?.message ?? '会话目录设置保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  const busy = disabled || saving;

  return h('div', { className: 'dim-conversationDirectory' },
    h('div', { className: 'dim-workspaceHeader' },
      h('span', null, '会话目录隔离'),
      h('label', { className: 'dim-contextSwitchRow' },
        h('span', { className: 'dim-contextSwitchLabel' }, enabled ? '已开启' : '已关闭'),
        h('input', {
          type: 'checkbox',
          role: 'switch',
          className: 'dim-contextSwitch',
          checked: enabled,
          disabled: busy,
          onChange: (event) => {
            const nextEnabled = event.target.checked;
            setEnabled(nextEnabled);
            void save({ enabled: nextEnabled, strategy, prefix });
          },
        }))),
    enabled ? h('div', { className: 'dim-conversationDirectoryFields' },
      h('label', { className: 'dim-conversationDirectoryField' },
        h('span', null, '策略'),
        h('select', {
          value: strategy,
          disabled: busy,
          onChange: (event) => {
            const nextStrategy = event.target.value;
            setStrategy(nextStrategy);
            void save({ enabled, strategy: nextStrategy, prefix });
          },
        }, CONVERSATION_DIRECTORY_STRATEGIES.map((value) => h('option', {
          key: value,
          value,
        }, STRATEGY_LABELS[value] ?? value)))),
      h('label', { className: 'dim-conversationDirectoryField' },
        h('span', null, '前缀'),
        h('input', {
          type: 'text',
          value: prefix,
          disabled: busy,
          maxLength: 32,
          onChange: (event) => setPrefix(event.target.value),
          onBlur: () => {
            if (prefix !== settings.prefix) void save({ enabled, strategy, prefix });
          },
        })),
      h('div', { className: 'dim-summary' },
        '开启后工作目录按对话自动派生；/workspace、/conv 与手动改工作区不可用；/session 仅可绑定本目录内会话。'),
    ) : null,
    error ? h('div', { className: 'dim-summary dim-cardFeedback', role: 'alert' }, error) : null,
  );
}
