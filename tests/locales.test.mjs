/**
 * Locale key-set lock (code-review round 2, findings #2 and #4).
 *
 * The dialog called `t('dialog.bodyRequired')` while only
 * `settings.bodyRequired` existed, so an empty body rendered the raw key. This
 * file pins BOTH directions of the dictionary contract:
 *   - every key a client file passes to a translator (`t(...)`, `props.t(...)`,
 *     `deps.t(...)`) exists in the Chinese AND the English dictionary;
 *   - both dictionaries carry exactly the same key set, and no dictionary key
 *     is dead — every entry is rendered from somewhere in `src/client/*.ts`,
 *     which is what removed the unused `menu.empty`, `dialog.tags`,
 *     `dialog.noTags` and `settings.importPick` entries.
 *
 * The client sources are TypeScript; `tests/_client.mjs` transpiles the one
 * module this file executes and flattens it for the shared VM scope.
 *
 * Keys are read from the `t(...)` lines rather than from every quoted
 * `segment.name` string, because slot / RPC names such as `settings.section`
 * and `remote.promptLibrary` share the same shape. Values that cross back from
 * the VM are copied into this realm before a strict comparison.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readClientSource, transpileClientModule } from './_client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = join(ROOT, 'src', 'client');

const localesSource = await transpileClientModule('locales');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${localesSource}\n;globalThis.__locales = { NS, zh, en };`, sandbox, {
  filename: 'src/client/locales.ts'
});
const { zh, en } = sandbox.__locales;

/** One quoted locale key (four namespace roots, dot-separated segments). */
const KEY_PATTERN = /'((?:menu|dialog|chips|settings)(?:\.[A-Za-z0-9]+)+)'/gu;

/**
 * Every dictionary key a client file hands to a translator.
 * @returns {Promise<Set<string>>} the used key set.
 */
async function usedKeys() {
  const used = new Set();
  for (const name of (await readdir(CLIENT)).sort()) {
    // Source scan: the translator keys are string literals in the TypeScript
    // sources, so reading them verbatim is exact (and locale key sets are not
    // a runtime-execution question).
    if (!name.endsWith('.ts')) continue;
    const label = name.slice(0, -'.ts'.length);
    const text = await readClientSource(label);
    for (const line of text.split('\n')) {
      // `\bt(` covers `t(`, `props.t(` and `deps.t(`, and does not touch
      // `createElement(` / `estimateTokens(` / `slots.inject(` (word char
      // before the t). The ternary calls keep their keys on the `t(` line.
      if (!/\bt\(/u.test(line)) continue;
      for (const match of line.matchAll(KEY_PATTERN)) used.add(match[1]);
    }
  }
  return used;
}

test('locales: every translator key used in src/client/*.ts exists in zh and en', async () => {
  const used = await usedKeys();
  assert.ok(used.size > 0, 'the scan must find translator calls');
  const zhKeys = new Set(Object.keys(zh));
  const enKeys = new Set(Object.keys(en));
  const missingZh = [...used].filter((key) => !zhKeys.has(key)).sort();
  const missingEn = [...used].filter((key) => !enKeys.has(key)).sort();
  assert.deepEqual(missingZh, [], 'zh is missing translator key(s): ' + missingZh.join(', '));
  assert.deepEqual(missingEn, [], 'en is missing translator key(s): ' + missingEn.join(', '));
});

test('locales: zh and en carry the same key set and no key is dead', async () => {
  const zhKeys = [...Object.keys(zh)];
  const enKeys = [...Object.keys(en)];
  assert.deepEqual(zhKeys, enKeys, 'the two dictionaries must stay key-for-key mirrors');
  const used = await usedKeys();
  const dead = zhKeys.filter((key) => !used.has(key)).sort();
  assert.deepEqual(dead, [], 'dead dictionary key(s) with no render point: ' + dead.join(', '));
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', 'zh.' + key + ' must be a string');
    assert.equal(typeof en[key], 'string', 'en.' + key + ' must be a string');
    assert.notEqual(zh[key].trim(), '', 'zh.' + key + ' must not be blank');
    assert.notEqual(en[key].trim(), '', 'en.' + key + ' must not be blank');
  }
});

test('locales: dialog.bodyRequired exists in both dictionaries', () => {
  // src/client/dialog.ts renders this key for an empty body; before the fix
  // it did not exist anywhere and the raw key leaked into the dialog.
  assert.notEqual(zh['dialog.bodyRequired'], undefined);
  assert.notEqual(en['dialog.bodyRequired'], undefined);
  assert.notEqual(zh['dialog.bodyRequired'].trim(), '');
  assert.notEqual(en['dialog.bodyRequired'].trim(), '');
});
