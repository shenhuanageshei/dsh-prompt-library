/**
 * Host service-layer coverage (code-review round 1 - finding #1).
 *
 * What this file pins down:
 *   - PromptLibraryService (src/host/service.ts -> lib/host/service.js):
 *     list / save (create, update, not-found, library-full, input-invalid,
 *     read-only) / removePrompt / the three importLibrary branches (replace,
 *     merge, all-or-nothing) / the layer delegation / the remoteFailure
 *     mapping;
 *   - mergeById (src/host/service.ts -> lib/host/service.js): replace-in-place
 *     and append order;
 *   - markRemoteMethods + REMOTE_METHODS: the eight @Remote markers the Host
 *     Gateway source-mode discovery reads;
 *   - buildManifest (src/host/typert.ts -> lib/host/typert.js): face, service,
 *     members, invocations;
 *   - parseImportText (src/host/store.ts -> lib/host/store.js): bad JSON,
 *     duplicate id, cap, repair;
 *   - resolveSectionOrder + apply wiring (src/index.ts -> lib/index.js): the
 *     derived section order, manifest registration, the section callback, and
 *     the layer lifetime (an agent teardown must NOT clear layers — live
 *     finding 1).
 *
 * LOADER STUB (why this file does not just import the service):
 * Both entry points under test are the BUILT lib, never the TypeScript source:
 * lib/host/service.js and lib/index.js are the compiled host output
 * (tsc -p tsconfig.build.json; tsdown owns the client half), and their relative
 * imports are the same ones the source declares. A data: URL module cannot
 * resolve a relative specifier, so the module text is loaded through a data:
 * URL whose specifiers are rewritten:
 *   - ./store.js -> the real lib/host/store.js module;
 *   - @deepseek-ai/dsh-typert-protocol -> the local protocol stub below
 *     (lib/host/service.js imports the bare package, which a source-only
 *     checkout cannot resolve — see README W1: no network install).
 * The stub mirrors the verified 0.2.1-rc.3 shapes of the three members the
 * service uses, read from
 * resources/app.asar!/dsh/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js:
 * RemoteError (code + details + the isDSHRemoteError marker),
 * TypertRemoteService (name + the typertRemote binding) and Remote(name) (a
 * method decorator that calls context.addInitializer, which marks
 * Object.getPrototypeOf(this) under the
 * '@deepseek-ai/dsh-typert-protocol/remote-methods' descriptor, version 1,
 * eliding exportName when it equals the method name).
 *
 * lib/index.js is loaded the same way (zod -> a stub re-exporting the loaded
 * namespace, ./host/service.js -> a recording stub, every other import kept
 * real) so its wiring is exercised against the real store/layers/typert
 * modules. The shared modules are imported from lib/ directly, like the other
 * host tests do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadZod } from './_zod.mjs';
import { defineContract } from '../lib/contract.js';
import { LIBRARY_FILE, LIBRARY_VERSION, PromptStore, parseImportText } from '../lib/host/store.js';
import { LayerRegistry } from '../lib/host/layers.js';
import { buildManifest } from '../lib/host/typert.js';
import { estimateTokens } from '../lib/shared/tokens.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const z = await loadZod();
const contract = defineContract(z);

/** Absolute file URL of one built module under lib/. */
function libUrl(...segments) {
  return pathToFileURL(join(ROOT, 'lib', ...segments)).href;
}

/** A data: URL module carrying the given script text (no relative specifiers). */
function dataUrl(source) {
  return 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
}

/**
 * Load one BUILT lib/ module through a data: URL with the given specifiers
 * rewritten. The built lib is the artifact under test (never a source
 * transpiled on the fly).
 * @param {string} relativePath - path under lib/.
 * @param {Record<string, string>} replacements - specifier -> replacement URL.
 * @returns {Promise<object>} the module namespace.
 */
async function loadBuilt(relativePath, replacements) {
  let text = await readFile(join(ROOT, 'lib', relativePath), 'utf8');
  for (const [specifier, target] of Object.entries(replacements)) {
    const needle = "'" + specifier + "'";
    assert.ok(text.includes(needle), 'the loader stub expects lib/' + relativePath + ' to import "' + specifier + '"');
    text = text.split(needle).join("'" + target + "'");
  }
  return import(dataUrl(text));
}

