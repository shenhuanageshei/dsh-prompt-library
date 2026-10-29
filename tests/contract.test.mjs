/**
 * The wire contract (src/contract.ts -> lib/contract.js): limits, prompt schema
 * accept/reject boundaries, layer snapshot bounds, and the Remote invocation
 * descriptor set the host manifest and the client both consume.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadZod } from './_zod.mjs';
import { defineContract } from '../lib/contract.js';

const z = await loadZod();
const contract = defineContract(z);

const VALID_PROMPT = {
  id: 'p_1',
  title: '\u6781\u9650\u6d4b\u8bd5\u6388\u6743',
  body: '\u6b63\u6587',
  tags: ['\u6388\u6743', '\u6d4b\u8bd5'],
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z'
};

test('contract: LIMITS match design section 6.1', () => {
  assert.deepEqual(contract.LIMITS, { title: 80, body: 20000, tags: 8, tag: 40, prompts: 200, layers: 3 });
});

test('contract: promptSchema accepts a well-formed prompt', () => {
  const parsed = contract.promptSchema.safeParse(VALID_PROMPT);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, VALID_PROMPT);
});

test('contract: promptSchema accepts the boundary values', () => {
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, title: 'x'.repeat(80) }).success, true);
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, body: 'x'.repeat(20000) }).success, true);
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, tags: Array.from({ length: 8 }, (_, i) => 't' + i) }).success, true);
});

test('contract: promptSchema rejects empty and oversized title/body/tags', () => {
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, title: '' }).success, false);
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, title: 'x'.repeat(81) }).success, false);
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, body: '' }).success, false);
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, body: 'x'.repeat(20001) }).success, false);
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, tags: Array.from({ length: 9 }, (_, i) => 't' + i) }).success, false);
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, tags: ['x'.repeat(41)] }).success, false);
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, tags: [''] }).success, false);
});

test('contract: promptSchema is strict and requires every field', () => {
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, extra: true }).success, false);
  const { id, ...withoutId } = VALID_PROMPT;
  assert.equal(contract.promptSchema.safeParse(withoutId).success, false);
  assert.equal(contract.promptSchema.safeParse({ ...VALID_PROMPT, id: '' }).success, false);
});

test('contract: promptInputSchema means "empty id = create"', () => {
  assert.equal(contract.promptInputSchema.safeParse({ title: 'a', body: 'b', tags: [] }).success, true);
  assert.equal(contract.promptInputSchema.safeParse({ id: 'p_1', title: 'a', body: 'b', tags: [] }).success, true);
  assert.equal(contract.promptInputSchema.safeParse({ id: '', title: 'a', body: 'b', tags: [] }).success, false);
  assert.equal(contract.promptInputSchema.safeParse({ title: 'a', body: 'b' }).success, false);
  assert.equal(contract.promptInputSchema.safeParse({ title: 'a', body: 'b', tags: [], extra: 1 }).success, false);
});

test('contract: librarySnapshotSchema accepts the host snapshot shape', () => {
  const snapshot = {
    prompts: [VALID_PROMPT],
    updatedAt: '2026-10-27T00:00:00.000Z',
    filePath: 'C:/Users/me/.dsh/prompt-library/prompts.json',
    readOnly: false,
    corruptBackup: null,
    notice: null
  };
  assert.equal(contract.librarySnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(contract.librarySnapshotSchema.safeParse({ ...snapshot, readOnly: 'no' }).success, false);
  assert.equal(contract.librarySnapshotSchema.safeParse({ ...snapshot, filePath: '' }).success, false);
});

test('contract: layerSnapshotSchema caps the session at three layers', () => {
  const layer = { promptId: 'p_1', title: 'a', body: 'b', tokens: 1 };
  const snapshot = { layers: [layer], totalTokens: 1, limit: 3 };
  assert.equal(contract.layerSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(contract.layerSnapshotSchema.safeParse({ ...snapshot, layers: [layer, layer, layer, layer] }).success, false);
  assert.equal(contract.layerSnapshotSchema.safeParse({ ...snapshot, totalTokens: -1 }).success, false);
  assert.equal(contract.layerInputSchema.safeParse({ promptId: 'p_1', title: 'a', body: 'b' }).success, true);
  assert.equal(contract.layerInputSchema.safeParse({ promptId: '', title: 'a', body: 'b' }).success, false);
});

test('contract: import schemas accept exactly replace/merge and a non-negative count', () => {
  assert.equal(contract.importRequestSchema.safeParse({ mode: 'replace', text: '[]' }).success, true);
  assert.equal(contract.importRequestSchema.safeParse({ mode: 'merge', text: '[]' }).success, true);
  assert.equal(contract.importRequestSchema.safeParse({ mode: 'append', text: '[]' }).success, false);
  assert.equal(contract.importResultSchema.safeParse({ imported: 0, replaced: true }).success, true);
  assert.equal(contract.importResultSchema.safeParse({ imported: -1, replaced: true }).success, false);
});

test('contract: INVOCATIONS declares the eight promptLibrary endpoints with strict codecs', () => {
  assert.equal(contract.INVOCATIONS.length, 8);
  assert.deepEqual(contract.INVOCATIONS.map((entry) => entry.method), [
    'list',
    'save',
    'removePrompt',
    'importLibrary',
    'layers',
    'addLayer',
    'removeLayer',
    'clearLayers'
  ]);
  for (const entry of contract.INVOCATIONS) {
    assert.equal(entry.service, 'promptLibrary');
    assert.equal(entry.namespace, 'promptLibrary');
    assert.equal(entry.id, 'dsh-prompt-library#promptLibrary/' + entry.method);
    assert.equal(entry.invocation.kind, 'direct');
    assert.equal(entry.result.mode, 'strict');
    assert.equal(typeof entry.result.create, 'function');
    assert.ok(entry.result.typeSymbol.startsWith('dsh-prompt-library#'));
    for (const parameter of entry.parameters) {
      assert.equal(parameter.codec.mode, 'strict');
      assert.equal(typeof parameter.codec.create, 'function');
      assert.equal(typeof parameter.codec.create().safeParse, 'function');
    }
  }
  const save = contract.INVOCATIONS.find((entry) => entry.method === 'save');
  assert.deepEqual(save.parameters.map((parameter) => parameter.name), ['input']);
  const addLayer = contract.INVOCATIONS.find((entry) => entry.method === 'addLayer');
  assert.deepEqual(addLayer.parameters.map((parameter) => parameter.name), ['sessionId', 'input']);
});

test('contract: sessionId parameters carry the platform SessionId codec (design section 6.4)', () => {
  const sessionParameters = contract.INVOCATIONS
    .flatMap((entry) => entry.parameters)
    .filter((parameter) => parameter.name === 'sessionId');
  assert.equal(sessionParameters.length, 4);
  for (const parameter of sessionParameters) {
    // The wire type identity is the platform's, not a package-local symbol.
    assert.equal(parameter.codec.typeSymbol, '@deepseek-ai/dsh-session/types#SessionId');
    assert.equal(parameter.codec.mode, 'strict');
    // The schema mirrors the platform's generated SessionId schema: a plain
    // string, matching every generated manifest on 0.2.1-rc.3.
    assert.equal(typeof parameter.codec.create().safeParse, 'function');
    assert.equal(parameter.codec.create().safeParse('session-1').success, true);
  }
  assert.equal(contract.SESSION_ID_WIRE_TYPE_SYMBOL, '@deepseek-ai/dsh-session/types#SessionId');
  // Every other parameter keeps the package-local type symbol.
  const otherParameters = contract.INVOCATIONS
    .flatMap((entry) => entry.parameters)
    .filter((parameter) => parameter.name !== 'sessionId');
  for (const parameter of otherParameters) {
    assert.ok(parameter.codec.typeSymbol.startsWith('dsh-prompt-library#'));
  }
});
