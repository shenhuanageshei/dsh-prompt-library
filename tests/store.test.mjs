/**
 * PromptStore (src/host/store.ts -> lib/host/store.js):
 *   - missing file -> empty library, no file created;
 *   - corrupt file -> renamed to prompts.corrupt-<stamp>.json, empty library, boot continues;
 *   - atomic write (temp + rename, no .tmp left behind) plus prompts.bak.json;
 *   - serialized read-modify-write queue;
 *   - fail-closed validation before touching the disk;
 *   - unknown library version -> read-only, never overwritten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadZod } from './_zod.mjs';
import { defineContract } from '../lib/contract.js';
import {
  LIBRARY_FILE,
  LIBRARY_VERSION,
  MAX_CORRUPT_BACKUPS,
  PromptStore,
  createPromptId,
  emptyLibrary,
  parseLibraryText,
  resolveLibraryPath
} from '../lib/host/store.js';

const z = await loadZod();
const contract = defineContract(z);

/** One valid prompt row. */
function promptOf(id, overrides = {}) {
  return {
    id,
    title: 'title-' + id,
    body: 'body-' + id,
    tags: ['tag'],
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    ...overrides
  };
}

/** Fresh temp directory + store; cleaned up by the test runner. */
async function makeStore(t, name = 'library') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-prompt-library-' + name + '-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, LIBRARY_FILE);
  return { dir, filePath, store: new PromptStore({ filePath, contract }) };
}

test('store: resolveLibraryPath uses DSH_HOME then falls back to <home>/.dsh', () => {
  assert.equal(resolveLibraryPath({ DSH_HOME: 'C:/dsh' }, 'C:/home'), join('C:/dsh', 'prompt-library', 'prompts.json'));
  assert.equal(resolveLibraryPath({}, 'C:/home'), join('C:/home', '.dsh', 'prompt-library', 'prompts.json'));
  assert.equal(resolveLibraryPath({ DSH_HOME: '   ' }, 'C:/home'), join('C:/home', '.dsh', 'prompt-library', 'prompts.json'));
});

test('store: emptyLibrary and createPromptId mint the documented shapes', () => {
  assert.deepEqual(emptyLibrary(), { version: LIBRARY_VERSION, updatedAt: null, prompts: [] });
  const first = createPromptId();
  const second = createPromptId();
  assert.match(first, /^p_[0-9a-z]+[0-9a-f]{10}$/u);
  assert.notEqual(first, second);
});

test('store: a missing file loads as an empty library and writes nothing', async (t) => {
  const { dir, store } = await makeStore(t, 'missing');
  const state = await store.load();
  assert.deepEqual(state.library, { version: LIBRARY_VERSION, updatedAt: null, prompts: [] });
  assert.equal(state.corruptBackup, null);
  assert.equal(state.readOnly, false);
  assert.equal(state.notice, null);
  assert.deepEqual(await readdir(dir), []);
});

test('store: a corrupt file is quarantined, not fatal, and the library starts empty', async (t) => {
  const { dir, filePath, store } = await makeStore(t, 'corrupt');
  const corrupt = '{"version": 1, "prompts": [';
  await writeFile(filePath, corrupt, 'utf8');
  const state = await store.load();
  assert.deepEqual(state.library.prompts, []);
  assert.equal(state.notice, 'library-corrupt');
  assert.equal(typeof state.corruptBackup, 'string');
  assert.match(state.corruptBackup, /prompts\.corrupt-.*\.json$/u);
  assert.equal(await readFile(state.corruptBackup, 'utf8'), corrupt);
  const names = await readdir(dir);
  assert.ok(!names.includes(LIBRARY_FILE), 'the corrupt file must be moved out of the way');
  assert.ok(names.includes(state.corruptBackup.split(/[\\/]/u).pop()));
});

test('store: at most five quarantine files are kept', async (t) => {
  const { dir, filePath, store } = await makeStore(t, 'quarantine');
  for (let index = 0; index < MAX_CORRUPT_BACKUPS + 1; index += 1) {
    await writeFile(join(dir, 'prompts.corrupt-2020-01-0' + index + 'T00-00-00-000Z.json'), '{}', 'utf8');
  }
  await writeFile(filePath, 'not json', 'utf8');
  await store.load();
  const quarantine = (await readdir(dir)).filter((name) => /^prompts\.corrupt-.*\.json$/u.test(name));
  assert.equal(quarantine.length, MAX_CORRUPT_BACKUPS);
});

test('store: the first write is atomic and leaves no .tmp behind', async (t) => {
  const { dir, filePath, store } = await makeStore(t, 'atomic');
  const outcome = await store.update((library) => ({ library: { ...library, prompts: [promptOf('p_1')] }, value: 'p_1' }));
  assert.equal(outcome.value, 'p_1');
  assert.equal(outcome.library.prompts.length, 1);
  const raw = await readFile(filePath, 'utf8');
  const payload = JSON.parse(raw);
  assert.equal(payload.version, LIBRARY_VERSION);
  assert.equal(typeof payload.updatedAt, 'string');
  assert.equal(Number.isNaN(Date.parse(payload.updatedAt)), false);
  assert.deepEqual(payload.prompts.map((prompt) => prompt.id), ['p_1']);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  assert.ok(!(await readdir(dir)).includes('prompts.bak.json'), 'no backup exists before a second write');
});

