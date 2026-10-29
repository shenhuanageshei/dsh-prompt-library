/**
 * Token estimation shared by the host (layer snapshots) and the client (menu
 * rows, dialog, chips, settings list).
 *
 * Formula (design FR-9): estimateTokens = round(cjk * 0.75 +
 * nonCjk * 0.28), where CJK is the union of the three BMP CJK ranges
 * U+3400-U+4DBF, U+4E00-U+9FFF and U+F900-U+FAFF. Iteration is by code point,
 * so astral characters (emoji) count as one non-CJK character.
 */

/** One code point inside the three CJK ranges the estimator prices at 0.75. */
const CJK_CODE_POINT = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/u;

/**
 * Estimate the token cost of one text.
 * @param {unknown} text - candidate text; non-strings estimate as 0.
 * @returns {number} rounded token estimate (0 for empty text).
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0;
  let nonCjk = 0;
  for (const character of text) {
    if (CJK_CODE_POINT.test(character)) cjk += 1;
    else nonCjk += 1;
  }
  return Math.round(cjk * 0.75 + nonCjk * 0.28);
}
