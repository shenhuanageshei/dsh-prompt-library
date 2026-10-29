/**
 * The session layer file store (src/host/layer-store.ts -> lib/host/layer-store.js).
 *
 * Covers the 0.2 acceptance points that live in the storage layer:
 *   AC-1  a fresh store (a DSH restart) reads back what an earlier instance wrote;
 *   AC-2  an empty state is a legal empty file with no backup (nothing revives);
 *   AC-4  two sessions never share a file;
 *   AC-5  a session directory copied away and back still reads the same;
 *   AC-6  a broken main file recovers from the backup; no candidate -> no file;
 *         the READ path never renames, rewrites or quarantines anything;
 *   AC-8  a session without a directory writes the plugin fallback, and a read
 *         notices the directory appearing so it can be moved in;
 *   AC-9  a session id outside the whitelist never touches the filesystem;
 *   AC-13 content failures are not "failed" (a later write may repair them),
 *         I/O failures are "failed" (write refused, 30s backoff upstream), mixed
 *         cases go I/O-first, a pre-hit I/O error clears the stamp, a post-hit
 *         one does not, and an unreadable non-hit candidate stays stat-only;
 *   AC-14 a >1 MiB candidate is never read, a repeat read only stats, and a
 *         located directory is never re-scanned.
 *
 * The tests import the BUILT lib (the other host tests do the same). They use a
 * throwaway DSH_HOME and the store's documented fs/io seams to inject the exact
 * failure kinds that cannot be simulated portably on Windows (EACCES on read).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadZod } from './_zod.mjs';
import { defineContract } from '../lib/contract.js';
import {
  LAYER_BACKUP_FILE_NAME,
  LAYER_FILE_NAME,
  LAYER_TEMP_SUFFIX,
  MAX_FILE_BYTES,
  LayerStore,
  fallbackLayerPaths,
  layerPayload,
  parseLayerText,
  sameStampSet,
  sessionLayerPaths,
  validSessionId
} from '../lib/host/layer-store.js';

const z = await loadZod();
const contract = defineContract(z);

/** One layer row. */
function row(promptId, title, body) {
  return { promptId, title, body };
}

/** A throwaway DSH home plus its two derived roots. */
async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-library-layer-store-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    home,
    sessionsRoot: join(home, 'sessions'),
    fallbackDir: join(home, 'prompt-library', 'sessions')
  };
}

