import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileRules, expandHome, findRule, isWithin, normalizePath } from '../lib/match.js';

const base = resolve(join('/', 'srv', 'work'));

test('expandHome expands a leading tilde', () => {
  assert.equal(expandHome('~/project'), resolve(homedir(), 'project'));
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('C:/work'), 'C:/work');
});

test('normalizePath rejects relative and empty paths', () => {
  assert.equal(normalizePath('relative/dir', true), null);
  assert.equal(normalizePath('', true), null);
  assert.equal(normalizePath(null, true), null);
  assert.equal(normalizePath(base + '/', true), base);
});

test('normalizePath honors case sensitivity', () => {
  const upper = base.toUpperCase();
  assert.equal(normalizePath(upper, true), upper);
  assert.equal(normalizePath(upper, false), base.toLowerCase());
});

test('isWithin respects path boundaries', () => {
  assert.equal(isWithin(base, base), true);
  assert.equal(isWithin(base, join(base, 'child')), true);
  assert.equal(isWithin(base, base + '-other'), false);
});

test('compileRules orders the longest prefix first', () => {
  const rules = [
    { path: base, preset: 'workspace-write' },
    { path: join(base, 'client'), preset: 'danger-full-access' },
    { path: join(base, 'client', 'deep'), preset: 'workspace-write', label: 'deep' },
  ];
  const compiled = compileRules(rules, { caseSensitive: false });
  assert.deepEqual(compiled.map((rule) => rule.preset), ['workspace-write', 'danger-full-access', 'workspace-write']);
  const match = findRule(join(base, 'client', 'deep', 'src'), compiled, { caseSensitive: false });
  assert.equal(match.label, 'deep');
});

test('compileRules rejects relative paths', () => {
  assert.throws(() => compileRules([{ path: 'relative', preset: 'workspace-write' }], { caseSensitive: true }), /absolute directory/);
});

test('findRule matches the nearest ancestor and nothing outside', () => {
  const compiled = compileRules([
    { path: join(base, 'client'), preset: 'danger-full-access' },
  ], { caseSensitive: false });
  assert.equal(findRule(join(base, 'client', 'nested'), compiled, { caseSensitive: false }).preset, 'danger-full-access');
  assert.equal(findRule(join(base, 'client-other'), compiled, { caseSensitive: false }), null);
  assert.equal(findRule(base, compiled, { caseSensitive: false }), null);
  assert.equal(findRule('not-absolute', compiled, { caseSensitive: false }), null);
});

test('findRule is case-insensitive when configured', () => {
  const compiled = compileRules([{ path: join(base, 'Client'), preset: 'workspace-write' }], { caseSensitive: false });
  assert.notEqual(findRule(join(base, 'client', 'src'), compiled, { caseSensitive: false }), null);
  const strict = compileRules([{ path: join(base, 'Client'), preset: 'workspace-write' }], { caseSensitive: true });
  assert.equal(findRule(join(base, 'client', 'src'), strict, { caseSensitive: true }), null);
});
test('findRule can look for the agent preset dimension', () => {
  const compiled = compileRules([
    { path: base, preset: 'workspace-write' },
    { path: join(base, 'client'), agentPreset: 'reverse' },
  ], { caseSensitive: false });
  assert.equal(findRule(join(base, 'client', 'src'), compiled, { caseSensitive: false }, 'agentPreset').agentPreset, 'reverse');
  // A rule without the requested dimension never matches.
  assert.equal(findRule(join(base, 'other'), compiled, { caseSensitive: false }, 'agentPreset'), null);
  assert.equal(findRule(join(base, 'client', 'src'), compiled, { caseSensitive: false }, 'preset').preset, 'workspace-write');
});

test('compileRules keeps every dimension a rule declares', () => {
  const compiled = compileRules([{ path: base, preset: 'workspace-write', agentPreset: 'reverse' }], { caseSensitive: false });
  assert.equal(compiled[0].preset, 'workspace-write');
  assert.equal(compiled[0].agentPreset, 'reverse');
});
