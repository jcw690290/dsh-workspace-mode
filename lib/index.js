/**
 * dsh-workspace-mode — Host plugin that gives each workspace its own initial
 * permission preset and its own initial agent preset (the DSH "模式", e.g.
 * 标准模式 / ptc 模式 / a user-created preset).
 *
 * Permission presets: DSH pins a new session's permission preset from one
 * global default. This plugin runs a `session/created` listener with
 * `{ prepend: true }`, i.e. before @deepseek-ai/dsh-permission-presets
 * registers its own listener, so it can set a preset on a genuinely fresh
 * session first. The permission service then sees a non-empty permission state
 * and only fills the remaining facts, keeping the preset chosen here.
 *
 * Agent presets: DSH composes every new session from the registry's current
 * default preset, because the creation request always resolves *some* preset.
 * There is no hook before composition, but `agent/created` fires while the
 * session is still blank and its listeners may return a promise. So this plugin
 * listens there too and, when the session only carries the global default, asks
 * the registry to select the workspace's preset instead
 * (`ctx.agentPresets.select(agent, id)`). A session that already recorded an
 * explicit choice, or one whose first turn started, is left untouched.
 *
 * The optional Config schema below is what makes the DSH Settings page
 * ("workspace-mode") editable: every field is `.volatile()`, so a write from the
 * settings form updates this plugin's live config without remounting it. The
 * same values can still come from the profile's cordis.patch.yml.
 *
 * Only resources registered through `ctx.on` are used, so the plugin disposes
 * cleanly with its fiber. `@deepseek-ai/schemastery` is the single dependency;
 * it is imported dynamically so a profile that installed this bundle without
 * dependencies still runs (from yml config) instead of failing to load.
 * `agentPresets` is resolved optionally through `ctx.get`, so a profile without
 * the agent preset registry keeps the permission half working.
 */
import { compileRules, findRule } from './match.js';

export const name = 'workspace-mode';
export const inject = ['permissionPresets'];

const CASE_INSENSITIVE_PLATFORMS = new Set(['win32', 'darwin']);
const PERMISSION_FIELD = 'preset';
const AGENT_FIELD = 'agentPreset';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function presetText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read a config value, unwrapping a schemastery volatile reference.
 *
 * DSH replaces every volatile Config field with a frozen `{ get() }` object that
 * the loader rewrites in place when the Settings form saves, so reading through
 * `get()` on every use makes settings writes apply live.
 *
 * @param {unknown} value
 * @returns {unknown} The current value.
 */
export function readLive(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get();
  }
  return value;
}

/** Whether this platform compares workspace paths case sensitively by default. */
export function platformCaseSensitive() {
  return !CASE_INSENSITIVE_PLATFORMS.has(process.platform);
}

