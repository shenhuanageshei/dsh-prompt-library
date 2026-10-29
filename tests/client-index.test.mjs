/**
 * Client composition (src/client/index.ts + src/client/chips.ts) after 0.2.
 *
 * What this file pins down:
 *   - the mount/warm-up race from the 0.1 audit (code-review round 2, finding #1)
 *     still holds: a read issued before ctx.remote.$mount settles never reaches
 *     the host, and the post-mount sweep reads every known session;
 *   - 0.2 hydration (design §5.6, FR-4 / AC-3): the dock exposes sessionId +
 *     ensure, an ensure reads its own session WITHOUT any session-list change,
 *     consecutive ensures share one in-flight request, a success is remembered,
 *     a failure is retried, and a connection/reset makes a response from the old
 *     connection land nowhere;
 *   - the chip strip itself requests the read from an effect on mount (never
 *     from render) and keeps its 0.1 layout.
 *
 * The client modules are transpiled from TypeScript and flattened into one plain
 * script scope by tests/_client.mjs (they share that scope in the tsdown bundle
 * too), so they load into a VM context together with the remaining
 * collaborators as stubs — those need React / the product UI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transpileClientModule } from './_client.mjs';

const storeSource = await transpileClientModule('store');
const localesSource = await transpileClientModule('locales');
const indexSource = await transpileClientModule('index');
const chipsSource = await transpileClientModule('chips');

/** The wire LayerSnapshot every stub host answers with. */
function layersValue() {
  return {
    layers: [
      { promptId: 'p_1', title: 'one', body: 'one', tokens: 1 },
      { promptId: 'p_2', title: 'two', body: 'two', tokens: 1 }
    ],
    totalTokens: 2,
    limit: 3
  };
}

/**
 * A stub client cordis context.
 * @param {{sessionIds?: string[], deferLayers?: boolean, failLayers?: number}} [options] - harness knobs.
 * @returns {object} the harness.
 */
function makeHarness(options = {}) {
  const layersCalls = [];
  const effects = [];
  const entries = new Map();
  const listeners = new Map();
  const gates = [];
  let failuresLeft = options.failLayers ?? 0;
  const host = {
    async layers(sessionId) {
      layersCalls.push(String(sessionId));
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return { ok: false, error: { code: 'layer-read-failed', message: 'the session layer file could not be read' } };
      }
      if (options.deferLayers === true) {
        return new Promise((resolve) => {
          gates.push(() => resolve({ ok: true, value: layersValue() }));
        });
      }
      return { ok: true, value: layersValue() };
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
      getSnapshot: () => ({ ids: options.sessionIds ?? ['s1'] }),
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
    on(event, handler) {
      listeners.set(event, handler);
    }
  };
  return { ctx, effects, entries, listeners, layersCalls, gates, resolveMount };
}

/** Flush pending microtasks and timer callbacks (the RPC stub is async). */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Load the client composition into its own VM context. */
function loadComposition() {
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
  const script = [
    storeSource,
    localesSource,
    indexSource,
    ';globalThis.__indexExports = { apply };'
  ].join('\n');
  vm.runInContext(script, sandbox, { filename: 'src/client/index.ts' });
  return sandbox.__indexExports;
}

const { apply } = loadComposition();

/** Run apply() and wait for the mount to settle. */
async function mounted(options) {
  const harness = makeHarness(options);
  apply(harness.ctx);
  await settle();
  harness.resolveMount(() => {});
  const remoteEffect = harness.effects.find((effect) => effect.label === 'dsh-prompt-library: remote');
  assert.ok(remoteEffect, 'the Remote effect must be registered');
  await remoteEffect.result;
  await settle();
  return harness;
}

/** The chip-strip VM context: React is a recorder and useEffect is captured. */
const chipsEffects = [];
const chipsSandbox = {
  console,
  React: {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    }
  },
  useEffect(callback, deps) {
    chipsEffects.push({ callback, deps });
  }
};
vm.createContext(chipsSandbox);
{
  const script = [chipsSource, ';globalThis.__chips = { LayersDock };'].join('\n');
  vm.runInContext(script, chipsSandbox, { filename: 'src/client/chips.ts' });
}
const { LayersDock } = chipsSandbox.__chips;

test('index: a pre-mount layer warm-up is retried once the Remote mount settles', async () => {
  const { entries, layersCalls } = await mounted();
  assert.deepEqual([...layersCalls], ['s1'], 'only the post-mount sweep reaches the host');
  const dock = entries.get('conversation.input.dock');
  assert.ok(dock, 'the dock slot must be registered');
  const injected = dock.inject('s1');
  const shown = injected.hooks.layers.getSnapshot();
  assert.deepEqual([...shown.layers].map((layer) => layer.promptId), ['p_1', 'p_2']);
  assert.equal(shown.totalTokens, 2);
});

