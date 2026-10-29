/**
 * LayerRegistry (src/host/layers.ts -> lib/host/layers.js) after 0.2:
 *
 *   - the 0.1 semantics that must not change: add / update-in-place / the three
 *     layer limit / remove / clear / session isolation / sectionText joined by
 *     the design separator, and the limits coming from the shared contract;
 *   - the 0.2 persistence semantics (design §5.4): every mutation re-reads first
 *     and persists before committing, a failed persist leaves memory and the
 *     chips untouched (AC-7), an I/O-class read failure refuses writes with
 *     layer-read-failed and arms the 30s backoff (AC-13), a content-class failure
 *     does not (so a repairing write is allowed), a newer file version is
 *     read-only, and a fallback file is moved into the session directory once
 *     the read reports that it is promotable (AC-8);
 *   - the read side never throws (AC-10/AC-13): sectionText is '' and snapshot is
 *     an empty snapshot when the store throws, reports failed, or has no layers.
 *
 * The store is a hand-written in-memory fake, injected through the registry's
 * documented `store` seam, so a failure point can be placed exactly where the
 * design describes it (read failure, write failure, unknown version, promotion).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadZod } from './_zod.mjs';
import { defineContract } from '../lib/contract.js';
import { LAYER_BACKUP_FILE_NAME, LAYER_FILE_NAME, LayerStore } from '../lib/host/layer-store.js';
import {
  LAYER_LIMIT_CODE,
  LAYER_PERSIST_CODE,
  LAYER_READONLY_CODE,
  LAYER_READ_FAILED_CODE,
  LayerRegistry
} from '../lib/host/layers.js';
import { estimateTokens } from '../lib/shared/tokens.js';

const z = await loadZod();
const contract = defineContract(z);

/** One layer input. */
function layerOf(promptId, body, title = 'title-' + promptId) {
  return { promptId, title, body };
}

/** One persisted row (no tokens). */
function rowOf(promptId, body, title = 't-' + promptId) {
  return { promptId, title, body };
}

/** Let the serial queue and its async store calls run. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Poll until `predicate` answers true (bounded).
 * @param {() => Promise<boolean>|boolean} predicate - the condition.
 * @param {string} label - failure description.
 * @returns {Promise<void>} resolves when the condition holds.
 */
async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for ' + label);
}

/**
 * A deterministic in-memory stand-in for the session layer store.
 *
 * It keeps per-session state the way the real store keeps files, so a second
 * mutation's forced re-read sees what the first one wrote. `options.load` /
 * `options.write` may return a value to override a single call (used to inject
 * EACCES-style I/O failures, a failed load, an unknown version, a promotion
 * request or a write failure).
 * @param {{rows?: Record<string, object[]>, load?: Function, write?: Function}} [options] - seeds and hooks.
 * @returns {object} the fake store plus its call log and state map.
 */
function fakeStore(options = {}) {
  const state = new Map(
    Object.entries(options.rows ?? {}).map(([sessionId, rows]) => [sessionId, { rows: rows.map((row) => ({ ...row })), stamp: { file: sessionId } }])
  );
  const calls = { loads: [], writes: [] };
  let stampSeq = 0;
  const store = {
    calls,
    state,
    load(sessionId, previousStamp) {
      calls.loads.push({ sessionId, previousStamp });
      if (options.load !== undefined) {
        const override = options.load(sessionId, previousStamp, calls);
        if (override !== undefined) return override;
      }
      const entry = state.get(sessionId);
      if (entry === undefined) return { rows: [], stamp: { absent: sessionId }, readOnly: false, needsPromotion: false };
      return {
        rows: entry.rows.map((row) => ({ ...row })),
        stamp: entry.stamp,
        readOnly: entry.readOnly === true,
        needsPromotion: entry.promote === true
      };
    },
    async write(sessionId, rows) {
      calls.writes.push({ sessionId, rows: rows.map((row) => ({ ...row })) });
      if (options.write !== undefined) {
        const override = await options.write(sessionId, rows, calls);
        if (override !== undefined) return override;
      }
      stampSeq += 1;
      const stamp = { file: sessionId, n: stampSeq };
      state.set(sessionId, { rows: rows.map((row) => ({ ...row })), stamp });
      return stamp;
    }
  };
  return store;
}