/** The local @deepseek-ai/dsh-typert-protocol stub (see the file header). */
const PROTOCOL_STUB = String.raw`
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const SEGMENT = /^[A-Za-z0-9_$.-]+$/;
export class RemoteError extends Error {
  isDSHRemoteError = true;
  constructor(code, message, details, options) {
    super(message, options);
    this.name = 'RemoteError';
    this.code = code;
    this.details = details;
  }
}
export class TypertRemoteService {
  constructor(ctx, serviceKey, options = {}) {
    this.ctx = ctx;
    this.name = serviceKey;
    this.typertRemote = Object.freeze({ service: this, serviceKey, namespace: options.namespace ?? serviceKey });
  }
}
export function readDescriptor(prototype) {
  const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
  if (property === undefined) return undefined;
  const descriptor = property.value;
  if (descriptor === null || typeof descriptor !== 'object') throw new TypeError('typert-protocol stub: Remote method descriptor must be an object');
  if (descriptor.version !== 1) throw new TypeError('typert-protocol stub: unsupported Remote method descriptor version ' + String(descriptor.version));
  if (!Array.isArray(descriptor.methods)) throw new TypeError('typert-protocol stub: Remote method descriptor methods must be an array');
  return descriptor;
}
export function remoteMethods(service) {
  const prototype = Object.getPrototypeOf(service);
  if (prototype === null) return [];
  return (readDescriptor(prototype)?.methods ?? []).map((marker) => ({ ...marker }));
}
function mark(prototype, method, invocation, options) {
  const descriptor = readDescriptor(prototype);
  const marker = Object.freeze({
    method,
    ...(options.exportName === undefined || options.exportName === method ? {} : { exportName: options.exportName }),
    invocation: Object.freeze(invocation)
  });
  const current = descriptor?.methods.find((candidate) => candidate.method === method);
  if (current !== undefined) {
    if (current.exportName === marker.exportName && current.invocation.kind === invocation.kind) return;
    throw new Error('typert-protocol stub: Remote method "' + method + '" has conflicting invocation markers');
  }
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze([...(descriptor?.methods ?? []), marker]) })
  });
}
function addMarkerInitializer(context, invocation, options) {
  if (context.private || context.static || typeof context.name !== 'string') {
    throw new TypeError('typert-protocol stub: Remote decorators require a public instance method with a string name');
  }
  const method = context.name;
  context.addInitializer(function () {
    const prototype = Object.getPrototypeOf(this);
    if (prototype === null) throw new TypeError('typert-protocol stub: cannot mark Remote method "' + method + '" on an object without a prototype');
    mark(prototype, method, invocation, options);
  });
}
export function Remote(nameOrOptions, context) {
  if (typeof nameOrOptions === 'string') {
    if (nameOrOptions === '.' || nameOrOptions === '..' || !SEGMENT.test(nameOrOptions)) {
      throw new TypeError('typert-protocol stub: Remote export name must contain only RPC endpoint segment characters');
    }
    return function (_method, decoratorContext) {
      addMarkerInitializer(decoratorContext, { kind: 'direct' }, { exportName: nameOrOptions });
    };
  }
  if (nameOrOptions !== null && typeof nameOrOptions === 'object') {
    return function (_method, decoratorContext) {
      addMarkerInitializer(decoratorContext, { kind: 'direct' }, {});
    };
  }
  throw new TypeError('typert-protocol stub: Remote decorator context is missing');
}
`;

/** Recording stand-in for lib/host/service.js, used by the lib/index.js wiring tests. */
const SERVICE_STUB = String.raw`
export class PromptLibraryService {
  static instances = [];
  constructor(ctx, deps) {
    this.ctx = ctx;
    this.store = deps.store;
    this.layers = deps.layers;
    this.contract = deps.contract;
    PromptLibraryService.instances.push(this);
  }
}
`;

const protocolStubUrl = dataUrl(PROTOCOL_STUB);
const protocol = await import(protocolStubUrl);

const serviceModule = await loadBuilt('host/service.js', {
  '@deepseek-ai/dsh-typert-protocol': protocolStubUrl,
  './store.js': libUrl('host', 'store.js')
});
const { PromptLibraryService, REMOTE_METHODS, markRemoteMethods, mergeById } = serviceModule;

const serviceStubUrl = dataUrl(SERVICE_STUB);
const serviceStub = await import(serviceStubUrl);

/** One valid library prompt. */
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

/** A fresh library file (optionally seeded with prompts) plus a service over it. */
async function makeService(t, name, prompts) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-prompt-library-service-' + name + '-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, LIBRARY_FILE);
  if (prompts !== undefined) {
    await writeFile(
      filePath,
      JSON.stringify({ version: LIBRARY_VERSION, updatedAt: '2026-10-27T00:00:00.000Z', prompts }, null, 2),
      'utf8'
    );
  }
  const store = new PromptStore({ filePath, contract });
  const layers = new LayerRegistry({ contract });
  const service = new PromptLibraryService({}, { store, layers, contract });
  return { dir, filePath, store, layers, service };
}

/** A store stub whose every write path rejects with the same value. */
function failingStore(rejection) {
  const fail = () => Promise.reject(rejection);
  return { filePath: 'C:/dsh/prompt-library/prompts.json', load: fail, update: fail, replaceAll: fail };
}

/** A service whose store is a hand-written stub. */
function makeServiceOverStore(store) {
  return new PromptLibraryService({}, { store, layers: new LayerRegistry({ contract }), contract });
}

/** Assert the wire snapshot shape and the prompt ids it holds. */
function assertSnapshot(snapshot, ids) {
  assert.equal(contract.librarySnapshotSchema.safeParse(snapshot).success, true, 'the snapshot must satisfy the wire schema');
  assert.deepEqual(snapshot.prompts.map((prompt) => prompt.id), ids);
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.corruptBackup, null);
  assert.equal(snapshot.notice, null);
  assert.equal(typeof snapshot.filePath, 'string');
}

/** Matcher for a wire RemoteError with the given code. */
function wireError(code, message) {
  return (error) => {
    assert.equal(error.name, 'RemoteError');
    assert.equal(error.isDSHRemoteError, true);
    assert.equal(error.code, code);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  };
}

// ------------------------------------------------------------------ list ----

test('service: list of a missing library is an empty, schema-valid snapshot', async (t) => {
  const { filePath, service } = await makeService(t, 'list-missing');
  const snapshot = await service.list();
  assertSnapshot(snapshot, []);
  assert.equal(snapshot.updatedAt, null);
  assert.equal(snapshot.filePath, filePath);
});