test('index: the dock injects sessionId and an ensure that reads that session on its own', async () => {
  const { entries, layersCalls } = await mounted();
  const injected = entries.get('conversation.input.dock').inject('s9');
  assert.equal(injected.sessionId, 's9');
  assert.equal(typeof injected.ensure, 'function');
  layersCalls.length = 0;
  // No session-list change: the mount/refresh path alone must bring layers back.
  injected.ensure();
  await settle();
  assert.deepEqual([...layersCalls], ['s9'], 'ensure reads its own session');
  assert.deepEqual(
    [...injected.hooks.layers.getSnapshot().layers].map((layer) => layer.promptId),
    ['p_1', 'p_2'],
    'the read lands in the dock store, so the chips appear'
  );
});

test('index: consecutive ensures share one in-flight read and a success is remembered', async () => {
  const { entries, layersCalls, gates } = await mounted({ sessionIds: [], deferLayers: true });
  const injected = entries.get('conversation.input.dock').inject('s3');
  injected.ensure();
  injected.ensure();
  injected.ensure();
  await settle();
  assert.deepEqual([...layersCalls], ['s3'], 'three ensures, one request');

  gates.shift()();
  await settle();
  injected.ensure();
  await settle();
  assert.deepEqual([...layersCalls], ['s3'], 'a successful read is not repeated');
});

test('index: a failed read is not remembered, so the next ensure retries', async () => {
  const { entries, layersCalls } = await mounted({ sessionIds: [], failLayers: 1 });
  const injected = entries.get('conversation.input.dock').inject('s4');
  injected.ensure();
  await settle();
  assert.deepEqual([...layersCalls], ['s4']);
  assert.equal(injected.hooks.layers.getSnapshot().layers.length, 0, 'a failure leaves the strip empty');

  injected.ensure();
  await settle();
  assert.deepEqual([...layersCalls], ['s4', 's4'], 'the retry reads again');
  assert.deepEqual([...injected.hooks.layers.getSnapshot().layers].map((layer) => layer.promptId), ['p_1', 'p_2']);
});

test('index: a connection reset drops the response that was already in flight', async () => {
  const { entries, listeners, layersCalls, gates } = await mounted({ sessionIds: [], deferLayers: true });
  const injected = entries.get('conversation.input.dock').inject('s5');
  injected.ensure();
  await settle();
  assert.deepEqual([...layersCalls], ['s5']);

  const reset = listeners.get('connection/reset');
  assert.equal(typeof reset, 'function', 'the reset handler must be installed');
  reset();
  await settle();

  // The old connection answers now: it belongs to a dead generation.
  gates.shift()();
  await settle();
  assert.deepEqual([...injected.hooks.layers.getSnapshot().layers], [], 'a stale response never lands in the store');

  // ...and it did not mark the session ready either, so the next ensure retries.
  injected.ensure();
  await settle();
  assert.deepEqual([...layersCalls], ['s5', 's5'], 'the post-reset ensure reads again');
});

test('chips: the dock requests its read from an effect on mount (AC-3)', () => {
  chipsEffects.length = 0;
  const calls = [];
  const props = {
    sessionId: 's1',
    useLayers: () => ({ layers: [], totalTokens: 0, limit: 3 }),
    ensure: () => calls.push('ensure'),
    t: (key) => key,
    openEditor() {},
    remove() {}
  };
  const tree = LayersDock(props);
  assert.equal(tree, null, 'an untouched session still renders nothing');
  assert.deepEqual(calls, [], 'the read is not fired from render');
  assert.equal(chipsEffects.length, 1, 'one mount effect is registered');
  assert.deepEqual([...chipsEffects[0].deps], ['s1'], 'the effect follows the session id');
  chipsEffects[0].callback();
  assert.deepEqual(calls, ['ensure'], 'mounting the dock asks for this session layers');
});

test('chips: the strip keeps its 0.1 layout (one chip per layer plus the total)', () => {
  chipsEffects.length = 0;
  const props = {
    sessionId: 's1',
    useLayers: () => layersValue(),
    ensure() {},
    t: (key) => key,
    openEditor() {},
    remove() {}
  };
  const tree = LayersDock(props);
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'dsh_promptLibrary_chips');
  assert.equal(tree.children.length, 2, 'the chip row plus one trailing total');
  const [chipNodes, total] = tree.children;
  assert.equal(chipNodes.length, 2, 'one chip per layer');
  const [first, second] = chipNodes;
  const [titleButton, removeButton] = first.children;
  assert.equal(titleButton.type, 'button', 'the title is still a button (click to re-edit)');
  assert.deepEqual([...titleButton.children], ['one']);
  assert.deepEqual([...removeButton.children], ['×'], 'the remove control keeps its glyph');
  assert.deepEqual([...second.children[0].children], ['two']);
  assert.equal(total.props.className, 'dsh_promptLibrary_chipTotal');
});
