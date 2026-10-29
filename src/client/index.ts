/**
 * dsh-prompt-library — client half.
 *
 * Registers four contributions and one trigger source:
 *   - `/` trigger source (order -10, group "提示词" first, cap 20 rows);
 *   - `conversation.input.overlay` -> the edit-confirm dialog;
 *   - `conversation.input.dock`   -> the session system-layer chips;
 *   - `settings.section`          -> library CRUD + import/export.
 *
 * Everything the browser half needs over "plain JSON" lives in the shared
 * contract (src/contract.js) and the shared estimator (src/shared/tokens.js);
 * tsdown inlines both into this bundle, so the only module ids required at
 * runtime are `react` and `zod` — both present in the web boot facade's static
 * module map (`function OZ(){return{react:…,zod:…,...}}` in
 * resources/app.asar!/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js).
 */

import { contract } from './contract.js';
import { estimateTokens } from '../shared/tokens.js';
import { createClientStore } from './store.js';
import { NS, zh, en } from './locales.js';
import { adoptStyles } from './styles.js';
import { createPromptSource } from './source.js';
import { PromptDialog } from './dialog.js';
import { LayersDock } from './chips.js';
import { PromptLibrarySection } from './settings.js';

/** Cordis plugin name (matches the ModuleLoader id and dsh.plugin.json). */
export const name = 'dsh-prompt-library';

/** Services required before load (same set dsh-at-file relies on). */
export const inject = ['inputTriggers', 'sessions', 'connection', 'remote', 'slots', 'locale'];

/** The `promptLibrary` Remote contribution mounted into `ctx.remote`. */
const PROMPT_LIBRARY_REMOTE = { package: 'dsh-prompt-library', descriptors: contract.INVOCATIONS };

/** Empty client-side library view (rendered before the first host read). */
function emptyLibraryView() {
  return {
    available: false,
    prompts: [],
    updatedAt: null,
    filePath: '',
    readOnly: false,
    corruptBackup: null,
    notice: null,
    error: null
  };
}

/** Empty layer view for a session that has not been read yet. */
function emptyLayerView() {
  return { layers: [], totalTokens: 0, limit: contract.LIMITS.layers };
}

/**
 * Project a host LibrarySnapshot into the client view.
 * @param {object} snapshot - wire snapshot.
 * @returns {object} client view.
 */
function libraryView(snapshot) {
  return {
    available: true,
    prompts: Array.isArray(snapshot?.prompts) ? snapshot.prompts : [],
    updatedAt: snapshot?.updatedAt ?? null,
    filePath: typeof snapshot?.filePath === 'string' ? snapshot.filePath : '',
    readOnly: snapshot?.readOnly === true,
    corruptBackup: typeof snapshot?.corruptBackup === 'string' ? snapshot.corruptBackup : null,
    notice: snapshot?.notice ?? null,
    error: null
  };
}

/**
 * Compose the client half.
 * @param {object} ctx - client cordis root context.
 * @returns {void}
 */