test('service: list reports a quarantined corrupt file on the snapshot', async (t) => {
  const { dir, filePath, service } = await makeService(t, 'list-corrupt');
  await writeFile(filePath, '{"version": 1, "prompts": [', 'utf8');
  const snapshot = await service.list();
  assert.deepEqual(snapshot.prompts, []);
  assert.equal(contract.librarySnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(snapshot.notice, 'library-corrupt');
  assert.match(snapshot.corruptBackup, /prompts\.corrupt-.*\.json$/u);
  const names = await readdir(dir);
  assert.ok(names.includes(snapshot.corruptBackup.split(/[\\/]/u).pop()), 'the bad file is moved aside, not deleted');
  assert.ok(!names.includes(LIBRARY_FILE));
});

test('service: list reports a newer library version as read-only', async (t) => {
  const { filePath, service } = await makeService(t, 'list-readonly');
  await writeFile(filePath, JSON.stringify({ version: 99, prompts: [promptOf('p_1')] }), 'utf8');
  const snapshot = await service.list();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.notice, 'library-version-unknown');
  assert.deepEqual(snapshot.prompts.map((prompt) => prompt.id), ['p_1']);
});

// ------------------------------------------------------------------ save ----

test('service: save create mints an id and stamps both timestamps', async (t) => {
  const { filePath, service } = await makeService(t, 'save-create');
  const snapshot = await service.save({ title: 'Limit-test waiver', body: '\u6b63\u6587', tags: ['\u6388\u6743'] });
  assert.equal(snapshot.prompts.length, 1);
  assert.equal(contract.librarySnapshotSchema.safeParse(snapshot).success, true);
  const created = snapshot.prompts[0];
  assert.match(created.id, /^p_[0-9a-z]+[0-9a-f]{10}$/u);
  assert.equal(created.title, 'Limit-test waiver');
  assert.equal(created.body, '\u6b63\u6587');
  assert.deepEqual(created.tags, ['\u6388\u6743']);
  assert.equal(created.createdAt, created.updatedAt);
  assert.equal(Number.isNaN(Date.parse(created.createdAt)), false);
  assert.equal(typeof snapshot.updatedAt, 'string');
  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(onDisk.version, LIBRARY_VERSION);
  assert.deepEqual(onDisk.prompts.map((prompt) => prompt.id), [created.id]);
});

test('service: save update keeps id and createdAt and replaces the content', async (t) => {
  const first = promptOf('p_1');
  const { service } = await makeService(t, 'save-update', [first]);
  const snapshot = await service.save({ id: 'p_1', title: 'new title', body: 'new body', tags: ['a', 'b'] });
  assertSnapshot(snapshot, ['p_1']);
  const updated = snapshot.prompts[0];
  assert.equal(updated.title, 'new title');
  assert.equal(updated.body, 'new body');
  assert.deepEqual(updated.tags, ['a', 'b']);
  assert.equal(updated.createdAt, first.createdAt);
  assert.notEqual(updated.updatedAt, first.updatedAt);
  assert.equal(Number.isNaN(Date.parse(updated.updatedAt)), false);
});

