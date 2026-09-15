// Durable host-side settings and per-conversation activity log for session
// timeout. Mirrors ./inbound-ttl-store.mjs: same atomic write discipline
// (private temp file + rename), same damage-safe fallback (unreadable →
// disabled), and the same settings.json document version so both features
// share one file without a version bump.

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  DEFAULT_SESSION_TIMEOUT_SETTINGS,
  normalizeSessionTimeoutSettings,
} from './session-timeout.mjs';

const DOCUMENT_VERSION = 1;
// Damage fallback: an unreadable document never starts timeout cleanup — it
// must not widen into session unbinding on a corrupted settings file. This
// mirrors inbound-ttl-store's keep-forever-on-damage stance.
const UNREADABLE_SESSION_TIMEOUT_SETTINGS = Object.freeze({
  ...DEFAULT_SESSION_TIMEOUT_SETTINGS,
  enabled: false,
});

function invalidSessionTimeoutError() {
  const error = new Error('Invalid session timeout settings.');
  error.code = 'session-timeout-invalid';
  return error;
}

// Atomic write copy of writeSettingsDocument in inbound-ttl-store. Kept inline
// to avoid importing across modules; the contract is identical.
async function writeSettingsDocument(path, document) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * Durable host-side store for the conversation session-timeout feature.
 *
 * Two responsibilities live in one settings.json document:
 *   1. The `sessionTimeout` sub-object — runtime settings (`enabled`,
 *      `timeoutMinutes`, …) modified via the settings RPC.
 *   2. The `sessionActivity` sub-object — per-conversationKey activity
 *      records (`lastActivityAt`, `runningSince`, `sessionId`) touched by
 *      the service on every user message and turn-end event.
 *
 * The activity log is co-located with settings so a restart can rebuild the
 * pending-expiry view without a separate file; it is additive, so older
 * documents that lack it simply start every conversation as untracked.
 */
export class SessionTimeoutStore {
  #path;
  /** @type {ReturnType<typeof normalizeSessionTimeoutSettings>} */
  #settings = structuredClone(DEFAULT_SESSION_TIMEOUT_SETTINGS);
  /** @type {Map<string, {botId:string, sessionId?:string, lastActivityAt:number, runningSince?:number}>} */
  #activity = new Map();
  /** Inbound TTL and a sibling feature share this document; the store keeps
   *  only the two sub-objects it owns. Persisting the whole document would
   *  clobber inboundAttachmentTtlHours when only this feature changed. */
  #inboundTtlHours = 168;

  constructor(path) {
    if (typeof path !== 'string' || !path) {
      throw new TypeError('session timeout store path is required');
    }
    this.#path = path;
  }

  /**
   * `true` after a load() that found no settings.json (ENOENT) or a
   * document with no `sessionTimeout` sub-object. Lets the runtime apply
   * host-config defaults as the initial persisted values rather than
   * inheriting the in-memory defaults (which keep scanning disabled).
   */
  #wasFresh = false;