/**
 * Validate and normalize the raw plugin config.
 *
 * Three sources are merged into one rule list:
 * - `workspaces`, a flat `{ "<absolute dir>": "<permission preset>" }` map
 *   written by the Settings page (one key per workspace, so a form edit never
 *   shifts indexes);
 * - `agentPresets`, the same flat shape for agent presets (the "模式");
 * - `rules`, the richer array a profile author writes in cordis.patch.yml,
 *   whose entries may carry `preset`, `agentPreset`, or both.
 *
 * The two Settings maps come first, and equal-length paths keep declaration
 * order, so an entry made in the Settings page wins over a yml rule for the
 * same directory. A map entry only claims its own dimension, so the other
 * dimension still falls through to whatever else matches.
 *
 * @param {unknown} raw
 * @returns {{ rules: Array<{path: string, preset?: string, agentPreset?: string, label: string}>, includeSubagents: boolean, caseSensitive: boolean }}
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) throw new Error('workspace-mode: config must be an object');

  const includeSubagents = readLive(raw.includeSubagents);
  const caseSensitive = readLive(raw.caseSensitive);
  if (includeSubagents !== undefined && typeof includeSubagents !== 'boolean') {
    throw new Error('workspace-mode: config.includeSubagents must be a boolean');
  }
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
    throw new Error('workspace-mode: config.caseSensitive must be a boolean');
  }

  const rawWorkspaces = readLive(raw.workspaces) ?? {};
  if (!isPlainObject(rawWorkspaces)) {
    throw new Error('workspace-mode: config.workspaces must be an object');
  }
  const workspaceRules = Object.entries(rawWorkspaces).map(([path, preset]) => {
    if (typeof preset !== 'string' || preset.trim() === '') {
      throw new Error(
        `workspace-mode: config.workspaces[${JSON.stringify(path)}] must be a permission preset name`,
      );
    }
    return { path, preset: preset.trim(), label: '' };
  });

  const rawAgentPresets = readLive(raw.agentPresets) ?? {};
  if (!isPlainObject(rawAgentPresets)) {
    throw new Error('workspace-mode: config.agentPresets must be an object');
  }
  const agentRules = Object.entries(rawAgentPresets).map(([path, agentPreset]) => {
    if (typeof agentPreset !== 'string' || agentPreset.trim() === '') {
      throw new Error(
        `workspace-mode: config.agentPresets[${JSON.stringify(path)}] must be an agent preset name`,
      );
    }
    return { path, agentPreset: agentPreset.trim(), label: '' };
  });

  const rawRules = readLive(raw.rules) ?? [];
  if (!Array.isArray(rawRules)) throw new Error('workspace-mode: config.rules must be an array');
  const rules = rawRules.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`workspace-mode: rules[${index}] must be an object`);
    if (typeof item.path !== 'string' || item.path.trim() === '') {
      throw new Error(`workspace-mode: rules[${index}].path must be a non-empty string`);
    }
    const preset = presetText(item.preset);
    const agentPreset = presetText(item.agentPreset);
    if (preset === '' && agentPreset === '') {
      throw new Error(
        `workspace-mode: rules[${index}].preset or rules[${index}].agentPreset must be a non-empty string`,
      );
    }
    if (item.label !== undefined && typeof item.label !== 'string') {
      throw new Error(`workspace-mode: rules[${index}].label must be a string`);
    }
    const rule = { path: item.path, label: item.label ?? '' };
    if (preset !== '') rule.preset = preset;
    if (agentPreset !== '') rule.agentPreset = agentPreset;
    return rule;
  });

  return {
    rules: [...workspaceRules, ...agentRules, ...rules],
    includeSubagents: includeSubagents === true,
    caseSensitive: typeof caseSensitive === 'boolean' ? caseSensitive : platformCaseSensitive(),
  };
}

/**
 * Turn the live config into matchable rules.
 *
 * Permission presets are validated against the live catalog, because a typo
 * there would otherwise reach `permissionPresets.set` and fail a new session.
 * Agent presets cannot be validated here — the registry is resolved
 * asynchronously and may not be mounted yet — so they are checked right before
 * selection instead.
 *
 * @param {object} ctx - Host context.
 * @param {unknown} config - Live plugin config (may hold volatile references).
 * @param {boolean} strict - Fail activation loudly, or skip bad entries at
 *   session time (a settings write must never break new sessions).
 */
function resolvePlan(ctx, config, strict) {
  const options = normalizeConfig(config);

  let compiled;
  try {
    compiled = compileRules(options.rules, { caseSensitive: options.caseSensitive });
  } catch (error) {
    if (strict) throw error;
    console.warn(`[workspace-mode] ${describeError(error)}`);
    compiled = [];
  }

  const known = new Set(ctx.permissionPresets.names);
  const usable = [];
  for (const rule of compiled) {
    if (rule.preset === undefined || known.has(rule.preset)) {
      usable.push(rule);
      continue;
    }
    const detail = `unknown permission preset ${JSON.stringify(rule.preset)}`
      + ` (available: ${[...known].join(', ')})`;
    if (strict) {
      throw new Error(
        `workspace-mode: rule for ${JSON.stringify(rule.path)} uses ${detail}`,
      );
    }
    console.warn(`[workspace-mode] skipped permission preset for ${JSON.stringify(rule.path)}: ${detail}`);
    // Keep the rule's agent preset half usable; only drop the bad dimension.
    const { preset, ...rest } = rule;
    if (rest.agentPreset !== undefined) usable.push(rest);
  }
  return { options, compiled: usable };
}

