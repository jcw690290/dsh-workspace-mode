import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { apply, inject, name, normalizeConfig } from '../lib/index.js';

const base = resolve(join('/', 'srv', 'work'));
const PRESETS = {
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
};

/** The agent preset rows the fake registry serves. */
const AGENT_ROWS = [
  { id: 'standard', name: 'Standard' },
  { id: 'ptc', name: 'PTC' },
  { id: 'reverse', name: 'Reverse' },
  { id: 'broken', name: 'Broken', broken: 'its carrier failed to load' },
];

function createSession(cwd, overrides = {}) {
  return {
    id: 'session-' + Math.random().toString(36).slice(2),
    header: { cwd },
    permissions: { preset: null, sandbox: null, approval: null, seeded: false },
    projection: {},
    ...overrides,
  };
}

function createAgent(session) {
  return { id: 'agent-' + Math.random().toString(36).slice(2), session };
}

/** A registry that behaves like @deepseek-ai/dsh-agent-preset-registry. */
function createRegistry(rows = AGENT_ROWS, defaultId = 'ptc') {
  const selected = [];
  return {
    defaultId,
    selected,
    async list() {
      return rows;
    },
    async select(agent, agentPreset) {
      selected.push({ agent, agentPreset });
      agent.session.projection.agentPreset = agentPreset;
    },
  };
}

/**
 * Minimal host context: event ordering mirrors cordis (prepend unshifts),
 * permissionPresets models the durable session projection update on set(),
 * and get() resolves the optional agent preset registry and projections.
 */
