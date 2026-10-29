/**
 * Session layer file store (0.2 design §5.0-§5.3, §6.1).
 *
 * Places each session's 1-3 system layers inside that session's OWN directory
 * (the platform directory documented as "available for future session-local
 * artifacts"), with one previous-version backup and a plugin-directory fallback
 * for the window before a session directory exists:
 *
 *   <DSH_HOME>/sessions/<project>/<sessionId>/prompt-library-layers.json
 *   <DSH_HOME>/sessions/<project>/<sessionId>/prompt-library-layers.bak.json
 *   <DSH_HOME>/sessions/<project>/<sessionId>/prompt-library-layers.json.tmp
 *   <DSH_HOME>/prompt-library/sessions/<sessionId>.json          (fallback)
 *   <DSH_HOME>/prompt-library/sessions/<sessionId>.bak.json      (fallback backup)
 *
 * Contract (design §5.0):
 *   - `load` is SYNCHRONOUS and never throws: the system-prompt assembly can only
 *     read synchronously, and a broken layer file must never break a session or
 *     the sidebar. Every stat/read/parse/size error is swallowed inside.
 *   - the READ path has ZERO side effects: no rename, no quarantine, no cleanup,
 *     no write, no backup repair. Only the user's add/remove/clear writes.
 *   - candidate order is main -> backup -> fallback; the first readable and valid
 *     one wins (a readable backup is therefore an automatic recovery); only when
 *     all three are unusable is the session served as "no file" (empty rows).
 *   - failures are classified (requirements FR-3/FR-7, design §5.2):
 *       * I/O type (stat/read threw, unreadable, deleted mid-read) with no hit
 *         -> `failed: true`, stamp null; the registry backs off 30s and refuses
 *         writes (layer-read-failed);
 *       * content type (bad JSON, bad fields, > 1 MiB, not a regular file) with
 *         no hit -> empty rows but a real composite stamp and no `failed`, so the
 *         next user write may repair the broken main file;
 *       * mixed -> I/O wins (any I/O error and no hit => failed);
 *       * an I/O error AFTER a hit does not stop caching; an I/O error BEFORE
 *         the hit clears the returned stamp so the next read retries.
 *   - the composite stamp records (path, mtimeMs, size) for each candidate or a
 *     `{path, error}` marker; an unchanged stamp means stat-only, no re-parse.
 *     A file that does not exist records the non-error marker `{error:'absent'}`
 *     instead of a null: null is reserved for "this candidate is not part of the
 *     candidate set" (no session directory yet). That distinction is what lets a
 *     freshly-created session directory be noticed on a READ, which is required
 *     for AC-8 ("the folder appears -> the fallback is moved in") without a
 *     user write to trigger it; absence is never treated as an I/O error.
 *   - every candidate is capped at 1 MiB: an oversized file is never read and
 *     never parsed; the next candidate is tried instead.
 *   - no startup scan: only the current session's directory is located, and only
 *     the project level under the sessions root is listed; positive results are
 *     cached, negatives are always re-checked.
 *
 * `write` is asynchronous, fail-closed, and returns the composite stamp after a
 * successful write (null when a stamp stat failed). It copies only a PARSABLE
 * main file to the backup (a broken file never overwrites a recoverable backup),
 * writes through a `.tmp` sibling and renames it into place, and deletes the
 * fallback files once the session directory holds the layer file.
 *
 * Test seams: `fs` (sync read/stat/readdir) and `io` (async write side) can be
 * overridden so a unit test can inject EACCES/ENOENT at an exact step without
 * touching a real permission bit (impossible to simulate portably on Windows).
 * The public `reads` / `stats` / `readdirs` counters are instrumentation for the
 * mechanical AC-14 assertions ("10 MiB is never read", "a repeat read only
 * stats", "a long-unreadable non-hit candidate still only stats").
 */
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Hard per-file cap: anything larger is not read and not parsed (design §5.0). */
export const MAX_FILE_BYTES = 1024 * 1024;

/** The only layer-file version this release writes (design §6.1). */
export const LAYER_VERSION = 1;

/** Main layer file name inside a session (or fallback) directory. */
export const LAYER_FILE_NAME = 'prompt-library-layers.json';