/** Create the platform-shaped session directory home/sessions/<project>/<id>. */
async function makeSessionDir(home, sessionId, project = 'project-alpha') {
  const dir = join(home, 'sessions', project, sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A store over one throwaway home (env-based path resolution, like production). */
function storeIn(home, overrides = {}) {
  return new LayerStore({ contract, env: { DSH_HOME: home }, home, ...overrides });
}

/** Sorted directory entries. */
async function namesOf(dir) {
  return (await readdir(dir)).sort();
}

/** An EACCES-shaped error. */
function denied(operation) {
  const error = new Error(operation + ': permission denied');
  error.code = 'EACCES';
  return error;
}

/** The real sync fs face with optional overrides. */
function syncFs(overrides = {}) {
  return { lstatSync, statSync, readFileSync, readdirSync, ...overrides };
}

/** The real async fs face with optional overrides (the store's `io` seam). */
function asyncIo(overrides = {}) {
  return { copyFile, lstat, mkdir, readFile, rename, stat, unlink, writeFile, ...overrides };
}

// ------------------------------------------------------------ write / read ----

test('layer-store: writes into the session directory and a fresh store reads it back (AC-1)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const store = storeIn(home);
  const rows = [row('p_1', '说人话', '请用白话解释，先说结论。'), row('p_2', 'two', 'second body')];

  const stamp = await store.write('session-a', rows);
  assert.notEqual(stamp, null);
  assert.equal(stamp.main.path, join(dir, LAYER_FILE_NAME));

  const text = await readFile(join(dir, LAYER_FILE_NAME), 'utf8');
  const onDisk = JSON.parse(text);
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.sessionId, 'session-a');
  assert.deepEqual(onDisk.layers.map((entry) => entry.promptId), ['p_1', 'p_2']);
  assert.match(onDisk.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(text.endsWith('\n'), true, 'the file ends with a newline (design 6.1)');
  assert.equal(text.includes('\n  "version": 1'), true, 'two-space indentation keeps the file hand-editable');
  assert.deepEqual(await namesOf(dir), [LAYER_FILE_NAME], 'exactly one file: no temp, no backup on the first write');

  // A fresh instance is what a restarted DSH sees.
  const fresh = storeIn(home);
  const loaded = fresh.load('session-a', null);
  assert.equal(loaded.unchanged, undefined);
  assert.deepEqual(loaded.rows, rows);
  assert.equal(loaded.source, 'session');
  assert.equal(loaded.readOnly, false);
  assert.equal(loaded.needsPromotion, false);
  assert.equal(loaded.failed, undefined);
  assert.notEqual(loaded.stamp, null);
  assert.equal(fresh.reads, 1);
});

test('layer-store: the composite stamp turns a repeat read into stat-only (AC-14)', async (t) => {
  const { home } = await makeHome(t);
  await makeSessionDir(home, 'session-a');
  const store = storeIn(home);
  await store.write('session-a', [row('p_1', 'one', 'body one')]);

  const first = store.load('session-a', null);
  assert.equal(first.unchanged, undefined);
  assert.deepEqual(first.rows, [row('p_1', 'one', 'body one')]);
  const reads = store.reads;
  const readdirs = store.readdirs;

  assert.deepEqual(store.load('session-a', first.stamp), { unchanged: true });
  assert.equal(store.reads, reads, 'an unchanged stamp must not read the file again');
  assert.equal(store.readdirs, readdirs, 'the located session directory is cached (no rescan)');
});

test('layer-store: a session without a layer file is empty and never an I/O error (AC-13)', async (t) => {
  const { home } = await makeHome(t);
  await makeSessionDir(home, 'session-a');
  const store = storeIn(home);

  const result = store.load('session-a', null);
  assert.deepEqual(result.rows, []);
  assert.equal(result.source, 'none');
  assert.equal(result.readOnly, false);
  assert.equal(result.failed, undefined);
  assert.notEqual(result.stamp, null);
  assert.equal(result.stamp.main.error, 'absent');
  assert.equal(result.stamp.backup.error, 'absent');
  assert.equal(result.stamp.fallback.error, 'absent');
  assert.equal(store.reads, 0, 'an absent file is never read');
  assert.deepEqual(store.load('session-a', result.stamp), { unchanged: true });
});

test('layer-store: a file that appears later is noticed on the next read', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const store = storeIn(home);
  const empty = store.load('session-a', null);
  assert.deepEqual(empty.rows, []);
  // "Do not cache file absence": the platform may write the file at any time.
  await writeFile(join(dir, LAYER_FILE_NAME), layerPayload('session-a', [row('p_3', 'three', 'lately')]), 'utf8');
  const loaded = store.load('session-a', empty.stamp);
  assert.equal(loaded.unchanged, undefined);
  assert.deepEqual(loaded.rows, [row('p_3', 'three', 'lately')]);
});

// ------------------------------------------------------- read-failure paths ----

