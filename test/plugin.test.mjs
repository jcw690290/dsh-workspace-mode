import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { apply, inject, name, normalizeConfig } from '../lib/index.js';

const base = resolve(join('/', 'srv', 'work'));
const PRESETS = {
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
};

function createSession(cwd, overrides = {}) {
  return {
    id: 'session-' + Math.random().toString(36).slice(2),
    header: { cwd },
    permissions: { preset: null, sandbox: null, approval: null, seeded: false },
    ...overrides,
  };
}

/**
 * Minimal host context: event ordering mirrors cordis (prepend unshifts),
 * permissionPresets models the durable session projection update on set().
 */
function createHost() {
  const listeners = [];
  const calls = [];
  const ctx = {
    on(event, listener, options = {}) {
      const entry = { event, listener, options };
      if (event === 'session/created') {
        if (options?.prepend) listeners.unshift(entry);
        else listeners.push(entry);
      }
      return () => {};
    },
    permissionPresets: {
      names: Object.keys(PRESETS),
      permissionState: (session) => session.permissions,
      set(session, preset) {
        calls.push({ session, preset });
        const spec = PRESETS[preset];
        session.permissions = { preset, sandbox: spec.sandbox, approval: spec.approval, seeded: false };
      },
    },
  };
  return { ctx, listeners, calls };
}

function createCtx(plugConfig = { rules: [] }) {
  const host = createHost();
  apply(host.ctx, plugConfig);
  return host;
}

function emitCreated(host, session) {
  for (const entry of host.listeners) entry.listener(session);
}

/** What @deepseek-ai/dsh-permission-presets does for a session/created event. */
function registerDefaultPin(host, preset = 'workspace-write') {
  host.ctx.on('session/created', (session) => {
    const state = session.permissions;
    if (state.preset === null && state.sandbox === null && state.approval === null && state.seeded !== true) {
      session.permissions = { preset, sandbox: PRESETS[preset].sandbox, approval: PRESETS[preset].approval, seeded: false };
    }
  });
}

test('exports a host plugin contract', () => {
  assert.equal(name, 'workspace-mode');
  assert.deepEqual(inject, ['permissionPresets']);
  assert.equal(typeof apply, 'function');
});

test('matched workspace wins over the default pin', () => {
  const host = createCtx({ rules: [{ path: join(base, 'client'), preset: 'danger-full-access' }] });
  registerDefaultPin(host);
  const session = createSession(join(base, 'client', 'src'));
  emitCreated(host, session);
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].preset, 'danger-full-access');
  assert.equal(session.permissions.preset, 'danger-full-access');
  assert.equal(session.permissions.sandbox, 'danger-full-access');
});

test('unmatched workspace keeps the default pin', () => {
  const host = createCtx({ rules: [{ path: join(base, 'client'), preset: 'danger-full-access' }] });
  registerDefaultPin(host);
  const session = createSession(join(base, 'other'));
  emitCreated(host, session);
  assert.equal(host.calls.length, 0);
  assert.equal(session.permissions.preset, 'workspace-write');
});

test('resumed sessions keep their own permission facts', () => {
  const host = createCtx({ rules: [{ path: join(base, 'client'), preset: 'danger-full-access' }] });
  const session = createSession(join(base, 'client'), {
    permissions: { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask', seeded: true },
  });
  emitCreated(host, session);
  assert.equal(host.calls.length, 0);
  assert.equal(session.permissions.preset, 'workspace-write');
});

test('sessions without a workspace are ignored', () => {
  const host = createCtx({ rules: [{ path: join(base, 'client'), preset: 'danger-full-access' }] });
  emitCreated(host, createSession(undefined));
  emitCreated(host, { id: 'x' });
  assert.equal(host.calls.length, 0);
});

test('subagents are skipped unless includeSubagents is true', () => {
  const rules = [{ path: base, preset: 'danger-full-access' }];
  const skipped = createCtx({ rules });
  const parented = createSession(join(base, 'client'), { header: { cwd: join(base, 'client'), parentSession: 'parent-1' } });
  emitCreated(skipped, parented);
  assert.equal(skipped.calls.length, 0);

  const included = createCtx({ rules, includeSubagents: true });
  const child = createSession(join(base, 'client'), { header: { cwd: join(base, 'client'), parentSession: 'parent-1' } });
  emitCreated(included, child);
  assert.equal(included.calls.length, 1);
});

test('the longest matching rule wins', () => {
  const host = createCtx({
    rules: [
      { path: base, preset: 'workspace-write' },
      { path: join(base, 'client'), preset: 'danger-full-access' },
    ],
  });
  const session = createSession(join(base, 'client', 'nested'));
  emitCreated(host, session);
  assert.equal(session.permissions.preset, 'danger-full-access');
});

test('the listener is registered with prepend', () => {
  const host = createCtx({ rules: [{ path: base, preset: 'workspace-write' }] });
  assert.equal(host.listeners.length, 1);
  assert.equal(host.listeners[0].options.prepend, true);
});

test('unknown preset names fail activation', () => {
  const host = createHost();
  assert.throws(() => apply(host.ctx, { rules: [{ path: base, preset: 'nope' }] }), /unknown permission preset/);
});

test('invalid configs fail activation', () => {
  const host = createHost();
  assert.throws(() => apply(host.ctx, { rules: 'nope' }), /rules must be an array/);
  assert.throws(() => apply(host.ctx, { rules: [{}] }), /path must be a non-empty string/);
  assert.throws(() => apply(host.ctx, { rules: [{ path: base }] }), /preset must be a non-empty string/);
  assert.throws(() => apply(host.ctx, { rules: [{ path: 'relative', preset: 'workspace-write' }] }), /absolute directory/);
  assert.throws(() => apply(host.ctx, { includeSubagents: 'yes' }), /includeSubagents must be a boolean/);
});

test('empty config is a no-op', () => {
  const host = createCtx();
  registerDefaultPin(host);
  const session = createSession(join(base, 'client'));
  emitCreated(host, session);
  assert.equal(host.calls.length, 0);
  assert.equal(session.permissions.preset, 'workspace-write');
});

test('normalizeConfig defaults are platform aware', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config.rules, []);
  assert.equal(config.includeSubagents, false);
  assert.equal(config.caseSensitive, process.platform !== 'win32' && process.platform !== 'darwin');
});