// ------------------------------------------------- 0.1 semantics (unchanged) ----

test('layers: add returns the wire snapshot with per-row and total tokens', async () => {
  const layers = new LayerRegistry({ contract });
  const snapshot = await layers.add('s1', layerOf('p_1', '\u4e2d\u6587\u6b63\u6587'));
  assert.equal(snapshot.layers.length, 1);
  assert.deepEqual(snapshot.layers[0], {
    promptId: 'p_1',
    title: 'title-p_1',
    body: '\u4e2d\u6587\u6b63\u6587',
    tokens: estimateTokens('\u4e2d\u6587\u6b63\u6587')
  });
  assert.equal(snapshot.totalTokens, estimateTokens('\u4e2d\u6587\u6b63\u6587'));
  assert.equal(snapshot.limit, 3);
  assert.equal(layers.size, 1);
});

test('layers: insertion order is preserved and totals are summed', async () => {
  const layers = new LayerRegistry({ contract });
  await layers.add('s1', layerOf('p_1', 'one'));
  const snapshot = await layers.add('s1', layerOf('p_2', 'two'));
  await layers.add('s1', layerOf('p_3', 'three'));
  assert.deepEqual(snapshot.layers.map((layer) => layer.promptId), ['p_1', 'p_2']);
  const all = layers.snapshot('s1');
  assert.deepEqual(all.layers.map((layer) => layer.promptId), ['p_1', 'p_2', 'p_3']);
  assert.equal(all.totalTokens, ['one', 'two', 'three'].reduce((sum, body) => sum + estimateTokens(body), 0));
});

test('layers: the same promptId updates in place instead of adding a row', async () => {
  const layers = new LayerRegistry({ contract });
  await layers.add('s1', layerOf('p_1', 'old body', 'old title'));
  const snapshot = await layers.add('s1', layerOf('p_1', 'new body', 'new title'));
  assert.equal(snapshot.layers.length, 1);
  assert.deepEqual(snapshot.layers[0], {
    promptId: 'p_1',
    title: 'new title',
    body: 'new body',
    tokens: estimateTokens('new body')
  });
  assert.equal(snapshot.totalTokens, estimateTokens('new body'));
});

test('layers: a fourth distinct layer is refused with layer-limit and is never written', async () => {
  const store = fakeStore();
  const layers = new LayerRegistry({ contract, store });
  await layers.add('s1', layerOf('p_1', 'one'));
  await layers.add('s1', layerOf('p_2', 'two'));
  await layers.add('s1', layerOf('p_3', 'three'));
  const writesBefore = store.calls.writes.length;
  await assert.rejects(layers.add('s1', layerOf('p_4', 'four')), (error) => error.code === LAYER_LIMIT_CODE);
  assert.equal(store.calls.writes.length, writesBefore, 'a refused fourth layer never reaches the disk');
  assert.equal(layers.snapshot('s1').layers.length, 3);
  assert.equal(store.state.get('s1').rows.length, 3, 'the persisted state still holds three layers');
  assert.equal(layers.sectionText('s1').split('\n\n---\n\n').length, 3);
});

test('layers: remove drops one row and is idempotent for unknown ids', async () => {
  const layers = new LayerRegistry({ contract });
  await layers.add('s1', layerOf('p_1', 'one'));
  await layers.add('s1', layerOf('p_2', 'two'));
  const afterRemove = await layers.remove('s1', 'p_1');
  assert.deepEqual(afterRemove.layers.map((layer) => layer.promptId), ['p_2']);
  assert.equal(afterRemove.totalTokens, estimateTokens('two'));
  const afterUnknown = await layers.remove('s1', 'p_missing');
  assert.deepEqual(afterUnknown.layers.map((layer) => layer.promptId), ['p_2']);
  const emptied = await layers.remove('s1', 'p_2');
  assert.deepEqual(emptied.layers, []);
  assert.equal(emptied.totalTokens, 0);
  assert.equal(layers.size, 0);
});

