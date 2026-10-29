/**
 * Settings pure logic (src/client/settings.ts).
 *
 * Audit should-fix 5: the import confirmation read `result.imported`, but the
 * client half answers `{ ok, value: { imported, replaced } }`, so every
 * successful import reported "imported 0 prompts". `importOutcome` is now the
 * single mapping, and it is exercised here without a GUI.
 *
 * The two client files share one factory scope in the built bundle
 * (`filterLibrary` calls `promptMatches` from source.ts), so the harness loads
 * them into one context too — both are transpiled from TypeScript and
 * flattened by `tests/_client.mjs`. Cross-realm results are copied before a
 * strict comparison.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transpileClientModule } from './_client.mjs';

const settingsSource = await transpileClientModule('settings');
const sourceSource = await transpileClientModule('source');

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${sourceSource}\n${settingsSource}`, sandbox, { filename: 'src/client/settings.ts' });
vm.runInContext(
  'globalThis.__settingsHelpers = { importOutcome, parseTagField, filterLibrary, libraryFailureCopy, libraryErrorText, libraryWritable };',
  sandbox,
  { filename: 'src/client/settings.helpers.ts' }
);
const { importOutcome, parseTagField, filterLibrary, libraryFailureCopy, libraryErrorText, libraryWritable } =
  sandbox.__settingsHelpers;

test('settings: a successful import reports the count carried in result.value', () => {
  const outcome = importOutcome({ ok: true, value: { imported: 3, replaced: false } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.imported, 3);
  assert.equal(outcome.replaced, false);
  assert.equal(outcome.invalid, 0);
  assert.equal(outcome.message, '');
  assert.equal(importOutcome({ ok: true, value: { imported: 0, replaced: true } }).replaced, true);
  // A success without a value still reports a number, never undefined.
  assert.equal(importOutcome({ ok: true }).imported, 0);
});

test('settings: a rejected import keeps the invalid count and the message', () => {
  const outcome = importOutcome({ ok: false, code: 'import-invalid', message: '2 entries failed validation', invalid: 2 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.invalid, 2);
  assert.equal(outcome.message, '2 entries failed validation');
  // A failure without details never renders "undefined".
  const bare = importOutcome({ ok: false });
  assert.equal(bare.invalid, 0);
  assert.equal(bare.message, '');
  assert.equal(importOutcome(undefined).ok, false);
  // The failure CODE travels with the outcome so the settings section can map
  // it onto product copy (code-review round 2, finding #5).
  assert.equal(importOutcome({ ok: false, code: 'library-full', message: 'full' }).code, 'library-full');
  assert.equal(importOutcome({ ok: true, value: { imported: 1 } }).code, '');
  assert.equal(importOutcome(undefined).code, '');
});

test('settings: known library failure codes render product copy, unknown ones keep the host message', () => {
  const calls = [];
  const t = (key, params) => {
    calls.push({ key, params });
    return 'T:' + key;
  };
  assert.equal(libraryFailureCopy('library-readonly', t), 'T:settings.errorReadOnly');
  assert.equal(libraryFailureCopy('library-full', t), 'T:settings.errorFull');
  assert.equal(libraryFailureCopy('library-corrupt', t), 'T:settings.errorCorrupt');
  assert.equal(libraryFailureCopy('not-found', t), '');
  assert.equal(libraryFailureCopy(undefined, t), '');
  assert.equal(libraryErrorText({ ok: false, code: 'library-full', message: 'the library is full' }, t), 'T:settings.errorFull');
  assert.equal(libraryErrorText({ ok: false, code: 'library-readonly', message: 'read only' }, t), 'T:settings.errorReadOnly');
  const fallback = libraryErrorText({ ok: false, code: 'not-found', message: 'no prompt with id' }, t);
  assert.equal(fallback, 'T:settings.error');
  assert.equal(calls.at(-1).params.message, 'no prompt with id');
  assert.equal(libraryErrorText({ ok: false, message: '' }, t), 'T:settings.error');
  assert.equal(libraryErrorText(undefined, t), 'T:settings.error');
});

test('settings: the toolbar write actions are disabled for a read-only library', () => {
  assert.equal(libraryWritable({ available: true, readOnly: false }), true);
  assert.equal(libraryWritable({ available: true, readOnly: true }), false);
  assert.equal(libraryWritable({ available: false, readOnly: false }), false);
  assert.equal(libraryWritable({ available: false, readOnly: true }), false);
  assert.equal(libraryWritable(undefined), false);
});

test('settings: tags split on both commas, trim, drop empties, and de-duplicate', () => {
  assert.deepEqual([...parseTagField('授权, 测试，授权,,')], ['授权', '测试']);
  assert.equal(parseTagField('').length, 0);
  assert.equal(parseTagField(null).length, 0);
});

test('settings: filtering reuses the shared prompt matcher', () => {
  const prompts = [
    { id: 'p_1', title: 'Alpha', body: 'one', tags: [] },
    { id: 'p_2', title: 'Beta', body: 'two', tags: ['授权'] }
  ];
  assert.equal(filterLibrary(prompts, '  ').length, 2);
  assert.deepEqual([...filterLibrary(prompts, 'alp')].map((prompt) => prompt.id), ['p_1']);
});
