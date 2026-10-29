/**
 * The prompt library file: `$DSH_HOME/prompt-library/prompts.json`.
 *
 * Failure direction is fail-closed (design §9): a write never produces a
 * partial file (temp + rename), the previous good file is copied to
 * `prompts.bak.json` before every write, an unreadable/corrupt file is renamed
 * to `prompts.corrupt-<stamp>.json` (at most five kept) and the library starts
 * empty instead of blocking plugin load. An unknown `version` is never
 * overwritten: the library is served read-only with a notice. A MISSING
 * `version` is not unknown — a hand-edited file without one is read as v1 and
 * the next write normalizes it (code-review round 1, finding #7).
 */
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
/** Directory name under the DSH home that owns the library file. */
export const LIBRARY_DIR = 'prompt-library';
/** Library file name. */
export const LIBRARY_FILE = 'prompts.json';
/** How many `prompts.corrupt-*` backups are kept (design §6.1 keeps the bad file aside; the cap of five is a local choice documented in README). */
export const MAX_CORRUPT_BACKUPS = 5;
/** The only library schema version this release writes. */
export const LIBRARY_VERSION = 1;
/**
 * Resolve the library file path: `$DSH_HOME/prompt-library/prompts.json`, and
 * `~/.dsh/prompt-library/prompts.json` when DSH_HOME is unset.
 * @param {Record<string, string | undefined>} env - process environment.
 * @param {string} home - user home directory.
 * @returns {string} absolute path of the library file.
 */
export function resolveLibraryPath(env = process.env, home = homedir()) {
    const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
    const base = configured === '' ? join(home, '.dsh') : configured;
    return join(base, LIBRARY_DIR, LIBRARY_FILE);
}
/** @returns {object} a fresh empty library. */
export function emptyLibrary() {
    return { version: LIBRARY_VERSION, updatedAt: null, prompts: [] };
}
/**
 * Mint one prompt id (`p_<time36><random>`; design §6.1 shows a ULID-like id).
 * @param {number} now - epoch milliseconds.
 * @returns {string} fresh id.
 */
export function createPromptId(now = Date.now()) {
    return `p_${now.toString(36)}${randomBytes(5).toString('hex')}`;
}
/** Coerce one hand-edited entry into the shape the schema validates. */
function normalizeEntry(entry, now) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
        return entry;
    const tags = Array.isArray(entry.tags)
        ? entry.tags.filter((tag) => typeof tag === 'string' && tag.length > 0)
        : [];
    const createdAt = typeof entry.createdAt === 'string' && entry.createdAt.length > 0
        ? entry.createdAt
        : new Date(now).toISOString();
    return {
        id: entry.id,
        title: entry.title,
        body: entry.body,
        tags,
        createdAt,
        updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt.length > 0 ? entry.updatedAt : createdAt
    };
}
/**
 * Parse the library file text without touching the filesystem (unit-testable).
 * @param {string} text - raw file text.
 * @param {object} contract - the wire contract from `defineContract`.
 * @param {number} now - epoch milliseconds used for repaired timestamps.
 * @returns {{ok: true, library: object, readOnly: boolean}|{ok: false, reason: string, message: string, invalid: number}} outcome.
 */