/** Previous-version backup name (main file is copied here before a write). */
export const LAYER_BACKUP_FILE_NAME = 'prompt-library-layers.bak.json';

/** Atomic-write temp suffix (`.` is appended to the main file name). */
export const LAYER_TEMP_SUFFIX = '.tmp';

/** Session-id whitelist (FR-8: platform-shaped ids only, never a path). */
export const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/u;

/** Crash-leftover temp files older than this are cleaned on the next write. */
export const STALE_TEMP_MS = 10 * 60 * 1000;

/** Directory name of the platform sessions root under `$DSH_HOME`. */
export const SESSIONS_DIR = 'sessions';

/** Plugin-owned fallback directory under `$DSH_HOME` (sessions without a directory yet). */
export const FALLBACK_DIR = join('prompt-library', 'sessions');

/** One persisted layer row (tokens are recomputed on read, never stored). */
export type LayerRow = { promptId: string; title: string; body: string };

/** One candidate's stamp: either its file identity or a stat error marker. */
export type FileStamp =
  | { path: string; mtimeMs: number; size: number }
  | { path: string; error: string };

/** The composite stamp over main / backup / fallback. */
export type Stamp = { main: FileStamp | null; backup: FileStamp | null; fallback: FileStamp | null };

/** One load outcome: unchanged (cache hit) or the parsed state. */
export type LayerLoad =
  | { unchanged: true }
  | {
      rows: LayerRow[];
      stamp: Stamp | null;
      source: 'session' | 'fallback' | 'none';
      readOnly: boolean;
      needsPromotion: boolean;
      failed?: boolean;
    };

/** Constructor options of {@link LayerStore}. */
export interface LayerStoreOptions {
  contract: { LIMITS: { layers: number; title: number; body: number } };
  env?: Record<string, string | undefined>;
  home?: string;
  sessionsRoot?: string;
  fallbackDir?: string;
  fs?: LayerStoreSyncFs;
  io?: LayerStoreAsyncFs;
}

/** Sync filesystem face (overridable in tests). */
export interface LayerStoreSyncFs {
  lstatSync: typeof lstatSync;
  statSync: typeof statSync;
  readFileSync: typeof readFileSync;
  readdirSync: typeof readdirSync;
}

/** Async filesystem face used by `write` (overridable in tests). */
export interface LayerStoreAsyncFs {
  copyFile: typeof copyFile;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  stat: typeof stat;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
}

/**
 * Resolve `$DSH_HOME` (`~/.dsh` when unset), like the prompt library does.
 * @param {Record<string, string | undefined>} env - process environment.
 * @param {string} home - user home directory.
 * @returns {string} absolute DSH home.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return configured === '' ? join(home, '.dsh') : configured;
}

/**
 * @returns {string} the platform sessions root (`$DSH_HOME/sessions`).
 */
export function resolveSessionsRoot(env = process.env, home = homedir()) {
  return join(resolveDshHome(env, home), SESSIONS_DIR);
}

/**
 * @returns {string} the plugin fallback directory.
 */
export function resolveFallbackDir(env = process.env, home = homedir()) {
  return join(resolveDshHome(env, home), FALLBACK_DIR);
}

/**
 * @param {string} dir - a session directory.
 * @returns {{main: string, backup: string, temp: string}} that session's layer paths.
 */
export function sessionLayerPaths(dir) {
  return {
    main: join(dir, LAYER_FILE_NAME),
    backup: join(dir, LAYER_BACKUP_FILE_NAME),
    temp: join(dir, LAYER_FILE_NAME + LAYER_TEMP_SUFFIX)
  };
}

/**
 * @param {string} dir - the fallback directory.
 * @param {string} sessionId - a whitelisted session id.
 * @returns {{main: string, backup: string, temp: string}} the fallback layer paths.
 */
export function fallbackLayerPaths(dir, sessionId) {
  return {
    main: join(dir, sessionId + '.json'),
    backup: join(dir, sessionId + '.bak.json'),
    temp: join(dir, sessionId + '.json' + LAYER_TEMP_SUFFIX)
  };
}

/**
 * Whether one value is a safe session id (FR-8).
 * @param {unknown} id - candidate.
 * @returns {boolean} true when the id may be used in a file name.
 */