export function apply(ctx) {
  adoptStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-prompt-library: dictionaries');
  const t = ctx.locale.bind(NS);
  const slots = ctx.slots ?? ctx.get('slots');
  const inputTriggers = ctx.get('inputTriggers');
  const sessions = ctx.get('sessions');

  const libraryStore = createClientStore(emptyLibraryView());
  const layerStores = new Map();
  const dialogStores = new Map();
  /** Sessions whose layers were read successfully (skips a redundant read). */
  const layersReady = new Set();
  /** `sessionId -> in-flight read` so concurrent ensures share one request. */
  const oneFlight = new Map();
  /** Connection generation: a reset discards results from the old connection. */
  let epoch = 0;

  /** The mounted Remote namespace face (undefined until $mount settles). */
  let remote;
  /** Menu-cache invalidator, bound right after the source is built. */
  let invalidateSource = () => {};

  /**
   * Call one Remote method and normalize the failure branch.
   * @param {string} method - namespace method.
   * @param {...any} args - wire arguments.
   * @returns {Promise<{ok: true, value: any}|{ok: false, code: string, message: string, invalid?: number}>} outcome.
   */
  const call = async (method, ...args) => {
    const handle = remote;
    if (handle === undefined) {
      return { ok: false, code: 'remote-unavailable', message: 'the promptLibrary Remote is not mounted' };
    }
    try {
      const result = await handle[method](...args);
      if (result?.ok === true) return { ok: true, value: result.value };
      const error = result?.error ?? {};
      return {
        ok: false,
        code: typeof error.code === 'string' ? error.code : 'error',
        message: typeof error.message === 'string' ? error.message : 'unknown failure',
        invalid: typeof error.details?.invalid === 'number' ? error.details.invalid : undefined
      };
    } catch (error) {
      return { ok: false, code: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  };

  /** Per-session layer store (lazily created). */
  const layerStore = (sessionId) => {
    const key = String(sessionId);
    let store = layerStores.get(key);
    if (store === undefined) {
      store = createClientStore(emptyLayerView());
      layerStores.set(key, store);
    }
    return store;
  };

  /** Per-session dialog store (lazily created). */
  const dialogStore = (sessionId) => {
    const key = String(sessionId);
    let store = dialogStores.get(key);
    if (store === undefined) {
      store = createClientStore(null);
      dialogStores.set(key, store);
    }
    return store;
  };

  /** Read the library from the host and publish it. */
  const refreshLibrary = async (invalidateMenu = true) => {
    const result = await call('list');
    if (invalidateMenu) invalidateSource();
    if (result.ok) {
      libraryStore.set(libraryView(result.value));
      return { ok: true, value: result.value };
    }
    libraryStore.set({ ...emptyLibraryView(), error: result.message });
    return result;
  };

  /**
   * Read one session's layers and publish them.
   *
   * The generation is captured before the call and re-checked before the store
   * write: a response that arrives after `connection/reset` belongs to the old
   * connection and must not overwrite the new state (design §5.6).
   * @param {string} sessionId - session identity.
   * @returns {Promise<object>} the normalized call outcome.
   */
  const refreshLayers = async (sessionId) => {
    const key = String(sessionId);
    const startedAt = epoch;
    const result = await call('layers', key);
    if (result.ok && startedAt === epoch) layerStore(key).set(result.value);
    return result;
  };

  /**
   * Ensure one session's layers are read (design §5.6 / FR-4).
   *
   * - a session that already read successfully is skipped;
   * - a session with a read in flight reuses that promise (one request, not N);
   * - a failure is NOT marked ready, so the next mount/ensure retries;
   * - the returned promise never rejects (the caller is a React effect).
   * @param {string|number} sessionId - session identity.
   * @returns {Promise<{ok: boolean}>} the read outcome.
   */
  const ensureLayers = (sessionId) => {
    const key = String(sessionId);
    if (layersReady.has(key)) return Promise.resolve({ ok: true });
    const running = oneFlight.get(key);
    if (running !== undefined) return running;
    const startedAt = epoch;
    const run = refreshLayers(key)
      .then((result) => {
        if (startedAt !== epoch) return result; // connection reset: drop the landing
        if (result.ok) layersReady.add(key);
        else layersReady.delete(key);
        return result;
      })
      .catch((error) => {
        console.error('[dsh-prompt-library] layer hydrate failed', key, error);
        layersReady.delete(key);
        return { ok: false, code: 'error', message: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => {
        if (oneFlight.get(key) === run) oneFlight.delete(key);
      });
    oneFlight.set(key, run);
    return run;
  };

  /**
   * Forget every hydrate mark and in-flight read (connection reset or unmount).
   * @returns {void}
   */
  const resetLayerHydration = () => {
    epoch += 1;
    layersReady.clear();
    oneFlight.clear();
  };

  /**
   * Read the layers of every session the client knows about.
   *
   * This used to run inside the slot `inject` callbacks, i.e. during render,
   * firing an async RPC plus a store write from a render pass (audit
   * should-fix 11). It runs from an effect and from the session-list
   * subscription instead; a slot `inject` must stay a pure projection.
   */
  const warmSessionLayers = () => {
    const snapshot = sessions?.list?.getSnapshot();
    const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : Object.keys(snapshot?.byId ?? {});
    for (const id of ids) void ensureLayers(id);
  };

  /** Publish a library snapshot returned by a mutating call (design §5.5: a write invalidates the menu cache). */
  const applyLibrary = (snapshot) => {
    libraryStore.set(libraryView(snapshot));
    invalidateSource();
  };

  /** Open the edit-confirm dialog for one prompt pick. */
  const openDialog = (sessionId, pending) => {
    dialogStore(sessionId).set(pending);
  };

  /** Close the dialog of one session. */
  const closeDialog = (sessionId) => {
    dialogStore(sessionId).set(null);
  };

  /** Add (or update) one session layer. */
  const addLayer = async (sessionId, input) => {
    const result = await call('addLayer', String(sessionId), input);
    if (result.ok) layerStore(sessionId).set(result.value);
    return result;
  };

  /** Remove one session layer. */
  const removeLayer = async (sessionId, promptId) => {
    const result = await call('removeLayer', String(sessionId), promptId);
    if (result.ok) layerStore(sessionId).set(result.value);
    return result;
  };

  /** Create or update one prompt in the library. */
  const savePrompt = async (input) => {
    const result = await call('save', input);
    if (result.ok) applyLibrary(result.value);
    return result;
  };

  /** Remove one prompt from the library. */
  const removePrompt = async (id) => {
    const result = await call('removePrompt', id);
    if (result.ok) applyLibrary(result.value);
    return result;
  };

  /** Import a library file (replace or merge; all-or-nothing on the host). */
  const importLibrary = async (request) => {
    const result = await call('importLibrary', request);
    if (result.ok) await refreshLibrary(true);
    return result;
  };

  /** Re-open an existing layer for editing (design §12.3: click the chip title). */
  const openLayerEditor = async (sessionId, promptId) => {
    const snapshot = layerStore(sessionId).getSnapshot();
    const layer = (snapshot?.layers ?? []).find((entry) => entry.promptId === promptId);
    if (layer !== undefined) {
      openDialog(sessionId, { kind: 'edit-layer', layer, span: null, delivery: 'system' });
      return;
    }
    const library = libraryStore.getSnapshot();
    const prompt = (library?.prompts ?? []).find((entry) => entry.id === promptId);
    if (prompt !== undefined) {
      openDialog(sessionId, { kind: 'use', prompt, span: null, delivery: 'system' });
      return;
    }
    console.error('[dsh-prompt-library] no layer or library prompt for', promptId);
  };

  // The '/' trigger source. The factory only calls these deps at menu time, so
  // the mutual reference with refreshLibrary above is safe.
  const promptSource = createPromptSource({
    loadLibrary: async () => {
      const result = await call('list');
      if (result.ok) {
        const view = libraryView(result.value);
        libraryStore.set(view);
        return view;
      }
      // The settings section still needs its failure banner, but the MENU must
      // keep the rows it already has (design §9 "RPC 不可用 -> 菜单只读缓存"),
      // so the failure is signalled by rejecting: source.js then serves its warm
      // cache instead of caching an empty library (audit should-fix 10).
      libraryStore.set({ ...emptyLibraryView(), error: result.message });
      throw new Error(result.message);
    },
    openDialog,
    t,
    estimateTokens
  });
  const source = promptSource.source;
  invalidateSource = promptSource.invalidate;

  // Mount the Remote namespace, then load the library once.
  //
  // The async body's cleanup IS registered by cordis: `Fiber._execute` turns a
  // thenable effect into `effect.then(safeCollect)`, and `safeCollect` pushes
  // the resolved disposer onto the effect's `disposables` list
  // (@deepseek-ai/cordis src/fiber.ts:360-375, collected at :449-455; the effect
  // disposer waits for the async setup before running them, :505-514; built
  // runtime resources/app.asar!/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1139-1146).
  // dsh-at-file's remote effect uses exactly this shape
  // (.artifacts/prompt-library-review/_ref/at-file/client__index.ts:160-172), so
  // the cleanup below is not lost — no "detached async IIFE" rewrite is needed
  // (code-review round 2, finding #3).
  ctx.effect(async () => {
    const dispose = await ctx.remote.$mount(PROMPT_LIBRARY_REMOTE);
    remote = ctx.reflect.get('remote.promptLibrary');
    if (remote === undefined) {
      console.error('[dsh-prompt-library] the promptLibrary Remote namespace did not mount');
      return () => {
        void dispose();
      };
    }
    await refreshLibrary(true);
    // Prewarm the '/' menu cache now that the host answers (round 1, finding #5): the
    // first menu open after a mount paints from memory instead of paying a cold
    // read. refreshLibrary() above invalidated the cache, so this re-reads once.
    source.warm();
    // The layer subscription above ran before this mount settled, so every
    // session it touched failed with `remote-unavailable` and stayed unmarked.
    // Re-read EVERY known session now that the host can answer: the old sweep
    // visited only stores that already existed, which after a client reload/F5
    // is none — the host-held layers never showed up (code-review round 2,
    // finding #1).
    resetLayerHydration();
    warmSessionLayers();
    return () => {
      remote = undefined;
      resetLayerHydration();
      void dispose();
    };
  }, 'dsh-prompt-library: remote');

  // The trigger source itself.
  ctx.effect(() => {
    if (inputTriggers === undefined) {
      console.error('[dsh-prompt-library] the inputTriggers service is unavailable; the / picker stays off');
      return () => {};
    }
    const dispose = inputTriggers.registerSource(source);
    return () => {
      dispose();
    };
  }, 'dsh-prompt-library: / source');

  // A reconnect rebuilds the host: drop caches and re-read.
  ctx.on('connection/reset', () => {
    invalidateSource();
    // A rebuilt host is a new generation: forget the hydrate marks and the reads
    // still in flight, so their answers cannot land in the fresh state.
    resetLayerHydration();
    // Re-read, then prewarm the menu cache from that same rebuild (round 1, finding #5).
    void refreshLibrary(false).then(() => source.warm());
    warmSessionLayers();
  });

  // Warm the per-session layer snapshots outside render: once on mount and on
  // every session-list change (new/closed sessions). The stores themselves are
  // created lazily, so a session that appears later still has a hook face.
  ctx.effect(() => {
    const list = sessions?.list;
    if (list === undefined || typeof list.subscribe !== 'function') {
      if (sessions !== undefined) console.error('[dsh-prompt-library] the sessions list is unavailable; layer warm-up is off');
      return () => {};
    }
    const dispose = list.subscribe(warmSessionLayers);
    warmSessionLayers();
    return () => {
      dispose();
    };
  }, 'dsh-prompt-library: layer warm-up');

  // Session chips above the composer.
  slots.inject('conversation.input.dock', () => slots.register({
    name: 'conversation.input.dock',
    id: 'prompt-library',
    order: 30,
    locale: NS,
    inject: (sessionId) => ({
      sessionId: String(sessionId),
      // The dock reads its own session on mount (0.2 FR-4): a refresh no longer
      // depends on the session list changing. Idempotent, and wrapped so even a
      // synchronous surprise can never escape into the component render
      // (design §5.6: "ensure 外层再包 try/catch").
      ensure: () => {
        try {
          void ensureLayers(sessionId);
        } catch (error) {
          console.error('[dsh-prompt-library] layer ensure failed', sessionId, error);
        }
      },
      hooks: { layers: layerStore(sessionId) },
      openEditor: (promptId) => {
        void openLayerEditor(sessionId, promptId);
      },
      remove: (promptId) => {
        void removeLayer(sessionId, promptId);
      }
    })
  }, LayersDock));

  // Edit-confirm dialog (and layer re-edit), above the composer like the menu.
  slots.inject('conversation.input.overlay', () => slots.register({
    name: 'conversation.input.overlay',
    id: 'prompt-library-dialog',
    order: 5,
    locale: NS,
    inject: (sessionId) => ({
      sessionId,
      hooks: { dialog: dialogStore(sessionId), layers: layerStore(sessionId) },
      close: () => closeDialog(sessionId),
      addLayer: (input) => addLayer(sessionId, input)
    })
  }, PromptDialog));

  // Library management.
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'prompt-library',
    order: 58,
    label: () => t('settings.title'),
    locale: NS,
    inject: () => ({
      hooks: { library: libraryStore },
      savePrompt,
      removePrompt,
      importLibrary,
      reloadLibrary: () => refreshLibrary(true)
    })
  }, PromptLibrarySection));

  // `sessions` feeds the layer warm-up above; log once if it is missing so a
  // broken composition is visible instead of silently showing no chips.
  if (sessions === undefined) console.error('[dsh-prompt-library] the sessions service is unavailable');
}