test('layer-store: a corrupt main file recovers from the backup without touching the disk (AC-6)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const mainPath = join(dir, LAYER_FILE_NAME);
  const backupPath = join(dir, LAYER_BACKUP_FILE_NAME);
  await writeFile(mainPath, '{"version": 1, "layers": [', 'utf8');
  const backupRows = [row('p_9', 'nine', 'from the backup')];
  await writeFile(backupPath, layerPayload('session-a', backupRows), 'utf8');

  const before = await namesOf(dir);
  const mainBefore = await readFile(mainPath, 'utf8');
  const backupBefore = await readFile(backupPath, 'utf8');

  const store = storeIn(home);
  const result = store.load('session-a', null);
  assert.deepEqual(result.rows, backupRows);
  assert.equal(result.source, 'session');
  assert.equal(result.readOnly, false);
  assert.equal(result.failed, undefined);
  assert.notEqual(result.stamp, null);

  assert.equal(await readFile(mainPath, 'utf8'), mainBefore, 'the read path never rewrites the broken file');
  assert.equal(await readFile(backupPath, 'utf8'), backupBefore, 'the read path never repairs the backup either');
  assert.deepEqual(await namesOf(dir), before, 'no rename, no quarantine, no temp file');

  // The recovered state is cached: the recovery is not re-read on every assembly.
  assert.deepEqual(store.load('session-a', result.stamp), { unchanged: true });
});

test('layer-store: a read falls through to the fallback file when both session copies are unusable', async (t) => {
  const { home, fallbackDir } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  await writeFile(join(dir, LAYER_FILE_NAME), 'not json at all', 'utf8');
  await writeFile(join(dir, LAYER_BACKUP_FILE_NAME), '{"version": 1}', 'utf8');
  const fallback = fallbackLayerPaths(fallbackDir, 'session-a');
  await mkdir(dirname(fallback.main), { recursive: true });
  const fallbackRows = [row('p_5', 'five', 'in the fallback')];
  await writeFile(fallback.main, layerPayload('session-a', fallbackRows), 'utf8');

  const store = storeIn(home);
  const result = store.load('session-a', null);
  assert.deepEqual(result.rows, fallbackRows);
  assert.equal(result.source, 'fallback');
  assert.equal(result.needsPromotion, true, 'the session directory exists, so a read asks for the move-in');
  assert.equal(result.failed, undefined);
});

test('layer-store: a content failure is not "failed" and the next write repairs the main file (AC-6/AC-13)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const mainPath = join(dir, LAYER_FILE_NAME);
  await writeFile(mainPath, '{"version": 1, "sessionId": "session-a", "layers": "nope"}', 'utf8');
  const store = storeIn(home);

  const broken = store.load('session-a', null);
  assert.deepEqual(broken.rows, []);
  assert.equal(broken.source, 'none');
  assert.equal(broken.failed, undefined, 'a content failure allows a repairing write');
  assert.notEqual(broken.stamp, null);

  const stamp = await store.write('session-a', [row('p_1', 'one', 'repaired')]);
  assert.notEqual(stamp, null);
  assert.deepEqual(store.load('session-a', null).rows, [row('p_1', 'one', 'repaired')]);
  assert.equal(JSON.parse(await readFile(mainPath, 'utf8')).layers.length, 1);
  assert.equal(existsSync(join(dir, LAYER_BACKUP_FILE_NAME)), false, 'the broken file was not copied over the backup');
});

test('layer-store: an unreadable layer file is an I/O failure when no copy is readable (AC-13)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  await writeFile(join(dir, LAYER_FILE_NAME), layerPayload('session-a', [row('p_1', 'one', 'one')]), 'utf8');
  const before = await namesOf(dir);
  const store = storeIn(home, {
    fs: syncFs({
      readFileSync() {
        throw denied('readFileSync');
      }
    })
  });

  const result = store.load('session-a', null);
  assert.deepEqual(result.rows, []);
  assert.equal(result.source, 'none');
  assert.equal(result.failed, true, 'an I/O failure with no usable copy refuses writes upstream');
  assert.equal(result.stamp, null, 'the stamp is dropped so the next read retries');
  assert.deepEqual(await namesOf(dir), before, 'the read path never moves or cleans the unreadable file');
});