export function validSessionId(id) {
  return typeof id === 'string' && SAFE_SESSION_ID.test(id) && id !== '.' && id !== '..';
}

/** @param {unknown} error - caught value. @returns {string} its `code`, or ''. */
function errorCode(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
}

/** @param {unknown} value - candidate. @returns {boolean} true for a plain object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse one layer file's text (pure; never touches the filesystem).
 *
 * Rule set (design §5.2 "解析规则"):
 *   - the root must be an object and `version` an integer;
 *   - a version other than 1 is READ-ONLY and stops the candidate walk (a newer
 *     version's file must not be overridden by an older backup);
 *   - `sessionId` must equal the requested id;
 *   - `layers` must be an array within the contract limit;
 *   - every row needs a non-empty promptId, a non-empty title within the title
 *     limit, a non-empty body within the body limit, and a unique promptId;
 *   - unknown fields are ignored; `tokens` is never read from the file.
 * @param {string} text - raw file text.
 * @param {string} sessionId - the session the file must belong to.
 * @param {{LIMITS: {layers: number, title: number, body: number}}} contract - shared limits.
 * @returns {{ok: true, readOnly: false, rows: LayerRow[]}|{ok: true, readOnly: true, rows: []}|{ok: false, reason: string, message: string}} outcome.
 */
export function parseLayerText(text, sessionId, contract) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: 'unparsable', message: error instanceof Error ? error.message : String(error) };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'unparsable', message: 'the layer root must be an object' };
  if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version)) {
    return { ok: false, reason: 'unparsable', message: 'the layer file has no integer version' };
  }
  if (parsed.version !== LAYER_VERSION) return { ok: true, readOnly: true, rows: [] };
  if (parsed.sessionId !== sessionId) return { ok: false, reason: 'invalid', message: 'the layer file belongs to another session' };
  if (!Array.isArray(parsed.layers)) return { ok: false, reason: 'unparsable', message: 'the layer file has no layers array' };
  if (parsed.layers.length > contract.LIMITS.layers) {
    return { ok: false, reason: 'invalid', message: 'more than ' + contract.LIMITS.layers + ' layer(s)' };
  }
  const rows = [];
  const seen = new Set();
  for (const entry of parsed.layers) {
    if (!isPlainObject(entry)) return { ok: false, reason: 'invalid', message: 'a layer row must be an object' };
    const { promptId, title, body } = entry;
    if (typeof promptId !== 'string' || promptId === '') return { ok: false, reason: 'invalid', message: 'a layer row needs a promptId' };
    if (typeof title !== 'string' || title === '' || title.length > contract.LIMITS.title) {
      return { ok: false, reason: 'invalid', message: 'a layer row needs a title within the limit' };
    }
    if (typeof body !== 'string' || body === '' || body.length > contract.LIMITS.body) {
      return { ok: false, reason: 'invalid', message: 'a layer row needs a body within the limit' };
    }
    if (seen.has(promptId)) return { ok: false, reason: 'invalid', message: 'duplicate promptId in one layer file' };
    seen.add(promptId);
    rows.push({ promptId, title, body });
  }
  return { ok: true, readOnly: false, rows };
}

/**
 * Compare two stamps for one candidate key.
 * @param {FileStamp|null|undefined} left - previous stamp.
 * @param {FileStamp|null|undefined} right - fresh stamp.
 * @returns {boolean} true when nothing about this candidate changed.
 */