test('layers: clear empties exactly one session and leaves the other intact', async () => {
  const layers = new LayerRegistry({ contract });
  await layers.add('s1', layerOf('p_1', 'one'));
  await layers.add('s2', layerOf('p_2', 'two'));
  const cleared = await layers.clear('s1');
  assert.deepEqual(cleared.layers, []);
  assert.equal(cleared.limit, 3);
  assert.equal(layers.size, 1);
  assert.equal(layers.sectionText('s2'), 'two');
  // Clearing an unknown session is idempotent and still answers a snapshot.
  assert.deepEqual((await layers.clear('s_unknown')).layers, []);
  assert.equal(layers.size, 1);
});

test('layers: sessions are isolated from each other', async () => {
  const layers = new LayerRegistry({ contract });
  await layers.add('s1', layerOf('p_1', 'one'));
  await layers.add('s1', layerOf('p_2', 'two'));
  await layers.add('s2', layerOf('p_9', 'nine'));
  assert.deepEqual(layers.snapshot('s1').layers.map((layer) => layer.promptId), ['p_1', 'p_2']);
  assert.deepEqual(layers.snapshot('s2').layers.map((layer) => layer.promptId), ['p_9']);
  assert.equal(layers.sectionText('s3'), '');
});

test('layers: sectionText is empty without layers, one body with one, ordered with two', async () => {
  const layers = new LayerRegistry({ contract });
  assert.equal(layers.sectionText('s1'), '');
  assert.equal(layers.sectionText('unknown-session'), '');
  await layers.add('s1', layerOf('p_1', 'first body'));
  assert.equal(layers.sectionText('s1'), 'first body');
  await layers.add('s1', layerOf('p_2', 'second body'));
  assert.equal(layers.sectionText('s1'), 'first body\n\n---\n\nsecond body');
  await layers.add('s1', layerOf('p_3', 'third body'));
  assert.equal(layers.sectionText('s1'), 'first body\n\n---\n\nsecond body\n\n---\n\nthird body');
  await layers.remove('s1', 'p_1');
  assert.equal(layers.sectionText('s1'), 'second body\n\n---\n\nthird body');
});

test('layers: the limit comes from the shared contract, not a local constant', async () => {
  const narrow = new LayerRegistry({ contract: { LIMITS: { layers: 1 } } });
  await narrow.add('s1', layerOf('p_1', 'one'));
  await assert.rejects(narrow.add('s1', layerOf('p_2', 'two')), (error) => error.code === LAYER_LIMIT_CODE);
  assert.equal(narrow.snapshot('s1').limit, 1);
});

// ------------------------------------------------ persisted registry (§5.4) ----

test('layers: a fresh registry reads the session back from the store (AC-1)', () => {
  const store = fakeStore({ rows: { s1: [rowOf('p_1', 'from disk'), rowOf('p_2', 'also from disk')] } });
  const layers = new LayerRegistry({ contract, store });
  assert.equal(layers.sectionText('s1'), 'from disk\n\n---\n\nalso from disk');
  const snapshot = layers.snapshot('s1');
  assert.deepEqual(snapshot.layers.map((layer) => layer.promptId), ['p_1', 'p_2']);
  assert.equal(snapshot.totalTokens, estimateTokens('from disk') + estimateTokens('also from disk'));
  assert.equal(store.calls.writes.length, 0, 'a read never writes');
});

test('layers: add persists before committing and passes plain rows to the store', async () => {
  const store = fakeStore();
  const layers = new LayerRegistry({ contract, store });
  const snapshot = await layers.add('s1', layerOf('p_1', 'one'));
  assert.equal(store.calls.writes.length, 1);
  assert.deepEqual(store.calls.writes[0].rows, [rowOf('p_1', 'one', 'title-p_1')], 'no token field is persisted');
  assert.deepEqual(store.state.get('s1').rows, [rowOf('p_1', 'one', 'title-p_1')]);
  assert.equal(snapshot.layers[0].tokens, estimateTokens('one'));
  assert.equal(store.calls.loads.length > 0, true, 'the write is preceded by a read (write-before-read)');
});