test('service: save update on an unknown id rejects not-found and writes nothing', async (t) => {
  const { filePath, service } = await makeService(t, 'save-not-found', [promptOf('p_1')]);
  const before = await readFile(filePath, 'utf8');
  await assert.rejects(service.save({ id: 'p_missing', title: 't', body: 'b', tags: [] }), wireError('not-found', /p_missing/u));
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('service: save create at the 200-prompt cap rejects library-full and writes nothing', async (t) => {
  const full = Array.from({ length: contract.LIMITS.prompts }, (_, index) => promptOf('p_' + index));
  const { filePath, service } = await makeService(t, 'save-full', full);
  const before = await readFile(filePath, 'utf8');
  await assert.rejects(service.save({ title: 'one more', body: 'body', tags: [] }), wireError('library-full', /full/u));
  assert.equal(await readFile(filePath, 'utf8'), before);
  assert.equal((await service.list()).prompts.length, contract.LIMITS.prompts);
});

test('service: save rejects malformed input with input-invalid', async (t) => {
  const { filePath, service } = await makeService(t, 'save-invalid');
  await assert.rejects(service.save({ title: '', body: 'b', tags: [] }), wireError('input-invalid'));
  await assert.rejects(service.save({ title: 't', body: 'b', tags: [], extra: true }), wireError('input-invalid'));
  await assert.rejects(
    service.save({ title: 'x'.repeat(contract.LIMITS.title + 1), body: 'b', tags: [] }),
    wireError('input-invalid')
  );
  assert.equal(await readFile(filePath, 'utf8').catch(() => null), null, 'a rejected input must never reach the disk');
});

test('service: save on a read-only library rejects library-readonly', async (t) => {
  const { filePath, service } = await makeService(t, 'save-readonly');
  const raw = JSON.stringify({ version: 99, prompts: [promptOf('p_1')] });
  await writeFile(filePath, raw, 'utf8');
  await assert.rejects(service.save({ title: 't', body: 'b', tags: [] }), wireError('library-readonly'));
  assert.equal(await readFile(filePath, 'utf8'), raw);
});

// ---------------------------------------------------------- removePrompt ----

test('service: removePrompt drops one prompt and returns the remaining snapshot', async (t) => {
  const { service } = await makeService(t, 'removePrompt', [promptOf('p_1'), promptOf('p_2')]);
  const snapshot = await service.removePrompt('p_1');
  assertSnapshot(snapshot, ['p_2']);
});

test('service: removePrompt on an unknown id rejects not-found and keeps the file', async (t) => {
  const { filePath, service } = await makeService(t, 'remove-not-found', [promptOf('p_1')]);
  const before = await readFile(filePath, 'utf8');
  await assert.rejects(service.removePrompt('p_missing'), wireError('not-found', /p_missing/u));
  assert.equal(await readFile(filePath, 'utf8'), before);
});

// --------------------------------------------------------- importLibrary ----

test('service: importLibrary replace overwrites the whole library', async (t) => {
  const { filePath, service } = await makeService(t, 'import-replace', [promptOf('p_1'), promptOf('p_2')]);
  const result = await service.importLibrary({ mode: 'replace', text: JSON.stringify([promptOf('p_9')]) });
  assert.deepEqual({ ...result }, { imported: 1, replaced: true });
  assert.equal(contract.importResultSchema.safeParse(result).success, true);
  assertSnapshot(await service.list(), ['p_9']);
  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(onDisk.prompts.map((prompt) => prompt.id), ['p_9']);
});

test('service: importLibrary replace accepts an empty batch and empties the library', async (t) => {
  const { service } = await makeService(t, 'import-replace-empty', [promptOf('p_1')]);
  const result = await service.importLibrary({ mode: 'replace', text: '[]' });
  assert.deepEqual({ ...result }, { imported: 0, replaced: true });
  assertSnapshot(await service.list(), []);
});

test('service: importLibrary merge replaces by id in place and appends new ids', async (t) => {
  const { service } = await makeService(t, 'import-merge', [promptOf('p_1'), promptOf('p_2')]);
  const imported = [promptOf('p_1', { title: 'imported title', body: 'imported body' }), promptOf('p_3')];
  const result = await service.importLibrary({ mode: 'merge', text: JSON.stringify(imported) });
  assert.deepEqual({ ...result }, { imported: 2, replaced: false });
  const snapshot = await service.list();
  assertSnapshot(snapshot, ['p_1', 'p_2', 'p_3']);
  assert.equal(snapshot.prompts[0].title, 'imported title');
  assert.equal(snapshot.prompts[0].body, 'imported body');
  assert.equal(snapshot.prompts[1].title, 'title-p_2', 'an id the batch does not name keeps its row');
});

test('service: importLibrary merge past the cap rejects library-full and writes nothing', async (t) => {
  const full = Array.from({ length: contract.LIMITS.prompts }, (_, index) => promptOf('p_' + index));
  const { filePath, service } = await makeService(t, 'import-full', full);
  const before = await readFile(filePath, 'utf8');
  await assert.rejects(
    service.importLibrary({ mode: 'merge', text: JSON.stringify([promptOf('p_extra')]) }),
    wireError('library-full', /more than 200/u)
  );
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('service: importLibrary is all-or-nothing (one invalid entry rejects the batch)', async (t) => {
  const { filePath, service } = await makeService(t, 'import-atomic', [promptOf('p_1')]);
  const before = await readFile(filePath, 'utf8');
  const text = JSON.stringify([promptOf('p_2'), promptOf('p_3', { title: '' })]);
  await assert.rejects(service.importLibrary({ mode: 'merge', text }), (error) => {
    assert.equal(error.code, 'import-invalid');
    assert.equal(error.details.invalid, 1);
    assert.match(error.message, /1 entr/u);
    return true;
  });
  assert.equal(await readFile(filePath, 'utf8'), before, 'a rejected batch must not touch the library');
});

test('service: importLibrary rejects text that is not JSON', async (t) => {
  const { service } = await makeService(t, 'import-bad-json');
  await assert.rejects(service.importLibrary({ mode: 'merge', text: 'not json' }), (error) => {
    assert.equal(error.code, 'import-invalid');
    assert.equal(error.details.invalid, 0);
    assert.match(error.message, /not valid JSON/u);
    return true;
  });
});

test('service: importLibrary rejects an unknown mode with input-invalid', async (t) => {
  const { service } = await makeService(t, 'import-mode');
  await assert.rejects(service.importLibrary({ mode: 'append', text: '[]' }), wireError('input-invalid'));
});

test('service: importLibrary replace uses PromptStore.replaceAll (one implementation)', async () => {
  const calls = [];
  const store = {
    filePath: 'C:/dsh/prompt-library/prompts.json',
    update: () => {
      calls.push('update');
      return Promise.resolve({ library: { prompts: [] }, state: {}, value: undefined });
    },
    replaceAll: (prompts) => {
      calls.push('replaceAll:' + prompts.length);
      return Promise.resolve({ version: LIBRARY_VERSION, updatedAt: null, prompts });
    }
  };
  const service = makeServiceOverStore(store);
  const result = await service.importLibrary({ mode: 'replace', text: JSON.stringify([promptOf('p_9')]) });
  assert.deepEqual(calls, ['replaceAll:1'], 'replace goes through the single replaceAll implementation');
  assert.deepEqual({ ...result }, { imported: 1, replaced: true });
});

test('service: importLibrary merge keeps the serialized update path and never replaces', async () => {
  const calls = [];
  const store = {
    filePath: 'C:/dsh/prompt-library/prompts.json',
    update: (mutator) => {
      calls.push('update');
      const outcome = mutator({ version: LIBRARY_VERSION, updatedAt: null, prompts: [promptOf('p_1')] });
      return Promise.resolve({ library: outcome.library, state: {}, value: outcome.value });
    },
    replaceAll: () => {
      calls.push('replaceAll');
      return Promise.resolve({ version: LIBRARY_VERSION, updatedAt: null, prompts: [] });
    }
  };
  const service = makeServiceOverStore(store);
  const result = await service.importLibrary({ mode: 'merge', text: JSON.stringify([promptOf('p_2')]) });
  assert.deepEqual(calls, ['update'], 'merge must not touch the replace branch');
  assert.deepEqual({ ...result }, { imported: 1, replaced: false });
});

// ---------------------------------------------------------- remoteFailure ----

test('service: a plain Error maps to internal and keeps its message', async () => {
  const service = makeServiceOverStore(failingStore(new Error('disk exploded')));
  await assert.rejects(service.save({ title: 't', body: 'b', tags: [] }), (error) => {
    assert.equal(error.code, 'internal');
    assert.equal(error.message, 'disk exploded');
    assert.equal(error.isDSHRemoteError, true);
    return true;
  });
});

test('service: an error carrying a code passes that code through', async () => {
  const service = makeServiceOverStore(failingStore(Object.assign(new Error('access denied'), { code: 'EACCES' })));
  await assert.rejects(service.removePrompt('p_1'), (error) => {
    assert.equal(error.code, 'EACCES');
    assert.equal(error.message, 'access denied');
    return true;
  });
});

test('service: a non-Error rejection uses the per-call fallback sentence', async () => {
  const service = makeServiceOverStore(failingStore('boom'));
  await assert.rejects(service.save({ title: 't', body: 'b', tags: [] }), (error) => {
    assert.equal(error.code, 'internal');
    assert.equal(error.message, 'save failed');
    return true;
  });
  await assert.rejects(service.removePrompt('p_1'), (error) => {
    assert.equal(error.message, 'remove failed');
    return true;
  });
  await assert.rejects(service.importLibrary({ mode: 'replace', text: '[]' }), (error) => {
    assert.equal(error.message, 'import failed');
    return true;
  });
});

test('service: an existing RemoteError passes through untouched', async () => {
  const original = new protocol.RemoteError('custom', 'already wire', { reason: 'test' });
  const service = makeServiceOverStore(failingStore(original));
  await assert.rejects(service.save({ title: 't', body: 'b', tags: [] }), (error) => {
    assert.equal(error, original, 'a wire error must not be re-wrapped');
    assert.equal(error.code, 'custom');
    return true;
  });
});

// ---------------------------------------------------------------- layers ----

test('service: layer calls delegate to the registry and keep the wire shape', async (t) => {
  const { service } = await makeService(t, 'layers');
  const empty = await service.layers('s1');
  assert.deepEqual({ ...empty }, { layers: [], totalTokens: 0, limit: contract.LIMITS.layers });
  const one = await service.addLayer('s1', { promptId: 'p_1', title: 'title', body: '\u4e2d\u6587' });
  assert.equal(one.layers.length, 1);
  assert.equal(one.totalTokens, estimateTokens('\u4e2d\u6587'));
  assert.equal(contract.layerSnapshotSchema.safeParse(one).success, true);
  const updated = await service.addLayer('s1', { promptId: 'p_1', title: 'new title', body: 'new' });
  assert.equal(updated.layers.length, 1, 'the same promptId updates in place');
  assert.equal(updated.layers[0].title, 'new title');
  assert.equal((await service.layers('s2')).layers.length, 0, 'sessions stay isolated');
  assert.deepEqual((await service.removeLayer('s1', 'p_1')).layers, []);
  await service.addLayer('s1', { promptId: 'p_2', title: 't', body: 'b' });
  assert.deepEqual((await service.clearLayers('s1')).layers, []);
});

test('service: a fourth layer maps to layer-limit through remoteFailure', async (t) => {
  const { service } = await makeService(t, 'layers-limit');
  for (const id of ['p_1', 'p_2', 'p_3']) await service.addLayer('s1', { promptId: id, title: id, body: id });
  await assert.rejects(
    service.addLayer('s1', { promptId: 'p_4', title: 'p_4', body: 'p_4' }),
    wireError('layer-limit', /at most 3/u)
  );
  assert.equal((await service.layers('s1')).layers.length, 3);
});

test('service: addLayer rejects malformed input with input-invalid', async (t) => {
  const { service } = await makeService(t, 'layers-invalid');
  await assert.rejects(service.addLayer('s1', { promptId: '', title: 't', body: 'b' }), wireError('input-invalid'));
  await assert.rejects(service.addLayer('s1', { promptId: 'p_1', title: 't', body: 'b', extra: 1 }), wireError('input-invalid'));
  assert.equal((await service.layers('s1')).layers.length, 0);
});

// --------------------------------------------------------------- markers ----

test('service: markRemoteMethods installs the eight direct markers on the prototype', async (t) => {
  assert.equal(Object.isFrozen(REMOTE_METHODS), true);
  assert.deepEqual([...REMOTE_METHODS], [
    'list',
    'save',
    'removePrompt',
    'importLibrary',
    'layers',
    'addLayer',
    'removeLayer',
    'clearLayers'
  ]);
  const { service } = await makeService(t, 'markers');
  const markers = protocol.remoteMethods(service);
  assert.deepEqual(markers.map((marker) => marker.method), [...REMOTE_METHODS]);
  for (const marker of markers) {
    assert.deepEqual({ ...marker.invocation }, { kind: 'direct' });
    assert.equal('exportName' in marker, false, 'a marker whose export name equals the method name omits it');
  }
  const descriptor = protocol.readDescriptor(Object.getPrototypeOf(service));
  assert.equal(descriptor.version, 1);
  assert.equal(Object.isFrozen(descriptor), true);
  markRemoteMethods(PromptLibraryService);
  assert.equal(protocol.remoteMethods(service).length, REMOTE_METHODS.length, 'marking twice is idempotent');
});

// ---------------------------------------------------------------- typert ----

test('typert: buildManifest declares the host face and one promptLibrary service', () => {
  const manifest = buildManifest(contract);
  assert.equal(manifest.package, 'dsh-prompt-library');
  assert.equal(manifest.face, 'host');
  assert.deepEqual(manifest.schemas, []);
  assert.equal(manifest.model.services.length, 1);
  assert.deepEqual(manifest.model.events, []);
  assert.deepEqual(manifest.model.objects, []);
  const service = manifest.model.services[0];
  assert.equal(service.key, 'promptLibrary');
  assert.equal(service.exportName, 'PromptLibraryService');
  assert.equal(typeof service.description, 'string');
  assert.deepEqual(service.tags, []);
  assert.deepEqual(service.types, []);
});

test('typert: buildManifest lists one member per wire method with a signature', () => {
  const members = buildManifest(contract).model.services[0].members;
  assert.equal(members.length, REMOTE_METHODS.length);
  assert.deepEqual(members.map((member) => member.name), [...REMOTE_METHODS]);
  for (const member of members) {
    assert.equal(member.kind, 'method');
    assert.ok(member.signature.startsWith(member.name + '('), member.name + ' signature must start with its name');
    assert.match(member.signature, /Promise</u);
  }
});

test('typert: buildManifest forwards the contract INVOCATIONS verbatim', () => {
  const manifest = buildManifest(contract);
  assert.equal(manifest.invocations, contract.INVOCATIONS);
  assert.deepEqual(manifest.invocations.map((entry) => entry.method), [...REMOTE_METHODS]);
  for (const entry of manifest.invocations) {
    assert.equal(entry.id, 'dsh-prompt-library#promptLibrary/' + entry.method);
  }
});

test('typert: buildManifest is deterministic for one contract', () => {
  assert.deepEqual(buildManifest(contract), buildManifest(contract));
});

// --------------------------------------------------------- parseImportText ----

test('store: parseImportText rejects text that is not JSON', () => {
  const outcome = parseImportText('{"prompts": [', contract);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.invalid, 0);
  assert.match(outcome.message, /^not valid JSON: /u);
});

test('store: parseImportText accepts a bare array and a library object, rejects anything else', () => {
  const fromArray = parseImportText(JSON.stringify([promptOf('p_1')]), contract);
  assert.equal(fromArray.ok, true);
  assert.deepEqual(fromArray.prompts.map((prompt) => prompt.id), ['p_1']);
  const fromLibrary = parseImportText(JSON.stringify({ version: 1, prompts: [promptOf('p_2')] }), contract);
  assert.equal(fromLibrary.ok, true);
  assert.deepEqual(fromLibrary.prompts.map((prompt) => prompt.id), ['p_2']);
  const fromObject = parseImportText(JSON.stringify({ version: 1 }), contract);
  assert.equal(fromObject.ok, false);
  assert.match(fromObject.message, /expected a prompt array/u);
  assert.equal(parseImportText('null', contract).ok, false);
});

test('store: parseImportText rejects duplicate ids in one batch', () => {
  const outcome = parseImportText(JSON.stringify([promptOf('p_1'), promptOf('p_1', { title: 'again' })]), contract);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.invalid, 1);
  assert.match(outcome.message, /1 entry failed validation/u);
});

test('store: parseImportText counts every invalid entry and rejects the batch', () => {
  // The third entry must be GENUINELY invalid: normalizeEntry filters blank tags
  // to [] (a valid value), so `tags: ['']` repaired into a valid prompt and the
  // test only ever saw one invalid entry. An empty title survives normalization
  // and fails promptSchema (z.string().min(1)).
  const text = JSON.stringify([promptOf('p_1'), promptOf('p_2', { body: '' }), promptOf('p_3', { title: '' })]);
  const outcome = parseImportText(text, contract);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.invalid, 2);
  assert.match(outcome.message, /2 entries failed validation/u);
  assert.equal(parseImportText('[]', contract).ok, true, 'an empty batch is legal');
});

test('store: parseImportText enforces the 200-prompt cap at the boundary', () => {
  const atCap = Array.from({ length: contract.LIMITS.prompts }, (_, index) => promptOf('p_' + index));
  assert.equal(parseImportText(JSON.stringify(atCap), contract).ok, true);
  const overCap = [...atCap, promptOf('p_extra')];
  const outcome = parseImportText(JSON.stringify(overCap), contract);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.invalid, contract.LIMITS.prompts + 1);
  assert.match(outcome.message, /more than 200 prompts/u);
});

