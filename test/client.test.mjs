import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const settingsNamespace = 'workspace-mode';

/** Collect the text a react-element tree renders, so assertions can look for paths. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  // Function components are invoked directly: this is a stub renderer, not React.
  if (typeof node.type === 'function') return textOf(node.type(node.props));
  return textOf(node.props?.children);
}

function stubReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...props, children: children.length <= 1 ? children[0] : children } };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    // Effects run inline: the stub renderer calls component functions directly,
    // so "after mount" is "during this render" for the purpose of the test.
    useEffect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') dispose();
    },
  };
}

test('the browser bundle registers under its package name and renders a settings section', async () => {
  const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.client.platform, 'web');

  const captured = [];
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import('../lib/client.js');
  } finally {
    delete globalThis.window;
  }
  assert.equal(captured.length, 1, 'the bundle must register exactly one client module');
  const spec = captured[0];
  assert.equal(spec.id, pkg.name, 'the client module id must be the package name');

  const moduleExports = spec.factory((name) => {
    if (name === 'react') return stubReact();
    throw new Error('the browser half must only require platform modules, got ' + name);
  });
  assert.equal(typeof moduleExports.apply, 'function');
  assert.deepEqual([...moduleExports.inject].sort(), ['configForms', 'locale', 'slots']);

  // ── fake browser context ────────────────────────────────────────────
  const registered = [];
  const mutations = [];
  const dictionaries = [];
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 1,
    value: {
      workspaces: { 'D:/work/client': 'danger-full-access' },
      agentPresets: { 'D:/work/client': 'reverse' },
      includeSubagents: false,
    },
  };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject(services, callback) {
      const names = Array.isArray(services) ? services : [services];
      if (names.includes('remote.permissionPresets')) {
        callback({ remote: { permissionPresets: { catalog: async () => ({ ok: true, value: { options: [{ value: 'read-only', name: '只读' }] } }) } } });
      }
      if (names.includes('remote.agentPresets')) {
        callback({
          remote: {
            agentPresets: {
              list: async () => ({
                ok: true,
                value: {
                  presets: [
                    { id: 'ptc', name: 'PTC', isDefault: true },
                    { id: 'reverse', name: '反向' },
                  ],
                },
              }),
            },
          },
        });
      }
      return () => {};
    },
    locale: {
      register(namespace, dict) {
        dictionaries.push({ namespace, dict });
        return () => {};
      },
      bind: (namespace) => (key) => namespace + ':' + key,
    },
    slots: {
      inject(kind, register) {
        assert.equal(kind, 'settings.section');
        register();
        return () => {};
      },
      register(descriptor, component) {
        registered.push({ descriptor, component });
        return () => {};
      },
    },
    configForms: {
      get(namespace) {
        assert.equal(namespace, settingsNamespace);
        return {
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
          mutate: async (ops) => {
            mutations.push(ops);
            return true;
          },
        };
      },
    },
  };

  moduleExports.apply(ctx);

  assert.equal(dictionaries.length, 1);
  assert.deepEqual(Object.keys(dictionaries[0].dict).sort(), ['en', 'zh']);
  assert.equal(registered.length, 1);
  const { descriptor, component } = registered[0];
  assert.equal(descriptor.name, 'settings.section');
  assert.equal(descriptor.id, settingsNamespace);
  assert.equal(typeof descriptor.label, 'function');

  // The stub renderer only reaches a component when it walks the element tree,
  // so render once to mount (this starts the catalog loads), wait for them to
  // resolve, then render the settled state.
  textOf(component({ t: (key) => 'zh:' + key }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const rendered = component({ t: (key) => 'zh:' + key });
  const text = textOf(rendered);
  assert.ok(text.includes('D:/work/client'), 'the assigned workspace must be listed: ' + text);
  assert.ok(text.includes('danger-full-access'), 'the assigned preset must be selected: ' + text);
  assert.ok(text.includes('反向 (reverse)'), 'the assigned mode must be selected: ' + text);
  assert.ok(text.includes('PTC (ptc, zh:defaultMark)'), 'the default mode must be marked: ' + text);
  assert.ok(!text.includes('zh:modesUnavailable'), 'agent presets resolved, so no warning: ' + text);
  assert.deepEqual(mutations, [], 'rendering must not write');
});