test('layer-store: an I/O failure outranks a content failure on another candidate (AC-13)', async (t) => {
  const { home, fallbackDir } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  await writeFile(join(dir, LAYER_FILE_NAME), 'not json', 'utf8');
  const fallback = fallbackLayerPaths(fallbackDir, 'session-a');
  await mkdir(dirname(fallback.main), { recursive: true });
  await writeFile(fallback.main, layerPayload('session-a', [row('p_2', 'two', 'two')]), 'utf8');
  const unreadable = fallback.main;
  const store = storeIn(home, {
    fs: syncFs({
      readFileSync(path, encoding) {
        if (path === unreadable) throw denied('readFileSync');
        return readFileSync(path, encoding);
      }
    })
  });

  const result = store.load('session-a', null);
  assert.deepEqual(result.rows, []);
  assert.equal(result.failed, true, 'mixed cases are I/O-first');
  assert.equal(result.stamp, null);
});

test('layer-store: an I/O error before the hit clears the stamp but still serves the backup (AC-13)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const mainPath = join(dir, LAYER_FILE_NAME);
  await writeFile(mainPath, layerPayload('session-a', [row('p_1', 'one', 'main')]), 'utf8');
  const backupRows = [row('p_9', 'nine', 'backup')];
  await writeFile(join(dir, LAYER_BACKUP_FILE_NAME), layerPayload('session-a', backupRows), 'utf8');
  const store = storeIn(home, {
    fs: syncFs({
      readFileSync(path, encoding) {
        if (path === mainPath) throw denied('readFileSync');
        return readFileSync(path, encoding);
      }
    })
  });

  const result = store.load('session-a', null);
  assert.deepEqual(result.rows, backupRows);
  assert.equal(result.source, 'session');
  assert.equal(result.failed, undefined, 'a hit still serves the session its layers');
  assert.equal(result.stamp, null, 'a pre-hit I/O error forces a retry on the next read');

  const reads = store.reads;
  assert.deepEqual(store.load('session-a', null).rows, backupRows);
  assert.ok(store.reads > reads, 'the retry re-reads instead of trusting a cache');
});

test('layer-store: an I/O error after the hit keeps the cache and only stats (AC-13/AC-14)', async (t) => {
  const { home, fallbackDir } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  await writeFile(join(dir, LAYER_FILE_NAME), layerPayload('session-a', [row('p_1', 'one', 'main')]), 'utf8');
  const fallbackPath = fallbackLayerPaths(fallbackDir, 'session-a').main;
  const store = storeIn(home, {
    fs: syncFs({
      lstatSync(path) {
        if (path === fallbackPath) throw denied('lstatSync');
        return lstatSync(path);
      }
    })
  });

  const result = store.load('session-a', null);
  assert.deepEqual(result.rows, [row('p_1', 'one', 'main')]);
  assert.notEqual(result.stamp, null, 'a post-hit I/O error does not stop caching');
  assert.deepEqual(result.stamp.fallback, { path: fallbackPath, error: 'stat-failed' });

  const reads = store.reads;
  assert.deepEqual(store.load('session-a', result.stamp), { unchanged: true });
  assert.equal(store.reads, reads, 'the error marker is part of the stamp: a repeat read only stats');
});

// ------------------------------------------------ ownership, empty state ----

test('layer-store: a session without a directory writes the fallback, and a later directory can take it over (AC-8)', async (t) => {
  const { home, fallbackDir } = await makeHome(t);
  const store = storeIn(home);
  const rows = [row('p_1', 'one', 'written before the session directory exists')];

  const stamp = await store.write('session-new', rows);
  assert.notEqual(stamp, null);
  assert.deepEqual(await namesOf(fallbackDir), ['session-new.json'], 'the fallback main file, no temp file');
  assert.equal(existsSync(join(home, 'sessions')), false, 'the store never invents a session directory');

  const first = store.load('session-new', null);
  assert.deepEqual(first.rows, rows);
  assert.equal(first.source, 'fallback');
  assert.equal(first.needsPromotion, false, 'there is no session directory to move into yet');

  // The platform creates the session directory: the next read must notice it.
  const dir = await makeSessionDir(home, 'session-new');
  const promoted = store.load('session-new', first.stamp);
  assert.equal(promoted.unchanged, undefined, 'an appearing directory changes the candidate set');
  assert.deepEqual(promoted.rows, rows);
  assert.equal(promoted.source, 'fallback');
  assert.equal(promoted.needsPromotion, true, 'the read asks the registry to move the files in');

  // The registry's move-in is a normal write once the directory exists.
  await store.write('session-new', rows);
  assert.deepEqual(await namesOf(dir), [LAYER_FILE_NAME], 'the session directory owns the layer file now');
  assert.deepEqual(await namesOf(fallbackDir), [], 'the fallback files are gone after the move-in');
});

