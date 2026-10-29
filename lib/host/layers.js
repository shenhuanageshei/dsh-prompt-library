/**
 * Per-session system-prompt layers, persisted per session (0.2 design §5.4).
 *
 * The registry is the only thing the rest of the host talks to: it owns the
 * in-memory state (rows / stamps / read-only flag / backoff), and it delegates
 * every byte that reaches the disk to an injected {@link LayerStoreLike}
 * (`src/host/layer-store.ts`). Two rules come straight from the design:
 *
 *   - **Write after read, commit after disk.** Every mutation first re-reads the
 *     session's layer file (forcing a load even while a read backoff is armed),
 *     then persists the next state, and only a successful persist updates the
 *     in-memory rows. A failed persist leaves memory (and therefore the chips
 *     and the system prompt) exactly as it was: no fake chip that disappears on
 *     the next restart.
 *   - **Reads never throw.** The system-prompt assembly and the `layers` RPC call
 *     `sectionText` / `snapshot`, which swallow every failure and answer an empty
 *     state. An I/O-class read failure also arms a 30s backoff and refuses
 *     writes (`layer-read-failed`) so empty memory can never overwrite a file
 *     that exists but could not be read. A content-class failure (bad JSON,
 *     oversized, ...) does NOT arm the backoff: the next user write may repair
 *     the broken file (§5.2).
 *
 * With no store injected the registry degrades to the 0.1 pure-memory behavior
 * (single-process, never persisted), which is what the unit tests and any
 * non-persistent construction use.
 *
 * At most three layers per session; adding an existing `promptId` updates that
 * layer in place (same slot, new text) and never counts against the limit.
 *
 * This module is deliberately dependency-free beyond the shared token estimator
 * (no cordis, no zod): the unit tests import it straight from
 * `lib/host/layers.js` under plain `node:test`.
 */
import { estimateTokens } from '../shared/tokens.js';
/** Error code thrown when a fourth layer is requested. */
export const LAYER_LIMIT_CODE = 'layer-limit';
/** Error code thrown when a read failure refuses a write (I/O class, no copy). */
export const LAYER_READ_FAILED_CODE = 'layer-read-failed';
/** Error code thrown when the layer file was written by a newer version. */
export const LAYER_READONLY_CODE = 'layer-readonly';
/** Error code thrown when a write (or its backup/rename) fails. */
export const LAYER_PERSIST_CODE = 'layer-persist';
/** Read-failure backoff window (design §5.4: 30 seconds). */
export const READ_FAILURE_BACKOFF_MS = 30_000;
/** Minimum delay between two fallback move-in attempts for one session. */
export const PROMOTION_RETRY_MS = 30_000;
/** Wire codes that pass through the registry unchanged (never re-wrapped). */
const PASSTHROUGH_CODES = new Set([
    LAYER_LIMIT_CODE,
    LAYER_READ_FAILED_CODE,
    LAYER_READONLY_CODE,
    LAYER_PERSIST_CODE,
    'session-invalid'
]);
/**
 * Build one coded error (the wire layer maps `error.code`).
 * @param {string} code - plugin error code.
 * @param {string} message - human-readable host/log message.
 * @returns {Error & {code: string}} the error.
 */
export function layerError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
/** @param {unknown} error - caught value. @returns {string} its `code`, or ''. */
function errorCode(error) {
    return error !== null && typeof error === 'object' && typeof error.code === 'string'
        ? String(error.code)
        : '';
}
/**
 * Project internal rows into the `LayerSnapshot` wire shape.
 * @param {LayerRow[]} rows - internal rows.
 * @param {number} limit - the session limit.
 * @returns {{layers: object[], totalTokens: number, limit: number}} snapshot.
 */
function snapshotOf(rows, limit) {
    const layers = rows.map((row) => ({
        promptId: row.promptId,
        title: row.title,
        body: row.body,
        tokens: row.tokens
    }));
    return {
        layers,
        totalTokens: layers.reduce((sum, row) => sum + row.tokens, 0),
        limit
    };
}
/**
 * Compute the next layer list for one add (same id updates in place; a fourth
 * distinct id is refused). Pure: the caller persists `next` before committing.
 * @param {LayerRow[]} list - current rows.
 * @param {{promptId: string, title: string, body: string}} input - validated input.
 * @param {number} limit - the session limit.
 * @returns {LayerRow[]} the next rows (a new array; `list` is never mutated).
 * @throws {Error & {code: string}} `layer-limit` for a fourth distinct layer.
 */