function sameFileStamp(left, right) {
  const leftEmpty = left === null || left === undefined;
  const rightEmpty = right === null || right === undefined;
  if (leftEmpty || rightEmpty) return leftEmpty && rightEmpty;
  if (left.path !== right.path) return false;
  if ('error' in left || 'error' in right) {
    const leftError = 'error' in left ? left.error : undefined;
    const rightError = 'error' in right ? right.error : undefined;
    return leftError === rightError;
  }
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

/**
 * Compare two composite stamps (main / backup / fallback).
 * @param {Stamp|null|undefined} left - previous stamp.
 * @param {Stamp|null|undefined} right - fresh stamp.
 * @returns {boolean} true when all three candidates are unchanged.
 */
export function sameStampSet(left, right) {
  return sameFileStamp(left?.main, right?.main)
    && sameFileStamp(left?.backup, right?.backup)
    && sameFileStamp(left?.fallback, right?.fallback);
}

/**
 * Build the persisted payload: 2-space JSON plus a trailing newline (design §6.1).
 * @param {string} sessionId - session identity.
 * @param {LayerRow[]} rows - rows to persist.
 * @param {number} now - epoch milliseconds for `updatedAt`.
 * @returns {string} file text.
 */
export function layerPayload(sessionId, rows, now = Date.now()) {
  return JSON.stringify({
    version: LAYER_VERSION,
    sessionId,
    updatedAt: new Date(now).toISOString(),
    layers: rows.map((row) => ({ promptId: row.promptId, title: row.title, body: row.body }))
  }, null, 2) + '\n';
}

/** One resolved candidate: where it lives and how to read it. */
type Candidate = {
  key: 'main' | 'backup' | 'fallback';
  kind: 'session' | 'fallback';
  path: string;
  needsPromotion: boolean;
};

/**
 * The session layer file store.
 *
 * One instance owns the sessions root, the fallback directory and its positive
 * directory cache; construct it once per host process.
 */
export class LayerStore {
  /** Shared wire contract (limits only). */
  contract;
  /** Absolute sessions root. */
  sessionsRoot;
  /** Absolute fallback directory. */
  fallbackDir;
  /** Successful reads (AC-14 instrumentation). */
  reads = 0;
  /** Candidate stat calls (AC-14 instrumentation). */
  stats = 0;
  /** Sessions-root listings (AC-14 instrumentation: must stay at 1 per session). */
  readdirs = 0;
  /** `sessionId -> session directory`; positive results only (design §5.1). */
  #dirCache = new Map();
  /** Log keys already reported (log once, never the body). */
  #logged = new Set();
  #fs;
  #io;

  /**
   * @param {object} options - `contract`, optional `env`/`home` (path resolution),
   *   optional `sessionsRoot`/`fallbackDir` overrides, optional test seams.
   */
  constructor(options: LayerStoreOptions) {
    const { contract, env = process.env, home = homedir(), sessionsRoot, fallbackDir, fs, io } = options;
    this.contract = contract;
    this.sessionsRoot = typeof sessionsRoot === 'string' && sessionsRoot !== '' ? sessionsRoot : resolveSessionsRoot(env, home);
    this.fallbackDir = typeof fallbackDir === 'string' && fallbackDir !== '' ? fallbackDir : resolveFallbackDir(env, home);
    this.#fs = fs ?? { lstatSync, statSync, readFileSync, readdirSync };
    this.#io = io ?? { copyFile, lstat, mkdir, readFile, rename, stat, unlink, writeFile };
  }

  /**
   * Locate one session's directory without creating anything (design §5.1).
   * @param {string} sessionId - session identity.
   * @returns {string|null} absolute directory, or null when it does not exist yet.
   */
  locateSessionDir(sessionId) {
    if (!validSessionId(sessionId)) return null;
    const cached = this.#dirCache.get(sessionId);
    if (cached !== undefined) {
      if (this.#isDirectory(cached)) return cached;
      this.#dirCache.delete(sessionId);
    }
    let projects;
    try {
      this.readdirs += 1;
      projects = this.#fs.readdirSync(this.sessionsRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    const matches: string[] = [];
    for (const project of Array.isArray(projects) ? projects : []) {
      if (project === null || typeof project !== 'object') continue;
      if (typeof project.isDirectory !== 'function' || !project.isDirectory()) continue;
      const candidate = join(this.sessionsRoot, project.name, sessionId);
      if (this.#isDirectory(candidate)) matches.push(candidate);
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      // The platform reports duplicate session ids itself; this plugin must not
      // widen the problem (design §9 "重复会话 id 跨项目目录"). Serve the first
      // directory and record the session id plus every candidate path, once per
      // session. Paths and ids only: a layer body is never logged (§5.1, §11).
      this.#logOnce(
        'layer-session-dir-duplicate:' + sessionId,
        '[dsh-prompt-library] duplicate session directories for one session id; using the first',
        String(sessionId),
        matches
      );
    }
    const located = matches[0];
    this.#dirCache.set(sessionId, located);
    return located;
  }

  /**
   * Load one session's layers. Never throws; never writes (design §5.2).
   * @param {string} sessionId - session identity.
   * @param {Stamp|null} [previousStamp] - the stamp of the cached state, if any.
   * @returns {LayerLoad} `{unchanged: true}` or the parsed state.
   */
  load(sessionId, previousStamp = null) {
    try {
      return this.#load(sessionId, previousStamp);
    } catch (error) {
      this.#logOnce('layer-load-failed:' + String(sessionId), '[dsh-prompt-library] layer load failed', String(sessionId), errorCode(error) || String(error));
      return { rows: [], stamp: null, source: 'none', readOnly: false, needsPromotion: false, failed: true };
    }
  }

  /**
   * Persist one session's rows (design §5.3). Fail-closed: a rejected promise
   * means nothing was committed anywhere.
   * @param {string} sessionId - session identity.
   * @param {LayerRow[]} rows - already-validated rows (0..limit).
   * @returns {Promise<Stamp|null>} the composite stamp after the write, or null.
   */
  async write(sessionId, rows) {
    if (!validSessionId(sessionId)) {
      const error = new Error('the session id "' + String(sessionId) + '" is not a safe layer-file name') as Error & { code: string };
      error.code = 'session-invalid';
      throw error;
    }
    return this.#write(sessionId, rows, true);
  }

  /** @param {string} path - candidate directory. @returns {boolean} true when it exists as a directory. */
  #isDirectory(path) {
    try {
      this.stats += 1;
      const info = this.#fs.statSync(path, { throwIfNoEntry: false });
      return info !== undefined && info !== null && typeof info.isDirectory === 'function' && info.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * @param {string} sessionId - session identity.
   * @param {string|null} dir - the located session directory.
   * @returns {Candidate[]} the ordered candidate list (main, backup, fallback).
   */
  #candidates(sessionId, dir) {
    const candidates = [];
    if (dir !== null) {
      const paths = sessionLayerPaths(dir);
      candidates.push({ key: 'main', kind: 'session', path: paths.main, needsPromotion: false });
      candidates.push({ key: 'backup', kind: 'session', path: paths.backup, needsPromotion: false });
    }
    const fallback = fallbackLayerPaths(this.fallbackDir, sessionId);
    // The fallback is "promotable" only once a session directory exists to move into.
    candidates.push({ key: 'fallback', kind: 'fallback', path: fallback.main, needsPromotion: dir !== null });
    return candidates;
  }

  /** The load body (kept separate so `load` can guarantee "never throws"). */
  #load(sessionId, previousStamp) {
    if (!validSessionId(sessionId)) {
      return { rows: [], stamp: null, source: 'none', readOnly: false, needsPromotion: false };
    }
    const dir = this.locateSessionDir(sessionId);
    const candidates = this.#candidates(sessionId, dir);
    const stamp: Stamp = { main: null, backup: null, fallback: null };
    const infos = new Map();
    const errors = new Set();

    // 1. stat every candidate into the composite stamp (file identity or error marker).
    for (const candidate of candidates) {
      this.stats += 1;
      try {
        const info = this.#fs.lstatSync(candidate.path);
        if (info === undefined || info === null) continue;
        infos.set(candidate.key, info);
        stamp[candidate.key] = { path: candidate.path, mtimeMs: info.mtimeMs, size: info.size };
      } catch (error) {
        const code = errorCode(error);
        // A missing file is NOT an error (design D2 / AC-8): the marker keeps the
        // transition "absent -> present" (and "session directory appeared") as a
        // stamp change, so the next read re-parses and can promote the fallback.
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          stamp[candidate.key] = { path: candidate.path, error: 'absent' };
          continue;
        }
        errors.add(candidate.key);
        stamp[candidate.key] = { path: candidate.path, error: 'stat-failed' };
        this.#logOnce('layer-stat-failed:' + candidate.path, '[dsh-prompt-library] layer stat failed', candidate.path, code || String(error));
      }
    }

    if (previousStamp !== null && previousStamp !== undefined && sameStampSet(previousStamp, stamp)) {
      return { unchanged: true };
    }

    // 2. parse in order main -> backup -> fallback; one bad candidate never stops the walk.
    let errorBeforeHit = false;
    for (const candidate of candidates) {
      if (errors.has(candidate.key)) {
        errorBeforeHit = true;
        continue;
      }
      const info = infos.get(candidate.key);
      if (info === undefined) continue;
      if (typeof info.isFile !== 'function' || !info.isFile()) continue; // directory / symlink / fifo
      if (typeof info.size === 'number' && info.size > MAX_FILE_BYTES) continue; // never read, never parse
      let text;
      try {
        this.reads += 1;
        text = this.#fs.readFileSync(candidate.path, 'utf8');
      } catch (error) {
        // I/O class: unreadable, or deleted between stat and read.
        errors.add(candidate.key);
        stamp[candidate.key] = { path: candidate.path, error: 'read-failed' };
        errorBeforeHit = true;
        this.#logOnce('layer-read-failed:' + candidate.path, '[dsh-prompt-library] layer read failed', candidate.path, errorCode(error) || String(error));
        continue;
      }
      const parsed = parseLayerText(text, sessionId, this.contract);
      if (parsed.ok === true) {
        // A hit after an I/O error drops the stamp: the next assembly must retry
        // (design §5.2: "命中之前的 I/O 错误把 stamp 置空重试").
        return {
          rows: parsed.readOnly === true ? [] : parsed.rows,
          stamp: errorBeforeHit ? null : stamp,
          source: candidate.kind === 'fallback' ? 'fallback' : 'session',
          readOnly: parsed.readOnly === true,
          needsPromotion: parsed.readOnly === true ? false : candidate.needsPromotion
        };
      }
      // Content class (bad JSON / fields / shape): the next candidate is tried.
    }

    if (errors.size > 0) {
      // I/O priority: any I/O error and no usable hit means "read failed", so the
      // registry backs off and refuses writes instead of overwriting the disk.
      return { rows: [], stamp: null, source: 'none', readOnly: false, needsPromotion: false, failed: true };
    }
    // Content-only failure: empty rows, a real stamp (so a repeat read is stat-only),
    // and no failed flag (so the next user write may repair the main file).
    return { rows: [], stamp, source: 'none', readOnly: false, needsPromotion: false };
  }

  /**
   * The write body; `allowFallback` bounds the ENOENT retry (design §5.3).
   * @param {string} sessionId - session identity.
   * @param {LayerRow[]} rows - rows to persist.
   * @param {boolean} allowFallback - whether a vanished session directory may fall back.
   * @returns {Promise<Stamp|null>} the composite stamp after the write.
   */
  async #write(sessionId, rows, allowFallback) {
    const dir = this.locateSessionDir(sessionId);
    const target = dir !== null
      ? { kind: 'session', ...sessionLayerPaths(dir) }
      : { kind: 'fallback', ...fallbackLayerPaths(this.fallbackDir, sessionId) };
    try {
      if (target.kind === 'fallback') await this.#io.mkdir(dirname(target.main), { recursive: true });
      await this.#cleanStaleTemp(target.main);
      if (rows.length === 0) {
        // Empty state: a legal empty file plus backup removal, so a broken main
        // file can never resurrect already-removed layers through the backup (D5).
        await this.#writeAtomic(target.main, layerPayload(sessionId, rows));
        await this.#unlinkIfExists(target.backup);
        if (target.kind === 'session') await this.#removeFallback(sessionId);
        return this.#stampOf(sessionId);
      }
      // Only a parsable main file may be copied over the backup.
      await this.#copyIfValid(sessionId, target.main, target.backup);
      await this.#writeAtomic(target.main, layerPayload(sessionId, rows));
      if (target.kind === 'session') await this.#removeFallback(sessionId);
      return this.#stampOf(sessionId);
    } catch (error) {
      if (allowFallback && target.kind === 'session' && errorCode(error) === 'ENOENT') {
        // The session directory vanished between locate and write: never rebuild
        // it (that would require replicating the platform's path encoding), write
        // the fallback and let the next read promote it. Observable per §5.3 /
        // requirements §5: session id, error code and the two paths, never a body.
        this.#logOnce(
          'layer-session-dir-vanished:' + sessionId,
          '[dsh-prompt-library] session directory vanished before the layer write; using the plugin fallback directory',
          String(sessionId),
          errorCode(error),
          target.main,
          fallbackLayerPaths(this.fallbackDir, sessionId).main
        );
        return this.#write(sessionId, rows, false);
      }
      throw error;
    }
  }

  /**
   * Copy the main file to the backup when the main file parses as valid v1.
   * @param {string} sessionId - session identity.
   * @param {string} mainPath - main file path.
   * @param {string} backupPath - backup file path.
   * @returns {Promise<void>} resolves when done (or when there is nothing to copy).
   */
  async #copyIfValid(sessionId, mainPath, backupPath) {
    let info;
    try {
      info = await this.#io.stat(mainPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    if (typeof info.isFile !== 'function' || !info.isFile()) return;
    if (typeof info.size === 'number' && info.size > MAX_FILE_BYTES) return;
    let text;
    try {
      text = await this.#io.readFile(mainPath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      // An unreadable main file cannot be backed up; overwriting it would destroy
      // the only recoverable copy (design §5.3).
      throw error;
    }
    const parsed = parseLayerText(text, sessionId, this.contract);
    if (parsed.ok !== true || parsed.readOnly === true) return;
    await this.#io.copyFile(mainPath, backupPath);
  }

  /**
   * Write one file atomically through its `.tmp` sibling.
   * @param {string} path - destination path.
   * @param {string} text - file text.
   * @returns {Promise<void>} resolves after the rename.
   */
  async #writeAtomic(path, text) {
    const temp = path + LAYER_TEMP_SUFFIX;
    try {
      await this.#io.writeFile(temp, text, 'utf8');
      await this.#io.rename(temp, path);
    } catch (error) {
      await this.#unlinkIfExists(temp, true);
      throw error;
    }
  }

  /**
   * Best-effort cleanup of a crash-leftover temp file older than the threshold.
   * @param {string} path - the main file path.
   * @returns {Promise<void>} always resolves.
   */
  async #cleanStaleTemp(path) {
    const temp = path + LAYER_TEMP_SUFFIX;
    try {
      const info = await this.#io.stat(temp);
      if (Date.now() - info.mtimeMs >= STALE_TEMP_MS) await this.#io.unlink(temp);
    } catch {
      /* no stale temp file: nothing to clean */
    }
  }

  /**
   * Delete one file when it exists.
   * @param {string} path - file path.
   * @param {boolean} [bestEffort] - swallow every error instead of only ENOENT.
   * @returns {Promise<void>} resolves when gone.
   */
  async #unlinkIfExists(path, bestEffort = false) {
    try {
      await this.#io.unlink(path);
    } catch (error) {
      if (bestEffort || errorCode(error) === 'ENOENT') return;
      throw error;
    }
  }

  /**
   * Delete the fallback files after the session directory holds the layer file.
   * @param {string} sessionId - session identity.
   * @returns {Promise<void>} resolves when the fallback files are gone.
   */
  async #removeFallback(sessionId) {
    const fallback = fallbackLayerPaths(this.fallbackDir, sessionId);
    await this.#unlinkIfExists(fallback.main);
    await this.#unlinkIfExists(fallback.backup);
    await this.#unlinkIfExists(fallback.temp, true);
  }

  /**
   * Re-stat the composite candidate set after a write (design §5.3).
   * @param {string} sessionId - session identity.
   * @returns {Promise<Stamp|null>} the stamp, or null when a stat failed.
   */
  async #stampOf(sessionId) {
    const dir = this.locateSessionDir(sessionId);
    const candidates = this.#candidates(sessionId, dir);
    const stamp: Stamp = { main: null, backup: null, fallback: null };
    for (const candidate of candidates) {
      try {
        const info = await this.#io.lstat(candidate.path);
        stamp[candidate.key] = { path: candidate.path, mtimeMs: info.mtimeMs, size: info.size };
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          stamp[candidate.key] = { path: candidate.path, error: 'absent' };
          continue;
        }
        return null;
      }
    }
    return stamp;
  }

  /**
   * Log one message per key (paths and error codes only, never a layer body).
   * @param {string} key - dedupe key.
   * @param {...unknown} args - message parts.
   * @returns {void}
   */
  #logOnce(key, ...args) {
    if (this.#logged.has(key)) return;
    if (this.#logged.size > 500) this.#logged.clear();
    this.#logged.add(key);
    console.error(...args);
  }
}