test('layers: a failed write rejects layer-persist and commits nothing (AC-7)', async () => {
  const store = fakeStore({
    write() {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
  });
  const layers = new LayerRegistry({ contract, store });
  await assert.rejects(layers.add('s1', layerOf('p_1', 'one')), (error) => error.code === LAYER_PERSIST_CODE);
  assert.deepEqual(layers.snapshot('s1').layers, [], 'no fake chip: memory stayed empty');
  assert.equal(layers.sectionText('s1'), '', 'the prompt section stays empty too');
  assert.equal(store.state.has('s1'), false, 'nothing reached the disk');
});

test('layers: a failed write keeps the previous rows instead of a half state', async () => {
  let failNext = false;
  const store = fakeStore({
    write(sessionId, rows) {
      if (failNext) throw new Error('rename failed');
      return undefined; // fall through to the fake's normal write
    }
  });
  const layers = new LayerRegistry({ contract, store });
  await layers.add('s1', layerOf('p_1', 'one'));
  failNext = true;
  await assert.rejects(layers.add('s1', layerOf('p_2', 'two')), (error) => error.code === LAYER_PERSIST_CODE);
  assert.deepEqual(layers.snapshot('s1').layers.map((layer) => layer.promptId), ['p_1'], 'the committed row survives');
  assert.deepEqual(store.state.get('s1').rows.map((row) => row.promptId), ['p_1'], 'the disk keeps the previous version');
});

test('layers: session-invalid from the store keeps its own code', async () => {
  const store = fakeStore({
    write() {
      throw Object.assign(new Error('the session id "../x" is not a safe layer-file name'), { code: 'session-invalid' });
    }
  });
  const layers = new LayerRegistry({ contract, store });
  await assert.rejects(layers.add('s1', layerOf('p_1', 'one')), (error) => error.code === 'session-invalid');
});

test('layers: an I/O read failure refuses writes and arms the 30s backoff (AC-13)', async () => {
  let failReads = true;
  const store = fakeStore({
    load(sessionId, previousStamp, calls) {
      if (failReads) return { rows: [], stamp: null, readOnly: false, needsPromotion: false, failed: true };
      return undefined;
    }
  });
  const layers = new LayerRegistry({ contract, store });
  // Read side: fail-open, empty, no throw.
  assert.deepEqual(layers.snapshot('s1').layers, []);
  assert.equal(layers.sectionText('s1'), '');
  const loadsAfterBackoff = store.calls.loads.length;

  // The failure also refuses the write: never overwrite a file we could not read.
  await assert.rejects(layers.add('s1', layerOf('p_1', 'one')), (error) => error.code === LAYER_READ_FAILED_CODE);
  assert.equal(store.calls.writes.length, 0, 'nothing is written after an unreadable state');

  // While the backoff is armed, a plain read does not retry the store at all.
  layers.snapshot('s1');
  layers.sectionText('s1');
  assert.equal(store.calls.loads.length, loadsAfterBackoff + 1, 'only the forced write-path read ran, plain reads back off');
});

test('layers: a content-class failure is repairable with the next write (AC-6/AC-13)', async () => {
  const store = fakeStore({
    load(sessionId, previousStamp, calls) {
      if (calls.writes.length > 0) return undefined; // repaired: serve the fresh state
      // What layer-store returns for a broken main file with no usable backup:
      // empty rows, a real stamp, and no 'failed' flag.
      return { rows: [], stamp: { broken: true }, readOnly: false, needsPromotion: false };
    }
  });
  const layers = new LayerRegistry({ contract, store });
  assert.deepEqual(layers.snapshot('s1').layers, []);
  await layers.add('s1', layerOf('p_1', 'repaired'));
  assert.equal(store.calls.writes.length, 1, 'a content failure allows the repairing write');
  assert.deepEqual(layers.snapshot('s1').layers.map((layer) => layer.promptId), ['p_1']);
});

test('layers: a newer layer-file version is read-only for add / remove / clear', async () => {
  const store = fakeStore({
    load() {
      return { rows: [], stamp: { newer: true }, readOnly: true, needsPromotion: false };
    }
  });
  const layers = new LayerRegistry({ contract, store });
  assert.deepEqual(layers.snapshot('s1').layers, []);
  await assert.rejects(layers.add('s1', layerOf('p_1', 'one')), (error) => error.code === LAYER_READONLY_CODE);
  await assert.rejects(layers.remove('s1', 'p_1'), (error) => error.code === LAYER_READONLY_CODE);
  await assert.rejects(layers.clear('s1'), (error) => error.code === LAYER_READONLY_CODE);
  assert.equal(store.calls.writes.length, 0);
});

test('layers: an unchanged stamp keeps the committed rows and writes nothing', async () => {
  const store = fakeStore({
    rows: { s1: [rowOf('p_1', 'cached')] },
    load(sessionId, previousStamp, calls) {
      if (calls.loads.length > 1) return { unchanged: true };
      return undefined; // first read: the fake's normal load
    }
  });
  const layers = new LayerRegistry({ contract, store });
  // First read: the store returns its committed rows. Later reads answer
  // {unchanged:true}, which means "the caller already holds this state": the
  // registry must KEEP those rows and must not write.
  assert.deepEqual(layers.snapshot('s1').layers.map((layer) => layer.promptId), ['p_1']);
  assert.equal(layers.sectionText('s1'), 'cached');
  assert.deepEqual(
    layers.snapshot('s1').layers.map((layer) => layer.promptId),
    ['p_1'],
    'an unchanged stamp keeps the committed rows'
  );
  assert.equal(store.calls.writes.length, 0);

  const seeded = new LayerRegistry({ contract, store: fakeStore({ rows: { s2: [rowOf('p_2', 'cached')] } }) });
  assert.equal(seeded.sectionText('s2'), 'cached');
  assert.equal(store.calls.writes.length, 0);
});

test('layers: a store that throws never breaks the section or the snapshot (AC-13)', () => {
  const store = fakeStore({
    load() {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    }
  });
  const layers = new LayerRegistry({ contract, store });
  assert.doesNotThrow(() => layers.snapshot('s1'));
  assert.deepEqual(layers.snapshot('s1').layers, []);
  assert.equal(layers.sectionText('s1'), '');
  // ...and the failure still refuses writes, exactly like a reported I/O failure.
  return assert.rejects(layers.add('s1', layerOf('p_1', 'one')), (error) => error.code === LAYER_READ_FAILED_CODE);
});

test('layers: remove of the last layer and clear both persist an empty state (AC-2)', async () => {
  const store = fakeStore();
  const layers = new LayerRegistry({ contract, store });
  await layers.add('s1', layerOf('p_1', 'one'));
  await layers.remove('s1', 'p_1');
  assert.deepEqual(store.calls.writes.at(-1).rows, [], 'removing the last layer writes the empty state');
  assert.equal(layers.sectionText('s1'), '');

  await layers.add('s1', layerOf('p_2', 'two'));
  const writesBefore = store.calls.writes.length;
  await layers.clear('s1');
  assert.equal(store.calls.writes.length, writesBefore + 1);
  assert.deepEqual(store.calls.writes.at(-1).rows, []);
  // An already-empty clear is a no-op: no pointless write.
  const afterClear = store.calls.writes.length;
  await layers.clear('s1');
  assert.equal(store.calls.writes.length, afterClear);
});

test('layers: an unknown promptId removal writes nothing', async () => {
  const store = fakeStore({ rows: { s1: [rowOf('p_1', 'one')] } });
  const layers = new LayerRegistry({ contract, store });
  const snapshot = await layers.remove('s1', 'p_missing');
  assert.deepEqual(snapshot.layers.map((layer) => layer.promptId), ['p_1']);
  assert.equal(store.calls.writes.length, 0, 'an idempotent removal never touches the disk');
});

test('layers: a promotable fallback is moved into the session directory (AC-8)', async () => {
  let promote = true;
  const store = fakeStore({
    rows: { s1: [rowOf('p_1', 'from the fallback')] },
    load(sessionId, previousStamp) {
      if (!promote) return undefined;
      return {
        rows: [rowOf('p_1', 'from the fallback')],
        stamp: { fallback: true },
        readOnly: false,
        needsPromotion: true,
        source: 'fallback'
      };
    }
  });
  const layers = new LayerRegistry({ contract, store });
  assert.equal(layers.sectionText('s1'), 'from the fallback', 'the fallback is served immediately');
  await settle();
  await settle();
  assert.equal(store.calls.writes.length, 1, 'the move-in is a normal store write');
  assert.deepEqual(store.calls.writes[0].rows, [rowOf('p_1', 'from the fallback')]);

  // The move-in is rate limited: another promotion request within 30s is skipped.
  promote = true;
  layers.snapshot('s1');
  await settle();
  await settle();
  assert.equal(store.calls.writes.length, 1, 'one move-in attempt per session per 30s');
});

test('layers: concurrent mutations are serialized so nothing is lost', async () => {
  const store = fakeStore();
  const layers = new LayerRegistry({ contract, store });
  await Promise.all([layers.add('s1', layerOf('p_1', 'one')), layers.add('s1', layerOf('p_2', 'two'))]);
  assert.deepEqual(layers.snapshot('s1').layers.map((layer) => layer.promptId), ['p_1', 'p_2']);
  assert.deepEqual(store.state.get('s1').rows.map((row) => row.promptId), ['p_1', 'p_2']);
  assert.equal(store.calls.writes.length, 2);
});

test('layers: a registry over the real session store persists and reloads per session (AC-1/AC-4)', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-library-layers-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const sessionId of ['session-a', 'session-b']) await mkdir(join(home, 'sessions', 'project-alpha', sessionId), { recursive: true });
  const store = new LayerStore({ contract, env: { DSH_HOME: home }, home });

  const first = new LayerRegistry({ contract, store });
  await first.add('session-a', layerOf('p_1', 'alpha body'));
  await first.add('session-b', layerOf('p_2', 'beta body'));
  assert.equal(first.sectionText('session-a'), 'alpha body');
  assert.equal(first.sectionText('session-b'), 'beta body');

  // A fresh registry is what a restarted DSH builds.
  const restarted = new LayerRegistry({ contract, store: new LayerStore({ contract, env: { DSH_HOME: home }, home }) });
  assert.equal(restarted.sectionText('session-a'), 'alpha body');
  assert.equal(restarted.sectionText('session-b'), 'beta body');
  assert.deepEqual(restarted.snapshot('session-a').layers.map((layer) => layer.promptId), ['p_1']);
  assert.deepEqual(restarted.snapshot('session-b').layers.map((layer) => layer.promptId), ['p_2']);

  // The user's off switch is a persisted empty state, so it stays off.
  await restarted.remove('session-a', 'p_1');
  const afterRemoval = new LayerRegistry({ contract, store: new LayerStore({ contract, env: { DSH_HOME: home }, home }) });
  assert.equal(afterRemoval.sectionText('session-a'), '');
  assert.equal(afterRemoval.sectionText('session-b'), 'beta body');
});

