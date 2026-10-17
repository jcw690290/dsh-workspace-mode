import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { apply, Config, normalizeConfig } from '../lib/index.js';

const base = resolve(join('/', 'srv', 'work'));
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
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

function emitCreated(host, session) {
  for (const entry of host.listeners) entry.listener(session);
}

test('a workspaces entry applies to sessions below the directory', () => {
  const host = createHost();
  apply(host.ctx, { workspaces: { [join(base, 'client')]: 'danger-full-access' } });
  const session = createSession(join(base, 'client', 'src'));
  emitCreated(host, session);
  assert.equal(host.calls.length, 1);
  assert.equal(session.permissions.preset, 'danger-full-access');
});

test('a workspaces entry beats a rule for the same directory', () => {
  const host = createHost();
  const dir = join(base, 'client');
  apply(host.ctx, {
    workspaces: { [dir]: 'workspace-write' },
    rules: [{ path: dir, preset: 'danger-full-access' }],
  });
  const session = createSession(join(dir, 'nested'));
  emitCreated(host, session);
  assert.equal(session.permissions.preset, 'workspace-write');
});

test('volatile references are read live, so a settings write needs no restart', () => {
  const host = createHost();
  let workspaces = {};
  const config = { workspaces: { get: () => workspaces } };
  apply(host.ctx, config);

  const before = createSession(join(base, 'client'));
  emitCreated(host, before);
  assert.equal(host.calls.length, 0);

  workspaces = { [join(base, 'client')]: 'danger-full-access' };
  const after = createSession(join(base, 'client'));
  emitCreated(host, after);
  assert.equal(after.permissions.preset, 'danger-full-access');
});

test('an unknown preset written by mistake is skipped instead of breaking new sessions', () => {
  const host = createHost();
  let workspaces = { [join(base, 'client')]: 'ghost' };
  const config = { workspaces: { get: () => workspaces } };
  assert.throws(() => apply(host.ctx, config), /unknown permission preset/);

  workspaces = {};
  apply(host.ctx, config);
  workspaces = { [join(base, 'client')]: 'ghost' };
  const session = createSession(join(base, 'client'));
  assert.doesNotThrow(() => emitCreated(host, session));
  assert.equal(host.calls.length, 0);
  assert.equal(session.permissions.preset, null);
});

test('invalid workspaces values fail activation', () => {
  const host = createHost();
  assert.throws(() => apply(host.ctx, { workspaces: 'nope' }), /config\.workspaces must be an object/);
  assert.throws(() => apply(host.ctx, { workspaces: { [base]: '' } }), /must be a permission preset name/);
  assert.throws(() => apply(host.ctx, { workspaces: { [base]: 42 } }), /must be a permission preset name/);
});

test('normalizeConfig merges the settings maps before the yml rules', () => {
  const dir = join(base, 'client');
  const config = normalizeConfig({
    workspaces: { [dir]: 'danger-full-access' },
    agentPresets: { [dir]: 'reverse' },
    rules: [{ path: dir, preset: 'workspace-write' }],
  });
  assert.deepEqual(config.rules, [
    { path: dir, preset: 'danger-full-access', label: '' },
    { path: dir, agentPreset: 'reverse', label: '' },
    { path: dir, preset: 'workspace-write', label: '' },
  ]);
  assert.equal(config.caseSensitive, !CASE_INSENSITIVE);
});

test('invalid agentPresets values fail activation', () => {
  const host = createHost();
  assert.throws(() => apply(host.ctx, { agentPresets: 'nope' }), /config\.agentPresets must be an object/);
  assert.throws(() => apply(host.ctx, { agentPresets: { [base]: '' } }), /must be an agent preset name/);
  assert.throws(() => apply(host.ctx, { agentPresets: { [base]: 42 } }), /must be an agent preset name/);
});

test('an agent preset-only entry never touches the permission preset', () => {
  const host = createHost();
  apply(host.ctx, { agentPresets: { [join(base, 'client')]: 'reverse' } });
  const session = createSession(join(base, 'client'));
  emitCreated(host, session);
  assert.equal(host.calls.length, 0);
  assert.equal(session.permissions.preset, null);
});

test('the Config schema exposes every editable field as volatile', () => {
  assert.ok(Config, 'the host must export a schema so Settings can serve a form');
  for (const field of ['workspaces', 'agentPresets', 'rules', 'includeSubagents', 'caseSensitive']) {
    assert.ok(Config.dict[field], 'missing config field ' + field);
    assert.equal(Config.dict[field].meta.volatile, true, field + ' must be volatile');
  }
  assert.doesNotThrow(() => Config.toJSON());

  // Resolving the schema yields live references (this is what the host passes
  // to apply()), so read every field through get() exactly like the plugin does.
  const resolved = Config({});
  for (const field of ['workspaces', 'agentPresets', 'rules', 'includeSubagents', 'caseSensitive']) {
    assert.equal(typeof resolved[field].get, 'function', field + ' must resolve to a volatile reference');
  }
  assert.deepEqual(resolved.workspaces.get(), {});
  assert.deepEqual(resolved.agentPresets.get(), {});
  assert.deepEqual(resolved.rules.get(), []);
  assert.equal(resolved.includeSubagents.get(), false);
  assert.equal(resolved.caseSensitive.get(), !CASE_INSENSITIVE);
});