test('layer-store: an empty state is a legal empty file and drops the backup (AC-2/D5)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const store = storeIn(home);

  await store.write('session-a', [row('p_1', 'one', 'first'), row('p_2', 'two', 'second')]);
  await store.write('session-a', [row('p_1', 'one', 'second version')]);
  assert.deepEqual(await namesOf(dir), [LAYER_BACKUP_FILE_NAME, LAYER_FILE_NAME], 'the previous version is kept as the backup');
  assert.deepEqual(JSON.parse(await readFile(join(dir, LAYER_BACKUP_FILE_NAME), 'utf8')).layers.map((entry) => entry.promptId), ['p_1', 'p_2']);
  assert.equal(existsSync(join(dir, LAYER_FILE_NAME + LAYER_TEMP_SUFFIX)), false, 'no temp file is left behind');

  await store.write('session-a', []);
  assert.equal(existsSync(join(dir, LAYER_BACKUP_FILE_NAME)), false, 'the backup is deleted so removed layers cannot come back');
  const emptyFile = JSON.parse(await readFile(join(dir, LAYER_FILE_NAME), 'utf8'));
  assert.equal(emptyFile.version, 1);
  assert.equal(emptyFile.sessionId, 'session-a');
  assert.deepEqual(emptyFile.layers, [], 'the empty state is a legal, hand-readable empty layer file');

  const fresh = storeIn(home);
  const loaded = fresh.load('session-a', null);
  assert.deepEqual(loaded.rows, []);
  assert.equal(loaded.source, 'session', 'the empty file is a real (empty) session state');
  assert.equal(loaded.failed, undefined);
});

test('layer-store: two sessions never share a file (AC-4)', async (t) => {
  const { home } = await makeHome(t);
  const dirA = await makeSessionDir(home, 'session-a');
  const dirB = await makeSessionDir(home, 'session-b');
  const store = storeIn(home);
  const rowsA = [row('p_a', 'a', 'body of a')];
  const rowsB = [row('p_b', 'b', 'body of b')];

  await store.write('session-a', rowsA);
  await store.write('session-b', rowsB);

  assert.deepEqual(store.load('session-a', null).rows, rowsA);
  assert.deepEqual(store.load('session-b', null).rows, rowsB);
  assert.deepEqual(JSON.parse(await readFile(join(dirA, LAYER_FILE_NAME), 'utf8')).layers, rowsA);
  assert.deepEqual(JSON.parse(await readFile(join(dirB, LAYER_FILE_NAME), 'utf8')).layers, rowsB);
});

test('layer-store: a session directory copied away and back reads the same (AC-5)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const store = storeIn(home);
  const rows = [row('p_1', '说人话', '请用白话解释，先说结论。')];
  await store.write('session-a', rows);

  // "Copy the whole session directory elsewhere and copy it back": no other
  // plugin is involved, the file simply travels with the directory.
  const away = join(home, 'elsewhere');
  await cp(dir, away, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await cp(away, dir, { recursive: true });

  const fresh = storeIn(home);
  const loaded = fresh.load('session-a', null);
  assert.deepEqual(loaded.rows, rows);
  assert.equal(loaded.source, 'session');
});

// ------------------------------------------------------ safety and budget ----