/** A session is fresh when DSH has not recorded any permission fact yet. */
function isFreshPermissionState(state) {
  return state !== undefined
    && state !== null
    && state.preset === null
    && state.sandbox === null
    && state.approval === null
    && state.seeded !== true;
}

/**
 * Apply the configured permission preset to one newly created session.
 *
 * @returns {boolean} Whether a preset was applied.
 */
function applyToSession(ctx, session, compiled, options) {
  const header = session?.header;
  if (!header || typeof header.cwd !== 'string' || header.cwd.trim() === '') return false;
  if (!options.includeSubagents && header.parentSession !== undefined && header.parentSession !== null) return false;

  let state;
  try {
    state = ctx.permissionPresets.permissionState(session);
  } catch {
    // Projection not ready for this session; leave it to the default pin.
    return false;
  }
  if (!isFreshPermissionState(state)) return false;

  const rule = findRule(header.cwd, compiled, options, PERMISSION_FIELD);
  if (rule === null) return false;

  ctx.permissionPresets.set(session, rule.preset);
  const sessionId = session.id ?? header.id ?? '?';
  console.log(
    `[workspace-mode] session ${sessionId} in ${header.cwd} -> permission preset "${rule.preset}"`
    + (rule.label ? ` (${rule.label})` : ''),
  );
  return true;
}

/** Resolve the agent preset registry without declaring it as a hard dependency. */
function agentPresetRegistry(ctx) {
  let registry;
  try {
    registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : ctx.agentPresets;
  } catch {
    return undefined;
  }
  return registry !== undefined && registry !== null && typeof registry.select === 'function'
    ? registry
    : undefined;
}

/**
 * Read the agent preset a session currently runs, preferring the durable
 * projection over the (frozen) session header.
 *
 * @returns {string | null} The committed preset identity, if any.
 */
function currentAgentPreset(ctx, session, header) {
  let projections;
  try {
    projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : ctx.sessionProjections;
  } catch {
    projections = undefined;
  }
  if (projections !== undefined && projections !== null && typeof projections.stateOf === 'function') {
    try {
      const value = projections.stateOf(session, 'agentPreset');
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // Fall through to the header.
    }
  }
  return typeof header.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : null;
}

/**
 * Switch one newly created agent to the workspace's agent preset.
 *
 * Only sessions that still run the registry default are touched: an explicit
 * pick (the composer's 模式 menu, or `startSession(..., { agentPreset })`) is
 * already committed and must be preserved. `select` itself refuses sessions
 * whose first turn started.
 *
 * @returns {Promise<boolean>} Whether a preset was selected.
 */