function createHost(options = {}) {
  const listeners = [];
  const agentListeners = [];
  const calls = [];
  const registry = 'registry' in options ? options.registry : createRegistry();
  const ctx = {
    on(event, listener, opts = {}) {
      const entry = { event, listener, options: opts };
      if (event === 'session/created') {
        if (opts?.prepend) listeners.unshift(entry);
        else listeners.push(entry);
      } else if (event === 'agent/created') {
        if (opts?.prepend) agentListeners.unshift(entry);
        else agentListeners.push(entry);
      }
      return () => {};
    },
    get(id) {
      if (id === 'agentPresets') return registry;
      if (id === 'sessionProjections') {
        return {
          stateOf(session, key) {
            return session?.projection?.[key];
          },
        };
      }
      return undefined;
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
  return { ctx, listeners, agentListeners, calls, registry };
}

function createCtx(plugConfig = { rules: [] }, hostOptions = {}) {
  const host = createHost(hostOptions);
  apply(host.ctx, plugConfig);
  return host;
}

function emitCreated(host, session) {
  for (const entry of host.listeners) entry.listener(session);
}

async function emitAgent(host, agent) {
  for (const entry of host.agentListeners) await entry.listener({ agent, source: 'create' });
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
  assert.throws(() => apply(host.ctx, { rules: [{ path: base }] }), /must be a non-empty string/);
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

test('normalizeConfig merges the agent preset map and yml rules', () => {
  const config = normalizeConfig({
    agentPresets: { [join(base, 'client')]: 'reverse' },
    rules: [{ path: join(base, 'other'), agentPreset: 'standard' }, { path: base, preset: 'workspace-write' }],
  });
  assert.deepEqual(config.rules, [
    { path: join(base, 'client'), agentPreset: 'reverse', label: '' },
    { path: join(base, 'other'), agentPreset: 'standard', label: '' },
    { path: base, preset: 'workspace-write', label: '' },
  ]);
});

// --- agent presets (the "模式" dimension) -----------------------------------

test('a matched workspace selects its agent preset', async () => {
  const host = createCtx({ agentPresets: { [join(base, 'client')]: 'reverse' } });
  const session = createSession(join(base, 'client', 'src'), { header: { cwd: join(base, 'client', 'src'), agentPreset: 'ptc' } });
  const agent = createAgent(session);
  await emitAgent(host, agent);
  assert.equal(host.registry.selected.length, 1);
  assert.equal(host.registry.selected[0].agentPreset, 'reverse');
  assert.equal(session.projection.agentPreset, 'reverse');
});

test('the permission and agent dimensions are independent', () => {
  const host = createCtx({
    rules: [
      { path: base, preset: 'workspace-write' },
      { path: join(base, 'client'), agentPreset: 'reverse' },
    ],
  });
  const session = createSession(join(base, 'client'));
  emitCreated(host, session);
  assert.equal(session.permissions.preset, 'workspace-write');
  assert.equal(host.registry.selected.length, 0);
});

test('an explicit mode choice is preserved', async () => {
  const host = createCtx({ agentPresets: { [join(base, 'client')]: 'reverse' } });
  const session = createSession(join(base, 'client'), { header: { cwd: join(base, 'client'), agentPreset: 'standard' } });
  await emitAgent(host, createAgent(session));
  assert.equal(host.registry.selected.length, 0);
});

test('a committed projection overrides the header', async () => {
  const host = createCtx({ agentPresets: { [join(base, 'client')]: 'reverse' } });
  const session = createSession(join(base, 'client'), { header: { cwd: join(base, 'client'), agentPreset: 'ptc' } });
  session.projection.agentPreset = 'standard';
  await emitAgent(host, createAgent(session));
  assert.equal(host.registry.selected.length, 0);
});

test('agent presets skip subagents unless includeSubagents is true', async () => {
  const config = { agentPresets: { [base]: 'reverse' } };
  const parented = () => createSession(join(base, 'client'), {
    header: { cwd: join(base, 'client'), agentPreset: 'ptc', parentSession: 'parent-1' },
  });

  const skipped = createCtx(config);
  await emitAgent(skipped, createAgent(parented()));
  assert.equal(skipped.registry.selected.length, 0);

  const included = createCtx({ ...config, includeSubagents: true });
  await emitAgent(included, createAgent(parented()));
  assert.equal(included.registry.selected.length, 1);
});

test('an unknown agent preset is skipped, not fatal', async () => {
  const host = createCtx({ agentPresets: { [base]: 'nope' } });
  const session = createSession(join(base, 'client'), { header: { cwd: join(base, 'client'), agentPreset: 'ptc' } });
  await emitAgent(host, createAgent(session));
  assert.equal(host.registry.selected.length, 0);
});

test('a broken agent preset is skipped, not fatal', async () => {
  const host = createCtx({ agentPresets: { [base]: 'broken' } });
  const session = createSession(join(base, 'client'), { header: { cwd: join(base, 'client'), agentPreset: 'ptc' } });
  await emitAgent(host, createAgent(session));
  assert.equal(host.registry.selected.length, 0);
});

test('a profile without the registry keeps the permission half working', async () => {
  const host = createCtx({ rules: [{ path: base, preset: 'danger-full-access' }] }, { registry: undefined });
  const session = createSession(join(base, 'client'));
  emitCreated(host, session);
  assert.equal(session.permissions.preset, 'danger-full-access');
  await emitAgent(host, createAgent(session));
  assert.equal(host.calls.length, 1);
});

test('select errors do not escape the listener', async () => {
  const registry = createRegistry();
  registry.select = async () => {
    const error = new Error('This session has already started');
    error.code = 'agent-preset/locked';
    throw error;
  };
  const host = createCtx({ agentPresets: { [base]: 'reverse' } }, { registry });
  const session = createSession(join(base, 'client'), { header: { cwd: join(base, 'client'), agentPreset: 'ptc' } });
  await emitAgent(host, createAgent(session));
  assert.equal(session.projection.agentPreset, undefined);
});

test('invalid agent preset configs fail activation', () => {
  const host = createHost();
  assert.throws(() => apply(host.ctx, { agentPresets: 'nope' }), /agentPresets must be an object/);
  assert.throws(() => apply(host.ctx, { agentPresets: { [base]: 7 } }), /must be an agent preset name/);
});