test('store: parseImportText repairs a hand-edited entry (tags and timestamps)', () => {
  const now = 1700000000000;
  const outcome = parseImportText(JSON.stringify([{ id: 'p_1', title: 't', body: 'b' }]), contract, now);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.prompts[0], {
    id: 'p_1',
    title: 't',
    body: 'b',
    tags: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });
});

// -------------------------------------------------------------- mergeById ----

test('service: mergeById replaces in place and appends new ids at the end', () => {
  const existing = [promptOf('p_1', { body: 'old' }), promptOf('p_2')];
  const imported = [promptOf('p_3'), promptOf('p_1', { body: 'new' })];
  const merged = mergeById(existing, imported);
  assert.deepEqual(merged.map((prompt) => prompt.id), ['p_1', 'p_2', 'p_3']);
  assert.equal(merged[0], imported[1], 'the imported row is the row that lands (by reference)');
  assert.equal(merged[0].body, 'new');
  assert.equal(merged[1], existing[1]);
  assert.equal(merged[2], imported[0]);
});

test('service: mergeById never mutates the existing array', () => {
  const existing = [promptOf('p_1')];
  const merged = mergeById(existing, [promptOf('p_2')]);
  assert.notEqual(merged, existing);
  assert.deepEqual(existing.map((prompt) => prompt.id), ['p_1']);
  assert.equal(merged.length, 2);
});

