/**
 * The `promptLibrary` Remote service (design §5.4).
 *
 * Extends `TypertRemoteService` so the service instance carries the
 * `typertRemote` binding the Host Gateway requires
 * (`validateBinding` in …/dsh-api-gateway/lib/index.js, as of 0.2.1-rc.2 —
 * a plain cordis Service is rejected with gateway/binding-invalid). The
 * `@Remote` markers are attached without decorator syntax by
 * `markRemoteMethods` below: they are the gateway's source-mode fallback when
 * no strict definition is registered.
 *
 * Every mutating call returns the full library snapshot, so the client store
 * replaces its state without a second round trip.
 */
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createPromptId, parseImportText } from './store.js';

/** Endpoint methods exposed on the wire (also the marker list). */
export const REMOTE_METHODS = Object.freeze([
  'list',
  'save',
  'removePrompt',
  'importLibrary',
  'layers',
  'addLayer',
  'removeLayer',
  'clearLayers'
]);

/**
 * Error codes this service can put on the wire.
 *
 * Design §5.4 names `layer-limit / not-found / library-corrupt / stale-write`.
 * What is actually emitted (README「错误码对照」maps every code):
 *   - `layer-limit`      — LayerRegistry.add refused a fourth distinct layer;
 *   - `not-found`        — save/removePrompt named an id the library does not hold;
 *   - `library-full`     — the 200-prompt cap (design §6.1);
 *   - `library-readonly` — the file was written by a newer version (design §9);
 *   - `library-invalid`  — the fail-closed write check refused a prompt;
 *   - `input-invalid`    — a request that failed its wire schema;
 *   - `import-invalid`   — an import batch with at least one invalid entry;
 *   - `layer-read-failed`— the session layer file could not be read, so the write
 *                          was refused instead of overwriting it (0.2 design §6.3);
 *   - `layer-readonly`   — the session layer file was written by a newer version;
 *   - `session-invalid`  — the session id is not a safe layer-file name;
 *   - `internal`         — anything else.
 * `library-corrupt` is deliberately NOT an error code: a corrupt file is
 * quarantined and reported on the snapshot (`corruptBackup` +
 * `notice: "library-corrupt"`), which is what design §5.1 prescribes.
 * `stale-write` is unused because v0.1 has no revision comparison (design §9:
 * last write wins).
 */

/** The Remote service mounted under the `promptLibrary` cordis key. */
export class PromptLibraryService extends TypertRemoteService {
  /** Prompt library file access. */
  store;
  /**
   * Per-session layer registry (persisted per session through the injected
   * store, 0.2 design §5.4). Deliberately NOT named `layers`: an instance field
   * would shadow the `layers(sessionId)` endpoint below, which is why
   * `promptLibrary/layers` used to fail with "service.layers is not a function".
   */
  registry;
  /** Shared wire contract (schemas + limits). */
  contract;
  /** Display-only library path, kept for the client's post-restart sanity read. */
  libraryPath = '';

  /**
   * @param {object} ctx - owning cordis context.
   * @param {{store: object, layers: object, contract: object}} deps - collaborators.
   */
  constructor(ctx, { store, layers, contract }) {
    super(ctx, 'promptLibrary');
    this.store = store;
    this.registry = layers;
    this.contract = contract;
  }

  /**
   * Project a loaded library into the wire snapshot.
   *
   * Public on purpose: the host gateway invokes Remote endpoints with the
   * context's service Proxy as `this`; a private `#` member fails V8's brand
   * check with "Receiver must be an instance of class ..." (real gateway
   * reproduction, DSH 0.2.1-rc.3). Keep every endpoint helper public.
   * @param {object} library - loaded library.
   * @param {{corruptBackup: string|null, readOnly: boolean, notice: string|null}} state - report flags.
   * @returns {object} LibrarySnapshot.
   */
  snapshotOf(library, state) {
    return {
      prompts: library.prompts,
      updatedAt: library.updatedAt ?? null,
      filePath: this.store.filePath,
      readOnly: state.readOnly === true,
      corruptBackup: state.corruptBackup ?? null,
      notice: state.notice ?? null
    };
  }

  /** @returns {Promise<object>} the current library snapshot. */
  async list() {
    const state = await this.store.load();
    return this.snapshotOf(state.library, state);
  }