export function parseLibraryText(text, contract, now = Date.now()) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { ok: false, reason: 'unparsable', message: error instanceof Error ? error.message : String(error), invalid: 0 };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'unparsable', message: 'the library root must be an object', invalid: 0 };
    }
    if (!Array.isArray(parsed.prompts)) {
        return { ok: false, reason: 'unparsable', message: 'the library has no prompts array', invalid: 0 };
    }
    // A hand-edited file may leave `version` out; that is v1, and every write
    // normalizes the file back to `version: 1`. Any OTHER value — including a
    // numeric version this release does not know — stays read-only (design §9).
    const version = parsed.version === undefined ? LIBRARY_VERSION : parsed.version;
    const readOnly = version !== LIBRARY_VERSION;
    const prompts = [];
    let invalid = 0;
    for (const entry of parsed.prompts) {
        const result = contract.promptSchema.safeParse(normalizeEntry(entry, now));
        if (result.success)
            prompts.push(result.data);
        else
            invalid += 1;
    }
    if (readOnly) {
        // Unknown version: serve what validates, never write back (design §9).
        return {
            ok: true,
            readOnly: true,
            library: {
                version: LIBRARY_VERSION,
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
                prompts
            }
        };
    }
    if (invalid > 0) {
        return { ok: false, reason: 'invalid', message: `${invalid} prompt(s) failed validation`, invalid };
    }
    if (prompts.length > contract.LIMITS.prompts) {
        return { ok: false, reason: 'invalid', message: `the library holds more than ${contract.LIMITS.prompts} prompts`, invalid: prompts.length };
    }
    return {
        ok: true,
        readOnly: false,
        library: {
            version: LIBRARY_VERSION,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
            prompts
        }
    };
}
/**
 * Parse one import payload (a full library object or a bare prompt array).
 * All-or-nothing: one invalid entry rejects the batch (a local rule; the design
 * only says "validate, then merge/replace" — see README「其他已文档化的小偏差」).
 * @param {string} text - raw imported text.
 * @param {object} contract - the wire contract from `defineContract`.
 * @param {number} now - epoch milliseconds used for minted ids/timestamps.
 * @returns {{ok: true, prompts: object[]}|{ok: false, invalid: number, message: string}} outcome.
 */