test('layer-store: an unsafe session id never touches the filesystem (AC-9)', async (t) => {
  const { home } = await makeHome(t);
  const store = storeIn(home);
  const before = await namesOf(home);

  for (const bad of ['../evil', 'a/b', 'a\\b', 'has space', '', '.', '..']) {
    const result = store.load(bad, null);
    assert.deepEqual(result.rows, [], 'an unsafe id reads as no file: ' + JSON.stringify(bad));
    assert.equal(result.source, 'none');
    assert.equal(result.failed, undefined);
    assert.equal(result.stamp, null);
    await assert.rejects(store.write(bad, [row('p_1', 'one', 'one')]), (error) => error.code === 'session-invalid');
  }
  assert.equal(store.stats, 0, 'no candidate is ever stat-ed for an unsafe id');
  assert.deepEqual(await namesOf(home), before, 'nothing was created for an unsafe id');
});

test('layer-store: a file over 1 MiB is never read or parsed (AC-14)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const mainPath = join(dir, LAYER_FILE_NAME);
  const backupRows = [row('p_9', 'nine', 'recovered from the backup')];
  await writeFile(mainPath, Buffer.alloc(10 * 1024 * 1024, 0x61));
  await writeFile(join(dir, LAYER_BACKUP_FILE_NAME), layerPayload('session-a', backupRows), 'utf8');

  const store = storeIn(home);
  const result = store.load('session-a', null);
  assert.deepEqual(result.rows, backupRows, 'an oversized candidate is skipped, the next one is used');
  assert.equal(store.reads, 1, 'the 10 MiB file is never read (only the backup is)');
  assert.equal(result.stamp.main.size, 10 * 1024 * 1024);
  assert.deepEqual(store.load('session-a', result.stamp), { unchanged: true });
  assert.equal(store.reads, 1, 'an unchanged stamp stays stat-only');

  // Oversized with no usable copy: no file, but a content failure (repairable).
  await rm(join(dir, LAYER_BACKUP_FILE_NAME));
  const lonely = storeIn(home);
  const empty = lonely.load('session-a', null);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.failed, undefined, 'an oversized file is a content failure, not an I/O failure');
  assert.equal(lonely.reads, 0, 'the oversized file is never read');
  assert.notEqual(empty.stamp, null, 'the stamp is still cached: a repeat read only stats');
  assert.deepEqual(lonely.load('session-a', empty.stamp), { unchanged: true });
});

test('layer-store: a store whose filesystem throws still returns empty instead of throwing (AC-13)', async (t) => {
  const { home } = await makeHome(t);
  await makeSessionDir(home, 'session-a');
  const store = storeIn(home, {
    fs: syncFs({
      lstatSync() {
        throw denied('lstatSync');
      },
      statSync() {
        throw denied('statSync');
      },
      readFileSync() {
        throw denied('readFileSync');
      },
      readdirSync() {
        throw denied('readdirSync');
      }
    })
  });

  let result;
  assert.doesNotThrow(() => {
    result = store.load('session-a', null);
  }, 'the read path never throws at the system-prompt / RPC boundary');
  assert.deepEqual(result.rows, []);
  assert.equal(result.source, 'none');
  assert.equal(result.failed, true, 'an I/O failure with no usable candidate is reported, not thrown');
  assert.equal(result.stamp, null);
});

// ---------------------------------- size boundary, mid-read loss, zero writes ----

