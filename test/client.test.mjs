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
    useEffect() {},
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
    value: { workspaces: { 'D:/work/client': 'danger-full-access' }, includeSubagents: false },
  };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject(services, callback) {
      callback({ remote: { permissionPresets: { catalog: async () => ({ ok: true, value: { options: [{ value: 'read-only', name: '只读' }] } }) } } });
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

  const rendered = component({ t: (key) => 'zh:' + key });
  const text = textOf(rendered);
  assert.ok(text.includes('D:/work/client'), 'the assigned workspace must be listed: ' + text);
  assert.ok(text.includes('danger-full-access'), 'the assigned preset must be selected: ' + text);
  assert.deepEqual(mutations, [], 'rendering must not write');
});
