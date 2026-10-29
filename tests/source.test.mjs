/**
 * The `/` source cache (src/client/source.ts -> createPromptSource).
 *
 * Design §9 says "RPC 不可用 -> 菜单只读缓存": a failed read must keep the rows
 * the user can already see, instead of blanking the menu (audit should-fix 10 —
 * `candidates` returned `[]` on any failure and dropped the warm cache).
 *
 * The source is transpiled from TypeScript and flattened into a plain script
 * (`tests/_client.mjs`) so it loads into a VM context here and the factory runs
 * against stub deps. Values crossing back from that context are copied with a
 * spread before a strict comparison (cross-realm prototypes fail
 * `assert.deepEqual` from `node:assert/strict`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transpileClientModule } from './_client.mjs';

const source = await transpileClientModule('source');

const warnings = [];
const sandbox = { console: { error() {}, warn: (...args) => warnings.push(args) } };
vm.createContext(sandbox);
vm.runInContext(`${source}\n;globalThis.__sourceHelpers = { createPromptSource, visiblePrompts };`, sandbox, {
  filename: 'src/client/source.ts'
});
const { createPromptSource, visiblePrompts } = sandbox.__sourceHelpers;

/** Ids of the rows one call returned, copied into this realm. */
function ids(rows) {
  return [...rows].map((row) => row.value);
}

/** One library prompt. */
function promptOf(id, title, body = 'body') {
  return { id, title, body, tags: ['tag'], createdAt: 'now', updatedAt: 'now' };
}

/** A source whose host read can be switched to failing. */
function makeSource() {
  const state = { calls: 0, failing: false, now: 1000 };
  const face = createPromptSource({
    loadLibrary: async () => {
      state.calls += 1;
      if (state.failing) throw new Error('rpc down');
      return { prompts: [promptOf('p_1', '授权'), promptOf('p_2', '推进')] };
    },
    openDialog: () => {},
    t: (key) => key,
    estimateTokens: () => 7,
    now: () => state.now
  });
  return { source: face.source, invalidate: face.invalidate, state };
}

test('source: candidates map the library into menu rows and cache for the TTL', async () => {
  const { source: prompts, state } = makeSource();
  const first = await prompts.candidates({ sessionId: 's1' }, { query: '' });
  assert.equal(first.length, 2);
  assert.deepEqual(ids(first), ['p_1', 'p_2']);
  assert.equal(first[0].name, '授权');
  assert.equal(first[0].section, 'menu.group');
  assert.equal(first[0].description, 'tag · menu.tokens');
  assert.equal(state.calls, 1);

  // Inside the 5s TTL the cache answers without another host read.
  state.now += 1000;
  await prompts.candidates({ sessionId: 's1' }, { query: '' });
  assert.equal(state.calls, 1);
});

test('source: a failed read keeps the warm cache instead of blanking the menu', async () => {
  const { source: prompts, state } = makeSource();
  const warm = await prompts.candidates({ sessionId: 's1' }, { query: '' });
  assert.equal(warm.length, 2);

  state.failing = true;
  state.now += 60000;
  const afterFailure = await prompts.candidates({ sessionId: 's1' }, { query: '' });
  assert.equal(afterFailure.length, 2, 'the warm cache still answers while the RPC fails');
  assert.deepEqual(ids(afterFailure), ['p_1', 'p_2']);
  assert.equal(state.calls, 2);
});

test('source: a cold cache has nothing to serve and answers empty', async () => {
  const face = createPromptSource({
    loadLibrary: async () => {
      throw new Error('rpc down');
    },
    openDialog: () => {},
    t: (key) => key,
    estimateTokens: () => 0
  });
  assert.equal((await face.source.candidates({ sessionId: 's1' }, { query: '' })).length, 0);
});

test('source: invalidate() drops the cache so the next open re-reads', async () => {
  const { source: prompts, invalidate, state } = makeSource();
  await prompts.candidates({ sessionId: 's1' }, { query: '' });
  assert.equal(state.calls, 1);
  // A library write / reconnect invalidates the menu cache (client/index.ts).
  invalidate();
  await prompts.candidates({ sessionId: 's1' }, { query: '' });
  assert.equal(state.calls, 2, 'an invalidated cache re-reads even inside the TTL');
});

test('source: filtering matches title, tag, and body and respects the cap', () => {
  const prompts = [promptOf('p_1', 'Alpha', 'one'), promptOf('p_2', 'Beta', 'two'), promptOf('p_3', 'Gamma', 'three')];
  assert.deepEqual([...visiblePrompts(prompts, 'alp')].map((prompt) => prompt.id), ['p_1']);
  assert.deepEqual([...visiblePrompts(prompts, 'tag')].map((prompt) => prompt.id), ['p_1', 'p_2', 'p_3']);
  assert.deepEqual([...visiblePrompts(prompts, 'three')].map((prompt) => prompt.id), ['p_3']);
  assert.deepEqual([...visiblePrompts(prompts, '', 2)].map((prompt) => prompt.id), ['p_1', 'p_2']);
});

test('source: warm() prewarms the cache and never rejects', async () => {
  const { source: prompts, state } = makeSource();
  await prompts.warm();
  assert.equal(state.calls, 1);
  const rows = await prompts.candidates({ sessionId: 's1' }, { query: '' });
  assert.equal(rows.length, 2);
  assert.equal(state.calls, 1, 'a warmed cache answers the first open without a host read');
  const failing = createPromptSource({
    loadLibrary: async () => {
      throw new Error('rpc down');
    },
    openDialog: () => {},
    t: (key) => key,
    estimateTokens: () => 0
  });
  await assert.doesNotReject(failing.source.warm());
});

test('source: a pick after invalidation still opens the dialog with the last known prompt', async () => {
  const opened = [];
  const face = createPromptSource({
    loadLibrary: async () => ({ prompts: [promptOf('p_1', '授权', 'full body')] }),
    openDialog: (sessionId, pending) => opened.push({ sessionId, pending }),
    t: (key) => key,
    estimateTokens: () => 1
  });
  await face.source.candidates({ sessionId: 's1' }, { query: '' });
  face.invalidate();
  face.source.onPick({
    candidate: { value: 'p_1', name: '授权' },
    session: { sessionId: 's1' },
    span: { start: 0, end: 2, draftRev: 1 }
  });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].sessionId, 's1');
  assert.equal(opened[0].pending.prompt.body, 'full body', 'the body survives the invalidation');
  assert.equal(opened[0].pending.kind, 'use');
  assert.equal(opened[0].pending.delivery, 'insert');
  assert.deepEqual({ ...opened[0].pending.span }, { start: 0, end: 2, draftRev: 1 });
});

test('source: a pick with no cached row warns and opens the dialog from the menu row', () => {
  const opened = [];
  const face = createPromptSource({
    loadLibrary: async () => ({ prompts: [] }),
    openDialog: (sessionId, pending) => opened.push({ sessionId, pending }),
    t: (key) => key,
    estimateTokens: () => 1
  });
  warnings.length = 0;
  face.source.onPick({ candidate: { value: 'p_1', name: '只剩标题' }, session: { sessionId: 's7' }, span: null });
  assert.equal(warnings.length, 1, 'a lost row must be reported, never silently dropped');
  assert.equal(opened.length, 1, 'the click must not dead-end');
  assert.equal(opened[0].sessionId, 's7');
  assert.equal(opened[0].pending.prompt.title, '只剩标题');
  assert.equal(opened[0].pending.prompt.id, 'p_1');
  assert.equal(opened[0].pending.prompt.body, '');
  assert.equal(opened[0].pending.span, null);
});