test('layer-store: exactly 1 MiB is readable and one byte more is never read (AC-14/M4)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const mainPath = join(dir, LAYER_FILE_NAME);
  const rows = [row('p_1', 'one', 'on the boundary')];
  const payload = layerPayload('session-a', rows);
  const exact = Buffer.alloc(MAX_FILE_BYTES, 0x20);
  exact.write(payload, 0, 'utf8');
  assert.ok(payload.length < MAX_FILE_BYTES, 'the JSON itself stays well below the cap');
  assert.equal(exact.length, MAX_FILE_BYTES);
  await writeFile(mainPath, exact);

  const atLimit = storeIn(home);
  const readable = atLimit.load('session-a', null);
  assert.deepEqual(readable.rows, rows, 'a file of exactly MAX_FILE_BYTES is read and parsed');
  assert.equal(atLimit.reads, 1);
  assert.equal(readable.stamp.main.size, MAX_FILE_BYTES);

  await writeFile(mainPath, Buffer.concat([exact, Buffer.from(' ', 'utf8')]));
  const overLimit = storeIn(home);
  const skipped = overLimit.load('session-a', null);
  assert.deepEqual(skipped.rows, []);
  assert.equal(overLimit.reads, 0, 'one byte over the cap is never read or parsed');
  assert.equal(skipped.failed, undefined, 'oversized stays a content failure (a later write may repair it)');
  assert.equal(skipped.stamp.main.size, MAX_FILE_BYTES + 1);
});

test('layer-store: a file deleted between stat and read is an I/O failure, never a throw (AC-13/M5)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const mainPath = join(dir, LAYER_FILE_NAME);
  const backupPath = join(dir, LAYER_BACKUP_FILE_NAME);
  const backupRows = [row('p_9', 'nine', 'survived the race')];
  await writeFile(mainPath, layerPayload('session-a', [row('p_1', 'one', 'vanishing')]), 'utf8');
  await writeFile(backupPath, layerPayload('session-a', backupRows), 'utf8');

  const vanish = () => {
    const error = new Error('ENOENT: the layer file disappeared between stat and read');
    error.code = 'ENOENT';
    return error;
  };
  const raceFs = () => syncFs({
    readFileSync(path, encoding) {
      if (path === mainPath) throw vanish();
      return readFileSync(path, encoding);
    }
  });

  const store = storeIn(home, { fs: raceFs() });
  let result;
  assert.doesNotThrow(() => { result = store.load('session-a', null); }, 'a mid-read ENOENT must not escape the reader');
  assert.deepEqual(result.rows, backupRows, 'the walk continues with the next candidate');
  assert.equal(result.source, 'session');
  assert.equal(result.failed, undefined, 'a hit after the loss still serves the session its layers');
  assert.equal(result.stamp, null, 'the pre-hit I/O error drops the stamp so the next read retries');

  // The same vanished read with no usable copy is an I/O-class "no file".
  await rm(backupPath);
  const alone = storeIn(home, { fs: raceFs() });
  const empty = alone.load('session-a', null);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.source, 'none');
  assert.equal(empty.failed, true, 'no usable copy + a vanished read is an I/O failure');
  assert.equal(empty.stamp, null);
});

test('layer-store: the read path performs zero filesystem writes (AC-6/AC-13/M3)', async (t) => {
  const { home } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const mainPath = join(dir, LAYER_FILE_NAME);
  const backupPath = join(dir, LAYER_BACKUP_FILE_NAME);
  const backupRows = [row('p_9', 'nine', 'from the backup')];
  await writeFile(mainPath, '{"version": 1, "layers": [', 'utf8');
  await writeFile(backupPath, layerPayload('session-a', backupRows), 'utf8');
  const filesBefore = await namesOf(dir);
  const mainBefore = await readFile(mainPath, 'utf8');
  const backupBefore = await readFile(backupPath, 'utf8');

  const mutations = [];
  const deny = (name) => async () => {
    mutations.push(name);
    throw new Error('the read path must never write (' + name + ')');
  };
  const store = storeIn(home, {
    io: asyncIo({
      copyFile: deny('copyFile'),
      mkdir: deny('mkdir'),
      rename: deny('rename'),
      unlink: deny('unlink'),
      writeFile: deny('writeFile')
    })
  });

  const result = store.load('session-a', null);
  assert.deepEqual(result.rows, backupRows, 'a readable backup still recovers the layers');
  assert.deepEqual(mutations, [], 'an fs-seam write counter proves the read path never writes');
  assert.deepEqual(await namesOf(dir), filesBefore, 'no rename, no quarantine, no temp file');
  assert.equal(await readFile(mainPath, 'utf8'), mainBefore, 'the broken main file is untouched');
  assert.equal(await readFile(backupPath, 'utf8'), backupBefore, 'the backup is not repaired by a read');
});