test('store: every write first copies the previous file to prompts.bak.json', async (t) => {
  const { dir, filePath, store } = await makeStore(t, 'backup');
  await store.update((library) => ({ library: { ...library, prompts: [promptOf('p_1')] } }));
  const firstPayload = JSON.parse(await readFile(filePath, 'utf8'));
  await store.update((library) => ({ library: { ...library, prompts: [...library.prompts, promptOf('p_2')] } }));
  const backupPath = join(dir, 'prompts.bak.json');
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.deepEqual(backup.prompts.map((prompt) => prompt.id), ['p_1']);
  assert.deepEqual(backup.prompts, firstPayload.prompts);
  const current = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(current.prompts.map((prompt) => prompt.id), ['p_1', 'p_2']);
});

test('store: concurrent updates are serialized, never interleaved', async (t) => {
  const { filePath, store } = await makeStore(t, 'concurrent');
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      store.update((library) => ({ library: { ...library, prompts: [...library.prompts, promptOf('p_' + index)] } }))
    )
  );
  const payload = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(payload.prompts.map((prompt) => prompt.id).sort(), ['p_0', 'p_1', 'p_2', 'p_3', 'p_4']);
});

test('store: an invalid prompt is refused before the disk is touched', async (t) => {
  const { filePath, store } = await makeStore(t, 'invalid');
  await store.update((library) => ({ library: { ...library, prompts: [promptOf('p_1')] } }));
  const before = await readFile(filePath, 'utf8');
  await assert.rejects(
    store.update(() => ({ library: { version: LIBRARY_VERSION, updatedAt: null, prompts: [promptOf('p_bad', { title: '' })] } })),
    /refusing to write an invalid prompt/u
  );
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('store: an unknown version is served read-only and never overwritten', async (t) => {
  const { filePath, store } = await makeStore(t, 'readonly');
  const seed = { version: 99, updatedAt: '2026-10-27T00:00:00.000Z', prompts: [promptOf('p_1')] };
  const raw = JSON.stringify(seed, null, 2);
  await writeFile(filePath, raw, 'utf8');
  const state = await store.load();
  assert.equal(state.readOnly, true);
  assert.equal(state.notice, 'library-version-unknown');
  assert.deepEqual(state.library.prompts.map((prompt) => prompt.id), ['p_1']);
  await assert.rejects(store.update(() => ({ library: { prompts: [] } })), (error) => error.code === 'library-readonly');
  assert.equal(await readFile(filePath, 'utf8'), raw);
});

test('store: parseLibraryText reports unparsable roots without throwing', () => {
  assert.equal(parseLibraryText('not json', contract).ok, false);
  assert.equal(parseLibraryText('[]', contract).reason, 'unparsable');
  assert.equal(parseLibraryText('{"version": 1}', contract).reason, 'unparsable');
  const ok = parseLibraryText(JSON.stringify({ version: 1, updatedAt: null, prompts: [promptOf('p_1')] }), contract);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.library.prompts.map((prompt) => prompt.id), ['p_1']);
});

test('store: a library without a version loads as v1 and the next write normalizes it', async (t) => {
  const { filePath, store } = await makeStore(t, 'version-missing');
  await writeFile(filePath, JSON.stringify({ updatedAt: '2026-10-27T00:00:00.000Z', prompts: [promptOf('p_1')] }), 'utf8');
  const state = await store.load();
  assert.equal(state.readOnly, false, 'a missing version is a hand-edited v1 library, not an unknown version');
  assert.equal(state.notice, null);
  assert.deepEqual(state.library.prompts.map((prompt) => prompt.id), ['p_1']);
  await store.update((library) => ({ library: { ...library, prompts: [...library.prompts, promptOf('p_2')] } }));
  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(onDisk.version, LIBRARY_VERSION, 'the next write normalizes the file to version 1');
  assert.deepEqual(onDisk.prompts.map((prompt) => prompt.id), ['p_1', 'p_2']);
});

test('store: an explicit unknown or non-numeric version stays read-only', async (t) => {
  for (const version of [0, 2, 99, null, '1']) {
    const { filePath, store } = await makeStore(t, 'version-' + String(version));
    const raw = JSON.stringify({ version, prompts: [promptOf('p_1')] });
    await writeFile(filePath, raw, 'utf8');
    const state = await store.load();
    assert.equal(state.readOnly, true, 'version ' + JSON.stringify(version) + ' must stay read-only');
    await assert.rejects(store.update(() => ({ library: { prompts: [] } })), (error) => error.code === 'library-readonly');
    assert.equal(await readFile(filePath, 'utf8'), raw);
  }
});