export function parseImportText(text, contract, now = Date.now()) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { ok: false, invalid: 0, message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    const entries = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.prompts) ? parsed.prompts : null;
    if (entries === null) {
        return { ok: false, invalid: 0, message: 'expected a prompt array or a library object with a prompts array' };
    }
    const prompts = [];
    const seen = new Set();
    let invalid = 0;
    for (const entry of entries) {
        const result = contract.promptSchema.safeParse(normalizeEntry(entry, now));
        if (!result.success) {
            invalid += 1;
            continue;
        }
        if (seen.has(result.data.id)) {
            invalid += 1;
            continue;
        }
        seen.add(result.data.id);
        prompts.push(result.data);
    }
    if (invalid > 0)
        return { ok: false, invalid, message: `${invalid} entr${invalid === 1 ? 'y' : 'ies'} failed validation` };
    if (prompts.length > contract.LIMITS.prompts) {
        return { ok: false, invalid: prompts.length, message: `more than ${contract.LIMITS.prompts} prompts` };
    }
    return { ok: true, prompts };
}
/** One serialized read-modify-write queue around the library file. */
export class PromptStore {
    /** Absolute path of `prompts.json`. */
    filePath;
    /** The wire contract supplying the prompt schema and limits. */
    contract;
    /** Tail of the write queue (every mutation chains onto it). */
    #tail = Promise.resolve();
    /** Snapshot reports handed to callers; never persisted. */
    #corruptBackup = null;
    #readOnly = false;
    #notice = null;
    /**
     * @param {{filePath: string, contract: object}} options - resolved path and shared contract.
     */
    constructor({ filePath, contract }) {
        if (typeof filePath !== 'string' || filePath === '')
            throw new TypeError('PromptStore: filePath is required');
        this.filePath = filePath;
        this.contract = contract;
    }
    /** @returns {string} the previous-good backup path (`prompts.bak.json`). */
    get backupPath() {
        return /.json$/iu.test(this.filePath) ? this.filePath.replace(/.json$/iu, '.bak.json') : `${this.filePath}.bak.json`;
    }
    /** @returns {string} the atomic temp path. */
    get tempPath() {
        return `${this.filePath}.tmp`;
    }
    /**
     * Read the library, quarantining an unreadable file.
     * @returns {Promise<{library: object, corruptBackup: string|null, readOnly: boolean, notice: string|null}>} current state.
     */
    async load() {
        this.#corruptBackup = null;
        this.#readOnly = false;
        this.#notice = null;
        let text;
        try {
            text = await readFile(this.filePath, 'utf8');
        }
        catch (error) {
            if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
                return { library: emptyLibrary(), corruptBackup: null, readOnly: false, notice: null };
            }
            throw error;
        }
        const outcome = parseLibraryText(text, this.contract);
        if (outcome.ok) {
            this.#readOnly = outcome.readOnly;
            if (outcome.readOnly)
                this.#notice = 'library-version-unknown';
            return { library: outcome.library, corruptBackup: null, readOnly: outcome.readOnly, notice: this.#notice };
        }
        const backup = await this.#quarantine();
        this.#corruptBackup = backup;
        this.#notice = 'library-corrupt';
        return { library: emptyLibrary(), corruptBackup: backup, readOnly: false, notice: this.#notice };
    }
    /**
     * Serialize one read-modify-write over the library file.
     * @param {(library: object) => {library?: object, value?: any}} mutator - receives the loaded library, may return a replacement.
     * @returns {Promise<any>} whatever the mutator returned in `value`.
     */
    update(mutator) {
        const run = this.#tail.then(async () => {
            const state = await this.load();
            if (state.readOnly) {
                const error = new Error('the prompt library was written by a newer version and is read-only');
                error.code = 'library-readonly';
                throw error;
            }
            const outcome = await mutator(state.library);
            const next = outcome !== null && typeof outcome === 'object' && outcome.library !== undefined ? outcome.library : state.library;
            const saved = await this.#write(next);
            this.#corruptBackup = state.corruptBackup;
            this.#notice = state.corruptBackup === null ? null : 'library-corrupt';
            return { library: saved, state: { ...state, library: saved }, value: outcome === null || typeof outcome !== 'object' ? undefined : outcome.value };
        });
        this.#tail = run.then(() => undefined, () => undefined);
        return run;
    }
    /**
     * Replace the whole library (import). Serialized like `update`.
     * @param {object[]} prompts - the complete new prompt array.
     * @returns {Promise<object>} the written library.
     */
    async replaceAll(prompts) {
        const outcome = await this.update(() => ({ library: { version: LIBRARY_VERSION, updatedAt: null, prompts } }));
        return outcome.library;
    }
    /** Last known report flags (for callers that reload later). */
    get report() {
        return { corruptBackup: this.#corruptBackup, readOnly: this.#readOnly, notice: this.#notice };
    }
    /**
     * Write atomically: copy the previous file to `prompts.bak.json`, write the
     * temp file, then rename it over the target.
     * @param {object} library - library to persist.
     * @returns {Promise<object>} the persisted payload.
     */
    async #write(library) {
        const payload = {
            version: LIBRARY_VERSION,
            updatedAt: new Date().toISOString(),
            prompts: library.prompts
        };
        // Fail-closed validation before touching the disk.
        for (const prompt of payload.prompts) {
            const result = this.contract.promptSchema.safeParse(prompt);
            if (!result.success) {
                const error = new Error(`refusing to write an invalid prompt: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
                error.code = 'library-invalid';
                throw error;
            }
        }
        await mkdir(dirname(this.filePath), { recursive: true });
        try {
            const existing = await stat(this.filePath);
            if (existing.isFile())
                await copyFile(this.filePath, this.backupPath);
        }
        catch (error) {
            if (!(error !== null && typeof error === 'object' && error.code === 'ENOENT'))
                throw error;
        }
        try {
            await writeFile(this.tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            await rename(this.tempPath, this.filePath);
        }
        catch (error) {
            try {
                await unlink(this.tempPath);
            }
            catch {
                /* the temp file may already be gone; the original error is the report */
            }
            throw error;
        }
        return payload;
    }
    /**
     * Rename the unreadable file out of the way and prune old quarantine files.
     * @returns {Promise<string>} the quarantine path.
     */
    async #quarantine() {
        const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]/gu, '-');
        const target = /.json$/iu.test(this.filePath)
            ? this.filePath.replace(/.json$/iu, `.corrupt-${stamp}.json`)
            : `${this.filePath}.corrupt-${stamp}`;
        await mkdir(dirname(this.filePath), { recursive: true });
        await rename(this.filePath, target);
        await this.#pruneQuarantine();
        return target;
    }
    /** Keep at most MAX_CORRUPT_BACKUPS quarantine files (oldest removed first). */
    async #pruneQuarantine() {
        const directory = dirname(this.filePath);
        let names;
        try {
            names = await readdir(directory);
        }
        catch {
            return;
        }
        const quarantine = names
            .filter((name) => /^prompts\.corrupt-.*\.json$/iu.test(name))
            .sort();
        const excess = quarantine.length - MAX_CORRUPT_BACKUPS;
        if (excess <= 0)
            return;
        for (const name of quarantine.slice(0, excess)) {
            try {
                await unlink(join(directory, name));
            }
            catch {
                /* pruning is best effort: a locked backup must not fail the load */
            }
        }
    }
}