  /**
   * Create or update one prompt.
   * @param {{id?: string, title: string, body: string, tags: string[]}} input - prompt content.
   * @returns {Promise<object>} the library snapshot after the write.
   */
  async save(input) {
    const parsed = this.contract.promptInputSchema.safeParse(input);
    if (!parsed.success) throw remoteError('input-invalid', parsed.error.issues[0]?.message ?? 'invalid prompt input');
    const now = new Date().toISOString();
    const outcome = await this.store.update((library) => {
      const prompts = [...library.prompts];
      if (parsed.data.id === undefined) {
        if (prompts.length >= this.contract.LIMITS.prompts) throw Object.assign(new Error('the library is full'), { code: 'library-full' });
        const created = {
          id: createPromptId(),
          title: parsed.data.title,
          body: parsed.data.body,
          tags: [...parsed.data.tags],
          createdAt: now,
          updatedAt: now
        };
        prompts.push(created);
        return { library: { ...library, prompts }, value: created.id };
      }
      const index = prompts.findIndex((prompt) => prompt.id === parsed.data.id);
      if (index < 0) throw Object.assign(new Error(`no prompt with id "${parsed.data.id}"`), { code: 'not-found' });
      const previous = prompts[index];
      prompts[index] = {
        ...previous,
        title: parsed.data.title,
        body: parsed.data.body,
        tags: [...parsed.data.tags],
        updatedAt: now
      };
      return { library: { ...library, prompts }, value: previous.id };
    }).catch((error) => {
      throw remoteFailure(error, 'save failed');
    });
    return this.snapshotOf(outcome.library, outcome.state);
  }

  /**
   * Remove one prompt.
   *
   * The wire method is `removePrompt`, not `remove`: the latter collides with
   * `RemoteNamespaceService.prototype.remove` on the client gateway
   * (@deepseek-ai/dsh-api-gateway/lib/client.browser.js:1957-1958 / :2012,
   * as of 0.2.1-rc.3) and made the whole Remote contribution fail to mount.
   * Host behavior is unchanged.
   * @param {string} id - prompt id.
   * @returns {Promise<object>} the library snapshot after the write.
   */
  async removePrompt(id) {
    const outcome = await this.store.update((library) => {
      const prompts = library.prompts.filter((prompt) => prompt.id !== id);
      if (prompts.length === library.prompts.length) throw Object.assign(new Error(`no prompt with id "${id}"`), { code: 'not-found' });
      return { library: { ...library, prompts } };
    }).catch((error) => {
      throw remoteFailure(error, 'remove failed');
    });
    return this.snapshotOf(outcome.library, outcome.state);
  }

  /**
   * Import a library file (design §5.8: replace = overwrite the whole
   * library, merge = by id with the imported entry winning; the batch is
   * all-or-nothing — see README「其他已文档化的小偏差」).
   * @param {{mode: 'replace'|'merge', text: string}} request - import request.
   * @returns {Promise<{imported: number, replaced: boolean}>} import outcome.
   */
  async importLibrary(request) {
    const parsed = this.contract.importRequestSchema.safeParse(request);
    if (!parsed.success) throw remoteError('input-invalid', parsed.error.issues[0]?.message ?? 'invalid import request');
    const batch = parseImportText(parsed.data.text, this.contract);
    if (!batch.ok) {
      throw remoteError('import-invalid', `import rejected: ${batch.message}`, { invalid: batch.invalid });
    }
    const replaced = parsed.data.mode === 'replace';
    if (replaced) {
      // Replace is ONE implementation: PromptStore.replaceAll (same serialized
      // write queue as every other mutation). parseImportText already refused a
      // batch above the 200-prompt cap, so no extra length check is needed here.
      await this.store.replaceAll(batch.prompts).catch((error) => {
        throw remoteFailure(error, 'import failed');
      });
    } else {
      await this.store.update((library) => {
        const prompts = mergeById(library.prompts, batch.prompts);
        if (prompts.length > this.contract.LIMITS.prompts) {
          throw Object.assign(new Error(`the merged library would hold more than ${this.contract.LIMITS.prompts} prompts`), { code: 'library-full' });
        }
        return { library: { ...library, prompts } };
      }).catch((error) => {
        throw remoteFailure(error, 'import failed');
      });
    }
    return { imported: batch.prompts.length, replaced };
  }

  /**
   * Read one session's layers.
   *
   * A read failure never becomes a wire error (0.2 design §6.3): the registry
   * answers an empty snapshot, so a corrupt/oversized/unreadable layer file
   * cannot break the sidebar or the session list. The only wire errors in this
   * method are defensive (a broken registry stub).
   * @param {string} sessionId - session identity.
   * @returns {Promise<object>} that session's LayerSnapshot.
   */
  async layers(sessionId) {
    try {
      return this.registry.snapshot(sessionId);
    } catch (error) {
      console.error('[dsh-prompt-library] layer snapshot failed', sessionId, error);
      return { layers: [], totalTokens: 0, limit: this.contract.LIMITS.layers };
    }
  }