test('service: mergeById with an empty import keeps the library order', () => {
  const existing = [promptOf('p_2'), promptOf('p_1')];
  const merged = mergeById(existing, []);
  assert.deepEqual(merged.map((prompt) => prompt.id), ['p_2', 'p_1']);
  assert.equal(merged[0], existing[0]);
});

// ---------------------------------------------------------- lib/index.js ----

const indexModule = await (async () => {
  globalThis.__promptLibraryZodForTest = z;
  try {
    return await loadBuilt('index.js', {
      zod: dataUrl('export const z = globalThis.__promptLibraryZodForTest;'),
      './contract.js': libUrl('contract.js'),
      './host/store.js': libUrl('host', 'store.js'),
      './host/layers.js': libUrl('host', 'layers.js'),
      './host/service.js': serviceStubUrl,
      './host/typert.js': libUrl('host', 'typert.js')
    });
  } finally {
    delete globalThis.__promptLibraryZodForTest;
  }
})();
const { SECTION_NAME, SECTION_ORDER_FALLBACK, SECTION_ORDER_OFFSET, apply, inject, name, resolveSectionOrder } = indexModule;

/** A stub cordis root context that records what apply() wires. */
function makeCtx(overrides = {}) {
  const state = { effects: [], sections: [], manifests: [], listeners: new Map(), disposed: 0 };
  const ctx = {
    effect(effect, label) {
      const dispose = effect();
      state.effects.push({ label, dispose });
      return dispose;
    },
    systemPrompt: {
      getSectionOrder: () => 10200,
      section(config) {
        state.sections.push(config);
        return () => {};
      }
    },
    typert: {
      register(manifest) {
        state.manifests.push(manifest);
        return () => {
          state.disposed += 1;
        };
      }
    },
    on(event, handler) {
      state.listeners.set(event, handler);
    }
  };
  return { ctx: { ...ctx, ...overrides }, state };
}

