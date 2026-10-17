/**
 * Pure path-matching helpers for dsh-workspace-mode.
 *
 * Rules are absolute directory prefixes. The longest matching prefix wins, so
 * a nested rule can override a broader one. Matching respects path boundaries
 * (`/work/client` never matches `/work/client-other`) and follows the host's
 * default case sensitivity unless the config overrides it.
 */
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

/** Expand a leading `~/` or `~\` to the current user's home directory. */
export function expandHome(input) {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return resolve(homedir(), input.slice(2));
  return input;
}

/**
 * Normalize one workspace or rule directory for comparison.
 *
 * @param {string} input - Raw path from config or a session header.
 * @param {boolean} caseSensitive - Whether comparison is case sensitive.
 * @returns {string | null} Normalized absolute path, or null when unusable.
 */
export function normalizePath(input, caseSensitive) {
  if (typeof input !== 'string') return null;
  let value = expandHome(input.trim());
  if (value === '' || !isAbsolute(value)) return null;
  value = resolve(value);
  if (!caseSensitive) value = value.toLowerCase();
  // Trim trailing separators unless the path is a filesystem root (C:\ or /).
  while (value.length > 1 && value.endsWith(sep) && !/^[A-Za-z]:[\\/]$/.test(value)) {
    value = value.slice(0, -1);
  }
  return value;
}

/** Whether `candidate` is `root` itself or lives below it. */
export function isWithin(root, candidate) {
  if (candidate === root) return true;
  return root.endsWith(sep) ? candidate.startsWith(root) : candidate.startsWith(root + sep);
}

/**
 * Compile config rules into normalized entries ordered by match priority.
 *
 * @param {Array<{path: string, preset: string, label?: string}>} rules
 * @param {{ caseSensitive: boolean }} options
 * @returns {Array<{ path: string, preset: string, label: string, normalized: string }>}
 */
export function compileRules(rules, options) {
  const caseSensitive = options.caseSensitive === true;
  const compiled = [];
  for (const rule of rules) {
    const normalized = normalizePath(rule.path, caseSensitive);
    if (normalized === null) {
      throw new Error(`workspace-mode: rule path must be an absolute directory: ${JSON.stringify(rule.path)}`);
    }
    compiled.push({
      path: rule.path,
      preset: rule.preset,
      label: rule.label ?? '',
      normalized,
    });
  }
  // Longest prefix first; equal lengths keep declaration order.
  return compiled
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) => {
      const delta = right.rule.normalized.length - left.rule.normalized.length;
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map(({ rule }) => rule);
}

/**
 * Find the highest-priority rule matching a workspace directory.
 *
 * @param {string} cwd - Session workspace directory.
 * @param {Array<{ normalized: string }>} compiled - Result of {@link compileRules}.
 * @param {{ caseSensitive: boolean }} options
 * @returns {object | null} The matching rule, or null.
 */
export function findRule(cwd, compiled, options) {
  const candidate = normalizePath(cwd, options.caseSensitive === true);
  if (candidate === null) return null;
  for (const rule of compiled) {
    if (isWithin(rule.normalized, candidate)) return rule;
  }
  return null;
}
