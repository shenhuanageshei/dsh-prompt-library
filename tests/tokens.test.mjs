/**
 * estimateTokens (design FR-9): round(cjk * 0.75 + nonCjk * 0.28), where CJK is
 * the union of U+3400-U+4DBF, U+4E00-U+9FFF and U+F900-U+FAFF (iteration is by
 * code point, so an astral character counts as one non-CJK character).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from '../lib/shared/tokens.js';

test('estimateTokens: empty and non-string inputs cost zero', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(42), 0);
  assert.equal(estimateTokens({}), 0);
});

test('estimateTokens: CJK characters are priced at 0.75 each', () => {
  assert.equal(estimateTokens('中'), 1); // 0.75 -> 1
  assert.equal(estimateTokens('中文'), 2); // 1.5 -> 2
  assert.equal(estimateTokens('中文提示词'), 4); // 3.75 -> 4
  assert.equal(estimateTokens('极限测试授权'), 5); // 4.5 -> 5 (round half up)
});

test('estimateTokens: non-CJK characters are priced at 0.28 each', () => {
  assert.equal(estimateTokens('abc'), 1); // 0.84 -> 1
  assert.equal(estimateTokens('abcd'), 1); // 1.12 -> 1
  assert.equal(estimateTokens('a'.repeat(100)), 28);
});

test('estimateTokens: mixed text adds both parts before rounding', () => {
  assert.equal(estimateTokens('中a'), 1); // 0.75 + 0.28 = 1.03
  assert.equal(estimateTokens('中文abc'), 2); // 1.5 + 0.84 = 2.34
  assert.equal(estimateTokens('提示词abc'), 3); // 2.25 + 0.84 = 3.09
});

test('estimateTokens: code points outside the three BMP ranges are non-CJK', () => {
  // U+20000 (ext-B ideograph) and an emoji are outside the priced ranges and
  // each count as exactly one non-CJK character (not two code units).
  assert.equal(estimateTokens('\u{20000}'), 0); // round(0.28) = 0
  assert.equal(estimateTokens('\u{1F600}'), 0);
  assert.equal(estimateTokens('\u{20000}'.repeat(4)), 1); // 1.12 -> 1
});

test('estimateTokens: the fullwidth punctuation and CJK radicals are priced as CJK', () => {
  assert.equal(estimateTokens('\u3400'), 1); // ext-A start
  assert.equal(estimateTokens('\uF900'), 1); // compatibility start
  assert.equal(estimateTokens('\u9FFF'), 1); // unified end
});