test('index: resolveSectionOrder derives the order from the platform table', () => {
  assert.equal(SECTION_NAME, 'prompt-library:session-layers');
  assert.equal(SECTION_ORDER_FALLBACK + SECTION_ORDER_OFFSET, 10500);
  assert.equal(resolveSectionOrder({ getSectionOrder: () => 10200 }), 10500);
  assert.equal(resolveSectionOrder({ getSectionOrder: () => 9000 }), 9300);
});

test('index: resolveSectionOrder falls back when the platform cannot answer', () => {
  assert.equal(resolveSectionOrder(undefined), 10500);
  assert.equal(resolveSectionOrder({}), 10500);
  assert.equal(resolveSectionOrder({ getSectionOrder: () => undefined }), 10500);
  assert.equal(resolveSectionOrder({ getSectionOrder: () => Number.NaN }), 10500);
  assert.equal(resolveSectionOrder({ getSectionOrder: () => Number.POSITIVE_INFINITY }), 10500);
  assert.equal(resolveSectionOrder({ getSectionOrder: () => '10200' }), 10500);
});

test('index: apply registers the manifest and the section, and no agent-teardown clear', () => {
  const { ctx, state } = makeCtx();
  const before = serviceStub.PromptLibraryService.instances.length;
  apply(ctx);
  assert.equal(name, 'dsh-prompt-library');
  assert.deepEqual([...inject], ['typert', 'systemPrompt']);
  assert.equal(state.manifests.length, 1);
  assert.equal(state.manifests[0].package, 'dsh-prompt-library');
  assert.equal(state.manifests[0].face, 'host');
  assert.equal(state.manifests[0].invocations.length, 8);
  assert.deepEqual(state.effects.map((effect) => effect.label), ['dsh-prompt-library: typert manifest']);
  assert.equal(state.sections.length, 1);
  const section = state.sections[0];
  assert.equal(section.name, SECTION_NAME);
  assert.equal(section.order, resolveSectionOrder(ctx.systemPrompt));
  assert.equal(section.interpolate, false);
  assert.equal(typeof section.text, 'function');
  // Live finding 1: DSH recreates the agent per turn/step and emits
  // 'agent/disposed' between a user's two messages, so a clear listener here
  // emptied the registry while the chips were still on screen. No listener may
  // be installed for it — and 'session/disposed' is the agent loop's per-run
  // detach, not a session close, so it is off limits too.
  assert.equal(state.listeners.has('agent/disposed'), false, 'no agent/disposed clear listener may be installed');
  assert.equal(state.listeners.has('session/disposed'), false, 'session/disposed is a per-run detach, not a close');
  assert.equal(state.listeners.size, 0, 'the host half installs no lifecycle listener at all');
  assert.equal(serviceStub.PromptLibraryService.instances.length, before + 1);
  const service = serviceStub.PromptLibraryService.instances.at(-1);
  assert.equal(service.ctx, ctx);
  assert.equal(service.contract.LIMITS.layers, 3);
  assert.equal(service.libraryPath, service.store.filePath);
  assert.match(service.store.filePath, /prompt-library[\\/]prompts\.json$/u);
});

