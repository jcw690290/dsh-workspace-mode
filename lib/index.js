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
 * Only resources registered through `ctx.on` are used, so the plugin disposes
 * cleanly with its fiber. No `@deepseek-ai/*` imports: bundle plugins resolve
 * only their own files plus Node builtins.
 */
import { compileRules, findRule } from './match.js';

export const name = 'workspace-mode';
export const inject = ['permissionPresets'];

const CASE_INSENSITIVE_PLATFORMS = new Set(['win32', 'darwin']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize the raw plugin config from cordis.patch.yml.
 *
 * @param {unknown} raw
 * @returns {{ rules: Array<{path: string, preset: string, label: string}>, includeSubagents: boolean, caseSensitive: boolean }}
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) throw new Error('workspace-mode: config must be an object');

  if (raw.includeSubagents !== undefined && typeof raw.includeSubagents !== 'boolean') {
    throw new Error('workspace-mode: config.includeSubagents must be a boolean');
  }
  if (raw.caseSensitive !== undefined && typeof raw.caseSensitive !== 'boolean') {
    throw new Error('workspace-mode: config.caseSensitive must be a boolean');
  }

  const rawRules = raw.rules ?? [];
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
    rules,
    includeSubagents: raw.includeSubagents === true,
    caseSensitive: typeof raw.caseSensitive === 'boolean'
      ? raw.caseSensitive
      : !CASE_INSENSITIVE_PLATFORMS.has(process.platform),
  };
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
  const options = normalizeConfig(config);
  const compiled = compileRules(options.rules, { caseSensitive: options.caseSensitive });

  const known = new Set(ctx.permissionPresets.names);
  for (const rule of compiled) {
    if (!known.has(rule.preset)) {
      throw new Error(
        `workspace-mode: rule for ${JSON.stringify(rule.path)} uses unknown permission preset `
        + `${JSON.stringify(rule.preset)} (available: ${[...known].join(', ')})`,
      );
    }
  }

  ctx.on('session/created', (session) => {
    try {
      applyToSession(ctx, session, compiled, options);
    } catch (error) {
      console.warn(
        `[workspace-mode] skipped session ${session?.id ?? '?'}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, { prepend: true });

  if (compiled.length > 0) {
    console.log(`[workspace-mode] ${compiled.length} workspace rule(s) active`);
  }
}