// ------------------------------------- AC-8 end to end, concurrency, logs ----

test('layers: AC-8 end to end: fallback write, folder appears, registry moves the file in', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-library-promote-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fallbackDir = join(home, 'prompt-library', 'sessions');
  const sessionDir = join(home, 'sessions', 'project-alpha', 'session-a');
  const layers = new LayerRegistry({ contract, store: new LayerStore({ contract, env: { DSH_HOME: home }, home }) });

  await layers.add('session-a', layerOf('p_1', 'written before the folder exists'));
  assert.deepEqual((await readdir(fallbackDir)).sort(), ['session-a.json'], 'the fallback holds the layer while the folder is missing');
  assert.equal(existsSync(sessionDir), false, 'the store never invents a session directory');
  assert.equal(layers.sectionText('session-a'), 'written before the folder exists', 'the fallback is served immediately');

  // The platform creates the session folder (first message). No user write.
  await mkdir(sessionDir, { recursive: true });
  assert.equal(layers.sectionText('session-a'), 'written before the folder exists', 'the read still serves the fallback');
  await until(async () => (await readdir(fallbackDir)).length === 0, 'the registry to move the fallback in');

  assert.deepEqual((await readdir(sessionDir)).sort(), [LAYER_FILE_NAME], 'the session directory owns the layer file now');
  const onDisk = JSON.parse(await readFile(join(sessionDir, LAYER_FILE_NAME), 'utf8'));
  assert.equal(onDisk.sessionId, 'session-a');
  assert.deepEqual(onDisk.layers.map((entry) => entry.promptId), ['p_1']);

  // A fresh registry (a restart) reads it from the session folder.
  const restarted = new LayerRegistry({ contract, store: new LayerStore({ contract, env: { DSH_HOME: home }, home }) });
  assert.equal(restarted.sectionText('session-a'), 'written before the folder exists');
});