test('index: the section text reads the live layer registry and a disposed agent keeps it', () => {
  const { ctx, state } = makeCtx();
  apply(ctx);
  const section = state.sections[0];
  const service = serviceStub.PromptLibraryService.instances.at(-1);
  // Emit one host event through the stub context: nothing is installed for the
  // agent-lifecycle events, so this is the production no-op shape.
  const emit = (event, payload) => {
    const handler = state.listeners.get(event);
    if (handler !== undefined) handler(payload);
  };
  assert.equal(section.text({}), '');
  assert.equal(section.text({ agent: null }), '');
  assert.equal(section.text({ agent: {} }), '');
  assert.equal(section.text({ agent: { session: { id: 's1' } } }), '', 'no layer means an empty section (AC-11)');
  service.layers.add('s1', { promptId: 'p_1', title: 'one', body: 'first body' });
  assert.equal(section.text({ agent: { session: { id: 's1' } } }), 'first body');
  assert.equal(section.text({ agent: { session: { id: 's2' } } }), '', 'another session pays nothing');
  // Regression, live acceptance finding 1: the agent is disposed between two
  // messages. The registry (and therefore the next assembly) must still hold
  // the layer.
  emit('agent/disposed', { agent: { session: { id: 's1' } } });
  assert.equal(section.text({ agent: { session: { id: 's1' } } }), 'first body', 'agent/disposed must not clear a layer');
  assert.equal(service.layers.snapshot('s1').layers.length, 1);
  assert.doesNotThrow(() => emit('agent/disposed', {}));
  assert.doesNotThrow(() => emit('agent/disposed', { agent: null }));
  assert.doesNotThrow(() => emit('agent/disposed', { agent: {} }));
  assert.equal(section.text({ agent: { session: { id: 's1' } } }), 'first body', 'malformed teardown payloads change nothing either');
});

test('index: layers survive the per-turn agent recreation that emptied them in the live session (finding 1)', () => {
  const { ctx, state } = makeCtx();
  apply(ctx);
  const section = state.sections[0];
  const service = serviceStub.PromptLibraryService.instances.at(-1);
  const emit = (event, payload) => {
    const handler = state.listeners.get(event);
    if (handler !== undefined) handler(payload);
  };
  const assemble = (sessionId) => section.text({ agent: { session: { id: sessionId } } });

  const first = service.layers.add('s1', { promptId: 'p_1', title: 'one', body: 'say it plainly' });
  service.layers.add('s1', { promptId: 'p_2', title: 'two', body: 'keep going' });
  const both = 'say it plainly' + '\n\n---\n\n' + 'keep going';
  assert.equal(assemble('s1'), both, 'step 1 carries both layers');

  // Step 1 ends: DSH drops that turn's agent and announces it.
  emit('agent/disposed', { agent: { session: { id: 's1' } } });
  // Step 2 assembles with a brand-new agent object for the same session.
  assert.equal(assemble('s1'), both, 'step 2 still carries both layers');

  // A compaction swaps the agent again, and the session entry is detached
  // once per run ('session/disposed' is the loop's detach, not a close).
  emit('session/disposed', { id: 's1' });
  assert.equal(assemble('s1'), both, 'a compaction still sees both layers');
  emit('agent/disposed', { agent: { session: { id: 's1' } } });

  const held = service.layers.snapshot('s1');
  assert.equal(held.layers.length, 2);
  assert.deepEqual([...held.layers].map((layer) => layer.promptId), ['p_1', 'p_2']);
  assert.equal(held.totalTokens, both.split('\n\n---\n\n').reduce((sum, body) => sum + estimateTokens(body), 0));
  assert.equal(service.layers.size, 1, 'the session entry never moved');

  // The only non-restart clear paths left are the user's own: removing a layer
  // (chip x) or the explicit clearLayers RPC.
  service.layers.remove('s1', 'p_1');
  assert.equal(assemble('s1'), 'keep going');
  service.layers.clear('s1');
  assert.equal(assemble('s1'), '');
  assert.equal(first.layers.length, 1, 'a snapshot taken at step 1 is a value, not the live row array');
});

test('index: the manifest effect disposes the strict registration', () => {
  const { ctx, state } = makeCtx();
  apply(ctx);
  assert.equal(state.disposed, 0);
  state.effects[0].dispose();
  assert.equal(state.disposed, 1);
});

test('index: a rejected strict manifest is logged and the plugin still registers the section', () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const { ctx, state } = makeCtx({
      typert: {
        register() {
          throw new Error('registry refused');
        }
      }
    });
    assert.doesNotThrow(() => apply(ctx));
    assert.equal(state.sections.length, 1, 'the section must survive a failed manifest registration');
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /strict Typert manifest registration failed/u);
    assert.equal(typeof state.effects[0].dispose, 'function');
    assert.doesNotThrow(() => state.effects[0].dispose());
  } finally {
    console.error = original;
  }
});