export function computeAdd(list, input, limit) {
    const tokens = estimateTokens(input.body);
    const index = list.findIndex((row) => row.promptId === input.promptId);
    if (index >= 0) {
        const next = list.slice();
        next[index] = { promptId: input.promptId, title: input.title, body: input.body, tokens };
        return next;
    }
    if (list.length >= limit) {
        // `layer-limit` is the contract: the client maps that CODE onto localized
        // product copy (src/client/dialog.ts -> dialogErrorText -> 'dialog.delivery.full'),
        // so this English sentence is only the host-side/log fallback and never the
        // string a Chinese dialog shows.
        throw layerError(LAYER_LIMIT_CODE, 'at most ' + limit + ' session layers');
    }
    return [...list, { promptId: input.promptId, title: input.title, body: input.body, tokens }];
}
/** The session layer registry. */
export class LayerRegistry {
    /** `Map<sessionId, LayerRow[]>` - the last state that was successfully committed. */
    #rows = new Map();
    /** `Map<sessionId, stamp|null>` - the stamp of the state in `#rows`. */
    #stamps = new Map();
    /** `Map<sessionId, boolean>` - the layer file was written by a newer version. */
    #readOnly = new Map();
    /** `Map<sessionId, epochMs>` - read-failure backoff deadline. */
    #failedUntil = new Map();
    /** `Map<sessionId, epochMs>` - last fallback move-in attempt. */
    #promotionAt = new Map();
    /** Tail of the serial write queue (one disk mutation at a time). */
    #tail = Promise.resolve();
    /** Persistence seam; null means memory-only (0.1 behavior). */
    #store;
    /** Maximum layers per session. */
    limit;
    /**
     * @param {{contract: {LIMITS: {layers: number}}, store?: LayerStoreLike|null}} options - contract limits plus the optional persistence seam.
     */
    constructor({ contract, store = null }) {
        this.limit = contract.LIMITS.layers;
        this.#store = store ?? null;
    }
    /** @returns {number} how many sessions currently hold at least one layer. */
    get size() {
        return this.#rows.size;
    }
    /**
     * Queue one write task behind the previous one.
     *
     * Every mutation is serialized so two concurrent adds can never interleave
     * their read/persist/commit steps (design §4.5 "并发加层").
     * @param {() => Promise<unknown>} task - the mutation.
     * @returns {Promise<unknown>} the task's own result/rejection.
     */
    #enqueue(task) {
        const run = this.#tail.then(task);
        this.#tail = run.then(() => undefined, () => undefined);
        return run;
    }
    /**
     * Drop the committed state of one session (the fail-open answer to a read
     * failure: "no file", never the previous values).
     * @param {string} sessionId - session identity.
     * @returns {void}
     */
    #clearSession(sessionId) {
        this.#rows.delete(sessionId);
        this.#stamps.set(sessionId, null);
        this.#readOnly.set(sessionId, false);
    }
    /**
     * Commit rows into memory (recomputing tokens), keeping `size` meaning
     * "sessions that hold at least one layer".
     * @param {string} sessionId - session identity.
     * @param {LayerRow[]|PersistedLayerRow[]} rows - rows to commit.
     * @returns {void}
     */
    #setRows(sessionId, rows) {
        if (!Array.isArray(rows) || rows.length === 0) {
            this.#rows.delete(sessionId);
            return;
        }
        this.#rows.set(sessionId, rows.map((row) => ({
            promptId: row.promptId,
            title: row.title,
            body: row.body,
            tokens: estimateTokens(row.body)
        })));
    }
    /**
     * Make sure one session's layers are loaded (design §5.4).
     *
     * Never throws. When the store reports an I/O failure with no usable copy the
     * committed state is dropped and a 30s backoff is armed, which is what turns
     * the next write into `layer-read-failed` instead of an overwrite.
     * @param {string} sessionId - session identity.
     * @param {boolean} [force] - ignore an armed backoff (used by every write).
     * @returns {void}
     */
    #ensureLoaded(sessionId, force = false) {
        if (this.#store === null)
            return; // memory-only mode (0.1 behavior)
        if (force !== true) {
            const until = this.#failedUntil.get(sessionId);
            if (until !== undefined && until > Date.now())
                return;
        }
        let result;
        try {
            result = this.#store.load(sessionId, this.#stamps.get(sessionId) ?? null);
        }
        catch (error) {
            console.error('[dsh-prompt-library] layer read failed', sessionId, error);
            this.#clearSession(sessionId);
            this.#failedUntil.set(sessionId, Date.now() + READ_FAILURE_BACKOFF_MS);
            return;
        }
        if (result === null || typeof result !== 'object')
            return;
        if (result.unchanged === true)
            return;
        if (result.failed === true) {
            // I/O class with no usable candidate: behave exactly like "no file", but
            // remember that writing would overwrite something we could not read.
            this.#clearSession(sessionId);
            this.#failedUntil.set(sessionId, Date.now() + READ_FAILURE_BACKOFF_MS);
            return;
        }
        this.#failedUntil.delete(sessionId);
        this.#setRows(sessionId, Array.isArray(result.rows) ? result.rows : []);
        this.#stamps.set(sessionId, result.stamp ?? null);
        this.#readOnly.set(sessionId, result.readOnly === true);
        if (result.needsPromotion === true)
            this.#schedulePromotion(sessionId);
    }
    /**
     * Move a fallback file into the session directory once that directory exists.
     *
     * Runs on the same serial queue as writes, re-reads first (so it moves the
     * committed rows), and is rate-limited to one attempt per session per 30s. A
     * failure keeps the fallback files for the next attempt and only logs.
     * @param {string} sessionId - session identity.
     * @returns {void}
     */
    #schedulePromotion(sessionId) {
        const store = this.#store;
        if (store === null)
            return;
        const attemptedAt = this.#promotionAt.get(sessionId) ?? 0;
        if (Date.now() - attemptedAt < PROMOTION_RETRY_MS)
            return;
        this.#promotionAt.set(sessionId, Date.now());
        void this.#enqueue(async () => {
            this.#ensureLoaded(sessionId, true);
            if ((this.#failedUntil.get(sessionId) ?? 0) > Date.now())
                return;
            const rows = this.#rows.get(sessionId) ?? [];
            if (rows.length === 0)
                return;
            try {
                const stamp = await store.write(sessionId, rows.map(toPersisted));
                this.#stamps.set(sessionId, stamp ?? null);
            }
            catch (error) {
                console.error('[dsh-prompt-library] layer move-in failed', sessionId, error);
            }
        }).catch(() => undefined);
    }
    /**
     * Persist one session's rows through the store.
     * @param {string} sessionId - session identity.
     * @param {LayerRow[]} rows - the next rows.
     * @returns {Promise<LayerStamp|null>} the stamp after the write (null in memory-only mode).
     * @throws {Error & {code: string}} `layer-persist` for a write failure, or a passthrough code.
     */
    async #persist(sessionId, rows) {
        if (this.#store === null)
            return null; // memory-only mode (0.1 behavior)
        try {
            return await this.#store.write(sessionId, rows.map(toPersisted));
        }
        catch (error) {
            // Observability (0.2 requirements §5 "可观测", design §5.4): record the
            // session id and the underlying code/message BEFORE mapping the failure to
            // its wire code, so a host log still shows WHY a save was refused. Session
            // id / code / message only: a layer body or a key never reaches the log.
            const code = errorCode(error);
            console.error('[dsh-prompt-library] layer persist failed', String(sessionId), code === '' ? 'unknown' : code, error instanceof Error ? error.message : String(error));
            // `session-invalid` (and our own codes) keep their meaning; anything else
            // (EACCES, ENOENT, a full disk) becomes the wire code the client maps.
            if (PASSTHROUGH_CODES.has(code))
                throw error;
            throw layerError(LAYER_PERSIST_CODE, error instanceof Error ? error.message : 'the session layers could not be saved');
        }
    }
    /**
     * Refuse a write when the current state cannot be trusted or must not change.
     * @param {string} sessionId - session identity.
     * @returns {void}
     * @throws {Error & {code: string}} `layer-read-failed` or `layer-readonly`.
     */
    #assertWritable(sessionId) {
        if ((this.#failedUntil.get(sessionId) ?? 0) > Date.now()) {
            throw layerError(LAYER_READ_FAILED_CODE, 'the session layer file could not be read, so this change was not written');
        }
        if (this.#readOnly.get(sessionId) === true) {
            throw layerError(LAYER_READONLY_CODE, 'the session layer file was written by a newer version, so it is read-only here');
        }
    }
    /**
     * Add or update one layer (persist first, then commit).
     * @param {string} sessionId - session identity.
     * @param {{promptId: string, title: string, body: string}} input - layer content.
     * @returns {Promise<{layers: object[], totalTokens: number, limit: number}>} snapshot.
     * @throws {Error & {code: string}} `layer-limit`, `layer-read-failed`, `layer-readonly`, `layer-persist`, `session-invalid`.
     */
    async add(sessionId, input) {
        return this.#enqueue(async () => {
            this.#ensureLoaded(sessionId, true); // write-before-read: never overwrite unseen layers
            this.#assertWritable(sessionId);
            const next = computeAdd(this.#rows.get(sessionId) ?? [], input, this.limit);
            const stamp = await this.#persist(sessionId, next);
            this.#setRows(sessionId, next);
            if (this.#store !== null)
                this.#stamps.set(sessionId, stamp ?? null);
            return snapshotOf(this.#rows.get(sessionId) ?? [], this.limit);
        });
    }
    /**
     * Remove one layer (idempotent: an unknown id writes nothing).
     * @param {string} sessionId - session identity.
     * @param {string} promptId - layer to drop.
     * @returns {Promise<{layers: object[], totalTokens: number, limit: number}>} snapshot.
     * @throws {Error & {code: string}} `layer-read-failed`, `layer-readonly`, `layer-persist`.
     */
    async remove(sessionId, promptId) {
        return this.#enqueue(async () => {
            this.#ensureLoaded(sessionId, true);
            this.#assertWritable(sessionId);
            const list = this.#rows.get(sessionId) ?? [];
            const next = list.filter((row) => row.promptId !== promptId);
            if (next.length === list.length)
                return snapshotOf(list, this.limit); // nothing to do: no write
            const stamp = await this.#persist(sessionId, next);
            this.#setRows(sessionId, next);
            if (this.#store !== null)
                this.#stamps.set(sessionId, stamp ?? null);
            return snapshotOf(this.#rows.get(sessionId) ?? [], this.limit);
        });
    }
    /**
     * Clear every layer of one session (an empty state is written, not a delete).
     * @param {string} sessionId - session identity.
     * @returns {Promise<{layers: object[], totalTokens: number, limit: number}>} snapshot.
     * @throws {Error & {code: string}} `layer-read-failed`, `layer-readonly`, `layer-persist`.
     */
    async clear(sessionId) {
        return this.#enqueue(async () => {
            this.#ensureLoaded(sessionId, true);
            this.#assertWritable(sessionId);
            const list = this.#rows.get(sessionId) ?? [];
            if (list.length === 0)
                return snapshotOf([], this.limit); // already empty: no write
            const stamp = await this.#persist(sessionId, []);
            this.#setRows(sessionId, []);
            if (this.#store !== null)
                this.#stamps.set(sessionId, stamp ?? null);
            return snapshotOf([], this.limit);
        });
    }
    /**
     * Read one session's layers for the wire (never throws).
     * @param {string} sessionId - session identity.
     * @returns {{layers: object[], totalTokens: number, limit: number}} snapshot.
     */
    snapshot(sessionId) {
        try {
            this.#ensureLoaded(sessionId);
            return snapshotOf(this.#rows.get(sessionId) ?? [], this.limit);
        }
        catch (error) {
            console.error('[dsh-prompt-library] layer snapshot failed', sessionId, error);
            return snapshotOf([], this.limit);
        }
    }
    /**
     * The prompt section text for one session (never throws).
     * @param {string} sessionId - session identity.
     * @returns {string} joined bodies, or '' when the session has no layer.
     */
    sectionText(sessionId) {
        try {
            this.#ensureLoaded(sessionId);
            return (this.#rows.get(sessionId) ?? []).map((row) => row.body).join('\n\n---\n\n');
        }
        catch (error) {
            console.error('[dsh-prompt-library] layer section failed', sessionId, error);
            return '';
        }
    }
}
/**
 * Strip the live token estimate before handing a row to the store.
 * @param {LayerRow} row - internal row.
 * @returns {{promptId: string, title: string, body: string}} persisted row.
 */
function toPersisted(row) {
    return { promptId: row.promptId, title: row.title, body: row.body };
}