// ------------------------------------------------------------ observability ----

test('layer-store: duplicate session directories serve the first and log every candidate (design 9/A3)', async (t) => {
  const { home } = await makeHome(t);
  const alpha = await makeSessionDir(home, 'session-a', 'project-alpha');
  const beta = await makeSessionDir(home, 'session-a', 'project-beta');
  const alphaRows = [row('p_1', 'one', 'first body')];
  const betaRows = [row('p_2', 'two', 'second body')];
  await writeFile(join(alpha, LAYER_FILE_NAME), layerPayload('session-a', alphaRows), 'utf8');
  await writeFile(join(beta, LAYER_FILE_NAME), layerPayload('session-a', betaRows), 'utf8');

  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  let result;
  try {
    result = storeIn(home).load('session-a', null);
  } finally {
    console.error = original;
  }

  assert.equal(logged.length, 1, 'the duplicate is reported exactly once');
  assert.match(String(logged[0][0]), /duplicate session directories/u);
  assert.equal(String(logged[0][1]), 'session-a', 'the log carries the session id');
  const candidates = logged[0][2];
  assert.equal(candidates.length, 2, 'the log carries every candidate path');
  assert.deepEqual(new Set(candidates), new Set([alpha, beta]));
  const winner = candidates[0];
  assert.deepEqual(result.rows, winner === alpha ? alphaRows : betaRows, 'the first candidate in scan order is served');
  const text = JSON.stringify(logged);
  assert.equal(text.includes('first body'), false, 'the log never carries a layer body');
  assert.equal(text.includes('second body'), false, 'the log never carries a layer body');
});

test('layer-store: a session directory that vanishes during a write falls back to the plugin directory and is logged (design 5.3/A3)', async (t) => {
  const { home, fallbackDir } = await makeHome(t);
  const dir = await makeSessionDir(home, 'session-a');
  const rows = [row('p_1', 'one', 'first body')];
  const realWriteFile = writeFile;
  const io = asyncIo({
    async writeFile(path, text, encoding) {
      if (path.startsWith(dir)) {
        // The platform moved/removed the session directory between locate and
        // write: the real fs now fails, and the store's ENOENT retry re-locates
        // (no directory) and falls back to the plugin directory.
        await rm(dir, { recursive: true, force: true });
        throw Object.assign(new Error('ENOENT: the session directory vanished'), { code: 'ENOENT' });
      }
      return realWriteFile(path, text, encoding);
    }
  });

  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  let stamp;
  try {
    stamp = await new LayerStore({ contract, env: { DSH_HOME: home }, home, io }).write('session-a', rows);
  } finally {
    console.error = original;
  }

  assert.notEqual(stamp, null);
  assert.equal(existsSync(join(dir, LAYER_FILE_NAME)), false, 'nothing is written into the vanished directory');
  assert.deepEqual(await namesOf(fallbackDir), ['session-a.json'], 'the layer went to the plugin fallback directory');
  assert.equal(logged.length, 1, 'the fallback is reported exactly once');
  assert.match(String(logged[0][0]), /session directory vanished/u);
  assert.equal(String(logged[0][1]), 'session-a', 'the log carries the session id');
  assert.equal(String(logged[0][2]), 'ENOENT', 'the log carries the error code');
  assert.equal(String(logged[0][3]), join(dir, LAYER_FILE_NAME), 'the log carries the failed target path');
  assert.match(String(logged[0][4]), /prompt-library[\\/]sessions[\\/]session-a\.json$/u);
  assert.equal(JSON.stringify(logged).includes('first body'), false, 'the log never carries a layer body');
});


