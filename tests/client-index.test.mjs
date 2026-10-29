/**
 * Client composition (src/client/index.ts): the initial layer warm-up race
 * (code-review round 2, finding #1).
 *
 * On a fresh page load the session-list effect runs while
 * `ctx.remote.$mount` is still in flight: every first `layers` read answers
 * `remote-unavailable`. The old code marked those sessions as warmed anyway and
 * the post-mount sweep visited only stores that already existed, so after an F5
 * the host-held layers never appeared. This file drives `apply()` against
 * stubs: the read before the mount must not reach the host, the post-mount sweep
 * must re-read every session, and the dock store must end up with the host
 * layers.
 *
 * The three modules are transpiled from TypeScript and flattened into one plain
 * script scope by `tests/_client.mjs` (they share that scope in the tsdown
 * bundle too), so they load into a VM context together with the remaining
 * collaborators as stubs — those need React / the product UI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transpileClientModule } from './_client.mjs';

const storeSource = await transpileClientModule('store');
const localesSource = await transpileClientModule('locales');
const indexSource = await transpileClientModule('index');

/**
 * A stub client cordis context. `effect` records every effect body so the test
 * can await the async Remote effect once the mount resolves.
 * @returns {object} the harness.
 */
function makeHarness() {
  const layersCalls = [];
  const effects = [];
  const entries = new Map();
  const host = {
    async layers(sessionId) {
      layersCalls.push(String(sessionId));
      return {
        ok: true,
        value: {
          layers: [
            { promptId: 'p_1', title: 'one', body: 'one', tokens: 1 },
            { promptId: 'p_2', title: 'two', body: 'two', tokens: 1 }
          ],
          totalTokens: 2,
          limit: 3
        }
      };
    },
    async list() {
      return {
        ok: true,
        value: {
          prompts: [],
          updatedAt: null,
          filePath: '/tmp/prompts.json',
          readOnly: false,
          corruptBackup: null,
          notice: null
        }
      };
    }
  };
  const sessions = {
    list: {
      getSnapshot: () => ({ ids: ['s1'] }),
      subscribe: () => () => {}
    }
  };
  let resolveMount;
  const mount = new Promise((resolve) => {
    resolveMount = resolve;
  });
  const ctx = {
    effect(execute, label) {
      effects.push({ label, result: execute() });
      return () => {};
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key
    },
    slots: {
      inject(name, factory) {
        entries.set(name, factory());
      },
      register(entry) {
        return entry;
      }
    },
    get(name) {
      if (name === 'inputTriggers') return { registerSource: () => () => {} };
      if (name === 'sessions') return sessions;
      return undefined;
    },
    remote: { $mount: () => mount },
    reflect: { get: (name) => (name === 'remote.promptLibrary' ? host : undefined) },
    on() {}
  };
  return { ctx, effects, entries, layersCalls, resolveMount };
}

const sandbox = {
  console,
  // The contract is only read for its shape here: the composition reads
  // contract.INVOCATIONS at module evaluation and LIMITS.layers for the empty
  // layer view.
  contract: { INVOCATIONS: [], LIMITS: { layers: 3 } },
  adoptStyles() {},
  createPromptSource: () => ({ source: { warm: () => Promise.resolve() }, invalidate() {} }),
  estimateTokens: () => 0,
  React: {},
  LayersDock: {},
  PromptDialog: {},
  PromptLibrarySection: {}
};
vm.createContext(sandbox);
vm.runInContext(
  `${storeSource}\n${localesSource}\n${indexSource}\n;globalThis.__indexExports = { apply, layerWarmupKept };`,
  sandbox,
  { filename: 'src/client/index.ts' }
);
const { apply, layerWarmupKept } = sandbox.__indexExports;

/** Flush pending microtasks and timer callbacks (the RPC stub is async). */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('index: a pre-mount layer warm-up is retried once the Remote mount settles', async () => {
  const { ctx, effects, entries, layersCalls, resolveMount } = makeHarness();
  apply(ctx);
  await settle();
  assert.deepEqual([...layersCalls], [], 'the pre-mount read never reaches the host');

  resolveMount(() => {});
  const remoteEffect = effects.find((effect) => effect.label === 'dsh-prompt-library: remote');
  assert.ok(remoteEffect, 'the Remote effect must be registered');
  await remoteEffect.result;
  await settle();

  assert.deepEqual([...layersCalls], ['s1'], 'the post-mount sweep re-reads the session');
  const dock = entries.get('conversation.input.dock');
  assert.ok(dock, 'the dock slot must be registered');
  const injected = dock.inject('s1');
  const shown = injected.hooks.layers.getSnapshot();
  assert.deepEqual([...shown.layers].map((layer) => layer.promptId), ['p_1', 'p_2']);
  assert.equal(shown.totalTokens, 2);
});

test('index: only a successful layer read keeps the warm-up mark', () => {
  assert.equal(layerWarmupKept({ ok: true, value: { layers: [] } }), true);
  assert.equal(layerWarmupKept({ ok: false, code: 'remote-unavailable', message: 'not mounted' }), false);
  assert.equal(layerWarmupKept({ ok: false, code: 'error', message: 'boom' }), false);
  assert.equal(layerWarmupKept(undefined), false);
});
