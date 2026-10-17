/**
 * dsh-workspace-mode — Host plugin that gives each workspace its own initial
 * permission preset.
 *
 * DSH pins a new session's permission preset from one global default. This
 * plugin runs a `session/created` listener with `{ prepend: true }`, i.e. before
 * @deepseek-ai/dsh-permission-presets registers its own listener, so it can set
 * a preset on a genuinely fresh session first. The permission service then sees
 * a non-empty permission state and only fills the remaining facts, keeping the
 * preset chosen here.
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
 */
import { compileRules, findRule } from './match.js';

export const name = 'workspace-mode';
export const inject = ['permissionPresets'];

const CASE_INSENSITIVE_PLATFORMS = new Set(['win32', 'darwin']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
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
 * Two sources are merged into one rule list:
 * - `workspaces`, a flat `{ "<absolute dir>": "<preset>" }` map written by the
 *   Settings page (one key per workspace, so a form edit never shifts indexes);
 * - `rules`, the richer array a profile author writes in cordis.patch.yml.
 *
 * `workspaces` entries come first, and equal-length paths keep declaration
 * order, so an entry made in the Settings page wins over a yml rule for the
 * same directory.
 *
 * @param {unknown} raw
 * @returns {{ rules: Array<{path: string, preset: string, label: string}>, includeSubagents: boolean, caseSensitive: boolean }}
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

  const rawRules = readLive(raw.rules) ?? [];
  if (!Array.isArray(rawRules)) throw new Error('workspace-mode: config.rules must be an array');
  const rules = rawRules.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`workspace-mode: rules[${index}] must be an object`);
    if (typeof item.path !== 'string' || item.path.trim() === '') {
      throw new Error(`workspace-mode: rules[${index}].path must be a non-empty string`);
    }
    if (typeof item.preset !== 'string' || item.preset.trim() === '') {
      throw new Error(`workspace-mode: rules[${index}].preset must be a non-empty string`);
    }
    if (item.label !== undefined && typeof item.label !== 'string') {
      throw new Error(`workspace-mode: rules[${index}].label must be a string`);
    }
    return { path: item.path, preset: item.preset.trim(), label: item.label ?? '' };
  });

  return {
    rules: [...workspaceRules, ...rules],
    includeSubagents: includeSubagents === true,
    caseSensitive: typeof caseSensitive === 'boolean' ? caseSensitive : platformCaseSensitive(),
  };
}

/**
 * Turn the live config into matchable rules.
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
    if (known.has(rule.preset)) {
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
    console.warn(`[workspace-mode] skipped rule for ${JSON.stringify(rule.path)}: ${detail}`);
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

  const rule = findRule(header.cwd, compiled, options);
  if (rule === null) return false;

  ctx.permissionPresets.set(session, rule.preset);
  const sessionId = session.id ?? header.id ?? '?';
  console.log(
    `[workspace-mode] session ${sessionId} in ${header.cwd} -> permission preset "${rule.preset}"`
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

  ctx.on('session/created', (session) => {
    let plan;
    try {
      plan = resolvePlan(ctx, config, false);
    } catch (error) {
      console.warn(`[workspace-mode] skipped session ${session?.id ?? '?'}: ${describeError(error)}`);
      return;
    }
    try {
      applyToSession(ctx, session, plan.compiled, plan.options);
    } catch (error) {
      console.warn(
        `[workspace-mode] skipped session ${session?.id ?? '?'}: ${describeError(error)}`,
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
  rules: schemaFactory.array(schemaFactory.object({
    path: schemaFactory.string(),
    preset: schemaFactory.string(),
    label: schemaFactory.string().default(''),
  })).default([]).volatile(),
  includeSubagents: schemaFactory.boolean().default(false).volatile(),
  caseSensitive: schemaFactory.boolean().default(platformCaseSensitive()).volatile(),
});