test('layers: concurrent mutations never overlap a store write (serial queue)', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const store = fakeStore({
    async write() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return undefined; // fall through to the fake's normal write
    }
  });
  const layers = new LayerRegistry({ contract, store });

  await Promise.all([
    layers.add('s1', layerOf('p_1', 'one')),
    layers.add('s1', layerOf('p_2', 'two')),
    layers.add('s1', layerOf('p_3', 'three')),
    layers.remove('s1', 'p_1'),
    layers.clear('s1'),
    layers.add('s1', layerOf('p_9', 'nine'))
  ]);

  assert.equal(maxInFlight, 1, 'exactly one store write is in flight at a time');
  assert.equal(store.calls.writes.length, 6, 'every mutation was persisted exactly once');
  assert.deepEqual(layers.snapshot('s1').layers.map((layer) => layer.promptId), ['p_9']);
  assert.deepEqual(store.state.get('s1').rows.map((row) => row.promptId), ['p_9'], 'memory and disk agree');
});

test('layers: a concurrent burst never leaves a half-written layer file', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-library-burst-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, 'sessions', 'project-alpha', 'session-a');
  await mkdir(dir, { recursive: true });
  const layers = new LayerRegistry({ contract, store: new LayerStore({ contract, env: { DSH_HOME: home }, home }) });

  // Six concurrent adds, but a session caps at three: the extra three are
  // refused and the file must still be a complete, parseable three-row state.
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5, 6].map((n) => layers.add('session-a', layerOf('p_' + n, 'body ' + n)))
  );
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 3);
  assert.deepEqual(
    results.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason.code),
    [LAYER_LIMIT_CODE, LAYER_LIMIT_CODE, LAYER_LIMIT_CODE]
  );
  const names = (await readdir(dir)).sort();
  assert.equal(names.includes(LAYER_FILE_NAME + '.tmp'), false, 'no .tmp survives the burst');
  const onDisk = JSON.parse(await readFile(join(dir, LAYER_FILE_NAME), 'utf8'));
  assert.deepEqual(onDisk.layers.map((entry) => entry.promptId), ['p_1', 'p_2', 'p_3'], 'the file is a complete, ordered state');
  assert.deepEqual(layers.snapshot('session-a').layers.map((layer) => layer.promptId), ['p_1', 'p_2', 'p_3']);

  // A mixed batch (remove / update / re-add) is serialized the same way: every
  // intermediate file is the full next version, never a fragment.
  await Promise.allSettled([
    layers.remove('session-a', 'p_2'),
    layers.add('session-a', layerOf('p_1', 'updated body')),
    layers.add('session-a', layerOf('p_2', 'back again'))
  ]);
  const mixed = JSON.parse(await readFile(join(dir, LAYER_FILE_NAME), 'utf8'));
  assert.deepEqual(mixed.layers.map((entry) => entry.promptId), ['p_1', 'p_3', 'p_2'], 'a re-added row appends; nothing is lost');
  assert.equal(mixed.layers[0].body, 'updated body');
  assert.equal(mixed.layers[1].body, 'body 3');
  assert.equal(mixed.layers[2].body, 'back again');
  assert.deepEqual((await readdir(dir)).sort(), [LAYER_BACKUP_FILE_NAME, LAYER_FILE_NAME], 'only the main file and its backup remain');
});

test('layers: a failed persist is logged with the session id and code, never the body', async () => {
  const store = fakeStore({
    write() {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
  });
  const layers = new LayerRegistry({ contract, store });
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(
      layers.add('s1', layerOf('p_1', 'SECRET-BODY-MARKER')),
      (error) => error.code === LAYER_PERSIST_CODE
    );
  } finally {
    console.error = original;
  }

  assert.equal(logged.length, 1, 'one host log line per failed write');
  assert.match(String(logged[0][0]), /layer persist failed/u);
  assert.equal(String(logged[0][1]), 's1', 'the log carries the session id');
  assert.equal(String(logged[0][2]), 'ENOSPC', 'the log carries the underlying error code');
  assert.match(String(logged[0][3]), /disk full/u, 'the log carries the underlying message');
  assert.equal(JSON.stringify(logged).includes('SECRET-BODY-MARKER'), false, 'the log never carries a layer body');
});

