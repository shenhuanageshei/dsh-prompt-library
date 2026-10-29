/**
 * LayerRegistry (src/host/layers.ts -> lib/host/layers.js): add /
 * update-in-place / limit / remove / clear / session isolation, plus
 * sectionText ('' with no layer, one body, two bodies in insertion order joined
 * by the design separator).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadZod } from './_zod.mjs';
import { defineContract } from '../lib/contract.js';
import { LAYER_LIMIT_CODE, LayerRegistry } from '../lib/host/layers.js';
import { estimateTokens } from '../lib/shared/tokens.js';

const z = await loadZod();
const contract = defineContract(z);

/** One layer input. */
function layerOf(promptId, body, title = 'title-' + promptId) {
  return { promptId, title, body };
}

test('layers: add returns the wire snapshot with per-row and total tokens', () => {
  const layers = new LayerRegistry({ contract });
  const snapshot = layers.add('s1', layerOf('p_1', '\u4e2d\u6587\u6b63\u6587'));
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

test('layers: insertion order is preserved and totals are summed', () => {
  const layers = new LayerRegistry({ contract });
  layers.add('s1', layerOf('p_1', 'one'));
  const snapshot = layers.add('s1', layerOf('p_2', 'two'));
  layers.add('s1', layerOf('p_3', 'three'));
  assert.deepEqual(snapshot.layers.map((layer) => layer.promptId), ['p_1', 'p_2']);
  const all = layers.snapshot('s1');
  assert.deepEqual(all.layers.map((layer) => layer.promptId), ['p_1', 'p_2', 'p_3']);
  assert.equal(all.totalTokens, ['one', 'two', 'three'].reduce((sum, body) => sum + estimateTokens(body), 0));
});

test('layers: the same promptId updates in place instead of adding a row', () => {
  const layers = new LayerRegistry({ contract });
  layers.add('s1', layerOf('p_1', 'old body', 'old title'));
  const snapshot = layers.add('s1', layerOf('p_1', 'new body', 'new title'));
  assert.equal(snapshot.layers.length, 1);
  assert.deepEqual(snapshot.layers[0], {
    promptId: 'p_1',
    title: 'new title',
    body: 'new body',
    tokens: estimateTokens('new body')
  });
  assert.equal(snapshot.totalTokens, estimateTokens('new body'));
});

test('layers: a fourth distinct layer is refused with the layer-limit code', () => {
  const layers = new LayerRegistry({ contract });
  layers.add('s1', layerOf('p_1', 'one'));
  layers.add('s1', layerOf('p_2', 'two'));
  layers.add('s1', layerOf('p_3', 'three'));
  assert.throws(() => layers.add('s1', layerOf('p_4', 'four')), (error) => error.code === LAYER_LIMIT_CODE);
  assert.equal(layers.snapshot('s1').layers.length, 3);
  assert.equal(layers.sectionText('s1').split('\n\n---\n\n').length, 3);
});

test('layers: remove drops one row and is idempotent for unknown ids', () => {
  const layers = new LayerRegistry({ contract });
  layers.add('s1', layerOf('p_1', 'one'));
  layers.add('s1', layerOf('p_2', 'two'));
  const afterRemove = layers.remove('s1', 'p_1');
  assert.deepEqual(afterRemove.layers.map((layer) => layer.promptId), ['p_2']);
  assert.equal(afterRemove.totalTokens, estimateTokens('two'));
  const afterUnknown = layers.remove('s1', 'p_missing');
  assert.deepEqual(afterUnknown.layers.map((layer) => layer.promptId), ['p_2']);
  const emptied = layers.remove('s1', 'p_2');
  assert.deepEqual(emptied.layers, []);
  assert.equal(emptied.totalTokens, 0);
  assert.equal(layers.size, 0);
});

test('layers: clear empties exactly one session and leaves the other intact', () => {
  const layers = new LayerRegistry({ contract });
  layers.add('s1', layerOf('p_1', 'one'));
  layers.add('s2', layerOf('p_2', 'two'));
  const cleared = layers.clear('s1');
  assert.deepEqual(cleared.layers, []);
  assert.equal(cleared.limit, 3);
  assert.equal(layers.size, 1);
  assert.equal(layers.sectionText('s2'), 'two');
  // Clearing an unknown session is idempotent and still answers a snapshot.
  assert.deepEqual(layers.clear('s_unknown').layers, []);
  assert.equal(layers.size, 1);
});

test('layers: sessions are isolated from each other', () => {
  const layers = new LayerRegistry({ contract });
  layers.add('s1', layerOf('p_1', 'one'));
  layers.add('s1', layerOf('p_2', 'two'));
  layers.add('s2', layerOf('p_9', 'nine'));
  assert.deepEqual(layers.snapshot('s1').layers.map((layer) => layer.promptId), ['p_1', 'p_2']);
  assert.deepEqual(layers.snapshot('s2').layers.map((layer) => layer.promptId), ['p_9']);
  assert.equal(layers.sectionText('s3'), '');
});

test('layers: sectionText is empty without layers, one body with one, ordered with two', () => {
  const layers = new LayerRegistry({ contract });
  assert.equal(layers.sectionText('s1'), '');
  assert.equal(layers.sectionText('unknown-session'), '');
  layers.add('s1', layerOf('p_1', 'first body'));
  assert.equal(layers.sectionText('s1'), 'first body');
  layers.add('s1', layerOf('p_2', 'second body'));
  assert.equal(layers.sectionText('s1'), 'first body\n\n---\n\nsecond body');
  layers.add('s1', layerOf('p_3', 'third body'));
  assert.equal(layers.sectionText('s1'), 'first body\n\n---\n\nsecond body\n\n---\n\nthird body');
  layers.remove('s1', 'p_1');
  assert.equal(layers.sectionText('s1'), 'second body\n\n---\n\nthird body');
});

test('layers: the limit comes from the shared contract, not a local constant', () => {
  const narrow = new LayerRegistry({ contract: { LIMITS: { layers: 1 } } });
  narrow.add('s1', layerOf('p_1', 'one'));
  assert.throws(() => narrow.add('s1', layerOf('p_2', 'two')), (error) => error.code === LAYER_LIMIT_CODE);
  assert.equal(narrow.snapshot('s1').limit, 1);
});