  /**
   * Add or update one session layer.
   * @param {string} sessionId - session identity.
   * @param {{promptId: string, title: string, body: string}} input - layer content.
   * @returns {Promise<object>} that session's LayerSnapshot.
   */
  async addLayer(sessionId, input) {
    const parsed = this.contract.layerInputSchema.safeParse(input);
    if (!parsed.success) throw remoteError('input-invalid', parsed.error.issues[0]?.message ?? 'invalid layer input');
    try {
      return await this.registry.add(sessionId, parsed.data);
    } catch (error) {
      throw remoteFailure(error, 'addLayer failed');
    }
  }

  /**
   * Remove one session layer (idempotent; persists the empty state when the last
   * layer goes away).
   * @param {string} sessionId - session identity.
   * @param {string} promptId - layer to drop.
   * @returns {Promise<object>} that session's LayerSnapshot.
   */
  async removeLayer(sessionId, promptId) {
    try {
      return await this.registry.remove(sessionId, promptId);
    } catch (error) {
      throw remoteFailure(error, 'removeLayer failed');
    }
  }

  /**
   * Clear every layer of one session (persists the empty state).
   * @param {string} sessionId - session identity.
   * @returns {Promise<object>} the empty LayerSnapshot.
   */
  async clearLayers(sessionId) {
    try {
      return await this.registry.clear(sessionId);
    } catch (error) {
      throw remoteFailure(error, 'clearLayers failed');
    }
  }
}

/**
 * Merge imported prompts by id: the imported entry replaces an existing row in
 * place, and ids the library does not hold are appended in import order.
 * @param {object[]} existing - current prompts (library array order).
 * @param {object[]} imported - validated imported prompts.
 * @returns {object[]} merged prompts.
 */
export function mergeById(existing, imported) {
  const byId = new Map(imported.map((prompt) => [prompt.id, prompt]));
  const merged = existing.map((prompt) => byId.get(prompt.id) ?? prompt);
  for (const prompt of imported) {
    if (!existing.some((current) => current.id === prompt.id)) merged.push(prompt);
  }
  return merged;
}

/**
 * Convert one host failure into a wire RemoteError.
 * @param {unknown} error - caught value.
 * @param {string} fallback - message used when the error carries no message.
 * @returns {RemoteError} the wire failure.
 */
function remoteFailure(error, fallback) {
  if (error !== null && typeof error === 'object' && typeof error.isDSHRemoteError === 'boolean' && error.isDSHRemoteError) return error;
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'internal';
  const message = error instanceof Error ? error.message : fallback;
  return new RemoteError(code, message, {});
}

/**
 * Build one wire RemoteError from this plugin's own error vocabulary.
 *
 * The platform types `RemoteError`'s code against its `RemoteErrorDetailsMap`
 * (@deepseek-ai/dsh-typert-protocol). This plugin's codes are its own (design
 * §5.4 plus README「错误码对照」) and are declared to the gateway through the
 * strict contract instead, so the platform's narrower key union is widened here
 * once, in one place.
 * @param code - one of this plugin's wire codes.
 * @param message - human-readable message.
 * @param details - optional details payload.
 * @returns the wire failure.
 */
function remoteError(code: string, message: string, details: Record<string, unknown> = {}): RemoteError {
  return new RemoteError(code as never, message, details as never);
}

/**
 * Attach `@Remote` markers without decorator syntax (source-mode fallback).
 *
 * The protocol's decorator is a plain function pair: `Remote(name)` returns a
 * method decorator that calls `context.addInitializer(fn)`, and `fn` marks
 * `Object.getPrototypeOf(this)`. Running the initializer against a bare
 * prototype child reproduces exactly what the compiler helper would do.
 * @param {Function} Class - the service class.
 * @param {readonly string[]} methods - public instance methods to mark.
 * @returns {void}
 */
export function markRemoteMethods(Class, methods = REMOTE_METHODS) {
  for (const method of methods) {
    if (typeof Class.prototype[method] !== 'function') continue;
    const initializers = [];
    const context = {
      kind: 'method',
      name: method,
      static: false,
      private: false,
      addInitializer(initializer) {
        initializers.push(initializer);
      }
    };
    Remote(method)(Class.prototype[method], context as any);
    const carrier = Object.create(Class.prototype);
    for (const initializer of initializers) initializer.call(carrier);
  }
}

// Registered once at module load: markers live on the class prototype.
markRemoteMethods(PromptLibraryService);