async function applyAgentPreset(ctx, agent, compiled, options) {
  const session = agent?.session;
  const header = session?.header;
  if (!header || typeof header.cwd !== 'string' || header.cwd.trim() === '') return false;
  if (!options.includeSubagents && header.parentSession !== undefined && header.parentSession !== null) return false;

  const rule = findRule(header.cwd, compiled, options, AGENT_FIELD);
  if (rule === null) return false;

  const registry = agentPresetRegistry(ctx);
  if (registry === undefined) {
    console.warn('[workspace-mode] agent presets are unavailable in this profile; kept the current 模式');
    return false;
  }

  const fallback = typeof registry.defaultId === 'string' ? registry.defaultId : null;
  const current = currentAgentPreset(ctx, session, header);
  if (fallback !== null && current !== null && current !== fallback) return false;

  const wanted = rule.agentPreset;
  if (typeof registry.list === 'function') {
    const rows = await registry.list();
    const row = Array.isArray(rows) ? rows.find((entry) => entry && entry.id === wanted) : undefined;
    if (row === undefined) {
      console.warn(
        `[workspace-mode] skipped agent preset for ${JSON.stringify(rule.path)}: unknown agent preset `
        + `${JSON.stringify(wanted)}`,
      );
      return false;
    }
    if (typeof row.broken === 'string' && row.broken !== '') {
      console.warn(
        `[workspace-mode] skipped agent preset for ${JSON.stringify(rule.path)}: `
        + `${JSON.stringify(wanted)} cannot compose a session: ${row.broken}`,
      );
      return false;
    }
  }

  await registry.select(agent, wanted);
  const agentId = typeof agent?.id === 'string' ? agent.id : '?';
  console.log(
    `[workspace-mode] session ${agentId} in ${header.cwd} -> agent preset "${wanted}"`
    + (rule.label ? ` (${rule.label})` : ''),
  );
  return true;
}

/**
 * Cordis Host plugin entry point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  // Fail activation for a broken profile patch, but keep every later session
  // working when a Settings-page write turns out wrong.
  const initial = resolvePlan(ctx, config, true);

  const livePlan = (subject) => {
    try {
      return resolvePlan(ctx, config, false);
    } catch (error) {
      console.warn(`[workspace-mode] skipped ${subject}: ${describeError(error)}`);
      return null;
    }
  };

  ctx.on('session/created', (session) => {
    const plan = livePlan(`session ${session?.id ?? '?'}`);
    if (plan === null) return;
    try {
      applyToSession(ctx, session, plan.compiled, plan.options);
    } catch (error) {
      console.warn(
        `[workspace-mode] skipped session ${session?.id ?? '?'}: ${describeError(error)}`,
      );
    }
  }, { prepend: true });

  ctx.on('agent/created', async (payload) => {
    const agent = payload?.agent;
    const plan = livePlan(`agent ${agent?.id ?? '?'}`);
    if (plan === null) return;
    try {
      await applyAgentPreset(ctx, agent, plan.compiled, plan.options);
    } catch (error) {
      const code = error && typeof error.code === 'string' ? ` [${error.code}]` : '';
      console.warn(
        `[workspace-mode] skipped agent preset for ${agent?.id ?? '?'}${code}: ${describeError(error)}`,
      );
    }
  }, { prepend: true });

  if (initial.compiled.length > 0) {
    console.log(`[workspace-mode] ${initial.compiled.length} workspace rule(s) active`);
  }
}

let schemaFactory;
try {
  const loaded = await import('@deepseek-ai/schemastery');
  schemaFactory = loaded.default ?? loaded;
} catch (error) {
  console.warn(
    '[workspace-mode] @deepseek-ai/schemastery is not resolvable, so the Settings page stays read-only. '
    + 'Reinstall the bundle with its dependencies to make it editable: '
    + describeError(error),
  );
  schemaFactory = undefined;
}

/**
 * Editable settings schema.
 *
 * Every field is volatile: DSH serves volatile fields as the live form of the
 * profile entry whose id is `workspace-mode`, and a form write rewrites these
 * references in place. Declaring the schema is optional for the plugin itself —
 * the yml config keeps working when schemastery is unavailable.
 */
export const Config = schemaFactory === undefined ? undefined : schemaFactory.object({
  workspaces: schemaFactory.dict(schemaFactory.string()).default({}).volatile(),
  agentPresets: schemaFactory.dict(schemaFactory.string()).default({}).volatile(),
  rules: schemaFactory.array(schemaFactory.object({
    path: schemaFactory.string(),
    preset: schemaFactory.string().default(''),
    agentPreset: schemaFactory.string().default(''),
    label: schemaFactory.string().default(''),
  })).default([]).volatile(),
  includeSubagents: schemaFactory.boolean().default(false).volatile(),
  caseSensitive: schemaFactory.boolean().default(platformCaseSensitive()).volatile(),
});