  /**
   * Missing = first run. Damaged or future version falls back to disabled +
   * defaults, so an unreadable intent can never widen into session unbinding.
   */
  async load() {
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#settings = structuredClone(DEFAULT_SESSION_TIMEOUT_SETTINGS);
      this.#activity = new Map();
      this.#inboundTtlHours = 168;
      this.#wasFresh = true;
      await this.#removeStaleTemporaries();
      return this;
    }
    const read = this.#readDocument(raw);
    this.#settings = read.settings;
    this.#activity = read.activity;
    this.#inboundTtlHours = read.inboundTtlHours;
    this.#wasFresh = read.fresh;
    await this.#removeStaleTemporaries();
    return this;
  }

  /** Whether the last load() observed a fresh or sessionTimeout-less document. */
  wasFresh() {
    return this.#wasFresh;
  }

  async #removeStaleTemporaries() {
    const directory = dirname(this.#path);
    const prefix = `${basename(this.#path)}.`;
    try {
      const entries = await readdir(directory);
      await Promise.all(entries
        .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
        .map((name) => unlink(join(directory, name)).catch(() => {})));
    } catch {
      // Best-effort cleanup of interrupted atomic writes.
    }
  }

  /**
   * Parse a settings document. Both `sessionTimeout` and `sessionActivity`
   * are additive sub-objects: an absent or malformed either one falls back
   * to its safe default rather than poisoning the whole store.
   *
   * @param {string} raw
   */
  #readDocument(raw) {
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      return {
        settings: structuredClone(UNREADABLE_SESSION_TIMEOUT_SETTINGS),
        activity: new Map(),
        inboundTtlHours: 168,
        fresh: false,
      };
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return {
        settings: structuredClone(UNREADABLE_SESSION_TIMEOUT_SETTINGS),
        activity: new Map(),
        inboundTtlHours: 168,
        fresh: false,
      };
    }
    // Version mismatch is treated like damage: a future or rolled-back file
    // keeps the sweeper disabled until someone explicitly saves settings.
    if (document.version !== DOCUMENT_VERSION) {
      return {
        settings: structuredClone(UNREADABLE_SESSION_TIMEOUT_SETTINGS),
        activity: new Map(),
        inboundTtlHours: 168,
        fresh: false,
      };
    }
    // Fresh = the document does not yet carry a sessionTimeout sub-object;
    // the runtime can then seed host-config defaults as the initial values.
    const fresh = document.sessionTimeout === undefined;
    const settings = normalizeSessionTimeoutSettings(document.sessionTimeout);
    const activity = this.#readActivity(document.sessionActivity);
    const inboundTtlHours = typeof document.inboundAttachmentTtlHours === 'number'
      ? document.inboundAttachmentTtlHours
      : 168;
    return { settings, activity, inboundTtlHours, fresh };
  }

  #readActivity(raw) {
    const activity = new Map();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return activity;
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key !== 'string' || !key) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const lastActivityAt = Number(value.lastActivityAt);
      const sessionId = typeof value.sessionId === 'string' ? value.sessionId : undefined;
      const botId = typeof value.botId === 'string' ? value.botId : undefined;
      if (!Number.isFinite(lastActivityAt) || !botId) continue;
      const record = {
        botId,
        ...(sessionId ? { sessionId } : {}),
        lastActivityAt: Math.trunc(lastActivityAt),
      };
      const runningSince = Number(value.runningSince);
      if (Number.isFinite(runningSince)) record.runningSince = Math.trunc(runningSince);
      activity.set(key, record);
    }
    return activity;
  }

  getSettings() {
    return structuredClone(this.#settings);
  }

  async setSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw invalidSessionTimeoutError();
    }
    const validated = Object.fromEntries(
      Object.entries(patch).filter(([field]) =>
        Object.prototype.hasOwnProperty.call(DEFAULT_SESSION_TIMEOUT_SETTINGS, field)),
    );
    if (Object.keys(validated).length === 0) {
      throw invalidSessionTimeoutError();
    }
    // Merge into the current settings so a single-field RPC patch preserves
    // every other field's previously saved value.
    const next = normalizeSessionTimeoutSettings({
      ...this.#settings,
      ...validated,
    });
    // Atomically persist the whole document so inbound-ttl's field survives.
    await writeSettingsDocument(this.#path, {
      version: DOCUMENT_VERSION,
      ...(typeof this.#inboundTtlHours === 'number'
        ? { inboundAttachmentTtlHours: this.#inboundTtlHours } : {}),
      sessionTimeout: structuredClone(next),
      ...(this.#activity.size > 0 ? { sessionActivity: this.#serializeActivity() } : {}),
    });
    this.#settings = structuredClone(next);
    return structuredClone(next);
  }

  getTracked(key) {
    const record = this.#activity.get(key);
    if (!record) return null;
    return { ...record };
  }

  listTracked() {
    return [...this.#activity.entries()].map(([key, record]) => ({ key, ...record }));
  }

  /**
   * Record activity on a conversation. `at` defaults to now; `runningSince`
   * hints the service's protection window is open so a long turn never gets
   * expired mid-flight. Activity is flushed to disk so a restart can still
   * see the pending expiry window.
   */
  async track(key, { botId, sessionId, at = Date.now(), runningSince } = {}) {
    if (typeof key !== 'string' || !key || typeof botId !== 'string' || !botId) {
      throw new TypeError('session timeout track requires a key and botId');
    }
    const record = { botId, lastActivityAt: at };
    if (typeof sessionId === 'string' && sessionId) record.sessionId = sessionId;
    if (Number.isFinite(runningSince)) record.runningSince = Math.trunc(runningSince);
    this.#activity.set(key, record);
    await this.#persistActivity();
    return record;
  }

  async clearTracked(key) {
    if (this.#activity.delete(key)) await this.#persistActivity();
  }

  /** Only persist the activity sub-tree; settings writes already touched disk. */
  async #persistActivity() {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const document = JSON.parse(raw);
      if (!document || typeof document !== 'object' || Array.isArray(document)) return;
      if (this.#activity.size === 0) {
        delete document.sessionActivity;
      } else {
        document.sessionActivity = this.#serializeActivity();
      }
      await writeSettingsDocument(this.#path, document);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // First persistence: create the document the store owns stand-alone.
        await writeSettingsDocument(this.#path, {
          version: DOCUMENT_VERSION,
          ...(typeof this.#inboundTtlHours === 'number'
            ? { inboundAttachmentTtlHours: this.#inboundTtlHours } : {}),
          sessionTimeout: structuredClone(this.#settings),
          ...(this.#activity.size > 0 ? { sessionActivity: this.#serializeActivity() } : {}),
        });
      } else {
        throw error;
      }
    }
  }

  #serializeActivity() {
    const out = {};
    for (const [key, record] of this.#activity.entries()) {
      const value = { botId: record.botId, lastActivityAt: record.lastActivityAt };
      if (record.sessionId) value.sessionId = record.sessionId;
      if (Number.isFinite(record.runningSince)) value.runningSince = record.runningSince;
      out[key] = value;
    }
    return out;
  }
}
